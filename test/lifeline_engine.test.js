'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireSim } = require('./helpers.js');
const { createEngine } = requireSim('lifeline_engine.js');

const BA = { lat: -34.603722, lon: -58.381592 };
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function snapshot(extra = {}) {
    return {
        gps: BA,
        pressure: 102400,
        bpm: 96,
        spo2: 97,
        battery: 61,
        depth_m: 32.1,
        role: 'VICTIM',
        tilt: 40,
        light: 3,
        mic: 25,
        ...extra,
    };
}

test('Engine: arranca con el stack RF real (ready=true, sin ejemplos)', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    assert.equal(e.ready, true, 'motor listo en Node con radio/*.js');
    assert.equal(typeof e.encoder.encode, 'function');
    assert.equal(typeof e.mesh.addNode, 'function');
    assert.ok(e.encoder.encryption, 'AES-CTR');
});

test('Engine: buildTelemetryPacket produce bytes reales que decodifican', () => {
    const key = KEY;
    const e = createEngine({ key, callsign: 'LU1PNU' });
    const hex = e.buildTelemetryPacket(snapshot());
    assert.ok(hex.length > 0, 'hex no vacío');
    assert.match(hex, /^[0-9A-F]+$/);

    const { PacketEncoder } = require('./helpers.js').requireRadio('packet_encoder.js');
    const dec = new PacketEncoder({ encoding: 'CBOR', compression: 'LZ77', encryption: 'AES-CTR', key });
    const bytes = Array.from(Buffer.from(hex, 'hex'));
    const pkt = dec.decode(bytes);
    assert.equal(pkt.payload.bpm, 96);
    assert.equal(pkt.payload.role, 'VICTIM');
    assert.equal(pkt.payload.depth_m, 32.1);
});

test('Engine: sendLocalTelemetry se propaga por la malla real hasta el nodo remoto', () => {
    const e = createEngine({ key: KEY, ...BA });
    e.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM', ...BA, bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73 },
    ]);
    let received = null;
    e.mesh.nodes.get('AB00000000000002').onPacket = (p) => { received = p; };

    try {
        e.start();
        const before = e.mesh.stats.successfulDeliveries;
        const hex = e.sendLocalTelemetry(snapshot());
        assert.ok(hex, 'telemetría enviada');
        assert.ok(e.sequence >= 1);
        // La malla real entrega el paquete al nodo remoto (broadcast local)
        assert.ok(received, 'el nodo remoto recibió la telemetría');
        assert.ok(e.mesh.stats.successfulDeliveries > before, 'entrega registrada');
        assert.equal(received.payload.trama_hex, hex, 'la trama cifrada llega íntegra');
    } finally {
        e.stop();
    }
});

test('Engine: ingestRemoteTelemetry añade nodos reales sin datos inventados', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    e.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM', ...BA, bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73 },
    ]);
    const nodes = e.getNodes();
    assert.equal(nodes.length, 2, 'local + 1 remoto');
    const remote = nodes.find((n) => n.id === 'AB00000000000002');
    assert.equal(remote.role, 'VICTIM');
    assert.equal(remote.rssi, -73);
    assert.equal(remote.bpm, 110);
    assert.ok(e.mesh.nodes.has('AB00000000000002'), 'nodo en la malla real');
    // Sin entradas → sin nodos remotos inventados
    const e2 = createEngine({ key: KEY });
    assert.equal(e2.getNodes().length, 1, 'solo el dispositivo local');
});

test('Engine: sin callsign APRS queda inactivo y se reporta — no N0CALL inventado', () => {
    const e = createEngine({ key: KEY, callsign: null });
    assert.equal(e.callsign, null);
    assert.equal(e.getNodes()[0].aprsCallsign, null);
});

test('Engine: key ausente usa clave de referencia (documentada demo), no falla', () => {
    const e = createEngine({});
    assert.equal(e.ready, true);
    const hex = e.buildTelemetryPacket(snapshot());
    assert.ok(hex.length > 0);
});

test('Engine: injectRelayedFrame materializa el nodo remoto desde la trama real', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    const b = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
    try {
        b.start();
        const hex = b.sendLocalTelemetry(snapshot({ role: 'VICTIM' }));
        assert.ok(hex, 'telemetría de B');
        // El frame que la malla propaga (hook del adaptador) es el objeto
        // codificado { preamble, header, payload, crc }: lo replicamos con
        // el encodePacket real del nodo.
        const raw = {
            type: 'DATA',
            sourceId: b.localNode.id,
            sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF',
            timestamp: Date.now(),
            hopCount: 0,
            payload: { trama_hex: hex },
            packetId: `${b.localNode.id}-${Date.now()}-rx`,
        };
        const frame = b.localNode.encodePacket(raw);
        const delivered = a.injectRelayedFrame(frame, 'TELÉFONO');
        assert.ok(delivered, 'frame entregado a la malla de A');
        const nodes = a.getNodes();
        assert.equal(nodes.length, 2, 'local + remoto real');
        const remote = nodes.find((n) => n.id === 'BBBBBBBB00000002');
        assert.ok(remote, 'nodo remoto materializado sin ingest()');
        assert.equal(remote.role, 'VICTIM');
        assert.equal(remote.label, 'TELÉFONO', 'nombre del dispositivo remoto');
        assert.equal(remote.bpm, 96);
        assert.equal(remote.pressure, 102400, 'baro_hpa decodificado a Pa');
        // clearRemoteNodes deja solo el local
        a.clearRemoteNodes();
        assert.equal(a.getNodes().length, 1, 'nodos remotos limpiados');
    } finally {
        b.stop();
    }
});

test('Engine: un BEACON de un dispositivo en modo baliza materializa su nodo con sus datos', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    const b = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO', battery: 61 });
    // B emite su beacon real; la malla de A lo procesa como llegaría cross-device.
    const beacon = b.localNode.createBeacon();
    a.mesh.processBeacon(a.localNode, beacon);
    const remote = a.getNodes().find((n) => n.id === 'BBBBBBBB00000002');
    assert.ok(remote, 'nodo baliza materializado sin ingest()');
    assert.equal(remote.label, 'TELÉFONO', 'nombre real del beacon');
    assert.equal(remote.battery, 61, 'batería real del beacon');
    assert.ok(remote.lastSeen > 0, 'lastSeen marcado');
    assert.equal(remote.role, 'UNKNOWN', 'sin telemetría aún el rol no se inventa');
    assert.equal(remote.bpm, null, 'sin telemetría no hay vitales inventados');
    // Un segundo beacon refresca lastSeen pero sigue sin inventar vitales.
    const before = remote.lastSeen;
    a.mesh.processBeacon(a.localNode, b.localNode.createBeacon());
    assert.ok(a.getNodes().find((n) => n.id === 'BBBBBBBB00000002').lastSeen >= before);
    assert.equal(a.getNodes().find((n) => n.id === 'BBBBBBBB00000002').bpm, null);
});

test('Engine: pruneStaleNodes poda balizas sin señal reciente (TTL) y conserva las frescas', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    e.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'V1', role: 'VICTIM', ...BA, bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73 },
    ]);
    e.remoteNodes.get('AB00000000000002').lastSeen = Date.now() - 120000;
    assert.equal(e.pruneStaleNodes(30000), 1, 'nodo viejo podado');
    assert.equal(e.getNodes().length, 1, 'solo el local');
    assert.ok(!e.mesh.nodes.has('AB00000000000002'), 'sale de la malla real');
    e.ingestRemoteTelemetry([
        { id: 'AB00000000000003', label: 'V2', role: 'SCOUT', ...BA, bpm: 100, spo2: 98, battery: 50, pressure: 101325, rssi: -55 },
    ]);
    assert.equal(e.pruneStaleNodes(30000), 0, 'nodo fresco se conserva');
    assert.equal(e.getNodes().length, 2, 'local + nodo fresco');
});

test('Engine: intercom cross-device — el msg viaja incrustado en la trama real hasta el par', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    const b = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
    let recibido = null;
    a.onIntercomMessage = (m) => { recibido = m; };
    try {
        b.start();
        const snap = snapshot({ msg: 'ALFA 3 ENTERRADOS' });
        const hex = b.sendLocalTelemetry(snap);
        assert.ok(hex, 'trama con msg emitida');
        // Replica el frame que el hook del relay propaga, como en
        // injectRelayedFrame, y lo inyecta en la malla del par A.
        const raw = {
            type: 'DATA',
            sourceId: b.localNode.id,
            sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF',
            timestamp: Date.now(),
            hopCount: 0,
            payload: { trama_hex: hex },
            packetId: `${b.localNode.id}-${Date.now()}-rx`,
        };
        const frame = b.localNode.encodePacket(raw);
        const delivered = a.injectRelayedFrame(frame, 'TELÉFONO');
        assert.ok(delivered, 'frame entregado al par');
        assert.ok(recibido, 'callback de intercom disparado en el par');
        assert.equal(recibido.msg, 'ALFA 3 ENTERRADOS', 'mensaje íntegro');
        assert.equal(recibido.fromName, 'TELÉFONO', 'remitente conocido');
        assert.equal(recibido.fromId, b.localNode.id, 'id del remitente');
        // El nodo remoto también se materializa con las lecturas reales
        const remote = a.getNodes().find((n) => n.id === b.localNode.id);
        assert.equal(remote.bpm, 96);
        assert.equal(remote.label, 'TELÉFONO');
        // Sin msg en la trama, el callback NO se dispara (solo telemetría)
        recibido = null;
        const hex2 = b.sendLocalTelemetry(snapshot());
        const raw2 = {
            type: 'DATA',
            sourceId: b.localNode.id,
            sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF',
            timestamp: Date.now(),
            hopCount: 0,
            payload: { trama_hex: hex2 },
            packetId: `${b.localNode.id}-${Date.now()}-rx2`,
        };
        a.injectRelayedFrame(b.localNode.encodePacket(raw2), 'TELÉFONO');
        assert.equal(recibido, null, 'telemetría ordinaria no dispara intercom');
    } finally {
        b.stop();
    }
});

test('Engine: afterLocalTx recibe la misma trama real (hook a la radio física, Etapa 0)', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    let emitida = null;
    e.afterLocalTx = (hex) => { emitida = hex; };
    try {
        e.start();
        const hex = e.sendLocalTelemetry(snapshot());
        assert.ok(hex, 'telemetría emitida');
        assert.equal(emitida, hex, 'la radio física recibe la trama real exacta');
        // El hook es opcional: sin callback, transmitir no rompe
        e.afterLocalTx = null;
        assert.ok(e.sendLocalTelemetry(snapshot()), 'TX sin radio no falla');
    } finally {
        e.stop();
    }
});

test('Engine: CO/O2 reales viajan en la telemetría y se materializan en el par', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    const b = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
    try {
        b.start();
        const hex = b.sendLocalTelemetry(snapshot({ role: 'VICTIM', atm: { coPpm: 250, o2Pct: 18.5 } }));
        assert.ok(hex, 'telemetría con atmósfera');
        const raw = {
            type: 'DATA',
            sourceId: b.localNode.id,
            sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF',
            timestamp: Date.now(),
            hopCount: 0,
            payload: { trama_hex: hex },
            packetId: `${b.localNode.id}-${Date.now()}-atm`,
        };
        a.injectRelayedFrame(b.localNode.encodePacket(raw), 'TELÉFONO');
        const remote = a.remoteNodes.get(b.localNode.id);
        assert.ok(remote, 'nodo remoto materializado');
        assert.equal(remote.coPpm, 250);
        assert.equal(remote.o2Pct, 18.5);
    } finally {
        b.stop();
    }
});

test('Engine: DTN acumula la baliza de víctima y la expone como outbox (syncDTN)', () => {
    const b = createEngine({ key: KEY, loraId: 'BBBBBBBB00000002', nodeName: 'TELÉFONO' });
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    try {
        b.start();
        assert.ok(a.dtn, 'motor con DTN habilitado por defecto');
        // A recibe una víctima real vía relay
        const hex = b.sendLocalTelemetry(snapshot({ role: 'VICTIM', atm: { coPpm: 50 } }));
        const raw = {
            type: 'DATA',
            sourceId: b.localNode.id,
            sourceName: 'TELÉFONO',
            destinationId: 'FF:FF:FF:FF',
            timestamp: Date.now(),
            hopCount: 0,
            payload: { trama_hex: hex },
            packetId: `${b.localNode.id}-${Date.now()}-dtn`,
        };
        a.injectRelayedFrame(b.localNode.encodePacket(raw), 'TELÉFONO');
        assert.equal(a.dtn.counts().stored, 1, 'baliza almacenada (store-and-forward)');
        assert.equal(a.syncDTN().length, 1, 'queda pendiente en el outbox');
        assert.equal(a.syncDTN()[0].data.coPpm, 50, 'datos reales en el outbox');
    } finally {
        b.stop();
    }
});

test('Engine: mergeDTN mezcla el outbox de otra mula (cruces de datos)', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    try {
        // A ya tiene una baliza local; le llegan 2 de otra mula
        a.dtn.ingest({ nodeId: 'AAAABBBB00000001', timestamp: 100, data: { role: 'VICTIM' } });
        const r = a.mergeDTN([
            { nodeId: 'AAAABBBB00000002', timestamp: 200, data: { role: 'VICTIM' } },
            { nodeId: 'AAAABBBB00000003', timestamp: 300, data: { role: 'VICTIM' } },
        ]);
        assert.equal(r.added, 2);
        assert.equal(a.dtn.counts().stored, 3);
    } finally {
        a.stop();
    }
});

test('Engine: rebalanceRoles sugiere REPETIDOR por densidad de scouts + víctimas', () => {
    const a = createEngine({ key: KEY, callsign: 'LU1PNU' });
    try {
        const noVictims = a.rebalanceRoles();
        assert.equal(noVictims.suggested, 'SCOUT', 'sin víctimas no cambia');
        // 2 scouts + 1 víctima → sugiere RELAY
        a.remoteNodes.set('S1', { id: 'S1', role: 'SCOUT', node: { type: 'SCOUT' } });
        a.remoteNodes.set('S2', { id: 'S2', role: 'SCOUT', node: { type: 'SCOUT' } });
        a.remoteNodes.set('V1', { id: 'V1', role: 'VICTIM', node: { type: 'VICTIM' } });
        const r = a.rebalanceRoles();
        assert.equal(r.remoteScouts, 2);
        assert.equal(r.victims, 1);
        assert.equal(r.suggested, 'RELAY', 'densidad + víctima → repetidor');
        assert.equal(r.switch, true);
        // aplicar el rol lo refleja en la malla real
        a.setLocalRole('RELAY');
        assert.equal(a.localNode.type, 'RELAY');
    } finally {
        a.stop();
    }
});

test('Engine: wakeRadio habilitado (IDLE) sin inventar detección', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    assert.ok(e.wakeRadio, 'controlador de escucha ultra-baja creado');
    assert.equal(e.wakeRadio.getState().state, 'IDLE', 'escucha ultra-baja activa al arranque');
    // sin señal de proximidad no despierta (honesto)
    assert.equal(e.wakeRadio.getState().activations, 0);
});

test('Engine: vector de rescate UWB+IMU — null sin distancia (cero datos inventados)', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    assert.ok(e.azimuthFilter, 'filtro de Kalman por dispositivo');
    // Sin distancia UWB la flecha se apaga (null), aunque haya orientación.
    assert.equal(e.calculateRescueVector(null, 90, 0, -30, 0.1), null);
    // Sin orientación inicial tampoco se inventa.
    assert.equal(e.calculateRescueVector(4, null, null, -30, 0.1), null);
    e.stop();
});

test('Engine: vector de rescate estabiliza azimut y apunta bajo tierra', () => {
    const e = createEngine({ key: KEY, callsign: 'LU1PNU' });
    e.resetRescueVector();
    // Primer paso: inicializa con la brújula (azimut 0, Norte) → vector al Norte.
    const v0 = e.calculateRescueVector(4, 0, 0, -30, 0.1);
    assert.ok(v0 && v0.z < 0, 'z negativo = víctima por debajo del nivel del suelo');
    assert.ok(Math.abs(v0.y) < 1e-9 && v0.x > 0, 'azimut 0 → componente Norte (x)');
    // Dead-reckoning: se pierde la brújula, el giroscopio gira 90°/s durante 1 s.
    const v1 = e.calculateRescueVector(4, null, 90, -30, 1.0);
    assert.ok(v1, 'sigue calculando con el giroscopio (dead-reckoning)');
    assert.ok(Math.abs(v1.x) < 0.5, 'sin componente Norte tras girar 90° (x≈0)');
    assert.ok(v1.y > 2, 'apunta hacia el Este (y) tras el giro');
    e.stop();
});
