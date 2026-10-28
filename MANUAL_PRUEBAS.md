# MANUAL DE PRUEBAS — Project Lifeline Core

Fecha: 2026-08-02 · Entorno: Node v26.4.0, Android/Termux, PC en la misma red Wi-Fi.
Suite automatizada: **197/197 PASS** (ver `pnud_argentina_docs/05` y `06`).

---

## 1. Qué hay en el proyecto

| Ruta | Contenido |
|---|---|
| `radio/` | Stack RF real (sin dependencias): `aes128`, `packet_encoder`, `lora_mesh`, `aprs_protocol`, `sdr_receiver`, `frequency_mgr`, `udp_bridge` |
| `simulation/simulation/` | GUI (`index.html` v1.2, `index_integrated.html` v2.1), `server.js`, `app_integrated.js`, `lifeline_engine.js` (motor de producción), `relay_adapter.js` (relay cross-device), `device_sensors.js` (sensores reales), `core_math.js` |
| `test/` | Suite `node:test` + arnés DOM (`dom_harness.js`) + `helpers.js` |
| `pnud_argentina_docs/` | Registros oficiales de la suite |
| `GUIA_PRUEBAS_MANUALES.md` | Matriz completa de casos (TC-*) |

Regla de producción: **cero datos inventados**. La telemetría remota solo entra por
`ingestRemoteTelemetry()` o por una trama real descifrada (recepción de malla o
relay cross-device); sin lectura de sensor se muestra `—`, nunca un valor fabricado.

---

## 2. Pruebas automatizadas

### 2.1 Desde la computadora (Windows/macOS/Linux)

Requisito: Node.js ≥ 18 (probado en v26.4.0). Copiar la carpeta del proyecto y:

```sh
cd <carpeta-del-proyecto>
npm test                 # o: node --test "test/*.test.js"
```

Resultado esperado: `tests 190 / pass 190 / fail 0 / exit 0`.

Subsets:

```sh
npm run test:radio       # packet_encoder, aprs, lora, frequency, sdr
npm run test:sim         # core_math
npm run test:server      # server.js
npm run test:integration # integración RF end-to-end
node --test test/gui.test.js      # GUI headless (19 pruebas)
node --test test/browser_load.test.js  # carga completa en orden navegador (4 pruebas, BUG-10)
node --test test/gui_buttons.test.js   # todos los botones disparan su acción (5 pruebas)
node --test test/lifeline_engine.test.js
node --test test/relay_adapter.test.js   # adaptador relay cross-device
```

Nota (Node 26): usar el glob entre comillas `"test/*.test.js"`;
la forma `node --test test/` falla con `MODULE_NOT_FOUND "test"`.

### 2.2 Desde este dispositivo (Android/Termux)

Requisitos: Termux + `pkg install nodejs` (opcional `pkg install termux-api`
para sensores del sistema). El `node` es un alias de Termux: para usar `npm`
exportar el PATH una vez por sesión:

```sh
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
cd /storage/emulated/0/Documents/UNVolunteers
npm test                          # 197/197 esperado
node --test "test/*.test.js"
node --test test/gui.test.js
```

---

## 3. Levantar la red: cada dispositivo corre su propio servidor

Requisito: teléfono y PC en la **misma red Wi-Fi**. Cada dispositivo levanta su
PROPIO servidor (no hay servidor central) y los dispositivos que están en
estado de alerta se descubren solos por **UDP broadcast** (fallback: par manual).

### 3.1 Obtener la IP del dispositivo (Termux)

```sh
ifconfig          # si no existe: pkg install net-tools
```

Buscar en `wlan0` la línea `inet 192.168.x.x` (en este entorno actual:
`192.168.0.76`; cambia según la red). El broadcast local es `192.168.0.255`.

### 3.2 Levantar el servidor (en CADA dispositivo)

```sh
cd /storage/emulated/0/Documents/UNVolunteers/simulation/simulation
node server.js            # puerto 8000; o: PORT=9090 node server.js
```

Escucha en **todas las interfaces** (accesible por LAN) y anuncia su URL por
UDP (puerto 42203) SOLO cuando un navegador le reporta estado de alerta.
Mensaje esperado: `Server is running at http://localhost:8000`.

### 3.3 Abrir la GUI en cada dispositivo

| Dispositivo | URL |
|---|---|
| Teléfono (sensores: contexto seguro) | `http://localhost:8000/index_integrated.html?label=TELÉFONO` |
| PC | `http://localhost:8000/index_integrated.html?label=PC` (su propio server) |

Probar la conexión entre dispositivos antes de probar la malla:

```sh
curl -I http://192.168.0.5:8000/api/state   # desde el teléfono → 200 JSON
curl http://192.168.0.5:8000/rf/lora_mesh.js   # 200 text/javascript (stack RF real)
```

### 3.4 Parámetros por URL (GUI v2.1)

```text
http://192.168.0.76:8000/index_integrated.html?callsign=LU1PNU&key=a1b2c3d4e5f60718293a4b5c6d7e8f90&label=TELÉFONO
```

- `?key=…` — clave AES-128 en hex (32 caracteres). Sin clave → clave de referencia
  NIST documentada en `radio/` (SOLO demo; producción debe pasarla).
- `?callsign=…` — indicativo APRS. Sin indicativo → APRS inactivo (nunca `N0CALL`).
- `?label=…` — nombre visible del dispositivo (p. ej. `label=PC`, `label=TELÉFONO`).
  Sin parámetro → `DISPOSITIVO-LOCAL`. Es el nombre con el que el dispositivo
  aparece como nodo remoto para las otras pestañas vía relay.

### 3.5 Importante — contexto seguro y sensores

Los sensores reales (GPS, barómetro, luz, micrófono, movimiento) exigen un
**contexto seguro**: `https` o `localhost`. Por lo tanto:

- **En el dispositivo**: abrir `http://localhost:8000/index_integrated.html` →
  los sensores se habilitan (hay que aceptar los permisos).
- **Desde la PC**: `http://192.168.x.x:8000` NO es contexto seguro → los sensores
  se muestran como `—`. Es comportamiento esperado (verificación de la UI, no de
  sensores).

### 3.6 Solución de problemas

| Síntoma | Causa/arreglo |
|---|---|
| `curl` no responde desde la PC | No es la misma subred; o el router aísla clientes (AP isolation). Probar con un hotspot del teléfono y conectar la PC a ese hotspot. |
| El dispositivo no ve la GUI en sí mismo | `curl http://localhost:8000/` debe dar 200; si no, el servidor no está corriendo o el puerto está ocupado (`netstat -ltnp`). |
| Bloqueos raros | Firewall/antivirus de la PC; probar primero con `curl`. |

---

## 4. Pruebas manuales — procedimiento

Recomendación: GUI v2.0 **en el dispositivo** (`http://localhost:8000/index_integrated.html`,
para sensores) y la **misma URL desde la PC** (verificación remota). Mantener
DevTools abiertas (F12 → consola).

### 4.1 Al cargar (GUI v2.0)

En la consola RF deben verse los módulos reales cargados y el motor listo:
`[Mesh] Module loaded`, `[FreqMgr] Allocated 144.390 MHz`, `[SDR] Receiving on
433.000 MHz`, `Motor de producción listo — LoRa ID <16 hex>`. El nodo local es
`DISPOSITIVO-LOCAL`. Desde la consola:

```js
window.engine.getNodes();   // → 1 solo nodo: el local. Nada inventado.
window.engine.localNode.id; // → id LoRa de 8 bytes del dispositivo
```

### 4.2 Lista de verificación

**TC-BASE (GUI v1.2, `http://<IP>:8000/`)**

| # | Acción | Resultado esperado |
|---|---|---|
| 1 | Cargar | Estado inicial `DORMANT`; sin errores en consola |
| 2 | Toggle "En la muñeca" | Cambia `watchOnBody` y afecta IPU |
| 3 | TRIGGER P-WAVE | Transición `VIGILANCE`; respuesta del sistema; panel ⑤ activo |
| 4 | SOS: 3 toques en el botón SOS (táctil) | IPU sube; toggle SOS activa el flag |
| 5 | Sliders batería/bpm/spo2; auto-drain 1%/3 s | Los valores de la UI cambian |
| 6 | RESET | Vuelve a `DORMANT` y detiene |

**TC-RF (GUI v2.0 de producción, `index_integrated.html`)**

| # | Acción | Resultado esperado |
|---|---|---|
| 1 | Cargar sin sensores | Badge de rol `UNKNOWN`, razón `INSUFFICIENT_SENSORS`, confianza `0%`; `sensor-sources` con `gps:— barometer:— …`; lecturas `env-*` en `—`; indicadores `val-bpm`/`val-spo2`/`val-battery`/`val-pressure` en `—` (sin fuente real) |
| 2 | En el dispositivo (localhost), aceptar permisos GPS/luz/movimiento; mover el dispositivo | Lecturas reales reemplazan `—` cuando el sensor existe |
| 3 | Con barómetro + luz + movimiento | Badge `SCOUT` (razón `SURFACE`/`SURFACE_MOBILE`) |
| 4 | Subir el slider de presión (~101325 → 102000 Pa, ≈ 5,7 m de profundidad) y dejar el dispositivo quieto | Tras un periodo sin interacción (la prueba automática usa 2 h → `BURIED_STILL`), badge `VICTIM`. El slider solo aplica si el barómetro real no existe (si existe, el sensor pisa el slider) |
| 5 | TRIGGER P-WAVE | `engine.sequence >= 1`; panel ⑤ `LIVE CAPTURE (BYTES REALES)`: nonce 8 pares hex + MIC 4 pares hex + `CBOR+LZ77+AES-CTR`; `size-cipher = bytes.length - 12` |
| 6 | Radar/malla | Solo `/◉ LOCAL/`. No aparecen nodos de ejemplo |
| 6b | Otro dispositivo en baliza (VIGILANCE) emite BEACON en la misma LAN | Su nodo se materializa solo (sin `ingestRemoteTelemetry()`): aparece en la tabla scout con su nombre, rol `UNKNOWN` y batería/senal reales del beacon hasta que llegue su telemetría. Columna `SEÑAL` muestra la antigüedad (`0s…`) y los nodos sin señal durante +30 s se podan solos. La lista se repinta cada segundo (tick de refresco en tiempo real) |
| 7 | Botón `＋ INYECTAR NODO (DATOS REALES)` del panel ⑯ (tras P-WAVE) | Transmite la trama real AES-CTR del dispositivo (`engine.sequence` sube); el par la materializa como nodo remoto. Sin motor iniciado avisa. La inyección por consola `ingestRemoteTelemetry()` (4.3) sigue siendo la vía de ingesta local |
| 8 | Ping unicast | `window.engine.sendPing('AB00000000000002')` → log RF de relay; contador RX |
| 9 | Paneles RF | TX = `engine.sequence`; RX = `engine.mesh.stats.successfulDeliveries`; RSSI = `engine.localNode.getSignalStrength()`; APRS TX = `engine.tracker.stats.packetsSent` (0 sin `?callsign=`, >0 con él). Sin contador → `—` |
| 10 | RESET → TRIGGER | El motor se detiene y vuelve a arrancar |
| 11 | Recargar con `?key=` y `?callsign=` | Log RF muestra APRS listo con el indicativo y usa la clave pasada |

### 4.3 Inyección de un nodo remoto (prueba manual del mesh)

La GUI muestra nodos remotos si entra telemetría real por
`ingestRemoteTelemetry()` o si un par transmite su trama por el relay.
En la consola DevTools:

```js
window.engine.ingestRemoteTelemetry([{
  id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM',
  lat: -34.603722, lon: -58.381592,
  bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73
}]);
window.engine.getNodes();
// → [nodo local, VICTIM-1 (VICTIM, bpm 110, spo2 93, battery 42, rssi -73)]
```

Verificar que la lista/malla muestra el nodo con sus lecturas y que, sin llamar
a la función, el mapa vuelve a 1 solo nodo (no se inventan nodos).

### 4.4 Malla cross-device descentralizada (dos dispositivos en alerta)

No hay servidor central: **cada dispositivo corre su propio servidor** y solo
los que están en **estado de alerta (VIGILANCE = modo scout/baliza)** participan.
Al disparar P-WAVE, el navegador reporta `VIGILANCE` al servidor local
(`POST /api/state`); el servidor anuncia su URL por **UDP broadcast** (puerto
42203) y descubre a los pares en el mismo estado (`GET /api/peers`). Cada GUI
mantiene un `EventSource` a su propio `/relay/stream` y reenvía sus tramas por
`POST /relay/send` a su servidor **y a cada par** (malla completa HTTP). Los
dispositivos DORMANT son invisibles y no participan. El panel ⑯ `TEST SIGNALS`
(v2.2) muestra el estado del relay y la lista de pares.

```sh
# En CADA dispositivo: levantar su propio server
cd simulation/simulation && node server.js     # escucha en todas las interfaces
```

| # | Acción | Resultado esperado |
|---|---|---|
| 1 | Server en el teléfono y server en la PC (cada uno en su dispositivo) | Ambos responden `200` en `/api/state` |
| 2 | Teléfono: `http://localhost:8000/index_integrated.html?label=TELÉFONO`; PC: `http://localhost:8000/index_integrated.html?label=PC` | Panel ⑯ `CONECTADO`; `SIN PARES` en reposo |
| 3 | TRIGGER P-WAVE en el teléfono | En el panel ⑯ del teléfono aparece `[PAR] VIGILANCE TELÉFONO…` (se anunció) |
| 4 | TRIGGER P-WAVE en la PC (mismo estado de alerta) | Ambos paneles ⑯ listan al otro par (descubrimiento UDP ≤ 2 s) |
| 5 | Botón `TX` del panel ⑯ en el teléfono | En la PC `relay-rx` sube y el nodo `TELÉFONO` aparece con sus lecturas reales (role, battery, pressure; `bpm`/`spo2` en `—` si no hay puente BLE) |
| 6 | RESET en el teléfono (DORMANT) | En la PC el par `TELÉFONO` desaparece del panel ⑯ (BYE/TTL) |
| 6b | **Intercom cross-device**: en el teléfono (VIGILANCE) escribir en el campo del intercom y `ENTER` | El mensaje viaja incrustado en la trama real; en la PC aparece en su propio log de intercom como `TELÉFONO → AQUÍ: …`; el campo del teléfono se vacía |
| 7 | Si el broadcast UDP no llega (red aislada): campo `Par manual` → `http://<IP-PC>:8000` → `➕ AÑADIR PAR` | El par se añade (probe server→server) |
| 8 | Recargar una pestaña sin transportes (SSE/fetch bloqueado) | Panel ⑯ `SIN TRANSPORTE`; el resto de la GUI sigue viva |

Verificación desde la consola:

```js
// En la PC: el nodo remoto llega por el relay del par (sin ingest manual)
window.engine.getNodes().map(n => `${n.label} (${n.id}) ${n.role}`);
// → [DISPOSITIVO-LOCAL ..., TELÉFONO (BBBB…0002) VICTIM]  (lecturas reales)
// Pares del mismo estado:
window.engine; // o en el panel ⑯: lista [PAR] con label + URL
```

### 4.5 Registro de resultados

| Fecha | Caso | Resultado (OK / falla) | Observaciones |
|---|---|---|---|
| 2026-08-02 | TC-RF-1 sin sensores | | |
| | TC-RF-5 bytes reales | | |
| | TC-RF-7 nodo remoto | | |
| | TC-RELAY-1 P-WAVE cruzado PC↔teléfono | | |
| | TC-RELAY-2 descubrimiento UDP (ambos en VIGILANCE) | | |
| | TC-RELAY-3 RESET separa la malla (BYE) | | |

Firma final: estado general (p. ej. "197/197 automatizado + manual OK").

---

## 5. Comandos de referencia rápida

```sh
# Suite completa (PC o Termux)
node --test "test/*.test.js"

# GUI headless
node --test test/gui.test.js

# Servidor de la GUI (Termux)
cd simulation/simulation && node server.js

# IP del dispositivo (Termux)
ifconfig

# Verificación desde la PC
curl -I http://<IP-del-dispositivo>:8000/
```

## 6. Referencias

- `GUIA_PRUEBAS_MANUALES.md` — matriz completa de casos TC (incluye UDP cross-device).
- `radio/README_RF.txt` — documentación técnica del stack RF y del puente UDP.
- `pnud_argentina_docs/05_Registros_Suite_NodeTest.md` y `06_…log` — registros oficiales.

## Barrido avanzado (panel ⑰) — nuevos módulos

- `radio/atmosphere_bridge.js` — gases CO/O2 vía BLE GATT 0x181A; honesto: sin lectura → `—`.
- `radio/thermal_cam.js` — termografía de proximidad 32×24; sin transporte → `SIN_TRANSPORTE`.
- `radio/dtn_store.js` — mula de datos store-and-forward con cifrado AES-128 en reposo.
- `radio/wake_radio.js` — escucha ultra-baja; solo despierta ante firma de proximidad real.
- Altimetría diferencial en `core_math` (`calcDeltaHRef`/`estimateFloorLevel`: P0, sótanos `-N`, pisos `PN`).

Suite: **239/239 PASS** (197 base + 42 nuevos: atmósfera 11, térmica 6, dtn 7, wake 7, altimetría 4, motor +6, GUI +5). Ver `GUIA_PRUEBAS_MANUALES.md` TC-BARR-01..05.
