/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Field Serial Bridge (datos de campo)
 *  Puente real de telemetría para el Scout: canal de datos por
 *  USB Serial (Web Serial) que alimenta el dispositivo del usuario.
 *  Cero dependencias; navegador (window.LifelineFieldBridge) y Node
 *  (module.exports) para test.
 *
 *  Protocolo de líneas (una por línea, newline):
 *    UWB <metros>               → distancia ToF (chip UWB)
 *    ORI <alpha> <beta> <gamma> → orientación IMU/brújula (grados)
 *    THERMAL <hex>              → rejilla IR int16 LE (32×24)
 *
 *  Regla de producción: sin puerto serial real abierto no hay dato;
 *  los callbacks no disparan si no llega una línea real del puerto.
 *  En tests se inyectan líneas con `injectLine`/`injectChunk`.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const DEFAULT_W = 32;
    const DEFAULT_H = 24;

    function isSupported() {
        return !!(typeof global.navigator !== 'undefined' &&
            global.navigator.serial &&
            typeof global.navigator.serial.requestPort === 'function');
    }

    /** Extrae el valor de una línea simple "KEY valor". */
    function parseSimple(line, prefix) {
        const idx = line.indexOf(`${prefix} `);
        if (idx !== 0) return null;
        return line.slice(prefix.length + 1).trim();
    }

    class LifelineFieldBridge {
        constructor(opts = {}) {
            this.onStatus = opts.onStatus || null;
            this.width = opts.width || DEFAULT_W;
            this.height = opts.height || DEFAULT_H;
            this.port = null;
            this.connected = false;
            this.error = null;
            this._buf = '';
            this._lineHandlers = [];
            this._thermCb = null;
        }

        static isSupported() { return isSupported(); }

        /** Registra un manejador de línea completa (para UWB / ORI). */
        onLine(cb) {
            this._lineHandlers.push(cb);
            return () => {
                const i = this._lineHandlers.indexOf(cb);
                if (i >= 0) this._lineHandlers.splice(i, 1);
            };
        }

        /** Abre un puerto por la selección Web Serial del usuario. */
        async open() {
            if (!isSupported()) {
                return { ok: false, connected: false, error: 'WEB_SERIAL_NO_DISPONIBLE' };
            }
            try {
                this.port = await global.navigator.serial.requestPort();
            } catch (e) {
                return { ok: false, connected: false, error: 'SERIAL_CANCELADO' };
            }
            try {
                return this.attach(this.port);
            } catch (e) {
                return { ok: false, connected: false, error: 'SERIAL_ERROR' };
            }
        }

        /** Enlaza un puerto (o fake en tests) y arranca el bucle de lectura. */
        async attach(port) {
            this.port = port || this.port;
            this.connected = false;
            this.error = null;
            if (!this.port) return { ok: false, connected: false, error: 'SIN_PUERTO' };
            try {
                if (this.port.open && typeof this.port.open === 'function' && !this.port.__opened) {
                    await this.port.open({ baudRate: 115200 });
                    this.port.__opened = true;
                }
                this.connected = true;
                if (this.onStatus) this.onStatus({ connected: true });
                if (this.port.readable && typeof this.port.readable.getReader === 'function') {
                    this._pump(this.port.readable.getReader());
                }
                return { ok: true, connected: true };
            } catch (e) {
                this.error = (e && e.message) || 'SERIAL_ERROR';
                return { ok: false, connected: false, error: this.error };
            }
        }

        async _pump(reader) {
            this._reader = reader;
            try {
                while (this._reader && this.connected) {
                    const { value, done } = await this._reader.read();
                    if (done) break;
                    this._ingest(value);
                }
            } catch (e) { /* puerto cerrado */ }
        }

        /** Parte el texto en líneas y despacha cada una completa. */
        _ingest(chunk) {
            if (chunk == null) return;
            const text = typeof chunk === 'string'
                ? chunk
                : new TextDecoder().decode(chunk);
            this._buf += text;
            let nl;
            while ((nl = this._buf.indexOf('\n')) >= 0) {
                const line = this._buf.slice(0, nl).trim();
                this._buf = this._buf.slice(nl + 1);
                if (line) this._dispatch(line);
            }
        }

        _dispatch(line) {
            this._lineHandlers.slice().forEach((fn) => { try { fn(line); } catch (e) { /* aislado */ } });
            if (this._thermCb && line.indexOf('THERMAL ') === 0) {
                this._thermCb(line);
            }
        }

        /** Transporte que la cinta térmica (thermal_cam) puede enlazar. */
        get thermalTransport() {
            return {
                width: this.width,
                height: this.height,
                onLine: (cb) => { this._thermCb = cb; },
            };
        }

        /** Hook de prueba: inyecta una línea como si viniera del puerto. */
        injectLine(line) { this._dispatch(String(line).trim()); }

        /** Hook de prueba: inyecta un fragmento de texto (puede partir líneas). */
        injectChunk(chunk) { this._ingest(chunk); }

        async close() {
            this.connected = false;
            this._thermCb = null;
            this._lineHandlers = [];
            if (this.port && typeof this.port.close === 'function') {
                try { await this.port.close(); } catch (e) { /* ya cerrado */ }
            }
        }
    }

    const api = { LifelineFieldBridge, parseSimple, isSupported, DEFAULT_W, DEFAULT_H };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.LifelineFieldBridge = LifelineFieldBridge;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
