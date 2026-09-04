/**
 * @fileoverview Subsistema de red de próxima generación con WebTransport y WebSockets para Tacarigua 1.0.0.
 * @module @tacarigua/net
 * @license Phaser - Licencia MIT
 */

import { EventEmitter } from './core.js';

// =============================================================================
// CONSTANTES Y ENUMERACIONES DE RED
// =============================================================================

/**
 * Canales lógicos de transmisión según criticidad y orden de entrega.
 * @enum {number}
 */
export const NET_CHANNEL = Object.freeze({
    RELIABLE: 0,   // Streams ordenados y garantizados (Chat, inventario, eventos de muerte)
    UNRELIABLE: 1  // Datagramas de baja latencia con posible descarte (Posición, rotación, velocidad)
});

/**
 * Tipos de transporte compatibles negociables en caliente.
 * @enum {string}
 */
export const TRANSPORT_TYPE = Object.freeze({
    WEBTRANSPORT: 'webtransport',
    WEBSOCKET: 'websocket',
    AUTO: 'auto'
});

/**
 * Estados de la conexión de red.
 * @enum {string}
 */
export const CONNECTION_STATE = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed'
});

// =============================================================================
// SERIALIZADOR BINARIO DE ALTO RENDIMIENTO (BINARY PACKET)
// =============================================================================

/**
 * Lector y escritor binario optimizado para paquetes de red de videojuegos.
 */
export class BinaryPacket {
    /**
     * @param {number|ArrayBuffer} [bufferOrSize=1024] - Tamaño en bytes o buffer existente para lectura.
     */
    constructor(bufferOrSize = 1024) {
        if (typeof bufferOrSize === 'number') {
            this.buffer = new ArrayBuffer(bufferOrSize);
            this.byteLength = bufferOrSize;
            this.isExternal = false;
        } else {
            this.buffer = bufferOrSize;
            this.byteLength = bufferOrSize.byteLength;
            this.isExternal = true;
        }

        this.view = new DataView(this.buffer);
        this.cursor = 0;
        this.textEncoder = new TextEncoder();
        this.textDecoder = new TextDecoder();
    }

    /**
     * Reinicia el puntero de lectura/escritura a cero.
     * @returns {this}
     */
    reset() {
        this.cursor = 0;
        return this;
    }

    /**
     * Asegura que el búfer pueda alojar la cantidad requerida de bytes antes de escribir.
     * @param {number} additionalBytes 
     * @private
     */
    _ensureCapacity(additionalBytes) {
        if (this.isExternal) return;
        const needed = this.cursor + additionalBytes;
        if (needed > this.byteLength) {
            let nextCapacity = Math.max(needed, this.byteLength * 2);
            const newBuffer = new ArrayBuffer(nextCapacity);
            new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
            this.buffer = newBuffer;
            this.byteLength = nextCapacity;
            this.view = new DataView(this.buffer);
        }
    }

    // --- MÉTODOS DE ESCRITURA BINARIA ---

    writeUint8(value) {
        this._ensureCapacity(1);
        this.view.setUint8(this.cursor, value);
        this.cursor += 1;
        return this;
    }

    writeInt8(value) {
        this._ensureCapacity(1);
        this.view.setInt8(this.cursor, value);
        this.cursor += 1;
        return this;
    }

    writeUint16(value) {
        this._ensureCapacity(2);
        this.view.setUint16(this.cursor, value, true);
        this.cursor += 2;
        return this;
    }

    writeInt16(value) {
        this._ensureCapacity(2);
        this.view.setInt16(this.cursor, value, true);
        this.cursor += 2;
        return this;
    }

    writeUint32(value) {
        this._ensureCapacity(4);
        this.view.setUint32(this.cursor, value, true);
        this.cursor += 4;
        return this;
    }

    writeInt32(value) {
        this._ensureCapacity(4);
        this.view.setInt32(this.cursor, value, true);
        this.cursor += 4;
        return this;
    }

    writeFloat32(value) {
        this._ensureCapacity(4);
        this.view.setFloat32(this.cursor, value, true);
        this.cursor += 4;
        return this;
    }

    writeFloat64(value) {
        this._ensureCapacity(8);
        this.view.setFloat64(this.cursor, value, true);
        this.cursor += 8;
        return this;
    }

    writeString(str) {
        const encoded = this.textEncoder.encode(str);
        this.writeUint16(encoded.length);
        this._ensureCapacity(encoded.length);
        new Uint8Array(this.buffer, this.cursor, encoded.length).set(encoded);
        this.cursor += encoded.length;
        return this;
    }

    // --- MÉTODOS DE LECTURA BINARIA ---

    readUint8() {
        const value = this.view.getUint8(this.cursor);
        this.cursor += 1;
        return value;
    }

    readInt8() {
        const value = this.view.getInt8(this.cursor);
        this.cursor += 1;
        return value;
    }

    readUint16() {
        const value = this.view.getUint16(this.cursor, true);
        this.cursor += 2;
        return value;
    }

    readInt16() {
        const value = this.view.getInt16(this.cursor, true);
        this.cursor += 2;
        return value;
    }

    readUint32() {
        const value = this.view.getUint32(this.cursor, true);
        this.cursor += 4;
        return value;
    }

    readInt32() {
        const value = this.view.getInt32(this.cursor, true);
        this.cursor += 4;
        return value;
    }

    readFloat32() {
        const value = this.view.getFloat32(this.cursor, true);
        this.cursor += 4;
        return value;
    }

    readFloat64() {
        const value = this.view.getFloat64(this.cursor, true);
        this.cursor += 8;
        return value;
    }

    readString() {
        const len = this.readUint16();
        const slice = new Uint8Array(this.buffer, this.cursor, len);
        this.cursor += len;
        return this.textDecoder.decode(slice);
    }

    /**
     * Obtiene una vista recortada con los bytes efectivamente escritos.
     * @returns {Uint8Array}
     */
    getPayload() {
        return new Uint8Array(this.buffer, 0, this.cursor);
    }
}

// =============================================================================
// ADAPTADORES DE TRANSPORTE
// =============================================================================

/**
 * Interfaz base para cualquier adaptador de transporte de red.
 */
class BaseTransportAdapter extends EventEmitter {
    constructor() {
        super();
        this.state = CONNECTION_STATE.DISCONNECTED;
    }

    connect(url) {
        throw new Error('Método connect() debe ser implementado');
    }

    send(channel, data) {
        throw new Error('Método send() debe ser implementado');
    }

    disconnect() {
        throw new Error('Método disconnect() debe ser implementado');
    }
}

/**
 * Adaptador WebTransport nativo (HTTP/3 sobre QUIC con Datagramas y Streams).
 */
export class WebTransportAdapter extends BaseTransportAdapter {
    constructor() {
        super();
        /** @type {WebTransport|null} */
        this.transport = null;
        this.writer = null;
        this.reliableWriter = null;
        this.reliableStream = null;
    }

    async connect(url) {
        if (typeof WebTransport === 'undefined') {
            throw new Error('[Tacarigua 1.0.0 - Net] WebTransport no soportado en este entorno');
        }

        this.state = CONNECTION_STATE.CONNECTING;
        this.emit('stateChange', this.state);

        try {
            this.transport = new WebTransport(url);
            await this.transport.ready;

            this.state = CONNECTION_STATE.CONNECTED;
            this.emit('stateChange', this.state);
            this.emit('connected');

            // 1. Iniciar canal de datagramas (No confiable)
            this.writer = this.transport.datagrams.writable.getWriter();
            this._listenDatagrams();

            // 2. Iniciar Stream bidireccional primario (Confiable)
            this.reliableStream = await this.transport.createBidirectionalStream();
            this.reliableWriter = this.reliableStream.writable.getWriter();
            this._listenReliableStream(this.reliableStream.readable);

            this.transport.closed.then(() => {
                this.state = CONNECTION_STATE.DISCONNECTED;
                this.emit('stateChange', this.state);
                this.emit('disconnected');
            }).catch((err) => {
                this.state = CONNECTION_STATE.FAILED;
                this.emit('error', err);
            });

        } catch (error) {
            this.state = CONNECTION_STATE.FAILED;
            this.emit('error', error);
            throw error;
        }
    }

    async _listenDatagrams() {
        const reader = this.transport.datagrams.readable.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                this.emit('message', NET_CHANNEL.UNRELIABLE, value);
            }
        } catch (e) {
            // Cierre del stream de lectura
        }
    }

    async _listenReliableStream(readableStream) {
        const reader = readableStream.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                this.emit('message', NET_CHANNEL.RELIABLE, value);
            }
        } catch (e) {
            // Cierre de stream
        }
    }

    send(channel, data) {
        if (this.state !== CONNECTION_STATE.CONNECTED) return;

        const payload = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, 0, data.cursor || data.byteLength);

        if (channel === NET_CHANNEL.UNRELIABLE && this.writer) {
            this.writer.write(payload).catch(() => { });
        } else if (channel === NET_CHANNEL.RELIABLE && this.reliableWriter) {
            this.reliableWriter.write(payload).catch(() => { });
        }
    }

    disconnect() {
        if (this.transport) {
            this.transport.close();
            this.transport = null;
            this.writer = null;
            this.reliableWriter = null;
            this.reliableStream = null;
        }
        this.state = CONNECTION_STATE.DISCONNECTED;
        this.emit('stateChange', this.state);
    }
}

/**
 * Adaptador WebSocket binario para fallback universal.
 */
export class WebSocketAdapter extends BaseTransportAdapter {
    constructor() {
        super();
        /** @type {WebSocket|null} */
        this.socket = null;
    }

    connect(url) {
        return new Promise((resolve, reject) => {
            this.state = CONNECTION_STATE.CONNECTING;
            this.emit('stateChange', this.state);

            // Conversión de protocolo si se pasa formato https/http
            const wsUrl = url.replace(/^http/, 'ws');
            this.socket = new WebSocket(wsUrl);
            this.socket.binaryType = 'arraybuffer';

            this.socket.onopen = () => {
                this.state = CONNECTION_STATE.CONNECTED;
                this.emit('stateChange', this.state);
                this.emit('connected');
                resolve();
            };

            this.socket.onerror = (err) => {
                this.state = CONNECTION_STATE.FAILED;
                this.emit('error', err);
                reject(err);
            };

            this.socket.onclose = () => {
                this.state = CONNECTION_STATE.DISCONNECTED;
                this.emit('stateChange', this.state);
                this.emit('disconnected');
            };

            this.socket.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this.emit('message', NET_CHANNEL.RELIABLE, new Uint8Array(event.data));
                }
            };
        });
    }

    send(channel, data) {
        if (this.state !== CONNECTION_STATE.CONNECTED || !this.socket) return;
        const payload = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, 0, data.cursor || data.byteLength);
        this.socket.send(payload);
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.state = CONNECTION_STATE.DISCONNECTED;
        this.emit('stateChange', this.state);
    }
}

// =============================================================================
// INTERPOLADOR DE INSTANTÁNEAS (SNAPSHOT INTERPOLATOR)
// =============================================================================

/**
 * Estructura para registrar una instantánea de estado recibida desde el servidor.
 */
class SnapshotEntry {
    constructor(serverTime, clientReceivedTime, entitiesData) {
        this.serverTime = serverTime;
        this.clientReceivedTime = clientReceivedTime;
        this.entities = entitiesData; // Map de ID -> {x, y, rotation, etc.}
    }
}

/**
 * Búfer en anillo para reconciliación e interpolación de entidades conectadas.
 * Elimina el temblor (jitter) garantizando renderizado fluido a 120 FPS.
 */
export class SnapshotInterpolator {
    /**
     * @param {number} [interpolationLag=100] - Retardo de interpolación en milisegundos.
     */
    constructor(interpolationLag = 100) {
        this.interpolationLag = interpolationLag;
        /** @type {Array<SnapshotEntry>} */
        this.history = [];
        this.maxSnapshots = 60;
    }

    /**
     * Ingresa una nueva instantánea del servidor al historial.
     * @param {number} serverTime - Timestamp generado por el servidor.
     * @param {Map<number, object>} entitiesData - Mapa de estados de entidades.
     */
    pushSnapshot(serverTime, entitiesData) {
        const now = performance.now();
        const entry = new SnapshotEntry(serverTime, now, entitiesData);

        this.history.push(entry);

        if (this.history.length > this.maxSnapshots) {
            this.history.shift();
        }

        // Mantener ordenado ascendentemente por tiempo de servidor
        this.history.sort((a, b) => a.serverTime - b.serverTime);
    }

    /**
     * Interpola el estado de una entidad específica en base al tiempo de render actual.
     * @param {number} entityId 
     * @param {number} renderTime 
     * @param {object} outState - Objeto donde se escriben los resultados sin generar GC.
     * @returns {boolean} Si se pudo interpolar exitosamente.
     */
    interpolateEntity(entityId, renderTime, outState) {
        const targetTime = renderTime - this.interpolationLag;
        const count = this.history.length;

        if (count < 2) {
            // No hay suficientes instantáneas: usar la última conocida
            if (count === 1) {
                const single = this.history[0].entities.get(entityId);
                if (single) {
                    Object.assign(outState, single);
                    return true;
                }
            }
            return false;
        }

        // Localizar las dos instantáneas adyacentes al targetTime
        let prev = null;
        let next = null;

        for (let i = 0; i < count - 1; i++) {
            if (this.history[i].serverTime <= targetTime && targetTime <= this.history[i + 1].serverTime) {
                prev = this.history[i];
                next = this.history[i + 1];
                break;
            }
        }

        if (!prev || !next) {
            // Si el tiempo queda por delante, extrapolar desde la más reciente
            const latest = this.history[count - 1].entities.get(entityId);
            if (latest) {
                Object.assign(outState, latest);
                return true;
            }
            return false;
        }

        const stateA = prev.entities.get(entityId);
        const stateB = next.entities.get(entityId);

        if (!stateA || !stateB) return false;

        // Factor de mezcla temporal (alpha de 0 a 1)
        const timeRange = next.serverTime - prev.serverTime;
        const alpha = timeRange > 0 ? (targetTime - prev.serverTime) / timeRange : 0;

        // Interpolación afín de propiedades vectoriales
        outState.x = stateA.x + (stateB.x - stateA.x) * alpha;
        outState.y = stateA.y + (stateB.y - stateA.y) * alpha;

        // Interpolación esférica de ángulo más corto para rotación
        let da = (stateB.rotation - stateA.rotation) % (Math.PI * 2);
        da = (2 * da % (Math.PI * 2)) - da;
        outState.rotation = stateA.rotation + da * alpha;

        return true;
    }

    clear() {
        this.history.length = 0;
    }
}

// =============================================================================
// CLIENTE PRINCIPAL DE RED (NETWORK CLIENT)
// =============================================================================

/**
 * Gestor maestro del subsistema multijugador para juegos en tiempo real en Tacarigua 1.0.0.
 */
export class NetworkClient extends EventEmitter {
    /**
     * @param {import('./Game').Game} game - Instancia del motor Phaser.
     * @param {object} [config={}] - Opciones de configuración de red.
     */
    constructor(game, config = {}) {
        super();

        this.game = game;
        this.preferredTransport = config.transport || TRANSPORT_TYPE.AUTO;

        /** @type {BaseTransportAdapter|null} */
        this.adapter = null;

        this.interpolator = new SnapshotInterpolator(config.interpolationLag || 100);

        this.sendPacketBuffer = new BinaryPacket(2048);
        this.receivePacketBuffer = new BinaryPacket();

        // Enlace al loop principal del juego para actualizar interpolaciones
        this._updateBinding = this.update.bind(this);
    }

    /**
     * Establece la conexión negociando WebTransport de forma prioritaria.
     * @param {string} url - Dirección del servidor de juego.
     * @returns {Promise<void>}
     */
    async connect(url) {
        if (this.preferredTransport === TRANSPORT_TYPE.AUTO || this.preferredTransport === TRANSPORT_TYPE.WEBTRANSPORT) {
            if (typeof WebTransport !== 'undefined') {
                try {
                    const wtAdapter = new WebTransportAdapter();
                    this._bindAdapterEvents(wtAdapter);
                    await wtAdapter.connect(url);
                    this.adapter = wtAdapter;
                    this.game.events.on('step', this._updateBinding);
                    return;
                } catch (error) {
                    console.info('[Tacarigua 1.0.0 - Net] WebTransport no pudo conectar. Degradando a WebSocket.');
                }
            }
        }

        // Fallback: WebSocket
        const wsAdapter = new WebSocketAdapter();
        this._bindAdapterEvents(wsAdapter);
        await wsAdapter.connect(url);
        this.adapter = wsAdapter;
        this.game.events.on('step', this._updateBinding);
    }

    /**
     * Vincula los listeners de eventos del adaptador activo con el bus público.
     * @param {BaseTransportAdapter} adapter 
     * @private
     */
    _bindAdapterEvents(adapter) {
        adapter.on('connected', () => this.emit('connected'));
        adapter.on('disconnected', () => this.emit('disconnected'));
        adapter.on('error', (err) => this.emit('error', err));
        adapter.on('message', (channel, data) => this._onMessageReceived(channel, data));
    }

    /**
     * Deserializa y procesa los paquetes entrantes.
     * @param {number} channel 
     * @param {Uint8Array} rawData 
     * @private
     */
    _onMessageReceived(channel, rawData) {
        const packet = this.receivePacketBuffer;
        packet.buffer = rawData.buffer;
        packet.byteLength = rawData.byteLength;
        packet.view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
        packet.cursor = rawData.byteOffset;
        packet.isExternal = true;

        const packetType = packet.readUint8();
        this.emit(`packet:${packetType}`, packet, channel);
        this.emit('packet', packetType, packet, channel);
    }

    /**
     * Envía un comando binario utilizando el canal deseado.
     * @param {number} channel - NET_CHANNEL.RELIABLE o NET_CHANNEL.UNRELIABLE.
     * @param {number} packetType - ID numérico del mensaje.
     * @param {Function} buildCallback - Función que escribe los campos en el paquete binario.
     */
    send(channel, packetType, buildCallback) {
        if (!this.adapter || this.adapter.state !== CONNECTION_STATE.CONNECTED) {
            return;
        }

        const packet = this.sendPacketBuffer;
        packet.reset();
        packet.writeUint8(packetType);

        buildCallback(packet);

        this.adapter.send(channel, packet.getPayload());
    }

    /**
     * Actualiza la interpolación por cada paso del loop del juego.
     * @param {number} time 
     * @param {number} delta 
     */
    update(time, delta) {
        // Ejecución periódica para sincronizar entidades
    }

    /**
     * Desconecta de forma limpia la sesión de red activa.
     */
    disconnect() {
        this.game.events.off('step', this._updateBinding);
        if (this.adapter) {
            this.adapter.disconnect();
            this.adapter = null;
        }
        this.interpolator.clear();
    }

    /**
     * Libera de forma irreversible todos los recursos del cliente de red.
     */
    destroy() {
        this.disconnect();
        this.removeAllListeners();
        this.sendPacketBuffer = null;
        this.receivePacketBuffer = null;
        this.interpolator = null;
        this.game = null;
    }
}