# 🌟 Tacarigua.js (v1.0.0)
![TacariguaJS Banner](https://raw.githubusercontent.com/AbejorroDigital/Tacarigua-js/main/documentacion/banner.JPG)

> **El motor de videojuegos 2D para la web moderna.**  
> Arquitectura **WebGPU nativa**, diseño orientado a datos (**ECS/SoA**), físicas y audio **multihilo (Off-Thread)**, conectividad **WebTransport (HTTP/3)** y filosofía estricta de **Cero Asignación de Basura (Zero-GC)**.

---

[![WebGPU Ready](https://img.shields.io/badge/Render-WebGPU%20%7C%20WebGL2-blueviolet?style=for-the-badge&logo=webgpu)](https://github.com/AbejorroDigital/Tacarigua-js)
[![Zero GC](https://img.shields.io/badge/Memory-Zero--GC%20Loop-brightgreen?style=for-the-badge)](https://github.com/AbejorroDigital/Tacarigua-js)
[![ECS Architecture](https://img.shields.io/badge/Architecture-Data--Oriented%20(SoA)-orange?style=for-the-badge)](https://github.com/AbejorroDigital/Tacarigua-js)
[![ESM Only](https://img.shields.io/badge/ESM-Pure%20ES2022+-yellow?style=for-the-badge)](https://github.com/AbejorroDigital/Tacarigua-js)
[![Hecho en Venezuela](https://img.shields.io/badge/Hecho%20en-Venezuela%20🇻🇪-red?style=for-the-badge)](https://github.com/AbejorroDigital/Tacarigua-js)

---

## 🌊 El Origen y el Alma de TacariguaJS

**Tacarigua.js** nace de las manos de **Carlos García Torín ([Abejorro Digital](https://github.com/AbejorroDigital))** como un tributo sincero a la tierra venezolana y a la fuerza creadora e inagotable de su gente. 

El histórico **Lago de Tacarigua** (el espejo de agua que los ancestros veneraron en los fértiles valles del centro de Venezuela) ha sido durante siglos testigo de resiliencia, biodiversidad y vida en constante flujo. De la misma manera, **Tacarigua.js** fue forjado para reflejar la vastedad, la creatividad, la pasión técnica y el talento infinito de toda la comunidad hispanohablante.

Es un guiño a nuestras raíces, al orgullo local y a la convicción de que desde Hispanoamérica podemos construir ingeniería de software de clase mundial: **un motor hipermoderno, veloz, escrito en español y concebido a pulso**, diseñado para democratizar el desarrollo web de videojuegos de alto rendimiento a 60 y 120+ FPS sin depender de monolitos del pasado.

---

## 🚀 Demostración en Vivo: ¡Prueba Stellar Vanguard!

Para comprender el poder de TacariguaJS no hace falta imaginarlo: **hay que sentirlo en el navegador.**

Hemos desarrollado un juego de combate espacial arcade de alta intensidad completamente impulsado por el motor:

🕹️ **[JUGAR STELLAR VANGUARD SPACE SHOOTER](https://stellar-vanguard-space-shooter.netlify.app)**

* **Miles de proyectiles y partículas simultáneas** procesadas en el núcleo ECS columnar.
* **Pipeline de render WebGPU puro** con sombreadores WGSL y transformaciones afines en registros de CPU.
* **Audio espacial tridimensional** sintetizado en un hilo independiente (`AudioWorklet`).
* **Físicas y colisiones fluidas sin tirones (*jank-free*)**, corriendo a tasa de refresco ultra-alta.

¡Pruébalo, desafía tu récord y apoya este proyecto para demostrar lo que la web moderna es capaz de lograr!

---

## 💡 ¿Por qué TacariguaJS? El Salto Generacional

Inspirado profundamente en la ergonomía y la historia de **Phaser**, TacariguaJS surge de una necesidad crítica: **la web ha cambiado radicalmente.**

Las bases tradicionales de motores 2D web arrastran deudas técnicas acumuladas durante más de una década:
* El recolector de basura (*Garbage Collector*) destruye la fluidez con micro-pausas provocadas por objetos temporales en el *heap*.
* Los cálculos de físicas y audio saturan el hilo principal del DOM (*Main Thread*).
* La máquina de estados imperativa de WebGL 1/2 y los fragmentados *pipelines* de render ahogan al procesador en llamadas redundantes al driver (*state thrashing*).

**TacariguaJS es una modernización integral desde cero:**

```
                  ARQUITECTURA HISTÓRICA                             TACARIGUA.JS v1.0.0
 ┌──────────────────────────────────────────────────┐      ┌──────────────────────────────────────────────────┐
 │ • Herencia OOP profunda (Phaser.Class / AoS)     │      │ • Diseño Orientado a Datos (SoA) + Adaptador OOP │
 │ • WebGL 1/2 imperativo con cambios continuos     │ ───► │ • Render Hardware Interface (RHI) WebGPU / WGSL  │
 │ • Físicas en Hilo Principal (Jank por colisión)  │      │ • Físicas Off-Thread (SharedArrayBuffer/Workers) │
 │ • Audio en Hilo Principal (Clicks y Pops de DSP) │      │ • DSP de Audio en hilo exclusivo (AudioWorklet)  │
 │ • Red basada en JSON sobre WebSockets/TCP        │      │ • WebTransport (HTTP/3 sobre QUIC) + BinaryPacket│
 └──────────────────────────────────────────────────┘      └──────────────────────────────────────────────────┘
```

---

## ⚡ Características Técnicas Principales

### 🎨 1. Núcleo RHI WebGPU & Fallback WebGL 2 (`@tacarigua/renderer-webgpu`)
* **Pipeline WebGPU de Primera Clase:** Uso de `GPUDevice`, `GPUQueue`, comandos inmutables precompilados y sombreadores en **WGSL**.
* **Uniform Buffer Object (UBO) Unificado:** 128 bytes compartidos que actualizan matrices de proyección, dimensiones de pantalla, scroll y tiempo en un único despacho a la GPU.
* **Degradación Transparente (*Fallback*):** Si el navegador o hardware no soporta WebGPU, la RHI conmuta de forma invisible a WebGL 2.0 conservando la misma interfaz y sin alterar tus escenas.
* **Zero-GC Render Pass:** Descriptores estáticos preasignados; cero asignaciones dinámicas en el bucle de dibujado.

### ⚡ 2. Loteador Masivo 2D de Asignación Cero (`@tacarigua/batch-renderer-2d`)
* **Transformaciones Afines Desenrolladas (*Unrolled Affine Transforms*):** Rotación, escala y traslación calculadas directamente en registros de CPU sin instanciar matrices intermedias (`Matrix4` / `TransformMatrix`).
* **Vértice Entrelazado de 24 Bytes:** Empaquetamiento binario contiguo optimizado para el bus PCIe:
  $$\text{Layout: } [X, Y \ (\text{f32}\times 2) \mid U, V \ (\text{f32}\times 2) \mid \text{TexIndex} \ (\text{f32}) \mid \text{Color/Tint} \ (\text{u32})]$$
* **Soporte Dinámico de Texturas Multicapa (`texture_2d_array`):** Hasta 16 texturas vinculadas simultáneamente por cada llamada de dibujo (*draw call*).
* **Post-Procesamiento Ping-Pong:** Infraestructura desacoplada con dos render targets intercambiables en VRAM, eliminando fugas de memoria al encadenar efectos a pantalla completa (Bloom, Vignette, Grayscale).

### 🧩 3. Arquitectura Híbrida y Motor ECS Nativo (`@tacarigua/ecs`)
* **Memoria Columnar Contigua (Structure of Arrays - SoA):** Componentes respaldados por búferes planos contiguos (`Float32Array`, `Int32Array`, `Uint8Array`), maximizando la tasa de aciertos en la caché L1/L2 de la CPU.
* **Identificadores Generacionales Marcados (`EntityId`):** Entidades como enteros de 32 bits empaquetados: `(generación << 20) | índice`. Sin sobrecarga de objetos y libre de referencias huérfanas (*dangling references*).
* **Filtrado Reactivo Ultrarrápido (`BitSet` & `Query`):** Validación en tiempo constante $O(1)$ con eliminación contigua mediante la técnica *Swap & Pop*.
* **Adaptador OOP Híbrido (`GameObjectECSAdapter`):** Programa con la comodidad de siempre (`sprite.x += 10`, `sprite.setVelocity(...)`) mientras por debajo el motor muta directamente la memoria columnar del ECS. ¡Capacidad probada para más de **100.000 entidades simultáneas**!

### ⚙️ 4. Físicas Fuera del Hilo Principal (`@tacarigua/physics-worker`)
* **Cálculo Asíncrono en Web Worker Dedicado:** Detección de fases amplia y estrecha (*Broadphase/Narrowphase*), integración semi-implícita de Euler y respuesta elástica calculadas en un hilo secundario.
* **Memoria Compartida de Copia Cero:** Comunicación instantánea con el hilo principal a través de `SharedArrayBuffer` y semáforos atómicos (`Atomics`), reduciendo la latencia de intercambio a menos de **$0.1\text{ ms}$**.
* **Degradación Automática:** Si el entorno no cuenta con aislamiento de origen cruzado (`COOP/COEP`), conmuta sin fricción a transferencias de búferes tipados (`ArrayBuffer` transferibles).

### 🔊 5. Audio Espacial en Tiempo Real (`@tacarigua/sound-worklet`)
* **Procesamiento DSP en Hilo de Audio Dedicado:** Implementación nativa de `AudioWorkletProcessor` corriendo a 128 muestras por bloque (*Audio Quanta*), garantizando continuidad sónica incluso si la pestaña sufre caídas de fotogramas.
* **Paneo Estéreo de Potencia Constante (*Constant Power Panning*):** Distribución de energía acústica trigonométrica invariante ($\cos^2\theta + \sin^2\theta = 1$).
* **Curvas de Atenuación 3D Integradas:** Modelos físicos inverso, lineal y exponencial modulados sin chasquidos (*de-zippering*) mediante `AudioParam.setTargetAtTime()`.

### 🌐 6. Conectividad HTTP/3 y WebTransport (`@tacarigua/net`)
* **Datagramas QUIC No Confiables (*Unreliable Datagrams*):** Transmisión de movimiento y estado físico a 60 Hz sobre UDP, erradicando el bloqueo de cabeza de línea (*Head-of-Line Blocking*) característico de TCP/WebSockets.
* **Serializador Binario de Huella Cero (`BinaryPacket`):** Lectura y escritura atómica en Little-Endian sobre `ArrayBuffer` y `DataView` (hasta un 80% más ligero que JSON).
* **Interpolador de Instantáneas Integrado (`SnapshotInterpolator`):** Búfer en anillo para interpolación suave de posición y rotación por el camino angular más corto (*Shortest Slerp*).

### 🔥 7. Plugin de Vite con Scene HMR (`@tacarigua/vite-plugin`)
* **Reemplazo de Módulos en Caliente para Escenas:** Modifica la lógica de una escena en tu editor de código y observa los cambios en el navegador en **$< 80\text{ ms}$**, preservando intactos el estado transitorio (`data`, `registry`), las texturas cargadas y la posición de las cámaras.
* **Compilación y Minificación Automática de Shaders:** Importa archivos `.wgsl`, `.glsl`, `.vert` y `.frag` directamente como módulos ESM limpios y comprimidos.

### 🛠️ 8. Suite de Diagnóstico y Telemetría (`@tacarigua/devtools`)
* **Muestreador Estadístico Zero-Allocation:** Búferes circulares que calculan tiempos de CPU, GPU, FPS y VRAM estimada sin alterar las mediciones con recolección de basura.
* **Capa Visual Superpuesta (*Debug Overlays*):** HUD con gráficas vectoriales en tiempo real (*sparklines*), cajas de colisión física (AABB) y rectángulos interactivos sobre un canvas desacoplado.

---

## 🧠 Tacarigua Skill para Agentes de IA

¿Desarrollas asistido por Inteligencia Artificial? TacariguaJS cuenta con una **Skill oficial especializada** diseñada para que agentes y asistentes de código (como Claude Projects, Cursor, Copilot o ChatGPT) dominen las convenciones y patrones del motor:

🤖 **[Explorar la Skill de TacariguaJS](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/skill)**

Al integrarla, tu asistente generará código optimizado bajo la filosofía del motor:
* Estructuras de memoria continua SoA en lugar de arrays de objetos dispersos.
* Inyección directa al `SpriteBatcher` con transformaciones afines.
* Configuración correcta de buffers compartidos y primitivas atómicas.
* Sombreadores en WGSL idiomático con layouts de recursos precisos.

---

## 📚 Documentación Técnica Completa

El repositorio alberga manuales exhaustivos, desgloses matemáticos, contratos de interfaz y guías paso a paso para cada submódulo:

📖 **[ACCEDER A LA DOCUMENTACIÓN TÉCNICA](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion)**

| Módulo | Documento | Enfoque Principal |
| :--- | :--- | :--- |
| **Núcleo** | [`core-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/core-doc.md) | Ciclo de vida, Game loop Zero-GC, Signals y TimeStep. |
| **WebGPU RHI** | [`renderer-webgpu-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/renderer-webgpu-doc.md) | Capa RHI, sombreadores WGSL, buffers UBO y fallbacks. |
| **Loteado 2D** | [`batch-renderer-2d-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/batch-renderer-2d-doc.md) | SpriteBatcher, transformaciones afines y PostFX Ping-Pong. |
| **Motor ECS** | [`ecs-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/ecs-doc.md) | Estructura SoA, ComponentStore, EntityId y adaptadores. |
| **Físicas Worker** | [`physics-worker-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/physics-worker-doc.md) | Simulación off-thread, SharedArrayBuffer y Atomics. |
| **Audio Espacial**| [`sound-worklet-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/sound-worklet-doc.md) | DSP en AudioWorklet, Constant Power Panning y curvas. |
| **Networking** | [`net-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/net-doc.md) | WebTransport (QUIC), BinaryPacket e interpolación. |
| **WebXR / Háptico**| [`input-xr-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/input-xr-doc.md) | Sesiones inmersivas, mandos 6DoF, Hand Tracking y Dual-Rumble. |
| **Plugin Vite** | [`vite-plugin.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/vite-plugin.md) | Scene HMR en <80ms y compilación de WGSL/GLSL. |
| **DevTools** | [`devtools-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/devtools-doc.md) | Telemetría Zero-GC, superposición visual y mutación en caliente. |
| **Tipos Estrictos**| [`types-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/types-doc.md) | Contratos TypeScript, Branded IDs y claves genéricas. |
| **Testing / CI** | [`testing-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/testing-doc.md) | WebGPUMock, validación de fugas de memoria y benchmarks. |
| **Playground** | [`docs-playground-doc.md`](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion/docs-playground-doc.md) | Sandbox REPL aislado, TypeDoc y auditoría de migración. |

---

## 🚀 Inicio Rápido (Quick Start)

### 1. Configuración de Vite (`vite.config.js`)

Aprovecha el plugin oficial para disfrutar de HMR en escenas y soporte nativo de shaders WGSL:

```javascript
import { defineConfig } from 'vite';
import phaserVitePlugin from '@tacarigua/vite-plugin';

export default defineConfig({
    plugins: [
        phaserVitePlugin({
            minifyShaders: true,
            sceneHMR: true
        })
    ],
    server: {
        headers: {
            // Requerido para SharedArrayBuffer en físicas multihilo
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    }
});
```

### 2. Creando tu Primer Juego con ECS y WebGPU

```javascript
import { Game, RENDER_TYPE } from '@tacarigua/core.js';
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';
import { SpriteBatcher } from '@tacarigua/batch-renderer-2d';

// 1. Inicializar el motor priorizando WebGPU
const game = new Game({
    width: 1280,
    height: 720,
    type: RENDER_TYPE.AUTO, // Autodetecta WebGPU con fallback a WebGL 2
    render: {
        preferWebGPU: true,
        antialias: true
    },
    fps: {
        targetFps: 60,
        smoothStep: true
    }
});

// 2. Inicializar el mundo orientado a datos (ECS)
const world = new ECSWorld(10000);
world.addSystem(new MovementSystem(world));

// 3. Crear entidades masivas en memoria contigua (Zero GC)
for (let i = 0; i < 5000; i++) {
    const entity = world.createEntity();
    world.addComponent(entity, world.Transform, {
        x: Math.random() * 1280,
        y: Math.random() * 720,
        scaleX: 1,
        scaleY: 1
    });
    world.addComponent(entity, world.Velocity, {
        vx: (Math.random() - 0.5) * 150,
        vy: (Math.random() - 0.5) * 150
    });
}

// 4. Bucle principal coordinado
game.events.on('step', (time, delta) => {
    world.step(time, delta);
});
```

---

## 📊 Tabla Comparativa: Phaser 4.2.1 vs. Tacarigua 1.0.0

| Dimensión | Phaser 4.2.1 (Legado) | Tacarigua 1.0.0 (Moderno) | Beneficio para el Desarrollador |
| :--- | :--- | :--- | :--- |
| **Backend Gráfico** | WebGL 1 / 2 imperativo monolítico | **WebGPU nativo (RHI) con fallback WebGL 2** | Menor uso de CPU; acceso a sombreadores WGSL modernos. |
| **Loteado de Sprites** | Múltiples pipelines fragmentados | **`SpriteBatcher` unificado (24 bytes stride)** | Reducción radical de cambios de contexto en GPU. |
| **Transformación 2D** | Multiplicación de matrices en heap | **Transformaciones afines planas desenrolladas** | **~3.8x más rápido** en inyección de quads por segundo. |
| **Paradigma de Datos** | OOP jerárquico tradicional (AoS) | **ECS columnar puro (SoA) + Adaptador OOP** | Escala fluida a **100.000+ entidades** a 60/120 FPS. |
| **Físicas** | En el hilo principal (Jank al colisionar) | **Web Worker dedicado (`SharedArrayBuffer`)** | El hilo de renderizado jamás se congela por cálculos físicos. |
| **Audio** | Nodos en hilo principal / ScriptProcessor | **`AudioWorklet` off-thread dedicado** | Audio espacial 3D ininterrumpido y libre de chasquidos. |
| **Red** | Plugins externos sobre WebSockets | **WebTransport (HTTP/3 sobre QUIC) + Binario** | Sin *Head-of-Line Blocking*; latencia ultra baja en tiempo real. |
| **Experiencia Dev (DX)**| Recargas completas de página (Webpack) | **Scene HMR en $< 80\text{ ms}$ con Vite** | Iteración de diseño instantánea preservando variables y estado. |
| **Tipado** | JSDoc impreciso con tipos `any` | **TypeScript estricto con Branded Types** | Detección temprana de errores tipográficos en compilación. |

---

## 🤝 ¡Únete a la Revolución del Desarrollo Web en Español!

**TacariguaJS** es un proyecto abierto, vivo y con propósito. Queremos construir una comunidad vibrante donde desarrolladores de toda Hispanoamérica y el mundo compartan experiencias, creen videojuegos increíbles y lleven la web a su máximo potencial técnico.

### ¿Cómo puedes apoyar?
1. ⭐ **Dale una estrella al repositorio** para aumentar su visibilidad en GitHub.
2. 🕹️ **Juega y comparte [Stellar Vanguard](https://stellar-vanguard-space-shooter.netlify.app)** con tus colegas desarrolladores.
3. 📖 **Revisa la [documentación](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/documentacion)** y crea tu primer prototipo.
4. 🤖 **Añade la [skill de IA](https://github.com/AbejorroDigital/Tacarigua-js/tree/main/skill)** a tu flujo de trabajo diario con LLMs.
5. 💬 **Abre Issues y Pull Requests:** Todo feedback, sugerencia o mejora es bienvenido con los brazos abiertos.

---

## 📄 Licencia

Este proyecto está distribuido bajo la licencia **MIT**. Eres libre de usarlo, modificarlo, estudiarlo y crear con él juegos comerciales o proyectos educativos sin restricciones.

## 👥 Créditos y Agradecimientos

TacariguaJS está construido sobre los cimientos arquitectónicos, lógicos y conceptuales de **Phaser** (creado originalmente por *Photon Storm* y *Richard Davey* bajo la licencia MIT). 

Este proyecto, sin embargo, representa una modernización radical, refactorización profunda y reestructuración hacia un paradigma moderno (ESM, WebGPU, ECS, Web Workers) adaptado y optimizado de manera independiente para la comunidad hispanohablante.

* **Creadores originales de Phaser:** [Photon Storm / Richard Davey](https://phaser.io)
* **Modernización, Arquitectura y TacariguaJS:** Carlos Eduardo García Torín y colaboradores.

---

<p align="center">
  <b>Forjado con orgullo, ingenio y pasión desde Venezuela para todo el mundo hispanohablante. 🇻🇪✨</b><br>
  <i>"El talento no tiene fronteras cuando la tecnología se construye a pulso."</i>
</p>
