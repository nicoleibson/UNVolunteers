/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — LoRa Radio Driver v1.0 (Etapa 0)
 *  Driver de radio física LoRa (SX1276/SX1262) vía Web Serial.
 *  Cero dependencias; funciona en el navegador (window.LoRaRadioDriver)
 *  y en Node (module.exports) para test.
 *
 *  El navegador no controla SPI directamente: se comunica con un
 *  microcontrolador (ESP32 T-Beam, Heltec LoRa32, STM32-WL, RAK4631…)
 *  que ejecuta un firmware mínimo. Protocolo por líneas de texto:
 *
 *    Navegador → dispositivo:
 *      RESET
 *      CONFIG {"freq":915000000,"sf":10,"bw":125000,"txPower":20}
 *      TX <hex>
 *      RX ON / RX OFF
 *
 *    Dispositivo → navegador:
 *      OK
 *      ERROR <code>
 *      EVT READY {"radio":"SX1276","freq":915000000}
 *      EVT RX <hex> <rssi> <snr>
 *
 *  Regla de producción: el driver nunca inventa. Sin Web Serial o sin
 *  transporte conectado, connect()/transmit() devuelven {ok:false} con
 *  el motivo y la GUI lo reporta (SIN RADIO FÍSICA) sin degradar.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const CMD_RESET = 'RESET';
    const CMD_CONFIG = 'CONFIG';
    const CMD_TX = 'TX';
    const DEFAULT_BAUD = 115200;
    const DEFAULT_TIMEOUT_MS = 3000;

    function toHex(bytes) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function fromHex(hex) {
        const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return out;
    }

    /**
     * Transporte de líneas sobre Web Serial (navigator.serial).
     * Separa el flujo de bytes en líneas terminadas por '\n' y llama
     * `onLine`; `send(line)` escribe línea + newline.
     */
    class SerialLineTransport {
        constructor(port, baudRate) {
            this.port = port;
            this.baudRate = baudRate || DEFAULT_BAUD;
            this.reader = null;
            this.writer = null;
            this.buffer = '';
            this.onLine = null;
            this.onClose = null;
        }

        async start() {
            try {
                if (this.port.writable === undefined && typeof this.port.open === 'function') {
                    await this.port.open({ baudRate: this.baudRate });
                }
                this.reader = this.port.readable.getReader();
                this.writer = this.port.writable.getWriter();
            } catch (e) {
                throw new Error('SERIAL_OPEN_FAIL');
            }
            this._pump();
        }

        async _pump() {
            const decoder = new TextDecoder();
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    this._feed(decoder.decode(value, { stream: true }));
                }
            } catch (e) { /* puerto cerrado o error de lectura */ }
            if (this.onClose) this.onClose();
        }

        _feed(text) {
            this.buffer += text;
            let idx;
            while ((idx = this.buffer.indexOf('\n')) !== -1) {
                const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (line && this.onLine) this.onLine(line);
            }
        }

        send(line) {
            if (!this.writer) return Promise.resolve(false);
            try {
                this.writer.write(new TextEncoder().encode(line + '\n'));
                return Promise.resolve(true);
            } catch (e) {
                return Promise.resolve(false);
            }
        }

        async close() {
            try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ya cerrado */ }
            try { if (this.writer) this.writer.releaseLock(); } catch (e) { /* ya liberado */ }
            try { if (this.port && typeof this.port.close === 'function') await this.port.close(); } catch (e) { /* ya cerrado */ }
        }
    }

    /**
     * Driver de radio física LoRa. Usa un transporte inyectado (tests) o
     * crea uno sobre Web Serial al conectar.
     * @param {object} opts
     *  - transport: transporte con send(line)/close() y onLine asignable.
     *  - onFrame: (frame) => void — frame = { hex, rssi, snr, timestamp }.
     *  - onLog: (channel, msg) => void.
     *  - timeoutMs: timeout de confirmaciones (default 3000).
     */
    class LoRaRadioDriver {
        constructor(opts = {}) {
            this.transport = opts.transport || null;
            this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
            this.onFrame = opts.onFrame || null;
            this.onLog = opts.onLog || null;
            this.connected = false;
            this.radio = null;
            this.port = null;
            this._waiters = [];
        }

        static isSupported() {
            return !!(typeof navigator !== 'undefined' && navigator.serial);
        }

        static toHex(bytes) { return toHex(bytes); }
        static fromHex(hex) { return fromHex(hex); }

        _log(channel, msg) {
            if (this.onLog) this.onLog(channel, msg);
        }

        _waitForEvent(kinds, timeoutMs) {
            const kindsArr = Array.isArray(kinds) ? kinds : [kinds];
            return new Promise((resolve) => {
                const entry = { kinds: kindsArr, resolve, done: false };
                this._waiters.push(entry);
                setTimeout(() => {
                    if (!entry.done) {
                        entry.done = true;
                        this._waiters = this._waiters.filter((w) => w !== entry);
                        resolve(null);
                    }
                }, timeoutMs);
            });
        }

        _settle(kind, value) {
            this._waiters = this._waiters.filter((w) => {
                if (!w.kinds.includes(kind)) return true;
                w.done = true;
                w.resolve(value);
                return false;
            });
        }

        _handleLine(line) {
            if (line === 'OK') { this._settle('OK', { ok: true }); return; }
            if (line.startsWith('ERROR')) {
                const code = line.slice(6).trim() || 'ERROR';
                this._settle('ERROR', { ok: false, error: code });
                return;
            }
            if (line.startsWith('EVT ')) {
                const parts = line.split(' ');
                const kind = parts[1];
                if (kind === 'READY') {
                    let payload = {};
                    const jsonStart = line.indexOf('{');
                    if (jsonStart !== -1) {
                        try { payload = JSON.parse(line.slice(jsonStart)); } catch (e) { /* payload inválido */ }
                    }
                    this.radio = payload.radio || this.radio;
                    this._settle('READY', payload);
                    return;
                }
                if (kind === 'RX') {
                    const hex = parts[2] || '';
                    const rssi = parts[3] != null && parts[3] !== '' ? Number(parts[3]) : null;
                    const snr = parts[4] != null && parts[4] !== '' ? Number(parts[4]) : null;
                    if (hex && this.onFrame) {
                        this.onFrame({ hex, rssi, snr, timestamp: Date.now(), source: 'radio' });
                    }
                    return;
                }
                return;
            }
            // Líneas desconocidas se ignoran (logs del firmware, etc.)
        }

        /**
         * Conecta a la radio física. Devuelve {ok, connected, radio?, error?}.
         * Sin Web Serial → WEB_SERIAL_NO_DISPONIBLE (honesto, no inventa).
         */
        async connect(opts = {}) {
            let transport = this.transport;
            if (!transport) {
                if (!LoRaRadioDriver.isSupported()) {
                    return { ok: false, connected: false, error: 'WEB_SERIAL_NO_DISPONIBLE' };
                }
                try {
                    const ports = await navigator.serial.getPorts();
                    this.port = opts.port || ports[0] || (await navigator.serial.requestPort(
                        opts.filters ? { filters: opts.filters } : undefined
                    ));
                } catch (e) {
                    return { ok: false, connected: false, error: 'SERIAL_PORT_NO_DISPONIBLE' };
                }
                transport = new SerialLineTransport(this.port, opts.baudRate || DEFAULT_BAUD);
                this.transport = transport;
            }

            this._log('radio', 'Transporte enlazado — esperando al dispositivo');
            transport.onLine = (line) => this._handleLine(line);
            if (typeof transport.start === 'function') {
                try { await transport.start(); } catch (e) {
                    return { ok: false, connected: false, error: 'SERIAL_ABIERTA_FALLO' };
                }
            }

            try { transport.send(CMD_RESET); } catch (e) { /* se resuelve por timeout */ }
            const ready = await this._waitForEvent(['READY', 'ERROR'], this.timeoutMs);
            if (!ready || ready.ok === false) {
                this.connected = false;
                return {
                    ok: false,
                    connected: false,
                    error: ready && ready.ok === false ? ready.error : 'SIN_RESPUESTA_DEL_RADIO',
                };
            }
            this.connected = true;
            this._log('radio', `Radio física lista (${ready.radio || this.name || 'SX1276'})`);
            return { ok: true, connected: true, radio: ready.radio || this.name || 'SX1276' };
        }

        /** Configura frecuencia/SF/bandwidth/potencia del transceptor físico. */
        async configure(cfg = {}) {
            if (!this.connected) return { ok: false, error: 'NO_CONECTADO' };
            const payload = JSON.stringify({
                freq: cfg.frequency != null ? cfg.frequency : null,
                sf: cfg.spreadingFactor != null ? cfg.spreadingFactor : null,
                bw: cfg.bandwidth != null ? cfg.bandwidth : null,
                txPower: cfg.txPower != null ? cfg.txPower : null,
            });
            this._log('radio', `CONFIG ${payload}`);
            try { this.transport.send([CMD_CONFIG, payload].join(' ')); } catch (e) {
                return { ok: false, error: 'CONFIG_SIN_ENVIO' };
            }
            const res = await this._waitForEvent(['OK', 'ERROR'], this.timeoutMs);
            if (!res) return { ok: false, error: 'CONFIG_SIN_CONFIRMACION' };
            return res;
        }

        /**
         * Transmite un payload (Uint8Array o hex) por la radio física.
         * Espera confirmación OK/ERROR del firmware.
         */
        async transmit(payload) {
            if (!this.connected) return { ok: false, error: 'NO_CONECTADO' };
            const hex = typeof payload === 'string' ? payload : toHex(payload);
            if (!hex) return { ok: false, error: 'TX_VACIO' };
            this._log('radio', `TX ${hex.length / 2}B por radio física`);
            try { this.transport.send([CMD_TX, hex].join(' ')); } catch (e) {
                return { ok: false, error: 'TX_SIN_ENVIO' };
            }
            const res = await this._waitForEvent(['OK', 'ERROR'], this.timeoutMs);
            if (!res) return { ok: false, error: 'TX_SIN_CONFIRMACION' };
            return { ...res, bytes: hex.length / 2 };
        }

        status() {
            return {
                connected: this.connected,
                supported: LoRaRadioDriver.isSupported(),
                radio: this.radio,
                transport: this.transport ? (this.port ? 'serial' : 'mock') : null,
            };
        }

        async close() {
            this.connected = false;
            this._waiters.forEach((w) => { w.done = true; w.resolve(null); });
            this._waiters = [];
            if (this.transport && typeof this.transport.close === 'function') {
                try { await this.transport.close(); } catch (e) { /* ya cerrado */ }
            }
        }
    }

    const api = { LoRaRadioDriver, SerialLineTransport, toHex, fromHex, CMD_RESET, CMD_CONFIG, CMD_TX };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.LoRaRadioDriver = LoRaRadioDriver;
        global.SerialLineTransport = SerialLineTransport;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
