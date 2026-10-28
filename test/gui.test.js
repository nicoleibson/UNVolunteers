'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bootSimulator } = require('./dom_harness.js');

// ─────────────────────────── SIMULADOR v2.0 ───────────────────────────

test('GUI v2.0: carga completa y motor de producción listo (stack RF real)', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(typeof h.ctx.calcDeltaH, 'function', 'calcDeltaH global');
    assert.equal(typeof h.ctx.calcIPU, 'function', 'calcIPU global');
    assert.equal(typeof h.ctx.getTriageForVitals, 'function', 'getTriageForVitals global');
    assert.equal(typeof h.ctx.resolveState, 'function', 'resolveState global');
    assert.equal(typeof h.ctx.pingNode, 'function', 'pingNode global (window.pingNode)');
    assert.equal(typeof h.ctx.stateConfig, 'function', 'stateConfig global');
    assert.equal(typeof h.ctx.updateUI, 'function');
    assert.equal(typeof h.ctx.updateVitalsPanel, 'function');
    assert.equal(typeof h.ctx.updateEnvironPanel, 'function');
    assert.equal(typeof h.ctx.updateRFPanels, 'function');
    assert.equal(typeof h.ctx.updateWirePanel, 'function');
    assert.equal(typeof h.ctx.currentRole, 'function');
    assert.equal(typeof h.ctx.buildSnapshot, 'function');
    assert.equal(typeof h.ctx.initEngine, 'function');
    assert.equal(typeof h.ctx.initSensors, 'function');
    // Stack RF real cargado en el contexto (igual que index_integrated.html)
    assert.equal(typeof h.ctx.AES128, 'object', 'AES128 (radio/aes128.js)');
    assert.equal(typeof h.ctx.PacketEncoder, 'function', 'PacketEncoder');
    assert.equal(typeof h.ctx.LoRaMesh, 'function', 'LoRaMesh');
    assert.equal(typeof h.ctx.APRSTracker, 'function', 'APRSTracker');
    assert.equal(typeof h.ctx.SDRReceiver, 'function', 'SDRReceiver');
    assert.equal(typeof h.ctx.FrequencyManager, 'function', 'FrequencyManager');
    // Motor de producción creado y listo, sin nodos remotos inventados
    assert.equal(h.read('engine.ready'), true, 'motor listo');
    assert.equal(h.read('engine.getNodes().length'), 1, 'solo el nodo local');
});

test('GUI v2.0: estado inicial DORMANT con badge, IPU y físicas coherentes', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(h.read('systemState'), 'DORMANT');
    assert.equal(h.el('system-state-badge').textContent, 'DORMANT');
    assert.equal(h.el('stat-phy').textContent, 'DORMANT');
    // Regla de producción: sin sensor real → null, la GUI pinta '—'.
    assert.equal(h.read('battery'), null);
    assert.equal(h.read('bpm'), null);
    assert.equal(h.read('spo2'), null);
    assert.equal(h.read('pressureTrapped'), null);
    assert.equal(h.read('watchOnBody'), true);
    // Indicadores honestos en reposo (sin ejemplos inventados)
    assert.equal(h.el('val-bpm').textContent, '—');
    assert.equal(h.el('val-spo2').textContent, '—');
    assert.equal(h.el('val-battery').textContent, '—');
    assert.equal(h.el('val-pressure').textContent, '—');
    // IPU mínima con wearable y sin tacto reciente
    assert.ok(Math.abs(h.read('calcIPU()') - 0.525) < 1e-9, `IPU inicial=${h.read('calcIPU()')}`);
    // Resolución de estado inicial
    assert.equal(h.read('resolveState()'), 'DORMANT');
});

test('GUI v2.0: arranque dibuja en canvas y deja logs iniciales', () => {
    const h = bootSimulator('app_integrated.js');
    const ctx2d = h.el('mesh-canvas').getContext('2d');
    assert.ok(ctx2d.__calls.length > 0, `canvas dibujado (${ctx2d.__calls.length} llamadas 2D)`);
    assert.ok(h.el('log-output').children.length >= 2, 'logs de arranque presentes');
    assert.ok(h.el('lora-packet-log').children.length >= 1, 'log LoRa inicial');
    assert.ok(h.el('aprs-packet-log').children.length >= 1, 'log APRS inicial');
    assert.ok(h.el('sdr-packet-log').children.length >= 1, 'log SDR inicial');
});

test('GUI v2.0: TRIGGER P-WAVE activa VIGILANCE, motor y telemetría real', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(h.read('engine.ready'), true);
    h.click('btn-trigger-disaster');
    assert.equal(h.read('systemState'), 'VIGILANCE');
    assert.match(h.el('system-state-badge').textContent, /VIGILANCE/i);
    assert.equal(h.read('vigilanceSecs'), 1800);
    // Motor iniciado y telemetría real transmitida (sin datos inventados)
    assert.equal(h.read('engine.started'), true, 'engine.started');
    assert.ok(h.read('engine.sequence') >= 1, 'secuencia incrementada');
    assert.ok(h.read('engine.lastTelemetryBytes').length > 0, 'bytes reales del encoder');
    assert.equal(h.el('lora-freq-display').textContent, '915.000 MHz');
    assert.ok(h.el('lora-packet-log').children.length > 1, 'logs LoRa crecieron');
    // Panel ⑤: captura LIVE con trama nonce(8)||cipher||MIC(4)
    assert.equal(h.el('ecies-status').textContent, 'LIVE CAPTURE (BYTES REALES)');
    assert.equal(h.el('bytes-iv').textContent.split(' ').length, 8, 'nonce de 8 bytes');
    assert.equal(h.el('bytes-tag').textContent.split(' ').length, 4, 'MIC de 4 bytes');
    assert.match(h.el('size-cipher').textContent, /CBOR\+LZ77\+AES-CTR/);
    assert.equal(h.el('dec-bpm').textContent, '—', 'BPM descifrado sin fuente real → —');
    // Sin nodos remotos ingeridos: el radar solo muestra el nodo local
    assert.equal(h.read('engine.getNodes().length'), 1);
    assert.match(h.el('radar-victim-list').innerHTML, /◉ LOCAL/);
    // Segundo disparo se ignora
    const logsBefore = h.el('log-output').children.length;
    h.click('btn-trigger-disaster');
    assert.equal(h.read('systemState'), 'VIGILANCE', 'segundo trigger no cambia estado');
    assert.ok(h.el('log-output').children.length > logsBefore, 'registra "ya activo"');
});

test('GUI v2.0: sin sensores el rol es UNKNOWN y no se inventan lecturas', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(h.el('device-role-badge').textContent, 'UNKNOWN');
    assert.equal(h.el('device-role-reason').textContent, 'INSUFFICIENT_SENSORS');
    assert.equal(h.el('device-role-conf').textContent, '0%');
    // Fuentes de sensores todas ausentes
    assert.match(h.el('sensor-sources').textContent, /gps:— barometer:— thermometer:— light:— motion:— mic:— battery:—/);
    // Panel ⑤ en reposo: sin bytes inventados
    assert.equal(h.el('ecies-status').textContent, 'IDLE');
    assert.equal(h.el('bytes-iv').textContent, '-- -- -- --');
    assert.equal(h.el('bytes-tag').textContent, '-- -- -- --');
    // Activo pero sin lecturas reales → marcadores, no valores
    h.click('btn-trigger-disaster');
    h.read('updateEnvironPanel()');
    assert.equal(h.el('env-temp').textContent, '—');
    assert.equal(h.el('env-light').textContent, '—');
    assert.equal(h.el('env-mic').textContent, '—');
    assert.equal(h.el('env-tilt').textContent, '—');
    // Sin nodos remotos: solo el local (cero datos inventados)
    assert.equal(h.read('engine.getNodes().length'), 1);
});

test('GUI v2.0: clasificador de rol — SCOUT en superficie con sensores reales', () => {
    const h = bootSimulator('app_integrated.js');
    h.run(`lastSensor = { timestamp: Date.now(), gps: null, pressure: 101325, temperature: 25, light: 800, mic: 30, tilt: 5, battery: 90,
        sources: { gps:false, barometer:true, thermometer:true, light:true, mic:false, motion:true, battery:true },
        hasGPS:false, hasPressure:true, hasLight:true, hasMotion:true, hasMic:false, hasBattery:true }`);
    h.read('updateUI()');
    assert.equal(h.el('device-role-badge').textContent, 'SCOUT');
    assert.equal(h.el('device-role-reason').textContent, 'SURFACE');
    assert.equal(h.el('device-role-conf').textContent, '75%');
    assert.match(h.el('sensor-sources').textContent, /barometer:✓/);
    assert.match(h.el('sensor-sources').textContent, /light:✓/);
    assert.match(h.el('sensor-sources').textContent, /motion:✓/);
});

test('GUI v2.0: clasificador de rol — VÍCTIMA enterrada e inmóvil', () => {
    const h = bootSimulator('app_integrated.js');
    h.run('pressureTrapped = 102000');
    h.run('lastInteractionTime = Date.now() - 2 * 3600 * 1000');
    h.run(`lastSensor = { timestamp: Date.now(), gps: null, pressure: 102000, temperature: 22, light: 0, mic: 12, tilt: 60, battery: 55,
        sources: { gps:false, barometer:true, thermometer:true, light:true, mic:true, motion:true, battery:true },
        hasGPS:false, hasPressure:true, hasLight:true, hasMotion:true, hasMic:true, hasBattery:true }`);
    h.read('updateUI()');
    assert.equal(h.el('device-role-badge').textContent, 'VICTIM');
    assert.equal(h.el('device-role-reason').textContent, 'BURIED_STILL');
    assert.equal(h.el('device-role-conf').textContent, '95%');
    assert.match(h.el('sensor-sources').textContent, /barometer:✓/);
});

test('GUI v2.0: SOS por 3 taps + pantalla táctil recalculan IPU', () => {
    const h = bootSimulator('app_integrated.js');
    h.click('btn-trigger-disaster'); // SOS requiere no-DORMANT
    const baseline = h.read('calcIPU()');
    h.click('btn-trigger-tap');
    assert.equal(h.read('activeSOS'), true, 'SOS activado');
    assert.ok(h.read('calcIPU()') > baseline, 'IPU sube con SOS activo');
    // Toque de pantalla: refresca lastTouchTime y mantiene la IPU alta
    const beforeTouch = h.read('calcIPU()');
    h.click('btn-touch-interaction');
    assert.ok(h.read('lastTouchTime') > 0, 'lastTouchTime actualizado');
    // Tolerancia ~1/60000 s: el decaimiento por tacto usa Date.now() real,
    // así que cruzar un límite de milisegundo puede restar una fracción.
    assert.ok(h.read('calcIPU()') >= beforeTouch - 0.001, 'IPU recalculada tras tacto');
});

test('GUI v2.0: controles de entrada actualizan variables y etiquetas', () => {
    const h = bootSimulator('app_integrated.js');
    // Battery (slider = override manual de pruebas)
    h.el('control-battery').value = 20;
    h.input('control-battery');
    assert.equal(h.read('battery'), 20);
    assert.equal(h.el('val-battery').textContent, '20%');
    // BPM/SpO₂ entran por el snapshot real del sensor (camino de un puente
    // BLE del wearable): applySensorData, no sliders inventados.
    h.read("applySensorData({ timestamp: Date.now(), bpm: 130, spo2: 95 })");
    h.read('updateUI()');
    assert.equal(h.read('bpm'), 130, 'bpm real del sensor');
    let triage = h.read('getTriageForVitals(bpm, spo2, activeSOS, calcIPU())');
    assert.equal(triage.code, 2, 'bpm 130 → RED (IMMEDIATE)');
    assert.equal(h.el('val-bpm').textContent, '130 BPM');
    // Wearable off → IPU mínima sube y triaje pasa a YELLOW (vitae desconocidas)
    h.el('control-wearable-body').checked = false;
    h.change('control-wearable-body');
    assert.equal(h.read('watchOnBody'), false);
    assert.ok(Math.abs(h.read('calcIPU()') - 0.620) < 1e-9, `IPU sin wearable=${h.read('calcIPU()')}`);
    triage = h.read('getTriageForVitals(bpm, spo2, activeSOS, calcIPU())');
    assert.equal(triage.code, 1, 'sin wearable → YELLOW (UNKNOWN VITALS)');
    // Presión > 1013.25 → profundidad positiva
    h.el('control-pressure').value = 102000;
    h.input('control-pressure');
    assert.equal(h.read('pressureTrapped'), 102000);
    assert.ok(h.read('calcDeltaH(102000)') > 50, `deltaH=${h.read('calcDeltaH(102000)').toFixed(2)}m`);
});

test('GUI v2.0: paneles de telemetría y entorno renderizan sin lanzar', () => {
    const h = bootSimulator('app_integrated.js');
    h.el('control-pressure').value = 101325; h.input('control-pressure');
    assert.doesNotThrow(() => h.read('updateVitalsPanel()'), 'updateVitalsPanel');
    assert.doesNotThrow(() => h.read('updateEnvironPanel()'), 'updateEnvironPanel');
    assert.doesNotThrow(() => h.read('updateUI()'), 'updateUI');
    assert.ok(h.el('depth-display').textContent, 'profundidad mostrada');
    assert.ok(h.el('env-temp').textContent, 'temperatura mostrada');
});

test('GUI v2.0: RESET devuelve a DORMANT con valores por defecto', () => {
    const h = bootSimulator('app_integrated.js');
    h.click('btn-trigger-disaster');
    assert.equal(h.read('systemState'), 'VIGILANCE');

    // Degradar recursos: sin wearable y batería crítica → la máquina
    // resuelve por sí sola a SURVIVAL (invariante de supervivencia).
    h.el('control-battery').value = 10; h.input('control-battery');
    h.el('control-wearable-body').checked = false; h.change('control-wearable-body');
    h.click('btn-trigger-tap');
    assert.equal(h.read('activeSOS'), true);
    assert.equal(h.read('systemState'), 'SURVIVAL', 'battery 10 sin wearable → SURVIVAL');

    h.click('btn-reset');
    assert.equal(h.read('systemState'), 'DORMANT');
    assert.equal(h.read('battery'), null, 'sin lectura real de batería tras reset');
    assert.equal(h.read('watchOnBody'), true);
    assert.equal(h.read('bpm'), null, 'sin pulso real tras reset');
    assert.equal(h.read('spo2'), null, 'sin oxígeno real tras reset');
    assert.equal(h.read('pressureTrapped'), null, 'sin barómetro real tras reset');
    assert.equal(h.read('activeSOS'), false);
    assert.equal(h.el('val-battery').textContent, '—');
    assert.equal(h.el('val-bpm').textContent, '—');
});

test('GUI v2.0: panel ⑯ relay cross-device presente y con estado real', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(typeof h.ctx.initRelay, 'function', 'initRelay global');
    assert.ok(h.el('panel-testsig'), 'panel ⑯ en el DOM');
    assert.equal(typeof h.ctx.LifelineRelayAdapter.RelayAdapter, 'function', 'adaptador cargado');
    // El arnés no tiene EventSource/fetch → transporte no disponible (honesto)
    assert.match(h.el('relay-status').textContent, /SIN TRANSPORTE/);
    assert.equal(h.read('relay') !== null, true, 'adaptador creado');
    assert.equal(h.read('relay.connected'), false);
    assert.equal(h.read('relay.available'), false);
    assert.equal(h.el('relay-tx').textContent, '0');
    assert.equal(h.el('relay-rx').textContent, '0');
    assert.equal(h.el('relay-nodes').textContent, '1');
    assert.ok(h.el('relay-peers'), 'lista de pares en el panel');
    assert.match(h.el('relay-peers').innerHTML, /SIN PARES/);
});

test('GUI v2.2: el relay reporta el estado de alerta del dispositivo (DORMANT↔VIGILANCE)', () => {
    const h = bootSimulator('app_integrated.js');
    assert.equal(h.read('relay.alertState'), 'DORMANT', 'arranca dormido');
    h.click('btn-trigger-disaster');
    assert.equal(h.read('relay.alertState'), 'VIGILANCE', 'al disparar P-WAVE entra en alerta');
    h.click('btn-reset');
    assert.equal(h.read('relay.alertState'), 'DORMANT', 'al resetear vuelve a dormir');
});

test('GUI v2.0: panel ⑯ — inyectar nodo real transmite la trama; limpiar nodos remotos', () => {
    const h = bootSimulator('app_integrated.js');
    h.click('btn-trigger-disaster');
    assert.equal(h.read('engine.getNodes().length'), 1);
    assert.equal(h.el('relay-nodes').textContent, '1');

    // Inyectar nodo transmite la trama real del dispositivo (sin datos ficticios)
    const seqBefore = h.read('engine.sequence');
    h.click('btn-test-node');
    assert.ok(h.read('engine.sequence') > seqBefore, 'inyección transmite la trama real del dispositivo');
    assert.ok(h.read('engine.lastTelemetryBytes').length > 0, 'bytes reales del encoder');
    assert.ok(h.el('rf-log-output').children.length > 0);

    h.click('btn-test-clear');
    assert.equal(h.read('engine.getNodes().length'), 1, 'sin nodos remotos inventados');
    assert.equal(h.el('lora-nodes').textContent, '1');
});

test('GUI v2.0: panel ⑯ — botón TX reenvía telemetría real por el motor', () => {
    const h = bootSimulator('app_integrated.js');
    // TX sin motor iniciado → aviso, sin transmitir
    h.click('btn-test-tx');
    assert.ok(h.read('engine.sequence') === 0, 'sin trigger no transmite');

    h.click('btn-trigger-disaster');
    const seqAfterTrigger = h.read('engine.sequence');
    assert.ok(seqAfterTrigger >= 1, 'telemetría automática al disparar');

    h.click('btn-test-tx');
    assert.ok(h.read('engine.sequence') > seqAfterTrigger, 'TX manual incrementa la secuencia');
    assert.ok(h.read('engine.lastTelemetryBytes').length > 0, 'bytes reales del encoder');
});

// ─────────────────────────── SIMULADOR v1.2 ───────────────────────────

const V1_TABS = { tabButtons: ['tab-apex', 'tab-sidecar', 'tab-cdd'], tabContents: ['tab-apex', 'tab-sidecar', 'tab-cdd'] };

test('GUI v1.2: carga completa, globals y estado DORMANT', () => {
    const h = bootSimulator('app.js', V1_TABS);
    assert.equal(typeof h.ctx.calcDeltaH, 'function');
    assert.equal(typeof h.ctx.getTriageForVitals, 'function');
    assert.equal(typeof h.ctx.pingNode, 'function');
    assert.equal(h.read('systemState'), 'DORMANT');
    assert.equal(h.el('system-state-badge').textContent, 'DORMANT');
    assert.equal(h.read('resolveState()'), 'DORMANT');
});

test('GUI v1.2: TRIGGER P-WAVE → VIGILANCE y contador iniciado', () => {
    const h = bootSimulator('app.js', V1_TABS);
    h.click('btn-trigger-disaster');
    assert.equal(h.read('systemState'), 'VIGILANCE');
    assert.match(h.el('system-state-badge').textContent, /VIGILANCE/i);
    assert.equal(h.read('vigilanceSecs'), 1800);
});

test('GUI v1.2: pestañas APEX/Sidecar/CDD cambian de vista', () => {
    const h = bootSimulator('app.js', V1_TABS);
    // En el arranque, tab-apex está activo
    assert.equal(h.tabButtons[0].classList.contains('active'), true, 'tab-apex activo');
    assert.equal(h.tabContents[1].classList.contains('hidden'), true, 'tab-sidecar oculto');

    // Click en tab-sidecar
    h.click('tab-sidecar');
    assert.equal(h.tabButtons[1].classList.contains('active'), true, 'tab-sidecar activo');
    assert.equal(h.tabButtons[0].classList.contains('active'), false, 'tab-apex desactivado');
    assert.equal(h.tabContents[1].classList.contains('hidden'), false, 'tab-sidecar visible');
    assert.equal(h.tabContents[0].classList.contains('hidden'), true, 'tab-apex oculto');
});

test('GUI v1.2: SOS, controles y RESET mantienen el invariante', () => {
    const h = bootSimulator('app.js', V1_TABS);
    h.click('btn-trigger-disaster');
    h.click('btn-trigger-tap');
    assert.equal(h.read('activeSOS'), true);

    h.el('control-battery').value = 15; h.input('control-battery');
    assert.equal(h.read('battery'), 15);

    h.click('btn-reset');
    assert.equal(h.read('systemState'), 'DORMANT');
    assert.equal(h.read('battery'), 100);
    assert.equal(h.read('activeSOS'), false);
    assert.equal(h.read('watchOnBody'), true);
});
