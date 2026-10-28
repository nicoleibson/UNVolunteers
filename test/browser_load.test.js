'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootFullPage, bootSimulator } = require('./dom_harness.js');

// v2.2 — BUG detectado en navegador real: core_math.js filtraba
// `const IPU_THRESHOLD` (y otras) al scope global de script clásico;
// app_integrated.js la redeclaraba → SyntaxError y TODO el archivo moría
// (sin bindings de botones ni initRelay). El arnés clásico no lo veía
// porque carga core_math.js por require (scope de módulo). Este archivo
// carga TODOS los scripts en el orden exacto de index_integrated.html en
// UN solo contexto vm, como el navegador.

test('v2.2 carga completa en orden navegador sin colisiones de scope global', () => {
    // bootFullPage lanza si algún script falla al parsear/ejecutar en el
    // contexto compartido (espejo del navegador real).
    const h = bootFullPage();
    // Expo de globales en modo navegador (sin `module`):
    assert.strictEqual(typeof h.ctx.coreMath, 'object', 'window.coreMath');
    assert.strictEqual(typeof h.ctx.LifelineEngine, 'object', 'window.LifelineEngine');
    assert.strictEqual(typeof h.ctx.LifelineSensors, 'object', 'window.LifelineSensors');
    assert.strictEqual(typeof h.ctx.LifelineRelayAdapter, 'object', 'window.LifelineRelayAdapter');
    // La app arrancó completa (antes del fix ni siquiera existía):
    assert.strictEqual(h.read('systemState'), 'DORMANT');
    assert.ok(h.read('engine') && h.read('engine').ready, 'engine.ready');
    assert.strictEqual(h.read('APP_CONFIG.label'), 'DISPOSITIVO-LOCAL');
    // El relay existe (initRelay corrió):
    assert.ok(h.read('relay'), 'relay creado');
    // Hooks de depuración disponibles (solo existen si el archivo completo
    // se ejecutó; si el parse hubiera fallado, todo esto sería undefined):
    assert.strictEqual(typeof h.read('window.pingNode'), 'function', 'window.pingNode');
    assert.ok(h.read('window.engine') && h.read('window.engine').ready, 'window.engine.ready');
});

test('v2.2 ?label= configura la identidad del dispositivo', () => {
    const h = bootFullPage({ location: { search: '?label=TELÉFONO' } });
    assert.strictEqual(h.read('APP_CONFIG.label'), 'TELÉFONO');
    assert.strictEqual(h.read('relay.name'), 'TELÉFONO', 'relay.name');
    assert.strictEqual(h.read('engine.config.nodeName'), 'TELÉFONO', 'engine.config.nodeName');
});

test('v2.2 TRIGGER P-WAVE dispara VIGILANCE + relay setAlertState (GUI completa)', () => {
    const h = bootFullPage();
    assert.strictEqual(h.read('relay.alertState'), 'DORMANT');
    h.click('btn-trigger-disaster');
    assert.strictEqual(h.read('systemState'), 'VIGILANCE');
    assert.strictEqual(h.read('relay.alertState'), 'VIGILANCE');
    assert.ok(h.el('system-state-badge').textContent.includes('VIGILANCE'));
    // RESET vuelve a DORMANT
    h.click('btn-reset');
    assert.strictEqual(h.read('systemState'), 'DORMANT');
    assert.strictEqual(h.read('relay.alertState'), 'DORMANT');
});

test('v2.2 arnés clásico sigue operativo (coreMath por require)', () => {
    const h = bootSimulator('app_integrated.js');
    assert.strictEqual(h.read('systemState'), 'DORMANT');
    assert.strictEqual(typeof h.ctx.coreMath, 'object');
    h.click('btn-trigger-disaster');
    assert.strictEqual(h.read('systemState'), 'VIGILANCE');
});
