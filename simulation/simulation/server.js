const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const MAX_PATH_LENGTH = 1024;

// Relay de señales cross-device (pruebas manuales): la GUI de cada
// dispositivo reenvía sus tramas LoRa por POST /relay/send y las recibe
// por SSE (GET /relay/stream). Cero dependencias (solo http estándar).
const RELAY_PROTO_VERSION = 1;
const RELAY_MAX_BODY = 128 * 1024; // 128 KB por envelope
const RELAY_HEARTBEAT_MS = 15000;

// Descubrimiento de pares por UDP broadcast (cada dispositivo corre su
// propio servidor): mientras un dispositivo está en estado de alerta
// (VIGILANCE = modo scout/baliza) anuncia su URL HTTP; los pares en el
// mismo estado se descubren solos y se reenvían tramas directamente.
const DISCOVERY_PROTO_VERSION = 1;
const DISCOVERY_DEFAULT_PORT = 42203;
const DISCOVERY_INTERVAL_MS = 2000;
const PEER_TTL_MS = 8000;

// Directorio de módulos RF reales (radio/) para el alias /rf/ del navegador
const RADIO_DIR = path.join(__dirname, '..', '..', 'radio');

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
};

/**
 * Resuelve una ruta HTTP dentro de `root` de forma segura.
 * @param {string} root directorio raíz (absoluto).
 * @param {string} rawUrl `req.url` crudo (puede incluir query/hash).
 * @returns {{ok: true, filePath: string} | {ok: false, status: number, message: string}}
 */
function resolveFilePath(root, rawUrl) {
    // Separar query/fragmento
    let pathname = rawUrl.split('?')[0].split('#')[0];

    if (!pathname.startsWith('/')) {
        return { ok: false, status: 400, message: 'Bad Request' };
    }
    if (pathname.length > MAX_PATH_LENGTH) {
        return { ok: false, status: 414, message: 'URI Too Long' };
    }

    // Decodificar; secuencia de escape malformada → 400
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return { ok: false, status: 400, message: 'Bad Request' };
    }

    // Rechazar bytes nulos y separadores de Windows (p. ej. %5c)
    if (decoded.includes('\0') || decoded.includes('\\')) {
        return { ok: false, status: 403, message: 'Forbidden' };
    }

    // Directorio → index.html dentro de él
    if (decoded.endsWith('/')) decoded += 'index.html';

    const rel = decoded.replace(/^\/+/, '');
    const filePath = path.resolve(root, rel);

    // El resultado debe quedar dentro de root
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        return { ok: false, status: 403, message: 'Forbidden' };
    }

    return { ok: true, filePath };
}

function sendError(res, status, message) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
}

// ── Descubrimiento LAN: direcciones y broadcast ──────────────────────

/** Direcciones IPv4 no internas de rango privado (192.168/10/172.16-31). */
function lanAddresses() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const addr of ifaces[name] || []) {
            if (addr.family === 'IPv4' && !addr.internal
                && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr.address)) {
                out.push(addr);
            }
        }
    }
    return out;
}

/** Broadcast de la subred a partir de una dirección + netmask. */
function subnetBroadcast(addr) {
    const a = addr.address.split('.').map(Number);
    const m = addr.netmask.split('.').map(Number);
    return a.map((oct, i) => (oct | (~m[i] >>> 0)) & 0xff).join('.');
}

/** Broadcast por defecto: primera subred no interna, o limitado. */
function defaultBroadcastAddress() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const addr of ifaces[name] || []) {
            if (addr.family === 'IPv4' && !addr.internal && addr.netmask) {
                return subnetBroadcast(addr);
            }
        }
    }
    return '255.255.255.255';
}

function isActiveState(state) {
    return !!state && state !== 'DORMANT' && state !== 'ORPHAN';
}

function serveFile(res, filePath, method) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
                sendError(res, 404, 'File Not Found');
            } else {
                sendError(res, 500, 'Internal Server Error: ' + err.code);
            }
            return;
        }
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType });
        if (method === 'HEAD') {
            res.end();
        } else {
            res.end(content);
        }
    });
}

/**
 * Crea un servidor HTTP estático sobre un directorio raíz.
 * @param {{root?: string, mimeTypes?: object, rfAlias?: string|false,
 *          discovery?: boolean, discoveryPort?: number,
 *          discoveryIntervalMs?: number, peerTtlMs?: number,
 *          broadcastAddress?: string, networkId?: string, label?: string,
 *          instanceId?: string, url?: string}} config
 *  - rfAlias: directorio servido bajo el prefijo `/rf/` (por defecto radio/).
 *    `false` lo desactiva. El alias se resuelve SIEMPRE dentro de su propio
 *    directorio (misma seguridad que root).
 *  - discovery: habilita el descubrimiento de pares por UDP (por defecto true).
 *  - discoveryPort / discoveryIntervalMs / peerTtlMs / broadcastAddress:
 *    parámetros del anuncio (por defecto 42203 / 2000 ms / 8000 ms / subred).
 *  - networkId / label / instanceId / url: identidad del dispositivo.
 * @returns {import('http').Server}
 */
function createServer(config = {}) {
    const root = config.root || __dirname;
    const mimeTypes = config.mimeTypes || MIME_TYPES;
    const rfAlias = config.rfAlias !== undefined
        ? config.rfAlias
        : (fs.existsSync(RADIO_DIR) ? RADIO_DIR : null);

    // ── Identidad y estado del dispositivo ──────────────────────────
    const networkId = config.networkId || 'LIFELINE-001';
    const instanceId = config.instanceId
        || ('SVR-' + Math.random().toString(36).slice(2, 10).toUpperCase());
    let label = config.label || 'SERVIDOR-LOCAL';
    let alertState = 'DORMANT';
    let serverUrl = config.url || null;

    // ── Descubrimiento UDP de pares ─────────────────────────────────
    const discoveryEnabled = config.discovery !== false;
    const discoveryPort = config.discoveryPort !== undefined
        ? config.discoveryPort : DISCOVERY_DEFAULT_PORT;
    const discoveryIntervalMs = config.discoveryIntervalMs !== undefined
        ? config.discoveryIntervalMs : DISCOVERY_INTERVAL_MS;
    const peerTtlMs = config.peerTtlMs !== undefined
        ? config.peerTtlMs : PEER_TTL_MS;
    const broadcastAddress = config.broadcastAddress
        || defaultBroadcastAddress();

    const peers = new Map(); // instanceId -> { url, label, state, lastSeen }
    let discoverySocket = null;
    let discoveryBound = false;
    let advertiseTimer = null;

    function prunePeers() {
        const now = Date.now();
        peers.forEach((p, id) => {
            if (now - p.lastSeen > peerTtlMs) peers.delete(id);
        });
    }

    function onDiscoveryMessage(msg) {
        let env;
        try {
            env = JSON.parse(msg.toString('utf8'));
        } catch (e) { return; }
        if (!env || env.kind !== 'LIFELINE-DISCOVERY') return;
        if (env.v !== DISCOVERY_PROTO_VERSION) return;
        if (env.instanceId === instanceId) return;
        if (env.networkId !== networkId) return;
        if (!isActiveState(env.state)) {
            peers.delete(env.instanceId); // BYE / quedó inactivo
            return;
        }
        peers.set(env.instanceId, {
            url: env.url || null,
            label: env.label || null,
            state: env.state,
            lastSeen: Date.now(),
        });
    }

    function ensureDiscovery() {
        if (discoverySocket || !discoveryEnabled) return;
        try {
            discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            discoverySocket.on('message', onDiscoveryMessage);
            discoverySocket.on('error', (e) => {
                const s = discoverySocket;
                discoverySocket = null;
                discoveryBound = false;
                try { if (s) s.close(); } catch (err) { /* ya cerrado */ }
            });
            discoverySocket.bind(discoveryPort, () => {
                discoveryBound = true;
                try { discoverySocket.setBroadcast(true); } catch (e) { /* sin permiso */ }
            });
        } catch (e) {
            discoverySocket = null;
        }
    }

    function advertise(active, cb) {
        if (!discoverySocket || !discoveryBound || !serverUrl) { if (cb) cb(); return; }
        const env = {
            v: DISCOVERY_PROTO_VERSION,
            kind: 'LIFELINE-DISCOVERY',
            instanceId,
            networkId,
            label,
            state: active ? alertState : 'DORMANT',
            url: serverUrl,
            ts: Date.now(),
        };
        const data = Buffer.from(JSON.stringify(env));
        try {
            discoverySocket.send(data, 0, data.length, discoveryPort, broadcastAddress, cb || (() => {}));
        } catch (e) { if (cb) cb(); }
    }

    function startAdvertising() {
        if (!discoveryEnabled) return;
        ensureDiscovery();
        if (!discoverySocket) return;
        const kick = () => {
            advertise(true);
            if (advertiseTimer) clearInterval(advertiseTimer);
            advertiseTimer = setInterval(() => advertise(true), discoveryIntervalMs);
            if (advertiseTimer.unref) advertiseTimer.unref();
        };
        if (discoveryBound) kick();
        else discoverySocket.once('listening', kick);
    }

    function stopAdvertising() {
        if (advertiseTimer) { clearInterval(advertiseTimer); advertiseTimer = null; }
        const s = discoverySocket;
        if (s) {
            if (discoveryEnabled) {
                advertise(false, () => { try { s.close(); } catch (e) { /* ya cerrado */ } });
            } else {
                try { s.close(); } catch (e) { /* ya cerrado */ }
            }
        }
        discoverySocket = null;
        discoveryBound = false;
        peers.clear();
    }

    /** Estado de alerta del dispositivo (el navegador lo reporta). */
    function setAlertState(state, opts = {}) {
        const wasActive = isActiveState(alertState);
        alertState = state || 'DORMANT';
        if (typeof opts.label === 'string') label = opts.label;
        const isActive = isActiveState(alertState);
        if (isActive && !wasActive) {
            startAdvertising();
        } else if (!isActive && wasActive) {
            stopAdvertising();
        } else if (isActive && wasActive) {
            advertise(true); // refresco de identidad (nuevo label)
        }
        return { ok: true, instanceId, networkId, label, state: alertState, url: serverUrl };
    }

    // ── Clientes SSE del relay (pestañas de navegador conectadas) ──
    const relayClients = new Set();
    let relayClientSeq = 0;

    function relayBroadcast(env) {
        const data = 'data: ' + JSON.stringify(env) + '\n\n';
        relayClients.forEach((client) => {
            try {
                client.res.write(data);
            } catch (e) {
                relayClients.delete(client);
            }
        });
    }

    function handleRelayStream(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...SECURITY_HEADERS,
        });
        res.write('retry: 2000\n\n');

        const client = { id: ++relayClientSeq, res };
        relayClients.add(client);

        const heartbeat = setInterval(() => {
            try { client.res.write(': ping\n\n'); } catch (e) { /* cliente caído */ }
        }, RELAY_HEARTBEAT_MS);
        heartbeat.unref(); // no mantener el proceso vivo solo por el heartbeat

        req.on('close', () => {
            clearInterval(heartbeat);
            relayClients.delete(client);
        });
    }

    function handleRelaySend(req, res) {
        let size = 0;
        const chunks = [];
        let aborted = false;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > RELAY_MAX_BODY) {
                aborted = true;
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (aborted) {
                sendError(res, 413, 'Envelope demasiado grande');
                return;
            }
            let env;
            try {
                env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e) {
                sendError(res, 400, 'JSON inválido');
                return;
            }
            if (!env || !env.frame || !env.networkId || !env.instanceId || !env.kind) {
                sendError(res, 400, 'Envelope inválido');
                return;
            }
            if (env.v !== RELAY_PROTO_VERSION) {
                sendError(res, 400, 'Protocolo no soportado');
                return;
            }
            relayBroadcast(env);
            res.writeHead(204, { ...SECURITY_HEADERS, ...CORS_HEADERS });
            res.end();
        });

        req.on('error', () => {
            if (!res.headersSent) sendError(res, 400, 'Bad Request');
        });
    }

    // ── Helpers HTTP para las APIs ───────────────────────────────────
    const CORS_HEADERS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    function json(res, body, status = 200) {
        const data = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            ...SECURITY_HEADERS,
            ...CORS_HEADERS,
        });
        res.end(data);
    }

    function readBody(req, cb) {
        let size = 0;
        const chunks = [];
        let aborted = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > RELAY_MAX_BODY) {
                aborted = true;
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted) { cb(new Error('too-large')); return; }
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e) { cb(new Error('json')); return; }
            cb(null, body);
        });
        req.on('error', () => cb(new Error('request')));
    }

    /** Identidad + estado (GET) o reporte de estado (POST) del dispositivo. */
    function handleApiState(req, res) {
        if (req.method === 'GET') {
            json(res, {
                ok: true, instanceId, networkId, label, state: alertState, url: serverUrl,
                active: isActiveState(alertState),
            });
            return;
        }
        if (req.method !== 'POST') {
            sendError(res, 405, 'Method Not Allowed');
            return;
        }
        readBody(req, (err, body) => {
            if (err) { sendError(res, 400, 'JSON inválido'); return; }
            if (body && body.state !== undefined && typeof body.state !== 'string') {
                sendError(res, 400, 'Estado inválido');
                return;
            }
            const state = typeof body.state === 'string' ? body.state : 'DORMANT';
            const r = setAlertState(state, {
                label: typeof body.label === 'string' ? body.label : undefined,
            });
            json(res, { ...r, active: isActiveState(r.state) });
        });
    }

    /** Consulta/probe de un par por URL (server→server, sin CORS). */
    function probePeer(url, cb) {
        const target = url.replace(/\/+$/, '') + '/api/state';
        const req = http.get(target, { timeout: 2000 }, (r) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { data += c; });
            r.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j && j.ok && j.instanceId) {
                        cb({
                            instanceId: j.instanceId,
                            url: j.url || url,
                            label: j.label,
                            state: j.state,
                            active: isActiveState(j.state),
                        });
                        return;
                    }
                } catch (e) { /* no JSON */ }
                cb(null);
            });
        });
        req.on('error', () => cb(null));
        req.on('timeout', () => { req.destroy(); cb(null); });
    }

    /** Pares descubiertos (GET) o alta de pares manuales (POST). */
    function handleApiPeers(req, res) {
        if (req.method === 'GET') {
            prunePeers();
            const list = [];
            peers.forEach((p, id) => {
                list.push({
                    instanceId: id, url: p.url, label: p.label, state: p.state, lastSeen: p.lastSeen,
                });
            });
            json(res, { ok: true, peers: list });
            return;
        }
        if (req.method !== 'POST') {
            sendError(res, 405, 'Method Not Allowed');
            return;
        }
        readBody(req, (err, body) => {
            if (err) { sendError(res, 400, 'JSON inválido'); return; }
            const urls = Array.isArray(body && body.peers) ? body.peers : [];
            if (urls.length === 0) { json(res, { ok: true, added: 0, peers: [] }); return; }
            let pending = urls.length;
            const added = [];
            urls.forEach((url) => {
                probePeer(url, (peer) => {
                    if (peer && peer.active) {
                        peers.set(peer.instanceId, {
                            url: peer.url || url,
                            label: peer.label,
                            state: peer.state,
                            lastSeen: Date.now(),
                        });
                        added.push(peer.instanceId);
                    }
                    if (--pending === 0) json(res, { ok: true, added: added.length, peers: added });
                });
            });
        });
    }

    const server = http.createServer((req, res) => {
        const pathname = req.url.split('?')[0].split('#')[0];

        // Preflight CORS (fetch cross-origin de los pares)
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...CORS_HEADERS, ...SECURITY_HEADERS });
            res.end();
            return;
        }

        // Estado y pares del dispositivo (descubrimiento)
        if (pathname === '/api/state') {
            handleApiState(req, res);
            return;
        }
        if (pathname === '/api/peers') {
            handleApiPeers(req, res);
            return;
        }

        // Relay de señales cross-device
        if (pathname === '/relay/stream') {
            if (req.method === 'GET') {
                handleRelayStream(req, res);
                return;
            }
            sendError(res, 405, 'Method Not Allowed');
            return;
        }
        if (pathname === '/relay/send') {
            if (req.method !== 'POST') {
                sendError(res, 405, 'Method Not Allowed');
                return;
            }
            handleRelaySend(req, res);
            return;
        }

        // Solo GET/HEAD
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendError(res, 405, 'Method Not Allowed');
            return;
        }

        // Alias de módulos RF: /rf y /rf/* → dentro de rfAlias
        if (rfAlias && (pathname === '/rf' || pathname.startsWith('/rf/'))) {
            const sub = pathname === '/rf' ? '/' : pathname.slice('/rf'.length);
            const resolved = resolveFilePath(rfAlias, sub);
            if (!resolved.ok) {
                sendError(res, resolved.status, resolved.message);
                return;
            }
            serveFile(res, resolved.filePath, req.method);
            return;
        }

        const resolved = resolveFilePath(root, req.url);
        if (!resolved.ok) {
            sendError(res, resolved.status, resolved.message);
            return;
        }
        serveFile(res, resolved.filePath, req.method);
    });

    // URL canónica del dispositivo (LAN) al escuchar
    server.on('listening', () => {
        if (!serverUrl) {
            const port = server.address().port;
            const ips = lanAddresses();
            serverUrl = 'http://' + (ips[0] ? ips[0].address : '127.0.0.1') + ':' + port;
        }
    });
    server.on('close', () => {
        if (advertiseTimer) { clearInterval(advertiseTimer); advertiseTimer = null; }
        const s = discoverySocket;
        discoverySocket = null;
        discoveryBound = false;
        if (s) { try { s.close(); } catch (e) { /* ya cerrado */ } }
        peers.clear();
    });

    return server;
}

// Arranque directo: `node server.js` (o PORT=xxxx node server.js).
// Lee la configuración del entorno (ver .env.example). Las claves de
// cifrado y tokens NUNCA van en el repositorio.
if (require.main === module) {
    const PORT = Number(process.env.PORT) || 8000;
    const discoveryPort = process.env.LIFELINE_DISCOVERY_PORT != null
        ? Number(process.env.LIFELINE_DISCOVERY_PORT) : DISCOVERY_DEFAULT_PORT;
    createServer({
        networkId: process.env.LIFELINE_NETWORK_ID || 'LIFELINE-001',
        instanceId: process.env.LIFELINE_INSTANCE_ID || undefined,
        label: process.env.LIFELINE_LABEL || 'SERVIDOR-LOCAL',
        discovery: process.env.LIFELINE_DISCOVERY !== 'false',
        discoveryPort,
    }).listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}

module.exports = {
    createServer,
    MIME_TYPES,
    resolveFilePath,
    RELAY_PROTO_VERSION,
    DISCOVERY_PROTO_VERSION,
    DISCOVERY_DEFAULT_PORT,
    DISCOVERY_INTERVAL_MS,
    PEER_TTL_MS,
    lanAddresses,
    subnetBroadcast,
    defaultBroadcastAddress,
    isActiveState,
};
