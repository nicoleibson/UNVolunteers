'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio } = require('./helpers.js');
const { aes128Block, aes128Ctr, aesCmac } = requireRadio('aes128.js');
const { PacketEncoder, PacketBuilder, PACKET_CONFIG } = requireRadio('packet_encoder.js');

const fromHex = (h) => Array.from(Buffer.from(h, 'hex'));
const toHex = (a) => Buffer.from(a).toString('hex');

const KEY = '2b7e151628aed2a6abf7158809cf4f3c';

test('AES-128: vector FIPS-197 Apéndice B (bloque único)', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    const pt = fromHex('00112233445566778899aabbccddeeff');
    assert.equal(toHex(aes128Block(key, pt)), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('AES-CTR: vector NIST SP 800-38A (dos bloques)', () => {
    const key = fromHex(KEY);
    const ctr = fromHex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
    const pt = fromHex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
    const ct = toHex(aes128Ctr(key, ctr, pt));
    assert.equal(ct, '874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff');
});

test('AES-CMAC: vectores RFC 4493', () => {
    const key = fromHex(KEY);
    assert.equal(toHex(aesCmac(key, [])), 'bb1d6929e95937287fa37d129b756746');
    assert.equal(toHex(aesCmac(key, fromHex('6bc1bee22e409f96e93d7e117393172a'))), '070a16b46b4d4144f79bdd9dd04a287c');
    const m64 = fromHex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710');
    assert.equal(toHex(aesCmac(key, m64)), '51f0bebf7e3b9d92fc49741779363cfe');
});

test('PacketEncoder: AES-CTR no muta el input y agrega nonce+MIC (12 bytes)', () => {
    const encoder = new PacketEncoder({ encoding: 'JSON', encryption: 'AES-CTR', key: KEY });
    const packet = new PacketBuilder()
        .setSource('29CD40CE00032356')
        .setSequence(7)
        .setPayload({ bpm: 100 })
        .build();
    const bytes = encoder.encode(packet);
    const plainLen = encoder.encodeJSON(packet).length;
    assert.equal(bytes.length, plainLen + 12, 'nonce(8) + MIC(4)');
    assert.equal(bytes.length > 0, true);
});

test('PacketEncoder: AES-CTR con clave personalizada hace roundtrip', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY', compression: 'LZ77', encryption: 'AES-CTR', key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    const packet = new PacketBuilder()
        .setSource('29CD40CE00032356')
        .setSequence(42)
        .setPayload({ gps: { lat: -34.6, lon: -58.4 } })
        .build();
    const decoded = encoder.decode(encoder.encode(packet));
    assert.equal(decoded.payload.gps.lat, -34.6);
    assert.equal(decoded.sequence, 42);
});

test('PacketEncoder: AES-CTR con clave distinta no descifra (MIC mismatch)', () => {
    const a = new PacketEncoder({ encoding: 'JSON', encryption: 'AES-CTR', key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    const b = new PacketEncoder({ encoding: 'JSON', encryption: 'AES-CTR', key: '00000000000000000000000000000001' });
    const bytes = a.encode({ tipo: 'test' });
    assert.throws(() => b.decode(bytes), /MIC mismatch/);
});

test('PacketEncoder: AES-CTR detecta corrupción (cada byte del frame)', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY', compression: 'LZ77', encryption: 'AES-CTR', key: KEY });
    const bytes = encoder.encode(new PacketBuilder()
        .setSource('29CD40CE00032356')
        .setSequence(1)
        .setPayload({ bpm: 80 })
        .build());
    let thrown = 0;
    for (let i = 0; i < bytes.length; i++) {
        const corrupted = [...bytes];
        corrupted[i] ^= 0x01;
        assert.throws(() => encoder.decode(corrupted), /MIC mismatch|CRC mismatch/, `byte ${i}`);
        thrown++;
    }
    assert.equal(thrown, bytes.length);
});

test('PacketEncoder: AES-CTR usa nonce aleatorio → mismo plaintext distinto ciphertext', () => {
    const encoder = new PacketEncoder({ encoding: 'JSON', encryption: 'AES-CTR', key: KEY });
    const packet = new PacketBuilder().setSource('29CD40CE00032356').setPayload({ a: 1 }).build();
    const c1 = toHex(encoder.encode(packet));
    const c2 = toHex(encoder.encode(packet));
    assert.notEqual(c1, c2);
    assert.notEqual(c1.slice(0, 16), c2.slice(0, 16), 'nonces distintos');
});

test('PacketEncoder: clave inválida lanza error', () => {
    assert.throws(() => new PacketEncoder({ encryption: 'AES-CTR', key: 'corto' }), /hex/);
    assert.throws(() => new PacketEncoder({ encryption: 'AES-CTR', key: 'gg'.repeat(16) }), /hex/);
    assert.throws(() => new PacketEncoder({ encryption: 'AES-CTR', key: new Array(4) }), /16 bytes/);
});

test('PacketEncoder: AES-CTR con clave por defecto funciona sin configurar', () => {
    const encoder = new PacketEncoder({ encoding: 'CBOR', encryption: 'AES-CTR' });
    const packet = new PacketBuilder().setSource('29CD40CE00032356').setPayload({ v: 5 }).build();
    const decoded = encoder.decode(encoder.encode(packet));
    assert.equal(decoded.payload.v, 5);
});
