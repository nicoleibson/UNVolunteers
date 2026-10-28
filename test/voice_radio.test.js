'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { VoiceLink } = require('../radio/voice_link.js');
const { EmergencyRadio } = require('../radio/emergency_radio.js');

// ── fakes ──

function fakeTrack() {
    return { alive: true, stop() { this.alive = false; }, kind: 'audio' };
}

function fakeStream() {
    return { t: fakeTrack(), getAudioTracks() { return [this.t]; }, getTracks() { return [this.t]; } };
}

function fakeRTC() {
    return function FakePC() {
        this._track = null;
        this.connectionState = 'new';
        this.iceGatheringState = 'new';
        this.ontrack = null;
        this.onconnectionstatechange = null;
        this.addTrack = (t, s) => { this._track = { t, s }; };
        this.removeEventListener = () => {};
        this.addEventListener = () => {};
        this.createOffer = async () => ({ sdp: 'offer' });
        this.setLocalDescription = async (d) => { this.localDescription = d; this.iceGatheringState = 'complete'; };
        this.setRemoteDescription = async () => {};
        this.createAnswer = async () => ({ type: 'answer', sdp: 'answer' });
        this.close = () => { this.connectionState = 'closed'; };
    };
}

// ── VoiceLink: privacidad del micrófono ──

test('voice: sin WebRTC devuelve WEBRTC_NO_DISPONIBLE honesto', async () => {
    const v = new VoiceLink({ rtcCtor: null });
    assert.deepEqual(v.start(), { ok: false, error: 'WEBRTC_NO_DISPONIBLE' });
    assert.equal(v.status().supported, false);
});

test('voice: en modo escucha el micrófono NO está activo (no se adquiere)', () => {
    let gumCalls = 0;
    const v = new VoiceLink({ rtcCtor: fakeRTC(), getUserMedia: async () => { gumCalls++; return fakeStream(); } });
    v.start();
    assert.equal(v.status().micOn, false, 'mic apagado por defecto');
    assert.equal(gumCalls, 0, 'getUserMedia NO se llama en escucha');
});

test('voice PTT: talk(true) activa el mic bajo demanda y talk(false) lo libera', async () => {
    let gumCalls = 0; let stopped = 0;
    const v = new VoiceLink({
        rtcCtor: fakeRTC(),
        getUserMedia: async () => { gumCalls++; const s = fakeStream(); s.t.stop = () => { s.t.alive = false; stopped++; }; return s; },
        audioEl: {},
    });
    v.start();

    const on = await v.talk(true);
    assert.equal(on.ok, true);
    assert.equal(v.status().talking, true);
    assert.equal(v.status().micOn, true, 'mic activo solo al hablar');
    assert.equal(v._pc._track != null, true, 'pista de audio añadida al par');

    const off = await v.talk(false);
    assert.equal(off.ok, true);
    assert.equal(v.status().talking, false);
    assert.equal(v.status().micOn, false, 'mic liberado al soltar PTT');
    assert.equal(stopped, 1, 'la pista de micrófono se detiene (mic de verdad apagado)');
});

test('voice: sin permiso de micrófono → SIN_MIC honesto', async () => {
    const v = new VoiceLink({ rtcCtor: fakeRTC(), getUserMedia: null });
    v.start();
    const r = await v.talk(true);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'SIN_MIC');
});

test('VoiceLink: permisos denunciados → MIC_PERMISO_DENEGADO', async () => {
    const v = new VoiceLink({
        rtcCtor: fakeRTC(),
        getUserMedia: async () => { const e = new Error('denied'); throw e; },
    });
    v.start();
    const r = await v.talk(true);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'MIC_PERMISO_DENEGADO');
});

test('VoiceLink: señalización offer/answer / PTT de un lado por mic del local', async () => {
    const gum = async () => fakeStream();
    const a = new VoiceLink({ rtcCtor: fakeRTC(), getUserMedia: gum });
    const b = new VoiceLink({ rtcCtor: fakeRTC(), getUserMedia: gum });
    a.start(); b.start();
    const offer = await a.createOffer();
    const ans = await b.acceptOffer(JSON.stringify(offer.sdp));
    assert.equal(ans.ok, true);
    const fin = await a.acceptOfferAnswer(ans.sdp);
    assert.equal(fin.ok, true);
    a.close(); b.close();
});

// ---- EmergencyRadio ----

test('EmergencyRadio: sin SDR devuelve SIN_SDR honesto (no inventa)', async () => {
    const r = new EmergencyRadio({ sdr: null });
    assert.equal(r.open().ok, false);
    assert.equal(r.open().error, 'SIN_SDR');
    assert.equal((await r.scanEmergency()).ok, false);
    assert.equal(r.status().supported, false);
});

test('EmergencyRadio: sintoniza y detecta canal emergencia con señal', async () => {
    const sdr = {
        available: true,
        tune: (freq) => signalOf(freq),
        onAudio: (cb) => { cb(3); return () => {}; },
        play: (on) => {},
    };
    const r = new EmergencyRadio({ sdr });
    assert.equal(r.open().ok, true);
    const t = await r.tune(105.5, 'FM');
    assert.equal(t.ok, true);
    assert.equal(r.status().frequency, 105.5);
    assert.equal(r.status().state, 'ESCUCHANDO');

    // scanEmergency solo reporta canales con señal real (> 0).
    const sc = await r.scanEmergency([
        { freq: 99.0, mode: 'FM' },
        { freq: 90.0, mode: 'FM' },
    ]);
    assert.equal(sc.ok, true);
    assert.ok(Array.isArray(sc.found));
    assert.ok(sc.found.every((c) => c.level > 0), 'solo canales con señal');
    assert.ok(sc.found.some((c) => c.freq === 99.0));
    assert.ok(!sc.found.some((c) => c.freq === 90.0));
});

function signalOf(freq) {
    // Solamente 99.0 MHz trae señal (resto "vacío"):
    return freq === 99.0 ? { ok: true, signal: 6 } : { ok: true, signal: 0 };
}

test('EmergencyRadio: sin SDR no toca audio ni inventa señal', () => {
    let audioCalls = 0;
    const r = new EmergencyRadio({ sdr: null, onAudio: () => audioCalls++ });
    r.open();
    assert.equal(audioCalls, 0);
});