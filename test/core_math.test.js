'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireSim } = require('./helpers.js');
const {
    calcDeltaH, calcDeltaHRef, estimateFloorLevel,
    calcIPU, getTriageForVitals, resolveState, classifyRole,
    R_GAS, G_GRAVITY, M_MOLAR, T_KELVIN, P_START_PA, IPU_THRESHOLD,
    ROLE_VICTIM_DEPTH_M, ROLE_TRAPPED_STILL_SECS,
    AzimuthKalmanFilter, calculateRescueVector, normalizeDeg,
} = requireSim('core_math.js');

test('coreMath: calcDeltaHRef escala con la diferencia Scout-víctima', () => {
    // mayor presión atrapada → víctima más abajo que la referencia
    const d = calcDeltaHRef(1020 * 100, 1013.25 * 100);
    assert.ok(d > 0, 'bajo la referencia debe ser positivo');
    assert.equal(calcDeltaHRef(1013.25 * 100, 1013.25 * 100), 0);
    // presión menor → por encima de la referencia (negativo)
    assert.ok(calcDeltaHRef(950 * 100, 1013.25 * 100) < 0);
});

test('coreMath: calcDeltaHRef con entradas inválidas → null (honesto)', () => {
    assert.equal(calcDeltaHRef(null, 101325), null);
    assert.equal(calcDeltaHRef(101325, null), null);
    assert.equal(calcDeltaHRef(0, 101325), null);
    assert.equal(calcDeltaHRef(101325, 0), null);
});

test('coreMath: estimateFloorLevel mapea sótanos, planta baja y pisos superiores', () => {
    assert.equal(estimateFloorLevel(0).floor, 'P0');          // planta baja
    assert.equal(estimateFloorLevel(0).label, 'Planta baja (0)');
    assert.equal(estimateFloorLevel(-8).floor, 'P3');         // ~3 pisos arriba (colapso)
    assert.equal(estimateFloorLevel(-8).aboveGround, true);
    assert.equal(estimateFloorLevel(9).floor, '-3');          // sótano -3 (bajo tierra)
    assert.equal(estimateFloorLevel(9).basement, true);
    assert.equal(estimateFloorLevel(1.5).floor, 'P0');        // dentro de ±1.5 m → P0
});

test('coreMath: estimateFloorLevel con null → desconocido (honesto)', () => {
    const r = estimateFloorLevel(null);
    assert.equal(r.floor, '—');
    assert.equal(r.depthM, null);
});

test('coreMath: constantes físicas documentadas', () => {
    assert.equal(R_GAS, 8.314);
    assert.equal(G_GRAVITY, 9.80665);
    assert.equal(M_MOLAR, 0.02897);
    assert.equal(T_KELVIN, 300.0);
    assert.equal(P_START_PA, 101325);
    assert.equal(IPU_THRESHOLD, 0.40);
});

test('coreMath: calcDeltaH en puntos de referencia', () => {
    assert.ok(Math.abs(calcDeltaH(101325)) < 1e-6, '1013.25 hPa → 0.00 m');
    const d1020 = calcDeltaH(1020 * 100);
    assert.ok(d1020 > 55 && d1020 < 61, `1020 hPa → ≈ +58 m (obtenido ${d1020.toFixed(2)})`);
    const d950 = calcDeltaH(950 * 100);
    assert.ok(d950 > -600 && d950 < -530, `950 hPa → ≈ −566 m (obtenido ${d950.toFixed(2)})`);
    const d1024 = calcDeltaH(1024 * 100);
    assert.ok(d1024 > 85 && d1024 < 100, `1024 hPa → ≈ +92 m (obtenido ${d1024.toFixed(2)})`);
    // Signo: mayor presión → profundidad positiva (bajo tierra)
    assert.ok(calcDeltaH(1020 * 100) > 0);
    assert.ok(calcDeltaH(950 * 100) < 0);
});

test('coreMath: calcIPU mínimo con wearable = 0.525, sin wearable = 0.620', () => {
    const now = Date.now();
    const withWear = calcIPU({ watchOnBody: true, activeSOS: false, bpm: 60, lastTouchTime: 0, now: now - 3600e3 });
    const noWear = calcIPU({ watchOnBody: false, activeSOS: false, bpm: 60, lastTouchTime: 0, now: now - 3600e3 });
    assert.ok(Math.abs(withWear - 0.525) < 1e-9, `con wearable → ${withWear}`);
    assert.ok(Math.abs(noWear - 0.620) < 1e-9, `sin wearable → ${noWear}`);
    // IPU nunca supera 1 ni baja de 0
    for (let i = 0; i < 50; i++) {
        const ipu = calcIPU({ watchOnBody: true, activeSOS: true, bpm: 140, lastTouchTime: Date.now(), now: Date.now() });
        assert.ok(ipu >= 0 && ipu <= 1);
    }
});

test('coreMath: calcIPU crece con SOS, tacto reciente y bpm anómalo', () => {
    const now = Date.now();
    const base = calcIPU({ watchOnBody: true, activeSOS: false, bpm: 60, lastTouchTime: now - 60e3, now });
    const sos = calcIPU({ watchOnBody: true, activeSOS: true, bpm: 60, lastTouchTime: now - 60e3, now });
    const touch = calcIPU({ watchOnBody: true, activeSOS: false, bpm: 60, lastTouchTime: now, now });
    const bpmAbn = calcIPU({ watchOnBody: true, activeSOS: false, bpm: 140, lastTouchTime: now - 60e3, now });
    assert.ok(sos > base);
    assert.ok(touch > base);
    assert.ok(bpmAbn > base);
});

test('coreMath: getTriageForVitals cubre todas las ramas', () => {
    const T = (bpm, spo2, sos, ipu, opts) => getTriageForVitals(bpm, spo2, sos, ipu, opts);
    assert.equal(T(80, 98, false, 0.8).code, 0, 'vitals normales → GREEN');
    assert.equal(T(0, 100, false, 0.3).code, 3, 'IPU bajo → BLACK');
    assert.equal(T(0, 100, true, 0.8).code, 2, 'SOS → RED');
    assert.equal(T(125, 98, false, 0.8).code, 2, 'bpm alto → RED');
    assert.equal(T(40, 98, false, 0.8).code, 2, 'bpm bajo → RED');
    assert.equal(T(80, 85, false, 0.8).code, 2, 'spo2 bajo → RED');
    assert.equal(T(105, 98, false, 0.8).code, 1, 'bpm moderado → YELLOW');
    assert.equal(T(70, 93, false, 0.8).code, 1, 'spo2 moderado → YELLOW');
    assert.equal(T(80, 98, false, 0.8, { watchOnBody: false }).code, 1, 'sin wearable → YELLOW UNKNOWN');
    assert.equal(T(0, 0, false, 0.5, { watchOnBody: true }).code, 3, 'bpm 0 con wearable → BLACK');
});

test('coreMath: resolveState de la máquina de estados', () => {
    assert.equal(resolveState({ ipu: 0.8, battery: 80, systemState: 'DORMANT' }), 'DORMANT');
    assert.equal(resolveState({ ipu: 0.2, battery: 80, systemState: 'VIGILANCE' }), 'ORPHAN');
    assert.equal(resolveState({ ipu: 0.8, battery: 45, systemState: 'VIGILANCE' }), 'VIGILANCE');
    assert.equal(resolveState({ ipu: 0.8, battery: 20, systemState: 'VIGILANCE' }), 'ECO');
    assert.equal(resolveState({ ipu: 0.8, battery: 10, systemState: 'VIGILANCE' }), 'SURVIVAL');
});

test('coreMath: sin dependencias DOM (pureza)', () => {
    // Invocar con un mini-document que lanzaría si hubiera DOM
    const res = calcDeltaH(102000) + calcIPU({ watchOnBody: true }) + getTriageForVitals(80, 98, false, 0.8).code;
    assert.equal(typeof res, 'number');
});

test('coreMath: classifyRole — SOS activo ⇒ VÍCTIMA siempre', () => {
    const r = classifyRole({ activeSOS: true });
    assert.equal(r.role, 'VICTIM');
    assert.equal(r.confidence, 1.0);
});

test('coreMath: classifyRole — enterrada + inmóvil ⇒ VÍCTIMA', () => {
    // depthM desde calcDeltaH(102400) ≈ −10.8 m por presión atrapada alta
    const depthM = calcDeltaH(102400);
    const r = classifyRole({ depthM, mobilitySecs: ROLE_TRAPPED_STILL_SECS + 60 });
    assert.equal(r.role, 'VICTIM');
    assert.equal(r.reason, 'BURIED_STILL');
    assert.ok(r.confidence >= 0.9);
});

test('coreMath: classifyRole — inclinación/entorno de escombro ⇒ VÍCTIMA', () => {
    const r = classifyRole({ depthM: 2.0, tilt: 60, mobilitySecs: 600, hasLight: true, light: 1 });
    assert.equal(r.role, 'VICTIM', 'tilt extremo + enterrada');
    const r2 = classifyRole({ depthM: 2.0, tilt: 10, mobilitySecs: 600, hasLight: true, light: 0.5 });
    assert.equal(r2.role, 'VICTIM', 'oscuridad + enterrada + inmóvil');
    const r3 = classifyRole({ depthM: 2.0, tilt: 10, mobilitySecs: 600, bpm: 140, hasVitals: true });
    assert.equal(r3.role, 'VICTIM', 'bpm de estrés + enterrada + inmóvil');
});

test('coreMath: classifyRole — superficial y móvil ⇒ SCOUT', () => {
    const r = classifyRole({ depthM: calcDeltaH(101325), mobilitySecs: 10 });
    assert.equal(r.role, 'SCOUT');
    assert.equal(r.reason, 'SURFACE_MOBILE');
    const r2 = classifyRole({ depthM: 0.2, mobilitySecs: 800 });
    assert.equal(r2.role, 'SCOUT', 'superficie aún sin movilidad reciente');
});

test('coreMath: classifyRole — sin sensores ⇒ UNKNOWN; enterrado pero móvil ⇒ UNKNOWN', () => {
    assert.equal(classifyRole({}).role, 'UNKNOWN');
    assert.equal(classifyRole({ depthM: calcDeltaH(102400), mobilitySecs: 10 }).role, 'UNKNOWN',
        'subsuperficie móvil (rescatista) no concluye');
    assert.equal(classifyRole({ mobilitySecs: 10 }).role, 'UNKNOWN', 'solo movilidad sin presión no decide');
});

// ── Null-safety (regla de producción: sin lectura real → null) ──────

test('coreMath: calcIPU con bpm null no adjudica estrés ficticio', () => {
    const now = Date.now();
    const base = calcIPU({ watchOnBody: true, activeSOS: false, bpm: 60, lastTouchTime: 0, now });
    const sinPulso = calcIPU({ watchOnBody: true, activeSOS: false, bpm: null, lastTouchTime: 0, now });
    assert.equal(sinPulso, base, 'bpm null == bpm normal: sin bono de estrés');
    assert.equal(sinPulso, 0.525, 'IPU mínima con wearable');
});

test('coreMath: getTriageForVitals con vitales null → YELLOW (UNKNOWN VITALS), nunca RED', () => {
    const t = getTriageForVitals(null, null, false, 0.8, { watchOnBody: true });
    assert.equal(t.code, 1, 'vitales desconocidas → YELLOW');
    assert.match(t.label, /UNKNOWN VITALS/);
    // null en solo una de las dos también es desconocida
    assert.equal(getTriageForVitals(null, 98, false, 0.8).code, 1);
    assert.equal(getTriageForVitals(80, null, false, 0.8).code, 1);
});

test('coreMath: resolveState con battery null asume operación normal (no ECO/SURVIVAL)', () => {
    assert.equal(resolveState({ ipu: 0.8, battery: null, systemState: 'VIGILANCE' }), 'VIGILANCE',
        'batería desconocida no degrada el estado');
    // La degradación por batería real sigue intacta
    assert.equal(resolveState({ ipu: 0.8, battery: 20, systemState: 'VIGILANCE' }), 'ECO');
    assert.equal(resolveState({ ipu: 0.8, battery: 10, systemState: 'VIGILANCE' }), 'SURVIVAL');
});

test('coreMath: AzimuthKalmanFilter inicia con la primera lectura (sin inventar)', () => {
    const f = new AzimuthKalmanFilter();
    assert.equal(f.filter(null, null, 0), null, 'sin lectura ni estado → null');
    assert.equal(f.filter(90, null, 0), 90, 'primera lectura válida inicializa el estado');
    assert.equal(f.filter(null, null, 0), 90, 'sin brújula, sin giroscopio → conserva el estado');
});

test('coreMath: AzimuthKalmanFilter confía en el giroscopio cuando falta la brújula (dead-reckoning)', () => {
    const f = new AzimuthKalmanFilter({ r: 1.0 });
    f.filter(0, null, 0);
    const out = f.filter(null, 5, 1.0); // pierde brújula, gira 5°/s durante 1 s
    assert.equal(out, 5, 'predice con la velocidad angular del giroscopio');
});

test('coreMath: AzimuthKalmanFilter con R alto (jaula de Faraday) atenúa el salto magnético', () => {
    // R alto → K pequeño → la brújula apenas corrige el salto anómalo.
    const f = new AzimuthKalmanFilter({ r: 100, q: 0.1 });
    f.filter(0, null, 0);
    // Anomalía: el Norte "salta" 40° en 1 ms (medición espuria).
    const out = f.filter(40, 0, 0);
    assert.ok(out < 15, `el salto se atenúa (K→0): got ${out}°`);
    assert.ok(out > 0, 'sigue apuntando en la dirección razonable');
});

test('coreMath: AzimuthKalmanFilter con R bajo confía en la brújula', () => {
    const f = new AzimuthKalmanFilter({ r: 0.1, q: 0.1 });
    f.filter(0, null, 0);
    // K→1: con lecturas repetidas de la brújula converge hacia el dato real.
    let out = 0;
    for (let i = 0; i < 20; i++) out = f.filter(180, 0, 0);
    assert.ok(Math.abs(out - 180) < 0.5, `K→1: converge a la brújula (got ${out})`);
});

test('coreMath: AzimuthKalmanFilter normaliza el cruce del norte 360->0', () => {
    const f = new AzimuthKalmanFilter({ r: 0.1, q: 0.1 });
    f.filter(355, null, 0);
    // La brújula cruza de 355° a 2° (a través del norte): no debe saltar a -353.
    const out = f.filter(2, 0, 0);
    assert.ok(out >= 0 && out < 360, `ángulo normalizado 0-360 (got ${out})`);
    assert.ok(out > 350 || out < 10, 'no hay salto de ±353 grados');
});

test('coreMath: calculateRescueVector null-safe (cero datos inventados)', () => {
    assert.equal(calculateRescueVector(null, 0, 0, 0, 0.1), null, 'sin distancia UWB → null (flecha apagada)');
    assert.equal(calculateRescueVector(4, null, null, 0, 0.1), null, 'sin azimut estabilizable → null');
    assert.equal(calculateRescueVector(4, 0, 0, null, 0.1), null, 'sin pitch → null');
});

test('coreMath: calculateRescueVector transforma esféricas a cartesianas', () => {
    // Azimut 90° (Este) + pitch 0 → vector al Este de magnitud d.
    const east = calculateRescueVector(4, 90, null, 0, 0, new AzimuthKalmanFilter());
    assert.ok(Math.abs(east.x) < 1e-9, `x≈0 en el Este (got ${east.x})`);
    assert.ok(Math.abs(east.y - 4) < 1e-9, `y=4 hacia el Este (got ${east.y})`);
    // Azimut 0° (Norte) + pitch -30° (apuntando bajo tierra) → z negativo.
    const down = calculateRescueVector(4, 0, null, -30, 0, new AzimuthKalmanFilter());
    assert.ok(Math.abs(down.x - (4 * Math.cos(0) * Math.cos(-Math.PI / 6))) < 1e-9);
    assert.ok(Math.abs(down.z - (4 * Math.sin(-Math.PI / 6))) < 1e-9, 'z negativo = víctima bajo el suelo');
    assert.ok(down.z < 0, 'vector apunta hacia abajo');
});
