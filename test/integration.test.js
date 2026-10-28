'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, sleep } = require('./helpers.js');
const { PacketEncoder, PacketBuilder, PACKET_CONFIG } = requireRadio('packet_encoder.js');
const { AX25Frame, APRSPacket } = requireRadio('aprs_protocol.js');
const { LoRaNode, LoRaMesh } = requireRadio('lora_mesh.js');

const BA = { lat: -34.603722, lon: -58.381592 };

function sensorPayload() {
    return {
        gps: { lat: BA.lat, lon: BA.lon, alt: 25 },
        baro_hpa: 1018.0,
        bpm: 96,
        spo2: 97,
        battery: 61,
        depth_m: 32.1,
    };
}

test('Integración: sensor → PacketEncoder(BINARY+XOR+LZ77) → AX.25 → decode → payload', () => {
    const payload = sensorPayload();
    const encoder = new PacketEncoder({ encoding: 'BINARY', compression: 'LZ77', encryption: 'XOR' });

    // 1. Sensor → paquete binario
    const packet = new PacketBuilder()
        .setType(PACKET_CONFIG.types.DATA)
        .setSource('29CD40CE00032356')
        .setDestination('FFFFFFFFFFFFFFFF')
        .setSequence(7)
        .setPayload(payload)
        .build();
    const bytes = encoder.encode(packet);

    // 2. Bytes → campo de información AX.25 (sin pérdida para valores 0..255)
    const info = String.fromCharCode(...bytes);
    const frame = new AX25Frame({
        sourceCallsign: 'LU1PNU', destinationCallsign: 'APRS',
        repeaterPath: ['WIDE1-1'], infoField: info,
    });

    // 3. AX.25 → red → decode
    const decoded = AX25Frame.decode(frame.encode());
    assert.equal(decoded.infoField.length, bytes.length, 'AX.25 preserva longitud binaria');

    const recoveredBytes = Array.from(decoded.infoField, (c) => c.charCodeAt(0));
    const recovered = encoder.decode(recoveredBytes);

    assert.equal(recovered.type, PACKET_CONFIG.types.DATA);
    assert.equal(recovered.sequence, 7);
    assert.equal(recovered.payload.bpm, payload.bpm);
    assert.equal(recovered.payload.gps.lat, payload.gps.lat);
    assert.equal(recovered.payload.depth_m, payload.depth_m);
});

test('Integración: APRS posición → AX.25 → LoRa mesh → receptor → infoField', async () => {
    const mesh = new LoRaMesh({ frequency: 'US915' });
    const scout = new LoRaNode({ id: 'CC00000000000001', name: 'SCOUT-1', type: 'SCOUT', ...BA });
    const victima = new LoRaNode({ id: 'CC00000000000002', name: 'VICTIM-1', type: 'VICTIM', ...BA });
    mesh.addNode(scout);
    mesh.addNode(victima);

    let received = null;
    victima.onPacket = (p) => { received = p; };

    // Posición APRS de un voluntario en Buenos Aires
    const aprs = new APRSPacket({ callsign: 'LU1PNU', latitude: BA.lat, longitude: BA.lon });
    const report = aprs.createPositionReport();
    assert.match(report.infoField, /^!/);

    // Empaquetar frame AX.25 en payload LoRa (hex) y enviar por la malla
    const axHex = Buffer.from(report.frame.encode()).toString('hex');
    mesh.sendPacket(scout.id, victima.id, { ax25_hex: axHex, canal: 'PNUD-BA' });
    await sleep(400);

    assert.ok(received, 'el receptor recibió el paquete');
    assert.equal(received.payload.canal, 'PNUD-BA');

    // Reconstrucción: hex → AX.25 → infoField APRS
    const axBytes = Array.from(Buffer.from(received.payload.ax25_hex, 'hex'));
    const ax = AX25Frame.decode(axBytes);
    assert.equal(ax.infoField, report.infoField, 'infoField APRS íntegro tras la malla');
    assert.equal(ax.sourceCallsign, 'LU1PNU');
});

test('Integración: telemetría end-to-end con cifrado XOR sobre la malla', async () => {
    const mesh = new LoRaMesh({ frequency: 'US915' });
    const a = new LoRaNode({ id: 'DD00000000000001', type: 'SCOUT', ...BA });
    const b = new LoRaNode({ id: 'DD00000000000002', type: 'VICTIM', lat: BA.lat + 0.001, lon: BA.lon + 0.001 });
    mesh.addNode(a);
    mesh.addNode(b);

    const encoder = new PacketEncoder({ encoding: 'CBOR', encryption: 'XOR' });
    const packet = new PacketBuilder()
        .setType(PACKET_CONFIG.types.TELEMETRY || PACKET_CONFIG.types.DATA)
        .setSource('DD00000000000001')
        .setSequence(9)
        .setPayload(sensorPayload())
        .build();
    const bytes = encoder.encode(packet);

    let received = null;
    b.onPacket = (p) => { received = p; };

    mesh.sendPacket(a.id, b.id, { trama_hex: Buffer.from(bytes).toString('hex') });
    await sleep(400);

    assert.ok(received, 'telemetría recibida en el nodo destino');
    const decBytes = Array.from(Buffer.from(received.payload.trama_hex, 'hex'));
    const dec = encoder.decode(decBytes);
    assert.equal(dec.sequence, 9);
    assert.equal(dec.payload.bpm, sensorPayload().bpm);
});

test('Integración: telemetría end-to-end con cifrado AES-CTR (LoRaWAN-style) sobre la malla', async () => {
    const mesh = new LoRaMesh({ frequency: 'US915' });
    const a = new LoRaNode({ id: 'DD00000000000001', type: 'SCOUT', ...BA });
    const b = new LoRaNode({ id: 'DD00000000000002', type: 'VICTIM', lat: BA.lat + 0.001, lon: BA.lon + 0.001 });
    mesh.addNode(a);
    mesh.addNode(b);

    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const encoder = new PacketEncoder({ encoding: 'CBOR', compression: 'LZ77', encryption: 'AES-CTR', key });
    const packet = new PacketBuilder()
        .setType(PACKET_CONFIG.types.TELEMETRY || PACKET_CONFIG.types.DATA)
        .setSource('DD00000000000001')
        .setSequence(11)
        .setPayload(sensorPayload())
        .build();
    const bytes = encoder.encode(packet);
    assert.ok(bytes.length > 0);

    let received = null;
    b.onPacket = (p) => { received = p; };

    mesh.sendPacket(a.id, b.id, { trama_hex: Buffer.from(bytes).toString('hex') });
    await sleep(400);

    assert.ok(received, 'telemetría cifrada recibida en el nodo destino');
    const decBytes = Array.from(Buffer.from(received.payload.trama_hex, 'hex'));
    const dec = encoder.decode(decBytes);
    assert.equal(dec.sequence, 11);
    assert.equal(dec.payload.bpm, sensorPayload().bpm);
});

test('Integración: consistencia de formato (mismo payload en JSON y BINARY)', () => {
    const payload = sensorPayload();
    const make = (encoding) => new PacketEncoder({ encoding }).decode(new PacketEncoder({ encoding }).encode(
        new PacketBuilder().setPayload(payload).build()
    ));
    const fromJSON = make('JSON');
    const fromBin = make('BINARY');
    assert.deepEqual(fromJSON.payload, fromBin.payload);
    assert.deepEqual(fromJSON.payload, payload);
});

test('Integración: física de profundidad por barómetro (referencia core)', () => {
    const R = 8.314, g = 9.80665, M = 0.02897, T = 300.0, P0 = 101325;
    const calcDeltaH = (p) => ((R * T) / (g * M)) * Math.log(p / P0);
    assert.ok(Math.abs(calcDeltaH(101325)) < 1e-6, '1013.25 hPa → ~0 m');
    assert.ok(calcDeltaH(1020 * 100) > 50 && calcDeltaH(1020 * 100) < 60, '1020 hPa → +58 m aprox');
    assert.ok(calcDeltaH(950 * 100) < -500 && calcDeltaH(950 * 100) > -600, '950 hPa → −566 m aprox');
});
