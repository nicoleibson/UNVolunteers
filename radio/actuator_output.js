/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Actuator Output (Etapa 3)
 *  Salidas para alertas tempranas (P-Wave).
 *  Utiliza el sistema nativo de Android (Termux API) en Node o
 *  Web API (Navigator) en el navegador. Cero dependencias.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    class ActuatorOutput {
        constructor(opts = {}) {
            this.onLog = opts.onLog || null;
            this.enabled = opts.enabled !== false;
            this.execSync = IS_NODE ? require('child_process').execSync : null;
            // Flag inyectable para mocks en pruebas
            this._mockExec = opts._mockExec || null;
            this._mockWeb = opts._mockWeb || null;
        }

        _log(msg) {
            if (this.onLog) this.onLog('actuator', msg);
        }

        triggerAlert(level, message) {
            if (!this.enabled) return;
            this._log(`DISPARO ALERTA [${level}]: ${message}`);

            if (IS_NODE) {
                const exec = this._mockExec || this.execSync;
                try {
                    exec('termux-vibrate -d 2000', { stdio: 'ignore' });
                } catch (e) {
                    this._log('Fallo termux-vibrate');
                }
                
                try {
                    // Escapamos comillas dobles rudimentariamente
                    const safeMessage = String(message).replace(/"/g, '\\"');
                    exec(`termux-notification --title "ALERTA SÍSMICA" --content "${safeMessage}" --priority high`, { stdio: 'ignore' });
                } catch (e) {
                    this._log('Fallo termux-notification');
                }
            } else {
                const nav = this._mockWeb || (typeof navigator !== 'undefined' ? navigator : null);
                if (nav && typeof nav.vibrate === 'function') {
                    nav.vibrate([1000, 500, 1000]);
                }
                
                const Notif = this._mockWeb ? this._mockWeb.Notification : (typeof global.Notification !== 'undefined' ? global.Notification : null);
                if (Notif && Notif.permission === 'granted') {
                    try {
                        new Notif("ALERTA SÍSMICA", { body: message, requireInteraction: true });
                    } catch(e) {}
                }
            }
        }
    }

    const api = { ActuatorOutput };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.ActuatorOutput = ActuatorOutput;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
