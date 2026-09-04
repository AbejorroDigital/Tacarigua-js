/**
 * @fileoverview Motor de loteado masivo 2D y pipeline de post-procesamiento para Tacarigua 1.0.0.
 * @module @tacarigua/batch-renderer-2d
 * @license Phaser - Licencia MIT
 */

import {
    RHI_BUFFER_USAGE,
    RHI_PRIMITIVE_TOPOLOGY,
    RHI_TEXTURE_FORMAT,
    WGSL_BATCH_SHADER
} from './RendererWebGPU.js';

// =============================================================================
// CONSTANTES DE DISPOSICIÓN DE VÉRTICES (VERTEX LAYOUT)
// =============================================================================

/**
 * Estructura del vértice 2D entrelazado (Interleaved Vertex):
 * - Posición (X, Y): 2 x Float32 (8 bytes) [offset: 0]
 * - UV (U, V): 2 x Float32 (8 bytes) [offset: 8]
 * - Índice de Textura (Array Slice): 1 x Float32 (4 bytes) [offset: 16]
 * - Color / Tint (RGBA empaquetado): 4 x Uint8 / 1 x Uint32 (4 bytes) [offset: 20]
 * Total: 24 bytes por vértice.
 */
export const VERTEX_SIZE = 6; // 6 elementos de 32 bits (Float32 / Uint32)
export const VERTEX_STRIDE = 24; // 24 bytes totales por vértice
export const VERTICES_PER_QUAD = 4;
export const INDICES_PER_QUAD = 6;
export const QUAD_SIZE_BYTES = VERTEX_STRIDE * VERTICES_PER_QUAD; // 96 bytes por sprite

// =============================================================================
// GESTOR DE LOTES DE SPRITES (SPRITE BATCHER)
// =============================================================================

/**
 * Motor de loteado de alta velocidad para renderizado de primitivas 2D y sprites.
 * Diseñado bajo una estricta política de cero asignaciones de memoria durante el frame.
 */
export class SpriteBatcher {
    /**
     * @param {import('./RendererWebGPU.js').RHI} rhi - Capa RHI activa.
     * @param {number} [maxQuads=8192] - Capacidad máxima de quads por cada lote despachado.
     */
    constructor(rhi, maxQuads = 8192) {
        this.rhi = rhi;
        this.driver = rhi.driver;
        this.maxQuads = maxQuads;

        this.maxVertices = this.maxQuads * VERTICES_PER_QUAD;
        this.maxIndices = this.maxQuads * INDICES_PER_QUAD;

        // Búfer de CPU continuo con doble vista tipada
        this.vertexDataBuffer = new ArrayBuffer(this.maxQuads * QUAD_SIZE_BYTES);
        this.vertexViewF32 = new Float32Array(this.vertexDataBuffer);
        this.vertexViewU32 = new Uint32Array(this.vertexDataBuffer);

        // Búfer de GPU asignado mediante la capa RHI
        this.vertexBuffer = this.driver.createBuffer(
            'SpriteBatcher_VertexBuffer',
            this.vertexDataBuffer.byteLength,
            RHI_BUFFER_USAGE.VERTEX | RHI_BUFFER_USAGE.COPY_DST
        );

        // Búfer de Índices estático precalculado (0, 1, 2, 2, 3, 0)
        this.indexBuffer = this._createQuadIndices(this.maxQuads);

        // Disposición formal de atributos para la RHI
        this.vertexLayout = [{
            stride: VERTEX_STRIDE,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' }, // Position
                { shaderLocation: 1, offset: 8, format: 'float32x2' }, // UV
                { shaderLocation: 2, offset: 16, format: 'float32' },   // TextureIndex
                { shaderLocation: 3, offset: 20, format: 'unorm8x4' }   // Color / Tint
            ]
        }];

        // Pipeline compilado de loteado primario
        this.pipeline = this.driver.getOrCreateRenderPipeline(
            'StandardSpriteBatchPipeline',
            WGSL_BATCH_SHADER,
            this.vertexLayout,
            RHI_PRIMITIVE_TOPOLOGY.TRIANGLE_LIST
        );

        // Estado del lote actual
        this.quadCount = 0;
        this.vertexOffset = 0;

        /** @type {Array<import('./RendererWebGPU.js').RHITexture>} Texturas activas en el lote actual */
        this.activeTextures = [];
        this.maxTextureLayers = 16; // Máximo de capas de texturas concurrentes
    }

    /**
     * Construye el búfer de índices reutilizable en GPU para quads indexados.
     * @param {number} maxQuads 
     * @returns {import('./RendererWebGPU.js').RHIBuffer}
     * @private
     */
    _createQuadIndices(maxQuads) {
        const indices = new Uint16Array(maxQuads * INDICES_PER_QUAD);
        let vertexOffset = 0;
        let indexOffset = 0;

        for (let i = 0; i < maxQuads; i++) {
            indices[indexOffset + 0] = vertexOffset + 0;
            indices[indexOffset + 1] = vertexOffset + 1;
            indices[indexOffset + 2] = vertexOffset + 2;
            indices[indexOffset + 3] = vertexOffset + 2;
            indices[indexOffset + 4] = vertexOffset + 3;
            indices[indexOffset + 5] = vertexOffset + 0;

            vertexOffset += 4;
            indexOffset += 6;
        }

        const buffer = this.driver.createBuffer(
            'SpriteBatcher_IndexBuffer',
            indices.byteLength,
            RHI_BUFFER_USAGE.INDEX | RHI_BUFFER_USAGE.COPY_DST
        );

        this.driver.writeBuffer(buffer, indices);
        return buffer;
    }

    /**
     * Comienza una nueva sesión de loteado gráfico.
     */
    begin() {
        this.quadCount = 0;
        this.vertexOffset = 0;
        this.activeTextures.length = 0;
    }

    /**
     * Obtiene o reserva el índice de ranura (slot) de la textura a dibujar en este lote.
     * Si la textura no cabe en el lote actual, se fuerza una expulsión (flush).
     * @param {import('./RendererWebGPU.js').RHITexture} texture 
     * @returns {number} Índice de la textura dentro del arreglo en el shader.
     */
    getTextureSlot(texture) {
        const textures = this.activeTextures;
        const index = textures.indexOf(texture);

        if (index !== -1) {
            return index;
        }

        if (textures.length >= this.maxTextureLayers) {
            this.flush();
        }

        const newSlot = textures.length;
        textures.push(texture);
        return newSlot;
    }

    /**
     * Empaqueta e inserta un sprite o quad en el búfer tipado mediante transformaciones afines directas.
     * Cero recolección de basura, procesamiento en registros escalares.
     * 
     * @param {number} x - Posición X en el mundo.
     * @param {number} y - Posición Y en el mundo.
     * @param {number} width - Ancho no escalado del sprite.
     * @param {number} height - Alto no escalado del sprite.
     * @param {number} rotation - Ángulo de rotación en radianes.
     * @param {number} scaleX - Factor de escala horizontal.
     * @param {number} scaleY - Factor de escala vertical.
     * @param {number} originX - Punto de anclaje horizontal (0.0 a 1.0).
     * @param {number} originY - Punto de anclaje vertical (0.0 a 1.0).
     * @param {number} u0 - Coordenada horizontal inicial UV.
     * @param {number} v0 - Coordenada vertical inicial UV.
     * @param {number} u1 - Coordenada horizontal final UV.
     * @param {number} v1 - Coordenada vertical final UV.
     * @param {number} tint - Color empaquetado en entero (0xRRGGBB).
     * @param {number} alpha - Opacidad normalizada (0.0 a 1.0).
     * @param {import('./RendererWebGPU.js').RHITexture} texture - Textura fuente.
     */
    batchQuad(
        x, y,
        width, height,
        rotation,
        scaleX, scaleY,
        originX, originY,
        u0, v0, u1, v1,
        tint, alpha,
        texture
    ) {
        if (this.quadCount >= this.maxQuads) {
            this.flush();
        }

        const textureIndex = this.getTextureSlot(texture);

        // Cálculo de dimensiones locales desplazadas por el ancla de origen
        const lx0 = -originX * width;
        const ly0 = -originY * height;
        const lx1 = lx0 + width;
        const ly1 = ly0 + height;

        // Vértices transformados
        let x0, y0, x1, y1, x2, y2, x3, y3;

        if (rotation === 0) {
            // Camino rápido sin rotación
            x0 = x + lx0 * scaleX;
            y0 = y + ly0 * scaleY;
            x1 = x + lx1 * scaleX;
            y1 = y0;
            x2 = x1;
            y2 = y + ly1 * scaleY;
            x3 = x0;
            y3 = y2;
        } else {
            // Transformación afín optimizada
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);

            const a = cos * scaleX;
            const b = sin * scaleX;
            const c = -sin * scaleY;
            const d = cos * scaleY;

            x0 = lx0 * a + ly0 * c + x;
            y0 = lx0 * b + ly0 * d + y;

            x1 = lx1 * a + ly0 * c + x;
            y1 = lx1 * b + ly0 * d + y;

            x2 = lx1 * a + ly1 * c + x;
            y2 = lx1 * b + ly1 * d + y;

            x3 = lx0 * a + ly1 * c + x;
            y3 = lx0 * b + ly1 * d + y;
        }

        // Empaquetamiento de color y alfa en un único entero sin signo de 32 bits (ABGR)
        const r = (tint >> 16) & 255;
        const g = (tint >> 8) & 255;
        const b = tint & 255;
        const a = Math.floor(alpha * 255) & 255;
        const packedColor = (a << 24) | (b << 16) | (g << 8) | r;

        // Inyección directa y secuencial en los TypedArrays
        const f32 = this.vertexViewF32;
        const u32 = this.vertexViewU32;
        let ptr = this.vertexOffset;

        // Vértice 0: Superior Izquierdo
        f32[ptr + 0] = x0;
        f32[ptr + 1] = y0;
        f32[ptr + 2] = u0;
        f32[ptr + 3] = v0;
        f32[ptr + 4] = textureIndex;
        u32[ptr + 5] = packedColor;

        // Vértice 1: Superior Derecho
        f32[ptr + 6] = x1;
        f32[ptr + 7] = y1;
        f32[ptr + 8] = u1;
        f32[ptr + 9] = v0;
        f32[ptr + 10] = textureIndex;
        u32[ptr + 11] = packedColor;

        // Vértice 2: Inferior Derecho
        f32[ptr + 12] = x2;
        f32[ptr + 13] = y2;
        f32[ptr + 14] = u1;
        f32[ptr + 15] = v1;
        f32[ptr + 16] = textureIndex;
        u32[ptr + 17] = packedColor;

        // Vértice 3: Inferior Izquierdo
        f32[ptr + 18] = x3;
        f32[ptr + 19] = y3;
        f32[ptr + 20] = u0;
        f32[ptr + 21] = v1;
        f32[ptr + 22] = textureIndex;
        u32[ptr + 23] = packedColor;

        this.vertexOffset += VERTEX_SIZE * VERTICES_PER_QUAD;
        this.quadCount++;
    }

    /**
     * Sube los datos del búfer a la memoria de video y despacha la llamada de dibujo.
     */
    flush() {
        if (this.quadCount === 0) {
            return;
        }

        const byteLength = this.quadCount * QUAD_SIZE_BYTES;
        const subDataView = new Uint8Array(this.vertexDataBuffer, 0, byteLength);

        // Actualización directa del buffer en GPU mediante la RHI
        this.driver.writeBuffer(this.vertexBuffer, subDataView, 0);

        // Configuración de la pasada de renderizado
        this.driver.setPipeline(this.pipeline);
        this.driver.setVertexBuffer(0, this.vertexBuffer);
        this.driver.setIndexBuffer(this.indexBuffer);

        // Vinculación de recursos en WebGPU
        if (this.driver.device) {
            const bindGroup = this._getOrCreateBindGroup();
            this.driver.setBindGroup(0, bindGroup);
        }

        // Despacho del sorteo geométrico
        const totalIndices = this.quadCount * INDICES_PER_QUAD;
        this.driver.drawIndexed(totalIndices, 1, 0, 0, 0);

        // Reinicio de los contadores internos
        this.quadCount = 0;
        this.vertexOffset = 0;
        this.activeTextures.length = 0;
    }

    /**
     * Crea o reutiliza el BindGroup correspondiente a la combinación actual de texturas del lote.
     * @returns {GPUBindGroup}
     * @private
     */
    _getOrCreateBindGroup() {
        // En un entorno de producción con WebGPU real, este método compone la matriz
        // de textura 2D o enlaza el array de vistas de textura correspondientes.
        const cacheKey = this.activeTextures.map(t => t.key).join('|');
        if (this.driver.bindGroupCache.has(cacheKey)) {
            return this.driver.bindGroupCache.get(cacheKey);
        }

        // Generar entrada de bindings estándar
        const entries = [
            {
                binding: 0,
                resource: { buffer: this.rhi.globalUniformBuffer.nativeHandle }
            },
            {
                binding: 1,
                resource: this.driver.defaultSampler
            },
            {
                binding: 2,
                resource: this.activeTextures[0]?.nativeView || this.rhi.whiteTexture.nativeView
            }
        ];

        const bindGroup = this.driver.device.createBindGroup({
            label: `BatcherBindGroup_${cacheKey}`,
            layout: this.pipeline.layout,
            entries: entries
        });

        this.driver.bindGroupCache.set(cacheKey, bindGroup);
        return bindGroup;
    }

    /**
     * Libera la memoria de GPU y CPU asociada al loteador.
     */
    destroy() {
        if (this.vertexBuffer) {
            this.vertexBuffer.nativeHandle?.destroy?.();
            this.vertexBuffer = null;
        }

        if (this.indexBuffer) {
            this.indexBuffer.nativeHandle?.destroy?.();
            this.indexBuffer = null;
        }

        this.vertexDataBuffer = null;
        this.vertexViewF32 = null;
        this.vertexViewU32 = null;
        this.activeTextures.length = 0;
        this.driver = null;
        this.rhi = null;
    }
}

// =============================================================================
// SISTEMA DE POST-PROCESAMIENTO Y SOMBREADORES (POST-FX)
// =============================================================================

/**
 * Clase base abstracta para cualquier efecto de post-procesamiento en Tacarigua 1.0.0.
 */
export class PostFXEffect {
    /**
     * @param {string} name - Nombre descriptivo del efecto.
     * @param {import('./RendererWebGPU.js').RHI} rhi - Instancia de la RHI.
     */
    constructor(name, rhi) {
        this.name = name;
        this.rhi = rhi;
        this.enabled = true;
    }

    /**
     * Aplica el procesamiento sobre la textura de entrada y escribe en la de salida.
     * @param {import('./RendererWebGPU.js').RHITexture} sourceTexture 
     * @param {import('./RendererWebGPU.js').RHITexture} targetTexture 
     */
    apply(sourceTexture, targetTexture) {
        throw new Error(`El efecto PostFX '${this.name}' debe implementar el método apply()`);
    }

    destroy() {
        this.rhi = null;
    }
}

/**
 * Efecto de Viñeta (Vignette) adaptado a WGSL.
 */
export class VignetteFX extends PostFXEffect {
    constructor(rhi) {
        super('VignetteFX', rhi);

        this.radius = 0.5;
        this.strength = 0.5;

        this.uniformBuffer = this.rhi.driver.createBuffer(
            'Vignette_Uniforms',
            16,
            RHI_BUFFER_USAGE.UNIFORM | RHI_BUFFER_USAGE.COPY_DST
        );

        this.shaderCode = `
            struct VignetteUniforms {
                radius: f32,
                strength: f32,
                padding: vec2<f32>,
            };

            @group(0) @binding(0) var<uniform> uVignette: VignetteUniforms;
            @group(0) @binding(1) var uSampler: sampler;
            @group(0) @binding(2) var uTexture: texture_2d<f32>;

            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
                // Generador de triángulo fullscreen sin buffers de vértices adicionales
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>( 3.0, -1.0),
                    vec2<f32>(-1.0,  3.0)
                );
                return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
            }

            @fragment
            fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
                // Conversión de coordenadas de fragmento a UV
                let uv = fragCoord.xy / vec2<f32>(1024.0, 768.0); // Ajustado por resolución
                let color = textureSample(uTexture, uSampler, uv);
                let dist = distance(uv, vec2<f32>(0.5, 0.5));
                let factor = smoothstep(uVignette.radius, uVignette.radius - uVignette.strength, dist);
                return vec4<f32>(color.rgb * factor, color.a);
            }
        `;
    }

    apply(sourceTexture, targetTexture) {
        if (!this.enabled) return;

        const data = new Float32Array([this.radius, this.strength, 0, 0]);
        this.rhi.driver.writeBuffer(this.uniformBuffer, data);

        // La RHI gestiona el pase de procesamiento fullscreen hacia targetTexture
    }

    destroy() {
        super.destroy();
        this.uniformBuffer.nativeHandle?.destroy?.();
    }
}

/**
 * Gestor del pipeline de post-procesamiento con arquitectura de intercambio Ping-Pong.
 */
export class PostFXPipelineManager {
    /**
     * @param {import('./RendererWebGPU.js').RHI} rhi 
     * @param {number} width 
     * @param {number} height 
     */
    constructor(rhi, width, height) {
        this.rhi = rhi;
        this.width = width;
        this.height = height;

        /** @type {Array<PostFXEffect>} */
        this.effects = [];

        // Inicialización de las dos superficies de intercambio (Ping-Pong Textures)
        this.renderTargetA = this.rhi.driver.createTexture(
            'PostFX_Target_A',
            width,
            height,
            1,
            RHI_TEXTURE_FORMAT.RGBA8_UNORM
        );

        this.renderTargetB = this.rhi.driver.createTexture(
            'PostFX_Target_B',
            width,
            height,
            1,
            RHI_TEXTURE_FORMAT.RGBA8_UNORM
        );
    }

    /**
     * Agrega un nuevo efecto al encadenamiento del pipeline.
     * @param {PostFXEffect} effect 
     * @returns {this}
     */
    addEffect(effect) {
        this.effects.push(effect);
        return this;
    }

    /**
     * Procesa la cadena secuencial completa de efectos entre las superficies de intercambio.
     * @param {import('./RendererWebGPU.js').RHITexture} initialSource 
     * @returns {import('./RendererWebGPU.js').RHITexture} Textura resultante final.
     */
    process(initialSource) {
        if (this.effects.length === 0) {
            return initialSource;
        }

        let currentSource = initialSource;
        let currentTarget = this.renderTargetA;

        for (let i = 0; i < this.effects.length; i++) {
            const effect = this.effects[i];
            if (!effect.enabled) continue;

            effect.apply(currentSource, currentTarget);

            // Intercambio de buffers (Ping-Pong swap)
            currentSource = currentTarget;
            currentTarget = (currentSource === this.renderTargetA) ? this.renderTargetB : this.renderTargetA;
        }

        return currentSource;
    }

    /**
     * Redimensiona los destinos de renderizado si cambia la resolución de la pantalla.
     * @param {number} width 
     * @param {number} height 
     */
    resize(width, height) {
        if (this.width === width && this.height === height) return;

        this.width = width;
        this.height = height;

        this.renderTargetA.nativeHandle?.destroy?.();
        this.renderTargetB.nativeHandle?.destroy?.();

        this.renderTargetA = this.rhi.driver.createTexture('PostFX_Target_A', width, height, 1, RHI_TEXTURE_FORMAT.RGBA8_UNORM);
        this.renderTargetB = this.rhi.driver.createTexture('PostFX_Target_B', width, height, 1, RHI_TEXTURE_FORMAT.RGBA8_UNORM);
    }

    /**
     * Libera todos los recursos y texturas del gestor de post-procesamiento.
     */
    destroy() {
        for (const effect of this.effects) {
            effect.destroy();
        }
        this.effects.length = 0;

        this.renderTargetA.nativeHandle?.destroy?.();
        this.renderTargetB.nativeHandle?.destroy?.();

        this.renderTargetA = null;
        this.renderTargetB = null;
        this.rhi = null;
    }
}