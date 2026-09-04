/**
 * @fileoverview Banco de pruebas unitarias, emulador WebGPU y validación de rendimiento para Tacarigua 1.0.0.
 * @module @tacarigua/testing
 * @license Phaser - Licencia MIT
 */

import { TimeStep, Signal, EventEmitter } from './core.js';
import { ECSWorld, MovementSystem } from './ecs.js';
import { SpriteBatcher, VERTICES_PER_QUAD, QUAD_SIZE_BYTES } from './batch-renderer-2d.js';
import { BinaryPacket } from './net.js';

// =============================================================================
// EMULADOR DE HARDWARE WEBGPU (MOCK HARDWARE INTERFACE)
// =============================================================================

/**
 * Emula la API de WebGPU para posibilitar la ejecución de pruebas unitarias en entornos headless (Node.js/CI).
 */
export class WebGPUMock {
    /**
     * Instala el emulador en el objeto global si no existe soporte nativo de WebGPU.
     */
    static install() {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            const mock = new WebGPUMock();
            const fakeNavigator = typeof navigator !== 'undefined' ? navigator : {};
            fakeNavigator.gpu = mock;
            globalThis.navigator = fakeNavigator;
        }
    }

    constructor() {
        this.limits = {
            maxBufferSize: 1024 * 1024 * 1024,
            maxStorageBufferBindingSize: 1024 * 1024 * 1024
        };
    }

    getPreferredCanvasFormat() {
        return 'rgba8unorm';
    }

    async requestAdapter(options = {}) {
        return {
            limits: this.limits,
            requestDevice: async () => this.createMockDevice()
        };
    }

    createMockDevice() {
        const buffers = new Set();
        const textures = new Set();

        return {
            lost: new Promise(() => { }), // Nunca se pierde en el mock

            queue: {
                writeBuffer: (buffer, offset, data) => {
                    const destView = new Uint8Array(buffer._underlyingBuffer, offset);
                    const srcView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    destView.set(srcView);
                },
                writeTexture: () => { },
                copyExternalImageToTexture: () => { },
                submit: (commandBuffers) => { }
            },

            createBuffer: (desc) => {
                const nativeBuffer = {
                    label: desc.label,
                    size: desc.size,
                    usage: desc.usage,
                    _underlyingBuffer: new ArrayBuffer(desc.size),
                    destroy: function () {
                        this._underlyingBuffer = null;
                        buffers.delete(this);
                    }
                };
                buffers.add(nativeBuffer);
                return nativeBuffer;
            },

            createTexture: (desc) => {
                const nativeTexture = {
                    label: desc.label,
                    width: desc.size.width,
                    height: desc.size.height,
                    format: desc.format,
                    createView: () => ({ label: `View_${desc.label}` }),
                    destroy: function () {
                        textures.delete(this);
                    }
                };
                textures.add(nativeTexture);
                return nativeTexture;
            },

            createSampler: (desc) => ({ label: 'MockSampler', desc }),

            createShaderModule: (desc) => ({ label: desc.label, code: desc.code }),

            createRenderPipeline: (desc) => ({
                label: desc.label,
                getBindGroupLayout: () => ({ label: 'MockBindGroupLayout' })
            }),

            createBindGroup: (desc) => ({ label: desc.label }),

            createCommandEncoder: () => ({
                beginRenderPass: () => ({
                    setPipeline: () => { },
                    setBindGroup: () => { },
                    setVertexBuffer: () => { },
                    setIndexBuffer: () => { },
                    drawIndexed: () => { },
                    end: () => { }
                }),
                finish: () => ({ label: 'MockCommandBuffer' })
            }),

            destroy: () => {
                for (const b of buffers) b.destroy();
                for (const t of textures) t.destroy();
                buffers.clear();
                textures.clear();
            }
        };
    }
}

// =============================================================================
// VALIDADOR DE RECOLECCIÓN DE BASURA Y FUGAS DE MEMORIA (MEMORY LEAK ASSERTIONS)
// =============================================================================

/**
 * Valida que una rutina en bucle no asigne memoria volátil en el montón (Heap).
 */
export class MemoryLeakValidator {
    /**
     * Mide el comportamiento de memoria en múltiples iteraciones.
     * @param {Function} iterationFn - Función ejecutada en cada frame simulado.
     * @param {number} [warmupCycles=100] - Ciclos de calentamiento para estabilizar el JIT.
     * @param {number} [testCycles=1000] - Ciclos de evaluación estricta.
     * @returns {{passed: boolean, allocatedBytesEstimate: number}}
     */
    static testZeroAllocation(iterationFn, warmupCycles = 100, testCycles = 1000) {
        // 1. Fase de calentamiento del compilador JIT (V8/SpiderMonkey)
        for (let i = 0; i < warmupCycles; i++) {
            iterationFn();
        }

        // Forzar GC si el flag de Node.js --expose-gc está disponible
        if (typeof globalThis.gc === 'function') {
            globalThis.gc();
        }

        const startMemory = typeof process !== 'undefined' && process.memoryUsage ?
            process.memoryUsage().heapUsed : 0;

        // 2. Fase de medición estricta
        for (let i = 0; i < testCycles; i++) {
            iterationFn();
        }

        const endMemory = typeof process !== 'undefined' && process.memoryUsage ?
            process.memoryUsage().heapUsed : 0;

        const allocatedBytes = Math.max(0, endMemory - startMemory);

        // Si se ejecutó con exposición de GC, la diferencia debe ser insignificante (< 1024 bytes de ruido)
        const passed = allocatedBytes < 1024;

        return {
            passed,
            allocatedBytesEstimate: allocatedBytes
        };
    }
}

// =============================================================================
// BANCO DE PRUEBAS UNITARIAS (TEST RUNNER & ASSERTIONS)
// =============================================================================

/**
 * Sistema de aserciones liviano integrado para ejecutar sin frameworks externos.
 */
export class Assert {
    static isTrue(condition, message) {
        if (!condition) {
            throw new Error(`[ASSERT FAIL] Se esperaba 'true': ${message}`);
        }
    }

    static isFalse(condition, message) {
        if (condition) {
            throw new Error(`[ASSERT FAIL] Se esperaba 'false': ${message}`);
        }
    }

    static equal(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(`[ASSERT FAIL] Esperado '${expected}', obtenido '${actual}': ${message}`);
        }
    }

    static closeTo(actual, expected, delta, message) {
        if (Math.abs(actual - expected) > delta) {
            throw new Error(`[ASSERT FAIL] Esperado '${expected}' (+/- ${delta}), obtenido '${actual}': ${message}`);
        }
    }
}

/**
 * Suite de pruebas unitarias para los subsistemas centrales de Tacarigua 1.0.0.
 */
export class CoreUnitTests {
    static async runAll() {
        console.log('--- INICIANDO PRUEBAS UNITARIAS DE Tacarigua 1.0.0 ---');

        WebGPUMock.install();

        this.testSignal();
        this.testEventEmitter();
        this.testTimeStep();
        this.testECSWorld();
        this.testMovementSystem();
        this.testBinaryPacket();
        await this.testSpriteBatcher();

        console.log('--- TODAS LAS PRUEBAS UNITARIAS PASARON EXITOSAMENTE [OK] ---');
    }

    static testSignal() {
        const signal = new Signal();
        let calls = 0;
        let receivedValue = '';

        const binding = signal.add((val) => {
            calls++;
            receivedValue = val;
        });

        signal.dispatch('Evento 1');
        Assert.equal(calls, 1, 'Signal debe despachar a los suscriptores');
        Assert.equal(receivedValue, 'Evento 1', 'Signal debe transmitir argumentos');

        signal.detach(binding);
        signal.dispatch('Evento 2');
        Assert.equal(calls, 1, 'Signal detached no debe recibir disparos');

        // Prueba de once
        let onceCalls = 0;
        signal.addOnce(() => onceCalls++);
        signal.dispatch();
        signal.dispatch();
        Assert.equal(onceCalls, 1, 'addOnce solo debe disparar una vez');
    }

    static testEventEmitter() {
        const emitter = new EventEmitter();
        let count = 0;

        const handler = (increment) => { count += increment; };
        emitter.on('increment', handler);

        emitter.emit('increment', 5);
        Assert.equal(count, 5, 'EventEmitter debe sumar con argumentos');

        emitter.off('increment', handler);
        emitter.emit('increment', 10);
        Assert.equal(count, 5, 'EventEmitter off debe desuscribir correctamente');
    }

    static testTimeStep() {
        const fakeGame = { events: new EventEmitter() };
        const timeStep = new TimeStep(fakeGame, { targetFps: 60, smoothStep: true });

        // Simular 30 cuadros regulares
        let simulatedTime = 1000.0;
        const frameInterval = 1000.0 / 60.0;

        timeStep.resetDelta(simulatedTime);

        for (let i = 0; i < 30; i++) {
            simulatedTime += frameInterval;
            const smoothed = timeStep.smoothDelta(frameInterval);
            Assert.closeTo(smoothed, frameInterval, 0.05, 'El suavizado temporal debe oscilar cerca del intervalo de 60 FPS');
        }

        // Validación de cero asignaciones en el cálculo de delta
        const leakCheck = MemoryLeakValidator.testZeroAllocation(() => {
            timeStep.smoothDelta(16.666);
        }, 50, 500);

        Assert.isTrue(leakCheck.passed, 'TimeStep.smoothDelta no debe alojar memoria en el heap');
    }

    static testECSWorld() {
        const world = new ECSWorld(1024);

        const entityA = world.createEntity();
        const entityB = world.createEntity();

        Assert.isTrue(world.isAlive(entityA), 'La entidad A debe estar viva');
        Assert.isTrue(world.isAlive(entityB), 'La entidad B debe estar viva');

        world.addComponent(entityA, world.Transform, { x: 100, y: 200 });
        world.addComponent(entityA, world.Velocity, { vx: 50, vy: -20 });

        const indexA = entityA & 0xfffff;
        Assert.equal(world.Transform.columns.x[indexA], 100, 'ComponentStore debe persistir la coordenada X');
        Assert.equal(world.Transform.columns.y[indexA], 200, 'ComponentStore debe persistir la coordenada Y');
        Assert.equal(world.Velocity.columns.vx[indexA], 50, 'ComponentStore debe persistir la velocidad VX');

        const query = world.createQuery([world.Transform, world.Velocity]);
        Assert.equal(query.entities.length, 1, 'La consulta debe coincidir exactamente con la entidad A');
        Assert.equal(query.entities[0], entityA, 'El ID de la entidad en la consulta debe ser entityA');

        // Destrucción y reciclaje generacional
        world.destroyEntity(entityA);
        Assert.isFalse(world.isAlive(entityA), 'La entidad A debe figurar como no viva tras destruirse');
        Assert.equal(query.entities.length, 0, 'La consulta debe haber purgado a entityA en O(1)');

        const recycledEntity = world.createEntity();
        const indexRecycled = recycledEntity & 0xfffff;
        const genRecycled = recycledEntity >>> 20;

        Assert.equal(indexRecycled, indexA, 'El índice de la entidad destruida debe ser reutilizado');
        Assert.equal(genRecycled, 1, 'La generación de la entidad reciclada debe haberse incrementado a 1');
    }

    static testMovementSystem() {
        const world = new ECSWorld(128);
        const movement = new MovementSystem(world);
        world.addSystem(movement);

        const entity = world.createEntity();
        world.addComponent(entity, world.Transform, { x: 0, y: 0, rotation: 0 });
        world.addComponent(entity, world.Velocity, { vx: 100, vy: 200, angularVelocity: 1.5 });

        // Simular 1 segundo exacto (delta = 1000ms)
        world.step(1000, 1000);

        const idx = entity & 0xfffff;
        Assert.closeTo(world.Transform.columns.x[idx], 100, 0.001, 'Posición X debe avanzar acorde a VX');
        Assert.closeTo(world.Transform.columns.y[idx], 200, 0.001, 'Posición Y debe avanzar acorde a VY');
        Assert.closeTo(world.Transform.columns.rotation[idx], 1.5, 0.001, 'Rotación debe avanzar acorde a velocidad angular');
    }

    static testBinaryPacket() {
        const packet = new BinaryPacket(256);

        packet.writeUint8(255);
        packet.writeInt16(-1234);
        packet.writeInt32(98765432);
        packet.writeFloat32(3.14159);
        packet.writeString('Tacarigua 1.0.0 WebGPU');

        packet.reset();

        Assert.equal(packet.readUint8(), 255, 'Uint8 debe ser idéntico');
        Assert.equal(packet.readInt16(), -1234, 'Int16 debe ser idéntico');
        Assert.equal(packet.readInt32(), 98765432, 'Int32 debe ser idéntico');
        Assert.closeTo(packet.readFloat32(), 3.14159, 0.0001, 'Float32 debe preservar precisión decimal');
        Assert.equal(packet.readString(), 'Tacarigua 1.0.0 WebGPU', 'String UTF-8 debe decodificarse intacto');
    }

    static async testSpriteBatcher() {
        // Configuración de RHI simulada con el mock de WebGPU
        const mockDevice = new WebGPUMock().createMockDevice();
        const fakeRHI = {
            driver: {
                device: mockDevice,
                createBuffer: (name, size, usage) => ({
                    name, size, usage, nativeHandle: mockDevice.createBuffer({ label: name, size, usage })
                }),
                writeBuffer: (buf, data) => mockDevice.queue.writeBuffer(buf.nativeHandle, 0, data),
                getOrCreateRenderPipeline: () => ({ nativeHandle: {}, layout: {} }),
                setPipeline: () => { },
                setVertexBuffer: () => { },
                setIndexBuffer: () => { },
                setBindGroup: () => { },
                drawIndexed: () => { }
            },
            globalUniformBuffer: { nativeHandle: {} },
            whiteTexture: { nativeView: {} }
        };

        const batcher = new SpriteBatcher(fakeRHI, 128);
        const fakeTexture = { key: 'atlas_01', nativeView: {} };

        batcher.begin();

        for (let i = 0; i < 10; i++) {
            batcher.batchQuad(
                i * 10, i * 20,
                32, 32,
                0,
                1, 1,
                0.5, 0.5,
                0, 0, 1, 1,
                0xffffff, 1.0,
                fakeTexture
            );
        }

        Assert.equal(batcher.quadCount, 10, 'Deben registrarse 10 quads en el lote');
        Assert.equal(batcher.vertexOffset, 10 * VERTICES_PER_QUAD * 6, 'El puntero de vértices debe avanzar exactamente');

        batcher.flush();
        Assert.equal(batcher.quadCount, 0, 'Tras el flush el contador de quads debe reiniciar a 0');
    }
}

// =============================================================================
// BANCO DE BENCHMARKING DE ALTO RENDIMIENTO (PERFORMANCE BENCHMARK RUNNER)
// =============================================================================

/**
 * Ejecutor de pruebas de estrés comparativas de velocidad de procesamiento.
 */
export class EngineBenchmarkRunner {
    /**
     * Ejecuta una serie de pruebas de estrés masivas y muestra el rendimiento en consola.
     */
    static runStressBenchmarks() {
        console.log('\n=============================================================');
        console.log('   INICIANDO BENCHMARK DE RENDIMIENTO MASIVO (Tacarigua 1.0.0)   ');
        console.log('=============================================================');

        this.benchmarkECSThroughput();
        this.benchmarkBatcherThroughput();
        this.benchmarkBinarySerialization();

        console.log('=============================================================\n');
    }

    /**
     * Benchmark 1: Procesamiento de 100.000 entidades en el motor ECS.
     */
    static benchmarkECSThroughput() {
        const entityCount = 100000;
        const world = new ECSWorld(entityCount);
        const movement = new MovementSystem(world);
        world.addSystem(movement);

        for (let i = 0; i < entityCount; i++) {
            const e = world.createEntity();
            world.addComponent(e, world.Transform, { x: i, y: i * 2, rotation: 0 });
            world.addComponent(e, world.Velocity, { vx: 10, vy: 20, angularVelocity: 0.1 });
        }

        // Calentamiento
        world.step(16.666, 16.666);

        const startTime = performance.now();
        const iterations = 60; // Simulación de 60 cuadros completos

        for (let i = 0; i < iterations; i++) {
            world.step(16.666, 16.666);
        }

        const elapsedMs = performance.now() - startTime;
        const avgFrameMs = elapsedMs / iterations;
        const updatesPerSec = Math.round((entityCount * iterations) / (elapsedMs / 1000));

        console.log(`[ECS MovementSystem] Entidades: ${entityCount.toLocaleString()} | 60 Frames`);
        console.log(`  -> Tiempo total: ${elapsedMs.toFixed(2)} ms`);
        console.log(`  -> Tiempo promedio por frame: ${avgFrameMs.toFixed(3)} ms (Objetivo 60 FPS: < 16.6 ms)`);
        console.log(`  -> Rendimiento: ${updatesPerSec.toLocaleString()} actualizaciones/seg`);
    }

    /**
     * Benchmark 2: Empaquetado de 250.000 Quads con transformaciones afines en SpriteBatcher.
     */
    static benchmarkBatcherThroughput() {
        const mockDevice = new WebGPUMock().createMockDevice();
        const fakeRHI = {
            driver: {
                device: mockDevice,
                createBuffer: (name, size, usage) => ({
                    name, size, usage, nativeHandle: mockDevice.createBuffer({ label: name, size, usage })
                }),
                writeBuffer: () => { },
                getOrCreateRenderPipeline: () => ({ nativeHandle: {}, layout: {} }),
                setPipeline: () => { },
                setVertexBuffer: () => { },
                setIndexBuffer: () => { },
                setBindGroup: () => { },
                drawIndexed: () => { }
            },
            globalUniformBuffer: { nativeHandle: {} },
            whiteTexture: { nativeView: {} }
        };

        const batcher = new SpriteBatcher(fakeRHI, 8192);
        const fakeTexture = { key: 'tex', nativeView: {} };
        const totalQuads = 250000;

        batcher.begin();
        const startTime = performance.now();

        for (let i = 0; i < totalQuads; i++) {
            batcher.batchQuad(
                100, 100,
                64, 64,
                0.785, // 45 grados para exigir cálculo trigonométrico
                1.5, 1.5,
                0.5, 0.5,
                0, 0, 1, 1,
                0xffffff, 1.0,
                fakeTexture
            );
        }

        const elapsedMs = performance.now() - startTime;
        const quadsPerSec = Math.round(totalQuads / (elapsedMs / 1000));

        console.log(`[SpriteBatcher] Transformación e Inyección de ${totalQuads.toLocaleString()} Quads`);
        console.log(`  -> Tiempo total de empaquetado: ${elapsedMs.toFixed(2)} ms`);
        console.log(`  -> Velocidad de procesado: ${quadsPerSec.toLocaleString()} quads/seg`);
    }

    /**
     * Benchmark 3: Serialización y Deserialización en memoria de BinaryPacket.
     */
    static benchmarkBinarySerialization() {
        const packet = new BinaryPacket(1024 * 1024); // 1 MB
        const operations = 100000;

        const startTime = performance.now();

        packet.reset();
        for (let i = 0; i < operations; i++) {
            packet.writeFloat32(123.456);
            packet.writeInt32(i);
        }

        packet.reset();
        for (let i = 0; i < operations; i++) {
            packet.readFloat32();
            packet.readInt32();
        }

        const elapsedMs = performance.now() - startTime;
        const opsPerSec = Math.round((operations * 2) / (elapsedMs / 1000));

        console.log(`[BinaryPacket] ${operations.toLocaleString()} escrituras + lecturas binarias`);
        console.log(`  -> Tiempo total: ${elapsedMs.toFixed(2)} ms`);
        console.log(`  -> Operaciones por segundo: ${opsPerSec.toLocaleString()} ops/seg`);
    }
}