/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — VoiceLink (voz P2P por WebRTC)
 *  Canal de audio en vivo entre dispositivos, sobre Wi-Fi directo
 *  (hotspot/Direct) cuando no hay red celular. Complementa a
 *  WebRtcFieldLink (datos) y a AutoLink (descubrimiento).
 *
 *  PRIVACIDAD (requisito): el micrófono SOLO se activa cuando el
 *  usuario quiere comunicarse (push-to-talk). En modo escucha el mic
 *  está apagado de verdad (tracks detenidos, no solo enmudecidos);
 *  talk(true) adquiere el mic bajo demanda y talk(false) lo libera.
 *
 *  Regla honesta: sin RTCPeerConnection → WEBRTC_NO_DISPONIBLE; sin
 *  permiso de micrófono → MIC_PERMISO_DENEGADO; sin getUserMedia →
 *  SIN_MIC. Cero dependencias; navegador (window.VoiceLink) y Node.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function rtcCtor() {
        if (typeof global.RTCPeerConnection === 'function') return global.RTCPeerConnection;
        if (typeof RTCPeerConnection !== 'undefined') return RTCPeerConnection;
        return null;
    }

    function gUM() {
        if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            return (c) => navigator.mediaDevices.getUserMedia(c);
        }
        return null;
    }

    class VoiceLink {
        /**
         * @param {object} opts
         * @param {function} [opts.rtcCtor]      RTCPeerConnection (inyectable en tests).
         * @param {function} [opts.getUserMedia] getUserMedia (inyectable en tests).
         * @param {object}   [opts.audioEl]      elemento audio remoto (srcObject) para reproducción.
         * @param {function} [opts.onStatus]     (status) => void.
         */
        constructor(opts = {}) {
            this._rtc = opts.rtcCtor || rtcCtor();
            this._gum = opts.getUserMedia || gUM();
            this.audioEl = opts.audioEl || null;
            this.onStatus = opts.onStatus || null;

            this._pc = null;
            this._localStream = null;      // NO vivo salvo durante talk(true)
            this.talking = false;
            this.connected = false;
            this.remoteAudio = false;
            this.error = null;
        }

        static isSupported() { return rtcCtor() != null; }

        _status(extra) { if (this.onStatus) this.onStatus({ ...this.status(), ...extra }); }

        /** Estado honesto actual. */
        status() {
            return {
                supported: this._rtc != null,
                micAvailable: this._gum != null,
                talking: this.talking,
                micOn: !!(this._localStream && this._localStream.getAudioTracks().length),
                connected: this.connected,
                remoteAudio: this.remoteAudio,
                error: this.error,
            };
        }

        /** Crea la conexión P2P de audio y prepara la reproducción remota. */
        start() {
            if (!this._rtc) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            if (this._pc) return { ok: true, already: true };
            const pc = new this._rtc({ iceServers: [] });
            this._pc = pc;
            pc.ontrack = (ev) => {
                if (ev && ev.streams && ev.streams[0]) {
                    if (this.audioEl) this.audioEl.srcObject = ev.streams[0];
                    this.remoteAudio = true;
                    this._status({ remoteAudio: true });
                }
            };
            pc.onconnectionstatechange = () => {
                this.connected = pc.connectionState === 'connected';
                this._status();
            };
            this._status();
            return { ok: true };
        }

        /** Fuerza (temporalmente) a reproducir el audio remoto en el elemento dado. */
        attachAudio(el) {
            this.audioEl = el;
            if (this.remoteAudio && el) el.srcObject = el.srcObject || (this._pc && this._pc._remoteStream);
        }

        /**
         * Push-to-talk: talk(true) ADQUIERE el micrófono bajo demanda;
         * talk(false) lo LIBERA (detiene tracks → mic de verdad apagado).
         */
        async talk(on) {
            if (!this._rtc) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            if (this._pc == null) return { ok: false, error: 'SIN_CANAL_AUDIO' };

            if (on) {
                if (this.talking) return { ok: true, already: true };
                const got = await this._acquireMic();
                if (!got.ok) return got;
                this.talking = true;
                this._status({ talking: true });
                return { ok: true };
            }

            this._releaseMic();
            this.talking = false;
            this._status({ talking: false });
            return { ok: true };
        }

        async _acquireMic() {
            if (!this._gum) return { ok: false, error: 'SIN_MIC' };
            try {
                const stream = await this._gum({ audio: true });
                this._localStream = stream;
                stream.getAudioTracks().forEach((t) => {
                    try { this._pc.addTrack(t, stream); } catch (e) { /* ya añadida */ }
                });
                return { ok: true };
            } catch (e) {
                this.error = 'MIC_PERMISO_DENEGADO';
                return { ok: false, error: this.error };
            }
        }

        _releaseMic() {
            if (!this._localStream) return;
            this._localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
            this._localStream = null; // mic liberado de verdad
        }

        // ── señalización manual (igual filosofía que webrtc_link) ──

        async _waitGathering(desc) {
            return new Promise((resolve) => {
                if (!this._pc || this._pc.iceGatheringState === 'complete') { resolve(desc.sdp); return; }
                const done = () => {
                    this._pc.removeEventListener('icecandidate', done);
                    resolve((this._pc.localDescription || desc).sdp);
                };
                this._pc.addEventListener('icecandidate', (e) => { if (!e || !e.candidate) done(); });
            });
        }

        async createOffer() {
            if (!this._pc) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            try {
                const offer = await this._pc.createOffer();
                await this._pc.setLocalDescription(offer);
                const sdp = await this._waitGathering(offer);
                return { ok: true, sdp };
            } catch (e) { this.error = (e && e.message) || 'OFFER_ERROR'; return { ok: false, error: this.error }; }
        }

        async acceptOffer(offerSdp) {
            if (!this._pc) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            try {
                await this._pc.setRemoteDescription(JSON.parse(offerSdp));
                const answer = await this._pc.createAnswer();
                await this._pc.setLocalDescription(answer);
                const sdp = await this._waitGathering(this._pc);
                return { ok: true, sdp: JSON.stringify({ type: 'answer', sdp }) };
            } catch (e) { this.error = (e && e.message) || 'ANSWER_ERROR'; return { ok: false, error: this.error }; }
        }

        async acceptOfferAnswer(answerJson) {
            if (!this._pc) return { ok: false, error: 'WEBRTC_NO_DISPONIBLE' };
            try { await this._pc.setRemoteDescription(JSON.parse(answerJson)); return { ok: true }; }
            catch (e) { this.error = (e && e.message) || 'CONNECT_ERROR'; return { ok: false, error: this.error }; }
        }

        close() {
            this._releaseMic();
            this.talking = false;
            this.connected = false;
            if (this._pc) { try { this._pc.close(); } catch (e) {} }
            this._pc = null;
            this._status();
        }
    }

    const api = { VoiceLink };
    if (IS_NODE) module.exports = api;
    else global.VoiceLink = VoiceLink;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
