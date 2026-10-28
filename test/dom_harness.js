'use strict';

/**
 * Arnés de DOM simulado (sin dependencias) para probar los simuladores
 * AMRF v1.2 / v2.0 en Node.js vía `vm`. Provee:
 *  - document.getElementById/createElement/querySelectorAll
 *  - window (=== globalThis), addEventListener, timers reales, rAF no-op
 *  - Elementos con value/checked/textContent/classList/dataset/style/hijos
 *  - Contexto 2D de canvas como Proxy (registra llamadas, no-op)
 *  - coreMath real cargado antes del simulador (igual que index*.html)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIM = path.join(__dirname, '..', 'simulation', 'simulation');
const RADIO = path.join(__dirname, '..', 'radio');

// Scripts del stack RF real + proveedores del dispositivo, en el mismo
// orden de carga que index_integrated.html (modo navegador: se exponen
// como window.* en el contexto del vm).
const BROWSER_MODULES = [
    ['aes128.js', RADIO],
    ['packet_encoder.js', RADIO],
    ['lora_mesh.js', RADIO],
    ['aprs_protocol.js', RADIO],
    ['sdr_receiver.js', RADIO],
    ['frequency_mgr.js', RADIO],
    ['radio_driver.js', RADIO],
    ['ble_bridge.js', RADIO],
    ['atmosphere_bridge.js', RADIO],
    ['field_bridge.js', RADIO],
    ['webrtc_link.js', RADIO],
    ['thermal_cam.js', RADIO],
    ['device_links.js', RADIO],
    ['auto_link.js', RADIO],
    ['auto_transports.js', RADIO],
    ['voice_link.js', RADIO],
    ['emergency_radio.js', RADIO],
    ['excavation_cam.js', RADIO],
    ['dtn_store.js', RADIO],
    ['wake_radio.js', RADIO],
    ['device_sensors.js', SIM],
    ['lifeline_engine.js', SIM],
    ['relay_adapter.js', SIM],
];

// Orden EXACTO de carga de index_integrated.html (incluye core_math.js
// en modo navegador, que en el arnés clásico entra por require y por eso
// no reproducía las colisiones de scope global del navegador real).
const FULL_BROWSER_MODULES = [
    ['aes128.js', RADIO],
    ['packet_encoder.js', RADIO],
    ['lora_mesh.js', RADIO],
    ['aprs_protocol.js', RADIO],
    ['sdr_receiver.js', RADIO],
    ['frequency_mgr.js', RADIO],
    ['radio_driver.js', RADIO],
    ['ble_bridge.js', RADIO],
    ['atmosphere_bridge.js', RADIO],
    ['field_bridge.js', RADIO],
    ['webrtc_link.js', RADIO],
    ['thermal_cam.js', RADIO],
    ['device_links.js', RADIO],
    ['auto_link.js', RADIO],
    ['auto_transports.js', RADIO],
    ['voice_link.js', RADIO],
    ['emergency_radio.js', RADIO],
    ['excavation_cam.js', RADIO],
    ['dtn_store.js', RADIO],
    ['wake_radio.js', RADIO],
    ['core_math.js', SIM],
    ['device_sensors.js', SIM],
    ['lifeline_engine.js', SIM],
    ['relay_adapter.js', SIM],
];

function make2DContext() {
    const target = { __calls: [] };
    return new Proxy(target, {
        get(t, prop) {
            if (prop in t) return t[prop];
            if (prop === 'measureText') return () => ({ width: 30 });
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
                return () => ({ addColorStop() {} });
            }
            if (prop === 'canvas') return { width: 0, height: 0 };
            if (prop === Symbol.toPrimitive) return () => 0;
            t.__calls.push(String(prop));
            return () => {};
        },
        set(t, prop, v) { t[prop] = v; return true; },
    });
}

class FakeClassList {
    constructor() { this._set = new Set(); }
    add(...cls) { cls.forEach((c) => this._set.add(c)); }
    remove(...cls) { cls.forEach((c) => this._set.delete(c)); }
    toggle(c, force) {
        if (force === undefined) {
            if (this._set.has(c)) { this._set.delete(c); return false; }
            this._set.add(c); return true;
        }
        if (force) { this._set.add(c); return true; }
        this._set.delete(c); return false;
    }
    contains(c) { return this._set.has(c); }
    get list() { return [...this._set]; }
}

class FakeElement {
    constructor(id) {
        this.id = id;
        this._listeners = {};
        this._children = [];
        this._cls = new FakeClassList();
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.innerHTML = '';
        this.className = '';
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.hidden = false;
        this.dataset = {};
        this.style = {};
        this.width = 320;
        this.height = 160;
        this.parentElement = { clientWidth: 640, clientHeight: 400 };
        this._ctx = make2DContext();
    }

    get classList() { return this._cls; }
    get children() { return this._children; }
    get firstChild() { return this._children[0] || null; }

    getContext(type) { return type === '2d' ? this._ctx : null; }

    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
    }

    dispatch(type, evt = {}) {
        (this._listeners[type] || []).forEach((fn) => fn(evt));
        return true;
    }

    click() { return this.dispatch('click', {}); }

    appendChild(child) {
        child.parentElement = this;
        this._children.push(child);
        return child;
    }

    removeChild(child) {
        const i = this._children.indexOf(child);
        if (i >= 0) this._children.splice(i, 1);
        return child;
    }
}

function loadScript(ctx, filename) {
    const src = fs.readFileSync(path.join(SIM, filename), 'utf8');
    vm.runInContext(src, ctx, { filename });
}

/**
 * Carga el stack RF real (radio/*.js), device_sensors.js y
 * lifeline_engine.js en el contexto del vm en modo navegador, tal y
 * como los carga index_integrated.html. El motor de producción queda
 * disponible como ctx.LifelineEngine / ctx.LifelineSensors.
 */
function loadBrowserModules(ctx) {
    BROWSER_MODULES.forEach(([name, dir]) => {
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        vm.runInContext(src, ctx, { filename: name });
    });
}

/**
 * Crea el contexto vm con DOM simulado (elementos por id, tabs, canvas,
 * timers no-op, window === globalThis). Comparte la base entre
 * bootSimulator (coreMath por require) y bootFullPage (orden exacto del
 * HTML en modo navegador).
 * @param {{ tabButtons?: string[], tabContents?: string[], ids?: string[],
 *           provideCoreMath?: boolean }} [opts]
 */
function createContext(opts = {}) {
    const registry = new Map();
    const ctx = vm.createContext({});

    const getEl = (id) => {
        if (!registry.has(id)) registry.set(id, new FakeElement(id));
        return registry.get(id);
    };

    // Pre-registrar ids declarados
    (opts.ids || []).forEach((id) => getEl(id));

    // Tabs (querySelectorAll('.tab-btn') / '.tab-content').
    // Simula el HTML estático: la primera tab nace activa y el resto ocultas.
    const tabButtons = [];
    (opts.tabButtons || []).forEach((id, i) => {
        const el = getEl(id);
        el.classList.add('tab-btn');
        el.dataset.tab = el.id;
        if (i === 0) el.classList.add('active');
        tabButtons.push(el);
    });
    const tabContents = [];
    (opts.tabContents || []).forEach((id, i) => {
        const el = getEl(id);
        el.classList.add('tab-content');
        if (i !== 0) el.classList.add('hidden');
        tabContents.push(el);
    });

    const documentStub = {
        getElementById: getEl,
        createElement: (tag) => new FakeElement(`${tag}-${registry.size}`),
        querySelectorAll: (sel) => {
            if (sel === '.tab-btn') return tabButtons;
            if (sel === '.tab-content') return tabContents;
            return [];
        },
        body: new FakeElement('body'),
        documentElement: { clientWidth: 900, clientHeight: 700 },
    };

    const globalShims = {
        document: documentStub,
        console,
        // Ventana simulada: innerWidth controla el modo móvil (pantalla
        // completa por tarjeta) cuando es <= 600.
        innerWidth: opts.innerWidth != null ? opts.innerWidth : 1200,
        innerHeight: 900,
        // window === globalThis para que `window.pingNode = fn` sea global
        addEventListener(type, fn) { (globalShims.__winListeners[type] = globalShims.__winListeners[type] || []).push(fn); },
        __winListeners: {},
        requestAnimationFrame() { return 0; }, // no-op: evita animación infinita
        // Timers no-op: registran callbacks sin programarlos, así el proceso
        // del test no se mantiene vivo y nada dispara de forma asíncrona.
        __timerId: 0,
        __timers: [],
        setTimeout(fn, ms) { const id = ++globalShims.__timerId; globalShims.__timers.push({ id, fn, ms, type: 'timeout' }); return id; },
        clearTimeout() {},
        setInterval(fn, ms) { const id = ++globalShims.__timerId; globalShims.__timers.push({ id, fn, ms, type: 'interval' }); return id; },
        clearInterval() {},
        Math,
        Date,
        JSON,
        URLSearchParams,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        // TextEncoder/TextDecoder: disponibles de forma global en el navegador
        // real; el store DTN los usa para cifrar/descifrar el outbox en reposo.
        TextEncoder,
        TextDecoder,
    };
    if (opts.provideCoreMath !== false) {
        // coreMath real por require (scope de módulo). bootFullPage NO lo
        // provee aquí: lo carga core_math.js en modo navegador para poder
        // detectar colisiones de scope global (BUG de v2.2).
        globalShims.coreMath = require(path.join(SIM, 'core_math.js'));
    }
    if (opts.location) globalShims.location = opts.location;
    Object.assign(ctx, globalShims);
    ctx.window = ctx; // window === globalThis

    return { ctx, registry, getEl, globalShims, tabButtons, tabContents };
}

function makeHarness(o) {
    const { ctx, registry, getEl, globalShims, tabButtons, tabContents } = o;
    return {
        ctx,
        registry,
        getEl,
        el: getEl,
        /** Evalúa una expresión en el entorno léxico del simulador (ve let/const). */
        read(expr) { return vm.runInContext(expr, ctx); },
        /** Ejecuta una sentencia en el entorno léxico del simulador. */
        run(stmt) { return vm.runInContext(stmt, ctx); },
        click: (id, evt) => getEl(id).dispatch('click', evt || {}),
        change: (id) => getEl(id).dispatch('change', { target: getEl(id) }),
        input: (id) => getEl(id).dispatch('input', { target: getEl(id) }),
        keypress: (id, evt) => getEl(id).dispatch('keypress', evt || { key: 'Enter' }),
        tabButtons,
        tabContents,
        ctx2d: () => getEl('mesh-canvas').getContext('2d'),
        windowListeners: globalShims.__winListeners,
        get timers() { return globalShims.__timers; },
        /** Ejecuta una vez cada callback de temporizador ya encolado. */
        flushTimers() {
            const snapshot = globalShims.__timers.slice();
            snapshot.forEach((t) => { try { t.fn(); } catch (e) { /* no romper */ } });
        },
    };
}

/**
 * Carga un simulador en un contexto vm con DOM simulado.
 * @param {'app.js'|'app_integrated.js'} script
 * @param {{ tabButtons?: string[], tabContents?: string[], ids?: string[] }} [opts]
 */
function bootSimulator(script, opts = {}) {
    const o = createContext(opts);
    loadBrowserModules(o.ctx); // stack RF real + motor + sensores (igual que index_integrated.html)
    loadScript(o.ctx, script);
    return makeHarness(o);
}

/**
 * Carga la página COMPLETA igual que el navegador: TODOS los scripts de
 * index_integrated.html en su orden exacto (incluido core_math.js en modo
 * navegador, sin `module`) + app_integrated.js, en UN solo contexto vm.
 * Detecta colisiones de scope global (p. ej. `const IPU_THRESHOLD`
 * duplicado) que el arnés clásico no reproduce.
 * @param {{ ids?: string[] }} [opts]
 */
function bootFullPage(opts = {}) {
    const o = createContext({ ...opts, provideCoreMath: false });
    FULL_BROWSER_MODULES.forEach(([name, dir]) => {
        const src = require('fs').readFileSync(path.join(dir, name), 'utf8');
        vm.runInContext(src, o.ctx, { filename: name });
    });
    loadScript(o.ctx, 'app_integrated.js');
    return makeHarness(o);
}

module.exports = { bootSimulator, bootFullPage, FakeElement, SIM };
