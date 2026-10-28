# Gateway de borde — Proyecto Lifeline Core (Etapa 1)

Documento de despliegue: convertir una **Raspberry Pi / Orange Pi** (o
cualquier SBC Linux con Wi-Fi) en una pasarela táctica de emergencia que
cualquier civil alcanza **sin instalar nada**: un AP Wi-Fi propio + la GUI
de `server.js` + **PWA instalable que funciona offline**.

> Aunque el Internet caiga, el gateway sigue dando servicio en su propia red.

---

## 1. Qué se despliega

```
┌────────────────────────── SBC (RPi / OPi) ─────────────────────────┐
│  AP Wi-Fi "LIFELINE" (hostapd + dnsmasq)      │  10.10.0.1/24       │
│      │                                        │                     │
│  Teléfonos/PCs del equipo se conectan al AP   │                     │
│      │                                        │                     │
│  ┌────▼───────────────────────────┐   ┌──────▼───────────┐          │
│  │  server.js (PORT=8000)         │   │  Node.js ≥ 18    │          │
│  │  - GUI: index_integrated.html  │   │  systemd unit     │          │
│  │  - /rf/* (stack RF real)       │   │  Restart=always   │          │
│  │  - PWA: manifest + sw.js       │   │                   │          │
│  │  - relay SSE/POST + UDP descub. │   └──────────────────┘          │
│  └────────────────────────────────┘                                │
└───────────────────────────────────────────────────────────────────┘
```

Cada dispositivo de la red puede correr su PROPIO `server.js` (malla HTTP
descentralizada); el gateway es el nodo fijo que da cobertura a los civiles
sin configuración.

---

## 2. Requisitos

- SBC Linux con Wi-Fi que soporte AP (Raspberry Pi 3/4/5, Orange Pi Zero 2W,
  NanoPi...). RPi OS Lite (64 bits) recomendado.
- Node.js ≥ 18 (probado en Node 26.4.0).
- Alimentación estable y, para el escenario real, antena externa y batería UPS.

---

## 3. Instalación de Node.js (sin Internet externo, desde apt)

```sh
sudo apt update && sudo apt install -y nodejs npm hostapd dnsmasq git
node -v   # ≥ 18 (en RPi OS Bookworm: Node 18)
```

Si apt trae una versión vieja, descargar el binario oficial a mano
(https://nodejs.org) o usar nvm antes de perder la conectividad.

---

## 4. Copiar el proyecto

```sh
sudo mkdir -p /opt/lifeline
sudo rsync -a --delete ./ /opt/lifeline/          # copiar el repo a /opt/lifeline
cd /opt/lifeline
node --test "test/*.test.js"                       # suite completa debe pasar
```

---

## 5. AP Wi-Fi (hostapd + dnsmasq)

El gateway crea su PROPIA red, no depende de proveedores. SSID recomendado:
`LIFELINE` (o `LIFELINE-<sector>`). Sin Internet de salida: los clientes solo
ven el gateway.

`/etc/hostapd/hostapd.conf`:

```ini
interface=wlan0
driver=nl80211
ssid=LIFELINE
hw_mode=g
channel=6
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=emergencia2026
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
```

> Escenario real: cambiar `wpa_passphrase`. En desastre sin red eléctrica el
> AP puede dejarse abierto (`auth_algs=1` sin `wpa=`) para máxima cobertura.

Habilitar hostapd y dnsmasq:

```sh
sudo systemctl enable --now hostapd
sudo systemctl unmask hostapd
```

`/etc/dnsmasq.conf` (el gateway también sirve DNS y DHCP en su rango):

```ini
interface=wlan0
dhcp-range=10.10.0.10,10.10.0.200,255.255.255.0,1h
dhcp-option=option:router,10.10.0.1
dhcp-option=option:dns-server,10.10.0.1
address=/#/10.10.0.1
```

> `address=/#/` **cautiva** todo el DNS: cualquier URL que escriba un cliente
> resuelve al gateway. Ideal para civiles que teclean cualquier cosa y llegan
> a la GUI (ver §7, "portal cautivo").

`/etc/network/interfaces.d/wlan0` o Netplan equivalente:

```ini
auto wlan0
iface wlan0 inet static
    address 10.10.0.1
    netmask 255.255.255.0
```

---

## 6. Servicio systemd para server.js

`/etc/systemd/system/lifeline.service`:

```ini
[Unit]
Description=Project Lifeline Core — gateway de borde
After=network.target hostapd.service dnsmasq.service

[Service]
Type=simple
WorkingDirectory=/opt/lifeline/simulation/simulation
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
Environment=PORT=8000
Environment=HOST=0.0.0.0
# Identidad del gateway para la malla descentralizada
Environment=LIFELINE_LABEL=GATEWAY

[Install]
WantedBy=multi-user.target
```

Activar:

```sh
sudo systemctl enable --now lifeline
sudo systemctl status lifeline
curl -s http://10.10.0.1:8000/ | head -3
```

El servidor ya escucha en **todas las interfaces** (HOST=0.0.0.0) y sirve
`index_integrated.html` en `/` + el stack RF real en `/rf/`.

---

## 7. Uso desde un teléfono (sin instalar apps)

1. El civil se conecta al Wi-Fi `LIFELINE`.
2. Abre cualquier navegador y escribe `http://10.10.0.1:8000` (o cualquier URL:
   el portal cautivo `address=/#/` lo lleva a la GUI igualmente).
3. **PWA instalable** (más rápido al próximo acceso):
   - **Android/Chrome**: menú ⋮ → "Instalar aplicación" (o "Agregar a pantalla
     de inicio").
   - **iOS/Safari**: botón Compartir → "Agregar a pantalla de inicio".
   - **PC/Chrome**: icono de instalación en la barra de direcciones.
4. Instalada, la GUI se abre como app **sin navegador** y **funciona offline**
   (el service worker cachea la app shell; la telemetría del relay se obtiene
   solo cuando hay señal al server).

---

## 8. Verificación manual post-despliegue

| Qué | Cómo | Esperado |
|---|---|---|
| GUI en el AP | `curl http://10.10.0.1:8000/` | HTML con `<link rel="manifest">` |
| Manifest | `curl -I http://10.10.0.1:8000/manifest.webmanifest` | `Content-Type: application/manifest+json` |
| Service worker | `curl -I http://10.10.0.1:8000/sw.js` | `Content-Type: text/javascript`, 200 |
| Iconos | `curl -I http://10.10.0.1:8000/icons/icon-512.png` | `image/png`, 200 |
| Alias RF | `curl -I http://10.10.0.1:8000/rf/lora_mesh.js` | 200 |
| Relay | `curl -N http://10.10.0.1:8000/relay/stream` | `text/event-stream` con heartbeat |

Suite de referencia: `node --test "test/*.test.js"` → **PASS=190 FAIL=0**
(+ `test/pwa.test.js` valida manifest/sw/index/iconos).

---

## 9. Seguridad y modelo de confianza

- **Red LAN sin autenticación**: el panel asume una zona de desastre con
  confianza mutua entre dispositivos del mismo `networkId`. No expongas
  `PORT=8000` a Internet.
- El cifrado de las tramas es **AES-128-CTR + MIC CMAC** (`packet_encoder.js`)
  — la telemetría viaja cifrada incluso en esta LAN abierta.
- Si hay Internet de salida, bloquear salidas no esenciales del gateway
  (solo 8000/tcp local). El relay cross-device corre **por UDP 42203**
  (broadcast de descubrimiento) y **HTTP 8000** en la LAN.
- Cambiar `wpa_passphrase`, `LIFELINE_LABEL` y `networkId` por sector.

---

## 10. Roadmap vinculado (Etapa 1 → próximas)

- [x] PWA instalable (manifest + service worker + iconos 192/512).
- [x] Documento de despliegue gateway (este archivo).
- [ ] Soporte de varios APs en cascada (gateway satelital) y GNSS dedicado
      (Etapa 0 pendiente) para coordinar rutas por posición.
- [ ] Actuador de alerta temprana (relés RF → sirenas) al recibir alertas
      P-Wave validadas.
- [ ] Módems satelitales (Iridium SBD / Swarm / Astrocast) como capa 4.
