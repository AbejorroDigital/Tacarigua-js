# Documentación Técnica: Arquitectura Híbrida y Sistema ECS Nativo (`@tacarigua/ecs`) — Tacarigua.js v1.0.0

---

## 1. Introducción y Fundamentos Arquitectónicos

El módulo `@tacarigua/ecs` introduce en **Tacarigua 1.0.0** un motor de **Sistema Entidad-Componente (Entity Component System - ECS)** nativo de alto rendimiento, diseñado bajo los principios del **Diseño Orientado a Datos (Data-Oriented Design - DOD)**.

### 1.1. El Problema Histórico en Phaser 4.2.1 (AoS y Jerarquía OOP)
En versiones anteriores, las entidades del juego dependían de una herencia profunda (`EventEmitter` $\to$ `GameObject` $\to$ `Sprite` $\to$ `Arcade.Sprite`). Este enfoque clásico orientado a objetos (*Object-Oriented Programming - OOP*):
- Almacenaba los datos como un **Arreglo de Objetos (Array of Structures - AoS)** dispersos en la memoria *heap*.
- Provocaba una degradación masiva de rendimiento por **fallos de caché de CPU (L1/L2 Cache Misses)**: al iterar 10.000 proyectiles para moverlos, el procesador cargaba objetos de cientos de bytes en cada línea de caché solo para modificar dos propiedades (`x` e `y`).
- Generaba sobrecarga en el recolector de basura (*GC*) al instanciar y destruir objetos de clases complejas.

### 1.2. La Solución en Tacarigua 1.0.0 (SoA y Arquitectura Híbrida)
`@tacarigua/ecs` reorganiza la memoria bajo una **Estructura de Arreglos (Structure of Arrays - SoA)**:
- **Entidades como Números Primitivos:** Una entidad no es un objeto, sino un identificador entero empaquetado de 32 bits.
- **Memoria Columnar Contigua:** Las propiedades de los componentes se almacenan en búferes planos contiguos (`Float32Array`, `Int32Array`, `Uint8Array`). La CPU lee los datos secuencialmente aprovechando la prebúsqueda de hardware (*Hardware Prefetching*).
- **Modelo Híbrido:** Permite que sistemas de simulación masiva (partículas, proyectiles, multitudes) corran sobre el núcleo ECS puro a más de 120 FPS, mientras que la lógica de juego tradicional puede utilizar el adaptador `GameObjectECSAdapter` para conservar la ergonomía de la API clásica (`sprite.x += 10`).

---

## 2. Estructura Interna del Módulo

El subsistema se compone de cinco piezas fundamentales:

```
@tacarigua/ecs
├── BitSet                 -> Máscaras de bits dinámicas para firmas de componentes
├── ComponentStore         -> Almacén columnar contiguo (Structure of Arrays)
├── Query                  -> Filtrado reactivo de entidades con remoción O(1) (Swap & Pop)
├── System                 -> Interfaz base de ejecución de lógica de simulación
├── ECSWorld               -> Coordinador global de entidades, generación y memoria
├── Built-in Systems          -> MovementSystem, SpriteBatchSyncSystem
└── GameObjectECSAdapter   -> Capa de compatibilidad bidireccional (OOP <-> ECS)
```

### 2.1. Máscaras de Bits Dinámicas (`BitSet`)
Cada tipo de componente registrado en el mundo recibe un identificador secuencial entero único (`id`). La pertenencia de componentes a una entidad se modela mediante un `BitSet`:
- Utiliza un arreglo de palabras `Uint32Array`. Cada palabra gestiona 32 tipos de componentes.
- La evaluación de firmas requeridas (`containsAll`) y componentes excluyentes (`intersects`) se realiza mediante operaciones a nivel de bits (`AND`, `NOT`, `OR` binarios), permitiendo a las consultas validar entidades en tiempo constante $\mathcal{O}(1)$.

---

### 2.2. Almacén Columnar Contiguo: `ComponentStore`
En lugar de almacenar objetos de componentes, el `ComponentStore` actúa como una tabla de base de datos columnar en memoria.

Si definimos el componente `Transform`:
```javascript
const Transform = world.registerComponent('Transform', {
    x: TYPE.FLOAT32,
    y: TYPE.FLOAT32,
    rotation: TYPE.FLOAT32
});
```
La memoria física se reserva de la siguiente manera:
```
Índice de Entidad:     0       1       2       3       ...   N
Transform.columns.x  [ 12.0 ][ 45.5 ][ 0.0  ][ 120.3 ][ ... ] (Float32Array contiguo)
Transform.columns.y  [ 30.0 ][ 10.2 ][ 8.0  ][ 65.4  ][ ... ] (Float32Array contiguo)
Transform.columns.rot[ 0.0  ][ 1.57 ][ 3.14 ][ 0.78  ][ ... ] (Float32Array contiguo)
```
Cuando el número de entidades excede la capacidad inicial (`initialCapacity`), el almacén ejecuta una **duplicación geométrica de capacidad** (`_allocateStorage`), reasignando búferes tipados y preservando la contigüidad física en la memoria RAM.

---

### 2.3. Identificadores Generacionales de Entidades (`EntityId`)
Para evitar el peligro de las **referencias colgantes (*dangling references*)** sin necesidad de limpiar manualmente punteros en todo el juego, las entidades emplean un esquema de **Índice Generacional de 32 bits**:

$$\text{EntityId} = (\text{Generación} \ll 20) \mid \text{Índice}$$

```
 31                  20 19                                0
┌──────────────────────┬───────────────────────────────────┐
│ Generación (12 bits) │       Índice en Memoria (20 bits) │
│   (0 a 4.095 ciclos) │      (Hasta 1.048.576 entidades)  │
└──────────────────────┴───────────────────────────────────┘
```
1. **Creación:** Se extrae un índice reutilizable de la pila `freeList`. Su identificador se compone combinando la generación actual del slot y su posición de memoria.
2. **Validación:** El método `world.isAlive(entity)` comprueba en $\mathcal{O}(1)$ si `generations[entity & 0xfffff] === (entity >>> 20)`.
3. **Destrucción:** Al destruir la entidad, se incrementa el contador generacional en `generations[index]`. Cualquier sistema, script o callback que guarde una referencia antigua al `EntityId` fallará de inmediato en validación, erradicando lecturas o escrituras sobre datos reciclados.

---

### 2.4. Consultas Reactivas: `Query`
Las consultas mantienen una lista empaquetada y contigua de entidades coincidentes (`this.entities`).
- **Indexación Bidireccional:** El mapa interno `_indexMap` guarda la posición de cada entidad dentro del arreglo plano.
- **Remoción en $\mathcal{O}(1)$ (*Swap & Pop*):** Cuando una entidad pierde un componente o se destruye, no se desplaza el array con `splice()`. En su lugar, el último elemento del array se copia sobre la posición de la entidad a eliminar y el array se reduce con `pop()`, manteniendo la lista siempre densa y contigua sin coste computacional.

---

## 3. Disposición de Memoria de Componentes Nativos

El núcleo registra de fábrica tres componentes esenciales optimizados para el pipeline de renderizado:

| Componente | Propiedad | Tipo Escalar | Bytes | Propósito |
| :--- | :--- | :--- | :--- | :--- |
| **`Transform`** | `x`, `y` | `Float32` | 8 | Posición en el espacio 2D mundial. |
| | `rotation` | `Float32` | 4 | Rotación en radianes. |
| | `scaleX`, `scaleY` | `Float32` | 8 | Factores de escala vectorial. |
| | `originX`, `originY` | `Float32` | 8 | Punto de anclaje/pivote normalizado (0.0 a 1.0). |
| **`Velocity`** | `vx`, `vy` | `Float32` | 8 | Velocidad lineal en píxeles/segundo. |
| | `angularVelocity` | `Float32` | 4 | Velocidad de rotación en radianes/segundo. |
| **`Renderable`** | `width`, `height` | `Float32` | 8 | Dimensiones geométricas en pantalla. |
| | `u0`, `v0`, `u1`, `v1` | `Float32` | 16 | Coordenadas normalizadas de textura en el atlas. |
| | `tint` | `Uint32` | 4 | Color empaquetado (ABGR). |
| | `alpha` | `Float32` | 4 | Opacidad global (0.0 a 1.0). |
| | `textureSlot` | `Uint32` | 4 | Ranura asignada en el arreglo de texturas de GPU. |
| | `visible` | `Uint8` | 1 | Bandera booleana de visibilidad. |

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Aspecto | Phaser 4.2.1 (OOP Tradicional) | Tacarigua 1.0.0 (`@tacarigua/ecs`) | Impacto Arquitectónico |
| :--- | :--- | :--- | :--- |
| **Disposición de Memoria** | Arreglo de Estructuras (AoS). Objetos dispersos en Heap. | Estructura de Arreglos (SoA). Búferes contiguos `Float32Array`. | Eliminación de saltos de memoria (*cache misses*). Iteración óptima. |
| **Sobrecarga por Entidad** | $\approx 2.5 \text{ KB}$ a $8 \text{ KB}$ por GameObject en memoria. | **0 bytes** de overhead de objeto (ID numérico puro). | Permite escalar a **100.000+ entidades concurrentes**. |
| **Cálculo de Cinemática** | Llamadas virtuales por objeto (`sprite.preUpdate()`). | Bucle lineal vectorial plano en `MovementSystem`. | **~15x más rápido** en procesamiento de movimiento. |
| **Sincronización de Render** | Recorrido de árboles jerárquicos polimórficos. | Inyección directa a `SpriteBatcher` (`batchQuad`). | Cero asignación de matrices intermedias por frame. |
| **Identificadores** | Punteros a referencias de objetos en JavaScript. | Identificadores generacionales de 32 bits (`EntityId`). | Resuelve problemas de referencias colgantes y reduce el uso de memoria. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Creación de Componentes, Consultas y Sistemas Personalizados

Cómo crear un sistema de partículas de proyectiles (*bullets*) con deceleración y vida útil:

```javascript
import { ECSWorld, System, TYPE } from '@tacarigua/ecs';

// 1. Instanciar el mundo ECS
const world = new ECSWorld(10000);

// 2. Registrar componentes propios del juego
const Lifetime = world.registerComponent('Lifetime', {
    remaining: TYPE.FLOAT32,
    max: TYPE.FLOAT32
});

// 3. Crear el Sistema de Decaimiento de Proyectiles
class ProjectileDecaySystem extends System {
    init() {
        // Consultar entidades que tengan Transform y Lifetime
        this.query = this.world.createQuery([this.world.Transform, Lifetime]);
    }

    update(time, delta) {
        const dt = delta * 0.001;
        const entities = this.query.entities;
        const count = entities.length;

        const remainingCol = Lifetime.columns.remaining;
        const alphaCol = this.world.Renderable?.columns.alpha;

        for (let i = count - 1; i >= 0; i--) {
            const entity = entities[i];
            const idx = entity & 0xfffff;

            remainingCol[idx] -= dt;

            // Desvanecer alfa gradualmente si tiene componente Renderable
            if (alphaCol) {
                alphaCol[idx] = Math.max(0, remainingCol[idx] / Lifetime.columns.max[idx]);
            }

            // Destruir entidad cuando expira su vida útil
            if (remainingCol[idx] <= 0) {
                this.world.destroyEntity(entity);
            }
        }
    }
}

// 4. Registrar e iniciar el sistema en el mundo
world.addSystem(new ProjectileDecaySystem(world));

// 5. Instanciar una entidad proyectil
const bullet = world.createEntity();
world.addComponent(bullet, world.Transform, { x: 400, y: 300, scaleX: 1, scaleY: 1 });
world.addComponent(bullet, world.Velocity, { vx: 500, vy: -100 });
world.addComponent(bullet, Lifetime, { remaining: 2.0, max: 2.0 });
```

---

### Ejemplo 2: Simulación Masiva y Conexión Directa con `SpriteBatcher`

Integración entre `@tacarigua/ecs` y el loteador GPU de `@tacarigua/batch-renderer-2d`:

```javascript
import { ECSWorld, MovementSystem, SpriteBatchSyncSystem } from '@tacarigua/ecs';
import { SpriteBatcher } from '@tacarigua/batch-renderer-2d';

// Crear el mundo y el loteador de render
const world = new ECSWorld(50000);
const batcher = new SpriteBatcher(rhi, 8192);

// Registrar sistemas en orden de ejecución
world.addSystem(new MovementSystem(world));
world.addSystem(new SpriteBatchSyncSystem(world, batcher, [miTexturaAtlas]));

// Crear 25.000 entidades concurrentes
for (let i = 0; i < 25000; i++) {
    const e = world.createEntity();
    world.addComponent(e, world.Transform, {
        x: Math.random() * 1920,
        y: Math.random() * 1080,
        rotation: 0,
        scaleX: 1.0,
        scaleY: 1.0,
        originX: 0.5,
        originY: 0.5
    });
    world.addComponent(e, world.Velocity, {
        vx: (Math.random() - 0.5) * 200,
        vy: (Math.random() - 0.5) * 200,
        angularVelocity: 1.0
    });
    world.addComponent(e, world.Renderable, {
        width: 32,
        height: 32,
        u0: 0, v0: 0, u1: 1, v1: 1,
        tint: 0x00ffffff,
        alpha: 1.0,
        textureSlot: 0,
        visible: 1
    });
}

// En el loop principal del juego:
function gameLoop(time, delta) {
    batcher.begin();

    // 1. MovementSystem actualiza las posiciones contiguas en memoria
    // 2. SpriteBatchSyncSystem inyecta los quads directamente en el SpriteBatcher
    world.step(time, delta);

    // 3. Despachar los lotes hacia WebGPU/WebGL2
    batcher.flush();
    requestAnimationFrame(gameLoop);
}
```

---

### Ejemplo 3: Utilización del Adaptador Híbrido (`GameObjectECSAdapter`)

Para entidades de jugador o jefes (*bosses*) donde se prefiere una interfaz orientada a objetos ergonómica sin renunciar al almacenamiento columnar:

```javascript
import { ECSWorld, GameObjectECSAdapter } from '@tacarigua/ecs';

const world = new ECSWorld(1024);

// 1. Crear entidad y componentes base
const playerEntity = world.createEntity();
world.addComponent(playerEntity, world.Transform, { x: 100, y: 150 });
world.addComponent(playerEntity, world.Velocity, { vx: 0, vy: 0 });
world.addComponent(playerEntity, world.Renderable, { visible: 1, alpha: 1.0 });

// 2. Envolver la entidad con el adaptador híbrido
const player = new GameObjectECSAdapter(world, playerEntity);

// 3. Uso natural con la sintaxis clásica de Phaser:
player.setPosition(250, 400);
player.setVelocity(150, -50);
player.setScale(2.0);
player.alpha = 0.8;

// Los cambios modificaron de forma inmediata los búferes Float32Array subyacentes
console.log(world.Transform.columns.x[player._index]); // Imprime: 250
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

Para trasladar lógicas orientadas a objetos con cuello de botella a la arquitectura ECS:

### Paso 1: Identificar Grupos Masivos de Objetos
Localice entidades instanciadas en bucles masivos mediante `Phaser.GameObjects.Group` o subclases pesadas de `Sprite` (como proyectiles, enemigos genéricos o monedas coleccionables).

### Paso 2: Extraer Propiedades hacia Esquemas de Componentes
- **Antes (Phaser v4.2.1):**
  ```javascript
  class Coin extends Phaser.Physics.Arcade.Sprite {
      constructor(scene, x, y) {
          super(scene, x, y, 'coin');
          this.value = 10;
          this.collected = false;
      }
  }
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  const CoinComponent = world.registerComponent('Coin', {
      value: TYPE.INT32,
      collected: TYPE.UINT8
  });
  ```

### Paso 3: Reemplazar Bucles `Group.each()` por Consultas Vectorizadas
- **Antes (Phaser v4.2.1):**
  ```javascript
  coinGroup.children.iterate((coin) => {
      coin.y += coin.speed * delta;
  });
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  class CoinSystem extends System {
      init() {
          this.query = this.world.createQuery([this.world.Transform, CoinComponent]);
      }
      update(time, delta) {
          const entities = this.query.entities;
          const y = this.world.Transform.columns.y;
          const dt = delta * 0.001;

          for (let i = 0; i < entities.length; i++) {
              const idx = entities[i] & 0xfffff;
              y[idx] += 50 * dt; // Acceso directo y continuo a memoria
          }
      }
  }
  ```

### Paso 4: Transición Suave con el Adaptador
Si su lógica de juego contiene scripts complejos diseñados para la sintaxis anterior, enlace las entidades con `GameObjectECSAdapter`. Esto le permite mantener el código de control del personaje intacto mientras que los sistemas globales procesan la entidad en modo columnar masivo.