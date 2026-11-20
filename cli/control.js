'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function stateDir(opts = {}) {
    if (opts.stateDir) return opts.stateDir;
    if (process.env.LIFELINE_STATE_DIR) return process.env.LIFELINE_STATE_DIR;
    return path.join(os.homedir(), '.lifeline');
}

function statePath(opts = {}) {
    return path.join(stateDir(opts), 'session.json');
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function saveState(state, opts = {}) {
    const dir = stateDir(opts);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = statePath(opts);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) { /* FS sin permisos POSIX */ }
    return file;
}

function loadState(opts = {}) {
    const file = statePath(opts);
    let state;
    try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
    if (!state || !state.controlPort || !pidAlive(state.pid)) return null;
    return state;
}

function clearState(opts = {}) {
    const file = statePath(opts);
    try { fs.unlinkSync(file); } catch (e) { /* ya no existe */ }
}

function randomToken() {
    return crypto.randomBytes(24).toString('hex');
}

function readBody(req, cb) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
        raw += c;
        if (raw.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
        if (!raw) return cb(null, {});
        try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); }
    });
    req.on('error', cb);
}

function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/**
 * Servidor de control local (solo 127.0.0.1) para que los comandos
 * de un solo tiro (`lifeline send`, `status`, …) hablen con la sesión
 * que está corriendo en `lifeline run`.
 */
function startControlServer(opts) {
    const token = opts.token || randomToken();
    const server = http.createServer((req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        const provided = req.headers['x-lifeline-token'];
        if (provided !== token) {
            json(res, 401, { ok: false, error: 'TOKEN_INVALIDO' });
            return;
        }

        if (req.method === 'GET' && (pathname === '/status' || pathname === '/health')) {
            const value = pathname === '/health' ? { ok: true, pid: process.pid } : opts.getStatus();
            json(res, 200, { ok: true, result: value });
            return;
        }

        if (req.method === 'POST' && pathname === '/exec') {
            readBody(req, async (err, body) => {
                if (err) { json(res, 400, { ok: false, error: 'JSON_INVALIDO' }); return; }
                const argv = Array.isArray(body && body.argv) ? body.argv.map(String) : null;
                if (!argv || argv.length === 0) {
                    json(res, 400, { ok: false, error: 'ARGV_VACIO' });
                    return;
                }
                try {
                    const result = await opts.exec(argv);
                    json(res, 200, { ok: true, result });
                } catch (e) {
                    json(res, 500, { ok: false, error: e.message || String(e) });
                }
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/shutdown') {
            json(res, 200, { ok: true, shuttingDown: true });
            setTimeout(() => {
                try { opts.onShutdown(); } catch (e) { /* no romper */ }
            }, 25);
            return;
        }

        json(res, 404, { ok: false, error: 'NO_ENCONTRADO' });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            const addr = server.address();
            resolve({ server, port: addr.port, token, url: `http://127.0.0.1:${addr.port}` });
        });
    });
}

async function controlRequest(state, method, pathname, body) {
    const url = String(state.controlUrl || `http://127.0.0.1:${state.controlPort}`) + pathname;
    const headers = { 'x-lifeline-token': state.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: 'RESPUESTA_INVALIDA' }; }
    if (!res.ok || !data.ok) {
        const err = new Error(data.error || `CONTROL_HTTP_${res.status}`);
        err.control = data;
        throw err;
    }
    return data.result;
}

async function controlExec(state, argv) {
    return controlRequest(state, 'POST', '/exec', { argv });
}

async function controlStatus(state) {
    return controlRequest(state, 'GET', '/status');
}

async function controlShutdown(state) {
    return controlRequest(state, 'POST', '/shutdown', {});
}

module.exports = {
    stateDir,
    statePath,
    pidAlive,
    saveState,
    loadState,
    clearState,
    randomToken,
    startControlServer,
    controlRequest,
    controlExec,
    controlStatus,
    controlShutdown,
};
