# Documentación Técnica: Herramientas de Construcción y Plugin de Vite con HMR (`@tacarigua/vite-plugin`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

En las versiones previas de Phaser (v3.x y v4.2.1), la experiencia de desarrollo (*Developer Experience - DX*) estaba condicionada por herramientas de construcción legadas basadas en Webpack o Rollup sin integración nativa:
1. **Recargas Completas de Página (*Full Page Reloads*):** Cualquier modificación en un archivo de escena (`Phaser.Scene`) forzaba la recarga total del navegador. Esto destruía la instancia de `Phaser.Game`, reinicializaba el contexto gráfico de WebGL, reiniciaba el árbol de audio y obligaba al desarrollador a navegar manualmente a través de menús y niveles para reproducir el estado de prueba.
2. **Carga Ineficiente de Sombreadores:** La importación de sombreadores requería configurar cargadores específicos de texto plano (`raw-loader`, plugins de cadenas) o insertar código GLSL en cadenas multilínea dentro del código fuente de JavaScript, incrementando innecesariamente el peso del bundle final con comentarios y espacios en blanco.
3. **Monolito sin Tree-Shaking:** El empaquetado generaba archivos monolíticos de gran volumen al carecer de delimitaciones estrictas de efectos secundarios (`sideEffects`) y mapas de exportación condicionales.

En **Tacarigua 1.0.0**, el módulo `@tacarigua/vite-plugin` proporciona una suite de compilación moderna optimizada para **Vite**:
- **Reemplazo de Módulos en Caliente de Escenas (*Scene HMR*):** Permite editar el código de una `Scene` y ver reflejados los cambios al instante sin recargar la pestaña del navegador, preservando el estado transitorio (`data`, `registry`, cámaras y transformaciones).
- **Compilador y Minificador Nativo de Shaders:** Transforma automáticamente archivos con extensiones `.wgsl`, `.glsl`, `.vert` y `.frag` en módulos ECMAScript compactos durante la compilación, aplicando minificación agresiva en producción.
- **Recarga de Sombreadores en Tiempo Real:** Las modificaciones en archivos de sombreadores WGSL se inyectan en caliente disparando eventos `phaser-shader-reload` que actualizan los pipelines gráficos sin interrumpir el bucle de renderizado.
- **Especificación de Exportaciones Modulares (*Subpath Exports*):** Define la topología del paquete en `package.json` con `"sideEffects": false` para garantizar que herramientas como Vite, Rollup o Esbuild descarguen del bundle final cualquier subsistema no utilizado.

---

## 2. Estructura Interna del Módulo

El módulo se compone de tres piezas fundamentales:

```
@tacarigua/vite-plugin
├── SceneHMRBridge.js           -> Puente de ejecución para captura y restauración de estado en HMR
├── ShaderTransformer.js        -> Minificador y conversor de WGSL/GLSL a módulos ESM
├── phaserVitePlugin (default)  -> Definición del plugin de Vite (Hooks: configResolved, transform)
└── TACARIGUA_PACKAGE_EXPORTS_SPEC -> Contrato formal de distribución y tree-shaking del monorepo
```

### 2.1. Puente de Ejecución HMR: `SceneHMRBridge`
Opera en el navegador del desarrollador cuando Vite detecta cambios en caliente (`import.meta.hot`):
1. **Interceptación del Módulo:** Captura la actualización mediante `hot.accept()`.
2. **Localización de Instancias Activas:** Consulta el gancho global `window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__` para obtener las instancias de `Game` en ejecución.
3. **Serialización del Estado Transitorio:** Extrae los diccionarios de variables de escena (`scene.data.getAll()`) y la configuración serializada de la cámara principal (`scene.cameras.main.toJSON()`).
4. **Sustitución en Caliente de la Definición:**
   ```javascript
   game.scene.remove(sceneKey);             // 1. Remueve la clase anterior
   game.scene.add(sceneKey, NewSceneClass); // 2. Registra la nueva clase
   game.scene.start(sceneKey, preserved);   // 3. Reinicia inyectando el estado previo
   ```
5. **Restauración de Cámaras:** Reconfigura el viewport, scroll y zoom mediante `cameras.main.fromJSON()`.

---

### 2.2. Minificador y Transformador de Sombreadores: `minifyShader` / `transformShaderToESM`
Procesa los archivos de sombreadores en tiempo de compilación sin depender de analizadores sintácticos pesados (AST-less regex transform):
- **Limpieza de Comentarios:** Erradica comentarios de bloque (`/* ... */`) y comentarios de línea (`// ...`).
- **Colapso de Espacios en Blanco:** Elimina saltos de línea y tabulaciones redundantes, comprimiendo espacios en torno a delimitadores (`{`, `}`, `;`, `,`, `=`, `(`, `)`, operadores aritméticos y lógicos).
- **Generación de Módulos ESM:** Convierte el código minificado en una exportación por defecto (`export default shaderSource;`) y añade ganchos de reactividad para notificar recargas en caliente de shaders mediante el evento de ventana `phaser-shader-reload`.

---

### 2.3. Plugin Principal: `phaserVitePlugin`
Se integra en la cadena de compilación de Vite con prioridad `enforce: 'pre'`:
- **`configResolved`:** Detecta si la compilación actual corresponde a un entorno de desarrollo (`vite dev`) o producción (`vite build`).
- **`transform(code, id)`:**
  - Si el archivo coincide con la extensión de un sombreador (`/\.(wgsl|glsl|vert|frag)$/i`), lo transforma a módulo ESM invocando `transformShaderToESM()`.
  - Si el archivo es un script (`.js` o `.ts`) y declara una clase que hereda de `Scene` o `Phaser.Scene`, inyecta automáticamente el bloque de registro de `SceneHMRBridge` en su pie de archivo, liberando al desarrollador de tener que escribir código de infraestructura HMR manualmente.

---

## 3. Ciclo de Vida del Reemplazo de Escenas en Caliente (Scene HMR)

El siguiente flujo detalla la secuencia de operaciones ejecutada cuando un desarrollador modifica un archivo de escena en su entorno de trabajo:

```
  [ Desarrollador guarda PlayerScene.js ]
                    │
                    ▼
     Vite detecta mutación en el disco
                    │
                    ▼
  phaserVitePlugin.transform() ────────► Inyecta SceneHMRBridge.register()
                    │
                    ▼
   Vite despacha parche HMR vía WebSocket
                    │
                    ▼
  [ Navegador: SceneHMRBridge.register() ]
                    │
  ┌─────────────────┴─────────────────┐
  │ 1. Consulta TACARIGUA_DEVTOOLS...  │
  │ 2. Localiza instancia de juego    │
  └─────────────────┬─────────────────┘
                    │
  ┌─────────────────┴─────────────────┐
  │ 3. Serializa scene.data           │
  │    Serializa cameras.main         │
  └─────────────────┬─────────────────┘
                    │
  ┌─────────────────┴─────────────────┐
  │ 4. game.scene.remove(key)         │
  │    game.scene.add(key, NewClass)  │
  │    game.scene.start(key, data)    │
  └─────────────────┬─────────────────┘
                    │
                    ▼
   [ Escena recargada con lógica nueva ]
   - Mismo Game y Loop activo
   - Mismo contexto WebGPU y texturas
   - Misma posición de cámara y estado
```

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v5.0.0)

| Característica | Phaser 4.2.1 (Webpack / Rollup Manual) | Tacarigua 1.0.0 (`@tacarigua/vite-plugin`) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Tiempo de Recarga en Desarrollo** | 2.5 a 6.0 segundos (Recarga total de página). | **$< 80\text{ ms}$ (Reemplazo en caliente HMR)**. | Iteración instantánea durante el ajuste de físicas, animaciones y UI. |
| **Preservación de Estado** | Nula (Se reinicia el juego por completo). | **Preservación de estado de escena y cámara**. | No requiere navegar menús para reproducir situaciones de prueba. |
| **Importación de Shaders** | Requiere loaders complejos (`raw-loader`). | **Nativa con soporte WGSL/GLSL automático**. | Los shaders se importan como cadenas ESM directamente. |
| **Tamaño de Shaders en Bundle** | Contienen espacios, comentarios y tabulaciones. | **Minificación de código en build de producción**. | Ahorro del 30% al 50% en el peso de los sombreadores. |
| **Topología de Exportación** | Importaciones monolíticas globales. | **Subpath Exports con `sideEffects: false`**. | Bundles finales mínimos; exclusión total de módulos no importados. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Configuración de Vite con `phaserVitePlugin` (`vite.config.js`)

Cómo configurar un proyecto moderno con soporte completo para Tacarigua 1.0.0 y WebGPU:

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import phaserVitePlugin from '@tacarigua/vite-plugin';

export default defineConfig({
    plugins: [
        phaserVitePlugin({
            minifyShaders: true,  // Minifica código WGSL/GLSL en compilaciones de producción
            sceneHMR: true        // Habilita la recarga de escenas en caliente sin perder estado
        })
    ],
    server: {
        port: 3000,
        headers: {
            // Encabezados requeridos para habilitar SharedArrayBuffer en físicas off-thread
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    },
    build: {
        target: 'es2022', // Optimizado para WebGPU y clases nativas modernas
        sourcemap: true
    }
});
```

---

### Ejemplo 2: Importación Directa de Sombreadores WGSL

Gracias al transformador del plugin, cualquier sombreador WGSL o GLSL puede importarse directamente como un módulo de JavaScript:

```javascript
// main.js
import { Game, RENDER_TYPE } from '@tacarigua/core.js';
import customPostProcessWGSL from './shaders/CustomFilter.wgsl';

console.log('Código fuente WGSL minificado listo para GPU:');
console.log(customPostProcessWGSL);

// El código fuente importado puede pasarse directamente al compilador de pipelines de la RHI
const game = new Game({
    width: 1280,
    height: 720,
    render: { preferWebGPU: true }
});
```

---

### Ejemplo 3: Declaración de Escena Compatible con HMR Automático

El plugin detecta automáticamente clases que extiendan de `Scene` e inyecta la reactividad HMR sin necesidad de decoradores manuales:

```javascript
// scenes/BattleScene.js
import { Scene } from '@tacarigua/core.js';

export default class BattleScene extends Scene {
    constructor() {
        super({ key: 'BattleScene' });
    }

    init(data) {
        // 'data' conserva los valores previos tras un reemplazo en caliente (HMR)
        this.score = data.score || 0;
    }

    create() {
        // Al modificar este método y guardar el archivo, la escena se recargará
        // en menos de 100ms preservando el valor de this.score y la posición de la cámara
        console.log(`[BattleScene] Creada con puntuación acumulada: ${this.score}`);
    }

    update(time, delta) {
        // Modificaciones a la lógica de movimiento se aplican al instante
    }
}
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Migrar el Empaquetador de Webpack a Vite
1. Desinstale las dependencias heredadas de Webpack:
   ```bash
   npm uninstall webpack webpack-cli webpack-dev-server raw-loader
   ```
2. Instale Vite y el plugin oficial de Phaser 5:
   ```bash
   npm install --save-dev vite @tacarigua/vite-plugin
   ```
3. Cree el archivo `vite.config.js` referenciado en el **Ejemplo 1**.

### Paso 2: Reemplazar Cargas de Shaders Manuales
- **Antes (Phaser v4.2.1):**
  ```javascript
  // Requería configuración específica de raw-loader en Webpack
  const fragShader = require('./shader.frag');
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Importación ESM nativa procesada automáticamente por el plugin
  import fragShader from './shader.frag';
  import modernShaderWGSL from './shader.wgsl';
  ```

### Paso 3: Asegurar la Estructura de Exportación de Escenas
Para que el sistema de HMR identifique correctamente la escena a reemplazar, asegúrese de que cada archivo de escena exporte la clase por defecto (*default export*) o con una exportación nombrada consistente con el nombre de su clave (`key`):
```javascript
export default class GameScene extends Scene { ... }
```