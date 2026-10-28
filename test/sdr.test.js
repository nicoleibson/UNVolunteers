'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireRadio, sleep } = require('./helpers.js');
const { SDRReceiver, SDRScanner, SDR_CONFIG, DSP, Complex } = requireRadio('sdr_receiver.js');

function sine4096(freq = 1200, rate = 48000) {
    const s = new Float32Array(4096);
    for (let i = 0; i < s.length; i++) s[i] = Math.sin(2 * Math.PI * freq * i / rate);
    return s;
}

test('DSP: sineWave/cosineWave generan N muestras', () => {
    const s = DSP.sineWave(1200, 48000, 0.1);
    assert.equal(s.length, 4800);
    const c = DSP.cosineWave(1200, 48000, 0.05);
    assert.equal(c.length, 2400);
    assert.ok(Math.abs(s[0]) < 1e-9, 'sin(0)=0');
    assert.ok(Math.abs(c[0] - 1) < 1e-9, 'cos(0)=1');
});

test('DSP: fft en potencias de 2 y rechaza tamaños no potencia de 2', () => {
    for (const N of [2, 4, 8, 16, 256, 1024, 4096]) {
        const out = DSP.fft(new Float32Array(N));
        assert.equal(out.length, N);
    }
    assert.throws(() => DSP.fft(new Float32Array(4800)), /power of 2/);
    assert.throws(() => DSP.fft(new Float32Array(4095)), /power of 2/);
    assert.equal(DSP.fft(new Float32Array(1)).length, 1, 'N=1 es potencia de 2 válida');
});

test('DSP: ifft(fft(x)) reconstruye la señal (círculo cerrado)', () => {
    const x = sine4096(1200);
    const spec = DSP.fft(x);
    const back = DSP.ifft(spec);
    for (const i of [0, 10, 100, 1000, 4095]) {
        assert.ok(Math.abs(back[i].real - x[i]) < 1e-6, `muestra ${i}`);
    }
});

test('DSP: powerSpectrum devuelve bins no negativos', () => {
    const bins = DSP.powerSpectrum(sine4096());
    assert.equal(bins.length, 4096);
    for (const b of bins) assert.ok(b >= 0);
    const peak = Math.max(...bins);
    assert.ok(peak > 0);
});

test('DSP: calculateSNR requiere noiseFloor (NaN sin él) y crece con la señal', () => {
    const weak = DSP.sineWave(1200, 48000, 0.1);
    const strong = DSP.sineWave(1200, 48000, 0.1).map(v => v * 10);
    assert.ok(Number.isNaN(DSP.calculateSNR(weak)), 'sin noiseFloor → NaN');
    const snrW = DSP.calculateSNR(weak, 0.001);
    const snrS = DSP.calculateSNR(strong, 0.001);
    assert.ok(Number.isFinite(snrW) && Number.isFinite(snrS));
    assert.ok(snrS - snrW > 18, `señal x10 → +20 dB esperado (${snrW.toFixed(1)}→${snrS.toFixed(1)})`);
});

test('DSP: filtros lowPass/highPass/bandPass preservan longitud', () => {
    const s = sine4096(1200);
    const lp = DSP.lowPass(s, 2000, 48000);
    const hp = DSP.highPass(s, 2000, 48000);
    const bp = DSP.bandPass(s, 500, 3000, 48000);
    assert.equal(lp.length, s.length);
    assert.equal(hp.length, s.length);
    assert.equal(bp.length, s.length);
});

test('DSP: lowPass mantiene constante; highPass elimina DC', () => {
    const constSignal = new Float32Array(4096).fill(1.0);
    const lp = DSP.lowPass(constSignal, 1000, 48000);
    const hp = DSP.highPass(constSignal, 1000, 48000);
    assert.ok(Math.abs(lp[4095] - 1.0) < 0.01, 'lowPass de constante ≈ constante');
    assert.ok(Math.abs(hp[4095]) < 0.01, 'highPass de constante ≈ 0 (DC removido)');
});

test('DSP: demoduladores FM y AM devuelven longitudes esperadas', () => {
    const s = sine4096(1200);
    const fm = DSP.fmDemodulate(s, 48000);
    assert.equal(fm.length, s.length - 1);
    const am = DSP.amDemodulate(s);
    assert.equal(am.length, s.length);
    assert.ok(am.every(v => v >= -1e-6), 'AM demod no negativo');
});

test('SDR: constructor, tune, demod y gain con validación', () => {
    const sdr = new SDRReceiver({ frequency: 144.390e6, sampleRate: 48000 });
    assert.equal(sdr.frequency, 144.390e6);
    sdr.tune(145.800e6);
    assert.equal(sdr.frequency, 145.800e6);
    sdr.setDemodMode(SDR_CONFIG.demodModes.AM);
    assert.equal(sdr.demodMode, 'AM');
    assert.throws(() => sdr.setDemodMode('XYZ'), /Invalid demod mode/);
    sdr.setGain(55);
    assert.equal(sdr.gain, 55);
    sdr.setGain(500);
    assert.equal(sdr.gain, 100, 'gain clampa a 100');
    sdr.setGain(-5);
    assert.equal(sdr.gain, 0, 'gain clampa a 0');
});

test('SDR: getSpectrum devuelve bufferSize bins (8192)', () => {
    const sdr = new SDRReceiver({ bufferSize: 8192 });
    const spec = sdr.getSpectrum();
    assert.equal(spec.length, 8192);
});

test('SDR: ciclo start/recepción/stop sin errores', async () => {
    const sdr = new SDRReceiver({ frequency: 144.390e6, onSignal: () => {} });
    const ret = sdr.start();
    assert.equal(ret, sdr, 'start() encadenable');
    assert.equal(sdr.isReceiving, true);
    await sleep(150);
    sdr.stop();
    assert.equal(sdr.isReceiving, false);
});

test('SDRScanner: add/remove frecuencias y ciclo start/stop', async () => {
    const sc = new SDRScanner({ frequencies: [144.390e6], dwellTime: 40 });
    sc.addFrequency(144.800e6);
    sc.addFrequency(144.800e6);
    assert.equal(sc.frequencies.length, 2);
    sc.removeFrequency(144.390e6);
    assert.deepEqual(sc.frequencies, [144.800e6]);
    sc.start();
    assert.equal(sc.isScanning, true);
    await sleep(150);
    sc.stop();
    assert.equal(sc.isScanning, false);
    assert.ok(Array.isArray(sc.getSignals()));
});

test('Complex: operaciones aritméticas básicas', () => {
    const a = new Complex(3, 4);
    const b = new Complex(1, -2);
    assert.ok(Math.abs(a.magnitude() - 5) < 1e-9, '|3+4i|=5');
    assert.ok(Math.abs(a.add(b).real - 4) < 1e-9);
    assert.ok(Math.abs(a.add(b).imag - 2) < 1e-9);
    assert.ok(Math.abs(a.sub(b).real - 2) < 1e-9);
    const m = a.mul(b);
    assert.ok(Math.abs(m.real - 11) < 1e-9, `(3+4i)(1-2i)=11-2i, real=${m.real}`);
    assert.ok(Math.abs(m.imag + 2) < 1e-9, `imag=${m.imag}`);
    assert.ok(Math.abs(a.conjugate().imag + 4) < 1e-9);
    assert.ok(Math.abs(a.phase() - Math.atan2(4, 3)) < 1e-9);
});

test('SDR: configuración de sample rates, modos y rangos', () => {
    assert.equal(SDR_CONFIG.sampleRates.HIGH, 96000);
    assert.ok(SDR_CONFIG.demodModes.FM === 'FM');
    assert.ok(SDR_CONFIG.frequencyRanges.VHF_LOW.start === 136e6);
});
