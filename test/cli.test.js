'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, tokenize, bool, num, int, list, pick } = require('../cli/args.js');
const { Output } = require('../cli/output.js');
const control = require('../cli/control.js');
const { PacketEncoder } = require('../radio/packet_encoder.js');
const { APRSPacket } = require('../radio/aprs_protocol.js');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'lifeline.js');

function run(args, opts = {}) {
    return spawnSync(process.execPath, [BIN, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30000,
        ...opts,
    });
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-cli-'));
}

test('parseArgs acepta valores negativos y flags repetibles', () => {
    const args = parseArgs([
        'aprs', 'position',
        '--lat', '-34.6037',
        '--lon', '-58.3816',
        '--peer', 'a:1',
        '--peer', 'b:2',
        '--json',
    ]);
    assert.equal(args.lat, '-34.6037');
    assert.equal(args.lon, '-58.3816');
    assert.deepEqual(args.peer, ['a:1', 'b:2']);
    assert.equal(args.json, true);
    assert.deepEqual(args._, ['aprs', 'position']);
});

test('parseArgs soporta --clave=valor y --', () => {
    const args = parseArgs(['run', '--name=NODO', '--', '--literal']);
    assert.equal(args.name, 'NODO');
    assert.deepEqual(args._, ['run', '--literal']);
});

test('tokenize respeta comillas y escapes', () => {
    assert.deepEqual(tokenize('send "hola mundo" \'adios\' a\\ b'), ['send', 'hola mundo', 'adios', 'a b']);
    assert.deepEqual(tokenize('  status  '), ['status']);
});

test('helpers bool/num/int/list/pick', () => {
    assert.equal(bool('si'), true);
    assert.equal(bool('off', true), false);
    assert.equal(num('12.5'), 12.5);
    assert.equal(num('nope', 7), 7);
    assert.equal(int('12.9'), 12);
    assert.deepEqual(list(['a']), ['a']);
    assert.deepEqual(list(undefined), []);
    assert.equal(pick({ b: 2 }, ['a', 'b'], 0), 2);
});

test('Output emite NDJSON y respeta quiet', () => {
    const lines = [];
    const out = new Output({ json: true, jsonWriter: (line) => lines.push(line) });
    out.log('cli', 'hola');
    out.data({ ok: true });
    out.error(new Error('falló'));
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].type, 'log');
    assert.equal(parsed[1].ok, true);
    assert.equal(parsed[2].type, 'error');

    const quietLines = [];
    const quiet = new Output({ quiet: true, textWriter: (line) => quietLines.push(line) });
    quiet.log('cli', 'no');
    quiet.warn('no');
    assert.deepEqual(quietLines, []);
});

test('APRS codifica coordenadas negativas', () => {
    const packet = new APRSPacket({ callsign: 'LU1AAA', latitude: -34.6037, longitude: -58.3816 });
    assert.equal(packet.encodeLatitude(-34.6037), '3436.22S');
    assert.equal(packet.encodeLongitude(-58.3816), '05822.90W');
});

test('CLI --help no imprime banners de módulos', () => {
    const res = run(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Lifeline Core CLI/);
    assert.doesNotMatch(res.stdout, /Module loaded/);
});

test('CLI version y doctor --json', () => {
    const version = run(['version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const doctor = run(['doctor', '--json']);
    assert.equal(doctor.status, 0);
    const data = JSON.parse(doctor.stdout.trim());
    assert.equal(data.ok, true);
    assert.equal(data.webSerialInTerminal, false);
    assert.ok(Object.values(data.modules).every((v) => v === true));
});

test('CLI aprs position --json usa latitud/longitud reales', () => {
    const res = run(['aprs', 'position', '--callsign', 'LU1AAA', '--lat', '-34.6037', '--lon', '-58.3816', '--json']);
    assert.equal(res.status, 0);
    const data = JSON.parse(res.stdout.trim());
    assert.equal(data.ok, true);
    assert.match(data.infoField, /3436\.22S/);
    assert.match(data.infoField, /05822\.90W/);
    assert.match(data.hex, /^[0-9A-F]+$/);
});

test('CLI decode funciona sin sesión activa', () => {
    const encoder = new PacketEncoder({ encoding: 'CBOR', compression: 'LZ77', encryption: 'AES-CTR' });
    const hex = Buffer.from(encoder.encode({ type: 'text', text: 'HOLA', seq: 1 })).toString('hex');
    const res = run(['decode', hex, '--json']);
    assert.equal(res.status, 0);
    const data = JSON.parse(res.stdout.trim());
    assert.equal(data.ok, true);
    assert.equal(data.packet.text, 'HOLA');
    assert.equal(data.packet.seq, 1);
});

test('CLI status --json devuelve un motor efímero sin sesión', () => {
    const res = run(['status', '--json']);
    assert.equal(res.status, 0);
    const data = JSON.parse(res.stdout.trim());
    assert.equal(data.ok, true);
    assert.equal(data.activeSession, false);
    assert.equal(data.keyDefault, true);
    assert.equal(data.engine.nodes.length, 1);
});

test('control guarda, carga y borra el estado', () => {
    const dir = tempDir();
    try {
        const file = control.saveState({
            pid: process.pid,
            controlPort: 65001,
            controlUrl: 'http://127.0.0.1:65001',
            token: 'abc',
        }, { stateDir: dir });
        assert.equal(file, path.join(dir, 'session.json'));
        const loaded = control.loadState({ stateDir: dir });
        assert.equal(loaded.token, 'abc');
        assert.equal(loaded.controlPort, 65001);

        control.clearState({ stateDir: dir });
        assert.equal(control.loadState({ stateDir: dir }), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('servidor de control atiende status, exec y shutdown', async () => {
    const dir = tempDir();
    let shutdown = false;
    const ctl = await control.startControlServer({
        token: 'token-test',
        getStatus: () => ({ name: 'TEST', started: true }),
        exec: async (argv) => ({ ok: true, echo: argv }),
        onShutdown: () => { shutdown = true; },
    });
    try {
        control.saveState({
            pid: process.pid,
            controlPort: ctl.port,
            controlUrl: ctl.url,
            token: ctl.token,
        }, { stateDir: dir });
        const state = control.loadState({ stateDir: dir });

        const status = await control.controlStatus(state);
        assert.equal(status.name, 'TEST');

        const echoed = await control.controlExec(state, ['nodes']);
        assert.deepEqual(echoed.echo, ['nodes']);

        await assert.rejects(
            control.controlRequest({ ...state, token: 'malo' }, 'GET', '/status'),
            /TOKEN_INVALIDO/,
        );

        await control.controlShutdown(state);
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(shutdown, true);
    } finally {
        await new Promise((resolve) => ctl.server.close(resolve));
        control.clearState({ stateDir: dir });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
