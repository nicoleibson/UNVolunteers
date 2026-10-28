// ═══════════════════════════════════════════════════════════════
//  PROJECT LIFELINE CORE — Simulation Engine v1.2
//  Full E2E: trapped device state machine → ECIES packet →
//  Scout radar table with multi-node support + particle system
// ═══════════════════════════════════════════════════════════════

'use strict';

// ── Constants ────────────────────────────────────────────────────
// Las constantes físicas (R_GAS, G_GRAVITY, M_MOLAR, T_KELVIN,
// P_START_PA, IPU_THRESHOLD) viven en core_math.js (window.coreMath).
// Redeclararlas aquí como `const` global rompería la carga del navegador
// ("Identifier 'X' has already been declared"). Se usan vía coreMath.*.
const ID_ROTATE_MS  = 15000;

// ── Global state ─────────────────────────────────────────────────
let systemState   = 'DORMANT';
let battery       = 100;
let watchOnBody   = true;
let bpm           = 72;
let spo2          = 98;
let pressureTrapped = 101325;
let ipu           = 0.0;
let lastTouchTime = 0;
let activeSOS     = false;
let relayActive   = false;
let autoDrain     = false;
let vigilanceSecs = 1800;
let timerInterval = null;
let drainInterval = null;
let packetCount   = 0;
let packetsThisMinute = 0;

let ephemeralId = randomHex(4);

// ── Canvas & Particles ───────────────────────────────────────────
const canvas = document.getElementById('mesh-canvas');
const ctx    = canvas.getContext('2d');

// Panel 7 & 8 DOM Refs (must be declared before resizeCanvas)
const topCanvas      = document.getElementById('topdown-canvas');
const tctx           = topCanvas ? topCanvas.getContext('2d') : null;
const intercomLog    = document.getElementById('intercom-log');
const intercomSelect = document.getElementById('intercom-target-select');
const intercomInput  = document.getElementById('intercom-input');
const intercomSend   = document.getElementById('btn-intercom-send');

// Panel 9 & 10 DOM Refs
const vitalsCanvas   = document.getElementById('vitals-chart');
const vctx           = vitalsCanvas ? vitalsCanvas.getContext('2d') : null;

// ── Vitals History Buffer (60 seconds rolling) ───────────────────
const VITALS_HISTORY_MAX = 60;
let vitalsHistory = { bpm: [], spo2: [], battery: [] };
let trappedSince = 0;  // timestamp when disaster triggered

// ── Environmental Sensor Simulation State ─────────────────────────
let envState = { temp: 22, light: 0, mic: 0, tilt: 0 };

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
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

let waves     = [];   // BLE signal rings
let particles = [];   // Data packet dots traveling node → scout

// Scout node (moves horizontally at the surface)
let scoutX = 80, scoutDir = 1;

// ── Simulated multi-node mesh ─────────────────────────────────────
// Each node represents a trapped victim with independent vitals
const NODES = [
    {
        id: randomHex(4), color: '#ef4444',
        bpm: 78, spo2: 97, battery: 85, flags: 0x02,
        pressure: 101700, depth: -4.2, rssi: -65,
        gps: '10.4806,-66.9036',
        label: 'VICTIM A', isRelay: false,
        x: 0.35, y: 0.40   // fractional canvas position
    },
    {
        id: randomHex(4), color: '#f59e0b',
        bpm: 112, spo2: 93, battery: 42, flags: 0x02,
        pressure: 102400, depth: -10.8, rssi: -73,
        gps: '10.4808,-66.9031',
        label: 'VICTIM B', isRelay: false,
        x: 0.55, y: 0.60
    },
    {
        id: randomHex(4), color: '#8b5cf6',
        bpm: 105, spo2: 94, battery: 28, flags: 0x02,
        pressure: 103200, depth: -18.5, rssi: -85,
        gps: '10.4803,-66.9040',
        label: 'VICTIM C (RELAY)', isRelay: true,
        x: 0.70, y: 0.78
    }
];

// ── DOM Refs ─────────────────────────────────────────────────────
const logOutput      = document.getElementById('log-output');
const radarList      = document.getElementById('radar-victim-list');
const pingAllBtn     = document.getElementById('btn-ping-all');
const scannerDot     = document.getElementById('scanner-indicator');
const cryptoToast    = document.getElementById('crypto-toast');
const systemBadge    = document.getElementById('system-state-badge');
const systemPulse    = document.getElementById('system-pulse');

// (Panel 7 & 8 refs declared above, before resizeCanvas)

// ── Logging ──────────────────────────────────────────────────────
function addLog(msg, type = '') {
    const t    = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span style="color:#475569;font-size:0.6rem">[${t}]</span> ${msg}`;
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
    while (logOutput.children.length > 30) logOutput.removeChild(logOutput.firstChild);
}

// ── Math helpers ─────────────────────────────────────────────────
function calcDeltaH(pTrapped) {
    return coreMath.calcDeltaH(pTrapped);
}

function calcIPU() {
    ipu = coreMath.calcIPU({ watchOnBody, activeSOS, bpm, lastTouchTime, now: Date.now() });
    return ipu;
}

function getTriageForVitals(bpmV, spo2V, sosFlag, ipuV) {
    return coreMath.getTriageForVitals(bpmV, spo2V, sosFlag, ipuV, { watchOnBody, ipuThreshold: coreMath.IPU_THRESHOLD });
}

function randomHex(bytes) {
    return Array.from({length: bytes}, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('').toUpperCase();
}

function fakeHexBlock(n = 4) {
    return Array.from({length: n}, () => randomHex(1)).join(' ');
}

// ── State Machine ─────────────────────────────────────────────────
function resolveState() {
    return coreMath.resolveState({ ipu, battery, systemState, ipuThreshold: coreMath.IPU_THRESHOLD });
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

function updateUI() {
    calcIPU();
    const altDelta = calcDeltaH(pressureTrapped);
    const newState = resolveState();

    if (newState !== systemState && systemState !== 'DORMANT') {
        addLog(`[PowerMgr] State transition: ${systemState} → ${newState}`, 'log-alert');
    }
    if (systemState !== 'DORMANT') systemState = newState;

    const cfg = stateConfig(systemState);

    // Header badge
    systemBadge.textContent = cfg.label;
    systemBadge.className   = `badge state-${systemState.toLowerCase()}`;
    systemPulse.className   = `pulse-dot ${systemState !== 'DORMANT' && systemState !== 'ORPHAN' ? 'active' : ''}`;

    // Header stats
    document.getElementById('stat-phy').textContent   = cfg.phy;
    document.getElementById('stat-nodes').textContent =
        (systemState !== 'DORMANT' && systemState !== 'ORPHAN')
            ? (relayActive ? NODES.length : NODES.length - 1)
            : 0;

    // Radio mode badge
    const rmb = document.getElementById('radio-mode-badge');
    rmb.textContent = `PHY: ${cfg.phy}`;
    rmb.style.color = cfg.color;
    rmb.style.borderColor = cfg.color;

    // Status grid
    document.getElementById('status-radio').textContent   = cfg.label;
    document.getElementById('status-interval').textContent= cfg.interval;
    document.getElementById('status-tx-power').textContent= cfg.tx;
    document.getElementById('status-relay').textContent   =
        relayActive && systemState !== 'DORMANT' ? 'ACTIVE (HOP-1)' : 'INACTIVE';

    // IPU bar
    document.getElementById('ipu-value').textContent = ipu.toFixed(2);
    const fill = document.getElementById('ipu-fill');
    fill.style.width = `${ipu * 100}%`;
    fill.style.background = ipu < 0.4 ? '#ef4444' : ipu < 0.7 ? '#f59e0b' : 'linear-gradient(to right, #06b6d4, #10b981)';

    // Triage badge (primary node)
    const triage = getTriageForVitals(bpm, spo2, activeSOS, ipu);
    const badge  = document.getElementById('triage-badge-value');
    badge.textContent = triage.label;
    badge.className   = `triage-badge ${triage.cls}`;

    // Depth display (positive = below ground: higher trapped pressure = deeper)
    const depthM = altDelta;
    const depthEl = document.getElementById('depth-display');
    depthEl.textContent = `${depthM.toFixed(2)} m`;
    depthEl.style.color = depthM > 5 ? '#ef4444' : depthM > 1 ? '#f59e0b' : '#8b5cf6';

    // Scout interface
    const active = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    updateScoutTable(active);
    updateECIESPanel(active, triage, depthM);

    // Scanner dot animation
    if (active) {
        scannerDot.classList.add('active');
        pingAllBtn.disabled = false;
        
        if (intercomSelect && intercomSelect.disabled) {
            intercomSelect.disabled = false;
            intercomInput.disabled = false;
            intercomSend.disabled = false;
            intercomSelect.innerHTML = `<option value="ALL">BROADCAST TO ALL NODES</option>` + 
                NODES.map(n => `<option value="${n.id}">${n.label} (${n.id})</option>`).join('');
            if (intercomLog) intercomLog.innerHTML += `<div style="color:var(--primary); margin-top:8px">[SYS] Uplink established. Ready to transmit TTS.</div>`;
        }
    } else {
        scannerDot.classList.remove('active');
        pingAllBtn.disabled = true;
        
        if (intercomSelect && !intercomSelect.disabled) {
            intercomSelect.disabled = true;
            intercomInput.disabled = true;
            intercomSend.disabled = true;
            intercomSelect.innerHTML = `<option value="ALL">BROADCAST TO ALL NODES</option>`;
            if (intercomLog) intercomLog.innerHTML = `<div style="color:var(--muted)">[SYS] Uplink module offline. Awaiting distress signal.</div>`;
        }
    }
}

// ── Scout Radar Table ─────────────────────────────────────────────
function rssiPips(rssi) {
    // -50 dBm = 4 bars, -70 = 3, -80 = 2, -90+ = 1
    const bars = rssi > -60 ? 4 : rssi > -70 ? 3 : rssi > -80 ? 2 : 1;
    const pips  = Array.from({length: 4}, (_, i) =>
        `<div class="rssi-pip${i < bars ? ' active' : ''}" style="height:${(i+1)*4}px"></div>`
    ).join('');
    return `<div class="rssi-bar">${pips}<span style="margin-left:3px;color:#64748b;font-size:0.58rem">${rssi}</span></div>`;
}

function updateScoutTable(active) {
    if (!active) {
        radarList.innerHTML = `<tr><td colspan="8" class="text-center text-muted">
            No beacons detected — trigger a P-Wave alert to start scanning.
        </td></tr>`;
        return;
    }

    // Build primary node from live controls
    const primaryTriage = getTriageForVitals(bpm, spo2, activeSOS, ipu);
    const primaryDepthM = calcDeltaH(pressureTrapped);
    const primaryNode = {
        id: ephemeralId,
        label: 'VICTIM A (LIVE)',
        triage: primaryTriage,
        depthM: primaryDepthM,
        gps: '10.4806,-66.9036',
        bpmV: bpm, spo2V: spo2,
        rssi: -65, battery: battery,
        isRelay: false, isLive: true
    };

    // Static sim nodes (always visible when active)
    const simNodes = NODES.slice(1).map((n, i) => {
        const tr = getTriageForVitals(n.bpm, n.spo2, false, 0.80);
        return {
            id: n.id, label: n.label,
            triage: tr,
            depthM: calcDeltaH(n.pressure),
            gps: n.gps,
            bpmV: n.bpm, spo2V: n.spo2,
            rssi: n.rssi, battery: n.battery,
            isRelay: n.isRelay, isLive: false
        };
    });

    // Include relay node only if toggle is on
    const allNodes = [primaryNode, ...simNodes.slice(0, relayActive ? 2 : 1)];

    // Sort by triage priority (RED first)
    allNodes.sort((a, b) => b.triage.code - a.triage.code || a.triage.code - b.triage.code);

    radarList.innerHTML = allNodes.map(node => `
        <tr>
            <td class="node-id${node.isRelay ? ' relayed' : ''}">${node.id}
                ${node.isLive ? '<span style="color:#06b6d4;font-size:0.55rem;margin-left:4px">◉ LIVE</span>' : ''}
                ${node.isRelay ? '<span style="color:#8b5cf6;font-size:0.55rem;margin-left:4px">◈ VIA HOP</span>' : ''}
            </td>
            <td><span class="triage-badge ${node.triage.cls}">${node.triage.label}</span></td>
            <td style="color:${node.depthM > 10 ? '#ef4444' : '#f59e0b'}">${node.depthM.toFixed(1)} m ↓</td>
            <td style="font-size:0.62rem;color:#64748b">${node.gps}</td>
            <td>${node.bpmV} BPM / ${node.spo2V}% SpO₂</td>
            <td>${rssiPips(node.rssi)}</td>
            <td style="color:${node.battery < 20 ? '#ef4444' : node.battery < 40 ? '#f59e0b' : '#10b981'}">${node.battery}%</td>
            <td><button class="btn btn-sm btn-primary" onclick="pingNode('${node.id}',${node.isRelay})">📡 PING</button></td>
        </tr>
    `).join('');
}

// ── ECIES Packet Visualizer ───────────────────────────────────────
let eciesAnimTimer = null;

function updateECIESPanel(active, triage, depthM) {
    const statusEl = document.getElementById('ecies-status');

    if (!active) {
        statusEl.textContent = 'IDLE';
        statusEl.style.color = '';
        statusEl.style.borderColor = '';
        resetECIESBytes();
        resetDecryptedPanel();
        return;
    }

    statusEl.textContent   = 'LIVE CAPTURE';
    statusEl.style.color   = '#8b5cf6';
    statusEl.style.borderColor = '#8b5cf6';
}

function animateECIESCapture(triage, depthM) {
    // Phase 1: show encrypted bytes
    document.getElementById('seg-ephpub').classList.add('active');
    document.getElementById('seg-iv').classList.add('active');
    document.getElementById('seg-cipher').classList.add('active');
    document.getElementById('seg-tag').classList.add('active');

    document.getElementById('bytes-ephpub').textContent = fakeHexBlock(4) + ' ' + fakeHexBlock(4);
    document.getElementById('bytes-ephpub').classList.add('encrypted');
    document.getElementById('bytes-iv').textContent     = fakeHexBlock(4) + ' ' + fakeHexBlock(2);
    document.getElementById('bytes-iv').classList.add('encrypted');
    document.getElementById('bytes-cipher').textContent = fakeHexBlock(4) + ' ··· ' + fakeHexBlock(4);
    document.getElementById('bytes-cipher').classList.add('encrypted');
    document.getElementById('bytes-tag').textContent    = fakeHexBlock(4) + ' ' + fakeHexBlock(4);
    document.getElementById('bytes-tag').classList.add('encrypted');

    const baseCipherLen = 1 + bpm.toString().length + 1 + 1 + 1 + 4 + 16;
    // Si Multi-Hop está activo, agregamos el peso de un paquete ECIES completo adicional
    const relayExtraLen = relayActive ? 75 : 0; 
    const cipherLen = baseCipherLen + relayExtraLen;
    
    document.getElementById('size-cipher').textContent  = `~${cipherLen + 31} bytes · AES-GCM-256`;

    addLog(`[ECIES] Captured wire packet from ${ephemeralId} — ${60 + cipherLen} bytes encrypted${relayActive ? ' (MULTI-HOP BUNDLE)' : ''}`, 'log-alert');

    // Phase 2: decrypt after 1.2s
    setTimeout(() => {
        ['seg-ephpub','seg-iv','seg-cipher','seg-tag'].forEach(id =>
            document.getElementById(id).classList.replace('active', 'decoded')
        );
        ['bytes-ephpub','bytes-iv','bytes-cipher','bytes-tag'].forEach(id => {
            document.getElementById(id).classList.remove('encrypted');
            document.getElementById(id).classList.add('clear');
        });

        // Show decrypted values
        document.getElementById('dec-gps').textContent   = `${bpm > 60 ? '10.4806,-66.9036' : '?'}`;
        document.getElementById('dec-bpm').textContent   = `${bpm} BPM`;
        document.getElementById('dec-spo2').textContent  = `${spo2}%`;
        document.getElementById('dec-depth').textContent = `${depthM.toFixed(1)} m`;

        const decTriage = document.getElementById('dec-triage');
        decTriage.innerHTML = `<span class="triage-badge ${triage.cls}">${triage.label}</span>`;

        addLog(`[ScoutDecoder] Packet decrypted OK — BPM:${bpm} SpO₂:${spo2}% Depth:${depthM.toFixed(1)}m → ${triage.label}`, 'log-success');
        if (relayActive) {
            addLog(`[ScoutDecoder] ◈ Nested payload found in cache! Decrypting secondary node...`, 'log-alert');
            setTimeout(() => {
                addLog(`[ScoutDecoder] ◈ Secondary node (ID: ${NODES[2].id}) decrypted. Extracted from multi-hop proxy.`, 'log-success');
            }, 600);
        }

        // Phase 3: clear after 5s
        setTimeout(() => {
            resetECIESSegments();
        }, 5000 + (relayActive ? 1500 : 0));
    }, 1200);
}

function resetECIESBytes() {
    ['bytes-ephpub','bytes-iv','bytes-cipher','bytes-tag'].forEach(id => {
        document.getElementById(id).textContent = '-- -- -- --';
        document.getElementById(id).classList.remove('encrypted','clear');
    });
    ['seg-ephpub','seg-iv','seg-cipher','seg-tag'].forEach(id =>
        document.getElementById(id).classList.remove('active','decoded')
    );
}

function resetECIESSegments() {
    resetECIESBytes();
}

function resetDecryptedPanel() {
    ['dec-gps','dec-bpm','dec-spo2','dec-depth'].forEach(id =>
        document.getElementById(id).textContent = '—'
    );
    document.getElementById('dec-triage').innerHTML =
        '<span class="triage-badge triage-green">—</span>';
}

// ── Acoustic Locator ──────────────────────────────────────────────
window.pingNode = function(nodeId, isRelay) {
    if (systemState === 'DORMANT' || systemState === 'ORPHAN') return;

    addLog(`[Scout] Sending signed acoustic ping to node ${nodeId}…`, 'log-alert');

    setTimeout(() => {
        addLog(`[SecurityEngine] Validating Ed25519 signature against GOVT_PK…`, 'log-alert');
    }, 300);

    setTimeout(() => {
        addLog(`[SecurityEngine] ✓ Timestamp within ±5 min replay window. Signature valid.`, 'log-success');
        addLog(`[HardwareAudio] Playing 18 kHz chirp. Vibrator SOS pattern engaged on ${nodeId}.`, 'log-success');

        // Burst ping waves on primary victim position
        const node = NODES.find(n => n.id === nodeId) || NODES[0];
        
        // Trigger the visual shake effect on the canvas for 2.5 seconds
        node.pingUntil = Date.now() + 2500;
        
        const nx   = canvas.width  * node.x;
        const ny   = canvas.height * node.y;
        for (let i = 0; i < 7; i++) {
            setTimeout(() => {
                waves.push({ x: nx, y: ny, r: 8, color: '#06b6d4', maxR: 400, speed: 5 });
            }, i * 180);
        }
    }, 900);
};

document.getElementById('btn-ping-all').addEventListener('click', () => {
    NODES.forEach((n, i) => {
        setTimeout(() => window.pingNode(n.id, n.isRelay), i * 500);
    });
});

if (intercomSend) {
    intercomSend.addEventListener('click', () => {
        const msg = intercomInput.value.trim();
        if (!msg) return;
        const target = intercomSelect.value;
        const targetName = target === 'ALL' ? 'ALL NODES' : target;
        
        const time = new Date().toLocaleTimeString();
        intercomLog.innerHTML += `<div style="margin-top:4px"><span style="color:var(--muted)">[${time}]</span> <span style="color:var(--primary)">SCOUT → ${targetName}:</span> <span style="color:var(--text)">${msg}</span></div>`;
        intercomLog.scrollTop = intercomLog.scrollHeight;
        intercomInput.value = '';
        
        addLog(`[Uplink] Transmitting TTS payload to ${targetName} via BLE Coded PHY.`, 'log-alert');
        setTimeout(() => {
            addLog(`[SecurityEngine] Command signed and verified by node(s).`, 'log-success');
            if (target === 'ALL') {
                NODES.forEach(n => { n.pingUntil = Date.now() + 1500; });
            } else {
                const node = NODES.find(n => n.id === target);
                if (node) node.pingUntil = Date.now() + 1500;
            }
        }, 800);
    });
    
    intercomInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') intercomSend.click();
    });
}

// ── Canvas Rendering Loop ─────────────────────────────────────────
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grid
    ctx.strokeStyle = 'rgba(6,182,212,0.03)';
    ctx.lineWidth   = 1;
    for (let x = 0; x < canvas.width; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 32) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Rubble block
    const rtop = 90, rheight = canvas.height - 150;
    ctx.fillStyle   = 'rgba(15,23,42,0.5)';
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.roundRect(20, rtop, canvas.width - 40, rheight, 4); ctx.fill(); ctx.stroke();

    // Crack lines in rubble
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.setLineDash([6,10]);
    [[0.1,0.15,0.85,0.35],[0.3,0.45,0.7,0.65],[0.5,0.2,0.9,0.55]].forEach(([x1,y1,x2,y2]) => {
        ctx.beginPath();
        ctx.moveTo(canvas.width * x1, rtop + rheight * y1);
        ctx.lineTo(canvas.width * x2, rtop + rheight * y2);
        ctx.stroke();
    });
    ctx.setLineDash([]);

    // Scout (moves at surface)
    scoutX += 1.2 * scoutDir;
    if (scoutX > canvas.width - 60 || scoutX < 60) scoutDir *= -1;

    const sy = 55;
    ctx.fillStyle = '#06b6d4';
    ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(scoutX, sy, 11, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Scanner cone from Scout
    if (systemState !== 'DORMANT' && systemState !== 'ORPHAN') {
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

    // Draw victim nodes
    NODES.forEach((node, idx) => {
        // Only show relay node when toggle is active
        if (node.isRelay && !relayActive) return;
        if (systemState === 'DORMANT' || systemState === 'ORPHAN') return;

        const nx = canvas.width  * node.x;
        const ny = canvas.height * node.y;

        // Update primary node's position based on live pressure slider
        // (depth > 0 = below ground; above-ground victims stay at the surface)
        if (idx === 0) {
            const liveDepth  = calcDeltaH(pressureTrapped);
            const depthRatio = Math.min(1.0, Math.max(0, liveDepth / 30));
            node.y = 0.30 + depthRatio * 0.50;
        }

        let fnx = canvas.width  * node.x;
        let fny = canvas.height * node.y;

        // Acoustic Locator Shake effect
        if (node.pingUntil && Date.now() < node.pingUntil) {
            fnx += (Math.random() - 0.5) * 8;
            fny += (Math.random() - 0.5) * 8;
        }

        // Relay link line
        if (node.isRelay) {
            const prevNode = NODES[idx - 1];
            ctx.strokeStyle = 'rgba(139,92,246,0.35)';
            ctx.setLineDash([5,8]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(fnx, fny);
            ctx.lineTo(canvas.width * prevNode.x, canvas.height * prevNode.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Determine color from live triage (only for primary node)
        let nColor = node.color;
        if (idx === 0) {
            const tr = getTriageForVitals(bpm, spo2, activeSOS, ipu);
            nColor = tr.code === 0 ? '#10b981' : tr.code === 1 ? '#f59e0b' : tr.code === 2 ? '#ef4444' : '#475569';
        }

        // Node glow pulse
        const pulse = Math.sin(Date.now() / 300 + idx) * 4;
        ctx.strokeStyle = nColor + '55';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(fnx, fny, 14 + pulse, 0, Math.PI * 2); ctx.stroke();

        ctx.fillStyle   = nColor;
        ctx.shadowColor = nColor; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.arc(fnx, fny, 7, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur  = 0;

        // Label
        ctx.fillStyle = '#e2e8f0';
        ctx.font      = '8px monospace';
        ctx.fillText(idx === 0 ? `${node.label} (LIVE)` : node.label, fnx + 12, fny + 3);
        ctx.fillStyle = '#64748b';
        ctx.fillText(node.id, fnx + 12, fny + 13);

        // Depth indicator line
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(fnx, rtop); ctx.lineTo(fnx, fny); ctx.stroke();

        // BLE Wave emission
        const emitChance = systemState === 'VIGILANCE' ? 0.008
                         : systemState === 'ECO'       ? 0.004
                         :                               0.002;

        if (Math.random() < emitChance) {
            const wColor = node.isRelay ? '#8b5cf6' : (idx === 0 ? '#06b6d4' : '#f59e0b');
            waves.push({ x: fnx, y: fny, r: 5, color: wColor, maxR: 280, speed: 2.5 });

            // Launch data packet dot toward scout
            spawnPacket(fnx, fny, scoutX, sy, nColor);
        }
    });

    // Animate waves
    for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        w.r += w.speed;
        const alpha = 1 - w.r / w.maxR;
        ctx.strokeStyle = w.color;
        ctx.lineWidth   = Math.max(0.3, 2 * alpha);
        ctx.shadowColor = w.color;
        ctx.shadowBlur  = 6;
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur  = 0;
        if (w.r >= w.maxR) waves.splice(i, 1);
    }

    // Animate data packet dots
    for (let i = particles.length - 1; i >= 0; i--) {
        const p   = particles[i];
        p.progress += p.speed;
        const t  = p.progress;
        const px = p.x0 + (p.x1 - p.x0) * t;
        const py = p.y0 + (p.y1 - p.y0) * t - Math.sin(t * Math.PI) * 30; // arc path

        ctx.fillStyle   = p.color;
        ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur  = 0;

        // On arrival at scout
        if (t >= 1.0) {
            particles.splice(i, 1);
            packetCount++;
            packetsThisMinute++;
            document.getElementById('stat-ppm').textContent = packetsThisMinute;

            // Trigger ECIES animation occasionally
            if (Math.random() < 0.3 && systemState !== 'DORMANT') {
                showCryptoToast();
                const tr = getTriageForVitals(bpm, spo2, activeSOS, ipu);
                const dh = Math.abs(calcDeltaH(pressureTrapped));
                animateECIESCapture(tr, dh);
            }
        }

        if (p.progress > 1.2) particles.splice(i, 1); // safety cleanup
    }

    // ── TOP-DOWN MAP RENDERING ──
    if (tctx && topCanvas.width > 0) {
        tctx.clearRect(0, 0, topCanvas.width, topCanvas.height);
        
        // Map Grid
        tctx.strokeStyle = 'rgba(255,255,255,0.03)';
        tctx.lineWidth = 1;
        for (let x = 0; x < topCanvas.width; x += 40) {
            tctx.beginPath(); tctx.moveTo(x, 0); tctx.lineTo(x, topCanvas.height); tctx.stroke();
        }
        for (let y = 0; y < topCanvas.height; y += 40) {
            tctx.beginPath(); tctx.moveTo(0, y); tctx.lineTo(topCanvas.width, y); tctx.stroke();
        }
        
        // Epicenter indicator
        tctx.fillStyle = 'rgba(239, 68, 68, 0.05)';
        tctx.beginPath(); tctx.arc(topCanvas.width/2, topCanvas.height/2, 40 + Math.sin(Date.now()/500)*5, 0, Math.PI*2); tctx.fill();
        tctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
        tctx.font = '8px monospace';
        tctx.fillText("EPICENTER", topCanvas.width/2 - 20, topCanvas.height/2 + 3);
        
        if (systemState !== 'DORMANT' && systemState !== 'ORPHAN') {
            // Draw nodes
            NODES.forEach((node, idx) => {
                if (node.isRelay && !relayActive) return;
                
                // Map fractional x/y to a polar coordinate around the epicenter
                const angle = node.x * Math.PI * 2;
                const distance = node.y * topCanvas.height * 0.4;
                
                let tx = topCanvas.width/2 + Math.cos(angle) * distance;
                let ty = topCanvas.height/2 + Math.sin(angle) * distance;
                
                // Shake if pinged
                if (node.pingUntil && Date.now() < node.pingUntil) {
                    tx += (Math.random() - 0.5) * 4;
                    ty += (Math.random() - 0.5) * 4;
                }
                
                let nColor = node.color;
                if (idx === 0) {
                    const tr = getTriageForVitals(bpm, spo2, activeSOS, ipu);
                    nColor = tr.code === 0 ? '#10b981' : tr.code === 1 ? '#f59e0b' : tr.code === 2 ? '#ef4444' : '#475569';
                }
                
                // Node pulse
                tctx.strokeStyle = nColor + '66';
                tctx.lineWidth = 1.5;
                tctx.beginPath(); tctx.arc(tx, ty, 8 + (Math.sin(Date.now()/200 + idx)*2), 0, Math.PI*2); tctx.stroke();
                
                // Node core
                tctx.fillStyle = nColor;
                tctx.beginPath(); tctx.arc(tx, ty, 4, 0, Math.PI*2); tctx.fill();
                
                // Label
                tctx.fillStyle = '#e2e8f0';
                tctx.font = '9px monospace';
                tctx.fillText(node.id, tx + 8, ty + 3);
            });
            
            // Draw Scout (UAV) orbiting
            tctx.fillStyle = '#06b6d4';
            const sx = topCanvas.width/2 + Math.cos(Date.now()/3000) * (topCanvas.width/3);
            const sy = topCanvas.height/2 + Math.sin(Date.now()/2500) * (topCanvas.height/3);
            tctx.beginPath(); tctx.arc(sx, sy, 5, 0, Math.PI*2); tctx.fill();
            tctx.fillText("UAV", sx + 8, sy + 3);
            
            // Line from Scout to Epicenter/Primary
            tctx.strokeStyle = 'rgba(6,182,212,0.2)';
            tctx.setLineDash([3, 4]);
            tctx.beginPath(); 
            tctx.moveTo(sx, sy); 
            tctx.lineTo(topCanvas.width/2, topCanvas.height/2);
            tctx.stroke();
            tctx.setLineDash([]);
        }
    }

    // ── VITALS SPARKLINE CHART ──
    drawVitalsSparklines();

    requestAnimationFrame(draw);
}

function spawnPacket(x0, y0, x1, y1, color) {
    particles.push({ x0, y0, x1, y1, progress: 0, speed: 0.012 + Math.random() * 0.006, color });
}

function showCryptoToast() {
    cryptoToast.classList.add('visible');
    document.getElementById('crypto-toast-text').textContent =
        `🔒 ECIES packet captured (${60 + Math.floor(Math.random()*20)}B) — decrypting…`;
    setTimeout(() => cryptoToast.classList.remove('visible'), 2800);
}

// Packets per minute counter (reset every 60s)
setInterval(() => { packetsThisMinute = 0; }, 60000);

// ── Event Handlers ────────────────────────────────────────────────

// Trigger disaster
document.getElementById('btn-trigger-disaster').addEventListener('click', () => {
    if (systemState !== 'DORMANT') {
        addLog('[System] Already in active vigilance. Cell Broadcast ignored.', 'log-line');
        return;
    }
    systemState = 'VIGILANCE';
    addLog('[Baseband] ⚡ Cell Broadcast GEOFENCED_CRITICAL_ALERT intercepted.', 'log-danger');
    addLog('[Kernel] Doze Mode bypassed. High-Vigilance subsystem awake.', 'log-success');
    addLog('[Barometer] P_start locked at 1013.25 hPa as ground reference.', 'log-success');
    addLog('[WearOS] Bridge connecting to biometric sensor stream…', 'log-success');

    // Start 30-min countdown
    vigilanceSecs = 1800;
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (vigilanceSecs > 0) {
            vigilanceSecs--;
            const m = Math.floor(vigilanceSecs / 60).toString().padStart(2, '0');
            const s = (vigilanceSecs % 60).toString().padStart(2, '0');
            document.getElementById('vigilance-timer').textContent = `${m}:${s}`;
        } else {
            clearInterval(timerInterval);
            document.getElementById('vigilance-timer').textContent = 'EXPIRED';
            addLog('[System] High-Vigilance window expired. Entering passive cycle.', 'log-alert');
        }
    }, 1000);

    // Ephemeral ID rotation
    setInterval(() => {
        if (systemState !== 'DORMANT') {
            ephemeralId = randomHex(4);
            NODES.forEach(n => { n.id = randomHex(4); });
            addLog(`[StrongBox] MAC + Ephemeral ID rotated → ${ephemeralId}`, 'log-line');
        }
    }, ID_ROTATE_MS);

    updateUI();
});

// Reset
document.getElementById('btn-reset').addEventListener('click', () => {
    systemState = 'DORMANT';
    battery = 100; watchOnBody = true; bpm = 72; spo2 = 98;
    pressureTrapped = 101325; lastTouchTime = 0; activeSOS = false;
    relayActive = false; autoDrain = false; waves = []; particles = [];
    packetsThisMinute = 0; packetCount = 0;

    clearInterval(timerInterval);
    clearInterval(drainInterval);

    document.getElementById('control-battery').value = 100;
    document.getElementById('val-battery').textContent = '100%';
    document.getElementById('control-wearable-body').checked = true;
    document.getElementById('control-bpm').value = 72;
    document.getElementById('val-bpm').textContent = '72 BPM';
    document.getElementById('control-spo2').value = 98;
    document.getElementById('val-spo2').textContent = '98%';
    document.getElementById('control-pressure').value = 101325;
    document.getElementById('val-pressure').textContent = '1013.25 hPa';
    document.getElementById('control-relay-active').checked = false;
    document.getElementById('control-auto-drain').checked = false;
    document.getElementById('vigilance-timer').textContent = '--:--';
    document.getElementById('stat-ppm').textContent = '0';

    resetECIESBytes();
    resetDecryptedPanel();
    addLog('[System] Reset complete. Returning to DORMANT state.', 'log-line');
    updateUI();
});

// Auto-drain battery
document.getElementById('control-auto-drain').addEventListener('change', e => {
    autoDrain = e.target.checked;
    clearInterval(drainInterval);
    if (autoDrain) {
        drainInterval = setInterval(() => {
            if (systemState !== 'DORMANT' && battery > 1) {
                battery = Math.max(1, battery - 1);
                document.getElementById('control-battery').value = battery;
                document.getElementById('val-battery').textContent = `${battery}%`;
                updateUI();
            }
        }, 3000);
        addLog('[PowerMgr] Auto-drain enabled. Battery depleting at 1%/3s to simulate field use.', 'log-alert');
    }
});

// Sliders
document.getElementById('control-battery').addEventListener('input', e => {
    battery = parseInt(e.target.value);
    document.getElementById('val-battery').textContent = `${battery}%`;
    updateUI();
});

document.getElementById('control-wearable-body').addEventListener('change', e => {
    watchOnBody = e.target.checked;
    addLog(`[WearOS] PPG on-body: ${watchOnBody ? '✓ ATTACHED' : '✗ DETACHED'}`, 'log-line');
    updateUI();
});

document.getElementById('control-bpm').addEventListener('input', e => {
    bpm = parseInt(e.target.value);
    document.getElementById('val-bpm').textContent = `${bpm} BPM`;
    updateUI();
});

document.getElementById('control-spo2').addEventListener('input', e => {
    spo2 = parseInt(e.target.value);
    document.getElementById('val-spo2').textContent = `${spo2}%`;
    updateUI();
});

document.getElementById('control-pressure').addEventListener('input', e => {
    pressureTrapped = parseInt(e.target.value);
    document.getElementById('val-pressure').textContent = `${(pressureTrapped / 100).toFixed(2)} hPa`;
    updateUI();
});

document.getElementById('control-relay-active').addEventListener('change', e => {
    relayActive = e.target.checked;
    addLog(relayActive
        ? `[Relay] Intercepted payload from deep node ${NODES[2].id}. Multi-hop proxy active.`
        : `[Relay] Deep node ${NODES[2].id} offline. Cache cleared.`, relayActive ? 'log-alert' : 'log-line');
    updateUI();
});

// SOS Tap
document.getElementById('btn-trigger-tap').addEventListener('click', () => {
    if (systemState === 'DORMANT') { addLog('[System] DORMANT — tap ignored.', 'log-line'); return; }
    activeSOS = true;
    addLog('[WearOS] 3-TAP SOS PATTERN RECOGNIZED by kinematic high-pass filter!', 'log-success');
    addLog('[Framework] Priority flag → CONSCIOUS_ACTIVE_SOS. Elevating BLE power.', 'log-danger');

    for (let i = 0; i < 6; i++) {
        setTimeout(() => {
            waves.push({ x: canvas.width * NODES[0].x, y: canvas.height * NODES[0].y,
                         r: 5, color: '#ef4444', maxR: 350, speed: 4 + i * 0.4 });
        }, i * 250);
    }
    updateUI();
    setTimeout(() => {
        activeSOS = false;
        addLog('[WearOS] SOS classifier timeout. Returning to passive monitoring.', 'log-line');
        updateUI();
    }, 15000);
});

// Screen touch
document.getElementById('btn-touch-interaction').addEventListener('click', () => {
    if (systemState === 'DORMANT') { addLog('[System] DORMANT — touch ignored.', 'log-line'); return; }
    lastTouchTime = Date.now();
    addLog('[AUEF] Screen touch registered. I_touch → 1.0. IPU recalculated.', 'log-success');
    updateUI();
});

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
});

// ── Kickstart ─────────────────────────────────────────────────────
draw();
updateUI();
updateVitalsPanel();
updateEnvironPanel();
addLog('[AMRF v1.2] Simulation environment loaded. Press ⚡ TRIGGER P-WAVE to begin.', 'log-success');

// ── Vitals Sampling Timer (1 sample per second) ───────────────────
setInterval(() => {
    if (systemState === 'DORMANT' || systemState === 'ORPHAN') return;
    vitalsHistory.bpm.push(bpm + (Math.random() - 0.5) * 4);
    vitalsHistory.spo2.push(spo2 + (Math.random() - 0.5) * 1.5);
    vitalsHistory.battery.push(battery);
    if (vitalsHistory.bpm.length > VITALS_HISTORY_MAX) {
        vitalsHistory.bpm.shift();
        vitalsHistory.spo2.shift();
        vitalsHistory.battery.shift();
    }
    // Drift environmental sensors
    const depth = Math.abs(calcDeltaH(pressureTrapped));
    envState.temp = Math.max(12, 22 - depth * 0.4 + (Math.random() - 0.5) * 0.3);
    envState.light = Math.max(0, Math.min(50, 50 - depth * 3 + (Math.random() - 0.5) * 2));
    envState.mic = activeSOS ? 70 + Math.random() * 15 : (Math.random() < 0.1 ? 20 + Math.random() * 10 : 5 + Math.random() * 8);
    envState.tilt = Math.min(90, depth * 2.5 + (Math.random() - 0.5) * 3);
    
    // Refresh telemetry panels with the latest samples
    updateVitalsPanel();
    updateEnvironPanel();
}, 1000);

// ── Vitals Panel Update ───────────────────────────────────────────
function updateVitalsPanel() {
    const isActive = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    const statusEl = document.getElementById('vitals-status');
    if (statusEl) {
        statusEl.textContent = isActive ? 'RECORDING' : 'OFFLINE';
        statusEl.style.color = isActive ? 'var(--danger)' : 'var(--muted)';
        statusEl.style.borderColor = isActive ? 'var(--danger)' : 'var(--muted)';
    }
    if (!isActive) return;

    // BPM trend
    const bpmArr = vitalsHistory.bpm;
    const bpmTrendEl = document.getElementById('vitals-bpm-trend');
    if (bpmTrendEl && bpmArr.length >= 5) {
        const recent = bpmArr.slice(-5);
        const older  = bpmArr.slice(-10, -5);
        if (older.length > 0) {
            const avgRecent = recent.reduce((a,b) => a+b, 0) / recent.length;
            const avgOlder  = older.reduce((a,b) => a+b, 0) / older.length;
            const diff = avgRecent - avgOlder;
            if (diff > 3) { bpmTrendEl.textContent = `${Math.round(avgRecent)} ↑ RISING`; bpmTrendEl.style.color = '#ef4444'; }
            else if (diff < -3) { bpmTrendEl.textContent = `${Math.round(avgRecent)} ↓ FALLING`; bpmTrendEl.style.color = '#f59e0b'; }
            else { bpmTrendEl.textContent = `${Math.round(avgRecent)} → STABLE`; bpmTrendEl.style.color = '#10b981'; }
        } else {
            bpmTrendEl.textContent = `${Math.round(recent[recent.length-1])} ...`;
        }
    }

    // SpO2 trend
    const spo2Arr = vitalsHistory.spo2;
    const spo2TrendEl = document.getElementById('vitals-spo2-trend');
    if (spo2TrendEl && spo2Arr.length >= 5) {
        const recent = spo2Arr.slice(-5);
        const avgRecent = recent.reduce((a,b) => a+b, 0) / recent.length;
        if (avgRecent < 90) { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% ⚠ CRITICAL`; spo2TrendEl.style.color = '#ef4444'; }
        else if (avgRecent < 95) { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% ↓ LOW`; spo2TrendEl.style.color = '#f59e0b'; }
        else { spo2TrendEl.textContent = `${avgRecent.toFixed(1)}% → NORMAL`; spo2TrendEl.style.color = '#10b981'; }
    }

    // Time trapped
    const timeEl = document.getElementById('vitals-time-trapped');
    if (timeEl && trappedSince > 0) {
        const elapsed = Math.floor((Date.now() - trappedSince) / 1000);
        const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const s = (elapsed % 60).toString().padStart(2, '0');
        timeEl.textContent = `${h}:${m}:${s}`;
    }

    // Battery ETA
    const etaEl = document.getElementById('vitals-battery-eta');
    if (etaEl) {
        if (autoDrain && battery > 1) {
            const hoursLeft = (battery / (1/3)) / 3600; // 1% per 3s
            etaEl.textContent = `~${(hoursLeft * 3600 / 60).toFixed(0)} min`;
            etaEl.style.color = battery < 20 ? '#ef4444' : battery < 40 ? '#f59e0b' : 'var(--primary)';
        } else {
            etaEl.textContent = autoDrain ? 'DEPLETED' : 'STATIC';
            etaEl.style.color = 'var(--muted)';
        }
    }
}

// ── Environment Panel Update ──────────────────────────────────────
function updateEnvironPanel() {
    const isActive = systemState !== 'DORMANT' && systemState !== 'ORPHAN';
    if (!isActive) {
        ['env-temp','env-light','env-mic','env-tilt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });
        const ctEl = document.getElementById('collapse-type');
        if (ctEl) { ctEl.textContent = 'UNKNOWN'; ctEl.className = 'collapse-type-badge'; }
        const cdEl = document.getElementById('collapse-desc');
        if (cdEl) cdEl.textContent = 'Awaiting accelerometer data...';
        const apFill = document.getElementById('air-pocket-fill');
        if (apFill) apFill.style.width = '0%';
        const apVal = document.getElementById('air-pocket-val');
        if (apVal) apVal.textContent = '—';
        return;
    }

    const tempEl = document.getElementById('env-temp');
    if (tempEl) {
        tempEl.textContent = `${envState.temp.toFixed(1)}°C`;
        tempEl.style.color = envState.temp < 16 ? '#3b82f6' : envState.temp > 35 ? '#ef4444' : '#10b981';
    }
    const lightEl = document.getElementById('env-light');
    if (lightEl) {
        lightEl.textContent = `${envState.light.toFixed(0)} lux`;
        lightEl.style.color = envState.light < 5 ? '#ef4444' : envState.light < 20 ? '#f59e0b' : '#10b981';
    }
    const micEl = document.getElementById('env-mic');
    if (micEl) {
        const micLabel = envState.mic > 50 ? 'VOICE/TAP' : envState.mic > 15 ? 'AMBIENT' : 'SILENT';
        micEl.textContent = `${envState.mic.toFixed(0)} dB (${micLabel})`;
        micEl.style.color = envState.mic > 50 ? '#10b981' : envState.mic > 15 ? '#f59e0b' : '#ef4444';
    }
    const tiltEl = document.getElementById('env-tilt');
    if (tiltEl) {
        tiltEl.textContent = `${envState.tilt.toFixed(1)}°`;
        tiltEl.style.color = envState.tilt > 45 ? '#ef4444' : envState.tilt > 20 ? '#f59e0b' : '#10b981';
    }

    // Collapse type derived from tilt + depth
    const depth = Math.abs(calcDeltaH(pressureTrapped));
    const ctEl = document.getElementById('collapse-type');
    const cdEl = document.getElementById('collapse-desc');
    if (ctEl && cdEl) {
        if (envState.tilt > 50) {
            ctEl.textContent = 'PANCAKE';
            ctEl.className = 'collapse-type-badge type-pancake';
            cdEl.textContent = 'Floors collapsed flat. Horizontal excavation required.';
        } else if (envState.tilt > 20) {
            ctEl.textContent = 'LEAN-TO';
            ctEl.className = 'collapse-type-badge type-leanto';
            cdEl.textContent = 'Angled collapse. Possible survivable void spaces.';
        } else {
            ctEl.textContent = 'V-SHAPE';
            ctEl.className = 'collapse-type-badge type-vshape';
            cdEl.textContent = 'V-shaped void. Best survival probability.';
        }
    }

    // Air pocket estimation (light + pressure stability)
    const airPocketScore = Math.min(100, Math.max(0, envState.light * 1.5 + (100 - envState.tilt) * 0.3 + (envState.mic > 15 ? 15 : 0)));
    const apFill = document.getElementById('air-pocket-fill');
    const apVal = document.getElementById('air-pocket-val');
    if (apFill) apFill.style.width = `${airPocketScore}%`;
    if (apVal) {
        const label = airPocketScore > 60 ? 'GOOD' : airPocketScore > 30 ? 'MODERATE' : 'CRITICAL';
        apVal.textContent = `${airPocketScore.toFixed(0)}% (${label})`;
        apVal.style.color = airPocketScore > 60 ? '#10b981' : airPocketScore > 30 ? '#f59e0b' : '#ef4444';
    }
}

// ── Sparkline Chart Rendering (called in draw loop) ───────────────
function drawVitalsSparklines() {
    if (!vctx || !vitalsCanvas || vitalsCanvas.width === 0) return;
    if (vitalsHistory.bpm.length < 2) return;

    const W = vitalsCanvas.width;
    const H = vitalsCanvas.height;
    vctx.clearRect(0, 0, W, H);

    // Horizontal guides
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

    drawLine(vitalsHistory.bpm, 30, 180, '#ef4444');      // red = BPM
    drawLine(vitalsHistory.spo2, 65, 100, '#3b82f6');     // blue = SpO2
    drawLine(vitalsHistory.battery, 0, 100, '#f59e0b');   // amber = Battery
}
