'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AutoLinkManager, OWN, REMOTE } = require('../radio/auto_link.js');

function tinyTransport(available = true) {
    return {
        available,
        sent: [],
        cbs: [],
        send(line) { this.sent.push(line); },
        onReceive(cb) { this.cbs.push(cb); return () => { this.cbs = []; }; },
    };
}

function fakeScheduler() {
    let id = 0; const tasks = new Map();
    return {
        setTimeout(fn) { tasks.set(++id, fn); return id; },
        clearTimeout(i) { tasks.delete(i); },
        advance() { const run = [...tasks.values()]; tasks.clear(); run.forEach((f) => f()); },
    };
}

const SDK = { beaconInterval: 2000, ackTimeout: 5000 };

test('hoja: al entrar en emergencia baliza y con ACK/CONFIRM pasa a ACTIVO', () => {
    const lora = tinyTransport(); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'NODE-A', lora, scheduler: sched, ...SDK });
    const ev = []; lk.onLink = (id, st) => ev.push([id, st]);

    lk.enterEmergency('leaf');
    sched.advance();
    assert.ok(lora.sent.some((x) => x.startsWith('AUTOLINK|BALIZA|NODE-A')), 'baliza emitida');
    assert.equal(lk.status().own.state, OWN.BALIZA);

    lk.handleIncoming('lora', `AUTOLINK|ACK|COORD|${lk.own.token}`);
    assert.equal(lk.status().own.state, OWN.ACTIVO, 'hoja ACTIVO al confirmar');
    assert.ok(lora.sent.some((x) => x.startsWith(`AUTOLINK|CONFIRM|NODE-A|${lk.own.token}`)), 'CONFIRM emitido');
    assert.deepEqual(ev.at(-1), ['self', OWN.ACTIVO]);
    lk.dispose();
});

test('coordinador: baliza→ACK, CONFIRM→ACTIVO y enruta DATA', () => {
    const lora = tinyTransport(); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'COORD', lora, scheduler: sched, ...SDK });
    const recv = []; lk.onData = (id, p) => recv.push([id, p]);

    lk.enterEmergency('coordinator');
    lk.setEssential(['LEAF-1']);
    lk.handleIncoming('lora', 'AUTOLINK|BALIZA|LEAF-1|radio');
    const ack = lora.sent.find((x) => x.startsWith('AUTOLINK|ACK|COORD|'));
    assert.ok(ack, 'ACK enviado a la hoja');
    assert.equal(lk.status().links['LEAF-1'].state, REMOTE.PARED);

    lk.handleIncoming('lora', `AUTOLINK|CONFIRM|LEAF-1|${ack.split('|')[3]}`);
    assert.equal(lk.status().links['LEAF-1'].state, REMOTE.ACTIVO);

    lk.handleIncoming('lora', 'AUTOLINK|DATA|LEAF-1|UWB 4.2');
    assert.deepEqual(recv, [['LEAF-1', 'UWB 4.2']]);
    lk.dispose();
});

test('batería: las hojas redundantes se apagan (SLEEP), las esenciales no', () => {
    const lora = tinyTransport(); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'COORD', lora, scheduler: sched, ...SDK });
    lk.enterEmergency('coordinator');
    lk.setEssential(['LEAF-1']);

    lk.handleIncoming('lora', 'AUTOLINK|BALIZA|LEAF-1|caps');
    lk.handleIncoming('lora', 'AUTOLINK|BALIZA|LEAF-2|caps');
    assert.ok(!lora.sent.some((x) => x.startsWith('AUTOLINK|SLEEP|COORD|LEAF-1')), 'esencial sin SLEEP');
    assert.ok(lora.sent.some((x) => x.startsWith('AUTOLINK|SLEEP|COORD|LEAF-2')), 'redundante recibe SLEEP');
    assert.equal(lk.status().links['LEAF-2'].state, REMOTE.REDUNDANTE);
    lk.dispose();
});

test('pérdida de enlace: la hoja en ACTIVO revierte a baliza y vuelve a emitir', () => {
    const lora = tinyTransport(); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'NODE-A', lora, scheduler: sched, ...SDK });
    lk.enterEmergency('leaf');
    sched.advance();
    lk.handleIncoming('lora', `AUTOLINK|ACK|COORD|${lk.own.token}`);
    lk.handleIncoming('lora', 'AUTOLINK|CONFIRM|COORD|x');
    assert.equal(lk.status().own.state, OWN.ACTIVO);

    const base = Date.now();
    lk._now = () => base + lk.ackTimeout + 1;
    lk._expireIfLost();
    assert.equal(lk.status().own.state, OWN.BALIZA, 'revierte a baliza al perder el enlace');
    lk._now = () => base;
    sched.advance();
    assert.ok(lora.sent.some((x) => x.startsWith('AUTOLINK|BALIZA|NODE-A')), 'baliza reanudada');
    lk.dispose();
});

test('hoja dormida (SLEEP) deja de balizar y despierta con WAKE', () => {
    const lora = tinyTransport(); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'NODE-A', lora, scheduler: sched, ...SDK });
    const ev = []; lk.onLink = (id, st) => ev.push(st);
    lk.enterEmergency('leaf');
    sched.advance();
    const n0 = lora.sent.length;

    lk.handleIncoming('lora', 'AUTOLINK|SLEEP|COORD|LEAF-1');
    assert.equal(lk.status().own.state, OWN.SLEEP);
    sched.advance();
    assert.equal(lora.sent.length, n0, 'dormida: no emite nueva baliza');
    assert.ok(ev.includes(OWN.SLEEP));

    lk.handleIncoming('lora', 'AUTOLINK|WAKE|COORD|LEAF-1');
    assert.equal(lk.status().own.state, OWN.BALIZA);
    sched.advance();
    assert.ok(lora.sent.some((x) => x.startsWith('AUTOLINK|BALIZA|NODE-A')), 'despierta: baliza de nuevo');
    lk.dispose();
});

test('honesto: sin transporte LoRa disponible la baliza no emite', () => {
    const lora = tinyTransport(false); const sched = fakeScheduler();
    const lk = new AutoLinkManager({ ownId: 'NODE-A', lora, scheduler: sched, ...SDK });
    lk.enterEmergency('leaf');
    sched.advance();
    assert.equal(lora.sent.length, 0, 'no se inventan señales sin hardware');
    lk.dispose();
});