# Registros de Prueba Funcional Completa — Project Lifeline Core
**Destinatario:** PNUD Argentina (Buenos Aires) · Fecha: 01 de Agosto de 2026

---

## Resumen

| Ítem | Valor |
|------|-------|
| **Resultado** | ✅ **42 / 42 pruebas PASS** (0 fallos) |
| **Código de salida** | `0` |
| **Entorno** | Node.js `v26.4.0`, Linux/Termux (Android 15) |
| **Fecha/hora (local)** | `2026-08-01 17:19:56 GMT-0300 (Argentina Standard Time)` |
| **Script de prueba** | `03_prueba_funcional_completa.js` |
| **Log crudo** | `04_Registros_Prueba_Funcional_Completa.log` |

> El arnés cubre los 8 grupos: sintaxis, PacketEncoder, APRS/AX.25, LoRa Mesh,
> FrequencyManager, SDR/DSP, servidor HTTP y flujo de sensores → trama APRS.

## Hallazgo corregido durante la prueba: BUG-5 (APRS)

La prueba completa detectó un defecto real no identificado previamente en `radio/aprs_protocol.js`
(`APRSPacket`): los reportes `create*` incluían el carácter del `dataType` dentro de `data` y
`createAPRSPacket` lo anteponía de nuevo, generando **prefijos duplicados** en el campo de
información (formato APRS inválido).

**Evidencia antes de la corrección (primera ejecución del arnés):**
```
[FAIL] APRS | Telemetría (canal/valor) :: info="TT#001,98"     ← debería ser T#001,98
[PASS] APRS | Baliza de emergencia  :: info="!!/ 35-23.78S[059-37.10WEMERGENCY..."  ← doble '!'
```

**Corrección aplicada** en los 6 métodos (`createPositionReportWithTimestamp`, `createStatusReport`,
`createMessage`, `createTelemetryReport`, `createObject`, `createEmergencyBeacon`): `data` ya no
incluye el carácter de tipo. Verificación post-corrección:

```
pos  : !/35-23.78S[059-37.10W
ts   : /201938h35-23.78S[059-37.10W
stat : >OPERATIVO
msg  : :LU1AAA   :AYUDA
tel  : T#001,98
obj  : ;VICTIM_A */35-23.78S[059-37.10W
emer : !/35-23.78S[059-37.10WEMERGENCY - NEED RESCUE
```

## Resultados por grupo

### GRUPO 1 — Sintaxis (`node --check`) — 8/8 PASS
| Archivo | Resultado |
|---------|-----------|
| `packet_encoder.js` | PASS |
| `aprs_protocol.js` | PASS |
| `lora_mesh.js` | PASS |
| `frequency_mgr.js` | PASS |
| `sdr_receiver.js` | PASS |
| `server.js` | PASS |
| `app.js` (v1.2) | PASS |
| `app_integrated.js` (v2.0) | PASS |

### GRUPO 2 — PacketEncoder — 5/5 PASS
| Prueba | Resultado |
|--------|-----------|
| Roundtrip JSON (paquete EMERGENCY, payload telemetría) | PASS — `bytes=210` |
| Roundtrip BINARY | PASS — `bytes=113` |
| Roundtrip CBOR | PASS — `bytes=211` |
| CRC16 en rango 16 bits | PASS — `crc=0x3106` |
| CRC detecta corrupción | PASS — `decode lanzó CRC mismatch` |

### GRUPO 3 — APRS / AX.25 — 6/6 PASS
| Prueba | Resultado |
|--------|-----------|
| AX.25 roundtrip con repetidores `[WIDE1-1, WIDE2-1]` | PASS — `info=":HELLO TEST"` |
| AX.25 roundtrip sin repetidores | PASS — `info=":SOS DIRECTO"` |
| Reporte de posición Buenos Aires | PASS — `!/35-23.78S[059-37.10W` |
| Baliza de emergencia | PASS — `!/35-23.78S[059-37.10WEMERGENCY - NEED RESCUE` |
| Telemetría | PASS — `T#001,98` |
| APRSTracker registra objeto | PASS |

### GRUPO 4 — LoRa Mesh — 6/6 PASS
| Prueba | Resultado |
|--------|-----------|
| Alta de 3 nodos (SCOUT/RELAY/VICTIM) | PASS — `routingTable=3` |
| CRC 4 dígitos hex | PASS — `crc=7299` |
| Roundtrip `encodePacket`/`decodeFrame` | PASS — `dst=AA00000000000003 hops=0` |
| `findPath` 1 salto | PASS — `[AA...0001, AA...0002]` |
| `findPath` 2 saltos | PASS — `[AA...0001, AA...0002, AA...0003]` |
| `sendPacket` + propagación | PASS — `entregas: 0 -> 2` |

### GRUPO 5 — FrequencyManager — 3/3 PASS
| Prueba | Resultado |
|--------|-----------|
| Asignación de frecuencia | PASS — `ALLOC-MSATFBZH-4BY5 · 144.390 MHz · SCOUT-1` |
| Liberación de frecuencia | PASS — `true` |
| Estadísticas post-asignación | PASS — `total=2 activeChannels=1 collisions=0` |

### GRUPO 6 — SDR / DSP — 6/6 PASS
| Prueba | Resultado |
|--------|-----------|
| `getSpectrum` (8192 bins) | PASS |
| `powerSpectrum` 4096 bins | PASS |
| `calculateSNR` con noiseFloor | PASS — `SNR=26.99 dB` |
| `calculateSNR` sin noiseFloor (NaN esperado) | PASS — `SNR=NaN` |
| FFT potencia de 2 (4096 OK / 4800 lanza) | PASS |
| Tune + demod + gain | PASS — `145.800 MHz · 55 dB` |

### GRUPO 7 — Servidor HTTP (`server.js`) — 6/6 PASS
| Prueba | Resultado |
|--------|-----------|
| `GET /` | `200 text/html` |
| `GET /index_integrated.html` | `200 text/html` |
| `GET /app_integrated.js` | `200 text/javascript` |
| `GET /app.js` | `200 text/javascript` |
| Archivo inexistente | `404` |
| Traversal de ruta (`../../etc/passwd`) | `403` |

### GRUPO 8 — Flujo de sensores → trama APRS (Buenos Aires) — 2/2 PASS
| Prueba | Resultado |
|--------|-----------|
| Barómetro → profundidad (1013.25 hPa → 0 m) | PASS — `0.0000 m` |
| GPS BA → trama APRS | PASS — `!/35-23.78S[059-37.10W` |

## Notas sobre el arnés

- **APRS `createTelemetryReport`**: la primera ejecución falló (`TT#001,98`). Fue un bug real del
  código (BUG-5), no del arnés; corregido en `radio/aprs_protocol.js`.
- **LoRa roundtrip**: `createDataPacket()` ya devuelve la **trama** completa (header + payload +
  CRC), por lo que el arnés pasó `decodeFrame(frame)` directamente sin re-encapsular.
- **DSP `powerSpectrum`**: usa una señal construida de exactamente 4096 muestras (potencia de 2);
  `sineWave(1200, 48000, 0.1)` generaría 4800 muestras y lanzaría `FFT size must be power of 2`
  (comportamiento documentado, NOTA-1).
- **Servidor**: el arnés lanza `server.js` con `process.execPath` (en Termux el binario `node` no
  siempre está en el PATH del hijo) y `--path-as-is` para la prueba de traversal.
