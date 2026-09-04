/**
 * @fileoverview Subsistema de WebXR, controladores 6DoF y retroalimentación háptica para Tacarigua 1.0.0.
 * @module @tacarigua/input-xr
 * @license Phaser - Licencia MIT
 */

import { EventEmitter } from './core.js';

// =============================================================================
// CONSTANTES Y ENUMERACIONES WEBXR Y HÁPTICAS
// =============================================================================

/**
 * Modos de sesión WebXR compatibles.
 * @enum {string}
 */
export const XR_SESSION_MODE = Object.freeze({
    IMMERSIVE_VR: 'immersive-vr',
    IMMERSIVE_AR: 'immersive-ar',
    INLINE: 'inline'
});

/**
 * Espacios de referencia para la orientación del jugador en el espacio físico.
 * @enum {string}
 */
export const XR_REFERENCE_SPACE = Object.freeze({
    LOCAL: 'local',
    LOCAL_FLOOR: 'local-floor',
    BOUNDED_FLOOR: 'bounded-floor',
    UNBOUNDED: 'unbounded',
    VIEWER: 'viewer'
});

/**
 * Lateralidad o mano asignada a una entrada espacial.
 * @enum {string}
 */
export const XR_HANDEDNESS = Object.freeze({
    NONE: 'none',
    LEFT: 'left',
    RIGHT: 'right'
});

/**
 * Tipos de retroalimentación háptica soportados.
 * @enum {string}
 */
export const HAPTIC_TYPE = Object.freeze({
    DUAL_RUMBLE: 'dual-rumble',
    PULSE: 'pulse'
});

// =============================================================================
// GESTOR DE RETROALIMENTACIÓN HÁPTICA (HAPTIC FEEDBACK)
// =============================================================================

/**
 * Controla motores de vibración háptica en mandos tradicionales y controladores VR.
 */
export class HapticManager {
    constructor() {
        this.enabled = true;
    }

    /**
     * Dispara un efecto de vibración dual (baja y alta frecuencia) en un Gamepad o mando XR.
     * @param {Gamepad} gamepad - Instancia del Gamepad nativo.
     * @param {object} [options={}] - Parámetros de vibración.
     * @param {number} [options.duration=100] - Duración en milisegundos.
     * @param {number} [options.strongMagnitude=1.0] - Intensidad del motor de bajas frecuencias (0.0 a 1.0).
     * @param {number} [options.weakMagnitude=1.0] - Intensidad del motor de altas frecuencias (0.0 a 1.0).
     * @param {number} [options.startDelay=0] - Demora inicial en milisegundos.
     * @returns {Promise<boolean>}
     */
    async playEffect(gamepad, options = {}) {
        if (!this.enabled || !gamepad) return false;

        const duration = options.duration ?? 100;
        const strongMagnitude = options.strongMagnitude ?? 1.0;
        const weakMagnitude = options.weakMagnitude ?? 1.0;
        const startDelay = options.startDelay ?? 0;

        // 1. Prioridad: API moderna Dual-Rumble
        if (gamepad.vibrationActuator && typeof gamepad.vibrationActuator.playEffect === 'function') {
            try {
                await gamepad.vibrationActuator.playEffect(HAPTIC_TYPE.DUAL_RUMBLE, {
                    startDelay,
                    duration,
                    weakMagnitude,
                    strongMagnitude
                });
                return true;
            } catch (err) {
                // Falla silenciosa si el dispositivo no admite el patrón
            }
        }

        // 2. Respaldo para mandos WebXR con actuadores de pulso
        if (gamepad.hapticActuators && gamepad.hapticActuators.length > 0) {
            try {
                const intensity = Math.max(strongMagnitude, weakMagnitude);
                gamepad.hapticActuators[0].pulse(intensity, duration);
                return true;
            } catch (err) {
                // Actuador no disponible
            }
        }

        // 3. Respaldo para dispositivos móviles (navigator.vibrate)
        if (typeof navigator !== 'undefined' && navigator.vibrate && startDelay === 0) {
            navigator.vibrate(duration);
            return true;
        }

        return false;
    }

    /**
     * Emite un pulso háptico rápido de impacto.
     * @param {Gamepad} gamepad 
     * @param {number} [intensity=1.0] 
     * @param {number} [duration=50] 
     */
    pulse(gamepad, intensity = 1.0, duration = 50) {
        this.playEffect(gamepad, {
            duration,
            strongMagnitude: intensity,
            weakMagnitude: intensity
        });
    }

    /**
     * Detiene de inmediato cualquier efecto de vibración en el mando indicado.
     * @param {Gamepad} gamepad 
     */
    stop(gamepad) {
        if (!gamepad) return;

        if (gamepad.vibrationActuator && typeof gamepad.vibrationActuator.reset === 'function') {
            gamepad.vibrationActuator.reset();
        }
    }
}

// =============================================================================
// CONTROLADOR ESPACIAL 6DoF (XR CONTROLLER)
// =============================================================================

/**
 * Representa un mando espacial tridimensional con seis grados de libertad (6DoF) o una mano virtual.
 */
export class XRController extends EventEmitter {
    /**
     * @param {XRManager} xrManager - Gestor principal de WebXR.
     * @param {XRInputSource} inputSource - Fuente de entrada nativa de WebXR.
     * @param {number} index - Índice numérico del controlador.
     */
    constructor(xrManager, inputSource, index) {
        super();

        this.xrManager = xrManager;
        this.inputSource = inputSource;
        this.index = index;

        this.handedness = inputSource.handedness || XR_HANDEDNESS.NONE;
        this.targetRayMode = inputSource.targetRayMode; // 'gaze' | 'tracked-pointer' | 'screen'

        // Matrices de transformación locales (4x4, 16 floats)
        this.gripMatrix = new Float32Array(16);
        this.targetRayMatrix = new Float32Array(16);

        // Posición y orientación calculadas (3D)
        this.position = { x: 0, y: 0, z: 0 };
        this.pointerRay = {
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 0, z: -1 }
        };

        this.isConnected = true;
        this.hasGripPose = false;
        this.hasTargetRayPose = false;

        // Búferes para seguimiento de articulaciones de manos (Hand Tracking)
        this.isHand = Boolean(inputSource.hand);
        this.jointMatrices = this.isHand ? new Float32Array(inputSource.hand.size * 16) : null;
    }

    /**
     * Actualiza las transformaciones espaciales en cada cuadro inmersivo.
     * @param {XRFrame} frame 
     * @param {XRReferenceSpace} referenceSpace 
     */
    update(frame, referenceSpace) {
        if (!this.isConnected) return;

        // 1. Obtener pose del agarre físico (Grip Space)
        if (this.inputSource.gripSpace) {
            const gripPose = frame.getPose(this.inputSource.gripSpace, referenceSpace);
            if (gripPose) {
                this.hasGripPose = true;
                this.gripMatrix.set(gripPose.transform.matrix);
                const p = gripPose.transform.position;
                this.position.x = p.x;
                this.position.y = p.y;
                this.position.z = p.z;
            } else {
                this.hasGripPose = false;
            }
        }

        // 2. Obtener pose del rayo de puntero (Target Ray Space)
        if (this.inputSource.targetRaySpace) {
            const rayPose = frame.getPose(this.inputSource.targetRaySpace, referenceSpace);
            if (rayPose) {
                this.hasTargetRayPose = true;
                this.targetRayMatrix.set(rayPose.transform.matrix);
                const pos = rayPose.transform.position;
                const orient = rayPose.transform.orientation;

                this.pointerRay.origin.x = pos.x;
                this.pointerRay.origin.y = pos.y;
                this.pointerRay.origin.z = pos.z;

                // Cálculo vectorial de la dirección del rayo aplicando el cuaternión de orientación
                const qx = orient.x, qy = orient.y, qz = orient.z, qw = orient.w;
                this.pointerRay.direction.x = 2 * (qx * qz + qw * qy);
                this.pointerRay.direction.y = 2 * (qy * qz - qw * qx);
                this.pointerRay.direction.z = 1 - 2 * (qx * qx + qy * qy);
            } else {
                this.hasTargetRayPose = false;
            }
        }

        // 3. Seguimiento de articulaciones si es una mano (Hand Tracking)
        if (this.isHand && frame.fillPoses) {
            const joints = Array.from(this.inputSource.hand.values());
            frame.fillPoses(joints, referenceSpace, this.jointMatrices);
        }
    }

    /**
     * Emite una vibración háptica sobre el controlador si dispone de actuadores.
     * @param {number} [intensity=1.0] 
     * @param {number} [duration=50] 
     */
    vibrate(intensity = 1.0, duration = 50) {
        if (this.inputSource.gamepad) {
            this.xrManager.haptics.pulse(this.inputSource.gamepad, intensity, duration);
        }
    }

    /**
     * Obtiene el estado del gatillo primario o botón de disparo.
     * @returns {number} Valor normalizado de presión (0.0 a 1.0).
     */
    getTrigger() {
        const gp = this.inputSource.gamepad;
        if (gp && gp.buttons && gp.buttons.length > 0) {
            return gp.buttons[0].value;
        }
        return 0;
    }

    /**
     * Comprueba si el gatillo primario está presionado.
     * @returns {boolean}
     */
    isTriggerPressed() {
        const gp = this.inputSource.gamepad;
        if (gp && gp.buttons && gp.buttons.length > 0) {
            return gp.buttons[0].pressed;
        }
        return false;
    }

    /**
     * Obtiene los ejes del stick analógico o touchpad.
     * @returns {{x: number, y: number}}
     */
    getAxes() {
        const gp = this.inputSource.gamepad;
        if (gp && gp.axes && gp.axes.length >= 2) {
            return { x: gp.axes[2] || gp.axes[0], y: gp.axes[3] || gp.axes[1] };
        }
        return { x: 0, y: 0 };
    }

    destroy() {
        this.removeAllListeners();
        this.xrManager = null;
        this.inputSource = null;
        this.gripMatrix = null;
        this.targetRayMatrix = null;
        this.jointMatrices = null;
        this.isConnected = false;
    }
}

// =============================================================================
// GESTOR PRINCIPAL DE WEBXR (XR MANAGER)
// =============================================================================

/**
 * Gestor maestro del subsistema inmersivo de Realidad Virtual y Aumentada para Tacarigua 1.0.0.
 */
export class XRManager extends EventEmitter {
    /**
     * @param {import('./Game').Game} game - Instancia principal del juego.
     * @param {object} [config={}] - Opciones de configuración de WebXR.
     */
    constructor(game, config = {}) {
        super();

        this.game = game;
        this.haptics = new HapticManager();

        this.preferredSessionMode = config.sessionMode || XR_SESSION_MODE.IMMERSIVE_VR;
        this.preferredReferenceSpace = config.referenceSpace || XR_REFERENCE_SPACE.LOCAL_FLOOR;

        /** @type {XRSession|null} */
        this.session = null;

        /** @type {XRReferenceSpace|null} */
        this.referenceSpace = null;

        /** @type {XRWebGLLayer|null} Capa de renderizado WebGL/WebGPU XR */
        this.xrLayer = null;

        /** @type {Array<XRController>} Controladores espaciales activos */
        this.controllers = [];

        this.isSupported = false;
        this.isInSession = false;

        // Vistas oculares para renderizado estéreo (Left Eye / Right Eye)
        this.views = [];

        this._onXRFrame = this._onXRFrame.bind(this);
        this._onInputSourcesChange = this._onInputSourcesChange.bind(this);
        this._onSessionEnded = this._onSessionEnded.bind(this);

        this._checkSupport();
    }

    /**
     * Comprueba si el hardware y navegador soportan la API WebXR para el modo seleccionado.
     * @private
     */
    async _checkSupport() {
        if (typeof navigator !== 'undefined' && navigator.xr) {
            try {
                this.isSupported = await navigator.xr.isSessionSupported(this.preferredSessionMode);
                if (this.isSupported) {
                    this.emit('supported');
                }
            } catch (err) {
                this.isSupported = false;
            }
        }
    }

    /**
     * Inicia una sesión inmersiva de WebXR y reconfigura el loop del motor.
     * @param {string} [mode=this.preferredSessionMode] 
     * @returns {Promise<boolean>}
     */
    async requestSession(mode = this.preferredSessionMode) {
        if (!this.isSupported || this.isInSession) {
            return false;
        }

        try {
            this.session = await navigator.xr.requestSession(mode, {
                requiredFeatures: [this.preferredReferenceSpace],
                optionalFeatures: ['hand-tracking', 'hit-test']
            });

            this.session.addEventListener('end', this._onSessionEnded);
            this.session.addEventListener('inputsourceschange', this._onInputSourcesChange);

            // Integración de capa de render con la RHI activa (WebGL2 o WebGPU)
            const rhi = this.game.renderer;
            if (rhi && rhi.driver && rhi.driver.gl) {
                this.xrLayer = new XRWebGLLayer(this.session, rhi.driver.gl);
                await this.session.updateRenderState({ baseLayer: this.xrLayer });
            }

            // Establecer el espacio de referencia
            this.referenceSpace = await this.session.requestReferenceSpace(this.preferredReferenceSpace);

            this.isInSession = true;
            this.emit('sessionstart', this.session);

            // Pausar el loop de ventana ordinario y delegar los fotogramas al visor XR
            this.game.loop.stop();
            this.session.requestAnimationFrame(this._onXRFrame);

            return true;
        } catch (error) {
            console.error('[Tacarigua 1.0.0 - XR] Error al iniciar la sesión WebXR:', error);
            this.emit('error', error);
            return false;
        }
    }

    /**
     * Callback invocado en cada ciclo de refresco del visor XR.
     * @param {number} time - Timestamp en ms.
     * @param {XRFrame} frame - Datos espaciales del fotograma actual.
     * @private
     */
    _onXRFrame(time, frame) {
        if (!this.isInSession || !this.session) return;

        const session = frame.session;
        session.requestAnimationFrame(this._onXRFrame);

        // 1. Obtener la pose de la cabeza del espectador
        const viewerPose = frame.getViewerPose(this.referenceSpace);
        if (viewerPose) {
            this.views = viewerPose.views;

            // 2. Actualizar posiciones de controladores y manos
            for (let i = 0; i < this.controllers.length; i++) {
                this.controllers[i].update(frame, this.referenceSpace);
            }

            // 3. Ejecutar el paso de simulación del juego sincronizado
            const delta = this.game.loop.rawDelta;
            this.game.step(time, delta);
        }
    }

    /**
     * Responde a la inserción o desconexión física de mandos espaciales.
     * @param {XRInputSourceChangeEvent} event 
     * @private
     */
    _onInputSourcesChange(event) {
        // Registrar controladores agregados
        for (const inputSource of event.added) {
            const controller = new XRController(this, inputSource, this.controllers.length);
            this.controllers.push(controller);
            this.emit('controlleradded', controller);
        }

        // Remover controladores desconectados
        for (const inputSource of event.removed) {
            const index = this.controllers.findIndex(c => c.inputSource === inputSource);
            if (index !== -1) {
                const controller = this.controllers[index];
                this.controllers.splice(index, 1);
                controller.destroy();
                this.emit('controllerremoved', controller);
            }
        }
    }

    /**
     * Manejador para el cierre de la sesión WebXR.
     * @private
     */
    _onSessionEnded() {
        this.isInSession = false;

        for (const controller of this.controllers) {
            controller.destroy();
        }
        this.controllers.length = 0;

        if (this.session) {
            this.session.removeEventListener('end', this._onSessionEnded);
            this.session.removeEventListener('inputsourceschange', this._onInputSourcesChange);
            this.session = null;
        }

        this.referenceSpace = null;
        this.xrLayer = null;
        this.views.length = 0;

        this.emit('sessionend');

        // Restaurar el loop de animación tradicional del navegador
        this.game.loop.start(this.game.renderer ? this.game.step.bind(this.game) : this.game.headlessStep.bind(this.game));
    }

    /**
     * Concluye manualmente la sesión inmersiva.
     */
    async endSession() {
        if (this.session && this.isInSession) {
            await this.session.end();
        }
    }

    /**
     * Libera de forma ordenada los recursos de WebXR y actuadores hápticos.
     */
    destroy() {
        this.endSession();
        this.removeAllListeners();
        this.haptics = null;
        this.game = null;
    }
}