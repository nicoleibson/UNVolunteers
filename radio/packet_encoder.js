/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Packet Encoder Module v1.0
 *  RF Packet Encoding/Decoding for Disaster Response
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * Cifrado real estilo LoRaWAN: AES-128-CTR (confidencialidad) + MIC
 * AES-CMAC (integridad). Implementación pura JS (radio/aes128.js).
 */
let AES = null;
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
    AES = require('./aes128.js');
} else if (typeof window !== 'undefined' && window.AES128) {
    AES = window.AES128;
}

const DEFAULT_AES_KEY = '2b7e151628aed2a6abf7158809cf4f3c'; // clave NIST de referencia (solo demo)
const AES_NONCE_LEN = 8;
const AES_MIC_LEN = 4;

function parseHexKey(key) {
    if (typeof key === 'string') {
        if (!/^[0-9a-fA-F]+$/.test(key) || key.length !== 32) {
            throw new Error('AES-128 key debe ser 32 caracteres hex');
        }
        const out = [];
        for (let i = 0; i < 16; i++) out.push(parseInt(key.slice(i * 2, i * 2 + 2), 16));
        return out;
    }
    if (Array.isArray(key) || ArrayBuffer.isView(key)) {
        if (key.length !== 16) throw new Error('AES-128 key debe ser de 16 bytes');
        return Array.from(key, (b) => b & 0xFF);
    }
    throw new Error('AES-128 key inválida');
}

function secureRandomBytes(n) {
    const g = globalThis && globalThis.crypto;
    if (g && typeof g.getRandomValues === 'function') {
        const u8 = new Uint8Array(n);
        g.getRandomValues(u8);
        return Array.from(u8);
    }
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(Math.floor(Math.random() * 256));
    return arr;
}

// Bloque de contador estilo LoRaWAN: [0x01] + nonce(8) + reserva(3) + contador(4) = 16 bytes
function buildCounterBlock(nonce) {
    return [0x01, nonce[0], nonce[1], nonce[2], nonce[3], nonce[4], nonce[5], nonce[6], nonce[7], 0, 0, 0, 0, 0, 0, 0];
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Packet Configuration
 */
const PACKET_CONFIG = {
    // Packet types
    types: {
        BEACON: 0x01,
        DATA: 0x02,
        COMMAND: 0x03,
        ACK: 0x04,
        NACK: 0x05,
        RELAY: 0x06,
        EMERGENCY: 0x07,
    },
    
    // Header format
    headerSize: 16, // bytes
    
    // Maximum payload sizes
    maxPayload: {
        LORA_SF7: 51,
        LORA_SF8: 51,
        LORA_SF9: 115,
        LORA_SF10: 242,
        LORA_SF11: 242,
        LORA_SF12: 242,
        BLE: 251,
        APRS: 256,
    },
};

/**
 * Packet Encoder Class
 * Handles packet encoding/decoding
 */
class PacketEncoder {
    constructor(config = {}) {
        this.encoding = config.encoding || 'JSON';
        this.compression = config.compression || 'NONE';
        this.encryption = config.encryption || 'NONE';
        this.encryptionKey = null;
        this.micKey = null;

        if (this.encryption === 'AES-CTR') {
            if (!AES) throw new Error('Módulo AES-128 no disponible');
            this.encryptionKey = config.key ? parseHexKey(config.key) : parseHexKey(DEFAULT_AES_KEY);
            this.micKey = AES.aes128Block(this.encryptionKey, new Array(16).fill(0x02));
        }
        
        // Statistics
        this.stats = {
            encoded: 0,
            decoded: 0,
            errors: 0,
        };
    }
    
    /**
     * Encode packet to bytes
     */
    encode(packet) {
        try {
            let encoded;
            
            switch (this.encoding) {
                case 'JSON':
                    encoded = this.encodeJSON(packet);
                    break;
                case 'BINARY':
                    encoded = this.encodeBinary(packet);
                    break;
                case 'CBOR':
                    encoded = this.encodeCBOR(packet);
                    break;
                default:
                    encoded = this.encodeJSON(packet);
            }
            
            // Apply compression
            if (this.compression !== 'NONE') {
                encoded = this.compress(encoded);
            }
            
            // Apply encryption
            if (this.encryption !== 'NONE') {
                encoded = this.encrypt(encoded);
            }
            
            this.stats.encoded++;
            return encoded;
            
        } catch (error) {
            this.stats.errors++;
            throw error;
        }
    }
    
    /**
     * Decode bytes to packet
     */
    decode(bytes) {
        try {
            let decoded = bytes;
            
            // Reverse encryption
            if (this.encryption !== 'NONE') {
                decoded = this.decrypt(decoded);
            }
            
            // Reverse compression
            if (this.compression !== 'NONE') {
                decoded = this.decompress(decoded);
            }
            
            // Decode based on format
            let packet;
            switch (this.encoding) {
                case 'JSON':
                    packet = this.decodeJSON(decoded);
                    break;
                case 'BINARY':
                    packet = this.decodeBinary(decoded);
                    break;
                case 'CBOR':
                    packet = this.decodeCBOR(decoded);
                    break;
                default:
                    packet = this.decodeJSON(decoded);
            }
            
            this.stats.decoded++;
            return packet;
            
        } catch (error) {
            this.stats.errors++;
            throw error;
        }
    }
    
    /**
     * Encode packet to JSON
     */
    encodeJSON(packet) {
        const jsonStr = JSON.stringify(packet);
        return this.stringToBytes(jsonStr);
    }
    
    /**
     * Decode JSON to packet
     */
    decodeJSON(bytes) {
        const jsonStr = this.bytesToString(bytes);
        return JSON.parse(jsonStr);
    }
    
    /**
     * Encode packet to binary format
     */
    encodeBinary(packet) {
        const buffer = [];
        
        // Header
        buffer.push(packet.type || 0x00);
        buffer.push(packet.version || 1);
        buffer.push(packet.flags || 0);
        
        // Source ID (8 bytes)
        const sourceId = packet.sourceId || '0000000000000000';
        for (let i = 0; i < 8; i++) {
            buffer.push(parseInt(sourceId.slice(i * 2, i * 2 + 2), 16) || 0);
        }
        
        // Destination ID (8 bytes)
        const destId = packet.destinationId || 'FFFFFFFFFFFFFFFF';
        for (let i = 0; i < 8; i++) {
            buffer.push(parseInt(destId.slice(i * 2, i * 2 + 2), 16) || 0);
        }
        
        // Sequence number (2 bytes)
        const seq = packet.sequence || 0;
        buffer.push((seq >> 8) & 0xFF);
        buffer.push(seq & 0xFF);
        
        // Payload length (2 bytes)
        const payloadBytes = this.stringToBytes(JSON.stringify(packet.payload || {}));
        buffer.push((payloadBytes.length >> 8) & 0xFF);
        buffer.push(payloadBytes.length & 0xFF);
        
        // Payload
        buffer.push(...payloadBytes);
        
        // CRC (2 bytes)
        const crc = this.calculateCRC16(buffer);
        buffer.push((crc >> 8) & 0xFF);
        buffer.push(crc & 0xFF);
        
        return buffer;
    }
    
    /**
     * Decode binary to packet
     */
    decodeBinary(bytes) {
        if (bytes.length < PACKET_CONFIG.headerSize) {
            throw new Error('Packet too short');
        }
        
        let offset = 0;
        
        // Header
        const type = bytes[offset++];
        const version = bytes[offset++];
        const flags = bytes[offset++];
        
        // Source ID
        let sourceId = '';
        for (let i = 0; i < 8; i++) {
            sourceId += bytes[offset++].toString(16).padStart(2, '0');
        }
        
        // Destination ID
        let destId = '';
        for (let i = 0; i < 8; i++) {
            destId += bytes[offset++].toString(16).padStart(2, '0');
        }
        
        // Sequence number
        const sequence = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;
        
        // Payload length
        const payloadLen = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;

        // Verify CRC (antes de interpretar el payload)
        const receivedCRC = (bytes[offset + payloadLen] << 8) | bytes[offset + payloadLen + 1];
        const calculatedCRC = this.calculateCRC16(bytes.slice(0, offset + payloadLen));

        if (receivedCRC !== calculatedCRC) {
            throw new Error('CRC mismatch');
        }

        // Payload
        const payloadBytes = bytes.slice(offset, offset + payloadLen);
        const payload = JSON.parse(this.bytesToString(payloadBytes));
        
        return {
            type,
            version,
            flags,
            sourceId,
            destinationId: destId,
            sequence,
            payload,
        };
    }
    
    /**
     * Encode to CBOR (simplified)
     */
    encodeCBOR(packet) {
        // Simplified CBOR encoding
        const jsonStr = JSON.stringify(packet);
        const bytes = this.stringToBytes(jsonStr);
        
        // Add CBOR major type marker
        return [0xA0, ...bytes]; // Map type
    }
    
    /**
     * Decode CBOR (simplified)
     */
    decodeCBOR(bytes) {
        // Skip CBOR header
        const jsonBytes = bytes.slice(1);
        return JSON.parse(this.bytesToString(jsonBytes));
    }
    
    /**
     * Compress data (LZ77-like)
     */
    compress(data) {
        // Compresión LZ77 sobre bytes crudos.
        // Los literales ≥ 0x80 (o 0x00) se escapan con prefijo 0x00 para no
        // confundirse con los tokens de match (0x80..0xFF).
        const compressed = [];
        
        let i = 0;
        while (i < data.length) {
            // Look for matches
            let matchLen = 0;
            let matchDist = 0;
            
            for (let j = Math.max(0, i - 255); j < i; j++) {
                let k = 0;
                while (i + k < data.length && data[j + k] === data[i + k]) {
                    k++;
                }
                if (k > matchLen && k > 2) {
                    matchLen = k;
                    matchDist = i - j;
                }
            }
            
            if (matchLen > 2) {
                // Emit match (len 3..127 + dist 0..255)
                if (matchLen > 127) matchLen = 127;
                compressed.push(0x80 | matchLen);
                compressed.push(matchDist);
                i += matchLen;
            } else {
                // Emit literal (escapa los que colisionan con tokens de match)
                const b = data[i];
                if (b >= 0x80 || b === 0x00) {
                    compressed.push(0x00, b);
                } else {
                    compressed.push(b);
                }
                i++;
            }
        }
        
        return compressed;
    }
    
    /**
     * Decompress data
     */
    decompress(data) {
        // Decompresión LZ77 (espejo de compress)
        const output = [];
        
        for (let i = 0; i < data.length; i++) {
            const byte = data[i];
            
            if (byte === 0x00) {
                // Literal escapado
                output.push(data[++i]);
            } else if (byte & 0x80) {
                // Match
                const len = byte & 0x7F;
                const dist = data[++i];
                
                for (let j = 0; j < len; j++) {
                    output.push(output[output.length - dist]);
                }
            } else {
                // Literal
                output.push(byte);
            }
        }
        
        return output;
    }
    
    /**
     * Encrypt data
     * 'XOR' → cifrado simulado heredado (demo).
     * 'AES-CTR' → AES-128-CTR estilo LoRaWAN con MIC de integridad.
     * Salida = nonce(8) || ciphertext || MIC(4).
     */
    encrypt(data) {
        if (this.encryption === 'AES-CTR') {
            const nonce = secureRandomBytes(AES_NONCE_LEN);
            const cipher = AES.aes128Ctr(this.encryptionKey, buildCounterBlock(nonce), data);
            const mic = AES.aesCmac(this.micKey, [...nonce, ...cipher]).slice(0, AES_MIC_LEN);
            return [...nonce, ...cipher, ...mic];
        }
        const key = 0x5A; // Simple key
        return data.map(b => b ^ key);
    }
    
    /**
     * Decrypt data (inverso de encrypt)
     */
    decrypt(data) {
        if (this.encryption === 'AES-CTR') {
            if (data.length < AES_NONCE_LEN + AES_MIC_LEN) {
                throw new Error('Ciphertext demasiado corto');
            }
            const nonce = data.slice(0, AES_NONCE_LEN);
            const cipher = data.slice(AES_NONCE_LEN, data.length - AES_MIC_LEN);
            const mic = data.slice(data.length - AES_MIC_LEN);

            const expected = AES.aesCmac(this.micKey, [...nonce, ...cipher]).slice(0, AES_MIC_LEN);
            if (!equalBytes(mic, expected)) {
                throw new Error('MIC mismatch');
            }
            return AES.aes128Ctr(this.encryptionKey, buildCounterBlock(nonce), cipher);
        }
        return this.encrypt(data); // XOR is its own inverse
    }
    
    /**
     * Calculate CRC16
     */
    calculateCRC16(data) {
        let crc = 0xFFFF;
        
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i] << 8;
            for (let j = 0; j < 8; j++) {
                if (crc & 0x8000) {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc <<= 1;
                }
            }
        }
        
        return crc & 0xFFFF;
    }
    
    /**
     * Convert string to bytes
     */
    stringToBytes(str) {
        return Array.from(str).map(c => c.charCodeAt(0));
    }
    
    /**
     * Convert bytes to string
     */
    bytesToString(bytes) {
        return String.fromCharCode(...bytes);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return { ...this.stats };
    }
}

/**
 * Packet Builder Class
 * Helper for building packets
 */
class PacketBuilder {
    constructor() {
        this.packet = {
            type: PACKET_CONFIG.types.DATA,
            version: 1,
            flags: 0,
            sourceId: '0000000000000000',
            destinationId: 'FFFFFFFFFFFFFFFF',
            sequence: 0,
            payload: {},
        };
    }
    
    /**
     * Set packet type
     */
    setType(type) {
        this.packet.type = type;
        return this;
    }
    
    /**
     * Set source ID
     */
    setSource(id) {
        this.packet.sourceId = id;
        return this;
    }
    
    /**
     * Set destination ID
     */
    setDestination(id) {
        this.packet.destinationId = id;
        return this;
    }
    
    /**
     * Set sequence number
     */
    setSequence(seq) {
        this.packet.sequence = seq;
        return this;
    }
    
    /**
     * Set payload
     */
    setPayload(payload) {
        this.packet.payload = payload;
        return this;
    }
    
    /**
     * Build packet
     */
    build() {
        return { ...this.packet };
    }
    
    /**
     * Reset builder
     */
    reset() {
        this.packet = {
            type: PACKET_CONFIG.types.DATA,
            version: 1,
            flags: 0,
            sourceId: '0000000000000000',
            destinationId: 'FFFFFFFFFFFFFFFF',
            sequence: 0,
            payload: {},
        };
        return this;
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PacketEncoder, PacketBuilder, PACKET_CONFIG };
}

// Browser globals
if (typeof window !== 'undefined') {
    window.PacketEncoder = PacketEncoder;
    window.PacketBuilder = PacketBuilder;
    window.PACKET_CONFIG = PACKET_CONFIG;
}

console.log('[Packet Encoder] Module loaded');
