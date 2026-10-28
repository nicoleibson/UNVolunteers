/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — EmergencyRadio (recepción AM/FM de rescate)
 *  Si el usuario queda atrapado y hay emisiones de radio de
 *  emergencia (AM/FM), permite escuchar las instrucciones de los
 *  rescatistas.
 *
 *  REALIDAD HONESTA: un teléfono no tiene transmisor AM/FM, y su
 *  sintonizador FM interno (si existe) NO es controlable desde un
 *  navegador (sin API web). Por eso este módulo recibe el espectro a
 *  través de un ADAPTADOR SDR inyectable (RTL-SDR / HackRF por USB o
 *  serial). Sin adaptador → SIN_SDR: no se inventa audio ni señal.
 *
 *  API del adaptador SDR: { available, tune(freqMhz,{mode:'AM'|'FM'}),
 *                            onAudio(cb)->unsub, scan()->[{freq,mode,signal}] }
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    // Canales de emergencia comunes a intentar (configurables, honestos).
    const DEFAULT_EMERGENCY = [
        { freq: 105.5, mode: 'FM', label: 'Emisión FM cercana' },
        { freq: 101.1, mode: 'FM', label: 'Emisión FM cercana' },
        { freq: 530, mode: 'AM', label: 'Banda AM baja' },
        { freq: 1610, mode: 'AM', label: 'Banda AM alta' },
    ];

    class EmergencyRadio {
        /**
         * @param {object} opts
         * @param {object} [opts.sdr]     Adaptador SDR {available, tune, onAudio, scan, volume}.
         * @param {function}[opts.onStatus] (status)=>void.
         * @param {function}[opts.onAudio]  (level)=>void  metadatos de audio recibido.
         */
        constructor(opts = {}) {
            this.sdr = opts.sdr || null;
            this.onAudio = opts.onAudio || null;
            this.onStatus = opts.onStatus || null;

            this.state = 'IDLE';        // IDLE | SINTONIZANDO | ESCUCHANDO | ERROR
            this.frequency = null;
            this.mode = null;
            this.error = null;
            this._unsubAudio = null;
            this._playing = false;
        }

        static isSupported(sdr) {
            return !!(sdr || null) && !!((sdr || null).available);
        }

        _status(extra) { if (this.onStatus) this.onStatus({ ...this.status(), ...extra }); }

        status() {
            return {
                supported: !!(this.sdr && this.sdr.available),
                state: this.state,
                frequency: this.frequency,
                mode: this.mode,
                playing: this._playing,
                error: this.error,
            };
        }

        /** Abre/verifica el adaptador SDR. Sin él → SIN_SDR (honesto). */
        open() {
            if (!this.sdr || !this.sdr.available) {
                this.state = 'ERROR';
                this.error = 'SIN_SDR';
                this._status({ error: 'SIN_SDR' });
                return { ok: false, error: 'SIN_SDR', detail: 'No hay receptor AM/FM (SDR) disponible' };
            }
            this._unsubAudio = this.sdr.onAudio && this.sdr.onAudio((level) => {
                if (this.onAudio) this.onAudio(level);
                if (this._playing) this._status({ level });
            });
            this.state = 'IDLE';
            this.error = null;
            this._status();
            return { ok: true };
        }

        /** Sintoniza una frecuencia con modo AM o FM. */
        async tune(freqMhz, mode = 'FM') {
            if (!this.sdr || !this.sdr.available) return { ok: false, error: 'SIN_SDR' };
            this.state = 'SINTONIZANDO';
            this._status();
            const res = await this.sdr.tune(freqMhz, { mode });
            if (!res || res.ok === false) {
                this.state = 'ERROR';
                this.error = (res && res.error) || 'SINTONIA_FALLIDA';
                this._status();
                return { ok: false, error: this.error };
            }
            this.frequency = freqMhz;
            this.mode = mode;
            this.state = 'ESCUCHANDO';
            this._status();
            return { ok: true, frequency: freqMhz, mode };
        }

        /**
         * Escanea los canales de emergencia conocidos; devuelve los que
         * presentan señal (indicación de instrucciones disponibles del
         * rescatista). No inventa señal: depende de la lectura del SDR.
         */
        async scanEmergency(channels) {
            const list = channels || DEFAULT_EMERGENCY;
            if (!this.sdr || !this.sdr.available) return { ok: false, error: 'SIN_SDR' };
            const found = [];
            for (const ch of list) {
                this.state = 'SINTONIZANDO';
                this.frequency = ch.freq; this.mode = ch.mode;
                this._status();
                const r = await this.sdr.tune(ch.freq, { mode: ch.mode });
                const level = r && typeof r.signal === 'number' ? r.signal : 0;
                if (level > 0) found.push({ ...ch, level });
            }
            this.frequency = null; this.mode = null;
            this.state = found.length ? 'ESCUCHANDO' : 'IDLE';
            this._status();
            return { ok: true, found };
        }

        /** Reproduce/pausa el audio sintonizado (el usuario elige escuchar). */
        play(on) {
            if (!this.sdr || !this.sdr.available) return { ok: false, error: 'SIN_SDR' };
            this._playing = !!on;
            if (this.sdr.play) this.sdr.play(on, this.frequency);
            this._status({ playing: this._playing });
            return { ok: true, playing: this._playing };
        }

        close() {
            this._playing = false;
            if (this._unsubAudio) { try { this._unsubAudio(); } catch (e) {} }
            this._unsubAudio = null;
            if (this.sdr && this.sdr.close) this.sdr.close();
            this.state = 'IDLE'; this.frequency = null; this.mode = null;
            this._status();
        }
    }

    const api = { EmergencyRadio, DEFAULT_EMERGENCY };
    if (IS_NODE) module.exports = api;
    else {
        global.EmergencyRadio = EmergencyRadio;
        global.EMERGENCY_CHANNELS = DEFAULT_EMERGENCY;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));