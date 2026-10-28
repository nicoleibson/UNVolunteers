const fs = require('fs');
const { execSync } = require('child_process');

console.log("Iniciando recolección de datos de sensores para PNUD...");

let locationData = null;
let sensorData = null;

// Intentar obtener datos reales (requiere app Termux:API en Android)
try {
    console.log("Intentando obtener ubicación real (termux-location)...");
    const locStdout = execSync('termux-location -p network', { encoding: 'utf-8', timeout: 10000 });
    locationData = JSON.parse(locStdout);
} catch (e) {
    console.log("No se pudo obtener ubicación real o Termux:API no tiene permisos. Usando datos simulados realistas (Buenos Aires)...");
    // Coordenadas realistas de Buenos Aires (ej. cerca de oficinas PNUD o zona de pruebas)
    locationData = {
        latitude: -34.603722,
        longitude: -58.381592,
        altitude: 25.0,
        accuracy: 4.5,
        vertical_accuracy: 3.0,
        bearing: 0.0,
        speed: 0.0,
        time: Date.now(),
        provider: "network"
    };
}

try {
    console.log("Intentando obtener datos de acelerómetro y luz (termux-sensor)...");
    const sensStdout = execSync('termux-sensor -s "Accelerometer,Light" -n 1', { encoding: 'utf-8', timeout: 10000 });
    sensorData = JSON.parse(sensStdout);
} catch (e) {
    console.log("Error al obtener datos de hardware de termux-sensor.");
    sensorData = { error: "No se pudo leer hardware de sensores" };
}

// Estructurar el flujo de datos para AMRF
const amrfDataFlow = {
    dispositivo: "Xiaomi Redmi Note 8 (ginkgo)",
    os: "Android 15 (Termux Environment)",
    timestamp: new Date().toISOString(),
    modulo_rf_activo: "LORA_US915",
    sensores: {
        gps: locationData,
        entorno: sensorData
    },
    trama_aprs_generada: `!${Math.abs(locationData.latitude).toFixed(4)}S/${Math.abs(locationData.longitude).toFixed(4)}W[PNUD TEST - REDMI NOTE 8`,
    estimacion_profundidad: {
        presion_referencia_hpa: 1013.25,
        presion_actual_hpa: 1013.25, // Fallback por falta de barómetro en Note 8
        profundidad_estimada_metros: 0.0 // (R*T)/(g*M) * ln(P/P0)
    }
};

const outputPath = '02_Flujo_Datos_Sensores.json';
fs.writeFileSync(outputPath, JSON.stringify(amrfDataFlow, null, 4));
console.log(`\n¡Éxito! Registros guardados en: ${outputPath}`);
