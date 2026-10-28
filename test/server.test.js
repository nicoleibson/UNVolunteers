'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { SIM, requireSim, mulberry32 } = require('./helpers.js');
const { createServer, MIME_TYPES, resolveFilePath, subnetBroadcast, isActiveState, lanAddresses } = requireSim('server.js');

let server;
let base;

before(async () => {
    server = createServer({ root: SIM });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function get(rawPath) {
    return new Promise((resolve) => {
        http.get(base + rawPath, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body }));
        }).on('error', (e) => resolve({ status: 0, ct: '', body: String(e.message) }));
    });
}

test('Servidor: raíz sirve index.html como text/html', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.ct, /^text\/html/);
    assert.match(r.body, /LIFELINE|DOCTYPE/i);
});

test('Servidor: tipos MIME correctos', async () => {
    const checks = [
        ['/index_integrated.html', /^text\/html/],
        ['/app_integrated.js', /^text\/javascript/],
        ['/app.js', /^text\/javascript/],
        ['/styles.css', /^text\/css/],
    ];
    for (const [p, re] of checks) {
        const r = await get(p);
        assert.equal(r.status, 200, p);
        assert.match(r.ct, re, p);
    }
});

test('Servidor: archivo inexistente → 404', async () => {
    assert.equal((await get('/noexiste.js')).status, 404);
    assert.equal((await get('/sub/otro.html')).status, 404);
});

test('Servidor: traversal literal ../ bloqueado (403)', async () => {
    // El cliente http.get normaliza los ".." vía WHATWG URL; probamos con socket crudo
    const port = server.address().port;
    const status = await new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write('GET /../../../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        });
        let data = '';
        sock.on('data', (d) => { data += d.toString(); });
        sock.on('end', () => resolve(parseInt(data.split(' ')[1], 10)));
        sock.on('error', reject);
    });
    assert.equal(status, 403, `status=${status}`);
});

test('Servidor: traversal con %2e%2e no escapa del raíz (no 200)', async () => {
    const r = await get('/%2e%2e/%2e%2e/etc/passwd');
    assert.notEqual(r.status, 200, `status=${r.status}`);
    assert.notEqual(r.status, 0);
});

test('Servidor: rutas por encima del raíz pero internas no escapan', async () => {
    // ../ dentro de la URL hacia un archivo real dentro del raíz sigue dentro de root
    const r = await get('/../server.js');
    assert.notEqual(r.status, 403); // no debe considerarse traversal
    assert.ok(r.status === 200 || r.status === 404);
});

test('Servidor: doble instancia en puertos distintos coexiste', async () => {
    const s2 = createServer({ root: SIM });
    await new Promise((resolve) => s2.listen(0, resolve));
    const port2 = s2.address().port;
    const r = await new Promise((resolve) =>
        http.get(`http://127.0.0.1:${port2}/`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        })
    );
    assert.equal(r, 200);
    await new Promise((resolve) => s2.close(resolve));
});

test('Servidor: MIME desconocido cae en application/octet-stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-srv-'));
    fs.writeFileSync(path.join(dir, 'archivo.xyz'), 'hola');
    const s3 = createServer({ root: dir });
    await new Promise((resolve) => s3.listen(0, resolve));
    const port3 = s3.address().port;
    const r = await new Promise((resolve) =>
        http.get(`http://127.0.0.1:${port3}/archivo.xyz`, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '' }));
        })
    );
    assert.equal(r.status, 200);
    assert.match(r.ct, /octet-stream/);
    await new Promise((resolve) => s3.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Servidor: MIME_TYPES exportado', () => {
    assert.equal(MIME_TYPES['.html'], 'text/html');
    assert.equal(MIME_TYPES['.js'], 'text/javascript');
});

test('resolveFilePath: traversal y entradas maliciosas → rechazadas', () => {
    const cases = [
        ['/../../../../etc/passwd', 403],
        ['/%2e%2e/%2e%2e/etc/passwd', 403],
        ['/..%2f..%2f..%2fetc%2fpasswd', 403],
        ['/..\\..\\..\\etc\\passwd', 403],
        ['/%2e%2e%5c%2e%2e%5cetc%5cpasswd', 403],
        ['/%00', 403],
        ['/sub/%00index.html', 403],
        ['/%c0%ae%c0%ae', 400],
        ['/%zz', 400],
    ];
    for (const [url, status] of cases) {
        const r = resolveFilePath(SIM, url);
        assert.equal(r.ok, false, url);
        assert.equal(r.status, status, url);
    }
});

test('resolveFilePath: rutas legítimas resuelven dentro de root', () => {
    assert.deepEqual(resolveFilePath(SIM, '/'), { ok: true, filePath: SIM + '/index.html' });
    assert.deepEqual(resolveFilePath(SIM, '/app.js'), { ok: true, filePath: SIM + '/app.js' });
    // query/hash se ignoran
    assert.equal(resolveFilePath(SIM, '/app.js?x=1#sec').filePath, SIM + '/app.js');
    // directorio → index.html dentro
    assert.equal(resolveFilePath(SIM, '/sub/').filePath, SIM + '/sub/index.html');
    assert.equal(resolveFilePath(SIM, '//app.js').filePath, SIM + '/app.js');
});

test('resolveFilePath: longitud excesiva → 414 y sin barra inicial → 400', () => {
    const r = resolveFilePath(SIM, '/' + 'a'.repeat(2048));
    assert.equal(r.ok, false);
    assert.equal(r.status, 414);
    assert.equal(resolveFilePath(SIM, 'app.js').status, 400);
});

function rawRequest(target) {
    return new Promise((resolve, reject) => {
        const port = server.address().port;
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let data = '';
        sock.on('data', (d) => { data += d.toString(); });
        sock.on('end', () => {
            const line = data.split('\r\n')[0];
            resolve({ status: parseInt(line.split(' ')[1], 10) || 0, body: data });
        });
        sock.on('error', reject);
    });
}

test('Servidor: lista de travesías maliciosas por socket crudo nunca dan 200 ni filtran', async () => {
    const malicious = [
        '/../../../../etc/passwd',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/..%2f..%2f..%2fetc%2fpasswd',
        '/%2e%2e%5c%2e%2e%5cetc%5cpasswd',
        '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '/%252e%252e%252f%252e%252e%252fetc',
        '/%00',
        '/%c0%ae%c0%ae',
        '/....//....//....//etc/passwd',
        '/..\\..\\..\\',
        '///etc/passwd',
        '//server.js/../../..',
    ];
    for (const t of malicious) {
        const r = await rawRequest(t);
        assert.notEqual(r.status, 200, `traversal dio 200: ${t}`);
        assert.ok(!r.body.includes('root:'), `fuga de /etc/passwd en: ${t}`);
        assert.ok(!r.body.includes('r00t:'), `fuga de /etc/passwd en: ${t}`);
    }
});

test('Servidor: fuzzing determinista de travesías nunca escapa del raíz', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-fuzz-'));
    const rootA = path.join(tmp, 'raiz');
    const outside = path.join(tmp, 'fuera');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(rootA, 'index.html'), 'OK-INTERNO');
    fs.writeFileSync(path.join(outside, 'marcador.txt'), 'SECRETO-FUERA-DEL-RAIZ');

    const s = createServer({ root: rootA });
    await new Promise((resolve) => s.listen(0, resolve));
    const base = `http://127.0.0.1:${s.address().port}`;

    const rand = mulberry32(0xC0FFEE);
    const tokens = ['..', '.', 'a', 'b', 'etc', 'passwd', 'index.html', 'marcador.txt',
        '%2e%2e', '%2e', '%2f', '%5c', '..\\', '%00', '%252e'];
    const seps = ['/', '\\', '%2f', '%5c'];
    const fetch = (t) => new Promise((resolve) => {
        http.get(base + t, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', () => resolve({ status: 0, body: '' }));
    });

    const allowed = [0, 200, 400, 403, 404, 405, 414];
    try {
        for (let i = 0; i < 300; i++) {
            let t = '/';
            const n = 1 + Math.floor(rand() * 4);
            for (let j = 0; j < n; j++) {
                t += tokens[Math.floor(rand() * tokens.length)];
                if (rand() < 0.8) t += seps[Math.floor(rand() * seps.length)];
            }
            if (rand() < 0.3) t += '?q=1';
            const r = await fetch(t);
            assert.ok(allowed.includes(r.status), `estado inesperado ${r.status} para ${t}`);
            assert.ok(!r.body.includes('SECRETO-FUERA-DEL-RAIZ'), `fuga de marcador en: ${t}`);
        }
    } finally {
        s.closeAllConnections();
        await new Promise((resolve) => s.close(resolve));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Servidor: encabezados de seguridad en respuestas 200 y 404', async () => {
    const port = server.address().port;
    const grab = (p) => new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}${p}`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.headers));
        });
    });
    for (const p of ['/', '/nope.js', '/%2e%2e/%2e%2e/etc/passwd']) {
        const h = await grab(p);
        assert.equal(h['x-content-type-options'], 'nosniff', p);
        assert.equal(h['x-frame-options'], 'DENY', p);
        assert.equal(h['cache-control'], 'no-store', p);
    }
});

test('Servidor: HEAD responde sin cuerpo y con Content-Type', async () => {
    const port = server.address().port;
    const r = await new Promise((resolve) => {
        http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body: b }));
        }).end();
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, '');
    assert.match(r.ct, /^text\/html/);
});

test('Servidor: métodos no GET/HEAD → 405', async () => {
    const port = server.address().port;
    const r = await new Promise((resolve) => {
        http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).end('data');
    });
    assert.equal(r.status, 405);
});

test('Servidor: directorio sirve su index.html', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-dir-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'index.html'), 'SUBINDEX');
    const s4 = createServer({ root: dir });
    await new Promise((resolve) => s4.listen(0, resolve));
    const port4 = s4.address().port;
    const r = await new Promise((resolve) =>
        http.get(`http://127.0.0.1:${port4}/sub/`, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        })
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, 'SUBINDEX');
    await new Promise((resolve) => s4.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── Alias /rf/ (módulos RF reales para la GUI de producción) ──

test('Servidor: /rf/ sirve módulos RF reales como text/javascript', async () => {
    const r = await get('/rf/aes128.js');
    assert.equal(r.status, 200, 'aes128.js vía /rf/');
    assert.match(r.ct, /^text\/javascript/);
    assert.match(r.body, /aes128Block/, 'contenido real del módulo AES');
    assert.ok((await get('/rf/packet_encoder.js')).status === 200);
    assert.ok((await get('/rf/lora_mesh.js')).status === 200);
    assert.ok((await get('/rf/aprs_protocol.js')).status === 200);
    assert.ok((await get('/rf/sdr_receiver.js')).status === 200);
    assert.ok((await get('/rf/frequency_mgr.js')).status === 200);
});

test('Servidor: /rf/ no escapa de radio/ (traversal → no 200)', async () => {
    // socket crudo: http.get normaliza los ".." antes de llegar al servidor
    const t1 = await rawRequest('/rf/../../server.js');
    assert.notEqual(t1.status, 200, `escape por ..: ${t1.status}`);
    assert.ok(!t1.body.includes('createServer'), 'no filtra server.js');
    const t2 = await rawRequest('/rf/%2e%2e/%2e%2e/server.js');
    assert.notEqual(t2.status, 200, `escape encodado: ${t2.status}`);
    assert.notEqual(t2.status, 0);
    const t3 = await rawRequest('/rf/../test/server.test.js');
    assert.notEqual(t3.status, 200, `escape a test/: ${t3.status}`);
    const t4 = await get('/rf/');
    assert.equal(t4.status, 404, 'sin index.html dentro de radio/');
    const t5 = await rawRequest('/rf/%5c..%5c..%5cserver.js');
    assert.notEqual(t5.status, 200, `escape con \\ encodado: ${t5.status}`);
});

test('Servidor: rfAlias:false desactiva el alias (404)', async () => {
    const s5 = createServer({ root: SIM, rfAlias: false });
    await new Promise((resolve) => s5.listen(0, resolve));
    const port5 = s5.address().port;
    const r = await new Promise((resolve) =>
        http.get(`http://127.0.0.1:${port5}/rf/aes128.js`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        })
    );
    assert.equal(r, 404);
    await new Promise((resolve) => s5.close(resolve));
});

// ── Relay cross-device (SSE + POST) ─────────────────────────────────

function openSSE() {
    return new Promise((resolve, reject) => {
        const req = http.get(base + '/relay/stream', (res) => resolve({ req, res }));
        req.on('error', reject);
    });
}

function waitForChunk(res, pred, timeout = 4000) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const to = setTimeout(() => reject(new Error('SSE timeout')), timeout);
        res.on('data', (d) => {
            buf += d.toString();
            const hit = pred(buf);
            if (hit) {
                clearTimeout(to);
                resolve(hit);
            }
        });
        res.on('end', () => { clearTimeout(to); reject(new Error('SSE stream cerrado')); });
    });
}

function postRelay(body) {
    return new Promise((resolve) => {
        const post = http.request(base + '/relay/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
        });
        post.on('error', () => resolve(0));
        post.write(JSON.stringify(body));
        post.end();
    });
}

const RELAY_ENV = {
    v: 1,
    instanceId: 'tab-A',
    name: 'PC',
    networkId: 'LIFELINE-001',
    kind: 'DATA',
    frame: { type: 'DATA', sourceId: 'AA00000000000001', payload: { trama_hex: '0102' } },
};

test('Servidor: relay — /relay/stream es SSE y POST /relay/send difunde 204', async () => {
    const conn = await openSSE();
    try {
        assert.equal(conn.res.statusCode, 200);
        assert.match(conn.res.headers['content-type'], /text\/event-stream/);
        await waitForChunk(conn.res, (b) => (b.includes('retry: 2000') ? 'retry' : null));
        const status = await postRelay(RELAY_ENV);
        assert.equal(status, 204, 'POST /relay/send → 204');
        const dataLine = await waitForChunk(conn.res, (b) => {
            const i = b.indexOf('data: ');
            return i >= 0 ? b.slice(i) : null;
        });
        const parsed = JSON.parse(dataLine.replace(/^data: /, '').trim());
        assert.equal(parsed.instanceId, 'tab-A');
        assert.equal(parsed.kind, 'DATA');
        assert.equal(parsed.frame.sourceId, 'AA00000000000001');
    } finally {
        conn.req.destroy();
    }
});

test('Servidor: relay — dos clientes SSE reciben el mismo envelope', async () => {
    const c1 = await openSSE();
    const c2 = await openSSE();
    try {
        await waitForChunk(c1.res, (b) => (b.includes('retry: 2000') ? 'retry' : null));
        await waitForChunk(c2.res, (b) => (b.includes('retry: 2000') ? 'retry' : null));
        await postRelay(RELAY_ENV);
        const [d1, d2] = await Promise.all([
            waitForChunk(c1.res, (b) => { const i = b.indexOf('data: '); return i >= 0 ? b.slice(i) : null; }),
            waitForChunk(c2.res, (b) => { const i = b.indexOf('data: '); return i >= 0 ? b.slice(i) : null; }),
        ]);
        const e1 = JSON.parse(d1.replace(/^data: /, '').trim());
        const e2 = JSON.parse(d2.replace(/^data: /, '').trim());
        assert.equal(e1.instanceId, 'tab-A');
        assert.deepEqual(e2.frame, e1.frame, 'ambos clientes reciben la misma trama');
    } finally {
        c1.req.destroy();
        c2.req.destroy();
    }
});

test('Servidor: relay — envelope inválido → 400 y métodos no permitidos → 405', async () => {
    assert.equal(await postRelay({ noframe: true }), 400, 'sin frame → 400');
    assert.equal(await postRelay({ frame: {}, networkId: 'X', instanceId: 'Y', kind: 'DATA' }), 400, 'frame vacío → 400');
    const badVersion = { ...RELAY_ENV, v: 99 };
    assert.equal(await postRelay(badVersion), 400, 'versión de protocolo inválida → 400');
    const getStatus = await new Promise((resolve) => {
        http.get(base + '/relay/send', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0));
    });
    assert.equal(getStatus, 405, 'GET /relay/send → 405');
    assert.equal(await postRelay(RELAY_ENV), 204, 'envelope válido sigue funcionando');
});

// ── Descubrimiento de pares (cada dispositivo corre su propio server) ──

function jsonGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function waitPeers(url, count, timeout = 2500) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const j = await jsonGet(url);
        if (j.peers.length >= count) return j.peers;
        if (Date.now() > deadline) return j.peers;
        await new Promise((r) => setTimeout(r, 50));
    }
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, resolve));
}

test('Servidor: /api/state expone identidad y estado de alerta', async () => {
    const st = await jsonGet(base + '/api/state');
    assert.equal(st.ok, true);
    assert.ok(st.instanceId, 'id de instancia');
    assert.equal(st.networkId, 'LIFELINE-001');
    assert.equal(st.state, 'DORMANT', 'inicia dormido');
    assert.equal(st.active, false);
    assert.ok(st.url, 'URL canónica del dispositivo');
});

test('Servidor: helpers de descubrimiento LAN', () => {
    assert.equal(subnetBroadcast({ address: '192.168.0.11', netmask: '255.255.255.0' }), '192.168.0.255');
    assert.equal(subnetBroadcast({ address: '10.1.2.3', netmask: '255.255.0.0' }), '10.1.255.255');
    assert.equal(subnetBroadcast({ address: '172.16.0.1', netmask: '255.255.255.0' }), '172.16.0.255');
    assert.equal(isActiveState('VIGILANCE'), true);
    assert.equal(isActiveState('ECO'), true);
    assert.equal(isActiveState('DORMANT'), false);
    assert.equal(isActiveState('ORPHAN'), false);
    assert.equal(isActiveState(null), false);
    assert.ok(Array.isArray(lanAddresses()));
});

test('Servidor: descubrimiento UDP — dos dispositivos en VIGILANCE se descubren y el BYE los separa', async () => {
    const opts = {
        discoveryPort: 42601,
        broadcastAddress: '255.255.255.255',
        discoveryIntervalMs: 60,
        peerTtlMs: 1000,
    };
    const A = createServer({ ...opts, label: 'PC', instanceId: 'A-DISC' });
    const B = createServer({ ...opts, label: 'TELÉFONO', instanceId: 'B-DISC' });
    try {
        await Promise.all([listen(A), listen(B)]);
        const baseA = `http://127.0.0.1:${A.address().port}`;
        const baseB = `http://127.0.0.1:${B.address().port}`;
        // DORMANT: nadie se anuncia → no hay pares
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await jsonGet(baseA + '/api/peers')).peers.length, 0, 'DORMANT invisible');

        await postJson(baseA + '/api/state', { state: 'VIGILANCE' });
        await postJson(baseB + '/api/state', { state: 'VIGILANCE' });
        const pa = await waitPeers(baseA + '/api/peers', 1);
        const pb = await waitPeers(baseB + '/api/peers', 1);
        assert.equal(pa[0].label, 'TELÉFONO', 'A ve a B');
        assert.equal(pa[0].state, 'VIGILANCE');
        assert.equal(pb[0].label, 'PC', 'B ve a A');
        assert.match(pb[0].url, /^http:\/\//);

        // B sale de alerta → A lo olvida por BYE (no espera el TTL)
        await postJson(baseB + '/api/state', { state: 'DORMANT' });
        const pa2 = await waitPeers(baseA + '/api/peers', 0, 2500);
        assert.equal(pa2.length, 0, 'BYE evicta al par que salió de alerta');
    } finally {
        A.close();
        B.close();
    }
});

test('Servidor: POST /api/peers añade pares manuales (probe server→server) y filtra inactivos', async () => {
    const A = createServer({ label: 'PC', instanceId: 'A-MAN', discovery: false });
    const B = createServer({ label: 'TELÉFONO', instanceId: 'B-MAN', discovery: false });
    try {
        await Promise.all([listen(A), listen(B)]);
        const baseA = `http://127.0.0.1:${A.address().port}`;
        const baseB = `http://127.0.0.1:${B.address().port}`;

        // B DORMANT → probe no lo añade
        await postJson(baseA + '/api/peers', { peers: [baseB] });
        assert.equal((await jsonGet(baseA + '/api/peers')).peers.length, 0, 'par DORMANT descartado');

        // B en alerta → se añade con su identidad
        await postJson(baseB + '/api/state', { state: 'VIGILANCE', label: 'TELÉFONO' });
        await postJson(baseA + '/api/peers', { peers: [baseB] });
        const pa = await waitPeers(baseA + '/api/peers', 1);
        assert.equal(pa[0].label, 'TELÉFONO');
        assert.equal(pa[0].state, 'VIGILANCE');

        // cuerpos inválidos
        const rBad = await postJson(baseA + '/api/peers', { peers: 'no-array' });
        assert.equal(rBad, 200, 'peers no-array → lista vacía (200)');
        assert.equal((await jsonGet(baseA + '/api/peers')).peers.length, 1, 'sin añadir nada');
        assert.equal(await postJson(baseA + '/api/state', { state: 42 }), 400);
        assert.equal(await postJson(baseA + '/api/state', {}), 200, 'sin state → DORMANT');
    } finally {
        A.close();
        B.close();
    }
});
