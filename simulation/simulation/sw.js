// Project Lifeline Core — Service Worker (Etapa 1: gateways de borde)
// Estrategia: cache-first para el "app shell" (offline total), red-only para
// la API (relay/descubrimiento) — la telemetría NUNCA se sirve de caché.
// Versión del caché: bump CACHE_VERSION al desplegar cambios de la shell.
'use strict';

const CACHE_VERSION = 'lifeline-shell-v3';
const CACHE_NAME = CACHE_VERSION;

const APP_SHELL = [
    './',
    './index_integrated.html',
    './styles.css',
    './core_math.js',
    './device_sensors.js',
    './lifeline_engine.js',
    './relay_adapter.js',
    './app_integrated.js',
    './rf/aes128.js',
    './rf/packet_encoder.js',
    './rf/lora_mesh.js',
    './rf/aprs_protocol.js',
    './rf/sdr_receiver.js',
    './rf/frequency_mgr.js',
    './rf/radio_driver.js',
    './rf/ble_bridge.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

function isApiRequest(url) {
    const p = url.pathname;
    return p.startsWith('/api/') || p.startsWith('/relay/');
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // no cachear terceros (Google Fonts, etc.)
    if (isApiRequest(url)) return; // relay/descubrimiento: siempre red

    event.respondWith(
        caches.match(req).then((hit) => {
            if (hit) return hit;
            return fetch(req).then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            });
        })
    );
});

// Offline: navegaciones sin red → app shell cacheada
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
