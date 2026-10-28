'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireSim } = require('./helpers.js');
const { RelayAdapter } = requireSim('relay_adapter.js');
const { createEngine } = requireSim('lifeline_engine.js');

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function snapshot(extra = {}) {
    return {
        gps: { lat: -34.603722, lon: -58.381592 },
        pressure: 102400,
        bpm: 96,
        spo2: 97,
        battery: 61,
        depth_m: 5.7,
        role: 'VICTIM',
        tilt: 40,
        light: 3,
        mic: 25,
        ...extra,
    };
}

// Fake SSE + fetch para simular el navegador en Node.
function installFakeTransport() {
    const sources = [];
    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.closed = false;
            this._h = {};
            sources.push(this);
        }
        set onopen(fn) { this._h.open = fn; }
        set onmessage(fn) { this._h.message = fn; }
        set onerror(fn) { this._h.error = fn; }
        close() { this.closed = true; }
        emit(data) { if (this._h.message) this._h.message({ data }); }
        open() { if (this._h.open) this._h.open(); }
    }
    const posts = [];
    const realFetch = globalThis.fetch;
    const realES = globalThis.EventSource;
    globalThis.fetch = (url, opts) => {
        posts.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ ok: true, status: 204 });
    };
    globalThis.EventSource = FakeEventSource;
    return {
        sources,
        posts,
        restore() {
            globalThis.fetch = realFetch;
            if (realES === undefined) delete globalThis.EventSource;
            else globalThis.EventSource = realES;
        },
    };
}

test('RelayAdapter: disponible, conecta, reenvía TX y materializa RX en la malla', () => {
    const t = installFakeTransport();
    const A = createEngine({ key: KEY });
    const B = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
    let aAdap = null;
    let bAdap = null;
    try {
        aAdap = new RelayAdapter({ mesh: A.mesh, instanceId: 'tab-A', networkId: 'LIFELINE-001', name: 'PC', relayUrl: '' });
        assert.equal(aAdap.available, true, 'EventSource + fetch presentes');
        assert.equal(aAdap.connect(), true, 'conecta al relay');
        bAdap = new RelayAdapter({ mesh: B.mesh, instanceId: 'tab-B', networkId: 'LIFELINE-001', name: 'TELÉFONO', relayUrl: '' });
        bAdap.connect();
        assert.equal(t.sources.length, 2, 'dos EventSource (uno por pestaña)');

        B.start();
        const hex = B.sendLocalTelemetry(snapshot());
        assert.ok(hex, 'telemetría de B');

        const post = t.posts.find(
            (p) => p.url.endsWith('/relay/send') && p.body.kind === 'DATA' && p.body.frame.payload.payload.trama_hex === hex
        );
        assert.ok(post, 'frame de B reenviado por POST /relay/send');
        assert.equal(post.body.instanceId, 'tab-B');
        assert.equal(post.body.name, 'TELÉFONO');
        assert.equal(post.body.networkId, 'LIFELINE-001');

        // El relay difunde a A: A recibe el envelope de B por SSE.
        t.sources[0].emit(JSON.stringify(post.body));
        const remote = A.getNodes().find((n) => n.id === 'BBBBBBBB00000002');
        assert.ok(remote, 'A materializó el nodo de B sin ingest()');
        assert.equal(remote.label, 'TELÉFONO', 'nombre del dispositivo remoto');
        assert.equal(remote.role, 'VICTIM');
        assert.equal(remote.bpm, 96);
        assert.equal(remote.pressure, 102400);
        assert.ok(aAdap.getStats().rx >= 1, 'contador RX del adaptador');

        // Auto-eco: A ignora su propio envelope (instanceId).
        const selfEnv = t.posts.find((p) => p.body.instanceId === 'tab-A');
        const before = A.getNodes().length;
        if (selfEnv) {
            t.sources[0].emit(JSON.stringify(selfEnv.body));
            assert.equal(A.getNodes().length, before, 'auto-eco descartado');
        }

        // Otra red: se ignora.
        const otherNet = { ...post.body, networkId: 'OTRA-RED' };
        t.sources[0].emit(JSON.stringify(otherNet));
        assert.equal(A.getNodes().length, before, 'frames de otra red descartados');
    } finally {
        if (bAdap) bAdap.close();
        if (aAdap) aAdap.close();
        B.stop();
        t.restore();
    }
});

test('RelayAdapter: sin EventSource/fetch no conecta y no engancha la malla', () => {
    const t = installFakeTransport();
    try {
        // Quitar el transporte antes de construir.
        const realFetch = globalThis.fetch;
        delete globalThis.fetch;
        delete globalThis.EventSource;
        const A = createEngine({ key: KEY });
        const adap = new RelayAdapter({ mesh: A.mesh, instanceId: 'tab-A', networkId: 'LIFELINE-001', name: 'PC' });
        assert.equal(adap.available, false, 'sin transporte no disponible');
        assert.equal(adap.connect(), false, 'connect falla');
        assert.equal(adap.getStats().error, 'no-browser-api');
        globalThis.fetch = realFetch;
    } finally {
        t.restore();
    }
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('RelayAdapter: setAlertState conecta pares del mismo estado, TX a local+par, DORMANT los cierra', async () => {
    const t = installFakeTransport();
    const A = createEngine({ key: KEY });
    const adap = new RelayAdapter({ mesh: A.mesh, instanceId: 'tab-A', networkId: 'LIFELINE-001', name: 'PC' });
    try {
        adap.connect();
        const peerUrl = 'http://192.168.0.5:8000';
        const statePosts = [];
        const relayPosts = [];
        globalThis.fetch = (url, opts = {}) => {
            if (url.endsWith('/api/state')) {
                statePosts.push(JSON.parse(opts.body));
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
            }
            if (url.endsWith('/api/peers')) {
                return Promise.resolve({
                    ok: true, status: 200,
                    json: async () => ({
                        ok: true,
                        peers: [{ url: peerUrl, label: 'TELÉFONO', state: 'VIGILANCE' }],
                    }),
                });
            }
            if (url.endsWith('/relay/send')) {
                relayPosts.push({ url, body: JSON.parse(opts.body) });
                return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
            }
            return Promise.reject(new Error('no-route ' + url));
        };

        adap.setAlertState('VIGILANCE');
        await delay(30); // esperar el refresh de pares (async)
        assert.equal(statePosts.length, 1, 'reporta estado al servidor local');
        assert.equal(statePosts[0].state, 'VIGILANCE');
        assert.equal(statePosts[0].label, 'PC');
        assert.equal(adap.getPeers().length, 1, 'par descubierto');
        assert.equal(adap.getPeers()[0].label, 'TELÉFONO');

        // TX real del motor → POST al servidor local y al par (malla completa)
        A.start();
        A.sendLocalTelemetry(snapshot());
        await delay(20);
        assert.ok(relayPosts.length >= 1, 'TX reenviado');
        const urls = relayPosts.map((p) => p.url);
        assert.ok(urls.some((u) => u === '/relay/send'), 'servidor local');
        assert.ok(urls.some((u) => u === peerUrl + '/relay/send'), 'par remoto');
        assert.equal(relayPosts[0].body.instanceId, 'tab-A', 'identidad del emisor');

        // Un frame ajeno llega por el SSE local (el par lo reenvió a este server)
        const B = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
        const hexB = B.buildTelemetryPacket(snapshot({ role: 'VICTIM' }));
        assert.ok(hexB, 'hex real del par');
        const rawB = {
            type: 'DATA', sourceId: 'BBBBBBBB00000002', sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF', timestamp: Date.now(), hopCount: 0,
            payload: { trama_hex: hexB }, packetId: 'p1',
        };
        t.sources[0].emit(JSON.stringify({
            v: 1, instanceId: 'tab-B', name: 'TELÉFONO', networkId: 'LIFELINE-001', kind: 'DATA',
            frame: B.localNode.encodePacket(rawB),
        }));
        const remote = A.getNodes().find((n) => n.id === 'BBBBBBBB00000002');
        assert.ok(remote, 'frame del par materializado');
        assert.equal(remote.label, 'TELÉFONO');

        // DORMANT: cierra el polling y los pares
        adap.setAlertState('DORMANT');
        assert.equal(statePosts.length, 2, 'reporta DORMANT');
        assert.equal(statePosts[1].state, 'DORMANT');
        assert.equal(adap.getPeers().length, 0, 'pares cerrados');
    } finally {
        adap.close();
        A.stop();
        t.restore();
    }
});
