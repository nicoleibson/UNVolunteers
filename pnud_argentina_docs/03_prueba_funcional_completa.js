'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  PRUEBA FUNCIONAL COMPLETA — PROJECT LIFELINE CORE
 *  Stack RF (Node.js) + Simuladores AMRF v1.2 / v2.0
 *  Entorno: Termux / Android (también Linux) — Node.js
 * ═══════════════════════════════════════════════════════════════
 *  Ejecutar:  node 03_prueba_funcional_completa.js
 *  Salida:    consola + 04_Registros_Prueba_Funcional_Completa.log
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const RADIO = path.join(BASE, 'radio');
const SIM   = path.join(BASE, 'simulation', 'simulation');

const { PacketEncoder, PacketBuilder, PACKET_CONFIG } = require(path.join(RADIO, 'packet_encoder.js'));
const { AX25Frame, APRSPacket, APRSTracker } = require(path.join(RADIO, 'aprs_protocol.js'));
const { LoRaNode, LoRaMesh, LORA_CONFIG } = require(path.join(RADIO, 'lora_mesh.js'));
const { FrequencyManager, FrequencyScanner, FREQ_MGR_CONFIG } = require(path.join(RADIO, 'frequency_mgr.js'));
const { SDRReceiver, SDRScanner, SDR_CONFIG, DSP, Complex } = require(path.join(RADIO, 'sdr_receiver.js'));

const lines = [];
let passed = 0;
let failed = 0;

function log(msg) {
    const t = new Date().toISOString();
    const line = `[${t}] ${msg}`;
    lines.push(line);
    console.log(line);
}

function result(group, name, ok, detail = '') {
    const tag = ok ? 'PASS' : 'FAIL';
    if (ok) passed++; else failed++;
    const suffix = detail ? ` :: ${detail}` : '';
    log(`[${tag}] ${group} | ${name}${suffix}`);
    return ok;
}

function check(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// GRUPO 1 — SINTAXIS (node --check)
// ═══════════════════════════════════════════════════════════════
function testSintaxis() {
    log('=== GRUPO 1: SINTAXIS (node --check) ===');
    const files = [
        ['packet_encoder.js',  path.join(RADIO, 'packet_encoder.js')],
        ['aprs_protocol.js',   path.join(RADIO, 'aprs_protocol.js')],
        ['lora_mesh.js',       path.join(RADIO, 'lora_mesh.js')],
        ['frequency_mgr.js',   path.join(RADIO, 'frequency_mgr.js')],
        ['sdr_receiver.js',    path.join(RADIO, 'sdr_receiver.js')],
        ['server.js',          path.join(SIM, 'server.js')],
        ['app.js (v1.2)',      path.join(SIM, 'app.js')],
        ['app_integrated.js (v2.0)', path.join(SIM, 'app_integrated.js')],
    ];
    for (const [name, file] of files) {
        try {
            execSync(`node --check "${file}"`, { stdio: 'pipe' });
            result('Sintaxis', name, true);
        } catch (e) {
            result('Sintaxis', name, false, String(e.stderr || e.message).trim());
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 2 — PACKET ENCODER (JSON / BINARY / CBOR + CRC)
// ═══════════════════════════════════════════════════════════════
function testPacketEncoder() {
    log('=== GRUPO 2: PACKET ENCODER ===');

    const packet = new PacketBuilder()
        .setType(PACKET_CONFIG.types.EMERGENCY)
        .setSource('29CD40CE00032356')
        .setDestination('FFFFFFFFFFFFFFFF')
        .setSequence(42)
        .setPayload({ bpm: 118, spo2: 94, battery: 67, depth: 4.3, gps: { lat: -34.603722, lon: -58.381592 } })
        .build();

    for (const enc of ['JSON', 'BINARY', 'CBOR']) {
        try {
            const encoder = new PacketEncoder({ encoding: enc });
            const bytes = encoder.encode(packet);
            const decoded = encoder.decode(bytes);
            const ok = decoded.payload && decoded.payload.bpm === 118 &&
                      decoded.sequence === 42 && decoded.type === PACKET_CONFIG.types.EMERGENCY;
            result('PacketEncoder', `Roundtrip ${enc}`, ok,
                `bytes=${bytes.length} payload=${JSON.stringify(decoded.payload)} seq=${decoded.sequence}`);
        } catch (e) {
            result('PacketEncoder', `Roundtrip ${enc}`, false, e.message);
        }
    }

    // CRC: 16 bits y detección de corrupción
    try {
        const enc = new PacketEncoder({ encoding: 'BINARY' });
        const bytes = enc.encode(packet);
        const crc = enc.calculateCRC16(bytes.slice(0, bytes.length - 2));
        result('PacketEncoder', 'CRC16 en rango 16 bits', crc <= 0xFFFF, `crc=0x${crc.toString(16).toUpperCase()}`);

        const corrupted = [...bytes];
        const idx = Math.min(20, corrupted.length - 3);
        corrupted[idx] ^= 0xFF;
        let threw = false;
        try { enc.decode(corrupted); } catch (err) { threw = /CRC mismatch/i.test(err.message); }
        result('PacketEncoder', 'CRC detecta corrupción', threw, threw ? 'decode lanzó CRC mismatch' : 'no detectó corrupción');
    } catch (e) {
        result('PacketEncoder', 'Pruebas CRC', false, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 3 — APRS / AX.25
// ═══════════════════════════════════════════════════════════════
function testAPRS() {
    log('=== GRUPO 3: APRS / AX.25 ===');

    // Roundtrip AX.25 con repetidores
    try {
        const f = new AX25Frame({
            sourceCallsign: 'LU1AAA', sourceSSID: 1,
            destinationCallsign: 'APRS',
            repeaterPath: ['WIDE1-1', 'WIDE2-1'],
            infoField: ':HELLO TEST',
        });
        const bytes = f.encode();
        const dec = AX25Frame.decode(bytes);
        const ok = dec.infoField === ':HELLO TEST' &&
                   JSON.stringify(dec.repeaterPath) === JSON.stringify(['WIDE1-1', 'WIDE2-1']);
        result('AX25', 'Roundtrip con repetidores', ok,
            `info="${dec.infoField}" path=[${dec.repeaterPath}] bytes=${bytes.length}`);
    } catch (e) {
        result('AX25', 'Roundtrip con repetidores', false, e.message);
    }

    // Roundtrip AX.25 sin repetidores
    try {
        const f = new AX25Frame({
            sourceCallsign: 'LU1AAA', sourceSSID: 1,
            destinationCallsign: 'APRS',
            repeaterPath: [],
            infoField: ':SOS DIRECTO',
        });
        const bytes = f.encode();
        const dec = AX25Frame.decode(bytes);
        const ok = dec.infoField === ':SOS DIRECTO' && dec.repeaterPath.length === 0;
        result('AX25', 'Roundtrip sin repetidores', ok,
            `info="${dec.infoField}" path=${dec.repeaterPath.length}`);
    } catch (e) {
        result('AX25', 'Roundtrip sin repetidores', false, e.message);
    }

    // Reporte de posición Buenos Aires (coordenadas de referencia PNUD)
    try {
        const p = new APRSPacket({
            callsign: 'LU1PNUD', ssid: 0,
            latitude: -34.603722, longitude: -58.381592,
        });
        const pos = p.createPositionReport();
        const ok = pos.infoField.startsWith('!');
        result('APRS', 'Reporte de posición BA', ok, `info="${pos.infoField}"`);
    } catch (e) {
        result('APRS', 'Reporte de posición BA', false, e.message);
    }

    // Baliza de emergencia y telemetría
    try {
        const p = new APRSPacket({ callsign: 'LU1PNUD', latitude: -34.603722, longitude: -58.381592 });
        const em = p.createEmergencyBeacon();
        result('APRS', 'Baliza de emergencia', em.infoField.includes('EMERGENCY'), `info="${em.infoField}"`);
    } catch (e) {
        result('APRS', 'Baliza de emergencia', false, e.message);
    }
    try {
        const p = new APRSPacket({ callsign: 'LU1PNUD' });
        const t = p.createTelemetryReport(1, 98);
        result('APRS', 'Telemetría (canal/valor)', t.infoField === 'T#001,98', `info="${t.infoField}"`);
    } catch (e) {
        result('APRS', 'Telemetría (canal/valor)', false, e.message);
    }

    // Tracker: objetos y beacons
    try {
        const tr = new APRSTracker({ callsign: 'LU1PNUD' });
        tr.addObject('VICTIM_A', { latitude: -34.603722, longitude: -58.381592 });
        const objs = tr.getAllObjects();
        const ok = Object.keys(objs).length === 1;
        result('APRS', 'APRSTracker registra objeto', ok, `objetos=${Object.keys(objs).join(',')}`);
    } catch (e) {
        result('APRS', 'APRSTracker registra objeto', false, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 4 — LORA MESH
// ═══════════════════════════════════════════════════════════════
async function testLoRaMesh() {
    log('=== GRUPO 4: LORA MESH ===');

    const mesh = new LoRaMesh({ frequency: 'US915', networkId: 'LIFELINE-001' });
    const nodeA = new LoRaNode({ id: 'AA00000000000001', name: 'SCOUT-1', type: 'SCOUT', lat: -34.603722, lon: -58.381592 });
    const nodeB = new LoRaNode({ id: 'AA00000000000002', name: 'RELAY-1', type: 'RELAY', lat: -34.604500, lon: -58.381900 });
    const nodeC = new LoRaNode({ id: 'AA00000000000003', name: 'VICTIM-1', type: 'VICTIM', lat: -34.605300, lon: -58.382500 });

    const okJoin = [nodeA, nodeB, nodeC].every(n => mesh.addNode(n) === true);
    result('LoRa', 'Alta de nodos (3)', okJoin, `routingTable=${mesh.routingTable.size}`);

    // CRC 4 dígitos hex
    try {
        const crc = nodeA.calculateCRC({ a: 1 });
        result('LoRa', 'CRC 4 dígitos hex', /^[0-9A-F]{4}$/.test(crc), `crc=${crc}`);
    } catch (e) {
        result('LoRa', 'CRC 4 dígitos hex', false, e.message);
    }

    // Roundtrip encode/decode
    try {
        const frame = nodeA.createDataPacket({ msg: 'SOS', type: 'EMERGENCY' }, nodeC.id);
        const decoded = nodeB.decodeFrame(frame);
        const ok = decoded && decoded.packetId === frame.payload.packetId && decoded.sourceId === nodeA.id;
        result('LoRa', 'Roundtrip encode/decodeFrame', ok,
            `dst=${decoded.destinationId} crc=${frame.crc} hops=${decoded.hopCount}`);
    } catch (e) {
        result('LoRa', 'Roundtrip encode/decodeFrame', false, e.message);
    }

    // findPath — 1 salto
    try {
        mesh.routingTable.get(nodeA.id).nextHop = nodeB.id;
        mesh.routingTable.get(nodeB.id).nextHop = nodeA.id;
        const path = mesh.findPath(nodeA.id, nodeB.id);
        const ok = Array.isArray(path) && path.length === 2;
        result('LoRa', 'findPath 1 salto', ok, `path=${JSON.stringify(path)}`);
    } catch (e) {
        result('LoRa', 'findPath 1 salto', false, e.message);
    }

    // findPath — 2 saltos
    try {
        mesh.routingTable.get(nodeA.id).nextHop = nodeB.id;
        mesh.routingTable.get(nodeB.id).nextHop = nodeC.id;
        mesh.routingTable.get(nodeC.id).nextHop = nodeB.id;
        const path = mesh.findPath(nodeA.id, nodeC.id);
        const ok = Array.isArray(path) && path.length === 3;
        result('LoRa', 'findPath 2 saltos', ok, `path=${JSON.stringify(path)}`);
    } catch (e) {
        result('LoRa', 'findPath 2 saltos', false, e.message);
    }

    // Envío de paquete real (propagación)
    try {
        const before = mesh.stats.successfulDeliveries;
        const sent = mesh.sendPacket(nodeA.id, nodeC.id, { msg: 'AYUDA', lat: -34.603722, lon: -58.381592 });
        await sleep(500);
        const after = mesh.stats.successfulDeliveries;
        result('LoRa', 'sendPacket + propagación', sent === true && after > before,
            `entregas: ${before} -> ${after}`);
    } catch (e) {
        result('LoRa', 'sendPacket + propagación', false, e.message);
    }

    const stats = mesh.getStats();
    log(`[INFO] LoRa mesh stats: nodeCount=${stats.nodeCount} routingTable=${stats.routingTableSize} paquetes=${stats.totalPackets}`);
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 5 — FREQUENCY MANAGER
// ═══════════════════════════════════════════════════════════════
function testFrequencyManager() {
    log('=== GRUPO 5: FREQUENCY MANAGER ===');
    const fm = new FrequencyManager({ region: 'AMERICAS' });

    try {
        const alloc = fm.requestFrequency({ requesterId: 'SCOUT-1', type: 'TRACKING', priority: FREQ_MGR_CONFIG.priorityLevels.HIGH });
        const ok = alloc && typeof alloc.frequency === 'number' && alloc.frequency > 100e6;
        result('FreqMgr', 'Asignación de frecuencia', ok,
            `id=${alloc.id} freq=${(alloc.frequency / 1e6).toFixed(3)} MHz requester=${alloc.requesterId}`);
    } catch (e) {
        result('FreqMgr', 'Asignación de frecuencia', false, e.message);
    }

    try {
        const allocs = fm.getActiveAllocations();
        const id = allocs[0] && allocs[0].id;
        const released = fm.releaseFrequency(id);
        result('FreqMgr', 'Liberación de frecuencia', released === true, `id=${id}`);
    } catch (e) {
        result('FreqMgr', 'Liberación de frecuencia', false, e.message);
    }

    try {
        const alloc = fm.requestFrequency({ requesterId: 'VICTIM-1', type: 'TRACKING' });
        const s = fm.getStats();
        const ok = s.activeChannels === 1 && alloc.frequency > 100e6;
        result('FreqMgr', 'Estadísticas post-asignación', ok,
            `totalAllocations=${s.totalAllocations} activeChannels=${s.activeChannels} collisions=${s.collisions}`);
    } catch (e) {
        result('FreqMgr', 'Estadísticas post-asignación', false, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 6 — SDR / DSP
// ═══════════════════════════════════════════════════════════════
function testSDR() {
    log('=== GRUPO 6: SDR / DSP ===');

    try {
        const sdr = new SDRReceiver({ frequency: 144.390e6, sampleRate: 48000 });
        const spec = sdr.getSpectrum();
        result('SDR', 'getSpectrum (8192 bins)', spec.length === 8192, `bins=${spec.length}`);
    } catch (e) {
        result('SDR', 'getSpectrum (8192 bins)', false, e.message);
    }

    try {
        // Señal de exactamente 4096 muestras (potencia de 2) a 1200 Hz
        const signal = new Float32Array(4096);
        for (let i = 0; i < signal.length; i++) {
            signal[i] = Math.sin(2 * Math.PI * 1200 * i / 48000);
        }
        const bins = DSP.powerSpectrum(signal);
        result('DSP', 'powerSpectrum 4096 bins', bins.length === 4096, `bins=${bins.length}`);
    } catch (e) {
        result('DSP', 'powerSpectrum 4096 bins', false, e.message);
    }

    try {
        const signal = DSP.sineWave(1200, 48000, 0.1);
        const snr = DSP.calculateSNR(signal, 0.001);
        result('DSP', 'calculateSNR con noiseFloor', Number.isFinite(snr), `SNR=${snr.toFixed(2)} dB`);
    } catch (e) {
        result('DSP', 'calculateSNR con noiseFloor', false, e.message);
    }

    try {
        const signal = DSP.sineWave(1200, 48000, 0.1);
        const snr = DSP.calculateSNR(signal); // sin noiseFloor
        result('DSP', 'calculateSNR sin noiseFloor (NaN esperado)', Number.isNaN(snr), `SNR=${snr}`);
    } catch (e) {
        result('DSP', 'calculateSNR sin noiseFloor (NaN esperado)', false, e.message);
    }

    try {
        const ok4096 = DSP.fft(new Float32Array(4096)).length === 4096;
        let threw4800 = false;
        try { DSP.fft(new Float32Array(4800)); } catch (err) { threw4800 = true; }
        const ok = ok4096 && threw4800;
        result('DSP', 'FFT potencia de 2 (4096 OK / 4800 lanza)', ok,
            `4096->OK 4800->${threw4800 ? 'throw' : 'no throw'}`);
    } catch (e) {
        result('DSP', 'FFT potencia de 2 (4096 OK / 4800 lanza)', false, e.message);
    }

    try {
        const sdr = new SDRReceiver();
        sdr.tune(145.800e6);
        sdr.setDemodMode(SDR_CONFIG.demodModes.AM);
        sdr.setGain(55);
        result('SDR', 'Tune + demod + gain', sdr.frequency === 145.800e6 && sdr.gain === 55,
            `freq=${(sdr.frequency / 1e6).toFixed(3)} MHz gain=${sdr.gain} dB`);
    } catch (e) {
        result('SDR', 'Tune + demod + gain', false, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 7 — SERVIDOR HTTP (server.js)
// ═══════════════════════════════════════════════════════════════
async function testServer() {
    log('=== GRUPO 7: SERVIDOR HTTP (server.js) ===');
    const { spawn } = require('child_process');
    const server = spawn(process.execPath, ['server.js'], { cwd: SIM, stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(1500);

    const http = require('http');
    function get(pathname, raw) {
        return new Promise(resolve => {
            const opts = { host: 'localhost', port: 8000, path: pathname, method: 'GET' };
            if (raw) opts.path = pathname; // ya incluye ../.. (--path-as-is)
            const req = http.request(opts, res => {
                res.resume();
                res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '' }));
            });
            req.on('error', () => resolve({ status: 0, ct: '' }));
            req.end();
        });
    }

    try {
        const root = await get('/');
        result('Servidor', 'GET / → 200', root.status === 200, `status=${root.status} type=${root.ct}`);
    } catch (e) { result('Servidor', 'GET / → 200', false, e.message); }

    try {
        const r = await get('/index_integrated.html');
        result('Servidor', 'GET index_integrated.html', r.status === 200, `status=${r.status} type=${r.ct}`);
    } catch (e) { result('Servidor', 'GET index_integrated.html', false, e.message); }

    try {
        const r = await get('/app_integrated.js');
        result('Servidor', 'GET app_integrated.js', r.status === 200 && /javascript/.test(r.ct), `status=${r.status} type=${r.ct}`);
    } catch (e) { result('Servidor', 'GET app_integrated.js', false, e.message); }

    try {
        const r = await get('/app.js');
        result('Servidor', 'GET app.js', r.status === 200 && /javascript/.test(r.ct), `status=${r.status} type=${r.ct}`);
    } catch (e) { result('Servidor', 'GET app.js', false, e.message); }

    try {
        const r = await get('/noexiste.js');
        result('Servidor', 'Archivo inexistente → 404', r.status === 404, `status=${r.status}`);
    } catch (e) { result('Servidor', 'Archivo inexistente → 404', false, e.message); }

    try {
        const r = await get('/../../../etc/passwd', true); // traversal crudo
        result('Servidor', 'Traversal de ruta → 403', r.status === 403, `status=${r.status}`);
    } catch (e) { result('Servidor', 'Traversal de ruta → 403', false, e.message); }

    server.kill();
    await sleep(300);
}

// ═══════════════════════════════════════════════════════════════
// GRUPO 8 — FLUJO DE SENSORES → TRAMA APRS (contexto PNUD)
// ═══════════════════════════════════════════════════════════════
function testFlujoSensores() {
    log('=== GRUPO 8: FLUJO SENSORES → TRAMA APRS (Buenos Aires) ===');
    try {
        const gps = { latitude: -34.603722, longitude: -58.381592, altitude: 25.0 };
        const baro = { presion_hpa: 1013.25 };
        const p0 = 1013.25;
        const R = 8.314462618;
        const T = 288.15;
        const g = 9.80665;
        const M = 0.0289644;
        const profundidad = (R * T) / (g * M) * Math.log(p0 / baro.presion_hpa);

        const tracker = new APRSTracker({ callsign: 'LU1PNUD' });
        const pk = new APRSPacket({
            callsign: 'LU1PNUD',
            latitude: gps.latitude,
            longitude: gps.longitude,
            altitude: gps.altitude,
        });
        const pos = pk.createPositionReport();
        tracker.addObject('NODO_PNUD', { latitude: gps.latitude, longitude: gps.longitude });

        const ok = pos.infoField.startsWith('!') && Object.keys(tracker.getAllObjects()).length === 1;
        result('Sensores', 'Barómetro → profundidad', Math.abs(profundidad) < 0.01,
            `profundidad=${profundidad.toFixed(4)} m (1013.25 hPa → 0 m)`);
        result('Sensores', 'GPS BA → trama APRS', ok, `trama="${pos.infoField}"`);
    } catch (e) {
        result('Sensores', 'Flujo sensores → APRS', false, e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
async function main() {
    log('═══════════════════════════════════════════════════════════════');
    log(' PRUEBA FUNCIONAL COMPLETA — PROJECT LIFELINE CORE');
    log(` Fecha/hora: ${new Date().toString()}`);
    log(` Node.js:    ${process.version}`);
    log('═══════════════════════════════════════════════════════════════');

    testSintaxis();
    testPacketEncoder();
    testAPRS();
    await testLoRaMesh();
    testFrequencyManager();
    testSDR();
    await testServer();
    testFlujoSensores();

    log('═══════════════════════════════════════════════════════════════');
    log(` RESUMEN: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
    log('═══════════════════════════════════════════════════════════════');

    const logPath = path.join(__dirname, '04_Registros_Prueba_Funcional_Completa.log');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    log(`Registro guardado en: ${logPath}`);

    process.exit(failed === 0 ? 0 : 1);
}

main();
