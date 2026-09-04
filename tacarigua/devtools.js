/**
 * @fileoverview Agente de telemetría, perfilado y depuración en tiempo real para Tacarigua 1.0.0.
 * @module @tacarigua/devtools
 * @license Phaser - Licencia MIT
 */

import { EventEmitter } from './core.js';
import { CORE_EVENTS } from './core.js';

// =============================================================================
// MUESTREADOR ESTADÍSTICO DE RENDIMIENTO (METRIC SAMPLER)
// =============================================================================

/**
 * Búfer circular estático de alta precisión para el registro continuo de métricas sin recolección de basura.
 */
export class MetricSampler {
    /**
     * @param {number} [sampleSize=120] - Número de muestras en la ventana de cálculo.
     */
    constructor(sampleSize = 120) {
        this.sampleSize = sampleSize;
        this.samples = new Float32Array(sampleSize);
        this.index = 0;
        this.count = 0;
    }

    /**
     * Registra una nueva muestra escalar en el búfer circular.
     * @param {number} value 
     */
    push(value) {
        this.samples[this.index] = value;
        this.index = (this.index + 1) % this.sampleSize;
        if (this.count < this.sampleSize) {
            this.count++;
        }
    }

    /**
     * Calcula la media aritmética de las muestras registradas.
     * @returns {number}
     */
    getAverage() {
        if (this.count === 0) return 0;
        let sum = 0;
        for (let i = 0; i < this.count; i++) {
            sum += this.samples[i];
        }
        return sum / this.count;
    }

    /**
     * Obtiene el valor mínimo de la ventana de muestras.
     * @returns {number}
     */
    getMin() {
        if (this.count === 0) return 0;
        let min = this.samples[0];
        for (let i = 1; i < this.count; i++) {
            if (this.samples[i] < min) min = this.samples[i];
        }
        return min;
    }

    /**
     * Obtiene el valor máximo de la ventana de muestras.
     * @returns {number}
     */
    getMax() {
        if (this.count === 0) return 0;
        let max = this.samples[0];
        for (let i = 1; i < this.count; i++) {
            if (this.samples[i] > max) max = this.samples[i];
        }
        return max;
    }

    /**
     * Reinicia el contenido del muestreador.
     */
    reset() {
        this.samples.fill(0);
        this.index = 0;
        this.count = 0;
    }
}

// =============================================================================
// PERFILADOR DE RENDIMIENTO (PERFORMANCE PROFILER)
// =============================================================================

/**
 * Mide con precisión los tiempos de ejecución de las fases del ciclo de vida del juego.
 */
export class PerformanceProfiler {
    /**
     * @param {import('./Game').Game} game - Instancia del juego.
     */
    constructor(game) {
        this.game = game;

        this.fpsSampler = new MetricSampler(120);
        this.frameTimeSampler = new MetricSampler(120);
        this.stepTimeSampler = new MetricSampler(120);
        this.renderTimeSampler = new MetricSampler(120);

        this.drawCalls = 0;
        this.quadsRendered = 0;
        this.estimatedVRAMBytes = 0;

        this._stepStartTime = 0;
        this._renderStartTime = 0;
        this._frameStartTime = 0;

        this._bindEvents();
    }

    /**
     * Vincula los ganchos de telemetría a los eventos del motor.
     * @private
     */
    _bindEvents() {
        const events = this.game.events;

        events.on(CORE_EVENTS.PRE_STEP, () => {
            this._frameStartTime = performance.now();
            this._stepStartTime = this._frameStartTime;
        });

        events.on(CORE_EVENTS.POST_STEP, () => {
            const stepDuration = performance.now() - this._stepStartTime;
            this.stepTimeSampler.push(stepDuration);
        });

        events.on(CORE_EVENTS.PRE_RENDER, () => {
            this._renderStartTime = performance.now();
            this.drawCalls = 0;
            this.quadsRendered = 0;
        });

        events.on(CORE_EVENTS.POST_RENDER, () => {
            const renderDuration = performance.now() - this._renderStartTime;
            const totalFrameDuration = performance.now() - this._frameStartTime;

            this.renderTimeSampler.push(renderDuration);
            this.frameTimeSampler.push(totalFrameDuration);
            this.fpsSampler.push(this.game.loop.actualFps);

            this._updateVRAMEstimation();
        });
    }

    /**
     * Estima el uso total de memoria de video (VRAM) en función de texturas y búferes asignados.
     * @private
     */
    _updateVRAMEstimation() {
        let totalBytes = 0;
        const renderer = this.game.renderer;

        if (renderer && renderer.driver) {
            // Texturas cargadas
            if (this.game.textures) {
                for (const key in this.game.textures.list) {
                    const tex = this.game.textures.list[key];
                    if (tex && tex.source) {
                        for (let i = 0; i < tex.source.length; i++) {
                            const src = tex.source[i];
                            // Estimación RGBA8: width * height * 4 bytes
                            totalBytes += (src.width * src.height * 4);
                        }
                    }
                }
            }

            // Búfer de vértices global
            if (renderer.globalUniformBuffer) {
                totalBytes += renderer.globalUniformBuffer.size;
            }
        }

        this.estimatedVRAMBytes = totalBytes;
    }

    /**
     * Exporta un paquete serializado liviano con las métricas actuales para DevTools.
     * @returns {object}
     */
    getSummary() {
        return {
            fps: Math.round(this.fpsSampler.getAverage()),
            fpsMin: Math.round(this.fpsSampler.getMin()),
            fpsMax: Math.round(this.fpsSampler.getMax()),
            frameTimeMs: Number(this.frameTimeSampler.getAverage().toFixed(2)),
            stepTimeMs: Number(this.stepTimeSampler.getAverage().toFixed(2)),
            renderTimeMs: Number(this.renderTimeSampler.getAverage().toFixed(2)),
            drawCalls: this.drawCalls,
            quadsRendered: this.quadsRendered,
            vramMB: Number((this.estimatedVRAMBytes / (1024 * 1024)).toFixed(2))
        };
    }
}

// =============================================================================
// CAPA VISUAL DE DEPURACIÓN EN PANTALLA (DEBUG OVERLAY)
// =============================================================================

/**
 * Renderiza gráficos visuales de diagnóstico superpuestos directamente sobre el juego.
 */
export class DebugOverlayRenderer {
    /**
     * @param {import('./Game').Game} game 
     * @param {PerformanceProfiler} profiler 
     */
    constructor(game, profiler) {
        this.game = game;
        this.profiler = profiler;

        this.visible = false;
        this.showSparkline = true;
        this.showHitboxes = false;
        this.showPhysicsAABB = false;

        /** @type {HTMLCanvasElement|null} */
        this.overlayCanvas = null;
        /** @type {CanvasRenderingContext2D|null} */
        this.overlayContext = null;

        this._createCanvas();
    }

    /**
     * Crea un lienzo transparente superpuesto en el DOM alineado al canvas principal del juego.
     * @private
     */
    _createCanvas() {
        if (typeof document === 'undefined') return;

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCanvas.style.zIndex = '999999';

        this.overlayContext = this.overlayCanvas.getContext('2d');
        this.syncDimensions();

        const parent = this.game.canvas ? this.game.canvas.parentNode : document.body;
        if (parent) {
            parent.appendChild(this.overlayCanvas);
        }

        // Suscribir al final del renderizado para dibujar la superposición
        this.game.events.on(CORE_EVENTS.POST_RENDER, this.render, this);
    }

    /**
     * Sincroniza la resolución del canvas de overlay con el lienzo principal del juego.
     */
    syncDimensions() {
        if (!this.overlayCanvas || !this.game.canvas) return;
        this.overlayCanvas.width = this.game.canvas.width;
        this.overlayCanvas.height = this.game.canvas.height;
        this.overlayCanvas.style.width = this.game.canvas.style.width;
        this.overlayCanvas.style.height = this.game.canvas.style.height;
    }

    /**
     * Dibuja los gráficos estadísticos y contornos de colisión.
     */
    render() {
        if (!this.visible || !this.overlayContext) return;

        const ctx = this.overlayContext;
        ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        if (this.showSparkline) {
            this._drawPerformanceHUD(ctx);
        }

        if (this.showHitboxes) {
            this._drawHitboxes(ctx);
        }

        if (this.showPhysicsAABB) {
            this._drawPhysicsAABB(ctx);
        }
    }

    /**
     * Dibuja la gráfica de cuadros por segundo y el texto de estado.
     * @param {CanvasRenderingContext2D} ctx 
     * @private
     */
    _drawPerformanceHUD(ctx) {
        const summary = this.profiler.getSummary();
        const x = 10;
        const y = 10;
        const width = 180;
        const height = 90;

        // Fondo oscuro semitransparente
        ctx.fillStyle = 'rgba(10, 15, 25, 0.85)';
        ctx.fillRect(x, y, width, height);

        ctx.strokeStyle = '#2a3b5c';
        ctx.strokeRect(x, y, width, height);

        // Texto informativo
        ctx.font = '10px monospace';
        ctx.fillStyle = summary.fps >= 55 ? '#00ff66' : summary.fps >= 30 ? '#ffcc00' : '#ff3333';
        ctx.fillText(`FPS: ${summary.fps} [${summary.fpsMin}-${summary.fpsMax}]`, x + 8, y + 16);

        ctx.fillStyle = '#ffffff';
        ctx.fillText(`Frame: ${summary.frameTimeMs} ms`, x + 8, y + 30);
        ctx.fillText(`CPU: ${summary.stepTimeMs} ms | GPU: ${summary.renderTimeMs} ms`, x + 8, y + 44);
        ctx.fillText(`DrawCalls: ${summary.drawCalls} | Quads: ${summary.quadsRendered}`, x + 8, y + 58);
        ctx.fillText(`VRAM Est: ${summary.vramMB} MB`, x + 8, y + 72);

        // Gráfica de línea (Sparkline de FPS)
        const samples = this.profiler.fpsSampler.samples;
        const count = this.profiler.fpsSampler.count;
        const graphX = x + 8;
        const graphY = y + 84;
        const graphWidth = width - 16;
        const graphHeight = 10;

        ctx.strokeStyle = '#00ffff';
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
            const val = samples[i];
            const px = graphX + (i / count) * graphWidth;
            const py = graphY - (Math.min(val, 120) / 120) * graphHeight;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    /**
     * Dibuja los bordes interactivos de los objetos en escena.
     * @param {CanvasRenderingContext2D} ctx 
     * @private
     */
    _drawHitboxes(ctx) {
        if (!this.game.scene) return;

        ctx.save();
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 1;

        const scenes = this.game.scene.getScenes(true);
        for (const scene of scenes) {
            const children = scene.children?.list || [];
            for (const child of children) {
                if (child.input && child.input.enabled) {
                    const bounds = child.getBounds ? child.getBounds() : null;
                    if (bounds) {
                        ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
                    }
                }
            }
        }
        ctx.restore();
    }

    /**
     * Dibuja las cajas delimitadoras de física de los cuerpos rígidos.
     * @param {CanvasRenderingContext2D} ctx 
     * @private
     */
    _drawPhysicsAABB(ctx) {
        // Enlace automático con el gestor de físicas activas
        const physicsBridge = this.game.physicsWorkerBridge;
        if (!physicsBridge || !physicsBridge.bodyData) return;

        ctx.save();
        ctx.strokeStyle = '#ff0055';
        ctx.lineWidth = 1;

        const bodies = physicsBridge.bodyData;
        const count = physicsBridge.activeBodiesCount;
        const stride = 16; // BODY_STRIDE

        for (let i = 0; i < count; i++) {
            const offset = i * stride;
            const x = bodies[offset + 0]; // POS_X
            const y = bodies[offset + 1]; // POS_Y
            const w = bodies[offset + 6]; // WIDTH
            const h = bodies[offset + 7]; // HEIGHT

            ctx.strokeRect(x - w * 0.5, y - h * 0.5, w, h);
        }
        ctx.restore();
    }

    /**
     * Destruye el lienzo de superposición.
     */
    destroy() {
        this.game.events.off(CORE_EVENTS.POST_RENDER, this.render, this);
        if (this.overlayCanvas && this.overlayCanvas.parentNode) {
            this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
        }
        this.overlayCanvas = null;
        this.overlayContext = null;
        this.profiler = null;
        this.game = null;
    }
}

// =============================================================================
// AGENTE PRINCIPAL DE DEVTOOLS (DEVTOOLS AGENT)
// =============================================================================

/**
 * Agente orquestador de telemetría y puente de comunicación bidireccional con DevTools.
 */
export class DevToolsAgent extends EventEmitter {
    /**
     * @param {import('./Game').Game} game - Instancia del motor Phaser.
     */
    constructor(game) {
        super();

        this.game = game;
        this.profiler = new PerformanceProfiler(game);
        this.overlay = new DebugOverlayRenderer(game, this.profiler);

        this.enabled = true;
        this.telemetryIntervalMs = 250; // Emisión a 4 Hz hacia la extensión
        this._intervalHandle = null;

        this._registerGlobalHook();
        this._startTelemetryStream();
        this._bindExtensionMessages();
    }

    /**
     * Registra el hook global estandarizado en window para que las extensiones detecten Tacarigua 1.0.0.
     * @private
     */
    _registerGlobalHook() {
        if (typeof window === 'undefined') return;

        window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__ = window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__ || {
            version: '1.0.0',
            games: new Set(),
            register: (gameInstance) => {
                window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__.games.add(gameInstance);
            },
            unregister: (gameInstance) => {
                window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__.games.delete(gameInstance);
            }
        };

        window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__.register(this.game);
    }

    /**
     * Inicia la transmisión periódica de paquetes de telemetría hacia las DevTools.
     * @private
     */
    _startTelemetryStream() {
        if (typeof window === 'undefined') return;

        this._intervalHandle = setInterval(() => {
            if (!this.enabled) return;

            const summary = this.profiler.getSummary();
            const message = {
                source: 'tacarigua-devtools-agent',
                type: 'TELEMETRY_TICK',
                payload: {
                    metrics: summary,
                    sceneCount: this.game.scene ? this.game.scene.scenes.length : 0,
                    ecsEntityCount: this.game.ecsWorld ? this.game.ecsWorld.capacity - this.game.ecsWorld.freeList.length : 0
                }
            };

            window.postMessage(message, '*');
            this.emit('telemetry', message.payload);
        }, this.telemetryIntervalMs);
    }

    /**
     * Escucha comandos entrantes desde la extensión de DevTools para inspección o mutación en vivo.
     * @private
     */
    _bindExtensionMessages() {
        if (typeof window === 'undefined') return;

        window.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data.source !== 'tacarigua-devtools-panel') return;

            switch (data.command) {
                case 'TOGGLE_OVERLAY':
                    this.overlay.visible = !this.overlay.visible;
                    break;
                case 'TOGGLE_HITBOXES':
                    this.overlay.showHitboxes = Boolean(data.value);
                    break;
                case 'TOGGLE_PHYSICS_AABB':
                    this.overlay.showPhysicsAABB = Boolean(data.value);
                    break;
                case 'INSPECT_SCENES':
                    this._sendSceneTreeSnapshot();
                    break;
                case 'MUTATE_GAMEOBJECT':
                    this._mutateGameObject(data.sceneKey, data.gameObjectId, data.property, data.value);
                    break;
            }
        });
    }

    /**
     * Serializa y despacha la jerarquía del árbol de escenas activa a DevTools.
     * @private
     */
    _sendSceneTreeSnapshot() {
        if (!this.game.scene) return;

        const scenesPayload = [];
        const activeScenes = this.game.scene.getScenes(false);

        for (const scene of activeScenes) {
            const sceneData = {
                key: scene.sys.settings.key,
                status: scene.sys.settings.status,
                children: []
            };

            const children = scene.children?.list || [];
            for (const child of children) {
                sceneData.children.push({
                    id: child.name || child.type,
                    type: child.type,
                    x: child.x,
                    y: child.y,
                    rotation: child.rotation,
                    scaleX: child.scaleX,
                    scaleY: child.scaleY,
                    alpha: child.alpha,
                    visible: child.visible
                });
            }
            scenesPayload.push(sceneData);
        }

        window.postMessage({
            source: 'tacarigua-devtools-agent',
            type: 'SCENE_TREE_SNAPSHOT',
            payload: scenesPayload
        }, '*');
    }

    /**
     * Modifica en caliente una propiedad sobre un GameObject inspeccionado.
     * @private
     */
    _mutateGameObject(sceneKey, gameObjectId, property, value) {
        const scene = this.game.scene.getScene(sceneKey);
        if (!scene || !scene.children) return;

        const child = scene.children.list.find(c => (c.name || c.type) === gameObjectId);
        if (child && property in child) {
            child[property] = value;
        }
    }

    /**
     * Destruye el agente de telemetría y desconecta los canales de comunicación.
     */
    destroy() {
        this.enabled = false;
        if (this._intervalHandle) {
            clearInterval(this._intervalHandle);
            this._intervalHandle = null;
        }

        if (typeof window !== 'undefined' && window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__) {
            window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__.unregister(this.game);
        }

        this.overlay.destroy();
        this.removeAllListeners();
        this.overlay = null;
        this.profiler = null;
        this.game = null;
    }
}