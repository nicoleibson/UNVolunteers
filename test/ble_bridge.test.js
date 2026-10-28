'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio } = require('./helpers.js');
const {
    LifelineBleBridge,
    parseHeartRate,
    parsePulseOximeter,
    BLE_HR_SERVICE,
    BLE_PLX_SERVICE,
    BLE_HR_CHAR,
    BLE_PLX_CONT_CHAR,
} = requireRadio('ble_bridge.js');

function fakeChar() {
    const handlers = [];
    return {
        value: null,
        addEventListener(type, fn) { if (type === 'characteristicvaluechanged') handlers.push(fn); },
        startNotifications() { return Promise.resolve(); },
        dispatch(evt) { handlers.forEach((fn) => fn(evt)); },
    };
}

function fakeDevice(chars) {
    const map = {
        [BLE_HR_SERVICE]: { getCharacteristic: async (uuid) => { if (uuid === BLE_HR_CHAR) return chars.hr; throw new Error('no'); } },
        [BLE_PLX_SERVICE]: { getCharacteristic: async (uuid) => { if (uuid === BLE_PLX_CONT_CHAR) return chars.plx; throw new Error('no'); } },
    };
    return {
        name: 'PULSIO-X',
        gatt: { connect: async () => ({ getPrimaryService: async (uuid) => {
            if (map[uuid]) return map[uuid];
            throw new Error('service missing');
        } }) },
    };
}

test('BLE: parseadores GATT estándar', () => {
    // Heart Rate: flags 0x00 → BPM u8
    assert.deepEqual(parseHeartRate([0x00, 96]), { bpm: 96 });
    // flags 0x01 → BPM u16 little-endian
    assert.deepEqual(parseHeartRate([0x01, 96, 1]), { bpm: 0x0160 });
    // datos insuficientes → null (no inventa)
    assert.equal(parseHeartRate([0x00]), null);

    // PLX continuous: flags bit0 (SpO2 u8) + bit2 (PR u8)
    assert.deepEqual(parsePulseOximeter([0b00000101, 97, 78]), { spo2: 97, bpm: 78 });
    // sin flags de datos → campos null
    assert.deepEqual(parsePulseOximeter([0x00, 5]), { spo2: null, bpm: null });
    assert.equal(parsePulseOximeter([0x05]), null, 'trama corta → null');
});

test('BLE: sin Web Bluetooth (Node) el puente reporta honestamente', async () => {
    assert.equal(LifelineBleBridge.isSupported(), false, 'Node no expone navigator.bluetooth');
    const bridge = new LifelineBleBridge({});
    const res = await bridge.connect();
    assert.equal(res.ok, false);
    assert.equal(res.error, 'WEB_BLUETOOTH_NO_DISPONIBLE');
});

test('BLE: attach a un wearable real entrega lecturas vitales', async () => {
    const readings = [];
    const charHR = fakeChar();
    const charPLX = fakeChar();
    const bridge = new LifelineBleBridge({ onReading: (r) => readings.push(r) });

    const res = await bridge.attach(fakeDevice({ hr: charHR, plx: charPLX }));
    assert.equal(res.ok, true);
    assert.deepEqual(res.services, ['HR', 'PLX'], 'ambos servicios vitales');
    assert.equal(bridge.connected, true);

    // Heart Rate llega como notificación real
    charHR.dispatch({ target: { value: new Uint8Array([0x00, 96]) } });
    assert.deepEqual(readings[0], { bpm: 96 }, 'BPM real del wearable');
    // SpO2 + PR del oxímetro
    charPLX.dispatch({ target: { value: new Uint8Array([0b00000101, 97, 78]) } });
    assert.deepEqual(readings[1], { bpm: 78, spo2: 97 }, 'SpO2 y pulso reales');
});

test('BLE: wearable sin servicios vitales → BLE_SIN_SERVICIOS_VITALES (no inventa)', async () => {
    const bridge = new LifelineBleBridge({ onReading: () => { throw new Error('no debe leer'); } });
    const device = {
        name: 'SIN-VITALES',
        gatt: { connect: async () => ({ getPrimaryService: async () => { throw new Error('no'); } }) },
    };
    const res = await bridge.attach(device);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BLE_SIN_SERVICIOS_VITALES');
    assert.equal(bridge.connected, false);
});

test('BLE: notificaciones con DataView también se parsean', async () => {
    const readings = [];
    const charHR = fakeChar();
    const bridge = new LifelineBleBridge({ onReading: (r) => readings.push(r) });
    await bridge.attach(fakeDevice({ hr: charHR, plx: fakeChar() }));

    const bytes = new Uint8Array([0x00, 88]);
    charHR.dispatch({ target: { value: { buffer: bytes.buffer } } });
    assert.deepEqual(readings[0], { bpm: 88 }, 'DataView (Web Bluetooth real) parseado');
});
