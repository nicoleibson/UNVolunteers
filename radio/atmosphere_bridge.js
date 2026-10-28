/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Atmosphere Bridge v1.0
 *  Sensores de gases y atmósfera subterránea para el Scout:
 *  CO (monóxido) y O2 (oxígeno) vía Web Bluetooth (GATT estándar
 *  Environmental Sensing 0x181A). Cero dependencias; navegador
 *  (window.LifelineAtmosphereBridge) y Node (module.exports).
 *
 *  Servicios GATT estándar:
 *    - Carbon Monoxide Concentration  0x2BD0 (u16, ppm)
 *    - Oxygen Concentration           0x2BD5 (u16, %)
 *
 *  Utilidad en barrido: si el Scout se acerca a una zona de colapso
 *  con fuga de gas, `evaluateAtmosphere` marca level HAZARD/SEVERE y
 *  `audible=true` → la GUI genera una alerta sonora INMEDIATA.
 *
 *  Regla de producción: sin Web Bluetooth o sin servicio ambiental,
 *  la lectura queda null — nunca se inventa una concentración.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const ENV_SERVICE = 0x181A;
    const CO_CHAR = 0x2BD0;   // Carbon Monoxide Concentration (ppm)
    const O2_CHAR = 0x2BD5;   // Oxygen Concentration (%)

    /** CO (0x2BD0): u16 LE → ppm. */
    function parseCO(bytes) {
        if (!bytes || bytes.length < 2) return null;
        return { coPpm: bytes[0] | (bytes[1] << 8) };
    }

    /** O2 (0x2BD5): u16 LE → % (se divide entre 100 para el % real). */
    function parseO2(bytes) {
        if (!bytes || bytes.length < 2) return null;
        const raw = bytes[0] | (bytes[1] << 8);
        return { o2Pct: raw / 100 };
    }

    /**
     * Evalúa el riesgo atmosférico a partir de lecturas reales.
     * Umbrales honestos (exposición ocupacional / deficiencia de O2):
     *   CO: <35 ppm SAFE · 35-199 WATCH · 200-1199 HAZARD · ≥1200 SEVERE
     *   O2: ≥19.5% SAFE · 16-19.4 WATCH · 10-15.9 HAZARD · <10 SEVERE
     * El peor de ambos define el nivel. `audible` (alerta sonora
     * inmediata) solo en HAZARD/SEVERE. lecturas null → SAFE sin aviso.
     * @param {number|null} coPpm
     * @param {number|null} o2Pct
     * @returns {{level:'SAFE'|'WATCH'|'HAZARD'|'SEVERE', audible:boolean,
     *            co:number|null, o2:number|null, reasons:string[]}}
     */
    function evaluateAtmosphere(coPpm, o2Pct) {
        const reasons = [];
        let level = 'SAFE';

        function worsen(newLevel) {
            const order = ['SAFE', 'WATCH', 'HAZARD', 'SEVERE'];
            if (order.indexOf(newLevel) > order.indexOf(level)) level = newLevel;
        }

        if (coPpm != null) {
            if (coPpm >= 1200) { worsen('SEVERE'); reasons.push(`CO ${coPpm} ppm — nivel inmediatamente peligroso (IDLH)`); }
            else if (coPpm >= 200) { worsen('HAZARD'); reasons.push(`CO ${coPpm} ppm — riesgo de intoxicación`); }
            else if (coPpm >= 35) { worsen('WATCH'); reasons.push(`CO ${coPpm} ppm — elevar atención`); }
        }
        if (o2Pct != null) {
            if (o2Pct < 10) { worsen('SEVERE'); reasons.push(`O2 ${o2Pct.toFixed(1)}% — hipoxia grave`); }
            else if (o2Pct < 16) { worsen('HAZARD'); reasons.push(`O2 ${o2Pct.toFixed(1)}% — atmósfera con riesgo`); }
            else if (o2Pct < 19.5) { worsen('WATCH'); reasons.push(`O2 ${o2Pct.toFixed(1)}% — deficiencia de oxígeno`); }
        }

        return {
            level,
            audible: level === 'HAZARD' || level === 'SEVERE',
            co: coPpm != null ? coPpm : null,
            o2: o2Pct != null ? o2Pct : null,
            reasons,
        };
    }

    function toBytes(value) {
        if (value instanceof Uint8Array) return value;
        if (value && value.buffer) return new Uint8Array(value.buffer);
        if (Array.isArray(value)) return new Uint8Array(value);
        return null;
    }

    /**
     * Puente de atmósfera BLE. `onReading({coPpm?, o2Pct?})` recibe
     * concentraciones reales; `onStatus({connected, services})` el estado.
     * Para tests se inyecta un device GATT falso vía attach(device).
     */
    class LifelineAtmosphereBridge {
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
                optionalServices: [ENV_SERVICE],
            });
        }

        async connect(opts = {}) {
            if (!this.device) {
                if (!LifelineAtmosphereBridge.isSupported()) {
                    return { ok: false, connected: false, error: 'WEB_BLUETOOTH_NO_DISPONIBLE' };
                }
                try {
                    this.device = opts.device || await LifelineAtmosphereBridge.requestDevice();
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

                await this._wireService(server, ENV_SERVICE, CO_CHAR, 'CO', (bytes) => {
                    const r = parseCO(bytes);
                    return r ? { coPpm: r.coPpm } : null;
                });
                await this._wireService(server, ENV_SERVICE, O2_CHAR, 'O2', (bytes) => {
                    return parseO2(bytes);
                });

                if (this.services.length === 0) {
                    this.error = 'SIN_SERVICIO_AMBIENTAL';
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
                return; // concentración no presente en este sensor
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
        LifelineAtmosphereBridge,
        parseCO,
        parseO2,
        evaluateAtmosphere,
        ENV_SERVICE,
        CO_CHAR,
        O2_CHAR,
    };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.LifelineAtmosphereBridge = LifelineAtmosphereBridge;
        global.evaluateAtmosphere = evaluateAtmosphere;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
