'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseThermalGrid, detectHumanSignatures, ThermalCam } = require('../radio/thermal_cam.js');

function celsius(bytes) {
    return { width: 32, height: 24, raw: bytes };
}

test('Térmica: parseThermalGrid decodifica int16 LE °C (32×24)', () => {
    const bytes = new Uint8Array(32 * 24 * 2);
    for (let i = 0; i < 32 * 24; i++) {
        bytes[i * 2] = 20; bytes[i * 2 + 1] = 0; // 20 °C
    }
    const grid = parseThermalGrid(celsius(bytes));
    assert.equal(grid.width, 32);
    assert.equal(grid.height, 24);
    assert.equal(grid.temps.length, 32 * 24);
    assert.equal(grid.temps[0], 20);
});

test('Térmica: detectHumanSignatures cuenta píxeles en 36-37 °C', () => {
    const temps = new Float32Array(32 * 24).fill(20);
    // nube humana en el centro
    temps[16 * 32 + 16] = 36.5;
    temps[16 * 32 + 17] = 36.8;
    temps[17 * 32 + 16] = 37.0;
    const r = detectHumanSignatures(temps, { width: 32, height: 24 });
    assert.equal(r.count, 1);
    assert.equal(r.humanPixels, 3);
    assert.equal(r.hotspots.length, 3);
    assert.equal(r.hotspots[0].temp, 37.0);
});

test('Térmica: sin firma corporal no detecta (honesto)', () => {
    const temps = new Float32Array(32 * 24).fill(15);
    const r = detectHumanSignatures(temps, { width: 32, height: 24 });
    assert.equal(r.count, 0);
    assert.equal(r.humanPixels, 0);
    assert.equal(r.hotspots.length, 0);
});

test('Térmica: rango configurable (34-38 °C), outlier caliente no cuenta', () => {
    const temps = new Float32Array(32 * 24).fill(20);
    temps[0] = 36.2;   // humana
    temps[1] = 52.0;   // copo caliente, fuera del rango corporal
    const r = detectHumanSignatures(temps, { width: 32, height: 24, minTemp: 34, maxTemp: 38 });
    assert.equal(r.humanPixels, 1);
    assert.equal(r.count, 1);
});

test('Térmica: transport empuja THERMAL → onFrame con humanos detectados', () => {
    const frames = [];
    const cam = new ThermalCam({ onFrame: (f) => frames.push(f) });
    const lines = [];
    const transport = {
        onLine: (cb) => { transport._cb = cb; },
        removeLine: () => {},
    };
    cam.attach(transport);
    // 32×24 de 20 °C, con un pixel a 36.5 °C
    const temps = new Float32Array(32 * 24).fill(20);
    temps[8 * 32 + 8] = 36.5;
    const hex = Array.from(temps, (t) => {
        const v = t >= 0 ? t : t + 65536;
        const lo = Math.round(v) & 0xFF, hi = (Math.round(v) >> 8) & 0xFF;
        return lo.toString(16).padStart(2, '0') + hi.toString(16).padStart(2, '0');
    }).join('');
    transport._cb('THERMAL ' + hex);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].width, 32);
    assert.equal(frames[0].humans.humanPixels, 1);
});

test('Térmica: sin transporte → SIN_TRANSPORTE honesto', () => {
    const cam = new ThermalCam();
    const r = cam.attach(null);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'SIN_TRANSPORTE');
});