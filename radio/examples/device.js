/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Demo de malla RF entre 2 dispositivos
 *
 *  Ejecutar en cada dispositivo (Termux / Linux, misma red Wi-Fi):
 *
 *    Dispositivo A (apunta a B por unicast):
 *        node examples/device.js A <IP-DE-B> [puertoLocal] [puertoPeer]
 *
 *    Dispositivo B (apunta a A por unicast):
 *        node examples/device.js B <IP-DE-A> [puertoLocal] [puertoPeer]
 *
 *  O ambos con broadcast (requiere misma subred y mismo puerto):
 *        node examples/device.js A --broadcast
 *        node examples/device.js B --broadcast
 *
 *  El unicast mutuo es más fiable que el broadcast (que algunas redes
 *  Wi-Fi bloquean). Cada peer se indica como "IP" (usa el puerto por
 *  defecto) o "IP:puerto". Argumentos: NAME [peer...] [localPort]
 *  [defaultPeerPort]. Por defecto todos usan el puerto 21000.
 *
 *  Relays multi-hop: cada dispositivo trae un nodo RELAY. En una cadena
 *  A↔B↔C, un unicast de A a un nodo de C es reenviado por el RELAY de B
 *  (hop 1) y los beacons se re-inundan para que todos aprendan las rutas.
 *  El demo alterna broadcast/unicast al remoto más lejano conocido.
 *  Ejemplo de cadena (3 dispositivos, todos en el puerto 21000):
 *      A: node examples/device.js A <IP-B> 21000 21000
 *      B: node examples/device.js B <IP-A> <IP-C> 21000 21000
 *      C: node examples/device.js C <IP-B> 21000 21000
 *
 *  Cada dispositivo levanta su propia LoRaMesh local (SCOUT + RELAY)
 *  y el UdpBridge reenvía beacons, joins y paquetes DATA al otro.
 *  Ctrl+C para ver estadísticas y salir.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const { LoRaNode, LoRaMesh } = require('../lora_mesh.js');
const { UdpBridge } = require('../udp_bridge.js');

function hashId(name) {
    // Id determinista de 8 hex para distinguir nodos por dispositivo
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

const args = process.argv.slice(2);
const name = (args[0] || 'DEVICE').toUpperCase().slice(0, 8);
const rest = args.slice(1);
const useBroadcast = rest.includes('--broadcast');
const numerics = rest.filter((a) => /^\d+$/.test(a)).map(Number);
const localPort = numerics[0] || 21000;
const defaultPeerPort = numerics[1] || localPort;

// Peers: cada argumento no numérico ni flag es "IP" o "IP:puerto"
const peers = rest
    .filter((a) => a !== '--broadcast' && !/^\d+$/.test(a))
    .map((spec) => {
        const [addr, p] = spec.split(':');
        return { address: addr, port: p ? parseInt(p, 10) : defaultPeerPort };
    });

const SEND_EVERY_MS = 5000;

const mesh = new LoRaMesh({ frequency: 'US915', networkId: `LIFELINE-${hashId(name).slice(0, 4)}` });

const mkNode = (suffix, type, lat, lon) => {
    const n = new LoRaNode({
        id: `${hashId(name).slice(0, 4)}${suffix}`,
        name: `${name}-${type}`,
        type,
        lat, lon,
        maxHops: 5,
        onPacket: (packet) => {
            const dst = packet.destinationId === 'FF:FF:FF:FF' ? 'BROADCAST' : packet.destinationId;
            console.log(`[${name}] ← RECIBIDO ${packet.type} de ${packet.sourceName || packet.sourceId} -> ${dst} (hop ${packet.hopCount})`, packet.payload || '');
        },
        onNodeJoin: (note) => console.log(`[${name}] ← NODE_JOIN ${note.sourceName} (${note.sourceId})`),
    });
    mesh.addNode(n);
    return n;
};

// Nodos locales con posiciones separadas (en km de distancia se respeta rango SF)
mkNode('A1', 'SCOUT', -34.60, -58.38);   // Buenos Aires
mkNode('A2', 'RELAY', -34.61, -58.40);

// Nodo remoto con más hops conocido (para ejercitar el relay multi-hop)
const remoteTarget = () => {
    let best = null;
    mesh.routingTable.forEach((route, nodeId) => {
        if (route.nextHop !== nodeId) { // entrada remota (beacon)
            if (!best || route.hops > best.hops) best = { nodeId, hops: route.hops };
        }
    });
    return best;
};

const bridge = new UdpBridge({
    mesh,
    port: localPort,
    peers,
    broadcast: useBroadcast,
    broadcastPort: localPort,
    networkId: 'LIFELINE-DEMO',
    name,
});

let seq = 0;
const sender = setInterval(() => {
    const scout = mesh.getActiveNodes()[0];
    if (!scout) return;
    seq++;
    const telemetry = { bpm: 70 + (seq % 20), spo2: 97, battery: 100 - (seq % 10) };
    // Cada 3 envíos: unicast al remoto más lejano conocido (activa relays)
    const target = seq % 3 === 0 ? remoteTarget() : null;
    if (target) {
        console.log(`[${name}] → ENVIANDO DATA #${seq} unicast a ${target.nodeId} (hop ${target.hops})`);
        mesh.sendPacket(scout.id, target.nodeId, { device: name, seq, ts: Date.now(), telemetry });
    } else {
        console.log(`[${name}] → ENVIANDO DATA #${seq} (broadcast)`);
        mesh.sendPacket(scout.id, 'FF:FF:FF:FF', { device: name, seq, ts: Date.now(), telemetry });
    }
}, SEND_EVERY_MS);

async function main() {
    await bridge.start();
    mesh.start(); // activa nodos y beaconing (beacons también se reenvían)
    console.log(`[${name}] Malla local lista. Nodos: ${mesh.getActiveNodes().map((n) => n.name).join(', ')}`);
    console.log(`[${name}] Enviando DATA cada ${SEND_EVERY_MS} ms. Ctrl+C para salir.`);
}

function shutdown() {
    clearInterval(sender);
    mesh.stop();
    bridge.close();
    const s = bridge.getStats();
    console.log(`\n[${name}] ESTADÍSTICAS UDP: tx=${s.tx} (${s.txBytes}B) rx=${s.rx} (${s.rxBytes}B) errores=${s.errors}`);
    const m = mesh.getStats();
    console.log(`[${name}] ESTADÍSTICAS MESH: paquetes=${m.totalPackets} entregas=${m.successfulDeliveries} fallidos=${m.failedDeliveries} rutas=${m.routingTableSize}`);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
    console.error(`[${name}] Error fatal:`, err);
    process.exit(1);
});
