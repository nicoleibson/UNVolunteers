'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bootFullPage } = require('./dom_harness.js');

// Requisito: la GUI debe reflejar en pantalla todos los procesos en acción
// y cada botón debe disparar su acción correspondiente. Se verifica botón
// por botón sobre la página completa (orden navegador real).

function logText(h, id) {
    return h.el(id).children.map((c) => c.innerHTML).join('\n');
}

function boot() {
    return bootFullPage();
}

test('botones de alerta: TRIGGER P-WAVE arranca el motor y RESET lo apaga', () => {
    const h = boot();
    assert.strictEqual(h.read('engine.started'), false);
    h.click('btn-trigger-disaster');
    assert.strictEqual(h.read('systemState'), 'VIGILANCE');
    assert.strictEqual(h.read('engine.started'), true, 'motor arrancado');
    assert.strictEqual(h.read('relay.alertState'), 'VIGILANCE');
    assert.ok(logText(h, 'log-output').includes('Cell Broadcast GEOFENCED_CRITICAL_ALERT interceptado'));
    assert.ok(logText(h, 'log-output').includes('RF] Motor de producción iniciado'), 'log de inicio RF');
    h.click('btn-reset');
    assert.strictEqual(h.read('systemState'), 'DORMANT');
    assert.strictEqual(h.read('relay.alertState'), 'DORMANT');
    assert.strictEqual(h.read('engine.started'), false, 'motor detenido al reset');
});

test('botones de interacción requieren alerta activa y registran la acción', () => {
    const h = boot();
    // En DORMANT: ignorados con aviso
    h.click('btn-trigger-tap');
    assert.strictEqual(h.read('activeSOS'), false);
    h.click('btn-touch-interaction');
    assert.ok(logText(h, 'log-output').includes('DORMANT — toque ignorado'));

    // En VIGILANCE: actúan
    h.click('btn-trigger-disaster');
    h.click('btn-trigger-tap');
    assert.strictEqual(h.read('activeSOS'), true, 'SOS activado');
    assert.ok(logText(h, 'log-output').includes('PATRÓN SOS DE 3 TAPS RECONOCIDO'));
    assert.ok(logText(h, 'lora-packet-log').includes('SOS beacon transmitido'));

    h.click('btn-touch-interaction');
    assert.ok(h.read('lastTouchTime') > 0, 'touch registrado');
    assert.ok(logText(h, 'log-output').includes('Toque de pantalla registrado. IPU recalculada.'));
});

test('botones del panel ⑯ TEST SIGNALS', () => {
    const h = boot();
    // btn-test-tx exige motor iniciado
    h.click('btn-test-tx');
    assert.ok(logText(h, 'rf-log-output').includes('Motor no iniciado'));

    h.click('btn-trigger-disaster');
    h.click('btn-test-tx');
    assert.ok(logText(h, 'rf-log-output').includes('Señal de prueba TX enviada'), 'TX de prueba');
    assert.ok(logText(h, 'lora-packet-log').includes('Telemetry TX'), 'broadcast AES-CTR real');

    // btn-test-node exige motor iniciado (no transmite en DORMANT)
    h.click('btn-test-node');
    assert.ok(logText(h, 'rf-log-output').includes('Motor no iniciado'), 'aviso sin motor');

    // Tras el trigger, inyectar transmite la trama real del dispositivo
    h.click('btn-trigger-disaster');
    const seqBefore = h.read('engine.sequence');
    h.click('btn-test-node');
    assert.ok(h.read('engine.sequence') > seqBefore, 'trama real transmitida');
    assert.ok(logText(h, 'lora-packet-log').includes('Nodo inyectado TX'), 'inyección real por la malla');
    assert.ok(logText(h, 'rf-log-output').includes('Nodo inyectado'));

    // btn-test-clear limpia los nodos remotos (no inventa ninguno)
    h.click('btn-test-clear');
    assert.strictEqual(h.read('engine.remoteNodes.size'), 0, 'sin nodos remotos');
    assert.ok(logText(h, 'rf-log-output').includes('Nodos remotos limpiados'));

    // btn-test-addpeer solicita el par manual (feedback visible)
    h.el('test-peer-url').value = 'http://192.168.0.5:8000';
    h.click('btn-test-addpeer');
    assert.ok(logText(h, 'rf-log-output').includes('Par manual solicitado: http://192.168.0.5:8000'));
    // Sin URL: pide que la indiques
    h.el('test-peer-url').value = '';
    h.click('btn-test-addpeer');
    assert.ok(logText(h, 'rf-log-output').includes('Indica la URL del par'));
});

test('btn-ping-all pinguea los nodos visibles por la malla real', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // Nodo remoto real por la vía del feed del operativo (sin datos ficticios)
    h.read(`engine.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM', bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73 },
    ]);`);
    h.read('updateUI()');
    h.click('btn-ping-all');
    h.flushTimers();
    assert.ok(h.read('pingUntil.size') >= 1, 'pings emitidos');
    assert.ok(logText(h, 'lora-packet-log').includes('Ping request →'), 'ping por LoRa');
});

test('refresco en tiempo real: el tick periódico repinta la lista sin updateUI manual', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read(`engine.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM', bpm: 110, spo2: 93, battery: 42, pressure: 102400, rssi: -73 },
    ]);`);
    // Sin llamar updateUI() a mano: el tick de 1 s refresca la tabla scout.
    h.flushTimers();
    const html = h.el('radar-victim-list').innerHTML;
    assert.ok(html.includes('VICTIM-1'), 'nodo visible en la lista tras el tick');
    assert.ok(html.includes('42%'), 'batería real mostrada');
    assert.ok(/\d+s<\/td>/.test(html), 'columna de última señal renderizada');
});

test('baliza real: el BEACON de otro dispositivo materializa su nodo en el panel', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read(`
        const beaconNode = new LoRaNode({ id: 'BBBBBBBB00000002', name: 'TELÉFONO', type: 'SCOUT', battery: 61 });
        window.__beacon = beaconNode.createBeacon();
    `);
    h.read('engine.mesh.processBeacon(engine.localNode, window.__beacon);');
    assert.strictEqual(h.read('engine.remoteNodes.size'), 1, 'baliza materializada sin ingest()');
    h.flushTimers();
    const html = h.el('radar-victim-list').innerHTML;
    assert.ok(html.includes('TELÉFONO'), 'dispositivo baliza visible en la lista');
    assert.ok(html.includes('61%'), 'batería real del beacon mostrada');
});

test('Etapa 0: botones BIND RADIO/BLE reportan honestamente sin hardware (nunca inventan)', async () => {
    const h = boot();
    // Sin Web Serial / Web Bluetooth en el entorno: los botones disparan su
    // acción y el estado refleja el motivo real, sin lecturas ficticias.
    h.click('btn-bind-radio');
    await new Promise((r) => setImmediate(r)); // deja correr el .then del connect
    assert.ok(logText(h, 'rf-log-output').includes('Radio física no disponible'), 'radio reportada');
    assert.match(h.el('radio-status').textContent, /SIN RADIO/);

    h.click('btn-bind-ble');
    await new Promise((r) => setImmediate(r));
    assert.ok(logText(h, 'rf-log-output').includes('Wearable BLE no disponible'), 'BLE reportado');
    assert.match(h.el('ble-status').textContent, /SIN BLE/);

    // Sin hardware, los vitales no se inventan
    assert.strictEqual(h.read('bpm'), null);
    assert.strictEqual(h.read('spo2'), null);
    // Los módulos están cargados en la página (navegador real los cargaría)
    assert.ok(h.read('typeof LoRaRadioDriver') === 'function', 'driver cargado');
    assert.ok(h.read('typeof LifelineBleBridge') === 'function', 'puente BLE cargado');
});

test('btn-intercom-send transmite el mensaje y vacía el campo', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.el('intercom-input').value = 'ALFA 3 ENTERRADOS';
    h.click('btn-intercom-send');
    assert.strictEqual(h.el('intercom-input').value, '', 'campo vaciado');
    assert.ok(h.el('intercom-log').innerHTML.includes('SCOUT →'), 'mensaje en el log intercom');
    assert.ok(logText(h, 'log-output').includes('Transmitiendo comando por la malla LoRa real'));
    assert.ok(logText(h, 'lora-packet-log').includes('Intercom TX'), 'TX LoRa real');
    // Enter también envía
    h.el('intercom-input').value = 'OTRO';
    h.keypress('intercom-input', { key: 'Enter' });
    assert.strictEqual(h.el('intercom-input').value, '');
});

test('Panel ⑰: gases sin módulo vinculado → SIN GASES y CO/O2 en «—» (honesto)', async () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('updateAtmPanel()');
    assert.equal(h.el('atm-co').textContent, '—');
    assert.equal(h.el('atm-o2').textContent, '—');
    assert.equal(h.el('atm-level').textContent, 'SIN LECTURA');
    h.click('btn-bind-atm'); // sin navigator.bluetooth en el arnés
    await new Promise((r) => setImmediate(r));
    assert.ok(h.el('atm-status').textContent.includes('SIN GASES'), 'estado honesto sin Web Bluetooth');
});

test('Panel ⑰: térmica sin transporte → SIN TÉRMICA, sin firmas inventadas', () => {
    const h = boot();
    h.click('btn-bind-thermal');
    assert.ok(h.el('th-status').textContent.includes('SIN TÉRMICA'), 'estado honesto sin transporte');
    // sin rejilla real, no se reporta ninguna firma corpórea (no se inventa)
    assert.notEqual(h.el('th-count').textContent, '1');
    assert.notEqual(h.el('th-pixels').textContent, '1');
});

test('Panel ⑰: DTN — baliza de víctima real se almacena y el panel repinta', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.run('engine.dtn.clear()');
    h.run(`engine.dtn.ingest({ nodeId:'EEEEDDDD00000009', timestamp:Date.now(), data:{ role:'VICTIM', bpm:90, spo2:97 } });`);
    h.run(`engine.remoteNodes.set('EEEEDDDD00000009', { id:'EEEEDDDD00000009', label:'VIC', role:'VICTIM', node:{type:'VICTIM'}, pressure:102500, lastSeen:Date.now(), bpm:90, spo2:97 });`);
    h.read('updateDTNPanel()');
    assert.equal(h.el('dtn-stored').textContent, '1');
    assert.equal(h.el('dtn-pending').textContent, '1', 'baliza pendiente en el outbox');
    h.click('btn-dtn-sync');
    assert.ok(logText(h, 'rf-log-output').includes('DTN'), 'feedback de sincronización de la mula');
});

test('Panel ⑰: rol dinámico sugiere REPETIDOR con scouts + víctimas y aplica el cambio', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // 2 scouts + 1 víctima → sugiere RELAY
    h.run(`engine.remoteNodes.set('S1', { id:'S1', role:'SCOUT', node:{type:'SCOUT'}, lastSeen:Date.now() });`);
    h.run(`engine.remoteNodes.set('S2', { id:'S2', role:'SCOUT', node:{type:'SCOUT'}, lastSeen:Date.now() });`);
    h.run(`engine.remoteNodes.set('V1', { id:'V1', role:'VICTIM', node:{type:'VICTIM'}, lastSeen:Date.now() });`);
    h.read('updateDynamicRolePanel()');
    assert.equal(h.el('role-suggest').textContent, 'RELAY', 'densidad + víctima → repetidor');
    h.click('btn-apply-role');
    assert.equal(h.read('engine.localNode.type'), 'RELAY', 'rol aplicado en la malla real');
});

test('Panel ⑰: wake-up radio IDLE→ACTIVE al detectar proximidad (honesto)', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('updateWakePanel()');
    assert.equal(h.el('wake-state').textContent, 'IDLE', 'escucha ultra-baja activa al arranque');
    h.click('btn-wake-prox'); // simula la firma de proximidad del HCI
    assert.equal(h.el('wake-state').textContent, 'ACTIVE', 'sensores de alcance activos');
    assert.equal(h.read('engine.wakeRadio.getState().activations'), 1);
});

test('Detección en vivo: un nodo nuevo se refleja en el feed al instante', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('clearDetections()');
    h.read(`engine.ingestRemoteTelemetry([
        { id: 'AB00000000000002', label: 'VICTIM-1', role: 'VICTIM', bpm: 110, spo2: 93, pressure: 102400 },
    ]);`);
    h.read('updateUI()'); // dispara trackNodeDetections
    assert.equal(h.read('detectionFeed.length'), 1, 'una detección registrada');
    assert.equal(h.read('detectionFeed[0].evt'), 'NUEVO', 'evento de primer avistamiento');
    assert.ok(h.read('detectionFeed[0].label') === 'VICTIM-1');
    // el feed repinta los datos recibidos (vitals + profundidad reales)
    assert.ok(h.el('detection-feed-list').innerHTML.includes('110 BPM'), 'vitals reflejadas');
    assert.ok(h.el('detection-feed-list').innerHTML.includes('NUEVO'), 'etiqueta de evento pintada');
});

test('Detección en vivo: cambios de datos → evento ACTUALIZADO (no inventa)', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('clearDetections()');
    h.read(`engine.ingestRemoteTelemetry([{ id: 'AB00000000000002', role: 'VICTIM', bpm: 90, spo2: 97 }]);`);
    h.read('updateUI()');
    // el nodo actualiza sus lecturas → ACTUALIZADO, no una segunda NUEVO
    h.read(`engine.remoteNodes.set('AB00000000000002', { id:'AB00000000000002', role:'VICTIM', bpm: 60, spo2: 90, pressure: 102300 });`);
    h.read('updateUI()');
    assert.equal(h.read('detectionFeed[0].evt'), 'ACTUALIZADO', 'refresco por cambio real de datos');
    assert.equal(h.read('detectionFeed.length'), 2, 'NUEVO + ACTUALIZADO en el feed');
    // resaltado de fila activo para el nodo actualizado
    h.read('updateScoutTable("VIGILANCE")');
    assert.ok(h.el('radar-victim-list').innerHTML.includes('det-row-upd'), 'fila resaltada como actualizada');
});

test('Detección en vivo: LIMPIAR vacía el feed y el contador', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read(`engine.ingestRemoteTelemetry([{ id: 'AB00000000000002', role: 'VICTIM', bpm: 110, spo2: 93 }]);`);
    h.read('updateUI()');
    assert.equal(h.read('detectionFeed.length'), 1);
    h.read('clearDetections()');
    assert.equal(h.read('detectionFeed.length'), 0, 'feed limpiado');
    assert.ok(h.el('detection-feed-list').innerHTML.includes('Sin detecciones'), 'estado vacío honesto');
});

test('Móvil: en smartphone cada tarjeta es pantalla completa (mob-active) y el menú se construye', () => {
    const h = bootFullPage({ innerWidth: 360 }); // smartphone
    // El primer panel nace como pantalla activa.
    assert.equal(h.read('mobileActivePanel'), 'panel-role', 'pantalla inicial = primera tarjeta');
    assert.ok(h.el('panel-role').classList.contains('mob-active'), 'tarjeta activa visible a pantalla completa');
    // El menú ampliable se llenó con todas las tarjetas por su función.
    assert.equal(h.read('mobileNavButtons.size'), 20, 'una entrada por tarjeta');
    // Navegar a otra pantalla cambia la activa y la resalta en el menú.
    h.read(`goToPanel('panel-barrido')`);
    assert.equal(h.read('mobileActivePanel'), 'panel-barrido');
    assert.ok(h.el('panel-barrido').classList.contains('mob-active'), 'nueva tarjeta activa');
    assert.ok(!h.el('panel-role').classList.contains('mob-active'), 'la anterior deja de estar activa');
    const btn = h.read('mobileNavButtons.get(\'panel-barrido\')');
    assert.ok(btn.classList.contains('active'), 'entrada del menú resaltada');
    assert.equal(btn.textContent, '⑰ BARRIDO', 'menú identifica la tarjeta por función');
});

test('Móvil: toggle abre/cierra el cajón del menú ampliable', () => {
    const h = bootFullPage({ innerWidth: 360 });
    assert.ok(!h.el('mobile-drawer').classList.contains('open'), 'cajón cerrado al inicio');
    h.read('toggleMobileNav()');
    assert.ok(h.el('mobile-drawer').classList.contains('open'), 'cajón abierto con ☰');
    assert.ok(h.el('mobile-overlay').classList.contains('open'), 'fondo oscurecido');
    h.read('closeMobileNav()');
    assert.ok(!h.el('mobile-drawer').classList.contains('open'), 'cajón cerrado al elegir/cerrar');
});

test('Escritorio: las tarjetas no se ocultan (fluyen en grid) pese al menú', () => {
    const h = bootFullPage({ innerWidth: 1280 }); // desktop
    assert.equal(h.read('isMobileLayout()'), false, 'layout de escritorio detectado');
    assert.ok(!h.el('panel-role').classList.contains('mob-active'), 'ninguna tarjeta es pantalla completa');
    // el menú sigue construido pero sin activar ninguna pantalla
    assert.equal(h.read("mobileNavButtons.size"), 20);
    // rotar a móvil reordena; volver a escritorio restaura el grid
    h.read('window.innerWidth = 360; onLayoutChange();');
    assert.ok(h.el('panel-role').classList.contains('mob-active'), 'móvil: pantalla activa');
    h.read('window.innerWidth = 1280; onLayoutChange();');
    assert.ok(!h.el('panel-role').classList.contains('mob-active'), 'escritorio: grid restaurado');
});

test('Móvil: botón PANTALLA COMPLETA al final del menú adapta la tarjeta activa', () => {
    const h = bootFullPage({ innerWidth: 360 });
    // el botón del pie del cajón existe y está cableado
    assert.equal(h.el('btn-mobile-fullscreen').id, 'btn-mobile-fullscreen', 'botón presente en el menú');
    assert.equal(h.read('typeof toggleFullscreen'), 'function', 'controlador de pantalla completa cableado');
    // sin API nativa en el arnés, el toggle aplica el fallback forced-fullscreen
    h.read(`goToPanel('panel-scout')`);
    h.read('toggleFullscreen()');
    assert.ok(h.el('panel-scout').classList.contains('forced-fullscreen'), 'tarjeta forzada a pantalla completa');
    // volver a pulsar lo desactiva
    h.read('toggleFullscreen()');
    assert.ok(!h.el('panel-scout').classList.contains('forced-fullscreen'), 'se restaura al salir de pantalla completa');
});

test('Móvil: el menú navega y el cajón se cierra al elegir pantalla', () => {
    const h = bootFullPage({ innerWidth: 360 });
    h.read('toggleMobileNav()');
    assert.ok(h.el('mobile-drawer').classList.contains('open'));
    h.read(`goToPanel('panel-vitals')`);
    assert.ok(!h.el('mobile-drawer').classList.contains('open'), 'elegir pantalla cierra el menú');
    assert.ok(h.el('panel-vitals').classList.contains('mob-active'), 'tarjeta seleccionada activa');
});

test('Sensores: distancia UWB y orientación ingresan nativas y null-safe (cero datos inventados)', () => {
    const h = boot();
    // Sin lectura real: sin brújula ni UWB (honesto).
    const snap0 = h.read('sensors.getSnapshot()');
    assert.equal(snap0.uwbDistance, null, 'sin distancia UWB real');
    assert.equal(snap0.hasUwb, false);
    assert.equal(snap0.orientation, null, 'sin DeviceOrientation real');
    assert.equal(snap0.hasOrientation, false);
    // setDistance con un número real activa la fuente UWB.
    h.read('sensors.setDistance(4.2)');
    const snap1 = h.read('sensors.getSnapshot()');
    assert.equal(snap1.uwbDistance, 4.2, 'distancia UWB real');
    assert.equal(snap1.hasUwb, true);
    // Valor inválido se descarta (no se inventa).
    h.read('sensors.setDistance("no-real")');
    assert.equal(h.read('sensors.getSnapshot().uwbDistance'), null, 'entrada no numérica descartada');
    assert.equal(h.read('sensors.getSnapshot().hasUwb'), false);
});

test('Flecha táctica: sin lectura real la flecha se apaga (cero datos inventados)', () => {
    const h = boot();
    h.click('btn-trigger-disaster'); // motor con calculateRescueVector
    // Sin distancia UWB ni orientación → SIN VECTOR honesto.
    assert.strictEqual(h.el('rescue-status').textContent, 'SIN VECTOR');
    assert.ok(h.el('rescue-readout').textContent.includes('sin distancia UWB'), 'motivo honesto');
    // Distancia UWB pero sin brújula → sigue apagada (sin brújula).
    h.read('sensors.setDistance(4.2)');
    assert.ok(h.el('rescue-readout').textContent.includes('sin brújula'), 'falta orientación');
});

test('Flecha táctica: con UWB + orientación dibuja el vector de rescate', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('sensors.setDistance(4.2)');
    // Azimut 0 = Norte, inclinación -30 = apuntando hacia abajo.
    h.read('sensors.onOrientation({alpha:0, beta:-30, gamma:0})');
    assert.strictEqual(h.el('rescue-status').textContent, 'VECTOR ACTIVO');
    const readout = h.el('rescue-readout').textContent;
    assert.ok(readout.includes('Cavar'), 'anota profundidad de excavación');
    assert.ok(readout.includes('-2.1 m') || readout.includes('Cavar -'), 'z<0 = víctima bajo el suelo');
    assert.ok(readout.includes('rumbo N'), 'azimut 0 → flecha al Norte');
});

test('Excavación (GUI): vector sin firma térmica → desvío 0° honesto', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('sensors.setDistance(4.2)');
    h.read('sensors.onOrientation({alpha:0, beta:-30, gamma:0})');
    const text = h.el('excavation-suggestion').textContent;
    assert.ok(text.includes('Excavar'), 'sugiere el punto');
    assert.ok(text.includes('profundidad'), 'anota profundidad');
    assert.ok(text.includes('desvío 0° (sin firma térmica)'), 'sin térmica no inventa desvío');
    assert.ok(text.includes('sin firma térmica'), 'honesto');
});

test('Excavación (GUI): firma térmica a la derecha desvía el punto (gradiente de calor)', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    h.read('sensors.setDistance(4.2)');
    h.read('sensors.onOrientation({alpha:0, beta:-30, gamma:0})');
    // Frame térmico real: hotspot (barrera) desplazado a la derecha de la rejilla 32×24.
    h.read('setLastThermal({width:32, height:24, temps:new Float32Array(32*24).fill(20), humans:{hotspots:[{x:28,y:12,temp:37.1}]}})');
    const text = h.el('excavation-suggestion').textContent;
    assert.ok(text.includes('desvío') && text.includes('az'), 'desvío azimut por gradiente térmico');
    assert.ok(text.includes('barrera 37.1 °C'), 'referencia a la barrera térmica');
});

test('Overlay táctico: modo TÁCTICA consolida vector + punto de excavación en un resumen único', () => {
    const h = boot();
    assert.strictEqual(h.read('getTacticalMode()'), 'TACTICA', 'modo consolidado por defecto');
    h.click('btn-trigger-disaster');
    h.read('sensors.setDistance(4.2)');
    h.read('sensors.onOrientation({alpha:0, beta:-30, gamma:0})');
    h.read('setLastThermal({width:32, height:24, temps:new Float32Array(32*24).fill(20), humans:{hotspots:[{x:28,y:12,temp:37.1}]}})');
    const sum = h.el('tactical-summary').textContent;
    assert.ok(sum.includes('MODO TÁCTICA'), 'resumen consolidado');
    assert.ok(sum.includes('excavar'), 'incluye el punto de excavación');
    assert.ok(sum.includes('desvío'), 'incluye la corrección térmica');
    assert.ok(sum.includes('profundidad') || sum.includes('@'), 'incluye la profundidad');
});

test('Overlay táctico: conmutador TÁCTICA→VECTOR→TÁCTICA y honestidad sin vector', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // Sin datos → resumen honesto.
    assert.ok(h.el('tactical-summary').textContent.includes('sin vector'), 'honesto sin datos');
    // Activar vector.
    h.read('sensors.setDistance(4.2)');
    h.read('sensors.onOrientation({alpha:0, beta:-30, gamma:0})');
    h.read('setLastThermal({width:32, height:24, temps:new Float32Array(32*24).fill(20), humans:{hotspots:[{x:28,y:12,temp:37.1}]}})');
    const btn = () => h.el('btn-tactical-mode').textContent;
    assert.strictEqual(h.read('getTacticalMode()'), 'TACTICA', 'inicia en modo consolidado');
    // Cambiar a VECTOR: el botón se actualiza por JS.
    h.click('btn-tactical-mode');
    assert.strictEqual(h.read('getTacticalMode()'), 'VECTOR', 'pasa a modo vector');
    assert.ok(btn().includes('OFF'), 'botón refleja modo VECTOR');
    assert.ok(h.el('tactical-summary').textContent.includes('MODO VECTOR'), 'resumen de solo dirección');
    // Volver a TÁCTICA.
    h.click('btn-tactical-mode');
    assert.strictEqual(h.read('getTacticalMode()'), 'TACTICA');
    assert.ok(btn().includes('ON'));
    assert.ok(h.el('tactical-summary').textContent.includes('MODO TÁCTICA'));
});

test('Puente de campo: una línea real UWB+ORI inyectada llega al sensor y enciende el overlay', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // Crear el puente (enlaza el enrutado UWB/ORI al sensor real).
    h.read('connectFieldSerial()');
    // Enlazar un puerto de campo real (simulado) y alimentarlo con líneas físicas.
    h.read('getFieldBridge().attach({__opened:true, open:async()=>{}, readable:null})');
    h.read('getFieldBridge().injectLine("UWB 4.2")');
    h.read('getFieldBridge().injectLine("ORI 0 -30 0")');
    assert.strictEqual(h.read('sensors.getSnapshot().hasUwb'), true, 'UWB real → sensor');
    assert.equal(h.read('sensors.getSnapshot().uwbDistance'), 4.2);
    assert.strictEqual(h.read('sensors.getSnapshot().hasOrientation'), true, 'ORI real → sensor');
    // El overlay táctico se enciende con el vector real del campo.
    assert.strictEqual(h.el('rescue-status').textContent, 'VECTOR ACTIVO');
    assert.ok(h.el('tactical-summary').textContent.includes('MODO TÁCTICA'));
    assert.ok(h.el('tactical-summary').textContent.includes('profundidad') || h.el('tactical-summary').textContent.includes('@'));
});

test('Modo esclavo (maestro): la línea recibida por red se inyecta al puente y enciende el vector', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // El receptor (maestro) inyecta líneas WebRTC en el puente de campo.
    h.read('injectFieldLine("UWB 5.1")');
    h.read('injectFieldLine("ORI 90 -20 0")');
    assert.strictEqual(h.read('sensors.getSnapshot().hasUwb'), true, 'UWB de red → sensor');
    assert.equal(h.read('sensors.getSnapshot().uwbDistance'), 5.1);
    assert.strictEqual(h.read('sensors.getSnapshot().hasOrientation'), true, 'ORI de red → sensor');
    assert.strictEqual(h.el('rescue-status').textContent, 'VECTOR ACTIVO');
    assert.ok(h.el('tactical-summary').textContent.includes('MODO TÁCTICA'));
});

test('Conmutador manual de enlace: alterna ESCLAVO/MAESTRO y "aplicar rol" NO lo cambia', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    // 1er clic → ESCLAVO.
    h.click('btn-rtc-mode');
    assert.strictEqual(h.read('rtcMode'), 'SLAVE');
    assert.ok(h.el('btn-rtc-mode').textContent.includes('ESCLAVO'));
    assert.ok(h.el('rtc-mode-state').textContent.includes('ESCLAVO'));
    assert.ok(h.el('rtc-mode-state').textContent.includes('EMITE') || h.el('rtc-mode-state').textContent.includes('CREAR OFERTA'));
    // 2º clic → MAESTRO.
    h.click('btn-rtc-mode');
    assert.strictEqual(h.read('rtcMode'), 'MASTER');
    assert.ok(h.el('btn-rtc-mode').textContent.includes('MAESTRO'));
    assert.ok(h.el('rtc-mode-state').textContent.includes('MAESTRO'));
    assert.ok(h.el('rtc-mode-state').textContent.toLowerCase().includes('recibe'));
    // El conmutador del panel ROL se sincroniza.
    assert.ok(h.el('btn-rtc-role').textContent.includes('MAESTRO'));
    // Volver a ESCLAVO.
    h.click('btn-rtc-mode');
    assert.strictEqual(h.read('rtcMode'), 'SLAVE');
    // Aplicar rol NO debe tocar el modo de enlace.
    h.read('applyRole()');
    assert.strictEqual(h.read('rtcMode'), 'SLAVE', 'aplicar rol no altera el modo de enlace');
    assert.ok(h.el('rtc-mode-state').textContent.includes('ESCLAVO'));
    // El log refleja el rol aplicado con el modo.
    assert.ok(logText(h, 'rf-log-output').includes('Rol local aplicado'));
    assert.ok(logText(h, 'rf-log-output').includes('ESCLAVO'));
});

test('Dispositivos enlazables por separado: el gestor expone 5 sensores independientes', async () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    const m = h.read('initDeviceLinks()');
    assert.ok(m, 'gestor creado');
    assert.ok(h.read('window.deviceLinks') === m, 'expuesto en window');
    const ids = h.read('deviceLinks.list()').map((d) => d.id).sort();
    assert.deepEqual(ids, ['ATMOSPHERE', 'BLE', 'FIELD', 'RADIO', 'THERMAL'], 'cinco dispositivos independientes registrados');
    // Estado inicial honesto: todos 'down', cada uno con su propio acceso.
    ['RADIO', 'BLE', 'ATMOSPHERE', 'FIELD', 'THERMAL'].forEach((id) => {
        assert.equal(h.read(`deviceLinks.status('${id}').state`), 'down', id + ' arranca desconectado');
    });
    // Conectar uno no afecta el estado de los demás (independencia de aislado real).
    // Sin hardware en el arnés, RADIO falla honesto (error) pero SOLO él cambia.
    await h.read('deviceLinks.connect("RADIO")');
    assert.equal(h.read(`deviceLinks.status('RADIO').state`), 'error', 'RADIO intentó abrir hardware real (no disponible)');
    assert.equal(h.read(`deviceLinks.status('BLE').state`), 'down', 'BLE sigue down tras RADIO');
    assert.equal(h.read(`deviceLinks.status('THERMAL').state`), 'down', 'THERMAL sigue down tras RADIO');
    assert.equal(h.read(`deviceLinks.status('FIELD').state`), 'down', 'FIELD sigue down tras RADIO');
    assert.equal(h.read(`deviceLinks.status('BLE').state`), 'down', 'BLE sigue down tras RADIO');
    assert.equal(h.read(`deviceLinks.status('THERMAL').state`), 'down', 'THERMAL sigue down tras RADIO');
});

test('Maestro: el esclavo que llega por WebRTC se materializa como nodo remoto en los gráficos', () => {
    const h = boot();
    h.click('btn-trigger-disaster');
    assert.strictEqual(h.read('engine.remoteNodes.size'), 0, 'sin remotos antes');
    // El maestro recibe una línea UWB del esclavo → materializa el dispositivo.
    h.read('materializeFieldRemote("UWB 4.2")');
    h.read('materializeFieldRemote("ORI 90 -20 0")');
    assert.strictEqual(h.read('engine.remoteNodes.size'), 1, 'esclavo materializado como nodo');
    // Aparece en la lista de nodos de la malla (radar) y en displayNodes (gráficos).
    const nodes = h.read('displayNodes()');
    const found = nodes.find((n) => n.label === 'NODO-CAMPO');
    assert.ok(found, 'nodo campo presente en displayNodes (gráficos)');
    assert.strictEqual(found.role, 'SCOUT');
    const raw = h.read('engine.remoteNodes.get(rtcRemoteId)');
    assert.strictEqual(raw.uwbDistance, 4.2, 'guarda la lectura UWB real del esclavo');
    h.flushTimers();
    assert.ok(h.el('radar-victim-list').innerHTML.includes('NODO-CAMPO'), 'nodo campo en el radar');
    // Al cerrar el enlace se poda (honesto, sin nodo fantasma).
    h.read('pruneFieldRemote()');
    assert.strictEqual(h.read('engine.remoteNodes.size'), 0, 'se retira al cerrar');
});
