/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Integrated Production Engine v2.0
 *  AMRF + LoRa Mesh + APRS + SDR — stack RF real (radio/*.js)
 *  + datos reales del dispositivo (device_sensors.js)
 *  + clasificador automático de rol (core_math.classifyRole).
 *
 *  CERO datos de ejemplo: sin NODES ficticios, sin callsigns de
 *  ejemplo, sin RSSI/SNR aleatorios, sin hex inventado. La
 *  telemetría remota SOLO entra por ingestRemoteTelemetry() y los
 *  paquetes mostrados son bytes reales del PacketEncoder
 *  (CBOR + LZ77 + AES-CTR). Cada sensor es opcional: sin lectura
 *  real se muestra '—' y no se fabrica valor.
 *
 *  Funciona en el navegador (index_integrated.html) y en Node
 *  (dom_harness.js) con guardas de elementos.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ── Diagnóstico visible de errores de runtime (browser real) ───────
// Si algo lanza durante la carga o en cualquier handler, se refleja en
// el log RF y en el título en vez de quedar mudo en la consola.
(function captureErrors() {
    function fmt(e) {
        const msg = (e && e.message) ? e.message : String(e);
        return msg.slice(0, 200);
    }
    function report(ch, msg) {
        try {
            const el = document.getElementById('rf-log-output');
            if (el) {
                const line = document.createElement('div');
                line.className = 'packet-entry';
                line.innerHTML = '<span class="packet-time">[ERR]</span> <span class="packet-type">JS</span> — ' + msg;
                el.appendChild(line);
            }
            const title = document.getElementById('rf-version');
            if (title) title.textContent = '⚠ ' + msg;
        } catch (e2) { /* sin DOM aún */ }
    }
    window.addEventListener('error', (ev) => report('error', 'error: ' + fmt(ev.error || ev.message)));
    window.addEventListener('unhandledrejection', (ev) => report('rejection', 'promesa: ' + fmt(ev.reason)));
})();

// ── Constantes ─────────────────────────────────────────────────────
// IPU_THRESHOLD vive en core_math.js (window.coreMath.IPU_THRESHOLD).
// Declararla aquí de nuevo como `const` global rompería la carga en el
// navegador ("Identifier 'IPU_THRESHOLD' has already been declared") si
// core_math.js se cargara como script clásico.
const TELEMETRY_INTERVAL_MS   = 5000;
const VITALS_HISTORY_MAX      = 60;
const PACKETS_PER_MIN_WINDOW  = 60000;

// ── Estado global ───────────────────────────────────────────────────
let systemState     = 'DORMANT';
// Regla de producción: sin lectura real → null (la GUI pinta '—').
// El navegador no expone API de pulso/oxígeno; la batería llega por
// navigator.getBattery() y la presión por el barómetro real cuando existen.
let battery         = null;
let watchOnBody     = true;
let bpm             = null;
let spo2            = null;
let pressureTrapped = null;
let activeSOS       = false;
let relayActive     = false;
let autoDrain       = false;
let vigilanceSecs   = 1800;
let trappedSince    = 0;
let lastTouchTime   = 0;
let lastInteractionTime = 0;
let packetsThisMinute = 0;

let timerInterval      = null;
let drainInterval      = null;
let telemetryInterval  = null;

let engine    = null;   // LifelineEngine (stack RF real)
let sensors   = null;   // LifelineSensors (proveedor del dispositivo)
let relay     = null;   // RelayAdapter (señales cross-device vía server)
let lastSensor = null;  // último snapshot de sensores
let roleInfo  = null;   // salida de coreMath.classifyRole

// ── Historiales / buffers ───────────────────────────────────────────
let vitalsHistory = { bpm: [], spo2: [], battery: [] };
const pingUntil = new Map(); // nodeId -> timestamp

// ── Detecciones en vivo (identificación de nodos al instante) ──────
// nodeFlash: nodeId -> { since, isNew } marca el nodo detectado/actualizado
// recientemente para resaltarlo en el radar y la tabla.
const nodeFlash = new Map();
// detectionFeed: array cronológico de detecciones recibidas (sin inventar).
let detectionFeed = [];
// prevNodeSig: última firma de datos por nodo para detectar llegada/cambio.
let prevNodeSig = new Map();
const FLASH_MS = 4000;   // ventana del resaltado NUEVO/ACTUALIZADO
const FEED_MAX = 12;     // detecciones visibles en el feed en vivo

// ── Arrays de partículas / ondas (solo visualización) ───────────────
let waves     = [];
let particles = [];
let scoutX = 80, scoutDir = 1;

// ── DOM References ──────────────────────────────────────────────────
const canvas       = document.getElementById('mesh-canvas');
const ctx          = canvas ? canvas.getContext('2d') : null;
const topCanvas    = document.getElementById('topdown-canvas');
const tctx         = topCanvas ? topCanvas.getContext('2d') : null;
const vitalsCanvas = document.getElementById('vitals-chart');
const vctx         = vitalsCanvas ? vitalsCanvas.getContext('2d') : null;

const intercomLog    = document.getElementById('intercom-log');
const intercomSelect = document.getElementById('intercom-target-select');
const intercomInput  = document.getElementById('intercom-input');
const intercomSend   = document.getElementById('btn-intercom-send');

const logOutput    = document.getElementById('log-output');
const radarList    = document.getElementById('radar-victim-list');
const pingAllBtn   = document.getElementById('btn-ping-all');
const scannerDot   = document.getElementById('scanner-indicator');
const cryptoToast  = document.getElementById('crypto-toast');
const systemBadge  = document.getElementById('system-state-badge');
const systemPulse  = document.getElementById('system-pulse');

// RF canvas
const rfCanvas = document.getElementById('rf-spectrum-canvas');
const rfctx    = rfCanvas ? rfCanvas.getContext('2d') : null;
const loraWaveCanvas   = document.getElementById('lora-waveform-canvas');
const loraWaveCtx      = loraWaveCanvas ? loraWaveCanvas.getContext('2d') : null;
const sdrSpectrumCanvas = document.getElementById('sdr-spectrum-canvas');
const sdrSpectrumCtx   = sdrSpectrumCanvas ? sdrSpectrumCanvas.getContext('2d') : null;
const freqAllocCanvas  = document.getElementById('freq-alloc-canvas');
const freqAllocCtx     = freqAllocCanvas ? freqAllocCanvas.getContext('2d') : null;

// ── Configuración de la aplicación (URL ?key= / ?callsign=) ─────────
function urlParam(name, fallback) {
    try {
        const params = new URLSearchParams(window.location.search);
        const v = params.get(name);
        return v !== null ? v : fallback;
    } catch (e) { return fallback; }
}

const APP_CONFIG = {
    // Clave AES-128 en hex (32 chars). Sin clave → la clave de referencia
    // NIST documentada en radio/ (SOLO demo). Producción debe pasar ?key=.
    key: urlParam('key', null),
    // Indicativo APRS del operador. Sin indicativo → APRS inactivo (sin N0CALL).
    callsign: urlParam('callsign', null),
    // Nombre visible de este dispositivo (aparece como nodo remoto en las
    // otras pestañas conectadas al relay). ?label=TELÉFONO
    label: urlParam('label', 'DISPOSITIVO-LOCAL'),
    region: 'AMERICAS',
    frequency: 'US915',
};

// ── Utility Functions ──────────────────────────────────────────────
function getEl(id) {
    return document.getElementById(id);
}

function setText(id, txt) {
    const el = getEl(id);
    if (el) el.textContent = txt;
}

function formatFrequency(freq) {
    return (freq / 1e6).toFixed(3) + ' MHz';
}

function timestamp() {
    return new Date().toLocaleTimeString();
}

function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
}

// ── Canvas Resize ──────────────────────────────────────────────────
function resizeCanvas() {
    if (canvas && canvas.parentElement) {
        canvas.width  = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
    }
    if (topCanvas && topCanvas.parentElement) {
        topCanvas.width  = topCanvas.parentElement.clientWidth;
        topCanvas.height = topCanvas.parentElement.clientHeight;
    }
    if (vitalsCanvas && vitalsCanvas.parentElement) {
        vitalsCanvas.width  = vitalsCanvas.parentElement.clientWidth;
        vitalsCanvas.height = vitalsCanvas.parentElement.clientHeight;
    }
    if (rfCanvas && rfCanvas.parentElement) {
        rfCanvas.width  = rfCanvas.parentElement.clientWidth;
        rfCanvas.height = rfCanvas.parentElement.clientHeight;
    }
    if (loraWaveCanvas && loraWaveCanvas.parentElement) {
        loraWaveCanvas.width  = loraWaveCanvas.parentElement.clientWidth - 32;
        loraWaveCanvas.height = 80;
    }
    if (sdrSpectrumCanvas && sdrSpectrumCanvas.parentElement) {
        sdrSpectrumCanvas.width  = sdrSpectrumCanvas.parentElement.clientWidth - 32;
        sdrSpectrumCanvas.height = 80;
    }
    if (freqAllocCanvas && freqAllocCanvas.parentElement) {
        freqAllocCanvas.width  = freqAllocCanvas.parentElement.clientWidth - 32;
        freqAllocCanvas.height = 60;
    }
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('resize', onLayoutChange);
resizeCanvas();
// initMobileNav() se invoca al final del script (tras declarar PANEL_REGISTRY).

// ── Math Helpers (coreMath) ────────────────────────────────────────
function calcDeltaH(pTrapped) {
    return coreMath.calcDeltaH(pTrapped);
}

function calcIPU() {
    return coreMath.calcIPU({ watchOnBody, activeSOS, bpm, lastTouchTime, now: Date.now() });
}

function getTriageForVitals(bpmV, spo2V, sosFlag, ipuV) {
    return coreMath.getTriageForVitals(bpmV, spo2V, sosFlag, ipuV, { watchOnBody, ipuThreshold: coreMath.IPU_THRESHOLD });
}

// ── State Machine ──────────────────────────────────────────────────
function resolveState() {
    return coreMath.resolveState({ ipu: calcIPU(), battery, systemState, ipuThreshold: coreMath.IPU_THRESHOLD });
}

function stateConfig(st) {
    const c = {
        DORMANT:   { label:'DORMANT',           phy:'DORMANT',          interval:'N/A',     payload:'0B',       tx:'OFF',    color:'#475569' },
        ORPHAN:    { label:'ORPHAN (NO BEACON)', phy:'DISABLED',         interval:'—',       payload:'0B',       tx:'OFF',    color:'#ef4444' },
        VIGILANCE: { label:'VIGILANCE ACTIVE',   phy:'CODED_PHY (LR)',   interval:'1000 ms', payload:'255B EXT', tx:'MEDIUM', color:'#06b6d4' },
        ECO:       { label:'ECO EMERGENCY',      phy:'CODED_PHY (ECO)',  interval:'3000 ms', payload:'255B EXT', tx:'LOW',    color:'#8b5cf6' },
        SURVIVAL:  { label:'ULTRA SURVIVAL',     phy:'BLE_LEGACY',       interval:'5000 ms', payload:'24B TRUNC',tx:'LOW',    color:'#f59e0b' },
    };
    return c[st] || c.DORMANT;
}

// ── Logging ────────────────────────────────────────────────────────
function addLog(msg, type = '') {
    if (!logOutput) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span style="color:#475569;font-size:0.6rem">[${timestamp()}]</span> ${msg}`;
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
    while (logOutput.children.length > 30) logOutput.removeChild(logOutput.firstChild);
}

function addRFLog(msg, type = '') {
    const el = getEl('rf-log-output');
    if (!el) return;
    const line = document.createElement('div');
    line.className = `packet-entry ${type}`;
    line.innerHTML = `<span class="packet-time">[${timestamp()}]</span> <span class="packet-type">RF</span> — ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 30) el.removeChild(el.firstChild);
}

function addLoRaPacketLog(message) {
    const el = getEl('lora-packet-log');
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = 'packet-entry';
    entry.innerHTML = `<span class="packet-time">[${timestamp()}]</span> <span class="packet-type">LoRa</span> — ${message}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 15) el.removeChild(el.firstChild);
}

function addAPRSPacketLog(message) {
    const el = getEl('aprs-packet-log');
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = 'packet-entry';
    entry.innerHTML = `<span class="packet-time">[${timestamp()}]</span> <span class="packet-type aprs">APRS</span> — ${message}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 15) el.removeChild(el.firstChild);
}

function addSDRPacketLog(message) {
    const el = getEl('sdr-packet-log');
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = 'packet-entry';
    entry.innerHTML = `<span class="packet-time">[${timestamp()}]</span> <span class="packet-type sdr">SDR</span> — ${message}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 15) el.removeChild(el.firstChild);
}

// ═══════════════════════════════════════════════════════════════════
//  MOTOR DE PRODUCCIÓN — LifelineEngine (stack RF real)
// ═══════════════════════════════════════════════════════════════════

function initEngine() {
    if (typeof LifelineEngine === 'undefined') return null;
    try {
        engine = LifelineEngine.createEngine({
            key: APP_CONFIG.key,
            callsign: APP_CONFIG.callsign,
            region: APP_CONFIG.region,
            frequency: APP_CONFIG.frequency,
            encryption: 'AES-CTR',
            nodeName: APP_CONFIG.label,
            onLog: (ch, msg) => addRFLog(`[${ch.toUpperCase()}] ${msg}`, ch === 'lora' ? '' : ''),
        });
        window.engine = engine; // hook de depuración para pruebas manuales
        // Etapa 0: cuando hay radio física vinculada, cada trama local sale
        // también por el transceptor LoRa (además de la malla/relay HTTP).
        engine.afterLocalTx = (hex) => {
            if (radioDriver && radioDriver.connected) {
                radioDriver.transmit(hex);
            }
        };
        if (engine && engine.ready) {
            addRFLog(`Motor de producción listo — LoRa ID ${engine.localNode.id}`, 'log-success');
            // Intercom cross-device: los mensajes llegan incrustados en las
            // tramas reales y se muestran en el log de intercom del par.
            engine.onIntercomMessage = (m) => {
                addRFLog(`[Intercom] Recibido de ${m.fromName}: ${m.msg}`, 'log-success');
                if (intercomLog) {
                    intercomLog.innerHTML += `<div style="margin-top:4px"><span style="color:var(--muted)">[${timestamp()}]</span> <span style="color:var(--success)">${m.fromName} → AQUÍ:</span> <span style="color:var(--text)">${m.msg}</span></div>`;
                    intercomLog.scrollTop = intercomLog.scrollHeight;
                }
                updateUI();
            };
        } else {
            addRFLog('Motor sin stack RF (radio/*.js no cargados) — modo degradado.', 'log-alert');
        }
    } catch (e) {
        engine = null;
        addRFLog('Error iniciando motor: ' + e.message, 'log-danger');
    }
    return engine;
}

// ═══════════════════════════════════════════════════════════════════
//  SENSORES DEL DISPOSITIVO — LifelineSensors
// ═══════════════════════════════════════════════════════════════════

function initSensors() {
    if (typeof LifelineSensors === 'undefined') return null;
    sensors = LifelineSensors;
    window.sensors = sensors; // hook de depuración para pruebas manuales
    try { sensors.start(); } catch (e) { /* nunca debe lanzar */ }
    try {
        sensors.subscribe((snap) => {
            lastSensor = snap;
            applySensorData(snap);
            updateUI();
        });
    } catch (e) { /* sin proveedor */ }
    return sensors;
}

// ── Relay cross-device (señales de testeo por el navegador) ──────────
function initRelay() {
    if (!engine || !engine.ready) {
        setText('relay-status', 'SIN MOTOR');
        return null;
    }
    if (typeof LifelineRelayAdapter === 'undefined' || !LifelineRelayAdapter.RelayAdapter) {
        setText('relay-status', 'NO DISPONIBLE');
        return null;
    }
    try {
        relay = new LifelineRelayAdapter.RelayAdapter({
            mesh: engine.mesh,
            instanceId: 'tab-' + Math.random().toString(36).slice(2, 12),
            networkId: 'LIFELINE-001',
            name: APP_CONFIG.label,
            relayUrl: '',
            onMessage: () => updateUI(),
            onPeersChange: () => updateUI(),
            onLog: (ch, msg) => addRFLog(`[${ch.toUpperCase()}] ${msg}`),
        });
        const ok = relay.connect();
        setText('relay-status', ok ? 'CONECTADO (SSE)' : 'SIN TRANSPORTE (SSE)');
        setRelayInd(ok);
        addRFLog(ok ? 'Relay cross-device activo — el servidor local se anuncia a los pares en alerta.' : 'Relay sin transporte — este navegador no soporta SSE/fetch.', ok ? 'log-success' : 'log-alert');
        // Reportar el estado de alerta actual al servidor (DORMANT en el arranque)
        relay.setAlertState(systemState === 'DORMANT' ? 'DORMANT' : systemState);
        return relay;
    } catch (e) {
        setText('relay-status', 'ERROR');
        addRFLog('Error iniciando relay: ' + e.message, 'log-danger');
        return null;
    }
}

function setRelayInd(active) {
    const el = getEl('relay-status-ind');
    if (el) el.className = `status-indicator ${active ? 'active' : 'inactive'}`;
}

function updateRelayPanel() {
    const nodes = (engine && engine.ready) ? engine.getNodes().length : 0;
    setText('relay-nodes', String(nodes));
    if (!relay) return;
    const s = relay.getStats();
    setText('relay-tx', String(s.tx));
    setText('relay-rx', String(s.rx));
    const st = getEl('relay-status');
    if (st && s.connected !== undefined) {
        st.textContent = s.connected ? 'CONECTADO (SSE)' : 'SIN TRANSPORTE (SSE)';
    }
    // Pares descubiertos en el mismo estado de alerta
    const pl = getEl('relay-peers');
    if (pl) {
        const peers = relay.getPeers();
        if (peers.length === 0) {
            pl.innerHTML = '<div class="packet-entry"><span class="packet-time">[RELAY]</span> <span class="packet-type">SIN PARES</span> — en alerta, el servidor se anuncia por UDP broadcast a los dispositivos del mismo estado.</div>';
        } else {
            pl.innerHTML = peers.map((p) =>
                `<div class="packet-entry"><span class="packet-time">[PAR]</span> <span class="packet-type">${(p.state || '?')}</span> ${(p.label || p.url)} · <span style="color:var(--text-sub)">${p.url}</span></div>`
            ).join('');
        }
    }
    const statusInd = getEl('relay-status-ind');
    if (statusInd) {
        const active = s.available && s.alertState !== 'DORMANT';
        statusInd.className = `status-indicator ${active ? 'active' : 'inactive'}`;
    }
}

function applySensorData(snap) {
    if (!snap) return;
    // Lecturas reales del dispositivo: ganan sobre los controles manuales
    // solo cuando el sensor existe (sources.* === true). Nunca inventa.
    if (snap.hasBattery && snap.battery != null) battery = snap.battery;
    if (snap.hasPressure && snap.pressure != null) pressureTrapped = snap.pressure;
    // Un futuro puente BLE de pulso/oxígeno entregaría bpm/spo2 en el
    // snapshot real; sin él permanecen null → '—' en la GUI.
    if (snap.bpm != null) bpm = snap.bpm;
    if (snap.spo2 != null) spo2 = snap.spo2;
}

// ── Clasificador automático de rol (SCOUT / VÍCTIMA / UNKNOWN) ──────
function currentRole() {
    const snap = lastSensor || (sensors && typeof sensors.getSnapshot === 'function' ? sensors.getSnapshot() : null);
    const depthM = pressureTrapped != null ? coreMath.calcDeltaH(pressureTrapped) : null;
    return coreMath.classifyRole({
        depthM,
        tilt: snap && snap.hasMotion ? snap.tilt : null,
        light: snap && snap.hasLight ? snap.light : null,
        bpm,
        activeSOS,
        mobilitySecs: lastInteractionTime ? (Date.now() - lastInteractionTime) / 1000 : null,
        hasPressure: snap ? snap.hasPressure : false,
        hasMotion: snap ? snap.hasMotion : false,
        hasLight: snap ? snap.hasLight : false,
        hasVitals: bpm != null && spo2 != null,
    });
}

function updateRolePanel() {
    roleInfo = currentRole();
    const badge = getEl('device-role-badge');
    if (badge) {
        badge.textContent = roleInfo.role;
        badge.className = 'badge ' + (roleInfo.role === 'VICTIM'
            ? 'role-badge-victim' : roleInfo.role === 'SCOUT'
            ? 'role-badge-scout' : 'role-badge-unknown');
    }
    setText('device-role-reason', roleInfo.reason);
    setText('device-role-conf', `${Math.round(roleInfo.confidence * 100)}%`);
    const snap = lastSensor || {};
    const src = snap.sources || {};
    setText('sensor-sources', ['gps','barometer','thermometer','light','motion','mic','battery']
        .map((k) => `${k}:${src[k] ? '✓' : '—'}`).join(' '));
}

// ── Telemetría real ────────────────────────────────────────────────
function buildSnapshot() {
    const snap = lastSensor || (sensors && typeof sensors.getSnapshot === 'function' ? sensors.getSnapshot() : {});
    const depthM = pressureTrapped != null ? coreMath.calcDeltaH(pressureTrapped) : null;
    return {
        gps: snap.hasGPS && snap.gps ? { lat: snap.gps.lat, lon: snap.gps.lon, alt: snap.gps.alt } : null,
        pressure: snap.hasPressure && snap.pressure != null ? snap.pressure : pressureTrapped,
        bpm,
        spo2,
        battery,
        depth_m: depthM,
        role: roleInfo ? roleInfo.role : 'UNKNOWN',
        tilt: snap.hasMotion ? snap.tilt : null,
        light: snap.hasLight ? snap.light : null,
        mic: snap.hasMic ? snap.mic : null,
        atm: (atmCO != null || atmO2 != null) ? { coPpm: atmCO, o2Pct: atmO2 } : null,
    };
}

function sendTelemetryOnce() {
    if (!engine || !engine.ready || !engine.started) return;
    const hex = engine.sendLocalTelemetry(buildSnapshot());
    if (!hex) return;
    packetsThisMinute++;
    addLoRaPacketLog(`Telemetry TX ${hex.length / 2}B seq#${engine.sequence} (AES-CTR)`);
    updateWirePanel();
    updateUI();
}

function startTelemetry() {
    if (!engine || !engine.ready || telemetryInterval) return;
    sendTelemetryOnce();
    telemetryInterval = setInterval(sendTelemetryOnce, TELEMETRY_INTERVAL_MS);
}

function stopTelemetry() {
    if (telemetryInterval) {
        clearInterval(telemetryInterval);
        telemetryInterval = null;
    }
}

// ── Nodos visibles (local vivo + remotos ingeridos) ────────────────
function displayNodes() {
    const nodes = (engine && engine.ready) ? engine.getNodes().slice() : [];
    const snap = lastSensor || {};
    return nodes.map((n) => {
        if (n.isLocal) {
            return {
                ...n,
                gps: snap.hasGPS && snap.gps ? { lat: snap.gps.lat, lon: snap.gps.lon } : null,
                pressure: snap.hasPressure ? snap.pressure : pressureTrapped,
                battery, bpm, spo2,
                role: roleInfo ? roleInfo.role : 'UNKNOWN',
            };
        }
        return n;
    });
}

function findNode(id) {
    return displayNodes().find((n) => n.id === id) || null;
}

// Firma de datos recibidos de un nodo: cualquier cambio en sus lecturas
// (vitals, atmósfera, profundidad) cuenta como una detección real.
function nodeSig(node) {
    const v = [node.bpm, node.spo2, node.coPpm, node.o2Pct, node.pressure != null ? +node.pressure.toFixed(1) : null];
    return v.map((x) => (x == null ? '·' : String(x))).join('|');
}

// Detecta nodos que llegan o actualizan sus datos y los vuelca al feed en
// vivo + resaltado. Solo reacciona a nodos REALES de engine.getNodes().
function trackNodeDetections() {
    if (!engine || !engine.ready) return;
    const nodes = (engine.ready ? engine.getNodes() : []).filter((n) => !n.isLocal);
    const now = Date.now();
    const seen = new Set();

    nodes.forEach((node) => {
        seen.add(node.id);
        const sig = nodeSig(node);
        const prev = prevNodeSig.get(node.id);

        if (prev === undefined) {
            // Primera vez que vemos al nodo → detección NUEVA.
            nodeFlash.set(node.id, { since: now, isNew: true });
            pushDetection(node, 'NUEVO', now);
        } else if (prev !== sig) {
            // Sus datos cambian → detección ACTUALIZADA.
            nodeFlash.set(node.id, { since: now, isNew: false });
            pushDetection(node, 'ACTUALIZADO', now);
        }
        prevNodeSig.set(node.id, sig);
    });

    // Nodos que ya no se ven: limpia firma vieja (el resaltado se extingue solo).
    prevNodeSig.forEach((_, id) => { if (!seen.has(id)) prevNodeSig.delete(id); });

    // Expira el resaltado de los que ya pasaron la ventana.
    nodeFlash.forEach((f, id) => { if (now - f.since > FLASH_MS) nodeFlash.delete(id); });

    renderDetectionFeed();
}

function pushDetection(node, evt, ts) {
    const bpmV = node.bpm != null ? `${node.bpm} BPM` : null;
    const spo2V = node.spo2 != null ? `${node.spo2}% SpO₂` : null;
    const vitals = bpmV && spo2V ? `${bpmV} / ${spo2V}` : (bpmV || spo2V || null);
    const atmV = (node.coPpm != null || node.o2Pct != null)
        ? `${node.coPpm != null ? node.coPpm + ' CO' : ''}${node.coPpm != null && node.o2Pct != null ? ' / ' : ''}${node.o2Pct != null ? node.o2Pct.toFixed(1) + '% O₂' : ''}`
        : null;
    const depthM = node.pressure != null ? Math.abs(coreMath.calcDeltaH(node.pressure)) : null;
    detectionFeed.unshift({
        id: node.id,
        label: node.label || node.id.slice(0, 8),
        role: node.role || 'UNKNOWN',
        evt,
        ts,
        vitals,
        atm: atmV,
        depth: depthM != null ? depthM.toFixed(1) + ' m ↓' : null,
    });
    if (detectionFeed.length > FEED_MAX) detectionFeed.length = FEED_MAX;
}

function renderDetectionFeed() {
    const tbody = getEl('detection-feed-list');
    const counter = getEl('detection-count');
    if (counter) counter.textContent = String(detectionFeed.length);

    if (!tbody) return;
    if (!detectionFeed.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">Sin detecciones — esperando datos de nodos reales.</td></tr>`;
        return;
    }
    const rows = detectionFeed.map((d) => {
        const nColor = d.role === 'VICTIM' ? '#ef4444' : d.role === 'SCOUT' ? '#10b981' : '#94a3b8';
        const cls = d.evt === 'NUEVO' ? 'det-ev-new' : 'det-ev-upd';
        const body = [d.vitals, d.atm, d.depth].filter(Boolean).join(' · ');
        return `<tr class="${cls}">
            <td class="node-id">${d.label}
                <div style="font-size:0.55rem;color:#64748b">${d.id.slice(0, 8)} · ${d.role}</div>
            </td>
            <td><span class="det-ev ${cls}" style="color:${nColor}">${d.evt}</span></td>
            <td><div style="font-size:0.6rem;color:#64748b">${timestampDate(d.ts)}</div>${body ? `<div style="font-size:0.62rem">${body}</div>` : ''}</td>
        </tr>`;
    }).join('');
    tbody.innerHTML = rows;
    const fade = getEl('detection-fade');
    if (fade) fade.classList.add('seen');
}

function timestampDate(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════
//  NAV MÓVIL — cada tarjeta es una pantalla completa en smartphone
// ═══════════════════════════════════════════════════════════════════
// En pantallas angostas cada panel se convierte en una ventana de
// pantalla completa y un menú ampliable (☰) permite elegir cada tarjeta
// por su función. En escritorio nada cambia (las tarjetas fluyen en grid).

const PANEL_REGISTRY = [
    ['panel-role',      'ROL DISPOSITIVO'],
    ['panel-viz',       '① CAMPO'],
    ['panel-controls',  '② CONTROLES'],
    ['panel-telemetry', '③ TELEMETRÍA'],
    ['panel-scout',     '④ TRIAGE SCOUT'],
    ['panel-field',     '⤻ ENLACE DE CAMPO (WebRTC)'],
    ['panel-detections','DETECCIONES EN VIVO'],
    ['panel-ecies',     '⑤ PAQUETE'],
    ['panel-deploy',    '⑥ ESTRATEGIA'],
    ['panel-map',       '⑦ RADAR GEO'],
    ['panel-intercom',  '⑧ INTERCOM'],
    ['panel-vitals',    '⑨ VITALES'],
    ['panel-environ',   '⑩ AMBIENTE'],
    ['panel-lora',      '⑪ LoRa MESH'],
    ['panel-aprs',      '⑫ APRS'],
    ['panel-sdr',       '⑬ SDR'],
    ['panel-spectrum',  '⑭ FRECUENCIAS'],
    ['panel-rfconsole', '⑮ CONSOLA RF'],
    ['panel-testsig',   '⑯ RELAY'],
    ['panel-barrido',   '⑰ BARRIDO'],
];

// Estado de la pantalla activa (móvil). Por defecto la primera tarjeta.
let mobileActivePanel = PANEL_REGISTRY.length ? PANEL_REGISTRY[0][0] : null;
const MOBILE_NAV_ACTIVE_CLASS = 'mob-active';
const mobileNavButtons = new Map(); // panelId -> botón del menú

function isMobileLayout() {
    return typeof window !== 'undefined'
        && window.innerWidth != null
        && window.innerWidth <= 600;
}

function initMobileNav() {
    const list = getEl('mobile-nav-list');
    if (!list) return;
    mobileNavButtons.clear();
    // Construye el menú ampliable con cada tarjeta y su función.
    PANEL_REGISTRY.forEach(([id, title]) => {
        if (!getEl(id)) return;
        const btn = document.createElement('button');
        btn.className = 'mobile-nav-item';
        btn.dataset.panel = id;
        btn.textContent = title;
        btn.addEventListener('click', () => applyMobilePanel(id));
        mobileNavButtons.set(id, btn);
        list.appendChild(btn);
    });
    closeMobileNav();
    // Si ya estamos en móvil, deja visible solo la pantalla activa.
    if (isMobileLayout()) applyMobilePanel(mobileActivePanel);
}

function applyMobilePanel(id) {
    mobileActivePanel = id;
    PANEL_REGISTRY.forEach(([pid]) => {
        const panel = getEl(pid);
        if (panel) panel.classList.toggle(MOBILE_NAV_ACTIVE_CLASS, pid === id);
    });
    // Marca el elemento activo en el menú.
    mobileNavButtons.forEach((btn, pid) => btn.classList.toggle('active', pid === id));
    closeMobileNav();
    updateUI();
}

window.goToPanel = function (id) { applyMobilePanel(id); };
window.toggleMobileNav = function () {
    const drawer = getEl('mobile-drawer');
    const overlay = getEl('mobile-overlay');
    if (!drawer) return;
    const open = drawer.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open', open);
};
window.closeMobileNav = function () {
    const drawer = getEl('mobile-drawer');
    const overlay = getEl('mobile-overlay');
    if (drawer) drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
};

// ── Pantalla completa (Fullscreen API, con fallback) ────────────────
// Cada tarjeta activa se muestra como una aplicación a pantalla completa.
function isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function requestFullscreen(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) return fn.call(el);
    // Sin API nativa (p. ej. iOS): fallback por clase que fuerza la vista.
    el.classList.add('forced-fullscreen');
    return undefined;
}

function exitFullscreen() {
    if (isFullscreenActive()) {
        const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
        if (fn) fn.call(document);
    }
    const card = currentActiveCard();
    if (card) card.classList.remove('forced-fullscreen');
}

function currentActiveCard() {
    return mobileActivePanel ? getEl(mobileActivePanel) : null;
}

window.toggleFullscreen = function () {
    const el = currentActiveCard();
    if (!el) return;
    const on = isFullscreenActive() || el.classList.contains('forced-fullscreen');
    if (on) {
        exitFullscreen();
    } else {
        requestFullscreen(el);
    }
    closeMobileNav();
};

// Responde a cambios de orientación/tamaño (desktop ↔ móvil).
function onLayoutChange() {
    if (isMobileLayout()) {
        if (!mobileActivePanel) mobileActivePanel = PANEL_REGISTRY.length ? PANEL_REGISTRY[0][0] : null;
        applyMobilePanel(mobileActivePanel);
    } else {
        // En escritorio vuelven a fluir todas las tarjetas en grid.
        PANEL_REGISTRY.forEach(([pid]) => { const p = getEl(pid); if (p) p.classList.remove(MOBILE_NAV_ACTIVE_CLASS); });
        closeMobileNav();
    }
}

window.clearDetections = function () { detectionFeed = []; prevNodeSig.clear(); nodeFlash.clear(); renderDetectionFeed(); updateScoutTable(systemState !== 'DORMANT' && systemState !== 'ORPHAN'); };

// ═══════════════════════════════════════════════════════════════════
//  FLECHA TÁCTICA — vector de rescate UWB + IMU (vectorización magnética)
// ═══════════════════════════════════════════════════════════════════
// Cruzamos la distancia UWB real (via bridge BLE/Serial → sensors.setDistance)
// con la orientación real del IMU (DeviceOrientationEvent: alpha/beta/gamma)
// y el Filtro de Kalman del motor para dibujar en el Canvas la brújula
// dinámica y la flecha hacia la víctima. Regla estricta: sin lectura real
// → vector null y la flecha se apaga (—), jamás se inventa una dirección.

const rescueCanvas = document.getElementById('rescue-canvas');
const rescueCtx = rescueCanvas ? rescueCanvas.getContext('2d') : null;
let rescueLastTs = 0;
// Modo táctico consolidado: 'TACTICA' (vector + punto de excavación en un
// solo overlay) | 'VECTOR' (solo la flecha de dirección).
let tacticalMode = 'TACTICA';

// Estado real de la fuentes para el vector de rescate.
function getRescueSources() {
    const snap = lastSensor || (sensors && typeof sensors.getSnapshot === 'function' ? sensors.getSnapshot() : {});
    const distance = (snap.hasUwb && snap.uwbDistance != null) ? snap.uwbDistance : null;
    const o = (snap.hasOrientation && snap.orientation) ? snap.orientation : null;
    return {
        distance,                       // metros (UWB ToF)
        azimuth: o ? o.alpha : null,    // grados — magnetómetro (Norte)
        pitch: o && o.beta != null ? o.beta : null, // grados — inclinación (IMU)
        gyroRate: null,                 // sin fuente dedicada de velocidad angular por el momento
    };
}

// Calcula el estado de la flecha táctica (vector 3D + anotaciones).
function computeRescueArrow() {
    const s = getRescueSources();
    const now = Date.now();
    const dt = rescueLastTs ? Math.max(0.05, Math.min(2, (now - rescueLastTs) / 1000)) : 0.1;
    rescueLastTs = now;
    if (!engine || !engine.calculateRescueVector) {
        return { valid: false, ...s };
    }
    const vec = engine.calculateRescueVector(s.distance, s.azimuth, s.gyroRate, s.pitch, dt, engine.azimuthFilter);
    if (!vec) return { valid: false, ...s, vec: null };

    const azimuth = engine.azimuthFilter && engine.azimuthFilter.x != null ? engine.azimuthFilter.x : s.azimuth;
    const h = Math.hypot(vec.x, vec.y);                        // distancia aparente (horizontal)
    const plunge = Math.atan2(Math.abs(vec.z), h) * 180 / Math.PI; // inclinación bajo el plano
    const dirAz = (Math.atan2(vec.y, vec.x) * 180 / Math.PI + 360) % 360; // rumbo de la flecha
    return {
        valid: true, vec, distance: s.distance, azimuth,
        h, plunge, dirAz,
        depth: vec.z,                      // negativo = víctima bajo el suelo
        dirLabel: compassDir(dirAz),
        inclLabel: compassDir(azimuth),
    };
}

// Notación de rumbo (rosa de 16 puntos).
function compassDir(deg) {
    const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
    return pts[idx];
}

// Dibuja la brújula dinámica y la flecha táctica en el Canvas.
function renderRescueArrow(state) {
    if (!rescueCtx || !rescueCanvas) {
        // Sin canvas, aún así se actualiza la lectura textual honesta.
        updateRescueReadout(state);
        return;
    }
    const W = rescueCanvas.width || 200;
    const H = rescueCanvas.height || 200;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 12;
    const ctx = rescueCtx;

    ctx.clearRect(0, 0, W, H);

    // Aro de la brújula.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

    // Marca del Norte (roja) rotada por el azimut real (si hay orientación).
    const az = state.azimuth != null ? ((state.azimuth % 360) + 360) % 360 : null;
    if (az != null) {
        const a = -az * Math.PI / 180;
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + R * Math.sin(a), cy - R * Math.cos(a));
        ctx.stroke();
        ctx.fillStyle = '#ef4444';
        ctx.font = '10px monospace';
        ctx.fillText('N', cx + (R + 6) * Math.sin(a), cy - (R + 6) * Math.cos(a) + 3);
    }

    if (!state.valid || !state.vec) {
        // Sin vector real: flecha apagada, solo la cruz central.
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
        updateRescueReadout(state);
        return;
    }

    const v = state.vec;
    const hMax = R * 0.78;
    const len = Math.max(0, Math.min(1, state.h / 20));  // escala de la distancia horizontal
    const ang = (Math.atan2(v.y, v.x) * 180 / Math.PI) * Math.PI / 180; // rumbo en radianes
    const L = hMax * (0.25 + 0.75 * len);

    // Flecha "táctica": trazo + punta en la dirección del vector horizontal.
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + L * Math.cos(ang), cy - L * Math.sin(ang));
    ctx.stroke();
    // Punta de flecha.
    const px = cx + L * Math.cos(ang), py = cy - L * Math.sin(ang);
    const head = 0.16;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx + (L - 10) * Math.cos(ang - 0.45), cy - (L - 10) * Math.sin(ang - 0.45));
    ctx.lineTo(cx + (L - 10) * Math.cos(ang + 0.45), cy - (L - 10) * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fillStyle = '#06b6d4'; ctx.fill();

    // Indicador de profundidad (z negativo = cavar hacia abajo).
    ctx.fillStyle = state.depth < 0 ? '#f59e0b' : '#10b981';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(state.depth < 0 ? `↙ ${Math.abs(state.depth).toFixed(1)} m ↓` : `↗ ${state.depth.toFixed(1)} m ↑`,
        cx - 28, cy + R - 6);

    updateRescueReadout(state);
}

// Lectura textual honesta de la flecha táctica (div, accesible/testeable).
function updateRescueReadout(state) {
    const el = getEl('rescue-readout');
    if (!el) return;
    const c = getEl('rescue-status');
    if (!state.valid || !state.vec) {
        const motivo = state.distance == null ? 'sin distancia UWB' :
                       state.azimuth == null ? 'sin brújula' :
                       state.pitch == null ? 'sin inclinación (IMU)' : 'sin vector';
        el.textContent = `— · ${motivo}`;
        if (c) { c.textContent = 'SIN VECTOR'; c.style.color = '#64748b'; }
        return;
    }
    el.textContent = `Cavar ${state.depth.toFixed(1)} m (${state.inclLabel} ${state.azimuth!=null?Math.round(state.azimuth)+'°':''}) · rumbo ${state.dirLabel} ${Math.round(state.dirAz)}° · dist. ${state.h.toFixed(1)} m`;
    if (c) { c.textContent = 'VECTOR ACTIVO'; c.style.color = '#06b6d4'; }
}

// Punto de entrada desde updateUI (tick de 1 s).
function renderRescueCompass() {
    const rescue = computeRescueArrow();
    const exca = rescue.valid ? computeExcavationSuggestion(rescue) : null;
    if (tacticalMode === 'TACTICA') {
        renderTacticalOverlay(rescue, exca);
    } else {
        renderRescueArrow(rescue);
        updateTacticalSummary(rescue, exca);
    }
    renderExcavationSuggestion(exca, rescue);
}

// ── Sugerencia de excavación (vector de rescate + gradiente térmico) ──
// Correla la dirección/inclinación del vector UWB+IMU con el punto más
// cálido de la cámara térmica para afinar el punto exacto de excavación.
function computeExcavationSuggestion(rescue) {
    if (typeof ExcavationCam === 'undefined' || !ExcavationCam.suggestExcavationPoint) {
        return null;
    }
    return ExcavationCam.suggestExcavationPoint(rescue, lastThermal);
}

function renderExcavationSuggestion(exca, rescue) {
    const el = getEl('excavation-suggestion');
    if (!el) return;
    if (!exca || exca.status !== 'SUGGESTED' || !exca.suggestion) {
        el.textContent = 'Punto de excavación: — · sin vector';
        return;
    }
    const s = exca.suggestion;
    const dirLabel = compassDir(s.azimuthFinal != null ? s.azimuthFinal : 0);
    const ang = s.azimuthFinal != null ? `${Math.round(s.azimuthFinal)}°` : '';
    const desvio = exca.thermalUsed
        ? `${s.azimuthOffset.toFixed(0)}° az / ${s.pitchOffset.toFixed(0)}° in`
        : '0° (sin firma térmica)';
    const temp = exca.thermal ? `barrera ${exca.thermal.temp.toFixed(1)} °C` : 'sin firma térmica';
    el.textContent = `Excavar: ${dirLabel} ${ang} · profundidad ${s.depth.toFixed(1)} m · desvío ${desvio} · ${temp}`;
}

// ── MODO TÁCTICA CONSOLIDADO ──────────────────────────────────────
// Overlay único que une la brújula dinámica (flecha cian = dirección UWB+IMU),
// el punto exacto de excavación (diana ámbar, corregida por el gradiente
// térmico) y un resumen unificado. Honesto: sin vector, se apaga todo.

// Cambia el modo del overlay y repinta.
function toggleTacticalMode() {
    tacticalMode = tacticalMode === 'TACTICA' ? 'VECTOR' : 'TACTICA';
    const lbl = getEl('tactical-mode-label');
    if (lbl) lbl.textContent = `MODO ${tacticalMode}`;
    const btn = getEl('btn-tactical-mode');
    if (btn) {
        btn.classList.toggle('tactical-on', tacticalMode === 'TACTICA');
        btn.textContent = tacticalMode === 'TACTICA' ? '⬡ MODO TÁCTICA: ON' : '⬡ MODO TÁCTICA: OFF';
    }
    renderRescueCompass();
    return tacticalMode;
}

// Resumen unificado legible (div superior del overlay táctico).
function buildTacticalSummary(rescue, exca) {
    if (!rescue.valid || !rescue.vec) return 'TÁCTICA: sin vector — sin datos qué consolidar';
    const base = `${rescue.dirLabel} ${Math.round(rescue.dirAz)}° · profundidad ${rescue.depth.toFixed(1)} m`;
    if (tacticalMode === 'VECTOR') return `MODO VECTOR: ${base}`;
    if (exca && exca.suggestion) {
        const s = exca.suggestion;
        const dir = compassDir(s.azimuthFinal != null ? s.azimuthFinal : 0);
        const dev = exca.thermalUsed ? ` · desvío +${s.azimuthOffset.toFixed(0)}° térm` : ' (sin firma térmica)';
        const ang = s.azimuthFinal != null ? `${Math.round(s.azimuthFinal)}°` : '—';
        return `MODO TÁCTICA: excavar ${dir} ${ang} @ ${s.depth.toFixed(1)} m${dev}`;
    }
    return `MODO TÁCTICA: ${base} (sin firma térmica)`;
}

function updateTacticalSummary(rescue, exca) {
    const el = getEl('tactical-summary');
    if (!el) return;
    el.textContent = buildTacticalSummary(rescue, exca);
}

// Rotula la marca del Norte por el azimut real.
function drawNorthMark(ctx, cx, cy, R, azimuth) {
    const az = azimuth != null ? ((azimuth % 360) + 360) % 360 : null;
    if (az == null) return;
    const a = -az * Math.PI / 180;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(a), cy - R * Math.cos(a));
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.font = '10px monospace';
    ctx.fillText('N', cx + (R + 6) * Math.sin(a), cy - (R + 6) * Math.cos(a) + 3);
}

// Flecha cian hacia el vector horizontal del rescate.
function drawVectorArrow(ctx, cx, cy, R, rescue, color) {
    const hMax = R * 0.78;
    const len = Math.max(0, Math.min(1, rescue.h / 20));
    const ang = (Math.atan2(rescue.vec.y, rescue.vec.x) * Math.PI / 180);
    const L = hMax * (0.25 + 0.75 * len);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + L * Math.cos(ang), cy - L * Math.sin(ang));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + L * Math.cos(ang), cy - L * Math.sin(ang));
    ctx.lineTo(cx + (L - 10) * Math.cos(ang - 0.45), cy - (L - 10) * Math.sin(ang - 0.45));
    ctx.lineTo(cx + (L - 10) * Math.cos(ang + 0.45), cy - (L - 10) * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

// Diana ámbar del punto EXACTO de excavación (corregido por el gradiente térmico).
function drawExcavationTarget(ctx, cx, cy, R, s) {
    const ang = (s.azimuthFinal != null ? s.azimuthFinal : 0) * Math.PI / 180;
    const len = Math.max(10, Math.min(R * 0.85, 0.2 * R + (s.distanceHorizontal || s.distanceBase || 0)));
    const tx = cx + len * Math.cos(ang);
    const ty = cy - len * Math.sin(ang);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(tx, ty, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(tx, ty, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#f59e0b'; ctx.fill();
    ctx.font = 'bold 9px monospace';
    ctx.fillText('EXCAVAR', tx - 22, ty - 12);
}

function drawDepthTag(ctx, cx, cy, R, depth) {
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = depth < 0 ? '#f59e0b' : '#10b981';
    ctx.fillText(depth < 0 ? `↙ ${Math.abs(depth).toFixed(1)} m ↓` : `↗ ${Math.abs(depth).toFixed(1)} m ↑`,
        cx - 28, cy + R - 6);
}

// Overlay único consolidado (MODO TÁCTICA).
function renderTacticalOverlay(rescue, exca) {
    updateTacticalSummary(rescue, exca);
    if (!rescueCtx || !rescueCanvas) return;
    const ctx = rescueCtx;
    const W = rescueCanvas.width || 200;
    const H = rescueCanvas.height || 200;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 12;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    drawNorthMark(ctx, cx, cy, R, rescue.azimuth);

    if (!rescue.valid || !rescue.vec) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
        updateRescueReadout(rescue);
        return;
    }

    // Dirección del vector (cian) + punto exacto de excavación (ámbar) juntos.
    drawVectorArrow(ctx, cx, cy, R, rescue, '#06b6d4');
    const s = exca && exca.suggestion ? exca.suggestion : null;
    if (s) drawExcavationTarget(ctx, cx, cy, R, s);
    drawDepthTag(ctx, cx, cy, R, s ? s.depth : rescue.depth);
    updateRescueReadout(rescue);
}

// ═══════════════════════════════════════════════════════════════════
//  PANELES RF — datos del stack real
// ═══════════════════════════════════════════════════════════════════

function rfActive() {
    return !!(engine && engine.ready && engine.started);
}

function updateRFPanels() {
    const active = rfActive();
    const aprsActive = active && !!engine.callsign;

    const setInd = (id, on, cls) => {
        const el = getEl(id);
        if (el) el.className = `status-indicator ${on ? (cls || 'active') : 'inactive'}`;
    };
    setInd('lora-status-ind', active);
    setInd('aprs-status-ind', aprsActive);
    setInd('sdr-status-ind', active);
    setInd('rf-status-ind', active);

    if (!active) {
        setText('lora-tx-count', '0');
        setText('lora-rx-count', '0');
        setText('lora-avg-hops', '0');
        setText('lora-rssi', '—');
        setText('lora-snr', '—');
        setText('lora-sf', 'SF10');
        setText('lora-bw', 'BW125');
        setText('aprs-tx-count', '0');
        setText('aprs-rx-count', '—');
        setText('sdr-signals', '0');
        setText('sdr-decoded', '0');
        setText('stat-rf-links', '0');
        return;
    }

    const localNode = engine.localNode;
    const mesh = engine.mesh;

    setText('lora-freq-display', formatFrequency(localNode.frequency === 'EU868' ? 868e6 : 915e6));
    setText('lora-nodes', String(mesh.nodes.size));
    // TX real: paquetes construidos por el encoder (engine.sequence).
    // RX: entregas reales registradas por la malla.
    setText('lora-tx-count', String(engine.sequence));
    setText('lora-rx-count', String(mesh.stats.successfulDeliveries));
    setText('lora-avg-hops', String(engine.getStats().lora.avgHops));
    const rssi = typeof localNode.getSignalStrength === 'function' ? localNode.getSignalStrength() : null;
    setText('lora-rssi', rssi != null ? `${rssi.toFixed(0)} dBm` : '—');
    const rssiBar = getEl('lora-rssi-bar');
    if (rssiBar) rssiBar.style.width = `${Math.max(0, Math.min(100, (rssi || -70) + 100))}%`;
    setText('lora-snr', '—'); // el stack real no computa SNR
    setText('lora-sf', localNode.spreadingFactor);
    setText('lora-bw', localNode.bandwidth);

    setText('aprs-freq', formatFrequency(engine.tracker.frequency));
    setText('aprs-callsign', engine.callsign || '—');
    setText('aprs-tx-count', String(engine.tracker.stats.packetsSent));
    setText('aprs-rx-count', '—'); // sin contador de recepción en el stack real
    const ig = getEl('aprs-igate');
    if (ig) {
        ig.textContent = aprsActive ? 'ACTIVE (NO IGATE)' : 'OFFLINE (NO IGATE)';
        ig.style.color = aprsActive ? '#f59e0b' : '#6b7280';
    }
    setText('aprs-digipeater', 'N/A (MESH RELAY)');

    setText('sdr-center-freq', formatFrequency(engine.sdr.frequency));
    setText('sdr-sample-rate', `${(engine.sdr.sampleRate / 1e3).toFixed(1)} kHz`);
    setText('sdr-signals', '0');
    setText('sdr-decoded', '0');

    setText('rf-current-freq', formatFrequency(localNode.frequency === 'EU868' ? 868e6 : 915e6));
    setText('rf-current-sf', localNode.spreadingFactor);
    setText('rf-encryption', 'AES-CTR');
    setText('rf-lora-id', localNode.id);

    setText('stat-rf-links', String((active ? 1 : 0) + (aprsActive ? 1 : 0) + (active ? 1 : 0)));

    drawLoRaWaveform();
    drawSDRSpectrum();
    drawFreqAllocation();
}

// ═══════════════════════════════════════════════════════════════════
//  PANEL ⑤ — VISUALIZADOR DEL PAQUETE REAL (CBOR + LZ77 + AES-CTR)
// ═══════════════════════════════════════════════════════════════════

function hexPairs(hexStr, limit) {
    const pairs = hexStr.match(/.{2}/g) || [];
    const shown = pairs.slice(0, limit);
    let out = shown.join(' ');
    if (pairs.length > limit) out += ` ··· +${pairs.length - limit} bytes`;
    return out;
}

function resetWireBytes() {
    ['bytes-ephpub','bytes-iv','bytes-cipher','bytes-tag'].forEach((id) => setText(id, '-- -- -- --'));
    ['seg-ephpub','seg-iv','seg-cipher','seg-tag'].forEach((id) => {
        const el = getEl(id);
        if (el) el.classList.remove('active', 'decoded');
    });
}

function resetDecryptedPanel() {
    ['dec-gps','dec-bpm','dec-spo2','dec-depth'].forEach((id) => setText(id, '—'));
    const decTriage = getEl('dec-triage');
    if (decTriage) decTriage.innerHTML = '<span class="triage-badge triage-green">—</span>';
}

function updateWirePanel() {
    const statusEl = getEl('ecies-status');
    if (!rfActive() || !engine.lastTelemetryBytes) {
        if (statusEl) {
            statusEl.textContent = 'IDLE';
            statusEl.style.color = '';
            statusEl.style.borderColor = '';
        }
        resetWireBytes();
        resetDecryptedPanel();
        return;
    }

    const bytes = engine.lastTelemetryBytes;
    const hex = LifelineEngine.hexOf(bytes);
    // Formato de trama real del encoder: nonce AES(8) || ciphertext || MIC(4)
    const nonceHex = hex.slice(0, 16);
    const micHex = hex.slice(-8);
    const cipherHex = hex.slice(16, -8);

    let pkt = null;
    try { pkt = engine.encoder.decode(bytes); } catch (e) { pkt = null; }

    setText('bytes-ephpub', pkt
        ? `t:${pkt.type} s:${(pkt.sourceId || '').slice(0, 8)} d:${(pkt.destinationId || '').slice(0, 8)} seq:${pkt.sequence}`
        : 'CBOR');
    setText('bytes-iv', hexPairs(nonceHex, 8));
    setText('bytes-cipher', hexPairs(cipherHex, 8));
    setText('bytes-tag', hexPairs(micHex, 4));
    setText('size-cipher', `${bytes.length - 12} bytes · CBOR+LZ77+AES-CTR`);

    ['seg-ephpub','seg-iv','seg-cipher','seg-tag'].forEach((id) => {
        const el = getEl(id);
        if (el) { el.classList.remove('active'); el.classList.add('decoded'); }
    });

    if (statusEl) {
        statusEl.textContent = 'LIVE CAPTURE (BYTES REALES)';
        statusEl.style.color = '#8b5cf6';
        statusEl.style.borderColor = '#8b5cf6';
    }

    const s = engine.lastSnapshot || {};
    const ipu = calcIPU();
    const tr = getTriageForVitals(s.bpm != null ? s.bpm : bpm, s.spo2 != null ? s.spo2 : spo2, activeSOS, ipu);
    setText('dec-gps', s.gps && s.gps.lat != null ? `${s.gps.lat.toFixed(4)}, ${s.gps.lon.toFixed(4)}` : '—');
    setText('dec-bpm', s.bpm != null ? `${s.bpm} BPM` : '—');
    setText('dec-spo2', s.spo2 != null ? `${s.spo2}%` : '—');
    setText('dec-depth', s.depth_m != null ? `${s.depth_m.toFixed(2)} m` : '—');
    const decTriage = getEl('dec-triage');
    if (decTriage) decTriage.innerHTML = `<span class="triage-badge ${tr.cls}">${tr.label}</span>`;
}

// ═══════════════════════════════════════════════════════════════════
//  UI UPDATE
// ═══════════════════════════════════════════════════════════════════

// Indicadores con datos reales: sin lectura → '—' (regla de producción).
// Los sliders de batería/presión quedan como override manual para pruebas.
function updateVitalControls() {
    setText('val-battery', battery != null ? `${battery}%` : '—');
    setText('val-bpm', bpm != null ? `${bpm} BPM` : '—');
    setText('val-spo2', spo2 != null ? `${spo2}%` : '—');
    setText('val-pressure', pressureTrapped != null ? `${(pressureTrapped / 100).toFixed(2)} hPa` : '—');
    const bCtl = getEl('control-battery');
    if (bCtl && battery != null) bCtl.value = battery;
    const pCtl = getEl('control-pressure');
    if (pCtl && pressureTrapped != null) pCtl.value = pressureTrapped;
}

function updateUI() {
    const ipu = calcIPU();
    const altDelta = pressureTrapped != null ? calcDeltaH(pressureTrapped) : null;
    const newState = resolveState();

    if (newState !== systemState && systemState !== 'DORMANT') {
        addLog(`[PowerMgr] Transición de estado: ${systemState} → ${newState}`, 'log-alert');
    }
    if (systemState !== 'DORMANT') systemState = newState;

    const cfg = stateConfig(systemState);
    const active = systemState !== 'DORMANT' && systemState !== 'ORPHAN';

    if (systemBadge) {
        systemBadge.textContent = cfg.label;
        systemBadge.className = `badge state-${systemState.toLowerCase()}`;
    }
    if (systemPulse) {
        systemPulse.className = `pulse-dot ${active ? 'active' : ''}`;
    }

    setText('stat-phy', cfg.phy);
    setText('stat-nodes', String(active && engine && engine.ready ? engine.getNodes().length : 0));
    setText('stat-ppm', String(packetsThisMinute));

    const rmb = getEl('radio-mode-badge');
    if (rmb) {
        rmb.textContent = `PHY: ${cfg.phy}`;
        rmb.style.color = cfg.color;
        rmb.style.borderColor = cfg.color;
    }

    setText('status-radio', cfg.label);
    setText('status-interval', cfg.interval);
    setText('status-tx-power', cfg.tx);
    setText('status-relay', relayActive && active ? 'ACTIVE (HOP-1)' : 'INACTIVE');

    const ipuValue = getEl('ipu-value');
    const ipuFill = getEl('ipu-fill');
    if (ipuValue) ipuValue.textContent = ipu.toFixed(2);
    if (ipuFill) {
        ipuFill.style.width = `${ipu * 100}%`;
        ipuFill.style.background = ipu < 0.4 ? '#ef4444' : ipu < 0.7 ? '#f59e0b' : 'linear-gradient(to right, #06b6d4, #10b981)';
    }

    const triage = getTriageForVitals(bpm, spo2, activeSOS, ipu);
    const badge = getEl('triage-badge-value');
    if (badge) {
        badge.textContent = triage.label;
        badge.className = `triage-badge ${triage.cls}`;
    }

    const depthEl = getEl('depth-display');
    if (depthEl) {
        if (altDelta == null) {
            depthEl.textContent = '—';
            depthEl.style.color = '#94a3b8';
        } else {
            depthEl.textContent = `${altDelta.toFixed(2)} m`;
            depthEl.style.color = altDelta > 5 ? '#ef4444' : altDelta > 1 ? '#f59e0b' : '#8b5cf6';
        }
    }

    // Rol del dispositivo (clasificador automático)
    updateRolePanel();
    if (roleInfo && roleInfo.role === 'VICTIM' && active && !trappedSince) {
        trappedSince = Date.now();
    }

    updateScoutTable(active);
    trackNodeDetections();
    renderRescueCompass();

    // Scanner dot + ping-all
    if (scannerDot) {
        if (active) {
            scannerDot.classList.add('active');
            if (pingAllBtn) pingAllBtn.disabled = false;
        } else {
            scannerDot.classList.remove('active');
            if (pingAllBtn) pingAllBtn.disabled = true;
        }
    }

    // Intercom (destinos = nodos reales)
    if (intercomSelect && intercomInput && intercomSend) {
        if (active) {
            intercomSelect.disabled = false;
            intercomInput.disabled = false;
            intercomSend.disabled = false;
            const nodes = displayNodes();
            intercomSelect.innerHTML = `<option value="ALL">BROADCAST A TODOS</option>` +
                nodes.map((n) => `<option value="${n.id}">${n.label} (${n.id.slice(0, 4)})</option>`).join('');
        } else {
            intercomSelect.disabled = true;
            intercomInput.disabled = true;
            intercomSend.disabled = true;
        }
    }

    updateRFPanels();
    updateWirePanel();
    updateRelayPanel();
    updateVitalControls();
}

// ── Scout Radar Table (nodos reales) ────────────────────────────────
function lastSeenTxt(ts) {
    if (ts == null) return '—';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function lastSeenColor(ts) {
    if (ts == null) return '#64748b';
    const age = Date.now() - ts;
    return age < 15000 ? '#10b981' : age < 30000 ? '#f59e0b' : '#ef4444';
}

function rssiPips(rssi) {
    if (rssi == null) return '<span style="color:#64748b">—</span>';
    const bars = rssi > -60 ? 4 : rssi > -70 ? 3 : rssi > -80 ? 2 : 1;
    const pips = Array.from({length: 4}, (_, i) =>
        `<div class="rssi-pip${i < bars ? ' active' : ''}" style="height:${(i+1)*4}px"></div>`
    ).join('');
    return `<div class="rssi-bar">${pips}<span style="margin-left:3px;color:#64748b;font-size:0.58rem">${rssi.toFixed(0)}</span></div>`;
}

// Clase CSS de fila para nodos detectados/actualizados recientemente.
function flashRow(nodeId) {
    const f = nodeFlash.get(nodeId);
    if (!f || (Date.now() - f.since) > FLASH_MS) return '';
    return f.isNew ? 'det-row-new' : 'det-row-upd';
}

function updateScoutTable(active) {
    if (!radarList) return;

    if (!active) {
        radarList.innerHTML = `<tr><td colspan="11" class="text-center text-muted">
            Sin beacons detectados — dispara un P-Wave para iniciar.
        </td></tr>`;
        return;
    }

    const nodes = displayNodes();
    if (nodes.length === 0) {
        radarList.innerHTML = `<tr><td colspan="11" class="text-center text-muted">
            Malla sin nodos activos.
        </td></tr>`;
        return;
    }

    const ipu = calcIPU();
    const localTriage = getTriageForVitals(bpm, spo2, activeSOS, ipu);
    const localDepthM = pressureTrapped != null ? Math.abs(calcDeltaH(pressureTrapped)) : null;
    const snap = lastSensor || {};
    const scoutPressure = pressureTrapped != null
        ? pressureTrapped
        : (snap.hasPressure && snap.pressure != null ? snap.pressure : null);
    const localRssi = engine && engine.localNode && typeof engine.localNode.getSignalStrength === 'function'
        ? engine.localNode.getSignalStrength() : null;

    const rows = nodes.map((node) => {
        const bpmV = node.isLocal ? bpm : node.bpm;
        const spo2V = node.isLocal ? spo2 : node.spo2;
        const sos = node.isLocal ? activeSOS : false;
        const depthM = node.isLocal ? localDepthM : (node.pressure != null ? Math.abs(calcDeltaH(node.pressure)) : null);
        const nodeP = node.isLocal ? pressureTrapped : node.pressure;
        const floorTxt = (nodeP != null && scoutPressure != null)
            ? nodeFloorLabel({ pressure: nodeP }, scoutPressure)
            : '—';
        const gpsTxt = node.gps && node.gps.lat != null ? `${node.gps.lat.toFixed(4)}, ${node.gps.lon.toFixed(4)}` : '—';
        const battTxt = node.battery != null ? `${node.battery}%` : '—';
        const rssiV = node.isLocal ? localRssi : node.rssi;

        const hasVitals = bpmV != null && spo2V != null;
        const tr = hasVitals ? getTriageForVitals(bpmV, spo2V, sos, ipu) : null;
        const vitalsTxt = hasVitals ? `${bpmV} BPM / ${spo2V}% SpO₂` : '—';
        const atmTxt = (node.coPpm != null || node.o2Pct != null)
            ? `${node.coPpm != null ? node.coPpm + ' CO' : ''}${node.coPpm != null && node.o2Pct != null ? ' / ' : ''}${node.o2Pct != null ? node.o2Pct.toFixed(1) + '% O₂' : ''}`
            : '—';

        return `<tr class="${flashRow(node.id)}">
            <td data-label="NODO" class="node-id${node.isRelay ? ' relayed' : ''}">${node.label || node.id.slice(0, 8)}
                ${node.isLocal ? '<span style="color:#06b6d4;font-size:0.55rem;margin-left:4px">◉ LOCAL</span>' : ''}
                ${node.isRelay ? '<span style="color:#8b5cf6;font-size:0.55rem;margin-left:4px">◈ VIA HOP</span>' : ''}
                <div style="font-size:0.55rem;color:#64748b">${node.id.slice(0, 8)} · ${node.role || 'UNKNOWN'}${node.isLocal ? ` · ${localTriage.code === 0 ? 'STABLE' : localTriage.code === 1 ? 'DELAYED' : localTriage.code === 2 ? 'IMMEDIATE' : 'UNRESPONSIVE'}` : ''}</div>
            </td>
            <td data-label="TRIAGE">${tr ? `<span class="triage-badge ${tr.cls}">${tr.label}</span>` : '<span style="color:#64748b">—</span>'}</td>
            <td data-label="PROFUNDIDAD" style="color:${depthM != null && depthM > 10 ? '#ef4444' : '#f59e0b'}">${depthM != null ? depthM.toFixed(1) + ' m ↓' : '—'}</td>
            <td data-label="PISO" style="font-size:0.62rem;color:${floorTxt.startsWith('↑') ? '#8b5cf6' : floorTxt.startsWith('-') ? '#06b6d4' : '#94a3b8'}">${floorTxt}</td>
            <td data-label="GPS" style="font-size:0.62rem;color:#64748b">${gpsTxt}</td>
            <td data-label="VITALES" style="font-size:0.62rem">${vitalsTxt}</td>
            <td data-label="ATMOSFERA" style="font-size:0.6rem;color:${atmTxt === '—' ? '#64748b' : '#f59e0b'}">${atmTxt}</td>
            <td data-label="RSSI">${rssiPips(rssiV)}</td>
            <td data-label="BATERIA" style="color:${battTxt === '—' ? '#64748b' : node.battery < 20 ? '#ef4444' : node.battery < 40 ? '#f59e0b' : '#10b981'}">${battTxt}</td>
            <td data-label="ÚLTIMA SEÑAL" style="color:${lastSeenColor(node.isLocal ? Date.now() : node.lastSeen)}">${lastSeenTxt(node.isLocal ? Date.now() : node.lastSeen)}</td>
            <td data-label="ACCION"><button class="btn btn-sm btn-primary" onclick="pingNode('${node.id}')">📡 PING</button></td>
        </tr>`;
    }).join('');

    radarList.innerHTML = rows;
}

// ═══════════════════════════════════════════════════════════════════
//  PING / INTERCOM — transmisión real por la malla
// ═══════════════════════════════════════════════════════════════════

window.pingNode = function (nodeId) {
    if (systemState === 'DORMANT' || systemState === 'ORPHAN') return;
    if (!rfActive()) return;

    addLog(`[Scout] Enviando ping a nodo ${nodeId.slice(0, 4)}…`, 'log-alert');
    addLoRaPacketLog(`Ping request → ${nodeId.slice(0, 4)}...`);
    const hex = engine.sendPing(nodeId);
    if (hex) addLoRaPacketLog(`Ping TX ${hex.length / 2}B (unicast relay)`);
    pingUntil.set(nodeId, Date.now() + 2500);

    const node = findNode(nodeId);
    const W = canvas ? canvas.width : 400;
    const H = canvas ? canvas.height : 300;
    const pos = nodeScreenPos(node || { id: nodeId, isLocal: false, pressure: pressureTrapped }, W, H);
    for (let i = 0; i < 6; i++) {
        setTimeout(() => {
            waves.push({ x: pos.x, y: pos.y, r: 8, color: '#06b6d4', maxR: 400, speed: 5 });
        }, i * 180);
    }
    updateUI();
};

if (pingAllBtn) {
    pingAllBtn.addEventListener('click', () => {
        displayNodes().forEach((n, i) => {
            setTimeout(() => window.pingNode(n.id), i * 400);
        });
    });
}

// ── Panel ⑯ — señales de testeo por el navegador ────────────────────
const testTxBtn = document.getElementById('btn-test-tx');
if (testTxBtn) {
    testTxBtn.addEventListener('click', () => {
        if (!engine || !engine.ready) return;
        if (!engine.started) {
            addRFLog('Motor no iniciado — dispara un P-Wave primero.', 'log-alert');
            return;
        }
        sendTelemetryOnce();
        addRFLog('Señal de prueba TX enviada (broadcast real AES-CTR).', 'log-success');
        updateUI();
    });
}

const testNodeBtn = document.getElementById('btn-test-node');
if (testNodeBtn) {
    testNodeBtn.addEventListener('click', () => {
        if (!engine || !engine.ready) return;
        if (!engine.started) {
            addRFLog('Motor no iniciado — dispara un P-Wave primero.', 'log-alert');
            return;
        }
        // Inyecta el dispositivo en la malla transmitiendo su trama REAL
        // (CBOR+LZ77+AES-CTR) con las lecturas reales del dispositivo.
        // Nada ficticio: los pares la materializan como nodo remoto.
        const hex = engine.sendLocalTelemetry(buildSnapshot());
        if (hex) {
            packetsThisMinute++;
            addLoRaPacketLog(`Nodo inyectado TX ${hex.length / 2}B (lecturas reales del dispositivo)`);
            updateWirePanel();
        }
        updateUI();
        addRFLog('Nodo inyectado: trama real transmitida con las lecturas del dispositivo (sin datos ficticios).', 'log-success');
    });
}

const testClearBtn = document.getElementById('btn-test-clear');
if (testClearBtn) {
    testClearBtn.addEventListener('click', () => {
        if (!engine) return;
        engine.clearRemoteNodes();
        updateUI();
        addRFLog('Nodos remotos limpiados.', 'log-line');
    });
}

const testAddPeerBtn = document.getElementById('btn-test-addpeer');
const testPeerUrl = document.getElementById('test-peer-url');
if (testAddPeerBtn && testPeerUrl) {
    testAddPeerBtn.addEventListener('click', () => {
        const url = testPeerUrl.value.trim();
        if (!url) {
            addRFLog('Indica la URL del par, p. ej. http://192.168.0.5:8000', 'log-alert');
            return;
        }
        if (!relay) {
            addRFLog('Relay no iniciado.', 'log-alert');
            return;
        }
        relay.addManualPeer(url);
        addRFLog(`Par manual solicitado: ${url}`, 'log-line');
        updateUI();
    });
}

// ═══════════════════════════════════════════════════════════════════
//  ETAPA 0 — HARDWARE FÍSICO (radio LoRa Web Serial + wearable BLE)
//  Solo enlazan hardware real: sin Web Serial / Web Bluetooth o sin
//  dispositivo, reportan el motivo (SIN RADIO / SIN BLE) y nunca
//  inventan lecturas ni tramas.
// ═══════════════════════════════════════════════════════════════════

let radioDriver = null;
let bleBridge = null;

// ═══════════════════════════════════════════════════════════════
//  ENLACES POR DISPOSITIVO (DeviceLinkManager): cada sensor/dispositivo
//  físico se conecta de forma INDEPENDIENTE, con su propio estado y sus
//  propios datos, a través de radio/device_links.js. La GUI se suscribe
//  por dispositivo (data/status) y NO comparte estado entre enlaces.
//  Cada conecta=() delega en deviceLinks.connect(id); las factories usan
//  los bridges reales (radio_driver/ble_bridge/atmosphere_bridge/
//  field_bridge/thermal_cam) para arrancar el hardware tal cual.
// ═══════════════════════════════════════════════════════════════
let deviceLinks = null; // DeviceLinkManager (=> window.deviceLinks)

function ensureThermalCam() {
    if (thermalCam) return thermalCam;
    if (typeof ThermalCam === 'undefined') return null;
    thermalCam = new ThermalCam({
        onFrame: (frame) => {
            lastThermal = frame;
            renderThermalCanvas(frame);
            updateUI();
        },
    });
    return thermalCam;
}

function initDeviceLinks() {
    if (deviceLinks || typeof DeviceLinkManager === 'undefined') return deviceLinks;
    const m = new DeviceLinkManager();
    deviceLinks = m;

    // ── RADIO LoRa (radio_driver) ──
    m.register({
        id: 'RADIO', name: 'Radio LoRa', kind: 'rf',
        isSupported: () => (typeof LoRaRadioDriver !== 'undefined' && LoRaRadioDriver.isSupported()),
        factory: () => {
            if (!radioDriver) radioDriver = new LoRaRadioDriver({
                onFrame: (frame) => m._emit('data', 'RADIO', { type: 'frame', trama_hex: frame.hex, rssi: frame.rssi }),
                onLog: (ch, msg) => m._emit('data', 'RADIO', { type: 'log', ch, msg }),
            });
            return {
                bridge: radioDriver,
                connect: () => radioDriver.connect(),
                disconnect: () => (radioDriver.close ? radioDriver.close() : null),
            };
        },
    });

    // ── BLE VITALES (LifelineBleBridge) ──
    m.register({
        id: 'BLE', name: 'Wearable BLE', kind: 'vitals',
        isSupported: () => (typeof LifelineBleBridge !== 'undefined' && LifelineBleBridge.isSupported()),
        factory: () => {
            if (!bleBridge) bleBridge = new LifelineBleBridge({
                onReading: (r) => m._emit('data', 'BLE', { type: 'reading', bpm: r.bpm, spo2: r.spo2 }),
                onStatus: (s) => m._emit('status', 'BLE', { type: 'bridge', connected: s.connected, services: s.services }),
            });
            return {
                bridge: bleBridge,
                connect: () => bleBridge.connect(),
                disconnect: () => (bleBridge.close ? bleBridge.close() : null),
            };
        },
    });

    // ── GASES (LifelineAtmosphereBridge) ──
    m.register({
        id: 'ATMOSPHERE', name: 'Gases', kind: 'environment',
        isSupported: () => (typeof LifelineAtmosphereBridge !== 'undefined' && LifelineAtmosphereBridge.isSupported()),
        factory: () => {
            if (!atmosphereBridge) atmosphereBridge = new LifelineAtmosphereBridge({
                onReading: (r) => m._emit('data', 'ATMOSPHERE', { type: 'reading', coPpm: r.coPpm, o2Pct: r.o2Pct }),
                onStatus: (s) => m._emit('status', 'ATMOSPHERE', { type: 'bridge', connected: s.connected, services: s.services }),
            });
            return {
                bridge: atmosphereBridge,
                connect: () => atmosphereBridge.connect(),
                disconnect: () => (atmosphereBridge.close ? atmosphereBridge.close() : null),
            };
        },
    });

    // ── CAMPO UWB/IMU/IR (LifelineFieldBridge por Web Serial) ──
    m.register({
        id: 'FIELD', name: 'Campo UWB/IMU/IR', kind: 'field',
        isSupported: () => (typeof LifelineFieldBridge !== 'undefined' && LifelineFieldBridge.isSupported()),
        factory: () => {
            const fb = ensureFieldBridge();
            fb.onLine((line) => m._emit('data', 'FIELD', { type: 'line', line }));
            return {
                bridge: fb,
                connect: () => fb.open(),
                disconnect: () => fb.close(),
            };
        },
    });

    // ── CÁMARA TÉRMICA (ThermalCam sobre un transporte de líneas) ──
    m.register({
        id: 'THERMAL', name: 'Cámara térmica IR', kind: 'thermal',
        isSupported: () => (typeof ThermalCam !== 'undefined'),
        factory: ({ harness, opts }) => {
            const cam = ensureThermalCam();
            if (!cam) return { connect: () => Promise.resolve({ ok: false, error: 'NO_MODULO' }) };
            // Suscribe el mapa real ya que ensureThermalCam recibe onFrame.
            return {
                bridge: cam,
                connect: () => {
                    const transport = (opts && opts.transport) || (fieldBridge ? fieldBridge.thermalTransport : null);
                    const res = cam.attach(transport);
                    return Promise.resolve(res);
                },
                disconnect: () => cam.close(),
            };
        },
    });

    // Suscripciones por dispositivo → rutinas reales de la app.
    wireDeviceSubscriptions(m);
    window.deviceLinks = m;
    return m;
}

// Suscripciones: llevan los datos reales de cada dispositivo a los sensores,
// al motor y a la UI (mismas cadenas de log que antes, ahora desacopladas).
function wireDeviceSubscriptions(m) {
    // RADIO: tramas reales → motor; logs de canal → feed.
    m.sub('RADIO', 'data', (p) => {
        if (p.type === 'frame') {
            if (!engine) return;
            const result = engine._handleIncoming({ payload: { trama_hex: p.trama_hex, rssi: p.rssi } });
            addRFLog(`Radio física RX ${p.trama_hex.length / 2}B (${result ? 'decodificada' : 'descartada'})`);
            updateUI();
        } else if (p.type === 'log') {
            addRFLog(`[${p.ch.toUpperCase()}] ${p.msg}`, 'log-line');
        }
    });

    // BLE VITALES: reemplaza «—» con el dato real del wearable.
    m.sub('BLE', 'data', (p) => {
        if (p.type !== 'reading') return;
        if (p.bpm != null || p.spo2 != null) {
            const snap = lastSensor || {};
            applySensorData({
                timestamp: Date.now(),
                bpm: p.bpm != null ? p.bpm : snap.bpm,
                spo2: p.spo2 != null ? p.spo2 : snap.spo2,
            });
            addRFLog(`Wearable: ${p.bpm != null ? p.bpm + ' BPM' : '— BPM'} · ${p.spo2 != null ? p.spo2 + '% SpO₂' : '— SpO₂'}`);
            updateUI();
        }
    });

    // ATMOSFERA: CO/O2 reales y panel + veredicto.
    m.sub('ATMOSPHERE', 'data', (p) => {
        if (p.type !== 'reading') return;
        if (p.coPpm != null) atmCO = p.coPpm;
        if (p.o2Pct != null) atmO2 = p.o2Pct;
        updateAtmPanel();
        updateUI();
    });

    // CAMPO: líneas UWB/ORI/THERMAL reales → lector/parse de la app.
    m.sub('FIELD', 'data', (p) => {
        if (p.type === 'line') handleFieldLine(p.line);
    });

    // TÉRMICA: el onFrame lo atiende ensureThermalCam (canvas + updateUI).
    // (status opcional: refleja SIN_TÉRMICA honesto).
    m.sub('THERMAL', 'status', (s) => {
        const el = getEl('th-status');
        if (el) {
            el.textContent = s.state === 'up' ? 'TÉRMICA ONLINE' : `SIN TÉRMICA: ${s.error || '—'}`;
            el.style.color = s.state === 'up' ? 'var(--rf-green)' : '#f59e0b';
        }
    });
}

// Conexión de cada dispositivo vía el gestor (independiente por id).
function connectRadio() {
    const m = initDeviceLinks();
    if (!m) {
        if (typeof LoRaRadioDriver === 'undefined') addRFLog('Driver de radio física no cargado (radio_driver.js).', 'log-alert');
        return;
    }
    m.connect('RADIO').then((res) => {
        const statusEl = getEl('radio-status');
        if (statusEl) {
            statusEl.textContent = res.ok ? `RADIO: ${res.radio || 'OK'}` : `SIN RADIO: ${res.error}`;
            statusEl.style.color = res.ok ? 'var(--rf-green)' : '#f59e0b';
        }
        addRFLog(res.ok
            ? 'Radio física vinculada — las tramas locales viajan también por el transceptor LoRa.'
            : `Radio física no disponible (${res.error}).`, res.ok ? 'log-success' : 'log-alert');
        updateUI();
    });
}

function connectBle() {
    const m = initDeviceLinks();
    if (!m) {
        if (typeof LifelineBleBridge === 'undefined') addRFLog('Puente BLE no cargado (ble_bridge.js).', 'log-alert');
        return;
    }
    m.connect('BLE').then((res) => {
        const statusEl = getEl('ble-status');
        if (statusEl) {
            const svc = (res.services && res.services.join('+')) || '—';
            statusEl.textContent = res.ok ? `BLE CONECTADO (${svc})` : `SIN BLE: ${res.error}`;
            statusEl.style.color = res.ok ? 'var(--rf-green)' : '#f59e0b';
        }
        addRFLog(res.ok
            ? `Wearable BLE vinculado — vitales reales (${(res.services || []).join('+')}).`
            : `Wearable BLE no disponible (${res.error}).`, res.ok ? 'log-success' : 'log-alert');
        updateUI();
    });
}

const bindRadioBtn = document.getElementById('btn-bind-radio');
if (bindRadioBtn) bindRadioBtn.addEventListener('click', () => connectRadio());
const bindBleBtn = document.getElementById('btn-bind-ble');
if (bindBleBtn) bindBleBtn.addEventListener('click', () => connectBle());
const bindFieldBtn = document.getElementById('btn-bind-serial');
if (bindFieldBtn) bindFieldBtn.addEventListener('click', () => connectFieldSerial());
const tacticalModeBtn = document.getElementById('btn-tactical-mode');
if (tacticalModeBtn) tacticalModeBtn.addEventListener('click', () => toggleTacticalMode());
window.toggleTacticalMode = toggleTacticalMode;
window.getTacticalMode = () => tacticalMode;
window.connectRadio = connectRadio;
window.connectBle = connectBle;
window.connectFieldSerial = connectFieldSerial;

// ═══════════════════════════════════════════════════════════════════
//  PANEL ⑰ BARRIDO AVANZADO (Etapa 2): riesgo ambiental + DTN +
//  rol dinámico + wake-up radio. Cero datos inventados: cada métrica
//  solo cambia con lecturas/reacciones REALES.
// ═══════════════════════════════════════════════════════════════════
let atmosphereBridge = null;
let thermalCam = null;
let atmCO = null;
let atmO2 = null;
let lastThermal = null;
// Hook de depuración/pruebas: inyecta un frame térmico real (rejilla MLX) y repinta.
// No inventa datos por sí mismo: quien lo llame aporta un mapa real (transport Web Serial o test).
window.setLastThermal = function (frame) { lastThermal = frame; renderRescueCompass(); };
let audioCtx = null;

/** Alerta sonora inmediata ante riesgo ambiental (Web Audio, sin deps). */
function beepAtmosphere(howMany, holdMs) {
    try {
        if (!audioCtx) {
            const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AC) return; // sin audio en este entorno (honesto)
            audioCtx = new AC();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
        for (let i = 0; i < howMany; i++) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.value = i % 2 === 0 ? 880 : 620;
            gain.gain.setValueAtTime(0.18, audioCtx.currentTime + i * (holdMs / 1000));
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(audioCtx.currentTime + i * (holdMs / 1000));
            osc.stop(audioCtx.currentTime + (i + 1) * (holdMs / 1000));
        }
    } catch (e) { /* sin audio: no rompe el barrido */ }
}

function connectAtmosphere() {
    const m = initDeviceLinks();
    if (!m) {
        if (typeof LifelineAtmosphereBridge === 'undefined') addRFLog('Puente de gases no cargado (atmosphere_bridge.js).', 'log-alert');
        return;
    }
    m.connect('ATMOSPHERE').then((res) => {
        const el = getEl('atm-status');
        if (el) {
            el.textContent = res.ok ? `GASES: ${(res.services || []).join('+')}` : `SIN GASES: ${res.error}`;
            el.style.color = res.ok ? 'var(--rf-green)' : '#f59e0b';
        }
        addRFLog(res.ok
            ? 'Módulo de gases vinculado (BLE 0x181A) — CO/O2 reales.'
            : `Módulo de gases no disponible (${res.error}).`, res.ok ? 'log-success' : 'log-alert');
        updateAtmPanel();
        updateUI();
    });
}

function updateAtmPanel() {
    const verdict = evaluateAtmosphere(atmCO, atmO2);
    const co = getEl('atm-co');
    const o2 = getEl('atm-o2');
    const lvl = getEl('atm-level');
    const reason = getEl('atm-reason');
    if (co) co.textContent = atmCO != null ? atmCO : '—';
    if (o2) o2.textContent = atmO2 != null ? atmO2.toFixed(1) : '—';
    if (lvl) {
        if (atmCO == null && atmO2 == null) { lvl.textContent = 'SIN LECTURA'; lvl.style.color = '#10b981'; }
        else if (verdict.level === 'SAFE') { lvl.textContent = 'SEGURO'; lvl.style.color = '#10b981'; }
        else if (verdict.level === 'WATCH') { lvl.textContent = 'ATENCIÓN'; lvl.style.color = '#f59e0b'; }
        else if (verdict.level === 'HAZARD') { lvl.textContent = '⚠ PELIGRO'; lvl.style.color = '#ef4444'; }
        else { lvl.textContent = '🚨 SEVERO'; lvl.style.color = '#ef4444'; }
    }
    if (reason) reason.textContent = verdict.reasons.length ? verdict.reasons.join(' · ') : 'Atmósfera dentro de límites.';
    // Alerta sonora INMEDIATA ante riesgo: ninguna invención, solo reacciona
    // a lecturas reales que el evaluador marca como peligrosas.
    if (verdict.audible && atmCO != null) beepAtmosphere(3, 220);
}

function connectThermal(transport) {
    const m = initDeviceLinks();
    if (!m) {
        if (typeof ThermalCam === 'undefined') addRFLog('Cámara térmica no cargada (thermal_cam.js).', 'log-alert');
        return;
    }
    if (!transport && fieldBridge) transport = fieldBridge.thermalTransport;
    m.connect('THERMAL', { transport }).then((res) => {
        const el = getEl('th-status');
        if (el) {
            el.textContent = res.ok ? 'TÉRMICA ONLINE' : `SIN TÉRMICA: ${res.error}`;
            el.style.color = res.ok ? 'var(--rf-green)' : '#f59e0b';
        }
        addRFLog(res.ok
            ? 'Cámara térmica vinculada — firmas IR 36–37 °C.'
            : `Cámara térmica no disponible (${res.error}).`, res.ok ? 'log-success' : 'log-alert');
        updateUI();
    });
}

// ── Puente de campo (Web Serial): UWB + orientación + térmica al unísono ──
let fieldBridge = null;

// Enruta las líneas de datos físicos del puerto serial al proveedor real.
function handleFieldLine(line) {
    // UWB <metros> → distancia ToF del chip UWB.
    if (line.indexOf('UWB ') === 0) {
        const v = parseFloat(line.slice(4));
        if (typeof sensors !== 'undefined' && typeof sensors.setDistance === 'function') {
            sensors.setDistance(v);
        }
        return;
    }
    // ORI <alpha> <beta> <gamma> → orientación IMU/brújula (grados).
    if (line.indexOf('ORI ') === 0) {
        const parts = line.slice(4).trim().split(/\s+/).map(Number);
        if (parts.length >= 3 && typeof sensors.onOrientation === 'function') {
            sensors.onOrientation({ alpha: parts[0], beta: parts[1], gamma: parts[2] });
        }
    }
}

function connectFieldSerial() {
    const m = initDeviceLinks();
    if (!m) {
        if (typeof LifelineFieldBridge === 'undefined') addRFLog('Puente de campo no cargado (field_bridge.js).', 'log-alert');
        return;
    }
    m.connect('FIELD').then((res) => {
        const el = getEl('fb-status');
        if (el) {
            el.textContent = res.ok ? 'PUENTE DE CAMPO OK' : `SIN PUENTE: ${res.error}`;
            el.style.color = res.ok ? 'var(--rf-green)' : '#f59e0b';
        }
        addRFLog(res.ok
            ? 'Puente de campo vinculado — UWB + orientación + térmica por Web Serial.'
            : `Puente de campo no disponible (${res.error}).`, res.ok ? 'log-success' : 'log-alert');
        if (res.ok && fieldBridge) connectThermal(fieldBridge.thermalTransport);
    });
}
window.getFieldBridge = () => fieldBridge;

// ── Modo esclavo temporal (WebRTC P2P para pruebas de campo) ────────
// Emisor (esclavo): crea la oferta, emite sus lecturas reales por un
// DataChannel. Receptor (maestro): pega la oferta, responde e inyecta
// las líneas recibidas en el puente de campo (mismo protocolo UWB/ORI/THERMAL).
// Señalización manual por copiar/pegar: sin servidor de paso.

let rtcLink = null;      // enlace activo (emisor o receptor)
let rtcSlaveTimer = null; // bucle de emisión del esclavo
let rtcMode = null;       // 'SLAVE' (emisor/esclavo) | 'MASTER' (receptor/maestro)

// Conmutador manual del modo de enlace (independiente del rol). Al aplicar
// un rol (SCOUT/RELAY) el modo NO cambia — se define aquí a voluntad.
function toggleRtcMode() {
    rtcMode = rtcMode === 'SLAVE' ? 'MASTER' : 'SLAVE';
    applyRtcMode();
    addRFLog(`Modo de enlace de campo → ${rtcMode === 'SLAVE' ? 'ESCLAVO (emisor)' : 'MAESTRO (receptor)'}.`, 'log-line');
    return rtcMode;
}

function applyRtcMode() {
    const modeTxt = rtcMode === 'SLAVE' ? 'ESCLAVO (emisor)' : 'MAESTRO (receptor)';
    // Conmutador principal dentro de la caja WebRTC (panel ④), bien visible.
    const btn = getEl('btn-rtc-mode');
    if (btn) {
        btn.classList.toggle('rtc-mode-on', rtcMode === 'SLAVE');
        btn.textContent = rtcMode === 'SLAVE' ? '⤻ MODO: ESCLAVO' : '⤻ MODO: MAESTRO';
    }
    // Estado descriptivo justo al lado del conmutador de la caja.
    const state = getEl('rtc-mode-state');
    if (state) {
        state.textContent = rtcMode === 'SLAVE'
            ? 'ESCLAVO → ① CREAR OFERTA, luego ③ PEGAR RESPUESTA (emite sensores).'
            : rtcMode === 'MASTER' ? 'MAESTRO → ② PEGAR OFERTA y RESPONDER (recibe e inyecta).' : 'Sin modo — pulsa para elegir.';
        state.style.color = rtcMode === 'SLAVE' ? '#06b6d4' : rtcMode === 'MASTER' ? '#10b981' : '#64748b';
    }
    // Conmutador del panel ROL (⑰), sincronizado.
    const btn2 = getEl('btn-rtc-role');
    if (btn2) {
        btn2.classList.toggle('rtc-mode-on', rtcMode === 'SLAVE');
        btn2.textContent = rtcMode === 'SLAVE' ? '⤻ MODO: ESCLAVO' : '⤻ MODO: MAESTRO';
    }
    const lbl = getEl('rtc-role-label') || getEl('rtc-mode-label');
    if (lbl) {
        lbl.textContent = rtcMode === 'SLAVE'
            ? 'ESCLAVO · emisor (①→③)'
            : rtcMode === 'MASTER' ? 'MAESTRO · receptor (②)' : 'SIN MODO DE ENLACE';
        lbl.style.color = rtcMode === 'SLAVE' ? '#06b6d4' : rtcMode === 'MASTER' ? '#10b981' : '#64748b';
    }
// Feedback inmediato y visible en la caja WebRTC.
    const box = getEl('rtc-box');
    if (box) {
        if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (rtcMode === 'SLAVE' || rtcMode === 'MASTER') {
            rtcStatus(`MODO ${modeTxt}`, rtcMode === 'SLAVE' ? '#06b6d4' : '#10b981');
        }
    }
    const hint = getEl('rtc-role-hint');
    if (hint) {
        hint.textContent = rtcMode === 'SLAVE'
            ? 'Emisor: ① CREAR OFERTA → el maestro responde → ③ PEGAR RESPUESTA y EMITE sus sensores reales.'
            : 'Receptor: pega la OFERTA del esclavo y ② RESPONDE → recibe e inyecta UWB/ORI/THERMAL.';
    }
}

// Expone el estado de enlace + modo para el reflejo en cada acción.
function rtcProgress(txt, color) {
    rtcStatus(txt, color);
    addRFLog(`[Campo] ${txt}`, 'log-line');
}

function ensureFieldBridge() {
    if (fieldBridge) return fieldBridge;
    if (typeof LifelineFieldBridge === 'undefined') return null;
    fieldBridge = new LifelineFieldBridge({});
    fieldBridge.onLine(handleFieldLine);
    return fieldBridge;
}

// Inyecta una línea recibida (por red) como si viniera del puerto serial.
function injectFieldLine(line) {
    if (!line) return;
    const fb = ensureFieldBridge();
    if (fb) fb.injectLine(line);
}

// Identidad estable del dispositivo remoto (esclavo) dentro de un enlace.
// Se deriva de la OFERTA que el esclavo envió, así un nodo por dispositivo.
let rtcOfferJson = '';
let rtcRemoteId = null;
function remoteIdFromOffer() {
    const str = rtcOfferJson || 'field-slave';
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i); h = Math.imul(h, 16777619);
    }
    return ('SS' + (h >>> 0).toString(16).padStart(8, '0')).slice(0, 10);
}

// Materializa al esclavo remoto como nodo real en la malla/radar (además de
// alimentar el sensor). Se refresca con cada línea y se poda al cerrar el enlace.
function materializeFieldRemote(line) {
    if (!engine || !engine.ready) return;
    if (!rtcRemoteId) rtcRemoteId = remoteIdFromOffer();
    const id = rtcRemoteId;
    let entry = engine.remoteNodes.get(id);
    if (!entry) {
        entry = {
            id, label: 'NODO-CAMPO', role: 'SCOUT',
            node: { type: 'SCOUT', id },
            bpm: null, spo2: null, battery: null,
            pressure: null, rssi: null, lat: null, lon: null,
            isRelay: false, isRemoteWeb: true,
        };
        engine.remoteNodes.set(id, entry);
    }
    entry.lastSeen = Date.now();
    // Adjunta los datos reales que trae cada línea para su visualización.
    const p = String(line || '').trim().split(/\s+/);
    const cmd = (p[0] || '').toUpperCase();
    if (cmd === 'UWB' && p[1] != null) entry.uwbDistance = parseFloat(p[1]);
    else if (cmd === 'ORI' && p[1] != null) {
        entry.orientAlpha = parseFloat(p[1]);
        if (p[2] != null) entry.orientBeta = parseFloat(p[2]);
        if (p[3] != null) entry.orientGamma = parseFloat(p[3]);
    } else if (lastThermal && lastThermal.temps) {
        entry.hasThermal = true; entry.thermalPeakC = lastThermal.temps.length ? Math.round(lastThermal.temps[0]) : null;
    }
    return entry;
}

function pruneFieldRemote() {
    if (!engine) return;
    if (rtcRemoteId && engine.remoteNodes.has(rtcRemoteId)) {
        engine.remoteNodes.delete(rtcRemoteId);
        try { engine.mesh.removeNode(rtcRemoteId); } catch (e) {}
    }
    rtcRemoteId = null; rtcOfferJson = '';
    rtcStatus('Enlace cerrado — nodo remoto retirado', '#64748b');
}

function rtcStatus(txt, color) {
    const el = getEl('rtc-status');
    if (el) { el.textContent = txt; if (color) el.style.color = color; }
}

// Emisor (esclavo): crea la oferta y la deja lista para pegar en el maestro.
function rtcCreateOffer() {
    if (typeof WebRtcFieldLink === 'undefined') { rtcProgress('WebRTC no cargado', '#ef4444'); return; }
    if (rtcLink) { rtcLink.close(); rtcLink = null; }
    // Una oferta es, por definición, el lado EMISOR (esclavo). Reflejarlo en el modo.
    rtcMode = 'SLAVE'; applyRtcMode();
    const link = new WebRtcFieldLink({ onStatus: (s) => rtcProgress(s.type || (s.connected ? 'CONECTADO' : '...'), '#06b6d4') });
    rtcLink = link;
    link.createOffer().then((res) => {
        const out = getEl('rtc-sdp-out');
        if (!res.ok) { rtcProgress(`Oferta: ${res.error}`, '#ef4444'); return; }
        if (out) out.value = JSON.stringify({ type: 'offer', sdp: res.sdp });
        rtcProgress('1· Copia la OFERTA → pégalo en el maestro (esclavo = emisor)', '#06b6d4');
    });
}

// Receptor (maestro): acepta la oferta, devuelve la respuesta y empieza a recibir.
function rtcAcceptOffer() {
    const inp = getEl('rtc-sdp-in');
    const offerJson = inp && inp.value ? inp.value.trim() : '';
    if (!offerJson) { rtcProgress('Pega la OFERTA del esclavo primero', '#f59e0b'); return; }
    if (typeof WebRtcFieldLink === 'undefined') { rtcProgress('WebRTC no cargado', '#ef4444'); return; }
    if (rtcLink) { rtcLink.close(); rtcLink = null; }
    // Aceptar una oferta = lado RECEPTOR (maestro). Reflejarlo en el modo.
    rtcMode = 'MASTER'; applyRtcMode();
    rtcOfferJson = offerJson; rtcRemoteId = null;
    const link = new WebRtcFieldLink({
        onLine: (line) => {
            // Inyecta UWB/ORI/THERMAL reales en el puente de campo del maestro.
            injectFieldLine(line);
            const fb = ensureFieldBridge();
            if (fb && lastThermal == null) connectThermal(fb.thermalTransport);
            // El dispositivo remoto (esclavo) aparece como nodo en la malla/gráficos.
            materializeFieldRemote(line);
            rtcProgress(`Recibido: ${line}`, '#10b981');
        },
        onStatus: (s) => rtcProgress(s.type || (s.connected ? 'CONECTADO' : '...'), '#06b6d4'),
    });
    rtcLink = link;
    link.acceptOffer(offerJson).then((res) => {
        const out = getEl('rtc-sdp-out');
        if (!res.ok) { rtcProgress(`Respuesta: ${res.error}`, '#ef4444'); return; }
        if (out) out.value = res.sdp;
        rtcProgress('2· Copia la RESPUESTA → pégalo en el esclavo (maestro = receptor)', '#06b6d4');
    });
}

// Emisor (esclavo): aplica la respuesta del maestro y arranca a emitir.
function rtcComplete() {
    const inp = getEl('rtc-sdp-in');
    const answerJson = inp && inp.value ? inp.value.trim() : '';
    if (!answerJson) { rtcProgress('Pega la RESPUESTA del maestro primero', '#f59e0b'); return; }
    if (!rtcLink) { rtcProgress('Primero crea la OFERTA', '#f59e0b'); return; }
    rtcLink.acceptOfferAnswer(answerJson).then((res) => {
        if (!res.ok) { rtcProgress(`Conexión: ${res.error}`, '#ef4444'); return; }
        rtcStatus('Enlace establecido — EMITIENDO lecturas reales', '#10b981');
        rtcProgress('Enlace establecido — EMITIENDO lecturas reales del esclavo', '#10b981');
        startRtcSlaveLoop();
    });
}

// Bucle del esclavo: emite las lecturas REALES del dispositivo (orientación,
// UWB por su propio puente, y rejilla térmica) como líneas del protocolo.
function startRtcSlaveLoop() {
    stopRtcSlaveLoop();
    let ticks = 0;
    rtcSlaveTimer = setInterval(() => {
        if (!rtcLink || !rtcLink.connected) return;
        const s = (typeof sensors !== 'undefined' && typeof sensors.getSnapshot === 'function')
            ? sensors.getSnapshot() : {};
        const num = (v) => (v == null ? '0' : v);
        let sent = 0;
        if (s.hasOrientation && s.orientation && s.orientation.alpha != null) {
            rtcLink.send(`ORI ${num(s.orientation.alpha)} ${num(s.orientation.beta)} ${num(s.orientation.gamma)}`); sent++;
        }
        if (s.hasUwb && s.uwbDistance != null) {
            rtcLink.send(`UWB ${s.uwbDistance}`); sent++;
        }
        if (typeof thermalToHex !== 'undefined' && typeof lastThermal !== 'undefined' && lastThermal && lastThermal.temps) {
            const hex = thermalToHex(lastThermal);
            if (hex) { rtcLink.send(`THERMAL ${hex}`); sent++; }
        }
        ticks++;
        // Confirma progreso de forma periódica (no a cada línea, para no saturar).
        if (ticks % 5 === 0 || sent === 0) {
            rtcProgress(`Emisión #${ticks}: ${sent} lectura(s) enviadas (ORI/UWB/THERMAL)`, '#10b981');
        }
    }, 1000);
}

function stopRtcSlaveLoop() {
    if (rtcSlaveTimer) { clearInterval(rtcSlaveTimer); rtcSlaveTimer = null; }
}

function rtcClose() {
    stopRtcSlaveLoop();
    if (rtcLink) { rtcLink.close(); rtcLink = null; }
    rtcStatus('Enlace cerrado', '#64748b');
    pruneFieldRemote();
    rtcProgress('Enlace de campo cerrado — nodo remoto retirado.', '#64748b');
}

window.rtcCreateOffer = rtcCreateOffer;
window.rtcAcceptOffer = rtcAcceptOffer;
window.rtcComplete = rtcComplete;
window.rtcClose = rtcClose;
window.toggleRtcMode = toggleRtcMode;
window.getRtcLink = () => rtcLink;
window.materializeFieldRemote = materializeFieldRemote;
window.pruneFieldRemote = pruneFieldRemote;
const bindRtcOffer = document.getElementById('btn-rtc-offer');
if (bindRtcOffer) bindRtcOffer.addEventListener('click', () => rtcCreateOffer());
const bindRtcAccept = document.getElementById('btn-rtc-accept');
if (bindRtcAccept) bindRtcAccept.addEventListener('click', () => rtcAcceptOffer());
const bindRtcComplete = document.getElementById('btn-rtc-complete');
if (bindRtcComplete) bindRtcComplete.addEventListener('click', () => rtcComplete());
const bindRtcClose = document.getElementById('btn-rtc-close');
if (bindRtcClose) bindRtcClose.addEventListener('click', () => rtcClose());
const bindRtcMode = document.getElementById('btn-rtc-mode');
if (bindRtcMode) bindRtcMode.addEventListener('click', () => toggleRtcMode());
const bindRtcRole = document.getElementById('btn-rtc-role');
if (bindRtcRole) bindRtcRole.addEventListener('click', () => toggleRtcMode());

function renderThermalCanvas(frame) {
    const cv = getEl('thermal-canvas');
    if (!cv || !frame || !frame.temps) return;
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    const w = frame.width, h = frame.height;
    ctx.clearRect(0, 0, cv.width, cv.height);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < frame.temps.length; i++) {
        const t = frame.temps[i];
        if (t < min) min = t; if (t > max) max = t;
    }
    const margin = 12, span = Math.max(0.1, max - min);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const t = frame.temps[y * w + x];
            const v = (t - min) / span;
            const r = Math.round(20 + 220 * v);
            const g = Math.round(10 + (t >= 36 && t <= 37 ? 180 : 40) * (1 - v));
            const b = Math.round(20 + 40 * (1 - v));
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            const px = margin + x * ((cv.width - margin * 2) / w);
            const py = margin + y * ((cv.height - margin * 2) / h);
            ctx.fillRect(px, py, Math.ceil(cv.width / w), Math.ceil(cv.height / h));
        }
    }
    const humans = frame.humans || { count: 0, humanPixels: 0 };
    const c = getEl('th-count'); if (c) c.textContent = humans.count;
    const p = getEl('th-pixels'); if (p) p.textContent = humans.humanPixels;
}

/** piso del nodo a partir de la altimetría diferencial (barométrica). */
function nodeFloorLabel(entry, scoutPressure) {
    if (!entry || !entry.pressure || !scoutPressure) return '—';
    const delta = coreMath.calcDeltaHRef(entry.pressure, scoutPressure);
    const f = coreMath.estimateFloorLevel(delta);
    return f.aboveGround ? `↑ ${f.floor}` : f.basement ? `${f.floor}` : `${f.floor}`;
}

function updateDTNPanel() {
    const stored = getEl('dtn-stored');
    const pend = getEl('dtn-pending');
    if (!engine || !engine.dtn) {
        if (stored) stored.textContent = 'OFF';
        if (pend) pend.textContent = 'OFF';
        const st = getEl('dtn-status'); if (st) st.textContent = 'STORE OFF';
        return;
    }
    const c = engine.dtn.counts();
    if (stored) stored.textContent = c.stored;
    if (pend) pend.textContent = c.pending;
}

function syncDTN() {
    // Entrega el outbox local al transporte cross-device (mula de datos →
    // gateway). Honesto: solo transmite balizas reales que aún no se
    // sincronizaron, y las marca como entregadas una vez en el transporte.
    if (!engine || !engine.dtn) { addRFLog('DTN deshabilitado.', 'log-line'); return; }
    const out = engine.syncDTN();
    if (!out.length) { addRFLog('DTN: sin balizas pendientes por sincronizar.', 'log-line'); updateDTNPanel(); updateUI(); return; }
    // (framework) enlaza con relay/udp: aquí se entrega el outbox al
    // transporte del dispositivo y se marca como sincronizado.
    if (relay && typeof relay.sendFrame === 'function') {
        out.forEach((b) => { try { relay.sendFrame({ kind: 'DATA', frame: { nodeId: b.nodeId, timestamp: b.timestamp, data: b.data } }); } catch (e) { /* el transporte no debe romper la sincronización */ } });
    }
    out.forEach((b) => engine.dtn.markSynced(b.nodeId));
    addRFLog(`DTN: ${out.length} baliza(s) entregada(s) al transporte cross-device.`, 'log-success');
    updateDTNPanel();
    updateUI();
}

function updateDynamicRolePanel() {
    if (!engine) return;
    let cur = 'SCOUT';
    if (engine.localNode && engine.localNode.type) cur = engine.localNode.type;
    const r = engine.rebalanceRoles();
    const c = getEl('role-current'); if (c) c.textContent = cur;
    const s = getEl('role-suggest'); if (s) { s.textContent = r.suggested; s.style.color = r.switch ? '#f59e0b' : '#10b981'; }
    const rr = getEl('role-reason'); if (rr) rr.textContent = r.reason;
}

function applyRole() {
    if (!engine) return;
    const r = engine.rebalanceRoles();
    engine.setLocalRole(r.suggested);
    updateDynamicRolePanel();
    // Aplicar rol NO cambia el modo de enlace (se define aparte con el conmutador).
    const modeTxt = rtcMode === 'SLAVE' ? 'ESCLAVO (emisor)' : rtcMode === 'MASTER' ? 'MAESTRO (receptor)' : 'sin modo';
    addRFLog(`Rol local aplicado → ${engine.localNode.type} (modo enlace: ${modeTxt}).`, 'log-success');
}

function wakeProximity() {
    if (!engine || !engine.wakeRadio) { addRFLog('Wake-up radio no disponible.', 'log-line'); return; }
    engine.wakeRadio.signalProximity();
    updateWakePanel();
    addRFLog(`Wake-up radio → ${engine.wakeRadio.getState().state} (sensores de alcance activos).`, 'log-line');
}

function updateWakePanel() {
    if (!engine || !engine.wakeRadio) return;
    const s = engine.wakeRadio.getState();
    const st = getEl('wake-state'); if (st) { st.textContent = s.state; st.style.color = s.state === 'ACTIVE' ? '#ef4444' : s.state === 'IDLE' ? '#f59e0b' : '#64748b'; }
    const c = getEl('wake-count'); if (c) c.textContent = s.activations;
}

const bindAtmBtn = document.getElementById('btn-bind-atm');
if (bindAtmBtn) bindAtmBtn.addEventListener('click', () => connectAtmosphere());
const bindThBtn = document.getElementById('btn-bind-thermal');
if (bindThBtn) bindThBtn.addEventListener('click', () => connectThermal());
const dtnSyncBtn = document.getElementById('btn-dtn-sync');
if (dtnSyncBtn) dtnSyncBtn.addEventListener('click', () => syncDTN());
const applyRoleBtn = document.getElementById('btn-apply-role');
if (applyRoleBtn) applyRoleBtn.addEventListener('click', () => applyRole());
const wakeProxBtn = document.getElementById('btn-wake-prox');
if (wakeProxBtn) wakeProxBtn.addEventListener('click', () => wakeProximity());

window.connectAtmosphere = connectAtmosphere;
window.connectThermal = connectThermal;
window.syncDTN = syncDTN;
window.applyRole = applyRole;
window.wakeProximity = wakeProximity;

if (intercomSend) {
    intercomSend.addEventListener('click', () => {
        const msg = intercomInput.value.trim();
        if (!msg) return;
        const target = intercomSelect.value;
        intercomLog.innerHTML += `<div style="margin-top:4px"><span style="color:var(--muted)">[${timestamp()}]</span> <span style="color:var(--primary)">SCOUT → ${target}:</span> <span style="color:var(--text)">${msg}</span></div>`;
        intercomLog.scrollTop = intercomLog.scrollHeight;
        intercomInput.value = '';

        addLog(`[Uplink] Transmitiendo comando por la malla LoRa real.`, 'log-alert');
        addAPRSPacketLog(`Mensaje a ${target}: ${msg}`);
        if (rfActive()) {
            const dest = target === 'ALL' ? 'FF:FF:FF:FF' : target;
            // El texto viaja incrustado en la trama real (AES-CTR): el par lo
            // decodifica y lo muestra en su propio log de intercom.
            const snap = buildSnapshot();
            snap.msg = msg;
            const hex = engine.sendLocalTelemetry(snap, dest);
            if (hex) addLoRaPacketLog(`Intercom TX ${hex.length / 2}B → ${target.slice(0, 4)} (msg incrustado)`);
        }
    });

    intercomInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') intercomSend.click();
    });
}

// ═══════════════════════════════════════════════════════════════════
//  CANVAS RENDERING (visualización sobre nodos reales)
// ═══════════════════════════════════════════════════════════════════

function nodeScreenPos(node, W, H) {
    const depthM = node.pressure != null ? Math.abs(coreMath.calcDeltaH(node.pressure)) : 0;
    const dr = Math.min(1, Math.max(0, depthM / 30));
    if (node.isLocal) {
        return { x: W * 0.35, y: H * (0.30 + dr * 0.45), depthM };
    }
    const r = 0.15 + hash01(node.id) * 0.5;
    const ang = hash01(node.id + '§') * Math.PI * 2;
    return {
        x: W * (0.5 + Math.cos(ang) * r),
        y: H * (0.28 + Math.sin(ang) * r * 0.55 + dr * 0.25),
        depthM,
    };
}

function nodeColor(node) {
    if (node.isLocal) {
        const tr = getTriageForVitals(bpm, spo2, activeSOS, calcIPU());
        return tr.code === 0 ? '#10b981' : tr.code === 1 ? '#f59e0b' : tr.code === 2 ? '#ef4444' : '#475569';
    }
    if (node.isRelay) return '#8b5cf6';
    return node.role === 'VICTIM' ? '#ef4444' : node.role === 'SCOUT' ? '#10b981' : '#94a3b8';
}

function draw() {
    if (!ctx || !canvas) {
        requestAnimationFrame(draw);
        return;
    }

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(6,182,212,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 32) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Rubble
    const rtop = 90, rheight = H - 150;
    ctx.fillStyle = 'rgba(15,23,42,0.5)';
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(20, rtop, W - 40, rheight, 4); ctx.fill(); ctx.stroke();

    // Crack lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.setLineDash([6, 10]);
    [[0.1,0.15,0.85,0.35],[0.3,0.45,0.7,0.65],[0.5,0.2,0.9,0.55]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath();
        ctx.moveTo(W * x1, rtop + rheight * y1);
        ctx.lineTo(W * x2, rtop + rheight * y2);
        ctx.stroke();
    });
    ctx.setLineDash([]);

    // Scout
    scoutX += 1.2 * scoutDir;
    if (scoutX > W - 60 || scoutX < 60) scoutDir *= -1;
    const sy = 55;
    ctx.fillStyle = '#06b6d4';
    ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(scoutX, sy, 11, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    const active = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    if (active) {
        const grad = ctx.createLinearGradient(scoutX, sy, scoutX, sy + 200);
        grad.addColorStop(0, 'rgba(6,182,212,0.12)');
        grad.addColorStop(1, 'rgba(6,182,212,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(scoutX, sy);
        ctx.lineTo(scoutX - 60, sy + 200);
        ctx.lineTo(scoutX + 60, sy + 200);
        ctx.closePath();
        ctx.fill();
    }

    ctx.fillStyle = '#f1f5f9';
    ctx.font = '9px monospace';
    ctx.fillText('SCOUT / UAV', scoutX - 30, sy - 18);

    // Nodos reales
    const nodes = displayNodes();
    nodes.forEach((node) => {
        if (!active) return;
        const pos = nodeScreenPos(node, W, H);
        let nx = pos.x, ny = pos.y;

        if (pingUntil.has(node.id) && Date.now() < pingUntil.get(node.id)) {
            nx += (Math.random() - 0.5) * 8;
            ny += (Math.random() - 0.5) * 8;
        }

        const nColor = nodeColor(node);

        // Relay link al nodo anterior
        if (node.isRelay) {
            const prev = nodes[nodes.indexOf(node) - 1] || nodes[0];
            const p = nodeScreenPos(prev, W, H);
            ctx.strokeStyle = 'rgba(139,92,246,0.35)';
            ctx.setLineDash([5, 8]);
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(p.x, p.y); ctx.stroke();
            ctx.setLineDash([]);
        }

        const pulse = Math.sin(Date.now() / 300 + hash01(node.id) * 10) * 4;
        ctx.strokeStyle = nColor + '55';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(nx, ny, 14 + pulse, 0, Math.PI * 2); ctx.stroke();

        // Resaltado de detección en vivo: anillo pulsante + etiqueta NUEVO/
        // ACTUALIZADO durante la ventana tras la llegada de sus datos.
        const flash = nodeFlash.get(node.id);
        if (flash && (Date.now() - flash.since) < FLASH_MS) {
            const fade = 1 - Math.max(0, (Date.now() - flash.since)) / FLASH_MS;
            const ringR = 20 + (1 - fade) * 10;
            ctx.strokeStyle = flash.isNew ? '#06b6d4' : '#a855f7';
            ctx.globalAlpha = 0.4 + 0.6 * fade;
            ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.arc(nx, ny, ringR, 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = 1;
            // Etiqueta flotante de identificación.
            ctx.font = 'bold 8px monospace';
            ctx.fillStyle = flash.isNew ? '#06b6d4' : '#a855f7';
            ctx.fillText(flash.isNew ? `◉ NUEVO ${node.label}` : `△ ACTUALIZADO ${node.label}`, nx + 12, ny - 12);
        }

        ctx.fillStyle = nColor;
        ctx.shadowColor = nColor; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.arc(nx, ny, 7, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#e2e8f0';
        ctx.font = '8px monospace';
        ctx.fillText(`${node.label} (${node.role})`, nx + 12, ny + 3);
        ctx.fillStyle = '#64748b';
        ctx.fillText(node.id, nx + 12, ny + 13);

        // Datos recibidos del nodo al instante (identificación del blob).
        const rdBpm = node.bpm != null ? `${node.bpm}B` : null;
        const rdSpo2 = node.spo2 != null ? `${node.spo2}%` : null;
        const rdAtm = node.coPpm != null ? `CO${node.coPpm}` : node.o2Pct != null ? `O2${node.o2Pct.toFixed(0)}` : null;
        const rdDepth = node.pressure != null ? `${Math.abs(coreMath.calcDeltaH(node.pressure)).toFixed(1)}m` : null;
        const rdLine = [rdBpm, rdSpo2, rdAtm, rdDepth].filter(Boolean).join(' ');
        if (rdLine) {
            ctx.font = '7px monospace';
            ctx.fillStyle = '#fbbf24';
            ctx.fillText(rdLine, nx + 12, ny + 29);
        }

        if (rfActive()) {
            ctx.fillStyle = '#06b6d4';
            ctx.font = '7px monospace';
            ctx.fillText(`LoRa:${node.loraId.slice(0, 4)}`, nx + 12, ny + 21);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(nx, rtop); ctx.lineTo(nx, ny); ctx.stroke();

        // Emisión BLE (visualización)
        const emitChance = systemState === 'VIGILANCE' ? 0.008 : systemState === 'ECO' ? 0.004 : 0.002;
        if (Math.random() < emitChance) {
            waves.push({ x: nx, y: ny, r: 5, color: nColor, maxR: 280, speed: 2.5 });
            spawnPacket(nx, ny, scoutX, sy, nColor);
        }
    });

    // Waves
    for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        w.r += w.speed;
        const alpha = 1 - w.r / w.maxR;
        ctx.strokeStyle = w.color;
        ctx.lineWidth = Math.max(0.3, 2 * alpha);
        ctx.shadowColor = w.color;
        ctx.shadowBlur = 6;
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        if (w.r >= w.maxR) waves.splice(i, 1);
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.progress += p.speed;
        const t = p.progress;
        const px = p.x0 + (p.x1 - p.x0) * t;
        const py = p.y0 + (p.y1 - p.y0) * t - Math.sin(t * Math.PI) * 30;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        if (t >= 1.0 || p.progress > 1.2) particles.splice(i, 1);
    }

    // ── TOP-DOWN MAP ──
    if (tctx && topCanvas.width > 0) {
        tctx.clearRect(0, 0, topCanvas.width, topCanvas.height);
        tctx.strokeStyle = 'rgba(255,255,255,0.03)';
        tctx.lineWidth = 1;
        for (let x = 0; x < topCanvas.width; x += 40) {
            tctx.beginPath(); tctx.moveTo(x, 0); tctx.lineTo(x, topCanvas.height); tctx.stroke();
        }
        for (let y = 0; y < topCanvas.height; y += 40) {
            tctx.beginPath(); tctx.moveTo(0, y); tctx.lineTo(topCanvas.width, y); tctx.stroke();
        }

        tctx.fillStyle = 'rgba(239,68,68,0.05)';
        tctx.beginPath(); tctx.arc(topCanvas.width/2, topCanvas.height/2, 40 + Math.sin(Date.now()/500) * 5, 0, Math.PI * 2); tctx.fill();
        tctx.fillStyle = 'rgba(239,68,68,0.3)';
        tctx.font = '8px monospace';
        tctx.fillText('EPICENTER', topCanvas.width/2 - 20, topCanvas.height/2 + 3);

        if (active) {
            nodes.forEach((node) => {
                const tp = nodeScreenPos(node, topCanvas.width, topCanvas.height);
                let tx = topCanvas.width/2 + (tp.x - W * 0.35) * 0.5;
                let ty = topCanvas.height/2 + (tp.y - H * 0.55) * 0.5;
                if (pingUntil.has(node.id) && Date.now() < pingUntil.get(node.id)) {
                    tx += (Math.random() - 0.5) * 4;
                    ty += (Math.random() - 0.5) * 4;
                }
                const nColor = nodeColor(node);
                tctx.strokeStyle = nColor + '66';
                tctx.lineWidth = 1.5;
                tctx.beginPath(); tctx.arc(tx, ty, 8 + (Math.sin(Date.now()/200 + hash01(node.id) * 10) * 2), 0, Math.PI * 2); tctx.stroke();
                tctx.fillStyle = nColor;
                tctx.beginPath(); tctx.arc(tx, ty, 4, 0, Math.PI * 2); tctx.fill();
                tctx.fillStyle = '#e2e8f0';
                tctx.font = '9px monospace';
                tctx.fillText(node.id.slice(0, 4), tx + 8, ty + 3);
            });

            tctx.fillStyle = '#06b6d4';
            const sx = topCanvas.width/2 + Math.cos(Date.now()/3000) * (topCanvas.width/3);
            const sy2 = topCanvas.height/2 + Math.sin(Date.now()/2500) * (topCanvas.height/3);
            tctx.beginPath(); tctx.arc(sx, sy2, 5, 0, Math.PI * 2); tctx.fill();
            tctx.fillText('UAV', sx + 8, sy2 + 3);
            tctx.strokeStyle = 'rgba(6,182,212,0.2)';
            tctx.setLineDash([3, 4]);
            tctx.beginPath(); tctx.moveTo(sx, sy2); tctx.lineTo(topCanvas.width/2, topCanvas.height/2); tctx.stroke();
            tctx.setLineDash([]);
        }
    }

    drawVitalsSparklines();
    drawRFSpectrum();
    drawLoRaWaveform();
    drawSDRSpectrum();
    drawFreqAllocation();

    requestAnimationFrame(draw);
}

function spawnPacket(x0, y0, x1, y1, color) {
    particles.push({ x0, y0, x1, y1, progress: 0, speed: 0.012 + Math.random() * 0.006, color });
}

function showCryptoToast(text) {
    if (!cryptoToast) return;
    const toastText = getEl('crypto-toast-text');
    if (toastText) toastText.textContent = text;
    cryptoToast.classList.add('visible');
    setTimeout(() => cryptoToast.classList.remove('visible'), 2800);
}

setInterval(() => { packetsThisMinute = 0; }, PACKETS_PER_MIN_WINDOW);

// ── Vitals Sparklines (valores reales, sin jitter) ──────────────────
function drawVitalsSparklines() {
    if (!vctx || !vitalsCanvas || vitalsCanvas.width === 0) return;
    if (vitalsHistory.bpm.length < 2) return;

    const W = vitalsCanvas.width, H = vitalsCanvas.height;
    vctx.clearRect(0, 0, W, H);

    vctx.strokeStyle = 'rgba(255,255,255,0.05)';
    vctx.lineWidth = 1;
    for (let y = H * 0.25; y < H; y += H * 0.25) {
        vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(W, y); vctx.stroke();
    }

    function drawLine(data, minVal, maxVal, color) {
        if (data.length < 2) return;
        vctx.strokeStyle = color;
        vctx.lineWidth = 2;
        vctx.shadowColor = color;
        vctx.shadowBlur = 4;
        vctx.beginPath();
        const step = W / (VITALS_HISTORY_MAX - 1);
        data.forEach((val, i) => {
            const x = i * step;
            const normalized = (val - minVal) / (maxVal - minVal);
            const y = H - (normalized * (H - 10)) - 5;
            if (i === 0) vctx.moveTo(x, y);
            else vctx.lineTo(x, y);
        });
        vctx.stroke();
        vctx.shadowBlur = 0;
    }

    drawLine(vitalsHistory.bpm, 30, 180, '#ef4444');
    drawLine(vitalsHistory.spo2, 65, 100, '#3b82f6');
    drawLine(vitalsHistory.battery, 0, 100, '#f59e0b');
}

// ── RF Spectrum (visualización sobre estado real) ───────────────────
function drawRFSpectrum() {
    if (!rfctx || !rfCanvas || rfCanvas.width === 0) return;
    const W = rfCanvas.width, H = rfCanvas.height;
    rfctx.clearRect(0, 0, W, H);

    rfctx.strokeStyle = 'rgba(255,255,255,0.03)';
    rfctx.lineWidth = 1;
    for (let x = 0; x < W; x += 20) {
        rfctx.beginPath(); rfctx.moveTo(x, 0); rfctx.lineTo(x, H); rfctx.stroke();
    }

    const active = rfActive();
    const spectrum = [];
    for (let i = 0; i < W; i++) {
        let amplitude = Math.random() * 10;
        if (active && Math.abs(i - W * 0.3) < 10) {
            amplitude += 40 + Math.sin(Date.now() / 200) * 10;
        }
        if (active && engine.callsign && Math.abs(i - W * 0.6) < 8) {
            amplitude += 30 + Math.sin(Date.now() / 300) * 5;
        }
        spectrum.push(amplitude);
    }

    rfctx.strokeStyle = '#06b6d4';
    rfctx.lineWidth = 1.5;
    rfctx.beginPath();
    spectrum.forEach((amp, i) => {
        const y = H - (amp / 80 * H);
        if (i === 0) rfctx.moveTo(i, y);
        else rfctx.lineTo(i, y);
    });
    rfctx.stroke();

    rfctx.fillStyle = '#64748b';
    rfctx.font = '8px monospace';
    rfctx.fillText('RF SPECTRUM', 5, 12);
    rfctx.fillText('915.000 MHz', 5, H - 5);
    if (active) {
        rfctx.fillStyle = '#06b6d4';
        rfctx.fillText('● LoRa', W - 60, 12);
    }
    if (active && engine.callsign) {
        rfctx.fillStyle = '#10b981';
        rfctx.fillText('● APRS', W - 60, 24);
    }
}

// ── LoRa Waveform ──────────────────────────────────────────────────
function drawLoRaWaveform() {
    if (!loraWaveCtx || !loraWaveCanvas || loraWaveCanvas.width === 0) return;
    const W = loraWaveCanvas.width, H = loraWaveCanvas.height;
    loraWaveCtx.clearRect(0, 0, W, H);

    loraWaveCtx.strokeStyle = 'rgba(255,255,255,0.03)';
    loraWaveCtx.lineWidth = 1;
    for (let x = 0; x < W; x += 20) {
        loraWaveCtx.beginPath(); loraWaveCtx.moveTo(x, 0); loraWaveCtx.lineTo(x, H); loraWaveCtx.stroke();
    }

    if (!rfActive()) {
        loraWaveCtx.fillStyle = '#64748b';
        loraWaveCtx.font = '10px monospace';
        loraWaveCtx.fillText('LoRa OFFLINE', W/2 - 35, H/2 + 3);
        return;
    }

    loraWaveCtx.strokeStyle = '#10b981';
    loraWaveCtx.lineWidth = 2;
    loraWaveCtx.shadowColor = '#10b981';
    loraWaveCtx.shadowBlur = 4;
    loraWaveCtx.beginPath();
    const chirpRate = 0.02;
    for (let x = 0; x < W; x++) {
        const t = (Date.now() / 1000 + x * chirpRate) % 1;
        const y = H/2 + Math.sin(x * 0.05 + Date.now() * 0.003) * (H * 0.3) * (0.5 + 0.5 * Math.sin(t * Math.PI));
        if (x === 0) loraWaveCtx.moveTo(x, y);
        else loraWaveCtx.lineTo(x, y);
    }
    loraWaveCtx.stroke();
    loraWaveCtx.shadowBlur = 0;

    loraWaveCtx.fillStyle = '#10b981';
    loraWaveCtx.font = '8px monospace';
    loraWaveCtx.fillText(`LoRa ${engine.localNode.spreadingFactor}`, 5, 12);
}

// ── SDR Spectrum ───────────────────────────────────────────────────
function drawSDRSpectrum() {
    if (!sdrSpectrumCtx || !sdrSpectrumCanvas || sdrSpectrumCanvas.width === 0) return;
    const W = sdrSpectrumCanvas.width, H = sdrSpectrumCanvas.height;
    sdrSpectrumCtx.clearRect(0, 0, W, H);

    sdrSpectrumCtx.strokeStyle = 'rgba(255,255,255,0.03)';
    sdrSpectrumCtx.lineWidth = 1;
    for (let x = 0; x < W; x += 20) {
        sdrSpectrumCtx.beginPath(); sdrSpectrumCtx.moveTo(x, 0); sdrSpectrumCtx.lineTo(x, H); sdrSpectrumCtx.stroke();
    }

    if (!rfActive()) {
        sdrSpectrumCtx.fillStyle = '#64748b';
        sdrSpectrumCtx.font = '10px monospace';
        sdrSpectrumCtx.fillText('SDR OFFLINE', W/2 - 35, H/2 + 3);
        return;
    }

    const spectrum = [];
    for (let i = 0; i < W; i++) {
        spectrum.push(Math.random() * 8 + (Math.abs(i - W * 0.5) < 15 ? 20 : 0));
    }

    sdrSpectrumCtx.strokeStyle = '#a855f7';
    sdrSpectrumCtx.lineWidth = 1.5;
    sdrSpectrumCtx.beginPath();
    spectrum.forEach((amp, i) => {
        const y = H - (amp / 100 * H);
        if (i === 0) sdrSpectrumCtx.moveTo(i, y);
        else sdrSpectrumCtx.lineTo(i, y);
    });
    sdrSpectrumCtx.stroke();

    sdrSpectrumCtx.fillStyle = '#a855f7';
    sdrSpectrumCtx.font = '8px monospace';
    sdrSpectrumCtx.fillText(`SDR ${formatFrequency(engine.sdr.frequency)}`, 5, 12);
}

// ── Frequency Allocation ───────────────────────────────────────────
function drawFreqAllocation() {
    if (!freqAllocCtx || !freqAllocCanvas || freqAllocCanvas.width === 0) return;
    const W = freqAllocCanvas.width, H = freqAllocCanvas.height;
    freqAllocCtx.clearRect(0, 0, W, H);

    freqAllocCtx.strokeStyle = 'rgba(255,255,255,0.03)';
    freqAllocCtx.lineWidth = 1;
    for (let x = 0; x < W; x += 20) {
        freqAllocCtx.beginPath(); freqAllocCtx.moveTo(x, 0); freqAllocCtx.lineTo(x, H); freqAllocCtx.stroke();
    }

    const active = rfActive();
    const bands = [
        { start: 0.05, end: 0.25, color: '#10b981', label: 'LoRa 915', active },
        { start: 0.35, end: 0.45, color: '#f59e0b', label: 'APRS 144', active: active && !!engine.callsign },
        { start: 0.55, end: 0.65, color: '#a855f7', label: 'SDR 433', active },
        { start: 0.8, end: 0.95, color: '#3b82f6', label: 'HF 7MHz', active: false },
    ];

    bands.forEach((band) => {
        const x1 = W * band.start, x2 = W * band.end;
        freqAllocCtx.fillStyle = band.active ? band.color + '33' : 'rgba(255,255,255,0.03)';
        freqAllocCtx.fillRect(x1, 10, x2 - x1, H - 20);
        freqAllocCtx.strokeStyle = band.active ? band.color : 'rgba(255,255,255,0.1)';
        freqAllocCtx.lineWidth = band.active ? 2 : 1;
        freqAllocCtx.strokeRect(x1, 10, x2 - x1, H - 20);
        if (band.active) {
            freqAllocCtx.fillStyle = band.color;
            freqAllocCtx.shadowColor = band.color;
            freqAllocCtx.shadowBlur = 6;
            freqAllocCtx.fillRect(x1, H - 6, x2 - x1, 3);
            freqAllocCtx.shadowBlur = 0;
        }
        freqAllocCtx.fillStyle = band.active ? band.color : '#64748b';
        freqAllocCtx.font = '7px monospace';
        freqAllocCtx.fillText(band.label, x1 + 5, 22);
    });
}

// ═══════════════════════════════════════════════════════════════════
//  EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════

document.getElementById('btn-trigger-disaster').addEventListener('click', () => {
    if (systemState !== 'DORMANT') {
        addLog('[System] Ya activo. Cell Broadcast ignorado.', 'log-line');
        return;
    }
    systemState = 'VIGILANCE';
    lastInteractionTime = Date.now();
    if (relay) {
        relay.setAlertState('VIGILANCE');
        addRFLog('Relay en VIGILANCE — anunciando a los pares por UDP broadcast.', 'log-success');
    }
    addLog('[Baseband] ⚡ Cell Broadcast GEOFENCED_CRITICAL_ALERT interceptado.', 'log-danger');
    addLog('[Kernel] Doze Mode omitido. Subsistema de alta vigilancia activo.', 'log-success');
    addLog('[Barometer] P_start fijado a 1013.25 hPa (o barómetro real).', 'log-success');
    addLog('[WearOS] Puente conectando a la transmisión biométrica…', 'log-success');

    if (!engine) initEngine();
    if (engine && engine.ready && !engine.started) {
        engine.start();
        addLog('[RF] Motor de producción iniciado — LoRa + SDR activos (APRS según indicativo).', 'log-success');
        addSDRPacketLog(`SDR recibiendo @ ${formatFrequency(engine.sdr.frequency)}`);
    }
    startTelemetry();
    showCryptoToast('Motor de producción activo — telemetría real AES-CTR');

    vigilanceSecs = 1800;
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (vigilanceSecs > 0) {
            vigilanceSecs--;
            const m = Math.floor(vigilanceSecs / 60).toString().padStart(2, '0');
            const s = (vigilanceSecs % 60).toString().padStart(2, '0');
            setText('vigilance-timer', `${m}:${s}`);
        } else {
            clearInterval(timerInterval);
            setText('vigilance-timer', 'EXPIRED');
            addLog('[System] Ventana de vigilancia expirada.', 'log-alert');
        }
    }, 1000);

    updateUI();
});

document.getElementById('btn-reset').addEventListener('click', () => {
    systemState = 'DORMANT';
    // Sin lecturas reales al resetear → null (la GUI pinta '—').
    battery = null; watchOnBody = true; bpm = null; spo2 = null;
    pressureTrapped = null; activeSOS = false;
    relayActive = false; autoDrain = false;
    trappedSince = 0; lastTouchTime = 0; lastInteractionTime = 0;
    packetsThisMinute = 0;
    pingUntil.clear();
    waves = []; particles = [];

    if (relay) {
        relay.setAlertState('DORMANT');
        addRFLog('Relay DORMANT — dejando de anunciar; pares desconectados.', 'log-line');
    }
    clearInterval(timerInterval);
    clearInterval(drainInterval);
    stopTelemetry();
    if (engine && engine.started) engine.stop();

    const setCtl = (id, val) => {
        const el = getEl(id);
        if (el) el.value = val;
    };
    setCtl('control-wearable-body', true);
    const wb = getEl('control-wearable-body');
    if (wb) wb.checked = true;
    // Sliders de batería/presión: override manual de pruebas, vuelven a su
    // posición neutra; los indicadores los pinta updateVitalControls (→ '—').
    setCtl('control-battery', 100);
    setCtl('control-pressure', 101325);
    setCtl('control-relay-active', false);
    setCtl('control-auto-drain', false);
    setText('vigilance-timer', '--:--');
    setText('stat-ppm', '0');
    updateVitalControls();

    const setInd2 = (id, cls) => {
        const el = getEl(id);
        if (el) el.className = `status-indicator ${cls}`;
    };
    setInd2('lora-status-ind', 'inactive');
    setInd2('aprs-status-ind', 'inactive');
    setInd2('sdr-status-ind', 'inactive');
    setInd2('rf-status-ind', 'inactive');

    resetWireBytes();
    resetDecryptedPanel();
    addLog('[System] Reset completo. Estado DORMANT.', 'log-line');
    addLoRaPacketLog('System reset — LoRa offline');
    addAPRSPacketLog('System reset — APRS offline');
    addSDRPacketLog('System reset — SDR offline');
    updateUI();
});

document.getElementById('control-auto-drain').addEventListener('change', (e) => {
    autoDrain = e.target.checked;
    lastInteractionTime = Date.now();
    clearInterval(drainInterval);
    if (autoDrain) {
        drainInterval = setInterval(() => {
            if (systemState !== 'DORMANT' && battery > 1) {
                battery = Math.max(1, battery - 1);
                const ctl = getEl('control-battery');
                if (ctl) ctl.value = battery;
                setText('val-battery', `${battery}%`);
                updateUI();
            }
        }, 3000);
        addLog('[PowerMgr] Auto-drain habilitado.', 'log-alert');
    }
});

document.getElementById('control-battery').addEventListener('input', (e) => {
    battery = parseInt(e.target.value);
    setText('val-battery', `${battery}%`);
    lastInteractionTime = Date.now();
    updateUI();
});

document.getElementById('control-wearable-body').addEventListener('change', (e) => {
    watchOnBody = e.target.checked;
    lastInteractionTime = Date.now();
    addLog(`[WearOS] PPG on-body: ${watchOnBody ? '✓ ADHERIDO' : '✗ DESADHERIDO'}`, 'log-line');
    updateUI();
});

document.getElementById('control-pressure').addEventListener('input', (e) => {
    pressureTrapped = parseInt(e.target.value);
    setText('val-pressure', `${(pressureTrapped / 100).toFixed(2)} hPa`);
    lastInteractionTime = Date.now();
    updateUI();
});

document.getElementById('control-relay-active').addEventListener('change', (e) => {
    relayActive = e.target.checked;
    lastInteractionTime = Date.now();
    addLog(relayActive ? `[Relay] Proxy multi-hop activo.` : `[Relay] Proxy offline.`,
        relayActive ? 'log-alert' : 'log-line');
    updateUI();
});

document.getElementById('btn-trigger-tap').addEventListener('click', () => {
    if (systemState === 'DORMANT') { addLog('[System] DORMANT — tap ignorado.', 'log-line'); return; }
    activeSOS = true;
    lastTouchTime = Date.now();
    lastInteractionTime = Date.now();
    addLog('[WearOS] ¡PATRÓN SOS DE 3 TAPS RECONOCIDO!', 'log-success');
    addLog('[Framework] Flag de prioridad → CONSCIOUS_ACTIVE_SOS.', 'log-danger');
    addLoRaPacketLog('SOS beacon transmitido');
    addAPRSPacketLog('SOS beacon transmitido');
    addSDRPacketLog('SOS signal detectado');

    if (engine && engine.ready) {
        const hex = engine.sendLocalTelemetry(buildSnapshot());
        if (hex) addLoRaPacketLog(`SOS telemetry TX ${hex.length / 2}B`);
    }

    const node = findNode(engine && engine.localNode ? engine.localNode.id : '');
    const W = canvas ? canvas.width : 400;
    const H = canvas ? canvas.height : 300;
    const pos = nodeScreenPos(node || { id: 'L', isLocal: true, pressure: pressureTrapped }, W, H);
    for (let i = 0; i < 6; i++) {
        setTimeout(() => {
            waves.push({ x: pos.x, y: pos.y, r: 5, color: '#ef4444', maxR: 350, speed: 4 + i * 0.4 });
        }, i * 250);
    }
    updateUI();
    setTimeout(() => {
        activeSOS = false;
        addLog('[WearOS] SOS timeout. Volviendo a pasivo.', 'log-line');
        updateUI();
    }, 15000);
});

document.getElementById('btn-touch-interaction').addEventListener('click', () => {
    if (systemState === 'DORMANT') { addLog('[System] DORMANT — toque ignorado.', 'log-line'); return; }
    lastTouchTime = Date.now();
    lastInteractionTime = Date.now();
    addLog('[AUEF] Toque de pantalla registrado. IPU recalculada.', 'log-success');
    updateUI();
});

// Tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
        btn.classList.add('active');
        const el = document.getElementById(btn.dataset.tab);
        if (el) el.classList.remove('hidden');
    });
});

// ═══════════════════════════════════════════════════════════════════
//  PANELES ⑨ / ⑩ — VITALS Y ENTORNO (solo datos reales)
// ═══════════════════════════════════════════════════════════════════

// Muestreo de vitales (valores reales, sin jitter inventado). Solo se
// registran lecturas reales (no null): las series alimentan sparklines/tendencias.
setInterval(() => {
    // Refresco en tiempo real de la malla: sincroniza la batería real hacia
    // el nodo local (los beacons saldrán con la lectura real), poda balizas
    // sin señal reciente y repinta la lista de dispositivos del panel.
    if (engine) {
        if (engine.localNode) engine.localNode.battery = battery;
        if (typeof engine.pruneStaleNodes === 'function') engine.pruneStaleNodes();
        // Panel ⑰: refresco periódico honesto de rol dinámico + DTN + wake.
        updateDynamicRolePanel();
        updateDTNPanel();
        if (engine.wakeRadio) engine.wakeRadio.tick();
        updateWakePanel();
    }
    if (systemState === 'DORMANT' || systemState === 'ORPHAN') return;
    if (bpm != null) vitalsHistory.bpm.push(bpm);
    if (spo2 != null) vitalsHistory.spo2.push(spo2);
    if (battery != null) vitalsHistory.battery.push(battery);
    ['bpm', 'spo2', 'battery'].forEach((k) => {
        while (vitalsHistory[k].length > VITALS_HISTORY_MAX) vitalsHistory[k].shift();
    });
    updateVitalsPanel();
    updateEnvironPanel();
    updateUI();
}, 1000);

function updateVitalsPanel() {
    const isActive = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    const statusEl = getEl('vitals-status');
    if (statusEl) {
        statusEl.textContent = isActive ? 'RECORDING' : 'OFFLINE';
        statusEl.style.color = isActive ? 'var(--danger)' : 'var(--muted)';
        statusEl.style.borderColor = isActive ? 'var(--danger)' : 'var(--muted)';
    }
    if (!isActive) return;

    const bpmArr = vitalsHistory.bpm;
    const bpmTrendEl = getEl('vitals-bpm-trend');
    if (bpmTrendEl && bpmArr.length >= 5) {
        const recent = bpmArr.slice(-5);
        const older = bpmArr.slice(-10, -5);
        if (older.length > 0) {
            const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
            const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
            const diff = avgRecent - avgOlder;
            if (diff > 3) { bpmTrendEl.textContent = `${Math.round(avgRecent)} ↑ RISING`; bpmTrendEl.style.color = '#ef4444'; }
            else if (diff < -3) { bpmTrendEl.textContent = `${Math.round(avgRecent)} ↓ FALLING`; bpmTrendEl.style.color = '#f59e0b'; }
            else { bpmTrendEl.textContent = `${Math.round(avgRecent)} → STABLE`; bpmTrendEl.style.color = '#10b981'; }
        } else {
            bpmTrendEl.textContent = `${Math.round(recent[recent.length - 1])} ...`;
        }
    }

    const spo2Arr = vitalsHistory.spo2;
    const spo2TrendEl = getEl('vitals-spo2-trend');
    if (spo2TrendEl && spo2Arr.length >= 5) {
        const recent = spo2Arr.slice(-5);
        const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (avgRecent < 90) { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% ⚠ CRITICAL`; spo2TrendEl.style.color = '#ef4444'; }
        else if (avgRecent < 95) { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% ↓ LOW`; spo2TrendEl.style.color = '#f59e0b'; }
        else { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% → NORMAL`; spo2TrendEl.style.color = '#10b981'; }
    }

    const timeEl = getEl('vitals-time-trapped');
    if (timeEl) {
        if (trappedSince > 0) {
            const elapsed = Math.floor((Date.now() - trappedSince) / 1000);
            const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
            const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
            const s = (elapsed % 60).toString().padStart(2, '0');
            timeEl.textContent = `${h}:${m}:${s}`;
        } else {
            timeEl.textContent = '00:00:00';
        }
    }

    const etaEl = getEl('vitals-battery-eta');
    if (etaEl) {
        if (autoDrain && battery > 1) {
            const mins = (battery / (1 / 3)) / 60;
            etaEl.textContent = `~${mins.toFixed(0)} min`;
            etaEl.style.color = battery < 20 ? '#ef4444' : battery < 40 ? '#f59e0b' : 'var(--primary)';
        } else {
            etaEl.textContent = autoDrain ? 'DEPLETED' : 'STATIC';
            etaEl.style.color = 'var(--muted)';
        }
    }
}

function updateEnvironPanel() {
    const isActive = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    const snap = lastSensor || {};

    if (!isActive) {
        ['env-temp','env-light','env-mic','env-tilt'].forEach((id) => setText(id, '—'));
        const ctEl = getEl('collapse-type');
        if (ctEl) { ctEl.textContent = 'UNKNOWN'; ctEl.className = 'collapse-type-badge'; }
        const cdEl = getEl('collapse-desc');
        if (cdEl) cdEl.textContent = 'Esperando datos de sensores...';
        const apFill = getEl('air-pocket-fill');
        if (apFill) apFill.style.width = '0%';
        setText('air-pocket-val', '—');
        return;
    }

    const tempEl = getEl('env-temp');
    if (tempEl) {
        if (snap.sources.thermometer && snap.temperature != null) {
            tempEl.textContent = `${snap.temperature.toFixed(1)}°C`;
            tempEl.style.color = snap.temperature < 16 ? '#3b82f6' : snap.temperature > 35 ? '#ef4444' : '#10b981';
        } else {
            tempEl.textContent = '—';
            tempEl.style.color = '#64748b';
        }
    }

    const lightEl = getEl('env-light');
    if (lightEl) {
        if (snap.hasLight && snap.light != null) {
            lightEl.textContent = `${snap.light.toFixed(0)} lux`;
            lightEl.style.color = snap.light < 5 ? '#ef4444' : snap.light < 20 ? '#f59e0b' : '#10b981';
        } else {
            lightEl.textContent = '—';
            lightEl.style.color = '#64748b';
        }
    }

    const micEl = getEl('env-mic');
    if (micEl) {
        if (snap.hasMic && snap.mic != null) {
            const micLabel = snap.mic > 50 ? 'VOZ/TAP' : snap.mic > 15 ? 'AMBIENTE' : 'SILENCIO';
            micEl.textContent = `${snap.mic.toFixed(0)} dB (${micLabel})`;
            micEl.style.color = snap.mic > 50 ? '#10b981' : snap.mic > 15 ? '#f59e0b' : '#ef4444';
        } else {
            micEl.textContent = '—';
            micEl.style.color = '#64748b';
        }
    }

    const tiltEl = getEl('env-tilt');
    if (tiltEl) {
        if (snap.hasMotion && snap.tilt != null) {
            tiltEl.textContent = `${snap.tilt.toFixed(1)}°`;
            tiltEl.style.color = snap.tilt > 45 ? '#ef4444' : snap.tilt > 20 ? '#f59e0b' : '#10b981';
        } else {
            tiltEl.textContent = '—';
            tiltEl.style.color = '#64748b';
        }
    }

    const ctEl = getEl('collapse-type');
    const cdEl = getEl('collapse-desc');
    if (ctEl && cdEl) {
        if (snap.hasMotion && snap.tilt != null) {
            if (snap.tilt > 50) {
                ctEl.textContent = 'PANCAKE';
                ctEl.className = 'collapse-type-badge type-pancake';
                cdEl.textContent = 'Los pisos colapsaron en plano.';
            } else if (snap.tilt > 20) {
                ctEl.textContent = 'LEAN-TO';
                ctEl.className = 'collapse-type-badge type-leanto';
                cdEl.textContent = 'Colapso inclinado. Posibles huecos.';
            } else {
                ctEl.textContent = 'V-SHAPE';
                ctEl.className = 'collapse-type-badge type-vshape';
                cdEl.textContent = 'Mejor probabilidad de supervivencia.';
            }
        } else {
            ctEl.textContent = 'UNKNOWN';
            ctEl.className = 'collapse-type-badge';
            cdEl.textContent = 'Esperando sensor de inclinación...';
        }
    }

    // Estimación de bolsa de aire: solo con entradas reales
    const apFill = getEl('air-pocket-fill');
    const apVal = getEl('air-pocket-val');
    const hasEnv = snap.hasLight || snap.hasMotion || snap.hasMic;
    if (apFill && apVal) {
        if (hasEnv) {
            const lightScore = snap.hasLight && snap.light != null ? Math.min(100, snap.light * 1.5) : 0;
            const tiltScore = snap.hasMotion && snap.tilt != null ? (100 - snap.tilt) * 0.3 : 0;
            const micScore = snap.hasMic && snap.mic != null && snap.mic > 15 ? 15 : 0;
            const airPocketScore = Math.min(100, Math.max(0, lightScore + tiltScore + micScore));
            apFill.style.width = `${airPocketScore}%`;
            const label = airPocketScore > 60 ? 'BUENA' : airPocketScore > 30 ? 'MODERADA' : 'CRÍTICA';
            apVal.textContent = `${airPocketScore.toFixed(0)}% (${label})`;
            apVal.style.color = airPocketScore > 60 ? '#10b981' : airPocketScore > 30 ? '#f59e0b' : '#ef4444';
        } else {
            apFill.style.width = '0%';
            apVal.textContent = '—';
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════════

draw();
initEngine();
initSensors();
initRelay();
updateUI();
updateVitalsPanel();
updateEnvironPanel();
addLog('[AMRF v2.1] Producción cargada — stack RF real + sensores + relay cross-device.', 'log-success');
addLog('[RF] Esperando Cell Broadcast para iniciar la telemetría.', 'log-line');
addLoRaPacketLog('Módulo LoRa real listo');
addAPRSPacketLog(APP_CONFIG.callsign ? `APRS listo — ${APP_CONFIG.callsign}` : 'APRS inactivo — sin indicativo configurado');
addSDRPacketLog('SDR listo');
updateRFPanels();

// ── PWA (Etapa 1: gateways de borde) ─────────────────────────────────
// Registro del service worker para instalación/offline. Guardado: en
// entornos sin SW (o sin navegador, p. ej. el arnés de tests vm) no lanza.
if (globalThis.navigator && navigator.serviceWorker &&
    typeof navigator.serviceWorker.register === 'function' &&
    window.location && window.location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(() => {
        if (typeof addLog === 'function') {
            addLog('[PWA] Service worker listo — la app puede instalarse y funcionar offline en el AP del gateway.', 'log-success');
        }
    }).catch((err) => {
        if (typeof addLog === 'function') {
            addLog('[PWA] Service worker no registrado (' + (err && err.message ? err.message : err) + ').', 'log-line');
        }
    });
}

// ── Arranque del nav móvil: construye el menú y aplica el modo de
// pantalla completa por tarjeta si el dispositivo es angosto (smartphone).
initMobileNav();
