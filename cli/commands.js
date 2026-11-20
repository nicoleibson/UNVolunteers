'use strict';

const fs = require('fs');
const { parseArgs, num } = require('./args.js');
const { createSnapshot } = require('./session.js');
const { maskKey } = require('./session.js');

const HELP = `Comandos de sesión Lifeline:

  help                        esta ayuda
  status | stats              estado de la sesión, malla, UDP/relay y DTN
  nodes                       nodos reales conocidos (local + remotos)
  send <texto> [--to <id>]    mensaje táctico (intercom) por la malla
  telemetry [opciones]        telemetría: --bpm --spo2 --battery --depth
                              --pressure --lat --lon --alt --tilt --light --mic
  ping <id>                   telemetría unicast a un nodo
  role <SCOUT|RELAY>          cambia el rol local
  alert <ESTADO>              reporta estado (VIGILANCE, DORMANT, …)
  peers                       pares descubiertos por el relay
  peer add <url>              agrega un par manual (fallback)
  dtn list|sync|merge <json>|clear
  decode <hex>                descifra/decodifica una trama real
  freq stats|request          gestor de frecuencias
  sdr spectrum|info|tune <MHz>
  radio status|tx <hex>       radio física (si se abrió con --radio-port)
  gnss                        última posición GNSS real
  messages                    últimos mensajes de intercom
  config                      configuración efectiva (clave enmascarada)
  clear                       quita nodos remotos
  shutdown                    detiene la sesión
  quit | exit                 sale de la sesión (REPL)`;

function requireStarted(session) {
    if (!session.started) throw new Error('SESIÓN_NO_INICIADA');
}

function nodeLine(node) {
    const gps = node.gps && node.gps.lat != null ? `${node.gps.lat.toFixed(5)},${node.gps.lon.toFixed(5)}` : '—';
    const vitals = [node.bpm != null ? `${node.bpm}bpm` : null, node.spo2 != null ? `${node.spo2}%` : null]
        .filter(Boolean).join('/') || '—';
    return `${node.isLocal ? '*' : ' '} ${node.id.slice(0, 8)}  ${String(node.label || '—').padEnd(18)} ${String(node.role || '—').padEnd(8)} ${String(node.battery != null ? node.battery + '%' : '—').padEnd(5)} ${String(gps).padEnd(24)} ${vitals}`;
}

function formatNodes(nodes) {
    const header = '  ID        NOMBRE             ROL      BAT   GPS                      VITALES';
    return [header, ...nodes.map(nodeLine)].join('\n');
}

function formatStatus(st) {
    const secs = Math.round((st.uptimeMs || 0) / 1000);
    const udp = st.udp ? `UDP ${st.udp.port} · tx=${st.udp.stats.tx} rx=${st.udp.stats.rx} err=${st.udp.stats.errors}` : 'UDP off';
    const relay = st.relay
        ? `Relay ${st.relay.relayUrl || '—'} · peers=${st.relay.peers.length} tx=${st.relay.stats.tx} rx=${st.relay.stats.rx}`
        : 'Relay off';
    const lora = st.engine.lora || {};
    const mesh = `Malla · paquetes=${lora.totalPackets ?? 0} entregas=${lora.deliveries ?? 0} nodos=${st.engine.nodes.length}`;
    const dtn = st.engine.dtn
        ? `DTN · ${st.engine.dtn.stored ?? 0} guardados / ${st.engine.dtn.pending ?? 0} pendientes`
        : 'DTN off';
    const radio = st.radio ? `Radio · ${st.radio.connected ? 'conectada' : 'sin conexión'}${st.radio.radio ? ' (' + st.radio.radio + ')' : ''}` : 'Radio off';
    const gnss = st.gnss ? (st.gnss.fix ? `GNSS · ${st.gnss.lat}, ${st.gnss.lon}` : 'GNSS · sin fix') : 'GNSS off';
    return [
        `${st.name} (${st.id}) · ${st.role} · ${st.alertState} · ${secs}s`,
        `Clave ${st.key}${st.keyDefault ? ' (DEMO)' : ''} · red ${st.networkId}`,
        st.http ? `HTTP ${st.http.url}` : 'HTTP off',
        udp,
        relay,
        mesh,
        dtn,
        radio,
        gnss,
    ].join('\n');
}

function createCommandHandler(session, out) {
    return async function exec(argv) {
        const cmd = String((argv && argv[0]) || 'help').toLowerCase();
        const rest = (argv || []).slice(1);
        const args = parseArgs(rest);

        switch (cmd) {
            case 'help':
            case '?':
                return { ok: true, text: HELP, commands: HELP };

            case 'status':
            case 'stats': {
                requireStarted(session);
                const status = session.status();
                return { ok: true, ...status, text: formatStatus(status) };
            }

            case 'nodes': {
                requireStarted(session);
                const nodes = session.engine.getNodes();
                return { ok: true, nodes, text: formatNodes(nodes) };
            }

            case 'send':
            case 'message': {
                requireStarted(session);
                const text = args._.join(' ').trim();
                if (!text) throw new Error('USO: send <texto> [--to <id>]');
                const result = session.sendMessage(text, args.to || args.destination);
                return {
                    ...result,
                    text: `TX mensaje seq#${result.seq} (${result.bytes}B) → ${result.to}`,
                };
            }

            case 'telemetry':
            case 'telemetry-tx': {
                requireStarted(session);
                const snapshot = createSnapshot(args, session.snapshot());
                const to = args.to || args.destination || 'FF:FF:FF:FF';
                const result = session.sendTelemetry(snapshot, to);
                return {
                    ...result,
                    snapshot,
                    text: `TX telemetría seq#${result.seq} (${result.bytes}B) → ${to}`,
                };
            }

            case 'ping': {
                requireStarted(session);
                const nodeId = args._[0] || args.id;
                if (!nodeId) throw new Error('USO: ping <id>');
                const result = session.ping(nodeId);
                return { ...result, text: `TX ping seq#${result.seq} → ${nodeId}` };
            }

            case 'role': {
                requireStarted(session);
                const role = args._[0] || args.role;
                if (!role) throw new Error('USO: role <SCOUT|RELAY>');
                const result = session.setRole(role);
                return { ...result, text: `Rol local → ${result.role}` };
            }

            case 'alert': {
                requireStarted(session);
                const state = args._[0] || args.state;
                if (!state) throw new Error('USO: alert <VIGILANCE|DORMANT|...>');
                const result = await session.setAlertState(state);
                return { ...result, text: `Estado de alerta → ${result.alertState}` };
            }

            case 'peers': {
                const peers = session.peers();
                const text = peers.length
                    ? peers.map((p) => `${p.label || '—'}  ${p.state || '—'}  ${p.url}`).join('\n')
                    : 'sin pares descubiertos';
                return { ok: true, peers, text };
            }

            case 'peer': {
                const sub = args._[0];
                if (sub === 'add') {
                    const url = args._[1] || args.url;
                    if (!url) throw new Error('USO: peer add <url>');
                    const result = await session.addPeerUrl(url);
                    return { ...result, text: `Par agregado: ${url}` };
                }
                const peers = session.peers();
                return { ok: true, peers, text: peers.map((p) => p.url).join('\n') || 'sin pares' };
            }

            case 'dtn': {
                const sub = args._[0] || 'list';
                if (sub === 'list') {
                    const result = session.dtnList();
                    const text = result.ok
                        ? `DTN: ${result.counts.stored} guardados, ${result.counts.pending} pendientes, ${result.counts.bytes}B${result.counts.encrypted ? ' (cifrado)' : ''}`
                        : result.error;
                    return { ...result, text };
                }
                if (sub === 'sync') {
                    const result = session.dtnList();
                    const pending = result.pending || [];
                    return { ...result, pending, text: `${pending.length} baliza(s) pendiente(s) de sincronizar` };
                }
                if (sub === 'clear') {
                    const result = session.dtnClear();
                    return { ...result, text: 'DTN vaciado' };
                }
                if (sub === 'merge') {
                    const file = args._[1] || args.file;
                    if (!file) throw new Error('USO: dtn merge <archivo.json>');
                    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
                    const beacons = Array.isArray(raw) ? raw : (raw.beacons || raw.pending || []);
                    const result = session.dtnMerge(beacons);
                    return { ...result, text: `DTN merge: +${result.added} nuevos, ${result.updated} actualizados, ${result.duplicate} duplicados` };
                }
                throw new Error('USO: dtn list|sync|merge <json>|clear');
            }

            case 'decode': {
                requireStarted(session);
                const hex = args._[0] || args.hex;
                if (!hex) throw new Error('USO: decode <hex>');
                const bytes = Buffer.from(String(hex).replace(/[^0-9A-Fa-f]/g, ''), 'hex');
                const packet = session.engine.encoder.decode(Array.from(bytes));
                return { ok: true, packet, text: JSON.stringify(packet, null, 2) };
            }

            case 'freq': {
                requireStarted(session);
                const sub = args._[0] || 'stats';
                const mgr = session.engine.freqMgr;
                if (!mgr) throw new Error('FREQ_MGR_NO_DISPONIBLE');
                if (sub === 'stats') {
                    const stats = { ...mgr.getStats(), active: mgr.getActiveAllocations() };
                    return { ok: true, stats, text: JSON.stringify(stats, null, 2) };
                }
                if (sub === 'request') {
                    const pass = num(args.priority, 2);
                    const bandwidth = num(args.bandwidth, 125000);
                    const alloc = mgr.requestFrequency({
                        requesterId: args.requester || session.id,
                        type: args.type || 'DATA',
                        priority: pass,
                        bandwidth,
                    });
                    if (!alloc) throw new Error('SIN_FRECUENCIA_DISPONIBLE');
                    return { ok: true, allocation: alloc, text: `Asignada ${(alloc.frequency / 1e6).toFixed(3)} MHz (${alloc.id})` };
                }
                throw new Error('USO: freq stats|request');
            }

            case 'sdr': {
                requireStarted(session);
                const sub = args._[0] || 'info';
                const sdr = session.engine.sdr;
                if (!sdr) throw new Error('SDR_NO_DISPONIBLE');
                if (sub === 'info') {
                    const info = {
                        frequency: sdr.frequency,
                        frequencyMHz: sdr.frequency / 1e6,
                        sampleRate: sdr.sampleRate,
                        demodMode: sdr.demodMode,
                        simulated: true,
                        note: 'El receptor SDR del repo es un banco DSP/simulación; no controla hardware RTL-SDR.',
                    };
                    return { ok: true, ...info, text: `${info.frequencyMHz.toFixed(3)} MHz · ${info.sampleRate / 1000} kHz · ${info.demodMode} (simulado)` };
                }
                if (sub === 'tune') {
                    const mhz = num(args._[1] || args.freq, null);
                    if (mhz == null) throw new Error('USO: sdr tune <MHz>');
                    sdr.tune(mhz * 1e6);
                    return { ok: true, frequencyMHz: mhz, text: `SDR sintonizado a ${mhz.toFixed(3)} MHz (simulado)` };
                }
                if (sub === 'spectrum') {
                    const spectrum = sdr.getSpectrum();
                    const top = Array.from(spectrum, (v, i) => ({ bin: i, value: v }))
                        .sort((a, b) => b.value - a.value).slice(0, 10);
                    return { ok: true, simulated: true, bins: spectrum.length, top, text: top.map((t) => `bin ${t.bin}: ${Number(t.value).toFixed(3)}`).join('\n') };
                }
                throw new Error('USO: sdr spectrum|info|tune <MHz>');
            }

            case 'radio': {
                const sub = args._[0] || 'status';
                if (!session.radio) throw new Error('RADIO_NO_VINCULADA (usá --radio-port al iniciar)');
                if (sub === 'status') {
                    return { ok: true, radio: session.radio.status(), text: JSON.stringify(session.radio.status(), null, 2) };
                }
                if (sub === 'tx') {
                    const hex = args._[1] || args.hex;
                    if (!hex) throw new Error('USO: radio tx <hex>');
                    const result = await session.radio.transmit(hex);
                    if (!result.ok) throw new Error(`TX_RADIO_${result.error}`);
                    return { ok: true, ...result, text: `TX radio ${result.bytes}B OK` };
                }
                throw new Error('USO: radio status|tx <hex>');
            }

            case 'gnss': {
                if (!session.gnss) throw new Error('GNSS_NO_CONECTADO (usá --gnss-port al iniciar)');
                const state = session.gnss.state;
                return { ok: true, gnss: state, text: state.fix ? `${state.lat}, ${state.lon} alt ${state.alt}m` : 'sin fix GNSS' };
            }

            case 'messages': {
                const messages = session.messages.slice(-50);
                const text = messages.length
                    ? messages.map((m) => `${new Date(m.at).toISOString().slice(11, 19)} ${m.fromName || m.fromId}: ${m.message}`).join('\n')
                    : 'sin mensajes';
                return { ok: true, messages, text };
            }

            case 'config': {
                const cfg = {
                    name: session.name,
                    id: session.id,
                    networkId: session.networkId,
                    role: session.role,
                    alertState: session.alertState,
                    key: maskKey(session.key),
                    keyDefault: session.keyDefault,
                    udpPort: session.udpPort,
                    httpPort: session.httpEnabled ? session.httpPort : null,
                    dtnFile: session.dtnFile,
                };
                return { ok: true, config: cfg, text: JSON.stringify(cfg, null, 2) };
            }

            case 'clear': {
                requireStarted(session);
                session.engine.clearRemoteNodes();
                return { ok: true, text: 'Nodos remotos eliminados' };
            }

            case 'shutdown': {
                await session.stop();
                return { ok: true, shutdown: true, text: 'Sesión detenida' };
            }

            case 'quit':
            case 'exit':
                return { ok: true, quit: true, text: 'Chau' };

            case 'echo':
                return { ok: true, text: args._.join(' ') };

            case 'whoami':
                return { ok: true, name: session.name, id: session.id, role: session.role, text: `${session.name} (${session.id}) · ${session.role}` };

            default:
                throw new Error(`COMANDO_DESCONOCIDO: ${cmd} (usá help)`);
        }
    };
}

module.exports = { createCommandHandler, HELP, formatNodes, formatStatus };
