/**
 * @fileoverview Contratos de tipos y definiciones TypeScript estrictas para Tacarigua 1.0.0.
 * Empaquetado como módulo de declaraciones de tipo compatible con TypeScript 5+.
 * @module @tacarigua/types
 * @license Phaser - Licencia MIT
 */

/**
 * =============================================================================
 * DECLARACIONES Y CONTRATOS DE TIPOS PARA Tacarigua 1.0.0
 * =============================================================================
 */

export const PHASER_TYPES_DECLARATION = `
declare namespace Phaser {
    // =========================================================================
    // TIPOS MARCADOS Y PRIMITIVAS FUNDAMENTALES
    // =========================================================================

    /**
     * Identificador único de entidad en el motor ECS, marcado nominalmente.
     */
    export type EntityId = number & { readonly __brand: unique symbol };

    /**
     * Identificador numérico de lote o textura en memoria de GPU.
     */
    export type TextureSlotId = number & { readonly __slotBrand: unique symbol };

    /**
     * Tipos de datos soportados para componentes escalares continuos.
     */
    export type ComponentScalarType = 
        | 'f32' 
        | 'f64' 
        | 'i32' 
        | 'i16' 
        | 'i8' 
        | 'u32' 
        | 'u16' 
        | 'u8';

    /**
     * Esquema de propiedades para un almacén de componentes ECS.
     */
    export type ComponentSchema = Record<string, ComponentScalarType>;

    // =========================================================================
    // CONSTANTES Y CONFIGURACIÓN DEL MOTOR (CORE)
    // =========================================================================

    export enum RenderType {
        AUTO = 0,
        CANVAS = 1,
        WEBGL = 2,
        HEADLESS = 3,
        WEBGPU = 4
    }

    export enum BlendMode {
        SKIP_CHECK = -1,
        NORMAL = 0,
        ADD = 1,
        MULTIPLY = 2,
        SCREEN = 3,
        OVERLAY = 4,
        DARKEN = 5,
        LIGHTEN = 6,
        COLOR_DODGE = 7,
        COLOR_BURN = 8,
        HARD_LIGHT = 9,
        SOFT_LIGHT = 10,
        DIFFERENCE = 11,
        EXCLUSION = 12,
        HUE = 13,
        SATURATION = 14,
        COLOR = 15,
        LUMINOSITY = 16,
        ERASE = 17
    }

    export enum ScaleMode {
        NONE = 0,
        WIDTH_CONTROLS_HEIGHT = 1,
        HEIGHT_CONTROLS_WIDTH = 2,
        FIT = 3,
        ENVELOP = 4,
        RESIZE = 5,
        EXPAND = 6
    }

    export interface FPSConfig {
        minFps?: number;
        targetFps?: number;
        fpsLimit?: number;
        smoothStep?: boolean;
        panicMax?: number;
        deltaHistory?: number;
        forceSetTimeout?: boolean;
    }

    export interface RenderConfig {
        transparent?: boolean;
        clearBeforeRender?: boolean;
        antialias?: boolean;
        pixelArt?: boolean;
        roundPixels?: boolean;
        powerPreference?: 'high-performance' | 'low-power' | 'default';
        batchSize?: number;
        maxTextures?: number;
        preferWebGPU?: boolean;
        useComputeShaders?: boolean;
    }

    export interface GameConfig<
        TTextureKeys extends string = string,
        TAudioKeys extends string = string,
        TSceneKeys extends string = string
    > {
        width?: number | string;
        height?: number | string;
        zoom?: number;
        parent?: HTMLElement | string | null;
        scaleMode?: ScaleMode;
        type?: RenderType;
        backgroundColor?: number | string;
        render?: RenderConfig;
        fps?: FPSConfig;
        canvas?: HTMLCanvasElement | OffscreenCanvas | null;
        canvasStyle?: Partial<CSSStyleDeclaration> | null;
        customEnvironment?: boolean;
        scene?: SceneConstructor<TSceneKeys>[] | object[] | null;
        callbacks?: {
            preBoot?: (game: Game) => void;
            postBoot?: (game: Game) => void;
        };
    }

    // =========================================================================
    // EVENTOS Y SEÑALES REACTIVAS
    // =========================================================================

    export interface ISignalBinding {
        detach(): boolean;
    }

    export interface ISignal<TArgs extends any[] = []> {
        readonly hasListeners: boolean;
        add(fn: (...args: TArgs) => void, context?: any): ISignalBinding;
        addOnce(fn: (...args: TArgs) => void, context?: any): ISignalBinding;
        detach(binding: ISignalBinding): boolean;
        dispatch(...args: TArgs): void;
        clear(): void;
    }

    export interface IEventEmitter<TEventMap extends Record<string, any[]> = Record<string, any[]>> {
        on<K extends keyof TEventMap>(event: K, fn: (...args: TEventMap[K]) => void, context?: any): this;
        once<K extends keyof TEventMap>(event: K, fn: (...args: TEventMap[K]) => void, context?: any): this;
        emit<K extends keyof TEventMap>(event: K, ...args: TEventMap[K]): boolean;
        off<K extends keyof TEventMap>(event: K, fn?: (...args: TEventMap[K]) => void, context?: any): this;
        removeAllListeners(): this;
    }

    // =========================================================================
    // CAPA RHI (RENDER HARDWARE INTERFACE)
    // =========================================================================

    export type RHITextureFormat = 
        | 'rgba8unorm' 
        | 'rgba8unorm-srgb' 
        | 'bgra8unorm' 
        | 'depth24plus-stencil8' 
        | 'r8unorm';

    export type RHIPrimitiveTopology = 
        | 'triangle-list' 
        | 'triangle-strip' 
        | 'line-list' 
        | 'line-strip' 
        | 'point-list';

    export interface IRHIBuffer {
        readonly name: string;
        readonly size: number;
        readonly usage: number;
        readonly nativeHandle: any;
        readonly isDestroyed: boolean;
    }

    export interface IRHITexture {
        readonly key: string;
        readonly width: number;
        readonly height: number;
        readonly depth: number;
        readonly format: RHITextureFormat;
        readonly nativeHandle: any;
        readonly nativeView: any;
        readonly isDestroyed: boolean;
    }

    export interface IRHIPipeline {
        readonly id: string;
        readonly nativeHandle: any;
        readonly layout: any;
    }

    export interface IRHIDriver {
        readonly initialized: boolean;
        init(): Promise<boolean> | boolean;
        resize(width: number, height: number): void;
        createBuffer(name: string, size: number, usageFlags: number): IRHIBuffer;
        writeBuffer(buffer: IRHIBuffer, data: BufferSource, offset?: number): void;
        createTexture(key: string, width: number, height: number, depth?: number, format?: RHITextureFormat): IRHITexture;
        updateTexture(texture: IRHITexture, source: ImageBitmap | HTMLCanvasElement | Uint8Array, layerIndex?: number): void;
        beginFrame(r: number, g: number, b: number, a: number): void;
        setPipeline(pipeline: IRHIPipeline): void;
        setVertexBuffer(slot: number, buffer: IRHIBuffer, offset?: number): void;
        setIndexBuffer(buffer: IRHIBuffer, format?: string, offset?: number): void;
        drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
        endFrame(): void;
        destroy(): void;
    }

    // =========================================================================
    // MOTOR DE LOTEADO Y SPRITES (BATCH RENDERER 2D)
    // =========================================================================

    export interface ISpriteBatcher {
        readonly maxQuads: number;
        begin(): void;
        getTextureSlot(texture: IRHITexture): number;
        batchQuad(
            x: number, y: number,
            width: number, height: number,
            rotation: number,
            scaleX: number, scaleY: number,
            originX: number, originY: number,
            u0: number, v0: number, u1: number, v1: number,
            tint: number, alpha: number,
            texture: IRHITexture
        ): void;
        flush(): void;
        destroy(): void;
    }

    // =========================================================================
    // SUBSISTEMA ECS (ENTITY COMPONENT SYSTEM)
    // =========================================================================

    export interface IComponentStore<TSchema extends ComponentSchema = ComponentSchema> {
        readonly id: number;
        readonly name: string;
        readonly schema: TSchema;
        readonly capacity: number;
        readonly columns: { [K in keyof TSchema]: ArrayLike<number> };
        set(entityIndex: number, values: Partial<{ [K in keyof TSchema]: number }>): void;
        reset(entityIndex: number): void;
        ensureCapacity(entityIndex: number): void;
    }

    export interface IQuery {
        readonly entities: ReadonlyArray<EntityId>;
        match(entity: EntityId, entityMask: any): void;
        removeEntity(entity: EntityId): void;
    }

    export abstract class System {
        enabled: boolean;
        constructor(world: ECSWorld);
        abstract init(): void;
        abstract update(time: number, delta: number): void;
        destroy(): void;
    }

    export class ECSWorld {
        readonly capacity: number;
        constructor(initialEntityPool?: number);
        registerComponent<TSchema extends ComponentSchema>(name: string, schema: TSchema): IComponentStore<TSchema>;
        createEntity(): EntityId;
        destroyEntity(entity: EntityId): void;
        isAlive(entity: EntityId): boolean;
        addComponent<TSchema extends ComponentSchema>(
            entity: EntityId, 
            component: IComponentStore<TSchema>, 
            initialValues?: Partial<{ [K in keyof TSchema]: number }>
        ): this;
        removeComponent(entity: EntityId, component: IComponentStore): this;
        createQuery(allOf: IComponentStore[], noneOf?: IComponentStore[]): IQuery;
        addSystem(system: System): this;
        step(time: number, delta: number): void;
        destroy(): void;
    }

    // =========================================================================
    // FÍSICAS OFF-THREAD (WEB WORKERS)
    // =========================================================================

    export interface BodyCreationOptions {
        isStatic?: boolean;
        isSensor?: boolean;
        mass?: number;
        bounce?: number;
        friction?: number;
        gravityScale?: number;
        velocityX?: number;
        velocityY?: number;
        rotation?: number;
        angularVelocity?: number;
        id?: number;
    }

    export interface IPhysicsWorkerBridge {
        readonly hasSharedMemory: boolean;
        readonly activeBodiesCount: number;
        createBody(x: number, y: number, width: number, height: number, options?: BodyCreationOptions, bindTarget?: any): number;
        setVelocity(bodyIndex: number, vx: number, vy: number): void;
        setPosition(bodyIndex: number, x: number, y: number): void;
        update(delta: number): void;
        destroy(): void;
    }

    // =========================================================================
    // AUDIO ESPACIAL CON AUDIOWORKLET
    // =========================================================================

    export interface SpatialSoundConfig {
        x?: number;
        y?: number;
        z?: number;
        minDistance?: number;
        maxDistance?: number;
        rolloffFactor?: number;
        distanceModel?: 'linear' | 'inverse' | 'exponential';
        volume?: number;
        rate?: number;
        loop?: boolean;
        follow?: { x: number; y: number; z?: number } | null;
    }

    export interface ISpatialSound extends IEventEmitter {
        x: number;
        y: number;
        z: number;
        volume: number;
        rate: number;
        loop: boolean;
        readonly isPlaying: boolean;
        readonly isPaused: boolean;
        setPosition(x: number, y: number, z?: number): this;
        setFollow(target: { x: number; y: number; z?: number } | null): this;
        setVolume(volume: number): this;
        play(offset?: number): this;
        pause(): this;
        resume(): this;
        stop(): this;
        destroy(): void;
    }

    export interface ISpatialSoundManager extends IEventEmitter {
        readonly context: AudioContext | null;
        readonly unlocked: boolean;
        setListenerPosition(x: number, y: number, z?: number): this;
        addSpatial(key: string, config?: SpatialSoundConfig): ISpatialSound;
        setMasterVolume(volume: number): this;
        update(time: number, delta: number): void;
        destroy(): void;
    }

    // =========================================================================
    // NETWORKING: WEBTRANSPORT & WEBSOCKETS
    // =========================================================================

    export enum NetChannel {
        RELIABLE = 0,
        UNRELIABLE = 1
    }

    export interface IBinaryPacket {
        readonly buffer: ArrayBuffer;
        cursor: number;
        reset(): this;
        writeUint8(val: number): this;
        writeInt8(val: number): this;
        writeUint16(val: number): this;
        writeInt16(val: number): this;
        writeUint32(val: number): this;
        writeInt32(val: number): this;
        writeFloat32(val: number): this;
        writeFloat64(val: number): this;
        writeString(str: string): this;
        readUint8(): number;
        readInt8(): number;
        readUint16(): number;
        readInt16(): number;
        readUint32(): number;
        readInt32(): number;
        readFloat32(): number;
        readFloat64(): number;
        readString(): string;
        getPayload(): Uint8Array;
    }

    export interface INetworkClient extends IEventEmitter {
        connect(url: string): Promise<void>;
        send(channel: NetChannel, packetType: number, buildCallback: (packet: IBinaryPacket) => void): void;
        disconnect(): void;
        destroy(): void;
    }

    // =========================================================================
    // WEBXR & HÁPTICOS
    // =========================================================================

    export interface IXRController extends IEventEmitter {
        readonly handedness: 'none' | 'left' | 'right';
        readonly isConnected: boolean;
        readonly position: { x: number; y: number; z: number };
        readonly pointerRay: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
        vibrate(intensity?: number, duration?: number): void;
        getTrigger(): number;
        isTriggerPressed(): boolean;
        getAxes(): { x: number; y: number };
        destroy(): void;
    }

    export interface IXRManager extends IEventEmitter {
        readonly isSupported: boolean;
        readonly isInSession: boolean;
        readonly controllers: ReadonlyArray<IXRController>;
        requestSession(mode?: string): Promise<boolean>;
        endSession(): Promise<void>;
        destroy(): void;
    }

    // =========================================================================
    // NÚCLEO Y ESCENA (GAME & SCENE)
    // =========================================================================

    export type SceneConstructor<TKey extends string = string> = new () => Scene<TKey>;

    export class Scene<TKey extends string = string> {
        sys: any;
        game: Game;
        init(data?: any): void;
        preload(): void;
        create(data?: any): void;
        update(time: number, delta: number): void;
    }

    export class Game<
        TTextureKeys extends string = string,
        TAudioKeys extends string = string,
        TSceneKeys extends string = string
    > {
        readonly config: any;
        readonly events: IEventEmitter;
        readonly canvas: HTMLCanvasElement | OffscreenCanvas | null;
        readonly renderer: any;
        readonly isRunning: boolean;
        readonly isPaused: boolean;
        constructor(config?: GameConfig<TTextureKeys, TAudioKeys, TSceneKeys>);
        boot(): void;
        start(): void;
        step(time: number, delta: number): void;
        headlessStep(time: number, delta: number): void;
        pause(): void;
        resume(): void;
        destroy(removeCanvas?: boolean): void;
    }
}
`;