'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { SIM, requireSim } = require('./helpers.js');
const { createServer } = requireSim('server.js');

let server;
let base;

before(async () => {
    server = createServer({ root: SIM, discovery: false });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function postSignal(room, type, sdp) {
    const body = { room, from: 'TEST-1', type };
    if (sdp !== undefined) body.sdp = sdp;
    const res = await fetch(`${base}/voice/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await parseBody(res) };
}

async function parseBody(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { return text; }
}

async function getSignals(room) {
    const res = await fetch(`${base}/voice/signal?room=${encodeURIComponent(room)}`);
    return { status: res.status, body: await parseBody(res) };
}

test('Voz: sala inválida y señal inválida se rechazan', async () => {
    const badRoom = await postSignal('salala ConEspacios', 'offer', 'v=0');
    assert.equal(badRoom.status, 400);

    const badType = await postSignal('EQUIPO-A', 'wat', 'v=0');
    assert.equal(badType.status, 400);

    const badSdp = await postSignal('EQUIPO-A', 'offer', '');
    assert.equal(badSdp.status, 400);
});

test('Voz: offer/answer persisten por sala', async () => {
    const offer = await postSignal('EQUIPO-B', 'offer', 'v=0 offer');
    assert.equal(offer.status, 200);
    assert.equal(offer.body.ok, true);

    const answer = await postSignal('EQUIPO-B', 'answer', 'v=0 answer');
    assert.equal(answer.status, 200);

    const list = await getSignals('EQUIPO-B');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.signals.map((s) => s.type), ['offer', 'answer']);
    assert.equal(list.body.signals[0].sdp, 'v=0 offer');

    const other = await getSignals('EQUIPO-C');
    assert.deepEqual(other.body.signals, []);
});

test('Voz: SSE entrega saludo y señales en vivo', async () => {
    const events = await new Promise((resolve, reject) => {
        const seen = [];
        const timer = setTimeout(() => reject(new Error('SSE timeout')), 5000);
        const req = http.get(`${base}/voice/stream?room=SSE-ROOM`, (res) => {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /text\/event-stream/);
            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString();
                let idx = buffer.indexOf('\n\n');
                while (idx !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const line = frame.split('\n').find((l) => l.startsWith('data: '));
                    if (line) {
                        seen.push(JSON.parse(line.slice(6)));
                        if (seen.length >= 2) {
                            clearTimeout(timer);
                            resolve(seen);
                            req.destroy();
                            return;
                        }
                    }
                    idx = buffer.indexOf('\n\n');
                }
            });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        setTimeout(() => postSignal('SSE-ROOM', 'offer', 'v=0 live'), 50);
    });

    assert.equal(events[0].room, 'SSE-ROOM');
    assert.ok(events.some((e) => e.type === 'offer' && e.sdp === 'v=0 live'));
});
