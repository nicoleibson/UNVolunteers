'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { DeviceLinkManager } = require('../radio/device_links.js');

// Requisito: cada sensor/dispositivo se enlaza de forma INDEPENDIENTE —
// conecta/desconecta por su cuenta, con su propio estado y sus propios
// datos. El gestor solo reenvía eventos; no comparte estado entre enlaces.

function fakeBrand(id, name, kind, ok = true, error = 'SIN_HARDWARE', supported = true) {
    return {
        id, name, kind,
        isSupported: () => supported,
        factory: () => ({
            bridge: { tag: id },
            opts: {},
            connect: async () => {
                if (!ok) return { ok: false, connected: false, error };
                return { ok: true, connected: true, radio: name };
            },
            disconnect: async () => {},
        }),
    };
}

test('gestor: registra marcas y lista los dispositivos con soporte', () => {
    const m = new DeviceLinkManager([
        fakeBrand('RADIO', 'Radio LoRa', 'rf'),
        fakeBrand('BLE', 'Wearable', 'vitals'),
        fakeBrand('CAMPO', 'UWB/IMU', 'field', true, '', false), // no soportado
    ]);
    const list = m.list();
    assert.equal(list.length, 3);
    assert.equal(m.has('RADIO'), true);
    assert.equal(m.has('NOPE'), false);
    const byId = Object.fromEntries(list.map((d) => [d.id, d]));
    assert.equal(byId.RADIO.supported, true);
    assert.equal(byId.CAMPO.supported, false, 'no soportado se refleja');
});

test('gestor: conectar un id desconocido responde NO_DEVICE honesto', async () => {
    const m = new DeviceLinkManager([]);
    const res = await m.connect('X');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'NO_DEVICE');
});

test('gestor: cada dispositivo conecta y mantiene SU PROPIO estado aislado', async () => {
    const m = new DeviceLinkManager([
        fakeBrand('RADIO', 'Radio', 'rf'),
        fakeBrand('BLE', 'Wearable', 'vitals'),
    ]);
    const statuses = {};
    m.sub('RADIO', 'status', (s) => { statuses.RADIO = s; });
    m.sub('BLE', 'status', (s) => { statuses.BLE = s; });

    await m.connect('RADIO');
    assert.equal(m.status('RADIO').state, 'up');
    assert.equal(m.status('BLE').state, 'down', 'BLE intacto: sin contaminar');

    await m.connect('BLE');
    assert.equal(m.status('RADIO').state, 'up');
    assert.equal(m.status('BLE').state, 'up');

    await m.disconnect('RADIO');
    assert.equal(m.status('RADIO').state, 'down');
    assert.equal(m.status('BLE').state, 'up', 'BLE sigue arriba tras desconectar RADIO');

    assert.equal(statuses.BLE.state, 'up', 'el suscriptor de BLE recibió su estado');
    assert.equal(statuses.RADIO.state, 'down', 'el suscriptor de RADIO recibió su estado');
});

test('gestor: datos y estado por dispositivo llegan SOLO a su suscriptor', async () => {
    const m = new DeviceLinkManager([fakeBrand('A', 'A', 'x'), fakeBrand('B', 'B', 'y')]);
    const dataA = [];
    const dataB = [];
    m.sub('A', 'data', (d) => dataA.push(d));
    m.sub('B', 'data', (d) => dataB.push(d));

    await m.connect('A');
    await m.connect('B');
    const linkA = m._links.get('A');
    linkA._emitData({ source: 'A', v: 1 });
    linkA._emitData({ source: 'A', v: 2 });
    const linkB = m._links.get('B');
    linkB._emitData({ source: 'B', v: 9 });

    assert.deepEqual(dataA.map((d) => d.v), [1, 2]);
    assert.deepEqual(dataB.map((d) => d.v), [9], 'B no recibe datos de A');
});

test('gestor: conectar idempotente y honestidad de fallo sin hardware', async () => {
    const m = new DeviceLinkManager([
        fakeBrand('OK', 'Ok', 'x'),
        fakeBrand('ROTO', 'Roto', 'y', false, 'WEB_SERIAL_NO_DISPONIBLE'),
    ]);
    const r1 = await m.connect('OK');
    assert.equal(r1.ok, true);
    const r2 = await m.connect('OK');
    assert.equal(r2.already, true, 'no reabre transceiver duplicado');

    const bad = await m.connect('ROTO');
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'WEB_SERIAL_NO_DISPONIBLE');
    assert.equal(m.status('ROTO').state, 'error');
    assert.equal(m.status('OK').state, 'up', 'el error de uno no afecta al otro');
});

test('gestor: connect() de un id con factory que lanza devuelve FAULT y error aislado', async () => {
    const m = new DeviceLinkManager([
        { id: 'R', name: 'R', kind: 'k', factory: () => { throw new Error('boom'); } },
    ]);
    const res = await m.connect('R');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'boom');
    assert.equal(m.status('R').state, 'error');
});

test('gestor: disconnectAll baja todos los enlaces', async () => {
    const m = new DeviceLinkManager([fakeBrand('A', 'A', 'x'), fakeBrand('B', 'B', 'y')]);
    await m.connect('A');
    await m.connect('B');
    await m.disconnectAll();
    assert.equal(m.status('A').state, 'down');
    assert.equal(m.status('B').state, 'down');
});
