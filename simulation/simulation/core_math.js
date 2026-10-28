/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — core_math.js
 *  Funciones puras de física/triaje/estado compartidas por los
 *  simuladores AMRF v1.2 (app.js) y v2.0 (app_integrated.js).
 *  Sin dependencias de DOM: testeable en Node.js.
 * ═══════════════════════════════════════════════════════════════
 */

(function (global) {
'use strict';

// Constantes físicas (idénticas a los simuladores)
const R_GAS = 8.314;        // J/(mol·K)
const G_GRAVITY = 9.80665;  // m/s²
const M_MOLAR = 0.02897;    // kg/mol (aire)
const T_KELVIN = 300.0;     // K
const P_START_PA = 101325;  // Pa (nivel de referencia)

const IPU_THRESHOLD = 0.40;

// ── Clasificación de rol del dispositivo (SCOUT / VÍCTIMA) ──────────
const ROLE_VICTIM_DEPTH_M = 1.0;      // >1 m bajo referencia = enterrado
const ROLE_TRAPPED_TILT_DEG = 45;     // inclinación anómala sostenida
const ROLE_TRAPPED_STILL_SECS = 120;  // sin interacción durante 2 min
const ROLE_DARK_LUX = 5;              // oscuridad de escombro
const ROLE_VICTIM_BPM_MAX = 120;      // bpm de estrés severo
const ROLE_VICTIM_BPM_MIN = 50;

/**
 * Clasifica el rol del usuario del dispositivo a partir de los sensores.
 *  - VICTIM: los sensores determinan que la persona está atrapada entre
 *    escombros (enterrada + inmóvil, SOS activo, inclinación/entorno de
 *    escombro, vitales de estrés).
 *  - SCOUT: transednte o rescatista libre en superficie (móvil, sin
 *    señales de atrapamiento).
 *  - UNKNOWN: sin sensores suficientes para decidir.
 * @param {object} vars { depthM, tilt, light, bpm, activeSOS, mobilitySecs,
 *        hasPressure, hasMotion, hasLight, hasVitals }
 * @returns {{role: 'SCOUT'|'VICTIM'|'UNKNOWN', reason: string,
 *            label: string, confidence: number}}
 */
function classifyRole(vars = {}) {
    const depthM = vars.depthM !== undefined ? vars.depthM : null;
    const tilt = vars.tilt !== undefined ? vars.tilt : null;
    const light = vars.light !== undefined ? vars.light : null;
    const bpm = vars.bpm !== undefined ? vars.bpm : null;
    const activeSOS = !!vars.activeSOS;
    const mobilitySecs = vars.mobilitySecs !== undefined ? vars.mobilitySecs : null;

    const hasPressure = vars.hasPressure !== undefined ? vars.hasPressure : depthM !== null;
    const hasMotion = vars.hasMotion !== undefined ? vars.hasMotion : tilt !== null;
    const hasLight = vars.hasLight !== undefined ? vars.hasLight : light !== null;
    const hasVitals = vars.hasVitals !== undefined ? vars.hasVitals : bpm !== null;

    if (activeSOS) {
        return { role: 'VICTIM', reason: 'SOS_ACTIVE', label: 'Víctima atrapada', confidence: 1.0 };
    }

    const still = mobilitySecs !== null && mobilitySecs > ROLE_TRAPPED_STILL_SECS;
    const buried = hasPressure && depthM > ROLE_VICTIM_DEPTH_M;
    const tilted = hasMotion && tilt > ROLE_TRAPPED_TILT_DEG;
    const dark = hasLight && light < ROLE_DARK_LUX;
    const distress = hasVitals && (bpm > ROLE_VICTIM_BPM_MAX || bpm < ROLE_VICTIM_BPM_MIN);

    // Atrapada: enterrada + inmóvil
    if (buried && still) return { role: 'VICTIM', reason: 'BURIED_STILL', label: 'Víctima atrapada', confidence: 0.95 };
    // Atrapada: enterrada + inclinación de escombro + inmóvil
    if (hasPressure && depthM > 0.3 && tilted && still) return { role: 'VICTIM', reason: 'IMMOBILIZED_TILT', label: 'Víctima atrapada', confidence: 0.85 };
    // Atrapada: enterrada + oscuridad + inmóvil
    if (hasPressure && depthM > 0.3 && dark && still) return { role: 'VICTIM', reason: 'TRAPPED_DARK_STILL', label: 'Víctima atrapada', confidence: 0.8 };
    // Atrapada: enterrada + vitales de estrés + inmóvil
    if (hasPressure && depthM > 0.3 && distress && still) return { role: 'VICTIM', reason: 'VITALS_DISTRESS', label: 'Víctima atrapada', confidence: 0.75 };
    // Subsuperficie pero móvil (p.ej. rescatista en sótano): no concluyente
    if (buried && !still) return { role: 'UNKNOWN', reason: 'SUBSURFACE_MOBILE', label: 'Sin determinar', confidence: 0.5 };

    // Scout: en superficie y móvil
    const shallow = hasPressure && depthM <= ROLE_VICTIM_DEPTH_M;
    if (shallow && !still && mobilitySecs !== null && mobilitySecs <= 900) {
        return { role: 'SCOUT', reason: 'SURFACE_MOBILE', label: 'Rescatista / Transcúnte', confidence: 0.9 };
    }
    if (shallow) return { role: 'SCOUT', reason: 'SURFACE', label: 'Rescatista / Transcúnte', confidence: 0.75 };
    // Móvil y en entorno luminoso sin presión disponible (sin barómetro)
    if (hasLight && light >= ROLE_DARK_LUX && mobilitySecs !== null && mobilitySecs <= ROLE_TRAPPED_STILL_SECS) {
        return { role: 'SCOUT', reason: 'MOBILE_BRIGHT', label: 'Rescatista / Transcúnte', confidence: 0.6 };
    }

    return { role: 'UNKNOWN', reason: 'INSUFFICIENT_SENSORS', label: 'Sin determinar', confidence: 0 };
}

/**
 * Diferencia de altura/altitud estimada a partir de la presión atrapada.
 * Positivo = por debajo del nivel de referencia (bajo tierra / mayor presión).
 * @param {number} pTrapped Presión atrapada en Pa
 * @returns {number} metros
 */
function calcDeltaH(pTrapped) {
    return ((R_GAS * T_KELVIN) / (G_GRAVITY * M_MOLAR)) * Math.log(pTrapped / P_START_PA);
}

/**
 * Altimetría diferencial: diferencia de altura estimada entre una presión
 * de referencia (el Scout en superficie) y una presión atrapada (el nodo
 * de la víctima antes del sismo). Positivo = la víctima está a mayor
 * presión (más abajo) que la referencia; negativo = por encima.
 * @param {number} pTrappedPa Presión atrapada (Pa)
 * @param {number} pRefPa Presión de referencia del Scout (Pa)
 * @returns {number} metros (positivo = bajo la referencia)
 */
function calcDeltaHRef(pTrappedPa, pRefPa) {
    if (pTrappedPa == null || pRefPa == null || pRefPa <= 0 || pTrappedPa <= 0) return null;
    return ((R_GAS * T_KELVIN) / (G_GRAVITY * M_MOLAR)) * Math.log(pTrappedPa / pRefPa);
}

/**
 * Estima el piso/nivel a partir de la altimetría diferencial (metros).
 * Usa una altura de piso de referencia (3 m). Mapea sótanos (negativo),
 * planta baja y pisos superiores colapsados para guiar la excavación.
 * @param {number|null} deltaM Metros diferenciales (positivo = bajo tierra)
 * @param {{floorHeightM?:number}} [opts]
 * @returns {{floor:string, label:string, depthM:number|null,
 *            basement:boolean, aboveGround:boolean}}
 */
function estimateFloorLevel(deltaM, opts = {}) {
    const h = opts.floorHeightM != null ? opts.floorHeightM : 3;
    if (deltaM == null || deltaM === Infinity || deltaM === -Infinity) {
        return { floor: '—', label: 'desconocido', depthM: null, basement: false, aboveGround: false };
    }
    if (deltaM <= -h / 2) {
        // Por encima del nivel de referencia (pisos superiores colapsados)
        const f = Math.max(1, Math.round(-deltaM / h));
        return { floor: `P${f}`, label: `Piso ${f} (sobre el nivel)`, depthM: deltaM, basement: false, aboveGround: true };
    }
    if (deltaM > h / 2) {
        // Bajo tierra (sótanos)
        const f = Math.max(1, Math.round(deltaM / h));
        return { floor: `-${f}`, label: `Sótano -${f}`, depthM: deltaM, basement: true, aboveGround: false };
    }
    return { floor: 'P0', label: 'Planta baja (0)', depthM: deltaM, basement: false, aboveGround: false };
}

/**
 * Índice de Presencia del Usuario (IPU 0..1).
 * @param {{watchOnBody: boolean, activeSOS?: boolean, bpm?: number,
 *         lastTouchTime?: number, now?: number}} vars
 * @returns {number} IPU entre 0 y 1
 */
function calcIPU(vars) {
    const { watchOnBody, activeSOS = false, bpm = 60, lastTouchTime = 0, now = Date.now() } = vars;
    const elapsed = (now - lastTouchTime) / 1000;
    const iTouch = Math.max(0, 1 - elapsed / 60);
    let mSig = 0.1;
    if (activeSOS) mSig += 0.5;

    let ipu;
    if (watchOnBody) {
        // Sin lectura real de pulso (bpm === null) no se adjudica estrés:
        // `null > 100` y `null < 50` serían falsos/verdaderos erróneos.
        if (bpm != null && (bpm > 100 || bpm < 50)) mSig += 0.2;
        ipu = Math.min(1.0, Math.max(0.0, 0.25 * iTouch + 0.25 * mSig + 0.50 * 1.0));
    } else {
        ipu = Math.min(1.0, Math.max(0.0, 0.60 + 0.2 * iTouch + 0.2 * mSig));
    }
    return ipu;
}

/**
 * Clasificación de triaje por constantes vitales.
 * @param {number} bpmV
 * @param {number} spo2V
 * @param {boolean} sosFlag
 * @param {number} ipuV
 * @param {{watchOnBody?: boolean, ipuThreshold?: number}} [opts]
 * @returns {{code: number, label: string, cls: string}}
 */
function getTriageForVitals(bpmV, spo2V, sosFlag, ipuV, opts = {}) {
    const watchOnBody = opts.watchOnBody !== undefined ? opts.watchOnBody : true;
    const ipuThreshold = opts.ipuThreshold !== undefined ? opts.ipuThreshold : IPU_THRESHOLD;

    if (ipuV < ipuThreshold) return { code: 3, label: 'BLACK (UNRESPONSIVE)', cls: 'triage-black' };
    if (sosFlag) return { code: 2, label: 'RED (IMMEDIATE)', cls: 'triage-red' };

    if (watchOnBody) {
        if (bpmV === 0) return { code: 3, label: 'BLACK (UNRESPONSIVE)', cls: 'triage-black' };
        // Vitales desconocidas (sin fuente real): triaje incierto, nunca RED.
        // `bpmV < 50` o `spo2V < 90` con null serían verdaderos erróneos.
        if (bpmV == null || spo2V == null) {
            return { code: 1, label: 'YELLOW (UNKNOWN VITALS)', cls: 'triage-yellow' };
        }
        if (bpmV > 120 || bpmV < 50 || spo2V < 90) return { code: 2, label: 'RED (IMMEDIATE)', cls: 'triage-red' };
        if (bpmV > 100 || bpmV < 60 || spo2V < 95) return { code: 1, label: 'YELLOW (DELAYED)', cls: 'triage-yellow' };
    } else {
        return { code: 1, label: 'YELLOW (UNKNOWN VITALS)', cls: 'triage-yellow' };
    }

    return { code: 0, label: 'GREEN (STABLE)', cls: 'triage-green' };
}

/**
 * Resolución del estado de la máquina de estados AMRF.
 * @param {{ipu: number, battery: number, systemState: string,
 *          ipuThreshold?: number}} vars
 * @returns {'DORMANT'|'ORPHAN'|'VIGILANCE'|'ECO'|'SURVIVAL'}
 */
function resolveState(vars) {
    const { ipu, battery, systemState, ipuThreshold = IPU_THRESHOLD } = vars;
    if (systemState === 'DORMANT') return 'DORMANT';
    if (ipu < ipuThreshold) return 'ORPHAN';
    // Batería desconocida (sin fuente real): se asume operación normal y no
    // se degrada a ECO/SURVIVAL por un `null` (null > 30 sería falso).
    if (battery == null || battery > 30) return 'VIGILANCE';
    if (battery > 15) return 'ECO';
    return 'SURVIVAL';
}

/**
 * Filtro de Kalman 1D para estabilizar el Azimut (Alpha).
 * Mitiga la distorsión magnética estructural (hierro retorcido en Zona
 * Cero) fusionando Giroscopio (predicción/dead-reckoning) y Magnetómetro
 * (corrección). Null-safe: sin fuente real devuelve null (cero datos
 * inventados).
 *
 * Ciclo continuo de dos pasos:
 *  - PREDICCIÓN: estado futuro según la velocidad angular del giroscopio.
 *  - ACTUALIZACIÓN: corrección con la lectura de la brújula ponderada por
 *    la Ganancia de Kalman (K). Si el ruido de medición R es alto (jaula
 *    de Faraday), K → 0 y el filtro confía en el giroscopio; si R es bajo,
 *    K → 1 y confía en la brújula.
 */
class AzimuthKalmanFilter {
    /**
     * @param {{q?:number, r?:number, p0?:number}} [opts]
     *  - q: ruido del proceso (deriva del giroscopio), por defecto 0.1.
     *  - r: ruido de medición (anomalías del magnetómetro), por defecto 15.0.
     *  - p0: covarianza de error inicial, por defecto 1.0.
     */
    constructor(opts = {}) {
        this.q = opts.q != null ? opts.q : 0.1;
        this.r = opts.r != null ? opts.r : 15.0;
        this.x = null;      // estado estimado (ángulo, grados)
        this.p = opts.p0 != null ? opts.p0 : 1.0; // covarianza de error
    }

    /**
     * @param {number|null} measurement - lectura del magnetómetro z_k (grados)
     * @param {number|null} gyroRate     - velocidad angular del giroscopio (grados/s)
     * @param {number} dt                - delta de tiempo en segundos
     * @returns {number|null} ángulo estabilizado (0-360) o null si no hay fuente real
     */
    filter(measurement, gyroRate, dt) {
        // Null-safety: sin lectura ni estado previo no hay dato real.
        if (measurement === null && this.x === null) return null;

        // Inicialización en la primera lectura válida.
        if (this.x === null) {
            this.x = measurement;
            return this.x;
        }

        // 1. PREDICCIÓN (dead-reckoning con el giroscopio si está disponible).
        let predictedX = this.x;
        if (gyroRate !== null) predictedX += gyroRate * dt;
        const predictedP = this.p + this.q;

        // Si perdemos temporalmente la brújula, devolvemos la predicción del
        // giroscopio (dead-reckoning), asumiendo trayectoria continua.
        if (measurement === null) {
            this.x = predictedX;
            this.p = predictedP;
            return normalizeDeg(this.x);
        }

        // 2. ACTUALIZACIÓN (corrección con el magnetómetro).
        // Manejo del cruce del eje norte (360->0) para evitar saltos bruscos.
        let diff = measurement - predictedX;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        const k = predictedP / (predictedP + this.r); // Ganancia de Kalman
        this.x = predictedX + k * diff;
        this.p = (1 - k) * predictedP;

        return normalizeDeg(this.x);
    }
}

/** Normaliza un ángulo a [0, 360). */
function normalizeDeg(deg) {
    return ((deg % 360) + 360) % 360;
}

/**
 * Calcula el vector de rescate 3D integrando UWB y el Filtro de Kalman.
 * Transforma coordenadas esféricas (distancia, azimut estabilizado, pitch)
 * en un vector cartesiano relativo a la pantalla del rescatista.
 *
 *  - x: componente Este/Oeste de la flecha táctica.
 *  - y: componente Norte/Sur de la flecha táctica.
 *  - z: profundidad (negativo = la víctima está por debajo del suelo).
 *
 * Null-safe (cero datos inventados):
 *  - Si `distance` (lectura UWB) es null, la flecha se apaga → null.
 *  - Si el azimut no se puede estabilizar o `pitch` falta, → null.
 *
 * @param {number|null} distance     - distancia absoluta por UWB (metros)
 * @param {number|null} rawAzimuth   - azimut del magnetómetro (grados)
 * @param {number|null} gyroRate     - velocidad angular Z del giroscopio (grados/s)
 * @param {number|null} pitch        - inclinación del dispositivo (grados)
 * @param {number} dt                - delta de tiempo en segundos
 * @param {AzimuthKalmanFilter} [filter] - filtro a usar (inyectable para tests)
 * @returns {{x:number, y:number, z:number}|null} vector cartesiano o null
 */
function calculateRescueVector(distance, rawAzimuth, gyroRate, pitch, dt, filter) {
    if (distance === null) return null;
    const f = filter || azimuthFilter;
    const stableAzimuth = f.filter(rawAzimuth, gyroRate, dt);
    if (stableAzimuth === null || pitch === null) return null;

    const theta = stableAzimuth * (Math.PI / 180);
    const phi = pitch * (Math.PI / 180);

    return {
        x: distance * Math.cos(theta) * Math.cos(phi),
        y: distance * Math.sin(theta) * Math.cos(phi),
        z: distance * Math.sin(phi),
    };
}

// Instancia global del filtro para el motor.
const azimuthFilter = new AzimuthKalmanFilter();

const coreMath = {
    R_GAS, G_GRAVITY, M_MOLAR, T_KELVIN, P_START_PA, IPU_THRESHOLD,
    ROLE_VICTIM_DEPTH_M, ROLE_TRAPPED_TILT_DEG, ROLE_TRAPPED_STILL_SECS,
    ROLE_DARK_LUX, ROLE_VICTIM_BPM_MAX, ROLE_VICTIM_BPM_MIN,
    calcDeltaH, calcDeltaHRef, estimateFloorLevel, calcIPU, getTriageForVitals, resolveState, classifyRole,
    AzimuthKalmanFilter, calculateRescueVector, normalizeDeg,
};

// Node.js (CommonJS) — require() devuelve coreMath.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = coreMath;
    return;
}

// Navegador: se expone SOLO coreMath. El IIFE evita filtrar al scope
// global R_GAS, IPU_THRESHOLD, ROLE_*, calcDeltaH, … que colisionaban
// con las declaraciones propias de los simuladores (app.js y
// app_integrated.js declaran su propio IPU_THRESHOLD → SyntaxError en
// navegador si este archivo los redeclara globalmente).
global.coreMath = coreMath;
})(typeof globalThis !== 'undefined' ? globalThis : this);
