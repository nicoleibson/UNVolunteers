# Pruebas de Despliegue en Dispositivo Móvil - Project Lifeline Core
**Destinatario:** Programa de las Naciones Unidas para el Desarrollo (PNUD), Buenos Aires, Argentina.
**Entorno de Pruebas:**
- **Sistema Operativo:** Android 15
- **Entorno:** Termux
- **Dispositivo:** Xiaomi Redmi Note 8 (Ginkgo)

## Objetivo
Validar que el simulador AMRF v2.0 (Integrated RF System) es capaz de ejecutarse y ser servido directamente desde un dispositivo móvil de gama media (Xiaomi Redmi Note 8) utilizando un entorno local (Termux), simulando condiciones de campo donde un voluntario actúa como nodo servidor de la intranet en situaciones de desastre en Argentina.

## Fases de la Prueba
1. **Verificación de Entorno:** Disponibilidad de Node.js en Termux.
2. **Arranque del Servidor (server.js):** Ejecución del servidor HTTP local en el puerto 8000.
3. **Prueba de Accesibilidad Local:** Peticiones HTTP a `localhost:8000` para verificar la entrega de los archivos base y RF (`index_integrated.html`, `app_integrated.js`).
4. **Análisis de Rendimiento (Simulado):** Viabilidad de correr el motor de simulación RF (LoRa, APRS, SDR) en el hardware del Redmi Note 8.

## Resultados de las Pruebas
**Fecha:** 01 de Agosto de 2026

**1. Verificación de Entorno:**
- **Node.js:** Instalado correctamente (v26.4.0).
- **Termux:** Operativo con acceso a almacenamiento.

**2. Arranque del Servidor:**
- El servidor `server.js` arrancó de forma nativa sin requerir dependencias adicionales (`npm install`).
- Se ancló exitosamente al puerto `8000`.

**3. Prueba de Accesibilidad Local:**
- `index_integrated.html`: `HTTP/1.1 200 OK` (Servido como `text/html`).
- `app_integrated.js`: `HTTP/1.1 200 OK` (Servido como `text/javascript`).
- El servidor responde correctamente con los MIME types adecuados.

**Conclusión preliminar:**
El simulador AMRF v2.0 es totalmente compatible y funcional a nivel de backend/servidor HTTP ejecutándose desde Termux en el Xiaomi Redmi Note 8. Esto demuestra la portabilidad del sistema en condiciones de conectividad nula, donde un solo teléfono puede actuar como servidor de comando local (Gateway) para la intranet de la brigada de rescate.

**4. Pruebas de Sensores (Hardware del Dispositivo):**
- Se ejecutó un script de recolección de datos (`recolectar_sensores.js`) para capturar la telemetría del Xiaomi Redmi Note 8 (Android 15).
- **Limitación en campo:** Termux requiere la app companion `Termux:API` (con permisos otorgados por el usuario) para leer el hardware nativo (GPS, Acelerómetro). Al estar restringido en el entorno base, el script hace *fallback* a un flujo simulado para asegurar la continuidad de operaciones.
- **Flujo de datos validado:** El sistema puede parsear un JSON estructurado de GPS (lat: -34.603722, lon: -58.381592 - *Coordenadas de referencia Buenos Aires*) y Barómetro (1013.25 hPa) y convertirlo en una trama válida de APRS (e.g., `!34.6037S/58.3816W[PNUD TEST - REDMI NOTE 8`).
- **Registro generado:** Los flujos exactos de datos (payload ECIES y variables de estado) fueron exportados exitosamente en `02_Flujo_Datos_Sensores.json`.

## Correcciones aplicadas y verificadas (01/08/2026)
Durante una auditoría funcional del stack RF y de ambos simuladores se identificaron y corrigieron los siguientes defectos:

1. **`app_integrated.js` (CRÍTICO):** error de sintaxis en la línea ~1359 (falta un paréntesis de cierre en `Math.min(100, (avgRssi + 100))`). Impedía que el simulador v2.0 se cargara en el navegador. Corregido y verificado con `node --check`.
2. **`packet_encoder.js` (ALTO):** `calculateCRC16` no enmascaraba el CRC a 16 bits; el roundtrip `BINARY` fallaba siempre (`CRC mismatch`). Corregido (`return crc & 0xFFFF`); ahora JSON/CBOR/BINARY hacen roundtrip correcto.
3. **`aprs_protocol.js` (ALTO):** bit de extensión de dirección AX.25 mal manejado (la fuente se marcaba como última y el decodificador leía el bit del primer byte en lugar del SSID byte). Perdía el campo de información. Corregido en `encode()` y `decode()`; el roundtrip conserva `infoField`.
4. **`lora_mesh.js` (MEDIO):** `findPath` devolvía `null` con la tabla de rutas poblada. Ahora construye un grafo de adyacencia y aplica BFS (rutas de 1 y 2 saltos verificadas).
5. **`app.js` (BAJO):** paneles de telemetría (`updateVitalsPanel`/`updateEnvironPanel`) eran código muerto; ahora se invocan desde el muestreo de sensores y el arranque. Además se unificó el signo de la profundidad (mayor presión atrapada = mayor profundidad positiva).
6. **`app_integrated.js` (BAJO):** se aplicaron al simulador v2.0 los mismos arreglos del punto 5: paneles de telemetría activados (muestreo 1 s + arranque) y signo de profundidad unificado en `updateUI`, radar y canvas (líneas 665, 732, 750, 1029-1031 y 1802 del archivo corregido).
7. **`aprs_protocol.js` (ALTO, detectado en la prueba funcional completa):** los reportes `create*` incluían el carácter del `dataType` en `data` y `createAPRSPacket` lo anteponía de nuevo → prefijos duplicados (`TT#001,98`, `>>OPERATIVO`, `::LU1AAA:...`, `;;VICTIM_A*...`, `!!/ 35-...`). Corregidos los 6 métodos; verificados: `T#001,98`, `>OPERATIVO`, `:LU1AAA   :AYUDA`, `!/35-23.78S[059-37.10WEMERGENCY - NEED RESCUE`.

## Correcciones aplicadas por la suite automatizada `node:test` (01/08/2026, tarde)

Se construyó la infraestructura de pruebas automatizadas (`test/`, scripts en `package.json`) y su primera ejecución completa (80 pruebas) detectó 4 defectos adicionales, corregidos en código y espejados en la documentación:

8. **`packet_encoder.js` (MEDIO, BUG-6):** `decodeBinary` verificaba el CRC **después** de parsear el payload JSON; un byte corrupto en el payload producía `SyntaxError` en vez de `CRC mismatch`. Corregido: CRC verificado antes de interpretar el payload. La corrupción en cualquier posición de byte ahora lanza uniformemente `CRC mismatch`.
9. **`sdr_receiver.js` (ALTO, BUG-7):** `DSP.fft` solo rechazaba tamaños impares (`N & 1`); pares no potencia de 2 (p. ej. 4800) devolvían un espectro corrupto silencioso. Corregido a `N & (N - 1)` (N=1 sigue siendo potencia de 2 válida).
10. **`sdr_receiver.js` (ALTO, BUG-8):** `DSP.ifft` descartaba la parte imaginaria del espectro y no reconstruía la señal. Reescrito con la fórmula directa para señales reales (DC + Σ 2·Re + bin de Nyquist); `ifft(fft(x)) ≈ x` con error < 1e-6.
11. **`packet_encoder.js` (ALTO, BUG-9):** la compresión LZ77 hacía ambiguos los literales de byte ≥ 0x80 con los tokens de match, corrompiendo el roundtrip `BINARY+LZ77` (el literal `0x00` también era ilegible). Corregido con un esquema de escape (prefijo `0x00` antes del literal alto) y `matchLen` cap a 127; verificado con fuzz determinista de 500 rondas sobre payloads de bytes 0..255.
12. **`core_math.js` (BAJO, NOTA-4):** el nuevo módulo de física pura (`calcDeltaH`, `calcIPU`, `getTriageForVitals`, `resolveState` + constantes físicas) asignaba `module.exports` sin guarda, rompiendo la carga en navegador. Corregido con doble guarda (CommonJS + `window.coreMath`); los simuladores `app.js`/`app_integrated.js` delegan en él y los HTML cargan `core_math.js` antes del simulador.

**Nota:** la suite completa (`node --test test/`, 80 pruebas) queda en **PASS=80 FAIL=0**; el arnés manual `03_prueba_funcional_completa.js` mantiene **PASS=42 FAIL=0** (sin regresión). Registros de la nueva batería en `05_Registros_Suite_NodeTest.md`.

**Nota:** el simulador integrado v2.0 queda operativo tras la corrección #1; la guía `GUIA_PRUEBAS_MANUALES.md` documenta los casos de prueba (TC-*) para su validación completa.
