/**
 * @fileoverview Motor ECS nativo orientado a datos y puente de interoperabilidad híbrida para Tacarigua 1.0.0.
 * @module @tacarigua/ecs
 * @license Phaser - Licencia MIT
 */

// =============================================================================
// ESTRUCTURA DE BITS PARA CONSULTAS (BITSET)
// =============================================================================

/**
 * Búfer de bits de longitud dinámica para el filtrado rápido de componentes en entidades.
 */
export class BitSet {
    /**
     * @param {number} [initialWords=2] - Cantidad de palabras de 32 bits iniciales.
     */
    constructor(initialWords = 2) {
        this.words = new Uint32Array(initialWords);
    }

    /**
     * Asegura que el arreglo de palabras pueda contener el índice solicitado.
     * @param {number} wordIndex 
     * @private
     */
    _resize(wordIndex) {
        if (wordIndex >= this.words.length) {
            const newWords = new Uint32Array(Math.max(wordIndex + 1, this.words.length * 2));
            newWords.set(this.words);
            this.words = newWords;
        }
    }

    /**
     * Enciende el bit en el índice indicado.
     * @param {number} index 
     * @returns {this}
     */
    set(index) {
        const wordIndex = index >>> 5;
        this._resize(wordIndex);
        this.words[wordIndex] |= 1 << (index & 31);
        return this;
    }

    /**
     * Apaga el bit en el índice indicado.
     * @param {number} index 
     * @returns {this}
     */
    clear(index) {
        const wordIndex = index >>> 5;
        if (wordIndex < this.words.length) {
            this.words[wordIndex] &= ~(1 << (index & 31));
        }
        return this;
    }

    /**
     * Verifica si el bit en el índice dado está activo.
     * @param {number} index 
     * @returns {boolean}
     */
    has(index) {
        const wordIndex = index >>> 5;
        if (wordIndex >= this.words.length) return false;
        return (this.words[wordIndex] & (1 << (index & 31))) !== 0;
    }

    /**
     * Reinicia todos los bits a cero.
     * @returns {this}
     */
    reset() {
        this.words.fill(0);
        return this;
    }

    /**
     * Comprueba si este conjunto contiene todos los bits de otro BitSet (Intersección total).
     * @param {BitSet} other 
     * @returns {boolean}
     */
    containsAll(other) {
        const otherWords = other.words;
        const otherLen = otherWords.length;
        const thisWords = this.words;
        const thisLen = thisWords.length;

        for (let i = 0; i < otherLen; i++) {
            const otherWord = otherWords[i];
            if (otherWord === 0) continue;
            if (i >= thisLen) return false;
            if ((thisWords[i] & otherWord) !== otherWord) {
                return false;
            }
        }
        return true;
    }

    /**
     * Comprueba si coincide con al menos un bit activo de otro BitSet.
     * @param {BitSet} other 
     * @returns {boolean}
     */
    intersects(other) {
        const minLen = Math.min(this.words.length, other.words.length);
        for (let i = 0; i < minLen; i++) {
            if ((this.words[i] & other.words[i]) !== 0) {
                return true;
            }
        }
        return false;
    }
}

// =============================================================================
// TIPOS DE DATOS Y ALMACENAMIENTO COLUMNAR (SoA)
// =============================================================================

/**
 * Tipos de datos escalares soportados en los esquemas de componentes.
 * @enum {string}
 */
export const TYPE = Object.freeze({
    FLOAT32: 'f32',
    FLOAT64: 'f64',
    INT32: 'i32',
    INT16: 'i16',
    INT8: 'i8',
    UINT32: 'u32',
    UINT16: 'u16',
    UINT8: 'u8'
});

/**
 * Almacén columnar contiguo para un componente específico (Structure of Arrays).
 */
export class ComponentStore {
    /**
     * @param {number} id - Identificador numérico del componente.
     * @param {string} name - Nombre único del componente.
     * @param {object} schema - Definición de propiedades y tipos escalares.
     * @param {number} initialCapacity - Cantidad de entidades soportadas antes de redimensionar.
     */
    constructor(id, name, schema, initialCapacity = 4096) {
        this.id = id;
        this.name = name;
        this.schema = schema;
        this.capacity = initialCapacity;

        /** @type {Object.<string, TypedArray>} Columnas contiguas de datos */
        this.columns = {};

        this._allocateStorage(initialCapacity);
    }

    /**
     * Inicializa o redimensiona las columnas de memoria tipada.
     * @param {number} capacity 
     * @private
     */
    _allocateStorage(capacity) {
        for (const [prop, type] of Object.entries(this.schema)) {
            const prevArray = this.columns[prop];
            let newArray;

            switch (type) {
                case TYPE.FLOAT32: newArray = new Float32Array(capacity); break;
                case TYPE.FLOAT64: newArray = new Float64Array(capacity); break;
                case TYPE.INT32: newArray = new Int32Array(capacity); break;
                case TYPE.INT16: newArray = new Int16Array(capacity); break;
                case TYPE.INT8: newArray = new Int8Array(capacity); break;
                case TYPE.UINT32: newArray = new Uint32Array(capacity); break;
                case TYPE.UINT16: newArray = new Uint16Array(capacity); break;
                case TYPE.UINT8: newArray = new Uint8Array(capacity); break;
                default:
                    throw new Error(`[Tacarigua 1.0.0 - ECS] Tipo de dato '${type}' no soportado para la propiedad '${prop}'`);
            }

            if (prevArray) {
                newArray.set(prevArray.subarray(0, Math.min(prevArray.length, capacity)));
            }

            this.columns[prop] = newArray;
        }
        this.capacity = capacity;
    }

    /**
     * Expande la memoria columnar si el índice de entidad excede la capacidad actual.
     * @param {number} entityIndex 
     */
    ensureCapacity(entityIndex) {
        if (entityIndex >= this.capacity) {
            let nextCapacity = Math.max(entityIndex + 1, this.capacity * 2);
            this._allocateStorage(nextCapacity);
        }
    }

    /**
     * Asigna valores a los componentes de una entidad.
     * @param {number} entityIndex 
     * @param {object} values 
     */
    set(entityIndex, values) {
        this.ensureCapacity(entityIndex);
        for (const [prop, val] of Object.entries(values)) {
            if (this.columns[prop]) {
                this.columns[prop][entityIndex] = val;
            }
        }
    }

    /**
     * Restablece los datos de una entidad a los valores predeterminados.
     * @param {number} entityIndex 
     */
    reset(entityIndex) {
        if (entityIndex < this.capacity) {
            for (const prop in this.columns) {
                this.columns[prop][entityIndex] = 0;
            }
        }
    }
}

// =============================================================================
// GESTOR DE CONSULTAS Y FILTRADO (QUERIES)
// =============================================================================

/**
 * Consulta de entidades optimizada con lista estática de entidades coincidentes.
 */
export class Query {
    /**
     * @param {ECSWorld} world - Mundo propietario.
     * @param {Array<ComponentStore>} allOf - Componentes obligatorios.
     * @param {Array<ComponentStore>} [noneOf=[]] - Componentes excluyentes.
     */
    constructor(world, allOf = [], noneOf = []) {
        this.world = world;
        this.maskAll = new BitSet();
        this.maskNone = new BitSet();

        for (const comp of allOf) {
            this.maskAll.set(comp.id);
        }

        for (const comp of noneOf) {
            this.maskNone.set(comp.id);
        }

        /** @type {Array<number>} Arreglo contiguo con las entidades activas coincidentes */
        this.entities = [];

        /** @type {Map<number, number>} Mapeo de EntityID a su posición en this.entities */
        this._indexMap = new Map();
    }

    /**
     * Evalúa si una entidad califica para la consulta y actualiza el caché interno.
     * @param {number} entity 
     * @param {BitSet} entityMask 
     */
    match(entity, entityMask) {
        const qualifies = entityMask.containsAll(this.maskAll) && !entityMask.intersects(this.maskNone);
        const currentIndex = this._indexMap.get(entity);

        if (qualifies && currentIndex === undefined) {
            // Agregar entidad
            this._indexMap.set(entity, this.entities.length);
            this.entities.push(entity);
        } else if (!qualifies && currentIndex !== undefined) {
            // Remoción Swap & Pop para eliminar en O(1) sin alterar punteros
            const lastEntity = this.entities.pop();
            if (entity !== lastEntity) {
                this.entities[currentIndex] = lastEntity;
                this._indexMap.set(lastEntity, currentIndex);
            }
            this._indexMap.delete(entity);
        }
    }

    /**
     * Notifica a la consulta que una entidad ha sido eliminada del mundo.
     * @param {number} entity 
     */
    removeEntity(entity) {
        const currentIndex = this._indexMap.get(entity);
        if (currentIndex !== undefined) {
            const lastEntity = this.entities.pop();
            if (entity !== lastEntity) {
                this.entities[currentIndex] = lastEntity;
                this._indexMap.set(lastEntity, currentIndex);
            }
            this._indexMap.delete(entity);
        }
    }
}

// =============================================================================
// SISTEMAS DE LÓGICA (SYSTEMS)
// =============================================================================

/**
 * Clase base abstracta para implementar lógica que opera sobre consultas del ECS.
 */
export class System {
    /**
     * @param {ECSWorld} world - Referencia al mundo ECS.
     */
    constructor(world) {
        this.world = world;
        this.enabled = true;
    }

    /**
     * Inicializa componentes, consultas y recursos específicos del sistema.
     */
    init() { }

    /**
     * Paso de actualización por cuadro.
     * @param {number} time - Tiempo total en ms.
     * @param {number} delta - Tiempo transcurrido desde el último frame en ms.
     */
    update(time, delta) { }

    /**
     * Destruye y libera los recursos del sistema.
     */
    destroy() {
        this.world = null;
    }
}

// =============================================================================
// MUNDO ECS CENTRAL (ECS WORLD)
// =============================================================================

/**
 * Administrador global de entidades, componentes, sistemas y consultas.
 */
export class ECSWorld {
    /**
     * @param {number} [initialEntityPool=8192] - Capacidad inicial del grupo de entidades.
     */
    constructor(initialEntityPool = 8192) {
        this.capacity = initialEntityPool;

        // Gestión de reciclaje de entidades por generación (Previene referencias muertas)
        this.generations = new Uint16Array(this.capacity);
        this.entityMasks = [];

        for (let i = 0; i < this.capacity; i++) {
            this.entityMasks.push(new BitSet());
        }

        /** @type {Array<number>} Pila de índices liberados para reciclaje */
        this.freeList = [];
        for (let i = this.capacity - 1; i >= 0; i--) {
            this.freeList.push(i);
        }

        /** @type {Map<string, ComponentStore>} Componentes registrados */
        this.components = new Map();
        this.componentCount = 0;

        /** @type {Array<Query>} Consultas activas */
        this.queries = [];

        /** @type {Array<System>} Sistemas en orden de ejecución */
        this.systems = [];

        // Registro de componentes nativos del motor
        this.Transform = this.registerComponent('Transform', {
            x: TYPE.FLOAT32,
            y: TYPE.FLOAT32,
            rotation: TYPE.FLOAT32,
            scaleX: TYPE.FLOAT32,
            scaleY: TYPE.FLOAT32,
            originX: TYPE.FLOAT32,
            originY: TYPE.FLOAT32
        });

        this.Velocity = this.registerComponent('Velocity', {
            vx: TYPE.FLOAT32,
            vy: TYPE.FLOAT32,
            angularVelocity: TYPE.FLOAT32
        });

        this.Renderable = this.registerComponent('Renderable', {
            width: TYPE.FLOAT32,
            height: TYPE.FLOAT32,
            u0: TYPE.FLOAT32,
            v0: TYPE.FLOAT32,
            u1: TYPE.FLOAT32,
            v1: TYPE.FLOAT32,
            tint: TYPE.UINT32,
            alpha: TYPE.FLOAT32,
            textureSlot: TYPE.UINT32,
            visible: TYPE.UINT8
        });
    }

    /**
     * Registra un nuevo tipo de componente en el mundo.
     * @param {string} name 
     * @param {object} schema 
     * @returns {ComponentStore}
     */
    registerComponent(name, schema) {
        if (this.components.has(name)) {
            return this.components.get(name);
        }

        const compId = this.componentCount++;
        const store = new ComponentStore(compId, name, schema, this.capacity);
        this.components.set(name, store);
        return store;
    }

    /**
     * Expande los búferes de entidades si se agota la capacidad preasignada.
     * @private
     */
    _growEntityPool() {
        const oldCap = this.capacity;
        const newCap = oldCap * 2;

        const newGen = new Uint16Array(newCap);
        newGen.set(this.generations);
        this.generations = newGen;

        for (let i = oldCap; i < newCap; i++) {
            this.entityMasks.push(new BitSet());
            this.freeList.push(i);
        }

        for (const store of this.components.values()) {
            store.ensureCapacity(newCap);
        }

        this.capacity = newCap;
    }

    /**
     * Crea una nueva entidad en el mundo y devuelve su identificador único.
     * @returns {number} ID empaquetado de la entidad.
     */
    createEntity() {
        if (this.freeList.length === 0) {
            this._growEntityPool();
        }

        const index = this.freeList.pop();
        const generation = this.generations[index];
        this.entityMasks[index].reset();

        // Empaquetado: 12 bits de generación, 20 bits de índice
        return (generation << 20) | index;
    }

    /**
     * Destruye una entidad y devuelve su identificador al grupo de reciclaje.
     * @param {number} entity 
     */
    destroyEntity(entity) {
        const index = entity & 0xfffff;
        const gen = entity >>> 20;

        if (this.generations[index] !== gen) {
            return; // Entidad obsoleta o ya destruida
        }

        // Incrementar generación para invalidar IDs previos
        this.generations[index] = (this.generations[index] + 1) & 0xfff;
        this.entityMasks[index].reset();

        for (const store of this.components.values()) {
            store.reset(index);
        }

        for (let i = 0; i < this.queries.length; i++) {
            this.queries[i].removeEntity(entity);
        }

        this.freeList.push(index);
    }

    /**
     * Verifica si una entidad está viva y su generación corresponde.
     * @param {number} entity 
     * @returns {boolean}
     */
    isAlive(entity) {
        const index = entity & 0xfffff;
        const gen = entity >>> 20;
        return index < this.capacity && this.generations[index] === gen;
    }

    /**
     * Agrega un componente a una entidad y actualiza las consultas activas.
     * @param {number} entity 
     * @param {ComponentStore} component 
     * @param {object} [initialValues={}] 
     * @returns {this}
     */
    addComponent(entity, component, initialValues = {}) {
        const index = entity & 0xfffff;
        component.set(index, initialValues);

        const mask = this.entityMasks[index];
        mask.set(component.id);

        // Notificar a las consultas
        for (let i = 0; i < this.queries.length; i++) {
            this.queries[i].match(entity, mask);
        }

        return this;
    }

    /**
     * Remueve un componente de una entidad.
     * @param {number} entity 
     * @param {ComponentStore} component 
     * @returns {this}
     */
    removeComponent(entity, component) {
        const index = entity & 0xfffff;
        component.reset(index);

        const mask = this.entityMasks[index];
        mask.clear(component.id);

        for (let i = 0; i < this.queries.length; i++) {
            this.queries[i].match(entity, mask);
        }

        return this;
    }

    /**
     * Registra y genera una consulta de entidades reactiva basada en componentes.
     * @param {Array<ComponentStore>} allOf - Componentes obligatorios.
     * @param {Array<ComponentStore>} [noneOf=[]] - Componentes excluyentes.
     * @returns {Query}
     */
    createQuery(allOf, noneOf = []) {
        const query = new Query(this, allOf, noneOf);
        this.queries.push(query);

        // Población inicial de la consulta
        for (let i = 0; i < this.capacity; i++) {
            if (this.freeList.indexOf(i) === -1) {
                const entity = (this.generations[i] << 20) | i;
                query.match(entity, this.entityMasks[i]);
            }
        }

        return query;
    }

    /**
     * Agrega un sistema lógico a la secuencia de ejecución.
     * @param {System} system 
     * @returns {this}
     */
    addSystem(system) {
        this.systems.push(system);
        system.init();
        return this;
    }

    /**
     * Ejecuta un paso de actualización sobre todos los sistemas registrados.
     * @param {number} time 
     * @param {number} delta 
     */
    step(time, delta) {
        for (let i = 0; i < this.systems.length; i++) {
            const system = this.systems[i];
            if (system.enabled) {
                system.update(time, delta);
            }
        }
    }

    /**
     * Destruye el mundo ECS y libera todos los arreglos contiguos.
     */
    destroy() {
        for (const system of this.systems) {
            system.destroy();
        }
        this.systems.length = 0;
        this.queries.length = 0;
        this.components.clear();
        this.freeList.length = 0;
        this.entityMasks.length = 0;
        this.generations = null;
    }
}

// =============================================================================
// SISTEMAS INCORPORADOS (BUILT-IN SYSTEMS)
// =============================================================================

/**
 * Sistema de cinemática básica vectorizado. Itera directamente sobre las columnas de velocidad y transformación.
 */
export class MovementSystem extends System {
    init() {
        this.query = this.world.createQuery([this.world.Transform, this.world.Velocity]);
    }

    update(time, delta) {
        const dt = delta * 0.001;
        const entities = this.query.entities;
        const count = entities.length;

        const transform = this.world.Transform.columns;
        const velocity = this.world.Velocity.columns;

        const posX = transform.x;
        const posY = transform.y;
        const rot = transform.rotation;

        const vx = velocity.vx;
        const vy = velocity.vy;
        const angVel = velocity.angularVelocity;

        // Bucle sin llamadas intermedias ni asignaciones
        for (let i = 0; i < count; i++) {
            const idx = entities[i] & 0xfffff;
            posX[idx] += vx[idx] * dt;
            posY[idx] += vy[idx] * dt;
            rot[idx] += angVel[idx] * dt;
        }
    }
}

/**
 * Sistema que canaliza de forma masiva las entidades compatibles hacia el SpriteBatcher.
 */
export class SpriteBatchSyncSystem extends System {
    /**
     * @param {ECSWorld} world 
     * @param {import('./SpriteBatcher.js').SpriteBatcher} batcher 
     * @param {Array<import('./RendererWebGPU.js').RHITexture>} texturePool 
     */
    constructor(world, batcher, texturePool) {
        super(world);
        this.batcher = batcher;
        this.texturePool = texturePool;
    }

    init() {
        this.query = this.world.createQuery([this.world.Transform, this.world.Renderable]);
    }

    update(time, delta) {
        const entities = this.query.entities;
        const count = entities.length;

        const transform = this.world.Transform.columns;
        const renderable = this.world.Renderable.columns;

        const x = transform.x;
        const y = transform.y;
        const rot = transform.rotation;
        const sx = transform.scaleX;
        const sy = transform.scaleY;
        const ox = transform.originX;
        const oy = transform.originY;

        const w = renderable.width;
        const h = renderable.height;
        const u0 = renderable.u0;
        const v0 = renderable.v0;
        const u1 = renderable.u1;
        const v1 = renderable.v1;
        const tint = renderable.tint;
        const alpha = renderable.alpha;
        const slot = renderable.textureSlot;
        const visible = renderable.visible;

        const batcher = this.batcher;
        const textures = this.texturePool;

        for (let i = 0; i < count; i++) {
            const idx = entities[i] & 0xfffff;

            if (visible[idx] === 0 || alpha[idx] <= 0) continue;

            const tex = textures[slot[idx]];
            if (!tex) continue;

            batcher.batchQuad(
                x[idx], y[idx],
                w[idx], h[idx],
                rot[idx],
                sx[idx], sy[idx],
                ox[idx], oy[idx],
                u0[idx], v0[idx],
                u1[idx], v1[idx],
                tint[idx], alpha[idx],
                tex
            );
        }
    }
}

// =============================================================================
// CAPA DE INTEROPERABILIDAD HÍBRIDA (OOP <-> ECS ADAPTER)
// =============================================================================

/**
 * Adaptador que envuelve un ID de entidad ECS y expone la API clásica de GameObject.
 * Permite que los desarrolladores usen la sintaxis clásica de Phaser con el rendimiento subyacente del ECS.
 */
export class GameObjectECSAdapter {
    /**
     * @param {ECSWorld} world - Mundo ECS activo.
     * @param {number} entity - Identificador de la entidad vinculada.
     */
    constructor(world, entity) {
        this.world = world;
        this.entity = entity;
        this._index = entity & 0xfffff;
    }

    get x() {
        return this.world.Transform.columns.x[this._index];
    }
    set x(value) {
        this.world.Transform.columns.x[this._index] = value;
    }

    get y() {
        return this.world.Transform.columns.y[this._index];
    }
    set y(value) {
        this.world.Transform.columns.y[this._index] = value;
    }

    get rotation() {
        return this.world.Transform.columns.rotation[this._index];
    }
    set rotation(value) {
        this.world.Transform.columns.rotation[this._index] = value;
    }

    get scaleX() {
        return this.world.Transform.columns.scaleX[this._index];
    }
    set scaleX(value) {
        this.world.Transform.columns.scaleX[this._index] = value;
    }

    get scaleY() {
        return this.world.Transform.columns.scaleY[this._index];
    }
    set scaleY(value) {
        this.world.Transform.columns.scaleY[this._index] = value;
    }

    get alpha() {
        return this.world.Renderable.columns.alpha[this._index];
    }
    set alpha(value) {
        this.world.Renderable.columns.alpha[this._index] = value;
    }

    get visible() {
        return this.world.Renderable.columns.visible[this._index] === 1;
    }
    set visible(value) {
        this.world.Renderable.columns.visible[this._index] = value ? 1 : 0;
    }

    /**
     * Establece la posición en una sola llamada.
     * @param {number} x 
     * @param {number} y 
     * @returns {this}
     */
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        return this;
    }

    /**
     * Establece la escala en ambos ejes.
     * @param {number} sx 
     * @param {number} [sy=sx] 
     * @returns {this}
     */
    setScale(sx, sy = sx) {
        this.scaleX = sx;
        this.scaleY = sy;
        return this;
    }

    /**
     * Establece el ancla de origen.
     * @param {number} ox 
     * @param {number} [oy=ox] 
     * @returns {this}
     */
    setOrigin(ox, oy = ox) {
        this.world.Transform.columns.originX[this._index] = ox;
        this.world.Transform.columns.originY[this._index] = oy;
        return this;
    }

    /**
     * Asigna la velocidad lineal en el componente de movimiento.
     * @param {number} vx 
     * @param {number} vy 
     * @returns {this}
     */
    setVelocity(vx, vy) {
        this.world.Velocity.columns.vx[this._index] = vx;
        this.world.Velocity.columns.vy[this._index] = vy;
        return this;
    }

    /**
     * Destruye la entidad subyacente en el mundo ECS.
     */
    destroy() {
        this.world.destroyEntity(this.entity);
        this.world = null;
        this.entity = 0;
        this._index = 0;
    }
}