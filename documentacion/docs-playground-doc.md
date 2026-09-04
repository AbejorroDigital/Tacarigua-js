# Documentación Técnica: Módulo `@tacarigua/docs-playground`
**Tacarigua 1.0.0 — Infraestructura de Documentación Interactiva, Entorno de Pruebas Aislado (Sandbox REPL) y Motor de Migración**

---

## 1. Visión General y Arquitectura del Módulo

El módulo `@tacarigua/docs-playground` proporciona las herramientas de infraestructura necesarias para la generación de documentación técnica automatizada, la ejecución de código en vivo (*in-browser REPL*) bajo entornos WebGPU/WebXR aislados y la auditoría programática de proyectos que migran desde versiones legadas (Phaser 3.x / 4.x) a la arquitectura moderna de **Tacarigua 1.0.0**.

El módulo desacopla la documentación estática tradicional convirtiéndola en un entorno de desarrollo activo mediante tres pilares:

```
                            +-------------------------------------------------------+
                            |                 @tacarigua/docs-playground               |
                            +-------------------------------------------------------+
                                   |                           |                |
                                   v                           v                v
                 +-----------------------------+  +------------------------+  +--------------------+
                 |    TYPEDOC_ASTRO_CONFIG     |  |    PlaygroundRunner    |  |  MIGRATION_MANUAL  |
                 | - Extracción estricta ESM   |  | - Sandbox Iframe       |  |  & MigrationAuditor|
                 | - Generación Markdown AST   |  | - Blob URL Lifecycle   |  | - Reglas dinámicas |
                 | - Integración con Astro SSG |  | - PostMessage Bridge   |  | - Diagnóstico Phaserv4/Tacariguav1|
                 +-----------------------------+  +------------------------+  +--------------------+
                                                               |
                                            +------------------+------------------+
                                            |                                     |
                                            v                                     v
                             [Hardware: WebGPU / WebGL2]            [Aislamiento COOP / COEP]
                             (Soporte para Shaders WGSL)            (SharedArrayBuffer habilitado)
```

### Componentes Principales
1. **`TYPEDOC_ASTRO_CONFIG`**: Configuración declarativa que orquesta la extracción de contratos de tipos desde los 10 paquetes del monorepo hacia Markdown compatible con el framework de generación estática Astro.
2. **`PlaygroundRunner`**: Arnés de ejecución en caja de arena (*Sandboxed Harness*) que compila dinámicamente código cliente en un `<iframe>` seguro con soporte para WebGPU, WebXR y cabeceras de aislamiento cruzado.
3. **`MIGRATION_MANUAL`**: Base de conocimientos estructurada que mapea formalmente los *breaking changes*, cambios de paradigma (OOP a ECS) y transformaciones de sombreadores (GLSL a WGSL).
4. **`MigrationAuditor`**: Analizador estático en tiempo de ejecución que intercepta objetos de configuración legados y genera diagnósticos detallados clasificados por severidad (`warning`, `deprecated`, `breaking`).

---

## 2. Análisis Técnico Detallado de Clases y Estructuras

### 2.1. `TYPEDOC_ASTRO_CONFIG` (Especificación del Monorepo)

Este objeto configura el pipeline de compilación de documentación del monorepo mediante `typedoc-plugin-markdown`. Su objetivo es extraer las definiciones tipadas sin procesar código privado o interno, formateándolo directamente para colecciones de contenido en Astro.

* **Puntos de entrada estrictos**: Mapea exclusivamente los puntos de entrada ESM de cada módulo (`@tacarigua/core`, `@tacarigua/renderer-webgpu`, `@tacarigua/batch-renderer-2d`, `@tacarigua/ecs`, `@tacarigua/physics-worker`, `@tacarigua/sound-worklet`, `@tacarigua/net`, `@tacarigua/input-xr`, `@tacarigua/devtools`, `@tacarigua/vite-plugin`).
* **Optimización de compilación**:
  * `excludePrivate: true`: Purga métodos que comprometan la encapsulación del motor.
  * `cleanOutputDir: true`: Elimina discrepancias en el árbol de archivos generado antes de compilar el sitio estático.

### 2.2. `PlaygroundRunner` (Arnés de Ejecución Aislado)

La clase `PlaygroundRunner` encapsula la creación, inyección, supervisión y destrucción de un entorno de pruebas (*sandbox*) dentro del navegador del desarrollador.

#### Ciclo de Vida y Pipeline de Ejecución:
1. **Instanciación y Permisos**: Construye un elemento `HTMLIFrameElement` inyectándole atributos de seguridad avanzados:
   ```html
   allow="cross-origin-isolated; xr-spatial-tracking; fullscreen; autoplay"
   ```
   *Esto es indispensable para que las muestras que utilicen `@tacarigua/physics-worker` con `SharedArrayBuffer` y `@tacarigua/input-xr` funcionen sin bloqueos de seguridad del navegador.*
2. **Inyección de Código Dinámico vía Blob URL**: Convierte una plantilla HTML5 completa (incluyendo scripts de captura de telemetría y polyfills de detección WebGPU) en un objeto binario `Blob` (`text/html`), asignándole una URL transitoria mediante `URL.createObjectURL(blob)`.
3. **Puente de Comunicación (`MessageEvent`)**: Intercepta eventos `window.postMessage` provenientes del subdominio de arena mediante el canal con origen `'tacarigua-playground-sandbox'`. Clasifica los mensajes en tres tipos:
   * `LOG`: Captura transmisiones de la consola interna del iframe.
   * `ERROR`: Desglosa excepciones globales (`window.onerror`) con seguimiento de pila (*stack trace*).
   * `METRICS`: Recibe métricas de telemetría emitidas por `@tacarigua/devtools`.
4. **Política Estricta de Liberación de Memoria**: El método `stop()` revoca explícitamente el `Blob URL` activo (`URL.revokeObjectURL`), desvincula el iframe asignando `'about:blank'` a su propiedad `src`, y purga el nodo del DOM para evitar fugas de memoria en la GPU o contextos WebGL zombis.

### 2.3. `MigrationAuditor` (Motor de Diagnóstico Dinámico)

Proporciona un mecanismo de inspección programática para configuraciones de Phaser. Su método estático `auditConfig(legacyConfig)` analiza las propiedades del objeto de inicialización y retorna un arreglo estructurado de advertencias y directivas de modernización.

```typescript
type DiagnosticLevel = 'warning' | 'deprecated' | 'breaking';

interface Diagnostic {
    field: string;
    level: DiagnosticLevel;
    advice: string;
}
```

* **Regla 1 (Tipo de Render)**: Detecta `type === 1` (`CANVAS`). Advierte que el renderizador Canvas puro ha dejado de ser el objetivo primario en Tacarigua v1.0.0 y aconseja utilizar `RENDER_TYPE.AUTO` para activar la abstracción WebGPU/WebGL 2.
* **Regla 2 (Árbol de Físicas Arcade)**: Detecta banderas heredadas como `physics.arcade.useTree: false`. Indica que el sistema clásico de árbol espacial R-Tree ha sido reemplazado por la resolución lineal AABB orientada a datos en Web Workers (`@tacarigua/physics-worker`).
* **Regla 3 (Audio HTML5 Desactivado)**: Detecta `audio.disableWebAudio: true`. Bloquea la inicialización marcándola como `breaking`, ya que Tacarigua 1.0.0 requiere estrictamente Web Audio API con procesadores `AudioWorklet`.

---

## 3. Comparativa Técnica: Phaser 4.2.1 vs Tacarigua 1.0.0

| Dimensión | Phaser 4.2.1 | Tacarigua 1.0.0 (`@tacarigua/docs-playground`) |
| :--- | :--- | :--- |
| **Documentación de API** | Páginas HTML monolíticas generadas por JSDoc antiguo, sin validación estricta de tipos. | Generación basada en AST mediante **TypeDoc Markdown + Astro**, asegurando tipado estricto al 100%. |
| **Entorno REPL / Sandbox** | Basado en recarga completa de página o iframes simples con WebGL 1, sin aislamiento cruzado. | `PlaygroundRunner` con soporte nativo de **WebGPU**, WebXR y permisos para `SharedArrayBuffer`. |
| **Validación de Configuración** | Falla silenciosa o advertencias genéricas arrojadas por consola en tiempo de ejecución. | Auditoría estática predictiva mediante `MigrationAuditor.auditConfig()` con diagnósticos categorizados. |
| **Canal de Telemetría** | Dependiente de consolas de navegador estándar (`console.log`). | Enlace bidireccional serializado mediante `postMessage` para logs, errores de shaders WGSL y telemetría. |
| **Gestión de Recursos REPL** | Fugas de contextos WebGL frecuentes tras múltiples ejecuciones de ejemplos de código. | Ciclo de vida controlado por `Blob` revocable y desvinculación explícita del pipeline de render. |

---

## 4. Guía de Uso Práctico y Ejemplos de Implementación

### 4.1. Integración de `PlaygroundRunner` en un Panel de Desarrollo

El siguiente ejemplo muestra cómo integrar el arnés interactivo dentro de una herramienta web o documentación interactiva para ejecutar código de Tacarigua 1.0.0 en caliente:

```javascript
import { PlaygroundRunner } from '@tacarigua/docs-playground';

// 1. Obtener el contenedor del DOM
const container = document.getElementById('repl-container');

// 2. Instanciar el ejecutor configurando los callbacks de telemetría
const runner = new PlaygroundRunner(container, {
    onConsoleLog: (msg) => {
        console.log(`%c[Sandbox Console] ${msg}`, 'color: #00ffff');
    },
    onConsoleError: (err) => {
        console.error(`[Sandbox Error] ${err.message}`, err.stack);
    },
    onMetricsUpdate: (metrics) => {
        document.getElementById('fps-counter').innerText = `FPS: ${metrics.fps}`;
    }
});

// 3. Código fuente del juego a ejecutar en tiempo real
const gameCode = `
    import { Game, RENDER_TYPE } from './core.js';
    import { ECSWorld, MovementSystem } from './ecs.js';

    const game = new Game({
        type: RENDER_TYPE.AUTO,
        scale: { width: 800, height: 600 }
    });

    const world = new ECSWorld(1000);
    world.addSystem(new MovementSystem(world));

    for (let i = 0; i < 500; i++) {
        const entity = world.createEntity();
        world.addComponent(entity, world.Transform, { x: 400, y: 300, scaleX: 1, scaleY: 1 });
        world.addComponent(entity, world.Velocity, { vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200 });
    }

    console.log("Mundo ECS inicializado con 500 entidades en WebGPU");
`;

// 4. Despachar ejecución
runner.execute(gameCode);

// 5. Para detener y limpiar el entorno cuando el usuario cambie de pestaña o ejemplo:
// runner.destroy();
```

### 4.2. Auditoría Preventiva de una Configuración Heredada

Antes de instanciar la clase `Game`, se recomienda pasar la configuración del proyecto por `MigrationAuditor` para identificar dependencias obsoletas:

```javascript
import { MigrationAuditor } from '@tacarigua/docs-playground';
import { Game, RENDER_TYPE } from '@tacarigua/core.js';

const userConfig = {
    type: 1, // CANVAS heredado
    parent: 'game-container',
    width: 1024,
    height: 768,
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: 300 },
            useTree: false // Propiedad obsoleta en v1.0.0
        }
    },
    audio: {
        disableWebAudio: true // Propiedad rota en v1.0.0
    }
};

// Auditar configuración
const diagnostics = MigrationAuditor.auditConfig(userConfig);

for (const issue of diagnostics) {
    if (issue.level === 'breaking') {
        console.error(`[CRÍTICO] Campo "${issue.field}": ${issue.advice}`);
    } else if (issue.level === 'deprecated') {
        console.warn(`[OBSOLETO] Campo "${issue.field}": ${issue.advice}`);
    } else {
        console.info(`[AVISO] Campo "${issue.field}": ${issue.advice}`);
    }
}

// Transformación correctiva si hay errores críticos
if (diagnostics.some(d => d.level === 'breaking')) {
    console.log('Aplicando correcciones automáticas para Tacarigua 1.0.0...');
    userConfig.type = RENDER_TYPE.AUTO;
    delete userConfig.audio.disableWebAudio;
    delete userConfig.physics.arcade.useTree;
}

const game = new Game(userConfig);
```

---

## 5. Guía de Migración y Breaking Changes

A continuación se detallan las áreas principales de incompatibilidad técnica extraídas de `MIGRATION_MANUAL` y cómo resolverlas al actualizar proyectos de **Phaser 4.2.1** a **Tacarigua 1.0.0**.

### 5.1. Desacoplamiento del Espacio de Nombres Global

* **Problema en Phaser v4.2.1**: Los proyectos dependían del objeto global `window.Phaser`, lo que impedía que herramientas como Vite, Rollup o esbuild eliminaran código no utilizado (*tree-shaking*).
* **Solución en Tacarigua v1.0.0**: Todos los componentes se empaquetan en submódulos ESM independientes.

```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser 4.2.1)
// ==========================================
const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    scene: [BootScene, PlayScene]
});

// ==========================================
// CÓDIGO MODERNO (Tacarigua 1.0.0)
// ==========================================
import { Game, RENDER_TYPE } from '@tacarigua/core.js';

const game = new Game({
    type: RENDER_TYPE.AUTO, // Prioriza WebGPU con degradación transparente a WebGL 2
    scale: {
        width: 800,
        height: 600
    },
    scene: [BootScene, PlayScene]
});
```

---

### 5.2. Pipeline de Post-Procesamiento: Migración de GLSL a WGSL

* **Problema en Phaser v4.2.1**: Los efectos personalizados heredaban de `Phaser.Renderer.WebGL.Pipelines.MultiPipeline` y escribían cadenas en lenguaje GLSL ES 1.0/2.0, obligando al uso de la máquina de estados de WebGL.
* **Solución en Tacarigua v1.0.0**: Los efectos deben heredar de `PostFXEffect` y escribir sombreadores en WGSL estructurado, vinculándose a través de buffers uniformes gestionados por la RHI.

```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser 4.2.1) - Fragment Shader GLSL
// ==========================================
const CustomPipeline = new Phaser.Class({
    Extends: Phaser.Renderer.WebGL.Pipelines.MultiPipeline,
    initialize: function CustomPipeline(game) {
        Phaser.Renderer.WebGL.Pipelines.MultiPipeline.call(this, {
            game: game,
            fragShader: `
                precision mediump float;
                uniform sampler2D uMainSampler;
                varying vec2 outTexCoord;
                void main(void) {
                    vec4 color = texture2D(uMainSampler, outTexCoord);
                    gl_FragColor = vec4(color.rgb * 0.5, color.a);
                }
            `
        });
    }
});

// ==========================================
// CÓDIGO MODERNO (Tacarigua 1.0.0) - Sombreador Nativo WGSL
// ==========================================
import { PostFXEffect } from '@tacarigua/batch-renderer-2d';

export class DarkenFX extends PostFXEffect {
    constructor(rhi) {
        super('DarkenFX', rhi);
        
        this.shaderCode = `
            @group(0) @binding(1) var uSampler: sampler;
            @group(0) @binding(2) var uTexture: texture_2d<f32>;

            @fragment
            fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
                let uv = fragCoord.xy / vec2<f32>(800.0, 600.0);
                let color = textureSample(uTexture, uSampler, uv);
                return vec4<f32>(color.rgb * 0.5, color.a);
            }
        `;
    }

    apply(sourceTexture, targetTexture) {
        if (!this.enabled) return;
        // Despacho automático de la pasada fullscreen mediante la RHI
    }
}
```

---

### 5.3. Cargas Masivas: Sustitución de GameObjects por el Motor ECS

* **Problema en Phaser v4.2.1**: La creación de decenas de miles de instancias de sprites sobrecargaba el montón (*Heap*) de JavaScript debido al peso de las clases orientadas a objetos, provocando recolecciones de basura frecuentes (*GC freezes*).
* **Solución en Tacarigua v1.0.0**: Uso del diseño orientado a datos (DOD) mediante arreglos contiguos en memoria tipada con `ECSWorld`.

```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser 4.2.1) - OOP Tradicional (Sobrecarga de GC)
// ==========================================
const bullets = [];
for (let i = 0; i < 15000; i++) {
    const sprite = this.add.sprite(0, 0, 'bullet');
    this.physics.add.existing(sprite);
    sprite.body.setVelocity(200, 50);
    bullets.push(sprite);
}

// ==========================================
// CÓDIGO MODERNO (Tacarigua 1.0.0) - ECS con Búferes Contiguos (Zero GC)
// ==========================================
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

const world = new ECSWorld(15000);
world.addSystem(new MovementSystem(world));

for (let i = 0; i < 15000; i++) {
    const entity = world.createEntity();
    world.addComponent(entity, world.Transform, { x: 0, y: 0, scaleX: 1, scaleY: 1 });
    world.addComponent(entity, world.Velocity, { vx: 200, vy: 50 });
}
// En cada frame: world.step(time, delta);
```

---

## 6. Consideraciones de Seguridad y Aislamiento de Memoria

1. **Aislamiento Cruzado (Cross-Origin Isolation)**: Para permitir que las físicas se ejecuten en hilos independientes (`@tacarigua/physics-worker`) dentro del arnés provisto por `PlaygroundRunner`, el servidor que aloje el playground debe proveer los encabezados de respuesta HTTP correspondientes:
   ```http
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
2. **Ciclo de Vida de Objetos Binarios (Blob Leaks)**: Cada invocación de `execute()` crea un recurso interno mediante `URL.createObjectURL`. El método `stop()` revoca inmediatamente este identificador para liberar los descriptores de archivos virtuales del navegador, mitigando el agotamiento de memoria virtual en sesiones prolongadas de prueba.