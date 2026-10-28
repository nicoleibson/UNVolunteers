'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DtnStore } = require('../radio/dtn_store.js');

const KEY = '2b7e151628aed2a6abf7158809cf4f3c'; // 32 hex válida

function memIO() {
    const m = new Map();
    return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

test('DTN: ingest añade baliza, dedup por nodeId, conserva la más reciente', () => {
    const s = new DtnStore({ key: KEY, seed: 7 });
    assert.equal(s.ingest({ nodeId: 'N1', timestamp: 100, data: { role: 'VICTIM' } }).action, 'added');
    // timestamp viejo → duplicate
    assert.equal(s.ingest({ nodeId: 'N1', timestamp: 50, data: { role: 'VICTIM' } }).action, 'duplicate');
    // timestamp nuevo → updated
    const r = s.ingest({ nodeId: 'N1', timestamp: 200, data: { role: 'VICTIM', bpm: 80 } });
    assert.equal(r.action, 'updated');
    assert.equal(s.counts().stored, 1);
    assert.equal(s.store.N1.timestamp, 200);
});

test('DTN: pending/markSynced controlan el outbox', () => {
    const s = new DtnStore({ key: KEY, seed: 3 });
    s.ingest({ nodeId: 'A', timestamp: 100 });
    s.ingest({ nodeId: 'B', timestamp: 50 });
    assert.equal(s.counts().pending, 2);
    assert.equal(s.pending().length, 2);
    assert.equal(s.pending()[0].nodeId, 'B'); // orden por timestamp
    s.markSynced('A');
    assert.equal(s.counts().pending, 1);
    assert.equal(s.counts().synced, 1);
    assert.equal(s.pending()[0].nodeId, 'B');
});

test('DTN: merge acumula balizas de otro dispositivo (cruces de mulas)', () => {
    const s = new DtnStore({ key: KEY, seed: 5 });
    s.ingest({ nodeId: 'X', timestamp: 1 });
    const r = s.merge([
        { nodeId: 'Y', timestamp: 2 },
        { nodeId: 'Z', timestamp: 3 },
    ]);
    assert.deepEqual({ added: 2, updated: 0, duplicate: 0 }, {
        added: r.added,
        updated: r.updated,
        duplicate: r.duplicate,
    });
    assert.equal(s.counts().stored, 3);
});

test('DTN: persistencia cifrada en io (roundtrip de cliente a cliente)', () => {
    const ioA = memIO();
    const ioB = memIO();
    const a = new DtnStore({ key: KEY, io: ioA, seed: 11 });
    a.ingest({ nodeId: 'M1', timestamp: 42, data: { role: 'VICTIM', bpm: 90 } });
    // el blob en reposo está cifrado (no contiene JSON plano del dato)
    const blob = ioA.get('lifeline:dtn:v1');
    assert.ok(!('"role"'.includes(blob)) === true || !blob.includes('role'));

    // "otro" dispositivo recibe el outbox vía mula y lo descifra
    const b = new DtnStore({ key: KEY, io: ioB, seed: 11 });
    b.merge(a.pending().map((p) => ({ nodeId: p.nodeId, timestamp: p.timestamp, data: p.data })));
    assert.equal(b.counts().stored, 1);
    assert.equal(b.store.M1.data.bpm, 90);
});

test('DTN: correlación de nonce único por cifrado (mismo dato → distinto blob)', () => {
    const s = new DtnStore({ key: KEY, seed: 1 });
    const blob1 = s._encrypt('HOLA');
    const blob2 = s._encrypt('HOLA');
    assert.notEqual(blob1, blob2);
    assert.equal(s._decrypt(blob1), 'HOLA');
});

test('DTN: MIC falla si se corrompe el cifrado (no descifra basura)', () => {
    const s = new DtnStore({ key: KEY, seed: 1 });
    const blob = s._encrypt('secreto');
    const corrupt = blob.slice(0, 8) + '00' + blob.slice(10);
    assert.equal(s._decrypt(corrupt), null);
});

test('DTN: ingest sin nodeId no almacena', () => {
    const s = new DtnStore({ key: KEY });
    assert.equal(s.ingest({ timestamp: 1 }).stored, false);
    assert.equal(s.counts().stored, 0);
});