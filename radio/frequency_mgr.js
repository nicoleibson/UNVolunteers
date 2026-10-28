/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Frequency Manager Module v1.0
 *  Dynamic Frequency Allocation for Disaster Response
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * Frequency Manager Configuration
 */
const FREQ_MGR_CONFIG = {
    // Licensed emergency frequencies (MHz)
    emergencyFrequencies: {
        '406.025': { name: 'ELT', type: 'DISTRESS', power: 'LOW', range: 'SATELLITE' },
        '406.028': { name: 'EPIRB', type: 'DISTRESS', power: 'LOW', range: 'SATELLITE' },
        '406.040': { name: 'PLB', type: 'DISTRESS', power: 'LOW', range: 'SATELLITE' },
        '121.500': { name: 'VHF-HELICOPTER', type: 'AVIATION', power: 'MEDIUM', range: '50km' },
        '123.100': { name: 'SAR-AUX', type: 'AVIATION', power: 'MEDIUM', range: '50km' },
    },
    
    // ISM bands (license-free)
    ismBands: {
        '433.05-434.79': { name: 'ISM-EU-433', region: 'EUROPE', power: 10, range: 2 },
        '868.0-868.6': { name: 'ISM-EU-868', region: 'EUROPE', power: 14, range: 3 },
        '902-928': { name: 'ISM-US-915', region: 'AMERICAS', power: 20, range: 5 },
    },
    
    // Amateur radio bands (license required)
    amateurBands: {
        '144.0-148.0': { name: '2m-VHF', license: 'Technician+', power: 1500, range: 50 },
        '144.390': { name: 'APRS-NA', license: 'Technician+', power: 50, range: 30 },
        '144.800': { name: 'APRS-EU', license: 'Technician+', power: 50, range: 30 },
        '420-450': { name: '70cm-UHF', license: 'Technician+', power: 500, range: 30 },
    },
    
    // Priority levels
    priorityLevels: {
        CRITICAL: 1,    // Life-threatening emergencies
        HIGH: 2,        // Active rescue operations
        MEDIUM: 3,      // Coordination
        LOW: 4,         // Routine communication
    },
};

/**
 * Frequency Allocation Class
 * Manages dynamic frequency allocation
 */
class FrequencyManager {
    constructor(config = {}) {
        this.region = config.region || 'AMERICAS';
        this.allocations = new Map();
        this.activeFrequencies = new Map();
        
        // Statistics
        this.stats = {
            totalAllocations: 0,
            activeChannels: 0,
            collisions: 0,
        };
        
        // Callbacks
        this.onAllocation = config.onAllocation || null;
        this.onDeallocation = config.onDeallocation || null;
    }
    
    /**
     * Request frequency allocation
     */
    requestFrequency(request) {
        const {
            requesterId,
            type = 'DATA',
            priority = FREQ_MGR_CONFIG.priorityLevels.MEDIUM,
            bandwidth = 12500,
            duration = 3600, // 1 hour default
        } = request;
        
        console.log(`[FreqMgr] Allocation request from ${requesterId} (Priority: ${priority})`);
        
        // Find available frequency
        const frequency = this.findAvailableFrequency(type, priority, bandwidth);
        
        if (!frequency) {
            console.log('[FreqMgr] No frequencies available');
            return null;
        }
        
        // Create allocation
        const allocation = {
            id: this.generateAllocationId(),
            frequency: frequency,
            requesterId: requesterId,
            type: type,
            priority: priority,
            bandwidth: bandwidth,
            allocatedAt: Date.now(),
            expiresAt: Date.now() + (duration * 1000),
            isActive: true,
        };
        
        // Store allocation
        this.allocations.set(allocation.id, allocation);
        this.activeFrequencies.set(frequency, allocation.id);
        
        this.stats.totalAllocations++;
        this.stats.activeChannels++;
        
        console.log(`[FreqMgr] Allocated ${(frequency / 1e6).toFixed(3)} MHz to ${requesterId}`);
        
        if (this.onAllocation) {
            this.onAllocation(allocation);
        }
        
        return allocation;
    }
    
    /**
     * Release frequency allocation
     */
    releaseFrequency(allocationId) {
        const allocation = this.allocations.get(allocationId);
        
        if (!allocation) {
            console.log(`[FreqMgr] Allocation ${allocationId} not found`);
            return false;
        }
        
        allocation.isActive = false;
        this.activeFrequencies.delete(allocation.frequency);
        this.stats.activeChannels--;
        
        console.log(`[FreqMgr] Released ${(allocation.frequency / 1e6).toFixed(3)} MHz from ${allocation.requesterId}`);
        
        if (this.onDeallocation) {
            this.onDeallocation(allocation);
        }
        
        return true;
    }
    
    /**
     * Find available frequency based on requirements
     */
    findAvailableFrequency(type, priority, bandwidth) {
        // Get available frequencies for region
        const available = this.getAvailableFrequencies(type);
        
        // Sort by priority compatibility
        const sorted = available.sort((a, b) => {
            const aPriority = a.priority || FREQ_MGR_CONFIG.priorityLevels.LOW;
            const bPriority = b.priority || FREQ_MGR_CONFIG.priorityLevels.LOW;
            return aPriority - bPriority;
        });
        
        // Find first available
        for (const freq of sorted) {
            if (!this.activeFrequencies.has(freq.frequency)) {
                return freq.frequency;
            }
        }
        
        return null;
    }
    
    /**
     * Get available frequencies for type
     */
    getAvailableFrequencies(type) {
        const frequencies = [];
        
        switch (type) {
            case 'EMERGENCY':
                // Use emergency frequencies
                Object.keys(FREQ_MGR_CONFIG.emergencyFrequencies).forEach(freq => {
                    frequencies.push({
                        frequency: parseFloat(freq) * 1e6,
                        priority: FREQ_MGR_CONFIG.priorityLevels.CRITICAL,
                    });
                });
                break;
                
            case 'DATA':
            case 'VOICE':
                // Use ISM bands (license-free)
                if (this.region === 'EUROPE') {
                    frequencies.push(
                        { frequency: 433.05e6, priority: 3 },
                        { frequency: 868.0e6, priority: 3 }
                    );
                } else {
                    frequencies.push(
                        { frequency: 915e6, priority: 3 }
                    );
                }
                
                // Add amateur bands if available
                frequencies.push(
                    { frequency: 144.390e6, priority: 2 },
                    { frequency: 144.800e6, priority: 2 }
                );
                break;
                
            case 'TRACKING':
                // Use APRS frequencies
                frequencies.push(
                    { frequency: 144.390e6, priority: 2 },
                    { frequency: 144.800e6, priority: 2 }
                );
                break;
                
            default:
                // Use ISM bands
                frequencies.push({ frequency: 915e6, priority: 3 });
        }
        
        return frequencies;
    }
    
    /**
     * Generate unique allocation ID
     */
    generateAllocationId() {
        return `ALLOC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    }
    
    /**
     * Check for expired allocations
     */
    checkExpirations() {
        const now = Date.now();
        
        this.allocations.forEach((allocation, id) => {
            if (allocation.isActive && allocation.expiresAt < now) {
                console.log(`[FreqMgr] Allocation expired: ${id}`);
                this.releaseFrequency(id);
            }
        });
    }
    
    /**
     * Get allocation by ID
     */
    getAllocation(id) {
        return this.allocations.get(id);
    }
    
    /**
     * Get all active allocations
     */
    getActiveAllocations() {
        return Array.from(this.allocations.values()).filter(a => a.isActive);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeChannels: this.activeFrequencies.size,
        };
    }
    
    /**
     * Force release all allocations (emergency override)
     */
    emergencyOverride() {
        console.log('[FreqMgr] EMERGENCY OVERRIDE - Releasing all allocations');
        
        this.allocations.forEach((allocation, id) => {
            if (allocation.priority > FREQ_MGR_CONFIG.priorityLevels.CRITICAL) {
                this.releaseFrequency(id);
            }
        });
    }
}

/**
 * Frequency Scanner Class
 * Scans and monitors frequency activity
 */
class FrequencyScanner {
    constructor(config = {}) {
        this.frequencies = config.frequencies || [];
        this.threshold = config.threshold || -80; // dB
        this.scanInterval = config.scanInterval || 100; // ms
        
        this.isScanning = false;
        this.detectedSignals = new Map();
        
        // Callbacks
        this.onSignalDetected = config.onSignalDetected || null;
    }
    
    /**
     * Start scanning
     */
    start() {
        this.isScanning = true;
        console.log(`[Scanner] Scanning ${this.frequencies.length} frequencies`);
        this.scanLoop();
        return this;
    }
    
    /**
     * Stop scanning
     */
    stop() {
        this.isScanning = false;
        console.log('[Scanner] Stopped');
        return this;
    }
    
    /**
     * Scan loop
     */
    scanLoop() {
        if (!this.isScanning) return;
        
        this.frequencies.forEach(freq => {
            // Simulate detection
            if (Math.random() < 0.05) {
                const signal = {
                    frequency: freq,
                    strength: this.threshold + Math.random() * 40,
                    timestamp: Date.now(),
                };
                
                this.detectedSignals.set(freq, signal);
                
                if (this.onSignalDetected) {
                    this.onSignalDetected(signal);
                }
            }
        });
        
        setTimeout(() => this.scanLoop(), this.scanInterval);
    }
    
    /**
     * Add frequency to scan
     */
    addFrequency(frequency) {
        if (!this.frequencies.includes(frequency)) {
            this.frequencies.push(frequency);
        }
        return this;
    }
    
    /**
     * Get detected signals
     */
    getDetectedSignals() {
        return Array.from(this.detectedSignals.values());
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FrequencyManager, FrequencyScanner, FREQ_MGR_CONFIG };
}

// Browser globals
if (typeof window !== 'undefined') {
    window.FrequencyManager = FrequencyManager;
    window.FrequencyScanner = FrequencyScanner;
    window.FREQ_MGR_CONFIG = FREQ_MGR_CONFIG;
}

console.log('[Frequency Manager] Module loaded');
