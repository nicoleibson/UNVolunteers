/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Device Links (enlaces por dispositivo)
 *  Gestor de enlace que DESACOPLA cada sensor/dispositivo físico
 *  (radio LoRa, wearable BLE, módulo de gases, unidad de campo
 *  UWB/IMU/IR, cámara térmica, enlace de campo WebRTC) para que cada
 *  uno conecte, desconecte y notifique su propio estado y sus propios
 *  datos de forma INDEPENDIENTE.
 *
 *  Regla de producción: ningún enlace inventa lecturas. Cada dispositivo
 *  solo emite lo que su transporte físico real entrega; sin transporte
 *  el estado es honesto (`SIN_…` / `NO_MODULO`).
 *
 *  Cero dependencias; navegador (window.DeviceLinkManager) y Node
 *  (module.exports) para test. No conoce la GUI: los consumidores se
 *  suscriben por dispositivo (`on(id,'data'|'status', cb)`).
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    // Acceso a los drivers de cada dispositivo (inyectados por el host o
    // leídos de window). Cada fabricante declara de qué driver depende.
    const BLANK = {};

    /** Capitaliza un id para etiquetas de log. */
    function title(id) { return String(id || '').toUpperCase(); }

    /**
     * Dispositivo individual (un enlace). Mantiene SU PROPIO estado y sus
     * propios callbacks; no comparte nada con otros dispositivos.
     */
    class DeviceLink {
        constructor(manager, brand, api) {
            this.manager = manager;
            this.brand = brand;
            this._api = api;                  // { data, status } emisiones al gestor
            this._presenter = null;           // objeto conectable devuelto por la factory
            this.bridge = null;               // driver real (si la factory lo expone)
            this.state = 'down';              // down | connecting | up | error
            this.error = null;
            this.last = null;                 // última lectura real (para UI honesto)
            this.connectedAt = null;
        }

        get id() { return this.brand.id; }
        get name() { return this.brand.name; }
        get kind() { return this.brand.kind; }

        isSupported() {
            if (this.brand.isSupported) return !!this.brand.isSupported();
            return this.bridge != null;
        }

        /** Inyecta estado interno y lo emite a los suscriptores. */
        _emit(over) {
            if (over.state != null) this.state = over.state;
            if (over.error != null) this.error = over.error;
            if (this.state === 'up') this.connectedAt = Date.now();
            this._api.status({ state: this.state, error: this.error, last: this.last, name: this.name });
        }
        _emitData(payload) { this.last = payload; this._api.data(payload); }

        /** Emisores que el adaptador usa para notificar datos/estado. */
        _harness() {
            return {
                data: (p) => this._emitData(p),
                status: (s) => this._emit(s),
            };
        }

        connect(opts) {
            const brand = this.brand;
            if (!brand.factory) {
                this._emit({ state: 'error', error: 'SIN_FACTORY' });
                return Promise.resolve({ ok: false, connected: false, error: 'SIN_FACTORY' });
            }
            // Idempotente: ya arriba no reabre para no duplicar transceivers/puertos.
            if (this.state === 'up') {
                return Promise.resolve({ ok: true, connected: true, already: true });
            }
            this._emit({ state: 'connecting', error: null });
            let res;
            try {
                const harness = this._harness();
                const built = brand.factory({ device: this, harness, opts });
                if (built && built.bridge) this.bridge = built.bridge;
                this._presenter = built || { connect: async () => ({ ok: true, connected: true }) };
                res = Promise.resolve(this._presenter.connect(built.opts || opts));
            } catch (e) {
                this._emit({ state: 'error', error: (e && e.message) || 'FAULT' });
                return Promise.resolve({ ok: false, connected: false, error: (e && e.message) || 'FAULT' });
            }
            res.then((r) => {
                if (!r || r.ok === false) {
                    this._emit({ state: 'error', error: r ? r.error : 'SIN_RESPUESTA' });
                } else {
                    this._emit({ state: 'up', error: null });
                }
            }).catch((e) => {
                this._emit({ state: 'error', error: (e && e.message) || 'ERROR' });
            });
            return res;
        }

        disconnect() {
            this._emit({ state: 'down', error: null });
            const p = this._presenter;
            if (p && typeof p.disconnect === 'function') {
                try {
                    const r = p.disconnect();
                    return r && typeof r.then === 'function' ? r : Promise.resolve(r);
                } catch (e) { /* cerrado */ }
            }
            return Promise.resolve();
        }
    }

    /**
     * Gestor de dispositivos: registra marcas (un adaptador por sensor),
     * mantiene UN DeviceLink por id y reenvía a los suscriptores los eventos
     * `data` y `status` de cada uno de forma independiente.
     */
    class DeviceLinkManager {
        constructor(brands = []) {
            this._brands = new Map();
            this._links = new Map();
            this._subscriptions = { data: new Map(), status: new Map() };
            brands.forEach((b) => this.register(b));
        }

        register(brand) {
            if (!brand || !brand.id) return this;
            this._brands.set(brand.id, brand);
            return this;
        }

        list() {
            return Array.from(this._brands.values()).map((b) => ({
                id: b.id,
                name: b.name,
                kind: b.kind,
                supported: this.isSupported(b.id),
            }));
        }

        has(id) { return this._brands.has(id); }

        isSupported(id) {
            const b = this._brands.get(id);
            if (!b) return false;
            const link = this._links.get(id);
            if (b.isSupported) return !!b.isSupported();
            return link ? link.isSupported() : false;
        }

        sub(id, type, cb) {
            if (!cb) return () => {};
            const s = this._subscriptions[type] || this._subscriptions;
            if (!this._subscriptions[type]) this._subscriptions[type] = new Map();
            const m = this._subscriptions[type];
            if (!m.has(id)) m.set(id, new Set());
            m.get(id).add(cb);
            return () => this.unsub(id, type, cb);
        }
        unsub(id, type, cb) {
            const m = this._subscriptions[type];
            if (m && m.has(id)) m.get(id).delete(cb);
        }

        _emit(type, id, payload) {
            const m = this._subscriptions[type];
            if (m && m.has(id)) m.get(id).forEach((cb) => { try { cb(payload); } catch (e) { /* aislado */ } });
        }

        status(id) {
            const link = this._links.get(id);
            if (!link) return { id, state: 'down', name: (this._brands.get(id) || {}).name || id, supported: this.isSupported(id) };
            return { id, name: link.name, state: link.state, error: link.error, last: link.last, supported: link.isSupported() };
        }

        /** Conecta SOLO el dispositivo indicado. Devuelve su resultado. */
        connect(id, opts = {}) {
            const brand = this._brands.get(id);
            if (!brand) return Promise.resolve({ ok: false, connected: false, error: 'NO_DEVICE' });
            let link = this._links.get(id);
            if (!link) {
                const api = {
                    data: (p) => this._emit('data', id, p),
                    status: (s) => this._emit('status', id, s),
                };
                link = new DeviceLink(this, brand, api);
                this._links.set(id, link);
            }
            return link.connect(opts);
        }

        /** Desconecta SOLO el dispositivo indicado. */
        disconnect(id) {
            const link = this._links.get(id);
            if (!link) return Promise.resolve(false);
            return link.disconnect();
        }

        disconnectAll() {
            const ids = Array.from(this._links.keys());
            return Promise.all(ids.map((id) => this.disconnect(id)));
        }
    }

    const api = { DeviceLinkManager, DeviceLink };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.DeviceLinkManager = DeviceLinkManager;
        global.DeviceLink = DeviceLink;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));