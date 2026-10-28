'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AutoLinkManager } = require('../radio/auto_link.js');
const { makeLoRaTransport, makeBleTransport, createAutoTransports, toHex, fromHex } =
    require('../radio/auto_transports.js');
const { LoRaRadioDriver } = require('../radio/radio_driver.js');

function fakeScheduler() {
    let id = 0; const tasks = new Map();
    return {
        setTimeout(fn) { tasks.set(++id, fn); return id; },
        clearTimeout(i) { tasks.delete(i); },
        advance() { const run = [...tasks.values()]; tasks.clear(); run.forEach((f) => f()); },
    };
}

// Transporte serial falso con enrutado P2P hacia un "peer" (simula el aire).
class FakeTransport {
    constructor(name) {
        this.name = name; this.onLine = null; this.onClose = null;
        this.sent = []; this.started = false; this._peer = null;
    }
    start() { this.started = true; return Promise.resolve(); }
    emit(line) { if (this.onLine) this.onLine(line); }
    emitRx(hex) { this.emit(`EVT RX ${hex} 120 8`); }
    send(line) {
        this.sent.push(line);
        if (line === 'RESET') { setImmediate(() => this.emit('EVT READY {"radio":"SX1276"}')); return; }
        const hex = line.split(' ')[1];
        if (hex && this._peer) this._peer.emitRx(hex); // el aire entrega al otro radio
        if (line.startsWith('TX ')) this.emit('OK');   // firmware confirma TX
    }
    close() {}
}

async function connectRadio(name) {
    const t = new FakeTransport(name);
    const d = new LoRaRadioDriver({ transport: t, timeoutMs: 200 });
    const res = await d.connect();
    assert.equal(res.ok, true, `${name} conecta`);
    return { driver: d, transport: t };
}

test('adaptador LoRa: disponible al conectar, texto↔hex y onReceive decodifica', async () => {
    const { driver, transport } = await connectRadio('A');
    const lo = makeLoRaTransport(driver);

    assert.equal(lo.available, true, 'disponible con radio conectada');

    const recv = [];
    lo.onReceive((line) => recv.push(line));

    // onReceive decodifica un frame hex entrante (EVT RX) a texto.
    driver.onFrame({ hex: toHex('AUTOLINK|ACK|COORD|tok'), rssi: -70, snr: 8 });
    assert.deepEqual(recv, ['AUTOLINK|ACK|COORD|tok']);

    // send codifica texto→hex y lo envía por el radio.
    lo.send('AUTOLINK|BALIZA|NODE-A|caps');
    assert.ok(transport.sent.some((l) => l.startsWith(`TX ${toHex('AUTOLINK|BALIZA|NODE-A|caps')}`)));
    await driver.close();
});

test('adaptador BLE: honesto — sin enlace de par available:false', () => {
    const ble = makeBleTransport(null);
    assert.equal(ble.available, false);
    assert.equal(ble.send('x'), false);
});

test('adaptador BLE: con enlace bidireccional envía y recibe', () => {
    const sent = [];
    const link = {
        connected: true,
        send(line) { sent.push(line); return true; },
        onReceive(cb) { this._cb = cb; return () => { this._cb = null; }; },
    };
    const ble = makeBleTransport(link);
    assert.equal(ble.available, true);
    assert.equal(ble.send('AUTOLINK|DATA|A|term'), true);
    assert.deepEqual(sent, ['AUTOLINK|DATA|A|term']);

    const recv = [];
    ble.onReceive((l) => recv.push(l));
    link._cb('AUTOLINK|DATA|B|term');
    assert.deepEqual(recv, ['AUTOLINK|DATA|B|term']);

    link.connected = false;
    assert.equal(ble.available, false);
    assert.equal(ble.send('x'), false);
});

test('loop completo: hoja y coordinador se emparejan vía radio LoRa real', async () => {
    const A = await connectRadio('A'); // hoja
    const B = await connectRadio('B'); // coordinador
    A.transport._peer = B.transport;   // el aire conecta A↔B
    B.transport._peer = A.transport;

    const sched = fakeScheduler();
    const leaf = new AutoLinkManager({
        ownId: 'NODE-A', scheduler: sched, ackTimeout: 5000,
        ...createAutoTransports({ radioDriver: A.driver }),
    });
    const coord = new AutoLinkManager({
        ownId: 'COORD', scheduler: sched, ackTimeout: 5000,
        ...createAutoTransports({ radioDriver: B.driver }),
    });

    const coordLinks = [];
    coord.onLink = (id, st) => coordLinks.push([id, st]);
    const data = [];
    coord.onData = (id, p) => data.push([id, p]);

    coord.enterEmergency('coordinator');
    coord.setEssential(['NODE-A']); // no apagar la hoja que queremos
    leaf.enterEmergency('leaf');

    sched.advance(); // primer baliza → handshake ACK/CONFIRM síncrono por el aire
    assert.equal(leaf.status().own.state, 'ACTIVO', 'hoja ACTIVO');
    assert.equal(coord.status().links['NODE-A'].state, 'ACTIVO', 'coordinador la ve ACTIVO');
    assert.ok(coordLinks.some(([id]) => id === 'NODE-A'), 'coordinador notificó la hoja');

    // La hoja transmite datos densos; el coordinador los recibe.
    leaf.handleIncoming('lora', 'AUTOLINK|CONFIRM|COORD|x'); // idempotente/estado ACTIVO
    leaf._sendData('NODE-A', 'UWB 4.2');
    assert.deepEqual(data.some(([id, p]) => id === 'NODE-A' && p === 'UWB 4.2'), true);

    await A.driver.close(); await B.driver.close();
    leaf.dispose(); coord.dispose();
});