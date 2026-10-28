'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio } = require('./helpers.js');
const { LoRaRadioDriver, SerialLineTransport, toHex, fromHex } = requireRadio('radio_driver.js');

class FakeTransport {
    constructor() {
        this.sent = [];
        this.onLine = null;
        this.started = false;
        this.closed = false;
    }
    async start() { this.started = true; }
    send(line) { this.sent.push(line); return Promise.resolve(true); }
    emit(line) { if (this.onLine) this.onLine(line); }
    async close() { this.closed = true; }
}

const tick = () => new Promise((r) => setImmediate(r));

// Espera de forma determinista a que el driver registre su listener de línea
// (evita un race al emitir EVT READY antes de que escuche, sobre todo bajo carga).
async function waitLineHandler(transport, max = 25) {
    let n = 0;
    await tick();
    while (!transport.onLine && n < max) { await tick(); n++; }
    return transport.onLine != null;
}

function driverWithTransport(overrides = {}) {
    const transport = new FakeTransport();
    const driver = new LoRaRadioDriver({ transport, timeoutMs: 150, ...overrides });
    return { driver, transport };
}

async function connectReady(driver, transport, readyLine = 'EVT READY {"radio":"SX1276"}') {
    const pending = driver.connect();
    await waitLineHandler(transport); // RESET sale y el driver escucha
    transport.emit(readyLine);
    const res = await pending;
    assert.equal(res.ok, true, 'conexión ok');
    return res;
}

test('Radio: sin Web Serial (Node) el driver reporta honestamente', async () => {
    assert.equal(LoRaRadioDriver.isSupported(), false, 'Node no expone navigator.serial');
    const d = new LoRaRadioDriver({ timeoutMs: 50 });
    const res = await d.connect();
    assert.equal(res.ok, false);
    assert.equal(res.error, 'WEB_SERIAL_NO_DISPONIBLE');
    assert.equal(d.status().connected, false);
});

test('Radio: transmit sin conexión → NO_CONECTADO (no inventa TX)', async () => {
    const d = new LoRaRadioDriver({ timeoutMs: 50 });
    const res = await d.transmit('AABB');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'NO_CONECTADO');
});

test('Radio: connect con transporte envía RESET y espera EVT READY', async () => {
    const { driver, transport } = driverWithTransport();
    const pending = driver.connect();
    await waitLineHandler(transport);
    assert.equal(transport.started, true, 'transporte iniciado');
    assert.deepEqual(transport.sent, ['RESET'], 'RESET enviado al firmware');
    transport.emit('EVT READY {"radio":"SX1276","freq":915000000}');
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.connected, true);
    assert.equal(res.radio, 'SX1276');
    assert.equal(driver.status().connected, true);
});

test('Radio: connect sin respuesta → SIN_RESPUESTA_DEL_RADIO', async () => {
    const { driver } = driverWithTransport({ timeoutMs: 30 });
    const res = await driver.connect();
    assert.equal(res.ok, false);
    assert.equal(res.error, 'SIN_RESPUESTA_DEL_RADIO');
});

test('Radio: ERROR al conectar → se reporta sin marcar conectado', async () => {
    const { driver, transport } = driverWithTransport({ timeoutMs: 150 });
    const pending = driver.connect();
    await waitLineHandler(transport);
    transport.emit('ERROR BOOT_FAIL');
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BOOT_FAIL');
    assert.equal(driver.status().connected, false);
});

test('Radio: transmit envía TX <hex> y confirma con OK', async () => {
    const { driver, transport } = driverWithTransport();
    await connectReady(driver, transport);
    transport.sent.length = 0;

    const pending = driver.transmit('AABBCC');
    assert.deepEqual(transport.sent, ['TX AABBCC'], 'trama hex enviada al transceptor');
    transport.emit('OK');
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.bytes, 3, 'bytes transmitidos');
});

test('Radio: ERROR del firmware → TX fallido con el código', async () => {
    const { driver, transport } = driverWithTransport();
    await connectReady(driver, transport);
    const pending = driver.transmit('AABB');
    transport.emit('ERROR TX_TIMEOUT');
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'TX_TIMEOUT');
});

test('Radio: configure envía CONFIG JSON y confirma', async () => {
    const { driver, transport } = driverWithTransport();
    await connectReady(driver, transport);
    transport.sent.length = 0;

    const pending = driver.configure({ frequency: 915000000, spreadingFactor: 10, bandwidth: 125000, txPower: 20 });
    const sent = transport.sent[0];
    assert.ok(sent.startsWith('CONFIG '), 'CONFIG enviado');
    const cfg = JSON.parse(sent.slice(7));
    assert.equal(cfg.freq, 915000000);
    assert.equal(cfg.sf, 10);
    transport.emit('OK');
    const res = await pending;
    assert.equal(res.ok, true);
});

test('Radio: EVT RX dispara onFrame con hex/rssi/snr reales', async () => {
    const frames = [];
    const { driver, transport } = driverWithTransport({ onFrame: (f) => frames.push(f) });
    await connectReady(driver, transport);
    transport.emit('EVT RX AABBCC -73 5');
    assert.equal(frames.length, 1, 'frame recibido');
    assert.equal(frames[0].hex, 'AABBCC');
    assert.equal(frames[0].rssi, -73);
    assert.equal(frames[0].snr, 5);
    assert.equal(frames[0].source, 'radio');
});

test('Radio: helpers toHex/fromHex y TX por Uint8Array', async () => {
    assert.equal(toHex([0x00, 0xFF, 0x10]), '00FF10');
    assert.deepEqual(Array.from(fromHex('00ff10')), [0x00, 0xFF, 0x10]);
    const { driver, transport } = driverWithTransport();
    await connectReady(driver, transport);
    transport.sent.length = 0;
    const pending = driver.transmit(new Uint8Array([0xDE, 0xAD]));
    assert.deepEqual(transport.sent, ['TX DEAD'], 'Uint8Array codificado a hex');
    transport.emit('OK');
    const res = await pending;
    assert.equal(res.ok, true);
});

test('Radio: timeout de confirmación → TX_SIN_CONFIRMACION', async () => {
    const { driver, transport } = driverWithTransport({ timeoutMs: 30 });
    await connectReady(driver, transport);
    const res = await driver.transmit('AABB');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'TX_SIN_CONFIRMACION');
});

test('Radio: SerialLineTransport separa el flujo de bytes en líneas', async () => {
    const transport = new SerialLineTransport({});
    const lines = [];
    transport.onLine = (l) => lines.push(l);
    transport._feed('OK\nEVT RX AABB -70\nEVT READY {"rad');
    transport._feed('io":"SX1276"}\n');
    assert.deepEqual(lines, ['OK', 'EVT RX AABB -70', 'EVT READY {"radio":"SX1276"}']);
});
