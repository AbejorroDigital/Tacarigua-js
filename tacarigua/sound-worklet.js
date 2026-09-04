/**
 * @fileoverview Subsistema de audio espacial 2D/3D basado en AudioWorklet para Tacarigua 1.0.0.
 * @module @tacarigua/sound-worklet
 * @license Phaser - Licencia MIT
 */

import { EventEmitter } from './core.js';

// =============================================================================
// CÓDIGO FUENTE DEL PROCESADOR DE AUDIOWORKLET (INLINE WORKLET SCRIPT)
// =============================================================================

/**
 * Código ejecutable que reside y se procesa dentro del hilo de audio dedicado.
 */
const SPATIAL_WORKLET_PROCESSOR_CODE = `
class SpatialAudioProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'gain', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0 },
            { name: 'pan', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0 },
            { name: 'attenuation', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0 }
        ];
    }

    constructor() {
        super();
        this.port.onmessage = (event) => {
            // Manejo de eventos de control fuera de parámetros de bloque
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        // Si no hay señal de audio presente, mantener activo el procesador
        if (!input || input.length === 0 || !output) {
            return true;
        }

        const inputChannelL = input[0];
        const inputChannelR = input.length > 1 ? input[1] : input[0];
        const outputChannelL = output[0];
        const outputChannelR = output.length > 1 ? output[1] : output[0];

        const gainParam = parameters.gain;
        const panParam = parameters.pan;
        const attenuationParam = parameters.attenuation;

        const isGainConstant = gainParam.length === 1;
        const isPanConstant = panParam.length === 1;
        const isAttenConstant = attenuationParam.length === 1;

        const bufferLength = outputChannelL.length;

        for (let i = 0; i < bufferLength; i++) {
            const currentGain = isGainConstant ? gainParam[0] : gainParam[i];
            const currentPan = isPanConstant ? panParam[0] : panParam[i];
            const currentAtten = isAttenConstant ? attenuationParam[0] : attenuationParam[i];

            // Panning estéreo de potencia constante (Constant Power Panning)
            const panNormalized = (currentPan + 1.0) * 0.25 * Math.PI;
            const leftPanGain = Math.cos(panNormalized);
            const rightPanGain = Math.sin(panNormalized);

            const effectiveGain = currentGain * currentAtten;

            // Muestra entrante modulada
            const sampleL = inputChannelL[i] * effectiveGain;
            const sampleR = inputChannelR[i] * effectiveGain;

            outputChannelL[i] = sampleL * leftPanGain;
            if (output.length > 1) {
                outputChannelR[i] = sampleR * rightPanGain;
            }
        }

        return true;
    }
}

registerProcessor('spatial-audio-processor', SpatialAudioProcessor);
`;

// =============================================================================
// OBJETO SONORO ESPACIAL (SPATIAL SOUND)
// =============================================================================

/**
 * Representa una fuente de sonido con posicionamiento tridimensional y atenuación por distancia.
 */
export class SpatialSound extends EventEmitter {
    /**
     * @param {SpatialSoundManager} manager - Gestor de audio espacial propietario.
     * @param {string} key - Clave del asset de audio almacenado en caché.
     * @param {AudioBuffer} audioBuffer - Búfer de audio decodificado.
     * @param {object} [config={}] - Parámetros de configuración inicial.
     */
    constructor(manager, key, audioBuffer, config = {}) {
        super();

        this.manager = manager;
        this.key = key;
        this.audioBuffer = audioBuffer;

        /** @type {AudioBufferSourceNode|null} */
        this.sourceNode = null;

        /** @type {AudioWorkletNode|null} */
        this.workletNode = null;

        /** @type {PannerNode|null} Nodo de fallback si AudioWorklet no está disponible */
        this.fallbackPanner = null;

        /** @type {GainNode|null} */
        this.fallbackGain = null;

        // Posicionamiento en el espacio cartesiano del juego
        this.x = config.x ?? 0.0;
        this.y = config.y ?? 0.0;
        this.z = config.z ?? 0.0;

        // Propiedades acústicas
        this.minDistance = config.minDistance ?? 50.0;
        this.maxDistance = config.maxDistance ?? 1500.0;
        this.rolloffFactor = config.rolloffFactor ?? 1.0;
        this.distanceModel = config.distanceModel ?? 'inverse'; // 'linear' | 'inverse' | 'exponential'

        // Estados del reproductor
        this.volume = config.volume ?? 1.0;
        this.rate = config.rate ?? 1.0;
        this.loop = config.loop ?? false;
        this.isPlaying = false;
        this.isPaused = false;

        this.startTime = 0;
        this.pauseOffset = 0;

        /** @type {object|null} Objetivo de seguimiento (GameObject o Entidad) */
        this.followTarget = config.follow ?? null;

        this._setupNodes();
    }

    /**
     * Inicializa la cadena de nodos de audio conectando el Worklet a la salida principal.
     * @private
     */
    _setupNodes() {
        const ctx = this.manager.context;

        if (this.manager.useWorklet) {
            this.workletNode = new AudioWorkletNode(ctx, 'spatial-audio-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            this.workletNode.connect(this.manager.masterGain);
        } else {
            // Cadena de nodos clásica para fallback
            this.fallbackGain = ctx.createGain();
            this.fallbackPanner = ctx.createPanner();
            this.fallbackPanner.panningModel = 'equalpower';
            this.fallbackPanner.distanceModel = this.distanceModel;
            this.fallbackPanner.refDistance = this.minDistance;
            this.fallbackPanner.maxDistance = this.maxDistance;
            this.fallbackPanner.rolloffFactor = this.rolloffFactor;

            this.fallbackGain.connect(this.fallbackPanner);
            this.fallbackPanner.connect(this.manager.masterGain);
        }
    }

    /**
     * Establece la posición espacial absoluta de la fuente sonora.
     * @param {number} x 
     * @param {number} y 
     * @param {number} [z=0] 
     * @returns {this}
     */
    setPosition(x, y, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.updateSpatialProperties();
        return this;
    }

    /**
     * Vincula la fuente sonora a un GameObject para actualizar su posición automáticamente.
     * @param {object|null} target - Objeto con propiedades x, y.
     * @returns {this}
     */
    setFollow(target) {
        this.followTarget = target;
        return this;
    }

    /**
     * Recalcula la atenuación y el balance estéreo con respecto a la posición del oyente.
     */
    updateSpatialProperties() {
        if (this.followTarget) {
            this.x = this.followTarget.x ?? this.x;
            this.y = this.followTarget.y ?? this.y;
            this.z = this.followTarget.z ?? this.z;
        }

        const listener = this.manager.listenerPosition;
        const dx = this.x - listener.x;
        const dy = this.y - listener.y;
        const dz = this.z - listener.z;

        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Cálculo de atenuación según el modelo acústico seleccionado
        let attenuation = 1.0;
        if (distance > this.minDistance) {
            if (this.distanceModel === 'linear') {
                attenuation = 1.0 - (this.rolloffFactor * (distance - this.minDistance)) / (this.maxDistance - this.minDistance);
            } else if (this.distanceModel === 'inverse') {
                attenuation = this.minDistance / (this.minDistance + this.rolloffFactor * (distance - this.minDistance));
            } else if (this.distanceModel === 'exponential') {
                attenuation = Math.pow(Math.max(distance / this.minDistance, 1.0), -this.rolloffFactor);
            }
        }
        attenuation = Math.max(0.0, Math.min(1.0, attenuation));

        // Proyección de balance estéreo (-1 a 1) relativa a la orientación del oyente
        const pan = Math.max(-1.0, Math.min(1.0, dx / Math.max(this.minDistance, Math.abs(dx) + Math.abs(dy))));

        const currentTime = this.manager.context.currentTime;

        if (this.workletNode) {
            const gainParam = this.workletNode.parameters.get('gain');
            const panParam = this.workletNode.parameters.get('pan');
            const attenParam = this.workletNode.parameters.get('attenuation');

            gainParam.setValueAtTime(this.volume, currentTime);
            panParam.setTargetAtTime(pan, currentTime, 0.02); // Suavizado para prevenir distorsión acústica
            attenParam.setTargetAtTime(attenuation, currentTime, 0.02);
        } else if (this.fallbackPanner) {
            this.fallbackGain.gain.setValueAtTime(this.volume, currentTime);
            this.fallbackPanner.positionX.setTargetAtTime(this.x, currentTime, 0.02);
            this.fallbackPanner.positionY.setTargetAtTime(this.y, currentTime, 0.02);
            this.fallbackPanner.positionZ.setTargetAtTime(this.z, currentTime, 0.02);
        }
    }

    /**
     * Inicia la reproducción del sonido espacial.
     * @param {number} [offset=0] - Punto de inicio en segundos.
     * @returns {this}
     */
    play(offset = 0) {
        if (this.isPlaying) {
            this.stop();
        }

        const ctx = this.manager.context;
        this.sourceNode = ctx.createBufferSource();
        this.sourceNode.buffer = this.audioBuffer;
        this.sourceNode.loop = this.loop;
        this.sourceNode.playbackRate.setValueAtTime(this.rate, ctx.currentTime);

        const targetNode = this.workletNode || this.fallbackGain;
        this.sourceNode.connect(targetNode);

        this.sourceNode.onended = () => {
            if (!this.loop && this.isPlaying) {
                this.isPlaying = false;
                this.emit('complete', this);
            }
        };

        this.updateSpatialProperties();
        this.sourceNode.start(0, offset);
        this.startTime = ctx.currentTime - offset;
        this.isPlaying = true;
        this.isPaused = false;
        this.emit('play', this);

        return this;
    }

    /**
     * Pausa temporalmente la reproducción recordando el progreso.
     * @returns {this}
     */
    pause() {
        if (!this.isPlaying || this.isPaused) return this;

        const ctx = this.manager.context;
        this.pauseOffset = (ctx.currentTime - this.startTime) % this.audioBuffer.duration;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
        this.sourceNode = null;

        this.isPlaying = false;
        this.isPaused = true;
        this.emit('pause', this);

        return this;
    }

    /**
     * Reanuda la reproducción desde el punto pausado.
     * @returns {this}
     */
    resume() {
        if (this.isPaused) {
            this.play(this.pauseOffset);
        }
        return this;
    }

    /**
     * Detiene por completo la reproducción del sonido.
     * @returns {this}
     */
    stop() {
        if (this.sourceNode) {
            this.sourceNode.stop();
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        this.isPlaying = false;
        this.isPaused = false;
        this.pauseOffset = 0;
        this.emit('stop', this);

        return this;
    }

    /**
     * Modifica el volumen relativo de esta fuente de sonido.
     * @param {number} value - Factor de ganancia (0.0 a 1.0+).
     * @returns {this}
     */
    setVolume(value) {
        this.volume = Math.max(0, value);
        this.updateSpatialProperties();
        return this;
    }

    /**
     * Libera los recursos del nodo de audio.
     */
    destroy() {
        this.stop();
        this.removeAllListeners();

        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }

        if (this.fallbackGain) {
            this.fallbackGain.disconnect();
            this.fallbackPanner.disconnect();
            this.fallbackGain = null;
            this.fallbackPanner = null;
        }

        this.followTarget = null;
        this.audioBuffer = null;
        this.manager = null;
    }
}

// =============================================================================
// GESTOR DE AUDIO ESPACIAL (SPATIAL SOUND MANAGER)
// =============================================================================

/**
 * Gestor maestro del subsistema acústico espacial de Tacarigua 1.0.0.
 */
export class SpatialSoundManager extends EventEmitter {
    /**
     * @param {import('./Game').Game} game - Instancia del motor Tacarigua.
     * @param {object} [config={}] - Opciones de configuración de audio.
     */
    constructor(game, config = {}) {
        super();

        this.game = game;

        /** @type {AudioContext|null} */
        this.context = null;

        /** @type {GainNode|null} */
        this.masterGain = null;

        this.useWorklet = false;
        this.unlocked = false;

        // Posición global del oyente (Cámara / Escena)
        this.listenerPosition = { x: 0.0, y: 0.0, z: 0.0 };

        /** @type {Set<SpatialSound>} */
        this.sounds = new Set();

        this._unlockCallback = this._unlockContext.bind(this);
        this._initContext();
    }

    /**
     * Configura el AudioContext y gestiona la carga asíncrona del AudioWorklet.
     * @private
     */
    async _initContext() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            console.warn('[Tacarigua 1.0.0 - Sound] Web Audio API no soportada en este entorno.');
            return;
        }

        this.context = new AudioContextClass({ latencyHint: 'interactive' });
        this.masterGain = this.context.createGain();
        this.masterGain.connect(this.context.destination);

        // Registro del AudioWorklet mediante un Blob URL inline
        if (this.context.audioWorklet) {
            try {
                const blob = new Blob([SPATIAL_WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
                const workletUrl = URL.createObjectURL(blob);
                await this.context.audioWorklet.addModule(workletUrl);
                URL.revokeObjectURL(workletUrl);
                this.useWorklet = true;
            } catch (error) {
                console.warn('[Tacarigua 1.0.0 - Sound] Fallo al compilar AudioWorklet, usando fallback nativo:', error);
                this.useWorklet = false;
            }
        }

        if (this.context.state === 'suspended') {
            this._setupUnlockListeners();
        } else {
            this.unlocked = true;
        }
    }

    /**
     * Registra los manejadores de gestos de usuario para desbloquear el AudioContext según políticas del navegador.
     * @private
     */
    _setupUnlockListeners() {
        if (typeof document === 'undefined') return;

        const events = ['pointerdown', 'touchstart', 'keydown'];
        const unlock = () => {
            events.forEach((evt) => document.removeEventListener(evt, unlock));
            this._unlockContext();
        };

        events.forEach((evt) => document.addEventListener(evt, unlock, { once: true, passive: true }));
    }

    /**
     * Reanuda el contexto de audio suspendido.
     * @private
     */
    _unlockContext() {
        if (this.context && this.context.state === 'suspended') {
            this.context.resume().then(() => {
                this.unlocked = true;
                this.emit('unlocked', this);
            });
        }
    }

    /**
     * Establece la posición tridimensional del oyente en el escenario.
     * @param {number} x 
     * @param {number} y 
     * @param {number} [z=0] 
     * @returns {this}
     */
    setListenerPosition(x, y, z = 0) {
        this.listenerPosition.x = x;
        this.listenerPosition.y = y;
        this.listenerPosition.z = z;

        if (!this.useWorklet && this.context?.listener) {
            const l = this.context.listener;
            const t = this.context.currentTime;
            if (l.positionX) {
                l.positionX.setTargetAtTime(x, t, 0.02);
                l.positionY.setTargetAtTime(y, t, 0.02);
                l.positionZ.setTargetAtTime(z, t, 0.02);
            } else {
                l.setPosition(x, y, z);
            }
        }

        // Actualizar fuentes sonoras activas
        for (const sound of this.sounds) {
            if (sound.isPlaying) {
                sound.updateSpatialProperties();
            }
        }

        return this;
    }

    /**
     * Crea e inicializa una nueva fuente de sonido espacial.
     * @param {string} key - Clave del asset en la caché de audio.
     * @param {object} [config={}] - Opciones de configuración.
     * @returns {SpatialSound}
     */
    addSpatial(key, config = {}) {
        const audioBuffer = this.game.cache.audio.get(key);
        if (!audioBuffer) {
            throw new Error(`[Tacarigua 1.0.0 - Sound] No se encontró audio cargado para la clave: "${key}"`);
        }

        const sound = new SpatialSound(this, key, audioBuffer, config);
        this.sounds.add(sound);
        return sound;
    }

    /**
     * Sincroniza todas las fuentes sonoras activas vinculadas a GameObjects o cámaras en cada cuadro.
     * @param {number} time 
     * @param {number} delta 
     */
    update(time, delta) {
        for (const sound of this.sounds) {
            if (sound.isPlaying && sound.followTarget) {
                sound.updateSpatialProperties();
            }
        }
    }

    /**
     * Modifica el volumen maestro del juego.
     * @param {number} volume - Factor multiplicador (0.0 a 1.0+).
     * @returns {this}
     */
    setMasterVolume(volume) {
        if (this.masterGain && this.context) {
            this.masterGain.gain.setValueAtTime(Math.max(0, volume), this.context.currentTime);
        }
        return this;
    }

    /**
     * Libera de forma ordenada los recursos del sistema de audio y cierra el contexto.
     */
    destroy() {
        this.removeAllListeners();

        for (const sound of this.sounds) {
            sound.destroy();
        }
        this.sounds.clear();

        if (this.masterGain) {
            this.masterGain.disconnect();
            this.masterGain = null;
        }

        if (this.context) {
            this.context.close();
            this.context = null;
        }

        this.game = null;
    }
}