╔══════════════════════════════════════════════════════════════════╗
║   PROJECT LIFELINE CORE — AMRF v2.2 INTEGRATED RF SYSTEM       ║
║   Integrated Simulation with LoRa + APRS + SDR                 ║
╚══════════════════════════════════════════════════════════════════╝

WHAT'S NEW IN v2.0:
═══════════════════

1. LORA MESH NETWORK (Panel 11)
   - Frequency: US915 (915 MHz ISM band)
   - Features: Mesh routing, multi-hop relay, adaptive spreading factor
   - Real-time waveform visualization
   - RSSI/SNR monitoring
   - Automatic node discovery and beaconing

2. APRS PROTOCOL (Panel 12)
   - Frequency: 144.390 MHz (VHF 2m Amateur)
   - Features: Position tracking, message relay, digipeater
   - Support for APRS objects and IS gateway
   - Real-time packet logging

3. SDR RECEIVER (Panel 13)
   - Frequency: 433 MHz ISM band (configurable)
   - Features: Signal detection, spectrum analysis
   - Waterfall display visualization
   - Multi-signal simultaneous decoding

4. FREQUENCY ALLOCATION (Panel 14)
   - Visual display of all active frequency bands
   - Status indicators for each band
   - ISM 915 (LoRa), VHF 2m (APRS), ISM 433 (SDR), HF 7MHz (planned)

FILES:
══════
- index_integrated.html — New HTML with RF panels
- app_integrated.js     — Updated JS with RF module integration
- server.js             — HTTP server with cross-device relay (SSE + POST)
- lifeline_engine.js    — Production engine (real RF stack) with reception
- relay_adapter.js      — Browser relay adapter (EventSource + fetch)
- styles.css            — Existing styles (unchanged)
- radio/                — RF module source code
  - lora_mesh.js       — LoRa mesh network implementation
  - aprs_protocol.js   — APRS packet radio protocol
  - sdr_receiver.js    — SDR receiver implementation
  - frequency_mgr.js   — Frequency allocation manager
  - packet_encoder.js  — RF packet encoder/decoder

HOW TO RUN:
═══════════
1. Navigate to the simulation directory:
   cd /storage/emulated/0/Documents/UNVolunteers/simulation/simulation

2. Start the HTTP server:
   node server.js

3. Open browser to:
   http://localhost:8000/index_integrated.html

4. Click "⚡ TRIGGER P-WAVE" to activate all RF systems

SIMULATION FLOW:
════════════════
1. DORMANT → All RF systems offline
2. TRIGGER P-WAVE → Cell Broadcast received
3. RF Systems Init:
   - LoRa mesh network initialized with 3 nodes
   - APRS tracker activated with position beacons
   - SDR receiver starts scanning for signals
4. Active Monitoring:
   - LoRa: Periodic beacons every 5s
   - APRS: Position updates every 30s
   - SDR: Continuous signal scanning
5. Emergency:
   - SOS button transmits on all frequencies
   - Multi-protocol redundant messaging

RF MODULES STATUS:
═════════════════
[✓] LoRa Mesh — Active (915 MHz)
[✓] APRS — Active (144.390 MHz)
[✓] SDR — Active (433 MHz scanning)
[ ] HF Backup — Planned (7.030 MHz)

For detailed RF architecture, see: radio/README_RF.txt

CHANGELOG v2.0.1 (2026-08-01)
═════════════════════════════
CORRECCIÓN CRÍTICA APLICADA Y VERIFICADA:
- app_integrated.js (línea ~1359): error de sintaxis corregido.
  Faltaba un paréntesis de cierre en el ancho de la barra RSSI LoRa:
  Math.min(100, (avgRssi + 100))  →  Math.min(100, (avgRssi + 100))
  El error "SyntaxError: missing ) after argument list" impedía que el
  script completo se cargara (todos los paneles RF muertos).
  Verificado con `node --check` (CHECK OK) y servido correctamente por
  server.js como text/javascript.

5. **`app.js`/`app_integrated.js` (BAJO):** paneles de telemetría
   (`updateVitalsPanel`/`updateEnvironPanel`) eran código muerto; ahora se invocan desde el muestreo
   de sensores y el arranque en ambos simuladores. Además se unificó el signo de la profundidad
   (mayor presión atrapada = mayor profundidad positiva) en v1.2 y v2.0.

CHANGELOG v2.0.2 (2026-08-02) — PRODUCCIÓN
═══════════════════════════════════════════
`app_integrated.js` reescrito como GUI de PRODUCCIÓN (cero datos de ejemplo):
- Eliminados: NODES ficticios (Caracas), fakeHexBlock(), malla/radios fake,
  RSSI/SNR con Math.random(), `ephemeralId randomHex(4)`, globals
  `initLoRaMesh`/`initAPRS`/`initSDR`.
- Motor real: `LifelineEngine.createEngine` (radio/*.js reales) +
  `LifelineSensors` (device_sensors.js) + `coreMath.classifyRole`.
- Telemetría remota SOLO por `engine.ingestRemoteTelemetry()`; sin nodos
  inventados (radar con "Malla sin nodos activos" hasta ingerir).
- Sensores opcionales: sin lectura real se muestra `—`; nunca se fabrica.
- Badge de rol automático (SCOUT / VÍCTIMA / UNKNOWN) con razón y
  confianza (`device-role-badge/reason/conf`, `sensor-sources`).
- Panel ⑤ con bytes reales del PacketEncoder: `nonce(8) || ciphertext || MIC(4)`
  (pares hex + `t:/s:/d:/seq:`); en reposo IDLE con `-- -- -- --`.
- Paneles RF con estadísticas reales del motor (TX = engine.sequence,
  RX = mesh.stats.successfulDeliveries, APRS TX = tracker.stats.packetsSent;
  sin contador → `—`).
- Parámetros por URL: `?key=` (AES-128 en 32 hex) y `?callsign=` (APRS;
  sin indicativo → APRS inactivo, no se usa N0CALL).
- Los controles de simulación (batería/bpm/spo2/presión, auto-drain) siguen
  siendo entradas de usuario; el proveedor de sensores las pisa cuando hay
  lectura real.

CHANGELOG v2.1 (2026-08-02) — RELAY CROSS-DEVICE POR NAVEGADOR
═══════════════════════════════════════════════════════════════
- server.js: relay HTTP sin dependencias. `GET /relay/stream` (SSE:
  text/event-stream, retry 2000, heartbeat 15 s) y `POST /relay/send`
  (envelope {v, instanceId, name, networkId, kind, frame}; máx 128 KB → 413,
  inválido → 400, método no permitido → 405). Protocolo v1
  (RELAY_PROTO_VERSION). Difunde cada envelope a todos los clientes SSE.
- relay_adapter.js (NUEVO): adaptador de navegador (window.LifelineRelayAdapter
  + module.exports). Engancha la malla como UdpBridge (propagatePacket /
  processBeacon / broadcastNodeJoin), abre el EventSource, reenvía las tramas
  por POST con instanceId/name/networkId, filtra auto-eco y otras redes, e
  inyecta los frames ajenos en la malla local. close() restaura los hooks.
- lifeline_engine.js: recepción REAL — localNode.onPacket → _handleIncoming:
  descifra payload.trama_hex (AES-128), ignora el propio id, upsert del nodo
  remoto (label = _relayName) y lo añade a la malla. injectRelayedFrame(frame,
  relayName) entrega el frame codificado a todos los nodos locales; el nodo
  remoto queda en `remoteNodes`. clearRemoteNodes() limpia remotos y malla.
- index_integrated.html: panel ⑯ TEST SIGNALS (estado del relay CONECTADO /
  SIN TRANSPORTE, contadores tx/rx, nodos visibles; botones TX = telemetría
  real, INYECTAR NODO REMOTO (TEST) = ingest local, LIMPIAR REMOTOS).
- app_integrated.js: `?label=` (nombre visible del dispositivo, ej. TELÉFONO),
  initRelay() entre initSensors() y updateUI(), updateRelayPanel(), y
  refresh inmediato al recibir un envelope ajeno.
- Suite: servidor 24, lifeline_engine 7, relay_adapter 2 (nuevo), GUI 18 —
  total 148/148 PASS.
- Prueba real cross-device: server una sola vez (PC o teléfono) y en cada
  dispositivo abrir index_integrated.html?label=NOMBRE; el TRIGGER P-WAVE de
  uno aparece como nodo remoto con lecturas reales en el otro (ver panel ⑯).

Para la guía de pruebas manuales completa (con casos TC-*), ver:
GUIA_PRUEBAS_MANUALES.md (raíz del proyecto).

CHANGELOG v2.2 (2026-08-02) — MALLA HTTP DESCENTRALIZADA POR UDP
═════════════════════════════════════════════════════════════════
Cada dispositivo corre su PROPIO server (sin nodo central); solo los
que están en estado de alerta participan:
- server.js: `GET/POST /api/state` (identidad instanceId/networkId/label/
  url + estado + active), `GET/POST /api/peers` (pares del mismo estado de
  alerta; POST = probe server→server con timeout, fallback manual),
  descrubrimiento UDP broadcast (dgram, puerto 42203, anuncio cada 2 s,
  TTL 8 s, protocolo v1, filtro por networkId/versión/auto-eco) y BYE al
  pasar a DORMANT. Helpers LAN: lanAddresses/subnetBroadcast/
  defaultBroadcastAddress/isActiveState. CORS en toda la API.
- relay_adapter.js v2.0: `setAlertState(state)` (reporta al server local;
  activo → polling de `/api/peers` cada 2 s, DORMANT → detiene y limpia),
  `addManualPeer(url)`, `_sendFrame` multi-destino (servidor local + todos
  los pares) → malla HTTP completa.
- app_integrated.js: initRelay reporta el estado al relay; TRIGGER P-WAVE →
  VIGILANCE (modo scout/baliza); RESET → DORMANT; updateRelayPanel renderiza
  la lista de pares (#relay-peers) y el estado (#relay-status);
  btn-test-addpeer → addManualPeer.
- index_integrated.html: panel ⑯ con lista de pares (SIN PARES en reposo),
  campo "Par manual" + botón AÑADIR PAR. Parámetros por URL: ?label=,
  ?networkId=, ?key=, ?callsign=, ?discovery=.
- Suite: servidor 28, lifeline_engine 11, relay_adapter 3, GUI 19,
  radio_driver 12, ble_bridge 5, pwa 7 — total 197/197 PASS.
- Refresco en tiempo real de nodos/balizas: todo dispositivo en modo baliza
  (VIGILANCE) que emita BEACON se materializa en la malla/radar con los datos
  reales del beacon (fuente, tipo, posición, batería, señal); sin telemetría
  aún, rol/vitales quedan null/'UNKNOWN' hasta que llegue. El motor poda
  balizas sin señal durante más de 30 s (`pruneStaleNodes`, TTL configurable
  por `nodeTtlMs`) y la GUI repinta la tabla scout (#radar-victim-list) cada
  segundo (tick de 1 s con updateUI), incluyendo la columna SEÑAL (antigüedad
  de la última señal). El nodo local sincroniza su batería real en cada tick,
  así los beacons salen con la lectura real.
- Indicadores reales (regla de producción): batería solo desde
  navigator.getBattery(), presión desde el barómetro real, bpm/spo2 desde un
  puente BLE del wearable — sin fuente real la GUI pinta «—» (null en la
  telemetría). Sliders bpm/spo2 eliminados del panel ②; los de batería/presión
  quedan como override manual de pruebas. btn-test-node ya no inyecta datos
  ficticios: transmite la trama real AES-CTR del dispositivo.
- Intercom cross-device real: el mensaje viaja incrustado en la trama
  (snapshot.msg → payload.msg) y el motor del par lo enruta a su log de
  intercom vía `engine.onIntercomMessage`.
- Etapa 0 — hardware físico: radio/radio_driver.js (radio LoRa SX1276/SX1262
  por Web Serial; protocolo RESET/CONFIG/TX + OK/ERROR/EVT READY/EVT RX; sin
  Web Serial → SIN RADIO, honesto) y radio/ble_bridge.js (wearable BLE GATT
  0x180D/0x1822 → applySensorData; sin Web Bluetooth → SIN BLE, honesto).
  Hook engine.afterLocalTx: cada trama local también sale por el transceptor
  vinculado. Botones del panel ⑯: VINCULAR RADIO LORA (WEB SERIAL) y
  VINCULAR WEARABLE (BLE), con estados SIN RADIO FÍSICA / SIN BLE.
- Cómo probar en red real: node server.js en CADA dispositivo; abrir
  index_integrated.html?label=PC y ?label=TELÉFONO; TRIGGER P-WAVE en ambos
  → aparecen como pares en el panel ⑯, cada nodo del otro materializa en su
  malla y el chat intercom se cruza por el relay. Si el broadcast UDP no llega:
  añadir el par manualmente por URL.

CHANGELOG v2.3 (2026-08-04) — CAPACIDADES NUEVAS DEL MOTOR
═════════════════════════════════════════════════════════
Sensores de atmósfera (CO/O₂), red DTN "mula de datos", rol dinámico
por densidad real, radio de wake-up y altimetría diferencial de piso.

1. SENSORES DE ATMÓSFERA CO / O₂ (`lifeline_engine.js`)
   - Salida (`buildTelemetryPacket`): el paquete de telemetría real
     (CBOR+LZ77+AES-CTR) ahora transporta `co_ppm` y `o2_pct` cuando el
     snapshot trae `atm.coPpm` / `atm.o2Pct` (si no hay lectura real → null,
     nunca se fabrica).
   - Entrada (`_handleIncoming`): al ingerir un paquete ajeno se leen
     `pl.co_ppm` / `pl.o2_pct` y se vuelcan en el nodo remoto
     (`coPpm` / `o2Pct`), conservando el valor previo si la trama no los trae.
   - Radar (`getNodes`): los descriptores de nodo expuestos incluyen
     `coPpm` y `o2Pct` para que la GUI repinte el estado atmosférico real.

2. DTN STORE-AND-FORWARD ("mula de datos") — `engine.dtn` (DtnStore)
   - El motor actúa como mula de datos: almacena cifradas las balizas de
     víctimas que llegan sin vía de salida y las expone para entregarlas al
     cruzar otro dispositivo o un Gateway.
   - `engine.syncDTN()` → devuelve el outbox de balizas pendientes
     (`dtn.pending()`).
   - `engine.mergeDTN(beacons)` → acepta el outbox de OTRO dispositivo
     (cruces de mulas) y lo mezcla; devuelve `{added, updated, duplicate}`.
   - Ingestión de balizas de víctimas: cada beacon recibido se incorpora al
     DTN de forma cifrada para su entrega posterior.
   - `engine.dtn.markSynced(...)` marca balizas como sincronizadas tras la
     entrega.
   - `config.dtn:false` deshabilita por completo el DTN (motor sin mula).

3. ROL DINÁMICO POR DENSIDAD REAL — `engine.rebalanceRoles()`
   - Reconfiguración autónoma de rol basada en los nodos REALES conocidos
     (nunca inventa densidad).
   - Cuenta `remoteScouts` (nodos SCOUT/RELAY remotos) y `victims`
     (VICTIM/BEACON) desde `remoteNodes`.
   - Regla honesta: si hay ≥ `relayMinScouts` (default 2) otros SCOUT en la
     zona Y al menos una víctima en el borde sin cobertura → sugiere pasar a
     REPETIDOR de largo alcance; si el sector está saturado o no hay víctimas
     → volver a SCOUT de barrido.
   - Devuelve `{current, suggested, switch, reason, remoteScouts, victims,
     localType}`.
   - `engine.setLocalRole(SCOUT|RELAY)` aplica el rol local y lo refleja en
     la malla real (`localNode.type` + `config.role`).

4. WAKE-UP RADIO — `engine.wakeRadio` (WakeRadioController)
   - Escucha pasiva ultra-baja que despierta los sensores de alcance SOLO
     ante una firma de proximidad real.
   - `enable()` se invoca al arrancar el motor → el controlador entra en
     IDLE (espera pasiva); nunca inventa una detección.
   - `signalProximity()` dispara la transición a estado ACTIVO ante una
     firma real detectada por el HCI/transporte externo (honesto: sin
     detección no despierta).
   - Config: `wakeIdleMs`, `wakeActiveMs`, `wakeDutyCycle`.

5. ALTIMETRÍA DIFERENCIAL (`core_math.js`)
   - `calcDeltaHRef(pTrappedPa, pRefPa)` → metros bajo una presión de
     referencia (positivo = por debajo de la referencia), con la fórmula
     barométrica (R·T / g·M)·ln(pTrapada/pRef). Devuelve `null` si las
     presiones son nulas o inválidas.
   - `estimateFloorLevel(deltaM, {floorHeightM})` → estima el nivel a partir
     de la altimetría diferencial (altura de piso por defecto 3 m):
       * `P0` — planta baja (nivel de referencia).
       * `-N` — sótanos bajo el nivel (positivo en profundidad).
       * `PN` — pisos superiores colapsados (sobre el nivel, negativo).
       * Devuelve `{floor, label, depthM, basement, aboveGround}` y `'—'`
         (desconocido) si la profundidad es nula o infinita. Guía la
         excavación (qué piso/sótano busca el equipo).

© 2026 Project Lifeline Core — UN Volunteers
