'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RADIO = path.join(ROOT, 'radio');
const SIM = path.join(ROOT, 'simulation', 'simulation');

function requireRadio(name) {
    return require(path.join(RADIO, name));
}

function requireSim(name) {
    return require(path.join(SIM, name));
}

// Mulberry32: PRNG determinista para fuzzing reproducible
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, RADIO, SIM, requireRadio, requireSim, mulberry32, sleep };
