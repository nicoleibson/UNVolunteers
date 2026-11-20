# Manual de usuario — Lifeline Core by Zentec

Versión 2.0.1. Este manual cubre cómo iniciar el gateway, usar la aplicación web, operar el walkie de voz por Wi-Fi y trabajar con la CLI headless.

## 1. Requisitos

- Node.js >= 18.
- Navegador moderno; se recomienda Chrome o Chromium en Android.
- Para voz: dos dispositivos en la misma Wi-Fi o hotspot, y contexto seguro (`https://` o `localhost`) para acceder al micrófono.
- Sin dependencias npm: el proyecto funciona con el runtime de Node.js y módulos del navegador.

## 2. Instalación y arranque

Desde la raíz del repositorio:

```bash
git clone https://github.com/nicoleibson/UNVolunteers.git
cd UNVolunteers
cd simulation/simulation
node server.js
```

Luego abrir en el navegador:

```text
http://localhost:8000/index_integrated.html
```

Para abrir desde otro dispositivo de la misma red, reemplazar `localhost` por la IP del dispositivo que corre el servidor:

```text
http://<IP-del-gateway>:8000/index_integrated.html
```

Ese acceso HTTP por LAN sirve para los paneles de simulación, pero Chrome no entregará el micrófono. Para voz, el gateway debe estar detrás de HTTPS con certificado confiable.

### Instalar la PWA

1. Abrir la app en Chrome/Android mediante HTTPS o `localhost`.
2. Usar el menú del navegador → `Instalar app` o `Agregar a pantalla de inicio`.
3. La PWA queda disponible offline con la shell cacheada.

Si la interfaz queda desactualizada después de una actualización, recargar con caché desactivada o desregistrar el service worker desde las herramientas del navegador.

## 3. Uso general de la aplicación

La página integrada reúne los paneles de Simulación, Emergencia, RF, WebRTC, DTN y Sensores. Algunos parámetros iniciales se pueden pasar por query string:

```text
/index_integrated.html?label=NODO-A&voiceRoom=EQUIPO-1
```

- `label`: define la identidad local mostrada en la app.
- `voiceRoom`: precarga el nombre de la sala del walkie.

Los paneles muestran estados honestos cuando falta hardware o permiso: `SIN_SDR`, `NO_CONECTADO`, `WEBRTC_NO_DISPONIBLE`, `SIN_MIC` o `MIC_PERMISO_DENEGADO`. No se inventan datos de sensores, radio ni audio.

## 4. Walkie Wi-Fi de voz PTT

### 4.1 Qué es

Es un canal de voz semidúplex: solo una persona habla a la vez. El audio viaja de dispositivo a dispositivo con WebRTC; la señalización `offer`/`answer` pasa por el gateway mediante:

- `POST /voice/signal` y `GET /voice/signal`
- `GET /voice/stream` (Server-Sent Events)

El micrófono se adquiere únicamente mientras se mantiene presionado PTT. Al soltar, se detienen los tracks y el dispositivo queda en escucha. El SDP inicial se negocia con un transceiver de audio, por lo que el track del micrófono se reemplaza durante PTT sin necesidad de renegociar.

### 4.2 Preparación

1. Conectar ambos teléfonos a la misma Wi-Fi o hotspot.
2. Servir la app por HTTPS o `localhost`.
3. Abrir la app en ambos dispositivos.
4. En el panel `WALKIE WI-FI · VOZ PTT`, escribir el mismo nombre en `SALA`, por ejemplo `EQUIPO-1`.

El nombre de sala acepta de 1 a 32 caracteres: letras, números, guion y guion bajo. No acepta espacios.

### 4.3 Conexión automática

1. En el dispositivo A, tocar `CREAR SALA / OFERTA`.
2. En el dispositivo B, tocar `UNIRSE A SALA`.
3. Esperar a que el estado muestre `ENLACE ACTIVO — ESCUCHANDO`.
4. Mantener presionado `PULSAR PARA HABLAR` en quien va a hablar.
5. Soltar el botón para volver a escuchar.
6. Tocar `COLGAR` para cerrar el canal en ambos dispositivos.

También funciona si el dispositivo B se une primero: quedará en `ESPERANDO OFERTA...` y aceptará la oferta cuando el dispositivo A la publique.

Si el estado muestra `LA SALA YA TIENE OFERTA — usa UNIRSE`, significa que esa sala ya tiene una oferta pendiente. En el segundo dispositivo usar `UNIRSE A SALA`, no `CREAR SALA / OFERTA`.

### 4.4 Señalización manual

Usar este modo si `fetch` o SSE no pueden publicar señales en el gateway. Igualmente requiere HTTPS o `localhost` para el micrófono.

1. Abrir `Señalización manual (copiar/pegar)` en ambos dispositivos.
2. En el dispositivo A, tocar `CREAR OFERTA`.
3. Copiar todo el contenido de `← Copiar de aquí` y enviarlo al dispositivo B.
4. En el dispositivo B, pegarlo en `Pegar OFERTA o RESPUESTA →` y tocar `RESPONDER OFERTA`.
5. Copiar la respuesta desde `← Copiar de aquí` y enviarla al dispositivo A.
6. En el dispositivo A, pegar la respuesta y tocar `APLICAR RESPUESTA`.
7. Esperar `ENLACE ACTIVO — ESCUCHANDO` y usar PTT.

La conexión WebRTC no configura servidores STUN/TURN, por lo que ambos dispositivos deben verse directamente en la misma red local.

### 4.5 Estados y mensajes

| Estado | Significado |
| --- | --- |
| `SIN CANAL` | No se inició ninguna sesión de voz. |
| `CONECTANDO...` | Se está iniciando WebRTC y la señalización. |
| `OFERTA PUBLICADA — esperando respuesta` | El dispositivo A publicó la oferta. |
| `ESPERANDO OFERTA...` | El dispositivo B está a la espera. |
| `RESPUESTA LISTA — conectando audio` | El dispositivo B generó la respuesta. |
| `CONECTANDO AUDIO...` | El dispositivo A aplicó la respuesta. |
| `ENLACE ACTIVO — ESCUCHANDO` | Audio listo; micrófono apagado. |
| `HABLANDO — MIC ACTIVO` | PTT presionado; micrófono en uso. |
| `CANAL CERRADO` | Se tocó `COLGAR` o llegó una señal de cierre. |

Si aparece un error con código (`WEBRTC_NO_DISPONIBLE`, `SIN_MIC`, `MIC_PERMISO_DENEGADO`, etc.), revisar la sección de solución de problemas.

### 4.6 Límites del canal de voz

- Semidúplex: no hablar los dos al mismo tiempo.
- No usa malla LoRa ni APRS; es estrictamente Wi-Fi/local.
- El gateway mantiene como máximo 32 señales por sala y descarta señales con más de 10 minutos de antigüedad.
- El tamaño máximo de una señal SDP es 256 KB.
- Los endpoints `/voice/*` no tienen autenticación: cualquier dispositivo en la misma red que conozca la sala puede unirse.
- No se configura STUN/TURN: la comunicación P2P requiere conectividad directa dentro de la red local.

## 5. CLI headless

La CLI opera el mismo stack desde terminal, sin navegador:

```bash
npm run cli -- run --name NODO-A --peer 192.168.0.5:21000 --http-port 8000
```

En otra terminal:

```bash
npm run cli -- status
npm run cli -- nodes
npm run cli -- send HOLA EQUIPO
npm run cli -- doctor --json
```

Para usar el comando `lifeline` directamente:

```bash
npm link
lifeline --help
```

En Android/Termux, evitar `chmod` sobre rutas `/storage/emulated/...`; usar `node bin/lifeline.js` o `npm run cli -- ...`.

La referencia completa está en `docs/CLI.md`.

## 6. Pruebas y diagnóstico

Desde la raíz del repositorio:

```bash
npm test
npm run test:cli
npm run cli -- doctor --json
```

La suite completa debe terminar con 335 pruebas aprobadas y 0 fallos.

## 7. Solución de problemas

| Síntoma | Acción |
| --- | --- |
| Chrome pide permiso de micrófono y falla | Servir por HTTPS o `localhost` y aceptar el permiso. |
| El botón PTT sigue deshabilitado | Esperar a `ENLACE ACTIVO — ESCUCHANDO`; PTT se habilita solo con la conexión activa. |
| No aparece la oferta | Confirmar que ambos usan exactamente la misma sala y que el gateway es alcanzable. |
| `LA SALA YA TIENE OFERTA` | Usar `UNIRSE A SALA` en el segundo dispositivo o cambiar de sala. |
| `SEÑALIZACIÓN SIN CONEXIÓN` | Revisar que el servidor esté corriendo y que `/voice/stream` no esté bloqueado. |
| `NO SE PUDO PUBLICAR` | Usar señalización manual o revisar la conectividad con `/voice/signal`. |
| La interfaz no refleja la nueva versión | Recargar sin caché o desregistrar el service worker. |
| Los dispositivos no se descubren en la red | Confirmar misma red, gateway accesible y UDP/42203 permitido si aplica. |

## 8. Seguridad operativa

- No exponer el gateway a Internet sin autenticación y TLS.
- La sala de voz es un canal abierto dentro de la red local; usar nombres no predecibles.
- El micrófono solo se activa durante PTT; de todos modos, informar a las personas presentes antes de transmitir.
- Para despliegues reales, agregar control de acceso a los endpoints de señalización y una política clara de retención de señales.

## 9. Referencias

- `README.md`: guía rápida y resumen bilingüe.
- `docs/CLI.md`: comandos y opciones de la CLI.
- `docs/DEMO_GUIDE.md`: guía de demostración.
- `docs/ARCHITECTURE_SIMPLIFIED.md`: arquitectura por capas.
- `radio/voice_link.js`: implementación de `VoiceLink`.
- `simulation/simulation/server.js`: endpoints `/voice/signal` y `/voice/stream`.
