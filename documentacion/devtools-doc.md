# Documentación Técnica: Herramientas de Desarrollo y Diagnóstico en Tiempo Real (`@tacarigua/devtools`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

En Phaser 4.2.1 y versiones precedentes, las labores de depuración y perfilado dependían de soluciones dispersas: llamadas ad-hoc a `console.log`, plugins comunitarios no estandarizados o la creación de interfaces DOM complejas que interferían con las mediciones de rendimiento. La mayor problemática radicaba en que las propias herramientas de diagnóstico instanciaban objetos en el *heap* durante cada cuadro, provocando picos artificiales de recolección de basura (*Garbage Collection*) y falseando las lecturas de tasa de refresco y tiempos de frame.

En **Tacarigua 1.0.0**, el módulo `@tacarigua/devtools` introduce una infraestructura de diagnóstico profesional y desacoplada:
- **Hook Global Estandarizado (`TACARIGUA_DEVTOOLS_GLOBAL_HOOK__`):** Expone un punto de anclaje global que permite a las extensiones oficiales de navegador (para Chrome y Firefox) detectar e inspeccionar automáticamente cualquier instancia activa del motor en la página.
- **Muestreo de Rendimiento sin Recolección de Basura (*Zero-Allocation Sampling*):** Emplea búferes circulares de tipo `Float32Array` (`MetricSampler`) para calcular medias, mínimos y máximos de tiempos de CPU y GPU sin reservar memoria dinámica durante el perfilado.
- **Estimación Continua de VRAM:** Monitorea dinámicamente la memoria de video asignada en GPU sumando el peso de texturas de atlas (`RGBA8`), búferes de intercambio y UBOs de la RHI.
- **Capa Visual Superpuesta (*Debug Overlays*):** Despliega un HUD transparente con gráficos de líneas (*sparklines*) de FPS y tiempos de fase, así como contornos visuales de cajas de colisión física (AABB) y zonas de impacto interactivo (*hitboxes*).
- **Mutación Bidireccional en Caliente:** Canaliza comandos remotos desde el panel de herramientas del desarrollador para alterar valores de objetos (`x`, `y`, `scale`, `visible`, `tint`) en tiempo de ejecución.

---

## 2. Estructura Interna del Módulo

El módulo se articula en cuatro componentes especializados:

```
@tacarigua/devtools
├── MetricSampler.js         -> Búfer circular Float32Array para métricas estadísticas
├── PerformanceProfiler.js   -> Cronometraje de fases del motor y estimación de VRAM
├── DebugOverlayRenderer.js  -> Lienzo superpuesto en DOM para HUD, AABBs y Hitboxes
└── DevToolsAgent.js         -> Coordinador de comunicación bidireccional vía window.postMessage
```

### 2.1. Muestreador Estadístico: `MetricSampler`
Implementa una ventana deslizante de muestras de tamaño fijo (por defecto, 120 cuadros, equivalente a 2 segundos a 60 FPS o 1 segundo a 120 FPS):
- **Estructura Interna:** Un búfer plano `Float32Array(sampleSize)` gestionado mediante aritmética modular:
  $$\text{index} = (\text{index} + 1) \pmod{\text{sampleSize}}$$
- **Cálculos Directos:** Métodos vectorizados `getAverage()`, `getMin()` y `getMax()` que operan linealmente sobre el búfer contiguo sin clonar datos.

---

### 2.2. Perfilador de Rendimiento: `PerformanceProfiler`
Mide la duración milimétrica de las etapas críticas del ciclo de vida del juego mediante `performance.now()`:
- **Fase de Lógica (`stepTimeMs`):** Intervalo transcurrido entre `CORE_EVENTS.PRE_STEP` y `CORE_EVENTS.POST_STEP`. Cuantifica el coste de actualización de escenas, sistemas ECS, scripts y máquinas de estado.
- **Fase de Renderizado (`renderTimeMs`):** Intervalo entre `CORE_EVENTS.PRE_RENDER` y `CORE_EVENTS.POST_RENDER`. Mide el tiempo de codificación y despacho de comandos hacia WebGPU o WebGL 2.
- **Tiempo Total de Cuadro (`frameTimeMs`):** Tiempo total que consume la iteración completa en la CPU.
- **Algoritmo de Estimación de VRAM:**
  Calcula el consumo en bytes recorriendo las fuentes de textura registradas en `TextureManager`:
  $$\text{Bytes}_{\text{textura}} = \text{ancho} \times \text{alto} \times 4 \text{ bytes (RGBA8)}$$
  A este valor se añade el tamaño de los búferes de uniformes globales (`globalUniformBuffer.size`).

---

### 2.3. Capa Visual de Superposición: `DebugOverlayRenderer`
Genera un canvas 2D superpuesto (`overlayCanvas`) colocado exactamente sobre el canvas principal del juego con estilo CSS `pointer-events: none` e índice $Z$ máximo:
- **Gráfica de Líneas (*FPS Sparkline*):** Dibuja una representación vectorial de la estabilidad de cuadros a lo largo del tiempo, mapeando los valores del `MetricSampler` a coordenadas del lienzo.
- **Contornos de Interacción (*Hitboxes*):** Dibuja rectángulos amarillos (`#ffff00`) sobre las coordenadas mundiales de los GameObjects que tienen componentes interactivos activos.
- **Cajas Delimitadoras Físicas (*Physics AABB*):** Lee directamente la memoria compartida del módulo `@tacarigua/physics-worker` (`physicsBridge.bodyData`), renderizando en color carmesí (`#ff0055`) los colisionadores de todos los cuerpos activos sin consultar instancias intermedias.

---

### 2.4. Agente de Telemetría: `DevToolsAgent`
Coordina la interacción entre Phaser y el entorno del navegador:
- **Registro del Hook Global:** Inyecta en el objeto global la estructura:
  ```javascript
  window.__TACARIGUA_DEVTOOLS_GLOBAL_HOOK__ = {
      version: '1.0.0',
      games: Set<Game>,
      register: Function,
      unregister: Function
  };
  ```
- **Transmisión Periódica de Telemetría:** Un temporizador a **4 Hz (250 ms)** emite paquetes `TELEMETRY_TICK` hacia `window` mediante `postMessage`, conteniendo métricas de FPS, memoria VRAM estimada, conteo de escenas y cantidad de entidades del ECS.
- **Recepción de Comandos del Panel:** Escucha eventos de tipo `tacarigua-devtools-panel` para conmutar visualizaciones o mutar propiedades en tiempo real.

---

## 3. Protocolo de Comunicación y Flujo de Datos

El intercambio de información entre el juego y la extensión de navegador sigue un canal de paso de mensajes asíncrono y desacoplado:

```
  [ Juego Tacarigua 1.0.0 ]                                       [ Extensión DevTools (Panel) ]
             │                                                                │
   DevToolsAgent._registerGlobalHook()                                        │
             │                                                                │
   DevToolsAgent (Timer cada 250ms)                                           │
             │ ─── postMessage({ type: 'TELEMETRY_TICK', payload }) ────────► │
             │                                                                │ Actualiza Gráficas
             │                                                                │ y Métricas en UI
             │                                                                │
             │                                                                │ Usuario presiona:
             │                                                                │ "Inspeccionar Escenas"
             │ ◄── postMessage({ command: 'INSPECT_SCENES' }) ─────────────── │
             │                                                                │
   DevToolsAgent._sendSceneTreeSnapshot()                                     │
             │ ─── postMessage({ type: 'SCENE_TREE_SNAPSHOT', payload }) ───► │
             │                                                                │ Muestra árbol jerárquico
             │                                                                │ de GameObjects en el panel
             │                                                                │
             │                                                                │ Usuario modifica:
             │                                                                │ "player.x = 500"
             │ ◄── postMessage({ command: 'MUTATE_GAMEOBJECT', value: 500 }) ─│
             │                                                                │
   DevToolsAgent._mutateGameObject()                                          │
   Modifica propiedad en caliente                                             │
             ▼                                                                ▼
```

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Característica | Phaser 4.2.1 | Tacarigua 1.0.0 (`@tacarigua/devtools`) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Arquitectura de Diagnóstico** | Logs manuales o extensiones externas con monkey-patching. | **Agente oficial nativo** desacoplado por eventos. | Detección limpia sin alterar los prototipos del motor. |
| **Muestreo de Métricas** | Arreglos dinámicos con mutaciones de tamaño. | **Búfer circular plano** (`Float32Array`). | **Cero asignaciones en memoria heap** durante el perfilado. |
| **Monitoreo de GPU** | Ciego a la memoria de video. | **Estimación continua de VRAM** (texturas + UBOs). | Prevención temprana de bloqueos por falta de memoria en dispositivos móviles. |
| **Superposición Visual** | Creación de objetos `Graphics` pesados en la escena. | **Canvas 2D superpuesto independiente** con *Zero-Pointer-Events*. | No contamina el árbol de visualización ni altera los draw calls de la RHI. |
| **Inspección de Estado** | Solo lectura mediante puntos de interrupción (*breakpoints*). | **Mutación bidireccional reactiva en caliente**. | Ajuste de variables de diseño (*tuning*) en tiempo real sin recargar. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Inicialización del Agente y Activación del HUD Visual

Cómo arrancar el agente de desarrollo y desplegar las métricas en pantalla durante el desarrollo:

```javascript
import { Game } from '@tacarigua/core.js';
import { DevToolsAgent } from '@tacarigua/devtools';

// 1. Inicializar el motor
const game = new Game({
    width: 1280,
    height: 720,
    render: { preferWebGPU: true }
});

// 2. Instanciar el agente de DevTools
const devtools = new DevToolsAgent(game);

// 3. Activar el HUD de rendimiento en pantalla (FPS, tiempos de CPU/GPU, VRAM)
devtools.overlay.visible = true;
devtools.overlay.showSparkline = true;

// 4. Activar la visualización de áreas de colisión
devtools.overlay.showPhysicsAABB = true;
devtools.overlay.showHitboxes = true;

console.log('[DevTools] Agente conectado. Abra las herramientas de desarrollador.');
```

---

### Ejemplo 2: Suscripción a Métricas de Telemetría para Interfaces Personalizadas

Si el proyecto cuenta con un panel de depuración propio en HTML o React, puede escuchar directamente las emisiones del agente:

```javascript
// Escuchar paquetes de telemetría emitidos a 4 Hz
devtools.on('telemetry', (data) => {
    const metrics = data.metrics;

    // Actualizar elementos del DOM propio del desarrollador
    document.getElementById('debug-fps').innerText = `${metrics.fps} FPS`;
    document.getElementById('debug-frametime').innerText = `${metrics.frameTimeMs} ms`;
    document.getElementById('debug-cpu-gpu').innerText = `CPU: ${metrics.stepTimeMs}ms | GPU: ${metrics.renderTimeMs}ms`;
    document.getElementById('debug-vram').innerText = `${metrics.vramMB} MB VRAM`;
    document.getElementById('debug-entities').innerText = `${data.ecsEntityCount} Entidades ECS`;
});
```

---

### Ejemplo 3: Envío de Comandos de Inspección y Mutación Manual desde Consola

El desarrollador puede enviar mensajes directamente desde la consola del navegador simulando el comportamiento de la extensión:

```javascript
// Solicitar el volcado completo del árbol de escenas activas
window.postMessage({
    source: 'tacarigua-devtools-panel',
    command: 'INSPECT_SCENES'
}, '*');

// Mutar en caliente la posición X del personaje principal en la escena 'GameScene'
window.postMessage({
    source: 'tacarigua-devtools-panel',
    command: 'MUTATE_GAMEOBJECT',
    sceneKey: 'GameScene',
    gameObjectId: 'player',
    property: 'x',
    value: 640
}, '*');

// Conmutar la visibilidad de las cajas de colisión físicas
window.postMessage({
    source: 'tacarigua-devtools-panel',
    command: 'TOGGLE_PHYSICS_AABB',
    value: true
}, '*');
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Retirar Extensiones o Plugins de Depuración No Oficiales
- **Antes (Phaser v4.2.1):**
  Se importaban plugins de inspección que sobreescribían los métodos `update()` de todas las escenas y agregaban listeners pesados al bucle principal:
  ```javascript
  // Código obsoleto de depuración
  import PhaserDebugPlugin from 'phaser-plugin-debug';
  game.plugins.install('DebugPlugin', PhaserDebugPlugin);
  ```
- **Ahora (Tacarigua v1.0.0):**
  Basta con importar e instanciar `DevToolsAgent`. No es necesario modificar las escenas ni sobrecargar el ciclo de vida del juego:
  ```javascript
  import { DevToolsAgent } from '@tacarigua/devtools';
  const devtools = new DevToolsAgent(game);
  ```

### Paso 2: Reemplazar el Renderizado de Cajas Físicas con `DebugOverlayRenderer`
- **Antes (Phaser v4.2.1):**
  Habilitar el modo de depuración de Arcade o Matter creaba un objeto `Graphics` de dibujo vectorial que generaba llamadas de renderizado adicionales en cada frame, alterando la medición de rendimiento:
  ```javascript
  // Provocaba un impacto notable en FPS
  physics: {
      default: 'arcade',
      arcade: { debug: true }
  }
  ```
- **Ahora (Tacarigua v1.0.0):**
  La capa de superposición de `@tacarigua/devtools` dibuja directamente sobre un canvas 2D independiente sin interferir con las pasadas de render WebGPU/WebGL2 ni agregar *draw calls* a la GPU del juego:
  ```javascript
  devtools.overlay.showPhysicsAABB = true;
  ```

### Paso 3: Optimización para Entornos de Producción
En compilaciones de producción (*production builds*), el módulo `@tacarigua/devtools` puede ser completamente descartado por bundlers como Vite gracias a su delimitación como módulo sin efectos secundarios (`sideEffects: false`). Para asegurar la exclusión total de código en producción:
```javascript
// main.js
if (import.meta.env.DEV) {
    const { DevToolsAgent } = await import('@tacarigua/devtools');
    new DevToolsAgent(game);
}
```