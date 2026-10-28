/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — AutoLink: adaptadores de transporte reales
 *  Envuelve los drivers físicos con la interfaz que AutoLinkManager
 *  espera: { available, send(line), onReceive(cb) }.
 *
 *   - LoRa (radio_driver): baliza/scan + datos de bajo ancho de banda.
 *     El radio entrega/recibe HEX; el adaptador hace texto↔hex.
 *   - BLE  (enlace de par): datos densos de corto alcance. El adaptador
 *     solo se activa si hay un enlace bidireccional {connected,send,
 *     onReceive}; sin él queda available:false (honesto, no inventa).
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    function toHex(str) {
        let h = '';
        for (let i = 0; i < str.length; i++) h += str.charCodeAt(i).toString(16).padStart(2, '0');
        return h;
    }

    function fromHex(hex) {
        let out = '';
        for (let i = 0; i + 1 < hex.length; i += 2) {
            out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return out;
    }

    /**
     * Adaptador LoRa sobre un LoRaRadioDriver.
     * available == driver.connected; send codifica a hex y llama transmit;
     * onReceive decodifica cada onFrame(hex) a texto y lo entrega.
     */
    function makeLoRaTransport(driver) {
        return {
            get available() { return !!(driver && driver.connected); },
            send(line) {
                if (!driver || !driver.connected) return false;
                driver.transmit(toHex(String(line))); // TX por la radio física
                return true;
            },
            onReceive(cb) {
                if (!driver) return () => {};
                const prev = driver.onFrame;
                driver.onFrame = (frame) => {
                    const txt = frame && frame.hex ? fromHex(frame.hex) : null;
                    if (txt) cb(txt);
                };
                return () => { driver.onFrame = prev; };
            },
        };
    }

    /**
     * Adaptador BLE para datos densos de par a par.
     * `link` debe exponer { connected, send(line)->bool, onReceive(cb)->unsub }.
     * Sin enlace bidireccional real → available:false (nada inventado).
     */
    function makeBleTransport(link) {
        if (!link || typeof link.send !== 'function') {
            return { available: false, send: () => false, onReceive: () => () => {} };
        }
        return {
            get available() { return !!(link && link.connected); },
            send(line) {
                if (!link || !link.connected) return false;
                try { return link.send(String(line)) !== false; }
                catch (e) { return false; }
            },
            onReceive(cb) {
                if (!link || typeof link.onReceive !== 'function') return () => {};
                return link.onReceive(cb);
            },
        };
    }

    /** Construye {lora, ble} listos para pasar a un AutoLinkManager. */
    function createAutoTransports({ radioDriver, bleLink }) {
        return {
            lora: makeLoRaTransport(radioDriver),
            ble: makeBleTransport(bleLink),
        };
    }

    const api = { makeLoRaTransport, makeBleTransport, createAutoTransports, toHex, fromHex };
    if (IS_NODE) module.exports = api;
    else {
        global.AutoTransports = api;
        global.makeLoRaTransport = makeLoRaTransport;
        global.makeBleTransport = makeBleTransport;
        global.createAutoTransports = createAutoTransports;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
