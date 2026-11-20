#!/usr/bin/env node
'use strict';

const rawArgv = process.argv.slice(2);
const EARLY_JSON = rawArgv.some((a) => a === '--json' || a.startsWith('--json='));
const EARLY_QUIET = rawArgv.some((a) => a === '--quiet' || a === '-q' || a.startsWith('--quiet='));
const EARLY_VERBOSE = rawArgv.some((a) => a === '--verbose' || a.startsWith('--verbose='));
if (!EARLY_VERBOSE) {
    const inspect = require('util').inspect;
    const rawLog = console.log.bind(console);
    const isModuleBanner = (parts) => parts.length === 1
        && typeof parts[0] === 'string'
        && /^\[[^\]]+\] Module loaded$/.test(parts[0]);
    console.log = (...parts) => {
        if (isModuleBanner(parts)) return;
        if (EARLY_QUIET) return;
        if (EARLY_JSON) {
            process.stderr.write(parts.map((p) => typeof p === 'string' ? p : inspect(p, { depth: 4 })).join(' ') + '\n');
            return;
        }
        rawLog(...parts);
    };
}

const fs = require('fs');
const path = require('path');

const { parseArgs, bool, num } = require('../cli/args.js');
const { Output } = require('../cli/output.js');
const { createSession, createSnapshot, createDtnFileIO, DEFAULT_KEY, DEFAULT_NETWORK, DEFAULT_UDP_PORT, DEFAULT_HTTP_PORT } = require('../cli/session.js');
const { createCommandHandler, formatStatus } = require('../cli/commands.js');
const { runRepl, renderResult } = require('../cli/repl.js');
const control = require('../cli/control.js');
const { NodeSerialLineTransport } = require('../cli/node_serial.js');

const { LoRaRadioDriver } = require('../radio/radio_driver.js');
const { GnssReader } = require('../radio/gnss_reader.js');
const { AX25Frame, APRSPacket } = require('../radio/aprs_protocol.js');
const { SDRReceiver } = require('../radio/sdr_receiver.js');
const { FrequencyManager } = require('../radio/frequency_mgr.js');
const { DtnStore } = require('../radio/dtn_store.js');
const { PacketEncoder } = require('../radio/packet_encoder.js');
const { createServer } = require('../simulation/simulation/server.js');

const VERSION = require('../package.json').version;

const MAIN_HELP = `Lifeline Core CLI ${VERSION} — operación headless sin motor gráfico.

Uso:
  lifeline <comando> [opciones]

Comandos:
  run         inicia un nodo headless (motor RF + malla UDP + relay + HTTP)
  listen      igual que run pero sin REPL (solo eventos)
  serve       sirve la PWA/gateway HTTP sin motor RF
  status      estado de la sesión activa (o de un motor efímero)
  send        envía un mensaje táctico por la malla
  telemetry   envía telemetría con los valores indicados
  nodes       lista los nodos reales de la sesión
  ping        telemetría unicast a un nodo
  role        cambia el rol local (SCOUT|RELAY)
  alert       reporta estado de alerta (VIGILANCE|DORMANT|…)
  peers       pares del relay
  dtn         almacén store-and-forward (list|sync|merge|clear|add)
  decode      decodifica una trama hexadecimal
  aprs        herramientas APRS/AX.25
  radio       radio física por puerto serial (list|info|tx|rx)
  gnss        lee NMEA de un GNSS serial
  sdr         banco DSP/SDR (info|spectrum|tune)
  freq        gestor de frecuencias (stats|request)
  doctor      diagnóstico del entorno
  state       muestra el archivo de sesión activa
  version     versión
  help        esta ayuda

Ejemplos:
  lifeline run --name NODO-A --peer 192.168.0.5:21000 --http-port 8000
  lifeline run --name NODO-B --peer 192.168.0.4:21000 --http-port 8001 --no-repl
  lifeline run --exec "status; send HOLA EQUIPO"
  lifeline status --json
  lifeline aprs position --callsign LU1AAA --lat -34.6037 --lon -58.3816
  lifeline radio tx 486F6C61 --port /dev/ttyUSB0 --freq 915000000
  lifeline gnss read --port /dev/ttyUSB0 --baud 9600

Notas:
  - Sin --key se usa la clave AES de demo (no apta para producción).
  - La malla UDP usa el mismo puerto en cada host y --peer para unicast.
  - El relay HTTP requiere la sesión con servidor HTTP (por defecto :8000).
  - Web Serial no existe en terminal: la radio física usa --port (stty).
`;

function readPackageVersion() {
    return VERSION;
}

function controlState(args) {
    return control.loadState({ stateDir: args.stateDir });
}

function buildSession(args, out) {
    const alertState = typeof args.alert === 'string'
        ? args.alert
        : (bool(args.dormant) ? 'DORMANT' : 'VIGILANCE');
    return createSession({
        name: args.name || 'LIFELINE-CLI',
        id: args.id,
        role: args.role,
        networkId: args.network || DEFAULT_NETWORK,
        udpPort: args.udpPort != null ? num(args.udpPort, DEFAULT_UDP_PORT) : DEFAULT_UDP_PORT,
        httpPort: args.httpPort != null ? num(args.httpPort, DEFAULT_HTTP_PORT) : DEFAULT_HTTP_PORT,
        http: !bool(args.noHttp),
        udp: !bool(args.noUdp),
        dtn: !bool(args.noDtn),
        key: args.key || process.env.LIFELINE_KEY || DEFAULT_KEY,
        encryption: args.encryption,
        callsign: args.callsign,
        region: args.region,
        frequency: args.frequency,
        lat: args.lat,
        lon: args.lon,
        alt: args.alt,
        battery: args.battery,
        peer: args.peer,
        broadcast: bool(args.broadcast),
        relayUrl: args.relay || null,
        alertState,
        dormant: bool(args.dormant),
        discovery: !bool(args.noDiscovery),
        discoveryPort: args.discoveryPort,
        peerUrl: args.peerUrl,
        control: !bool(args.noControl),
        stateDir: args.stateDir,
        dtnFile: args.dtnFile,
        telemetryInterval: args.telemetryInterval,
        telemetryTo: args.telemetryTo,
        radioPort: args.radioPort,
        radioBaud: args.radioBaud,
        radioTimeout: args.radioTimeout,
        radioFreq: args.radioFreq,
        radioSf: args.radioSf,
        radioBw: args.radioBw,
        radioTxPower: args.radioTxPower,
        gnssPort: args.gnssPort,
        gnssBaud: args.gnssBaud,
        snapshot: createSnapshot(args, {}),
        output: out,
    });
}

function waitForSignal(onStop) {
    return new Promise((resolve) => {
        let stopping = false;
        const stop = async () => {
            if (stopping) return;
            stopping = true;
            try { await onStop(); } catch (e) { /* no romper el cierre */ }
            resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

async function runSession(args, out, opts = {}) {
    let session;
    try {
        session = buildSession(args, out);
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
        return;
    }
    const handler = createCommandHandler(session, out);
    try {
        await session.start(handler);
    } catch (e) {
        out.error(e);
        await session.stop();
        process.exitCode = 1;
        return;
    }

    if (args.exec) {
        const lines = String(args.exec).split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
        const { tokenize } = require('../cli/args.js');
        for (const line of lines) {
            try {
                const result = await handler(tokenize(line));
                renderResult(result, out, { json: out.json });
                if (result && (result.quit || result.shutdown)) break;
            } catch (e) {
                out.error(e);
                process.exitCode = 1;
            }
        }
        await session.stop();
        return;
    }

    if (opts.listen || bool(args.noRepl) || !process.stdin.isTTY) {
        out.log('session', 'Modo escucha. Ctrl+C para salir.');
        await waitForSignal(() => session.stop());
        return;
    }

    await runRepl(session, handler, out, { json: out.json });
    await session.stop();
}

async function cmdStatus(args, out) {
    const state = controlState(args);
    if (state) {
        try {
            const status = await control.controlStatus(state);
            if (out.json) { out.data(status); return; }
            out.text(formatStatus(status));
            return;
        } catch (e) {
            out.warn(`La sesión activa no respondió (${e.message}); diagnóstico local.`);
        }
    }
    let session;
    const prevQuiet = out.quiet;
    const prevLog = console.log;
    out.quiet = true;
    if (!out.verbose) console.log = () => {};
    try {
        session = buildSession({
            ...args,
            noHttp: true,
            noUdp: true,
            noDtn: true,
            noControl: true,
            noDiscovery: true,
        }, out);
        const handler = createCommandHandler(session, out);
        await session.start(handler);
        const status = session.status();
        await session.stop();
        console.log = prevLog;
        out.quiet = prevQuiet;
        if (out.json) out.data({ ...status, activeSession: false });
        else {
            out.text(formatStatus(status));
            out.text('');
            out.text('No hay sesión activa. Iniciá una con: lifeline run');
        }
    } catch (e) {
        console.log = prevLog;
        out.quiet = prevQuiet;
        out.error(e);
        process.exitCode = 1;
        if (session) await session.stop();
    }
}

async function controlOrLocal(args, out, argv, local) {
    const state = controlState(args);
    if (state) {
        try {
            const result = await control.controlExec(state, argv);
            renderResult(result, out, { json: out.json });
            return true;
        } catch (e) {
            out.warn(`Sesión activa no disponible (${e.message})`);
        }
    }
    if (local) {
        await local();
        return true;
    }
    out.error(`No hay sesión activa para "${argv[0]}". Iniciá una con: lifeline run`);
    process.exitCode = 1;
    return false;
}

async function cmdSend(args, out) {
    const text = args._.slice(1).join(' ').trim();
    if (!text) { out.error('USO: lifeline send <texto> [--to <id>]'); process.exitCode = 1; return; }
    const state = controlState(args);
    if (state) {
        await controlOrLocal(args, out, ['send', text, ...(args.to ? ['--to', String(args.to)] : [])]);
        return;
    }
    let session;
    try {
        session = buildSession({ ...args, noHttp: true, noControl: true, noRepl: true }, out);
        const handler = createCommandHandler(session, out);
        await session.start(handler);
        const result = session.sendMessage(text, args.to);
        const wait = num(args.wait, 500);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (out.json) out.data(result);
        else out.text(`TX mensaje seq#${result.seq} (${result.bytes}B) → ${result.to}`);
        await session.stop();
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
        if (session) await session.stop();
    }
}

async function cmdTelemetry(args, out) {
    const state = controlState(args);
    if (state) {
        const forward = ['telemetry'];
        for (const key of ['bpm', 'spo2', 'battery', 'depth', 'pressure', 'lat', 'lon', 'alt', 'tilt', 'light', 'mic']) {
            if (args[key] !== undefined) forward.push(`--${key}`, String(args[key]));
        }
        if (args.to) forward.push('--to', String(args.to));
        await controlOrLocal(args, out, forward);
        return;
    }
    let session;
    try {
        session = buildSession({ ...args, noHttp: true, noControl: true, noRepl: true }, out);
        const handler = createCommandHandler(session, out);
        await session.start(handler);
        const snapshot = createSnapshot(args, session.snapshot());
        const result = session.sendTelemetry(snapshot, args.to || 'FF:FF:FF:FF');
        const wait = num(args.wait, 300);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (out.json) out.data({ ...result, snapshot });
        else out.text(`TX telemetría seq#${result.seq} (${result.bytes}B) → ${result.to}`);
        await session.stop();
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
        if (session) await session.stop();
    }
}

async function cmdNodeCommand(args, out, name) {
    const state = controlState(args);
    if (!state) {
        out.error(`No hay sesión activa para "${name}". Iniciá una con: lifeline run`);
        process.exitCode = 1;
        return;
    }
    const rest = args._.slice(1).map(String);
    await controlOrLocal(args, out, [name, ...rest]);
}

async function cmdServe(args, out) {
    const port = num(args.httpPort, DEFAULT_HTTP_PORT);
    const server = createServer({
        networkId: args.network || DEFAULT_NETWORK,
        instanceId: args.id,
        label: args.label || args.name || 'GATEWAY-CLI',
        discovery: !bool(args.noDiscovery),
        discoveryPort: args.discoveryPort != null ? num(args.discoveryPort, undefined) : undefined,
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
            server.removeListener('error', reject);
            const addr = server.address();
            const actual = addr && typeof addr === 'object' ? addr.port : port;
            out.log('http', `Gateway HTTP en http://0.0.0.0:${actual}`);
            resolve();
        });
    }).catch((e) => { out.error(e); process.exitCode = 1; });
    if (process.exitCode) return;
    await waitForSignal(async () => {
        await new Promise((resolve) => server.close(() => resolve()));
        out.log('http', 'Gateway detenido');
    });
}

function aprsOutput(result, out) {
    if (out.json) { out.data(result); return; }
    out.text(`Callsign: ${result.callsign}`);
    out.text(`Info: ${result.infoField}`);
    out.text(`AX.25: ${result.hex}`);
    if (result.frequency) out.text(`Frecuencia: ${result.frequency}`);
}

function cmdAprs(args, out) {
    const sub = String(args._[1] || 'position').toLowerCase();
    const callsign = args.callsign || 'N0CALL';
    const lat = num(args.lat, 0);
    const lon = num(args.lon, 0);
    try {
        if (sub === 'decode') {
            const hex = args._[2] || args.hex;
            if (!hex) throw new Error('USO: aprs decode <hex>');
            const frame = AX25Frame.decode(Buffer.from(String(hex).replace(/[^0-9A-Fa-f]/g, ''), 'hex'));
            if (out.json) out.data(frame);
            else out.text(JSON.stringify(frame, null, 2));
            return;
        }
        if (sub === 'ax25') {
            const frame = new AX25Frame({
                sourceCallsign: callsign,
                sourceSSID: num(args.ssid, 0),
                destinationCallsign: args.destination || 'APRS',
                repeaterPath: (args.path ? String(args.path).split(',') : []),
                infoField: args.info || args._.slice(2).join(' ') || 'LIFELINE',
            });
            const bytes = frame.encode();
            const hex = Buffer.from(bytes).toString('hex').toUpperCase();
            const decoded = AX25Frame.decode(bytes);
            if (out.json) out.data({ ok: true, hex, decoded });
            else out.text(`AX.25: ${hex}\nInfo: ${decoded.infoField}`);
            return;
        }

        const packet = new APRSPacket({
            callsign,
            ssid: num(args.ssid, 0),
            latitude: lat,
            longitude: lon,
            symbol: args.symbol,
        });
        let aprs;
        if (sub === 'message') {
            const to = args.to || args._[2];
            const text = args.text || args._.slice(3).join(' ');
            if (!to || !text) throw new Error('USO: aprs message <destino> <texto>');
            aprs = packet.createMessage(to, text);
        } else if (sub === 'status') {
            const text = args.text || args._.slice(2).join(' ') || 'LIFELINE OPERATIVO';
            aprs = packet.createStatusReport(text);
        } else if (sub === 'object') {
            const name = args.object || args._[2] || 'OBJ';
            aprs = packet.createObject(name, num(args.objLat, lat), num(args.objLon, lon), !bool(args.dead));
        } else if (sub === 'emergency' || sub === 'sos' || sub === 'beacon') {
            aprs = packet.createEmergencyBeacon();
        } else if (sub === 'position-timestamp' || sub === 'timestamp') {
            aprs = packet.createPositionReportWithTimestamp();
        } else if (sub === 'position' || sub === 'pos') {
            aprs = packet.createPositionReport();
        } else {
            throw new Error('USO: aprs position|message|status|object|emergency|ax25|decode');
        }
        const bytes = aprs.frame.encode();
        const result = {
            ok: true,
            callsign,
            infoField: aprs.infoField,
            hex: Buffer.from(bytes).toString('hex').toUpperCase(),
            bytes: bytes.length,
        };
        aprsOutput(result, out);
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
    }
}

function cmdDecode(args, out) {
    try {
        const hex = args._[1] || args.hex;
        if (!hex) throw new Error('USO: decode <hex>');
        const bytes = Buffer.from(String(hex).replace(/[^0-9A-Fa-f]/g, ''), 'hex');
        if (!bytes.length) throw new Error('Trama hex inválida');
        const encoder = new PacketEncoder({
            encoding: 'CBOR',
            compression: 'LZ77',
            encryption: args.encryption || 'AES-CTR',
            key: args.key || process.env.LIFELINE_KEY || DEFAULT_KEY,
        });
        const packet = encoder.decode(Array.from(bytes));
        if (out.json) out.data({ ok: true, packet, bytes: bytes.length });
        else out.text(JSON.stringify(packet, null, 2));
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
    }
}

function cmdSdr(args, out) {
    const sub = String(args._[1] || 'info').toLowerCase();
    try {
        const sdr = new SDRReceiver({
            frequency: num(args.freq, 433) * 1e6,
            sampleRate: num(args.sampleRate, 96000),
            demodMode: args.demod || 'FM',
        });
        if (sub === 'spectrum') {
            const spectrum = sdr.getSpectrum();
            const top = Array.from(spectrum, (v, i) => ({ bin: i, value: v }))
                .sort((a, b) => b.value - a.value).slice(0, 12);
            const result = { ok: true, simulated: true, frequencyMHz: sdr.frequency / 1e6, bins: spectrum.length, top };
            if (out.json) out.data(result);
            else {
                out.text(`Espectro simulado @ ${(sdr.frequency / 1e6).toFixed(3)} MHz (${spectrum.length} bins)`);
                top.forEach((t) => out.text(`  bin ${t.bin}: ${Number(t.value).toFixed(3)}`));
            }
            return;
        }
        if (sub === 'tune') {
            const mhz = num(args._[2] || args.freq, null);
            if (mhz == null) throw new Error('USO: sdr tune <MHz>');
            sdr.tune(mhz * 1e6);
            const result = { ok: true, simulated: true, frequencyMHz: mhz };
            if (out.json) out.data(result);
            else out.text(`SDR sintonizado a ${mhz.toFixed(3)} MHz (simulado)`);
            return;
        }
        const result = {
            ok: true,
            simulated: true,
            frequencyMHz: sdr.frequency / 1e6,
            sampleRate: sdr.sampleRate,
            demodMode: sdr.demodMode,
            note: 'Banco DSP/simulación; no controla hardware RTL-SDR.',
        };
        if (out.json) out.data(result);
        else out.text(`${result.frequencyMHz.toFixed(3)} MHz · ${result.sampleRate / 1000} kHz · ${result.demodMode} (simulado)`);
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
    }
}

function cmdFreq(args, out) {
    const sub = String(args._[1] || 'stats').toLowerCase();
    try {
        const mgr = new FrequencyManager({ region: args.region || 'AMERICAS' });
        if (sub === 'request') {
            const alloc = mgr.requestFrequency({
                requesterId: args.requester || 'CLI',
                type: args.type || 'DATA',
                priority: num(args.priority, 2),
                bandwidth: num(args.bandwidth, 125000),
            });
            if (!alloc) throw new Error('SIN_FRECUENCIA_DISPONIBLE');
            if (out.json) out.data({ ok: true, allocation: alloc });
            else out.text(`Asignada ${(alloc.frequency / 1e6).toFixed(3)} MHz (${alloc.id})`);
            return;
        }
        const stats = { ...mgr.getStats(), active: mgr.getActiveAllocations() };
        if (out.json) out.data({ ok: true, stats });
        else out.text(JSON.stringify(stats, null, 2));
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
    }
}

function dtnFile(args) {
    return args.dtnFile || path.join(control.stateDir({ stateDir: args.stateDir }), 'dtn.json');
}

async function cmdDtn(args, out) {
    const state = controlState(args);
    if (state) {
        const sub = String(args._[1] || 'list');
        const argv = ['dtn', sub];
        if (args._[2]) argv.push(args._[2]);
        if (args.file) argv.push('--file', args.file);
        await controlOrLocal(args, out, argv);
        return;
    }
    try {
        const file = dtnFile(args);
        const store = new DtnStore({ key: args.key || DEFAULT_KEY, io: createDtnFileIO(file) });
        const sub = String(args._[1] || 'list').toLowerCase();
        if (sub === 'clear') {
            store.clear();
            if (out.json) out.data({ ok: true, cleared: true, file });
            else out.text(`DTN vaciado (${file})`);
            return;
        }
        if (sub === 'merge') {
            const from = args._[2] || args.file;
            if (!from) throw new Error('USO: dtn merge <archivo.json>');
            const raw = JSON.parse(fs.readFileSync(from, 'utf8'));
            const beacons = Array.isArray(raw) ? raw : (raw.beacons || raw.pending || []);
            const result = store.merge(beacons);
            if (out.json) out.data({ ok: true, ...result, file });
            else out.text(`DTN merge: +${result.added} nuevos, ${result.updated} actualizados, ${result.duplicate} duplicados (${file})`);
            return;
        }
        if (sub === 'add') {
            const nodeId = args._[2] || args.node;
            if (!nodeId) throw new Error('USO: dtn add <nodeId> [--data <json>]');
            let data = {};
            if (args.data) {
                try { data = JSON.parse(args.data); } catch (e) { data = { value: String(args.data) }; }
            }
            const result = store.ingest({ nodeId, timestamp: Date.now(), data, synced: false });
            if (out.json) out.data({ ok: true, ...result, file });
            else out.text(`DTN ${result.action}: ${nodeId} (${file})`);
            return;
        }
        const counts = store.counts();
        const pending = store.pending();
        if (out.json) out.data({ ok: true, counts, pending, file });
        else {
            out.text(`DTN ${file}`);
            out.text(`${counts.stored} guardados · ${counts.pending} pendientes · ${counts.bytes}B${counts.encrypted ? ' · cifrado' : ' · SIN CLAVE'}`);
            pending.forEach((p) => out.text(`  ${p.nodeId} ${new Date(p.timestamp).toISOString()}`));
        }
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
    }
}

async function cmdRadio(args, out) {
    const sub = String(args._[1] || 'list').toLowerCase();
    if (sub === 'list' || !args.port) {
        const ports = NodeSerialLineTransport.listPorts();
        if (out.json) out.data({ ok: true, ports });
        else {
            out.text(ports.length ? ports.join('\n') : 'No se encontraron puertos serie (/dev/ttyUSB*, /dev/ttyACM*).');
            out.text('En Termux puede requerir termux-usb o un gateway con el puerto físico.');
        }
        if (sub !== 'list' && !args.port) process.exitCode = 1;
        return;
    }
    const transport = new NodeSerialLineTransport(args.port, num(args.baud, 115200));
    const driver = new LoRaRadioDriver({
        transport,
        timeoutMs: num(args.timeout, 5000),
        onLog: (channel, message) => out.log(channel, message),
        onFrame: (frame) => out.event('radio-rx', { hex: frame.hex, rssi: frame.rssi, snr: frame.snr }),
    });
    try {
        const conn = await driver.connect();
        if (!conn.ok) throw new Error(`RADIO_${conn.error}`);
        const cfg = {};
        if (args.freq != null) cfg.frequency = num(args.freq, null);
        if (args.sf != null) cfg.spreadingFactor = num(args.sf, null);
        if (args.bw != null) cfg.bandwidth = num(args.bw, null);
        if (args.txPower != null) cfg.txPower = num(args.txPower, null);
        if (Object.keys(cfg).length) await driver.configure(cfg);

        if (sub === 'info') {
            const result = { ok: true, ...conn, status: driver.status() };
            if (out.json) out.data(result);
            else out.text(`Radio lista: ${result.radio || 'SX1276'} en ${args.port} @ ${num(args.baud, 115200)} baud`);
            await driver.close();
            return;
        }
        if (sub === 'tx') {
            const hex = args._[2] || args.hex || (args.file ? fs.readFileSync(args.file, 'utf8').trim() : null);
            if (!hex) throw new Error('USO: radio tx <hex> [--port ...]');
            const result = await driver.transmit(hex);
            if (!result.ok) throw new Error(`TX_RADIO_${result.error}`);
            if (out.json) out.data({ ok: true, ...result, port: args.port });
            else out.text(`TX radio ${result.bytes}B OK (${args.port})`);
            await driver.close();
            return;
        }
        if (sub === 'rx') {
            const timeout = num(args.timeout, 0);
            if (out.json) out.data({ ok: true, listening: true, port: args.port });
            else out.text(`RX en ${args.port}. Ctrl+C para salir.`);
            await new Promise((resolve) => {
                let done = false;
                let timer = null;
                const finish = async () => {
                    if (done) return;
                    done = true;
                    if (timer) clearTimeout(timer);
                    process.removeListener('SIGINT', onSignal);
                    process.removeListener('SIGTERM', onSignal);
                    await driver.close();
                    resolve();
                };
                const onSignal = () => { finish(); };
                if (timeout > 0) timer = setTimeout(finish, timeout);
                process.once('SIGINT', onSignal);
                process.once('SIGTERM', onSignal);
            });
            return;
        }
        throw new Error('USO: radio list|info|tx|rx --port <dispositivo>');
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
        try { await driver.close(); } catch (err) { /* ya cerrada */ }
    }
}

async function cmdGnss(args, out) {
    if (!args.port) {
        const state = controlState(args);
        if (state) {
            const result = await control.controlExec(state, ['gnss']);
            renderResult(result, out, { json: out.json });
            return;
        }
        out.error('USO: lifeline gnss read --port <dispositivo> [--baud 9600]');
        process.exitCode = 1;
        return;
    }
    const transport = new NodeSerialLineTransport(args.port, num(args.baud, 9600));
    const reader = new GnssReader({
        transport,
        onLog: (channel, message) => out.log(channel, message),
        onPosition: (state) => out.event('gnss', { lat: state.lat, lon: state.lon, alt: state.alt, fix: state.fix }),
        onHeading: (heading) => out.event('gnss-heading', { heading }),
    });
    try {
        const conn = await reader.connect();
        if (!conn.ok) throw new Error(`GNSS_${conn.error}`);
        const timeout = num(args.timeout, 15000);
        await new Promise((resolve) => {
            let done = false;
            let poll = null;
            let timer = null;
            const cleanup = () => {
                if (poll) clearInterval(poll);
                if (timer) clearTimeout(timer);
                process.removeListener('SIGINT', onSignal);
                process.removeListener('SIGTERM', onSignal);
            };
            const finish = () => {
                if (done) return;
                done = true;
                cleanup();
                resolve();
            };
            const onSignal = () => finish();
            poll = setInterval(() => { if (reader.state.fix) finish(); }, 200);
            timer = setTimeout(finish, timeout);
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
        });
        const state = reader.state;
        if (out.json) out.data({ ok: true, gnss: state });
        else out.text(state.fix ? `${state.lat}, ${state.lon} alt ${state.alt}m (heading ${state.heading != null ? state.heading : '—'})` : 'Sin fix GNSS en el tiempo de espera');
        await reader.close();
    } catch (e) {
        out.error(e);
        process.exitCode = 1;
        try { await reader.close(); } catch (err) { /* ya cerrado */ }
    }
}

function cmdDoctor(args, out) {
    const modules = [
        '../radio/packet_encoder.js',
        '../radio/lora_mesh.js',
        '../radio/aprs_protocol.js',
        '../radio/sdr_receiver.js',
        '../radio/frequency_mgr.js',
        '../radio/radio_driver.js',
        '../radio/gnss_reader.js',
        '../radio/dtn_store.js',
        '../radio/auto_link.js',
        '../radio/voice_link.js',
        '../simulation/simulation/lifeline_engine.js',
        '../simulation/simulation/relay_adapter.js',
        '../simulation/simulation/server.js',
    ];
    const loaded = {};
    for (const mod of modules) {
        try { require(mod); loaded[mod] = true; } catch (e) { loaded[mod] = e.message; }
    }
    const termux = process.env.TERMUX_VERSION || (process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
    const termuxTools = ['termux-location', 'termux-battery-status', 'termux-vibrate', 'termux-notification'];
    const termuxAvailable = {};
    if (termux) {
        const { execFileSync } = require('child_process');
        for (const tool of termuxTools) {
            try { execFileSync('which', [tool], { stdio: 'ignore' }); termuxAvailable[tool] = true; }
            catch (e) { termuxAvailable[tool] = false; }
        }
    }
    const state = controlState(args);
    const result = {
        ok: true,
        version: readPackageVersion(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        termux: !!termux,
        termuxTools: termuxAvailable,
        serialPorts: NodeSerialLineTransport.listPorts(),
        serialSupported: NodeSerialLineTransport.isSupported(),
        webSerialInTerminal: false,
        keyEnv: !!process.env.LIFELINE_KEY,
        stateFile: control.statePath({ stateDir: args.stateDir }),
        activeSession: state ? { pid: state.pid, name: state.name, controlPort: state.controlPort, httpPort: state.httpPort } : null,
        modules: loaded,
    };
    if (out.json) { out.data(result); return; }
    out.text(`Lifeline Core CLI ${result.version} · Node ${result.node} · ${result.platform}/${result.arch}`);
    out.text(`Termux: ${result.termux ? 'sí' : 'no'} · puertos serie: ${result.serialPorts.length ? result.serialPorts.join(', ') : 'ninguno'}`);
    out.text(`Web Serial en terminal: no (usar --port con stty) · clave por entorno: ${result.keyEnv ? 'sí' : 'no'}`);
    const bad = Object.entries(loaded).filter(([, v]) => v !== true);
    out.text(bad.length ? `Módulos con error: ${bad.map(([k, v]) => `${k} (${v})`).join(', ')}` : 'Todos los módulos cargan correctamente.');
    out.text(`Sesión activa: ${result.activeSession ? `${result.activeSession.name} pid ${result.activeSession.pid}` : 'no'}`);
    if (result.termux) {
        const missing = Object.entries(termuxAvailable).filter(([, v]) => !v).map(([k]) => k);
        out.text(missing.length ? `Termux API faltante: ${missing.join(', ')}` : 'Termux API disponible.');
    }
}

function cmdState(args, out) {
    const file = control.statePath({ stateDir: args.stateDir });
    const state = control.loadState({ stateDir: args.stateDir });
    if (out.json) {
        out.data({ ok: true, file, active: !!state, state: state ? { ...state, token: '***' } : null });
        return;
    }
    out.text(file);
    if (!state) { out.text('sin sesión activa (o PID muerto)'); return; }
    out.text(JSON.stringify({ ...state, token: '***' }, null, 2));
}

async function main() {
    const argv = process.argv.slice(2);
    const args = parseArgs(argv);
    const out = new Output({
        json: bool(args.json),
        quiet: bool(args.quiet),
        verbose: bool(args.verbose),
    });

    if (out.json) {
        const inspect = require('util').inspect;
        console.log = (...parts) => process.stderr.write(parts.map((p) => typeof p === 'string' ? p : inspect(p, { depth: 4 })).join(' ') + '\n');
    }

    const cmd = String(args._[0] || 'help').toLowerCase();

    if (args.help && !args._.length) { out.text(MAIN_HELP); return; }
    if (args.version || cmd === 'version') { out.text(VERSION); return; }

    switch (cmd) {
        case 'help':
            out.text(MAIN_HELP);
            return;
        case 'run':
            await runSession(args, out, {});
            return;
        case 'listen':
            await runSession(args, out, { listen: true });
            return;
        case 'serve':
            await cmdServe(args, out);
            return;
        case 'status':
            await cmdStatus(args, out);
            return;
        case 'send':
            await cmdSend(args, out);
            return;
        case 'telemetry':
            await cmdTelemetry(args, out);
            return;
        case 'nodes':
            await cmdNodeCommand(args, out, 'nodes');
            return;
        case 'ping':
        case 'role':
        case 'alert':
        case 'peers':
        case 'peer':
        case 'messages':
        case 'config':
        case 'clear':
        case 'whoami':
            await cmdNodeCommand(args, out, cmd);
            return;
        case 'decode':
            cmdDecode(args, out);
            return;
        case 'shutdown': {
            const state = controlState(args);
            if (!state) { out.error('No hay sesión activa'); process.exitCode = 1; return; }
            try { await control.controlShutdown(state); out.text('Sesión detenida'); }
            catch (e) { out.error(e); process.exitCode = 1; }
            return;
        }
        case 'dtn':
            await cmdDtn(args, out);
            return;
        case 'aprs':
            cmdAprs(args, out);
            return;
        case 'radio':
            await cmdRadio(args, out);
            return;
        case 'gnss':
            await cmdGnss(args, out);
            return;
        case 'sdr':
            cmdSdr(args, out);
            return;
        case 'freq':
            cmdFreq(args, out);
            return;
        case 'doctor':
            cmdDoctor(args, out);
            return;
        case 'state':
            cmdState(args, out);
            return;
        default:
            out.error(`Comando desconocido: ${cmd}. Usá "lifeline help".`);
            process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
});
