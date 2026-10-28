#!/bin/sh
# Project Lifeline Core — Etapa 1 (gateways de borde)
# Instala el gateway en una Raspberry Pi / Orange Pi (RPi OS / Debian/Ubuntu):
#  1) copia el repo a /opt/lifeline
#  2) configura AP Wi-Fi (hostapd) + DNS/DHCP (dnsmasq) con portal cautivo
#  3) instala el servicio systemd lifeline (server.js, PORT=8000)
#  4) valida el despliegue (suite + endpoints HTTP)
#
# Uso (como root):  sh tools/install_gateway.sh [SSID] [PASS]
# Requisitos: Node.js >= 18 instalado, interfaz wlan0 libre.
set -eu

SSID="${1:-LIFELINE}"
PASS="${2:-emergencia2026}"
DEST="/opt/lifeline"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
IFACE="wlan0"
GATEWAY_IP="10.10.0.1"

echo "==> [1/6] Copiando el proyecto a $DEST"
mkdir -p "$DEST"
rsync -a --delete "$REPO_DIR/" "$DEST/"

echo "==> [2/6] Verificando Node.js y la suite"
(cd "$DEST" && node --version)
(cd "$DEST" && node --test "test/*.test.js" >/tmp/lifeline-suite.log 2>&1 || {
    echo "FALLO en la suite automatizada — revisar /tmp/lifeline-suite.log" >&2; exit 1; })
echo "    suite PASS (revisar /tmp/lifeline-suite.log)"

echo "==> [3/6] Configurando AP Wi-Fi (hostapd + dnsmasq)"
apt-get install -y --no-install-recommends hostapd dnsmasq >/dev/null

cat >/etc/hostapd/hostapd.conf <<EOF
interface=$IFACE
driver=nl80211
ssid=$SSID
hw_mode=g
channel=6
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=$PASS
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF
sed -i "s/^#\?DAEMON_CONF=.*/DAEMON_CONF=\"\/etc\/hostapd\/hostapd.conf\"/" /etc/default/hostapd 2>/dev/null || true

cat >/etc/dnsmasq.conf <<EOF
interface=$IFACE
dhcp-range=10.10.0.10,10.10.0.200,255.255.255.0,1h
dhcp-option=option:router,$GATEWAY_IP
dhcp-option=option:dns-server,$GATEWAY_IP
address=/#/$GATEWAY_IP
EOF

cat >/etc/systemd/network/lifeline-wlan0.network <<EOF
[Match]
Name=$IFACE

[Network]
Address=$GATEWAY_IP/24
EOF

systemctl unmask hostapd >/dev/null 2>&1 || true
systemctl enable hostapd dnsmasq >/dev/null

echo "==> [4/6] Instalando el servicio systemd lifeline"
cp "$DEST/simulation/simulation/tools/lifeline.service" /etc/systemd/system/lifeline.service
systemctl daemon-reload
systemctl enable lifeline >/dev/null

echo "==> [5/6] Arrancando servicios"
systemctl restart hostapd dnsmasq lifeline

echo "==> [6/6] Verificación"
sleep 2
printf '    %-28s ' 'GUI (index_integrated.html):'
curl -sf -o /dev/null "http://$GATEWAY_IP:8000/" && echo OK || echo "FALLO (ver 'systemctl status lifeline')"
printf '    %-28s ' 'manifest.webmanifest:'
curl -sf -o /dev/null "http://$GATEWAY_IP:8000/manifest.webmanifest" && echo OK || echo FALLO
printf '    %-28s ' 'service worker (sw.js):'
curl -sf -o /dev/null "http://$GATEWAY_IP:8000/sw.js" && echo OK || echo FALLO
printf '    %-28s ' 'icono PWA 512:'
curl -sf -o /dev/null "http://$GATEWAY_IP:8000/icons/icon-512.png" && echo OK || echo FALLO

echo
echo "Listo. Conecta un teléfono al Wi-Fi '$SSID' y abre http://$GATEWAY_IP:8000"
echo "(el portal cautivo redirige cualquier URL al panel; PWA instalable en Chrome/Safari)."
