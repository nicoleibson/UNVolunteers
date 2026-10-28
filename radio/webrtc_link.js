/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — WebRTC Field Link (modo esclavo temporal)
 *  Enlace P2P directo (WebRTC DataChannel) entre dos dispositivos para
 *  las pruebas de campo: el dispositivo ESCLAVO emite el protocolo de
 *  líneas reales (UWB/ORI/THERMAL) y el MAESTRO lo recibe y lo inyecta
 *  en el puente de campo (field_bridge). Cero dependencias; Node
 *  (module.exports) y navegador (window.WebRtcFieldLink).
 *
 *  Señalización MANUAL sin infraestructura: se copia el OFERTA de un
 *  lado y se pega en el otro (no hace falta servidor de paso).
 *  Regla honesta: sin peer conectado no hay línea; nada se inventa.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function rtpcctor() {
        if (typeof global.RTCPeerConnection === 'function') return global.RTCPeerConnection;
        if (typeof RTCPeerConnection !== 'undefined') return RTCPeerConnection;
        return null;
    }

    function isSupported() { return rtpcctor() != null; }

    /** Codifica una rejilla térmica (Float32Array °C) a hex int16 LE (32×24). */
    function thermalToHex(frame, opts = {}) {
        if (!frame || !frame.temps) return null;
        const w = frame.width || opts.width || 32;
        const h = frame.height || opts.height || 24;
        let out = '';
        for (let i = 0; i < w * h; i++) {
            let v = frame.temps[i] != null ? frame.temps[i] : 0;
            v = Math.max(-32768, Math.min(32767, Math.round(v) & 0xFFFF));
            out += (v & 0xFF).toString(16).padStart(2, '0') + ((v >> 8) & 0xFF).toString(16).padStart(2, '0');
        }
        return out;
    }

    class WebRtcFieldLink {
        /** @param {{dataChannelRole:'offerer'|'receiver', onLine?:fn, onStatus?:fn}} opts */
        constructor(opts = {}) {
            this.onLine = opts.onLine || null;
            this.onStatus = opts.onStatus || null;
            this.role = opts.role || 'offerer';
            this._pc = null;
            this._dc = null;
            this._queue = [];
            this.connected = false;
            this.error = null;
        }

        static isSupported() { return isSupported(); }

        _wire(pc, isOfferer) {
            this._pc = pc;
            pc.onicecandidate = () => { /* recogido por _waitGathering */ };
            if (!isOfferer) {
                pc.ondatachannel = (ev) => this._bindData(ev.channel);
            }
        }

        _bindData(dc) {
            this._dc = dc;
            dc.onopen = () => {
                this.connected = true;
                this._flush();
                if (this.onStatus) this.onStatus({ connected: true });
            };
            dc.onmessage = (ev) => {
                const line = ev && ev.data != null ? String(ev.data) : null;
                if (line && this.onLine) this.onLine(line);
            };
        }

        // Espera a que termine la recogida de candidatos y devuelve { sdp }.
        _waitGathering(desc) {
            return new Promise((resolve) => {
                if (!this._pc || this._pc.iceGatheringState === 'complete') {
                    resolve({ sdp: desc && desc.sdp });
                    return;
                }
                const done = () => {
                    this._pc.removeEventListener('icecandidate', done);
                    resolve({ sdp: (this._pc.localDescription || desc).sdp });
                };
                this._pc.addEventListener('icecandidate', (e) => { if (!e || !e.candidate) done(); });
            });
        }

        /** Lado emisor (oferta): crea el canal si no es receptor y devuelve el oferta. */
        async createOffer() {
            const Ctor = rtpcctor();
            if (!Ctor) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            try {
                const pc = new Ctor({ iceServers: [] });
                this._wire(pc, true);
                const dc = pc.createDataChannel('lifeline', {});
                this._bindData(dc);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                const { sdp } = await this._waitGathering(offer);
                this.status('OFRENTA_LISTA');
                return { ok: true, sdp };
            } catch (e) {
                this.error = (e && e.message) || 'WEBRTC_OFFER_ERROR';
                return { ok: false, error: this.error };
            }
        }

        /** Lado receptor: acepta la oferta del emisor y devuelve la respuesta. */
        async acceptOffer(offerSdp) {
            const Ctor = rtpcctor();
            if (!Ctor) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            try {
                const pc = new Ctor({ iceServers: [] });
                this._wire(pc, false);
                await pc.setRemoteDescription(JSON.parse(offerSdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                const { sdp } = await this._waitGathering(pc);
                this.error = null;
                return { ok: true, sdp: JSON.stringify({ type: 'answer', sdp }) };
            } catch (e) {
                this.error = (e && e.message) || 'WEBRTC_ANSWER_ERROR';
                return { ok: false, error: this.error };
            }
        }

        /** Lado emisor: aplica la respuesta del receptor y completa la conexión. */
        async acceptOfferAnswer(answerJson) {
            if (!this._pc) return { ok: false, error: 'WEBRTC_SIN_OFERTA' };
            try {
                await this._pc.setRemoteDescription(JSON.parse(answerJson));
                return { ok: true };
            } catch (e) {
                this.error = (e && e.message) || 'WEBRTC_CONNECT_ERROR';
                return { ok: false, error: this.error };
            }
        }

        /** Envía una línea por el canal de datos (cola hasta abrir). */
        send(line) {
            if (this._dc && this._dc.readyState === 'open') {
                this._dc.send(String(line));
                return true;
            }
            if (this._dc && this._dc.readyState === 'connecting') {
                this._queue.push(String(line));
                return true;
            }
            return false;
        }

        _flush() {
            if (!this._dc || this._dc.readyState !== 'open') return;
            this._queue.forEach((l) => this._dc.send(l));
            this._queue = [];
        }

        status(type) {
            if (this.onStatus) this.onStatus({ type });
        }

        close() {
            this.connected = false;
            if (this._dc) { try { this._dc.close(); } catch (e) {} }
            if (this._pc) { try { this._pc.close(); } catch (e) {} }
            this._pc = null; this._dc = null;
        }
    }

    const api = { WebRtcFieldLink, thermalToHex, isSupported };
    if (IS_NODE) { module.exports = api; }
    else {
        global.WebRtcFieldLink = WebRtcFieldLink;
        global.thermalToHex = thermalToHex;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));