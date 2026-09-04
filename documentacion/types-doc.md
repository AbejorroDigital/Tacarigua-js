# Documentación Técnica de Arquitectura: Módulo de Tipos y Contratos (`@tacarigua/types`)

## 1. Visión General y Filosofía de Diseño

En **Tacarigua 1.0.0**, el módulo `@tacarigua/types` deja de ser un subproducto pasivo generado mediante scripts de extracción sobre anotaciones JSDoc heterogéneas (enfoque utilizado hasta la versión 4.2.1). En su lugar, se erige como la **columna vertebral normativa y contractual del motor**, definiendo las interfaces binarias, los límites de subsistemas desacoplados y las estructuras de memoria orientadas a datos (**Data-Oriented Design - DOD**).

```
                      +-----------------------------+
                      |     @tacarigua/types           |
                      | (Definiciones y Contratos)   |
                      +--------------+--------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+------------------+       +-------------------+       +-------------------+
|  @tacarigua/core    |       | @tacarigua/ecs       |       | @tacarigua/renderer  |
|  - GameConfig    |       | - EntityId        |       | - IRHIDriver      |
|  - Signals/Events|       | - IComponentStore |       | - IRHIBuffer      |
|  - TimeStep      |       | - Query / System  |       | - IRHIPipeline    |
+------------------+       +-------------------+       +-------------------+
         |                           |                           |
         +---------------------------+---------------------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+------------------+       +-------------------+       +-------------------+
| @tacarigua/physics  |       | @tacarigua/sound     |       | @tacarigua/net       |
| - PhysicsBridge  |       | - ISpatialSound   |       | - IBinaryPacket   |
| - Shared Memory  |       | - AudioWorklet    |       | - INetworkClient  |
+------------------+       +-------------------+       +-------------------+
```

### Objetivos Fundamentales
1. **Verificación Estricta en Tiempo de Compilación (`strict: true`):** Erradicación total de tipos `any` implícitos y firmas de retorno ambiguas.
2. **Tipado Nominal Mediante *Branded Types*:** Protección estricta contra errores de paso de argumentos entre identificadores escalares primitivos (como entidades ECS vs. ranuras de texturas).
3. **Parametrización Genérica Exhaustiva:** Tipado contextual para identificadores de recursos (texturas, sonidos, escenas) que permite la autocompleción de claves en el IDE y evita fallos en tiempo de ejecución por nombres erróneos (*typos*).
4. **Contratos Inmutables para la Capa RHI y Memoria Contigua:** Definición formal de buffers, layouts de vértices, descriptores de pasadas de render y esquemas de memoria para WebGPU, WebGL 2 y Web Workers.

---

## 2. Desglose de Contratos e Interfaces Principales

### 2.1. Tipos Marcados (*Branded Types*) y Primitivas de Memoria

Uno de los mayores riesgos en un motor orientado a datos con rendimiento crítico es el uso indistinto del tipo primitivo `number`. En JavaScript y TypeScript estándar, cualquier entero puede pasarse donde se espera un índice de entidad o un puntero de textura. Tacarigua 1.0.0 introduce marcas de tipo nominales (*type branding*):

```typescript
export type EntityId = number & { readonly __brand: unique symbol };
export type TextureSlotId = number & { readonly __slotBrand: unique symbol };
```

* **`EntityId`:** Representa un entero de 32 bits compuesto por `(generacion << 20) | indice`. El compilador impide pasar un número arbitrario a funciones como `world.destroyEntity(id)` o `world.addComponent(id, ...)` a menos que haya sido generado formalmente por `world.createEntity()`.
* **`TextureSlotId`:** Garantiza que los identificadores de capas de textura dentro del array de GPU (`texture_2d_array`) no se confundan con coordenadas o identificadores de contexto.
* **`ComponentScalarType` y `ComponentSchema`:** Define los tipos de datos primitivos permitidos dentro de la arquitectura SoA (*Structure of Arrays*):

```typescript
export type ComponentScalarType = 
    | 'f32' | 'f64' 
    | 'i32' | 'i16' | 'i8' 
    | 'u32' | 'u16' | 'u8';

export type ComponentSchema = Record<string, ComponentScalarType>;
```

### 2.2. Núcleo, Configuración y Reactividad (`@tacarigua/core`)

#### Tipos Genéricos del Orquestador (`GameConfig<TTextureKeys, TAudioKeys, TSceneKeys>`)
La clase `Game` y su interfaz de configuración parametrizan las claves de recursos para garantizar consistencia entre la fase de precarga y su utilización:

```typescript
export interface GameConfig<
    TTextureKeys extends string = string,
    TAudioKeys extends string = string,
    TSceneKeys extends string = string
> {
    width?: number | string;
    height?: number | string;
    type?: RenderType;
    render?: RenderConfig;
    fps?: FPSConfig;
    scene?: SceneConstructor<TSceneKeys>[] | object[] | null;
    // ...resto de opciones
}
```

#### Reactividad: Señales vs. Bus de Eventos
Se establecen contratos diferenciados para optimizar el rendimiento según el caso de uso:
* **`ISignal<TArgs>`:** Comunicación desacoplada de alto rendimiento. Opera mediante una lista doblemente enlazada, prescindiendo por completo de la asignación de strings por cada emisión. Ideal para ciclos de actualización frecuentes.
* **`IEventEmitter<TEventMap>`:** Emisor para eventos genéricos del ciclo de vida del motor mediante un diccionario estricto (`TEventMap`).

```typescript
export interface ISignal<TArgs extends any[] = []> {
    readonly hasListeners: boolean;
    add(fn: (...args: TArgs) => void, context?: any): ISignalBinding;
    addOnce(fn: (...args: TArgs) => void, context?: any): ISignalBinding;
    detach(binding: ISignalBinding): boolean;
    dispatch(...args: TArgs): void;
    clear(): void;
}
```

---

### 2.3. Capa RHI (Render Hardware Interface)

El renderizador ya no depende del estado imperativo monolítico de WebGL 1. Los contratos de la RHI abstraen el hardware físico, soportando arquitecturas modernas como **WebGPU** y **WebGL 2**:

| Interfaz | Función Arquitectónica | Detalle Técnico |
| :--- | :--- | :--- |
| `IRHIBuffer` | Representación abstracta de búfer en memoria de video. | Envuelve `GPUBuffer` o `WebGLBuffer`. Almacena tamaño (`size`) y flags inmutables de uso (`usage`). |
| `IRHITexture` | Abstracción de textura y vistas de render. | Maneja texturas 2D individuales o arreglos multidimensionales (`depth > 1`) para `texture_2d_array`. |
| `IRHIPipeline` | Encapsulación de sombreadores y estados de mezcla. | Enlaza la disposición de atributos de vértices y el layout de los recursos uniformes (*Bind Groups*). |
| `IRHIDriver` | Interfaz de bajo nivel para controladores gráficos. | Define el protocolo para `beginFrame`, `drawIndexed`, `writeBuffer`, etc., unificando WebGPU y WebGL 2. |

```typescript
export interface IRHIDriver {
    readonly initialized: boolean;
    init(): Promise<boolean> | boolean;
    resize(width: number, height: number): void;
    createBuffer(name: string, size: number, usageFlags: number): IRHIBuffer;
    writeBuffer(buffer: IRHIBuffer, data: BufferSource, offset?: number): void;
    createTexture(key: string, width: number, height: number, depth?: number, format?: RHITextureFormat): IRHITexture;
    updateTexture(texture: IRHITexture, source: ImageBitmap | HTMLCanvasElement | Uint8Array, layerIndex?: number): void;
    beginFrame(r: number, g: number, b: number, a: number): void;
    setPipeline(pipeline: IRHIPipeline): void;
    setVertexBuffer(slot: number, buffer: IRHIBuffer, offset?: number): void;
    setIndexBuffer(buffer: IRHIBuffer, format?: string, offset?: number): void;
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
    endFrame(): void;
    destroy(): void;
}
```

---

### 2.4. Subsistema ECS (Entity Component System)

Define los contratos para la arquitectura basada en datos:

* **`IComponentStore<TSchema>`:** Almacén columnar contiguo. La propiedad `columns` mapea cada campo del esquema directamente a una vista tipada (`Float32Array`, `Uint32Array`, etc.), garantizando localidad espacial en caché de CPU.
* **`IQuery`:** Máscara de evaluación rápida respaldada por arreglos densos de `EntityId`. Expone `match(entity, entityMask)` y `removeEntity(entity)`.
* **`System`:** Abstracción para los bucles lógicos que iteran linealmente sobre las columnas de datos.

```typescript
export interface IComponentStore<TSchema extends ComponentSchema = ComponentSchema> {
    readonly id: number;
    readonly name: string;
    readonly schema: TSchema;
    readonly capacity: number;
    readonly columns: { [K in keyof TSchema]: ArrayLike<number> };
    set(entityIndex: number, values: Partial<{ [K in keyof TSchema]: number }>): void;
    reset(entityIndex: number): void;
    ensureCapacity(entityIndex: number): void;
}
```

---

### 2.5. Módulos Concurrentes y Multimedia

#### Físicas Off-Thread (`@tacarigua/physics-worker`)
El contrato `IPhysicsWorkerBridge` define la interacción entre el hilo principal y el Web Worker. No transfiere instancias completas de objetos, sino buffers y desplazamientos en memoria contigua:

```typescript
export interface IPhysicsWorkerBridge {
    readonly hasSharedMemory: boolean;
    readonly activeBodiesCount: number;
    createBody(x: number, y: number, width: number, height: number, options?: BodyCreationOptions, bindTarget?: any): number;
    setVelocity(bodyIndex: number, vx: number, vy: number): void;
    setPosition(bodyIndex: number, x: number, y: number): void;
    update(delta: number): void;
    destroy(): void;
}
```

#### Networking con Cero Asignaciones (`@tacarigua/net`)
`IBinaryPacket` reemplaza los serializadores basados en JSON o strings. Opera directamente sobre `ArrayBuffer` y `DataView`, reduciendo a cero la presión sobre el recolector de basura (*Garbage Collector*).

```typescript
export interface IBinaryPacket {
    readonly buffer: ArrayBuffer;
    cursor: number;
    reset(): this;
    writeUint8(val: number): this;
    writeFloat32(val: number): this;
    readUint8(): number;
    readFloat32(): number;
    getPayload(): Uint8Array;
}
```

---

## 3. Comparativa Técnica: Phaser 4.2.1 frente a Tacarigua 1.0.0

| Característica | Phaser 4.2.1 | Tacarigua 1.0.0 (`@tacarigua/types`) | Impacto Arquitectónico |
| :--- | :--- | :--- | :--- |
| **Generación de Tipos** | Extraída automáticamente de JSDoc en el repositorio mono-fuente. | Escrita de forma nativa en contratos TypeScript estrictos (`.d.ts` directos). | Elimina tipos `any` inesperados y desincronizaciones entre la documentación y la API real. |
| **Identificadores de Entidad** | Instancias pesadas en Heap (`GameObject`, `Sprite`) con cientos de propiedades. | `EntityId` (tipo marcado nominal `number & { __brand }`). | Reducción de uso de memoria de cientos de bytes por objeto a un escalar de 32 bits. Cero GC. |
| **Claves de Recursos** | `string` genérico sin validación estática (`textures.get('player')`). | Tipado genérico parametrizado (`Game<TTextures, TAudios, TScenes>`). | Los fallos tipográficos en claves de recursos y nombres de escenas se detectan en tiempo de compilación. |
| **Arquitectura Gráfica** | Monolítica, acoplada al contexto `WebGLRenderingContext` de WebGL 1. | Capa desacoplada `IRHIDriver` compatible con WebGPU y WebGL 2. | Permite intercambiar el motor de renderizado en caliente sin modificar el código de escenas. |
| **Suscripción a Eventos** | `EventEmitter3` estándar basado en cadenas de texto no tipadas. | Implementación dual: `Signal` (lista enlazada para alta frecuencia) e `IEventEmitter` estricto. | Elimina micro-congelamientos por recolección de basura generados al registrar o emitir eventos en el bucle principal. |

---

## 4. Guía de Migración y Cambios de Ruptura (Breaking Changes)

### 4.1. Migración de Claves de Configuración y Tipado Genérico

En versiones anteriores, las escenas y assets utilizaban cadenas de texto libres, lo que permitía errores silenciosos durante la ejecución si se pasaba un identificador inválido.

#### Código en Phaser 4.2.1:
```javascript
// Phaser 4.2.1: Sin validación de cadenas en compilación
const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    scene: [BootScene, GameScene]
};

const game = new Phaser.Game(config);

// Ningún error estático si se comete un error tipográfico:
scene.scene.start('GmeScne'); 
```

#### Migración a Tacarigua 1.0.0:
```javascript
import { Game, RenderType } from '@tacarigua/core.js';

// 1. Declaración de uniones literales para recursos y escenas
/**
 * @typedef {'boot' | 'game' | 'game_over'} SceneKeys
 * @typedef {'atlas_main' | 'particles' | 'tileset'} TextureKeys
 * @typedef {'bgm_level1' | 'sfx_laser'} AudioKeys
 */

/** @type {import('@tacarigua/types').Phaser.GameConfig<TextureKeys, AudioKeys, SceneKeys>} */
const config = {
    type: RenderType.AUTO,
    width: 1920,
    height: 1080,
    render: {
        preferWebGPU: true,
        antialias: true
    },
    fps: {
        targetFps: 120,
        smoothStep: true
    }
};

const game = new Game(config);
```

---

### 4.2. Migración del Modelo Orientado a Objetos (OOP) a Contratos ECS

#### Código en Phaser 4.2.1:
```javascript
// Phaser 4.2.1: Objetos pesados asignados en el Heap
const bullets = [];
for (let i = 0; i < 5000; i++) {
    const sprite = this.add.sprite(x, y, 'bullet');
    this.physics.world.enable(sprite);
    sprite.body.setVelocity(100, 200);
    bullets.push(sprite);
}
```

#### Migración a Tacarigua 1.0.0:
```javascript
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

const world = new ECSWorld(10000);
const movementSystem = new MovementSystem(world);
world.addSystem(movementSystem);

// Creación masiva usando tipos escalares en búferes planos contiguos
for (let i = 0; i < 5000; i++) {
    // Retorna un EntityId marcado; no puede asignarse a un number arbitrario
    const entity = world.createEntity();

    world.addComponent(entity, world.Transform, {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1
    });

    world.addComponent(entity, world.Velocity, {
        vx: 100,
        vy: 200
    });
}
```

---

## 5. Ejemplos Prácticos de Implementación

### Ejemplo 1: Integración con la Capa RHI y Envío de Comandos a GPU

Demuestra el consumo del contrato `IRHIDriver` para inicializar un buffer y despachar geometría con la abstracción universal:

```javascript
import { RENDER_TYPE } from '@tacarigua/core.js';
import { RHI, RHI_BUFFER_USAGE, RHI_PRIMITIVE_TOPOLOGY } from '@tacarigua/renderer-webgpu';

/**
 * Renderizador de prueba que opera directamente sobre contratos RHI.
 * @param {import('@tacarigua/types').Phaser.IRHIDriver} driver 
 */
export function renderDirectTriangle(driver) {
    // 1. Datos entrelazados: Posición (X, Y) y Color (R, G, B, A) normalizado
    const vertexData = new Float32Array([
         0.0,  0.5,   1.0, 0.0, 0.0, 1.0,
        -0.5, -0.5,   0.0, 1.0, 0.0, 1.0,
         0.5, -0.5,   0.0, 0.0, 1.0, 1.0
    ]);

    // 2. Creación de búfer conforme al contrato IRHIBuffer
    const vertexBuffer = driver.createBuffer(
        'TriangleVertexBuffer',
        vertexData.byteLength,
        RHI_BUFFER_USAGE.VERTEX | RHI_BUFFER_USAGE.COPY_DST
    );

    // 3. Escritura directa en memoria de GPU sin asignación intermedia
    driver.writeBuffer(vertexBuffer, vertexData);

    // 4. Índices de primitivas
    const indexData = new Uint16Array([0, 1, 2]);
    const indexBuffer = driver.createBuffer(
        'TriangleIndexBuffer',
        indexData.byteLength,
        RHI_BUFFER_USAGE.INDEX | RHI_BUFFER_USAGE.COPY_DST
    );
    driver.writeBuffer(indexBuffer, indexData);

    // 5. Ejecución en la pasada de dibujo
    driver.beginFrame(0.05, 0.05, 0.08, 1.0);
    driver.setVertexBuffer(0, vertexBuffer);
    driver.setIndexBuffer(indexBuffer, 'uint16');
    driver.drawIndexed(3, 1, 0, 0, 0);
    driver.endFrame();
}
```

---

### Ejemplo 2: Creación de Componentes Personalizados con Esquemas Estrictos

Implementación de un componente personalizado y su posterior consulta vectorizada mediante las interfaces del subsistema ECS:

```javascript
import { ECSWorld, System, TYPE } from '@tacarigua/ecs';

/**
 * Esquema de datos para atributos de combate
 */
const CombatStatsSchema = {
    health: TYPE.FLOAT32,
    maxHealth: TYPE.FLOAT32,
    shield: TYPE.FLOAT32,
    isInvulnerable: TYPE.UINT8
};

const world = new ECSWorld(2048);

// Registro tipado del componente
const CombatStats = world.registerComponent('CombatStats', CombatStatsSchema);

// Sistema de regeneración de escudos sin asignación de memoria
class ShieldRegenSystem extends System {
    init() {
        // Consulta filtrada por entidades que posean CombatStats
        this.query = this.world.createQuery([CombatStats]);
    }

    /**
     * @param {number} time
     * @param {number} delta
     */
    update(time, delta) {
        const dt = delta * 0.001;
        const entities = this.query.entities;
        const count = entities.length;

        // Acceso directo a las columnas continuas de memoria (SoA)
        const shieldCol = CombatStats.columns.shield;
        const maxHealthCol = CombatStats.columns.maxHealth;

        for (let i = 0; i < count; i++) {
            const idx = entities[i] & 0xfffff; // Desempaquetado del índice

            if (shieldCol[idx] < maxHealthCol[idx]) {
                shieldCol[idx] = Math.min(maxHealthCol[idx], shieldCol[idx] + 5.0 * dt);
            }
        }
    }
}

world.addSystem(new ShieldRegenSystem(world));
```

---

## 6. Optimizaciones de Rendimiento Impulsadas por el Sistema de Tipos

El diseño de `@tacarigua/types` no se limita a aportar ayudas de autocompletado en el editor; introduce ventajas estructurales que impactan de forma medible en el rendimiento del motor JavaScript y en la GPU:

```
[Phaser 4.2.1: Enfoque Dinámico e Inestable]
GameObject (Heap) -> Propiedades heterogéneas dinámicas -> Megamorfismo en V8 -> GC Jank

[Tacarigua 1.0.0: Contratos de Tipos Planos]
EntityId (Escalar 32-bit) -> ComponentStore.columns (TypedArrays) -> Llamadas Monomórficas Estables -> Cero GC
```

1. **Garantía de Llamadas Monomórficas en V8 / SpiderMonkey:**
   Al mantener interfaces estrictas y formas de objetos idénticas (`Hidden Classes` / `Shapes` estables), el motor JIT puede aplicar *inline caching* y desvirtualizar métodos, evitando transiciones al estado megamórfico.
2. **Erradicación del *Boxing/Unboxing* de Primitivas:**
   Al tratar las entidades como tipos numéricos puros a nivel de runtime (`EntityId`), el motor evita crear envoltorios de objetos en el Heap, permitiendo que los identificadores residan directamente en registros de CPU.
3. **Localidad Espacial y Alineación de Memoria para GPU:**
   Los contratos de la RHI exigen alineaciones de 4 bytes en los buffers de vértices e índices, reflejando de forma precisa las restricciones impuestas por la especificación oficial de WebGPU y evitando desalineaciones que requieran reempaquetado en CPU.