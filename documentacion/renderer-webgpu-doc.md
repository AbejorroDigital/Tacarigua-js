# Documentación Técnica: Capa RHI y Pipeline WebGPU / WebGL2 (`@tacarigua/renderer-webgpu`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

El módulo `@tacarigua/renderer-webgpu` introduce la **Render Hardware Interface (RHI)** en Tacarigua 1.0.0. En la versión 4.2.1 y versiones precedentes, el subsistema de renderizado estaba fuertemente acoplado a la máquina de estados imperativa de WebGL 1.0/2.0 (`WebGLRenderer`, `WebGLPipeline`, `WebGLShader`). Esto provocaba un elevado número de llamadas redundantes al driver (`glBindBuffer`, `glUseProgram`, `glBindTexture`), obligaba a validar estados en cada llamada de dibujo (*draw call*) y limitaba el aprovechamiento de GPUs multinúcleo modernas.

La arquitectura RHI de Tacarigua 1.0.0 desacopla completamente la lógica de los objetos del juego del backend gráfico subyacente:
- **WebGPU como Núcleo de Primera Clase:** Diseñado para utilizar comandos inmutables, *Pipelines* precompilados (`GPURenderPipeline`), grupos de recursos (*BindGroups*) y sombreadores en **WGSL** (*WebGPU Shading Language*).
- **Fallback Homogéneo a WebGL 2.0:** Si el cliente carece de compatibilidad con WebGPU (falta de soporte en navegador o ausencia de `navigator.gpu`), la RHI conmuta de forma transparente a una implementación idéntica sobre WebGL 2.0 (`WebGL2RHI`), conservando la misma interfaz sin alterar los componentes superiores.
- **Normalización del Espacio de Profundidad:** Corrige automáticamente las discrepancias entre el rango de clip de WebGPU ($Z \in [0, 1]$) y el de WebGL 2 ($Z \in [-1, 1]$) dentro de la matriz de proyección unificada.
- **Asignación Cero en el Ciclo de Render:** Supresión absoluta de instanciaciones dinámicas por cuadro gracias a descriptores de pasada de render (`_renderPassDescriptor`) preasignados en memoria estática.

---

## 2. Estructura Interna y Componentes del Módulo

El módulo se articula en torno al coordinador `RHI`, que actúa como factoría y puente hacia los controladores de bajo nivel:

```
@tacarigua/renderer-webgpu.js
├── Constants & Enums  -> RHI_TEXTURE_FORMAT, RHI_BUFFER_USAGE, RHI_PRIMITIVE_TOPOLOGY, etc.
├── Shaders            -> WGSL_BATCH_SHADER (Sombreador estándar para loteado 2D)
├── Resource Wrappers  -> RHIBuffer, RHITexture, RHIPipeline
├── Drivers            -> WebGPURHI (Nativo WebGPU)
│                      -> WebGL2RHI (Fallback WebGL 2.0)
└── Coordinator        -> RHI (Fachada unificada, ciclo de cuadro y UBO global)
```

### 2.1. Descriptores y Estructuras de Datos

#### `RHIBuffer`
Encapsula la memoria de video asignada en GPU. Almacena:
- `size`: Tamaño del búfer en bytes (con alineación a 4 bytes impuesta por la especificación WebGPU).
- `usage`: Máscara de bits generada a partir de `RHI_BUFFER_USAGE` (`VERTEX`, `INDEX`, `UNIFORM`, `STORAGE`, `COPY_DST`).
- `nativeHandle`: Instancia subyacente (`GPUBuffer` o `WebGLBuffer`).

#### `RHITexture`
Representa recursos de imagen en GPU:
- Soporta texturas individuales 2D y arreglos de texturas 2D (`texture_2d_array` / `depth > 1`) para loteado multidestino en una sola llamada de dibujo.
- `nativeView`: Almacena la `GPUTextureView` en WebGPU, eliminando el re-empaquetado constante al asociar texturas a *BindGroups*.

#### `RHIPipeline`
Representa el estado gráfico inmutable:
- Encapsula el `GPURenderPipeline` (WebGPU) o el `WebGLProgram` (WebGL 2).
- Contiene el `layout` del pipeline requerido para generar *BindGroups* con coincidencia de firmas garantizada.

---

### 2.2. Implementación Nativa: `WebGPURHI`

Implementa el ciclo de vida moderno de GPU basado en comandos:
1. **Configuración de Contexto:** Obtiene el `GPUCanvasContext` mediante `canvas.getContext('webgpu')` y negocia el formato preferido (`navigator.gpu.getPreferredCanvasFormat()`).
2. **Caché de Pipelines (`pipelineCache`):** Almacena pipelines compilados indexados por identificador hash. La compilación de sombreadores WGSL y layouts de vértices se realiza una única vez; las llamadas posteriores reutilizan el pipeline desde memoria en tiempo constante $O(1)$.
3. **Caché de Grupos de Enlace (`bindGroupCache`):** Asocia combinaciones de texturas y buffers uniformes a `GPUBindGroup` estáticos, evitando la validación por fotograma.
4. **Escritura Eficiente:** Utiliza `GPUQueue.writeBuffer()` y `GPUQueue.writeTexture()` para transferir datos directamente desde TypedArrays contiguos sin bloquear el hilo principal.

---

### 2.3. Implementación de Respaldo: `WebGL2RHI`

Mapea la semántica de WebGPU a llamadas WebGL 2.0 sin alterar la API:
- Emula la inmutabilidad de texturas mediante `gl.texStorage2D()` y `gl.texStorage3D()`.
- Soporta indexación de instancias mediante `gl.drawElementsInstanced()`.
- Unifica las operaciones de borrado y vinculación de buffers mediante abstracciones análogas (`setVertexBuffer`, `setIndexBuffer`).

---

### 2.4. Coordinador Unificado: `RHI`

Provee la interfaz con la que interactúan `@tacarigua/core` y los sistemas de escenas:
- **`initialize()`**: Negocia la GPU física en orden de prioridad: `WEBGPU` $\to$ `WEBGL2` $\to$ `HEADLESS`.
- **`globalUniformBuffer`**: Búfer uniforme (UBO) central de 128 bytes (32 floats) que empaqueta:
  - Matriz de proyección ortográfica de 16 valores (`mat4x4<f32>`).
  - Resolución del lienzo (`vec2<f32>`).
  - Scroll de cámara (`vec2<f32>`).
  - Zoom de cámara (`f32`).
  - Tiempo acumulado del motor (`f32`).
- **`updateGlobalUniforms()`**: Escribe el bloque de datos directamente a la GPU en un único despacho mediante `writeBuffer`.

---

## 3. Flujo de Datos y Pipeline de Comandos

El paso de datos desde la definición de la escena hasta la presentación física en pantalla sigue un flujo estricto y unidireccional:

```
                      [ Escena / SpriteBatcher / ParticleSystem ]
                                           │
                        Prepara Vértices, Índices y Texturas
                                           │
                                           ▼
                                 RHI.beginRender(color)
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     ▼                                           ▼
              (Driver WebGPU)                             (Driver WebGL 2)
       Inicia GPUCommandEncoder                  Limpia gl.clearColor / gl.clear
       Inicia GPURenderPassEncoder               Activa gl.useProgram
                     │                                           │
                     └─────────────────────┬─────────────────────┘
                                           ▼
                              RHI.updateGlobalUniforms(...)
                              (Actualiza UBO de Cámara)
                                           │
                                           ▼
                         Driver.setPipeline(rhiPipeline)
                         Driver.setVertexBuffer(0, vBuffer)
                         Driver.setIndexBuffer(iBuffer)
                         Driver.setBindGroup(0, bindGroup)
                                           │
                                           ▼
                          Driver.drawIndexed(indexCount)
                                           │
                                           ▼
                                  RHI.endRender()
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     ▼                                           ▼
       Termina GPURenderPassEncoder               Flush completado
       queue.submit([commandBuffer])
                     │                                           │
                     └─────────────────────┬─────────────────────┘
                                           ▼
                             [ Presentación en Pantalla ]
```

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Aspecto | Phaser 4.2.1 (WebGL 1/2) | Tacarigua 1.0.0 (RHI WebGPU / WebGL 2) | Impacto Técnico |
| :--- | :--- | :--- | :--- |
| **Arquitectura de Render** | Máquina de estados mutables global (`gl.*`) | Descriptores inmutables y codificadores de comandos (`GPUCommandEncoder`) | Elimina cambios de estado redundantes en la CPU. |
| **Lenguaje de Sombreadores** | GLSL ES 1.00 / 3.00 con dependencias de macros | **WGSL** nativo en WebGPU con fallback compilado a GLSL 3.0 | Validación estricta en compilación; previene fallos de enlace en runtime. |
| **Paso de Parámetros Globales** | `gl.uniformMatrix4fv` llamada individualmente | **Uniform Buffer Object (UBO)** de bloque único | 1 sola transferencia de memoria para todo el frame en lugar de múltiples llamadas uniform. |
| **Asignaciones de Memoria en Cuadro** | Reconstrucción constante de objetos de pasada de render | Descriptores prealocados reutilizables (`_renderPassDescriptor`) | Cero generación de basura (*Zero-GC*) en el render loop. |
| **Validación de Pipeline** | En cada draw call (`gl.drawArrays`/`gl.drawElements`) | Al crear el pipeline (`createRenderPipeline`) | Las llamadas de dibujo son directas a registros de hardware sin validación de estado en CPU. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Inicialización Autónoma de la RHI y Configuración de Cuadro

Este ejemplo ilustra cómo inicializar la RHI directamente y despachar una pasada básica de borrado y actualización de variables globales:

```javascript
import { Game } from '@tacarigua/core.js';
import { RHI, RHI_BUFFER_USAGE } from '@tacarigua/renderer-webgpu';

// 1. Instanciar el núcleo del motor
const game = new Game({
    width: 1920,
    height: 1080,
    render: { preferWebGPU: true }
});

// 2. Crear y conectar el orquestador RHI
const rhi = new RHI(game);
await rhi.initialize();

console.log(`[RHI] Driver activo: ${rhi.activeBackend === 4 ? 'WebGPU' : 'WebGL2'}`);

// 3. Simulación de un paso de renderizado
function renderFrame(time) {
    // Actualizar proyección y cámara: Ancho, Alto, ScrollX, ScrollY, Zoom, Tiempo
    rhi.updateGlobalUniforms(1920, 1080, 0, 0, 1.0, time * 0.001);

    // Iniciar pasada con color de limpieza azul oscuro (RGBA en formato 0xRRGGBBAA)
    rhi.beginRender(0x0a1128ff);

    // Aquí se vincularían los pipelines y búferes a través del driver
    // rhi.driver.setPipeline(...);
    // rhi.driver.drawIndexed(...);

    // Finalizar pasada y despachar a la GPU
    rhi.endRender();
}

requestAnimationFrame(renderFrame);
```

---

### Ejemplo 2: Creación de un Búfer de Vértices y Dibujo Indexado sobre la RHI

Cómo crear recursos geométricos compatibles con la RHI para renderizar geometrías arbitrarias:

```javascript
import { 
    RHI_BUFFER_USAGE, 
    RHI_PRIMITIVE_TOPOLOGY,
    WGSL_BATCH_SHADER 
} from '@tacarigua/renderer-webgpu';

// Asumiendo 'rhi' inicializado previamente...
const driver = rhi.driver;

// 1. Geometría: Triángulo plano 2D (Posición X, Y + UV + TextureIndex + Color empaquetado)
// Formato: [X, Y,  U, V,  TexIdx,  Color(Uint32)]
const vertexData = new ArrayBuffer(3 * 24); // 3 vértices * 24 bytes
const f32 = new Float32Array(vertexData);
const u32 = new Uint32Array(vertexData);

// Vértice 0
f32[0] = 0.0;   f32[1] = 0.5;   // Posición
f32[2] = 0.5;   f32[3] = 0.0;   // UV
f32[4] = 0.0;                   // Texture Index
u32[5] = 0xffffffff;            // Blanco opaco

// Vértice 1
f32[6] = -0.5;  f32[7] = -0.5;
f32[8] = 0.0;   f32[9] = 1.0;
f32[10] = 0.0;
u32[11] = 0xffffffff;

// Vértice 2
f32[12] = 0.5;  f32[13] = -0.5;
f32[14] = 1.0;  f32[15] = 1.0;
f32[16] = 0.0;
u32[17] = 0xffffffff;

// 2. Crear buffers en GPU
const vertexBuffer = driver.createBuffer(
    'Triangle_VertexBuffer',
    vertexData.byteLength,
    RHI_BUFFER_USAGE.VERTEX | RHI_BUFFER_USAGE.COPY_DST
);
driver.writeBuffer(vertexBuffer, vertexData);

const indices = new Uint16Array([0, 1, 2]);
const indexBuffer = driver.createBuffer(
    'Triangle_IndexBuffer',
    indices.byteLength,
    RHI_BUFFER_USAGE.INDEX | RHI_BUFFER_USAGE.COPY_DST
);
driver.writeBuffer(indexBuffer, indices);

// 3. Crear pipeline con su layout
const vertexLayout = [{
    stride: 24,
    stepMode: 'vertex',
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32' },
        { shaderLocation: 3, offset: 20, format: 'unorm8x4' }
    ]
}];

const pipeline = driver.getOrCreateRenderPipeline(
    'SimpleTrianglePipeline',
    WGSL_BATCH_SHADER,
    vertexLayout,
    RHI_PRIMITIVE_TOPOLOGY.TRIANGLE_LIST
);

// 4. Ejecución en el bucle de render
rhi.beginRender(0x000000ff);
driver.setPipeline(pipeline);
driver.setVertexBuffer(0, vertexBuffer);
driver.setIndexBuffer(indexBuffer, 'uint16');
driver.drawIndexed(3, 1, 0, 0, 0);
rhi.endRender();
```

---

## 6. Guía de Migración: de Phaser v4.2.1 a Tacarigua v1.0.0 (Render Pipeline)

Para modernizar pipelines personalizados o llamadas directas de renderizado a la arquitectura de Tacarigua 1.0.0, aplique las siguientes transformaciones sistemáticas:

### Paso 1: Eliminar Acceso Directo a `this.renderer.gl`
- **Antes (Phaser v4.2.1):**
  ```javascript
  const gl = this.renderer.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Operar a través de la interfaz RHI desacoplada
  const driver = this.renderer.rhi.driver;
  driver.writeBuffer(this.rhiBuffer, this.data);
  driver.setVertexBuffer(0, this.rhiBuffer);
  driver.drawIndexed(6, 1, 0, 0, 0);
  ```

### Paso 2: Migración de Sombreadores de GLSL a WGSL
Los pipelines personalizados deben declarar sus sombreadores en sintaxis **WGSL**.
- Los bloques uniformes (`uniform mat4 uProjectionMatrix`) ahora se agrupan en un `struct` vinculado en el `@group(0) @binding(0)`:
  ```rust
  // Declaración moderna WGSL
  struct Uniforms {
      projectionMatrix: mat4x4<f32>,
      resolution: vec2<f32>,
  };
  @group(0) @binding(0) var<uniform> uGlobal: Uniforms;
  ```
- Los atributos de vértices se reciben como una estructura con decoradores `@location(n)`.
- El punto de entrada del fragmento debe retornar `@location(0) vec4<f32>`.

### Paso 3: Sustitución de `PipelineManager.set()` por `driver.setPipeline()`
- **Antes (Phaser v4.2.1):**
  ```javascript
  this.renderer.pipelines.set(this.pipeline, this.gameObject);
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Los pipelines son inmutables y se recuperan mediante identificador unívoco
  const pipeline = driver.getOrCreateRenderPipeline(
      'MiPipelineID', 
      codigoWGSL, 
      layoutVertices
  );
  driver.setPipeline(pipeline);
  ```

### Paso 4: Ajuste de Profundidad de Recorte Ortho
En WebGPU, el valor del plano cercano de recorte (*near plane*) en la matriz ortográfica se proyecta en $0$, no en $-1$. Si calcula proyecciones matemáticas manuales, asegúrese de adaptar la matriz utilizando `rhi.updateGlobalUniforms()` o la clase utilitaria `Matrix4.ortho()`, la cual detecta automáticamente el backend activo para normalizar el volumen canónico de visión.