/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — GNSS Reader (Etapa 2)
 *  Ingestión de módulo GPS/GNSS UART (NMEA/UBX) con brújula.
 *  Cero dependencias.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function parseNmeaLatLon(value, dir) {
        if (!value || !dir) return null;
        const dot = value.indexOf('.');
        if (dot === -1) return null;
        const degStr = value.substring(0, dot - 2);
        const minStr = value.substring(dot - 2);
        let deg = parseFloat(degStr) + parseFloat(minStr) / 60;
        if (dir === 'S' || dir === 'W') deg = -deg;
        return deg;
    }

    class GnssReader {
        constructor(opts = {}) {
            this.transport = opts.transport || null;
            this.onPosition = opts.onPosition || null;
            this.onHeading = opts.onHeading || null;
            this.onLog = opts.onLog || null;
            this.connected = false;
            
            this.state = {
                lat: null,
                lon: null,
                alt: null,
                heading: null,
                fix: false
            };
        }

        static isSupported() {
            return !!(typeof navigator !== 'undefined' && navigator.serial);
        }

        _log(msg) {
            if (this.onLog) this.onLog('gnss', msg);
        }

        _handleLine(line) {
            if (!line.startsWith('$')) return;
            const parts = line.split('*')[0].split(',');
            const type = parts[0];

            if (type === '$GPRMC' || type === '$GNRMC') {
                const status = parts[2];
                if (status === 'A') {
                    this.state.fix = true;
                    this.state.lat = parseNmeaLatLon(parts[3], parts[4]);
                    this.state.lon = parseNmeaLatLon(parts[5], parts[6]);
                    if (this.onPosition) this.onPosition(this.state);
                } else {
                    this.state.fix = false;
                }
            } else if (type === '$GPGGA' || type === '$GNGGA') {
                const fixQuality = parseInt(parts[6] || '0', 10);
                if (fixQuality > 0) {
                    this.state.fix = true;
                    this.state.lat = parseNmeaLatLon(parts[2], parts[3]);
                    this.state.lon = parseNmeaLatLon(parts[4], parts[5]);
                    this.state.alt = parseFloat(parts[9]) || null;
                    if (this.onPosition) this.onPosition(this.state);
                } else {
                    this.state.fix = false;
                }
            } else if (type === '$HCHDG' || type === '$HEHDT') {
                const heading = parseFloat(parts[1]);
                if (!isNaN(heading)) {
                    this.state.heading = heading;
                    if (this.onHeading) this.onHeading(this.state.heading);
                }
            }
        }

        async connect(opts = {}) {
            if (!this.transport) {
                if (!GnssReader.isSupported()) {
                    return { ok: false, connected: false, error: 'WEB_SERIAL_NO_DISPONIBLE' };
                }
                try {
                    const ports = await navigator.serial.getPorts();
                    const port = opts.port || ports[0] || (await navigator.serial.requestPort());
                    if (typeof global.SerialLineTransport !== 'undefined') {
                        this.transport = new global.SerialLineTransport(port, opts.baudRate || 9600);
                    } else {
                        return { ok: false, connected: false, error: 'NO_TRANSPORT' };
                    }
                } catch (e) {
                    return { ok: false, connected: false, error: 'SERIAL_PORT_NO_DISPONIBLE' };
                }
            }

            this.transport.onLine = (line) => this._handleLine(line);
            
            if (typeof this.transport.start === 'function') {
                try { await this.transport.start(); } catch(e) {
                    return { ok: false, connected: false, error: 'SERIAL_ABIERTA_FALLO' };
                }
            }

            this.connected = true;
            this._log('GNSS conectado');
            return { ok: true, connected: true };
        }

        async close() {
            this.connected = false;
            if (this.transport && typeof this.transport.close === 'function') {
                try { await this.transport.close(); } catch(e) { }
            }
        }
    }

    const api = { GnssReader, parseNmeaLatLon };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.GnssReader = GnssReader;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
