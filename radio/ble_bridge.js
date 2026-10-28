/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — BLE Biometric Bridge v1.0 (Etapa 0)
 *  Puente de vitales reales (BPM/SpO2) desde un wearable BLE vía
 *  Web Bluetooth. Cero dependencias; navegador (window.LifelineBleBridge)
 *  y Node (module.exports) para test.
 *
 *  Servicios GATT estándar:
 *    - Heart Rate Service  0x180D → Heart Rate Measurement 0x2A37
 *    - Pulse Oximeter Svc   0x1822 → Continuous Measurement  0x2A5F
 *
 *  Regla de producción: sin Web Bluetooth o sin servicios vitales, la
 *  GUI queda en «—» (null) — el puente nunca inventa una lectura.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const BLE_HR_SERVICE = 0x180D;
    const BLE_HR_CHAR = 0x2A37;
    const BLE_PLX_SERVICE = 0x1822;
    const BLE_PLX_CONT_CHAR = 0x2A5F;

    /** Parsea Heart Rate Measurement (0x2A37). Devuelve {bpm} o null. */
    function parseHeartRate(bytes) {
        if (!bytes || bytes.length < 2) return null;
        const flags = bytes[0];
        if (flags & 0x01) {
            if (bytes.length < 3) return null;
            return { bpm: bytes[1] | (bytes[2] << 8) };
        }
        return { bpm: bytes[1] };
    }

    /**
     * Parsea Pulse Oximeter Continuous Measurement (0x2A5F).
     * Flags: bit0 SpO2 8-bit · bit1 SpO2 16-bit · bit2 PR 8-bit ·
     * bit3 PR 16-bit. Devuelve {spo2, bpm} (campos ausentes → null).
     */
    function parsePulseOximeter(bytes) {
        if (!bytes || bytes.length < 2) return null;
        const flags = bytes[0];
        let i = 1;
        let spo2 = null;
        let bpm = null;
        if (flags & 0x01) { spo2 = bytes[i++]; }
        else if (flags & 0x02) { spo2 = bytes[i] | (bytes[i + 1] << 8); i += 2; }
        if (flags & 0x04) { bpm = bytes[i++]; }
        else if (flags & 0x08) { bpm = bytes[i] | (bytes[i + 1] << 8); i += 2; }
        return { spo2, bpm };
    }

    function toBytes(value) {
        if (value instanceof Uint8Array) return value;
        if (value && value.buffer) return new Uint8Array(value.buffer);
        if (Array.isArray(value)) return new Uint8Array(value);
        return null;
    }

    /**
     * Puente BLE. `onReading({bpm?, spo2?})` recibe lecturas reales;
     * `onStatus({connected, services})` el estado del enlace.
     * Para tests se inyecta un device GATT falso vía attach(device).
     */
    class LifelineBleBridge {
        constructor(opts = {}) {
            this.onReading = opts.onReading || null;
            this.onStatus = opts.onStatus || null;
            this.device = null;
            this.services = [];
            this.connected = false;
            this.error = null;
            this._handlers = [];
        }

        static isSupported() {
            return !!(typeof navigator !== 'undefined' && navigator.bluetooth);
        }

        static requestDevice() {
            return navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [BLE_HR_SERVICE, BLE_PLX_SERVICE],
            });
        }

        async connect(opts = {}) {
            if (!this.device) {
                if (!LifelineBleBridge.isSupported()) {
                    return { ok: false, connected: false, error: 'WEB_BLUETOOTH_NO_DISPONIBLE' };
                }
                try {
                    this.device = opts.device || await LifelineBleBridge.requestDevice();
                } catch (e) {
                    return { ok: false, connected: false, error: 'BLE_EMPAREJAMIENTO_CANCELADO' };
                }
            }
            return this.attach(this.device);
        }

        /** Enlaza un dispositivo GATT (real o fake) y suscribe notificaciones. */
        async attach(device) {
            this.device = device;
            this.connected = false;
            this.error = null;
            this.services = [];
            try {
                const server = device.gatt && typeof device.gatt.connect === 'function'
                    ? await device.gatt.connect()
                    : (device.gatt || device);

                await this._wireService(server, BLE_HR_SERVICE, BLE_HR_CHAR, 'HR', (bytes) => {
                    const r = parseHeartRate(bytes);
                    return r ? { bpm: r.bpm } : null;
                });
                await this._wireService(server, BLE_PLX_SERVICE, BLE_PLX_CONT_CHAR, 'PLX', (bytes) => {
                    return parsePulseOximeter(bytes);
                });

                if (this.services.length === 0) {
                    this.error = 'BLE_SIN_SERVICIOS_VITALES';
                    return { ok: false, connected: true, error: this.error, services: this.services };
                }
                this.connected = true;
                if (this.onStatus) this.onStatus({ connected: true, services: this.services });
                return { ok: true, connected: true, services: this.services };
            } catch (e) {
                this.error = 'BLE_GATT_ERROR';
                return { ok: false, connected: false, error: this.error };
            }
        }

        async _wireService(server, svcUuid, charUuid, name, parser) {
            let char;
            try {
                const svc = await server.getPrimaryService(svcUuid);
                char = await svc.getCharacteristic(charUuid);
            } catch (e) {
                return; // servicio ausente en este wearable
            }
            await char.startNotifications();
            const handler = (ev) => {
                const raw = ev && ev.target && ev.target.value ? ev.target.value : ev;
                const bytes = toBytes(raw);
                const reading = bytes ? parser(bytes) : null;
                if (reading && this.onReading) this.onReading(reading);
            };
            if (typeof char.addEventListener === 'function') {
                char.addEventListener('characteristicvaluechanged', handler);
            }
            this._handlers.push(handler);
            this.services.push(name);
        }

        async close() {
            this.connected = false;
            this._handlers = [];
            if (this.device && this.device.gatt && typeof this.device.gatt.disconnect === 'function') {
                try { this.device.gatt.disconnect(); } catch (e) { /* ya desconectado */ }
            }
        }
    }

    const api = {
        LifelineBleBridge,
        parseHeartRate,
        parsePulseOximeter,
        BLE_HR_SERVICE,
        BLE_HR_CHAR,
        BLE_PLX_SERVICE,
        BLE_PLX_CONT_CHAR,
    };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.LifelineBleBridge = LifelineBleBridge;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
