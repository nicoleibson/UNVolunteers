'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, sleep } = require('./helpers.js');
const { LoRaNode, LoRaMesh, LORA_CONFIG } = requireRadio('lora_mesh.js');

const BA1 = { lat: -34.603722, lon: -58.381592 };
const BA2 = { lat: -34.604500, lon: -58.381900 };
const BA3 = { lat: -34.605300, lon: -58.382500 };

function buildMesh() {
    const mesh = new LoRaMesh({ frequency: 'US915', networkId: 'LIFELINE-001' });
    const a = new LoRaNode({ id: 'AA00000000000001', name: 'SCOUT-1', type: 'SCOUT', ...BA1 });
    const b = new LoRaNode({ id: 'AA00000000000002', name: 'RELAY-1', type: 'RELAY', ...BA2 });
    const c = new LoRaNode({ id: 'AA00000000000003', name: 'VICTIM-1', type: 'VICTIM', ...BA3 });
    for (const n of [a, b, c]) mesh.addNode(n);
    return { mesh, a, b, c };
}

test('LoRa: alta, duplicado y baja de nodos', () => {
    const mesh = new LoRaMesh();
    const a = new LoRaNode({ id: 'AA00000000000001' });
    assert.equal(mesh.addNode(a), true);
    assert.equal(mesh.addNode(a), false, 'alta duplicada devuelve false');
    assert.equal(mesh.nodes.size, 1);
    assert.equal(mesh.routingTable.size, 1);

    assert.equal(mesh.removeNode('AA00000000000001'), true);
    assert.equal(mesh.nodes.size, 0);
    assert.equal(mesh.routingTable.size, 0);
    assert.equal(mesh.removeNode('AA00000000000001'), false, 'baja de inexistente devuelve false');
});

test('LoRa: activate/deactivate cambia estado activo', () => {
    const a = new LoRaNode({ id: 'AA00000000000001' });
    assert.equal(a.isActive, false);
    a.activate();
    assert.equal(a.isActive, true);
    a.deactivate();
    assert.equal(a.isActive, false);
});

test('LoRa: beacon crea trama BEACON y CRC de 4 dígitos hex', () => {
    const a = new LoRaNode({ id: 'AA00000000000001', name: 'SCOUT-1', ...BA1 });
    const beacon = a.createBeacon();
    assert.equal(beacon.header.type, 'BEACON');
    assert.equal(beacon.payload.sourceId, a.id);
    assert.match(beacon.crc, /^[0-9A-F]{4}$/, beacon.crc);
    assert.ok(beacon.payload.signalStrength >= -100 && beacon.payload.signalStrength <= 0);
});

test('LoRa: roundtrip encode/decode conserva payload y dedupe', () => {
    const { mesh, a, b, c } = buildMesh();
    const frame = a.createDataPacket({ msg: 'SOS', type: 'EMERGENCY' }, c.id);

    const decoded1 = b.decodeFrame(frame);
    assert.ok(decoded1);
    assert.equal(decoded1.packetId, frame.payload.packetId);
    assert.equal(decoded1.destinationId, c.id);
    assert.equal(decoded1.payload.msg, 'SOS');

    assert.equal(b.decodeFrame(frame), null, 'paquete duplicado se descarta');
});

test('LoRa: límite de hops descarta el paquete', () => {
    const { b } = buildMesh();
    const maxHops = b.maxHops;
    const packet = { type: 'DATA', sourceId: 'X', destinationId: b.id, hopCount: maxHops, packetId: 'P-1', payload: {} };
    const frame = b.encodePacket(packet);
    assert.equal(b.decodeFrame(frame), null, 'hopCount >= maxHops se descarta');
});

test('LoRa: processPacket entrega a destinatario y reenvía en nodo RELAY', () => {
    const { a, b, c } = buildMesh();
    const delivered = [];
    c.onPacket = (p) => delivered.push(p);

    const frame = a.createDataPacket({ msg: 'AYUDA' }, c.id);

    // Nodo SCOUT que no es el destino: no reenvía
    const drop = a.processPacket(frame);
    assert.equal(drop, null);

    // Nodo RELAY: reenvía (relay) cuando no es el destino
    const relayFrame = b.createDataPacket({ msg: 'AYUDA' }, c.id);
    const relayed = b.processPacket(relayFrame);
    assert.ok(relayed, 'RELAY reenvía el paquete');
    assert.equal(relayed.payload.relayId, b.id, 'relayId del nodo RELAY');
    assert.equal(relayed.payload.hopCount, 1);

    // Destinatario: entrega y devuelve el paquete
    const fresh = a.createDataPacket({ msg: 'AYUDA' }, c.id);
    const got = c.processPacket(fresh);
    assert.equal(got.payload.msg, 'AYUDA');
    assert.equal(delivered.length, 1);
});

test('LoRa: findPath 1 salto, 2 saltos, self y sin ruta', () => {
    const { mesh, a, b, c } = buildMesh();

    assert.deepEqual(mesh.findPath(a.id, a.id), [a.id], 'self → [source]');

    mesh.routingTable.get(a.id).nextHop = b.id;
    mesh.routingTable.get(b.id).nextHop = a.id;
    assert.deepEqual(mesh.findPath(a.id, b.id), [a.id, b.id], '1 salto');

    mesh.routingTable.get(b.id).nextHop = c.id;
    mesh.routingTable.get(c.id).nextHop = b.id;
    assert.deepEqual(mesh.findPath(a.id, c.id), [a.id, b.id, c.id], '2 saltos');

    assert.equal(mesh.findPath(a.id, 'AA99999999999999'), null, 'sin ruta → null');
});

test('LoRa: sendPacket broadcast entrega a todos los nodos en alcance', async () => {
    const { mesh, a } = buildMesh();
    const before = mesh.stats.successfulDeliveries;
    assert.equal(mesh.sendPacket(a.id, null, { msg: 'AQUI ESTOY' }), true);
    await sleep(400);
    assert.ok(mesh.stats.successfulDeliveries > before, 'entregas broadcast incrementan');
});

test('LoRa: sendPacket a nodo fuera de alcance no entrega', async () => {
    const mesh = new LoRaMesh({ frequency: 'US915' });
    const a = new LoRaNode({ id: 'AA00000000000001', type: 'SCOUT', ...BA1 });
    const far = new LoRaNode({ id: 'AA00000000000099', type: 'VICTIM', lat: 51.5, lon: -0.12 }); // Londres
    mesh.addNode(a);
    mesh.addNode(far);

    const before = mesh.stats.successfulDeliveries;
    mesh.sendPacket(a.id, far.id, { msg: 'HOLA LEJOS' });
    await sleep(400);
    assert.equal(mesh.stats.successfulDeliveries, before, 'fuera de alcance no entrega');
});

test('LoRa: calculateDistance (Haversine) en Buenos Aires', () => {
    const mesh = new LoRaMesh();
    const d = mesh.calculateDistance(BA1.lat, BA1.lon, -34.6, -58.38);
    assert.ok(d > 0.4 && d < 0.5, `distancia=${d} km`);
    assert.equal(mesh.calculateDistance(BA1.lat, BA1.lon, BA1.lat, BA1.lon), 0);
});

test('LoRa: red en escala (60 nodos en cadena) findPath completo', () => {
    const mesh = new LoRaMesh({ frequency: 'US915' });
    const N = 60;
    const nodes = [];
    for (let i = 0; i < N; i++) {
        const n = new LoRaNode({
            id: `BB${String(i).padStart(14, '0')}`,
            name: `N${i}`,
            lat: BA1.lat + i * 0.0001,
            lon: BA1.lon + i * 0.0001,
        });
        nodes.push(n);
        mesh.addNode(n);
    }
    assert.equal(mesh.nodes.size, N);
    for (let i = 0; i < N - 1; i++) {
        mesh.routingTable.get(nodes[i].id).nextHop = nodes[i + 1].id;
    }
    const path = mesh.findPath(nodes[0].id, nodes[59].id);
    assert.equal(path.length, N);
    assert.equal(path[0], nodes[0].id);
    assert.equal(path[N - 1], nodes[59].id);
});

test('LoRa: getStats expone métricas de red', () => {
    const { mesh } = buildMesh();
    const s = mesh.getStats();
    assert.equal(s.nodeCount, 3);
    assert.equal(s.routingTableSize, 3);
    assert.equal(typeof s.totalPackets, 'number');
    assert.equal(typeof s.successfulDeliveries, 'number');
    assert.equal(typeof s.failedDeliveries, 'number');
});

test('LoRa: config de spreading factors y bandas', () => {
    assert.equal(LORA_CONFIG.spreadingFactors.SF10.range, 7);
    assert.equal(LORA_CONFIG.frequencies.US915.band, 915.0);
    assert.ok(LORA_CONFIG.spreadingFactors.SF12.range > LORA_CONFIG.spreadingFactors.SF7.range);
});
