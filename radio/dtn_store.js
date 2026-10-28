/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — DTN Data Mule Store v1.0
 *  Almacén local de balizas de víctimas (Store-and-Forward) para las
 *  "mulas de datos" (Data Mules). Cifrado en reposo con AES-128-CTR +
 *  MIC (AES-CMAC); encolado pendiente (outbox) para sincronización
 *  silenciosa y automática entre Scouts y hacia el Gateway.
 *  Cero dependencias. Navegador (window.DtnStore) y Node.
 *
 *  Regla de producción: SOLO almacena balizas que realmente llegaron
 *  (nunca inventa). Sin vía de salida las balizas quedan en pending()
 *  hasta que un cruce con otro dispositivo las sincronice.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function loadAES() {
        if (IS_NODE) return require('./aes128.js');
        return global.AES128 || null;
    }

    const KEY_NS = 'lifeline:dtn:v1';
    const NONCE_LEN = 8;
    const MIC_LEN = 4;

    function toKeyBytes(keyHex) {
        const clean = String(keyHex).replace(/[^0-9A-Fa-f]/g, '');
        if (clean.length !== 32) {
            throw new Error('DTN: clave AES-128 debe tener 32 hex');
        }
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return out;
    }

    function randomNonce() {
        const n = new Uint8Array(NONCE_LEN);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(n);
        } else {
            for (let i = 0; i < NONCE_LEN; i++) n[i] = (Math.random() * 256) | 0;
        }
        return n;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function hexToBytes(hex) {
        const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return out;
    }

    function random(seed) {
        // PRNG mínimo determinista (tests): mulberry32 → nonce de 8 bytes.
        let s = seed >>> 0;
        return function () {
            const n = new Uint8Array(8);
            for (let i = 0; i < 8; i++) {
                s |= 0; s = (s + 0x6D2B79F5) | 0;
                let t = Math.imul(s ^ (s >>> 15), 1 | s);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                n[i] = ((t ^ (t >>> 14)) >>> 0) & 0xFF;
            }
            return n;
        };
    }

    /**
     * Almacén DTN de balizas.
     * @param {{key?:string, io?:object, seed?:number, nonceFn?:Function}} [opts]
     *  - key: clave AES-128 (32 hex) para cifrar en reposo.
     *  - io: {get(key):string|null, set(key,val):void, remove(key):void}
     *    (por defecto memoria; para localStorage pasar wrappers).
     *  - seed: semilla del PRNG de nonce (tests deterministas).
     */
    class DtnStore {
        constructor(opts = {}) {
            this.key = opts.key ? toKeyBytes(opts.key) : null;
            this.io = opts.io || this._memoryIO();
            this._seq = 0;
            this._rng = opts.nonceFn || (opts.seed != null ? random(opts.seed) : randomNonce);
            this.store = {};      // nodeId → {nodeId, timestamp, data, synced}
            this._load();
        }

        _memoryIO() {
            const mem = new Map();
            return {
                get: (k) => (mem.has(k) ? mem.get(k) : null),
                set: (k, v) => { mem.set(k, v); },
                remove: (k) => { mem.delete(k); },
            };
        }

        _load() {
            const blob = this.io.get ? this.io.get(KEY_NS) : null;
            if (!blob) return;
            const plain = this._decrypt(blob);
            if (!plain) return;
            try {
                const arr = JSON.parse(plain);
                this.store = {};
                for (const rec of arr) {
                    if (rec && rec.nodeId) this.store[rec.nodeId] = { ...rec, synced: !!rec.synced };
                }
            } catch (e) { this.store = {}; }
        }

        _persist() {
            if (!this.io || !this.io.set) return;
            const arr = Object.keys(this.store).map((k) => this.store[k]);
            const plain = JSON.stringify(arr);
            this.io.set(KEY_NS, this._encrypt(plain));
        }

        _encrypt(plain) {
            const aes = loadAES();
            const data = new TextEncoder().encode(plain);
            if (!this.key || !aes) return bytesToHex(data); // sin clave: ofuscación basura (testeo)
            const nonce = this._rng();
            const nonceArr = nonce instanceof Uint8Array ? nonce : Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]);
            const init = new Uint8Array(16);
            init.set(nonceArr.slice(0, 8), 0);
            init.set(init.slice(0, 8).map((b, i) => b ^ 0x22), 8); // contador 2º bloque
            const ct = aes.aes128Ctr(this.key, init, data);
            const mic = aes.aesCmac(this.key, new Uint8Array([...nonceArr, ...ct]));
            return bytesToHex(nonceArr) + bytesToHex(ct) + bytesToHex(mic.slice(0, MIC_LEN));
        }

        _decrypt(hex) {
            const aes = loadAES();
            const bytes = hexToBytes(hex);
            if (!this.key || !aes) {
                try { return new TextDecoder().decode(bytes); } catch (e) { return null; }
            }
            if (bytes.length < NONCE_LEN + MIC_LEN) return null;
            const nonce = bytes.slice(0, NONCE_LEN);
            const ct = bytes.slice(NONCE_LEN, bytes.length - MIC_LEN);
            const micRecv = bytes.slice(bytes.length - MIC_LEN);
            const micCalc = aes.aesCmac(this.key, new Uint8Array([...nonce, ...ct]));
            for (let i = 0; i < MIC_LEN; i++) {
                if (micRecv[i] !== micCalc[i]) return null; // integridad fallida
            }
            const init = new Uint8Array(16);
            init.set(nonce, 0);
            init.set(init.slice(0, 8).map((b) => b ^ 0x22), 8);
            const plain = aes.aes128Ctr(this.key, init, new Uint8Array(ct));
            return new TextDecoder().decode(new Uint8Array(plain));
        }

        /**
         * Acumula una baliza de víctima. Dedup por nodeId (conserva la de
         * timestamp más reciente; si es nueva/actualizada queda pendiente).
         * @param {{nodeId:string, timestamp?:number, data?:object, synced?:boolean}} beacon
         * @returns {{stored:boolean, action:'added'|'updated'|'duplicate',
         *           nodeId:string, pending:boolean}}
         */
        ingest(beacon) {
            if (!beacon || !beacon.nodeId) return { stored: false, action: 'duplicate', nodeId: null, pending: false };
            const nodeId = String(beacon.nodeId);
            const ts = beacon.timestamp != null ? beacon.timestamp : Date.now();
            const existing = this.store[nodeId];
            if (existing && ts <= existing.timestamp) {
                return { stored: false, action: 'duplicate', nodeId, pending: existing.synced === false };
            }
            this.store[nodeId] = {
                nodeId,
                timestamp: ts,
                data: beacon.data || {},
                synced: beacon.synced === true || (existing ? existing.synced : false),
            };
            this._persist();
            return {
                stored: true,
                action: existing ? 'updated' : 'added',
                nodeId,
                pending: this.store[nodeId].synced === false,
            };
        }

        /** Balizas aún no sincronizadas (outbox de la mula de datos). */
        pending() {
            return Object.keys(this.store)
                .filter((k) => this.store[k].synced === false)
                .map((k) => this.store[k])
                .sort((a, b) => a.timestamp - b.timestamp);
        }

        /** Marca una baliza como ya sincronizada (quitarla del outbox). */
        markSynced(nodeId) {
            const rec = this.store[nodeId];
            if (!rec) return false;
            rec.synced = true;
            this._persist();
            return true;
        }

        /**
         * Mezcla balizas recibidas de otro dispositivo (cruces de mulas).
         * @param {Array} beacons — [{nodeId, timestamp, data}]
         * @returns {{added:number, updated:number, duplicate:number}}
         */
        merge(beacons) {
            const out = { added: 0, updated: 0, duplicate: 0 };
            if (!Array.isArray(beacons)) return out;
            for (const b of beacons) {
                if (!b || !b.nodeId) continue;
                const r = this.ingest({ ...b, synced: false });
                if (r.action === 'added') out.added++;
                else if (r.action === 'updated') out.updated++;
                else out.duplicate++;
            }
            return out;
        }

        /** Estadísticas del almacén. */
        counts() {
            const keys = Object.keys(this.store);
            let pendingN = 0;
            let bytes = 0;
            for (const k of keys) {
                if (this.store[k].synced === false) pendingN++;
                try { bytes += JSON.stringify(this.store[k]).length; } catch (e) { /* no computable */ }
            }
            return {
                stored: keys.length,
                pending: pendingN,
                synced: keys.length - pendingN,
                bytes,
                encrypted: !!this.key,
            };
        }

        /** Vacía el almacén (p.ej. nueva misión). */
        clear() {
            this.store = {};
            if (this.io && this.io.remove) this.io.remove(KEY_NS);
        }
    }

    const api = { DtnStore, KEY_NS };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.DtnStore = DtnStore;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));