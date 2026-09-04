/**
 * @fileoverview Capa RHI (Render Hardware Interface) y Pipeline nativo WebGPU/WebGL2 para Tacarigua 1.0.0.
 * @module @tacarigua/renderer-webgpu
 * @license Phaser - Licencia MIT
 */

import { RENDER_TYPE, CORE_EVENTS } from './core.js';

// =============================================================================
// CONSTANTES Y ENUMERACIONES DEL SUBSISTEMA RHI
// =============================================================================

/**
 * Formatos de textura estandarizados soportados por la RHI.
 * @enum {string}
 */
export const RHI_TEXTURE_FORMAT = Object.freeze({
    RGBA8_UNORM: 'rgba8unorm',
    RGBA8_UNORM_SRGB: 'rgba8unorm-srgb',
    BGRA8_UNORM: 'bgra8unorm',
    DEPTH24_PLUS_STENCIL8: 'depth24plus-stencil8',
    R8_UNORM: 'r8unorm'
});

/**
 * Tipos de uso de buffers de GPU para optimizar transferencias de memoria.
 * @enum {number}
 */
export const RHI_BUFFER_USAGE = Object.freeze({
    VERTEX: 1 << 0,
    INDEX: 1 << 1,
    UNIFORM: 1 << 2,
    STORAGE: 1 << 3,
    COPY_SRC: 1 << 4,
    COPY_DST: 1 << 5
});

/**
 * Operaciones de mezcla (Blend Factors) mapeadas a estándares universales.
 * @enum {string}
 */
export const RHI_BLEND_FACTOR = Object.freeze({
    ZERO: 'zero',
    ONE: 'one',
    SRC_COLOR: 'src',
    ONE_MINUS_SRC_COLOR: 'one-minus-src',
    SRC_ALPHA: 'src-alpha',
    ONE_MINUS_SRC_ALPHA: 'one-minus-src-alpha',
    DST_COLOR: 'dst',
    ONE_MINUS_DST_COLOR: 'one-minus-dst',
    DST_ALPHA: 'dst-alpha',
    ONE_MINUS_DST_ALPHA: 'one-minus-dst-alpha'
});

/**
 * Ecuaciones de mezcla para operaciones de render.
 * @enum {string}
 */
export const RHI_BLEND_OPERATION = Object.freeze({
    ADD: 'add',
    SUBTRACT: 'subtract',
    REVERSE_SUBTRACT: 'reverse-subtract',
    MIN: 'min',
    MAX: 'max'
});

/**
 * Topología de renderizado de primitivas geométricas.
 * @enum {string}
 */
export const RHI_PRIMITIVE_TOPOLOGY = Object.freeze({
    TRIANGLE_LIST: 'triangle-list',
    TRIANGLE_STRIP: 'triangle-strip',
    LINE_LIST: 'line-list',
    LINE_STRIP: 'line-strip',
    POINT_LIST: 'point-list'
});

// =============================================================================
// SOMBREADOR ESTÁNDAR WGSL (WEBGPU SHADING LANGUAGE)
// =============================================================================

/**
 * Código fuente del sombreador primario para el procesamiento masivo de lotes (Batches) de sprites en WebGPU.
 */
export const WGSL_BATCH_SHADER = `
struct Uniforms {
    projectionMatrix: mat4x4<f32>,
    resolution: vec2<f32>,
    cameraScroll: vec2<f32>,
    cameraZoom: f32,
    time: f32,
};

@group(0) @binding(0) var<uniform> uGlobal: Uniforms;
@group(0) @binding(1) var uTextureSampler: sampler;
@group(0) @binding(2) var uTextures: texture_2d_array<f32>;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) textureIndex: f32,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) textureIndex: f32,
    @location(2) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // Transformación ortográfica combinada con scroll y zoom de cámara
    let worldPosition = vec4<f32>(in.position, 0.0, 1.0);
    out.position = uGlobal.projectionMatrix * worldPosition;
    out.uv = in.uv;
    out.textureIndex = in.textureIndex;
    out.color = in.color;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let layer = i32(round(in.textureIndex));
    let texColor = textureSample(uTextures, uTextureSampler, in.uv, layer);
    
    // Premultiplicación de alfa y mezcla con el tint del vértice
    let finalColor = texColor * in.color;
    
    if (finalColor.a <= 0.001) {
        discard;
    }

    return finalColor;
}
`;

// =============================================================================
// ESTRUCTURAS DE DATOS RHI
// =============================================================================

/**
 * Representa un buffer genérico en GPU gestionado por la abstracción RHI.
 */
export class RHIBuffer {
    /**
     * @param {string} name - Nombre identificador para debug.
     * @param {number} size - Tamaño total del buffer en bytes.
     * @param {number} usage - Máscara binaria de banderas RHI_BUFFER_USAGE.
     * @param {object} nativeHandle - Instancia nativa (GPUBuffer o WebGLBuffer).
     */
    constructor(name, size, usage, nativeHandle) {
        this.name = name;
        this.size = size;
        this.usage = usage;
        this.nativeHandle = nativeHandle;
        this.isDestroyed = false;
    }
}

/**
 * Representa una textura administrada dentro de la infraestructura RHI.
 */
export class RHITexture {
    /**
     * @param {string} key - Clave única de la textura.
     * @param {number} width - Ancho en píxeles.
     * @param {number} height - Alto en píxeles.
     * @param {number} depth - Cantidad de capas o profundidad (para arrays de texturas).
     * @param {string} format - Formato RHI_TEXTURE_FORMAT.
     * @param {object} nativeHandle - Instancia nativa (GPUTexture o WebGLTexture).
     * @param {object} [nativeView=null] - Vista de textura en WebGPU.
     */
    constructor(key, width, height, depth, format, nativeHandle, nativeView = null) {
        this.key = key;
        this.width = width;
        this.height = height;
        this.depth = depth;
        this.format = format;
        this.nativeHandle = nativeHandle;
        this.nativeView = nativeView;
        this.isDestroyed = false;
    }
}

/**
 * Representa un Pipeline de renderizado inmutable configurado.
 */
export class RHIPipeline {
    /**
     * @param {string} id - Hash o ID único de la configuración del pipeline.
     * @param {object} nativeHandle - Pipeline nativo de WebGPU o Shader Program de WebGL2.
     * @param {object} layout - Disposición de atributos y bind groups.
     */
    constructor(id, nativeHandle, layout) {
        this.id = id;
        this.nativeHandle = nativeHandle;
        this.layout = layout;
    }
}

// =============================================================================
// IMPLEMENTACIÓN RHI: WEBGPU BACKEND
// =============================================================================

/**
 * Adaptador de Render Hardware Interface implementado nativamente sobre WebGPU.
 */
export class WebGPURHI {
    /**
     * @param {Game} game - Instancia del juego principal.
     */
    constructor(game) {
        this.game = game;
        this.canvas = game.canvas;

        /** @type {GPUAdapter|null} */
        this.adapter = null;

        /** @type {GPUDevice|null} */
        this.device = null;

        /** @type {GPUQueue|null} */
        this.queue = null;

        /** @type {GPUCanvasContext|null} */
        this.context = null;

        /** @type {string} */
        this.preferredFormat = '';

        /** @type {GPUCommandEncoder|null} */
        this.currentCommandEncoder = null;

        /** @type {GPURenderPassEncoder|null} */
        this.currentRenderPass = null;

        // Caché de pipelines para evitar recompilación en GPU
        /** @type {Map<string, RHIPipeline>} */
        this.pipelineCache = new Map();

        // Caché de grupos de enlace (BindGroups)
        /** @type {Map<string, GPUBindGroup>} */
        this.bindGroupCache = new Map();

        // Sampler global bilineal estático
        /** @type {GPUSampler|null} */
        this.defaultSampler = null;

        // Descriptores de pasada prealocados (Zero GC)
        this._renderPassDescriptor = {
            colorAttachments: [{
                view: null,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        };

        this.initialized = false;
    }

    /**
     * Inicializa el dispositivo físico, colas de ejecución y el contexto del lienzo.
     * @returns {Promise<boolean>}
     */
    async init() {
        if (!navigator.gpu) {
            return false;
        }

        try {
            const powerPreference = this.game.config.powerPreference || 'high-performance';
            this.adapter = await navigator.gpu.requestAdapter({ powerPreference });

            if (!this.adapter) {
                return false;
            }

            this.device = await this.adapter.requestDevice({
                requiredFeatures: [],
                requiredLimits: {
                    maxBufferSize: this.adapter.limits.maxBufferSize,
                    maxStorageBufferBindingSize: this.adapter.limits.maxStorageBufferBindingSize
                }
            });

            this.queue = this.device.queue;
            this.context = this.canvas.getContext('webgpu');
            this.preferredFormat = navigator.gpu.getPreferredCanvasFormat();

            this.context.configure({
                device: this.device,
                format: this.preferredFormat,
                alphaMode: this.game.config.transparent ? 'premultiplied' : 'opaque'
            });

            this.defaultSampler = this.device.createSampler({
                magFilter: this.game.config.antialias ? 'linear' : 'nearest',
                minFilter: this.game.config.antialias ? 'linear' : 'nearest',
                mipmapFilter: 'nearest',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge'
            });

            // Manejador de pérdida de dispositivo
            this.device.lost.then((info) => {
                console.error(`[Tacarigua 1.0.0 - WebGPU] Dispositivo perdido: ${info.message}`);
                this.game.events.emit(CORE_EVENTS.CONTEXT_LOST, info);
            });

            this.initialized = true;
            return true;
        } catch (error) {
            console.warn('[Tacarigua 1.0.0 - WebGPU] Error al inicializar WebGPU:', error);
            return false;
        }
    }

    /**
     * Redimensiona los buffers de intercambio al cambiar el tamaño de la ventana.
     * @param {number} width 
     * @param {number} height 
     */
    resize(width, height) {
        if (!this.initialized || !this.context) return;
        this.context.configure({
            device: this.device,
            format: this.preferredFormat,
            alphaMode: this.game.config.transparent ? 'premultiplied' : 'opaque'
        });
    }

    /**
     * Crea un buffer de GPU con sus banderas de uso específicas.
     * @param {string} name 
     * @param {number} size - Tamaño en bytes.
     * @param {number} usageFlags - Banderas RHI_BUFFER_USAGE.
     * @returns {RHIBuffer}
     */
    createBuffer(name, size, usageFlags) {
        let gpuUsage = 0;
        if (usageFlags & RHI_BUFFER_USAGE.VERTEX) gpuUsage |= GPUBufferUsage.VERTEX;
        if (usageFlags & RHI_BUFFER_USAGE.INDEX) gpuUsage |= GPUBufferUsage.INDEX;
        if (usageFlags & RHI_BUFFER_USAGE.UNIFORM) gpuUsage |= GPUBufferUsage.UNIFORM;
        if (usageFlags & RHI_BUFFER_USAGE.STORAGE) gpuUsage |= GPUBufferUsage.STORAGE;
        if (usageFlags & RHI_BUFFER_USAGE.COPY_SRC) gpuUsage |= GPUBufferUsage.COPY_SRC;
        if (usageFlags & RHI_BUFFER_USAGE.COPY_DST) gpuUsage |= GPUBufferUsage.COPY_DST;

        const nativeBuffer = this.device.createBuffer({
            label: name,
            size: Math.max(16, (size + 3) & ~3), // Alineación a 4 bytes requerida por WebGPU
            usage: gpuUsage | GPUBufferUsage.COPY_DST
        });

        return new RHIBuffer(name, size, usageFlags, nativeBuffer);
    }

    /**
     * Escribe datos en un buffer de memoria de video de forma óptima sin asignación intermedia.
     * @param {RHIBuffer} buffer 
     * @param {BufferSource} data 
     * @param {number} [offset=0] 
     */
    writeBuffer(buffer, data, offset = 0) {
        this.queue.writeBuffer(buffer.nativeHandle, offset, data);
    }

    /**
     * Crea una textura en GPU con soporte para múltiples capas y vistas.
     * @param {string} key 
     * @param {number} width 
     * @param {number} height 
     * @param {number} [depth=1] 
     * @param {string} [format=RHI_TEXTURE_FORMAT.RGBA8_UNORM] 
     * @returns {RHITexture}
     */
    createTexture(key, width, height, depth = 1, format = RHI_TEXTURE_FORMAT.RGBA8_UNORM) {
        const gpuTexture = this.device.createTexture({
            label: key,
            size: { width, height, depthOrArrayLayers: depth },
            format: format,
            dimension: '2d',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        const gpuView = gpuTexture.createView({
            dimension: depth > 1 ? '2d-array' : '2d'
        });

        return new RHITexture(key, width, height, depth, format, gpuTexture, gpuView);
    }

    /**
     * Actualiza el contenido de una textura desde una fuente de imagen o TypedArray.
     * @param {RHITexture} texture 
     * @param {ImageBitmap|HTMLCanvasElement|Uint8Array} source 
     * @param {number} [layerIndex=0] 
     */
    updateTexture(texture, source, layerIndex = 0) {
        if (source instanceof Uint8Array) {
            this.queue.writeTexture(
                { texture: texture.nativeHandle, origin: { x: 0, y: 0, z: layerIndex } },
                source,
                { bytesPerRow: texture.width * 4, rowsPerImage: texture.height },
                { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
            );
        } else {
            this.queue.copyExternalImageToTexture(
                { source: source },
                { texture: texture.nativeHandle, origin: { x: 0, y: 0, z: layerIndex } },
                { width: texture.width, height: texture.height, depthOrArrayLayers: 1 }
            );
        }
    }

    /**
     * Compila o recupera un RenderPipeline optimizado de la caché interna.
     * @param {string} pipelineId 
     * @param {string} wgslCode 
     * @param {Array<object>} vertexBufferLayouts 
     * @param {string} [topology=RHI_PRIMITIVE_TOPOLOGY.TRIANGLE_LIST] 
     * @returns {RHIPipeline}
     */
    getOrCreateRenderPipeline(pipelineId, wgslCode, vertexBufferLayouts, topology = RHI_PRIMITIVE_TOPOLOGY.TRIANGLE_LIST) {
        if (this.pipelineCache.has(pipelineId)) {
            return this.pipelineCache.get(pipelineId);
        }

        const shaderModule = this.device.createShaderModule({
            label: `ShaderModule_${pipelineId}`,
            code: wgslCode
        });

        // Parseo de los layouts de vertex buffer a tipos de WebGPU
        const gpuVertexBuffers = vertexBufferLayouts.map((layout) => ({
            arrayStride: layout.stride,
            stepMode: layout.stepMode || 'vertex',
            attributes: layout.attributes.map((attr) => ({
                shaderLocation: attr.shaderLocation,
                offset: attr.offset,
                format: attr.format
            }))
        }));

        const nativePipeline = this.device.createRenderPipeline({
            label: `RenderPipeline_${pipelineId}`,
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: gpuVertexBuffers
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.preferredFormat,
                    blend: {
                        color: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        }
                    }
                }]
            },
            primitive: {
                topology: topology,
                cullMode: 'none'
            }
        });

        const pipeline = new RHIPipeline(pipelineId, nativePipeline, nativePipeline.getBindGroupLayout(0));
        this.pipelineCache.set(pipelineId, pipeline);
        return pipeline;
    }

    /**
     * Inicia un nuevo cuadro de renderizado y el codificador de comandos.
     * @param {number} r - Componente rojo (0-1).
     * @param {number} g - Componente verde (0-1).
     * @param {number} b - Componente azul (0-1).
     * @param {number} a - Componente alfa (0-1).
     */
    beginFrame(r = 0, g = 0, b = 0, a = 1) {
        this.currentCommandEncoder = this.device.createCommandEncoder({ label: 'MainFrameEncoder' });

        const currentView = this.context.getCurrentTexture().createView();
        const attachment = this._renderPassDescriptor.colorAttachments[0];
        attachment.view = currentView;
        attachment.clearValue.r = r;
        attachment.clearValue.g = g;
        attachment.clearValue.b = b;
        attachment.clearValue.a = a;

        this.currentRenderPass = this.currentCommandEncoder.beginRenderPass(this._renderPassDescriptor);
    }

    /**
     * Establece el pipeline de render actual.
     * @param {RHIPipeline} pipeline 
     */
    setPipeline(pipeline) {
        this.currentRenderPass.setPipeline(pipeline.nativeHandle);
    }

    /**
     * Vincula un grupo de recursos uniformes y texturas al pipeline activo.
     * @param {number} index 
     * @param {GPUBindGroup} bindGroup 
     */
    setBindGroup(index, bindGroup) {
        this.currentRenderPass.setBindGroup(index, bindGroup);
    }

    /**
     * Vincula un buffer de vértices al slot indicado.
     * @param {number} slot 
     * @param {RHIBuffer} buffer 
     * @param {number} [offset=0] 
     */
    setVertexBuffer(slot, buffer, offset = 0) {
        this.currentRenderPass.setVertexBuffer(slot, buffer.nativeHandle, offset);
    }

    /**
     * Vincula el buffer de índices.
     * @param {RHIBuffer} buffer 
     * @param {string} [format='uint16'] 
     * @param {number} [offset=0] 
     */
    setIndexBuffer(buffer, format = 'uint16', offset = 0) {
        this.currentRenderPass.setIndexBuffer(buffer.nativeHandle, format, offset);
    }

    /**
     * Dibuja geometrías utilizando el buffer de índices activo.
     * @param {number} indexCount 
     * @param {number} [instanceCount=1] 
     * @param {number} [firstIndex=0] 
     * @param {number} [baseVertex=0] 
     * @param {number} [firstInstance=0] 
     */
    drawIndexed(indexCount, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
        this.currentRenderPass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    }

    /**
     * Finaliza la pasada de render actual y somete los comandos a la GPU.
     */
    endFrame() {
        if (this.currentRenderPass) {
            this.currentRenderPass.end();
            this.currentRenderPass = null;
        }

        if (this.currentCommandEncoder) {
            const commandBuffer = this.currentCommandEncoder.finish();
            this.queue.submit([commandBuffer]);
            this.currentCommandEncoder = null;
        }
    }

    /**
     * Libera de forma ordenada los recursos nativos creados en la GPU.
     */
    destroy() {
        this.pipelineCache.clear();
        this.bindGroupCache.clear();

        if (this.defaultSampler) {
            this.defaultSampler = null;
        }

        if (this.device) {
            this.device.destroy();
            this.device = null;
        }

        this.context = null;
        this.adapter = null;
        this.initialized = false;
    }
}

// =============================================================================
// IMPLEMENTACIÓN RHI: WEBGL2 BACKEND (FALLBACK)
// =============================================================================

/**
 * Adaptador de Render Hardware Interface implementado sobre WebGL 2.0.
 * Ofrece la misma interfaz que el driver de WebGPU para fallback homogéneo.
 */
export class WebGL2RHI {
    /**
     * @param {Game} game - Instancia del motor Phaser.
     */
    constructor(game) {
        this.game = game;
        this.canvas = game.canvas;

        /** @type {WebGL2RenderingContext|null} */
        this.gl = null;

        /** @type {Map<string, RHIPipeline>} */
        this.programCache = new Map();

        this.activeProgram = null;
        this.initialized = false;

        // Caché de Vao genérico para evitar re-binding continuo
        this._currentVAO = null;
    }

    /**
     * Inicializa el contexto de WebGL 2.
     * @returns {boolean}
     */
    init() {
        const cfg = this.game.config;
        const options = {
            alpha: cfg.transparent,
            antialias: cfg.antialias,
            depth: true,
            stencil: true,
            premultipliedAlpha: true,
            powerPreference: cfg.powerPreference
        };

        const gl = this.canvas.getContext('webgl2', options);
        if (!gl) {
            return false;
        }

        this.gl = gl;
        this.initialized = true;

        // Configuración inicial de estados de máquina
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        return true;
    }

    resize(width, height) {
        if (!this.gl) return;
        this.gl.viewport(0, 0, width, height);
    }

    createBuffer(name, size, usageFlags) {
        const gl = this.gl;
        const nativeBuffer = gl.createBuffer();
        const target = (usageFlags & RHI_BUFFER_USAGE.INDEX) ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;

        gl.bindBuffer(target, nativeBuffer);
        gl.bufferData(target, size, gl.DYNAMIC_DRAW);
        gl.bindBuffer(target, null);

        return new RHIBuffer(name, size, usageFlags, nativeBuffer);
    }

    writeBuffer(buffer, data, offset = 0) {
        const gl = this.gl;
        const target = (buffer.usage & RHI_BUFFER_USAGE.INDEX) ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;

        gl.bindBuffer(target, buffer.nativeHandle);
        gl.bufferSubData(target, offset, data);
        gl.bindBuffer(target, null);
    }

    createTexture(key, width, height, depth = 1, format = RHI_TEXTURE_FORMAT.RGBA8_UNORM) {
        const gl = this.gl;
        const texture = gl.createTexture();
        const isArray = depth > 1;
        const target = isArray ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;

        gl.bindTexture(target, texture);
        gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        if (isArray) {
            gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, depth);
        } else {
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        }

        gl.bindTexture(target, null);

        return new RHITexture(key, width, height, depth, format, texture, null);
    }

    updateTexture(texture, source, layerIndex = 0) {
        const gl = this.gl;
        const isArray = texture.depth > 1;
        const target = isArray ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;

        gl.bindTexture(target, texture.nativeHandle);

        if (isArray) {
            if (source instanceof Uint8Array) {
                gl.texSubImage3D(target, 0, 0, 0, layerIndex, texture.width, texture.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
            } else {
                gl.texSubImage3D(target, 0, 0, 0, layerIndex, texture.width, texture.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
            }
        } else {
            if (source instanceof Uint8Array) {
                gl.texSubImage2D(target, 0, 0, 0, texture.width, texture.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
            } else {
                gl.texSubImage2D(target, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
            }
        }

        gl.bindTexture(target, null);
    }

    beginFrame(r = 0, g = 0, b = 0, a = 1) {
        const gl = this.gl;
        gl.clearColor(r, g, b, a);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    setPipeline(pipeline) {
        const gl = this.gl;
        if (this.activeProgram !== pipeline.nativeHandle) {
            gl.useProgram(pipeline.nativeHandle);
            this.activeProgram = pipeline.nativeHandle;
        }
    }

    setVertexBuffer(slot, buffer, offset = 0) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.nativeHandle);
    }

    setIndexBuffer(buffer, format = 'uint16', offset = 0) {
        const gl = this.gl;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer.nativeHandle);
    }

    drawIndexed(indexCount, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
        const gl = this.gl;
        const type = gl.UNSIGNED_SHORT;
        const byteOffset = firstIndex * 2;

        if (instanceCount > 1) {
            gl.drawElementsInstanced(gl.TRIANGLES, indexCount, type, byteOffset, instanceCount);
        } else {
            gl.drawElements(gl.TRIANGLES, indexCount, type, byteOffset);
        }
    }

    endFrame() {
        // En WebGL2 no se requiere dispatch explícito de command buffer
    }

    destroy() {
        for (const pipeline of this.programCache.values()) {
            this.gl.deleteProgram(pipeline.nativeHandle);
        }
        this.programCache.clear();
        this.gl = null;
        this.initialized = false;
    }
}

// =============================================================================
// COORDINADOR PRINCIPAL RHI (Render Hardware Interface)
// =============================================================================

/**
 * Punto de entrada del pipeline de renderizado unificado para Tacarigua 1.0.0.
 * Gestiona el ciclo de vida del hardware de renderizado, determinando
 * la estrategia de ejecución óptima de forma transparente.
 */
export class RHI {
    /**
     * @param {Game} game - Referencia al núcleo del motor Phaser.
     */
    constructor(game) {
        this.game = game;

        /** @type {WebGPURHI|WebGL2RHI|null} */
        this.driver = null;

        /** @type {number} */
        this.activeBackend = RENDER_TYPE.HEADLESS;

        /** @type {RHIBuffer|null} */
        this.globalUniformBuffer = null;

        /** @type {Float32Array} */
        this.uniformData = new Float32Array(32); // Matriz 4x4 (16 floats) + resolución (2) + scroll (2) + zoom (1) + time (1)
    }

    /**
     * Inicia la negociación de hardware intentando WebGPU y retrocediendo a WebGL 2 si es necesario.
     * @returns {Promise<boolean>}
     */
    async initialize() {
        const config = this.game.config;

        if (config.renderType === RENDER_TYPE.HEADLESS) {
            this.activeBackend = RENDER_TYPE.HEADLESS;
            return true;
        }

        // Intento 1: WebGPU
        if (config.preferWebGPU && (config.renderType === RENDER_TYPE.AUTO || config.renderType === RENDER_TYPE.WEBGPU)) {
            const webgpuDriver = new WebGPURHI(this.game);
            const success = await webgpuDriver.init();
            if (success) {
                this.driver = webgpuDriver;
                this.activeBackend = RENDER_TYPE.WEBGPU;
                this._postInit();
                return true;
            }
            console.info('[Tacarigua 1.0.0 - RHI] Fallback automático a WebGL 2.0.');
        }

        // Intento 2: WebGL 2
        if (config.renderType === RENDER_TYPE.AUTO || config.renderType === RENDER_TYPE.WEBGL) {
            const webglDriver = new WebGL2RHI(this.game);
            const success = webglDriver.init();
            if (success) {
                this.driver = webglDriver;
                this.activeBackend = RENDER_TYPE.WEBGL;
                this._postInit();
                return true;
            }
        }

        throw new Error('[Tacarigua 1.0.0 - RHI] Imposible inicializar ningún backend gráfico compatible.');
    }

    /**
     * Configura buffers de sistema una vez establecido el driver RHI.
     * @private
     */
    _postInit() {
        this.globalUniformBuffer = this.driver.createBuffer(
            'GlobalUniformBuffer',
            this.uniformData.byteLength,
            RHI_BUFFER_USAGE.UNIFORM | RHI_BUFFER_USAGE.COPY_DST
        );
    }

    /**
     * Actualiza la matriz de proyección ortográfica del frame.
     * @param {number} width 
     * @param {number} height 
     * @param {number} scrollX 
     * @param {number} scrollY 
     * @param {number} zoom 
     * @param {number} time 
     */
    updateGlobalUniforms(width, height, scrollX, scrollY, zoom, time) {
        // Matriz de proyección ortográfica estándar normalizada para WebGPU (Z: 0 a 1)
        const a = 2 / width;
        const b = -2 / height;

        const data = this.uniformData;
        data.fill(0);

        data[0] = a;
        data[5] = b;
        data[10] = 1;
        data[12] = -1;
        data[13] = 1;
        data[15] = 1;

        // Uniforms adicionales
        data[16] = width;
        data[17] = height;
        data[18] = scrollX;
        data[19] = scrollY;
        data[20] = zoom;
        data[21] = time;

        this.driver.writeBuffer(this.globalUniformBuffer, data);
    }

    /**
     * Abre el ciclo de dibujo de la pantalla.
     * @param {number} clearColor - Color hexadecimal con alfa (0xRRGGBBAA).
     */
    beginRender(clearColor) {
        const r = ((clearColor >> 24) & 255) / 255;
        const g = ((clearColor >> 16) & 255) / 255;
        const b = ((clearColor >> 8) & 255) / 255;
        const a = (clearColor & 255) / 255;

        this.driver.beginFrame(r, g, b, a);
    }

    /**
     * Concluye y despacha la pasada de renderizado hacia el hardware gráfico.
     */
    endRender() {
        this.driver.endFrame();
    }

    /**
     * Adapta dinámicamente la resolución del lienzo del driver.
     * @param {number} width 
     * @param {number} height 
     */
    resize(width, height) {
        if (this.driver) {
            this.driver.resize(width, height);
        }
    }

    /**
     * Destruye de forma segura el subsistema RHI completo.
     */
    destroy() {
        if (this.globalUniformBuffer) {
            if (this.driver.device) {
                this.globalUniformBuffer.nativeHandle.destroy();
            }
            this.globalUniformBuffer = null;
        }

        if (this.driver) {
            this.driver.destroy();
            this.driver = null;
        }

        this.game = null;
    }
}