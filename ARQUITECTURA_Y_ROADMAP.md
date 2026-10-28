# ARQUITECTURA Y ROADMAP — Project Lifeline Core (AMRF v2.0)

Fecha: 2026-08-04 · Versión: 2.0.1 · Entorno de referencia: Node.js v26.4.0, Android/Termux, PC en la misma red Wi-Fi.
Estado de la suite automatizada: **197/197 PASS** (`node --test "test/*.test.js"`).

Este documento formaliza el ecosistema de dispositivos del sistema, mapea lo que
ya está implementado contra lo que es un hueco de integración, y fija las etapas
de integración recomendadas para las próximas versiones. Es un documento de
planificación: la información operativa de pruebas vive en `MANUAL_PRUEBAS.md` y
`GUIA_PRUEBAS_MANUALES.md`.

---

## 1. Visión del ecosistema (capas)

```
┌────────────────────────────────────────────────────────────────┐
│  Capa 4 · Largo alcance (futuro)                               │
│    Satelital (Iridium SBD / Swarm / Astrocast) · HF/TNC 1.8-30MHz│
├────────────────────────────────────────────────────────────────┤
│  Capa 3 · Malla Mesh terrestre                                  │
│    LoRa Sub-GHz (433/868/915) · repetidores off-grid solares     │
│    · relay HTTP/UDP cross-device · UDP broadcast discovery      │
├────────────────────────────────────────────────────────────────┤
│  Capa 2 · Radios clásicas y SDR                                  │
│    APRS/AX.25 VHF/UHF (2m/70cm) · SDR FM (RTL-SDR/HackRF)        │
├────────────────────────────────────────────────────────────────┤
│  Capa 1 · Cómputo de borde                                      │
│    Smartphones/tablets Android (Termux) · navegadores (PWA)      │
│    · Edge gateways (Raspberry Pi / Orange Pi + AP Wi-Fi)         │
├────────────────────────────────────────────────────────────────┤
│  Capa 0 · Sensores y actuadores                                  │
│    Acelerómetros (detección sísmica) · GPS/GNSS · barómetro     │
│    · BLE biométrico (BPM/SpO2) · sirenas/relés (alerta temprana) │
└────────────────────────────────────────────────────────────────┘
```

Regla transversal: **cero datos inventados**. Sin lectura real de un sensor se
muestra `—` y la telemetría lleva `null`. El stack es 100% Node estándar (cero
dependencias) para operar sin red en desastre.

---

## 2. Inventario real del código

| Módulo | Ruta | Rol en la arquitectura |
|---|---|---|
| `packet_encoder.js` | `radio/` | Trama CBOR+LZ77+AES-CTR (nonce 8 + cifrado + MIC 4) |
| `lora_mesh.js` | `radio/` | Malla LoRa: nodos, rutas, beaconing 5 s, TTL/poda de balizas. Bandas `EU433/EU868/US915` |
| `aprs_protocol.js` | `radio/` | Tramas APRS/AX.25 (144.390 / 144.800), objetos de posición |
| `sdr_receiver.js` | `radio/` | Demodulación FM y monitor de espectro (RTL-SDR/HackRF) |
| `frequency_mgr.js` | `radio/` | Asignación de frecuencias por prioridad y región |
| `radio_driver.js` | `radio/` | Driver de radio física LoRa (SX1276/SX1262) vía Web Serial — Etapa 0 |
| `ble_bridge.js` | `radio/` | Puente BLE biométrico (BPM/SpO2) vía Web Bluetooth — Etapa 0 |
| `aes128.js` | `radio/` | AES-128 (núcleo de `packet_encoder`) |
| `udp_bridge.js` | `radio/` | Puente cross-device UDP entre instancias |
| `lifeline_engine.js` | `simulation/simulation/` | Motor de producción: encriptación, malla, APRS, SDR, intercom incrustado, **materialización de nodos por BEACON**, `pruneStaleNodes` (TTL 30 s) |
| `relay_adapter.js` | `simulation/simulation/` | Transporte cross-device: relay HTTP/SSE + pares por UDP broadcast; reenvía telemetría/beacon/join entre dispositivos en VIGILANCE |
| `device_sensors.js` | `simulation/simulation/` | Sensores reales del navegador (GPS, barómetro, luz, movimiento, micrófono, batería) — **no inventa datos** |
| `app_integrated.js` | `simulation/simulation/` | GUI v2.0 (panel AMRF en HTML5 Canvas): indicadores reales, clasificador de rol, tabla scout en tiempo real (tick 1 s), intercom |
| `core_math.js` | `simulation/simulation/` | IPU, triage, `resolveState`, `classifyRole` (con null-safety) |
| `server.js` | `simulation/simulation/` | Gateway HTTP por dispositivo: sirve la GUI en todas las interfaces (puerto 8000), `/api/state`, `/api/peers`, `/relay/send`, SSE, descubrimiento UDP |
| `manifest.webmanifest` | `simulation/simulation/` | PWA instalable: name, display standalone, iconos 192/512 — Etapa 1 |
| `sw.js` | `simulation/simulation/` | Service worker: cache-first del app shell (offline); API `/api/` y `/relay/` siempre en red — Etapa 1 |
| `tools/install_gateway.sh` | `simulation/simulation/` | Instalador de gateway RPi/OPi (hostapd + dnsmasq + systemd + validación) — Etapa 1 |
| `tools/lifeline.service` | `simulation/simulation/` | Unit systemd del gateway (`server.js`, Restart=always, PORT=8000) — Etapa 1 |
| `tools/gen_icons.js` | `simulation/simulation/` | Genera los iconos PWA PNG sin dependencias (zlib + CRC32) |

---

## 3. Dispositivos compatibles actuales (mapeo real)

### 3a. Móviles, tablets y cómputo de borde

| Dispositivo | Estado | Cómo |
|---|---|---|
| Smartphones/tablets Android | ✅ | GUI `index_integrated.html` + sensores del navegador (`device_sensors.js`) |
| Acelerómetros ultrasensibles (detección sísmica / telemetría) | ✅ | `device_sensors.js` → movimiento y tilt en `classifyRole` |
| Entorno Termux (Android) | ✅ | `node server.js` como servicio; `termux-services` + `svc` para baliza/monitoreo en segundo plano |
| Navegadores móviles y de escritorio (PWA panel) | ✅ | `server.js` sirve la GUI en todas las interfaces; canvas HTML5; **PWA instalable + offline** (manifest + sw.js, Etapa 1) |
| Web Bluetooth (BLE) / Web Serial / WebUSB | ✅ | `radio/ble_bridge.js` + `radio/radio_driver.js` (requieren wearable/transceptor reales) |

### 3b. Hardware de RF y módulos LoRa

| Dispositivo | Estado | Cómo |
|---|---|---|
| Malla LoRa 433/868/915 (SX1276/SX1262, T-Beam, Heltec, RAK4631, STM32-WL) | ✅* | `lora_mesh.js` (malla) + `radio/radio_driver.js` (driver Web Serial). *Requiere firmware del transceptor que hable el protocolo |
| Puentes BLE/Serial → tramas AES-CTR a la malla | ✅* | `radio/ble_bridge.js` + `applySensorData`; *requiere wearable BLE real |

### 3c. Radioafición y SDR

| Dispositivo | Estado | Cómo |
|---|---|---|
| Handhelds VHF/UHF (2 m / 70 cm) — APRS/AX.25 | ✅ | `aprs_protocol.js` + `APRSTracker`; coordenadas y mensajería táctica |
| SDR USB (RTL-SDR / HackRF) | ✅ | `sdr_receiver.js` (demod FM, monitor de espectro) |

### 3d. Sensores biométricos y de energía

| Dispositivo | Estado | Cómo |
|---|---|---|
| Oxímetros / pulsómetros / SpO2 / presión arterial BLE | ✅* | `radio/ble_bridge.js` (GATT 0x180D/0x1822) → `applySensorData({bpm, spo2})`; *sin wearable real la GUI sigue en `—` |
| Monitores de batería | ✅ | `navigator.getBattery()` (lectura real) |
| Barómetro (presión de derrumbe) | ✅ | Sensor real del navegador; profundidad `calcDeltaH` |

---

## 4. Gaps de integración (falta construir)

| Hueco | Descripción | Capa |
|---|---|---|
| ~~Driver LoRa físico~~ | ~~✅ Etapa 0: `radio/radio_driver.js`~~ (pendiente solo el firmware del transceptor) | 3 |
| ~~Puente BLE biométrico~~ | ~~✅ Etapa 0: `radio/ble_bridge.js`~~ (pendiente solo el wearable físico) | 0 |
| ~~Edge gateway documentado~~ | ~~✅ Etapa 1: `DEPLOY_GATEWAY.md` + `tools/install_gateway.sh` + `tools/lifeline.service` + PWA~~ | 1 |
| **Firmware de transceptor SX1276/SX1262** | Firmware para ESP32/Heltec/RAK que hable el protocolo del driver por serial | 3 |
| **GNSS dedicado** | Posición UART/I2C con brújula, independiente del A-GPS celular → `config.lat/lon` del motor | 0 |
| **Actuador de alerta temprana** | Relés RF que disparen sirenas/luces al recibir alertas P-Wave validadas | 0 |
| **Transportes de largo alcance** | Módems satelitales (Iridium SBD / Swarm / Astrocast) y TNC HF 1.8-30 MHz como capa 4 alternativa | 4 |
| **Repetidores autónomos off-grid** | Perfil de ultra bajo consumo + energía solar/LiFePO4 para nodos desatendidos | 3 |

---

## 5. Roadmap de integración (etapas)

### Etapa 0 — Base física (mayor desbloqueo) ✅ entregada (2026-08-04)
**Alcance entregado**
- `radio/radio_driver.js`: driver de radio LoRa vía **Web Serial** (`navigator.serial` + transporte abstracto inyectable). Protocolo de líneas `RESET / CONFIG / TX <hex>` y eventos `OK / ERROR / EVT READY / EVT RX <hex> <rssi> <snr>`. Honesto: sin Web Serial → `WEB_SERIAL_NO_DISPONIBLE`; sin conexión → `NO_CONECTADO` (nunca inventa TX).
- `radio/ble_bridge.js`: puente de vitales reales vía **Web Bluetooth** — GATT Heart Rate (0x180D/0x2A37) y Pulse Oximeter (0x1822/0x2A5F) → `applySensorData({bpm, spo2})`. Honesto: sin Web Bluetooth → `WEB_BLUETOOTH_NO_DISPONIBLE`; wearable sin servicios vitales → `BLE_SIN_SERVICIOS_VITALES`.
- Hook `engine.afterLocalTx`: cada trama local (telemetría, intercom, ping) sale también por la radio física cuando hay transceptor vinculado.
- GUI (`index_integrated.html` panel ⑯): botones `🔌 VINCULAR RADIO LORA (WEB SERIAL)` y `❤ VINCULAR WEARABLE (BLE)` con estados `SIN RADIO FÍSICA` / `SIN BLE`; los frames recibidos por radio entran al motor por la vía de descifrado real.

**Verificación**
- Suite en verde: +19 tests (`test/radio_driver.test.js` 12, `test/ble_bridge.test.js` 5, hook `afterLocalTx` 1, botones BIND 1) → **190/190 PASS**.
- Pendiente físico (no requiere más código en el repo): firmware del transceptor SX1276/SX1262 que hable el protocolo por el puerto serial.

### Etapa 1 — Gateways de borde ✅ entregada (2026-08-04)
**Alcance entregado**
- `DEPLOY_GATEWAY.md`: despliegue completo de `server.js` en Raspberry Pi/Orange Pi: AP Wi-Fi (hostapd) + DNS/DHCP (dnsmasq) + portal cautivo + servicio systemd + verificación por `curl`.
- `simulation/simulation/tools/install_gateway.sh`: instalador idempotente (copia el repo a `/opt/lifeline`, configura hostapd/dnsmasq, instala `lifeline.service`, arranca y valida endpoints).
- `simulation/simulation/tools/lifeline.service`: unit de systemd (Restart=always, `PORT=8000`, `HOST=0.0.0.0`).
- **PWA instalable**: `manifest.webmanifest` (name/short_name/display standalone/icons 192+512), `sw.js` (service worker cache-first del app shell, **la API `/api/` y `/relay/` nunca se cachean** — telemetría siempre en red; offline total de la GUI), iconos generados sin dependencias por `tools/gen_icons.js` (PNG válidos con zlib + CRC32, pulso de vida sobre azul noche).
- `index_integrated.html` enlaza manifest/theme-color/apple-touch-icon; `app_integrated.js` registra el SW de forma guardada (no lanza en el arnés vm ni en `file:`).

**Verificación**
- Un teléfono sin apps se conecta al AP del gateway y abre el panel (`http://10.10.0.1:8000`); instalada, la GUI abre standalone y offline.
- Suite +7: `test/pwa.test.js` (manifest JSON válido, iconos PNG con dimensiones reales, app shell coherente con disco, API nunca cacheada, enlaces del HTML, registro guardado, MIME correcto) → **197/197 PASS**.

### Etapa 2 — GNSS dedicado
**Alcance**
- `gnss_reader.js`: ingestión de módulo GPS/GNSS UART/I2C (NMEA/UBX) con brújula.
- La GUI ya acepta posición por `?lat/?lon`; el motor ya usa `config.lat/lon` en tramas APRS y beacons.

**Criterio de aceptación**
- Beacons/APRS salen con coordenadas del GNSS externo aunque el A-GPS celular no exista.

### Etapa 3 — Alerta temprana con actuadores
**Alcance**
- `actuator_output.js`: salidas por relé (sirena/luces) disparadas por tramas P-Wave validadas.
- Selector de zona/refugio y confirmación de disparo en la GUI.

**Criterio de aceptación**
- Al recibir una alerta validada, el actuador se dispara y se registra en el log RF.
- Prueba con mock de GPIO en la suite.

### Etapa 4 — Largo alcance (satélite / HF)
**Alcance**
- Interfaz de transporte alternativo en `relay_adapter.js` (hoy HTTP/UDP) para módems satelitales (Iridium SBD / Swarm / Astrocast) y TNC HF (1.8-30 MHz).
- Reintentos, cola de mensajes y compresión adaptada a canales lentos.

**Criterio de aceptación**
- Un mensaje intercom cruza por el transporte satelital con ACK/retry.
- Tests de la interfaz abstracta (mock de modem) sin hardware.

---

## 6. Decisiones de diseño que rigen estas etapas

- **Cero dependencias**: todo lo nuevo usa API estándar de Node/Web (Web Serial/WebUSB son APIs de plataforma, no librerías).
- **Cero datos inventados**: cada módulo físico solo puede *llegar* a producir lecturas reales; el resto permanece `—`/`null`.
- **Suite en verde**: cada etapa suma sus tests (`node --test "test/*.test.js"`) y nunca rompe los 171 actuales.
- **Español en todo el código y la documentación**.
- **El navegador no miente**: si una API (p. ej. Web Bluetooth) no está disponible, la GUI lo reporta (`SIN TRANSPORTE`) sin degradar silenciosamente.

---

## 7. Barrido avanzado subterráneo (módulos nuevos)

Módulos integrados en el motor (`simulation/simulation/lifeline_engine.js`) y en la
GUI (`index_integrated.html`, panel ⑰ BARRIDO AVANZADO). Siguen la regla transversal
de **cero datos inventados**: sin lectura real se muestra `—`/`null` y se reporta el
estado sin degradar.

| Módulo | Archivo | Rol |
|---|---|---|
| `LifelineAtmosphereBridge` | `radio/atmosphere_bridge.js` | BLE GATT **Environmental Sensing 0x181A** — CO `0x2BD0` (ppm, u16 LE), O2 `0x2BD5` (% , u16 LE/100). `evaluateAtmosphere(coPpm, o2Pct) → level {SAFE, WATCH, HAZARD, SEVERE}`; **audible solo en HAZARD/SEVERE**. Honesto: sin Web Bluetooth → `WEB_BLUETOOTH_NO_DISPONIBLE`; sin servicio ambiental → `SIN_SERVICIO_AMBIENTAL` |
| `ThermalCam` | `radio/thermal_cam.js` | Malla térmica `parseThermalGrid` (32×24 int16 LE °C) + `detectHumanSignatures` (firma corporal por defecto 36–37 °C, configurable → `count`/`hotspots`); transporte textual `THERMAL <hex>`; `attach(null)` → `SIN_TRANSPORTE` |
| `DtnStore` | `radio/dtn_store.js` | Store-and-forward (data mule): `ingest` dedup por `nodeId`, outbox vía `pending()`/`markSynced(nodeId)`, `merge(beacons)`, `counts()`; cifrado AES-128-CTR + MIC AES-CMAC 4 B en reposo; I/O inyectable (memoria / localStorage) |
| `WakeRadioController` | `radio/wake_radio.js` | Escucha ultra-baja BLE; estados `OFF/IDLE/ACTIVE`. `enable()→IDLE`, `signalProximity()→ACTIVE` (nunca inventa detección), `tick(now)` vuelve a `IDLE` tras `activeMs`; reloj inyectable |
| Altimetría diferencial | `simulation/simulation/core_math.js` | `calcDeltaHRef` + `estimateFloorLevel` (`P0`, `-N` sótanos, `PN` pisos) |

**Integración en el motor**

- `loadRadio` carga los 4 módulos (atmosphere, thermal, dtn, wake).
- `co_ppm` / `o2_pct` se incluyen en la telemetría.
- API del motor: `engine.dtn`, `syncDTN`, `mergeDTN`, `rebalanceRoles`, `setLocalRole`.
- `engine.wakeRadio.enable()` al arranque.

**Estado de pruebas**

- Suite automatizada en verde: **239/239 PASS** (`node --test "test/*.test.js"`), total subió de **197**.

## 8. Identificación de nodos y detección en vivo + responsive móvil

La GUI refleja la lista de datos recibidos **al instante** de detectar cada nodo, para
identificar mejor cada unidad en el operativo, y se adapta a pantallas smartphone.

**Reflejo en tiempo real (solo reacciona a nodos reales de `engine.getNodes()`)**

- **Radar + resaltado**: `trackNodeDetections()` (llamado desde `updateUI`) compara la
  firma de datos por nodo (`bpm|spo2|co_ppm|o2_pct|profundidad`) contra el estado previo.
  Primer avistamiento → evento `NUEVO`; cambio real de lecturas → evento `ACTUALIZADO`.
  El canvas `draw()` pinta un anillo pulsante + etiqueta `◉ NUEVO`/`△ ACTUALIZADO` durante
  `FLASH_MS` (4 s); la fila de la tabla se resalta (`det-row-new`/`det-row-upd`).
- **Feed en vivo**: panel `DETECCIONES EN VIVO` lista cronológicamente cada detección con
  los datos recibidos (vitales, atmósfera, profundidad) y su marca de tiempo (máx. `FEED_MAX` 12).
  Honesto: sin detecciones muestra "esperando datos de nodos reales". `clearDetections()` limpia.
- **Datos en el blob del radar**: bajo cada nodo se dibuja su última lectura recibida
  (`110B 93% CO5 3.2m`), además de su rol, para identificarlo sin abrir la tabla.

**Optimización móvil (smartphone)**

- Media query `@media (max-width:600px)`: la tabla de 11 columnas se **colapsa a tarjetas
  por nodo** (cada `<td data-label>` se vuelve una fila "Etiqueta: valor"); encabezado oculto.
- Radar con altura fija `260px` en móvil para que el lienzo no domine la pantalla.
- `#mesh-canvas` y contenedores se refluyen; pie de radar (PING ALL) apilado a ancho completo.

**Estado de pruebas** — suite en verde **242/242 PASS** (239 + 3 de detección en vivo).

## 9. Pantallas móviles (smartphone): ventana completa por tarjeta + menú ampliable

En pantallas angostas (≤600 px) cada tarjeta del operativo se convierte en una
**ventana de pantalla completa**, y un **menú ampliable (☰)** permite elegir cada
pantalla por su función. En escritorio las tarjetas siguen fluyendo en grid (sin cambios).

**Mecánica**

- `PANEL_REGISTRY` (19 tarjetas `id` → función) en `app_integrated.js`; `initMobileNav()`
  construye el cajón `#mobile-drawer` con un botón por pantalla (`createElement`, testeable).
- `applyMobilePanel(id)` marca la tarjeta activa con `mob-active` y resalta su entrada en
  el menú; `goToPanel(id)`/`toggleMobileNav()`/`closeMobileNav()` se exponen en `window`.
- `isMobileLayout()` = `window.innerWidth <= 600`. En móvil, CSS hace `position:fixed; inset:0`
  + `overflow-y:auto` a la tarjeta activa y oculta el resto; el botón ☰ flota (z-index alto).
- `onLayoutChange()` (hookeado a `resize`) reordena al rotar/redimensionar y restaura el grid
  al volver a escritorio.

**Estado de pruebas** — suite en verde **245/245 PASS** (242 + 3 de modo móvil:
pantalla completa + menú, toggle del cajón, y escritorio/móvil sin romper el grid).
El arnés `dom_harness.js` ahora acepta `innerWidth` y el método `panels` de selección.

## 10. Modo aplicación en móvil: pantalla completa por tarjeta + Fullscreen API

Refuerzo del modo móvil para que se comporte **como una aplicación**: cada tarjeta llena
toda la pantalla y el menú ☰ permite navegar entre ellas.

- **La tarjeta activa ocupa la pantalla completa**: en `@media (max-width:600px)` la tarjeta
  `mob-active` es `position:fixed; inset:0`, `display:flex; flex-direction:column`, y su cuerpo
  (`.card-body` / nodos no-header) hace `flex:1; overflow-y:auto` — el encabezado queda fijo y
  solo el contenido hace scroll interno (sensible a la altura de pantalla, no largo de página).
- **Botón `⛶ PANTALLA COMPLETA` al final del menú**: `toggleFullscreen()` usa la **Fullscreen
  API** (`requestFullscreen`/`exitFullscreen`) sobre la tarjeta activa, con **fallback
  `forced-fullscreen`** (clase que fuerza `position:fixed; width:100vw; height:100vh`) para
  navegadores sin API (p.ej. iOS). `isFullscreenActive()` considera la clase de fallback.
- **Caché PWA**: `sw.js` subió a `lifeline-shell-v2` — era la causa de que la app instalada
  siguiera sirviendo el shell viejo (página larga) por la estrategia cache-first.

**Estado de pruebas** — suite en verde **247/247 PASS** (245 + 2 de modo móvil: botón de
pantalla completa con fallback y cierre del cajón al elegir pantalla).

## 11. Licenciamiento, gobernanza y saneamiento de credenciales

Para promover el desarrollo libre y la adopción en escenarios humanitarios (PNUD,
agencias ONU, protección civil, brigadas de rescate y comunidades de radioaficionados),
el proyecto sigue estas recomendaciones:

**Licencia MIT (permisiva, código abierto)**

- Archivo **`LICENSE`** (MIT) en la raíz del repositorio.
- `package.json` declara `"license": "MIT"` (antes `UNLICENSED`) y deja de ser privado.
- Justificación: una licencia permisiva permite auditar, reutilizar, modificar y escalar la
  plataforma sin trabas legales, pilar de transparencia para el ecosistema ONU y adopción en terreno.

**Saneamiento de credenciales**

- No hay claves secretas ni tokens en el repositorio. La clave AES-128 del enlace se inyecta en
  ejecución:
  - Servidor/gateway: variable de entorno (`LIFELINE_AES_KEY`), ver `.env.example`.
  - GUI de mando: parámetro de URL `?key=<32 hex>` (los operadores la generan y la distribuyen
    fuera de banda). Sin clave → se usa la **clave de referencia NIST** (`DEFAULT_AES_KEY` en
    `radio/packet_encoder.js`), marcada explícitamente como SOLO DEMO.
  - `LIFELINE_CALLSIGN` se pasa por URL/entorno; si la omite, APRS queda inactivo (no usa `N0CALL`).
- `simulation/simulation/server.js` al arrancar directamente lee `PORT`, `LIFELINE_NETWORK_ID`,
  `LIFELINE_INSTANCE_ID`, `LIFELINE_LABEL`, `LIFELINE_DISCOVERY` y `LIFELINE_DISCOVERY_PORT`.
- Plantilla **`.env.example`** para desarrolladores y colaboradores; **`.gitignore`** excluye
  `.env*`, dependencias, registros y capturas de sesión.

**Gobernanza recomendada**

- Generar la clave maestra con `node -e "console.log(crypto.randomBytes(16).toString('hex'))"` y
  rotarla por operativo; distribuir fuera de banda.
- Mantener el repositorio público y el proceso de revisión abierto; los secretos nunca entran al
  historial. Si alguno se filtrara, rotarlo de inmediato (la arquitectura lo permite al ser
  clave por-URL/entorno, no compilada).

**Estado de pruebas** — suite en verde **247/247 PASS** (sin regresión por el licenciamiento).

## 12. Vectorización magnética de precisión (UWB + IMU)

Apunta a la flecha táctica del rescatista hacia la víctima con **ángulo e inclinación
exactos** (evita perforar a ciegas y el colapso secundario), fusionando UWB y el IMU del
teléfono bajo la regla estricta de **cero datos inventados**.

**Modelo matemático (en `core_math.js`, compartido Node/navegador)**

- `AzimuthKalmanFilter` — Filtro de Kalman **1D** que estabiliza el **Azimut (alpha)** ante
  la distorsión magnética estructural (hierro retorcido / jaula de Faraday):
  - **Predicción** (dead-reckoning): `x += gyroRate·dt`, `P += Q`.
  - **Actualización** (brújula): Ganancia `K = P/(P+R)`. Con `R` alto (anomalía), `K→0`
    confía en el giroscopio; con `R` bajo, `K→1` confía en la brújula. Cruce del norte
    (360→0) manejado con normalización a `[0,360)`.
  - Null-safe: sin lectura ni estado previo → `null`.
- `calculateRescueVector(distance, rawAzimuth, gyroRate, pitch, dt, filter)` — transforma
  esféricas→cartesianas: `x=d·cosθ·cosφ`, `y=d·sinθ·cosφ`, `z=d·sinφ` (z negativo = bajo
  el suelo). Si `distance` (UWB) es null → **null** (la flecha se apaga, no se congela).

**Integración en el motor (`lifeline_engine.js`)**

- `engine.azimuthFilter` (instancia por dispositivo), `engine.calculateRescueVector(...)`
  (usa la misma API null-safe), `engine.rescueVectorState()` y `engine.resetRescueVector()`.
- `coreMath` se añadió a `loadRadio` (Node `require('./core_math.js')`; navegador `global.coreMath`).

**Ingesta 100% nativa (`device_sensors.js`)**

- `DeviceOrientationEvent` captura `orientation = {alpha, beta, gamma}` (si el navegador no
  reporta `alpha`, se conserva `null` y `hasOrientation=false`).
- `setDistance(m)` recibe la distancia UWB **ToF** vía **bridge BLE/Serial** (patrón
  `ble_bridge`/`atmosphere_bridge`); entrada no numérica/negativa se descarta (→ `null`).
- Estado expuesto: `hasUwb`, `hasOrientation`, `uwbDistance`, `orientation` — sin lectura
  real la UI pintará `—` en lugar de inventar una dirección.

**Estado de pruebas** — suite en verde **266/266 PASS** (base + Filtro de Kalman, vector
null-safe/esféricas, convergencia R bajo, cruce del norte, dead-reckoning, ingesta UWB/IMU
y render de la flecha táctica en la GUI).

**Renderizado (flecha táctica)** — el panel ④ Scout incluye una brújula dinámica
(`#rescue-canvas`, Canvas 200×200) que cruza la distancia UWB real con la orientación real
del IMU y el Filtro de Kalman del motor:

- `getRescueSources()` → estado real (`distance`/`azimuth`/`pitch` desde el snapshot del sensor).
- `computeRescueArrow()` → `engine.calculateRescueVector(...)`; devuelve el vector `{x,y,z}`,
  la distancia horizontal `h`, la inclinación `plunge` y el rumbo `dirAz`/`dirLabel`.
- `renderRescueArrow()` dibuja el aro de la brújula, la marca del Norte (roja, girada por el
  azimut real), la flecha "táctica" hacia el vector horizontal y el indicador de profundidad
  (`↙ -x.x m ↓` si `z<0` = víctima bajo el suelo).
- `updateRescueReadout()` pinta la lectura textual honesta: `Cavar <z> m (<rumbo>) · dist. <h> m`.
- Regla estricta sin datos inventados: sin distancia UWB / sin brújula / sin inclinación, la
  flecha se apaga y el readout muestra `— · sin distancia UWB`, `— · sin brújula`, etc.,
  con el status `SIN VECTOR` (gris). Solo con las tres lecturas reales se muestra `VECTOR ACTIVO`.
- `onOrientation` se expone en el api del sensor (junto a `setDistance`) para poder inyectar
  la orientación real en pruebas headless y por el bridge BLE/Serial.

**Correlación térmica (punto de excavación)** — módulo `radio/excavation_cam.js`
(`ExcavationCam.suggestExcavationPoint`), registrado en el arnés/HTML como el resto de módulos RF:

- Correla el vector de rescate con el gradiente de calor del `thermal_cam`: la posición del
  pixel más cálido (firma humana) respecto al centro del campo genera un **desvío** de azimut
  (izquierda/derecha, `nx`) y de inclinación (arriba/abajo, `-ny`), según el campo de visión
  por defecto del MLX90640 (55°×35°, configurables `hFovDeg`/`vFovDeg`).
- Inclinación CON SIGNO (negativa = apuntando hacia abajo): `pitchBase = -|plunge|` si el
  vector indica `depth<0` (víctima bajo el suelo); si no, positiva.
- Resultado `{ status: SUGGESTED|NO_VECTOR, thermalUsed, suggestion:{ azimuthFinal,
  pitchFinal, depth, distanceHorizontal }, thermal }`. `depth = distBase·sin(pitchFinal)`;
  `azimuthFinal` siempre normalizado a `[0,360)`.
- Regla honesta: sin vector real → `NO_VECTOR` (nunca inventa un punto); sin firma térmica el
  desvío es 0 y se conserva la dirección del vector. La GUI (panel ④, `#excavation-suggestion`)
  pinta "Excavar: <rumbo> <azimut>º · profundidad <x> m · desvío <a>° az / <i>° in · barrera <t> °C".
- La GUI cruza `computeRescueArrow()` + `lastThermal` en cada tick (`updateUI`); el hook de
  depuración `window.setLastThermal(frame)` inyecta frames térmicos reales (Web Serial o tests).

**Consolidación (overlay táctico)** — ambos indicadores (flecha cian de dirección y diana ámbar
`EXCAVAR` de punto exacto) se unen en UN solo Canvas del panel ④ (`#rescue-canvas`), con un
resumen unificado `#tactical-summary` y un conmutador `#btn-tactical-mode`:

- Estado `tacticalMode` (`'TACTICA'` por defecto | `'VECTOR'`): `toggleTacticalMode()` alterna,
  etiqueta el botón (`ON`/`OFF`) y repinta.
- `renderRescueCompass()` computa el estado (`rescue` + `exca`) una vez y despacha por modo:
  - `TACTICA` → `renderTacticalOverlay()`: aro + N + flecha cian (dirección UWB+IMU) + diana
    ámbar en `azimuthFinal` (corregida por el gradiente térmico) + profundidad consolidada.
  - `VECTOR` → `renderRescueArrow()` (flecha sola).
  - Ayudantes extraídos: `drawNorthMark`, `drawVectorArrow`, `drawExcavationTarget`, `drawDepthTag`.
- Resumen unificado `buildTacticalSummary()`: `MODO TÁCTICA: excavar <rumbo> <az>º @ <x> m ·
  desvío +<a>° térm` (o `MODO VECTOR: <rumbo> ...`); honesto sin datos →
  `TÁCTICA: sin vector — sin datos qué consolidar`.
- Los desgloses `#rescue-readout` y `#excavation-suggestion` se conservan (detalle honesto).

**Estado de pruebas** — suite en verde **277/277 PASS** (base + Filtro de Kalman + vector
null-safe/esféricas + convergencia R bajo + cruce del norte + dead-reckoning + ingesta UWB/IMU
+ flecha táctica + correlación térmica de excavación + overlay táctico consolidado + puente
de campo Web Serial + modo esclavo WebRTC P2P).

**Modo esclavo (temporal, pruebas de campo) — `radio/webrtc_link.js`** — transforma un
dispositivo en ESCLAVO para validar en dos equipos sin infraestructura:

- Enlace P2P directo por **WebRTC DataChannel** con señalización manual por copiar/pegar
  (offer ↔ answer), sin servidor de paso.
- **Emisor (esclavo, el que tiene los sensores)**: `rtcCreateOffer` (①) → el maestro pega la
  oferta (②) → el esclavo pega la respuesta (③) y arranca `startRtcSlaveLoop`: emite las
  LECTURAS REALES del dispositivo (`ORI <a b g>` del IMU, `UWB <m>` de su puente,
  `THERMAL <hex>` de su barco térmica) como líneas del protocolo.
- **Receptor (maestro, Scout)**: `rtcAcceptOffer` devuelve la respuesta e inyecta cada línea
  recibida en el puente de campo (`injectFieldLine` → `fieldBridge.injectLine`), de modo que
  UWB/ORI/THERMAL llegan al sensor y a la célula, encendiendo el overlay táctico.
- `thermalToHex` codifica la rejilla (Float32Array °C) a hex int16 LE compatible con
  `thermal_cam`. Expone `window.WebRtcFieldLink` + `window.getRtcLink()` (debug/test).
- Regla honesta: sin enlace abierto nada viaja; el esclavo solo emite las lecturas reales que
  tiene y el maestro no inventa si no recibe.
- **Conmutador manual de modo (independiente del rol)**: botón `#btn-rtc-mode` en el panel
  ROL DINÁMICO alterna ESCLAVO/MAESTRO (`rtcMode`, `toggleRtcMode`); "aplicar rol" (SCOUT/RELAY)
  NO lo toca — solo lo refleja en el log. Cada acción del handshake (① oferta, ② respuesta,
  ③ completar, cerrar, y la emisión periódica del esclavo) registra su progreso vía
  `rtcProgress` en el log de campo y en `#rtc-status`, para confirmar el avance en pantalla.
  El conmutador se sincroniza solo: crear oferta ⇒ ESCLAVO, aceptar oferta ⇒ MAESTRO.
- **Nodo remoto en la malla/gráficos**: el maestro, al recibir cada línea (`ON_LINE`),
  materializa al dispositivo remoto como nodo real en `engine.remoteNodes`
  (`materializeFieldRemote`: id estable derivado de la OFERTA → `remoteIdFromOffer`, rol
  SCOUT, etiqueta `NODO-CAMPO`, adjunta UWB/orientación/térmica que traiga). Así el esclavo
  aparece en el radar (tabla) y en los gráficos (`mesh-canvas`/`topdown-canvas` vía
  `displayNodes()`) además de alimentar el sensor. Al cerrar el enlace (`rtcClose`) se poda
  (`pruneFieldRemote`) — honesto, sin nodos fantasma.
- **Panel propio y visible (móvil y escritorio)**: la caja WebRTC vive en su propia tarjeta
  `#panel-field` "⤻ ENLACE DE CAMPO", registrada en el menú móvil (☰) para alcanzarla en
  smartphone; el conmutador `#btn-rtc-mode` (ESCLAVO/MAESTRO) está al tope de la caja y, al
  pulsarlo, da feedback visible (`#rtc-mode-state` + status) y centraliza la vista. Un segundo
  conmutador (`#btn-rtc-role`) en el panel ROL queda sincronizado.

**Puente de campo (Web Serial) — `radio/field_bridge.js`** — la pieza que faltaba para las
pruebas reales: un puerto serial con líneas que alimentan el dispositivo físico del Scout.

- Protocolo de líneas: `UWB <m>` → `sensors.setDistance` · `ORI <a> <b> <g>` →
  `sensors.onOrientation` · `THERMAL <hex>` → enrutado a la cámara térmica
  (vía `fieldBridge.thermalTransport`, que `thermal_cam.attach` entiende).
- `connectFieldSerial()` abre el puerto (Web Serial), suscribe `handleFieldLine` y, al
  conectar, enlaza la térmica al mismo puerto. Botón `#btn-bind-serial` + status `#fb-status`.
- `window.getFieldBridge()` (debug/test) e `injectLine`/`injectChunk` para inyectar líneas
  reales en pruebas headless y en adquisición por otros canales (BLE). Coherente con
  `ble_bridge`/`atmosphere_bridge`: sin puerto abierto no llegan datos, nada se inventa.

**Movil pantalla completa (arreglado)**: la tarjeta activa usaba `100vh`, que en moviles con
barra/gesto queda por debajo del borde visible → contenido tapado por los banners o fuera de
pantalla. Fix (styles.css):
- `viewport-fit=cover` en el meta (insets seguros).
- Altura por viewport dinámico: `100dvh` (con `:fullscreen` y `.forced-fullscreen`) +
  `env(safe-area-inset-top/bottom)`; el botón ☰ y el cajón también respetan el área segura
  inferior; la tarjeta móvil base añade `padding-top` por muesca.
- `width:100%` en vez de `100vw` en el fallback (evita overflow horizontal).

**Próxima fase: pruebas de campo** — con el puente real montado, validar en hardware
`GUIA_PRUEBAS_MANUALES` (TC-FIELD-01..05) inyectando `UWB`/`ORI`/`THERMAL` desde el
dispositivo esclavo; el arnés cubre la lógica, el dato físico entra por el puerto sin
inventar nada.

---

## 6. Capa de enlaces por dispositivo (gestor desacoplado)

**Motivo**: los `connect*` de cada sensor estaban acoplados a un único `app_integrated.js`
(objeto gigante, estado compartido). Para comenzar la implementación real por dispositivo se
extrae una capa intermedia que los **desacopla**: cada sensor/dispositivo conecta, desconecta
y notifica su propio estado y sus propios datos de forma **independiente**, sin compartir
nada con los demás.

- **`radio/device_links.js`** — `DeviceLinkManager` + `DeviceLink`. API: `register({id, name,
  kind, isSupported, factory})`, `connect(id, opts)`, `disconnect(id)`, `disconnectAll()`,
  `status(id)`, `list()`, `sub(id,'data'|'status', cb)`. Cada `DeviceLink` guarda su propio
  `state` (down|connecting|up|error), `error`, `last` y `connectedAt`. Regla honesta: sin
  hardware el connect falla con `SIN_…` / `NO_MODULO` y SOLO ese enlace queda en `error`
  (los demás no se tocan). Cero dependencias; navegador (`window.DeviceLinkManager`) y Node.
- **Dispositivos registrados** en la app (`initDeviceLinks()`):
  `RADIO`(radio_driver) · `BLE`(ble_bridge vitales) · `ATMOSPHERE`(gases) · `FIELD`(campo
  UWB/IMU/IR por serial) · `THERMAL`(cámara IR sobre un transporte de líneas). Cada connect
  button delega en `deviceLinks.connect('ID')`; la GUI se suscribe por dispositivo y NO
  comparte estado. `window.deviceLinks` expuesto.
- **Aislamiento verificado**: `test/device_links.test.js` (7) + test de integración en
  `test/gui_buttons.test.js` (5 dispositivos registrados; conectar `RADIO` deja a
  `BLE`/`THERMAL`/`FIELD` `down`; sin hardware `RADIO` → `error` honesto aislado).
- **Es la base real**: cada adaptador ya envuelve el bridge físico correspondiente, así que
  enchufar el hardware (transceptor LoRa, wearable BLE, placa UWB/IMU, sensor IR) solo exige
  conectar el dispositivo real desde su propio enlace — sin tocar la lógica de los demás.

---

## 7. AutoLink — entrelazado automático en emergencia (híbrido LoRa+BLE)

**Motivo**: el enlace WebRTC de campo necesita copia-pega de SDP (bootstrap manual). En una
catástrofe no hay humano para hacerlo. `radio/auto_link.js` automatiza ese bootstrap con un
protocolo **baliza/scan** sobre transportes inyectables.

- **Transportes (híbrido, decisión de diseño)**: LoRa = descubrimiento + datos de bajo ancho
  de banda (vitales/GPS/UWB/alarmas, largo alcance); BLE = datos densos de corto alcance
  (imagen térmica). Sin transporte real disponible el módulo **no inventa señales** (honesto).
- **Adaptadores reales (`radio/auto_transports.js`)**: `makeLoRaTransport(driver)` envuelve el
  `LoRaRadioDriver` real (texto↔hex, disponible cuando la radio está conectada, `onReceive`
  decodifica cada `onFrame`); `makeBleTransport(link)` envuelve un enlace de par bidireccional
  `{connected,send,onReceive}` (sin él queda `available:false`, honesto — el `ble_bridge`
  actual es periférico/wearable, no un transporte de par). `createAutoTransports()` devuelve
  `{lora,ble}` listos para un `AutoLinkManager`.
- **Ciclo de vida de una hoja**: al entrar en `EMERGENCIA` la hoja pasa a
  `BALIZA` (emite `AUTOLINK|BALIZA|<id>|<caps>` periódico) → oye `ACK` → `EMPAREJANDO` (emite
  `CONFIRM`) → `ACTIVO` (transmite `DATA`). El coordinador hace `scan`: oye la baliza → responde
  `ACK`; con `CONFIRM` marca la hoja `ACTIVO`.
- **Política de batería (apagar hojas redundantes)**: con `setEssential(ids)` el coordinador
  declara la cadena esencial; las hojas fuera de ella reciben `SLEEP` y se apagan (dejan de
  balizar, ahorran batería); con `WAKE` se reactivan. Por defecto, sin cadena esencial, todo se
  apaga al primer contacto.
- **Reversión a baliza al perder el enlace**: si una hoja en `ACTIVO` no recibe novedades en
  `ackTimeout`, revierte a `BALIZA` automáticamente y vuelve a emitir para ser re-pareada.
- **Aislamiento/tests**: `test/auto_link.test.js` (6) con scheduler y transportes falsos
  deterministas — emparejado hoja↔coordinador, apagado de redundantes, revertsión por pérdida,
  SLEEP/WAKE, y honestidad sin hardware. `test/auto_transports.test.js` (4) valida los
  adaptadores reales con dos `LoRaRadioDriver` conectados por un "aire" compartido:
  la hoja y el coordinador se emparejan y transmiten por la radio física real. Suite:
  **297/297 PASS.**

---

## 8. Voz directa y radio de rescate AM/FM

**Realeza honesta de las radios del teléfono para voz:**
- **Wi-Fi Direct/Hotspot + WebRTC audio** = el único camino realista de voz teléfono-a-teléfono
  sin red celular. (El *sidelink* LTE/5G D2D depende de operadora/hardware; BLE es de bajo
  ancho de banda; un teléfono **no tiene transmisor AM/FM** — solo puede RECIBIR, y su
  sintonizador FM no es controlable desde un navegador.)

### 8a. `radio/voice_link.js` — Voz D2D (WebRTC audio)
Canal de audio en vivo sobre Wi-Fi (WebRTC), complementando a WebRtcFieldLink (datos) y a
AutoLink (descubrimiento). **Privacidad (requisito)**: el micrófono SOLO se activa bajo
demanda (push-to-talk) — en modo escucha los tracks están **detenidos** (no solo enmudecidos);
`talk(true)` adquiere el mic y `talk(false)` lo libera (`.stop()`).
- Honestidad: sin `RTCPeerConnection` → `WEBRTC_NO_DISPONIBLE`; sin `getUserMedia` → `SIN_MIC`;
  permiso denegado → `MIC_PERMISO_DENEGADO`. Señalización manual offer/answer igual que
  webrtc_link (el `ACk/CONFIRM` de `AutoLinkManager` puede firmar el Wi-Fi).
- Tests (`test/voice_radio.test.js`): escucha sin mic, PTT activa/libera el mic (más la pista
  se detiene), honestidad sin WebRTC/sin mic/sin permiso, señalización yield/accept.

### 8b. `radio/emergency_radio.js` — Recepción de rescate AM/FM
Si el usuario queda atrapado, sintoniza emisiones AM/FM (instrucciones de rescatistas).
Recepción SÓLO (el teléfono no transmite): vía adaptador SDR inyectable
`{available, tune(freq,{mode}), onAudio(cb), scan}` (RTL-SDR/HackRF por USB/serial).
Sin SDR → `SIN_SDR` honesto (no inventa audio ni señal). `tune(freq,mode)`,
`scanEmergency()` (canales de emergencia conocidos, reporta solo los de señal >0),
`play(on)`, `close()`.
- Diseño para hardware externo (Walk): el adaptador SDR es el enganche para RTL-SDR/HackRF o
  un Walkie-Talkie con salida de espectro; el módulo ya queda listo y honesto sin él.
- Tests: `SIN_SDR` honesto, afinado + detección de canal con señal, sin señal no reporta.
- Suite: **306/306 PASS**.
