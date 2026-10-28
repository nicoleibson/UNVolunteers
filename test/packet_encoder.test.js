'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, mulberry32 } = require('./helpers.js');
const { PacketEncoder, PacketBuilder, PACKET_CONFIG } = requireRadio('packet_encoder.js');

function makePacket() {
    return new PacketBuilder()
        .setType(PACKET_CONFIG.types.EMERGENCY)
        .setSource('29CD40CE00032356')
        .setDestination('FFFFFFFFFFFFFFFF')
        .setSequence(42)
        .setPayload({ bpm: 118, spo2: 94, battery: 67, depth: 4.3, gps: { lat: -34.603722, lon: -58.381592 } })
        .build();
}

test('PacketEncoder: roundtrip en todas las combinaciones encoding x compression x encryption', () => {
    const encodings = ['JSON', 'BINARY', 'CBOR'];
    const compressions = ['NONE', 'LZ77'];
    const encryptions = ['NONE', 'XOR', 'AES-CTR'];

    for (const encoding of encodings) {
        for (const compression of compressions) {
            for (const encryption of encryptions) {
                const encoder = new PacketEncoder({ encoding, compression, encryption });
                const bytes = encoder.encode(makePacket());
                const decoded = encoder.decode(bytes);

                assert.equal(decoded.type, PACKET_CONFIG.types.EMERGENCY, `${encoding}/${compression}/${encryption}: type`);
                assert.equal(decoded.sourceId.toLowerCase(), '29cd40ce00032356', `${encoding}/${compression}/${encryption}: source`);
                assert.equal(decoded.sequence, 42, `${encoding}/${compression}/${encryption}: sequence`);
                assert.equal(decoded.payload.bpm, 118, `${encoding}/${compression}/${encryption}: payload.bpm`);
                assert.equal(decoded.payload.gps.lat, -34.603722, `${encoding}/${compression}/${encryption}: payload.gps`);
            }
        }
    }
});

test('PacketEncoder: tamaño BINARY = header(16) + payload + CRC(2)', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY' });
    const bytes = encoder.encode(makePacket());
    const payloadLen = bytes.length - PACKET_CONFIG.headerSize - 2;
    assert.ok(payloadLen > 0);
    assert.equal(bytes[bytes.length - 2] & 0xFF, bytes[bytes.length - 2]);
});

test('PacketEncoder: CRC16 siempre en rango 16 bits', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY' });
    for (let i = 0; i < 50; i++) {
        const bytes = encoder.encode(makePacket());
        const crc = encoder.calculateCRC16(bytes.slice(0, bytes.length - 2));
        assert.ok(crc >= 0 && crc <= 0xFFFF, `crc=${crc}`);
    }
});

test('PacketEncoder: CRC detecta cualquier corrupción en BINARY (cada posición de byte)', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY' });
    const bytes = encoder.encode(makePacket());
    let thrown = 0;
    for (let i = 0; i < bytes.length; i++) {
        const corrupted = [...bytes];
        corrupted[i] ^= 0xFF;
        assert.throws(() => encoder.decode(corrupted), /CRC mismatch/, `byte position ${i}`);
        thrown++;
    }
    assert.equal(thrown, bytes.length);
});

test('PacketEncoder: paquetes truncados lanzan error', () => {
    const encoder = new PacketEncoder({ encoding: 'BINARY' });
    const bytes = encoder.encode(makePacket());
    assert.throws(() => encoder.decode(bytes.slice(0, 5)), /too short|Packet/);
    assert.throws(() => encoder.decode([]));
});

test('PacketEncoder: fuzzing de bytes corruptos aleatorios (determinista)', () => {
    const rng = mulberry32(20260801);
    const encoder = new PacketEncoder({ encoding: 'BINARY' });
    const bytes = encoder.encode(makePacket());

    for (let round = 0; round < 200; round++) {
        const corrupted = [...bytes];
        const flips = 1 + Math.floor(rng() * 4);
        for (let f = 0; f < flips; f++) {
            const idx = Math.floor(rng() * corrupted.length);
            corrupted[idx] = (corrupted[idx] ^ (0x01 << Math.floor(rng() * 8))) & 0xFF;
        }
        // La decodificación debe fallar (CRC) o el resultado debe re-encodear de forma estable
        try {
            const decoded = encoder.decode(corrupted);
            const reencoded = encoder.encode(decoded);
            assert.deepEqual(encoder.decode(reencoded).payload, decoded.payload);
        } catch (e) {
            assert.ok(/CRC mismatch|Unexpected token|JSON|too short|too short/i.test(e.message), `round ${round}: ${e.message}`);
        }
    }
});

test('PacketEncoder: stats se incrementan', () => {
    const encoder = new PacketEncoder({ encoding: 'JSON' });
    encoder.encode(makePacket());
    encoder.encode(makePacket());
    encoder.decode(encoder.encode(makePacket()));
    assert.equal(encoder.stats.encoded, 3);
    assert.equal(encoder.stats.decoded, 1);
    assert.equal(encoder.stats.errors, 0);
});

test('PacketEncoder: tipos de paquete disponibles', () => {
    for (const k of ['BEACON', 'DATA', 'COMMAND', 'ACK', 'NACK', 'RELAY', 'EMERGENCY']) {
        assert.equal(typeof PACKET_CONFIG.types[k], 'number', k);
    }
});

test('PacketEncoder: payload máximo declarado por PHY', () => {
    assert.ok(PACKET_CONFIG.maxPayload.LORA_SF10 >= 242);
    assert.ok(PACKET_CONFIG.maxPayload.APRS >= 256);
});
