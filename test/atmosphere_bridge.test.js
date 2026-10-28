'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseCO, parseO2, evaluateAtmosphere, LifelineAtmosphereBridge,
    ENV_SERVICE, CO_CHAR, O2_CHAR,
} = require('../radio/atmosphere_bridge.js');

function dataview(bytes) {
    return { target: { value: new DataView(new Uint8Array(bytes).buffer) } };
}

test('Atmósfera: parseCO lee ppm u16 LE', () => {
    assert.deepEqual(parseCO(new Uint8Array([0x2A, 0x00])), { coPpm: 42 });
    assert.deepEqual(parseCO(new Uint8Array([0xE8, 0x03])), { coPpm: 1000 });
});

test('Atmósfera: parseO2 lee porcentaje (u16 LE / 100)', () => {
    assert.deepEqual(parseO2(new Uint8Array([0xD9, 0x07])), { o2Pct: 20.09 });
});

test('Atmósfera: lecturas null/invalid → null sin inventar', () => {
    assert.equal(parseCO(null), null);
    assert.equal(parseCO(new Uint8Array([1])), null);
    assert.equal(parseO2(new Uint8Array([])), null);
});

test('Atmósfera: evalua CO — SAFE/WATCH/HAZARD/SEVERE y alarma audible', () => {
    assert.equal(evaluateAtmosphere(20, 20.9).level, 'SAFE');
    assert.equal(evaluateAtmosphere(20, 20.9).audible, false);
    assert.equal(evaluateAtmosphere(50, 20.9).level, 'WATCH');
    assert.equal(evaluateAtmosphere(50, 20.9).audible, false);
    assert.equal(evaluateAtmosphere(250, 20.9).level, 'HAZARD');
    assert.equal(evaluateAtmosphere(250, 20.9).audible, true);
    assert.equal(evaluateAtmosphere(1500, 20.9).level, 'SEVERE');
    assert.equal(evaluateAtmosphere(1500, 20.9).audible, true);
});

test('Atmósfera: O2 bajo dispara alarma (deficiencia de oxígeno)', () => {
    assert.equal(evaluateAtmosphere(5, 19).level, 'WATCH');
    assert.equal(evaluateAtmosphere(5, 15).level, 'HAZARD');
    assert.equal(evaluateAtmosphere(5, 15).audible, true);
    assert.equal(evaluateAtmosphere(5, 9).level, 'SEVERE');
});

test('Atmósfera: el peor de CO/O2 define el nivel', () => {
    const r = evaluateAtmosphere(1500, 9);
    assert.equal(r.level, 'SEVERE');
    const r2 = evaluateAtmosphere(300, 15.2);
    assert.equal(r2.level, 'HAZARD');
});

test('Atmósfera: sin Web Bluetooth → honesto WEB_BLUETOOTH_NO_DISPONIBLE', async () => {
    const b = new LifelineAtmosphereBridge();
    // sin navigator.bluetooth en Node
    const r = await b.connect();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'WEB_BLUETOOTH_NO_DISPONIBLE');
});

test('Atmósfera: attach wearable real con lecturas de CO y O2', async () => {
    const readings = [];
    const cbs = {};
    const b = new LifelineAtmosphereBridge({ onReading: (r) => readings.push(r) });
    const fakeServer = {
        getPrimaryService: async (uuid) => {
            assert.equal(uuid, ENV_SERVICE);
            return {
                getCharacteristic: async (charUuid) => ({
                    startNotifications: async () => {},
                    addEventListener: (ev, cb) => { cbs[charUuid] = cb; },
                }),
            };
        },
    };
    const device = { gatt: { connect: async () => fakeServer } };
    const res = await b.attach(device);
    assert.equal(res.ok, true);
    assert.equal(res.services.includes('CO'), true);
    assert.equal(res.services.includes('O2'), true);

    // CO characteristic (0x2BD0): 42 ppm
    cbs[CO_CHAR](dataview([0x2A, 0x00]));
    assert.deepEqual(readings[0], { coPpm: 42 });
    // O2 characteristic (0x2BD5): 20.09%
    cbs[O2_CHAR](dataview([0xD9, 0x07]));
    assert.deepEqual(readings[1], { o2Pct: 20.09 });
});

test('Atmósfera: device GATT sin servicio ambiental → SIN_SERVICIO_AMBIENTAL', async () => {
    const b = new LifelineAtmosphereBridge();
    const fakeServer = {
        getPrimaryService: async () => { throw new SyntaxError('no service'); },
    };
    const device = { gatt: { connect: async () => fakeServer } };
    const res = await b.attach(device);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'SIN_SERVICIO_AMBIENTAL');
    assert.deepEqual(res.services, []);
});