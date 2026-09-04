# Documentación Técnica: WebXR y Entradas Hápticas Avanzadas (`@tacarigua/input-xr`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

En las versiones previas de Phaser (v3.x y v4.2.1), la interacción con tecnologías de realidad extendida (VR/AR) era inexistente a nivel de motor o dependía de adaptadores comunitarios frágiles. Además, el subsistema de mandos (*Gamepad*) carecía de soporte para motores de vibración modernos, limitándose a lecturas analógicas de ejes y botones en el hilo de la interfaz de usuario.

En **Tacarigua 1.0.0**, el módulo `@tacarigua/input-xr` introduce una arquitectura integrada para **experiencias inmersivas 2.5D y espaciales**:
- **Integración Nativa con la WebXR Device API:** Control directo de sesiones inmersivas (`XRSession`), espacios de referencia físicos (`XRReferenceSpace`) y capas de renderizado estéreo vinculadas a la RHI.
- **Conmutación Dinámica del Loop de Animación (*Loop Hijacking*):** Al iniciar una sesión inmersiva, el reloj del juego (`TimeStep`) suspende el `requestAnimationFrame` tradicional de ventana y se acopla a la cadencia nativa del visor (72Hz, 90Hz o 120Hz) mediante `session.requestAnimationFrame(callback)`.
- **Mandos Espaciales con 6 Grados de Libertad (6DoF) y Seguimiento de Manos (*Hand Tracking*):** Rastreo simultáneo de la posición física del agarre (*grip*) y la orientación del rayo de puntero (*target ray*), con soporte para matrices articulares de manos escritas directamente en búferes planos `Float32Array`.
- **Sistema Háptico Universal Multicapa:** Soporte prioritario para actuadores de doble motor (*Dual-Rumble: motores de baja y alta frecuencia*), pulsos hápticos en mandos de visores y degradación automática a vibración móvil estándar (`navigator.vibrate`).

---

## 2. Estructura Interna del Módulo

El módulo se compone de tres entidades arquitectónicas esenciales:

```
@tacarigua/input-xr
├── core.js       -> XR_SESSION_MODE, XR_REFERENCE_SPACE, XR_HANDEDNESS, HAPTIC_TYPE
├── HapticManager   -> Motor de vibración multinivel (Dual-Rumble, Pulsos y Fallbacks)
├── XRController    -> Abstracción de mandos 6DoF, cálculo de rayos y Hand Tracking
└── XRManager       -> Orquestador maestro de sesión WebXR, vistas estéreo y loop
```

### 2.1. Gestor Háptico: `HapticManager`
Centraliza la comunicación con los actuadores de vibración de cualquier periférico:
- **Nivel 1 (Prioritario - Dual-Rumble):** Emplea `gamepad.vibrationActuator.playEffect('dual-rumble', ...)`. Permite modular de forma independiente el motor de sacudidas pesadas (`strongMagnitude`) y el motor de frecuencias finas (`weakMagnitude`).
- **Nivel 2 (Mandos WebXR):** Si el mando expone `gamepad.hapticActuators`, despacha pulsos de microsegundos con intensidad normalizada.
- **Nivel 3 (Dispositivos Móviles):** Emplea `navigator.vibrate(duration)` para asegurar respuesta física básica en navegadores móviles estándar.

---

### 2.2. Controlador Espacial: `XRController`
Encapsula una fuente de entrada `XRInputSource` (controlador de agarre o mano rastreada):
- **Matrices Locales Continuas:** Almacena matrices homogéneas $4 \times 4$ contiguas en `gripMatrix` y `targetRayMatrix` (`Float32Array(16)`).
- **Extracción de Rayo de Puntero (*Target Ray Vector*):** Cuando el mando expone una pose de puntero, calcula en tiempo real la orientación tridimensional del rayo a partir del cuaternión unitario de rotación sin instanciar objetos vectoriales:
  $$\begin{cases} d_x = 2 \cdot (q_x q_z + q_w q_y) \\ d_y = 2 \cdot (q_y q_z - q_w q_x) \\ d_z = 1 - 2 \cdot (q_x^2 + q_y^2) \end{cases}$$
- **Seguimiento Articular de Manos (*Hand Tracking*):** Si el dispositivo detecta manos desnudas, reserva un arreglo continuo de $25 \text{ articulaciones} \times 16 \text{ floats} = 400 \text{ floats}$ ($1.600 \text{ bytes}$). La llamada nativa `frame.fillPoses()` rellena toda la cinemática de la mano en una sola operación a nivel de GPU/C++.

---

### 2.3. Gestor Maestro de WebXR: `XRManager`
Gobierna el ciclo de vida inmersivo en coordinación con el motor gráfico:
- **Gestión de Espacios de Referencia:** Negocia `local-floor` como espacio primario para permitir experiencias a escala de habitación (*room-scale*) con piso calibrado, o `local` para experiencias sentadas.
- **Integración con la RHI:** Vincula el contexto gráfico de la RHI con una capa de proyección estéreo `XRWebGLLayer`.
- **Renderizado Estéreo:** Expone el arreglo `views` (Ojo Izquierdo y Ojo Derecho), cada uno con su respectivo `viewport` y matriz de proyección precalculada por el hardware del visor.

---

## 3. Ciclo de Vida y Conmutación del Bucle Temporal

El siguiente diagrama detalla cómo Tacarigua 1.0.0 conmuta la cadencia de ejecución del juego entre el modo estándar de navegador y el modo inmersivo WebXR:

```
  [ Modo Estándar ] ────────► TimeStep (requestAnimationFrame tradicional) ──► Game.step()
                                     │
          Usuario invoca xrManager.requestSession('immersive-vr')
                                     │
                                     ▼
        ┌────────────────────────────────────────────────────────┐
        │ 1. Pausa el TimeStep tradicional del navegador         │
        │ 2. Inicializa XRWebGLLayer sobre el contexto RHI       │
        │ 3. Negocia XRReferenceSpace ('local-floor')            │
        │ 4. Delega a session.requestAnimationFrame(_onXRFrame)  │
        └────────────────────────────┬───────────────────────────┘
                                     │
                                     ▼
  [ Modo WebXR Inmersivo ] (72Hz / 90Hz / 120Hz nativos)
        │
        ├─► frame.getViewerPose(referenceSpace)
        ├─► XRController.update() (Grip, Rayos, Articulaciones)
        ├─► Game.step(time, delta) (Lógica de Escena y Render Estéreo)
        │
        ▼
  Usuario cierra sesión o quita el visor (session.end())
        │
        └─► _onSessionEnded() ──► Restaura TimeStep tradicional del navegador
```

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Característica | Phaser 4.2.1 | Tacarigua 1.0.0 (`@tacarigua/input-xr`) | Ventaja Técnica |
| :--- | :--- | :--- | :--- |
| **Soporte de Realidad Extendida** | Inexistente (requería hacks externos). | **Nativo y desacoplado**. | Acceso directo a visores VR/AR con capa de proyección optimizada. |
| **Tasa de Refresco de Cuadros** | Atada rígidamente a la pantalla del monitor (60Hz). | **Sincronizada con el visor** (72Hz / 90Hz / 120Hz). | Experiencias inmersivas fluidas que previenen mareos (*motion sickness*). |
| **Rastreo de Mandos** | Ejes 2D estándar de Gamepad. | **Posicionamiento 6DoF y orientación por rayos**. | Detección espacial tridimensional precisa de mandos físicos. |
| **Seguimiento de Manos** | Incompatible. | **Buffer contiguo de articulaciones** (`fillPoses`). | Cero asignación de memoria para tracking de manos completas. |
| **Retroalimentación Háptica** | `navigator.vibrate` móvil elemental. | **Dual-Rumble y pulsos de microsegundos**. | Efectos de retroalimentación física diferenciados por frecuencia. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Verificación de Compatibilidad y Arranque de Sesión VR

Cómo verificar si el usuario cuenta con un visor conectado y solicitar una sesión inmersiva:

```javascript
import { Game } from '@tacarigua/core.js';
import { XRManager, XR_SESSION_MODE, XR_REFERENCE_SPACE } from '@tacarigua/input-xr';

const game = new Game({ width: 1280, height: 720 });

// 1. Inicializar el gestor WebXR
const xr = new XRManager(game, {
    sessionMode: XR_SESSION_MODE.IMMERSIVE_VR,
    referenceSpace: XR_REFERENCE_SPACE.LOCAL_FLOOR
});

// 2. Escuchar disponibilidad de hardware inmersivo
xr.on('supported', () => {
    console.log('[XR] Dispositivo VR detectado. Habilitando botón de entrada.');
    
    // Crear un botón en la interfaz HTML del juego
    const vrButton = document.createElement('button');
    vrButton.innerText = 'Entrar a Realidad Virtual';
    vrButton.onclick = async () => {
        const success = await xr.requestSession();
        if (success) {
            vrButton.style.display = 'none';
        }
    };
    document.body.appendChild(vrButton);
});

xr.on('sessionstart', () => {
    console.log('[XR] Sesión inmersiva iniciada con éxito a tasa de refresco nativa.');
});

xr.on('sessionend', () => {
    console.log('[XR] Sesión inmersiva concluida. Restaurando pantalla 2D.');
});
```

---

### Ejemplo 2: Lectura de Mandos 6DoF, Disparo y Retroalimentación Háptica

Cómo detectar mandos espaciales, leer el gatillo de disparo y emitir una sacudida física:

```javascript
// Escuchar cuando se enciende o sincroniza un mando
xr.on('controlleradded', (controller) => {
    console.log(`[XR] Mando conectado. Mano: ${controller.handedness}`);

    controller.on('select', () => {
        console.log(`[XR] Gatillo presionado a fondo en mando: ${controller.handedness}`);
    });
});

// En el loop de actualización de la escena:
game.events.on('step', (time, delta) => {
    if (!xr.isInSession) return;

    for (const controller of xr.controllers) {
        if (!controller.hasTargetRayPose) continue;

        // 1. Leer posición y dirección del rayo de puntería
        const origin = controller.pointerRay.origin;
        const dir = controller.pointerRay.direction;

        // 2. Comprobar si el gatillo está presionado
        const triggerPressure = controller.getTrigger(); // 0.0 a 1.0

        if (controller.isTriggerPressed()) {
            console.log(`Disparando rayo desde (${origin.x}, ${origin.y}, ${origin.z})`);

            // 3. Emitir vibración háptica instantánea de retroceso (Intensidad 1.0, 40 ms)
            controller.vibrate(1.0, 40);
        }

        // 4. Leer stick analógico para movimiento en el plano
        const stick = controller.getAxes();
        if (Math.abs(stick.x) > 0.1 || Math.abs(stick.y) > 0.1) {
            // Mover cámara o jugador
        }
    }
});
```

---

### Ejemplo 3: Uso Directo de Vibración Dual-Rumble en Mandos de Consola Tradicionales

Uso de `HapticManager` para mandos de videojuegos estándar (Xbox, PlayStation, mandos USB):

```javascript
import { HapticManager } from '@tacarigua/input-xr';

const haptics = new HapticManager();

window.addEventListener('gamepadconnected', (event) => {
    const gamepad = event.gamepad;

    // Disparar un patrón háptico: Golpe sordo inicial con reverberación ligera
    haptics.playEffect(gamepad, {
        startDelay: 0,
        duration: 250,        // 250 milisegundos
        strongMagnitude: 0.9, // Motor pesado de graves al 90%
        weakMagnitude: 0.2    // Motor agudo al 20%
    });
});
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Reemplazar Plugins Externos de WebXR
- **Antes (Phaser v4.2.1):**
  Se requería importar bibliotecas externas que modificaban el contexto WebGL subyacente y sobreescribían manualmente las cámaras de Phaser.
- **Ahora (Tacarigua v1.0.0):**
  Instanciar directamente `XRManager` desde `@tacarigua/input-xr`. El motor se encarga de pausar el loop ordinario y gestionar la vista estéreo en coordinación con la capa RHI.

### Paso 2: Actualizar la Lectura de Mandos Espaciales
- **Antes (Phaser v4.2.1):**
  La lectura de mandos en Phaser se limitaba a `pad.axes[0]` y `pad.buttons[0]`.
- **Ahora (Tacarigua v1.0.0):**
  Los controladores se abstraen mediante la clase `XRController`, que provee tanto las matrices espaciales (`gripMatrix`, `targetRayMatrix`) como las lecturas normalizadas de gatillos y joysticks (`getTrigger()`, `getAxes()`).

### Paso 3: Migrar la Vibración Básica a Efectos Hápticos Dual-Rumble
- **Antes (Phaser v4.2.1):**
  ```javascript
  if (navigator.vibrate) {
      navigator.vibrate(200); // Vibración tosca de teléfono móvil
  }
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Control diferenciado de frecuencias y amplitudes en hardware moderno
  xrManager.haptics.playEffect(gamepad, {
      duration: 200,
      strongMagnitude: 0.8,
      weakMagnitude: 0.4
  });
  ```