'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, sleep } = require('./helpers.js');
const { FrequencyManager, FrequencyScanner, FREQ_MGR_CONFIG } = requireRadio('frequency_mgr.js');

test('FreqMgr: asignación devuelve asignación con frecuencia en Hz', () => {
    const fm = new FrequencyManager({ region: 'AMERICAS' });
    const alloc = fm.requestFrequency({ requesterId: 'SCOUT-1', type: 'TRACKING' });
    assert.ok(alloc);
    assert.equal(typeof alloc.frequency, 'number');
    assert.ok(alloc.frequency > 100e6 && alloc.frequency < 1e9, `freq=${alloc.frequency}`);
    assert.equal(alloc.requesterId, 'SCOUT-1');
    assert.equal(alloc.isActive, true);
    assert.ok(alloc.expiresAt > alloc.allocatedAt);
    assert.match(alloc.id, /^ALLOC-/);
});

test('FreqMgr: segundo TRACKING obtiene frecuencia distinta; tercero se rechaza', () => {
    const fm = new FrequencyManager({ region: 'AMERICAS' });
    const a1 = fm.requestFrequency({ requesterId: 'SCOUT-1', type: 'TRACKING' });
    const a2 = fm.requestFrequency({ requesterId: 'SCOUT-2', type: 'TRACKING' });
    assert.notEqual(a1.frequency, a2.frequency, 'frecuencias distintas');
    const a3 = fm.requestFrequency({ requesterId: 'SCOUT-3', type: 'TRACKING' });
    assert.equal(a3, null, 'sin frecuencias disponibles → null');
    assert.equal(fm.getStats().activeChannels, 2);
    assert.equal(fm.getStats().collisions, 0);
});

test('FreqMgr: liberación de frecuencia (existente e inexistente)', () => {
    const fm = new FrequencyManager();
    const alloc = fm.requestFrequency({ requesterId: 'SCOUT-1', type: 'TRACKING' });
    assert.equal(fm.releaseFrequency('NO-EXISTE'), false);
    assert.equal(fm.releaseFrequency(alloc.id), true);
    assert.equal(fm.getStats().activeChannels, 0);
    assert.equal(alloc.isActive, false);
});

test('FreqMgr: tras liberar, la frecuencia vuelve a estar disponible', () => {
    const fm = new FrequencyManager();
    const a1 = fm.requestFrequency({ requesterId: 'A', type: 'TRACKING' });
    fm.releaseFrequency(a1.id);
    const a2 = fm.requestFrequency({ requesterId: 'B', type: 'TRACKING' });
    assert.equal(a2.frequency, a1.frequency, 'misma frecuencia reutilizada');
});

test('FreqMgr: tipos DATA/VOICE/EMERGENCY asignan frecuencias válidas', () => {
    // Instancia nueva por tipo: cada pool ofrece al menos una frecuencia
    for (const type of ['DATA', 'VOICE', 'EMERGENCY', 'TRACKING']) {
        const fm = new FrequencyManager({ region: 'AMERICAS' });
        const alloc = fm.requestFrequency({ requesterId: 'X', type });
        assert.ok(alloc && alloc.frequency > 100e6, `${type}: ${alloc && alloc.frequency}`);
    }
});

test('FreqMgr: emergencyOverride libera asignaciones no críticas', () => {
    const fm = new FrequencyManager();
    const a1 = fm.requestFrequency({ requesterId: 'A', type: 'TRACKING', priority: FREQ_MGR_CONFIG.priorityLevels.LOW });
    const a2 = fm.requestFrequency({ requesterId: 'B', type: 'TRACKING', priority: FREQ_MGR_CONFIG.priorityLevels.HIGH });
    assert.equal(fm.getStats().activeChannels, 2);
    fm.emergencyOverride();
    assert.equal(fm.getStats().activeChannels, 0, 'todas liberadas (prioridad > CRITICAL)');
    assert.equal(a1.isActive, false);
    assert.equal(a2.isActive, false);
});

test('FreqMgr: checkExpirations libera asignaciones vencidas', async () => {
    const fm = new FrequencyManager();
    const a = fm.requestFrequency({ requesterId: 'A', type: 'TRACKING', duration: 0 }); // expira de inmediato
    assert.equal(fm.getStats().activeChannels, 1);
    await sleep(20); // garantiza que expiresAt ya quedó en el pasado (comparación estricta <)
    fm.checkExpirations();
    assert.equal(fm.getStats().activeChannels, 0, 'vencida liberada');
    assert.equal(a.isActive, false);
});

test('FreqMgr: regiones EUROPE y AMERICAS ofrecen bandas distintas', () => {
    const eu = new FrequencyManager({ region: 'EUROPE' });
    const us = new FrequencyManager({ region: 'AMERICAS' });
    const euFreqs = eu.getAvailableFrequencies('DATA').map(f => f.frequency);
    const usFreqs = us.getAvailableFrequencies('DATA').map(f => f.frequency);
    assert.ok(euFreqs.includes(433.05e6) || euFreqs.includes(868.0e6), 'EU incluye banda ISM europea');
    assert.ok(usFreqs.includes(915e6), 'AMERICAS incluye 915 MHz');
});

test('FreqMgr: configuración de prioridades y frecuencias de emergencia', () => {
    assert.deepEqual(FREQ_MGR_CONFIG.priorityLevels, { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 });
    assert.ok(Object.keys(FREQ_MGR_CONFIG.emergencyFrequencies).includes('406.025'));
});

test('FreqScanner: addFrequency sin duplicados, start/stop y getDetectedSignals', async () => {
    const sc = new FrequencyScanner({ frequencies: [144.390e6], scanInterval: 40 });
    sc.addFrequency(915e6);
    sc.addFrequency(915e6); // duplicado
    assert.equal(sc.frequencies.length, 2);
    assert.equal(sc.isScanning, false);
    sc.start();
    assert.equal(sc.isScanning, true);
    await sleep(150);
    sc.stop();
    assert.equal(sc.isScanning, false);
    assert.ok(Array.isArray(sc.getDetectedSignals()));
});
