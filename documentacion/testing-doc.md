# Documentación Técnica: Módulo `@tacarigua/testing`
**Tacarigua 1.0.0 — Arquitectura de Pruebas Unitarias, Emulación de Hardware y Validación de Rendimiento**

---

## 1. Visión General y Arquitectura del Módulo

El módulo `@tacarigua/testing` proporciona la infraestructura de validación de bajo nivel de **Tacarigua 1.0.0**. Ha sido diseñado para desacoplar el ciclo de pruebas del entorno del navegador tradicional (DOM, ventanas gráficas, servidores X11 y navegadores controlados como Puppeteer/Karma), permitiendo la ejecución de suites de pruebas unitarias, validaciones de fugas de memoria y bancos de pruebas de estrés (*benchmarks*) en entornos sin interfaz gráfica (*headless*) como Node.js, Bun o contenedores de Integración Continua (CI/CD).

```
                      +---------------------------------------------------+
                      |                 Entorno Headless                  |
                      |                 (Node.js / Bun / CI)              |
                      +---------------------------------------------------+
                                                |
                                                v
                      +---------------------------------------------------+
                      |           WebGPUMock.install()                    |
                      |   - Inyecta globalThis.navigator.gpu              |
                      |   - Emula GPUDevice, GPUQueue, GPUBuffer          |
                      +---------------------------------------------------+
                                                |
         +--------------------------------------+--------------------------------------+
         |                                      |                                      |
         v                                      v                                      v
+------------------+                 +---------------------+                +---------------------+
|    CoreUnitTests |                 | MemoryLeakValidator |                | EngineBenchmark     |
| - Signal / Event |                 | - JIT Warmup        |                |   Runner            |
| - TimeStep Loop  |                 | - globalThis.gc()   |                | - 100k ECS entities |
| - ECS SoA Logic  |                 | - Heap allocation   |                | - 250k Quad batching|
| - BinaryPacket   |                 |   delta (<1024 B)   |                | - 100k BinPack ops  |
| - SpriteBatcher  |                 +---------------------+                +---------------------+
+------------------+
```

### Componentes Principales
1. **`WebGPUMock`**: Capa de abstracción y emulación de la API WebGPU nativa (`GPUDevice`, `GPUQueue`, `GPUBuffer`, `GPUTexture`, `GPURenderPipeline`, `GPUCommandEncoder`).
2. **`MemoryLeakValidator`**: Mecanismo de diagnóstico estricto que evalúa la estabilidad del montón (*heap*) y asegura la política de **Cero Asignación en Tiempo de Ejecución (*Zero-Allocation Runtime*)**.
3. **`Assert`**: Motor de aserciones asíncrono y síncrono ligero, desacoplado de dependencias externas.
4. **`CoreUnitTests`**: Suite integral de pruebas de integración y comportamiento funcional del núcleo.
5. **`EngineBenchmarkRunner`**: Banco de pruebas de estrés para medir el rendimiento bruto (*throughput*) de las estructuras de datos columnares (ECS), empaquetado afín de geometrías (Batcher) y serialización binaria (Net).

---

## 2. Análisis Técnico Detallado de Clases

### 2.1. `WebGPUMock`
Permite inicializar los subsistemas `@tacarigua/renderer-webgpu` y `@tacarigua/batch-renderer-2d` sin requerir una GPU física ni emuladores por software pesados como SwiftShader o Mesa.

* **Estrategia de Memoria**: Cuando se invoca `createBuffer()`, la clase reserva un `ArrayBuffer` subyacente (`_underlyingBuffer`) que simula la memoria de video asignada (VRAM).
* **Transferencias Binarias**: El método `queue.writeBuffer()` implementa una copia directa de memoria entre vistas tipadas mediante `Uint8Array.set()`, simulando con exactitud la semántica asíncrona de WebGPU:
  $$\text{Offset destino} \leftarrow \text{DataView}(SourceBytes)$$
* **Gestión de Ciclo de Vida**: Mantiene registros internos de tipo `Set<RHIBuffer>` y `Set<RHITexture>` para rastrear asignaciones huérfanas al invocar `destroy()`.

### 2.2. `MemoryLeakValidator`
Garantiza que las rutinas del motor no generen presión sobre el recolector de basura (*Garbage Collector*) durante el ciclo de renderizado continuo.

* **Fase de Calentamiento (*Warmup*)**: Ejecuta una función en un bucle cerrado (por defecto, 100 iteraciones) para permitir que el compilador JIT (V8 o SpiderMonkey) optimice el código intermedio (bytecode) a código máquina y descarte asignaciones de inicialización de clausuras.
* **Aislamiento del Heap**: Invoca explícitamente `globalThis.gc()` (requiere el flag `--expose-gc` en V8/Node.js) antes de registrar el consumo de memoria inicial (`process.memoryUsage().heapUsed`).
* **Cálculo de Tolerancia**:
  $$\Delta \text{Heap} = \text{Heap}_{\text{final}} - \text{Heap}_{\text{inicial}}$$
  Se define como prueba superada si $\Delta \text{Heap} < 1024\text{ bytes}$ tras $N$ ejecuciones estrictas (amortiguando ruido intrínseco de Node.js).

### 2.3. `Assert`
Implementa aserciones escalares y de coma flotante de alta precisión.
* `closeTo(actual, expected, delta, message)`: Esencial para validar cálculos trigonométricos de transformaciones afines y deltas suavizados de `TimeStep`, donde la precisión de 32/64 bits diverge por redondeo IEEE 754:
  $$|actual - expected| \le delta$$

### 2.4. `EngineBenchmarkRunner`
Mide métricas de rendimiento por segundo sobre cargas de trabajo masivas:
* **`benchmarkECSThroughput()`**: Mide el rendimiento de actualización de cinemática sobre 100.000 entidades vivas iteradas a través de arreglos continuos (`Float32Array`).
* **`benchmarkBatcherThroughput()`**: Evalúa la tasa de transformación afín vectorial 2D (con rotación trigonométrica e inyección entrelazada de 24 bytes por vértice) para 250.000 quads.
* **`benchmarkBinarySerialization()`**: Evalúa la velocidad de lectura y escritura binaria continua sobre `BinaryPacket`.

---

## 3. Comparativa Técnica: Phaser 4.2.1 vs Tacarigua 1.0.0

| Característica | Phaser 4.2.1 | Tacarigua 1.0.0 (`@tacarigua/testing`) |
| :--- | :--- | :--- |
| **Entorno de Pruebas** | Requería navegador web, Karma y dependencias de Canvas/WebGL simuladas con `jest-canvas-mock`. | Completamente agnóstico; corre en Node.js o Bun sin emulación DOM gracias a `WebGPUMock`. |
| **Pruebas de Pipelines Gráficos** | Imposible probar pipelines de WebGL sin hardware o configuraciones complejas de software GL en CI. | Emulación completa de comandos de `GPUDevice`, `RenderPipeline`, `BindGroup` y Buffers en memoria de CPU. |
| **Detección de Fugas de Memoria** | Manual mediante Chrome DevTools Memory Profiler; propensa a falsos positivos. | Automatizada en suite mediante `MemoryLeakValidator`, evaluando asignaciones a nivel de bytes en CI. |
| **Validación de Rendimiento** | Dependiente de `console.time` en ejemplos interactivos; métricas no reproducibles. | `EngineBenchmarkRunner` con métricas de rendimiento cuantitativas (ops/seg y ms/frame). |
| **Impacto de Dependencias** | Pesada sobrecarga de paquetes NPM (`mocha`, `chai`, `puppeteer`). | Aserciones y herramientas de simulación nativas integradas directamente en el monorepo. |

---

## 4. Guía de Uso Práctico y Ejemplos de Implementación

### 4.1. Ejecución de la Suite Completa en Entornos CI/CD (Node.js)

Para ejecutar las pruebas en un flujo de integración continua, configure el script de prueba para exponer la recolección de basura de V8:

```json
// package.json
{
  "scripts": {
    "test:core": "node --expose-gc scripts/run-tests.js"
  }
}
```

Script ejecutor (`scripts/run-tests.js`):

```javascript
import { CoreUnitTests, EngineBenchmarkRunner } from '@tacarigua/testing';

async function main() {
    try {
        console.log('Iniciando verificación técnica de Tacarigua 1.0.0...');
        
        // 1. Ejecutar las pruebas unitarias funcionales
        await CoreUnitTests.runAll();

        // 2. Ejecutar pruebas de estrés y validación de throughput
        EngineBenchmarkRunner.runStressBenchmarks();

        process.exit(0);
    } catch (error) {
        console.error('Fallo crítico en las pruebas:', error);
        process.exit(1);
    }
}

main();
```

### 4.2. Creación de una Prueba Unitaria con Detección de Fugas de Memoria

El siguiente ejemplo muestra cómo verificar que un nuevo sistema desarrollado sobre `@tacarigua/ecs` cumple estrictamente la política de cero asignaciones de memoria en el frame loop:

```javascript
import { WebGPUMock, Assert, MemoryLeakValidator } from '@tacarigua/testing';
import { ECSWorld, System } from '@tacarigua/ecs';

// Asegurar disponibilidad del backend mock
WebGPUMock.install();

class CombatSystem extends System {
    init() {
        this.Health = this.world.registerComponent('Health', { current: 'f32', max: 'f32' });
        this.query = this.world.createQuery([this.Health]);
    }

    update(time, delta) {
        const entities = this.query.entities;
        const healthColumns = this.Health.columns;
        const count = entities.length;

        // Bucle sin asignaciones en el heap
        for (let i = 0; i < count; i++) {
            const idx = entities[i] & 0xfffff;
            if (healthColumns.current[idx] < healthColumns.max[idx]) {
                healthColumns.current[idx] += 0.5; // Regeneración pasiva
            }
        }
    }
}

// Configuración de la prueba
const world = new ECSWorld(1024);
const combatSystem = new CombatSystem(world);
world.addSystem(combatSystem);

// Población de entidades
for (let i = 0; i < 500; i++) {
    const e = world.createEntity();
    world.addComponent(e, combatSystem.Health, { current: 50, max: 100 });
}

// Validación estricta de asignación de memoria en caliente
const leakResult = MemoryLeakValidator.testZeroAllocation(() => {
    world.step(16.666, 16.666);
}, 100, 1000);

Assert.isTrue(
    leakResult.passed, 
    `El CombatSystem generó basura en el Heap: ~${leakResult.allocatedBytesEstimate} bytes detectados.`
);

console.log('[OK] CombatSystem superó la prueba de cero asignaciones.');
```

---

## 5. Guía de Migración y Breaking Changes

### 5.1. Abandono de Pruebas Basadas en DOM y Canvas Mocking
En Phaser 4.2.1, las pruebas requerían configurar un lienzo virtual antes de inicializar la clase `Phaser.Game`. En Tacarigua 1.0.0, las pruebas se realizan directamente a través de `WebGPUMock` o en modo `HEADLESS`.

#### Código Antiguo (Phaser 4.2.1):
```javascript
// Test en Phaser 4.x requiriendo mocks pesados de navegador
require('jest-canvas-mock');

test('Sprite movement test v4', () => {
    const game = new Phaser.Game({
        type: Phaser.HEADLESS,
        width: 800,
        height: 600
    });

    const scene = new Phaser.Scene('TestScene');
    game.scene.add('TestScene', scene, true);

    const sprite = scene.add.sprite(0, 0, 'dummy');
    sprite.x += 10;

    expect(sprite.x).toBe(10);
    game.destroy(true);
});
```

#### Código Moderno (Tacarigua 1.0.0):
```javascript
// Test en Tacarigua 1.0.0 desacoplado del DOM y con estructuras de datos continuas
import { WebGPUMock, Assert } from '@tacarigua/testing';
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

WebGPUMock.install();

const world = new ECSWorld(64);
const movement = new MovementSystem(world);
world.addSystem(movement);

const entity = world.createEntity();
world.addComponent(entity, world.Transform, { x: 0, y: 0 });
world.addComponent(entity, world.Velocity, { vx: 10, vy: 0 });

// Simulación directa del paso de tiempo sin instanciar un bucle de ventana
world.step(1000, 1000);

const idx = entity & 0xfffff;
Assert.equal(world.Transform.columns.x[idx], 10, 'La posición debe avanzar linealmente');
```

### 5.2. Breaking Changes Clave
* **Eliminación de dependencias de render globales**: No existe `Phaser.Renderer.WebGL.WebGLRenderer` en pruebas unitarias; toda prueba gráfica debe consumir la abstracción `RHI` alimentada por `WebGPUMock`.
* **Uso obligatorio de `Assert`**: Se eliminan las aserciones basadas en frameworks dependientes de contexto (`Chai`, `Expect.js`) en los paquetes base, garantizando compatibilidad cruzada en Node, Bun y navegadores.
* **Control de Garbage Collector**: El método `MemoryLeakValidator.testZeroAllocation()` asume que la bandera de V8 `--expose-gc` está habilitada si se desea precisión absoluta. De lo contrario, advierte y calcula únicamente variaciones no deterministas del heap.

---

## 6. Optimizaciones de Rendimiento y Consideraciones de Bajo Nivel

### 6.1. Simulación de Buffers y Escritura por Cola
`WebGPUMock` emula el método `queue.writeBuffer()` evitando la creación de instancias intermedias de objetos:

```javascript
writeBuffer: (buffer, offset, data) => {
    const destView = new Uint8Array(buffer._underlyingBuffer, offset);
    const srcView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    destView.set(srcView);
}
```
* **Ventaja Arquitectónica**: Permite que las pruebas del `SpriteBatcher` escriban matrices de 250.000 quads sin penalizar la memoria de Node.js, verificando exactamente el empaquetamiento binario entrelazado de 24 bytes por vértice (`x, y, u, v, textureIndex, tint/color`) tal como se recibiría en la GPU real.

### 6.2. Estabilidad de Micro-Benchmarks
En `EngineBenchmarkRunner`, los ciclos de calentamiento inicial (`warmup`) fuerzan a que el motor V8 compile las funciones matemáticas y las des-optimice en caso de polimorfismo antes de iniciar el conteo de tiempo con `performance.now()`. Esto previene el sesgo de inicialización de clases y garantiza que las mediciones reflejen el rendimiento real en régimen estacionario (60/120 FPS sostenidos).