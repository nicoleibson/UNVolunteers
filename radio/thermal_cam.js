/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Thermal Cam (proximidad) v1.0
 *  Telemetría térmica de baja resolución para el Scout: soporte de
 *  mini-sensores IR (chips MLX90640: rejilla 32×24) vía Web Serial /
 *  transportes inyectables. Cero dependencias; navegador
 *  (window.ThermalCam) y Node (module.exports).
 *
 *  Utilidad en barrido: al escanear una estructura colapsada detecta
 *  firmas térmicas corporales (36-37 °C) a través de pequeñas
 *  aberturas, complementando la radiofrecuencia cuando el teléfono de
 *  la víctima está sin batería.
 *
 *  Regla de producción: sin transporte vinculado no hay rejilla — la
 *  GUI queda vacía (null). Nunca se inventa un mapa térmico.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const DEFAULT_W = 32;
    const DEFAULT_H = 24;

    /**
     * Parsea una rejilla térmica en temperaturas (°C).
     * Acepta:
     *   - {width, height, raw}: raw Uint8Array/Array de int16 LE °C
     *   - {width, height, temps}: Float32Array/Array de °C ya decodificados
     * Devuelve {width, height, temps: Float32Array}.
     */
    function parseThermalGrid(input) {
        if (!input) return null;
        const w = input.width || DEFAULT_W;
        const h = input.height || DEFAULT_H;
        const expected = w * h;
        const temps = new Float32Array(expected);

        if (input.temps) {
            const src = input.temps;
            for (let i = 0; i < expected && i < src.length; i++) temps[i] = src[i];
            return { width: w, height: h, temps };
        }

        const raw = input.raw;
        if (!raw) return null;
        for (let i = 0; i < expected && i < raw.length - 1; i++) {
            temps[i] = raw[i] | (raw[i + 1] << 8); // int16 LE (°C)
        }
        return { width: w, height: h, temps };
    }

    /**
     * Detecta firmas humanas en la rejilla: píxeles con temperatura
     * corporal (por defecto 36-37 °C). Devuelve contador, píxeles y los
     * hot-spots (máximos) como coordenadas {x, y, temp}.
     * @param {Float32Array} temps
     * @param {{width?:number,height?:number,minTemp?:number,maxTemp?:number}} [opts]
     * @returns {{count:number, humanPixels:number, hotspots:Array,
     *            minTemp:number, maxTemp:number}}
     */
    function detectHumanSignatures(temps, opts = {}) {
        const w = opts.width || DEFAULT_W;
        const h = opts.height || DEFAULT_H;
        const minTemp = opts.minTemp !== undefined ? opts.minTemp : 36;
        const maxTemp = opts.maxTemp !== undefined ? opts.maxTemp : 37;
        const hotspots = [];
        let humanPixels = 0;
        let maxTempSeen = -Infinity;
        let minTempSeen = Infinity;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const t = temps[y * w + x];
                if (t > maxTempSeen) maxTempSeen = t;
                if (t < minTempSeen) minTempSeen = t;
                if (t >= minTemp && t <= maxTemp) {
                    humanPixels++;
                    hotspots.push({ x, y, temp: t });
                }
            }
        }
        // Ordenar por temperatura desc (hot-spot más cálido primero)
        hotspots.sort((a, b) => b.temp - a.temp);

        return {
            count: hotspots.length > 0 ? 1 : 0,
            humanPixels,
            hotspots,
            minTemp: minTempSeen === Infinity ? null : minTempSeen,
            maxTemp: maxTempSeen === -Infinity ? null : maxTempSeen,
        };
    }

    /**
     * Cámara térmica sobre un transporte de líneas (estilo radio_driver).
     * El transporte debe exponer onLine(cb). Protocolo de líneas:
     *   THERMAL <hex de int16 LE °C, 32×24>
     * `onFrame({width, height, temps, humans})` recibe cada mapa real.
     */
    class ThermalCam {
        constructor(opts = {}) {
            this.onFrame = opts.onFrame || null;
            this.onStatus = opts.onStatus || null;
            this.transport = null;
            this.connected = false;
            this.error = null;
            this._onLine = null;
        }

        /** Vincula un transporte (real por Web Serial o fake en tests). */
        attach(transport) {
            this.transport = transport;
            this.connected = false;
            this.error = null;
            if (!transport) {
                this.error = 'SIN_TRANSPORTE';
                return { ok: false, connected: false, error: this.error };
            }
            const w = transport.width || DEFAULT_W;
            const h = transport.height || DEFAULT_H;
            this._onLine = (line) => {
                if (!line || line.indexOf('THERMAL ') !== 0) return;
                const hex = line.slice('THERMAL '.length).replace(/\s/g, '');
                if (hex.length < 2) return;
                const raw = new Uint8Array(hex.length / 2);
                for (let i = 0; i < raw.length; i++) {
                    raw[i] = parseInt(hex.substr(i * 2, 2), 16);
                }
                const grid = parseThermalGrid({ width: w, height: h, raw });
                if (!grid) return;
                const humans = detectHumanSignatures(grid.temps, { width: w, height: h });
                if (this.onFrame) this.onFrame({ width: w, height: h, temps: grid.temps, humans });
            };
            if (typeof transport.onLine === 'function') {
                transport.onLine(this._onLine);
            }
            this.connected = true;
            if (this.onStatus) this.onStatus({ connected: true });
            return { ok: true, connected: true };
        }

        async close() {
            this.connected = false;
            if (this.transport && typeof this.transport.removeLine === 'function') {
                try { this.transport.removeLine(this._onLine); } catch (e) { /* ya cerrado */ }
            }
        }
    }

    const api = {
        ThermalCam,
        parseThermalGrid,
        detectHumanSignatures,
        DEFAULT_W,
        DEFAULT_H,
    };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.ThermalCam = ThermalCam;
        global.parseThermalGrid = parseThermalGrid;
        global.detectHumanSignatures = detectHumanSignatures;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
