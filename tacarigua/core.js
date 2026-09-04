/**
 * @fileoverview Núcleo principal y orquestador del ciclo de vida de Tacarigua 1.0.0.
 * @module @tacarigua/core
 * @license Phaser - Licencia MIT
 */

// =============================================================================
// CONSTANTES GLOBALES Y TIPOS DE RENDERIZADO
// =============================================================================

/**
 * Metadatos de versión y constantes fundamentales del motor para la versión 1.0.0.
 */
export const VERSION = '1.0.0';
export const LOG_VERSION = 'v1.0.0';

/**
 * Modos de renderizado compatibles con la arquitectura RHI (Render Hardware Interface).
 * Se introduce WEBGPU como renderizador de primera clase.
 * @enum {number}
 */
export const RENDER_TYPE = Object.freeze({
    AUTO: 0,
    CANVAS: 1,
    WEBGL: 2,
    HEADLESS: 3,
    WEBGPU: 4
});

/**
 * Modos de fusión de color (Blend Modes) soportados.
 * @enum {number}
 */
export const BLEND_MODE = Object.freeze({
    SKIP_CHECK: -1,
    NORMAL: 0,
    ADD: 1,
    MULTIPLY: 2,
    SCREEN: 3,
    OVERLAY: 4,
    DARKEN: 5,
    LIGHTEN: 6,
    COLOR_DODGE: 7,
    COLOR_BURN: 8,
    HARD_LIGHT: 9,
    SOFT_LIGHT: 10,
    DIFFERENCE: 11,
    EXCLUSION: 12,
    HUE: 13,
    SATURATION: 14,
    COLOR: 15,
    LUMINOSITY: 16,
    ERASE: 17
});

/**
 * Modos de escalamiento de pantalla del lienzo.
 * @enum {number}
 */
export const SCALE_MODE = Object.freeze({
    NONE: 0,
    WIDTH_CONTROLS_HEIGHT: 1,
    HEIGHT_CONTROLS_WIDTH: 2,
    FIT: 3,
    ENVELOP: 4,
    RESIZE: 5,
    EXPAND: 6
});

/**
 * Eventos del Ciclo de Vida del Motor.
 * @enum {string}
 */
export const CORE_EVENTS = Object.freeze({
    BOOT: 'boot',
    READY: 'ready',
    PRE_STEP: 'prestep',
    STEP: 'step',
    POST_STEP: 'poststep',
    PRE_RENDER: 'prerender',
    POST_RENDER: 'postrender',
    PAUSE: 'pause',
    RESUME: 'resume',
    BLUR: 'blur',
    FOCUS: 'focus',
    HIDDEN: 'hidden',
    VISIBLE: 'visible',
    RESIZE: 'resize',
    CONTEXT_LOST: 'contextlost',
    CONTEXT_RESTORED: 'contextrestored',
    DESTROY: 'destroy'
});

// =============================================================================
// SISTEMA DE SEÑALES REACTIVAS Y EVENTOS (TREE-SHAKEABLE)
// =============================================================================

/**
 * Nodo de enlace para la lista enlazada interna de un Signal.
 */
class SignalBinding {
    /**
     * @param {Function} fn - Función receptora.
     * @param {*} context - Contexto 'this' de ejecución.
     * @param {boolean} once - Si debe ejecutarse únicamente una vez.
     */
    constructor(fn, context, once = false) {
        this.fn = fn;
        this.context = context;
        this.once = once;
        this.next = null;
        this.prev = null;
    }
}

/**
 * Sistema reactivo liviano basado en Señales sin asignación de cadenas de texto.
 * Optimiza la sincronización de estado y la comunicación directa entre subsistemas.
 */
export class Signal {
    constructor() {
        /** @type {SignalBinding|null} */
        this._head = null;
        /** @type {SignalBinding|null} */
        this._tail = null;
        this._count = 0;
    }

    /**
     * Suscribe un callback a la señal.
     * @param {Function} fn - Función a ejecutar.
     * @param {*} [context=null] - Contexto de ejecución.
     * @returns {SignalBinding}
     */
    add(fn, context = null) {
        const binding = new SignalBinding(fn, context, false);
        if (!this._head) {
            this._head = binding;
            this._tail = binding;
        } else {
            this._tail.next = binding;
            binding.prev = this._tail;
            this._tail = binding;
        }
        this._count++;
        return binding;
    }

    /**
     * Suscribe un callback a la señal para una única ejecución.
     * @param {Function} fn - Función a ejecutar.
     * @param {*} [context=null] - Contexto de ejecución.
     * @returns {SignalBinding}
     */
    addOnce(fn, context = null) {
        const binding = this.add(fn, context);
        binding.once = true;
        return binding;
    }

    /**
     * Remueve un enlace específico de la señal.
     * @param {SignalBinding} binding 
     * @returns {boolean}
     */
    detach(binding) {
        if (!binding) return false;
        if (binding.prev) binding.prev.next = binding.next;
        if (binding.next) binding.next.prev = binding.prev;
        if (binding === this._head) this._head = binding.next;
        if (binding === this._tail) this._tail = binding.prev;
        binding.prev = null;
        binding.next = null;
        this._count--;
        return true;
    }

    /**
     * Emite la señal pasando argumentos variables con sobrecarga cero.
     * @param {...*} args
     */
    dispatch(...args) {
        let node = this._head;
        while (node) {
            const nextNode = node.next;
            node.fn.apply(node.context, args);
            if (node.once) {
                this.detach(node);
            }
            node = nextNode;
        }
    }

    /**
     * Elimina todos los listeners de la señal.
     */
    clear() {
        let node = this._head;
        while (node) {
            const next = node.next;
            node.prev = null;
            node.next = null;
            node = next;
        }
        this._head = null;
        this._tail = null;
        this._count = 0;
    }

    get hasListeners() {
        return this._count > 0;
    }
}

/**
 * Gestor de eventos optimizado con soporte a canales de eventos y nombres arbitrarios.
 */
export class EventEmitter {
    constructor() {
        /** @type {Map<string, Signal>} */
        this._events = new Map();
    }

    /**
     * Escucha un evento.
     * @param {string} event 
     * @param {Function} fn 
     * @param {*} [context=null] 
     * @returns {this}
     */
    on(event, fn, context = null) {
        let signal = this._events.get(event);
        if (!signal) {
            signal = new Signal();
            this._events.set(event, signal);
        }
        signal.add(fn, context);
        return this;
    }

    /**
     * Escucha un evento una sola vez.
     * @param {string} event 
     * @param {Function} fn 
     * @param {*} [context=null] 
     * @returns {this}
     */
    once(event, fn, context = null) {
        let signal = this._events.get(event);
        if (!signal) {
            signal = new Signal();
            this._events.set(event, signal);
        }
        signal.addOnce(fn, context);
        return this;
    }

    /**
     * Emite un evento a todos sus suscriptores.
     * @param {string} event 
     * @param {...*} args 
     * @returns {boolean}
     */
    emit(event, ...args) {
        const signal = this._events.get(event);
        if (!signal || !signal.hasListeners) {
            return false;
        }
        signal.dispatch(...args);
        return true;
    }

    /**
     * Remueve los listeners de un evento o función específica.
     * @param {string} event 
     * @param {Function} [fn=null] 
     * @param {*} [context=null] 
     * @returns {this}
     */
    off(event, fn = null, context = null) {
        const signal = this._events.get(event);
        if (!signal) return this;

        if (!fn) {
            signal.clear();
            this._events.delete(event);
            return this;
        }

        let node = signal._head;
        while (node) {
            const next = node.next;
            if (node.fn === fn && (!context || node.context === context)) {
                signal.detach(node);
            }
            node = next;
        }

        if (!signal.hasListeners) {
            this._events.delete(event);
        }
        return this;
    }

    /**
     * Limpia completamente el bus de eventos.
     * @returns {this}
     */
    removeAllListeners() {
        for (const signal of this._events.values()) {
            signal.clear();
        }
        this._events.clear();
        return this;
    }
}

// =============================================================================
// GESTOR DE TIEMPO Y LOOP PRINCIPAL (TIMESTEP)
// =============================================================================

/**
 * Clase encargada del pulso temporal del motor (Game Loop).
 * Implementa delta smoothing sin recolección de basura utilizando un TypedArray en búfer circular,
 * garantizando precisión en altas tasas de refresco (120Hz/144Hz/240Hz).
 */
export class TimeStep {
    /**
     * @param {Game} game - Instancia del motor Tacarigua.
     * @param {object} [config={}] - Opciones de configuración del loop.
     */
    constructor(game, config = {}) {
        this.game = game;

        this.started = false;
        this.running = false;

        this.minFps = config.minFps ?? 5;
        this.targetFps = config.targetFps ?? 60;
        this.fpsLimit = config.fpsLimit ?? 0;

        this._hasFpsLimit = this.fpsLimit > 0;
        this._limitRate = this._hasFpsLimit ? 1000 / this.fpsLimit : 0;
        this._minInterval = 1000 / this.minFps;
        this._targetInterval = 1000 / this.targetFps;

        this.actualFps = this.targetFps;
        this.nextFpsUpdate = 0;
        this.framesThisSecond = 0;

        /** @type {Function} */
        this.callback = () => { };

        this.forceSetTimeout = config.forceSetTimeout ?? false;

        // Tiempos absolutos en milisegundos de alta resolución
        this.time = 0;
        this.startTime = 0;
        this.lastTime = 0;
        this.frame = 0;
        this.inFocus = true;

        this.pauseDuration = 0;
        this._pauseTime = 0;
        this._coolDown = 0;

        this.delta = 0;
        this.rawDelta = 0;
        this.now = 0;
        this.smoothStep = config.smoothStep ?? true;

        // Optimización v1.0.0: Memoria estática mediante Float64Array para suprimir asignaciones GC
        this.deltaSmoothingMax = config.deltaHistory ?? 10;
        this.deltaHistory = new Float64Array(this.deltaSmoothingMax);
        this.deltaIndex = 0;
        this.panicMax = config.panicMax ?? 120;

        // Identificador de la solicitud de frame activa (compatible con Web Workers o Window)
        this._rafHandle = null;

        // Bindings optimizados para el bucle de ejecución
        this._stepInternal = this._stepInternal.bind(this);
        this._stepLimitFPS = this._stepLimitFPS.bind(this);
    }

    /**
     * Inicializa el bucle temporal.
     * @param {Function} callback - Método ejecutado en cada paso del loop.
     */
    start(callback) {
        if (this.started) return;

        this.started = true;
        this.running = true;
        this.callback = callback;

        const initialNow = this.getPerformanceNow();
        this.deltaHistory.fill(this._targetInterval);
        this.resetDelta(initialNow);
        this.startTime = initialNow;

        this.requestNextFrame();
    }

    /**
     * Obtiene el tiempo actual de alta precisión de forma segura según el entorno.
     * @returns {number}
     */
    getPerformanceNow() {
        if (typeof performance !== 'undefined' && performance.now) {
            return performance.now();
        }
        return Date.now();
    }

    /**
     * Planifica el próximo cuadro garantizando soporte para OffscreenCanvas y Workers.
     */
    requestNextFrame() {
        if (!this.running) return;

        const loopFn = this._hasFpsLimit ? this._stepLimitFPS : this._stepInternal;

        if (this.forceSetTimeout) {
            this._rafHandle = setTimeout(() => {
                loopFn(this.getPerformanceNow());
            }, this._hasFpsLimit ? this._limitRate : 0);
        } else if (typeof requestAnimationFrame !== 'undefined') {
            this._rafHandle = requestAnimationFrame(loopFn);
        } else {
            // Entorno servidor / Headless worker
            this._rafHandle = setTimeout(() => {
                loopFn(this.getPerformanceNow());
            }, this._targetInterval);
        }
    }

    /**
     * Cancela la planificación del próximo cuadro.
     */
    cancelNextFrame() {
        if (this._rafHandle === null) return;

        if (this.forceSetTimeout || typeof requestAnimationFrame === 'undefined') {
            clearTimeout(this._rafHandle);
        } else {
            cancelAnimationFrame(this._rafHandle);
        }
        this._rafHandle = null;
    }

    /**
     * Suaviza la fluctuación del delta temporal aplicando una ventana circular estática.
     * @param {number} delta 
     * @returns {number}
     */
    smoothDelta(delta) {
        const historySize = this.deltaSmoothingMax;
        const history = this.deltaHistory;

        if (this._coolDown > 0 || !this.inFocus) {
            this._coolDown--;
            delta = Math.min(delta, this._targetInterval);
        }

        if (delta > this._minInterval) {
            delta = Math.min(history[this.deltaIndex], this._minInterval);
        }

        history[this.deltaIndex] = delta;
        this.deltaIndex = (this.deltaIndex + 1) % historySize;

        let accum = 0;
        for (let i = 0; i < historySize; i++) {
            accum += history[i];
        }

        return accum / historySize;
    }

    /**
     * Reinicia el acumulador de delta y el contador de pánico.
     * @param {number} [timeNow]
     */
    resetDelta(timeNow = this.getPerformanceNow()) {
        this.time = timeNow;
        this.lastTime = timeNow;
        this.nextFpsUpdate = timeNow + 1000;
        this.framesThisSecond = 0;
        this.delta = 0;
        this.deltaIndex = 0;
        this._coolDown = this.panicMax;
    }

    /**
     * Actualiza la tasa de cuadros por segundo calculada.
     * @param {number} timeNow 
     */
    updateFPS(timeNow) {
        this.actualFps = 0.25 * this.framesThisSecond + 0.75 * this.actualFps;
        this.nextFpsUpdate = timeNow + 1000;
        this.framesThisSecond = 0;
    }

    /**
     * Paso de ejecución regular desacoplado de asignaciones de memoria.
     * @param {number} timeNow 
     * @private
     */
    _stepInternal(timeNow) {
        this.now = timeNow;
        let delta = Math.max(0, timeNow - this.lastTime);

        this.rawDelta = delta;
        this.time += delta;

        if (this.smoothStep) {
            delta = this.smoothDelta(delta);
        }

        this.delta = delta;

        if (timeNow >= this.nextFpsUpdate) {
            this.updateFPS(timeNow);
        }

        this.framesThisSecond++;
        this.lastTime = timeNow;
        this.frame++;

        this.callback(timeNow, delta);

        this.requestNextFrame();
    }

    /**
     * Paso de ejecución con límite de FPS activo.
     * @param {number} timeNow 
     * @private
     */
    _stepLimitFPS(timeNow) {
        this.now = timeNow;
        const raw = Math.max(0, timeNow - this.lastTime);

        this.rawDelta = raw;
        this.time += raw;

        let delta = raw;
        if (this.smoothStep) {
            delta = this.smoothDelta(delta);
        }

        this.delta += delta;

        if (timeNow >= this.nextFpsUpdate) {
            this.updateFPS(timeNow);
        }

        this.framesThisSecond++;

        if (this.delta >= this._limitRate) {
            this.callback(timeNow, this.delta);
            this.delta %= this._limitRate;
        }

        this.lastTime = timeNow;
        this.frame++;

        this.requestNextFrame();
    }

    /**
     * Pausa temporalmente el avance del loop.
     */
    pause() {
        this._pauseTime = this.getPerformanceNow();
    }

    /**
     * Reanuda el cálculo de deltas tras una pausa.
     */
    resume() {
        const now = this.getPerformanceNow();
        this.resetDelta(now);
        this.pauseDuration = now - this._pauseTime;
        this.startTime += this.pauseDuration;
    }

    /**
     * Detiene el loop.
     */
    stop() {
        this.running = false;
        this.started = false;
        this.cancelNextFrame();
    }

    /**
     * Destruye el subsistema y libera referencias.
     */
    destroy() {
        this.stop();
        this.callback = () => { };
        this.game = null;
        this.deltaHistory = null;
    }
}

// =============================================================================
// PARSEADOR Y GESTOR DE CONFIGURACIÓN (`Config`)
// =============================================================================

/**
 * Normaliza y valida el objeto de configuración inicial de Tacarigua 1.0.0.
 */
export class Config {
    /**
     * @param {object} [userConfig={}] - Opciones provistas por el desarrollador.
     */
    constructor(userConfig = {}) {
        const scale = userConfig.scale || {};
        const render = userConfig.render || {};
        const physics = userConfig.physics || {};

        // Dimensiones del juego
        this.width = scale.width ?? userConfig.width ?? 1024;
        this.height = scale.height ?? userConfig.height ?? 768;
        this.zoom = scale.zoom ?? userConfig.zoom ?? 1;
        this.parent = scale.parent ?? userConfig.parent ?? null;
        this.scaleMode = scale.mode ?? userConfig.scaleMode ?? SCALE_MODE.NONE;
        this.autoCenter = scale.autoCenter ?? 0;
        this.expandParent = scale.expandParent ?? true;

        // Tipo de Renderizado primario
        this.renderType = userConfig.type ?? RENDER_TYPE.AUTO;

        // Configuración específica de Render
        this.transparent = render.transparent ?? false;
        this.clearBeforeRender = render.clearBeforeRender ?? true;
        this.antialias = render.antialias ?? true;
        this.pixelArt = render.pixelArt ?? false;
        this.roundPixels = render.roundPixels ?? false;
        this.powerPreference = render.powerPreference ?? 'high-performance';
        this.batchSize = render.batchSize ?? 16384;
        this.maxTextures = render.maxTextures ?? -1;

        // Opciones avanzadas para WebGPU (Tacarigua v1.0.0)
        this.preferWebGPU = render.preferWebGPU ?? true;
        this.useComputeShaders = render.useComputeShaders ?? false;

        if (this.pixelArt) {
            this.antialias = false;
            this.roundPixels = true;
        }

        // Color de Fondo
        this.backgroundColor = userConfig.backgroundColor ?? 0x000000;

        // Frecuencia de actualización y Loop
        this.fps = {
            minFps: userConfig.fps?.min ?? 5,
            targetFps: userConfig.fps?.target ?? 60,
            fpsLimit: userConfig.fps?.limit ?? 0,
            smoothStep: userConfig.fps?.smoothStep ?? true,
            panicMax: userConfig.fps?.panicMax ?? 120,
            deltaHistory: userConfig.fps?.deltaHistory ?? 10,
            forceSetTimeout: userConfig.fps?.forceSetTimeout ?? false
        };

        // Arquitectura de Audio
        this.audio = userConfig.audio || {};

        // Entorno y Contenedores DOM
        this.canvas = userConfig.canvas ?? null;
        this.canvasStyle = userConfig.canvasStyle ?? null;
        this.customEnvironment = userConfig.customEnvironment ?? false;
        this.domCreateContainer = userConfig.dom?.createContainer ?? false;
        this.domPointerEvents = userConfig.dom?.pointerEvents ?? 'none';

        // Escenas y Físicas
        this.sceneConfig = userConfig.scene ?? null;
        this.physics = physics;
        this.defaultPhysicsSystem = physics.default ?? 'arcade';

        // Opciones del Cargador (Loader)
        const loader = userConfig.loader || {};
        this.loaderBaseURL = loader.baseURL ?? '';
        this.loaderPath = loader.path ?? '';
        this.loaderMaxParallelDownloads = loader.maxParallelDownloads ?? 32;

        // Callbacks de inicialización
        this.preBoot = userConfig.callbacks?.preBoot ?? (() => { });
        this.postBoot = userConfig.callbacks?.postBoot ?? (() => { });
    }
}

// =============================================================================
// NÚCLEO CENTRAL DEL MOTOR (`Game`)
// =============================================================================

/**
 * Instancia raíz de un videojuego en Tacarigua 1.0.0.
 * Conduce los subsistemas, controla la integración con la ventana/worker,
 * distribuye el ciclo de vida por fotograma y administra la destrucción segura.
 */
export class Game {
    /**
     * Crea e inicializa una nueva instancia del motor Phaser.
     * @param {object} [gameConfig={}] - Opciones de configuración de la aplicación.
     */
    constructor(gameConfig = {}) {
        this.config = new Config(gameConfig);

        /** @type {EventEmitter} - Emisor global de eventos del ciclo de vida del juego */
        this.events = new EventEmitter();

        /** @type {HTMLCanvasElement|OffscreenCanvas|null} */
        this.canvas = null;

        /** @type {RenderingContext|null} */
        this.context = null;

        /** @type {object|null} Capa de Renderizado (RHI / WebGPU / WebGL2 / Canvas) */
        this.renderer = null;

        /** @type {HTMLElement|null} */
        this.domContainer = null;

        // Flags de control de estado del ciclo de vida
        this.isBooted = false;
        this.isRunning = false;
        this.isPaused = false;
        this.hasFocus = true;
        this.pendingDestroy = false;
        this.removeCanvasOnDestroy = false;

        // Subsistemas (se integran desacoplados en el proceso de Boot)
        this.textures = null;
        this.scene = null;
        this.scale = null;
        this.sound = null;
        this.input = null;
        this.plugins = null;

        // Loop temporal
        this.loop = new TimeStep(this, this.config.fps);

        // Control de listeners de entorno
        this._onVisibilityChange = this._onVisibilityChange.bind(this);
        this._onWindowBlur = this._onWindowBlur.bind(this);
        this._onWindowFocus = this._onWindowFocus.bind(this);

        // Disparo asíncrono controlado del arranque
        this._initEnvironment();
    }

    /**
     * Determina el entorno de ejecución (DOM tradicional vs Web Worker / Node)
     * e inicia la secuencia de arranque.
     * @private
     */
    _initEnvironment() {
        if (typeof document === 'undefined') {
            // Entorno Offscreen / Web Worker / Servidor
            this.boot();
            return;
        }

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            queueMicrotask(() => this.boot());
        } else {
            const onReady = () => {
                document.removeEventListener('DOMContentLoaded', onReady);
                window.removeEventListener('load', onReady);
                this.boot();
            };
            document.addEventListener('DOMContentLoaded', onReady, { once: true });
            window.addEventListener('load', onReady, { once: true });
        }
    }

    /**
     * Secuencia de arranque del juego (Boot sequence).
     * Prepara el canvas, resuelve el renderizador correspondiente y emite el evento BOOT.
     */
    boot() {
        if (this.isBooted) return;
        this.isBooted = true;

        this.config.preBoot(this);

        this._setupCanvas();
        this._setupEnvironmentListeners();

        this.events.emit(CORE_EVENTS.BOOT);

        // Inicio inmediato del loop principal
        this.start();
    }

    /**
     * Inicializa el lienzo según la configuración provista.
     * @private
     */
    _setupCanvas() {
        const cfg = this.config;

        if (cfg.canvas) {
            this.canvas = cfg.canvas;
        } else if (typeof document !== 'undefined') {
            this.canvas = document.createElement('canvas');
            if (cfg.canvasStyle) {
                Object.assign(this.canvas.style, cfg.canvasStyle);
            }

            const targetParent = typeof cfg.parent === 'string'
                ? document.getElementById(cfg.parent)
                : cfg.parent;

            const container = targetParent || document.body;
            container.appendChild(this.canvas);
        }

        if (this.canvas) {
            this.canvas.width = cfg.width;
            this.canvas.height = cfg.height;
        }
    }

    /**
     * Vincula los listeners de visibilidad y foco del sistema operativo / ventana.
     * @private
     */
    _setupEnvironmentListeners() {
        if (typeof document === 'undefined') return;

        document.addEventListener('visibilitychange', this._onVisibilityChange, false);
        window.addEventListener('blur', this._onWindowBlur, false);
        window.addEventListener('focus', this._onWindowFocus, false);
    }

    /**
     * Manejador para el evento 'visibilitychange'.
     * @private
     */
    _onVisibilityChange() {
        if (document.hidden) {
            this.loop.pause();
            this.events.emit(CORE_EVENTS.HIDDEN);
            this.events.emit(CORE_EVENTS.PAUSE);
        } else {
            this.loop.resume();
            this.events.emit(CORE_EVENTS.VISIBLE);
            this.events.emit(CORE_EVENTS.RESUME, this.loop.pauseDuration);
        }
    }

    /**
     * Manejador para la pérdida de foco de la ventana.
     * @private
     */
    _onWindowBlur() {
        this.hasFocus = false;
        this.loop.inFocus = false;
        this.events.emit(CORE_EVENTS.BLUR);
    }

    /**
     * Manejador para la recuperación de foco de la ventana.
     * @private
     */
    _onWindowFocus() {
        this.hasFocus = true;
        this.loop.inFocus = true;
        this.loop.resetDelta();
        this.events.emit(CORE_EVENTS.FOCUS);
    }

    /**
     * Inicia formalmente el loop de ejecución continuo del juego.
     */
    start() {
        this.isRunning = true;
        this.config.postBoot(this);

        this.events.emit(CORE_EVENTS.READY);

        const tickMethod = this.renderer ? this.step.bind(this) : this.headlessStep.bind(this);
        this.loop.start(tickMethod);
    }

    /**
     * Paso de simulación completo: Lógica + Renderizado visual.
     * @param {number} time - Marca de tiempo absoluta en ms.
     * @param {number} delta - Tiempo transcurrido desde el último fotograma en ms.
     */
    step(time, delta) {
        if (this.pendingDestroy) {
            this._executeDestroy();
            return;
        }

        if (this.isPaused) return;

        const events = this.events;

        // Fase 1: Pre-actualización de la simulación
        events.emit(CORE_EVENTS.PRE_STEP, time, delta);

        // Fase 2: Actualización de lógica (sistemas de escena, físicas y scripts)
        events.emit(CORE_EVENTS.STEP, time, delta);
        if (this.scene) {
            this.scene.update(time, delta);
        }

        // Fase 3: Post-actualización
        events.emit(CORE_EVENTS.POST_STEP, time, delta);

        // Fase 4: Pipeline de renderizado (RHI / WebGPU / WebGL2)
        const renderer = this.renderer;
        if (renderer) {
            renderer.preRender();
            events.emit(CORE_EVENTS.PRE_RENDER, renderer, time, delta);

            if (this.scene) {
                this.scene.render(renderer);
            }

            renderer.postRender();
            events.emit(CORE_EVENTS.POST_RENDER, renderer, time, delta);
        }
    }

    /**
     * Paso de simulación headless (ideal para servidores de juego o Web Workers dedicados).
     * @param {number} time - Marca de tiempo absoluta en ms.
     * @param {number} delta - Tiempo transcurrido en ms.
     */
    headlessStep(time, delta) {
        if (this.pendingDestroy) {
            this._executeDestroy();
            return;
        }

        if (this.isPaused) return;

        const events = this.events;

        events.emit(CORE_EVENTS.PRE_STEP, time, delta);
        events.emit(CORE_EVENTS.STEP, time, delta);

        if (this.scene) {
            this.scene.update(time, delta);
        }

        events.emit(CORE_EVENTS.POST_STEP, time, delta);
    }

    /**
     * Pausa el ciclo de ejecución de la simulación lógica y render.
     */
    pause() {
        if (!this.isPaused) {
            this.isPaused = true;
            this.events.emit(CORE_EVENTS.PAUSE);
        }
    }

    /**
     * Reanuda la ejecución del motor.
     */
    resume() {
        if (this.isPaused) {
            this.isPaused = false;
            this.loop.resetDelta();
            this.events.emit(CORE_EVENTS.RESUME, 0);
        }
    }

    /**
     * Solicita la detención ordenada y destrucción de todas las instancias del juego.
     * @param {boolean} [removeCanvas=false] - Si se debe remover el elemento canvas del árbol DOM.
     */
    destroy(removeCanvas = false) {
        this.pendingDestroy = true;
        this.removeCanvasOnDestroy = removeCanvas;
    }

    /**
     * Proceso destructivo ejecutado de forma síncrona al final de un frame seguro.
     * @private
     */
    _executeDestroy() {
        this.isRunning = false;
        this.loop.destroy();

        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            window.removeEventListener('blur', this._onWindowBlur);
            window.removeEventListener('focus', this._onWindowFocus);
        }

        if (this.scene) {
            this.scene.destroy();
            this.scene = null;
        }

        this.events.emit(CORE_EVENTS.DESTROY);
        this.events.removeAllListeners();

        if (this.renderer) {
            this.renderer.destroy();
            this.renderer = null;
        }

        if (this.removeCanvasOnDestroy && this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }

        if (this.domContainer && this.domContainer.parentNode) {
            this.domContainer.parentNode.removeChild(this.domContainer);
            this.domContainer = null;
        }

        this.canvas = null;
        this.context = null;
        this.pendingDestroy = false;
    }
}