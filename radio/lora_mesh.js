/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — LoRa Mesh Network Module v1.0
 *  Long Range, Low Power Mesh for Disaster Response
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * LoRa Mesh Network Configuration
 * Supports 433 MHz (Europe), 868 MHz (Europe), 915 MHz (Americas)
 */
const LORA_CONFIG = {
    // Frequency bands
    frequencies: {
        EU433: { band: 433.05, maxPower: 10, maxRange: 10 },
        EU868: { band: 868.0, maxPower: 14, maxRange: 12 },
        US915: { band: 915.0, maxPower: 20, maxRange: 15 },
    },
    
    // Spreading factors (SF7-SF12)
    // Higher SF = longer range, lower data rate
    spreadingFactors: {
        SF7:  { range: 2,  dataRate: 5.47,  timeOnAir: 8.5 },
        SF8:  { range: 3,  dataRate: 3.125, timeOnAir: 15 },
        SF9:  { range: 5,  dataRate: 1.76,  timeOnAir: 27 },
        SF10: { range: 7,  dataRate: 0.98,  timeOnAir: 48 },
        SF11: { range: 10, dataRate: 0.54,  timeOnAir: 86 },
        SF12: { range: 15, dataRate: 0.29,  timeOnAir: 154 },
    },
    
    // Bandwidth options
    bandwidths: {
        BW125: 125,  // kHz - best range
        BW250: 250,  // kHz - balanced
        BW500: 500,  // kHz - fastest
    },
    
    // Coding rates
    codingRates: {
        CR4_5: 1.25,  // 20% overhead
        CR4_6: 1.5,   // 33% overhead
        CR4_7: 1.75,  // 50% overhead
        CR4_8: 2.0,   // 100% overhead (most robust)
    },
    
    // Power levels (dBm)
    powerLevels: {
        LOW:    7,
        MEDIUM: 14,
        HIGH:   20,
        MAX:    22,
    },
};

/**
 * LoRa Node Class
 * Represents a single node in the mesh network
 */
class LoRaNode {
    constructor(config) {
        this.id = config.id || this.generateId();
        this.name = config.name || `Node-${this.id.slice(0, 4)}`;
        this.type = config.type || 'SCOUT'; // SCOUT, RELAY, VICTIM
        
        // Position
        this.lat = config.lat || 0;
        this.lon = config.lon || 0;
        this.alt = config.alt || 0; // meters above sea level
        
        // Radio configuration
        this.frequency = config.frequency || 'US915';
        this.spreadingFactor = config.spreadingFactor || 'SF10';
        this.bandwidth = config.bandwidth || 'BW125';
        this.codingRate = config.codingRate || 'CR4_5';
        this.txPower = config.txPower || 'MEDIUM';
        
        // Network state
        this.isActive = false;
        this.lastBeacon = 0;
        this.neighborCount = 0;
        this.hopCount = 0;
        this.maxHops = config.maxHops || 5;
        this.battery = config.battery != null ? config.battery : null;
        
        // Packet handling
        this.packetQueue = [];
        this.sentPackets = new Map();
        this.receivedPackets = new Set();
        
        // Callbacks
        this.onPacket = config.onPacket || null;
        this.onNodeJoin = config.onNodeJoin || null;
        this.onNodeLeave = config.onNodeLeave || null;
    }
    
    generateId() {
        return Array.from({ length: 8 }, () =>
            Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
        ).join('').toUpperCase();
    }
    
    /**
     * Activate the node and start beaconing
     */
    activate() {
        this.isActive = true;
        this.lastBeacon = Date.now();
        console.log(`[${this.name}] Node activated on ${this.frequency}`);
        return this;
    }
    
    /**
     * Deactivate the node
     */
    deactivate() {
        this.isActive = false;
        console.log(`[${this.name}] Node deactivated`);
        return this;
    }
    
    /**
     * Create a beacon packet
     */
    createBeacon() {
        const beacon = {
            type: 'BEACON',
            sourceId: this.id,
            sourceName: this.name,
            sourceType: this.type,
            timestamp: Date.now(),
            position: { lat: this.lat, lon: this.lon, alt: this.alt },
            hopCount: this.hopCount,
            battery: this.battery != null ? this.battery : null,
            signalStrength: this.getSignalStrength(),
        };
        
        this.lastBeacon = Date.now();
        return this.encodePacket(beacon);
    }
    
    /**
     * Create a data packet with payload
     */
    createDataPacket(payload, destinationId = null) {
        const packet = {
            type: 'DATA',
            sourceId: this.id,
            sourceName: this.name,
            destinationId: destinationId, // null = broadcast
            timestamp: Date.now(),
            hopCount: this.hopCount,
            payload: payload,
            packetId: this.generatePacketId(),
        };
        
        return this.encodePacket(packet);
    }
    
    /**
     * Create a relay packet (forward from another node)
     */
    createRelayPacket(originalPacket) {
        const relay = {
            ...originalPacket,
            relayId: this.id,
            relayName: this.name,
            hopCount: originalPacket.hopCount + 1,
            relayTimestamp: Date.now(),
        };
        
        return this.encodePacket(relay);
    }
    
    /**
     * Generate unique packet ID
     */
    generatePacketId() {
        return `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    
    /**
     * Encode packet to LoRa frame format
     */
    encodePacket(packet) {
        const frame = {
            preamble: '0x34',  // LoRa preamble
            header: {
                version: 1,
                type: packet.type,
                sourceId: packet.sourceId,
                destinationId: packet.destinationId || 'FF:FF:FF:FF', // Broadcast
                hopCount: packet.hopCount || 0,
                maxHops: this.maxHops,
            },
            payload: packet,
            crc: this.calculateCRC(packet),
        };
        
        return frame;
    }
    
    /**
     * Decode received frame
     */
    decodeFrame(frame) {
        if (!frame || !frame.payload) {
            return null;
        }
        
        const packet = frame.payload;
        
        // Check if already received (dedup)
        if (this.receivedPackets.has(packet.packetId)) {
            return null;
        }
        
        // Check hop limit
        if (packet.hopCount >= this.maxHops) {
            console.log(`[${this.name}] Packet exceeded max hops, dropping`);
            return null;
        }
        
        // Store as received
        this.receivedPackets.add(packet.packetId);
        
        return packet;
    }
    
    /**
     * Process received packet
     */
    processPacket(frame) {
        const packet = this.decodeFrame(frame);
        if (!packet) return null;
        
        // If packet is for us or broadcast
        if (packet.destinationId === this.id || packet.destinationId === 'FF:FF:FF:FF') {
            if (this.onPacket) {
                this.onPacket(packet);
            }
            return packet;
        }
        
        // Relay packet if we're a relay node
        if (this.type === 'RELAY' && packet.hopCount < this.maxHops) {
            return this.createRelayPacket(packet);
        }
        
        return null;
    }
    
    /**
     * Calculate CRC for packet integrity
     */
    calculateCRC(data) {
        const str = JSON.stringify(data);
        let crc = 0xFFFF;
        for (let i = 0; i < str.length; i++) {
            crc ^= str.charCodeAt(i) << 8;
            for (let j = 0; j < 8; j++) {
                if (crc & 0x8000) {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc <<= 1;
                }
            }
        }
        return (crc & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
    }
    
    /**
     * Get estimated signal strength based on distance
     */
    getSignalStrength() {
        const config = LORA_CONFIG.frequencies[this.frequency];
        const sfConfig = LORA_CONFIG.spreadingFactors[this.spreadingFactor];
        
        // Simplified path loss model
        const pathLoss = 20 * Math.log10(config.band) + 30;
        const rssi = config.maxPower - pathLoss - (sfConfig.range * 2);
        
        return Math.max(-120, Math.min(-30, rssi));
    }
    
    /**
     * Calculate time on air for current settings
     */
    getTimeOnAir(payloadSize) {
        const sf = LORA_CONFIG.spreadingFactors[this.spreadingFactor];
        const bw = LORA_CONFIG.bandwidths[this.bandwidth];
        const cr = LORA_CONFIG.codingRates[this.codingRate];
        
        // Simplified time on air calculation
        const symbolTime = (Math.pow(2, parseInt(this.spreadingFactor.slice(2))) / bw) * 1000;
        const preambleTime = (8 + 4.25) * symbolTime;
        const payloadTime = (payloadSize * 8 * cr * symbolTime) / (bw / 1000);
        
        return preambleTime + payloadTime;
    }
}

/**
 * LoRa Mesh Network Class
 * Manages multiple nodes and routing
 */
class LoRaMesh {
    constructor(config = {}) {
        this.frequency = config.frequency || 'US915';
        this.networkId = config.networkId || 'LIFELINE-001';
        
        this.nodes = new Map();
        this.routingTable = new Map();
        this.packetLog = [];
        
        // Statistics
        this.stats = {
            totalPackets: 0,
            successfulDeliveries: 0,
            failedDeliveries: 0,
            averageHops: 0,
            averageLatency: 0,
        };
        
        // Beacon interval
        this.beaconInterval = config.beaconInterval || 5000; // 5 seconds
        this.beaconTimer = null;
    }
    
    /**
     * Add a node to the mesh
     */
    addNode(node) {
        if (this.nodes.has(node.id)) {
            console.log(`[Mesh] Node ${node.name} already exists`);
            return false;
        }
        
        this.nodes.set(node.id, node);
        this.routingTable.set(node.id, { nextHop: node.id, hops: 0, lastSeen: Date.now() });
        
        console.log(`[Mesh] Node ${node.name} (${node.id}) joined network`);
        
        // Notify other nodes
        this.broadcastNodeJoin(node);
        
        return true;
    }
    
    /**
     * Remove a node from the mesh
     */
    removeNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node) return false;
        
        node.deactivate();
        this.nodes.delete(nodeId);
        this.routingTable.delete(nodeId);
        
        console.log(`[Mesh] Node ${node.name} left network`);
        
        return true;
    }
    
    /**
     * Start mesh network
     */
    start() {
        console.log(`[Mesh] Starting LoRa mesh on ${this.frequency}`);
        
        // Activate all nodes
        this.nodes.forEach(node => node.activate());
        
        // Start beaconing
        this.startBeaconing();
        
        return this;
    }
    
    /**
     * Stop mesh network
     */
    stop() {
        console.log('[Mesh] Stopping LoRa mesh');
        
        if (this.beaconTimer) {
            clearInterval(this.beaconTimer);
            this.beaconTimer = null;
        }
        
        this.nodes.forEach(node => node.deactivate());
        
        return this;
    }
    
    /**
     * Start periodic beaconing
     */
    startBeaconing() {
        this.beaconTimer = setInterval(() => {
            this.nodes.forEach(node => {
                if (node.isActive) {
                    const beacon = node.createBeacon();
                    this.processBeacon(node, beacon);
                }
            });
        }, this.beaconInterval);
    }
    
    /**
     * Process received beacon
     */
    processBeacon(receivingNode, beacon) {
        const sourceId = beacon.payload.sourceId;
        
        // Update routing table
        this.routingTable.set(sourceId, {
            nextHop: receivingNode.id,
            hops: beacon.payload.hopCount,
            lastSeen: Date.now(),
            signalStrength: beacon.payload.signalStrength,
        });
        
        // Log packet
        this.packetLog.push({
            type: 'BEACON',
            source: sourceId,
            receiver: receivingNode.id,
            timestamp: Date.now(),
        });
        
        this.stats.totalPackets++;
    }
    
    /**
     * Send data packet from source to destination
     */
    sendPacket(sourceId, destinationId, payload) {
        const sourceNode = this.nodes.get(sourceId);
        if (!sourceNode) {
            console.log(`[Mesh] Source node ${sourceId} not found`);
            return false;
        }
        
        const packet = sourceNode.createDataPacket(payload, destinationId);
        
        console.log(`[Mesh] Sending packet from ${sourceNode.name} to ${destinationId || 'BROADCAST'}`);
        
        // Simulate packet propagation
        this.propagatePacket(sourceNode, packet);
        
        return true;
    }
    
    /**
     * Propagate packet through mesh
     */
    propagatePacket(senderNode, packet, visited = new Set()) {
        visited.add(senderNode.id);
        
        this.nodes.forEach(node => {
            if (node.id === senderNode.id) return;
            if (visited.has(node.id)) return;
            
            // Check if node is within range (simplified)
            const distance = this.calculateDistance(
                senderNode.lat, senderNode.lon,
                node.lat, node.lon
            );
            
            const config = LORA_CONFIG.frequencies[this.frequency];
            const sfConfig = LORA_CONFIG.spreadingFactors[node.spreadingFactor];
            
            if (distance <= sfConfig.range * 1000) { // Convert km to meters
                // Node is in range, send packet
                const relayPacket = node.processPacket(packet);
                
                if (relayPacket) {
                    this.stats.successfulDeliveries++;
                    
                    // Continue propagation
                    if (relayPacket.destinationId && relayPacket.destinationId !== node.id) {
                        setTimeout(() => {
                            this.propagatePacket(node, relayPacket, visited);
                        }, 100);
                    }
                }
            }
        });
    }
    
    /**
     * Broadcast node join notification
     */
    broadcastNodeJoin(node) {
        const notification = {
            type: 'NODE_JOIN',
            sourceId: node.id,
            sourceName: node.name,
            sourceType: node.type,
            timestamp: Date.now(),
        };
        
        this.nodes.forEach(otherNode => {
            if (otherNode.id !== node.id && otherNode.onNodeJoin) {
                otherNode.onNodeJoin(notification);
            }
        });
    }
    
    /**
     * Calculate distance between two coordinates (Haversine)
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in km
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
    
    toRad(deg) {
        return deg * (Math.PI / 180);
    }
    
    /**
     * Get network statistics
     */
    getStats() {
        return {
            ...this.stats,
            nodeCount: this.nodes.size,
            activeNodes: Array.from(this.nodes.values()).filter(n => n.isActive).length,
            routingTableSize: this.routingTable.size,
        };
    }
    
    /**
     * Get all active nodes
     */
    getActiveNodes() {
        return Array.from(this.nodes.values()).filter(n => n.isActive);
    }
    
    /**
     * Find path between two nodes
     */
    findPath(sourceId, destinationId) {
        if (sourceId === destinationId) {
            return [sourceId];
        }
        
        // Build adjacency graph from routing table (links are bidirectional)
        const adjacency = new Map();
        const addEdge = (a, b) => {
            if (a === b) return; // ignore self-loops
            if (!adjacency.has(a)) adjacency.set(a, []);
            if (!adjacency.has(b)) adjacency.set(b, []);
            adjacency.get(a).push(b);
            adjacency.get(b).push(a);
        };
        
        this.routingTable.forEach((route, nodeId) => {
            if (route && route.nextHop) {
                addEdge(nodeId, route.nextHop);
            }
        });
        
        // BFS from source to destination
        const visited = new Set([sourceId]);
        const queue = [[sourceId]];
        
        while (queue.length > 0) {
            const path = queue.shift();
            const current = path[path.length - 1];
            
            if (current === destinationId) {
                return path;
            }
            
            for (const neighbor of adjacency.get(current) || []) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push([...path, neighbor]);
                }
            }
        }
        
        return null; // No path found
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LoRaNode, LoRaMesh, LORA_CONFIG };
}

// Browser globals
if (typeof window !== 'undefined') {
    window.LoRaNode = LoRaNode;
    window.LoRaMesh = LoRaMesh;
    window.LORA_CONFIG = LORA_CONFIG;
}

console.log('[LoRa Mesh] Module loaded');
