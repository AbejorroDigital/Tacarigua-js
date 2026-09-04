# Documentación Técnica: Físicas Off-Thread en Web Workers (`@tacarigua/physics-worker`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

En las versiones previas de Phaser (v3.x y v4.2.1), los motores de físicas (**Arcade Physics** y **Matter**) se ejecutaban de manera sincrónica en el **hilo principal de JavaScript (*Main Thread*)**. Esto provocaba cuellos de botella severos: si una escena demandaba calcular cientos de colisiones complejas o resolver cuerpos rígidos poligonales, la CPU consumía la mayor parte del presupuesto de tiempo del cuadro (16.6 ms para 60 FPS o 8.3 ms para 120 FPS), sacrificando la fluidez visual y generando caídas abruptas de cuadros por segundo (*jank*).

En **Tacarigua 1.0.0**, el módulo `@tacarigua/physics-worker` traslada la simulación física a un **Web Worker dedicado**. Sus características principales son:
- **Ejecución Asíncrona en Paralelo:** Las etapas de integración numérica, detección de fases amplia y estrecha (*Broadphase/Narrowphase*) y resolución de contactos se computan en un núcleo de CPU independiente.
- **Memoria Compartida de Copia Cero (`SharedArrayBuffer`):** El hilo principal y el worker comparten un segmento de memoria binaria lineal idéntico. Se erradica por completo la sobrecarga de serialización, deserialización y copiado que implicaba la API clásica de `postMessage()`.
- **Sincronización Atómica Libre de Bloqueos (`Atomics`):** Un bloque de control (*Header*) con banderas sincronizadas atómicamente orquesta la alternancia entre la lectura del renderizador y el cálculo físico sin riesgo de condiciones de carrera (*Race Conditions*).
- **Mapeo Híbrido Directo:** Proyecta las transformaciones calculadas directamente sobre los componentes columnares de `@tacarigua/ecs` o sobre los `GameObject` tradicionales.
- **Degradación Elegante Transparente (*Fallback*):** Si el servidor web no expone los encabezados de aislamiento de origen cruzado (`COOP/COEP`), el sistema detecta la ausencia de `SharedArrayBuffer` y conmuta a transferencias binarias mediante `ArrayBuffer` transferibles sin alterar la API expuesta al desarrollador.

---

## 2. Disposición de Memoria Binaria (Memory Layout)

Para eliminar cualquier asignación en el *heap* de JavaScript durante el bucle de físicas, el módulo reserva un único bloque binario segmentado en dos áreas: **Cabecera de Control** y **Arreglo de Cuerpos**.

```
┌──────────────────────────────────────┬─────────────────────────────────────────────────────────────────┐
│     CABECERA DE CONTROL (HEADER)     │                   BLOQUE DE DATOS DE CUERPOS                    │
│    16 x Int32 (64 bytes totales)     │           N x 16 x Float32 (N x 64 bytes por cuerpo)            │
├──────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤
│ [0] SYNC_FLAG                        │ [Cuerpo 0]: POS_X, POS_Y, VEL_X, VEL_Y, ROT, ANG_VEL, ...       │
│ [1] STEP_COUNTER                     │ [Cuerpo 1]: POS_X, POS_Y, VEL_X, VEL_Y, ROT, ANG_VEL, ...       │
│ [2] ACTIVE_BODIES                    │ ...                                                             │
│ [3] COLLISION_COUNT                  │ [Cuerpo N]: POS_X, POS_Y, VEL_X, VEL_Y, ROT, ANG_VEL, ...       │
│ [4..15] DELTA_TIME, RESERVADO        │                                                                 │
└──────────────────────────────────────┴─────────────────────────────────────────────────────────────────┘
```

### 2.1. Estructura de la Cabecera de Control (`Int32Array`)
Ocupa los primeros 64 bytes del búfer y se gestiona mediante primitivas `Atomics`:

| Índice | Constante | Tipo | Descripción |
| :---: | :--- | :--- | :--- |
| `0` | `CONTROL.SYNC_FLAG` | `Int32` | Semáforo de sincronización (`0`: Hilo Principal, `1`: Worker procesando, `2`: Datos listos). |
| `1` | `CONTROL.STEP_COUNTER` | `Int32` | Contador monótono creciente de fotogramas físicos completados. |
| `2` | `CONTROL.ACTIVE_BODIES` | `Int32` | Número actual de cuerpos rígidos registrados y activos. |
| `3` | `CONTROL.COLLISION_COUNT`| `Int32` | Total de colisiones detectadas y resueltas en el último paso. |
| `4` | `CONTROL.DELTA_TIME` | `Int32` | Intervalo temporal del paso expresado en microsegundos ($\mu\text{s}$). |
| `5` | `CONTROL.IS_TERMINATED` | `Int32` | Bandera de interrupción de emergencia para el hilo secundario. |
| `6..15` | `RESERVADO` | `Int32` | Espacio reservado para expansión (e.g. temporizadores y máscaras globales). |

### 2.2. Estructura de Atributos por Cuerpo Rígido (`Float32Array`)
Cada cuerpo físico registrado ocupa un paso (*stride*) de **16 floats de 32 bits (64 bytes)**:

| Desplazamiento (*Offset*) | Campo | Semántica Física |
| :---: | :--- | :--- |
| `0` | `POS_X` | Coordenada horizontal central $X$ en el espacio mundial. |
| `1` | `POS_Y` | Coordenada vertical central $Y$ en el espacio mundial. |
| `2` | `VEL_X` | Velocidad lineal horizontal $V_x$ (píxeles/segundo). |
| `3` | `VEL_Y` | Velocidad lineal vertical $V_y$ (píxeles/segundo). |
| `4` | `ROTATION` | Ángulo de rotación $\theta$ en radianes. |
| `5` | `ANGULAR_VEL` | Velocidad de rotación $\omega$ (radianes/segundo). |
| `6` | `WIDTH` | Ancho del delimitador de colisión (AABB). |
| `7` | `HEIGHT` | Alto del delimitador de colisión (AABB). |
| `8` | `MASS` | Masa física $M$ en kilogramos arbitrarios. |
| `9` | `INVERSE_MASS` | Masa recíproca calculada ($1 / M$ o $0.0$ para estáticos). |
| `10` | `BOUNCE` | Coeficiente de restitución elástica ($0.0 = \text{inelástico}, 1.0 = \text{elástico}$). |
| `11` | `FRICTION` | Coeficiente de fricción o rozamiento ambiental ($0.0 \text{ a } 1.0$). |
| `12` | `FLAGS` | Máscara de bits: `STATIC (1)`, `SENSOR (2)`, `ENABLED (4)`, `COLLIDING (8)`. |
| `13` | `GRAVITY_SCALE` | Escala multiplicadora de gravedad local. |
| `14` | `CUSTOM_ID` | Identificador de entidad ECS vinculado o índice de binding. |
| `15` | `RESERVED` | Parámetro libre para amortiguamiento o amortiguación angular. |

---

## 3. Máquina de Estados y Protocolo de Sincronización Atómica

Para asegurar que el hilo principal y el Web Worker operen en paralelo sin bloquearse mutuamente y sin generar condiciones de carrera, se utiliza una **máquina de estados atómica de tres fases** coordinada por `SYNC_FLAG`:

```
               [ HILO PRINCIPAL (Render / UI) ]             [ WEB WORKER (Física) ]
                              │                                        │
             ┌────────────────┴────────────────┐                       │
             │ Lee posiciones calculadas       │                       │
             │ Sincroniza GameObjects y ECS    │                       │
             └────────────────┬────────────────┘                       │
                              │                                        │
           Escribe delta y cuerpos activos                             │
           Atomics.store(SYNC_FLAG, 1) ───────────────────────► [ Detecta SYNC_FLAG === 1 ]
                              │                                        │
             ┌────────────────┴────────────────┐         ┌─────────────┴─────────────┐
             │ Continúa Renderizado WebGPU     │         │ Integra aceleración       │
             │ Procesa entradas y audio        │         │ Actualiza posiciones      │
             │ (Hilo libre de lag de físicas)  │         │ Detecta y resuelve AABBs  │
             └────────────────┬────────────────┘         └─────────────┬─────────────┘
                              │                                        │
                              │                       Atomics.store(SYNC_FLAG, 2)
                              │ ◄──────────────────────────────────────┘
             ┌────────────────┴────────────────┐                       │
             │ Comprueba SYNC_FLAG === 2       │                       │
             │ Aplica resultados en el frame   │                       │
             └─────────────────────────────────┘                       ▼
```

1. **Estado 0 (Idle / Escritura Principal):** El hilo principal actualiza entradas, aplica fuerzas externas o teletransporta cuerpos modificando directamente las posiciones en memoria.
2. **Estado 1 (Cálculo del Worker):** El hilo principal ordena la simulación asignando `SYNC_FLAG = 1`. El Worker toma el control, integra la gravedad, calcula la cinemática y resuelve los contactos.
3. **Estado 2 (Lectura Lista):** Al finalizar la resolución, el Worker marca `SYNC_FLAG = 2`. En el siguiente cuadro, el hilo principal detecta este valor e invoca `_syncEntities()` para trasladar las nuevas coordenadas al renderizador.

---

## 4. Motor de Resolución de Contactos y Cinemática

El bucle interno del Worker (`WORKER_SIMULATION_LOGIC`) implementa un integrador simplificado y de alta frecuencia:

### 4.1. Integración Semi-Implícita de Euler
Para cada cuerpo activo no estático ($M^{-1} > 0$):
$$V_x(t + \Delta t) = \left( V_x(t) + g_x \cdot s_g \cdot \Delta t \right) \cdot (1.0 - \mu \cdot \Delta t)$$
$$V_y(t + \Delta t) = \left( V_y(t) + g_y \cdot s_g \cdot \Delta t \right) \cdot (1.0 - \mu \cdot \Delta t)$$
$$X(t + \Delta t) = X(t) + V_x(t + \Delta t) \cdot \Delta t$$
$$Y(t + \Delta t) = Y(t) + V_y(t + \Delta t) \cdot \Delta t$$
$$\theta(t + \Delta t) = \theta(t) + \omega \cdot \Delta t$$

### 4.2. Detección AABB (Axis-Aligned Bounding Box)
Para cada par de cuerpos $A$ y $B$, se calcula el solapamiento en ambos ejes:
$$\Delta X = \left( \frac{W_A + W_B}{2} \right) - |X_A - X_B|$$
$$\Delta Y = \left( \frac{H_A + H_B}{2} \right) - |Y_A - Y_B|$$

Si $\Delta X > 0$ y $\Delta Y > 0$, existe colisión. La resolución se aplica a lo largo del **eje de mínima penetración** para minimizar la distorsión geométrica.

### 4.3. Impulso de Restitución (Rebote)
Se determina el impulso escalar $J$ en función de la velocidad relativa a lo largo de la normal de contacto $\vec{n}$:
$$J = \frac{-(1 + e) \cdot (\vec{V}_{rel} \cdot \vec{n})}{M_A^{-1} + M_B^{-1}}$$
Donde $e = \max(e_A, e_B)$. Las correcciones de velocidad y posición se ponderan proporcionalmente según la masa inversa de cada participante:
$$\vec{V}_A' = \vec{V}_A - J \cdot M_A^{-1} \cdot \vec{n}, \quad \vec{V}_B' = \vec{V}_B + J \cdot M_B^{-1} \cdot \vec{n}$$

---

## 5. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v5.0.0)

| Característica | Phaser 4.2.1 (Arcade / Matter) | Tacarigua 1.0.0 (`@tacarigua/physics-worker`) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Hilo de Ejecución** | Hilo Principal (UI / Render). | **Web Worker dedicado**. | Cero congelamientos (*jank-free*) en el hilo de renderizado. |
| **Transferencia de Datos** | Llamadas directas al heap. | **`SharedArrayBuffer` con `Atomics`**. | Latencia inferior a **$0.1\text{ ms}$** sin costo de serialización. |
| **Escalabilidad de Cuerpos** | Rendimiento degradado con $> 2.000$ cuerpos. | Estable con **$> 10.000$ cuerpos activos**. | Permite simulaciones a escala masiva a 60/120 FPS. |
| **Consumo de Memoria** | Dispersión de objetos en el Garbage Collector. | Búfer binario continuo (64 bytes/cuerpo). | 10.000 cuerpos ocupan exactamente **$640\text{ KB}$ de RAM**. |
| **Compatibilidad Web** | Restringida por el presupuesto de frame compartido. | Fallback automático por transferencia de búferes. | Funciona en entornos con o sin encabezados COOP/COEP. |

---

## 6. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Inicialización Básica y Creación de Cuerpos Físicos

```javascript
import { Game } from '@tacarigua/core.js';
import { PhysicsWorkerBridge, BODY_FLAGS } from '@tacarigua/physics-worker';

const game = new Game({ width: 1280, height: 720 });

// 1. Inicializar el puente de físicas off-thread
const physics = new PhysicsWorkerBridge(game, {
    maxBodies: 5000,
    gravity: { x: 0.0, y: 980.0 }
});

console.log(`[Física] Memoria compartida activa: ${physics.hasSharedMemory}`);

// 2. Crear suelo estático (inmóvil)
const groundId = physics.createBody(640, 700, 1280, 40, {
    isStatic: true,
    bounce: 0.2,
    friction: 0.8
});

// 3. Crear una caja dinámica que cae por gravedad
const boxSprite = { x: 640, y: 100, rotation: 0, setPosition(x, y) { this.x = x; this.y = y; } };

const boxId = physics.createBody(640, 100, 50, 50, {
    mass: 2.5,
    bounce: 0.6,
    velocityX: 120.0, // Impulso inicial horizontal
    velocityY: 0.0
}, boxSprite);

// 4. En el loop del juego (vinculado a CORE_EVENTS.STEP)
game.events.on('step', (time, delta) => {
    // Despachar paso de física al Worker
    physics.update(delta);
    
    // boxSprite.x y boxSprite.y se actualizan automáticamente tras la resolución
});
```

---

### Ejemplo 2: Sincronización Directa con Entidades del Motor ECS

Cómo vincular cuerpos del worker directamente con entidades columnares de `@tacarigua/ecs`:

```javascript
import { ECSWorld } from '@tacarigua/ecs';
import { PhysicsWorkerBridge } from '@tacarigua/physics-worker';

const world = new ECSWorld(10000);
const physics = new PhysicsWorkerBridge(game, { maxBodies: 10000 });

// Crear 1.000 entidades físicas simultáneas
for (let i = 0; i < 1000; i++) {
    const entity = world.createEntity();
    
    // Asignar componente Transform nativo
    world.addComponent(entity, world.Transform, {
        x: Math.random() * 1280,
        y: Math.random() * 200,
        rotation: 0
    });

    // Vincular la entidad ECS al cuerpo en el worker
    // physics-worker detecta 'target.Transform' y escribe directo en las columnas Float32Array
    physics.createBody(
        world.Transform.columns.x[entity & 0xfffff],
        world.Transform.columns.y[entity & 0xfffff],
        16, 16,
        { mass: 1.0, bounce: 0.75 },
        { Transform: { 
            get x() { return world.Transform.columns.x[entity & 0xfffff]; },
            set x(v) { world.Transform.columns.x[entity & 0xfffff] = v; },
            get y() { return world.Transform.columns.y[entity & 0xfffff]; },
            set y(v) { world.Transform.columns.y[entity & 0xfffff] = v; },
            set rotation(v) { world.Transform.columns.rotation[entity & 0xfffff] = v; }
        }}
    );
}

// Bucle de actualización
function onTick(delta) {
    physics.update(delta);
    world.step(performance.now(), delta);
}
```

---

### Ejemplo 3: Configuración de Aislamiento de Origen Cruzado (COOP / COEP)

Para que el navegador permita la asignación de `SharedArrayBuffer`, el servidor web debe responder con los siguientes encabezados HTTP de seguridad:

#### Configuración para Vite (`vite.config.js`):
```javascript
import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    }
});
```

#### Configuración para Nginx:
```nginx
add_header Cross-Origin-Opener-Policy "same-origin";
add_header Cross-Origin-Embedder-Policy "require-corp";
```

---

## 7. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Reemplazar la Creación Síncrona de Sprites Arcade
- **Antes (Phaser v4.2.1):**
  ```javascript
  const sprite = this.physics.add.sprite(x, y, 'player');
  sprite.setVelocity(200, -100);
  sprite.setBounce(0.5);
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  const sprite = this.add.sprite(x, y, 'player');
  // Se crea el cuerpo en el worker y se enlaza al sprite visual
  const bodyId = this.physicsWorker.createBody(x, y, sprite.width, sprite.height, {
      velocityX: 200,
      velocityY: -100,
      bounce: 0.5
  }, sprite);
  ```

### Paso 2: Adaptar la Modificación de Velocidades
En lugar de mutar propiedades de objeto en cada cuadro, se utilizan métodos de despacho atómico:
- **Antes (Phaser v4.2.1):**
  ```javascript
  sprite.body.velocity.x = 300;
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  this.physicsWorker.setVelocity(bodyId, 300, sprite.body?.velocityY || 0);
  ```

### Paso 3: Gestión de Colisiones Globales
En Tacarigua 1.0.0, la separación y respuesta elástica ocurren dentro del Worker. Para detectar contactos sin penalizar el rendimiento, consulte el flag `BODY_FLAGS.COLLIDING` o escuche eventos de colisión agregados al final del paso de simulación.