/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — AutoLink (entrelazado automático híbrido)
 *  Emparejado autónomo entre dispositivos en estado de EMERGENCIA
 *  (alerta sísmica / modo emergencia), sin intervención humana.
 *
 *  ARQUITECTURA (según decisión de diseño):
 *   - LoRa  : descubrimiento (baliza/scan) + datos de bajo ancho de
 *             banda (vitales, GPS, UWB, alarmas). Largo alcance.
 *   - BLE   : datos densos de corto alcance (imagen térmica).
 *
 *  CICLO DE VIDA DE UNA HOJA (esclavo):
 *     EMERGENCIA ─▶ BALIZA ─(oye ACK)─▶ EMPAREJANDO ─(CONFIRM)─▶ ACTIVO
 *        │            ▲                    │                          │
 *        │   (pérdida de enlace)           └──────────(DATA)──────────┘
 *        └── SENT:  │              coordinator puede mandar SLEEP ◀───┘
 *                   └── SLEEP (batería: deja de emitir baliza)
 *  Al PERDER la conexión (sin ACK/DATA en ackTimeout) la hoja vuelve a
 *  modo BALIZA para ser re-pareada. Exactamente el ciclo requerido.
 *
 *  POLÍTICA DE BATERÍA: al confirmar un enlace, el coordinador apaga las
 *  hojas REDUNDANTES (las que no forman parte de la cadena esencial) con
 *  un SLEEP; una hoja dormida deja de emitir baliza. Con WAKE se reactiva.
 *
 *  Cero dependencias; navegador (window.AutoLinkManager) y Node
 *  (module.exports). Los transportes son adaptadores inyectables
 *  (honesto: sin transporte real no hay señales, no se inventa nada).
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    // Protocolo de líneas (ASCII, igual filosofía que el driver de radio).
    const T = {
        BALIZA: 'AUTOLINK|BALIZA|',
        ACK: 'AUTOLINK|ACK|',
        CONFIRM: 'AUTOLINK|CONFIRM|',
        SLEEP: 'AUTOLINK|SLEEP|',
        WAKE: 'AUTOLINK|WAKE|',
        DATA: 'AUTOLINK|DATA|',
    };

    /** Hoja: BALIZA → EMPAREJANDO → ACTIVO / SLEEP */
    const OWN = { IDLE: 'IDLE', BALIZA: 'BALIZA', EMPAREJANDO: 'EMPAREJANDO', ACTIVO: 'ACTIVO', SLEEP: 'SLEEP' };
    /** Coordinador: estado por nodo remoto */
    const REMOTE = { ESCUCHANDO: 'ESCUCHANDO', PARED: 'PARED', ACTIVO: 'ACTIVO', REDUNDANTE: 'REDUNDANTE', PERDIDO: 'PERDIDO' };

    function defaultScheduler() {
        return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: clearTimeout };
    }

    class AutoLinkManager {
        /**
         * @param {object} opts
         * @param {string} opts.ownId        Identificador de este dispositivo (p.ej. 'NODE-A').
         * @param {object} [opts.lora]       Transporte LoRa: { available:boolean, send(line):void, onReceive(cb):fn }.
         * @param {object} [opts.ble]        Transporte BLE denso: igual interfaz; opcional.
         * @param {number} [opts.beaconInterval=2000] ms entre balizas de una hoja.
         * @param {number} [opts.ackTimeout=5000]     ms sin confirmación/ACK/DATA antes de revertir a BALIZA.
         * @param {object} [opts.scheduler]  {setTimeout,clearTimeout} para pruebas deterministas.
         * @param {function} [opts.onLink]   (nodeId, state) => void  cambios de enlace.
         * @param {function} [opts.onData]   (nodeId, payload) => void datos recibidos.
         * @param {function} [opts.onStatus] (status) => void        cambios de estado global.
         */
        constructor(opts = {}) {
            this.ownId = opts.ownId || 'NODE-?';
            this.lora = opts.lora || { available: false, send: () => {}, onReceive: () => {} };
            this.ble = opts.ble || null;
            this.beaconInterval = opts.beaconInterval || 2000;
            this.ackTimeout = opts.ackTimeout || 5000;
            this.sched = opts.scheduler || defaultScheduler();

            this.onLink = opts.onLink || null;
            this.onData = opts.onData || null;
            this.onStatus = opts.onStatus || null;

            this.mode = 'IDLE';           // IDLE | EMERGENCIA
            this.role = null;             // 'coordinator' | 'leaf'
            this.own = { state: OWN.IDLE, token: null, lastSeen: 0 };
            this.links = new Map();       // coord: nodeId -> {state,token,lastSeen,caps}
            this._essential = new Set();  // coord: ids de la cadena esencial (no se apagan)
            this._tokenCounter = 0;

            this._timers = [];
            this._unsubs = [];

            // Suscripción a los transportes (ambos canales entregan al mismo handler).
            this._unsubs.push(this.lora.onReceive((frame) => this.handleIncoming('lora', frame)));
            if (this.ble) this._unsubs.push(this.ble.onReceive((frame) => this.handleIncoming('ble', frame)));
        }

        _emitStatus() {
            if (this.onStatus) this.onStatus(this.status());
        }

        _setOwn(state, token) {
            this.own.state = state;
            if (token !== undefined) this.own.token = token;
            this.own.lastSeen = this._now();
        }

        _now() { return Date.now(); }

        _schedule(fn, ms) {
            const id = this.sched.setTimeout(() => {
                const i = this._timers.indexOf(id);
                if (i >= 0) this._timers.splice(i, 1);
                fn();
            }, ms);
            this._timers.push(id);
            return id;
        }

        _clearAllTimers() {
            this._timers.forEach((id) => this.sched.clearTimeout(id));
            this._timers = [];
        }

        _broadcast(msg) {
            if (this.lora && this.lora.available) this.lora.send(msg);
        }

        /** Datos densos: BLE si está conectado; si no, LoRa (honesto). */
        _sendData(from, payload) {
            const line = T.DATA + from + '|' + payload;
            if (this.ble && this.ble.available) {
                this.ble.send(line);
            } else {
                this._broadcast(line);
            }
        }

        _token() { return (this.ownId + ':' + (++this._tokenCounter)); }

        // ────────────────────────── API pública ──────────────────────────

        /** Entra en estado de emergencia. role: 'coordinator' | 'leaf'. */
        enterEmergency(role) {
            if (this.mode === 'EMERGENCIA') { this.role = role; return; }
            this.mode = 'EMERGENCIA';
            this.role = role;
            this._clearAllTimers();
            this.links.clear();
            if (role === 'leaf') {
                this._setOwn(OWN.BALIZA, this._token());
                this._schedule(() => this._beaconLoop(), 0);
            } else {
                this._setOwn(OWN.IDLE, null);
            }
            this._emitStatus();
        }

        /** Sale del estado de emergencia: apaga loops y devuelve todo a IDLE. */
        exitEmergency() {
            this.mode = 'IDLE';
            this.role = null;
            this._clearAllTimers();
            this._setOwn(OWN.IDLE, null);
            this.links.clear();
            this._emitStatus();
        }

        /**
         * Coordinador: declara cuáles hojas son la cadena esencial.
         * El resto se apagan (SLEEP) para ahorrar batería.
         */
        setEssential(nodeIds) {
            if (this.role !== 'coordinator') return;
            this._essential = new Set(nodeIds || []);
            this.applyPowerPolicy();
        }

        /** Coordinador: apaga hojas redundantes y despierta las esenciales. */
        applyPowerPolicy() {
            if (this.role !== 'coordinator') return;
            for (const [id, link] of this.links) {
                if (!this._essential.has(id) && (link.state === REMOTE.ACTIVO || link.state === REMOTE.PARED)) {
                    this._broadcast(T.SLEEP + this.ownId + '|' + id);
                    link.state = REMOTE.REDUNDANTE;
                    if (this.onLink) this.onLink(id, link.state);
                } else if (this._essential.has(id) && link.state === REMOTE.REDUNDANTE) {
                    this._broadcast(T.WAKE + this.ownId + '|' + id);
                    link.state = REMOTE.PARED;
                    if (this.onLink) this.onLink(id, link.state);
                }
            }
            this._emitStatus();
        }

        /** Estado legible de un enlace (coord) o del propio dispositivo (leaf). */
        status() {
            const out = { mode: this.mode, role: this.role };
            if (this.role === 'leaf') {
                out.own = { state: this.own.state };
            } else if (this.role === 'coordinator') {
                out.links = {};
                for (const [id, l] of this.links) out.links[id] = { state: l.state, caps: l.caps };
            }
            return out;
        }

        /** Limpia timers y suscripciones. */
        dispose() {
            this._clearAllTimers();
            this._unsubs.forEach((u) => { if (u) u(); });
            this._unsubs = [];
        }

        // ────────────────────────── loop de baliza (hoja) ──────────────────────────

        _beaconLoop() {
            if (this.mode !== 'EMERGENCIA' || this.role !== 'leaf') return;
            // Solo emite baliza si no está dormida ni ya activa transmitiendo.
            if (this.own.state === OWN.BALIZA || this.own.state === OWN.EMPAREJANDO) {
                this._broadcast(T.BALIZA + this.ownId + '|' + (this.own.caps || ''));
            }
            // Tras una baliza, programa la comprobación de pérdida de enlace.
            this._schedule(() => this._expireIfLost(), this.ackTimeout);
            // Sigue balizando mientras no esté ACTIVO/SLEEP.
            if (this.own.state === OWN.BALIZA || this.own.state === OWN.EMPAREJANDO) {
                this._schedule(() => this._beaconLoop(), this.beaconInterval);
            }
        }

        /** Al perder la conexión (sin ACK/DATA en ackTimeout) la hoja vuelve a BALIZA. */
        _expireIfLost() {
            if (this.mode !== 'EMERGENCIA' || this.role !== 'leaf') return;
            if (this.own.state !== OWN.ACTIVO) return;
            if (this._now() - this.own.lastSeen > this.ackTimeout) {
                this._setOwn(OWN.BALIZA, this._token());
                if (this.onLink) this.onLink('self', OWN.BALIZA);
                this._schedule(() => this._beaconLoop(), 0);
            }
        }

        // ────────────────────────── entrada de líneas ──────────────────────────

        /** Recibe una línea desde un transporte (lora|ble). */
        handleIncoming(channel, frame) {
            if (!frame || typeof frame !== 'string') return;
            if (!frame.startsWith('AUTOLINK|')) return;
            const parts = frame.split('|');
            const type = parts[1];
            if (this.role === 'leaf') this._handleLeaf(channel, parts, type);
            else this._handleCoordinator(channel, parts, type);
        }

        // ---------- hoja ----------
        _handleLeaf(channel, parts, type) {
            const from = parts[2];
            if (type === 'ACK') {
                const token = parts[3];
if (this.own.state === OWN.BALIZA || this.own.state === OWN.EMPAREJANDO) {
                // El token del ACK identifica este emparejado del coordinador; la hoja
                // lo adopta y lo devuelve en su CONFIRM para cerrar el enlace.
                this._setOwn(OWN.EMPAREJANDO, token);
                this._broadcast(T.CONFIRM + this.ownId + '|' + token);
                // Tras confirmar el enlace, la hoja empieza a transmitir.
                this._setOwn(OWN.ACTIVO, token);
                if (this.onLink) this.onLink('self', OWN.ACTIVO);
            }
            } else if (type === 'CONFIRM') {
                // Confirmación final del coordinador → ACTIVO (empieza a transmitir).
                if (this.own.state === OWN.EMPAREJANDO) {
                    this._setOwn(OWN.ACTIVO, this.own.token);
                    if (this.onLink) this.onLink('self', OWN.ACTIVO);
                }
            } else if (type === 'SLEEP') {
                // Coordinador pide apagar esta hoja (ahorrar batería).
                this._setOwn(OWN.SLEEP, null);
                if (this.onLink) this.onLink('self', OWN.SLEEP);
            } else if (type === 'WAKE') {
                // Reactivación: vuelve a modo baliza.
                if (this.own.state === OWN.SLEEP) {
                    this._setOwn(OWN.BALIZA, this._token());
                    this._schedule(() => this._beaconLoop(), 0);
                    if (this.onLink) this.onLink('self', OWN.BALIZA);
                }
            } else if (type === 'DATA') {
                this.own.lastSeen = this._now();
                if (this.onData) this.onData(from, parts.slice(3).join('|'));
            }
            this._emitStatus();
        }

        // ---------- coordinador ----------
        _handleCoordinator(channel, parts, type) {
            const from = parts[2];
            if (type === 'BALIZA') {
                const caps = parts[3] || '';
                let link = this.links.get(from);
                const now = this._now();
                if (!link) {
                    link = { state: REMOTE.PARED, token: this._token(), lastSeen: now, caps };
                    this.links.set(from, link);
                    this._broadcast(T.ACK + this.ownId + '|' + link.token);
                    if (this.onLink) this.onLink(from, REMOTE.PARED);
                    // Según la política de batería, la hoja redundante se apaga ya.
                    if (!this._essential.has(from)) {
                        this._broadcast(T.SLEEP + this.ownId + '|' + from);
                        link.state = REMOTE.REDUNDANTE;
                        if (this.onLink) this.onLink(from, REMOTE.REDUNDANTE);
                    }
                } else {
                    link.lastSeen = now;
                    if (link.state === REMOTE.REDUNDANTE) {
                        // Re-baliza de una hoja que dormimos → seguir dormida (re-SLEEP).
                        this._broadcast(T.SLEEP + this.ownId + '|' + from);
                    } else if (link.state === REMOTE.PERDIDO) {
                        link.state = REMOTE.PARED;
                        if (this.onLink) this.onLink(from, REMOTE.PARED);
                    }
                }
            } else if (type === 'CONFIRM') {
                const link = this.links.get(from);
                if (link && link.state !== REMOTE.ACTIVO) {
                    link.state = REMOTE.ACTIVO;
                    link.lastSeen = this._now();
                    if (this.onLink) this.onLink(from, REMOTE.ACTIVO);
                }
            } else if (type === 'DATA') {
                const link = this.links.get(from);
                if (link) link.lastSeen = this._now();
                if (this.onData) this.onData(from, parts.slice(3).join('|'));
            }
            this._emitStatus();
        }

        /** Coordinador: marca enlaces sin novedad como PERDIDOS. Llamar periódicamente. */
        sweep() {
            if (this.mode !== 'EMERGENCIA' || this.role !== 'coordinator') return;
            const now = this._now();
            for (const [id, link] of this.links) {
                if ((link.state === REMOTE.PARED || link.state === REMOTE.ACTIVO) &&
                    now - link.lastSeen > this.ackTimeout) {
                    link.state = REMOTE.PERDIDO;
                    if (this.onLink) this.onLink(id, REMOTE.PERDIDO);
                }
            }
            this._emitStatus();
        }
    }

    const api = { AutoLinkManager, OWN, REMOTE, T };
    if (IS_NODE) { module.exports = api; }
    else {
        global.AutoLinkManager = AutoLinkManager;
        global.AUTOLINK_STATES = { OWN, REMOTE };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
