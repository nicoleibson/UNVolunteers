/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — APRS Protocol Module v1.0
 *  Automatic Packet Reporting System for Rescue Operations
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * APRS Configuration
 * Standard APRS parameters for emergency operations
 */
const APRS_CONFIG = {
    // APRS frequencies (VHF 2m band)
    frequencies: {
        Americas: 144.390,    // North America
        Europe: 144.800,      // Europe
        Japan: 144.640,       // Japan
        Australia: 145.175,   // Australia
        Argentina: 144.930,   // Argentina
    },
    
    // Baud rates
    baudRates: {
        standard: 1200,
        highSpeed: 9600,
    },
    
    // AX.25 frame types
    frameTypes: {
        UI: 0x03,      // Unnumbered Information
        I: 0x00,       // Information
        S: 0x01,       // Supervisory
    },
    
    // APRS data types
    dataTypes: {
        POSITION: '!',
        MESSAGE: ':',
        STATUS: '>',
        TELEMETRY: 'T',
        WEATHER: '_',
        OBJECT: ';',
        ITEM: ')',
    },
    
    // Symbol codes
    symbols: {
        TRAPPED: '[',      // Person in distress
        RESCUE: '/',       // Rescue vehicle
        MEDICAL: '+',      // Medical
        COMMAND: 'C',      // Command post
        RELAY: 'R',        // Relay station
        HELICOPTER: 'H',   // Helicopter
    },
};

/**
 * AX.25 Frame Class
 * Handles AX.25 packet encoding/decoding
 */
class AX25Frame {
    constructor(config = {}) {
        this.sourceCallsign = config.sourceCallsign || 'N0CALL';
        this.sourceSSID = config.sourceSSID || 0;
        this.destinationCallsign = config.destinationCallsign || 'APRS';
        this.destinationSSID = config.destinationSSID || 0;
        this.repeaterPath = config.repeaterPath || ['WIDE1-1', 'WIDE2-1'];
        this.infoField = config.infoField || '';
        this.control = config.control || APRS_CONFIG.frameTypes.UI;
        this.protocol = config.protocol || 0xF0; // No layer 3
    }
    
    /**
     * Encode frame to bytes
     */
    encode() {
        const frame = [];
        
        // Destination address (7 bytes)
        frame.push(...this.encodeAddress(this.destinationCallsign, this.destinationSSID, false));
        
        // Source address (7 bytes) — last address only when there is no repeater path
        frame.push(...this.encodeAddress(this.sourceCallsign, this.sourceSSID, this.repeaterPath.length === 0));
        
        // Repeater path (7 bytes each)
        this.repeaterPath.forEach((path, index) => {
            const isLast = index === this.repeaterPath.length - 1;
            const callsign = path.split('-')[0];
            const ssid = parseInt(path.split('-')[1]) || 0;
            frame.push(...this.encodeAddress(callsign, ssid, isLast));
        });
        
        // Control field
        frame.push(this.control);
        
        // Protocol ID
        frame.push(this.protocol);
        
        // Info field
        const infoBytes = this.stringToBytes(this.infoField);
        frame.push(...infoBytes);
        
        // FCS (Frame Check Sequence)
        const fcs = this.calculateFCS(frame);
        frame.push(fcs & 0xFF);
        frame.push((fcs >> 8) & 0xFF);
        
        return frame;
    }
    
    /**
     * Decode frame from bytes
     */
    static decode(bytes) {
        if (bytes.length < 16) {
            throw new Error('Frame too short');
        }
        
        let offset = 0;
        
        // Decode destination
        const destination = this.decodeAddress(bytes.slice(offset, offset + 7));
        offset += 7;
        
        // Decode source
        const source = this.decodeAddress(bytes.slice(offset, offset + 7));
        offset += 7;
        
        // Decode repeater path
        // The extension bit (0x01) lives in the LAST byte of each address (SSID byte).
        // The address field ends when the previously-read address carries that bit.
        const repeaterPath = [];
        
        while (!(bytes[offset - 1] & 0x01) && offset + 7 <= bytes.length - 2) {
            const repeater = this.decodeAddress(bytes.slice(offset, offset + 7));
            repeaterPath.push(`${repeater.callsign}-${repeater.ssid}`);
            offset += 7;
        }
        
        // Control field
        const control = bytes[offset++];
        
        // Protocol ID
        const protocol = bytes[offset++];
        
        // Info field (everything until FCS)
        const infoBytes = bytes.slice(offset, bytes.length - 2);
        const infoField = String.fromCharCode(...infoBytes);
        
        return new AX25Frame({
            sourceCallsign: source.callsign,
            sourceSSID: source.ssid,
            destinationCallsign: destination.callsign,
            destinationSSID: destination.ssid,
            repeaterPath: repeaterPath,
            control: control,
            protocol: protocol,
            infoField: infoField,
        });
    }
    
    /**
     * Encode address field
     */
    encodeAddress(callsign, ssid, isLast) {
        const address = [];
        const paddedCallsign = callsign.padEnd(6, ' ').toUpperCase();
        
        for (let i = 0; i < 6; i++) {
            address.push(paddedCallsign.charCodeAt(i) << 1);
        }
        
        // SSID byte: reserved bits + SSID + extension bit
        const ssidByte = 0x60 | (ssid << 1) | (isLast ? 0x01 : 0x00);
        address.push(ssidByte);
        
        return address;
    }
    
    /**
     * Decode address field
     */
    static decodeAddress(bytes) {
        let callsign = '';
        for (let i = 0; i < 6; i++) {
            const char = bytes[i] >> 1;
            if (char !== 32) { // Skip spaces
                callsign += String.fromCharCode(char);
            }
        }
        
        const ssid = (bytes[6] >> 1) & 0x0F;
        
        return { callsign: callsign.trim(), ssid };
    }
    
    /**
     * Calculate Frame Check Sequence (FCS)
     */
    calculateFCS(data) {
        let fcs = 0xFFFF;
        
        for (let i = 0; i < data.length; i++) {
            fcs ^= data[i];
            for (let j = 0; j < 8; j++) {
                if (fcs & 0x0001) {
                    fcs = (fcs >> 1) ^ 0x8408;
                } else {
                    fcs >>= 1;
                }
            }
        }
        
        return fcs ^ 0xFFFF;
    }
    
    /**
     * Convert string to bytes
     */
    stringToBytes(str) {
        return Array.from(str).map(c => c.charCodeAt(0));
    }
    
    /**
     * Get frame as hex string
     */
    toHexString() {
        return this.encode().map(b => b.toString(16).padStart(2, '0')).join(' ');
    }
}

/**
 * APRS Packet Class
 * Handles APRS-specific packet creation
 */
class APRSPacket {
    constructor(config = {}) {
        this.callsign = config.callsign || 'N0CALL';
        this.ssid = config.ssid || 0;
        this.symbol = config.symbol || APRS_CONFIG.symbols.TRAPPED;
        this.symbolTable = config.symbolTable || '/';
        
        // Position
        this.latitude = config.latitude || 0;
        this.longitude = config.longitude || 0;
        this.altitude = config.altitude || 0;
        this.course = config.course || 0;
        this.speed = config.speed || 0;
        
        // Message
        this.message = config.message || '';
        this.messageType = config.messageType || 'POSITION';
    }
    
    /**
     * Create position report
     */
    createPositionReport() {
        const lat = this.encodeLatitude(this.latitude);
        const lon = this.encodeLongitude(this.longitude);
        
        // Compressed position format
        const data = `${this.symbolTable}${lat}${this.symbol}${lon}`;
        
        return this.createAPRSPacket('!', data);
    }
    
    /**
     * Create position report with timestamp
     */
    createPositionReportWithTimestamp() {
        const timestamp = this.encodeTimestamp(Date.now());
        const lat = this.encodeLatitude(this.latitude);
        const lon = this.encodeLongitude(this.longitude);
        
        const data = `${timestamp}${lat}${this.symbol}${lon}`;
        
        return this.createAPRSPacket('/', data);
    }
    
    /**
     * Create status report
     */
    createStatusReport(statusText) {
        const data = statusText;
        return this.createAPRSPacket('>', data);
    }
    
    /**
     * Create message
     */
    createMessage(addressee, message) {
        const paddedAddressee = addressee.padEnd(9, ' ');
        const data = `${paddedAddressee}:${message}`;
        return this.createAPRSPacket(':', data);
    }
    
    /**
     * Create telemetry report
     */
    createTelemetryReport(channel, value) {
        const data = `#${channel.toString().padStart(3, '0')},${value}`;
        return this.createAPRSPacket('T', data);
    }
    
    /**
     * Create APRS object
     */
    createObject(name, latitude, longitude, alive = true) {
        const lat = this.encodeLatitude(latitude);
        const lon = this.encodeLongitude(longitude);
        const killByte = alive ? '*' : '_';
        
        const data = `${name.padEnd(9, ' ')}${killByte}${this.symbolTable}${lat}${this.symbol}${lon}`;
        
        return this.createAPRSPacket(';', data);
    }
    
    /**
     * Create emergency beacon
     */
    createEmergencyBeacon() {
        const lat = this.encodeLatitude(this.latitude);
        const lon = this.encodeLongitude(this.longitude);
        
        // Emergency symbol
        const data = `${this.symbolTable}${lat}${this.symbol}${lon}EMERGENCY - NEED RESCUE`;
        
        return this.createAPRSPacket('!', data);
    }
    
    /**
     * Create rescue status update
     */
    createRescueStatus(victimCount, depth, condition) {
        const status = `RESCUE: ${victimCount} victims, depth ${depth}m, condition: ${condition}`;
        return this.createStatusReport(status);
    }
    
    /**
     * Create core APRS packet
     */
    createAPRSPacket(dataType, data) {
        const infoField = `${dataType}${data}`;
        
        const frame = new AX25Frame({
            sourceCallsign: this.callsign,
            sourceSSID: this.ssid,
            destinationCallsign: 'APRS',
            repeaterPath: ['WIDE1-1', 'WIDE2-1'],
            infoField: infoField,
        });
        
        return {
            frame: frame,
            infoField: infoField,
            timestamp: Date.now(),
            callsign: this.callsign,
        };
    }
    
    /**
     * Encode latitude to APRS format
     */
    encodeLatitude(lat) {
        const degrees = Math.abs(Math.floor(lat));
        const minutes = (Math.abs(lat) - degrees) * 60;
        
        const ns = lat >= 0 ? 'N' : 'S';
        
        return `${degrees.toString().padStart(2, '0')}${minutes.toFixed(2).padStart(5, '0')}${ns}`;
    }
    
    /**
     * Encode longitude to APRS format
     */
    encodeLongitude(lon) {
        const degrees = Math.abs(Math.floor(lon));
        const minutes = (Math.abs(lon) - degrees) * 60;
        
        const ew = lon >= 0 ? 'E' : 'W';
        
        return `${degrees.toString().padStart(3, '0')}${minutes.toFixed(2).padStart(5, '0')}${ew}`;
    }
    
    /**
     * Encode timestamp
     */
    encodeTimestamp(timestamp) {
        const date = new Date(timestamp);
        const hours = date.getUTCHours().toString().padStart(2, '0');
        const minutes = date.getUTCMinutes().toString().padStart(2, '0');
        const seconds = date.getUTCSeconds().toString().padStart(2, '0');
        
        return `${hours}${minutes}${seconds}h`;
    }
}

/**
 * APRS Tracker Class
 * Manages APRS tracking for multiple objects
 */
class APRSTracker {
    constructor(config = {}) {
        this.callsign = config.callsign || 'N0CALL';
        this.frequency = config.frequency || APRS_CONFIG.frequencies.Americas;
        this.objects = new Map();
        
        // Statistics
        this.stats = {
            packetsSent: 0,
            lastBeacon: 0,
        };
    }
    
    /**
     * Add object to track
     */
    addObject(name, config) {
        const packet = new APRSPacket({
            callsign: this.callsign,
            ...config,
        });
        
        this.objects.set(name, {
            packet: packet,
            lastUpdate: 0,
            position: { lat: config.latitude, lon: config.longitude },
        });
        
        console.log(`[APRS] Added object: ${name}`);
    }
    
    /**
     * Update object position
     */
    updatePosition(name, lat, lon) {
        const obj = this.objects.get(name);
        if (!obj) return false;
        
        obj.packet.latitude = lat;
        obj.packet.longitude = lon;
        obj.position = { lat, lon };
        obj.lastUpdate = Date.now();
        
        return true;
    }
    
    /**
     * Send beacon for all objects
     */
    sendBeacons() {
        this.objects.forEach((obj, name) => {
            const packet = obj.packet.createPositionReport();
            this.stats.packetsSent++;
            this.stats.lastBeacon = Date.now();
            
            console.log(`[APRS] Beacon sent for ${name}`);
        });
    }
    
    /**
     * Get object by name
     */
    getObject(name) {
        return this.objects.get(name);
    }
    
    /**
     * Get all tracked objects
     */
    getAllObjects() {
        return Array.from(this.objects.entries()).map(([name, obj]) => ({
            name,
            ...obj,
        }));
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AX25Frame, APRSPacket, APRSTracker, APRS_CONFIG };
}

// Browser globals
if (typeof window !== 'undefined') {
    window.AX25Frame = AX25Frame;
    window.APRSPacket = APRSPacket;
    window.APRSTracker = APRSTracker;
    window.APRS_CONFIG = APRS_CONFIG;
}

console.log('[APRS Protocol] Module loaded');
