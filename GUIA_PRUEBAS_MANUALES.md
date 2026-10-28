# GUÍA DE PRUEBAS MANUALES — PROJECT LIFELINE CORE

**Simulador AMRF v1.2 (base) + v2.0 (integrado RF) · Stack RF (Node.js)**
Fecha: 2026-08-01 · Entorno de referencia: Node.js v26.4.0, Linux/Termux, navegador Chrome/Chromium

---

## 0. ESTADO DEL PROYECTO — BUGS CONOCIDOS Y CORRECCIONES APLICADAS

> **✅ ESTADO 2026-08-04:** los 5 bugs + 2 notas manuales fueron **corregidos y verificados**,
> y la **suite automatizada `node --test` (test/) está en 197/197 PASS** (packet 9, aprs 13, lora 13,
> freq 10, SDR 14, core_math 15 —incl. `classifyRole` y null-safety de vitales/batería—, servidor endurecido 28 —incl. alias `/rf/`,
> relay SSE/POST y **descubrimiento de pares por UDP broadcast** con `/api/state` y `/api/peers`—,
> integración 6, AES-128 LoRaWAN-style 10, puente UDP cross-device 10 con relay multi-hop,
> motor `lifeline_engine` 11 con recepción real, **materialización de nodos por BEACON real**,
> **poda por TTL de balizas sin señal**, **intercom cross-device (msg incrustado en la trama real)**
> y **hook `afterLocalTx` a la radio física (Etapa 0)**,
> adaptador `relay_adapter` 3 con pares del mismo
> estado, GUI headless 19, carga de página completa en orden navegador 4 —BUG-10: `core_math.js`
> filtraba constantes al scope global y mataba `app_integrated.js` en el navegador real, ya
> corregido con IIFE y cubierto por `bootFullPage`—, verificación de TODOS los botones de la GUI 8
> —cada botón dispara su acción visible: TRIGGER/RESET, SOS (tap), toque, TX de prueba, inyección y
> limpieza de nodos, par manual, ping-all, intercom, **BIND RADIO (Web Serial)** y **BIND WEARABLE
> (BLE)** —ambos reportan honestamente sin hardware: `SIN RADIO`/`SIN BLE`—, y el **refresco en
> tiempo real** de la lista de dispositivos (tick de 1 s repinta la tabla scout) + **baliza real
> materializando su nodo en el panel**—, **radio_driver 12** (protocolo SX1276 por Web Serial,
> transporte abstracto, sin Web Serial → honesto) y **ble_bridge 5** (GATT 0x180D/0x1822, sin Web
> Bluetooth → honesto), **pwa 7** (manifest JSON válido, iconos PNG 192/512 reales con dimensiones
> correctas, app shell del service worker coherente con disco, API nunca cacheada, enlaces en el
> HTML y registro guardado, MIME manifest+json/js servidos bien)); descubrió 4 bugs adicionales
> (BUG-6…BUG-9), ya corregidos en código
> fuente y reflejados en esta tabla.
> Además, **`app_integrated.js` fue reescrito a producción**: cero datos de ejemplo (sin `NODES`
> ficticios, sin RSSI/SNR aleatorios, sin hex inventado); usa el motor real (`LifelineEngine` +
> `device_sensors.js`) y el clasificador automático de rol (`coreMath.classifyRole`, SCOUT/VÍCTIMA)
> en el badge de rol. La telemetría remota SOLO entra por `ingestRemoteTelemetry()` o por una trama
> real descifrada (malla o relay cross-device). El arnés de la GUI ahora carga el stack RF real en
> el contexto `vm`, por lo que los tests ejercitan el motor. La GUI v2.2 añade la **malla HTTP
> descentralizada**: cada dispositivo corre su PROPIO servidor y solo los que están en **estado de
> alerta (VIGILANCE = modo scout/baliza)** se descubren por UDP broadcast (panel ⑯ `TEST SIGNALS`),
> se conectan y se reenvían tramas; los DORMANT son invisibles. Fallback: par manual por URL.
> El simulador v2.0 ya carga (BUG-1 corregido), BINARY hace roundtrip (BUG-2), el AX.25 conserva
> el infoField (BUG-3), `findPath` resuelve rutas (BUG-4), los reportes APRS tienen el prefijo de
> tipo correcto (BUG-5), el CRC se verifica antes de parsear (BUG-6), la FFT exige potencia de 2
> (BUG-7), la IFFT reconstruye la señal (BUG-8) y el LZ77 es seguro para bytes binarios (BUG-9).
> Los paneles de telemetría de **ambos simuladores** están vivos con profundidad de signo
> consistente (NOTA-2 y NOTA-3); la física del simulador ahora vive en `core_math.js` (NOTA-4).
> La tabla siguiente muestra causa/efecto/corrección a efectos de regresión.

| ID | Severidad | Archivo | Causa | Efecto (antes) | Corrección aplicada | Estado |
|----|-----------|---------|-------|----------------|---------------------|--------|
| BUG-1 | **CRÍTICO** | `simulation/simulation/app_integrated.js:1359` | Falta un `)` de cierre en `Math.min(100, (avgRssi + 100))` | `SyntaxError: missing ) after argument list` → **todo el JS v2.0 no parseaba** | Cerrar paréntesis: `` `${Math.max(0, Math.min(100, (avgRssi + 100)))}%` `` | ✅ **CORREGIDO** (node --check OK) |
| BUG-2 | ALTO | `radio/packet_encoder.js:365` (`calculateCRC16`) | CRC no enmascarado a 16 bits; devolvía 32 bits (`0x45ca5c8a`) | Roundtrip **BINARY** siempre fallaba: `CRC mismatch` | `return crc & 0xFFFF;` | ✅ **CORREGIDO** (JSON/CBOR/BINARY OK) |
| BUG-3 | ALTO | `radio/aprs_protocol.js:85` y `:137` | Bit de extensión de dirección (0x01) mal manejado: `encode()` marcaba la fuente como última; `decode()` leía el primer byte y avanzaba 7 incondicionalmente | Roundtrip AX.25 perdía el `infoField` (`INFO_OUT: ""`) | `encode`: `isLast = repeaterPath.length === 0`; `decode`: comprobar `bytes[offset-1] & 0x01` y avanzar solo con más direcciones | ✅ **CORREGIDO** (info preservado con/sin repetidores) |
| BUG-4 | MEDIO | `radio/lora_mesh.js` (`findPath`) | Falta de grafo real: BFS sobre `route.nextHop === current` | `findPath(...) → null` aun con `routingTable` poblada | Adyacencia bidireccional desde `routingTable` + BFS | ✅ **CORREGIDO** (rutas 1-2 saltos OK) |
| BUG-5 | ALTO | `radio/aprs_protocol.js` (`APRSPacket`) | Prefijo de tipo de dato duplicado: `data` ya incluía el carácter del `dataType` y `createAPRSPacket` lo anteponía de nuevo | Campos de información inválidos: `TT#001,98`, `>>OPERATIVO`, `::LU1AAA:...`, `;;VICTIM_A*...`, `!!/ 35-...` | `data` sin el carácter de tipo en `createPositionReportWithTimestamp`, `createStatusReport`, `createMessage`, `createTelemetryReport`, `createObject`, `createEmergencyBeacon` | ✅ **CORREGIDO** (`T#001,98`, `>OPERATIVO`, `:LU1AAA   :AYUDA`, `!/35-23.78S[059-37.10WEMERGENCY...`) |
| NOTA-1 | BAJO | `radio/sdr_receiver.js` (`DSP.fft`) | Requiere tamaños potencia de 2 | `DSP.fft` con 4800/4095 lanza `FFT size must be power of 2` | Restricción documentada; usar 4096 a 48 kHz | ✅ Documentado (comportamiento intencional) |
| NOTA-2 | BAJO | `simulation/simulation/app.js` y `app_integrated.js` | `updateVitalsPanel()`/`updateEnvironPanel()` nunca se invocaban (código muerto) | Textos del panel "Node Telemetry" estáticos (`RECORDING`/`—`) | Invocadas desde el muestreo de sensores (1 s) y el arranque, en ambos simuladores | ✅ **CORREGIDO** |
| NOTA-3 | BAJO | `simulation/simulation/app.js` y `app_integrated.js` | Signo de profundidad invertido + `Math.abs` inconsistente | Presión >1013.25 hPa → profundidad **negativa**; nodos simulados vs primario inconsistentes | `depthM = altDelta` (positivo = bajo tierra); canvas con `Math.max(0, ...)`; signo unificado en radar — en ambos simuladores | ✅ **CORREGIDO** |
| BUG-6 | MEDIO | `radio/packet_encoder.js` (`decodeBinary`) | El CRC se verificaba **después** de `JSON.parse(payload)` | Byte corrupto en payload → `SyntaxError` de JSON en vez de `CRC mismatch` | CRC verificado antes de interpretar el payload | ✅ **CORREGIDO** (corrupción en cualquier posición → `CRC mismatch`) |
| BUG-7 | ALTO | `radio/sdr_receiver.js` (`DSP.fft`) | Chequeo `N & 1` solo rechazaba impares | Pares no potencia de 2 (ej. 4800) → espectro corrupto silencioso | Chequeo `N & (N - 1)` (N=1 sigue válido) | ✅ **CORREGIDO** (4800/4095 lanzan; 4096 OK) |
| BUG-8 | ALTO | `radio/sdr_receiver.js` (`DSP.ifft`) | Descarta la parte imaginaria (`spectrum.map(c => c.real)`) | `ifft(fft(x))` no reconstruía la señal | Fórmula directa para señales reales (DC + 2·Re + Nyquist) | ✅ **CORREGIDO** (error < 1e-6) |
| BUG-9 | ALTO | `radio/packet_encoder.js` (`compress`/`decompress`) | Literales ≥ 0x80 ambiguos con tokens de match LZ77; `0x00` ilegible | Roundtrip **BINARY+LZ77** corrupto (decompress < headerSize) | Escape con prefijo `0x00` para literales ≥ 0x80 y `0x00`; `matchLen` cap 127 | ✅ **CORREGIDO** (fuzz 500 rondas OK) |
| NOTA-4 | BAJO | `simulation/simulation/core_math.js` (nuevo) | `module.exports` sin guarda rompía el script en navegador (`module` no existe) | Simulador v1.2/v2.0 rompía al cargar `core_math.js` en el navegador | Guarda doble: `module.exports` (Node) + `window.coreMath` (navegador) | ✅ **CORREGIDO** (verificado vía `vm` en Node) |

---

## 1. PRERREQUISITOS Y PUESTA EN MARCHA

**Requisitos:**
- Node.js ≥ 18 (probado con v26.4.0)
- Navegador moderno (Chrome, Chromium, Firefox)
- (Opcional, Android) Termux con Node.js para las pruebas de sensores

**Arranque del servidor:**
```sh
cd /storage/emulated/0/Documents/UNVolunteers/simulation/simulation
node server.js
```
Debe mostrar: `Server is running at http://localhost:8000`

**Comprobación rápida:** abrir http://localhost:8000/ en el navegador.

**Dos simuladores disponibles:**
- `http://localhost:8000/` → **v1.2 base** (10 paneles)
- `http://localhost:8000/index_integrated.html` → **v2.0 integrado RF** (14 paneles) — **operativo** (BUG-1 corregido)

---

## 2. TC-SRV — SERVIDOR HTTP (server.js)

| ID | Prueba | Comando | Esperado |
|----|--------|---------|----------|
| TC-SRV-01 | Raíz | `curl -i http://localhost:8000/` | `HTTP/1.1 200 OK`, `Content-Type: text/html`, sirve `index.html` |
| TC-SRV-02 | index.html | `curl -s -o /dev/null -w "%{http_code} %{content_type}" http://localhost:8000/index.html` | `200 text/html` |
| TC-SRV-03 | index_integrated.html | `curl -s -o /dev/null -w "%{http_code} %{content_type}" http://localhost:8000/index_integrated.html` | `200 text/html` |
| TC-SRV-04 | app.js | `curl -s -o /dev/null -w "%{http_code} %{content_type}" http://localhost:8000/app.js` | `200 text/javascript` |
| TC-SRV-05 | app_integrated.js | `curl -s -o /dev/null -w "%{http_code} %{content_type}" http://localhost:8000/app_integrated.js` | `200 text/javascript` |
| TC-SRV-06 | styles.css | `curl -s -o /dev/null -w "%{http_code} %{content_type}" http://localhost:8000/styles.css` | `200 text/css` |
| TC-SRV-07 | Inexistente | `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/no_existe.js` | `404` |
| TC-SRV-08 | Path traversal | `curl --path-as-is -s -o /dev/null -w "%{http_code}" "http://localhost:8000/../../etc/passwd"` | `403` (bloqueado) |

*Verificado el 2026-08-01: TODOS los casos anteriores pasan (200/404/403 según esperado). Nota:
`curl` normaliza la URL por defecto (envía `/etc/passwd` → 404); usar `--path-as-is` para enviar el
traversal real y verificar el `403`.*

---

## 3. TC-BASE — SIMULADOR v1.2 (`index.html`)

Abrir `http://localhost:8000/` y pulsar F12 (Consola) para ver errores de JS. La consola debe estar **limpia** (sin errores).

### 3.1 Estado inicial (DORMANT)
| ID | Comprobación | Esperado |
|----|--------------|----------|
| TC-BASE-01 | Badge de estado | `DORMANT` (gris) |
| TC-BASE-02 | `stat-phy` | `DORMANT` |
| TC-BASE-03 | `stat-nodes` | `2` (3 nodos − relay oculto) |
| TC-BASE-04 | `stat-battery` / `stat-ppm` | `100%` / `0` |
| TC-BASE-05 | Temporizador vigilancia | `--:--` |
| TC-BASE-06 | Canvas | Rejilla + escombro + scout moviéndose; **sin nodos de víctima** (ocultos en DORMANT), sin cono de escaneo |
| TC-BASE-07 | Log | `[AMRF v1.2] Simulation environment loaded` |
| TC-BASE-08 | Botones | `TRIGGER P-WAVE` activo; `PING ALL`, `Intercom`, `SOS TAP` bloqueados |

### 3.2 Disparo del desastre (P-Wave)
| ID | Comprobación | Esperado |
|----|--------------|----------|
| TC-BASE-09 | Pulsar `⚡ TRIGGER P-WAVE` | Badge → `VIGILANCE`; `stat-phy` → `CODED_PHY (LR)`; `stat-nodes` sigue `2` |
| TC-BASE-10 | Log (orden) | `[Baseband] ⚡ Cell Broadcast GEOFENCED_CRITICAL_ALERT intercepted.` → `[Kernel] Doze Mode bypassed. High-Vigilance subsystem awake.` → `[Barometer] P_start locked at 1013.25 hPa as ground reference.` → `[WearOS] Bridge connecting to biometric sensor stream…` |
| TC-BASE-11 | Temporizador | Arranca en `30:00` y descuenta 1 s cada segundo |
| TC-BASE-12 | Canvas | Aparecen nodos de víctima (primario + VICTIM B), cono de escaneo desde el scout, paquetes (partículas) periódicos |
| TC-BASE-13 | Botones | `PING ALL` y `Intercom` habilitados; tap SOS operativo |

### 3.3 Triage y signos vitales
| ID | Acción | Esperado |
|----|--------|----------|
| TC-BASE-14 | bpm=72, spo2=98, wearable puesto | Triage `GREEN` (STABLE), nodo primario verde `#10b981` |
| TC-BASE-15 | bpm=130 (>120) | Triage `RED` (IMMEDIATE) `#ef4444` |
| TC-BASE-16 | spo2=85 (<90) | Triage `RED` |
| TC-BASE-17 | bpm=105 (>100) | Triage `YELLOW` (DELAYED) `#f59e0b` |
| TC-BASE-18 | spo2=92 (<95) | Triage `YELLOW` |
| TC-BASE-19 | Desmarcar "watch on body" | Log `[WearOS] PPG on-body: ✗ DETACHED`; triage → `YELLOW` (UNKNOWN VITALS) |
| TC-BASE-20 | Pulsar `⚡ SOS TAP` | Triage → crítico/rojo; alerta SOS en log |

> **IPU (nota):** con el wearable puesto, IPU mínimo = `0.25·0 + 0.25·0.1 + 0.50 = 0.525`; sin wearable `0.620`. Umbral de ORPHAN = `0.40` → **el estado ORPHAN es inalcanzable** en v1.2 con los controles actuales (documentar como observación, no como fallo de la prueba).

### 3.4 Presión / profundidad (signo corregido en NOTA-3)
| ID | Acción | Esperado |
|----|--------|----------|
| TC-BASE-21 | Slider presión en `1013.25 hPa` (default) | Profundidad `0.00 m` |
| TC-BASE-22 | Subir a `1020.00 hPa` | Profundidad ≈ **`+58.3 m`** (positiva = bajo tierra); nodo primario **desciende** en canvas |
| TC-BASE-23 | Bajar a `950.00 hPa` | Profundidad ≈ **`-565.9 m`** (sobre la referencia, "en superficie"); nodo primario se mantiene en la superficie del canvas (0.30) |

> Los valores de la tabla de radar (VICTIM A en vivo y nodos simulados) usan ahora el mismo signo
> (positivo = bajo tierra); p. ej. VICTIM B (1024.00 hPa) muestra ≈ `+92.7 m`.

### 3.5 Batería (auto-drenaje)
| ID | Acción | Esperado |
|----|--------|----------|
| TC-BASE-24 | Activar "Auto-drain battery" (en VIGILANCE) | Log `[PowerMgr] Auto-drain enabled. Battery depleting at 1%/3s...`; batería −1% cada 3 s |
| TC-BASE-25 | Cruzar ≤ 30% | `stat-phy` → `CODED_PHY (ECO)`, intervalo de transmisión 3000 ms |
| TC-BASE-26 | Cruzar ≤ 15% | Modo `ULTRA SURVIVAL` (BLE legacy, 5000 ms, TX baja) |
| TC-BASE-27 | Slider de batería a 100% | Vuelve a `VIGILANCE` |

### 3.6 Relay, PING ALL y Reset
| ID | Acción | Esperado |
|----|--------|----------|
| TC-BASE-28 | Activar relay | `stat-nodes` → `3`; log `[Relay] Intercepted payload from deep node <id>. Multi-hop proxy active.`; nodo relay aparece en canvas con enlace punteado |
| TC-BASE-29 | Desactivar relay | `stat-nodes` → `2`; log `[Relay] Deep node <id> offline. Cache cleared.` |
| TC-BASE-30 | `PING ALL` (en VIGILANCE) | Logs de pings acústicos a los nodos; efecto "shake" en nodos |
| TC-BASE-31 | `RESET` | Vuelve a DORMANT completo: badge, `stat-nodes` 2, `--:--`, batería 100%, slider preseleccionado; log `[System] Reset complete. Returning to DORMANT state.` |

> **Corregido (NOTA-2, 2026-08-01):** los textos del panel Node Telemetry (vitals-status, vitals-bpm-trend,
> env-temp, env-light, env-mic, env-tilt, tipo de colapso, bolsa de aire y ETA de batería) ahora se
> actualizan en vivo cada segundo junto con las sparklines. En DORMANT muestran `OFFLINE` / `—`.

---

## 4. TC-RF — SIMULADOR v2.0 (`index_integrated.html`) — **OPERATIVO**

> **Estado:** BUG-1 corregido (2026-08-01). El script ya parsea (`node --check` OK) y se sirve como
> `text/javascript`. Verificar en consola del navegador que **no** aparecen errores de sintaxis al cargar
> `index_integrated.html`.

Verificar (diseño de los paneles 11-14):
| ID | Panel | Comprobación esperada |
|----|-------|-----------------------|
| TC-RF-01 | 11 · Frequency Allocation | Tabla poblada: SCOUT-1 → `144.390 MHz` (APRS), banda LoRa ISM `915 MHz`, SDR `433 MHz`; contador de asignaciones > 0 |
| TC-RF-02 | 12 · LoRa Mesh 915 | Nodos registrados, intercambio de beacons, tabla de rutas crece, distancia calculada (par de prueba: ≈ `1.44 km`) |
| TC-RF-03 | 13 · APRS 144.390 | Consola APRS con tráfico TX/RX, reports `!34.6037S/58.3816W[` con símbolo `[` |
| TC-RF-04 | 14 · SDR 433 | Espectro animado (ruido + portadoras), controles lowpass/highpass/bandpass operativos, FFT 4096 bins |
| TC-RF-05 | Barra de estado | Estado del sistema reflejado en los 14 paneles |

> **Cambio de producción (2026-08-02):** `app_integrated.js` ya **no** puebla los paneles RF con nodos
> ficticios (SCOUT-1, VICTIM B, coordenadas Caracas). Ahora:
> - Los nodos visibles son el **nodo local** (`DISPOSITIVO-LOCAL`) y los que entren por
>   `ingestRemoteTelemetry()` (operativo/puente cross-device). Sin ingreso → radar con "Malla sin nodos activos".
> - Los contadores son reales del motor: LoRa TX = `engine.sequence`, RX = `mesh.stats.successfulDeliveries`,
>   APRS TX = `tracker.stats.packetsSent`; donde el stack no tiene contador se muestra `—`.
> - El **badge de rol** (`device-role-badge`) clasifica el dispositivo con `coreMath.classifyRole`
>   (SCOUT/VÍCTIMA/UNKNOWN) según presión (profundidad), inclinación, luz, vitales y SOS; sin sensores
>   → `UNKNOWN` (`INSUFFICIENT_SENSORS`), nunca inventa.
> - El **panel ⑤** muestra bytes reales del `PacketEncoder`: `nonce(8) || ciphertext || MIC(4)` en pares
>   hex con `t:/s:/d:/seq:`; en reposo `IDLE` con `-- -- -- --`.
> - Parámetros por URL: `?key=` (clave AES-128 en 32 hex) y `?callsign=` (indicativo APRS; sin él, APRS
>   inactivo y **no** se usa `N0CALL`).

> Reutilizar también TC-BASE-09 a TC-BASE-31 sobre el v2.0 (debe heredar el comportamiento v1.2).

---

## 5. TC-RADIO — MÓDULOS RF POR CLI (Node)

Ejecutar desde cualquier directorio. Los módulos cargan si se imprime `[X] Module loaded`.

### TC-RADIO-01 · Carga de los 5 módulos
```sh
node -e "
['frequency_mgr','packet_encoder','aprs_protocol','lora_mesh','sdr_receiver']
  .forEach(m => { require('/storage/emulated/0/Documents/UNVolunteers/radio/'+m+'.js'); console.log('LOADED:', m); });
"
```
**Esperado:** `LOADED:` x5 (sin excepciones). **Verificado: PASS.**

### TC-RADIO-02 · FrequencyManager (asignación/release/estadísticas)
```sh
node -e "
const { FrequencyManager } = require('/storage/emulated/0/Documents/UNVolunteers/radio/frequency_mgr.js');
const fm = new FrequencyManager();
const alloc = fm.requestFrequency({ requesterId: 'SCOUT-1', type: 'TRACKING' });
console.log('ALLOC:', (alloc.frequency / 1e6).toFixed(3), 'MHz | ID:', alloc.id);
console.log('STATS:', JSON.stringify(fm.getStats()));
console.log('RELEASE:', fm.releaseFrequency(alloc.id));
"
```
**Esperado:** `ALLOC: 144.390 MHz` (tipo `TRACKING`), `STATS: {"totalAllocations":1,"activeChannels":1,...}`,
`RELEASE: true`. **Verificado: PASS.** *(La API toma un objeto `{ requesterId, type, ... }` y devuelve la frecuencia en Hz.)*

### TC-RADIO-03 · PacketEncoder roundtrip (JSON/CBOR/BINARY OK tras BUG-2)
```sh
node -e "
const { PacketEncoder, PacketBuilder } = require('/storage/emulated/0/Documents/UNVolunteers/radio/packet_encoder.js');
const p = new PacketBuilder().setType(2).setSource('A1B2')
  .setPayload({ gps: '10.4806,-66.9036', bpm: 78 }).build();
for (const enc of ['JSON', 'CBOR', 'BINARY']) {
  const pe = new PacketEncoder({ encoding: enc });
  try { const d = pe.decode(pe.encode(p)); console.log(enc + ':', d.payload.bpm === 78 ? 'OK' : 'MISMATCH'); }
  catch (e) { console.log(enc + ': FAIL ->', e.message); }
}
"
```
**Esperado:** `JSON: OK`, `CBOR: OK`, `BINARY: OK`. **Verificado: PASS (tras corrección BUG-2).**

### TC-RADIO-04 · APRS Beacon (texto y frame AX.25)
```sh
node -e "
const { APRSBeacon } = require('/storage/emulated/0/Documents/UNVolunteers/radio/aprs_protocol.js');
const b = new APRSBeacon({ frequency: '144.390', toCall: 'CQ', fromCall: 'UNV1' });
console.log('TEXT:', b.toString());
console.log('AX25:', b.toAX25Frame().toString());
"
```
**Esperado:** texto APRS válido y representación del frame. **Verificado: PASS.**

### TC-RADIO-05 · AX.25 roundtrip (infoField preservado tras BUG-3)
```sh
node -e "
const { AX25Frame } = require('/storage/emulated/0/Documents/UNVolunteers/radio/aprs_protocol.js');
const f = new AX25Frame({ destinationCallsign: 'PNUD-1', destinationSSID: 0,
  sourceCallsign: 'UNV-1', sourceSSID: 0, infoField: ':HELLO' });
const buf = f.encode();
const d = AX25Frame.decode(buf);
console.log('INFO_IN :', JSON.stringify(f.infoField));
console.log('INFO_OUT:', JSON.stringify(d.infoField));
console.log('DEST/SRC:', d.destinationCallsign + '/' + d.sourceCallsign);
"
```
**Esperado (tras corrección BUG-3):** `INFO_IN : ":HELLO"`, `INFO_OUT: ":HELLO"`, y la ruta de
repetidores decodificada (`["WIDE1-1","WIDE2-1"]`). Con `repeaterPath: []` el `INFO_OUT` también se
conserva y la ruta es `[]`. **Verificado: PASS.**

### TC-RADIO-06 · LoRa Mesh (beacons OK; `findPath` corregido en BUG-4)
```sh
node -e "
const { LoRaMesh, LoRaNode } = require('/storage/emulated/0/Documents/UNVolunteers/radio/lora_mesh.js');
const mesh = new LoRaMesh({});
const n1 = new LoRaNode('SCOUT-1', 'GATEWAY', -34.6037, -58.3816);
const n2 = new LoRaNode('VICTIM-1', 'SENSOR', -34.6040, -58.3820);
const n3 = new LoRaNode('VICTIM-2', 'SENSOR', -34.6070, -58.3850);
mesh.addNode(n1); mesh.addNode(n2); mesh.addNode(n3);
mesh.processBeacon(n1, n2.createBeacon());
mesh.processBeacon(n2, n3.createBeacon());
console.log('ROUTING TABLE SIZE:', mesh.routingTable.size);
console.log('FIND_PATH 1-HOP :', JSON.stringify(mesh.findPath(n1.id, n2.id)));
console.log('FIND_PATH 2-HOP :', JSON.stringify(mesh.findPath(n1.id, n3.id)));
console.log('SEND:', mesh.sendPacket(n1.id, n2.id, { text: 'HELP' }));
console.log('STATS:', JSON.stringify(mesh.getStats()));
"
```
**Esperado (tras corrección BUG-4):** `ROUTING TABLE SIZE: 3`, `FIND_PATH 1-HOP` con 2 IDs,
`FIND_PATH 2-HOP` con 3 IDs (2 saltos), `SEND: true`, `STATS` con `totalPackets`/`successfulDeliveries` > 0.
**Verificado: PASS.**

### TC-RADIO-07 · SDR / DSP (FFT potencia de 2)
```sh
node -e "
const { SDRReceiver, DSP } = require('/storage/emulated/0/Documents/UNVolunteers/radio/sdr_receiver.js');
const sdr = new SDRReceiver({ sampleRate: 48000 });
const samples = Array.from({ length: 4096 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 48000));
console.log('SPEC_BINS:', DSP.powerSpectrum(samples).length);
console.log('SNR:', DSP.calculateSNR(samples, 0.01).toFixed(2), 'dB');
console.log('SDR_GET_SPECTRUM:', sdr.getSpectrum().length);
try { DSP.powerSpectrum(new Array(4800).fill(0)); console.log('FFT-4800: OK'); }
catch (e) { console.log('FFT-4800: FAIL ->', e.message); }
"
```
**Esperado:** `SPEC_BINS: 4096`, `SNR: ≈ 16.99 dB` (con `noiseFloor=0.01`), `SDR_GET_SPECTRUM: 8192`
(tamaño del buffer del receptor), `FFT-4800: FAIL -> FFT size must be power of 2`.
**Verificado: PASS (NOTA-1).** *(Las funciones DSP son estáticas: `DSP.powerSpectrum`, `DSP.calculateSNR(signal, noiseFloor)`.)*

---

## 6. TC-SENSOR — RECOLECCIÓN DE SENSORES (Termux)

```sh
cd /storage/emulated/0/Documents/UNVolunteers/pnud_argentina_docs
node recolectar_sensores.js
```
**Esperado:**
- Sin Termux:API autorizado: `termux-location`/`termux-sensor` fallan y el script usa **fallback simulado** con coordenadas de Buenos Aires `(-34.603722, -58.381592)`.
- Genera/actualiza `02_Flujo_Datos_Sensores.json` con `dispositivo`, `os`, `modulo_rf_activo: "LORA_US915"` y trama APRS `!34.6037S/58.3816W[PNUD TEST - REDMI NOTE 8`.
- Con Termux:API instalado y permisos: usa GPS real y sensores (Accelerometer, Light).

**Verificado:** el archivo `02_Flujo_Datos_Sensores.json` existe y fue generado por una ejecución previa con fallback simulado.

---

## 6B. TC-CROSS — PRUEBAS EN 2 DISPOSITIVOS (UDP bridge)

El stack RF es en memoria (un solo proceso Node). Para verificar el funcionamiento **entre dos dispositivos** en la misma red Wi-Fi, usar el **puente UDP** (`radio/udp_bridge.js`, cero dependencias) + la demo `radio/examples/device.js`.

**Cómo funciona:** al transmitir (DATA, beacons, NODE_JOIN), el frame se reenvía por UDP (unicast mutuo o broadcast); el otro dispositivo lo inyecta en su `LoRaMesh` local, que aplica dedup, límite de hops y relay normales. Filtra auto-eco y otras redes.

**Paso 1 — obtener IP (Termux):** `ip route | grep -E "default|wlan"` o `ifconfig`.
**Paso 2 — Dispositivo A:**
```sh
node radio/examples/device.js A <IP-DE-B> 21000 21000
```
**Paso 3 — Dispositivo B:**
```sh
node radio/examples/device.js B <IP-DE-A> 21000 21000
```
Alternativa con broadcast (misma subred, misma puerto): `node radio/examples/device.js A --broadcast` y `node radio/examples/device.js B --broadcast`.

| ID | Prueba | Esperado |
|----|--------|----------|
| TC-CROSS-01 | Arranque en ambos | Cada uno loguea `UDP escuchando en 0.0.0.0:21000` y `Malla local lista` |
| TC-CROSS-02 | NODE_JOIN cruzado | Cada dispositivo loguea `← NODE_JOIN <nombre>` del otro |
| TC-CROSS-03 | DATA cruzado | Cada uno recibe `← RECIBIDO DATA de <otro>-SCOUT -> BROADCAST` con telemetría (bpm/spo2/battery) |
| TC-CROSS-04 | Beacons → rutas | Al enviar DATA, el hop count es 0 y la entrega es inmediata; las estadísticas UDP muestran tx/rx > 0 |
| TC-CROSS-05 | Ctrl+C | Imprime `ESTADÍSTICAS UDP: tx=… rx=…` y `ESTADÍSTICAS MESH: paquetes=… entregas=… rutas=…` |
| TC-CROSS-06 | Verificación en 1 dispositivo | Dos procesos en loopback (`127.0.0.1`), B en puerto local 21001: `node radio/examples/device.js A 127.0.0.1 21000 21000` y `node radio/examples/device.js B 127.0.0.1 21001 21000` — ambos se reciben |
| TC-CROSS-07 | Relay multi-hop (3 dispositivos en cadena A↔B↔C) | Unicast de A a un nodo de C: en B se ve `reenvía (relay hop 1/2)` y en C llega con `hop 1` y `relayId` de B; los beacons se re-inundan y todos aprenden las rutas (routingTable 6/6) |

> Si el broadcast no llega (muchas redes Wi-Fi lo bloquean), usar **unicast mutuo** (los comandos de arriba ya lo hacen). Requisito previo: misma red/subred y puerto UDP 21000 abierto en ambos.

---

## 7. PLANTILLA DE REGISTRO DE RESULTADOS

| ID | Descripción | Resultado esperado | Resultado real | Estado |
|----|-------------|--------------------|----------------|--------|
| TC-SRV-01 | GET / | 200 text/html | | ☐ PASS / FAIL / BLOCKED |
| ... | ... | ... | ... | ... |

**Convención de estado:**
- `PASS` — coincide con lo esperado.
- `FAIL` — no coincide; registrar el detalle.
- `BLOCKED` — no se puede ejecutar por un bloqueo externo (p. ej. sin permisos de sensores en Termux).

---

## ANEXO · RESUMEN DE COMPORTAMIENTO VERIFICADO (2026-08-01)

- Servidor HTTP: raíz/HTML/JS/CSS → 200; inexistente → 404; traversal → 403 (verificado con socket crudo). PASS.
- **Servidor v2.2 (malla descentralizada):** `GET/POST /api/state` (identidad + estado), `GET/POST /api/peers` (pares del mismo estado de alerta), **descubrimiento UDP broadcast** (dos servers en VIGILANCE en loopback se encuentran con su URL LAN; BYE evicta al par al pasar a DORMANT), CORS para fetch cross-origin, `lanAddresses`/`subnetBroadcast`/`isActiveState`. PASS.
- FrequencyManager: 144.390 asignado a SCOUT-1; release y stats OK. PASS.
- PacketEncoder: JSON/CBOR/BINARY × NONE/LZ77 × NONE/XOR roundtrip OK (tras BUG-2 y BUG-9). PASS.
- APRSBeacon: generación OK. AX25Frame roundtrip: conserva infoField y repetidores (tras BUG-3). PASS.
- LoRaMesh: beacons, routingTable, sendPacket (entregas > 0) OK; findPath 1 y 2 saltos OK (tras BUG-4); escala 60 nodos en cadena OK. PASS.
- SDR/DSP: FFT 4096 bins, SNR ~17 dB; FFT solo potencia de 2 (tras BUG-7); `ifft(fft(x)) ≈ x` (tras BUG-8). PASS.
- `node --check` OK en `app.js`, `server.js` y **`app_integrated.js`** (tras BUG-1). PASS.
- Simulador v1.2: paneles de telemetría activos (tras NOTA-2); profundidad con signo consistente (tras NOTA-3).
- `core_math.js`: carga en Node (CommonJS) y en navegador simulado (`vm`, `window.coreMath`) — tras NOTA-4. PASS.
- **Suite automatizada `node --test "test/*.test.js"` (197 pruebas): PASS=197 FAIL=0.** Scripts: `npm test` (suite completa, requiere `PATH=/data/data/com.termux/files/usr/bin:$PATH`), `npm run test:radio`, `npm run test:sim`, `npm run test:server`, `npm run test:integration`. En Node 26 la forma `node --test test/` falla (MODULE_NOT_FOUND "test") → usar glob entre comillas.

## ANEXO · SUITE AUTOMATIZADA (node:test)

Ejecutar: `node --test "test/*.test.js"` (o `npm test`).

| Suite | Archivo | Cubre |
|-------|---------|-------|
| packet_encoder | `test/packet_encoder.test.js` | roundtrip 12 combos, tamaño, CRC16, corrupción posición a posición, truncados, fuzzing 200 rondas, stats, tipos, límite PHY |
| APRS | `test/aprs.test.js` | AX.25 roundtrip (0/2/3 repetidores), prefijos únicos, posición BA, telemetría, tracker, fuzzing 500 frames |
| LoRa | `test/lora.test.js` | alta/baja, activación, beacon+CRC, dedup, límite hops, processPacket/relay, findPath, broadcast, fuera de alcance, Haversine, escala 60 nodos, stats, SF/bandas |
| Frecuencias | `test/frequency.test.js` | asignación/release/reuso, colisiones, override, expiración, regiones, prioridades, scanner |
| SDR/DSP | `test/sdr.test.js` | ondas, FFT potencias 2, ifft(fft), powerSpectrum, SNR, filtros, demod FM/AM, SDRReceiver, scanner, Complex |
| core_math | `test/core_math.test.js` | constantes físicas, calcDeltaH (BA), calcIPU, triage (todas las ramas), resolveState, pureza sin DOM |
| Servidor | `test/server.test.js` | MIME, 404, 403 traversal (socket crudo), %2e%2e, doble instancia, octet-stream, **relay cross-device**: SSE `200 + retry: 2000`, POST `/relay/send` 204 y difusión del envelope a todos los clientes, dos clientes SSE reciben el mismo frame, envelope inválido→400, versión inválida→400, `GET /relay/send`→405, **estado/descubrimiento**: `GET/POST /api/state` (identidad `instanceId`/`networkId`/`label`/`url`, DORMANT inicial `active:false`, `{state:42}`→400), helpers LAN (`subnetBroadcast` 192.168.0.11/24→.255, 10.x/16, 172.16/24; `isActiveState` VIGILANCE/ECO true, DORMANT/ORPHAN/null false), **descubrimiento UDP loopback** (DORMANT invisible, dos servers en VIGILANCE se descubren mutuos con su url LAN, BYE tras DORMANT evicta al par), `POST /api/peers` manual (probe server→server con timeout, par DORMANT descartado, activo añadido, `{peers:'no-array'}`→200 lista vacía) |
| Integración | `test/integration.test.js` | sensor→PacketEncoder→AX.25→decode; APRS→AX.25→LoRa mesh→receptor; telemetría cifrada; consistencia JSON/BINARY; física barométrica |
| **UDP bridge** | `test/udp_bridge.test.js` | **Malla cross-device** en loopback: DATA broadcast cruzado, beacon remoto→tabla de rutas, NODE_JOIN, filtro auto-eco/otra red, close restaura la malla, 5 paquetes sin pérdida, relay multi-hop en cadena A→B→C (hop 1 + relayId), relay sin bucle en 2 dispositivos, límite de hops, re-flood de beacons→convergencia de rutas |
| **Motor Lifeline** | `test/lifeline_engine.test.js` | `createEngine` con stack RF real (`ready`, sin ejemplos), `buildTelemetryPacket`→bytes que decodifican, `sendLocalTelemetry`→propagación por la malla real, `ingestRemoteTelemetry` (nodos reales, sin inventar), sin callsign APRS inactivo (no `N0CALL`), key ausente→clave NIST demo, **recepción real**: `injectRelayedFrame` materializa el nodo remoto desde la trama cifrada que entrega la malla (`payload.trama_hex` → `_handleIncoming` → nodo con label del emisor) y `clearRemoteNodes` deja solo el local |
| **Relay adapter** | `test/relay_adapter.test.js` | Adaptador browser: disponible con EventSource+fetch, conecta (hookea `propagatePacket`/`processBeacon`/`onNodeJoin` + EventSource), TX de B reenviado por `POST /relay/send` con `instanceId`/`name`/`networkId`, RX de A materializa el nodo de B (label, role, lecturas) sin `ingest()`, filtro auto-eco (instanceId) y de otra red, sin transportes→`available:false` y `connect()` falla sin enganchar la malla; **estado/peers v2.2**: `setAlertState` (POST `/api/state` con label; VIGILANCE arranca polling de `/api/peers`, DORMANT lo detiene y limpia `peers`), par descubierto→TX real del motor a servidor local **y al par** (malla HTTP), frame del par por SSE→`injectRelayedFrame`→nodo remoto real (HEX con `localNode.encodePacket`; frame crudo NO materializa), `addManualPeer`/`getPeers` |
| **GUI headless** | `test/gui.test.js` | **Simuladores AMRF v1.2/v2.0 en `vm` con DOM simulado** (`test/dom_harness.js`, cero dependencias): el arnés carga el **stack RF real + `lifeline_engine` + `device_sensors` + `relay_adapter`** (mismo orden que `index_integrated.html`); v2.0: motor listo (solo nodo local), DORMANT inicial (badge/IPU/físicas con bpm/spo2/battery/presión en `null` y val-* en `—`), arranque (canvas + logs), TRIGGER P-WAVE→VIGILANCE + telemetría real (bytes del encoder, panel ⑤, radar con solo el local, dec-bpm `—`), sin sensores→rol UNKNOWN y `—` (cero datos inventados), clasificador de rol SCOUT/VÍCTIMA, SOS 3 taps+touch→IPU, controles (batería/wearable→triaje, bpm/spo2 vía `applySensorData`→triaje, presión→deltaH), paneles render, RESET→DORMANT (vuelve a `null`); panel ⑯ relay: presente con `SIN TRANSPORTE` en el arnés (honesto), inyectar nodo transmite la trama real del dispositivo (sin datos ficticios) y limpiar nodos remotos, TX reenvía telemetría real por el motor (no sin trigger); **v2.2 malla descentralizada**: `relay.alertState` DORMANT→VIGILANCE→DORMANT (trigger/reset), panel ⑯ muestra `SIN PARES` y la lista de pares (`relay-peers`); v1.2: tabs APEX/Sidecar/CDD |

Notas del arnés GUI: timers **no-op** (registrados, no programados) para que los `setInterval` del simulador no mantengan vivo el proceso del test (beacons 5/30 s, contador 1 s, `packetsThisMinute` 60 s); `h.read(expr)` accede al entorno léxico del script (los `let/const` no son propiedades del contexto `vm`); `requestAnimationFrame` no-op; primera tab activa simulando el HTML estático de v1.2. Ejecución aislada: `node --test test/gui.test.js`.

## ⑰ BARRIDO AVANZADO (panel) — casos manuales TC-BARR-01..05

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-BARR-01 | Atmósfera sin wearable | Abrir panel ⑰, pulsar **Vincular atmósfera** (sin Web Bluetooth) | `SIN GASES: WEB_BLUETOOTH_NO_DISPONIBLE`; CO/O2 en `—` y nivel `SIN LECTURA` (no inventa) |
| TC-BARR-02 | Térmica sin transporte | Pulsar **Vincular térmica** | `SIN TÉRMICA: SIN_TRANSPORTE`; recuento de firmas en `—`/0 (no inventa mapa térmico) |
| TC-BARR-03 | DTN mula de datos | Forzar baliza de víctima; pulsar **Sincronizar DTN** | `dtn-stored`/`dtn-pending` > 0; log `DTN: N baliza(s) entregada(s)`; `markSynced` deja `pending=0` |
| TC-BARR-04 | Rol dinámico | 2 scouts + 1 víctima → **Aplicar rol** | `role-suggest` `RELAY`; aplicar actualiza rol del dispositivo en la malla |
| TC-BARR-05 | Wake-up radio | Pulsar **Proximidad** | `wake-state` `IDLE`→`ACTIVE`, contador de activaciones +1; vuelve a `IDLE` tras la ventana |

Sin lectura real de gas/térmica/proximidad la GUI permanece en `—` (regla de cero datos inventados).

### Detección en vivo y responsive móvil — casos TC-DET-01..03

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-DET-01 | Nodo nuevo detectado | Disparar P-Wave; inyectar nodo con vitales | En el radar aparece anillo `◉ NUEVO`; en el feed `DETECCIONES EN VIVO` una entrada con `NUEVO` y sus datos; fila resaltada |
| TC-DET-02 | Nodo actualiza datos | Cambiar lecturas del nodo (bpm/SpO2/atm/profundidad) | En el feed una entrada `ACTUALIZADO`; el blob del radar muestra la nueva lectura |
| TC-DET-03 | Móvil smartphone | Abrir en pantalla <600 px | Tabla de 11 columnas colapsada a tarjetas por nodo; radar de 260 px; feed legible |
| TC-DET-04 | Limpiar detecciones | Pulsar **LIMPIAR** en el feed | Feed vacío y contador a 0; estado "Sin detecciones" |

### Pantallas móviles smartphone — casos TC-MOB-01..03

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-MOB-01 | Pantalla completa por tarjeta | Abrir en smartphone (≤600 px) | Solo se ve una tarjeta a pantalla completa; el resto ocultas; botón flotante ☰ presente |
| TC-MOB-02 | Menú ampliable | Pulsar ☰ | Se abre el cajón con una entrada por tarjeta (función); elegir una la muestra a pantalla completa y resalta su entrada; ✕/elegir cierra |
| TC-MOB-03 | Rotación / redimensionar | Girar a horizontal o abrir en escritorio | Al superar 600 px las tarjetas vuelven a fluir en grid; al volver a vertical se reordena a una pantalla |

En escritorio el menú ☰ no aparece y ninguna tarjeta se oculta.

### Modo aplicación móvil — casos TC-MOB-04..05

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-MOB-04 | Tarjeta llena la pantalla | Abrir en smartphone; navegar con ☰ | Cada tarjeta ocupa el alto completo de la pantalla; solo su contenido hace scroll, el encabezado permanece |
| TC-MOB-05 | Pantalla completa nativa | Abrir ☰ → pulsar **⛶ PANTALLA COMPLETA** al final del menú | La tarjeta activa entra en modo a pantalla completa (API nativa o fallback); al pulsar de nuevo sale |

Nota: si tras actualizar el código la app instalada sigue mostrando la vista antigua,
recarga con la caché renovada — `sw.js` está en `lifeline-shell-v2` (obliga a re-servir el shell).

### Vectorización de rescate (UWB+IMU) — casos TC-VEC-01..03

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-VEC-01 | Sin lectura real | Sin brújula/UWB | `hasOrientation=false`, `uwbDistance=null`; el vector devuelve `null` y la flecha se apaga (no inventa) |
| TC-VEC-02 | Estabilidad magnética | Anomalía: el Norte "salta" 40° en 1 ms | `AzimuthKalmanFilter` con R alto atenúa el salto (K→0, confía en giroscopio); con R bajo converge a la brújula |
| TC-VEC-03 | Dead-reckoning | Se pierde la brújula, gira el giroscopio | El vector continúa por integración giroscópica; z negativo = víctima bajo el suelo |
| TC-VEC-04 | Distancia UWB por bridge | `setDistance(4.2)` real | `hasUwb=true`, `uwbDistance=4.2`; entrada inválida se descarta a `null` |
| TC-VEC-05 | Flecha apagada (honesto) | Sin distancia UWB ni orientación en panel ④ Scout | El Canvas muestra la cruz central sin flecha; `rescue-status` = `SIN VECTOR`; readout = `— · sin distancia UWB` |
| TC-VEC-06 | Flecha con vector real | `setDistance(4.2)` + `onOrientation({alpha:0,beta:-30})`, orientando el móvil al Norte y algo hacia abajo | Brújula roja marca Norte; flecha cian apunta al Norte; `VECTOR ACTIVO`; readout `Cavar -x.x m (N) · rumbo N · dist. ~3.6 m`; indicador `↙ x.x m ↓` (bajo el suelo) |
| TC-VEC-07 | Inclinación (pitch) | Girar el móvil hacia el suelo | `z` se vuelve más negativo; la profundidad indicada y la inclinación en el readout aumentan (víctima más abajo) |
| TC-EXCAV-01 | Sin vector real | Sin distancia UWB/orientación | `#excavation-suggestion` = `Punto de excavación: — · sin vector` (nunca inventa un punto) |
| TC-EXCAV-02 | Vector sin firma térmica | `lastThermal` vacío | Desvío `0° (sin firma térmica)`; se conserva la dirección pura del vector; honesto |
| TC-EXCAV-03 | Gradiente a la derecha | La barrera térmica aparece desplazada a la derecha en la rejilla | Desvío azimut positivo (p. ej. `+22° az`); el rumbo sugerido de excavación se corrige hacia la derecha |
| TC-EXCAV-04 | Gradiente hacia abajo | La barrera térmica aparece abajo en la rejilla | Aumenta la inclinación hacia abajo y la profundidad (`< x.x m`); se excava más profundo en esa zona |

### Overlay táctico consolidado — casos TC-TAC

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-TAC-01 | Modo consolidado por defecto | Abrir panel ④ | `#tactical-summary` = `MODO TÁCTICA: excavar <rumbo> <az>º @ <x> m · desvío +<a>° térm`; en el Canvas conviven la flecha cian (dirección) y la diana ámbar `EXCAVAR` (punto corregido) |
| TC-TAC-02 | Conmutador de modo | Tocar `⬡ MODO TÁCTICA: ON/OFF` | Alterna `getTacticalMode()` entre `TACTICA` y `VECTOR`; el resumen cambia a `MODO VECTOR: <rumbo> ...` (flecha sola, sin diana térmica) |
| TC-TAC-03 | Honestidad sin datos | Sin UWB/orientación | `#tactical-summary` = `TÁCTICA: sin vector — sin datos qué consolidar`; cruza central, sin flecha ni diana |
| TC-TAC-04 | Unificación | Vector + firma térmica simultáneos | Un solo overlay: brújula + dirección (cian) + punto exacto (ámbar) + profundidad consolidada; las líneas de detalle `rescue-readout` y `excavation-suggestion` siguen mostrando el desglose honesto |

### Pruebas de campo (fase siguiente) — requisitos del puente real

Estas pruebas requieren el puente BLE/Serial real (no se simula en el arnés):

| TC-FIELD-01 | Ingesta UWB real | Puente BLE/Serial → `sensors.setDistance(m)` | Flecha/diana cambian con la distancia real del rango UWB ToF; sin puerto, todo queda en `—` (honesto) |
| TC-FIELD-02 | Brújula IMU real | Sostener el móvil como brújula, girar | La marca N y la flecha rotan por el azimut real (Kalman amortigua el saltos de hierro); `VECTOR ACTIVO` |
| TC-FIELD-03 | Grabado bajo escombros | Apuntar el móvil algo hacia abajo | `z<0`; profundidad e inclinación aumentan; readout `Cavar -x.x m` |
| TC-FIELD-04 | Barrera térmica real | Sensor IR MLX90640 apuntando a una persona (o a una fuente cálida) tras un tabique | La diana ámbar se desvía hacia el pixel más cálido y muestra `barrera <t> °C`; sin firma, desvío 0 |
| TC-FIELD-05 | Excavación guiada | Combinar paso a paso la diana + profundidad en el terreno | Confirmar que el punto señalado coincide con la ubicación de la víctima/fuente |

### Puente de campo (Web Serial) — casos TC-FIELD-B

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-FIELD-B-01 | VINCULAR PUENTE | `🔗 VINCULAR PUENTE DE CAMPO` → elegir puerto | `#fb-status` = `PUENTE DE CAMPO OK`; si el dispositivo emite `THERMAL`, el estado térmico pasa a `TÉRMICA ONLINE` |
| TC-FIELD-B-02 | Distancia UWB real | El esclavo emite `UWB 3.4` | El vector táctico se enciende con `dist. 3.4 m`; sin línea, queda `—` |
| TC-FIELD-B-03 | Orientación real | `ORI 120 -30 5` | La brújula gira a 120°, la flecha apunta y `z<0` (cavar); `VECTOR ACTIVO` |
| TC-FIELD-B-04 | Rejilla térmica real | `THERMAL <hex 32×24>` | La diana ámbar se desvía hacia el pixel más cálido; `barrera <t> °C` |
| TC-FIELD-B-05 | Sin línea | No hay UWB/orientación | Todos quedan en `—`; overlay `sin vector` (nada se inventa) |

### Móvil pantalla completa (arreglo dvh) — casos TC-MOB-FS

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-MOB-FS-01 | Sin banners fuera | Activar `⛶ PANTALLA COMPLETA` en un móvil con muesca/gesto | La tarjeta usa `100dvh` + `safe-area-inset`; el contenido no queda bajo la barra del navegador ni fuera de la pantalla |
| TC-MOB-FS-02 | Botón ☰ respetado | Desplazar el contenido de una tarjeta | El botón ☰ flotante no tapa el pie de las tarjetas (padding + safe-area inferior) |
| TC-MOB-FS-03 | Sin overflow horizontal | Tarjetas con tablas (p. ej. scout) en pantalla completa | No hay scroll horizontal (`width:100%`, no `100vw`) |

### Modo esclavo WebRTC (pruebas de campo en dos dispositivos) — casos TC-RTC

| ID | Escenario | Pasos | Resultado esperado |
|----|-----------|-------|--------------------|
| TC-RTC-01 | Emisor esclavo crea oferta | En el esclavo: `① CREAR OFERTA` | Aparece el texto `{"type":"offer","sdp":...}` en `#rtc-sdp-out`; estado `1· Copia la OFERTA` |
| TC-RTC-02 | Maestro responde | En el maestro: pegar la oferta en `#rtc-sdp-in` y `② PEGAR OFERTA → RESPONDER` | Aparece `{"type":"answer","sdp":...}`; estado `2· Copia la RESPUESTA` |
| TC-RTC-03 | Esclavo completa y emite | En el esclavo: pegar la respuesta y `③ PEGAR RESPUESTA → EMITIR` | Estado `EMITIENDO lecturas reales`; el bucle manda `ORI`/`UWB`/`THERMAL` cada segundo |
| TC-RTC-04 | Maestro recibe y muestra | Ver el overlay táctico del maestro | `VECTOR ACTIVO` con la UWB/orientación reales del esclavo; la diana térmica refleja su rejilla |
| TC-RTC-05 | Honesto sin enlace | `✖ CERRAR` en ambos | `SIN ENLACE`; el maestro vuelve a `sin vector` (no congela datos previos inventados) |
| TC-RTC-06 | Conmutador manual de modo | En el panel `⤻ ENLACE DE CAMPO` (o en ROL), pulsar `⤻ MODO: -` varias veces | Alterna ESCLAVO/MAESTRO; el botón y el estado lo reflejan y la caja se muestra (scroll); el log de campo registra el cambio |
| TC-RTC-07 | Aplicar rol NO cambia el modo | Con modo en ESCLAVO, pulsar `🔄 APLICAR ROL` | El modo sigue en ESCLAVO; el log muestra `Rol local aplicado → <ROL> (modo enlace: ESCLAVO (emisor))` |
| TC-RTC-08 | Cada acción refleja progreso | Crear oferta (①), aceptar (②), completar (③) y el bucle del esclavo | Cada paso escribe su avance en el log de campo y en `#rtc-status` (p. ej. `Recibido: ORI …`, `Emisión #5: 3 lectura(s) enviadas`) |
| TC-RTC-09 | Esclavo aparece como nodo remoto | Tras el enlace, mirar el radar/mapa del maestro | Aparece un nodo `NODO-CAMPO` (SCOUT) en la tabla y en los gráficos; al `✖ CERRAR` desaparece |

## Entrelazado automático (AutoLink) — radio/auto_link.js

Protocolo baliza/scan híbrido LoRa+BLE para emparejado autónomo en emergencia (sin
copia-pega). Validable en el arnés con transportes falsos; en hardware con dos transceptores.

| TC | Qué probar | Cómo | Resultado esperado |
|---|---|---|---|
| TC-AL-01 | Hoja entra en baliza | `enterEmergency('leaf')` con transporte LoRa | Emite `AUTOLINK|BALIZA|<id>` periódicamente; estado `BALIZA` |
| TC-AL-02 | Emparejado automático | Coordinador responde `ACK` con el token; hoja emite `CONFIRM` | Ambos pasan a `ACTIVO`; el coordinador recibe `DATA` de la hoja |
| TC-AL-03 | Apagar hojas redundantes | `setEssential(ids)` + coordinador oye baliza de hoja fuera de la cadena | Esa hoja recibe `SLEEP` y su estado pasa a `REDUNDANTE` (no baliza más) |
| TC-AL-04 | Revertir a baliza en pérdida | Hoja en `ACTIVO` deja de recibir `ACK/DATA` durante `ackTimeout` | Vuelve a `BALIZA` y reanuda la emisión |
| TC-AL-05 | Despertar por WAKE | Coordinador envía `WAKE` a una hoja dormida | La hoja pasa a `BALIZA` y baliza de nuevo |
| TC-AL-06 | Honesto sin hardware | `enterEmergency('leaf')` con `lora.available=false` | No emite nada (no inventa señales) |

## Transportes reales de AutoLink — radio/auto_transports.js

Adaptadores que envuelven los drivers físicos con la interfaz `{available, send, onReceive}`
de AutoLink. Validable en el arnés con dos radios falsas conectadas por un "aire".

| TC | Qué probar | Cómo | Resultado esperado |
|---|---|---|---|
| TC-AT-01 | LoRa disponible al conectar | `createAutoTransports({radioDriver})` tras `radio.connect()` | `lora.available === true` |
| TC-AT-02 | texto↔hex | `lora.send('AUTOLINK\|BALIZA\|A')` | Envía `TX <hex>` por el radio; un `onFrame` entrante decodifica a texto |
| TC-AT-03 | BLE honesto sin enlace de par | `makeBleTransport(null)` | `available === false`, `send` devuelve `false` |
| TC-AT-04 | Emparejado por radio real | Dos radios A/B conectadas; hoja (A) + coordinador (B) | Tras el primer ciclo ambos quedan `ACTIVO` y `DATA` fluye A→B |

## Voz directa (WebRTC) y radio de rescate AM/FM

### Voz — radio/voice_link.js
| TC | Qué probar | Cómo | Resultado esperado |
|---|---|---|---|
| TC-VZ-01 | Escucha sin mic | `VoiceLink` con peer conectado, sin llamar `talk(true)` | `micOn:false`, `getUserMedia` nunca llamado |
| TC-VZ-02 | PTT activa mic bajo demanda | Mantener `talk(true)` | `talking:true`, `micOn:true` |
| TC-VZ-03 | PTT libera mic de verdad | Soltar `talk(false)` | `talking:false`, `micOn:false`, pista detenida (`.stop()`) |
| TC-VZ-04 | Honesto sin WebRTC/mic | Entorno sin `RTCPeerConnection` o sin permiso | `WEBRTC_NO_DISPONIBLE` / `SIN_MIC` / `MIC_PERMISO_DENEGADO` |

### Radio de rescate — radio/emergency_radio.js
| TC | Qué probar | Cómo | Resultado esperado |
|---|---|---|---|
| TC-RR-01 | Sin SDR honesto | `EmergencyRadio({sdr:null}).open()` | `SIN_SDR`, no inventa señal |
| TC-RR-02 | Sintonizar AM/FM | `tune(105.5,'FM')` con adaptador | estado `ESCUCHANDO` |
| TC-RR-03 | Detectar emisión de rescate | `scanEmergency()` | Solo canales con señal real (>0) |
| TC-RR-04 | Hardware externo (Walk) | Conectar adaptador SDR (RTL-SDR/HackRF) | Sintoniza y reproduce instrucciones del rescatista |
