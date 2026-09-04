# Documentación Técnica: Subsistema de Audio Espacial con AudioWorklet (`@tacarigua/sound-worklet`) — Tacarigua.js v1.0.0

---

## 1. Visión General Arquitectónica

En las versiones previas de Phaser (v3.x y v4.2.1), el subsistema de sonido dependía de una implementación dividida entre `HTML5AudioSound` y `WebAudioSound`. En aplicaciones complejas o en dispositivos móviles, esto acarreaba limitaciones críticas:
1. **Bloqueo del Hilo Principal (Main Thread Audio):** La creación de nodos, modulación de ganancia y cálculo de paneo ocurrían en el hilo principal del DOM. Si la tasa de cuadros por segundo descendía debido a cargas de render o físicas, el subsistema sufría retrasos en la temporización y vaciados de búfer (*Buffer Underruns*), provocando chasquidos acústicos (*pops/clicks*).
2. **Artefactos por Saltos Discretos de Parámetros (*Zipper Noise*):** Modificar el volumen o la posición espacial mediante asignaciones inmediatas (`gainNode.gain.value = x`) generaba discontinuidades en la forma de onda de audio.
3. **Falta de un Modelo Acústico Espacial Integrado:** La simulación de atenuación por distancia requería plugins de terceros o cálculos matemáticos manuales dentro de los métodos `update()` de las escenas.

En **Tacarigua 1.0.0**, el módulo `@tacarigua/sound-worklet` traslada el procesamiento de señales digitales (DSP) al **hilo de audio de baja latencia del navegador** mediante la especificación **AudioWorklet**:
- **Procesamiento de Señal Off-Thread:** El algoritmo de mezcla y modulación espacial (`SpatialAudioProcessor`) corre en un hilo aislado en tiempo real, garantizando continuidad sónica ininterrumpida incluso si el hilo de renderizado se congela por completo.
- **Paneo Estéreo de Potencia Constante (*Constant Power Panning*):** Distribución trigonométrica de la energía sonora entre los canales izquierdo y derecho para mantener una percepción de volumen uniforme a través del panorama estéreo.
- **Modelos de Atenuación por Distancia Estandarizados:** Soporte nativo para curvas acústicas inversas, lineales y exponenciales calculadas a nivel de parámetro de audio (`AudioParam`).
- **Suavizado de Curvas Libre de Clics (*De-zippering*):** Todos los cambios de ganancia, posición y paneo se interpolan asintóticamente mediante `AudioParam.setTargetAtTime()`.
- **Degradación Elegante (*Fallback*):** Conmutación automática a `StereoPannerNode` o `PannerNode` tradicional si el navegador no admite `AudioWorklet` o si el contexto no se encuentra en un entorno seguro (HTTPS).

---

## 2. Estructura Interna del Módulo

El subsistema se divide en el procesador en tiempo real y las clases de coordinación en el hilo principal:

```
@tacarigua/sound-worklet
├── SpatialAudioProcessor (Inline Worklet) -> Código DSP ejecutado a 128 muestras por bloque (Hilo de Audio)
├── SpatialSound                           -> Objeto fuente con coordenadas tridimensionales y atenuación
└── SpatialSoundManager                    -> Coordinador global de contexto, oyente (Listener) y desbloqueo
```

### 2.1. Procesador en Tiempo Real: `SpatialAudioProcessor`
Es una clase derivada de `AudioWorkletProcessor` que se ejecuta dentro del motor de renderizado de audio del navegador:
- Opera sobre **cuantos de audio (*Audio Quanta*) de 128 muestras**.
- Expone tres parámetros de audio nativos (`AudioParam`):
  - `gain`: Ganancia lineal del sonido ($0.0 \text{ a } 2.0$).
  - `pan`: Posición en el panorama estéreo ($-1.0 \text{ [izq]} \text{ a } +1.0 \text{ [der]}$).
  - `attenuation`: Factor escalar de caída por distancia calculado por la CPU ($0.0 \text{ a } 1.0$).
- Procesa bloques mono o estéreo sin generar objetos en el heap ni activar recolección de basura.

---

### 2.2. Objeto Sonoro Espacial: `SpatialSound`
Representa una fuente sonora puntual emisora en el espacio $(X, Y, Z)$:
- **Atributos de Espacialización:** Coordenadas $X, Y, Z$, distancias umbral (`minDistance`, `maxDistance`), factor de caída (`rolloffFactor`) y modelo acústico (`distanceModel`).
- **Cadena de Nodos en AudioWorklet:**
  ```
  [ AudioBufferSourceNode ] ──► [ AudioWorkletNode ("spatial-audio-processor") ] ──► [ Master GainNode ] ──► [ Destination ]
  ```
- **Cadena de Nodos en Fallback (Clásica):**
  ```
  [ AudioBufferSourceNode ] ──► [ GainNode ] ──► [ PannerNode (Web Audio API) ] ──► [ Master GainNode ] ──► [ Destination ]
  ```
- **Seguimiento Dinámico (`followTarget`):** Permite vincular la fuente sonora a cualquier objeto que exponga coordenadas `x` e `y` (como `Sprite`, `Container` o adaptadores de `@tacarigua/ecs`), delegando la actualización continua al método `updateSpatialProperties()`.

---

### 2.3. Gestor de Audio Espacial: `SpatialSoundManager`
Orquestador maestro integrado en el ciclo de vida del juego:
- **Gestión del `AudioContext`:** Configura el contexto acústico con `latencyHint: 'interactive'` para asegurar la menor latencia de respuesta posible.
- **Inyección Dinámica de Worklet:** Compila y registra `SpatialAudioProcessor` en caliente mediante un `Blob URL`, eliminando la necesidad de empaquetar o servir archivos `.js` externos adicionales en Vite o Webpack.
- **Políticas de Autoplay del Navegador:** Registra oyentes pasivos para eventos de interacción de usuario (`pointerdown`, `touchstart`, `keydown`) que reactivan el contexto suspendido automáticamente.
- **Oyente Global (*Listener*):** Mantiene la posición del observador (`listenerPosition`), habitualmente sincronizada con la cámara principal del juego.

---

## 3. Modelos Matemáticos Acústicos y Algoritmos DSP

### 3.1. Paneo Estéreo de Potencia Constante (*Constant Power Panning*)
El paneo lineal tradicional ($\text{izq} = 1 - p, \text{der} = p$) sufre de una caída de intensidad de $-3\text{ dB}$ en el centro del campo sonoro. Para evitarlo, el `SpatialAudioProcessor` aplica la ley de potencia constante en cada muestra $i$:

$$\theta_{pan} = (\text{pan} + 1.0) \cdot \frac{\pi}{4}$$

$$\text{Ganancia Izquierda} = \cos(\theta_{pan}), \quad \text{Ganancia Derecha} = \sin(\theta_{pan})$$

$$\text{Ganancia Total Efectiva} = \text{gain} \cdot \text{attenuation}$$

$$\text{Muestra}_L[i] = \text{Entrada}_L[i] \cdot \text{Ganancia Total Efectiva} \cdot \text{Ganancia Izquierda}$$

$$\text{Muestra}_R[i] = \text{Entrada}_R[i] \cdot \text{Ganancia Total Efectiva} \cdot \text{Ganancia Derecha}$$

Esta formulación garantiza que la suma de potencias $(\cos^2 \theta + \sin^2 \theta = 1)$ sea invariante sin importar la orientación.

---

### 3.2. Modelos de Caída por Distancia (Atenuación)

Dado un sonido en $(x_s, y_s, z_s)$ y el oyente en $(x_l, y_l, z_l)$, la distancia euclidiana tridimensional es:

$$d = \sqrt{(x_s - x_l)^2 + (y_s - y_l)^2 + (z_s - z_l)^2}$$

Si $d \le d_{min}$, la atenuación es $1.0$ (volumen completo). Para $d > d_{min}$, se aplica la curva seleccionada:

#### 1. Modelo Inverso (`'inverse'`) — *Comportamiento Físico Natural*
$$\text{Atenuación} = \frac{d_{min}}{d_{min} + \text{rolloff} \cdot (d - d_{min})}$$

#### 2. Modelo Lineal (`'linear'`) — *Atenuación Progresiva para HUD / Zonas Delimitadas*
$$\text{Atenuación} = 1.0 - \frac{\text{rolloff} \cdot (d - d_{min})}{d_{max} - d_{min}}$$

#### 3. Modelo Exponencial (`'exponential'`) — *Caída Abrupta para Espacios Abiertos*
$$\text{Atenuación} = \left(\max\left(\frac{d}{d_{min}}, 1.0\right)\right)^{-\text{rolloff}}$$

En todos los casos, el valor final se acota estrictamente en el rango $[0.0, 1.0]$.

---

### 3.3. Supresión de Artefactos Mediante Filtros de Primer Orden
Para evitar chasquidos cuando un sonido o la cámara se mueven rápidamente, los parámetros del AudioWorklet no se mutan directamente. En su lugar, se programan transiciones asintóticas exponenciales de primer orden mediante:
```javascript
param.setTargetAtTime(targetValue, currentTime, timeConstant);
```
Con una constante de tiempo $\tau = 0.02\text{ s}$ ($20\text{ ms}$), el valor converge suavemente hacia el nuevo objetivo sin saltos discretos entre bloques de renderizado.

---

## 4. Comparativa de Rendimiento y Breaking Changes (Phaser v4.2.1 vs Tacarigua v1.0.0)

| Característica | Phaser 4.2.1 (WebAudio / HTML5Audio) | Tacarigua 1.0.0 (`@tacarigua/sound-worklet`) | Beneficio Técnico |
| :--- | :--- | :--- | :--- |
| **Hilo de Ejecución** | Hilo Principal del DOM (UI y Render). | **Hilo de Audio dedicado (`AudioWorklet`)**. | Eliminación de entrecortes por recolección de basura o caídas de FPS. |
| **Soporte HTML5 Audio** | Múltiples elementos `<audio>` en DOM. | **Eliminado por completo**. | Erradica fugas de memoria y limitaciones de concurrencia en navegadores móviles. |
| **Espacialización** | Panning estéreo manual en JavaScript o `PannerNode` síncrono. | **Procesador DSP espacial nativo** con paneo de potencia constante. | Calidad de audio espacial continua y coherencia de volumen en el campo estéreo. |
| **Modulación de Parámetros** | Asignación directa (`gain.value = x`). | **Rampas exponenciales vía `AudioParam`**. | Eliminación total de ruido de crepitación (*Zipper noise/clicks*). |
| **Desbloqueo de Audio** | Bloqueo manual por escena. | **Gestión global reactiva de interacción**. | Cumplimiento transparente de las políticas de Autoplay modernas. |

---

## 5. Guía de Uso Práctico y Ejemplos de Implementación (ES6+)

### Ejemplo 1: Configuración Básica de Audio Espacial Vinculado a un Sprite

Cómo instanciar una fuente de sonido 3D y vincularla al movimiento de un objeto en el juego:

```javascript
import { Game } from '@tacarigua/core.js';
import { SpatialSoundManager } from '@tacarigua/sound-worklet.js';

const game = new Game({ width: 1280, height: 720 });

// 1. Inicializar el gestor de sonido espacial
const soundManager = new SpatialSoundManager(game);

// 2. Crear un sprite en escena
const enemySprite = { x: 900, y: 360, z: 0 };

// 3. Crear el sonido espacial con curva inversa
const engineSound = soundManager.addSpatial('alien_engine', {
    x: enemySprite.x,
    y: enemySprite.y,
    minDistance: 100,    // Distancia a volumen máximo (100 px)
    maxDistance: 1200,   // Distancia de audibilidad límite
    rolloffFactor: 1.2,  // Intensidad de la curva de caída
    distanceModel: 'inverse',
    volume: 0.8,
    loop: true
});

// 4. Vincular el sonido para que siga automáticamente al enemigo
engineSound.setFollow(enemySprite);
engineSound.play();

// 5. En el bucle de actualización:
game.events.on('step', (time, delta) => {
    // Mover al enemigo en pantalla
    enemySprite.x -= 50 * (delta * 0.001);

    // Actualiza la posición del sonido y su cálculo de paneo/atenuación
    soundManager.update(time, delta);
});
```

---

### Ejemplo 2: Sincronización Dinámica de la Posición del Oyente con la Cámara

Para juegos con cámaras móviles (scrolling o vista cenital), el oyente (*Listener*) debe coincidir con el centro de la cámara para que los sonidos a la izquierda o derecha de la pantalla se perciban correctamente:

```javascript
import { SpatialSoundManager } from '@tacarigua/sound-worklet';

const soundManager = new SpatialSoundManager(game);

// En la escena del juego:
export class WorldScene {
    update(time, delta) {
        const camera = this.cameras.main;

        // La posición del oyente coincide con el centro visible de la cámara
        const listenerX = camera.scrollX + (camera.width * 0.5);
        const listenerY = camera.scrollY + (camera.height * 0.5);

        // Actualizar el oyente en el gestor acústico
        soundManager.setListenerPosition(listenerX, listenerY, 0);

        // Actualizar todas las fuentes que siguen objetos
        soundManager.update(time, delta);
    }
}
```

---

### Ejemplo 3: Efecto de Alarma Estática con Caída Exponencial

Configuración de un emisor acústico en una posición fija del mapa con atenuación abrupta:

```javascript
// Fuente fija en una compuerta del mapa
const alarmSound = soundManager.addSpatial('security_alarm', {
    x: 2400,
    y: 800,
    minDistance: 80,
    maxDistance: 600,
    rolloffFactor: 2.0, // Caída pronunciada al alejarse
    distanceModel: 'exponential',
    volume: 1.0,
    loop: true
});

alarmSound.play();
```

---

## 6. Guía de Migración Paso a Paso (Phaser v4.2.1 a Tacarigua v1.0.0)

### Paso 1: Eliminar Configuraciones Heredadas de HTML5 Audio
En versiones anteriores, se recurría a `disableWebAudio: true` para sortear problemas en navegadores antiguos:
- **Antes (Phaser v4.2.1):**
  ```javascript
  const config = {
      audio: {
          disableWebAudio: false,
          noAudio: false
      }
  };
  ```
- **Ahora (Tacarigua v1.0.0):**
  Tacarigua 1.0.0 exige Web Audio API con soporte para `AudioWorklet`. La configuración no requiere flags de fallback obsoletos:
  ```javascript
  const config = {
      audio: {
          // El motor inicializa AudioWorklet automáticamente en segundo plano
      }
  };
  ```

### Paso 2: Sustituir `sound.add()` por `soundManager.addSpatial()`
- **Antes (Phaser v4.2.1):**
  ```javascript
  const sound = this.sound.add('laser');
  sound.play();
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Para sonidos planos no espaciales:
  const sound = soundManager.addSpatial('laser', { minDistance: Infinity });
  sound.play();

  // Para sonidos posicionales en el mundo:
  const spatialSound = soundManager.addSpatial('laser', {
      x: emitter.x,
      y: emitter.y,
      minDistance: 100,
      maxDistance: 1000
  });
  spatialSound.play();
  ```

### Paso 3: Reemplazar el Paneo Manual por `setFollow()`
- **Antes (Phaser v4.2.1):**
  ```javascript
  // Modificación manual en el update
  sound.setPan(calculatePan(player.x, enemy.x));
  ```
- **Ahora (Tacarigua v1.0.0):**
  ```javascript
  // Delegación automática libre de basura
  sound.setFollow(enemy);
  ```