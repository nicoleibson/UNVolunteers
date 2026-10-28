/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — SDR Receiver Module v1.0
 *  Software Defined Radio Concepts for Disaster Response
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * SDR Configuration
 */
const SDR_CONFIG = {
    // Sample rates
    sampleRates: {
        LOW: 24000,
        MEDIUM: 48000,
        HIGH: 96000,
        VERY_HIGH: 192000,
        ULTRA: 250000,
    },
    
    // Frequency ranges
    frequencyRanges: {
        VHF_LOW: { start: 136e6, end: 174e6, name: 'VHF Low' },
        VHF_HIGH: { start: 174e6, end: 225e6, name: 'VHF High' },
        UHF: { start: 420e6, end: 470e6, name: 'UHF' },
        ISM_915: { start: 902e6, end: 928e6, name: 'ISM 915 MHz' },
    },
    
    // Demodulation modes
    demodModes: {
        AM: 'AM',   // Amplitude Modulation
        FM: 'FM',   // Frequency Modulation
        WFM: 'WFM', // Wide FM
        NFM: 'NFM', // Narrow FM
        SSB: 'SSB', // Single Sideband
        CW: 'CW',   // Continuous Wave
        DRM: 'DRM', // Digital Radio Mondiale
    },
    
    // Filter types
    filterTypes: {
        LOWPASS: 'lowpass',
        HIGHPASS: 'highpass',
        BANDPASS: 'bandpass',
        BANDSTOP: 'bandstop',
    },
};

/**
 * Complex Number Class
 * For DSP operations
 */
class Complex {
    constructor(real = 0, imag = 0) {
        this.real = real;
        this.imag = imag;
    }
    
    add(c) {
        return new Complex(this.real + c.real, this.imag + c.imag);
    }
    
    sub(c) {
        return new Complex(this.real - c.real, this.imag - c.imag);
    }
    
    mul(c) {
        return new Complex(
            this.real * c.real - this.imag * c.imag,
            this.real * c.imag + this.imag * c.real
        );
    }
    
    magnitude() {
        return Math.sqrt(this.real * this.real + this.imag * this.imag);
    }
    
    phase() {
        return Math.atan2(this.imag, this.real);
    }
    
    conjugate() {
        return new Complex(this.real, -this.imag);
    }
}

/**
 * DSP Helper Functions
 */
const DSP = {
    /**
     * Generate sine wave
     */
    sineWave(frequency, sampleRate, duration, phase = 0) {
        const samples = Math.floor(sampleRate * duration);
        const wave = new Float32Array(samples);
        
        for (let i = 0; i < samples; i++) {
            const t = i / sampleRate;
            wave[i] = Math.sin(2 * Math.PI * frequency * t + phase);
        }
        
        return wave;
    },
    
    /**
     * Generate cosine wave
     */
    cosineWave(frequency, sampleRate, duration, phase = 0) {
        const samples = Math.floor(sampleRate * duration);
        const wave = new Float32Array(samples);
        
        for (let i = 0; i < samples; i++) {
            const t = i / sampleRate;
            wave[i] = Math.cos(2 * Math.PI * frequency * t + phase);
        }
        
        return wave;
    },
    
    /**
     * FFT (Fast Fourier Transform)
     */
    fft(signal) {
        const N = signal.length;
        
        if (N === 1) return [new Complex(signal[0], 0)];
        
        if (N & (N - 1)) {
            throw new Error('FFT size must be power of 2');
        }
        
        // Split
        const even = new Float32Array(N / 2);
        const odd = new Float32Array(N / 2);
        
        for (let i = 0; i < N / 2; i++) {
            even[i] = signal[2 * i];
            odd[i] = signal[2 * i + 1];
        }
        
        // Recursive FFT
        const X_even = this.fft(even);
        const X_odd = this.fft(odd);
        
        const X = new Array(N);
        
        for (let k = 0; k < N / 2; k++) {
            const angle = -2 * Math.PI * k / N;
            const twiddle = new Complex(Math.cos(angle), Math.sin(angle));
            
            X[k] = X_even[k].add(twiddle.mul(X_odd[k]));
            X[k + N / 2] = X_even[k].sub(twiddle.mul(X_odd[k]));
        }
        
        return X;
    },
    
    /**
     * IFFT (Inverse FFT)
     */
    ifft(spectrum) {
        const N = spectrum.length;
        const out = new Array(N);
        const half = N / 2;
        
        for (let k = 0; k < N; k++) {
            // Término DC (real)
            let sum = spectrum[0] ? spectrum[0].real : 0;
            
            // Armónicos 1..N/2-1: 2·Re(X[n]·e^{j·2πnk/N})
            for (let n = 1; n < half; n++) {
                const angle = 2 * Math.PI * n * k / N;
                sum += 2 * (spectrum[n].real * Math.cos(angle) - spectrum[n].imag * Math.sin(angle));
            }
            
            // Bin de Nyquist (N/2) — real si la señal original lo es
            if (Number.isInteger(half) && spectrum[half]) {
                sum += spectrum[half].real * Math.cos(Math.PI * k);
            }
            
            out[k] = new Complex(sum / N, 0);
        }
        
        return out;
    },
    
    /**
     * Low-pass filter
     */
    lowPass(signal, cutoff, sampleRate) {
        const RC = 1 / (2 * Math.PI * cutoff);
        const dt = 1 / sampleRate;
        const alpha = dt / (RC + dt);
        
        const filtered = new Float32Array(signal.length);
        filtered[0] = signal[0];
        
        for (let i = 1; i < signal.length; i++) {
            filtered[i] = filtered[i - 1] + alpha * (signal[i] - filtered[i - 1]);
        }
        
        return filtered;
    },
    
    /**
     * High-pass filter
     */
    highPass(signal, cutoff, sampleRate) {
        const RC = 1 / (2 * Math.PI * cutoff);
        const dt = 1 / sampleRate;
        const alpha = RC / (RC + dt);
        
        const filtered = new Float32Array(signal.length);
        filtered[0] = signal[0];
        
        for (let i = 1; i < signal.length; i++) {
            filtered[i] = alpha * (filtered[i - 1] + signal[i] - signal[i - 1]);
        }
        
        return filtered;
    },
    
    /**
     * Band-pass filter
     */
    bandPass(signal, lowCutoff, highCutoff, sampleRate) {
        const highPassed = this.highPass(signal, lowCutoff, sampleRate);
        return this.lowPass(highPassed, highCutoff, sampleRate);
    },
    
    /**
     * FM demodulation
     */
    fmDemodulate(signal, sampleRate, deviation = 75000) {
        const demod = new Float32Array(signal.length - 1);
        
        for (let i = 0; i < signal.length - 1; i++) {
            // Calculate instantaneous frequency
            const phase1 = Math.atan2(signal[i], signal[i + 1]);
            const phase2 = Math.atan2(signal[i + 1], signal[i + 2] || 0);
            
            demod[i] = (phase2 - phase1) * sampleRate / (2 * Math.PI * deviation);
        }
        
        return demod;
    },
    
    /**
     * AM demodulation
     */
    amDemodulate(signal) {
        const demod = new Float32Array(signal.length);
        
        for (let i = 0; i < signal.length; i++) {
            demod[i] = Math.abs(signal[i]);
        }
        
        return this.lowPass(demod, 5000, 48000);
    },
    
    /**
     * Calculate power spectrum
     */
    powerSpectrum(signal) {
        const spectrum = this.fft(signal);
        return spectrum.map(c => c.magnitude() * c.magnitude());
    },
    
    /**
     * Calculate SNR (Signal-to-Noise Ratio)
     */
    calculateSNR(signal, noiseFloor) {
        const signalPower = signal.reduce((sum, s) => sum + s * s, 0) / signal.length;
        return 10 * Math.log10(signalPower / noiseFloor);
    },
};

/**
 * SDR Receiver Class
 * Simulates software defined radio receiver
 */
class SDRReceiver {
    constructor(config = {}) {
        this.frequency = config.frequency || 144.390e6; // APRS frequency
        this.sampleRate = config.sampleRate || SDR_CONFIG.sampleRates.HIGH;
        this.demodMode = config.demodMode || SDR_CONFIG.demodModes.FM;
        this.bandwidth = config.bandwidth || 12500; // Hz
        
        // State
        this.isReceiving = false;
        this.gain = config.gain || 40; // dB
        
        // Buffer
        this.buffer = [];
        this.bufferSize = config.bufferSize || 8192;
        
        // Callbacks
        this.onSignal = config.onSignal || null;
        this.onData = config.onData || null;
    }
    
    /**
     * Start receiving
     */
    start() {
        this.isReceiving = true;
        console.log(`[SDR] Receiving on ${(this.frequency / 1e6).toFixed(3)} MHz`);
        console.log(`[SDR] Sample rate: ${(this.sampleRate / 1e3).toFixed(1)} kHz`);
        console.log(`[SDR] Demod: ${this.demodMode}`);
        
        // Simulate receiving
        this.simulateReception();
        
        return this;
    }
    
    /**
     * Stop receiving
     */
    stop() {
        this.isReceiving = false;
        console.log('[SDR] Stopped receiving');
        return this;
    }
    
    /**
     * Simulate signal reception
     */
    simulateReception() {
        if (!this.isReceiving) return;
        
        // Generate noise floor
        const noise = this.generateNoise(this.bufferSize);
        
        // Check for signals
        const signal = this.detectSignal(noise);
        
        if (signal) {
            console.log(`[SDR] Signal detected: ${signal.strength.toFixed(1)} dB`);
            
            if (this.onSignal) {
                this.onSignal(signal);
            }
        }
        
        // Schedule next check
        setTimeout(() => this.simulateReception(), 100);
    }
    
    /**
     * Generate random noise
     */
    generateNoise(samples) {
        const noise = new Float32Array(samples);
        
        for (let i = 0; i < samples; i++) {
            noise[i] = (Math.random() * 2 - 1) * 0.01;
        }
        
        return noise;
    }
    
    /**
     * Detect signal in noise
     */
    detectSignal(noise) {
        // Calculate noise power
        const noisePower = noise.reduce((sum, n) => sum + n * n, 0) / noise.length;
        
        // Simulate random signal detection
        if (Math.random() < 0.1) { // 10% chance of signal
            return {
                frequency: this.frequency + (Math.random() - 0.5) * 1000,
                strength: -30 + Math.random() * 50, // -30 to +20 dB
                bandwidth: 12500 + Math.random() * 5000,
                type: 'unknown',
                timestamp: Date.now(),
            };
        }
        
        return null;
    }
    
    /**
     * Tune to new frequency
     */
    tune(frequency) {
        this.frequency = frequency;
        console.log(`[SDR] Tuned to ${(frequency / 1e6).toFixed(3)} MHz`);
        return this;
    }
    
    /**
     * Set demodulation mode
     */
    setDemodMode(mode) {
        if (!Object.values(SDR_CONFIG.demodModes).includes(mode)) {
            throw new Error(`Invalid demod mode: ${mode}`);
        }
        
        this.demodMode = mode;
        console.log(`[SDR] Demod mode: ${mode}`);
        return this;
    }
    
    /**
     * Set gain
     */
    setGain(gain) {
        this.gain = Math.max(0, Math.min(100, gain));
        console.log(`[SDR] Gain: ${this.gain} dB`);
        return this;
    }
    
    /**
     * Get spectrum data
     */
    getSpectrum() {
        const signal = this.generateNoise(this.bufferSize);
        return DSP.powerSpectrum(signal);
    }
}

/**
 * SDR Scanner Class
 * Scans multiple frequencies for signals
 */
class SDRScanner {
    constructor(config = {}) {
        this.frequencies = config.frequencies || [];
        this.sampleRate = config.sampleRate || SDR_CONFIG.sampleRates.HIGH;
        this.dwellTime = config.dwellTime || 100; // ms per frequency
        
        this.isScanning = false;
        this.currentIndex = 0;
        
        // Results
        this.signals = new Map();
        
        // Callbacks
        this.onSignalFound = config.onSignalFound || null;
        this.onScanComplete = config.onScanComplete || null;
    }
    
    /**
     * Start scanning
     */
    start() {
        this.isScanning = true;
        console.log(`[Scanner] Starting scan of ${this.frequencies.length} frequencies`);
        this.scanNext();
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
     * Scan next frequency
     */
    scanNext() {
        if (!this.isScanning) return;
        
        const freq = this.frequencies[this.currentIndex];
        
        // Simulate detection
        if (Math.random() < 0.05) { // 5% chance
            const signal = {
                frequency: freq,
                strength: -30 + Math.random() * 50,
                timestamp: Date.now(),
            };
            
            this.signals.set(freq, signal);
            
            if (this.onSignalFound) {
                this.onSignalFound(signal);
            }
        }
        
        this.currentIndex = (this.currentIndex + 1) % this.frequencies.length;
        
        // Continue scanning
        setTimeout(() => this.scanNext(), this.dwellTime);
    }
    
    /**
     * Add frequency to scan list
     */
    addFrequency(frequency) {
        if (!this.frequencies.includes(frequency)) {
            this.frequencies.push(frequency);
        }
        return this;
    }
    
    /**
     * Remove frequency from scan list
     */
    removeFrequency(frequency) {
        this.frequencies = this.frequencies.filter(f => f !== frequency);
        return this;
    }
    
    /**
     * Get found signals
     */
    getSignals() {
        return Array.from(this.signals.values());
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SDRReceiver, SDRScanner, SDR_CONFIG, DSP, Complex };
}

// Browser globals
if (typeof window !== 'undefined') {
    window.SDRReceiver = SDRReceiver;
    window.SDRScanner = SDRScanner;
    window.SDR_CONFIG = SDR_CONFIG;
    window.DSP = DSP;
    window.Complex = Complex;
}

console.log('[SDR Receiver] Module loaded');
