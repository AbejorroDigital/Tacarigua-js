/**
 * @fileoverview Infraestructura de documentación interactiva, ejecutor REPL y guía de migración para Tacarigua 1.0.0.
 * @module @tacarigua/docs-playground
 * @license Phaser - Licencia MIT
 */

// =============================================================================
// CONFIGURACIÓN DE GENERACIÓN DE DOCUMENTACIÓN (TYPEDOC + ASTRO)
// =============================================================================

/**
 * Configuración estándar para TypeDoc orientada a la extracción estricta del monorepo.
 */
export const TYPEDOC_ASTRO_CONFIG = {
    entryPoints: [
        '../core/src/index.js',
        '../renderer-webgpu/src/index.js',
        '../batch-renderer-2d/src/index.js',
        '../ecs/src/index.js',
        '../physics-worker/src/index.js',
        '../sound-worklet/src/index.js',
        '../net/src/index.js',
        '../input-xr/src/index.js',
        '../devtools/src/index.js',
        '../vite-plugin/src/index.js'
    ],
    out: '../../docs/dist/api',
    plugin: ['typedoc-plugin-markdown'],
    readme: 'none',
    githubPages: false,
    excludePrivate: true,
    excludeProtected: false,
    excludeExternals: true,
    cleanOutputDir: true,
    navigationLinks: {
        'Guía de Inicio': '/guides/getting-started',
        'Migración Phaser 4.x a Tacarigua 1.0': '/guides/migration-1',
        'Playground': '/playground'
    }
};

// =============================================================================
// ENTORNO DE PRUEBAS INTERACTIVO EN NAVEGADOR (PLAYGROUND HARNESS)
// =============================================================================

/**
 * Orquestador de ejecución en caja de arena (Sandbox) para probar ejemplos de Tacarigua 1.0 en tiempo real.
 */
export class PlaygroundRunner {
    /**
     * @param {HTMLElement} containerElement - Elemento contenedor donde se insertará el iframe.
     * @param {object} [options={}] - Parámetros de ejecución.
     */
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.options = options;

        /** @type {HTMLIFrameElement|null} */
        this.iframe = null;
        this.activeBlobUrl = null;

        this.onConsoleLog = options.onConsoleLog || ((msg) => console.log('[Playground]', msg));
        this.onConsoleError = options.onConsoleError || ((err) => console.error('[Playground Error]', err));
        this.onMetricsUpdate = options.onMetricsUpdate || (() => { });

        this._messageListener = this._handleIframeMessage.bind(this);
        window.addEventListener('message', this._messageListener);
    }

    /**
     * Procesa los mensajes emitidos desde el entorno aislado del iframe.
     * @param {MessageEvent} event 
     * @private
     */
    _handleIframeMessage(event) {
        const data = event.data;
        if (!data || data.origin !== 'tacarigua-playground-sandbox') return;

        switch (data.type) {
            case 'LOG':
                this.onConsoleLog(data.payload);
                break;
            case 'ERROR':
                this.onConsoleError(data.payload);
                break;
            case 'METRICS':
                this.onMetricsUpdate(data.payload);
                break;
        }
    }

    /**
     * Compila y ejecuta código fuente de usuario en un entorno aislado con WebGPU habilitado.
     * @param {string} userCode - Código JavaScript/ESM del juego.
     * @param {string} [customWGSL=''] - Sombreadores adicionales opcionales.
     */
    execute(userCode, customWGSL = '') {
        this.stop();

        this.iframe = document.createElement('iframe');
        this.iframe.style.width = '100%';
        this.iframe.style.height = '100%';
        this.iframe.style.border = 'none';
        this.iframe.setAttribute('allow', 'cross-origin-isolated; xr-spatial-tracking; fullscreen; autoplay');

        this.container.appendChild(this.iframe);

        const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #050811;
        }
        canvas {
            display: block;
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body>
    <script type="module">
        // Interceptor de errores y consola para telemetría en el host
        const notify = (type, payload) => {
            window.parent.postMessage({ origin: 'tacarigua-playground-sandbox', type, payload }, '*');
        };

        window.onerror = (msg, url, line, col, err) => {
            notify('ERROR', { message: msg, line, col, stack: err ? err.stack : null });
        };

        const originalLog = console.log;
        console.log = (...args) => {
            originalLog(...args);
            notify('LOG', args.join(' '));
        };

        // Comprobación de compatibilidad con WebGPU
        if (!navigator.gpu) {
            notify('LOG', 'Aviso: WebGPU no disponible en este navegador. Se aplicará fallback automático a WebGL 2.');
        }

        try {
            ${userCode}
        } catch (error) {
            notify('ERROR', { message: error.message, stack: error.stack });
        }
    </script>
</body>
</html>
        `;

        const blob = new Blob([htmlContent], { type: 'text/html' });
        this.activeBlobUrl = URL.createObjectURL(blob);
        this.iframe.src = this.activeBlobUrl;
    }

    /**
     * Detiene la ejecución activa y remueve el iframe junto a los recursos creados.
     */
    stop() {
        if (this.activeBlobUrl) {
            URL.revokeObjectURL(this.activeBlobUrl);
            this.activeBlobUrl = null;
        }

        if (this.iframe) {
            this.iframe.src = 'about:blank';
            if (this.iframe.parentNode) {
                this.iframe.parentNode.removeChild(this.iframe);
            }
            this.iframe = null;
        }
    }

    /**
     * Libera de forma permanente el ejecutor del playground.
     */
    destroy() {
        this.stop();
        window.removeEventListener('message', this._messageListener);
        this.container = null;
    }
}

// =============================================================================
// GUÍA Y CATÁLOGO DE MIGRACIÓN (MIGRATION GUIDE PHASER 4.x / 3.x -> TACARIGUA 1.0.0)
// =============================================================================

/**
 * Base de conocimientos estructurada con directrices de migración para desarrolladores.
 */
export const MIGRATION_MANUAL = Object.freeze({
    versionSource: '4.2.1',
    versionTarget: '1.0.0',

    breakingChanges: [
        {
            category: 'Arquitectura y Empaquetado',
            title: 'Módulos ESM Puros sin objeto global monolítico',
            description: 'Se elimina el namespace global window.Phaser como dependencia obligatoria. Los paquetes ahora se importan modularmente permitiendo tree-shaking real.',
            codeBefore: `
// Phaser 3/4
const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 800,
    height: 600
});
            `,
            codeAfter: `
// Tacarigua 1.0.0
import { Game, RENDER_TYPE } from '@tacarigua/core.js';

const game = new Game({
    type: RENDER_TYPE.AUTO, // Selecciona WebGPU automáticamente con fallback a WebGL 2
    width: 800,
    height: 600
});
            `
        },
        {
            category: 'Renderizado',
            title: 'Pipeline Primario WebGPU y sombreadores en WGSL',
            description: 'Se elimina la dependencia rígida de pipelines basados en la máquina de estados de WebGL 1. Los nuevos efectos y shaders de post-procesamiento se declaran en WGSL.',
            codeBefore: `
// Phaser 3/4 - Modificación manual de pipelines de fragmentos GLSL
class CustomPipeline extends Phaser.Renderer.WebGL.Pipelines.MultiPipeline {
    // Código GLSL ES 2.0 heredado...
}
            `,
            codeAfter: `
// Tacarigua 1.0.0 - Pipeline desacoplado sobre la RHI en WGSL
import { PostFXEffect } from '@tacarigua/batch-renderer-2d';

class CustomVignette extends PostFXEffect {
    constructor(rhi) {
        super('CustomVignette', rhi);
        // Sombreador nativo WGSL con enlace a buffers uniformes
    }
}
            `
        },
        {
            category: 'Entidades y Rendimiento',
            title: 'Adopción del modelo orientado a datos (ECS)',
            description: 'En escenarios de alto volumen de sprites (bullet-hell, enjambres, simulaciones masivas), se sustituye la herencia profunda de GameObjects por componentes columnares continuos en memoria tipada.',
            codeBefore: `
// Phaser 3/4 - Instanciación masiva de objetos pesados en Heap
for (let i = 0; i < 20000; i++) {
    const sprite = this.add.sprite(x, y, 'bullet');
    this.physics.add.existing(sprite);
    bullets.push(sprite);
}
            `,
            codeAfter: `
// Tacarigua 1.0.0 - Entidades numéricas contiguas en búferes planos (SoA)
import { ECSWorld, MovementSystem } from '@tacarigua/ecs';

const world = new ECSWorld(20000);
world.addSystem(new MovementSystem(world));

for (let i = 0; i < 20000; i++) {
    const entity = world.createEntity();
    world.addComponent(entity, world.Transform, { x: 0, y: 0, scaleX: 1, scaleY: 1 });
    world.addComponent(entity, world.Velocity, { vx: 200, vy: 50 });
}
            `
        },
        {
            category: 'Físicas',
            title: 'Físicas Off-Thread en Web Workers',
            description: 'Las físicas ya no bloquean el renderizado del hilo principal. Se comunican mediante SharedArrayBuffer o transferencias de búferes atómicos.',
            codeBefore: `
// Phaser 3/4 - Simulación síncrona en el hilo principal
// Provocaba congelamientos (jank) al resolver cientos de colisiones complejas
            `,
            codeAfter: `
// Tacarigua 1.0.0 - Inicialización del puente Off-Thread
import { PhysicsWorkerBridge } from '@tacarigua/physics-worker';

const physics = new PhysicsWorkerBridge(game, {
    maxBodies: 10000,
    gravity: { x: 0, y: 980 }
});
const bodyId = physics.createBody(x, y, width, height, { bounce: 0.8 }, mySprite);
            `
        },
        {
            category: 'Audio',
            title: 'Procesamiento en hilo dedicado mediante AudioWorklet',
            description: 'Se abandona ScriptProcessorNode y el cálculo de paneo estéreo manual. El audio espacial 2D/3D ahora opera en tiempo real sin pausas de recolección de basura.',
            codeBefore: `
// Phaser 3/4 - Web Audio API básica en el hilo de UI
const sound = this.sound.add('explosion');
sound.play();
            `,
            codeAfter: `
// Tacarigua 1.0.0 - Audio espacial con AudioWorklet
import { SpatialSoundManager } from '@tacarigua/sound-worklet';

const soundManager = new SpatialSoundManager(game);
const sound = soundManager.addSpatial('explosion', {
    minDistance: 50,
    maxDistance: 1000,
    rolloffFactor: 1.5
});
sound.setFollow(playerSprite);
sound.play();
            `
        }
    ]
});

// =============================================================================
// VALIDADOR DINÁMICO DE CONFIGURACIONES OBSOLETAS
// =============================================================================

/**
 * Inspecciona un objeto de configuración de Phaser 3/4 y sugiere las transformaciones para Tacarigua 1.0.0.
 */
export class MigrationAuditor {
    /**
     * Audita una configuración y devuelve diagnósticos y advertencias de modernización.
     * @param {object} legacyConfig 
     * @returns {Array<{field: string, level: 'warning'|'deprecated'|'breaking', advice: string}>}
     */
    static auditConfig(legacyConfig) {
        const diagnostics = [];

        if (legacyConfig.type === 1) { // CANVAS
            diagnostics.push({
                field: 'type',
                level: 'warning',
                advice: 'El modo CANVAS puro está desaconsejado en Tacarigua 1.0.0. Utilice RENDER_TYPE.AUTO para habilitar WebGPU con respaldo transparente en WebGL 2.'
            });
        }

        if (legacyConfig.physics?.arcade?.useTree === false) {
            diagnostics.push({
                field: 'physics.arcade.useTree',
                level: 'deprecated',
                advice: 'useTree ha sido reemplazado por la arquitectura de físicas desacopladas de @tacarigua/physics-worker basada en AABB contiguo.'
            });
        }

        if (legacyConfig.audio?.disableWebAudio) {
            diagnostics.push({
                field: 'audio.disableWebAudio',
                level: 'breaking',
                advice: 'HTML5 Audio como fallback ha sido retirado. Tacarigua 1.0.0 requiere Web Audio API con procesadores AudioWorklet dedicados.'
            });
        }

        return diagnostics;
    }
}