/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — UDP Bridge (cross-device) v1.0
 *  Puente de transporte para enlazar dos procesos/devices del
 *  stack LoRa Mesh por UDP (LAN). Cero dependencias (dgram).
 *
 *  Conecta la simulación en memoria de `LoRaMesh` con otro
 *  dispositivo: cuando un nodo local transmite (DATA/BEACON/
 *  NODE_JOIN), el frame se reenvía por UDP; el extremo receptor
 *  lo inyecta en su malla local y deja correr dedup/hops/relay.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const dgram = require('dgram');

const PROTO_VERSION = 1;
const DEFAULT_PORT = 21000;

/**
 * @param {object} opts
 * @param {import('./lora_mesh.js').LoRaMesh} opts.mesh  Malla local a enlazar.
 * @param {number}  [opts.port]          Puerto UDP local (0 = efímero).
 * @param {Array<{address: string, port: number}>} [opts.peers]  Peers unicast.
 * @param {boolean} [opts.broadcast]     Enviar también por broadcast 255.255.255.255.
 * @param {number}  [opts.broadcastPort] Puerto de broadcast (def: port).
 * @param {string}  [opts.networkId]     Filtro de red (ignora mensajes de otras).
 * @param {string}  [opts.name]          Nombre del dispositivo (para logs/demo).
 * @param {string}  [opts.instanceId]    Id único de instancia (para no auto-eco).
 */
class UdpBridge {
    constructor(opts = {}) {
        this.mesh = opts.mesh;
        this.port = opts.port !== undefined ? opts.port : DEFAULT_PORT;
        this.peers = opts.peers || [];
        this.broadcast = !!opts.broadcast;
        this.broadcastPort = opts.broadcastPort || this.port;
        this.networkId = opts.networkId || 'LIFELINE-001';
        this.name = opts.name || 'DEVICE';
        this.instanceId = opts.instanceId || Math.random().toString(36).slice(2, 12);
        this.socket = null;
        this.stats = { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, errors: 0 };
        this.forwardedPackets = new Set(); // dedup de relays reenviados
        this._orig = {};
        this._hookMesh();
    }

    /** Envuelve la malla para capturar transmisiones locales. */
    _hookMesh() {
        const self = this;
        const mesh = this.mesh;

        // Paquetes DATA: se reenvía el frame en la primera propagación
        // (visited vacío) para no duplicar en cada salto local.
        this._orig.propagatePacket = mesh.propagatePacket.bind(mesh);
        mesh.propagatePacket = function (senderNode, packet, visited) {
            if (!visited || visited.size === 0) {
                self._sendFrame(packet, 'DATA');
            }
            return self._orig.propagatePacket(senderNode, packet, visited);
        };

        // Beacons: un beacon local (sourceId === node.id) se reenvía una sola
        // vez. El dedup de forwardedPackets distingue el beacon generado
        // localmente del eco que vuelve tras el re-flood de un peer.
        this._orig.processBeacon = mesh.processBeacon.bind(mesh);
        mesh.processBeacon = function (node, beacon) {
            if (beacon && beacon.payload && beacon.payload.sourceId === node.id) {
                const bid = self._beaconId(beacon);
                if (!bid || !self.forwardedPackets.has(bid)) {
                    self._sendFrame(beacon, 'BEACON');
                    if (bid) self.forwardedPackets.add(bid);
                }
            }
            return self._orig.processBeacon(node, beacon);
        };

        // NODE_JOIN: se reenvía la notificación de alta.
        this._orig.broadcastNodeJoin = mesh.broadcastNodeJoin.bind(mesh);
        mesh.broadcastNodeJoin = function (node) {
            self._sendFrame({
                type: 'NODE_JOIN',
                sourceId: node.id,
                sourceName: node.name,
                sourceType: node.type,
                timestamp: Date.now(),
            }, 'NODE_JOIN');
            return self._orig.broadcastNodeJoin(node);
        };
    }

    /**
     * Abre el socket UDP y comienza a escuchar.
     * @returns {Promise<UdpBridge>} resuelve cuando el socket escucha.
     */
    start() {
        return new Promise((resolve, reject) => {
            if (this.socket) return resolve(this);
            const socket = dgram.createSocket('udp4');

            socket.on('listening', () => {
                if (this.broadcast) socket.setBroadcast(true);
                this.socket = socket;
                const addr = socket.address();
                console.log(`[${this.name}] UDP escuchando en ${addr.address}:${addr.port} (red ${this.networkId})`);
                if (this.broadcast) {
                    console.log(`[${this.name}] Broadcast habilitado a 255.255.255.255:${this.broadcastPort}`);
                }
                if (this.peers.length) {
                    console.log(`[${this.name}] Peers: ${this.peers.map((p) => `${p.address}:${p.port}`).join(', ')}`);
                }
                resolve(this);
            });

            socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
            socket.on('error', (err) => {
                this.stats.errors++;
                console.error(`[${this.name}] UDP error: ${err.message}`);
                reject(err);
            });

            socket.bind(this.port);
        });
    }

    /** Serializa y envía un frame hacia peers / broadcast. */
    _sendFrame(frame, kind) {
        if (!this.socket) return; // socket aún sin bind
        let buf;
        try {
            buf = Buffer.from(JSON.stringify({
                v: PROTO_VERSION,
                instanceId: this.instanceId,
                name: this.name,
                networkId: this.networkId,
                kind,
                frame,
            }));
        } catch (err) {
            this.stats.errors++;
            console.error(`[${this.name}] No se pudo serializar frame ${kind}: ${err.message}`);
            return;
        }
        const sent = () => { this.stats.tx++; this.stats.txBytes += buf.length; };
        if (this.broadcast) {
            this.socket.send(buf, 0, buf.length, this.broadcastPort, '255.255.255.255', sent);
        }
        this.peers.forEach((peer) => {
            this.socket.send(buf, 0, buf.length, peer.port, peer.address, sent);
        });
    }

    /** Maneja datagrama entrante (filtra auto-eco y otras redes). */
    _onMessage(msg, rinfo) {
        let env;
        try {
            env = JSON.parse(msg.toString('utf8'));
        } catch {
            this.stats.errors++;
            return;
        }
        if (env.instanceId === this.instanceId) return; // auto-eco
        if (env.networkId !== this.networkId) return; // otra red en la LAN
        if (env.v !== PROTO_VERSION || !env.frame) return;

        this.stats.rx++;
        this.stats.rxBytes += msg.length;
        this._dispatch(env.kind, env.frame, env);
    }

    /** Id sintético de beacon (sourceId:timestamp) para dedup del re-flood. */
    _beaconId(frame) {
        const p = frame && frame.payload;
        if (!p || !p.sourceId || !p.timestamp) return null;
        return `b:${p.sourceId}:${p.timestamp}`;
    }

    /** Inyecta el frame recibido en la malla local. */
    _dispatch(kind, frame, env) {
        const mesh = this.mesh;
        switch (kind) {
            case 'BEACON': {
                // Actualiza rutas y re-inunda a los peers (flooding de beacons),
                // con dedup para que en una cadena A↔B↔C, A aprenda a C.
                this.mesh.nodes.forEach((node) => mesh.processBeacon(node, frame));
                const bid = this._beaconId(frame);
                if (bid && !this.forwardedPackets.has(bid)) {
                    this.forwardedPackets.add(bid);
                    this._sendFrame(frame, 'BEACON');
                }
                break;
            }
            case 'NODE_JOIN':
                this.mesh.nodes.forEach((node) => {
                    if (node.onNodeJoin) node.onNodeJoin(frame);
                });
                break;
            case 'DATA':
            default: {
                const relays = [];
                this.mesh.nodes.forEach((node) => {
                    const result = node.processPacket(frame);
                    if (!result) return;
                    // Un frame de relay devuelto por un nodo RELAY lleva header
                    // y payload.relayId; un paquete entregado no tiene header.
                    if (result.header && result.payload && result.payload.relayId) {
                        relays.push(result);
                        console.log(`[${this.name}] ${node.name} reenvía (relay hop ${result.payload.hopCount})`);
                    } else {
                        console.log(`[${this.name}] Paquete de ${env.name || 'remoto'} entregado a ${node.name}`);
                    }
                });
                relays.forEach((relay) => this._forwardRelay(relay));
                break;
            }
        }
    }

    /** Reenvía un relay por UDP (con dedup para evitar inundar). */
    _forwardRelay(frame) {
        const pid = frame.payload && frame.payload.packetId;
        if (pid && this.forwardedPackets.has(pid)) return;
        if (pid) {
            this.forwardedPackets.add(pid);
            if (this.forwardedPackets.size > 1024) {
                this.forwardedPackets.delete(this.forwardedPackets.values().next().value);
            }
        }
        this._sendFrame(frame, 'DATA');
    }

    /** Restaura la malla y cierra el socket. */
    close() {
        if (this._orig.propagatePacket) this.mesh.propagatePacket = this._orig.propagatePacket;
        if (this._orig.processBeacon) this.mesh.processBeacon = this._orig.processBeacon;
        if (this._orig.broadcastNodeJoin) this.mesh.broadcastNodeJoin = this._orig.broadcastNodeJoin;
        if (this.socket) {
            try { this.socket.close(); } catch { /* ya cerrado */ }
            this.socket = null;
        }
        return this;
    }

    getStats() {
        return { ...this.stats };
    }
}

module.exports = { UdpBridge, DEFAULT_PORT, PROTO_VERSION };
