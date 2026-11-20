'use strict';

/**
 * Parser mínimo de argumentos para la CLI (sin dependencias).
 * Soporta `--clave valor`, `--clave=valor`, flags booleanas, `-h`,
 * opciones repetibles (se convierten en array) y posicionales.
 */

function camelCase(name) {
    return String(name).replace(/-([a-z0-9])/gi, (_, c) => c.toUpperCase());
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        if (raw === '--') {
            out._.push(...argv.slice(i + 1));
            break;
        }
        if (raw === '-h') { out.help = true; continue; }
        if (raw === '-v') { out.version = true; continue; }
        if (raw.startsWith('--')) {
            const eq = raw.indexOf('=');
            let name;
            let value;
            if (eq !== -1) {
                name = raw.slice(2, eq);
                value = raw.slice(eq + 1);
            } else {
                name = raw.slice(2);
                const next = argv[i + 1];
                const looksNegativeNumber = next !== undefined && /^-\d/.test(next);
                if (next !== undefined && (!next.startsWith('-') || next === '-' || looksNegativeNumber)) {
                    value = next;
                    i++;
                } else {
                    value = true;
                }
            }
            const key = camelCase(name);
            if (Object.prototype.hasOwnProperty.call(out, key)) {
                if (!Array.isArray(out[key])) out[key] = [out[key]];
                out[key].push(value);
            } else {
                out[key] = value;
            }
            continue;
        }
        if (raw.startsWith('-') && raw.length > 2) {
            // Flags cortas agrupadas: -abc → a=true,b=true,c=true
            for (const ch of raw.slice(1)) out[camelCase(ch)] = true;
            continue;
        }
        out._.push(raw);
    }
    return out;
}

/** Convierte una línea de shell en tokens respetando comillas simples/dobles. */
function tokenize(line) {
    const out = [];
    let cur = '';
    let quote = null;
    let escaped = false;
    const text = String(line == null ? '' : line);

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            cur += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (cur !== '') { out.push(cur); cur = ''; }
            continue;
        }
        cur += ch;
    }
    if (escaped) cur += '\\';
    if (cur !== '') out.push(cur);
    return out;
}

function bool(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return fallback;
}

function num(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function int(value, fallback = null) {
    const n = num(value, null);
    return n == null ? fallback : Math.trunc(n);
}

function list(value) {
    if (value === undefined || value === null || value === false) return [];
    if (Array.isArray(value)) return value;
    return [value];
}

function pick(args, names, fallback = undefined) {
    for (const name of names) {
        if (args[name] !== undefined) return args[name];
    }
    return fallback;
}

module.exports = { parseArgs, tokenize, camelCase, bool, num, int, list, pick };
