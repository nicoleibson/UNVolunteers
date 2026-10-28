'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WebRtcFieldLink, thermalToHex, isSupported } = require('../radio/webrtc_link.js');
const { parseThermalGrid } = require('../radio/thermal_cam.js');

function FakeDC() {
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.sent = [];
}
FakeDC.prototype.send = function (d) { this.sent.push(String(d)); };
FakeDC.prototype.close = function () { this.readyState = 'closed'; };

function FakePC() {
    this.iceGatheringState = 'complete';
    this.localDescription = null;
    this.remoteDescription = null;
    this._h = {};
    this._dc = null;
}
FakePC.prototype.addEventListener = function (t, f) { (this._h[t] = this._h[t] || []).push(f); };
FakePC.prototype.removeEventListener = function (t, f) {
    if (this._h[t]) { const i = this._h[t].indexOf(f); if (i >= 0) this._h[t].splice(i, 1); }
};
FakePC.prototype.createDataChannel = function () { this._dc = new FakeDC(); return this._dc; };
FakePC.prototype.createOffer = async function () { return { type: 'offer', sdp: 'OFFER_SDP' }; };
FakePC.prototype.createAnswer = async function () { return { type: 'answer', sdp: 'ANSWER_SDP' }; };
FakePC.prototype.setLocalDescription = async function (d) { this.localDescription = d; };
FakePC.prototype.setRemoteDescription = async function (d) {
    this.remoteDescription = d;
    if (d && d.type === 'answer' && this._dc && this.ondatachannel) {
        this.ondatachannel({ channel: this._dc });
    }
};
FakePC.prototype.close = function () {};

test('WebRTC: isSupported y codificación de rejilla térmica (id 1000) a hex int16 LE', () => {
    assert.equal(typeof WebRtcFieldLink, 'function');
    const temps = new Float32Array(32 * 24).fill(36.5);
    const hex = thermalToHex({ width: 32, height: 24, temps });
    assert.equal(hex.length, 32 * 24 * 2 * 2, '32×24×2 bytes×2 hex');
    const raw = new Uint8Array(hex.length / 2);
    for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.substr(i * 2, 2), 16);
    const grid = parseThermalGrid({ width: 32, height: 24, raw });
    assert.ok(Math.abs(grid.temps[0] - 37) < 0.01, 'round-trip 36.5→37');
});

test('WebRTC: offer→answer→complete y el data channel entrega líneas al receptor', async () => {
    const saved = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = FakePC;
    try {
        // Emisor (esclavo).
        const slave = new WebRtcFieldLink({ onLine: () => {} });
        const offer = await slave.createOffer();
        assert.equal(offer.ok, true);
        assert.equal(offer.sdp, 'OFFER_SDP');
        const offerJson = JSON.stringify({ type: 'offer', sdp: offer.sdp });

        // Receptor (maestro): acepta la oferta → respuesta.
        const received = [];
        const master = new WebRtcFieldLink({ onLine: (l) => received.push(l) });
        const ans = await master.acceptOffer(offerJson);
        assert.equal(ans.ok, true);
        const answerJson = JSON.parse(ans.sdp);
        assert.equal(answerJson.type, 'answer');

        // Emisor: aplica la respuesta y la conexión queda establecida.
        const done = await slave.acceptOfferAnswer(ans.sdp);
        assert.equal(done.ok, true);

        // Enlazar el canal (simula la apertura real) y probar envío/recepción.
        const dcA = slave._dc;
        master._bindData(dcA);
        dcA.readyState = 'open';
        dcA.onopen();
        assert.equal(master.connected, true, 'receptor conectado');
        assert.equal(slave.send('UWB 3.3'), true);
        assert.deepEqual(dcA.sent, ['UWB 3.3'], 'mensaje enviado por el canal');
        // El maestro recibe la línea y la entrega a onLine.
        dcA.onmessage({ data: 'UWB 3.3' });
        assert.deepEqual(received, ['UWB 3.3'], 'onLine recibe la línea');

        // Envío antes de abrir: se encola y se vacía al abrir.
        const freshDc = new FakeDC();
        const mx = new WebRtcFieldLink({});
        mx._bindData(freshDc);
        assert.equal(mx.send('ORI 1 2 3'), true, 'encolado si connecting');
        freshDc.readyState = 'open';
        freshDc.onopen();
        assert.deepEqual(freshDc.sent, ['ORI 1 2 3'], 'cola vaciada tras abrir');
    } finally {
        globalThis.RTCPeerConnection = saved;
    }
});