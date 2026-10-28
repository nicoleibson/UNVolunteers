'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');

const { LoRaNode, LoRaMesh } = require('../radio/lora_mesh.js');
const { UdpBridge } = require('../radio/udp_bridge.js');

function waitFor(cond, timeout = 2000, step = 10) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (cond()) { clearInterval(iv); resolve(); }
            else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error('timeout esperando condición')); }
        }, step);
    });
}

function mkMesh(prefix) {
    return new LoRaMesh({ frequency: 'US915', networkId: 'LIFELINE-DEMO' });
}

function mkNode(mesh, id, type, opts = {}) {
    const n = new LoRaNode({ id, name: `${id}-${type}`, type, ...opts });
    mesh.addNode(n);
    return n;
}

/** Levanta dos puentes unicast en loopback con puertos efímeros y los conecta. */
async function bootPair(opts = {}) {
    const meshA = mkMesh('A');
    const meshB = mkMesh('B');
    mkNode(meshA, 'A1', 'SCOUT', { lat: -34.60, lon: -58.38 });
    mkNode(meshB, 'B1', 'SCOUT', { lat: -34.62, lon: -58.40 });
    if (opts.relay) mkNode(meshB, 'BR', 'RELAY', { lat: -34.615, lon: -58.39 });

    const a = new UdpBridge({ mesh: meshA, port: 0, networkId: 'LIFELINE-DEMO', name: 'TEST-A' });
    const b = new UdpBridge({ mesh: meshB, port: 0, networkId: 'LIFELINE-DEMO', name: 'TEST-B' });
    await a.start();
    await b.start();
    a.peers.push({ address: '127.0.0.1', port: b.socket.address().port });
    b.peers.push({ address: '127.0.0.1', port: a.socket.address().port });
    return { meshA, meshB, a, b };
}

/** Levanta tres puentes en cadena: A↔B, B↔C (A no ve a C directamente). */
async function bootChain() {
    const meshA = mkMesh('A');
    const meshB = mkMesh('B');
    const meshC = mkMesh('C');
    mkNode(meshA, 'A1', 'SCOUT', { lat: -34.60, lon: -58.38 });
    mkNode(meshB, 'B1', 'SCOUT', { lat: -34.615, lon: -58.39 });
    mkNode(meshB, 'BR', 'RELAY', { lat: -34.615, lon: -58.39 });
    mkNode(meshC, 'C1', 'SCOUT', { lat: -34.63, lon: -58.42 });

    const a = new UdpBridge({ mesh: meshA, port: 0, networkId: 'LIFELINE-DEMO', name: 'T-A' });
    const b = new UdpBridge({ mesh: meshB, port: 0, networkId: 'LIFELINE-DEMO', name: 'T-B' });
    const c = new UdpBridge({ mesh: meshC, port: 0, networkId: 'LIFELINE-DEMO', name: 'T-C' });
    await a.start(); await b.start(); await c.start();
    const pa = { address: '127.0.0.1', port: a.socket.address().port };
    const pb = { address: '127.0.0.1', port: b.socket.address().port };
    const pc = { address: '127.0.0.1', port: c.socket.address().port };
    a.peers.push(pb);
    b.peers.push(pa, pc);
    c.peers.push(pb);
    return { meshA, meshB, meshC, a, b, c };
}

test('UDP Bridge: DATA broadcast cruzado llega a la malla remota', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const received = [];
    meshB.nodes.get('B1').onPacket = (packet) => received.push(packet);

    meshA.sendPacket('A1', 'FF:FF:FF:FF', { device: 'A', seq: 1, text: 'hola' });

    await waitFor(() => received.length >= 1);
    assert.equal(received.length, 1, 'el nodo B1 recibe el paquete');
    assert.equal(received[0].payload.text, 'hola');
    assert.equal(received[0].sourceId, 'A1');
    assert.ok(b.getStats().rx >= 1, 'B recibió datagramas');
    assert.ok(a.getStats().tx >= 1, 'A transmitió datagramas');
});

test('UDP Bridge: beacon remoto puebla la tabla de rutas del otro dispositivo', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const beacon = meshA.nodes.get('A1').createBeacon();
    meshA.processBeacon(meshA.nodes.get('A1'), beacon); // dispara el forward

    await waitFor(() => meshB.routingTable.has('A1'));
    assert.ok(meshB.routingTable.has('A1'), 'B conoce la ruta a A1');
    assert.equal(meshB.routingTable.get('A1').nextHop, 'B1');
    // Sin loop: A no re-forwarda beacons remotos → tx de A solo 1
    assert.equal(a.getStats().tx, 1, 'A no re-emite el beacon remoto');
});

test('UDP Bridge: NODE_JOIN de un dispositivo llega al otro', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const joins = [];
    meshB.nodes.get('B1').onNodeJoin = (note) => joins.push(note);

    mkNode(meshA, 'A2', 'RELAY', { lat: -34.61, lon: -58.40 }); // addNode → NODE_JOIN forward

    await waitFor(() => joins.length >= 1);
    assert.equal(joins[0].sourceId, 'A2');
    assert.equal(joins[0].type, 'NODE_JOIN');
});

test('UDP Bridge: filtra auto-eco y mensajes de otra red', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const portA = a.socket.address().port;
    const sock = dgram.createSocket('udp4');
    t.after(() => sock.close());
    await new Promise((res) => sock.bind(0, res));

    const sendJson = (payload) => new Promise((res) => {
        sock.send(Buffer.from(JSON.stringify(payload)), 0, 0, portA, '127.0.0.1', res);
    });

    // Auto-eco: mismo instanceId → se ignora
    await sendJson({ v: 1, instanceId: a.instanceId, networkId: 'LIFELINE-DEMO', kind: 'DATA', frame: { x: 1 } });
    // Otra red: networkId distinto → se ignora
    await sendJson({ v: 1, instanceId: 'otro', networkId: 'OTRA-RED', kind: 'DATA', frame: { x: 1 } });

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(a.getStats().rx, 0, 'ningún datagrama inválido contabilizado');
});

test('UDP Bridge: close restaura la malla (deja de reenviar)', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const received = [];
    meshB.nodes.get('B1').onPacket = (packet) => received.push(packet);

    a.close();
    meshA.sendPacket('A1', 'FF:FF:FF:FF', { device: 'A', text: 'tras close' });

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 0, 'sin reenvío tras close');
    assert.equal(a.getStats().tx, 0, 'tx no incrementa tras close');
});

test('UDP Bridge: múltiples paquetes secuenciales sin pérdida en loopback', async (t) => {
    const { meshA, meshB, a, b } = await bootPair();
    t.after(() => { a.close(); b.close(); });

    const received = [];
    meshB.nodes.get('B1').onPacket = (packet) => received.push(packet);

    for (let i = 1; i <= 5; i++) {
        meshA.sendPacket('A1', 'FF:FF:FF:FF', { device: 'A', seq: i });
    }

    await waitFor(() => received.length >= 5);
    const seqs = received.map((p) => p.payload.seq).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'los 5 paquetes llegan en orden');
    assert.ok(a.getStats().tx >= 5 && b.getStats().rx >= 5, 'tx/rx coherentes');
});

test('UDP Bridge: relay multi-hop en cadena A→B→C (hop 1, relayId)', async (t) => {
    const { meshA, meshB, meshC, a, b, c } = await bootChain();
    t.after(() => { a.close(); b.close(); c.close(); });

    const atC = [];
    const atB = [];
    meshC.nodes.get('C1').onPacket = (p) => atC.push(p);
    meshB.nodes.get('B1').onPacket = (p) => atB.push(p);

    // Unicast a C1 (C no está conectado a A): el relay BR de B lo reenvía
    meshA.sendPacket('A1', 'C1', { device: 'A', seq: 1, text: 'multi-hop' });

    await waitFor(() => atC.length >= 1);
    assert.equal(atC.length, 1, 'C recibe el paquete una sola vez');
    assert.equal(atC[0].hopCount, 1, 'C lo recibe con hop 1');
    assert.equal(atC[0].relayId, 'BR', 'C sabe que el relay fue B');
    assert.equal(atC[0].sourceId, 'A1');
    assert.equal(atC[0].payload.text, 'multi-hop');

    // B: SCOUT no entrega (no es destino), el RELAY sí reenvía
    assert.equal(atB.length, 0, 'B1 no entrega paquetes ajenos');

    // Sin loop: A solo envió el original (1) y B solo el relay (2 peers)
    const tA = a.getStats().tx, tB = b.getStats().tx, tC = c.getStats().tx;
    assert.equal(tA, 1, 'A no reenvía el eco del relay');
    assert.equal(tB, 2, 'B reenvía el relay a sus 2 peers');
    assert.equal(tC, 0, 'C no reenvía nada');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.getStats().tx, tA, 'tx de A estable (sin bucle)');
    assert.equal(b.getStats().tx, tB, 'tx de B estable (sin bucle)');
});

test('UDP Bridge: relay unicast en 2 dispositivos sin bucle ni entrega indebida', async (t) => {
    const { meshA, meshB, a, b } = await bootPair({ relay: true });
    t.after(() => { a.close(); b.close(); });

    let atA = 0;
    meshA.nodes.get('A1').onPacket = () => atA++;

    // Destino inexistente en A y B: B solo puede relayarlo
    meshA.sendPacket('A1', 'ZZZ', { device: 'A', seq: 1 });

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(atA, 0, 'A no entrega el eco del relay (no es destino)');
    const tA = a.getStats().tx, tB = b.getStats().tx;
    assert.equal(tA, 1, 'A no reenvía el eco');
    assert.equal(tB, 1, 'B reenvía un único relay');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.getStats().tx, tA, 'tx de A estable');
    assert.equal(b.getStats().tx, tB, 'tx de B estable');
});

test('UDP Bridge: re-flood de beacons hace converger rutas en cadena A↔B↔C', async (t) => {
    const { meshA, meshB, meshC, a, b, c } = await bootChain();
    t.after(() => { a.close(); b.close(); c.close(); });

    // C emite su beacon local → B re-inunda a A y C → A aprende la ruta a C1
    const beacon = meshC.nodes.get('C1').createBeacon();
    meshC.processBeacon(meshC.nodes.get('C1'), beacon);

    await waitFor(() => meshA.routingTable.has('C1'));
    assert.ok(meshA.routingTable.has('C1'), 'A aprende la ruta a C1');
    assert.equal(meshA.routingTable.get('C1').nextHop, 'A1');
    assert.ok(meshB.routingTable.has('C1'), 'B también conoce a C1');
    assert.ok(['B1', 'BR'].includes(meshB.routingTable.get('C1').nextHop), 'B enruta a C1 por un nodo local');

    // Flooding acotado: C 1 envío, B 2 (a A y C), A 1 (eco de regreso a B)
    assert.equal(c.getStats().tx, 1, 'C envía su beacon una vez');
    assert.equal(b.getStats().tx, 2, 'B re-inunda a sus 2 peers');
    assert.equal(a.getStats().tx, 1, 'A re-inunda a B una vez');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.getStats().tx, 1, 'tx de C estable');
    assert.equal(b.getStats().tx, 2, 'tx de B estable');
    assert.equal(a.getStats().tx, 1, 'tx de A estable');
});

test('UDP Bridge: límite de hops respetado en frames remotos', async (t) => {
    const { meshA, meshB, a, b } = await bootPair({ relay: true });
    t.after(() => { a.close(); b.close(); });

    const portB = b.socket.address().port;
    const sock = dgram.createSocket('udp4');
    t.after(() => sock.close());
    await new Promise((res) => sock.bind(0, res));

    const meshX = mkMesh('X');
    const x1 = mkNode(meshX, 'X1', 'SCOUT', { lat: 0, lon: 0 });

    const makeFrame = (hop) => {
        const frame = x1.createDataPacket({ text: 'hop-cap' }, 'ZZZ');
        frame.payload.hopCount = hop;
        return { v: 1, instanceId: 'otro', networkId: 'LIFELINE-DEMO', kind: 'DATA', frame };
    };
    const sendRaw = (env) => new Promise((res) => {
        sock.send(Buffer.from(JSON.stringify(env)), portB, '127.0.0.1', res);
    });

    // hopCount == maxHops (5) → decodeFrame lo descarta, sin relay
    await sendRaw(makeFrame(5));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.getStats().tx, 0, 'frame en el límite de hops no se reenvía');

    // hopCount 4 < 5 → BR crea relay hop 5 y lo reenvía
    await sendRaw(makeFrame(4));
    await waitFor(() => b.getStats().tx >= 1);
    assert.equal(b.getStats().tx, 1, 'frame válido sí se reenvía como relay');
});
