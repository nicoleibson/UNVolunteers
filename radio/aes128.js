/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — AES-128 puro en JS (cero dependencias)
 *  Cifrado de payload estilo LoRaWAN: AES-128-CTR + MIC (AES-CMAC)
 *  Implementación FIPS-197 / NIST SP 800-38A / RFC 4493.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// S-box FIPS-197 (tabla estándar)
const SBOX = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
];

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

const ZERO_BLOCK = new Array(16).fill(0);

/**
 * Multiplicación GF(2^8) (FIPS-197, x^8+x^4+x^3+x+1 = 0x11b)
 */
function gmul(a, b) {
    let p = 0;
    a &= 0xFF; b &= 0xFF;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xFF;
        if (hi) a ^= 0x1b;
        b >>= 1;
    }
    return p & 0xFF;
}

/**
 * Expansión de clave AES-128 → 11 claves de ronda (176 bytes)
 */
function keySchedule(key) {
    const w = new Uint8Array(176);
    for (let i = 0; i < 16; i++) w[i] = key[i] & 0xFF;

    let rcon = 0;
    for (let i = 4; i < 44; i++) {
        let t0 = w[(i - 1) * 4 + 0];
        let t1 = w[(i - 1) * 4 + 1];
        let t2 = w[(i - 1) * 4 + 2];
        let t3 = w[(i - 1) * 4 + 3];

        if (i % 4 === 0) {
            // RotWord + SubWord + Rcon
            const tmp = t0; t0 = t1; t1 = t2; t2 = t3; t3 = tmp;
            t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
            t0 ^= RCON[rcon++];
        }
        w[i * 4 + 0] = w[(i - 4) * 4 + 0] ^ t0;
        w[i * 4 + 1] = w[(i - 4) * 4 + 1] ^ t1;
        w[i * 4 + 2] = w[(i - 4) * 4 + 2] ^ t2;
        w[i * 4 + 3] = w[(i - 4) * 4 + 3] ^ t3;
    }
    return w;
}

function subBytes(s) { for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }

function shiftRows(s) {
    // Column-major: fila r está en s[r], s[r+4], s[r+8], s[r+12]
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    let u0 = s[2], u1 = s[6], u2 = s[10], u3 = s[14];
    s[2] = u2; s[6] = u3; s[10] = u0; s[14] = u1;
    let v = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = v;
}

function mixColumns(s) {
    for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i]     = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
}

function addRoundKey(s, w, round) {
    const off = round * 16;
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            s[c * 4 + r] ^= w[off + c * 4 + r];
}

/**
 * Cifra un bloque de 16 bytes con AES-128 (FIPS-197).
 * @param {Array|Uint8Array} key 16 bytes
 * @param {Array|Uint8Array} block 16 bytes (se copia; no muta el original)
 * @returns {number[]} bloque cifrado (16 bytes)
 */
function aes128Block(key, block) {
    const s = new Array(16);
    for (let i = 0; i < 16; i++) s[i] = block[i] & 0xFF;
    const w = keySchedule(key);

    addRoundKey(s, w, 0);
    for (let round = 1; round <= 9; round++) {
        subBytes(s);
        shiftRows(s);
        mixColumns(s);
        addRoundKey(s, w, round);
    }
    subBytes(s);
    shiftRows(s);
    addRoundKey(s, w, 10);
    return s;
}

/**
 * AES-128-CTR (NIST SP 800-38A). El bloque de contador inicial se incrementa
 * en los 4 bytes menos significativos por bloque de 16.
 * @param {Array} key 16 bytes
 * @param {Array} initBlock bloque de contador inicial (16 bytes)
 * @param {Array} data bytes a cifrar
 * @returns {number[]} bytes cifrados (misma longitud)
 */
function aes128Ctr(key, initBlock, data) {
    const out = new Array(data.length);
    const cb = new Array(16);
    for (let i = 0; i < 16; i++) cb[i] = initBlock[i] & 0xFF;

    for (let i = 0; i < data.length; i += 16) {
        const ks = aes128Block(key, cb);
        for (let j = 0; j < 16 && i + j < data.length; j++) {
            out[i + j] = (data[i + j] & 0xFF) ^ ks[j];
        }
        let ctr = ((cb[12] << 24) | (cb[13] << 16) | (cb[14] << 8) | cb[15]) >>> 0;
        ctr = (ctr + 1) >>> 0;
        cb[12] = (ctr >>> 24) & 0xFF;
        cb[13] = (ctr >>> 16) & 0xFF;
        cb[14] = (ctr >>> 8) & 0xFF;
        cb[15] = ctr & 0xFF;
    }
    return out;
}

/**
 * Desplazamiento a la izquierda en GF(2^128) con reducción 0x87 (RFC 4493)
 */
function dbl(block) {
    const out = new Array(16);
    const msb = block[0] >> 7;
    for (let i = 0; i < 16; i++) {
        out[i] = (block[i] << 1) & 0xFF;
        if (i < 15) out[i] |= block[i + 1] >> 7;
    }
    if (msb) out[15] ^= 0x87;
    return out;
}

/**
 * AES-CMAC (RFC 4493) — etiqueta de integridad.
 * @param {Array} key 16 bytes
 * @param {Array} data mensaje
 * @returns {number[]} etiqueta de 16 bytes
 */
function aesCmac(key, data) {
    const L = aes128Block(key, ZERO_BLOCK);
    const K1 = dbl(L);
    const K2 = dbl(K1);

    const n = Math.max(1, Math.ceil(data.length / 16));
    const start = (n - 1) * 16;

    const last = new Array(16).fill(0);
    if (data.length - start === 16 && data.length > 0) {
        for (let i = 0; i < 16; i++) last[i] = (data[start + i] & 0xFF) ^ K1[i];
    } else {
        for (let i = 0; i < 16; i++) last[i] = (start + i < data.length ? data[start + i] & 0xFF : 0x00);
        last[data.length - start] = 0x80;
        for (let i = 0; i < 16; i++) last[i] ^= K2[i];
    }

    let x = ZERO_BLOCK.slice();
    for (let i = 0; i < n - 1; i++) {
        const block = new Array(16);
        for (let j = 0; j < 16; j++) block[j] = (data[i * 16 + j] & 0xFF) ^ x[j];
        x = aes128Block(key, block);
    }
    const fin = new Array(16);
    for (let j = 0; j < 16; j++) fin[j] = last[j] ^ x[j];
    return aes128Block(key, fin);
}

// Export para CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { aes128Block, aes128Ctr, aesCmac, gmul };
}

// Browser global
if (typeof window !== 'undefined') {
    window.AES128 = { aes128Block, aes128Ctr, aesCmac, gmul };
}
