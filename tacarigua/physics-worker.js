/**
 * @fileoverview Subsistema de físicas Off-Thread en Web Workers con soporte SharedArrayBuffer para Tacarigua 1.0.0.
 * @module @tacarigua/physics-worker
 * @license Phaser - Licencia MIT
 */

// =============================================================================
// ESPECIFICACIÓN DE MEMORIA COMPARTIDA (SHARED MEMORY LAYOUT)
// =============================================================================

/**
 * Constantes de disposición para el bloque de control (Header) y cuerpos de física.
 */
export const HEADER_SIZE = 16; // 16 enteros de 32 bits para control y banderas de sincronización
export const BODY_STRIDE = 16; // 16 floats de 32 bits por cada cuerpo rígido (64 bytes por cuerpo)

/**
 * Índices de control atómico dentro de la cabecera (Header en Int32Array).
 */
export const CONTROL = Object.freeze({
    SYNC_FLAG: 0,       // 0: Principal escribiendo/leyendo, 1: Worker simulando, 2: Datos listos
    STEP_COUNTER: 1,    // Contador incremental de fotogramas físicos
    ACTIVE_BODIES: 2,   // Cantidad total de cuerpos físicos vivos en la escena
    COLLISION_COUNT: 3, // Cantidad de pares de colisión detectados en el paso
    DELTA_TIME: 4,      // Delta de tiempo en microsegundos
    IS_TERMINATED: 5    // Bandera de detención de emergencia
});

/**
 * Disposición interna de atributos para cada cuerpo rígido (Desplazamientos en Float32Array).
 */
export const BODY_OFFSET = Object.freeze({
    POS_X: 0,
    POS_Y: 1,
    VEL_X: 2,
    VEL_Y: 3,
    ROTATION: 4,
    ANGULAR_VEL: 5,
    WIDTH: 6,
    HEIGHT: 7,
    MASS: 8,
    INVERSE_MASS: 9,
    BOUNCE: 10,
    FRICTION: 11,
    FLAGS: 12,          // Bit 0: IsStatic, Bit 1: IsSensor, Bit 2: Enabled, Bit 3: Colliding
    GRAVITY_SCALE: 13,
    CUSTOM_ID: 14,      // Identificador de entidad ECS o puntero de GameObject
    RESERVED: 15
});

/**
 * Banderas binarias de estado por cada cuerpo físico.
 */
export const BODY_FLAGS = Object.freeze({
    STATIC: 1 << 0,
    SENSOR: 1 << 1,
    ENABLED: 1 << 2,
    COLLIDING: 1 << 3
});

// =============================================================================
// CÓDIGO FUENTE DEL WORKER AISLADO (INLINE WORKER SCRIPT)
// =============================================================================

/**
 * Código ejecutable que reside dentro del Web Worker.
 * Resuelve el paso físico de manera completamente desacoplada del hilo de render.
 */
const WORKER_SIMULATION_LOGIC = `
const HEADER_SIZE = 16;
const BODY_STRIDE = 16;

const CONTROL_SYNC_FLAG = 0;
const CONTROL_STEP_COUNTER = 1;
const CONTROL_ACTIVE_BODIES = 2;
const CONTROL_COLLISION_COUNT = 3;
const CONTROL_DELTA_TIME = 4;
const CONTROL_IS_TERMINATED = 5;

const BODY_POS_X = 0;
const BODY_POS_Y = 1;
const BODY_VEL_X = 2;
const BODY_VEL_Y = 3;
const BODY_ROTATION = 4;
const BODY_ANGULAR_VEL = 5;
const BODY_WIDTH = 6;
const BODY_HEIGHT = 7;
const BODY_MASS = 8;
const BODY_INVERSE_MASS = 9;
const BODY_BOUNCE = 10;
const BODY_FRICTION = 11;
const BODY_FLAGS = 12;
const BODY_GRAVITY_SCALE = 13;
const BODY_CUSTOM_ID = 14;

const FLAG_STATIC = 1 << 0;
const FLAG_SENSOR = 1 << 1;
const FLAG_ENABLED = 1 << 2;
const FLAG_COLLIDING = 1 << 3;

let sharedBuffer = null;
let headerInt32 = null;
let bodiesFloat32 = null;
let isRunning = false;
let gravityY = 980.0;
let gravityX = 0.0;

self.onmessage = function(event) {
    const data = event.data;
    switch (data.type) {
        case 'INIT_SHARED':
            sharedBuffer = data.buffer;
            headerInt32 = new Int32Array(sharedBuffer, 0, HEADER_SIZE);
            bodiesFloat32 = new Float32Array(sharedBuffer, HEADER_SIZE * 4);
            gravityX = data.gravityX || 0.0;
            gravityY = data.gravityY || 980.0;
            isRunning = true;
            break;

        case 'STEP_FALLBACK':
            // Modo de fallback sin SharedArrayBuffer: procesar y responder con el buffer transferido
            bodiesFloat32 = new Float32Array(data.buffer);
            gravityX = data.gravityX || 0.0;
            gravityY = data.gravityY || 980.0;
            simulateStep(data.bodyCount, data.delta);
            self.postMessage({ type: 'STEP_COMPLETE', buffer: bodiesFloat32.buffer }, [bodiesFloat32.buffer]);
            break;

        case 'SET_GRAVITY':
            gravityX = data.x;
            gravityY = data.y;
            break;

        case 'TERMINATE':
            isRunning = false;
            self.close();
            break;
    }
};

function simulateStep(activeCount, dt) {
    // 1. Integración de Fuerzas y Cinemática
    for (let i = 0; i < activeCount; i++) {
        const offset = i * BODY_STRIDE;
        const flags = bodiesFloat32[offset + BODY_FLAGS];

        if (!(flags & FLAG_ENABLED) || (flags & FLAG_STATIC)) {
            continue;
        }

        const invMass = bodiesFloat32[offset + BODY_INVERSE_MASS];
        if (invMass <= 0.0) continue;

        const gravScale = bodiesFloat32[offset + BODY_GRAVITY_SCALE];

        // Aceleración gravitacional
        bodiesFloat32[offset + BODY_VEL_X] += gravityX * gravScale * dt;
        bodiesFloat32[offset + BODY_VEL_Y] += gravityY * gravScale * dt;

        // Fricción ambiental simple
        const friction = 1.0 - (bodiesFloat32[offset + BODY_FRICTION] * dt);
        bodiesFloat32[offset + BODY_VEL_X] *= Math.max(0.0, friction);
        bodiesFloat32[offset + BODY_VEL_Y] *= Math.max(0.0, friction);

        // Integración de posición
        bodiesFloat32[offset + BODY_POS_X] += bodiesFloat32[offset + BODY_VEL_X] * dt;
        bodiesFloat32[offset + BODY_POS_Y] += bodiesFloat32[offset + BODY_VEL_Y] * dt;

        // Rotación
        bodiesFloat32[offset + BODY_ROTATION] += bodiesFloat32[offset + BODY_ANGULAR_VEL] * dt;
        
        // Limpiar bandera de colisión previa
        bodiesFloat32[offset + BODY_FLAGS] &= ~FLAG_COLLIDING;
    }

    // 2. Detección y Resolución de Colisiones AABB
    let collisionEvents = 0;
    for (let i = 0; i < activeCount; i++) {
        const oA = i * BODY_STRIDE;
        const flagsA = bodiesFloat32[oA + BODY_FLAGS];
        if (!(flagsA & FLAG_ENABLED)) continue;

        const ax = bodiesFloat32[oA + BODY_POS_X];
        const ay = bodiesFloat32[oA + BODY_POS_Y];
        const aw = bodiesFloat32[oA + BODY_WIDTH];
        const ah = bodiesFloat32[oA + BODY_HEIGHT];

        for (let j = i + 1; j < activeCount; j++) {
            const oB = j * BODY_STRIDE;
            const flagsB = bodiesFloat32[oB + BODY_FLAGS];
            if (!(flagsB & FLAG_ENABLED)) continue;

            // Evitar resolver colisiones entre dos cuerpos estáticos
            if ((flagsA & FLAG_STATIC) && (flagsB & FLAG_STATIC)) continue;

            const bx = bodiesFloat32[oB + BODY_POS_X];
            const by = bodiesFloat32[oB + BODY_POS_Y];
            const bw = bodiesFloat32[oB + BODY_WIDTH];
            const bh = bodiesFloat32[oB + BODY_HEIGHT];

            // Prueba de superposición de cajas alineadas a los ejes (AABB Overlap)
            const overlapX = (aw * 0.5 + bw * 0.5) - Math.abs(ax - bx);
            if (overlapX <= 0.0) continue;

            const overlapY = (ah * 0.5 + bh * 0.5) - Math.abs(ay - by);
            if (overlapY <= 0.0) continue;

            // Marcar colisión detectada
            bodiesFloat32[oA + BODY_FLAGS] |= FLAG_COLLIDING;
            bodiesFloat32[oB + BODY_FLAGS] |= FLAG_COLLIDING;
            collisionEvents++;

            // Sensores no responden físicamente
            if ((flagsA & FLAG_SENSOR) || (flagsB & FLAG_SENSOR)) continue;

            // Separación y rebote por el eje de menor penetración
            if (overlapX < overlapY) {
                const normalX = ax < bx ? -1.0 : 1.0;
                resolveContact(oA, oB, normalX, 0.0, overlapX);
            } else {
                const normalY = ay < by ? -1.0 : 1.0;
                resolveContact(oA, oB, 0.0, normalY, overlapY);
            }
        }
    }

    return collisionEvents;
}

function resolveContact(oA, oB, nx, ny, penetration) {
    const invMassA = (bodiesFloat32[oA + BODY_FLAGS] & FLAG_STATIC) ? 0.0 : bodiesFloat32[oA + BODY_INVERSE_MASS];
    const invMassB = (bodiesFloat32[oB + BODY_FLAGS] & FLAG_STATIC) ? 0.0 : bodiesFloat32[oB + BODY_INVERSE_MASS];
    const totalInvMass = invMassA + invMassB;

    if (totalInvMass <= 0.0) return;

    // Separación posicional para evitar empotramientos
    const moveA = penetration * (invMassA / totalInvMass);
    const moveB = penetration * (invMassB / totalInvMass);

    bodiesFloat32[oA + BODY_POS_X] += nx * moveA;
    bodiesFloat32[oA + BODY_POS_Y] += ny * moveA;
    bodiesFloat32[oB + BODY_POS_X] -= nx * moveB;
    bodiesFloat32[oB + BODY_POS_Y] -= ny * moveB;

    // Impulso de restitución elástica (Rebote)
    const relVelX = bodiesFloat32[oB + BODY_VEL_X] - bodiesFloat32[oA + BODY_VEL_X];
    const relVelY = bodiesFloat32[oB + BODY_VEL_Y] - bodiesFloat32[oA + BODY_VEL_Y];
    const velAlongNormal = relVelX * nx + relVelY * ny;

    if (velAlongNormal > 0.0) return; // Se están alejando

    const restitution = Math.max(bodiesFloat32[oA + BODY_BOUNCE], bodiesFloat32[oB + BODY_BOUNCE]);
    const impulseMag = -(1.0 + restitution) * velAlongNormal / totalInvMass;

    const ix = nx * impulseMag;
    const iy = ny * impulseMag;

    bodiesFloat32[oA + BODY_VEL_X] -= ix * invMassA;
    bodiesFloat32[oA + BODY_VEL_Y] -= iy * invMassA;
    bodiesFloat32[oB + BODY_VEL_X] += ix * invMassB;
    bodiesFloat32[oB + BODY_VEL_Y] += iy * invMassB;
}

// Bucle continuo para el modo nativo SharedArrayBuffer
function workerLoop() {
    if (!isRunning) return;

    // Esperar a que el hilo principal autorice el cálculo
    // Estado 1 indica: hilo principal terminó de escribir entradas y ordena calcular
    if (Atomics.load(headerInt32, CONTROL_SYNC_FLAG) === 1) {
        const activeBodies = Atomics.load(headerInt32, CONTROL_ACTIVE_BODIES);
        const dtMicro = Atomics.load(headerInt32, CONTROL_DELTA_TIME);
        const dt = (dtMicro > 0 ? dtMicro : 16666) / 1000000.0;

        const collisions = simulateStep(activeBodies, dt);

        Atomics.store(headerInt32, CONTROL_COLLISION_COUNT, collisions);
        Atomics.add(headerInt32, CONTROL_STEP_COUNTER, 1);

        // Notificar que los datos están listos para ser leídos por el render (Estado 2)
        Atomics.store(headerInt32, CONTROL_SYNC_FLAG, 2);
    }

    setTimeout(workerLoop, 0);
}

// Inicializar sondeo del bucle
setTimeout(workerLoop, 0);
`;

// =============================================================================
// COORDINADOR DEL SUBSISTEMA DE FÍSICAS OFF-THREAD
// =============================================================================

/**
 * Puente principal que gobierna la sincronización con el Worker de físicas.
 */
export class PhysicsWorkerBridge {
    /**
     * @param {import('./Game').Game} game - Instancia del motor Phaser.
     * @param {object} [config={}] - Opciones de configuración de físicas.
     */
    constructor(game, config = {}) {
        this.game = game;
        this.maxBodies = config.maxBodies ?? 10000;
        this.gravityX = config.gravity?.x ?? 0.0;
        this.gravityY = config.gravity?.y ?? 980.0;

        // Comprobación de Aislamiento de Origen Cruzado para soporte de SharedArrayBuffer
        this.hasSharedMemory = typeof SharedArrayBuffer !== 'undefined' &&
            Boolean(globalThis.crossOriginIsolated);

        this.totalBufferSize = (HEADER_SIZE * 4) + (this.maxBodies * BODY_STRIDE * 4);
        this.rawBuffer = null;
        this.header = null;
        this.bodyData = null;

        /** @type {Worker|null} */
        this.worker = null;
        this.activeBodiesCount = 0;

        /** @type {Map<number, object>} Mapeo de ID de cuerpo a GameObject o Entidad */
        this.bodyBindings = new Map();

        this.stepPending = false;
        this._initWorker();
    }

    /**
     * Inicializa el Web Worker y estructura la memoria física compartida o de respaldo.
     * @private
     */
    _initWorker() {
        const blob = new Blob([WORKER_SIMULATION_LOGIC], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        this.worker = new Worker(workerUrl);

        if (this.hasSharedMemory) {
            // Asignación de memoria compartida sin recolección de basura
            this.rawBuffer = new SharedArrayBuffer(this.totalBufferSize);
            this.header = new Int32Array(this.rawBuffer, 0, HEADER_SIZE);
            this.bodyData = new Float32Array(this.rawBuffer, HEADER_SIZE * 4);

            Atomics.store(this.header, CONTROL.SYNC_FLAG, 0);
            Atomics.store(this.header, CONTROL.ACTIVE_BODIES, 0);

            this.worker.postMessage({
                type: 'INIT_SHARED',
                buffer: this.rawBuffer,
                gravityX: this.gravityX,
                gravityY: this.gravityY
            });
        } else {
            console.warn('[Tacarigua 1.0.0 - PhysicsWorker] SharedArrayBuffer no disponible. Usando fallback por transferencia de buffers.');
            this.rawBuffer = new ArrayBuffer(this.maxBodies * BODY_STRIDE * 4);
            this.bodyData = new Float32Array(this.rawBuffer);

            this.worker.onmessage = (e) => {
                if (e.data.type === 'STEP_COMPLETE') {
                    this.bodyData = new Float32Array(e.data.buffer);
                    this.stepPending = false;
                    this._syncEntities();
                }
            };
        }

        URL.revokeObjectURL(workerUrl);
    }

    /**
     * Registra un nuevo cuerpo en la memoria de físicas.
     * @param {number} x - Posición inicial horizontal.
     * @param {number} y - Posición inicial vertical.
     * @param {number} width - Ancho del colisionador.
     * @param {number} height - Alto del colisionador.
     * @param {object} [options={}] - Parámetros de masa, restitución y banderas.
     * @param {object} [bindTarget=null] - GameObject o entidad vinculada.
     * @returns {number} Índice o identificador del cuerpo creado.
     */
    createBody(x, y, width, height, options = {}, bindTarget = null) {
        if (this.activeBodiesCount >= this.maxBodies) {
            throw new Error('[Tacarigua 1.0.0 - PhysicsWorker] Se excedió la capacidad máxima de cuerpos físicos.');
        }

        const bodyIndex = this.activeBodiesCount++;
        const offset = bodyIndex * BODY_STRIDE;
        const isStatic = options.isStatic ?? false;
        const isSensor = options.isSensor ?? false;
        const mass = isStatic ? 0.0 : (options.mass ?? 1.0);

        let flags = BODY_FLAGS.ENABLED;
        if (isStatic) flags |= BODY_FLAGS.STATIC;
        if (isSensor) flags |= BODY_FLAGS.SENSOR;

        const f32 = this.bodyData;
        f32[offset + BODY_OFFSET.POS_X] = x;
        f32[offset + BODY_OFFSET.POS_Y] = y;
        f32[offset + BODY_OFFSET.VEL_X] = options.velocityX ?? 0.0;
        f32[offset + BODY_OFFSET.VEL_Y] = options.velocityY ?? 0.0;
        f32[offset + BODY_OFFSET.ROTATION] = options.rotation ?? 0.0;
        f32[offset + BODY_OFFSET.ANGULAR_VEL] = options.angularVelocity ?? 0.0;
        f32[offset + BODY_OFFSET.WIDTH] = width;
        f32[offset + BODY_OFFSET.HEIGHT] = height;
        f32[offset + BODY_OFFSET.MASS] = mass;
        f32[offset + BODY_OFFSET.INVERSE_MASS] = mass > 0 ? 1.0 / mass : 0.0;
        f32[offset + BODY_OFFSET.BOUNCE] = options.bounce ?? 0.0;
        f32[offset + BODY_OFFSET.FRICTION] = options.friction ?? 0.1;
        f32[offset + BODY_OFFSET.FLAGS] = flags;
        f32[offset + BODY_OFFSET.GRAVITY_SCALE] = options.gravityScale ?? 1.0;
        f32[offset + BODY_OFFSET.CUSTOM_ID] = options.id ?? bodyIndex;

        if (this.hasSharedMemory) {
            Atomics.store(this.header, CONTROL.ACTIVE_BODIES, this.activeBodiesCount);
        }

        if (bindTarget) {
            this.bodyBindings.set(bodyIndex, bindTarget);
        }

        return bodyIndex;
    }

    /**
     * Aplica un impulso de velocidad lineal a un cuerpo.
     * @param {number} bodyIndex 
     * @param {number} vx 
     * @param {number} vy 
     */
    setVelocity(bodyIndex, vx, vy) {
        const offset = bodyIndex * BODY_STRIDE;
        this.bodyData[offset + BODY_OFFSET.VEL_X] = vx;
        this.bodyData[offset + BODY_OFFSET.VEL_Y] = vy;
    }

    /**
     * Actualiza la posición de un cuerpo físico directamente en la memoria.
     * @param {number} bodyIndex 
     * @param {number} x 
     * @param {number} y 
     */
    setPosition(bodyIndex, x, y) {
        const offset = bodyIndex * BODY_STRIDE;
        this.bodyData[offset + BODY_OFFSET.POS_X] = x;
        this.bodyData[offset + BODY_OFFSET.POS_Y] = y;
    }

    /**
     * Dispara el paso de simulación física en el worker.
     * @param {number} delta - Delta en milisegundos.
     */
    update(delta) {
        if (this.activeBodiesCount === 0) return;

        if (this.hasSharedMemory) {
            // Modo memoria compartida con Atomics
            const syncStatus = Atomics.load(this.header, CONTROL.SYNC_FLAG);

            // Si el worker terminó su cómputo (Estado 2), sincronizar resultados
            if (syncStatus === 2) {
                this._syncEntities();
            }

            // Ordenar nueva ejecución al Worker (Estado 1)
            Atomics.store(this.header, CONTROL.DELTA_TIME, Math.floor(delta * 1000));
            Atomics.store(this.header, CONTROL.ACTIVE_BODIES, this.activeBodiesCount);
            Atomics.store(this.header, CONTROL.SYNC_FLAG, 1);
        } else {
            // Modo Fallback por transferencia de búfer
            if (!this.stepPending) {
                this.stepPending = true;
                const bufferCopy = this.bodyData.buffer.slice(0, this.activeBodiesCount * BODY_STRIDE * 4);
                this.worker.postMessage({
                    type: 'STEP_FALLBACK',
                    buffer: bufferCopy,
                    bodyCount: this.activeBodiesCount,
                    delta: delta * 0.001,
                    gravityX: this.gravityX,
                    gravityY: this.gravityY
                }, [bufferCopy]);
            }
        }
    }

    /**
     * Proyecta las transformaciones calculadas en el worker directamente hacia los GameObjects vinculados o el ECS.
     * @private
     */
    _syncEntities() {
        const f32 = this.bodyData;
        const bindings = this.bodyBindings;

        for (const [bodyIndex, target] of bindings.entries()) {
            const offset = bodyIndex * BODY_STRIDE;
            const x = f32[offset + BODY_OFFSET.POS_X];
            const y = f32[offset + BODY_OFFSET.POS_Y];
            const rot = f32[offset + BODY_OFFSET.ROTATION];

            // Si el objetivo es un GameObject tradicional de Phaser
            if (target.setPosition) {
                target.x = x;
                target.y = y;
                target.rotation = rot;
            }
            // Si el objetivo es un componente ECS
            else if (target.Transform) {
                target.Transform.x = x;
                target.Transform.y = y;
                target.Transform.rotation = rot;
            }
        }
    }

    /**
     * Destruye el Worker y limpia los búferes de memoria compartida.
     */
    destroy() {
        if (this.worker) {
            this.worker.postMessage({ type: 'TERMINATE' });
            this.worker.terminate();
            this.worker = null;
        }

        this.bodyBindings.clear();
        this.bodyData = null;
        this.header = null;
        this.rawBuffer = null;
        this.game = null;
    }
}