'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { suggestExcavationPoint } = require('../radio/excavation_cam.js');

// Vector de rescate real: azimut 0 = Norte, inclinación 30° hacia abajo,
// distancia horizontal 3.46 m.
const RESCUE = {
    valid: true,
    vec: { x: 3, y: 0, z: -2 },
    azimuth: 0,
    plunge: 30,
    h: 3.46,
    depth: -2,
};

test('Excavación: sin vector real → NO_VECTOR honesto', () => {
    const r = suggestExcavationPoint(null, null);
    assert.equal(r.status, 'NO_VECTOR');
    assert.equal(r.suggestion, null);
    assert.equal(suggestExcavationPoint({ valid: false, vec: null }, null).status, 'NO_VECTOR');
});

test('Excavación: sin firma térmica conserva la dirección del vector (offset 0)', () => {
    const r = suggestExcavationPoint(RESCUE, null);
    assert.equal(r.status, 'SUGGESTED');
    assert.equal(r.thermalUsed, false);
    assert.equal(r.suggestion.azimuthOffset, 0);
    assert.equal(r.suggestion.pitchOffset, 0);
    assert.equal(r.suggestion.azimuthFinal, 0, 'azimut sin corregir = Norte');
    assert.equal(r.suggestion.pitchFinal, -30, 'inclinación hacia abajo (negativa)');
    assert.ok(r.suggestion.depth < 0, 'bajo el suelo');
});

test('Excavación: firma térmica a la derecha corrige el azimut (gradiente de calor)', () => {
    // Pixel más cálido desplazado a la derecha de la rejilla 32×24.
    const hotRight = { x: 28, y: 12, temp: 37.1 };
    const thermal = { width: 32, height: 24, temps: [], humans: { hotspots: [hotRight] } };
    const r = suggestExcavationPoint(RESCUE, thermal);
    assert.equal(r.thermalUsed, true);
    assert.ok(r.suggestion.azimuthOffset > 0, `desvío positivo: ${r.suggestion.azimuthOffset}`);
    assert.ok(Math.abs(r.suggestion.azimuthFinal - (0 + r.suggestion.azimuthOffset)) < 1e-6);
});

test('Excavación: firma térmica abajo añade inclinación y aumenta la profundidad', () => {
    const hotDown = { x: 16, y: 22, temp: 37.0 };
    const thermal = { width: 32, height: 24, temps: [], humans: { hotspots: [hotDown] } };
    const r = suggestExcavationPoint(RESCUE, thermal);
    assert.ok(r.suggestion.pitchOffset < 0, 'pixel abajo → más inclinación hacia abajo');
    assert.ok(r.suggestion.pitchFinal < -30);
    assert.ok(r.suggestion.depth < -2, 'más inclinación → más profundo');
});

test('Excavación: azimut final se normaliza a [0,360)', () => {
    const thermal = { width: 32, height: 24, temps: [], humans: { hotspots: [{ x: 28, y: 12, temp: 36.6 }] } };
    const rescueN = { ...RESCUE, azimuth: 350 };
    const r = suggestExcavationPoint(rescueN, thermal);
    assert.ok(r.suggestion.azimuthFinal >= 0 && r.suggestion.azimuthFinal < 360, 'siempre en rango');
});
