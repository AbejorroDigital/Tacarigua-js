/**
 * @fileoverview Plugin oficial de Vite con soporte para Scene HMR y compilación de WGSL para Tacarigua 1.0.0.
 * @module @tacarigua/vite-plugin
 * @license Phaser - Licencia MIT
 */

// =============================================================================
// PUENTE CLIENTE PARA HMR DE ESCENAS (CLIENT RUNTIME HMR BRIDGE)
// =============================================================================

/**
 * Cliente de ejecución inyectado en el navegador para preservar y restaurar el estado de escenas.
 */
export class SceneHMRBridge {
    /**
     * Registra un módulo de escena para permitir reemplazo en caliente sin reiniciar el juego.
     * @param {object} hot - Objeto import.meta.hot expuesto por Vite.
     * @param {Function} SceneClass - Clase de la escena exportada.
     */
    static register(hot, SceneClass) {
        if (!hot) return;

        hot.accept((newModule) => {
            if (!newModule) return;

            const NewSceneClass = Object.values(newModule).find(
                (exp) => typeof exp === 'function' && exp.prototype
            );

            if (!NewSceneClass) return;

            // Detección de instancias activas del motor Phaser mediante el hook de DevTools
            const globalHook = window.TACARIGUA_DEVTOOLS_GLOBAL_HOOK__;
            if (!globalHook || !globalHook.games) return;

            for (const game of globalHook.games) {
                if (!game.scene) continue;

                // Localizar escenas activas que sean instancias de la clase modificada
                const activeScenes = game.scene.scenes.filter(
                    (s) => s.constructor.name === SceneClass.name || s.sys.settings.key === SceneClass.name
                );

                for (const oldScene of activeScenes) {
                    const sceneKey = oldScene.sys.settings.key;
                    console.info(`[Tacarigua 1.0.0 - HMR] Recargando escena en caliente: "${sceneKey}"`);

                    // 1. Extraer estado transitorio
                    const preservedData = {
                        data: oldScene.data ? oldScene.data.getAll() : {},
                        cameras: oldScene.cameras ? oldScene.cameras.main.toJSON() : null,
                        physicsBodies: []
                    };

                    // 2. Detener y remover la definición anterior
                    game.scene.remove(sceneKey);

                    // 3. Registrar la nueva definición de clase
                    game.scene.add(sceneKey, NewSceneClass, false);

                    // 4. Reiniciar la nueva escena inyectando el estado previo
                    game.scene.start(sceneKey, preservedData.data);

                    const reloadedScene = game.scene.getScene(sceneKey);
                    if (reloadedScene && preservedData.cameras && reloadedScene.cameras) {
                        reloadedScene.cameras.main.fromJSON(preservedData.cameras);
                    }
                }
            }
        });
    }
}

// =============================================================================
// MINIFICADOR Y TRANSFORMADOR DE SHADERS WGSL / GLSL
// =============================================================================

/**
 * Minifica código fuente de sombreadores eliminando comentarios y espacios innecesarios.
 * @param {string} code - Código fuente en WGSL o GLSL.
 * @returns {string} Código optimizado.
 */
export function minifyShader(code) {
    return code
        // Eliminar comentarios de bloque /* ... */
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Eliminar comentarios de línea // ...
        .replace(/\/\/.*$/gm, '')
        // Reemplazar saltos de línea y tabulaciones múltiples por espacios simples
        .replace(/[\r\n\t]+/g, ' ')
        // Limpiar espacios en torno a delimitadores y operadores
        .replace(/\s*([{};,=()+\-*\/><&|:])\s*/g, '$1')
        // Reducir espacios redundantes restantes
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Transforma un archivo de sombreador WGSL/GLSL en un módulo ESM JavaScript ejecutable.
 * @param {string} source - Código fuente original.
 * @param {string} id - Ruta del archivo.
 * @param {boolean} isProduction - Si debe aplicarse minificación agresiva.
 * @returns {{code: string, map: null}}
 */
export function transformShaderToESM(source, id, isProduction) {
    const processedSource = isProduction ? minifyShader(source) : source;
    const jsonString = JSON.stringify(processedSource);

    const esmCode = [
        `const shaderSource = ${jsonString};`,
        `export default shaderSource;`,
        `if (import.meta.hot) {`,
        `    import.meta.hot.accept((newModule) => {`,
        `        if (newModule) {`,
        `            window.dispatchEvent(new CustomEvent('phaser-shader-reload', {`,
        `                detail: { id: ${JSON.stringify(id)}, source: newModule.default }`,
        `            }));`,
        `        }`,
        `    });`,
        `}`
    ].join('\n');

    return {
        code: esmCode,
        map: null
    };
}

// =============================================================================
// PLUGIN PRINCIPAL DE VITE PARA Tacarigua 1.0.0
// =============================================================================

/**
 * Plugin oficial de Vite para la compilación, empaquetado y HMR de proyectos Tacarigua 1.0.0.
 * 
 * @param {object} [options={}] - Opciones de configuración del plugin.
 * @param {boolean} [options.minifyShaders=true] - Si se deben minificar los shaders en modo build.
 * @param {boolean} [options.sceneHMR=true] - Habilita la recarga en caliente inteligente de escenas.
 * @returns {object} Objeto de plugin compatible con Vite/Rollup.
 */
export default function phaserVitePlugin(options = {}) {
    const minifyShaders = options.minifyShaders ?? true;
    const enableSceneHMR = options.sceneHMR ?? true;

    let isProduction = false;

    return {
        name: 'vite-plugin-tacarigua-1',
        enforce: 'pre',

        configResolved(resolvedConfig) {
            isProduction = resolvedConfig.isProduction;
        },

        /**
         * Transforma archivos con extensiones de shaders a módulos ESM en memoria.
         */
        transform(code, id) {
            // 1. Transformación de Shaders WGSL y GLSL
            if (/\.(wgsl|glsl|vert|frag)$/i.test(id)) {
                return transformShaderToESM(code, id, isProduction && minifyShaders);
            }

            // 2. Inyección automática del boundary HMR en clases de Escena de Phaser
            if (enableSceneHMR && !isProduction && /\.(js|ts)$/.test(id)) {
                // Detectar si el archivo declara una clase que hereda de Phaser.Scene o exporta una escena
                if (code.includes('extends Scene') || code.includes('extends Phaser.Scene')) {
                    const injection = [
                        code,
                        `\n// Inyección automática Tacarigua 1.0.0 Scene HMR`,
                        `import { SceneHMRBridge } from '@tacarigua/vite-plugin';`,
                        `if (import.meta.hot) {`,
                        `    const defaultExport = (typeof defaultScene !== 'undefined') ? defaultScene : null;`,
                        `    SceneHMRBridge.register(import.meta.hot, defaultExport || (typeof exports !== 'undefined' ? exports.default : null));`,
                        `}`
                    ].join('\n');

                    return {
                        code: injection,
                        map: null
                    };
                }
            }

            return null;
        }
    };
}

// =============================================================================
// ESPECIFICACIÓN DE DISTRIBUCIÓN MODULAR (PACKAGE.JSON TEMPLATE)
// =============================================================================

/**
 * Estructura estándar de configuración de exportaciones para el paquete raíz `@tacarigua/core`.
 * Garantiza un tree-shaking del 100% en bundlers modernos.
 */
export const TACARIGUA_PACKAGE_EXPORTS_SPEC = {
    name: 'tacarigua',
    version: '1.0.0',
    type: 'module',
    sideEffects: false,
    exports: {
        '.': {
            types: './types/index.d.ts',
            import: './src/index.js'
        },
        './core': {
            types: './types/core/index.d.ts',
            import: './src/core/index.js'
        },
        './renderer-webgpu': {
            types: './types/renderer-webgpu/index.d.ts',
            import: './src/renderer-webgpu/index.js'
        },
        './batch-renderer-2d': {
            types: './types/batch-renderer-2d/index.d.ts',
            import: './src/batch-renderer-2d/index.js'
        },
        './ecs': {
            types: './types/ecs/index.d.ts',
            import: './src/ecs/index.js'
        },
        './physics-worker': {
            types: './types/physics-worker/index.d.ts',
            import: './src/physics-worker/index.js'
        },
        './sound-worklet': {
            types: './types/sound-worklet/index.d.ts',
            import: './src/sound-worklet/index.js'
        },
        './net': {
            types: './types/net/index.d.ts',
            import: './src/net/index.js'
        },
        './input-xr': {
            types: './types/input-xr/index.d.ts',
            import: './src/input-xr/index.js'
        },
        './devtools': {
            types: './types/devtools/index.d.ts',
            import: './src/devtools/index.js'
        },
        './vite-plugin': {
            types: './types/vite-plugin/index.d.ts',
            import: './src/vite-plugin/index.js'
        }
    }
};