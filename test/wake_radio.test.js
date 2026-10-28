'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WakeRadioController, ST_OFF, ST_IDLE, ST_ACTIVE } = require('../radio/wake_radio.js');

test('Wake: arranca OFF, enable() → IDLE (escucha ultra-baja)', () => {
    const c = new WakeRadioController({ clock: () => 0 });
    assert.equal(c.getState().state, ST_OFF);
    c.enable();
    const s = c.getState();
    assert.equal(s.state, ST_IDLE);
    assert.equal(s.enabled, true);
});

test('Wake: signalProximity despierta → ACTIVE y llama onActivate', () => {
    let activated = 0;
    const c = new WakeRadioController({ activeMs: 8000, onActivate: () => activated++, clock: () => 1000 });
    c.enable();
    const s = c.signalProximity();
    assert.equal(s.state, ST_ACTIVE);
    assert.equal(activated, 1);
    assert.equal(c.getState().listening, true);
});

test('Wake: tras activeMs vuelve a IDLE (tick)', () => {
    let idleCount = 0;
    let now = 0;
    const c = new WakeRadioController({ activeMs: 8000, onIdle: () => idleCount++, clock: () => now });
    c.enable();
    c.signalProximity();
    now = 7999; c.tick();  // aún activo
    assert.equal(c.getState().state, ST_ACTIVE);
    now = 8000; c.tick();  // vence
    assert.equal(c.getState().state, ST_IDLE);
    assert.equal(idleCount, 1);
});

test('Wake: OFF ignora proximity (honesto, no despierta)', () => {
    let activated = 0;
    const c = new WakeRadioController({ onActivate: () => activated++ });
    c.signalProximity(); // OFF
    assert.equal(activated, 0);
    assert.equal(c.getState().state, ST_OFF);
});

test('Wake: ya ACTIVE no re-dispara ni cuenta de nuevo', () => {
    const c = new WakeRadioController({ activeMs: 8000, clock: () => 0 });
    c.enable();
    c.signalProximity();
    c.signalProximity();
    assert.equal(c.getState().activations, 1);
});

test('Wake: disable() apaga y limita consumo', () => {
    const c = new WakeRadioController({ clock: () => 0 });
    c.enable();
    c.disable();
    const s = c.getState();
    assert.equal(s.state, ST_OFF);
    assert.equal(s.enabled, false);
    assert.equal(s.listening, false);
});