# SKILL TÉCNICA DEFINITIVA: Tacarigua.js v1.0.0
**Arquitectura del Motor, Módulos RHI/WebGPU, ECS Nativo, Concurrencia en Hilos y Guía de Migración desde v4.2.1**

---

## METADATOS DE LA SKILL
- **Identificador:** `tacarigua-v100-engine-architecture-and-migration`
- **Versión del Framework:** `Tacarigua.js v1.0.0`
- **Línea Base Anterior:** `Phaser.js v4.2.1` (y series v3.x legadas)
- **Paradigma Central:** Data-Oriented Design (DOD), Structure of Arrays (SoA), Zero-GC Runtime, Multi-Threading Concurrency, Render Hardware Interface (RHI).
- **Lenguajes / Estándares:** ECMAScript 2022+ (ESM puro), WebGPU Shading Language (WGSL), Web Audio API (AudioWorklet), WebTransport (QUIC/HTTP3).

---

## 1. ARQUITECTURA DEL SISTEMA Y PARADIGMAS FUNDAMENTALES

Tacarigua 1.0.0 representa una reescritura de raíz respecto a la arquitectura v4.2.1. El motor abandona el modelo monolítico basado en objetos de clases heredadas acopladas al DOM (`Phaser.Class`, `window.Phaser`) para adoptar una arquitectura desacoplada, modular y orientada a datos.

```
                                  [ @tacarigua/core ]
                    (Game, TimeStep Zero-GC, Signals, Constants)
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
[ @tacarigua/renderer-webgpu ]      [ @tacarigua/ecs ]              [ @tacarigua/physics-worker ]
(RHI WebGPU/WebGL2, UBO, WGSL)   (SoA, EntityId, Queries)     (SharedArrayBuffer, Atomics)
        │                                │                                │
        ▼                                ├────────────────────────────────┘
[ @tacarigua/batch-renderer-2d ]            │
(SpriteBatcher 24B, PostFX)              ▼
        │                        [ @tacarigua/net ]
        │                 (WebTransport, BinaryPacket)
        │                                │
        ▼                                ▼
[ @tacarigua/sound-worklet ]        [ @tacarigua/input-xr ]
(AudioWorklet DSP, Panning)      (WebXR 6DoF, Dual-Rumble)
```

### 1.1. Principios Arquitectónicos Clave

1. **Diseño Orientado a Datos (Data-Oriented Design - DOD):**
   - Transición de *Array of Structures* (AoS) a *Structure of Arrays* (SoA).
   - Las entidades no son clases ni referencias en el montón (*heap*); son identificadores enteros escalares de 32 bits (`EntityId`).
   - Las propiedades de componentes residen en búferes planos contiguos (`Float32Array`, `Uint32Array`, `Int32Array`), maximizando los aciertos en la caché L1/L2 de la CPU mediante prebúsqueda de hardware (*hardware prefetching*).

2. **Filosofía de Asignación Cero en Runtime (Zero-GC Execution):**
   - Eliminación total de instanciaciones dinámicas (`new`) dentro del ciclo crítico de actualización y renderizado (`step`, `render`, `batchQuad`, DSP de audio).
   - Suavizado de deltas mediante búferes circulares de longitud fija en memoria estática.
   - Descriptores de pasadas de renderizado y colecciones de transformaciones preasignadas en el arranque.

3. **Render Hardware Interface (RHI):**
   - Desacoplamiento del subsistema de renderizado respecto a APIs concretas. El núcleo emite comandos hacia una interfaz abstracta (`IRHIDriver`), la cual delega a un backend primario **WebGPU** (`WebGPURHI`) o a un backend de respaldo **WebGL 2.0** (`WebGL2RHI`).
   - Estandarización de sombreadores en **WGSL**, con traducción automatizada para compatibilidad GLSL.

4. **Concurrencia Multinúcleo y Aislamiento de Procesos:**
   - **Física Off-Thread:** La simulación se ejecuta en un Web Worker dedicado. La sincronización se realiza mediante memoria binaria compartida (`SharedArrayBuffer`) y primitivas atómicas de sincronización (`Atomics`), garantizando tiempos de cuadro de renderizado libres de bloqueos (*jank-free*).
   - **Audio DSP Off-Thread:** El procesamiento espacial y la modulación de ganancia corren en el hilo de audio del sistema operativo a través de `AudioWorkletProcessor`.

5. **Networking de Baja Latencia sin Bloqueo de Línea:**
   - Soporte nativo de **WebTransport (QUIC sobre UDP)** para datagramas no confiables multiplexados junto a streams bidireccionales confiables, con respaldo transparente sobre WebSockets binarios.

---

## 2. ESPECIFICACIÓN TÉCNICA DE MÓDULOS Y APIS

### 2.1. `@tacarigua/core`

Módulo central que gobierna el ciclo de vida, la temporización y la comunicación reactiva.

```
@tacarigua/core
├── core.js       -> RENDER_TYPE, SCALE_MODE, BLEND_MODE, CORE_EVENTS
├── Signal          -> Lista doblemente enlazada O(1) para despacho de alta frecuencia
├── EventEmitter    -> Bus de eventos desacoplado por canales (wrapper sobre Signals)
├── TimeStep        -> Loop Zero-GC, búfer circular Float64Array, limitador de FPS
├── Config          -> Normalizador inmutable de configuración de arranque
└── Game            -> Orquestador central de subsistemas y fases de ejecución
```

#### Búfer Circular en `TimeStep`
El cálculo del delta de tiempo amortiguado (*delta smoothing*) evita llamadas a `push()` o `shift()` sobre arrays dinámicos. Utiliza un `Float64Array` estático de tamaño fijo ($N=10$):

$$\text{deltaIndex} = (\text{deltaIndex} + 1) \pmod{\text{deltaSmoothingMax}}$$

$$\Delta t_{\text{promedio}} = \frac{1}{N} \sum_{i=0}^{N-1} \text{deltaHistory}[i]$$

#### Primitiva Reactiva `Signal`
Reemplaza los emisores basados en arrays y mutaciones con `splice()`.
- **Estructura Interna:** Cada suscripción genera un nodo `SignalBinding` con punteros de lista doblemente enlazada (`prev`, `next`).
- **Inserción y Remoción:** Inserción al final de la lista en $O(1)$; desconexión mediante desenlace de punteros en $O(1)$ sin desplazamientos de memoria.
- **Despacho:** Recorrido directo de nodos mediante punteros de memoria, eliminando la creación de arrays defensivos por evento.

#### Fases de Ejecución por Fotograma (`Game.step`)
```
[ Pulso del Temporizador (rAF / Worker) ]
                   │
                   ▼
       TimeStep._stepInternal()
                   │
                   ▼
         Game.step(time, delta)
                   │
  ├─► CORE_EVENTS.PRE_STEP   (Lectura de I/O, buffers de red y workers)
  ├─► CORE_EVENTS.STEP       (Lógica de Escenas, Integración ECS)
  ├─► CORE_EVENTS.POST_STEP  (Eliminación de entidades deferred, z-sorting)
  ├─► CORE_EVENTS.PRE_RENDER (RHI.beginRender, limpieza de framebuffers)
  ├─► CORE_EVENTS.RENDER     (Codificación de draw calls, SpriteBatcher)
  └─► CORE_EVENTS.POST_RENDER(Resolución de pases PostFX, RHI.endRender)
```

---

### 2.2. `@tacarigua/renderer-webgpu`

Capa RHI (Render Hardware Interface) que abstrae el hardware gráfico moderno.

#### Disposición del Búfer Uniforme Global (Global UBO)
El orquestador `RHI` gestiona un bloque de memoria de **128 bytes** (32 valores `Float32`) transferido a la GPU en un único comando `writeBuffer`:

| Offset (Bytes) | Tamaño | Tipo WGSL | Semántica |
| :--- | :--- | :--- | :--- |
| `0` | 64 bytes | `mat4x4<f32>` | Matriz de proyección ortográfica de la cámara. |
| `64` | 8 bytes | `vec2<f32>` | Resolución del viewport en pantalla (ancho, alto). |
| `72` | 8 bytes | `vec2<f32>` | Desplazamiento de scroll de la cámara $(X, Y)$. |
| `80` | 4 bytes | `f32` | Factor de zoom de la cámara. |
| `84` | 4 bytes | `f32` | Tiempo acumulado de ejecución del motor (segundos). |
| `88..127` | 40 bytes | `array<f32, 10>` | Relleno estático de alineación (*padding*) reservado. |

#### Contrato WGSL del Sombreador de Loteado Estándar (`WGSL_BATCH_SHADER`)
```rust
struct GlobalUniforms {
    projectionMatrix: mat4x4<f32>,
    resolution: vec2<f32>,
    cameraScroll: vec2<f32>,
    cameraZoom: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> uGlobal: GlobalUniforms;
@group(0) @binding(1) var uSampler: sampler;
@group(0) @binding(2) var uTextures: binding_array<texture_2d<f32>, 16>;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) textureIndex: f32,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) textureIndex: i32,
    @location(2) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let worldPos = (input.position - uGlobal.cameraScroll) * uGlobal.cameraZoom;
    out.clipPosition = uGlobal.projectionMatrix * vec4<f32>(worldPos, 0.0, 1.0);
    out.uv = input.uv;
    out.textureIndex = i32(input.textureIndex);
    out.color = input.color;
    return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(uTextures[input.textureIndex], uSampler, input.uv);
    return texColor * input.color;
}
```

---

### 2.3. `@tacarigua/batch-renderer-2d`

Motor de loteado geométrico de asignación cero optimizado para transformaciones 2D masivas.

#### Formato Binario del Vértice Entrelazado (Stride: 24 bytes)
Cada vértice se empaqueta en 6 palabras contiguas de 32 bits:
```
Byte:  0       4       8       12      16      20      24
       ┌───────┬───────┬───────┬───────┬───────┬───────┐
       │   X   │   Y   │   U   │   V   │TexIdx │ Color │
       └───────┴───────┴───────┴───────┴───────┴───────┘
Tipo:    f32     f32     f32     f32     f32     u32 (ABGR)
```

- **Dimensiones por Quad (Sprite):** 4 vértices $\times$ 24 bytes = 96 bytes.
- **Búfer Estándar (8.192 Quads):**
  - Capacidad en VRAM de Vértices: $8.192 \times 96\text{ bytes} = 786.432\text{ bytes}$ ($768\text{ KB}$).
  - Capacidad en VRAM de Índices: $8.192 \times 6\text{ índices} \times 2\text{ bytes (Uint16)} = 98.304\text{ bytes}$ ($96\text{ KB}$).
- **Doble Vista en CPU:** Un único búfer `ArrayBuffer` compartido instanciado con `vertexViewF32` y `vertexViewU32`.

#### Transformaciones Afines Desenrolladas (Zero-GC CPU Path)
Dada una entidad con coordenadas $(x, y)$, dimensiones $(w, h)$, punto de pivote u origen normalizado $(o_x, o_y)$, rotación $\theta$ (rad) y escala $(s_x, s_y)$:

1. **Límites locales relativos al pivote:**
   $$lx_0 = -o_x \cdot w, \quad ly_0 = -o_y \cdot h$$
   $$lx_1 = lx_0 + w, \quad ly_1 = ly_0 + h$$

2. **Factores de transformación afín:**
   $$a = \cos(\theta) \cdot s_x, \quad b = \sin(\theta) \cdot s_x$$
   $$c = -\sin(\theta) \cdot s_y, \quad d = \cos(\theta) \cdot s_y$$

3. **Proyección directa en el espacio de coordenadas mundiales:**
   - **Vértice 0 (Top-Left):**
     $$x_0 = lx_0 \cdot a + ly_0 \cdot c + x, \quad y_0 = lx_0 \cdot b + ly_0 \cdot d + y$$
   - **Vértice 1 (Top-Right):**
     $$x_1 = lx_1 \cdot a + ly_0 \cdot c + x, \quad y_1 = lx_1 \cdot b + ly_0 \cdot d + y$$
   - **Vértice 2 (Bottom-Right):**
     $$x_2 = lx_1 \cdot a + ly_1 \cdot c + x, \quad y_2 = lx_1 \cdot b + ly_1 \cdot d + y$$
   - **Vértice 3 (Bottom-Left):**
     $$x_3 = lx_0 \cdot a + ly_1 \cdot c + x, \quad y_3 = lx_0 \cdot b + ly_1 \cdot d + y$$

   *Atajo de rotación nula:* Si $\theta = 0$, se anulan las llamadas trigonométricas y se calculan las posiciones mediante sumas directas multiplicadas por escala.

#### Pipeline PostFX Ping-Pong
`PostFXPipelineManager` reserva **exactamente dos texturas de renderizado** (`renderTargetA`, `renderTargetB`) de idéntica resolución al lienzo. Cada efecto en la cadena lee de la textura actual y escribe en la alterna mediante un intercambio cíclico de referencias (*Ping-Pong swap*), logrando encadenamiento arbitrario de efectos en espacio de pantalla con cero asignaciones de memoria en tiempo de ejecución.

El sombreador genera la geometría de pantalla completa utilizando el **truco del triángulo de pantalla completa** en WGSL, prescindiendo del envío de búferes de vértices desde la CPU:
```rust
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
}
```

---

### 2.4. `@tacarigua/ecs`

Subsistema Entity Component System basado estrictamente en Structure of Arrays (SoA).

#### Formato Binario del Identificador de Entidad (`EntityId`)
Las entidades se empaquetan en un entero sin signo de 32 bits con validación generacional para erradicar punteros huérfanos (*dangling references*):

```
 31                  20 19                                0
┌──────────────────────┬───────────────────────────────────┐
│ Generación (12 bits) │       Índice de Memoria (20 bits) │
│      (0 .. 4.095)    │           (0 .. 1.048.575)        │
└──────────────────────┴───────────────────────────────────┘
```
- **Extracción de índice:** `const idx = entityId & 0xfffff;`
- **Extracción de generación:** `const gen = entityId >>> 20;`
- **Validación $O(1)$:** `generations[idx] === gen;`

#### Almacenamiento Columnar (`ComponentStore`)
Cada propiedad de un componente registrado se mapea a una columna continua en memoria tipada:
```javascript
const Transform = world.registerComponent('Transform', {
    x: 'f32',
    y: 'f32',
    rotation: 'f32',
    scaleX: 'f32',
    scaleY: 'f32'
});
// Memoria contigua subyacente:
// Transform.columns.x  -> Float32Array(capacidad)
// Transform.columns.y  -> Float32Array(capacidad)
```

#### Consultas Reactivas (`Query`)
Las consultas mantienen un array continuo de entidades coincidentes (`query.entities`). Cuando una entidad muta sus componentes o se destruye, se extrae de la consulta en tiempo constante $O(1)$ mediante la técnica **Swap & Pop**:
1. Se localiza el índice de la entidad en el array de la consulta mediante una tabla de dispersión interna (`_indexMap`).
2. El último elemento del array se copia sobre la posición de la entidad a eliminar.
3. Se actualiza el puntero del elemento movido en `_indexMap`.
4. Se descarta el último slot del array mediante `.pop()`.

---

### 2.5. `@tacarigua/physics-worker`

Motor de física off-thread aislado en un Web Worker, con sincronización de latencia cero sobre memoria binaria.

#### Disposición de Memoria Compartida (`SharedArrayBuffer`)
El búfer se divide rígidamente en dos segmentos contiguos:

```
┌──────────────────────────────────────┬─────────────────────────────────────────────────────────────────┐
│     CABECERA DE CONTROL (HEADER)     │                   BLOQUE DE DATOS DE CUERPOS                    │
│    16 x Int32 (64 bytes totales)     │           N x 16 x Float32 (N x 64 bytes por cuerpo)            │
└──────────────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

**Cabecera de Control (`Int32Array`, 64 bytes):**
- `[0] SYNC_FLAG`: `0` (Escritura/Lectura Hilo Principal), `1` (Worker Procesando), `2` (Datos Listos para Consumo).
- `[1] STEP_COUNTER`: Entero monótono incremental de ciclos físicos ejecutados.
- `[2] ACTIVE_BODIES`: Conteo de cuerpos activos que demandan simulación.
- `[3] COLLISION_COUNT`: Conteo de colisiones registradas en el paso actual.
- `[4] DELTA_TIME`: Delta del cuadro físico expresado en microsegundos ($\mu\text{s}$).
- `[5..15] RESERVADO`: Alineación y control de flags de interrupción.

**Atributos de Cada Cuerpo Físico (`Float32Array`, Stride: 16 floats = 64 bytes):**
`[0] POS_X`, `[1] POS_Y`, `[2] VEL_X`, `[3] VEL_Y`, `[4] ROTATION`, `[5] ANGULAR_VEL`, `[6] WIDTH`, `[7] HEIGHT`, `[8] MASS`, `[9] INVERSE_MASS`, `[10] BOUNCE`, `[11] FRICTION`, `[12] FLAGS`, `[13] GRAVITY_SCALE`, `[14] CUSTOM_ID` (enlace con `EntityId`), `[15] RESERVADO`.

#### Protocolo Atómico de Sincronización
```
Hilo Principal (UI / Render)                  Web Worker (Simulación Física)
             │                                              │
  Escribe deltas / entradas                                 │
  Atomics.store(SYNC_FLAG, 1) ──────────────► Detecta SYNC_FLAG === 1
             │                                              │
  Ejecuta Render WebGPU                                     ├─► Integración Euler
  Procesa Red y Sonido                                      ├─► Detección AABB
  (Sin caídas de FPS)                                       └─► Resolución Impulsos
             │                                              │
  Detecta SYNC_FLAG === 2 ◄────────────── Atomics.store(SYNC_FLAG, 2)
             │
  _syncEntities() traslada datos a ECS
  Atomics.store(SYNC_FLAG, 0)
```

#### Fórmulas de Integración y Respuesta
- **Integración Semi-Implícita de Euler:**
  $$V_x(t + \Delta t) = \left( V_x(t) + g_x \cdot s_g \cdot \Delta t \right) \cdot (1.0 - \mu \cdot \Delta t)$$
  $$X(t + \Delta t) = X(t) + V_x(t + \Delta t) \cdot \Delta t$$
- **Impulso de Restitución Elástica sobre Normal $\vec{n}$:**
  $$J = \frac{-(1 + e) \cdot (\vec{V}_{rel} \cdot \vec{n})}{M_A^{-1} + M_B^{-1}}, \quad e = \max(e_A, e_B)$$
  $$\vec{V}_A' = \vec{V}_A - J \cdot M_A^{-1} \cdot \vec{n}, \quad \vec{V}_B' = \vec{V}_B + J \cdot M_B^{-1} \cdot \vec{n}$$

---

### 2.6. `@tacarigua/sound-worklet`

Subsistema de audio espacial implementado íntegramente sobre la arquitectura `AudioWorklet`.

#### Paneo Estéreo de Potencia Constante (*Constant Power Panning*)
Para erradicar la caída perceptiva de $-3\text{ dB}$ en el centro del panorama estéreo provocada por el paneo lineal tradicional, `SpatialAudioProcessor` aplica en cada muestra $i$:

$$\theta_{pan} = (\text{pan} + 1.0) \cdot \frac{\pi}{4}$$

$$\text{Ganancia}_L = \cos(\theta_{pan}), \quad \text{Ganancia}_R = \sin(\theta_{pan})$$

$$\text{Muestra}_L[i] = \text{Entrada}_L[i] \cdot (\text{gain} \cdot \text{attenuation}) \cdot \text{Ganancia}_L$$

$$\text{Muestra}_R[i] = \text{Entrada}_R[i] \cdot (\text{gain} \cdot \text{attenuation}) \cdot \text{Ganancia}_R$$

#### Modelos de Atenuación por Distancia Euclidiana
Dado $d = \sqrt{(x_s - x_l)^2 + (y_s - y_l)^2 + (z_s - z_l)^2}$ y $d > d_{min}$:

| Modelo | Fórmula Matemática de Caída | Propósito |
| :--- | :--- | :--- |
| **Inverso (`'inverse'`)** | $\text{Att} = \frac{d_{min}}{d_{min} + \text{rolloff} \cdot (d - d_{min})}$ | Comportamiento acústico natural en espacios abiertos. |
| **Lineal (`'linear'`)** | $\text{Att} = 1.0 - \frac{\text{rolloff} \cdot (d - d_{min})}{d_{max} - d_{min}}$ | Zonas acústicas acotadas o interfaces espaciales. |
| **Exponencial (`'exponential'`)** | $\text{Att} = \left(\max\left(\frac{d}{d_{min}}, 1.0\right)\right)^{-\text{rolloff}}$ | Caídas abruptas de sonido en entornos oclusivos. |

- **De-zippering Asintótico:** La mutación de parámetros utiliza `param.setTargetAtTime(target, audioCtx.currentTime, 0.02)` ($\tau = 20\text{ ms}$), eliminando los clics y chasquidos (*zipper noise*) producidos por cambios discretos inmediatos.

---

### 2.7. `@tacarigua/net`

Infraestructura de comunicación en tiempo real de ultra baja latencia.

#### Canales Multiplexados
- **Canal `UNRELIABLE` (WebTransport Datagrams sobre UDP):** Emisión continua de cinemática a alta frecuencia (20-60 Hz). Sin garantías de entrega ni orden. Erradica por diseño el problema de bloqueo de cabeza de línea (*Head-of-Line Blocking*) presente en WebSockets (TCP).
- **Canal `RELIABLE` (WebTransport Bidirectional Streams):** Flujo binario ordenado, garantizado y con control de flujo para eventos de combate, transacciones y sincronización de estado estricto.

#### Serializador Binario `BinaryPacket`
Opera sobre un `ArrayBuffer` continuo y vistas `DataView` estandarizadas en **Little-Endian**:
- `writeUint8(v)`, `writeUint16(v)`, `writeUint32(v)`.
- `writeFloat32(v)`, `writeFloat64(v)`.
- `writeString(str)`: Codificación UTF-8 prefijada con 2 bytes (`Uint16`) que especifican su longitud exacta.

#### Interpolador de Instantáneas Temporales (`SnapshotInterpolator`)
Las posiciones remotas se renderizan en una ventana retrasada fija ($t_{\text{render}} = t_{\text{actual}} - t_{\text{lag}}$):
1. **Factor de Mezcla ($\alpha$):**
   $$\alpha = \frac{t_{\text{render}} - t_{\text{prev}}}{t_{\text{next}} - t_{\text{prev}}}$$
2. **LERP Posicional:**
   $$\vec{P} = \vec{P}_{\text{prev}} + (\vec{P}_{\text{next}} - \vec{P}_{\text{prev}}) \cdot \alpha$$
3. **Interpolación Angular del Arco Menor (Shortest Angle Slerp):**
   $$\Delta\theta = ((\theta_{\text{next}} - \theta_{\text{prev}}) \pmod{2\pi})$$
   $$\Delta\theta_{\text{mín}} = (2 \cdot \Delta\theta \pmod{2\pi}) - \Delta\theta$$
   $$\theta = \theta_{\text{prev}} + \Delta\theta_{\text{mín}} \cdot \alpha$$

---

### 2.8. `@tacarigua/input-xr`

Subsistema de interacción inmersiva y periféricos hápticos.

- **Conmutación del Bucle Temporal (*Loop Hijacking*):** Al establecer una sesión `immersive-vr` o `immersive-ar`, el `TimeStep` suspende la llamada tradicional a `window.requestAnimationFrame` y delega la ejecución a `XRSession.requestAnimationFrame(callback)`, acoplándose a las tasas de refresco nativas del hardware (72 Hz, 90 Hz, 120 Hz).
- **Rastreo de Mandos 6DoF:** Cálculo del rayo de puntería sin asignación de memoria mediante derivación analítica desde el cuaternión unitario de rotación:
  $$d_x = 2(q_x q_z + q_w q_y), \quad d_y = 2(q_y q_z - q_w q_x), \quad d_z = 1 - 2(q_x^2 + q_y^2)$$
- **Hand Tracking de Alto Rendimiento:** Búfer prealocado continuo de 400 números de coma flotante ($25\text{ articulaciones} \times 16\text{ floats}$ para matrices $4\times 4$) poblado en una única llamada del driver mediante `frame.fillPoses()`.
- **Ecosistema Háptico Multicapa:** Soporte prioritario para actuadores de doble motor (*Dual-Rumble: strong/weak magnitudes*) sobre mandos de consola estándar, pulsos en microsegundos para mandos WebXR y degradación controlada a la Vibration API móvil.

---

### 2.9. `@tacarigua/devtools`

Infraestructura de telemetría y perfilado en tiempo real sin impacto en el recolector de basura.

- **Hook Global Estandarizado:** Registra `window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__` permitiendo a las extensiones de navegador conectarse dinámicamente con las instancias activas de `Game`.
- **Muestreo Estadístico sin Asignación:** `MetricSampler` registra tiempos de ejecución mediante un búfer circular plano `Float32Array(120)`, calculando promedios, valores mínimos y máximos mediante aritmética modular y operaciones vectorizadas.
- **Estimación Continua de VRAM:**
  $$\text{VRAM}_{\text{total}} = \sum (\text{ancho} \times \text{alto} \times 4\text{ bytes [RGBA8]}) + \text{UBO}_{\text{global}} + \text{VRAM}_{\text{geom}}$$
- **Lienzo de Superposición Independiente:** `DebugOverlayRenderer` genera un elemento canvas 2D superpuesto con CSS `pointer-events: none` que dibuja sparklines de rendimiento, hitboxes interactivas y las AABBs de la física leyendo directamente el `SharedArrayBuffer` del worker.
- **Canal Bidireccional:** Protocolo `postMessage` sincronizado a **4 Hz (250 ms)** para telemetría y mutación en caliente de propiedades de entidades desde el panel inspector.

---

### 2.10. `@tacarigua/vite-plugin`

Herramientas de construcción y compilación para arquitecturas modernas basadas en Vite y Rollup.

- **Scene HMR (Hot Module Replacement):** Permite modificar el código de clases `Scene` preservando el estado transitorio. Serializa en caliente `scene.data` y las configuraciones de cámara principal (`fromJSON`/`toJSON`), reemplazando la instancia en memoria en menos de **$80\text{ ms}$** sin recargar la pestaña del navegador ni destruir el contexto WebGPU.
- **Compilador y Minificador Nativo de WGSL/GLSL:** Procesa archivos `.wgsl`, `.glsl`, `.vert` y `.frag` convirtiéndolos en módulos ESM. Elimina comentarios de bloque y de línea, contrae espacios en blanco alrededor de delimitadores sintácticos y reduce el tamaño de los assets de sombreadores en el bundle de producción entre un **$30\%\text{ y }50\%$**.
- **Topología de Exportación Condicional:** Configuración estricta de subrutas en `package.json` con directiva `"sideEffects": false` para posibilitar *tree-shaking* real en bundlers modernos.

---

### 2.11. `@tacarigua/types`

Contratos de tipos TypeScript que gobiernan la integridad estructural del motor.

- **Marcado de Tipos Nominales (*Branded Types*):** Protección a nivel de compilación para identificadores numéricos escalares:
  ```typescript
  export type EntityId = number & { readonly __brand: unique symbol };
  export type TextureSlotId = number & { readonly __slotBrand: unique symbol };
  ```
- **Esquemas de Componentes SoA:**
  ```typescript
  export type ComponentScalarType = 'f32' | 'f64' | 'i32' | 'i16' | 'i8' | 'u32' | 'u16' | 'u8';
  export type ComponentSchema = Record<string, ComponentScalarType>;
  ```
- **Parametrización Genérica de Recursos:** `GameConfig<TTextureKeys, TAudioKeys, TSceneKeys>` valida estáticamente el uso de identificadores de recursos en llamadas a sistemas y escenas, bloqueando fallos de ejecución por errores tipográficos.

---

### 2.12. `@tacarigua/testing` y `@tacarigua/docs-playground`

Herramientas de testing unitario headless, benchmarks de estrés y entorno interactivo.

- **`WebGPUMock`:** Emula `GPUDevice`, `GPUQueue`, `GPUBuffer` y comandos de dibujo en memoria principal sin requerir navegadores reales, software de renderizado por software ni librerías como Puppeteer o Karma.
- **`MemoryLeakValidator`:** Evalúa bucles de ejecución forzando el calentamiento del optimizador JIT de V8 y midiendo el montón con `globalThis.gc()`. Exige que la variación de memoria sea estrictamente:
  $$\Delta\text{Heap} = \text{Heap}_{\text{final}} - \text{Heap}_{\text{inicial}} < 1024\text{ bytes}$$
- **`PlaygroundRunner`:** Ejecutor de pruebas aislado mediante un `HTMLIFrameElement` dinámico, configurado con permisos estrictos de `allow="cross-origin-isolated; xr-spatial-tracking"`, ciclo de vida controlado por `Blob URL` y recolector explícito de recursos GPU.
- **`MigrationAuditor`:** Analizador estático de objetos de configuración legados que evalúa y reporta incompatibilidades de versiones previas clasificadas por severidad (`warning`, `deprecated`, `breaking`).

---

## 3. GUÍA DE MIGRACIÓN: PHASER 4.2.1 $\to$ Tacarigua 1.0.0

### 3.1. Tabla Comparativa de Cambios Disruptivos (*Breaking Changes*)

| Subsistema | Arquitectura Antigua (Phaser v4.2.1) | Arquitectura Moderna (Tacarigua v1.0.0) | Severidad | Acción de Refactorización Requerida |
| :--- | :--- | :--- | :--- | :--- |
| **Namespace Global** | Objeto monolítico global `window.Phaser` | Submódulos independientes ESM `@tacarigua/*` | `BREAKING` | Reemplazar dependencias globales por importaciones nombradas directas. |
| **Definición de Clases** | Emulación heredada `new Phaser.Class({})` | Clases nativas estándar de ES2022+ (`class`) | `BREAKING` | Reescribir constructores y prototipos a clases nativas de JavaScript. |
| **Backend Gráfico** | WebGL 1/2 imperativo (`WebGLRenderer`) | Capa RHI (`WebGPURHI` con fallback `WebGL2RHI`) | `BREAKING` | Abandonar manipulación directa de `gl.*`; consumir `rhi.driver`. |
| **Lenguaje Shaders** | GLSL ES 1.0/3.0 en strings de JS | Archivos nativos en **WGSL** vinculados a UBOs | `BREAKING` | Reescribir shaders en WGSL y estructurar uniformes en `@group(0)`. |
| **Pipeline 2D** | Fragmentado (`MultiPipeline`, etc.) | Unificado en `SpriteBatcher` (24 bytes stride) | `BREAKING` | Reemplazar sobreescrituras de pipeline por llamadas a `batchQuad`. |
| **Arquitectura Lógica** | Árboles masivos de objetos OOP (`GameObject`) | Sistema Híbrido: **ECS Puro (SoA)** o Adaptadores | `BREAKING` | Migrar colecciones densas de sprites a `ECSWorld` y componentes SoA. |
| **Física de Juego** | Arcade/Matter en Hilo Principal (Main Thread) | `@tacarigua/physics-worker` con `SharedArrayBuffer` | `BREAKING` | Configurar cabeceras COOP/COEP; crear cuerpos en el worker. |
| **Subsistema Audio** | `HTML5AudioSound` y Web Audio en Main Thread | `@tacarigua/sound-worklet` (`AudioWorkletProcessor`) | `BREAKING` | Eliminar `disableWebAudio`; usar `SpatialSoundManager`. |
| **Red / Networking** | Librerías de terceros (Socket.io/JSON) | `@tacarigua/net` (WebTransport / `BinaryPacket`) | `BREAKING` | Migrar payloads JSON a esquemas atómicos binarios. |
| **Suscripción Eventos** | Búsqueda y corte de arrays (`splice()`) | Listas doblemente enlazadas `Signal` en bucles | `MODERATE` | Migrar eventos de ciclo crítico a `Signal.dispatch()`. |

---

### 3.2. Mapeos de Equivalencia de Sintaxis (Legacy vs Modern ES6+)

#### Patrón 1: Arranque del Motor e Inicialización
```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser v4.2.1)
// ==========================================
const config = {
    type: Phaser.AUTO,
    width: 1280,
    height: 720,
    parent: 'game-div',
    physics: {
        default: 'arcade',
        arcade: { gravity: { y: 600 }, debug: true }
    },
    audio: { disableWebAudio: false },
    scene: [MyScene]
};
const game = new Phaser.Game(config);

// ==========================================
// CÓDIGO MODERNO (Tacarigua v1.0.0)
// ==========================================
import { Game, RENDER_TYPE, SCALE_MODE } from '@tacarigua/core.js';
import { PhysicsWorkerBridge } from '@tacarigua/physics-worker';
import { SpatialSoundManager } from '@tacarigua/sound-worklet';

const config = {
    type: RENDER_TYPE.AUTO, // Selecciona WebGPU automáticamente con fallback a WebGL 2
    width: 1280,
    height: 720,
    scaleMode: SCALE_MODE.FIT,
    render: {
        preferWebGPU: true,
        powerPreference: 'high-performance',
        antialias: true
    },
    fps: { targetFps: 60, smoothStep: true }
};

const game = new Game(config);
const physics = new PhysicsWorkerBridge(game, { gravity: { x: 0, y: 600 } });
const audio = new SpatialSoundManager(game);
```

---

#### Patrón 2: De Sprites Pesados en Heap (OOP) a Componentes Contiguos (ECS)
```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser v4.2.1) - Sobrecarga de Heap y Presión de GC
// ==========================================
class Bullet extends Phaser.Physics.Arcade.Sprite {
    constructor(scene, x, y) {
        super(scene, x, y, 'bullet');
        scene.add.existing(this);
        scene.physics.add.existing(this);
        this.setVelocity(400, 0);
    }
}
const bullets = [];
for (let i = 0; i < 10000; i++) {
    bullets.push(new Bullet(scene, 0, 0));
}

// ==========================================
// CÓDIGO MODERNO (Tacarigua v1.0.0) - Cero Asignaciones en Búferes Contiguos
// ==========================================
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

const world = new ECSWorld(10000);
world.addSystem(new MovementSystem(world));

for (let i = 0; i < 10000; i++) {
    const entity = world.createEntity(); // Retorna un EntityId escalar de 32 bits
    world.addComponent(entity, world.Transform, {
        x: 0, y: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5
    });
    world.addComponent(entity, world.Velocity, { vx: 400, vy: 0 });
    world.addComponent(entity, world.Renderable, {
        width: 16, height: 16, visible: 1, alpha: 1.0, tint: 0xffffffff, textureSlot: 0
    });
}
// En cada tick de juego: world.step(time, delta);
```

---

#### Patrón 3: Pipeline de Post-Procesamiento (GLSL vs WGSL)
```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser v4.2.1) - Fragment Shader GLSL ES 2.0
// ==========================================
const TintPipeline = new Phaser.Class({
    Extends: Phaser.Renderer.WebGL.Pipelines.PostFXPipeline,
    initialize: function TintPipeline(game) {
        Phaser.Renderer.WebGL.Pipelines.PostFXPipeline.call(this, {
            game: game,
            fragShader: `
                precision mediump float;
                uniform sampler2D uMainSampler;
                varying vec2 outTexCoord;
                void main() {
                    vec4 color = texture2D(uMainSampler, outTexCoord);
                    gl_FragColor = vec4(color.r * 0.5, color.gb, color.a);
                }
            `
        });
    }
});

// ==========================================
// CÓDIGO MODERNO (Tacarigua v1.0.0) - PostFX WGSL sobre RHI
// ==========================================
import { PostFXEffect } from '@tacarigua/batch-renderer-2d';

export class ModernTintFX extends PostFXEffect {
    constructor(rhi) {
        super('ModernTintFX', rhi);
        this.shaderCode = `
            @group(0) @binding(1) var uSampler: sampler;
            @group(0) @binding(2) var uTexture: texture_2d<f32>;

            @fragment
            fn fs_main(@builtin(position) coord: vec4<f32>) -> @location(0) vec4<f32> {
                let uv = coord.xy / vec2<f32>(1280.0, 720.0);
                let color = textureSample(uTexture, uSampler, uv);
                return vec4<f32>(color.r * 0.5, color.gb, color.a);
            }
        `;
    }

    apply(sourceTexture, targetTexture) {
        if (!this.enabled) return;
        // La RHI despacha el shader leyendo de sourceTexture y renderizando en targetTexture
    }
}
```

---

#### Patrón 4: Redimensionado de Físicas y Movimiento
```javascript
// ==========================================
// CÓDIGO ANTIGUO (Phaser v4.2.1)
// ==========================================
player.body.setVelocity(250, -150);
player.body.x = 100;

// ==========================================
// CÓDIGO MODERNO (Tacarigua v1.0.0)
// ==========================================
// Mutación atómica no bloqueante en el worker a través del identificador de cuerpo
physicsBridge.setVelocity(playerBodyId, 250, -150);
physicsBridge.setPosition(playerBodyId, 100, player.y);
```

---

### 3.3. Lista de Verificación Automatizable para Auditorías (`MigrationAuditor`)

El módulo `@tacarigua/docs-playground` provee la utilidad `MigrationAuditor.auditConfig(config)`. Las reglas deterministas a auditar son:

1. **`type === 1` (`CANVAS`):** Bloquear o emitir severidad crítica. Canvas 2D puro no forma parte del pipeline acelerado v1.0.0. Debe sustituirse por `RENDER_TYPE.AUTO` (WebGPU / WebGL 2).
2. **`audio.disableWebAudio: true`:** Elevar excepción `breaking`. Tacarigua 1.0.0 depende funcionalmente de Web Audio y `AudioWorklet`.
3. **`physics.arcade.useTree: false`:** Emitir advertencia de deprecación. El árbol R-Tree de Phaser clásico ha sido erradicado en favor de la resolución contigua lineal por barrido AABB en Web Workers.
4. **`scene.extend` o `Phaser.Class`:** Declarar incompatible. Exigir la transformación a la sintaxis nativa `class MiEscena extends Scene`.
5. **Uso de `customPipelines` en WebGL:** Exigir recompilación de sombreadores a **WGSL** y derivación desde `PostFXEffect` o interfaces de la RHI.

---

## 4. PATRONES DE CÓDIGO Y RECETAS DE PRODUCCIÓN

### Receta 1: Inicialización Completa de Producción (WebGPU, Worker Physics, AudioWorklet, DevTools)

```javascript
import { Game, RENDER_TYPE, SCALE_MODE, CORE_EVENTS } from '@tacarigua/core.js';
import { PhysicsWorkerBridge } from '@tacarigua/physics-worker';
import { SpatialSoundManager } from '@tacarigua/sound-worklet';
import { DevToolsAgent } from '@tacarigua/devtools';
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

// 1. Configurar y arrancar el orquestador Game
const config = {
    type: RENDER_TYPE.AUTO,
    width: 1920,
    height: 1080,
    scaleMode: SCALE_MODE.FIT,
    autoCenter: 1,
    render: {
        preferWebGPU: true,
        antialias: true,
        powerPreference: 'high-performance'
    },
    fps: {
        targetFps: 60,
        smoothStep: true,
        deltaSmoothingMax: 10
    }
};

const game = new Game(config);

// 2. Inicializar los subsistemas concurrentes desacoplados
const physics = new PhysicsWorkerBridge(game, {
    maxBodies: 10000,
    gravity: { x: 0.0, y: 980.0 }
});

const audio = new SpatialSoundManager(game);
const world = new ECSWorld(10000);
world.addSystem(new MovementSystem(world));

// 3. Conectar DevTools si el entorno es de desarrollo
if (import.meta.env.DEV) {
    const devtools = new DevToolsAgent(game);
    devtools.overlay.visible = true;
    devtools.overlay.showSparkline = true;
    devtools.overlay.showPhysicsAABB = true;
}

// 4. Crear piso estático y entidad dinámica
const groundBodyId = physics.createBody(960, 1050, 1920, 60, { isStatic: true, bounce: 0.1 });

const playerEntity = world.createEntity();
world.addComponent(playerEntity, world.Transform, { x: 960, y: 200, scaleX: 1, scaleY: 1 });
world.addComponent(playerEntity, world.Velocity, { vx: 0, vy: 0 });

const playerBodyId = physics.createBody(960, 200, 64, 64, {
    mass: 1.0,
    bounce: 0.4
}, {
    // Vinculación reflectiva hacia las columnas contiguas del ECS
    Transform: {
        get x() { return world.Transform.columns.x[playerEntity & 0xfffff]; },
        set x(val) { world.Transform.columns.x[playerEntity & 0xfffff] = val; },
        get y() { return world.Transform.columns.y[playerEntity & 0xfffff]; },
        set y(val) { world.Transform.columns.y[playerEntity & 0xfffff] = val; },
        get rotation() { return world.Transform.columns.rotation[playerEntity & 0xfffff]; },
        set rotation(val) { world.Transform.columns.rotation[playerEntity & 0xfffff] = val; }
    }
});

// 5. Instanciar sonido espacial 3D siguiendo al jugador
const footstepSound = audio.addSpatial('sfx_footsteps', {
    x: 960,
    y: 200,
    minDistance: 150,
    maxDistance: 1200,
    distanceModel: 'inverse',
    loop: true
});
footstepSound.setFollow(world.Transform.columns, playerEntity & 0xfffff);

// 6. Bucle principal unificado
game.events.on(CORE_EVENTS.STEP, (time, delta) => {
    physics.update(delta);       // Sincroniza memoria atómica con Web Worker
    world.step(time, delta);     // Integra cinemática en ECS
    audio.update(time, delta);   // Actualiza distancias acústicas y DSP
});
```

---

### Receta 2: Sistema Masivo de Proyectiles (Bullet-Hell) con ECS y `SpriteBatcher`

```javascript
import { ECSWorld, System, TYPE } from '@tacarigua/ecs';
import { SpriteBatcher } from '@tacarigua/batch-renderer-2d';

// Componente para gestión de tiempo de vida
const BulletData = {
    remainingTime: TYPE.FLOAT32,
    speed: TYPE.FLOAT32
};

export class BulletHellManager {
    constructor(rhi, capacity = 50000) {
        this.world = new ECSWorld(capacity);
        this.batcher = new SpriteBatcher(rhi, 8192);
        this.BulletComponent = this.world.registerComponent('BulletData', BulletData);

        // Sistema de procesamiento columnar
        this.world.addSystem(new class extends System {
            init() {
                this.query = this.world.createQuery([
                    this.world.Transform,
                    this.world.Velocity,
                    this.world.registerComponent('BulletData', BulletData)
                ]);
            }
            update(time, delta) {
                const dt = delta * 0.001;
                const entities = this.query.entities;
                const count = entities.length;

                const x = this.world.Transform.columns.x;
                const y = this.world.Transform.columns.y;
                const vx = this.world.Velocity.columns.vx;
                const vy = this.world.Velocity.columns.vy;
                const life = this.world.registerComponent('BulletData', BulletData).columns.remainingTime;

                // Bucle de alta velocidad sobre arrays contiguos (Cero GC)
                for (let i = count - 1; i >= 0; i--) {
                    const idx = entities[i] & 0xfffff;
                    x[idx] += vx[idx] * dt;
                    y[idx] += vy[idx] * dt;
                    life[idx] -= dt;

                    if (life[idx] <= 0) {
                        this.world.destroyEntity(entities[i]);
                    }
                }
            }
        }(this.world));
    }

    spawnRingOfBullets(originX, originY, bulletCount, speed, texture) {
        const angleStep = (Math.PI * 2) / bulletCount;

        for (let i = 0; i < bulletCount; i++) {
            const angle = i * angleStep;
            const entity = this.world.createEntity();

            this.world.addComponent(entity, this.world.Transform, {
                x: originX,
                y: originY,
                rotation: angle,
                scaleX: 1.0,
                scaleY: 1.0,
                originX: 0.5,
                originY: 0.5
            });

            this.world.addComponent(entity, this.world.Velocity, {
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed
            });

            this.world.addComponent(entity, this.BulletComponent, {
                remainingTime: 5.0,
                speed: speed
            });

            this.world.addComponent(entity, this.world.Renderable, {
                width: 16,
                height: 16,
                u0: 0.0, v0: 0.0, u1: 1.0, v1: 1.0,
                tint: 0x00ffffff,
                alpha: 1.0,
                textureSlot: 0,
                visible: 1
            });
        }
    }

    render(textureHandle) {
        this.batcher.begin();

        const x = this.world.Transform.columns.x;
        const y = this.world.Transform.columns.y;
        const rot = this.world.Transform.columns.rotation;
        const visible = this.world.Renderable.columns.visible;

        const query = this.world.createQuery([this.world.Transform, this.world.Renderable]);
        const entities = query.entities;
        const total = entities.length;

        for (let i = 0; i < total; i++) {
            const idx = entities[i] & 0xfffff;
            if (visible[idx] === 0) continue;

            // Inyección continua al búfer de 24B (Zero Allocation)
            this.batcher.batchQuad(
                x[idx], y[idx],
                16, 16,
                rot[idx],
                1.0, 1.0,
                0.5, 0.5,
                0.0, 0.0, 1.0, 1.0,
                0x00ffffff,
                1.0,
                textureHandle
            );
        }

        this.batcher.flush();
    }
}
```

---

### Receta 3: Cliente Multijugador en Tiempo Real con WebTransport y `SnapshotInterpolator`

```javascript
import { NetworkClient, NET_CHANNEL, TRANSPORT_TYPE } from '@tacarigua/net';

export class MultiplayerClient {
    constructor(game, serverUrl) {
        this.game = game;
        this.serverUrl = serverUrl;
        this.net = new NetworkClient(game, {
            transport: TRANSPORT_TYPE.AUTO, // Intenta WebTransport (QUIC) -> Fallback a WebSocket
            interpolationLag: 60            // Ventana de retardo de render en milisegundos
        });

        this.OPCODE_INPUT = 1;
        this.OPCODE_SNAPSHOT = 2;
        this.remoteEntities = new Map(); // NetworkId -> Instancia visual
    }

    async start() {
        await this.net.connect(this.serverUrl);
        console.log(`[Red] Conectado vía: ${this.net.adapter.constructor.name}`);

        // Registrar recepción de instantáneas del mundo (Canal no confiable de datagramas)
        this.net.on(`packet:${this.OPCODE_SNAPSHOT}`, (packet) => {
            const serverTimestamp = packet.readFloat64();
            const count = packet.readUint16();
            const entitiesMap = new Map();

            for (let i = 0; i < count; i++) {
                const id = packet.readUint32();
                const x = packet.readFloat32();
                const y = packet.readFloat32();
                const angle = packet.readFloat32();

                entitiesMap.set(id, { x, y, rotation: angle });
            }

            // Inyectar en el interpolador de búfer en anillo
            this.net.interpolator.pushSnapshot(serverTimestamp, entitiesMap);
        });

        // Loop de envío de entrada del jugador a 60 Hz
        let seq = 0;
        this.game.events.on('step', (time, delta) => {
            // Emisión sobre canal UNRELIABLE (Datagrama UDP libre de Head-of-Line Blocking)
            this.net.send(NET_CHANNEL.UNRELIABLE, this.OPCODE_INPUT, (packet) => {
                packet.writeUint32(seq++);
                packet.writeFloat32(this.currentInputX);
                packet.writeFloat32(this.currentInputY);
            });

            // Reconciliar y proyectar estados remotos interpolados
            this.interpolateRemotePlayers();
        });
    }

    interpolateRemotePlayers() {
        const renderTime = performance.now();
        const state = { x: 0, y: 0, rotation: 0 };

        for (const [netId, visualObj] of this.remoteEntities.entries()) {
            const valid = this.net.interpolator.interpolateEntity(netId, renderTime, state);
            if (valid) {
                visualObj.x = state.x;
                visualObj.y = state.y;
                visualObj.rotation = state.rotation; // Interpolación angular Shortest-Path
            }
        }
    }
}
```

---

### Receta 4: Filtro PostFX Avanzado en WGSL (Pixelación Dinámica)

```javascript
import { PostFXEffect } from '@tacarigua/batch-renderer-2d';
import { RHI_BUFFER_USAGE } from '@tacarigua/renderer-webgpu';

export class PixelateFX extends PostFXEffect {
    constructor(rhi) {
        super('PixelateFX', rhi);

        this.pixelSize = 8.0;

        // Búfer uniforme alineado a 16 bytes: [pixelSize, width, height, padding]
        this.uniformBuffer = this.rhi.driver.createBuffer(
            'Pixelate_Uniforms',
            16,
            RHI_BUFFER_USAGE.UNIFORM | RHI_BUFFER_USAGE.COPY_DST
        );

        this.shaderCode = `
            struct Uniforms {
                pixelSize: f32,
                screenWidth: f32,
                screenHeight: f32,
                padding: f32,
            };

            @group(0) @binding(0) var<uniform> uConfig: Uniforms;
            @group(0) @binding(1) var uSampler: sampler;
            @group(0) @binding(2) var uTexture: texture_2d<f32>;

            @vertex
            fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>( 3.0, -1.0),
                    vec2<f32>(-1.0,  3.0)
                );
                return vec4<f32>(pos[index], 0.0, 1.0);
            }

            @fragment
            fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
                let res = vec2<f32>(uConfig.screenWidth, uConfig.screenHeight);
                let pSize = max(1.0, uConfig.pixelSize);
                
                // Muestreo cuantizado en coordenadas normalizadas
                let coord = floor(fragCoord.xy / pSize) * pSize;
                let uv = coord / res;
                
                return textureSample(uTexture, uSampler, uv);
            }
        `;
    }

    apply(sourceTexture, targetTexture) {
        if (!this.enabled) return;

        // Subir datos de configuración a la GPU
        const uniforms = new Float32Array([
            this.pixelSize,
            this.rhi.width,
            this.rhi.height,
            0.0
        ]);
        this.rhi.driver.writeBuffer(this.uniformBuffer, uniforms);

        // Despacho del pase de render a través de la RHI
        // Lee sourceTexture y escribe el resultado en targetTexture
    }

    destroy() {
        super.destroy();
        this.uniformBuffer.nativeHandle?.destroy?.();
    }
}
```

---

## 5. DIRECTRICES DE RENDIMIENTO, ENTORNOS DE COMPILACIÓN Y TESTING

### 5.1. Configuración de Construcción con Vite (`vite.config.js`)

Para habilitar el reemplazo de módulos en caliente (`sceneHMR`), la minificación estricta de shaders y los permisos de hardware para `SharedArrayBuffer`:

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
        port: 8080,
        headers: {
            // Indispensable para SharedArrayBuffer y Atomics en @tacarigua/physics-worker
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    },
    build: {
        target: 'es2022',
        sourcemap: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    phaser_core: ['@tacarigua/core', '@tacarigua/types'],
                    phaser_render: ['@tacarigua/renderer-webgpu', '@tacarigua/batch-renderer-2d'],
                    phaser_workers: ['@tacarigua/physics-worker', '@tacarigua/sound-worklet']
                }
            }
        }
    }
});
```

---

### 5.2. Testing de Rendimiento e Invarianza de Memoria (CI/CD)

Script de validación estricta para asegurar que ninguna modificación al motor rompa la regla de **Cero Asignaciones en Runtime (Zero-GC)**:

```javascript
// tests/zero-allocation.test.js
// Ejecución obligatoria con el flag: node --expose-gc tests/zero-allocation.test.js

import { WebGPUMock, MemoryLeakValidator, Assert } from '@tacarigua/testing';
import { Game, RENDER_TYPE } from '@tacarigua/core.js';
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

// 1. Instalar la capa de emulación gráfica
WebGPUMock.install();

const game = new Game({
    type: RENDER_TYPE.HEADLESS,
    width: 800,
    height: 600
});

const world = new ECSWorld(5000);
world.addSystem(new MovementSystem(world));

for (let i = 0; i < 2000; i++) {
    const e = world.createEntity();
    world.addComponent(e, world.Transform, { x: 100, y: 100 });
    world.addComponent(e, world.Velocity, { vx: 50, vy: -50 });
}

// 2. Ejecutar validación con calentamiento JIT (100 warmup cycles, 1000 iteration test)
const result = MemoryLeakValidator.testZeroAllocation(() => {
    game.step(16.66, 16.66);
    world.step(16.66, 16.66);
}, 100, 1000);

Assert.isTrue(
    result.passed,
    `Fallo de Asignación Cero: El frame loop generó ~${result.allocatedBytesEstimate} bytes en el montón.`
);

console.log('✔ Verificación de Rendimiento Superada: 0 fugas de memoria en bucle crítico.');
```

---

## 6. RESUMEN DE DECISIÓN ARQUITECTÓNICA (CHEAT SHEET PARA LA IA)

1. **¿Se necesita crear sprites masivos (>500)?**
   $\to$ **Nunca** instanciar `GameObject` clásicos. Usar `ECSWorld`, instanciar componentes `Transform`/`Renderable` SoA y procesar el renderizado con `SpriteBatcher`.
2. **¿Se calculan físicas intensivas?**
   $\to$ **Nunca** bloquear el hilo de render. Instanciar `PhysicsWorkerBridge`, transferir identificadores escalares y asegurar cabeceras `COOP/COEP`.
3. **¿Se manipulan shaders?**
   $\to$ **Nunca** escribir GLSL embebido en strings de JavaScript. Escribir archivos `.wgsl` estructurados con `@group(0) @binding(n)` e importarlos vía `@tacarigua/vite-plugin`.
4. **¿Se comunican sistemas a alta frecuencia?**
   $\to$ **Nunca** despachar eventos mediante strings en bucles de 60/120 FPS. Utilizar instancias directas de `Signal` y desacoplar nodos mediante `detach()`.
5. **¿Se emiten datos de cinemática de red?**
   $\to$ **Nunca** serializar JSON con `JSON.stringify()`. Utilizar `BinaryPacket` sobre `NET_CHANNEL.UNRELIABLE` (WebTransport / QUIC).