'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Transporte serial de líneas para Node/Termux. Sustituye al Web Serial
 * del navegador: configura el TTY con `stty` y lee/escribe líneas \n.
 * Es inyectable (fs/exec) para poder testearse sin hardware.
 */
class NodeSerialLineTransport {
    constructor(devicePath, baudRate = 115200, opts = {}) {
        this.devicePath = devicePath;
        this.baudRate = baudRate;
        this.fs = opts.fs || fs;
        this.execFileSync = opts.execFileSync || execFileSync;
        this.buffer = '';
        this.onLine = null;
        this.onClose = null;
        this.readStream = null;
        this.writeStream = null;
        this.opened = false;
    }

    static isSupported() {
        try {
            return process.platform === 'linux';
        } catch (e) {
            return false;
        }
    }

    static listPorts(opts = {}) {
        const fsImpl = opts.fs || fs;
        const out = [];
        const dirs = ['/dev/serial/by-id', '/dev'];
        const seen = new Set();
        for (const dir of dirs) {
            let entries;
            try { entries = fsImpl.readdirSync(dir); } catch (e) { continue; }
            for (const entry of entries) {
                if (!/^(ttyUSB|ttyACM|serial|ttyAMA|ttyS)/i.test(entry)) continue;
                const full = `${dir}/${entry}`;
                if (seen.has(full)) continue;
                seen.add(full);
                out.push(full);
            }
        }
        return out;
    }

    async start() {
        if (!this.devicePath) throw new Error('SERIAL_NO_DISPOSITIVO');
        if (!this.fs.existsSync(this.devicePath)) throw new Error('SERIAL_NO_EXISTE');
        try {
            this.execFileSync('stty', [
                '-F', this.devicePath,
                String(this.baudRate),
                'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke',
                'min', '1', 'time', '1',
            ], { stdio: 'ignore' });
        } catch (e) {
            throw new Error('SERIAL_CONFIG_FALLO');
        }
        try {
            this.readStream = this.fs.createReadStream(this.devicePath, { encoding: 'utf8' });
            this.writeStream = this.fs.createWriteStream(this.devicePath);
        } catch (e) {
            throw new Error('SERIAL_ABIERTA_FALLO');
        }
        this.readStream.on('data', (chunk) => this._feed(chunk));
        this.readStream.on('error', () => this._closed());
        this.readStream.on('end', () => this._closed());
        this.writeStream.on('error', () => this._closed());
        this.opened = true;
        return this;
    }

    _feed(text) {
        this.buffer += String(text).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line && this.onLine) {
                try { this.onLine(line); } catch (e) { /* el consumidor no debe romper el puerto */ }
            }
        }
    }

    send(line) {
        if (!this.writeStream) return Promise.resolve(false);
        try {
            this.writeStream.write(String(line) + '\n');
            return Promise.resolve(true);
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    _closed() {
        if (!this.opened) return;
        this.opened = false;
        if (this.onClose) {
            try { this.onClose(); } catch (e) { /* no romper */ }
        }
    }

    async close() {
        this.opened = false;
        if (this.readStream) {
            try { this.readStream.destroy(); } catch (e) { /* ya cerrado */ }
            this.readStream = null;
        }
        if (this.writeStream) {
            try { this.writeStream.end(); } catch (e) { /* ya cerrado */ }
            this.writeStream = null;
        }
    }
}

module.exports = { NodeSerialLineTransport };
