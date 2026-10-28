/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Wake-up Radio Controller v1.0
 *  Escucha ultra-baja de consumo (BLE HCI SoC) que despierta los
 *  sensores de alcance (UWB/radar, térmica, gas) SOLO al detectar una
 *  firma de proximidad. Evita mantener los radares de alta precisión
 *  siempre activos (ahorro de batería del Scout).
 *  Cero dependencias. Navegador (window.WakeRadioController) y Node.
 *
 *  Regla de producción: el controlador NUNCA inventa una detección —
 *  solo reacciona a signalProximity() (llamado por el callback del
 *  HCI/transporte real). Estado inicial OFF; enable() → IDLE.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const ST_OFF = 'OFF';
    const ST_IDLE = 'IDLE';
    const ST_ACTIVE = 'ACTIVE';

    /**
     * @param {{idleMs?:number, activeMs?:number, dutyCycle?:number,
     *          onActivate?:Function, onIdle?:Function, clock?:Function}} [opts]
     *  - idleMs: intervalo de la escucha pasiva (por defecto 1000 ms).
     *  - activeMs: ventana de actividad tras un despertar (por defecto 8000 ms).
     *  - dutyCycle: fracción de tiempo en escucha activa (por defecto 0.05).
     *  - clock: () => ms (inyectable para tests; por defecto Date.now).
     */
    class WakeRadioController {
        constructor(opts = {}) {
            this.idleMs = opts.idleMs != null ? opts.idleMs : 1000;
            this.activeMs = opts.activeMs != null ? opts.activeMs : 8000;
            this.dutyCycle = opts.dutyCycle != null ? opts.dutyCycle : 0.05;
            this.onActivate = opts.onActivate || null;
            this.onIdle = opts.onIdle || null;
            this.clock = opts.clock || (() => Date.now());
            this.state = ST_OFF;
            this.enabled = false;
            this.activations = 0;
            this._activeUntil = 0;
            this._listening = false;
        }

        /** Activa la escucha ultra-baja (transición OFF → IDLE). */
        enable() {
            this.enabled = true;
            if (this.state === ST_OFF) {
                this.state = ST_IDLE;
                this._listening = this._sampleDuty();
            }
            return this.getState();
        }

        /** Desactiva por completo (IDLE/ACTIVE → OFF). */
        disable() {
            this.enabled = false;
            this.state = ST_OFF;
            this._listening = false;
            return this.getState();
        }

        /**
         * Firma de proximidad detectada por el HCI/transporte real:
         * despierta los sensores de alcance (→ ACTIVE) durante activeMs
         * y vuelve a IDLE. Sin efecto si está OFF o ya ACTIVE.
         */
        signalProximity() {
            if (!this.enabled) return this.getState();
            if (this.state === ST_ACTIVE) return this.getState(); // ya despierto
            this.activations++;
            this.state = ST_ACTIVE;
            this._listening = true;
            this._activeUntil = this.clock() + this.activeMs;
            if (this.onActivate) this.onActivate();
            return this.getState();
        }

        /**
         * Avanza el reloj (llamado por un timer o manualmente en tests).
         * Si ACTIVE y venció la ventana → vuelve a IDLE (escucha pasiva).
         */
        tick(now) {
            now = now != null ? now : this.clock();
            if (this.state === ST_ACTIVE && now >= this._activeUntil) {
                this.state = ST_IDLE;
                this._listening = this._sampleDuty();
                if (this.onIdle) this.onIdle();
            }
            return this.getState();
        }

        _sampleDuty() {
            const r = this._rand() < this.dutyCycle;
            return r;
        }

        _rand() {
            return Math.random();
        }

        getState() {
            return {
                state: this.state,
                enabled: this.enabled,
                listening: this._listening,
                activations: this.activations,
                activeMs: this.activeMs,
                idleMs: this.idleMs,
                dutyCycle: this.dutyCycle,
            };
        }
    }

    const api = { WakeRadioController, ST_OFF, ST_IDLE, ST_ACTIVE };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.WakeRadioController = WakeRadioController;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));