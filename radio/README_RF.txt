================================================================================
    PROJECT LIFELINE CORE — RADIO FREQUENCY COMMUNICATION MODULE
    UN Volunteers · Disaster Response · RF Communication v1.0
================================================================================

This module implements radio frequency communication for disaster scenarios
when normal infrastructure (cell towers, internet) is down.

================================================================================
                         ARCHITECTURE OVERVIEW
================================================================================

                    ┌─────────────────────────────────────────────┐
                    │           DISASTER ZONE LAYER               │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
                    │  │  Node A │  │  Node B │  │  Node C │    │
                    │  │ (BLE)   │←→│ (LoRa)  │←→│ (APRS)  │    │
                    │  └────┬────┘  └────┬────┘  └────┬────┘    │
                    │       │           │           │           │
                    └───────┼───────────┼───────────┼───────────┘
                            │           │           │
                    ┌───────▼───────────▼───────────▼───────────┐
                    │         GATEWAY / SCOUT LAYER              │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
                    │  │  LoRa   │  │  APRS   │  │  SDR    │    │
                    │  │ Gateway │  │  Igate  │  │ Receiver│    │
                    │  └────┬────┘  └────┬────┘  └────┬────┘    │
                    └───────┼───────────┼───────────┼───────────┘
                            │           │           │
                    ┌───────▼───────────▼───────────▼───────────┐
                    │         COMMAND CENTER LAYER               │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
                    │  │ Satellite│ │  HF     │  │ Internet │    │
                    │  │ (Starlink)│ │ Radio  │  │ Backup  │    │
                    │  └─────────┘  └─────────┘  └─────────┘    │
                    └─────────────────────────────────────────────┘

================================================================================
                         COMMUNICATION LAYERS
================================================================================

LAYER 1: BLE MESH (0-100m)
- Device-to-device communication
- Low power, short range
- For trapped victims nearby

LAYER 2: LORA MESH (100m-15km)
- Node-to-gateway communication
- Long range, low power
- For deep rubble penetration

LAYER 3: APRS/VHF (1-50km)
- GPS tracking and messaging
- Real-time position reporting
- For rescue team coordination

LAYER 4: HF RADIO (50-1000km)
- Long range command & control
- Satellite backup
- For regional coordination

================================================================================
                         FILES IN THIS MODULE
================================================================================

1. lora_mesh.js      - LoRa mesh network simulation
2. aprs_protocol.js  - APRS packet radio implementation
3. sdr_receiver.js   - Software Defined Radio concepts
4. frequency_mgr.js  - Frequency management and allocation
5. packet_encoder.js - RF packet encoding/decoding
6. radio_driver.js   - Physical LoRa radio driver (SX1276/SX1262) via Web Serial — Etapa 0
7. ble_bridge.js     - BLE wearable bridge (BPM/SpO2) via Web Bluetooth — Etapa 0

================================================================================
                         FREQUENCY BANDS USED
================================================================================

BAND           FREQUENCY        PURPOSE           RANGE
─────────────────────────────────────────────────────────────
ISM 433 MHz    433.05-434.79    LoRa Europe       2-15 km
ISM 868 MHz    868.0-868.6      LoRa Europe       2-15 km
ISM 915 MHz    902-928          LoRa Americas     2-15 km
VHF 2m         144.0-148.0      APRS/Amateur      1-50 km
VHF 70cm       420-450          Amateur           1-30 km
HF             3-30 MHz         Long range        50-1000 km
UHF            406-406.1        ELT/EPIRB         Satellite

================================================================================
                         LEGAL NOTES
================================================================================

- ISM bands (433/868/915 MHz): License-free for low power
- VHF/UHF Amateur: Requires amateur radio license
- HF: Requires license for transmit
- Emergency use: May have exceptions under disaster declarations
- ELT/EPIRB: Licensed for emergency only (406 MHz)

================================================================================
                         NEXT STEPS
================================================================================

1. Integrar el stack RF con los simuladores AMRF v1.2/v2.0 (pipeline
   sensor → PacketEncoder → AX.25 → LoRa mesh ya cubierto en test/integration.test.js).
2. GUI headless del simulador v2.0: HECHO — test/gui.test.js (15 pruebas) + arnés
   DOM sin dependencias (test/dom_harness.js). El arnés carga el stack RF real
   (radio/*.js) + device_sensors.js + lifeline_engine.js en modo navegador en el
   contexto vm (mismo orden que index_integrated.html). Timers no-op (los
   setInterval del simulador colgaban el runner) y h.read(expr) para el entorno
   léxico de los let/const. Cobertura: motor de producción listo (solo nodo
   local), DORMANT inicial, canvas+logs, TRIGGER P-WAVE→VIGILANCE + telemetría
   real (bytes del encoder, panel ⑤), rol UNKNOWN sin sensores (cero datos
   inventados), clasificador SCOUT/VÍCTIMA, SOS 3 taps+touch→IPU, controles,
   paneles, RESET, tabs v1.2.
3. Puente cross-device: HECHO — radio/udp_bridge.js (dgram, cero dependencias)
   reenvía DATA/BEACON/NODE_JOIN entre dos dispositivos por UDP (LAN), con relay
   multi-hop (test/udp_bridge.test.js, 10 pruebas) y re-flood de beacons para
   convergencia de rutas. Demo en radio/examples/device.js.
   Ver sección CROSS-DEVICE TESTING abajo.
4. Robustez/fuzzing adicional y seguridad del servidor HTTP: HECHO —
   resolveFilePath (traversal encodado %2e%2e/%5c/%00/escape malformado → 400/403),
   solo GET/HEAD (405), HEAD sin cuerpo, directorio→index, 414 por longitud,
   encabezados de seguridad (nosniff/X-Frame-Options/Cache-Control), fuzzing
   determinista de 300 travesías y alias seguro /rf/ → radio/ (test/server.test.js,
   21 pruebas).
5. Cifrado real: HECHO — radio/aes128.js (AES-128-CTR + MIC AES-CMAC, puro JS,
   cero dependencias, estilo LoRaWAN). Vectores oficiales: FIPS-197 B, NIST
   SP 800-38A CTR y RFC 4493 CMAC (test/aes128.test.js, 10 pruebas). Modo
   `encryption: 'AES-CTR'` con clave propia o por defecto (demo); overhead
   nonce(8)+MIC(4)=12. El XOR simulado sigue como modo 'XOR' para compatibilidad.
6. Mantener la suite `npm test` en verde ante cada cambio.

===============================================================================
                    ETAPA 0 — RADIO FÍSICA (Web Serial) Y BLE BIOMÉTRICO
===============================================================================

El navegador NO puede controlar el radio por SPI directo. radio_driver.js
habla con el transceptor (T-Beam, Heltec, RAK4631, STM32-WL, o cualquier
SX1276/SX1262) por su UART USB → Web Serial (navigator.serial). El firmware
del MCU debe responder el protocolo de líneas:

  COMANDOS (host → radio):
    RESET                 → reinicia el radio, emite EVT READY
    CONFIG {JSON}         → frecuencia/SF/BW/potencia, ej.
                           CONFIG {"freq":915000000,"sf":12,"bw":125000,"txPower":20}
    TX <hex>              → transmitir frame, espera OK o ERROR <code>
    RX ON | RX OFF        → armar/desarmar recepción continua

  EVENTOS (radio → host):
    OK                          → comando ejecutado
    ERROR <code>                → p.ej. ERROR TIMEOUT / ERROR NO_ACK / ERROR CRC
    EVT READY {"radio":"SX1262","freq":915000000}
    EVT RX <hex> <rssi> <snr>   → frame recibido con métricas reales

  Regla de producción (cero datos inventados):
    - sin navigator.serial → {ok:false, error:"WEB_SERIAL_NO_DISPONIBLE"}
    - sin puerto abierto   → {ok:false, error:"NO_CONECTADO"}
    - sin OK en 3 s        → {ok:false, error:"TX_SIN_CONFIRMACION"}
  El bus se abstrae en un transporte inyectable (SerialLineTransport en el
  navegador; FakeTransport en los tests Node). EVT RX dispara
  onFrame({hex, rssi, snr, timestamp, source:"radio"}).

ble_bridge.js lee un wearable real por Web Bluetooth (requiere gesto de
usuario). Servicios GATT estándar:
    Heart Rate       0x180D / char 0x2A37 → bpm (flags: bit0 = u16 LE)
    Pulse Oximeter   0x1822 / char 0x2A5F → SpO2 + PR
                      (flags: bit0 SpO2-u8, bit1 SpO2-u16, bit2 PR-u8, bit3 PR-u16)
  onReading({bpm?, spo2?}) con lecturas reales. Honesto:
    - sin navigator.bluetooth → "WEB_BLUETOOTH_NO_DISPONIBLE"
    - wearable sin servicios vitales → "BLE_SIN_SERVICIOS_VITALES"
  attach(device) permite inyectar un GATT fake en los tests.

Integración con el motor: engine.afterLocalTx(hex) — toda trama local
(telemetría, intercom, ping) sale también por el transceptor vinculado.
GUI (index_integrated.html panel ⑯): botones VINCULAR RADIO LORA (WEB SERIAL)
y VINCULAR WEARABLE (BLE); estados honestos SIN RADIO FÍSICA / SIN BLE.

Ejemplo de firmware mínimo de referencia en radio/examples/ (boceto para
ESP32 + SX1276: lee una línea, ejecuta el comando y responde por serial).

===============================================================================
                      CROSS-DEVICE TESTING (UDP bridge)
===============================================================================

El stack RF es 100% en memoria (un solo proceso Node). Para probar la malla
entre DOS dispositivos reales en la misma LAN, radio/udp_bridge.js conecta
cada proceso con el otro vía UDP (módulo nativo dgram):

  - Envío: al transmitir (sendPacket), cada beacon local (mesh.processBeacon)
    y cada alta de nodo (NODE_JOIN), el frame se serializa y se envía por UDP
    (unicast a los peers y/u broadcast 255.255.255.255).
  - Recepción: el datagrama se inyecta en la malla local vía processPacket /
    processBeacon / onNodeJoin, dejando correr dedup, límite de hops y relay.
  - Relay multi-hop: si un nodo RELAY local decide reenviar un paquete
    recibido (createRelayPacket), el frame de relay se reenvía a los peers
    (con dedup de packetId). Así un unicast A→C cruza la cadena vía el RELAY
    de B (hop 1, hop 2, ...). Los broadcasts NO se relayean (semántica del
    mesh: broadcast = inundación local; unicast = enrutado con relays).
  - Beacon flooding: los beacons remotos se re-inundan a los peers con dedup
    sintético (sourceId:timestamp), de modo que en una cadena A↔B↔C todos los
    dispositivos aprenden las rutas a todos los nodos (routingTable 6/6).
  - Filtros: auto-eco (instanceId) y networkId (mensajes de otras redes).
  - close() restaura la malla a su estado original.

Demo (Termux/Linux en cada dispositivo, misma red Wi-Fi):
    # Dispositivo A:
    node radio/examples/device.js A <IP-DE-B> 21000 21000
    # Dispositivo B:
    node radio/examples/device.js B <IP-DE-A> 21000 21000
    # Alternativa con broadcast (misma subred):
    node radio/examples/device.js A --broadcast
    node radio/examples/device.js B --broadcast

Resultado esperado: cada dispositivo registra NODE_JOIN del otro, recibe sus
DATA (con dedup y hop count) y aprende sus rutas por beacons; Ctrl+C imprime
las estadísticas UDP (tx/rx/bytes) y de malla (paquetes/entregas/rutas).

Cadena de 3 dispositivos (relay multi-hop). Cada peer se indica como "IP" o
"IP:puerto"; argumentos: NAME [peer...] [localPort] [defaultPeerPort]:
    # A:  node radio/examples/device.js A <IP-B> 21000 21000
    # B:  node radio/examples/device.js B <IP-A> <IP-C> 21000 21000
    # C:  node radio/examples/device.js C <IP-B> 21000 21000
El demo alterna broadcast/unicast al remoto más lejano conocido; en B se
observa "reenvía (relay hop 1/2)" y en el destino el paquete llega con hop > 0.

Puerto por defecto: 21000. Verificación en un solo dispositivo sin segundo
teléfono: procesos en loopback (127.0.0.1) con puertos locales distintos:
    # A:  node radio/examples/device.js A 127.0.0.1:21001 21000
    # B:  node radio/examples/device.js B 127.0.0.1:21000 127.0.0.1:21002 21001
    # C:  node radio/examples/device.js C 127.0.0.1:21001 21002

===============================================================================
                      TEST AUTOMATION (node:test)
===============================================================================

Ejecutar la batería completa:
    node --test "test/*.test.js"      (o `npm test`)

Scripts npm: test | test:radio | test:sim | test:server | test:integration
Resultado de referencia (2026-08-04): PASS=197 FAIL=0
  (packet 9, aprs 13, lora 13, freq 10, SDR 14, core_math 15, servidor 28
   con relay SSE/POST y descubrimiento UDP de pares, integración 6, AES 10,
   UDP 10, GUI 19, lifeline_engine 11, relay_adapter 3, gui_buttons 8,
   radio_driver 12, ble_bridge 5, browser_load 4, pwa 7).
Nota: en Node 26 la forma `node --test test/` falla (MODULE_NOT_FOUND "test");
usar el glob entre comillas. `npm test` requiere el PATH de Termux.
Registros: pnud_argentina_docs/05_Registros_Suite_NodeTest.md y
           06_Registros_Suite_NodeTest.log.

================================================================================
                          CHANGELOG v1.0.1 (2026-08-01)
================================================================================

CORRECCIONES APLICADAS Y VERIFICADAS:
- packet_encoder.js (calculateCRC16): CRC ahora enmascarado a 16 bits
  (return crc & 0xFFFF). Antes devolvía 32 bits y el roundtrip BINARY
  siempre fallaba con "CRC mismatch". JSON/CBOR/BINARY verificados OK.
- aprs_protocol.js (AX25Frame): el bit de extensión de dirección (0x01)
  vive en el SSID byte (último byte de cada dirección).
  * encode(): la fuente solo se marca como última cuando NO hay ruta de
    repetidores (this.repeaterPath.length === 0).
  * decode(): el loop ahora comprueba bytes[offset - 1] & 0x01 (SSID byte
    de la dirección previa) y solo avanza 7 bytes cuando hay más
    direcciones. Antes el campo de información se perdía (INFO_OUT: "").
  Verificado: roundtrip conserva infoField con y sin repetidores.
- lora_mesh.js:
  * LoRaNode.calculateCRC: máscara 0xFFFF para hex siempre de 4 dígitos.
  * LoRaMesh.findPath: ahora construye un grafo de adyacencia bidireccional
    desde la routingTable y ejecuta BFS. Antes devolvía null aun con la
    tabla poblada. Verificado: rutas de 1 y 2 saltos correctas.
- aprs_protocol.js (APRSPacket): prefijo de tipo de dato duplicado en los
  reportes. Las funciones create* ya incluían el carácter del dataType en
  `data` y createAPRSPacket lo anteponía de nuevo, generando campos de
  información inválidos (p.ej. "TT#001,98", ">>OPERATIVO", "::LU1AAA:...").
  Corregido en createPositionReportWithTimestamp, createStatusReport,
  createMessage, createTelemetryReport, createObject y createEmergencyBeacon.
  Verificado: "T#001,98", ">OPERATIVO", ":LU1AAA   :AYUDA",
  "!/35-23.78S[059-37.10WEMERGENCY - NEED RESCUE", etc.

CORRECCIONES DESCUBIERTAS POR LA SUITE node:test (80 pruebas, PASS=80):
- BUG-6 packet_encoder.js (decodeBinary): el CRC se verificaba DESPUÉS de
  parsear el payload JSON; un byte corrupto en el payload producía un
  SyntaxError de JSON en vez de "CRC mismatch". Corregido: CRC verificado
  antes de interpretar el payload. La detección de corrupción ahora es
  uniforme (position-byte 0..n → "CRC mismatch").
- BUG-7 sdr_receiver.js (fft): el chequeo `N & 1` solo rechazaba tamaños
  impares; pares no potencia de 2 (p.ej. 4800) pasaban y devolvían un
  espectro corrupto silenciosamente. Corregido a `N & (N - 1)`. (N=1 sigue
  siendo una potencia de 2 válida.)
- BUG-8 sdr_receiver.js (ifft): la implementación descartaba la parte
  imaginaria del espectro (spectrum.map(c => c.real)) y no reconstruía la
  señal. Reescrita con la fórmula directa para señales reales
  (DC + Σ 2·Re(X[n]·e^{j2πnk/N}) + bin de Nyquist). Verificado:
  ifft(fft(x)) ≈ x con error < 1e-6.
- BUG-9 packet_encoder.js (compress/decompress LZ77): los literales de
  byte ≥ 0x80 (frecuentes en paquetes BINARY, flags/CRC/longitud) eran
  ambiguos con los tokens de match (0x80..0xFF), corrompiendo la
  descompresión; el literal 0x00 también era ilegible. Corregido con un
  esquema de escape (prefijo 0x00 antes del literal alto), matchLen cap a
  127. Verificado: roundtrip BINARY+LZ77+XOR en fuzz de 500 rondas con
  payloads aleatorios de bytes 0..255.

NUEVO EN v2.1 — PUENTE CROSS-DEVICE (2026-08-01):
- radio/udp_bridge.js: UdpBridge engancha una LoRaMesh y reenvía por UDP
  (dgram, cero dependencias) los frames DATA (primera propagación), los
  beacons locales y los NODE_JOIN. El extremo receptor inyecta el frame en
  su malla local (dedup, límite de hops y relay intactos). Filtra auto-eco
  (instanceId) y otras redes (networkId). close() restaura la malla.
  Enfoque de hooks: propagatePacket (visited vacío), processBeacon
  (solo sourceId === node.id para evitar loops) y broadcastNodeJoin.
- radio/examples/device.js: demo por dispositivo (unicast mutuo o broadcast);
  envía DATA periódicas (alterna broadcast/unicast al remoto más lejano),
  loguea recepciones y stats al salir (Ctrl+C). Soporta varios peers como
  "IP" o "IP:puerto".
- test/udp_bridge.test.js: 10 pruebas en loopback (DATA cruzado, beacon→rutas,
  NODE_JOIN, filtro auto-eco/otra red, close restaura, 5 paquetes sin pérdida,
  relay multi-hop cadena A→B→C, relay 2 dispositivos sin bucle, límite de
  hops, re-flood de beacons → convergencia de rutas).
- Adecuación: puerto efímero (port: 0) respetado en el default de UdpBridge
  (antes `0 || 21000` caía en 21000 → EADDRINUSE en tests paralelos).

NUEVO EN v2.2 — RELAY MULTI-HOP CROSS-DEVICE (2026-08-01):
- UdpBridge reenvía ahora los relays: cuando un nodo RELAY local devuelve
  createRelayPacket tras recibir un frame remoto, el frame de relay se
  propaga a los peers (dedup de packetId). Verificado en cadena A↔B↔C:
  unicast A→C llega con hop 1 y relayId de B.
- Re-flood de beacons: los beacons remotos se re-inundan con dedup sintético
  (sourceId:timestamp) para que todos los dispositivos de la cadena aprendan
  las rutas a todos los nodos (routingTable 6/6 en demo de 3 procesos).
- El patch de processBeacon distingue beacon local vs eco del re-flood
  usando el dedup (evita re-emitir el eco de vuelta).
- Semántica respetada del mesh: broadcast NO relayea (inundación local);
  solo unicast se enruta por RELAY. La demo alterna ambos modos.

NUEVO EN v2.3 — CIFRADO REAL AES-128 (LoRaWAN-style, 2026-08-01):
- radio/aes128.js: AES-128 puro en JS (cero dependencias): bloque (FIPS-197),
  CTR (NIST SP 800-38A) y CMAC (RFC 4493). Validado contra los vectores
  oficiales antes de integrar. Exports CommonJS + window.AES128.
- packet_encoder.js: modo `encryption: 'AES-CTR'`. Cifra el payload con
  AES-128-CTR y le antepone un nonce aleatorio de 8 bytes (keystream único
  por mensaje); añade un MIC AES-CMAC de 4 bytes (clave derivada AES(key,
  0x02…0x02)) autenticando nonce||ciphertext. Salida = nonce(8)||ct||MIC(4).
  El decodificador verifica el MIC antes de interpretar nada (clave
  incorrecta o corrupción → "MIC mismatch").
- Clave: `config.key` (32 hex o 16 bytes); sin clave se usa la NIST de
  referencia (SOLO DEMO). Orden correcto comprimir→cifrar / MIC→descifrar→
  descomprimir. El modo 'XOR' heredado se mantiene para compatibilidad.
- test/aes128.test.js: 10 pruebas (vectores oficiales + integración con el
  encoder: overhead 12, roundtrip, clave errónea, corrupción byte a byte,
  nonce único, claves inválidas, clave por defecto). test/integration.test.js
  añade telemetría AES-CTR end-to-end sobre la malla.

NUEVO EN v2.4 — MOTOR LIFELINE + GUI DE PRODUCCIÓN (2026-08-02):
- simulation/simulation/lifeline_engine.js: motor de producción dual
  Node/navegador que integra el stack RF real. Crea PacketEncoder (CBOR+LZ77+
  AES-CTR), LoRaMesh, APRSTracker (callsign null → APRS inactivo, sin N0CALL),
  SDRReceiver y FrequencyManager. API: buildTelemetryPacket, sendLocalTelemetry
  (broadcast), sendPing (unicast relay), ingestRemoteTelemetry (la ÚNICA entrada
  de telemetría remota), getNodes, getStats, start/stop, lastTelemetryBytes,
  lastSnapshot, sequence, localNode.
- test/lifeline_engine.test.js: 6 pruebas (ready sin ejemplos, roundtrip real,
  propagación por la malla, ingest sin inventar, APRS inactivo sin callsign,
  key ausente→clave NIST demo).
- simulation/simulation/app_integrated.js reescrito a PRODUCCIÓN: cero datos de
  ejemplo (sin NODES ficticios, sin RSSI/SNR aleatorios, sin hex inventado);
  sensores opcionales (device_sensors.js) con '—' cuando no hay lectura; badge
  de rol automático (coreMath.classifyRole); panel ⑤ con bytes reales
  nonce(8)||cipher||MIC(4); paneles RF con estadísticas reales del motor.
  El arnés GUI (dom_harness.js) carga ahora el stack RF real en el contexto vm.
- Parámetros por URL del simulador: ?key= (AES-128 32 hex), ?callsign= (APRS)
  y ?label= (nombre visible del dispositivo, ej. TELÉFONO).

NUEVO EN v2.5 — RELAY CROSS-DEVICE POR NAVEGADOR (SSE + POST, 2026-08-02):
- simulation/simulation/server.js: relay HTTP sin dependencias. GET
  /relay/stream (SSE: text/event-stream, retry 2000, heartbeat 15 s) y
  POST /relay/send (envelope {v, instanceId, name, networkId, kind, frame},
  máx 128 KB → 413, inválido → 400, métodos no permitidos → 405). El server
  difunde cada envelope a todos los clientes SSE; protocolo v1 (RELAY_PROTO_VERSION).
- simulation/simulation/relay_adapter.js: adaptador de navegador (window.
  LifelineRelayAdapter + module.exports). Engancha la malla igual que UdpBridge
  (propagatePacket, processBeacon, broadcastNodeJoin), abre el EventSource,
  reenvía las tramas por POST con instanceId/name/networkId, filtra auto-eco
  (mismo instanceId) y otras redes, e inyecta los frames ajenos en la malla
  local (dedup/hops intactos). close() restaura los hooks.
- simulation/simulation/lifeline_engine.js: recepción REAL. localNode.onPacket →
  _handleIncoming: descifra payload.trama_hex (AES-128), ignora el propio id,
  hace upsert del nodo remoto (label = _relayName o existente) y lo añade a la
  malla. injectRelayedFrame(frame, relayName) entrega el frame codificado
  {preamble, header, payload, crc} a todos los nodos locales y devuelve el
  primer resultado; clearRemoteNodes() limpia remotos y malla.
- GUI v2.1 (index_integrated.html): panel ⑯ TEST SIGNALS con estado del relay
  (CONECTADO / SIN TRANSPORTE), contadores tx/rx, nodos visibles y botones TX
  (telemetría real), INYECTAR NODO REMOTO (TEST) y LIMPIAR REMOTOS.
- test/server.test.js: 24 pruebas (3 nuevas de relay: SSE + retry, POST 204 y
  difusión del envelope, dos clientes reciben el mismo frame, 400/405).
- test/lifeline_engine.test.js: 7 (1 nueva: injectRelayedFrame materializa el
  nodo remoto desde la trama real y clearRemoteNodes deja 1).
- test/relay_adapter.test.js: 2 (flujo TX→POST→SSE→RX con EventSource/fetch
  simulados en Node; filtro auto-eco/otra red; sin transportes no engancha).
- test/gui.test.js: 18 (3 nuevas del panel ⑯: presente con SIN TRANSPORTE
  honesto, inyectar/limpiar nodos, TX reenvía telemetría real del motor).

NUEVO EN v2.6 — MALLA HTTP DESCENTRALIZADA POR UDP (2026-08-02):
- simulation/simulation/server.js: cada dispositivo corre su PROPIO servidor
  (sin nodo central). Escucha en todas las interfaces (PORT=8000) y anuncia su
  URL canónica por UDP broadcast cuando un navegador le reporta estado de
  alerta:
  - GET/POST /api/state: identidad (instanceId, networkId, label) + estado
    {DORMANT|VIGILANCE|ECO|ORPHAN} + url LAN + active. POST valida el estado
    (string válido → 400) y dispara el anuncio/bye del nodo.
  - GET /api/peers: pares del mismo estado de alerta (prune por TTL).
  - POST /api/peers: probe server→server (GET /api/state del candidato con
    timeout 2 s); solo añade pares no-activos; body no-array → 200 lista vacía.
  - Descubrimiento: dgram UDP con reuseAddr, setBroadcast(true), subred
    privada por defecto (fallback 255.255.255.255), puerto 42203
    (DISCOVERY_DEFAULT_PORT), anuncio cada 2 s (DISCOVERY_INTERVAL_MS),
    TTL de par 8 s (PEER_TTL_MS), protocolo v1 (DISCOVERY_PROTO_VERSION),
    filtro por networkId/versión/auto-eco (instanceId). BYE al pasar a
    DORMANT (stopAdvertising con callback) → evicción inmediata del par.
  - Helpers LAN: lanAddresses(), subnetBroadcast(), defaultBroadcastAddress()
    e isActiveState() (activo = no DORMANT/ORPHAN). CORS en toda la API.
- simulation/simulation/relay_adapter.js v2.0:
  - setAlertState(state): reporta al servidor local (POST /api/state con
    label). En activo → _refreshPeers() (GET /api/peers, dedup por url,
    onPeersChange) + polling cada PEER_POLL_MS=2000. En DORMANT detiene el
    polling y _clearPeers() (no participa).
  - addManualPeer(url) (POST /api/peers + refresh) — fallback si el broadcast
    no llega.
  - _sendFrame envía el envelope a [relayUrl] + todos los pares (malla HTTP
    completa; el par lo difunde por SSE e inyecta en su malla). Chequeo
    null/undefined (acepta relayUrl:'').
  - getStats() incluye alertState y peers; close() detiene polling/limpieza.
- simulation/simulation/app_integrated.js: initRelay() reporta el estado del
  sistema al relay (setAlertState); TRIGGER P-WAVE → VIGILANCE (modo
  scout/baliza); RESET → DORMANT; updateRelayPanel() renderiza la lista de
  pares en #relay-peers y el estado (#relay-status/#relay-status-ind); botón
  btn-test-addpeer → addManualPeer(test-peer-url).
- GUI v2.2 (index_integrated.html): panel ⑯ TEST SIGNALS con lista de pares
  (SIN PARES en reposo), campo "Par manual" + botón AÑADIR PAR; footer v2.2.
  Parámetros por URL: ?label=, ?networkId=, ?key=, ?callsign=, ?discovery=.
- test/server.test.js: 28 (4 nuevas: GET/POST /api/state identidad+estado,
  helpers LAN y isActiveState, descubrimiento UDP loopback con BYE,
  POST /api/peers manual con probe).
- test/relay_adapter.test.js: 3 (1 nueva: setAlertState → polling de pares,
  TX multi-destino servidor local + par, frame del par materializa el nodo
  remoto real por SSE, DORMANT limpia pares).
- test/gui.test.js: 19 (1 nueva: alertState DORMANT→VIGILANCE→DORMANT y panel
  con SIN PARES).
- Suite: 154/154 PASS (28+3+19+10+14+13+13+12+10+9+7+6).

NUEVO EN v2.7 — ETAPA 0: RADIO FÍSICA + BLE BIOMÉTRICO (2026-08-04):
- radio/radio_driver.js: LoRaRadioDriver + SerialLineTransport vía Web Serial.
  Protocolo de líneas: RESET / CONFIG {JSON} / TX <hex> / RX ON|OFF; eventos
  OK / ERROR <code> / EVT READY {radio,freq} / EVT RX <hex> <rssi> <snr>.
  Transporte inyectable (FakeTransport en Node). Honesto: sin Web Serial →
  WEB_SERIAL_NO_DISPONIBLE; sin conexión → NO_CONECTADO; timeout → TX_SIN_CONFIRMACION.
  toHex/fromHex para tramas binarias.
- radio/ble_bridge.js: LifelineBleBridge vía Web Bluetooth. GATT Heart Rate
  0x180D/0x2A37 y Pulse Oximeter 0x1822/0x2A5F; parseHeartRate (flags u8/u16)
  y parsePulseOximeter (SpO2 y PR u8/u16). Honesto: sin Web Bluetooth →
  WEB_BLUETOOTH_NO_DISPONIBLE; wearable sin servicios → BLE_SIN_SERVICIOS_VITALES.
  attach(device) inyecta GATT fake en tests.
- simulation/simulation/lifeline_engine.js: hook engine.afterLocalTx(hex) en
  sendLocalTelemetry/sendPing → cada trama local sale por el transceptor
  vinculado (try/catch, opcional; TX sin hook no rompe).
- GUI (index_integrated.html panel ⑯): botones VINCULAR RADIO LORA (WEB SERIAL)
  y VINCULAR WEARABLE (BLE) + badges radio-status/ble-status; estados honestos
  SIN RADIO FÍSICA: <error> / SIN BLE: <error>. onFrame del radio entra al
  motor por engine._handleIncoming (descifrado real); onReading del wearable
  alimenta applySensorData({bpm, spo2}).
- test/radio_driver.test.js: 12 pruebas (sin Web Serial honesto, NO_CONECTADO,
  RESET+READY, timeout, TX OK/ERROR, CONFIG JSON, EVT RX, toHex/fromHex,
  Uint8Array→hex, parsing de líneas serial).
- test/ble_bridge.test.js: 5 pruebas (parseadores GATT, sin Web Bluetooth,
  attach wearable real con lecturas, sin servicios vitales, DataView/Web Bluetooth).
- test/lifeline_engine.test.js: 11 (afterLocalTx recibe la misma trama).
- test/gui_buttons.test.js: 8 (BIND RADIO/BLE honestos sin hardware).
- Suite: 197/197 PASS.

ESTADO DE LOS MÓDULOS (2026-08-01):
- frequency_mgr.js  — OK (asignación/release/stats verificados)
- packet_encoder.js — OK (JSON/CBOR/BINARY × NONE/LZ77 × NONE/XOR/AES-CTR roundtrip)
- aprs_protocol.js  — OK (beacons, AX.25 roundtrip y prefijos APRS verificados)
- lora_mesh.js      — OK (beacons, envío, routing, findPath y escala 60 nodos)
- sdr_receiver.js   — OK (DSP; fft solo potencia de 2; ifft reconstruye)
- radio_driver.js   — OK (protocolo Web Serial; sin Web Serial → honesto)
- ble_bridge.js     — OK (GATT 0x180D/0x1822; sin Web Bluetooth → honesto)

NOTAS DE INTEGRACIÓN:
- Los callsigns AX.25 se limitan a 6 caracteres (norma); los tests usan
  "LU1PNU" (7+ se truncan silenciosamente en encode).
- findPath construye aristas BIDIRECCIONALES a partir de nextHop; una
  topología en anillo crea atajos de BFS (esperado).
- En processPacket, el paquete relayado devuelto por decodeFrame expone
  relayId/relayName en payload.* (no a nivel raíz).
- LZ77 ahora es seguro para bytes binarios arbitrarios (0..255).

===============================================================================
            ETAPA 0.5 — SENSORES DE PROXIMIDAD Y PERSISTENCIA
            Atmosphere · Thermal · DTN Store · Wake-up Radio
===============================================================================

Cuatro módulos nuevos en radio/ amplían la detección de víctimas más allá de la
radiofrecuencia y la telemetría pura: gases de atmósfera, cámara térmica,
almacenamiento en reposo (Data Mule) y una radio de despertar de ultra-bajo
consumo. Todos siguen la regla de producción del proyecto: cero datos
inventados — sin hardware/lectura real la salida es null/honesta.

===============================================================================
                         1. radio/atmosphere_bridge.js
===============================================================================

Puente de atmósfera (LifelineAtmosphereBridge) que lee sensores de gas del
Scout vía Web Bluetooth (GATT estándar Environmental Sensing 0x181A) y evalúa
el riesgo de la zona de colapso. Cero dependencias; navegador
(window.LifelineAtmosphereBridge) y Node (module.exports).

SERVICIOS GATT:
  BANDERA            GATT        UNIDAD      NOTA
  ─────────────────────────────────────────────────────────────
  Carbon Monoxide    0x2BD0      ppm         u16 LE
  Oxygen             0x2BD5      %           u16 LE (raw/100)

API:
  parseCO(bytes)              → {coPpm} (u16 LE) o null si < 2 bytes
  parseO2(bytes)              → {o2Pct: raw/100} (u16 LE) o null
  evaluateAtmosphere(coPpm, o2Pct)
      → {level, audible, co, o2, reasons}
  LifelineAtmosphereBridge    → connect() / attach(device) / close()
      onReading({coPpm?, o2Pct?}); onStatus({connected, services})

UMBRALES DE RIESGO (exposición ocupacional / deficiencia de O2):
  CO:   <35 ppm SAFE · 35-199 WATCH · 200-1199 HAZARD · ≥1200 SEVERE
  O2:   ≥19.5% SAFE · 16-19.4 WATCH · 10-15.9 HAZARD · <10 SEVERE
  El peor de ambos define el nivel. `audible` (alerta sonora inmediata)
  solo en HAZARD/SEVERE; lecturas null → SAFE sin aviso.

Regla de producción: sin Web Bluetooth → WEB_BLUETOOTH_NO_DISPONIBLE; sin
servicio ambiental → SIN_SERVICIO_AMBIENTAL; lectura null → nunca se inventa
una concentración. attach(device) inyecta un GATT fake en los tests.

===============================================================================
                             2. radio/thermal_cam.js
===============================================================================

Cámara térmica de baja resolución (ThermalCam) para mini-sensores IR (chips
MLX90640: rejilla 32×24) vía Web Serial / transportes inyectables. Detecta
firmas térmicas corporales (36-37 °C) a través de pequeñas aberturas,
complementando la RF cuando el teléfono de la víctima está sin batería.

API:
  parseThermalGrid(input)
      Acepta {width,height,raw} (int16 LE °C) o {width,height,temps}
      (Float32Array ya decodificado). → {width, height, temps} o null.
  detectHumanSignatures(temps, opts)
      Píxeles en rango corporal (por defecto 36-37 °C). Hot-spots ordenados
      por temperatura desc. → {count, humanPixels, hotspots, minTemp, maxTemp}
  ThermalCam                      → attach(transport) / close()
      onFrame({width, height, temps, humans}); onStatus({connected})

PROTOCOLO DE LÍNEAS (el transporte debe exponer onLine(cb)):
  THERMAL <hex de int16 LE °C, 32×24>   → dispara onFrame con mapa real

Regla de producción: sin transporte vinculado → SIN_TRANSPORTE y rejilla
null (la GUI queda vacía). Nunca se inventa un mapa térmico.

===============================================================================
                             3. radio/dtn_store.js
===============================================================================

Almacén local de balizas de víctimas (DtnStore) para las "mulas de datos"
(Data Mules): cifrado en reposo con AES-128-CTR + MIC (AES-CMAC, reutiliza
radio/aes128.js), encolado pendiente (outbox) y sincronización silenciosa y
automática entre Scouts y hacia el Gateway. Cero dependencias.

API:
  ingest(beacon)   → acumula baliza. Dedup por nodeId conservando la de
                     timestamp más reciente.
                     → {stored, action:'added'|'updated'|'duplicate', nodeId, pending}
  pending()        → balizas aún no sincronizadas (outbox), ordenadas por
                     timestamp asc.
  markSynced(nodeId) → marca como sincronizada (la saca del outbox). → bool
  merge(beacons)   → mezcla balizas de otro dispositivo (cruces de mulas).
                     → {added, updated, duplicate}
  counts()         → {stored, pending, synced, bytes, encrypted}
  clear()          → vacía el almacén (p.ej. nueva misión)

OPTS: {key: clave AES-128 32 hex (cifra en reposo), io: {get,set,remove}
  (memoria por defecto; pasar wrappers para localStorage), seed: PRNG de
  nonce determinista para tests}.

Formato en reposo = nonce(8) || ciphertext(CTR) || MIC(4). Sin clave el
almacén funciona en modo ofuscación simple (solo testeo).

Regla de producción: SOLO almacena balizas que realmente llegaron (nunca
inventa); sin vía de salida quedan en pending() hasta un cruce con otro
dispositivo.

===============================================================================
                         4. radio/wake_radio.js
===============================================================================

Controlador de radio de despertar (WakeRadioController): escucha ultra-baja de
consumo (BLE HCI SoC) que despierta los sensores de alcance (UWB/radar,
térmica, gas) SOLO al detectar una firma de proximidad, evitando mantener los
radares de alta precisión siempre activos (ahorro de batería del Scout).

ESTADOS Y TRANSICIONES:
  OFF   → enable() → IDLE        (escucha pasiva de ultra-bajo consumo)
  IDLE  → signalProximity() → ACTIVE   (despierta los sensores de alcance)
  ACTIVE→ tick() (venció activeMs) → IDLE  (vuelve a escucha pasiva)
  IDLE/ACTIVE → disable() → OFF  (desactiva por completo)

API:
  enable()          → OFF → IDLE (inicia la escucha pasiva)
  signalProximity() → IDLE → ACTIVE durante activeMs (llamado por el callback
                      del HCI/transporte real; sin efecto si OFF o ya ACTIVE)
  tick(now)         → avanza el reloj; ACTIVE vencido → IDLE (onIdle)
  disable()         → IDLE/ACTIVE → OFF
  getState()        → {state, enabled, listening, activations, activeMs,
                       idleMs, dutyCycle}

OPTS: idleMs (1000 ms), activeMs (8000 ms), dutyCycle (0.05), onActivate,
  onIdle, clock (inyectable para tests; por defecto Date.now).

Regla de producción: el controlador NUNCA inventa una detección — solo reacciona
a signalProximity() (llamado por el callback del HCI/transporte real). Estado
inicial OFF; enable() → IDLE.

===============================================================================
                  ESTADO DE LOS MÓDULOS NUEVOS (ETAPA 0.5)
===============================================================================

- atmosphere_bridge.js — OK (GATT 0x181A; parseadores u16 LE; umbrales honestos)
- thermal_cam.js       — OK (rejilla 32×24; detección de firmas 36-37 °C)
- dtn_store.js         — OK (AES-128 en reposo; outbox; merge entre mulas)
- wake_radio.js        — OK (estados OFF/IDLE/ACTIVE; duty cycle; sin inventar)

==============================================================================
