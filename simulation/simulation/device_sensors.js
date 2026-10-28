/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — device_sensors.js
 *  Proveedor de datos reales del dispositivo para producción.
 *  Sin dependencias: usa las APIs del navegador cuando existen
 *  (geolocalización, batería, sensores ambientales del Chromium
 *  Sensor API, orientación/movimiento y micrófono). Cada sensor es
 *  opcional: si no está disponible su valor queda en `null` y el
 *  flag correspondiente en `sources` en `false`. NO inventa datos.
 *  Expone `window.LifelineSensors`.
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const listeners = [];

    let gps = null;          // { lat, lon, alt, accuracy }
    let pressure = null;     // Pa
    let temperature = null;  // °C
    let light = null;        // lux
    let mic = null;          // dB
    let tilt = null;         // ° (0 = vertical)
    let battery = null;      // %
    // Orientación para la vectorización de rescate (UWB + IMU). Null-safe:
    // sin brújula/IMU reales permanecen null (cero datos inventados).
    let orientation = null;  // { alpha, beta, gamma } grados (DeviceOrientationEvent)
    let uwbDistance = null;  // metros (chip UWB vía bridge BLE/Serial)

    const sources = {
        gps: false,
        barometer: false,
        thermometer: false,
        light: false,
        mic: false,
        motion: false,
        battery: false,
        orientation: false,
        uwb: false,
    };

    let motionStarted = false;
    let mediaStream = null;
    let audioCtx = null;
    let analyser = null;
    let micTimer = null;

    function emit() {
        const snap = getSnapshot();
        listeners.slice().forEach((fn) => {
            try { fn(snap); } catch (e) { /* el listener no debe romper el proveedor */ }
        });
    }

    function subscribe(fn) {
        listeners.push(fn);
        fn(getSnapshot());
        return () => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        };
    }

    /** Conecta un sensor de la API de Sensores de Chromium (secure context). */
    function connectSensor(Ctor, onReading, mapReading) {
        try {
            if (typeof global[Ctor] !== 'function') return;
            const sensor = new global[Ctor]({ frequency: 2 });
            sensor.addEventListener('reading', () => {
                mapReading(sensor);
                emit();
            });
            sensor.addEventListener('error', () => {});
            sensor.start();
        } catch (e) { /* sin permiso o no soportado */ }
    }

    function computeTilt(beta, gamma) {
        if (beta === null || beta === undefined) return null;
        const g = gamma === null || gamma === undefined ? 0 : gamma;
        return Math.min(90, Math.sqrt(Math.pow(90 - beta, 2) + Math.pow(g, 2)));
    }

    function startMotion() {
        if (motionStarted) return;
        motionStarted = true;
        try {
            if (typeof global.DeviceMotionEvent !== 'undefined' &&
                typeof global.DeviceMotionEvent.requestPermission === 'function') {
                global.DeviceMotionEvent.requestPermission().then((res) => {
                    if (res === 'granted') {
                        global.addEventListener('devicemotion', onMotion);
                        sources.motion = true;
                        emit();
                    }
                }).catch(() => {});
            } else if (typeof global.DeviceOrientationEvent !== 'undefined') {
                const req = global.DeviceOrientationEvent.requestPermission;
                const enable = () => {
                    global.addEventListener('deviceorientation', onOrientation, true);
                    sources.motion = true;
                    emit();
                };
                if (typeof req === 'function') {
                    req().then((res) => { if (res === 'granted') enable(); }).catch(() => {});
                } else {
                    global.addEventListener('deviceorientation', onOrientation, true);
                    sources.motion = true;
                    emit();
                }
            }
        } catch (e) { /* sin sensor de movimiento */ }
    }

    function onMotion(evt) {
        const acc = evt.accelerationIncludingGravity;
        if (acc) {
            const vx = acc.x || 0, vy = acc.y || 0, vz = acc.z || 0;
            // Inclinación respecto a la vertical usando la gravedad
            const norm = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
            tilt = Math.round(Math.min(90, Math.acos(Math.min(1, Math.abs(vz) / norm)) * 180 / Math.PI));
        }
        emit();
    }

    function onOrientation(evt) {
        tilt = computeTilt(evt.beta, evt.gamma);
        // Captura de la orientación completa (azimut/pitch/roll) real.
        // alpha es null en algunos navegadores sin brújula → se conserva null.
        if (evt.alpha !== null && evt.alpha !== undefined) {
            orientation = { alpha: evt.alpha, beta: evt.beta, gamma: evt.gamma };
            sources.orientation = true;
        }
        emit();
    }

    function setupMicrophone(analyserNode) {
        const data = new Uint8Array(analyserNode.frequencyBinCount);
        function sample() {
            analyserNode.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = data.length ? sum / data.length : 0;
            // Mapeo aproximado: nivel RMS de la FFT → dB SPL (0..120)
            const db = Math.round(20 * Math.log10(1 + avg * 2.2));
            mic = Math.max(0, Math.min(120, db));
            emit();
        }
        sample();
        micTimer = setInterval(sample, 1000);
    }

    /** Activa el micrófono (requiere permiso del usuario). Promise<boolean>. */
    function enableMicrophone() {
        return new Promise((resolve) => {
            if (mic !== null) { resolve(true); return; }
            try {
                if (!global.navigator || !navigator.mediaDevices ||
                    typeof navigator.mediaDevices.getUserMedia !== 'function') {
                    resolve(false);
                    return;
                }
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then((stream) => {
                        mediaStream = stream;
                        audioCtx = new (global.AudioContext || global.webkitAudioContext)();
                        const src = audioCtx.createMediaStreamSource(stream);
                        analyser = audioCtx.createAnalyser();
                        analyser.fftSize = 256;
                        src.connect(analyser);
                        sources.mic = true;
                        setupMicrophone(analyser);
                        resolve(true);
                    })
                    .catch(() => resolve(false));
            } catch (e) {
                resolve(false);
            }
        });
    }

    function stopMicrophone() {
        if (micTimer) clearInterval(micTimer);
        micTimer = null;
        if (mediaStream) {
            mediaStream.getTracks().forEach((t) => t.stop());
            mediaStream = null;
        }
        if (audioCtx && typeof audioCtx.close === 'function') audioCtx.close();
        audioCtx = null;
        analyser = null;
        mic = null;
        sources.mic = false;
    }

    /** Arranca todos los sensores disponibles. No lanza nunca. */
    function start() {
        try {
            if (global.navigator && navigator.geolocation &&
                typeof navigator.geolocation.watchPosition === 'function') {
                navigator.geolocation.watchPosition(
                    (pos) => {
                        gps = {
                            lat: pos.coords.latitude,
                            lon: pos.coords.longitude,
                            alt: pos.coords.altitude,
                            accuracy: pos.coords.accuracy,
                        };
                        sources.gps = true;
                        emit();
                    },
                    () => { /* sin permiso o timeout: gps queda null */ },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
                );
            }
        } catch (e) { /* geolocalización no disponible */ }

        try {
            if (global.navigator && typeof navigator.getBattery === 'function') {
                navigator.getBattery().then((b) => {
                    battery = Math.round(b.level * 100);
                    sources.battery = true;
                    b.addEventListener('levelchange', () => {
                        battery = Math.round(b.level * 100);
                        emit();
                    });
                    emit();
                }).catch(() => {});
            }
        } catch (e) { /* sin API de batería */ }

        connectSensor('AmbientPressureSensor', null, (s) => {
            pressure = s.pressure !== null && s.pressure !== undefined
                ? Math.round(s.pressure * 1000) // kPa → Pa (Sensor API entrega kPa)
                : null;
            if (pressure !== null) sources.barometer = true;
        });
        connectSensor('AmbientTemperatureSensor', null, (s) => {
            temperature = s.temperature !== null && s.temperature !== undefined ? s.temperature : null;
            if (temperature !== null) sources.thermometer = true;
        });
        connectSensor('AmbientLightSensor', null, (s) => {
            light = s.illuminance !== null && s.illuminance !== undefined ? s.illuminance : null;
            if (light !== null) sources.light = true;
        });

        startMotion();
    }

    function stop() {
        stopMicrophone();
        // watchPosition no tiene stop por id aquí; el objeto se descarta con la página
    }

    function getSnapshot() {
        const now = Date.now();
        return {
            timestamp: now,
            gps,
            pressure,   // Pa
            temperature, // °C
            light,      // lux
            mic,        // dB
            tilt,       // °
            battery,    // %
            orientation, // { alpha, beta, gamma } — brújula + IMU reales
            uwbDistance, // metros — distancia UWB real (bridge BLE/Serial)
            sources: { ...sources },
            hasGPS: sources.gps,
            hasPressure: sources.barometer,
            hasLight: sources.light,
            hasMotion: sources.motion,
            hasMic: sources.mic,
            hasBattery: sources.battery,
            hasOrientation: sources.orientation,
            hasUwb: sources.uwb,
        };
    }

    // Alimenta la distancia UWB (ToF) desde un bridge BLE/Serial real.
    // Null-safe: un valor no numérico o fuera de rango se descarta (→ null).
    function setDistance(distance) {
        const d = typeof distance === 'number' && isFinite(distance) && distance > 0 ? distance : null;
        uwbDistance = d;
        sources.uwb = d !== null;
        emit();
    }

    const api = { start, stop, subscribe, getSnapshot, enableMicrophone, stopMicrophone, setDistance, onOrientation };
    if (typeof global.window !== 'undefined') {
        global.window.LifelineSensors = api;
    } else {
        global.LifelineSensors = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
