'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { SIM, requireSim } = require('./helpers.js');
const { createServer } = requireSim('server.js');

const SIM_DIR = SIM; // simulation/simulation/
const RADIO_DIR = path.join(__dirname, '..', 'radio');
const MANIFEST = path.join(SIM_DIR, 'manifest.webmanifest');
const SW = path.join(SIM_DIR, 'sw.js');
const INDEX = path.join(SIM_DIR, 'index_integrated.html');
const ICON_DIR = path.join(SIM_DIR, 'icons');

let server;
let base;

before(async () => {
    server = createServer({ root: SIM });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function get(rawPath) {
    return new Promise((resolve) => {
        http.get(base + rawPath, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body }));
        }).on('error', (e) => resolve({ status: 0, ct: '', body: String(e.message) }));
    });
}

function pngSize(file) {
    const b = fs.readFileSync(file);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function swShellFiles() {
    const src = fs.readFileSync(SW, 'utf8');
    const m = src.match(/const APP_SHELL = \[([\s\S]*?)\];/);
    assert.ok(m, 'sw.js debe declarar APP_SHELL');
    const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    return paths;
}

test('PWA: manifest.webmanifest es JSON válido con los campos de instalación', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.ok(m.name);
    assert.ok(m.short_name);
    assert.equal(m.display, 'standalone');
    assert.ok(m.start_url);
    assert.ok(m.scope);
    assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
    const sizes = m.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
});

test('PWA: los iconos del manifest existen y son PNG de las dimensiones declaradas', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    for (const icon of m.icons) {
        const file = path.join(SIM_DIR, icon.src);
        assert.ok(fs.existsSync(file), `falta ${icon.src}`);
        const sig = fs.readFileSync(file).subarray(0, 8);
        assert.ok(sig.equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), `${icon.src} no es PNG`);
        const [w, h] = icon.sizes.split('x').map(Number);
        const dim = pngSize(file);
        assert.equal(dim.w, w);
        assert.equal(dim.h, h);
    }
});

test('PWA: cada archivo del app shell del service worker existe en disco', () => {
    const rootAliases = { './rf/': RADIO_DIR, './icons/': ICON_DIR };
    for (const rel of swShellFiles()) {
        let file;
        if (rel === './') file = path.join(SIM_DIR, 'index_integrated.html');
        else {
            const alias = Object.keys(rootAliases).find((a) => rel.startsWith(a));
            file = alias
                ? path.join(rootAliases[alias], rel.slice(alias.length))
                : path.join(SIM_DIR, rel.replace(/^\.\//, ''));
        }
        assert.ok(fs.existsSync(file), `app shell referencia archivo inexistente: ${rel}`);
    }
});

test('PWA: el service worker nunca cachea la API (relay/descubrimiento)', () => {
    const src = fs.readFileSync(SW, 'utf8');
    assert.match(src, /isApiRequest/);
    assert.match(src, /startsWith\('\/api\/'\)/);
    assert.match(src, /startsWith\('\/relay\/'\)/);
    assert.match(src, /respondWith/);
});

test('PWA: index_integrated.html enlaza manifest, theme-color e icono táctil', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
    assert.match(html, /name="theme-color"/);
    assert.match(html, /rel="apple-touch-icon"/);
});

test('PWA: app_integrated.js registra el service worker de forma guardada', () => {
    const app = fs.readFileSync(path.join(SIM_DIR, 'app_integrated.js'), 'utf8');
    assert.match(app, /serviceWorker\.register\('sw\.js'/);
    assert.match(app, /navigator\.serviceWorker/);
    assert.match(app, /globalThis\.navigator/);
});

test('PWA: el servidor sirve manifest y sw con MIME correcto', async () => {
    const rManifest = await get('/manifest.webmanifest');
    assert.equal(rManifest.status, 200);
    assert.match(rManifest.ct, /^application\/manifest\+json/);
    const rSw = await get('/sw.js');
    assert.equal(rSw.status, 200);
    assert.match(rSw.ct, /^text\/javascript/);
    const rIcon = await get('/icons/icon-512.png');
    assert.equal(rIcon.status, 200);
    assert.match(rIcon.ct, /^image\/png/);
});
