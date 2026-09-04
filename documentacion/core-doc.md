# Documentación Técnica: Módulo Core (`@tacarigua/core`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

El módulo `@tacarigua/core` constituye el núcleo fundacional y orquestador del ciclo de vida de **Tacarigua.js 1.0.0**. En versiones anteriores de Phaser (v4.2.1 e inferiores), el núcleo estaba acoplado a un objeto global monolítico (`window.Phaser`), dependía de un emulador de herencia sintético (`Phaser.Class`), realizaba múltiples asignaciones dinámicas de memoria por cuadro (*per-frame allocations*) y forzaba una dependencia directa con el DOM del navegador, lo que impedía su ejecución nativa en entornos aislados como **Web Workers** o servidores **Node.js/Bun**.

En **Tacarigua 1.0.0**, este módulo ha sido completamente reescrito bajo estándares **ES2022+**, adoptando:
- **Modularidad ESM Estricta:** Eliminación total de dependencias globales; exportaciones independientes preparadas para *tree-shaking* agresivo en bundlers modernos (Vite, Rollup, Esbuild).
- **Loop Principal de Asignación Cero (Zero-GC Timestep):** Eliminación de la creación y descarte de arreglos dinámicos en el cálculo de deltas mediante el uso de búferes circulares sobre `Float64Array`.
- **Arquitectura Agnóstica del Entorno:** Ejecución desacoplada del DOM que permite correr instancias headless en Workers dedicados mediante `OffscreenCanvas` o entornos de servidor para simulación determinista autoritativa.
- **Canal Reactivo de Señales (`Signal`):** Comunicación interna basada en listas doblemente enlazadas de alta velocidad sin sobrecarga por concatenación o serialización de cadenas de texto.

---

## 2. Estructura Interna y Componentes del Módulo

El módulo `@tacarigua/core` se compone de cinco piezas arquitectónicas principales:

```
@tacarigua/core
├── core       -> Enumeraciones inmutables (RENDER_TYPE, BLEND_MODE, SCALE_MODE, CORE_EVENTS)
├── Signal          -> Primitiva reactiva de enlace rápido (Lista doblemente enlazada)
├── EventEmitter    -> Bus de eventos desacoplado por canales basado en Signals
├── TimeStep        -> Reloj de alta resolución, estabilizador de delta y limitador de FPS
├── Config          -> Validador e inicializador inmutable de opciones de arranque
└── Game            -> Orquestador del ciclo de vida, puente de subsistemas y render
```

### 2.1. Enumeraciones y Constantes Fundamentales (`core.js`)
Define los contratos de tipos primitivos congelados (`Object.freeze`) para evitar modificaciones accidentales en tiempo de ejecución:
- `RENDER_TYPE`: Introduce `WEBGPU: 4` como objetivo de renderizado primario junto a `AUTO: 0`, `CANVAS: 1`, `WEBGL: 2` y `HEADLESS: 3`.
- `CORE_EVENTS`: Catálogo estandarizado de eventos de bajo nivel (`boot`, `ready`, `prestep`, `step`, `poststep`, `prerender`, `postrender`, etc.).
- `SCALE_MODE` y `BLEND_MODE`: Modos de adaptación matemática de lienzo y mezcla cromática.

### 2.2. Sistema de Señales y Eventos (`Signal` / `core.js`)
- **`SignalBinding`**: Nodo de enlace que encapsula la función de retrollamada (*callback*), el contexto de ejecución y el flag de ejecución única (`once`), implementando punteros `prev` y `next`.
- **`Signal`**: Estructura de datos en lista enlazada. A diferencia del sistema anterior basado en `Array.splice` sobre arreglos de listeners:
  - La inserción (`add` / `addOnce`) se realiza en tiempo constante $O(1)$.
  - La desconexión (`detach`) se realiza en $O(1)$ sin provocar desplazamientos de índices en memoria.
  - El despacho (`dispatch`) recorre los punteros directos, reduciendo el salto de punteros y evitando la clonación defensiva del array de eventos.
- **`EventEmitter`**: Mapea cadenas de eventos a instancias de `Signal` en un `Map` estático. Provee retrocompatibilidad con la API tradicional (`on`, `once`, `off`, `emit`).

### 2.3. Motor de Tiempo y Bucle Principal (`TimeStep`)
Es el corazón del motor. Determina cuándo y cómo se actualizan los sistemas lógicos y el pipeline de dibujo.
- **Búfer Circular Estático de Deltas:** Implementa un `Float64Array` de tamaño fijo (`deltaSmoothingMax`, por defecto 10). La actualización del historial se gestiona mediante un puntero de anillo:
  $$\text{deltaIndex} = (\text{deltaIndex} + 1) \pmod{\text{deltaSmoothingMax}}$$
  Esto garantiza que el suavizado de cuadros (*delta smoothing*) no realice llamadas al asignador de memoria ni active el recolector de basura (*Garbage Collector*).
- **Soporte Híbrido de Sincronización:** Adapta dinámicamente el origen del pulso entre `requestAnimationFrame`, temporizadores de precisión basados en `setTimeout` (para Web Workers o servidores) y `performance.now()`.

### 2.4. Normalizador de Configuración (`Config`)
Procesa el objeto de opciones del usuario asegurando tipado y valores por defecto consistentes:
- Configura las propiedades de WebGPU (`preferWebGPU`, `useComputeShaders`, `powerPreference`).
- Establece la cadencia de cuadros (`fps.minFps`, `fps.targetFps`, `fps.fpsLimit`, `fps.smoothStep`).
- Protege los límites de textura y tamaños de lote (`batchSize`, `maxTextures`).

### 2.5. El Orquestador (`Game`)
Centraliza el ciclo de vida, resuelve el canvas destino, vincula los eventos de foco y visibilidad de la ventana, y ejecuta la secuencia secuencial de fases por fotograma.

---

## 3. Flujo de Datos y Ciclo de Vida (Game Loop Lifecycle)

En cada iteración del bucle temporal coordinado por `TimeStep`, se ejecuta una secuencia determinista dividida en dos grandes etapas: **Simulación Lógica** y **Pipeline de Renderizado**.

```
                           [ requestAnimationFrame / Worker Pulse ]
                                             │
                                             ▼
                                  TimeStep._stepInternal()
                                             │
                       Calcula Delta / Suaviza vía Float64Array
                                             │
                                             ▼
                                     Game.step(time, delta)
                                             │
         ┌───────────────────────────────────┴───────────────────────────────────┐
         │                                                                       │
         ▼                                                                       ▼
   [ MODO NORMAL ]                                                       [ MODO HEADLESS ]
         │                                                                       │
         ├─► events.emit(CORE_EVENTS.PRE_STEP)                                  ├─► events.emit(CORE_EVENTS.PRE_STEP)
         │                                                                       │
         ├─► events.emit(CORE_EVENTS.STEP)                                      ├─► events.emit(CORE_EVENTS.STEP)
         ├─► scene.update(time, delta)                                           ├─► scene.update(time, delta)
         │                                                                       │
         ├─► events.emit(CORE_EVENTS.POST_STEP)                                 ├─► events.emit(CORE_EVENTS.POST_STEP)
         │                                                                       │
         ├─► renderer.preRender()                                                └─► (Finaliza ciclo sin dibujar)
         ├─► events.emit(CORE_EVENTS.PRE_RENDER)
         ├─► scene.render(renderer)
         ├─► renderer.postRender()
         │
         └─► events.emit(CORE_EVENTS.POST_RENDER)
```

### Fases de Ejecución:
1. **Fase `PRE_STEP`:** Preparación de subsistemas (actualización de colas de entrada, lectura de buffers de red o cómputo off-thread).
2. **Fase `STEP`:** Ejecución de la lógica de las escenas registradas, pasos de integración física (Arcade/Matter/Rapier) y sistemas ECS.
3. **Fase `POST_STEP`:** Limpieza de entidades marcadas para destrucción y ordenamiento de profundidad de capas (*Depth sorting*).
4. **Fase `PRE_RENDER`:** Limpieza de búferes de color, profundidad y stencil en el contexto gráfico (`RHI`).
5. **Fase `RENDER`:** Recorrido del árbol visual de cámaras y codificación de llamadas de dibujo (*Draw calls*) hacia WebGPU o WebGL 2.
6. **Fase `POST_RENDER`:** Resolución de texturas de post-procesamiento (*PostFX*), capturas de pantalla (*snapshots*) y despacho de comandos a la GPU.

---

## 4. Comparativa de Rendimiento y Cambios de Ruptura (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Característica | Phaser 4.2.1 (Legacy) | Tacarigua 1.0.0 (Modernizado) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Paradigma de Clases** | Emulación `new Phaser.Class({})` | Clases nativas ES2022+ (`class`) | Optimización en compilación JIT y menor consumo de memoria. |
| **Empaquetado** | Objeto global monolítico / UMD | ESM puro con exports condicionales | *Tree-shaking* real; reducción de hasta un 60% en bundles ligeros. |
| **Búfer de Delta en Loop** | `Array` dinámico (`push`/`shift`) | `Float64Array` estático (anillo circular) | Cero asignaciones en memoria heap; supresión de *GC micro-stutter*. |
| **Backend Gráfico Primario** | WebGL 1 / 2 imperativo | WebGPU (RHI) con fallback WebGL 2 | Acceso a pipelines modernos de GPU y Compute Shaders. |
| **Despacho de Eventos** | Búsqueda y corte de Arrays (`splice`) | Lista doblemente enlazada (`Signal`) | Inserción y eliminación de listeners en $O(1)$ sin mutaciones costosas. |
| **Entorno de Ejecución** | Acoplado rígidamente a `window` y `document` | Abstraído de variables globales de ventana | Soporte nativo para Web Workers y servidores Node.js/Bun. |

---

## 5. Guía de Uso y Ejemplos Prácticos (ES6+)

### Ejemplo 1: Inicialización Básica Modular con Vite y ESM

```javascript
import { Game, RENDER_TYPE, SCALE_MODE } from '@tacarigua/core.js';

// Configuración desacoplada y fuertemente tipada
const config = {
    type: RENDER_TYPE.AUTO, // Selecciona WebGPU automáticamente si está disponible, con fallback a WebGL 2
    width: 1280,
    height: 720,
    scaleMode: SCALE_MODE.FIT,
    autoCenter: 1, // Centrado horizontal y vertical automático
    backgroundColor: 0x0a0e17,
    render: {
        antialias: true,
        pixelArt: false,
        powerPreference: 'high-performance',
        preferWebGPU: true
    },
    fps: {
        targetFps: 60,
        smoothStep: true,
        deltaHistory: 10
    },
    callbacks: {
        preBoot: (game) => {
            console.log('[Sistema] Pre-inicialización completada.');
        },
        postBoot: (game) => {
            console.log('[Sistema] Motor arrancado con renderizador tipo:', game.config.renderType);
        }
    }
};

// Instanciación limpia sin polución de variables globales
const game = new Game(config);
```

---

### Ejemplo 2: Uso del Sistema Reactivo de Señales de Alta Velocidad

Para estados que se actualizan frecuentemente (como posición del cursor, vida del jugador o envío de paquetes de red a 60/120 Hz), se recomienda el uso directo de `Signal` en lugar del bus de eventos tradicional por cadenas:

```javascript
import { Signal } from '@tacarigua/core.js';

// Creación de la señal para telemetría de posición
const onPlayerPositionChanged = new Signal();

// Componente visual o UI que escucha el cambio
const binding = onPlayerPositionChanged.add((x, y, isGrounded) => {
    // Se ejecuta de manera sincrónica sin asignación de strings de evento
    console.log(`Posición: X=${x}, Y=${y}, En Suelo=${isGrounded}`);
});

// Emisión en el loop de actualización (Zero GC)
function updatePlayer(delta) {
    const currentX = 150.5;
    const currentY = 320.0;
    const grounded = true;

    // Despacho ultrarrápido a través de la lista enlazada
    onPlayerPositionChanged.dispatch(currentX, currentY, grounded);
}

// Desconexión en tiempo constante O(1) cuando se destruye el objeto
binding.detach();
```

---

### Ejemplo 3: Ejecución de un Bucle Headless en un Web Worker

Tacarigua 1.0.0 permite ejecutar instancias sin interfaz visual dentro de un Worker para servidores dedicados o físicas pesadas:

```javascript
// worker-physics.js
import { Game, RENDER_TYPE, CORE_EVENTS } from '@tacarigua/core.js';

const serverConfig = {
    type: RENDER_TYPE.HEADLESS, // Sin canvas ni contexto de dibujo
    customEnvironment: true,
    width: 800,
    height: 600,
    fps: {
        targetFps: 60,
        forceSetTimeout: true // Utiliza temporizadores compatibles con Workers
    }
};

const simulation = new Game(serverConfig);

// Suscripción al ciclo de cálculo lógico
simulation.events.on(CORE_EVENTS.STEP, (time, delta) => {
    // Simulación de física autoritativa desacoplada de la GPU
});

// Arranque manual de la simulación
simulation.boot();
```

---

## 6. Guía de Migración: de Phaser v4.2.1 a Tacarigua v1.0.0

Para migrar una base de código construida sobre la versión v4.2.1 hacia la arquitectura de Tacarigua 1.0.0, siga estos pasos:

### Paso 1: Eliminar el Objeto Global y Usar Importaciones Nombradas
- **Antes (Phaser v4.2.1):**
  ```javascript
  const config = {
      type: Phaser.AUTO,
      scale: { mode: Phaser.Scale.FIT }
  };
  const game = new Phaser.Game(config);
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  import { Game, RENDER_TYPE, SCALE_MODE } from '@tacarigua/core.js';

  const config = {
      type: RENDER_TYPE.AUTO,
      scaleMode: SCALE_MODE.FIT
  };
  const game = new Game(config);
  ```

### Paso 2: Reemplazo de Herencia Clásica por Clases Nativas ES2022
- **Antes (Phaser v4.2.1):**
  ```javascript
  var MyCustomPlugin = new Phaser.Class({
      initialize: function MyCustomPlugin(game) {
          this.game = game;
      },
      update: function () { ... }
  });
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  export class MyCustomPlugin {
      constructor(game) {
          this.game = game;
      }
      update() { ... }
  }
  ```

### Paso 3: Migración de Eventos Críticos a Señales (`Signals`)
Si cuenta con emisores de eventos utilizados en bucles de alta frecuencia (como `update`, `preupdate`, `progress`), sustituya el emisor genérico por `Signal` para reducir la presión sobre el recolector de basura:
- **Antes (Phaser v4.2.1):**
  ```javascript
  this.events.emit('player-moved', x, y);
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Declarado en la inicialización: this.onPlayerMoved = new Signal();
  this.onPlayerMoved.dispatch(x, y);
  ```

### Paso 4: Adaptar la Configuración de Renderizado para WebGPU
Si utilizaba pipelines personalizados directos en WebGL 1/2, configure explícitamente `preferWebGPU: true` en el bloque de renderizado del `Config` y verifique el manejo de pérdida de contexto mediante el evento `CORE_EVENTS.CONTEXT_LOST`.