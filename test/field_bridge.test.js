'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LifelineFieldBridge, parseSimple, isSupported } = require('../radio/field_bridge.js');

test('field_bridge: parseSimple extrae el valor de una línea "KEY valor"', () => {
    assert.equal(parseSimple('UWB 3.42', 'UWB'), '3.42');
    assert.equal(parseSimple('ORI 10 20 30', 'ORI'), '10 20 30');
    assert.equal(parseSimple('THERMAL aa', 'UWB'), null, 'prefijo no coincide');
});

test('field_bridge: inyectar una línea llega a los handlers y a la térmica', () => {
    const fb = new LifelineFieldBridge();
    const lines = [];
    fb.onLine((l) => lines.push(l));
    // La térmica enlaza el transporte y recibe THERMAL.
    const thCam = { got: null, attach(transport) { transport.onLine((l) => { this.got = l; }); } };
    thCam.attach(fb.thermalTransport);

    fb.injectLine('UWB 4.2');
    assert.deepEqual(lines, ['UWB 4.2'], 'handler recibe la línea');
    fb.injectLine('THERMAL a1b2');
    assert.equal(thCam.got, 'THERMAL a1b2', 'la térmica recibe la rejilla');
    assert.equal(lines.length, 2, 'los handlers también ven la línea térmica');
});

test('field_bridge: fragmentos de texto se parten en líneas (puede cortar a mitad)', () => {
    const fb = new LifelineFieldBridge();
    const lines = [];
    fb.onLine((l) => lines.push(l));
    fb.injectChunk('UWB 3.\nORI 1 2 3\nTHER');
    fb.injectChunk('MAL aabb\n');
    assert.deepEqual(lines, ['UWB 3.', 'ORI 1 2 3', 'THERMAL aabb']);
});

test('field_bridge: sin puerto → attach falla honesto (SIN_PUERTO), sin inventar líneas', () => {
    const fb = new LifelineFieldBridge();
    assert.equal(fb.connected, false);
    assert.equal(fb._lineHandlers.length, 0);
});

test('field_bridge: attach a un puerto sin readable conecta', async () => {
    const fb = new LifelineFieldBridge();
    const res = await fb.attach({ __opened: false, open: async () => {}, readable: null });
    assert.equal(res.ok, true);
    assert.equal(fb.connected, true);
    assert.equal(isSupported(), false, 'en Node no hay navigator.serial');
});