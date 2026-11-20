'use strict';

const util = require('util');

function stamp() {
    return new Date().toISOString().slice(11, 19);
}

class Output {
    constructor(opts = {}) {
        this.json = !!opts.json;
        this.quiet = !!opts.quiet;
        this.verbose = !!opts.verbose;
        this._jsonFn = opts.jsonWriter || ((line) => process.stdout.write(line + '\n'));
        this._textFn = opts.textWriter || ((line) => process.stdout.write(line + '\n'));
        this._errFn = opts.errorWriter || ((line) => process.stderr.write(line + '\n'));
    }

    log(channel, message, opts = {}) {
        const level = opts.level || 'info';
        if (this.quiet) return;
        if (this.json) {
            this._jsonFn(JSON.stringify({
                ts: new Date().toISOString(),
                type: 'log',
                level,
                channel: channel || 'cli',
                message: typeof message === 'string' ? message : util.inspect(message, { depth: 4, breakLength: 120 }),
            }));
            return;
        }
        const line = `[${stamp()}] [${channel || 'cli'}] ${typeof message === 'string' ? message : util.inspect(message, { depth: 4, breakLength: 120 })}`;
        this._textFn(line);
    }

    event(type, data) {
        if (this.json) {
            this._jsonFn(JSON.stringify({ ts: new Date().toISOString(), type, ...data }));
            return;
        }
        if (this.quiet) return;
        this._textFn(`[${stamp()}] [${type}] ${formatEvent(data)}`);
    }

    data(value) {
        if (this.json) {
            this._jsonFn(JSON.stringify(value));
            return;
        }
        this._textFn(typeof value === 'string' ? value : util.inspect(value, { depth: 6, breakLength: 120 }));
    }

    text(line) {
        if (this.json) return;
        this._textFn(String(line));
    }

    error(message) {
        if (this.json) {
            this._jsonFn(JSON.stringify({
                ts: new Date().toISOString(),
                type: 'error',
                message: message instanceof Error ? message.message : String(message),
            }));
            return;
        }
        this._errFn(`[${stamp()}] [error] ${message instanceof Error ? message.stack || message.message : message}`);
    }

    warn(message) {
        this.log('warn', message, { level: 'warn' });
    }

    debug(channel, message) {
        if (!this.verbose) return;
        this.log(channel, message, { level: 'debug' });
    }
}

function formatEvent(data) {
    if (!data || typeof data !== 'object') return String(data);
    if (data.message) {
        const from = data.fromName || data.fromId || 'remoto';
        return `mensaje de ${from}: ${data.message}`;
    }
    if (data.node) return `nodo ${data.node} (${data.role || '—'})`;
    return util.inspect(data, { depth: 3, breakLength: 120 });
}

module.exports = { Output, formatEvent };
