/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — RelayAdapter (cross-device) v2.0
 *  Puente de transporte entre dispositivos. Cero dependencias.
 *
 *  Cada dispositivo corre su PROPIO servidor (server.js). Mientras
 *  está en estado de alerta (VIGILANCE = modo scout/baliza), el
 *  servidor anuncia su URL por UDP broadcast y descubre a los pares
 *  en el mismo estado. El adaptador reporta el estado de alerta al
 *  servidor local (POST /api/state), consulta los pares descubiertos
 *  (GET /api/peers) y reenvía cada trama local por POST /relay/send
 *  a su propio servidor y a cada par (malla completa HTTP).
 *
 *  Solo participan en la malla los dispositivos con estado de alerta
 *  activo; los DORMANT no se anuncian y no se conectan. Los frames
 *  recibidos se inyectan en la malla local (mismo criterio que
 *  radio/udp_bridge.js). Funciona en el navegador
 *  (window.LifelineRelayAdapter) y en Node (module.exports) para test.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    const PROTO_VERSION = 1;
    const DEFAULT_NETWORK = 'LIFELINE-001';
    const PEER_POLL_MS = 2000;

    function isActiveState(state) {
        return !!state && state !== 'DORMANT' && state !== 'ORPHAN';
    }

    /**
     * Interfaz abstracta para módems satelitales (Iridium/Swarm) o TNC HF (Etapa 4).
     * Soporta cola de mensajes, reintentos y compresión para canales lentos.
     */
    class SlowTransportQueue {
        constructor(modem, opts = {}) {
            this.modem = modem; // { send: async (payload) => boolean }
            this.maxRetries = opts.maxRetries || 3;
            this.timeoutMs = opts.timeoutMs || 10000;
            this.queue = [];
            this.isSending = false;
        }

        enqueue(frame) {
            // En la vida real aquí aplicaríamos compresión LZMA/Protobuf.
            // Para el alcance de Etapa 4, enviamos JSON mínimo.
            const payload = JSON.stringify(frame);
            this.queue.push({ payload, retries: 0 });
            this._processQueue();
        }

        async _processQueue() {
            if (this.isSending || this.queue.length === 0) return;
            this.isSending = true;

            const msg = this.queue[0];
            try {
                const success = await this._sendWithTimeout(msg.payload);
                if (success) {
                    this.queue.shift(); // ACK recibido, desencolar
                } else {
                    this._handleFailure(msg);
                }
            } catch (e) {
                this._handleFailure(msg);
            }

            this.isSending = false;
            if (this.queue.length > 0) {
                setTimeout(() => this._processQueue(), 1000); // Backoff simple
            }
        }

        _handleFailure(msg) {
            msg.retries++;
            if (msg.retries >= this.maxRetries) {
                this.queue.shift(); // Descartar tras reintentos agotados
            }
        }

        _sendWithTimeout(payload) {
            return new Promise((resolve) => {
                let done = false;
                const timer = setTimeout(() => {
                    if (!done) { done = true; resolve(false); }
                }, this.timeoutMs);
                
                Promise.resolve(this.modem.send(payload)).then(res => {
                    if (!done) { done = true; clearTimeout(timer); resolve(res); }
                }).catch(() => {
                    if (!done) { done = true; clearTimeout(timer); resolve(false); }
                });
            });
        }
    }

    class RelayAdapter {
        /**
         * @param {object} opts
         * @param {object}  opts.mesh            Malla LoRa local a enlazar.
         * @param {string}  [opts.instanceId]    Id de esta pestaña (auto-eco).
         * @param {string}  [opts.networkId]     Filtro de red (ignora otras).
         * @param {string}  [opts.name]          Nombre visible del dispositivo.
         * @param {string}  [opts.relayUrl]      Base del servidor ('' = misma origen).
         * @param {Function}[opts.onMessage]     (env) => void al recibir.
         * @param {Function}[opts.onPeersChange] (peers) => void al cambiar pares.
         * @param {Function}[opts.onLog]         (channel, msg) => void.
         */
        constructor(opts = {}) {
            this.mesh = opts.mesh || null;
            this.instanceId = opts.instanceId || Math.random().toString(36).slice(2, 12);
            this.networkId = opts.networkId || DEFAULT_NETWORK;
            this.name = opts.name || 'BROWSER';
            this.relayUrl = opts.relayUrl || '';
            this.onMessage = opts.onMessage || null;
            this.onPeersChange = opts.onPeersChange || null;
            this.onLog = opts.onLog || null;
            this.stats = { tx: 0, rx: 0, errors: 0 };
            this.es = null;
            this.connected = false;
            this.error = null;
            this.alertState = 'DORMANT';
            this.peers = new Map(); // url -> { url, label, state, lastSeen }
            this.peerTimer = null;
            this.slowTransport = null;
            this._orig = {};
        }

        /** ¿El navegador dispone de EventSource + fetch para el relay? */
        get available() {
            return typeof EventSource !== 'undefined' && typeof fetch === 'function';
        }

        /**
         * Asigna un módem lento alternativo (satelital/HF).
         */
        setSlowTransport(modem, opts = {}) {
            if (modem) {
                this.slowTransport = new SlowTransportQueue(modem, opts);
            } else {
                this.slowTransport = null;
            }
        }

        /**
         * Conecta al relay y engancha la malla para reenviar tramas locales.
         * @returns {boolean} true si el transporte quedó activo.
         */
        connect() {
            if (!this.available || !this.mesh) {
                this.error = this.mesh ? 'no-browser-api' : 'no-mesh';
                this._log('relay', `Relay no disponible (${this.error})`);
                return false;
            }
            this._hookMesh();
            try {
                this.es = new EventSource(this.relayUrl + '/relay/stream');
            } catch (e) {
                this.error = e.message;
                this._log('relay', 'Error creando EventSource: ' + e.message);
                return false;
            }
            this.es.onopen = () => { this.connected = true; };
            this.es.onmessage = (ev) => { this._onRelayMessage(ev.data); };
            this.es.onerror = () => { this.connected = false; };
            this._log('relay', `Relay conectado (${this.networkId}) — ${this.name}`);
            return true;
        }

        /**
         * Reporta el estado de alerta al servidor local y gestiona la malla
         * de pares. Solo en estado activo (VIGILANCE) el dispositivo se
         * anuncia, descubre pares y reenvía tramas.
         * @param {string} state 'VIGILANCE' | 'DORMANT' | ...
         * @returns {boolean} true si el transporte quedó activo.
         */
        setAlertState(state) {
            this.alertState = state || 'DORMANT';
            if (typeof fetch === 'function') {
                fetch(this.relayUrl + '/api/state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state: this.alertState, label: this.name }),
                }).catch(() => { this.stats.errors++; });
            }
            if (isActiveState(this.alertState)) {
                this._refreshPeers();
                this._startPeerPolling();
            } else {
                this._stopPeerPolling();
                this._clearPeers();
            }
            return true;
        }

        _startPeerPolling() {
            if (this.peerTimer) return;
            this.peerTimer = setInterval(() => this._refreshPeers(), PEER_POLL_MS);
        }

        _stopPeerPolling() {
            if (this.peerTimer) {
                clearInterval(this.peerTimer);
                this.peerTimer = null;
            }
        }

        _clearPeers() {
            this.peers.clear();
            if (this.onPeersChange) {
                try { this.onPeersChange(this.getPeers()); } catch (e) { /* no romper */ }
            }
        }

        /** Consulta los pares descubiertos por el servidor local. */
        async _refreshPeers() {
            if (typeof fetch !== 'function') return;
            try {
                const r = await fetch(this.relayUrl + '/api/peers');
                if (!r.ok) return;
                const j = await r.json();
                const list = (j && j.peers) || [];
                const seen = new Set();
                list.forEach((p) => {
                    if (!p.url) return;
                    seen.add(p.url);
                    const existing = this.peers.get(p.url);
                    if (existing) {
                        existing.label = p.label;
                        existing.state = p.state;
                        existing.lastSeen = p.lastSeen;
                    } else {
                        this.peers.set(p.url, {
                            url: p.url, label: p.label, state: p.state, lastSeen: p.lastSeen,
                        });
                        this._log('relay', `Par descubierto: ${p.label || p.url}`);
                    }
                });
                this.peers.forEach((p, url) => {
                    if (!seen.has(url)) this.peers.delete(url);
                });
            } catch (e) {
                this.stats.errors++;
            }
            if (this.onPeersChange) {
                try { this.onPeersChange(this.getPeers()); } catch (e) { /* no romper */ }
            }
        }

        /**
         * Añade un par manual por URL (fallback cuando el broadcast UDP no
         * alcanza): POST /api/peers y refresca la lista.
         * @param {string} url p. ej. 'http://192.168.0.5:8000'.
         */
        addManualPeer(url) {
            if (typeof fetch !== 'function') return false;
            fetch(this.relayUrl + '/api/peers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ peers: [url] }),
            }).then(() => this._refreshPeers()).catch(() => { this.stats.errors++; });
            return true;
        }

        /** Lista de pares actuales [{url, label, state, lastSeen}]. */
        getPeers() {
            const out = [];
            this.peers.forEach((p) => out.push({ ...p }));
            return out;
        }

        _log(channel, msg) {
            if (this.onLog) {
                try { this.onLog(channel, msg); } catch (e) { /* logger no debe romper */ }
            }
        }

        /** Envuelve la malla para capturar transmisiones locales. */
        _hookMesh() {
            const mesh = this.mesh;
            const self = this;

            this._orig.propagatePacket = mesh.propagatePacket.bind(mesh);
            mesh.propagatePacket = function (senderNode, packet, visited) {
                if (!visited || visited.size === 0) self._sendFrame(packet, 'DATA');
                return self._orig.propagatePacket(senderNode, packet, visited);
            };

            this._orig.processBeacon = mesh.processBeacon.bind(mesh);
            mesh.processBeacon = function (node, beacon) {
                if (beacon && beacon.payload && beacon.payload.sourceId === node.id) {
                    self._sendFrame(beacon, 'BEACON');
                }
                return self._orig.processBeacon(node, beacon);
            };

            this._orig.broadcastNodeJoin = mesh.broadcastNodeJoin.bind(mesh);
            mesh.broadcastNodeJoin = function (node) {
                self._sendFrame({
                    type: 'NODE_JOIN',
                    sourceId: node.id,
                    sourceName: node.name,
                    sourceType: node.type,
                    timestamp: Date.now(),
                }, 'NODE_JOIN');
                return self._orig.broadcastNodeJoin(node);
            };
        }

        /**
         * Serializa y envía un frame hacia el servidor local y todos los
         * pares (malla completa): POST /relay/send a cada destino.
         */
        _sendFrame(frame, kind) {
            if (typeof fetch !== 'function') return;
            const body = JSON.stringify({
                v: PROTO_VERSION,
                instanceId: this.instanceId,
                name: this.name,
                networkId: this.networkId,
                kind,
                frame,
            });
            const targets = [this.relayUrl];
            this.peers.forEach((p) => targets.push(p.url));
            targets.forEach((t) => {
                if (t === null || t === undefined) return;
                this.stats.tx++;
                fetch(String(t).replace(/\/+$/, '') + '/relay/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body,
                }).catch(() => { this.stats.errors++; });
            });

            // Reenvío por satélite / HF (Capa 4) si aplica
            if (this.slowTransport && kind === 'DATA' && frame.payload && frame.payload.type === 'INTERCOM') {
                this.slowTransport.enqueue(frame);
            }
        }

        /** Maneja un mensaje entrante del relay (filtra auto-eco y otras redes). */
        _onRelayMessage(data) {
            let env;
            try {
                env = JSON.parse(data);
            } catch (e) {
                this.stats.errors++;
                return;
            }
            if (!env || env.instanceId === this.instanceId) return; // auto-eco
            if (env.networkId !== this.networkId) return; // otra red en el relay
            this.stats.rx++;
            this._dispatch(env);
        }

        /** Inyecta el frame recibido en la malla local. */
        _dispatch(env) {
            const mesh = this.mesh;
            const kind = env.kind;
            const frame = env.frame;
            if (!mesh || !frame) return;

            switch (kind) {
                case 'BEACON': {
                    mesh.nodes.forEach((node) => {
                        try { mesh.processBeacon(node, frame); } catch (e) { /* nodo aislado */ }
                    });
                    break;
                }
                case 'NODE_JOIN': {
                    mesh.nodes.forEach((node) => {
                        if (node.onNodeJoin) {
                            try { node.onNodeJoin(frame); } catch (e) { /* sin manejador */ }
                        }
                    });
                    break;
                }
                case 'DATA':
                default: {
                    frame._relayName = env.name || frame.sourceName || null;
                    if (frame.payload && typeof frame.payload === 'object') {
                        frame.payload._relayName = frame._relayName;
                    }
                    mesh.nodes.forEach((node) => {
                        try { node.processPacket(frame); } catch (e) { /* nodo aislado */ }
                    });
                    break;
                }
            }

            if (this.onMessage) {
                try { this.onMessage(env); } catch (e) { /* callback no debe romper */ }
            }
        }

        /** Restaura la malla y cierra conexiones y polling de pares. */
        close() {
            this._stopPeerPolling();
            this._clearPeers();
            if (this.es) {
                try { this.es.close(); } catch (e) { /* ya cerrado */ }
                this.es = null;
            }
            this.connected = false;
            if (this._orig.propagatePacket) this.mesh.propagatePacket = this._orig.propagatePacket;
            if (this._orig.processBeacon) this.mesh.processBeacon = this._orig.processBeacon;
            if (this._orig.broadcastNodeJoin) this.mesh.broadcastNodeJoin = this._orig.broadcastNodeJoin;
            return this;
        }

        getStats() {
            return {
                ...this.stats,
                connected: this.connected,
                error: this.error,
                available: this.available,
                alertState: this.alertState,
                peers: this.peers.size,
            };
        }
    }

    const api = { RelayAdapter, PROTO_VERSION, DEFAULT_NETWORK, SlowTransportQueue };
    if (IS_NODE) {
        module.exports = api;
    } else if (typeof global.window !== 'undefined') {
        global.window.LifelineRelayAdapter = api;
    } else {
        global.LifelineRelayAdapter = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
