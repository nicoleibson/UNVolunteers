// Project Lifeline Core — Etapa 1 (gateways de borde)
// Genera los iconos PWA sin dependencias: PNG válidos con zlib (built-in) y
// CRC32 propio. Dibuja una línea de pulso (heartbeat) roja sobre fondo
// azul noche — el "lifeline". Uso: node tools/gen_icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'icons');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    // 10..12: compression/filter/interlace = 0
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + width * 4)] = 0; // filtro None
        rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const NAVY = [10, 18, 32, 255];
const RED = [239, 68, 68, 255];
const PULSE = [
    [0.08, 0.55], [0.25, 0.55], [0.34, 0.28], [0.44, 0.74],
    [0.54, 0.40], [0.63, 0.55], [0.92, 0.55],
];

function segDist2(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
    return ex * ex + ey * ey;
}

function render(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const r = 0.045 * size, r2 = r * r;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = x / size, py = y / size;
            let c = NAVY;
            for (let i = 0; i < PULSE.length - 1; i++) {
                const [x1, y1] = PULSE[i], [x2, y2] = PULSE[i + 1];
                if (segDist2(px, py, x1, y1, x2, y2) <= r2) { c = RED; break; }
            }
            const o = (y * size + x) * 4;
            rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
        }
    }
    return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
    const file = path.join(OUT, `icon-${size}.png`);
    fs.writeFileSync(file, render(size));
    const b = fs.readFileSync(file);
    console.log(`${file}: ${b.length} bytes, ${b.readUInt32BE(16)}x${b.readUInt32BE(20)} (IHDR)`);
}
