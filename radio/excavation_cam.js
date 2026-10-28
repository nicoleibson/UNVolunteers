/**
 * ═══════════════════════════════════════════════════════════════
 *  PROJECT LIFELINE CORE — Excavation Cam (punto de excavación)
 *  Correla el vector de rescate UWB+IMU con el gradiente de calor de
 *  la cámara térmica para sugerir el punto EXACTO de excavación:
 *  brújula (azimut) + inclinación (profundidad) + desvío térmico.
 *
 *  Cero dependencias; navegador (window.ExcavationCam) y Node
 *  (module.exports). Regla honesta: sin vector de rescate real la
 *  sugerencia es NO_VECTOR; sin firma térmica el desvío térmico es 0
 *  (se conserva la dirección del vector, jamás se inventa un punto).
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

(function (global) {
    const IS_NODE = typeof module !== 'undefined' && module.exports;

    // Campo de visión del MLX90640 (rejilla 32×24) en grados.
    const DEFAULT_HFOV_DEG = 55;
    const DEFAULT_VFOV_DEG = 35;

    function normalizeDeg(deg) {
        return ((deg % 360) + 360) % 360;
    }

    /**
     * Corrige la dirección del vector de rescate por el desvío del punto
     * más cálido (firma humana) dentro del campo de visión térmico.
     * @param {object|null} rescue  — salida del vector (computeRescueArrow):
     *        { valid, vec, azimuth, plunge, h, depth }
     * @param {object|null} thermal — frame de thermal_cam: { width, height, temps, humans }
     * @param {{hFovDeg?:number,vFovDeg?:number}} [opts]
     * @returns {object} estado de la sugerencia
     */
    function suggestExcavationPoint(rescue, thermal, opts = {}) {
        const hFov = opts.hFovDeg !== undefined ? opts.hFovDeg : DEFAULT_HFOV_DEG;
        const vFov = opts.vFovDeg !== undefined ? opts.vFovDeg : DEFAULT_VFOV_DEG;

        if (!rescue || !rescue.valid || !rescue.vec) {
            return { status: 'NO_VECTOR', reason: 'sin vector de rescate', suggestion: null };
        }

        const azimuthBase = rescue.azimuth != null ? normalizeDeg(rescue.azimuth) : null;
        const distBase = rescue.h || Math.hypot(rescue.vec.x, rescue.vec.y) || 0;

        // Inclinación CON SIGNO: negativa = apuntando hacia abajo (bajo el suelo),
        // coherente con el vector de rescate donde z<0 = víctima bajo tierra.
        const pitchBase = (rescue.depth != null && rescue.depth < 0)
            ? -Math.abs(rescue.plunge || 0)
            : Math.abs(rescue.plunge || 0);

        // Desvío térmico: pixel más cálido respecto al centro del campo.
        let azimutOffset = 0;
        let pitchOffset = 0;
        let hotPixel = null;
        if (thermal && thermal.temps && thermal.humans &&
            thermal.humans.hotspots && thermal.humans.hotspots.length) {
            hotPixel = thermal.humans.hotspots[0];
            const w = thermal.width;
            const h = thermal.height;
            const hHalf = (w - 1) / 2 || 1;
            const vHalf = (h - 1) / 2 || 1;
            const nx = (hotPixel.x - hHalf) / hHalf; // -1 (izq) .. +1 (der)
            const ny = (hotPixel.y - vHalf) / vHalf; // -1 (arriba) .. +1 (abajo)
            azimutOffset = nx * (hFov / 2);
            // Un hotspot por debajo del centro (ny>0) = excavar más abajo (pitch más negativo).
            pitchOffset = -ny * (vFov / 2);
        }

        const azimuthFinal = azimuthBase != null ? normalizeDeg(azimuthBase + azimutOffset) : null;
        const pitchFinal = pitchBase + pitchOffset;
        const phi = pitchFinal * Math.PI / 180;
        const depth = distBase * Math.sin(phi);
        const distHoriz = Math.max(0, distBase * Math.cos(phi));

        return {
            status: 'SUGGESTED',
            thermalUsed: hotPixel != null,
            suggestion: {
                azimuthBase,
                azimuthOffset: azimutOffset,
                azimuthFinal,
                pitchBase,
                pitchOffset,
                pitchFinal,
                distanceBase: distBase,
                distanceHorizontal: distHoriz,
                depth,
            },
            thermal: hotPixel ? { x: hotPixel.x, y: hotPixel.y, temp: hotPixel.temp } : null,
        };
    }

    const api = { suggestExcavationPoint, normalizeDeg, DEFAULT_HFOV_DEG, DEFAULT_VFOV_DEG };
    if (IS_NODE) {
        module.exports = api;
    } else {
        global.ExcavationCam = { suggestExcavationPoint, normalizeDeg, DEFAULT_HFOV_DEG, DEFAULT_VFOV_DEG };
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
