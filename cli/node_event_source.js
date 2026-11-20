'use strict';

const http = require('http');
const https = require('https');

/**
 * EventSource mínimo para Node (SSE) compatible con lo que RelayAdapter
 * espera: onopen / onmessage / onerror / close().
 * Se reconecta con backoff simple mientras no se cierre explícitamente.
 */
class NodeEventSource {
    constructor(url, opts = {}) {
        this.url = String(url);
        this.retryMs = opts.retryMs != null ? opts.retryMs : 2000;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this._req = null;
        this._closed = false;
        this._retryTimer = null;
        this._buffer = '';
        this._connect();
    }

    _connect() {
        if (this._closed) return;
        let parsed;
        try {
            parsed = new URL(this.url);
        } catch (e) {
            this._fail();
            return;
        }
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get(parsed, {
            headers: {
                Accept: 'text/event-stream',
                'Cache-Control': 'no-cache',
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                this._fail();
                return;
            }
            if (this.onopen) {
                try { this.onopen(); } catch (e) { /* no romper */ }
            }
            res.setEncoding('utf8');
            this._buffer = '';
            res.on('data', (chunk) => this._feed(chunk));
            res.on('end', () => this._fail());
            res.on('error', () => this._fail());
        });
        req.on('error', () => this._fail());
        req.on('timeout', () => { req.destroy(); this._fail(); });
        this._req = req;
    }

    _feed(chunk) {
        this._buffer += String(chunk).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = this._buffer.indexOf('\n\n')) !== -1) {
            const block = this._buffer.slice(0, idx);
            this._buffer = this._buffer.slice(idx + 2);
            const data = [];
            for (const line of block.split('\n')) {
                if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length && this.onmessage) {
                try { this.onmessage({ data: data.join('\n') }); } catch (e) { /* no romper */ }
            }
        }
    }

    _fail() {
        this._req = null;
        if (this._closed) return;
        if (this.onerror) {
            try { this.onerror(new Error('SSE_ERROR')); } catch (e) { /* no romper */ }
        }
        if (this._retryTimer) return;
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._connect();
        }, this.retryMs);
        if (this._retryTimer.unref) this._retryTimer.unref();
    }

    close() {
        this._closed = true;
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        if (this._req) {
            try { this._req.destroy(); } catch (e) { /* ya cerrado */ }
            this._req = null;
        }
    }
}

module.exports = { NodeEventSource };
