'use strict';

const fs = require('fs');
const path = require('path');

const { createEngine } = require('../simulation/simulation/lifeline_engine.js');
const { UdpBridge } = require('../radio/udp_bridge.js');
const { RelayAdapter } = require('../simulation/simulation/relay_adapter.js');
const { createServer } = require('../simulation/simulation/server.js');
const { LoRaRadioDriver } = require('../radio/radio_driver.js');
const { GnssReader } = require('../radio/gnss_reader.js');
const { NodeEventSource } = require('./node_event_source.js');
const { NodeSerialLineTransport } = require('./node_serial.js');
const control = require('./control.js');

const DEFAULT_KEY = '2b7e151628aed2a6abf7158809cf4f3c';
const DEFAULT_NETWORK = 'LIFELINE-001';
const DEFAULT_UDP_PORT = 21000;
const DEFAULT_HTTP_PORT = 8000;

function hexIdFromName(name) {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    const text = String(name || 'LIFELINE');
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a ^= c; a = Math.imul(a, 0x01000193);
        b ^= c + i; b = Math.imul(b, 0x85ebca6b);
    }
    const left = (a >>> 0).toString(16).padStart(8, '0');
    const right = (b >>> 0).toString(16).padStart(8, '0');
    return (left + right).toUpperCase();
}

function normalizeId(value, name) {
    const raw = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (raw.length === 16) return raw;
    return hexIdFromName(name);
}

function maskKey(key) {
    const text = String(key || '');
    if (text.length <= 8) return '****';
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function createSnapshot(args = {}, base = {}) {
    const lat = numberOrNull(args.lat) != null ? numberOrNull(args.lat) : (base.gps ? base.gps.lat : null);
    const lon = numberOrNull(args.lon) != null ? numberOrNull(args.lon) : (base.gps ? base.gps.lon : null);
    const alt = numberOrNull(args.alt) != null ? numberOrNull(args.alt) : (base.gps ? base.gps.alt : null);
    const pressureHpa = numberOrNull(args.pressure) != null ? numberOrNull(args.pressure) : null;
    return {
        gps: { lat, lon, alt },
        pressure: pressureHpa != null ? pressureHpa * 100 : (base.pressure != null ? base.pressure : null),
        bpm: numberOrNull(args.bpm) != null ? numberOrNull(args.bpm) : (base.bpm != null ? base.bpm : null),
        spo2: numberOrNull(args.spo2) != null ? numberOrNull(args.spo2) : (base.spo2 != null ? base.spo2 : null),
        battery: numberOrNull(args.battery) != null ? numberOrNull(args.battery) : (base.battery != null ? base.battery : null),
        depth_m: numberOrNull(args.depth) != null ? numberOrNull(args.depth) : (base.depth_m != null ? base.depth_m : null),
        tilt: numberOrNull(args.tilt) != null ? numberOrNull(args.tilt) : (base.tilt != null ? base.tilt : null),
        light: numberOrNull(args.light) != null ? numberOrNull(args.light) : (base.light != null ? base.light : null),
        mic: numberOrNull(args.mic) != null ? numberOrNull(args.mic) : (base.mic != null ? base.mic : null),
        role: args.role || base.role || 'UNKNOWN',
        ...(args.msg != null ? { msg: String(args.msg) } : {}),
    };
}

function createDtnFileIO(filePath) {
    const dir = path.dirname(filePath);
    function readMap() {
        try {
            const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return value && typeof value === 'object' ? value : {};
        } catch (e) {
            return {};
        }
    }
    function writeMap(map) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(map), { mode: 0o600 });
        } catch (e) { /* el store no debe romper la sesión */ }
    }
    return {
        get(key) { const map = readMap(); return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null; },
        set(key, value) { const map = readMap(); map[key] = value; writeMap(map); },
        remove(key) { const map = readMap(); delete map[key]; writeMap(map); },
        filePath,
    };
}

function parsePeers(raw, defaultPort) {
    const values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return values.map((spec) => {
        const text = String(spec);
        const idx = text.lastIndexOf(':');
        if (idx > 0 && /^\d+$/.test(text.slice(idx + 1))) {
            return { address: text.slice(0, idx), port: Number(text.slice(idx + 1)) };
        }
        return { address: text, port: defaultPort };
    }).filter((p) => p.address);
}

function createSession(opts = {}) {
    const out = opts.output;
    if (!out) throw new Error('createSession requiere output');
    const name = opts.name || 'LIFELINE-CLI';
    const id = normalizeId(opts.id, name);
    const networkId = opts.networkId || DEFAULT_NETWORK;
    const udpPort = opts.udpPort != null ? Number(opts.udpPort) : DEFAULT_UDP_PORT;
    let httpPort = opts.httpPort != null ? Number(opts.httpPort) : DEFAULT_HTTP_PORT;
    const httpEnabled = opts.http !== false;
    const udpEnabled = opts.udp !== false;
    const dtnEnabled = opts.dtn !== false;
    const stateDir = opts.stateDir;
    const dtnFile = opts.dtnFile || path.join(control.stateDir({ stateDir }), 'dtn.json');
    const key = opts.key || process.env.LIFELINE_KEY || DEFAULT_KEY;
    const keyDefault = key === DEFAULT_KEY;
    const instanceId = opts.instanceId || id.slice(0, 12).toLowerCase();

    const session = {
        name,
        id,
        networkId,
        instanceId,
        udpPort,
        httpPort,
        httpEnabled,
        udpEnabled,
        key,
        keyDefault,
        role: opts.role === 'RELAY' ? 'RELAY' : 'SCOUT',
        alertState: opts.dormant ? 'DORMANT' : (opts.alertState || 'VIGILANCE'),
        startedAt: null,
        started: false,
        messages: [],
        gps: opts.lat != null || opts.lon != null ? {
            lat: numberOrNull(opts.lat),
            lon: numberOrNull(opts.lon),
            alt: numberOrNull(opts.alt),
        } : null,
        baseSnapshot: opts.snapshot || null,
        engine: null,
        bridge: null,
        relay: null,
        server: null,
        control: null,
        controlUrl: null,
        token: null,
        radio: null,
        gnss: null,
        timers: [],
    };

    const engine = createEngine({
        key,
        encryption: opts.encryption || 'AES-CTR',
        callsign: opts.callsign || null,
        region: opts.region || 'AMERICAS',
        frequency: opts.frequency || 'US915',
        lat: session.gps ? session.gps.lat : null,
        lon: session.gps ? session.gps.lon : null,
        alt: session.gps ? session.gps.alt : null,
        battery: numberOrNull(opts.battery),
        nodeName: name,
        loraId: id,
        nodeTtlMs: opts.nodeTtlMs,
        sdrFreq: opts.sdrFreq != null ? Number(opts.sdrFreq) * 1e6 : undefined,
        dtn: dtnEnabled,
        dtnIO: dtnEnabled ? createDtnFileIO(dtnFile) : undefined,
        onLog: (channel, message) => {
            out.log(channel, message);
            if (opts.onLog) {
                try { opts.onLog(channel, message); } catch (e) { /* no romper */ }
            }
        },
    });
    if (!engine.ready) {
        throw new Error('MOTOR_NO_DISPONIBLE (faltan módulos RF)');
    }
    engine.setLocalRole(session.role);
    session.engine = engine;
    session.dtnFile = dtnFile;

    const previousOnPacket = engine.localNode.onPacket;
    engine.localNode.onPacket = (packet) => {
        let result = null;
        try { result = previousOnPacket ? previousOnPacket(packet) : null; } catch (e) {
            out.error(`RX inválida: ${e.message}`);
        }
        if (packet) {
            let payload = null;
            if (packet.payload && packet.payload.trama_hex) {
                payload = { trama_hex: packet.payload.trama_hex.slice(0, 32) + (packet.payload.trama_hex.length > 32 ? '…' : '') };
            } else if (packet.payload) {
                payload = packet.payload;
            }
            out.event('packet', {
                type: packet.type || 'DATA',
                fromId: packet.sourceId || null,
                fromName: packet.sourceName || null,
                to: packet.destinationId || null,
                hop: packet.hopCount || 0,
                payload,
            });
        }
        return result;
    };

    engine.onIntercomMessage = ({ fromId, fromName, msg }) => {
        const message = { at: Date.now(), fromId, fromName, message: String(msg) };
        session.messages.push(message);
        if (session.messages.length > 200) session.messages.shift();
        out.event('message', message);
    };

    if (udpEnabled) {
        session.bridge = new UdpBridge({
            mesh: engine.mesh,
            port: udpPort,
            peers: parsePeers(opts.peer, udpPort),
            broadcast: !!opts.broadcast,
            broadcastPort: udpPort,
            networkId,
            name,
            instanceId,
        });
    }

    const relayUrl = opts.relayUrl || null;
    if (relayUrl) {
        session.relay = new RelayAdapter({
            mesh: engine.mesh,
            instanceId,
            networkId,
            name,
            relayUrl,
            EventSource: NodeEventSource,
            onMessage: (envelope) => {
                out.debug('relay', `RX ${envelope.kind || 'DATA'} de ${envelope.name || 'par'}`);
            },
            onPeersChange: (peers) => {
                out.event('peers', { peers: peers.map((p) => ({ url: p.url, label: p.label, state: p.state })) });
            },
            onLog: (channel, message) => out.log(channel, message),
        });
    }

    session.snapshot = () => createSnapshot(opts, {
        ...(session.baseSnapshot || {}),
        ...(session.gps ? { gps: session.gps } : {}),
    });

    session.sendMessage = (text, to) => {
        if (!text) throw new Error('MENSAJE_VACIO');
        const snap = { ...session.snapshot(), msg: String(text), role: session.role };
        const hex = engine.sendLocalTelemetry(snap, to || 'FF:FF:FF:FF');
        if (!hex) throw new Error('TX_FALLÓ (motor no iniciado)');
        return { ok: true, hex, seq: engine.sequence, bytes: hex.length / 2, to: to || 'BROADCAST' };
    };

    session.sendTelemetry = (snapshot, destinationId) => {
        const snap = snapshot || { ...session.snapshot(), role: session.role };
        const hex = engine.sendLocalTelemetry(snap, destinationId || 'FF:FF:FF:FF');
        if (!hex) throw new Error('TX_FALLÓ (motor no iniciado)');
        return { ok: true, hex, seq: engine.sequence, bytes: hex.length / 2, to: destinationId || 'BROADCAST' };
    };

    session.ping = (nodeId) => {
        if (!nodeId) throw new Error('NODO_REQUERIDO');
        const hex = engine.sendPing(nodeId);
        if (!hex) throw new Error('PING_FALLÓ (motor no iniciado)');
        return { ok: true, hex, seq: engine.sequence, bytes: hex.length / 2, to: nodeId };
    };

    session.setRole = (role) => {
        const next = String(role || '').toUpperCase() === 'RELAY' ? 'RELAY' : 'SCOUT';
        engine.setLocalRole(next);
        session.role = next;
        return { ok: true, role: next };
    };

    session.setAlertState = async (state) => {
        const next = String(state || 'DORMANT').toUpperCase();
        session.alertState = next;
        if (session.relay) {
            session.relay.setAlertState(next);
        } else if (session.server) {
            try {
                await fetch(`http://127.0.0.1:${session.httpPort}/api/state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state: next, label: name }),
                });
            } catch (e) {
                out.warn(`No se pudo reportar estado al servidor local: ${e.message}`);
            }
        }
        return { ok: true, alertState: next };
    };

    session.addPeerUrl = async (url) => {
        if (!session.relay) throw new Error('RELAY_NO_ACTIVO');
        session.relay.addManualPeer(url);
        return { ok: true, peer: url };
    };

    session.peers = () => {
        if (session.relay) return session.relay.getPeers();
        return [];
    };

    session.dtnList = () => {
        if (!engine.dtn) return { ok: false, error: 'DTN_DESHABILITADO' };
        return { ok: true, counts: engine.dtn.counts(), pending: engine.syncDTN() };
    };

    session.dtnClear = () => {
        if (!engine.dtn) return { ok: false, error: 'DTN_DESHABILITADO' };
        engine.dtn.clear();
        return { ok: true, cleared: true };
    };

    session.dtnMerge = (beacons) => {
        if (!engine.dtn) return { ok: false, error: 'DTN_DESHABILITADO' };
        if (!Array.isArray(beacons)) throw new Error('BEACONS_INVALIDOS');
        return { ok: true, ...engine.mergeDTN(beacons) };
    };

    session.status = () => {
        const engineStats = engine.getStats();
        const dtn = engine.dtn ? engine.dtn.counts() : null;
        return {
            ok: true,
            pid: process.pid,
            name,
            id,
            networkId,
            role: session.role,
            alertState: session.alertState,
            started: session.started,
            uptimeMs: session.startedAt ? Date.now() - session.startedAt : 0,
            key: maskKey(key),
            keyDefault,
            engine: {
                ...engineStats,
                nodes: engine.getNodes(),
                dtn,
            },
            http: session.httpEnabled ? {
                url: `http://0.0.0.0:${session.httpPort}`,
                local: `http://127.0.0.1:${session.httpPort}`,
            } : null,
            udp: session.bridge ? {
                port: udpPort,
                stats: session.bridge.getStats(),
            } : null,
            relay: session.relay ? {
                relayUrl: session.relay.relayUrl || relayUrl,
                stats: session.relay.getStats(),
                peers: session.peers(),
            } : null,
            radio: session.radio ? session.radio.status() : null,
            gnss: session.gnss ? session.gnss.state : null,
            messages: session.messages.slice(-20),
        };
    };

    async function startServer() {
        if (!httpEnabled || session.server) return;
        const server = createServer({
            networkId,
            instanceId,
            label: name,
            discovery: opts.discovery !== false,
            discoveryPort: opts.discoveryPort != null ? Number(opts.discoveryPort) : undefined,
        });
        await new Promise((resolve, reject) => {
            const onError = (err) => { server.removeListener('listening', onListen); reject(err); };
            const onListen = () => { server.removeListener('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListen);
            server.listen(httpPort, '0.0.0.0');
        });
        session.server = server;
        const addr = server.address();
        if (addr && typeof addr === 'object') {
            httpPort = addr.port;
            session.httpPort = httpPort;
        }
        out.log('http', `Gateway HTTP en http://0.0.0.0:${httpPort}`);
    }

    async function bindRadio() {
        if (!opts.radioPort) return;
        const transport = new NodeSerialLineTransport(opts.radioPort, Number(opts.radioBaud) || 115200);
        const driver = new LoRaRadioDriver({
            transport,
            timeoutMs: Number(opts.radioTimeout) || 5000,
            onLog: (channel, message) => out.log(channel, message),
            onFrame: (frame) => {
                out.event('radio-rx', { hex: frame.hex.slice(0, 32), rssi: frame.rssi, snr: frame.snr });
                try {
                    engine._handleIncoming({ payload: { trama_hex: frame.hex } });
                } catch (e) {
                    out.error(`Frame de radio inválido: ${e.message}`);
                }
            },
        });
        const result = await driver.connect();
        if (!result.ok) {
            out.warn(`Radio física no disponible (${result.error})`);
            try { await driver.close(); } catch (e) { /* ya cerrada */ }
            return;
        }
        const cfg = {};
        if (opts.radioFreq != null) cfg.frequency = Number(opts.radioFreq);
        if (opts.radioSf != null) cfg.spreadingFactor = Number(opts.radioSf);
        if (opts.radioBw != null) cfg.bandwidth = Number(opts.radioBw);
        if (opts.radioTxPower != null) cfg.txPower = Number(opts.radioTxPower);
        if (Object.keys(cfg).length) {
            const configured = await driver.configure(cfg);
            if (!configured.ok) out.warn(`Configuración de radio falló (${configured.error})`);
        }
        session.radio = driver;
        engine.afterLocalTx = (hex) => {
            driver.transmit(hex).then((res) => {
                if (!res.ok) out.warn(`TX física falló (${res.error})`);
            }).catch((e) => out.warn(`TX física falló (${e.message})`));
        };
        out.log('radio', `Radio física lista (${result.radio || 'SX1276'})`);
    }

    async function bindGnss() {
        if (!opts.gnssPort) return;
        const transport = new NodeSerialLineTransport(opts.gnssPort, Number(opts.gnssBaud) || 9600);
        const reader = new GnssReader({
            transport,
            onLog: (channel, message) => out.log(channel, message),
            onPosition: (state) => {
                session.gps = { lat: state.lat, lon: state.lon, alt: state.alt };
                engine.config.lat = state.lat;
                engine.config.lon = state.lon;
                out.event('gnss', { lat: state.lat, lon: state.lon, alt: state.alt, fix: state.fix });
            },
            onHeading: (heading) => out.event('gnss-heading', { heading }),
        });
        const result = await reader.connect();
        if (!result.ok) {
            out.warn(`GNSS no disponible (${result.error})`);
            try { await reader.close(); } catch (e) { /* ya cerrado */ }
            return;
        }
        session.gnss = reader;
        out.log('gnss', `GNSS conectado en ${opts.gnssPort}`);
    }

    session.start = async (commandHandler) => {
        if (session.started) return session;
        await startServer();
        if (session.bridge) {
            try {
                await session.bridge.start();
            } catch (e) {
                out.warn(`UDP no disponible: ${e.message} (sigo sin puente UDP)`);
                session.bridge = null;
            }
        }
        const relayUrlFinal = relayUrl || (httpEnabled ? `http://127.0.0.1:${httpPort}` : null);
        if (session.relay && !relayUrlFinal) {
            out.warn('Relay sin URL local; se omite');
            session.relay = null;
        } else if (session.relay) {
            session.relay.relayUrl = relayUrlFinal;
            if (!session.relay.connect()) {
                out.warn(`Relay no disponible (${session.relay.error})`);
            }
        }
        engine.start();
        session.started = true;
        session.startedAt = Date.now();
        await bindRadio();
        await bindGnss();
        if (session.relay) {
            session.relay.setAlertState(session.alertState);
        } else {
            await session.setAlertState(session.alertState);
        }
        if (opts.peerUrl) {
            for (const url of [].concat(opts.peerUrl)) {
                try { session.relay && session.relay.addManualPeer(url); } catch (e) { /* no romper */ }
            }
        }
        if (opts.control !== false) {
            const ctl = await control.startControlServer({
                token: control.randomToken(),
                getStatus: () => session.status(),
                exec: commandHandler || (async () => ({ ok: false, error: 'SIN_HANDLER' })),
                onShutdown: () => { session.stop().finally(() => process.exit(0)); },
            });
            session.control = ctl.server;
            session.controlPort = ctl.port;
            session.controlUrl = ctl.url;
            session.token = ctl.token;
            control.saveState({
                version: 1,
                pid: process.pid,
                name,
                id,
                networkId,
                role: session.role,
                alertState: session.alertState,
                httpPort: httpEnabled ? httpPort : null,
                udpPort: udpEnabled ? udpPort : null,
                controlPort: ctl.port,
                controlUrl: ctl.url,
                token: ctl.token,
                startedAt: session.startedAt,
                cwd: process.cwd(),
            }, { stateDir });
        }
        const interval = Number(opts.telemetryInterval) || 0;
        if (interval > 0) {
            const timer = setInterval(() => {
                try {
                    const result = session.sendTelemetry(session.snapshot(), opts.telemetryTo || 'FF:FF:FF:FF');
                    out.log('telemetry', `TX automática seq#${result.seq} (${result.bytes}B)`);
                } catch (e) {
                    out.warn(`Telemetría automática falló: ${e.message}`);
                }
            }, interval);
            session.timers.push(timer);
        }
        const prune = setInterval(() => engine.pruneStaleNodes(), 5000);
        if (prune.unref) prune.unref();
        session.timers.push(prune);
        out.log('session', `${name} (${id}) listo — red ${networkId} — ${session.role} — ${session.alertState}`);
        if (keyDefault) out.warn('Usando la clave AES de demo. En campo usá --key con una clave única.');
        return session;
    };

    session.stop = async () => {
        if (!session.started && !session.server && !session.control) return;
        session.timers.forEach((t) => clearInterval(t));
        session.timers = [];
        session.started = false;
        if (session.control) {
            try { session.control.close(); } catch (e) { /* ya cerrado */ }
            session.control = null;
        }
        control.clearState({ stateDir });
        if (session.relay) session.relay.close();
        if (session.bridge) session.bridge.close();
        if (session.radio) {
            try { await session.radio.close(); } catch (e) { /* ya cerrada */ }
            session.radio = null;
        }
        if (session.gnss) {
            try { await session.gnss.close(); } catch (e) { /* ya cerrado */ }
            session.gnss = null;
        }
        try { engine.stop(); } catch (e) { /* ya detenido */ }
        if (session.server) {
            await new Promise((resolve) => { try { session.server.close(() => resolve()); } catch (e) { resolve(); } });
            session.server = null;
        }
        out.log('session', 'Sesión detenida');
    };

    return session;
}

module.exports = {
    createSession,
    createSnapshot,
    createDtnFileIO,
    parsePeers,
    hexIdFromName,
    normalizeId,
    maskKey,
    DEFAULT_KEY,
    DEFAULT_NETWORK,
    DEFAULT_UDP_PORT,
    DEFAULT_HTTP_PORT,
};
