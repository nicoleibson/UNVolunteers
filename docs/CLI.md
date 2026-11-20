# Lifeline Core CLI (headless)

La CLI permite operar el stack completo de Lifeline Core desde una terminal, sin
navegador ni motor gráfico. Usa el mismo motor RF, malla UDP, relay HTTP, DTN,
APRS y drivers serie que la aplicación web.

- Requisitos: Node.js >= 18.
- Sin dependencias npm.
- Funciona en Linux, Android/Termux y cualquier terminal POSIX.

## Ejecución

```bash
node bin/lifeline.js <comando> [opciones]
npm run cli -- <comando> [opciones]
```

Para tener el comando `lifeline` en el PATH:

```bash
npm link
lifeline --help
```

## Flujo típico

Terminal 1 — nodo que queda corriendo:

```bash
lifeline run --name NODO-A --peer 192.168.0.5:21000 --http-port 8000
```

Terminal 2 — comandos contra la sesión activa:

```bash
lifeline status
lifeline nodes
lifeline send HOLA EQUIPO
lifeline telemetry --battery 88 --bpm 72 --lat -34.6037 --lon -58.3816
lifeline shutdown
```

La sesión `run` publica un servidor de control en `127.0.0.1` y escribe
`~/.lifeline/session.json` (permisos `0600`). Los comandos de un solo tiro leen
ese archivo para hablar con la sesión en curso.

## Comandos

| Comando | Descripción |
| --- | --- |
| `run` | Inicia un nodo headless con motor RF, malla UDP, relay, HTTP y REPL. |
| `listen` | Igual que `run` pero sin REPL; solo eventos. |
| `serve` | Sirve la PWA/gateway HTTP sin motor RF. |
| `status` | Estado de la sesión activa o de un motor efímero. |
| `send` | Envía un mensaje táctico por la malla. |
| `telemetry` | Envía telemetría con los valores indicados. |
| `nodes` | Lista los nodos reales de la sesión. |
| `ping` | Telemetría unicast a un nodo. |
| `role` | Cambia el rol local (`SCOUT` o `RELAY`). |
| `alert` | Reporta estado de alerta (`VIGILANCE`, `DORMANT`, etc.). |
| `peers` / `peer` | Lista o agrega pares del relay. |
| `messages` | Últimos mensajes recibidos. |
| `config` | Configuración efectiva de la sesión. |
| `whoami` | Identidad local. |
| `clear` | Limpia la consola del REPL. |
| `shutdown` | Detiene la sesión activa. |
| `dtn` | Store-and-forward: `list`, `sync`, `merge`, `clear`, `add`. |
| `decode` | Decodifica una trama hexadecimal (no requiere sesión). |
| `aprs` | Herramientas APRS/AX.25. |
| `radio` | Radio física por puerto serie: `list`, `info`, `tx`, `rx`. |
| `gnss` | Lee NMEA de un GNSS serie. |
| `sdr` | Banco DSP/SDR simulado: `info`, `spectrum`, `tune`. |
| `freq` | Gestor de frecuencias: `stats`, `request`. |
| `doctor` | Diagnóstico del entorno y de los módulos. |
| `state` | Muestra el archivo de sesión activa. |
| `version` | Versión instalada. |
| `help` | Ayuda. |

## `run` / `listen`

```bash
lifeline run [opciones]
```

| Opción | Descripción |
| --- | --- |
| `--name <texto>` | Nombre visible del nodo. |
| `--id <hex>` | ID de nodo (se deriva del nombre si se omite). |
| `--network <texto>` | Red lógica (por defecto `LIFELINE-001`). |
| `--role SCOUT\|RELAY` | Rol local. |
| `--alert <estado>` | Estado de alerta inicial. |
| `--dormant` | Inicia en `DORMANT`. |
| `--key <32 hex>` | Clave AES-128. También `LIFELINE_KEY`. |
| `--peer <host:puerto>` | Par UDP; repetible. |
| `--udp-port <n>` | Puerto UDP local (por defecto `21000`). |
| `--http-port <n>` | Puerto HTTP local (por defecto `8000`; `0` = efímero). |
| `--no-http` | Desactiva el gateway HTTP. |
| `--no-udp` | Desactiva la malla UDP. |
| `--no-dtn` | Desactiva el almacén DTN. |
| `--no-discovery` | Desactiva el descubrimiento de pares. |
| `--relay <url>` | URL del relay HTTP (si se omite, usa el HTTP local). |
| `--peer-url <url>` | Par manual del relay; repetible. |
| `--radio-port <dev>` | Puerto serie de la radio LoRa (ej. `/dev/ttyUSB0`). |
| `--radio-baud <n>` | Baudios de la radio (por defecto `115200`). |
| `--gnss-port <dev>` | Puerto serie del GNSS. |
| `--gnss-baud <n>` | Baudios del GNSS (por defecto `9600`). |
| `--callsign <texto>` | Callsign APRS. |
| `--lat/--lon/--alt <n>` | Posición inicial. |
| `--state-dir <dir>` | Directorio de estado (por defecto `~/.lifeline`). |
| `--exec "<cmds>"` | Ejecuta comandos separados por `;` y termina. |
| `--no-repl` | No abre el REPL. |
| `--json` | Salida NDJSON. |
| `--quiet` | Solo salida de datos. |
| `--verbose` | Incluye logs de depuración. |

Ejemplos:

```bash
lifeline run --name NODO-A --peer 192.168.0.5:21000 --http-port 8000
lifeline run --name NODO-B --peer 192.168.0.4:21000 --http-port 8001 --no-repl
lifeline run --exec "status; nodes; send HOLA EQUIPO" --no-udp --http-port 0
lifeline run --name RELAY --role RELAY --radio-port /dev/ttyUSB0 --gnss-port /dev/ttyUSB1
```

### REPL

Dentro de `run` (sin `--no-repl`) hay un prompt `lifeline>` con los mismos
comandos que la CLI, más `help`, `clear`, `quit` y `exit`.

## Comandos de un solo tiro

Si hay una sesión activa, estos comandos se ejecutan dentro de ella; si no,
algunos crean un motor efímero local (por ejemplo `status`, `send` y
`telemetry`).

```bash
lifeline status --json
lifeline send "HOLA EQUIPO" --to FF:FF:FF:FF
lifeline telemetry --battery 88 --bpm 72 --spo2 97 --depth 12.5
lifeline ping 036A77A4DC1C2200 --battery 50
lifeline role RELAY
lifeline alert DORMANT
lifeline nodes
lifeline peers
```

## DTN

```bash
lifeline dtn list
lifeline dtn sync
lifeline dtn add 036A77A4DC1C2200 --data '{"battery":50}'
lifeline dtn merge ./beacons.json
lifeline dtn clear
```

## APRS y tramas

```bash
lifeline aprs position --callsign LU1AAA --lat -34.6037 --lon -58.3816
lifeline aprs message LU2BBB "HOLA" --callsign LU1AAA
lifeline aprs status "EN BASE" --callsign LU1AAA
lifeline aprs ax25 --callsign LU1AAA --info "HOLA"
lifeline aprs decode <hex>
lifeline decode <hex>
```

`decode` acepta `--key` y `--encryption`; por defecto usa AES-CTR y la clave de
demo.

## Radio física y GNSS

Web Serial no existe en una terminal. La radio se abre como puerto serie POSIX
con `stty` y streams de Node:

```bash
lifeline radio list
lifeline radio info --port /dev/ttyUSB0 --baud 115200
lifeline radio tx 486F6C61 --port /dev/ttyUSB0 --freq 915000000
lifeline radio rx --port /dev/ttyUSB0 --timeout 30000
lifeline gnss read --port /dev/ttyUSB1 --baud 9600
```

En Android/Termux puede hacer falta `termux-usb` o un gateway que exponga el
puerto físico. Si no hay hardware, los comandos fallan de forma explícita; no se
inventan lecturas.

## SDR y frecuencias

El banco SDR es una simulación DSP honesta, no controla un RTL-SDR:

```bash
lifeline sdr info
lifeline sdr spectrum --freq 433 --sample-rate 96000
lifeline sdr tune 144.390
lifeline freq stats --region AMERICAS
lifeline freq request --type DATA --priority 2 --bandwidth 125000
```

## Salida para scripts

- `--json`: una línea JSON por evento en stdout; logs y advertencias van a
  stderr. Es seguro para `jq`.
- `--quiet`: silencia logs; solo salida solicitada.
- `--verbose`: agrega logs de depuración.
- Código de salida `0` en éxito, `1` en error.

Ejemplo:

```bash
lifeline status --json | jq -r '.id, .role, .engine.nodes | length'
lifeline aprs position --callsign LU1AAA --lat -34.6 --lon -58.4 --json | jq -r .hex
```

## Estado y servidor de control

- Archivo: `~/.lifeline/session.json` (o `$LIFELINE_STATE_DIR/session.json`,
  o `--state-dir`), modo `0600`.
- Contiene PID, puertos, token y metadatos de la sesión.
- El servidor de control escucha solo en `127.0.0.1`.
- Rutas: `GET /status`, `GET /health`, `POST /exec`, `POST /shutdown`.
- Todas requieren el header `x-lifeline-token` con el token del archivo.
- Al detener la sesión, el archivo se borra.

```bash
lifeline state
lifeline state --json
```

## Diagnóstico

```bash
lifeline doctor
lifeline doctor --json
```

Verifica versión de Node, plataforma, Termux, herramientas `termux-*`, puertos
serie, módulos y sesión activa.

## Seguridad

- Sin `--key` se usa la clave AES de demo (`2b7e…4f3c`), marcada como `DEMO`.
  No es apta para producción; en campo usá una clave única de 32 hex.
- El servidor de control está limitado a loopback y protegido por token.
- El archivo de estado se escribe con permisos `0600` cuando el sistema de
  archivos lo permite.
- La PWA/gateway HTTP sigue disponible para operadores con navegador.

## Limitaciones conocidas

- El SDR es simulado; no controla hardware.
- La radio física requiere un dispositivo serie accesible.
- Sin hardware GNSS no hay fix; los campos quedan en `null` (no se inventan).
- En almacenamiento emulado de Android el bit de ejecución puede no aplicarse;
  usá `node bin/lifeline.js` o `npm run cli`.

## Pruebas

```bash
npm run test:cli
npm test
```
