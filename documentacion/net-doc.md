# Documentación Técnica: Conectividad y Networking de Próxima Generación (`@tacarigua/net`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

Históricamente, Phaser (v3.x y v4.2.1) carecía de una capa de red integrada en su núcleo. Los desarrolladores dependían de librerías externas de terceros (como Socket.io o frameworks basados en WebSockets estándar), lo que introducía graves deficiencias en juegos multijugador en tiempo real:
1. **Bloqueo de Cabeza de Línea (*Head-of-Line Blocking* en TCP):** Si un paquete de movimiento se pierde en una conexión WebSocket (TCP), todos los paquetes posteriores se retienen en el búfer del sistema operativo hasta que el paquete perdido se retransmite, generando picos de retraso (*lag spikes*) artificiales incompatibles con juegos de acción rápida.
2. **Sobrecarga por Serialización en JSON/Texto:** El envío de coordenadas y orientaciones mediante cadenas de texto UTF-8 inflaba el ancho de banda y generaba recolección de basura continua (*Garbage Collection*) al parsear cadenas en cada frame.
3. **Ausencia de Reconciliación e Interpolación:** Los clientes sufrían de movimiento espasmódico (*jitter*) al intentar pintar las posiciones del servidor directamente sin un búfer temporal de retraso (*render lag*).

En **Tacarigua 1.0.0**, el módulo `@tacarigua/net` proporciona una solución nativa de **latencia ultra baja**:
- **Soporte Nativo de WebTransport (HTTP/3 sobre QUIC):** Permite el envío de **datagramas no confiables (*Unreliable Datagrams*)** sobre UDP, donde los paquetes obsoletos se descartan sin bloquear el tráfico subsiguiente.
- **Canales Lógicos Multiplexados:** Unifica la transmisión en dos canales: `UNRELIABLE` (datagramas para física y telemetría continua) y `RELIABLE` (streams bidireccionales ordenados para chat, compras o eventos críticos de combate).
- **Serializador Binario de Huella de Memoria Cero (`BinaryPacket`):** Lectura y escritura atómica directa sobre `ArrayBuffer` y `DataView`, reduciendo el consumo de ancho de banda hasta en un **80%** respecto a JSON.
- **Interpolador de Instantáneas Integrado (`SnapshotInterpolator`):** Búfer en anillo que interpola de forma continua la posición y el ángulo más corto entre instantáneas temporales del servidor, alimentando directamente al motor `@tacarigua/ecs`.
- **Degradación Transparente a WebSockets:** Negociación automática que degrada a WebSockets binarios en navegadores o servidores que aún no expongan WebTransport.

---

## 2. Estructura Interna del Módulo

El módulo se estructura en tres capas principales: serialización binaria, adaptadores de transporte y el cliente orquestador:

```
@tacarigua/net
├── core.js           -> NET_CHANNEL, TRANSPORT_TYPE, CONNECTION_STATE
├── BinaryPacket.js        -> Serializador/deserializador binario sobre ArrayBuffer/DataView
├── Adapters               -> BaseTransportAdapter
│   ├── WebTransportAdapter -> HTTP/3 sobre QUIC (Datagramas + Streams bidireccionales)
│   └── WebSocketAdapter    -> Fallback universal con binaryType = 'arraybuffer'
├── SnapshotInterpolator.js-> Búfer en anillo e interpolación de estados temporales del servidor
└── NetworkClient.js       -> Fachada unificada, ciclo de vida y despacho hacia el motor
```

### 2.1. Serializador Binario: `BinaryPacket`
Opera como un flujo binario de lectura/escritura secuencial mediante un cursor interno (`cursor`):
- **Endianness Estandarizada:** Todas las lecturas y escrituras multinivel (16, 32 y 64 bits) operan en **Little-Endian** (`true` en DataView), asegurando interoperabilidad transparente con arquitecturas x86 y ARM.
- **Cadenas con Longitud Prefijada:** El método `writeString()` codifica mediante `TextEncoder`, almacena un prefijo de 2 bytes (`Uint16`) con la longitud en bytes y escribe el contenido UTF-8 de forma contigua.
- **Expansión Geométrica Controlada:** Si se inicializa en modo dinámico, duplica su capacidad automáticamente al llenarse; en modo de lectura externa (`isExternal = true`), impide escrituras fuera de rango sin clonar buffers.

---

### 2.2. Adaptadores de Transporte

#### `WebTransportAdapter`
Aprovecha la API nativa de WebTransport:
- **Datagramas (`datagrams.writable` / `datagrams.readable`):** Canal sin garantías de entrega ni orden. Diseñado para transmitir posiciones $X, Y$, rotación y velocidades a 20-60 Hz. Si un datagrama se pierde en la red, el cliente simplemente procesa el siguiente más reciente.
- **Streams Bidireccionales (`createBidirectionalStream`):** Flujo de bytes confiable, ordenado y con control de flujo para mensajes que no pueden perderse.

#### `WebSocketAdapter`
Implementación de respaldo sobre el protocolo estándar `ws://` / `wss://`:
- Configura `binaryType = 'arraybuffer'` para evitar la deserialización de texto.
- Enruta todo el tráfico a través del canal confiable, simulando la interfaz de WebTransport sin requerir cambios en el código de juego.

---

### 2.3. Búfer de Interpolación: `SnapshotInterpolator`
Para ocultar el retardo de red inherente (*latency jitter*), el cliente no renderiza las entidades en la posición inmediata reportada por el último paquete recibido, sino en un tiempo pasado desplazado por una ventana de retardo constante denominada **Retardo de Interpolación (*Interpolation Lag*)**, habitualmente fijado entre $50\text{ ms}$ y $100\text{ ms}$:

$$\text{Tiempo de Render} = t_{\text{actual}} - t_{\text{lag}}$$

```
  Instantánea Servidor (prev)              Tiempo de Render             Instantánea Servidor (next)
             t = 1000ms                       t = 1060ms                        t = 1100ms
                  ●────────────────────────────────┼─────────────────────────────────●
                                             Factor α = 0.6
```

1. **Localización de Intervalo:** Localiza en el historial las dos instantáneas cuyos timestamps del servidor circunden al tiempo objetivo:
   $$t_{\text{prev}} \le \text{Tiempo de Render} \le t_{\text{next}}$$
2. **Cálculo de Factor de Mezcla ($\alpha$):**
   $$\alpha = \frac{\text{Tiempo de Render} - t_{\text{prev}}}{t_{\text{next}} - t_{\text{prev}}}$$
3. **Interpolación Lineal Posicional:**
   $$X = X_{\text{prev}} + (X_{\text{next}} - X_{\text{prev}}) \cdot \alpha$$
   $$Y = Y_{\text{prev}} + (Y_{\text{next}} - Y_{\text{prev}}) \cdot \alpha$$
4. **Interpolación de Ángulo Más Corto (*Shortest Angle Slerp*):**
   Resuelve la discontinuidad angular en el punto de corte de $2\pi$ radianes ($360^\circ$):
   $$\Delta\theta = ((\theta_{\text{next}} - \theta_{\text{prev}}) \pmod{2\pi})$$
   $$\Delta\theta_{\text{mínimo}} = (2 \cdot \Delta\theta \pmod{2\pi}) - \Delta\theta$$
   $$\theta = \theta_{\text{prev}} + \Delta\theta_{\text{mínimo}} \cdot \alpha$$

---

## 3. Comparativa de Transporte: WebTransport vs. WebSockets

```
[ Paquete 1: OK ] ─────────► [ Paquete 1 Recibido ]
[ Paquete 2: PERDIDO ] ────► X
[ Paquete 3: OK ] ─────────► (En TCP/WebSocket: RETENIDO en buffer esperando reenvío del 2) ──► LAG SPIKE
                             (En WebTransport Datagram: ENTREGADO INMEDIATAMENTE al juego)  ──► FLUIDO
```

| Característica | WebSockets (TCP) | WebTransport (QUIC / UDP) | Ventaja en Tacarigua 1.0.0 |
| :--- | :--- | :--- | :--- |
| **Protocolo Base** | TCP (Orientado a conexión). | **QUIC (Multiplexado sobre UDP)**. | Establecimiento de conexión más rápido (0-RTT). |
| **Head-of-Line Blocking** | Presente; una pérdida detiene todo el canal. | **Inexistente en Datagramas**. | Sin congelamientos de red cuando se pierden paquetes de posición. |
| **Garantía de Entrega** | Siempre confiable (retransmisión forzada). | **Configurable (Confiable y No Confiable)**. | Libertad de elegir la política óptima por mensaje. |
| **Sobrecarga de Cabeceras** | Elevada por enrutamiento TCP. | Reducida al mínimo en datagramas. | Mayor eficiencia de ancho de banda. |

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v5.0.0)

| Aspecto | Phaser 4.2.1 (Socket.io / Librerías Externas) | Tacarigua 1.0.0 (`@tacarigua/net`) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Integración al Core** | Nula; plugins externos o dependencias manuales. | **Módulo oficial nativo**. | Sincronización exacta con el `TimeStep` y escenas. |
| **Formato de Mensajes** | Predominio de JSON en texto plano (`JSON.stringify`). | **`BinaryPacket` binario estricto**. | Reducción de hasta **5x en tamaño de paquete**. |
| **Recolección de Basura** | Alocación masiva de objetos anidados por mensaje. | Búferes prealocados reutilizables (`sendPacketBuffer`). | **Cero asignaciones** en el bucle continuo de emisión. |
| **Interpolación de Red** | Manual por parte del usuario en el método `update()`. | **`SnapshotInterpolator` con búfer circular**. | Movimiento suave y determinista sin tirones a 120 FPS. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Conexión al Servidor y Envío de Movimiento No Confiable (Datagramas a 60 Hz)

```javascript
import { Game } from '@tacarigua/core.js';
import { NetworkClient, NET_CHANNEL, TRANSPORT_TYPE } from '@tacarigua/net';

const game = new Game({ width: 1280, height: 720 });

// 1. Inicializar el cliente con preferencia WebTransport
const net = new NetworkClient(game, {
    transport: TRANSPORT_TYPE.AUTO,
    interpolationLag: 80
});

// Identificadores de mensajes binarios (OpCodes)
const MSG_PLAYER_INPUT = 1;
const MSG_WORLD_SNAPSHOT = 2;

// 2. Conectar al servidor de juegos
await net.connect('https://game.servidor.com:4433/session');

console.log(`[Red] Conectado mediante: ${net.adapter.constructor.name}`);

// 3. Envío de entrada del jugador en cada paso del juego (Zero GC)
let sequenceNumber = 0;

function sendInput(vx, vy, angle) {
    // Se envía por el canal NO CONFIABLE (Datagrama) para mínima latencia
    net.send(NET_CHANNEL.UNRELIABLE, MSG_PLAYER_INPUT, (packet) => {
        packet.writeUint32(sequenceNumber++);
        packet.writeFloat32(vx);
        packet.writeFloat32(vy);
        packet.writeFloat32(angle);
    });
}
```

---

### Ejemplo 2: Mensajería Confiable para Acciones Críticas del Juego

Para acciones que no pueden perderse bajo ninguna circunstancia (compra en tienda, disparo de habilidad, chat):

```javascript
const MSG_CAST_SPELL = 10;

function castSpell(spellId, targetX, targetY) {
    // Se envía por el canal CONFIABLE (Stream garantizado)
    net.send(NET_CHANNEL.RELIABLE, MSG_CAST_SPELL, (packet) => {
        packet.writeUint16(spellId);
        packet.writeFloat32(targetX);
        packet.writeFloat32(targetY);
        packet.writeString('BolaDeFuego');
    });
}
```

---

### Ejemplo 3: Recepción de Instantáneas y Sincronización con `@tacarigua/ecs`

Cómo desempaquetar las instantáneas del servidor e interpolar las posiciones de otros jugadores:

```javascript
import { ECSWorld } from '@tacarigua/ecs';

const world = new ECSWorld(2048);
const otherPlayersMap = new Map(); // EntityId -> objeto interpolado

// Escuchar paquetes de instantánea del mundo emitidos por el servidor
net.on(`packet:${MSG_WORLD_SNAPSHOT}`, (packet) => {
    const serverTime = packet.readFloat64();
    const entityCount = packet.readUint16();

    const snapshotEntities = new Map();

    for (let i = 0; i < entityCount; i++) {
        const netId = packet.readUint32();
        const posX = packet.readFloat32();
        const posY = packet.readFloat32();
        const rot = packet.readFloat32();

        snapshotEntities.set(netId, { x: posX, y: posY, rotation: rot });
    }

    // Inyectar en el interpolador
    net.interpolator.pushSnapshot(serverTime, snapshotEntities);
});

// Reconciliación en cada cuadro del juego:
const tempInterpolatedState = { x: 0, y: 0, rotation: 0 };

game.events.on('step', (time) => {
    const renderTime = performance.now();

    for (const [netId, ecsEntity] of otherPlayersMap.entries()) {
        const hasData = net.interpolator.interpolateEntity(netId, renderTime, tempInterpolatedState);

        if (hasData) {
            // Actualizar directamente la memoria física del ECS
            const idx = ecsEntity & 0xfffff;
            world.Transform.columns.x[idx] = tempInterpolatedState.x;
            world.Transform.columns.y[idx] = tempInterpolatedState.y;
            world.Transform.columns.rotation[idx] = tempInterpolatedState.rotation;
        }
    }
});
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Eliminar Dependencias de Socket.io o Clientes WebSocket Externos
- **Antes (Phaser v4.2.1):**
  ```javascript
  import io from 'socket.io-client';
  const socket = io('https://server.com');
  socket.emit('move', { x: 100, y: 200 }); // Serialización JSON ineficiente
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  import { NetworkClient, NET_CHANNEL } from '@tacarigua/net';

  const net = new NetworkClient(game);
  await net.connect('https://server.com:4433');
  net.send(NET_CHANNEL.UNRELIABLE, 1, (packet) => {
      packet.writeFloat32(100);
      packet.writeFloat32(200);
  });
  ```

### Paso 2: Separar el Tráfico por Canales de Entrega
Identifique los eventos del juego según su criticidad:
1. **Canal `UNRELIABLE`:** Movimiento, rotación, velocidad, inputs de mando continuos.
2. **Canal `RELIABLE`:** Respawn de jugadores, daño, sincronización de inventario, chat.

### Paso 3: Integrar el `SnapshotInterpolator` en lugar de LERP Manual
Sustituya las funciones matemáticas manuales de interpolación lineal dispersas en los métodos `update()` por `net.interpolator.pushSnapshot()`, permitiendo que el interpolador integrado gestione el retardo de renderizado y las correcciones angulares de forma automática.