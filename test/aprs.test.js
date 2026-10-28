'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, mulberry32 } = require('./helpers.js');
const { AX25Frame, APRSPacket, APRSTracker, APRS_CONFIG } = requireRadio('aprs_protocol.js');

const BA = { latitude: -34.603722, longitude: -58.381592 };

test('AX25: roundtrip con repetidores conserva infoField y path', () => {
    const f = new AX25Frame({
        sourceCallsign: 'LU1AAA', sourceSSID: 1,
        destinationCallsign: 'APRS',
        repeaterPath: ['WIDE1-1', 'WIDE2-1'],
        infoField: ':HELLO TEST',
    });
    const dec = AX25Frame.decode(f.encode());
    assert.equal(dec.infoField, ':HELLO TEST');
    assert.deepEqual(dec.repeaterPath, ['WIDE1-1', 'WIDE2-1']);
    assert.equal(dec.sourceCallsign, 'LU1AAA');
    assert.equal(dec.destinationCallsign, 'APRS');
});

test('AX25: roundtrip sin repetidores (fuente es la última dirección)', () => {
    const f = new AX25Frame({
        sourceCallsign: 'LU1AAA', sourceSSID: 0,
        destinationCallsign: 'APRS',
        repeaterPath: [],
        infoField: ':SOS DIRECTO',
    });
    const dec = AX25Frame.decode(f.encode());
    assert.equal(dec.infoField, ':SOS DIRECTO');
    assert.deepEqual(dec.repeaterPath, []);
});

test('AX25: ruta de 3 repetidores', () => {
    const f = new AX25Frame({
        sourceCallsign: 'LU1AAA',
        repeaterPath: ['WIDE1-1', 'WIDE2-1', 'WIDE3-1'],
        infoField: 'X',
    });
    const dec = AX25Frame.decode(f.encode());
    assert.deepEqual(dec.repeaterPath, ['WIDE1-1', 'WIDE2-1', 'WIDE3-1']);
    assert.equal(dec.infoField, 'X');
});

test('AX25: callsigns cortos se rellenan y se decodifican correctamente', () => {
    const f = new AX25Frame({ sourceCallsign: 'LU1A', sourceSSID: 15, infoField: 'Y' });
    const dec = AX25Frame.decode(f.encode());
    assert.equal(dec.sourceCallsign, 'LU1A');
    assert.equal(dec.sourceSSID, 15);
});

test('AX25: infoField vacío se conserva', () => {
    const f = new AX25Frame({ sourceCallsign: 'LU1AAA', repeaterPath: [], infoField: '' });
    const dec = AX25Frame.decode(f.encode());
    assert.equal(dec.infoField, '');
});

test('APRS: reportes con prefijo de tipo único y válido', () => {
    const p = new APRSPacket({ callsign: 'LU1PNUD', ...BA });
    const cases = [
        ['Posición', p.createPositionReport().infoField, /^!/],
        ['Posición+TS', p.createPositionReportWithTimestamp().infoField, /^\/[0-9]{6}h/],
        ['Estado', p.createStatusReport('OPERATIVO').infoField, /^>/],
        ['Mensaje', p.createMessage('LU1AAA', 'AYUDA').infoField, /^:/],
        ['Telemetría', p.createTelemetryReport(1, 98).infoField, /^T#001,98$/],
        ['Objeto', p.createObject('VICTIM_A', BA.latitude, BA.longitude).infoField, /^;/],
        ['Emergencia', p.createEmergencyBeacon().infoField, /^!/],
    ];
    for (const [name, info, re] of cases) {
        assert.match(info, re, name);
        // Sin prefijos duplicados
        assert.ok(!/(^T[^#]|^>>|^::|^;;|^!!\/)/.test(info), `${name}: ${info}`);
    }
});

test('APRS: posición BA codifica coordenadas correctas', () => {
    const p = new APRSPacket({ callsign: 'LU1PNUD', ...BA });
    const info = p.createPositionReport().infoField;
    assert.ok(info.includes('35-23.78S'), info);
    assert.ok(info.includes('059-37.10W'), info);
});

test('APRS: telemetría múltiples canales', () => {
    const p = new APRSPacket();
    assert.equal(p.createTelemetryReport(0, 100).infoField, 'T#000,100');
    assert.equal(p.createTelemetryReport(7, 3).infoField, 'T#007,3');
});

test('APRS: crear reporte empaqueta en frame AX.25 con infoField completo', () => {
    const p = new APRSPacket({ callsign: 'LU1PNU', ...BA });
    const r = p.createPositionReport();
    assert.ok(r.frame instanceof AX25Frame);
    const dec = AX25Frame.decode(r.frame.encode());
    assert.equal(dec.infoField, r.infoField);
    assert.equal(dec.sourceCallsign, 'LU1PNU');
});

test('APRSTracker: addObject, updatePosition, getObject, getAllObjects', () => {
    const tr = new APRSTracker({ callsign: 'LU1PNUD' });
    tr.addObject('VICTIM_A', { ...BA });
    assert.equal(tr.getObject('VICTIM_A').position.lat, BA.latitude);
    assert.ok(tr.updatePosition('VICTIM_A', -34.61, -58.38));
    assert.equal(tr.getObject('VICTIM_A').position.lat, -34.61);
    assert.ok(!tr.updatePosition('NOEXISTE', 0, 0), 'updatePosition a objeto inexistente devuelve false');
    assert.equal(tr.getAllObjects().length, 1);
    assert.equal(tr.getAllObjects()[0].name, 'VICTIM_A');
});

test('APRSTracker: sendBeacons incrementa contador de paquetes', () => {
    const tr = new APRSTracker({ callsign: 'LU1PNUD' });
    tr.addObject('VICTIM_A', { ...BA });
    tr.addObject('VICTIM_B', { latitude: -34.6, longitude: -58.37 });
    tr.sendBeacons();
    assert.equal(tr.stats.packetsSent, 2);
    assert.ok(tr.stats.lastBeacon > 0);
});

test('APRS: fuzzing AX.25 decode no cuelga ni crashea (determinista)', () => {
    const rng = mulberry32(777);
    for (let round = 0; round < 500; round++) {
        const len = Math.floor(rng() * 40);
        const bytes = Array.from({ length: len }, () => Math.floor(rng() * 256));
        try {
            const dec = AX25Frame.decode(bytes);
            // Si decodificó, que re-encodée sin error
            const re = new AX25Frame({
                sourceCallsign: dec.sourceCallsign, sourceSSID: dec.sourceSSID,
                destinationCallsign: dec.destinationCallsign, destinationSSID: dec.destinationSSID,
                repeaterPath: dec.repeaterPath, infoField: dec.infoField,
            });
            re.encode();
        } catch (e) {
            assert.ok(e instanceof Error);
        }
    }
});

test('APRS: frame demasiado corto lanza error claro', () => {
    assert.throws(() => AX25Frame.decode([0x00, 0x01]), /too short/i);
});
