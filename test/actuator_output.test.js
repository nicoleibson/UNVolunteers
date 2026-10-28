const test = require('node:test');
const assert = require('node:assert');
const { ActuatorOutput } = require('../radio/actuator_output.js');

test('ActuatorOutput: llama a execSync con Termux API en Node', () => {
    let llamadas = [];
    const actuator = new ActuatorOutput({
        _mockExec: (cmd) => { llamadas.push(cmd); }
    });
    
    actuator.triggerAlert('SEVERE', 'Alerta P-Wave');
    assert.strictEqual(llamadas.length, 2);
    assert.ok(llamadas[0].includes('termux-vibrate -d 2000'));
    assert.ok(llamadas[1].includes('termux-notification'));
    assert.ok(llamadas[1].includes('Alerta P-Wave'));
});

test('ActuatorOutput: escapa comillas dobles en el mensaje', () => {
    let llamadas = [];
    const actuator = new ActuatorOutput({
        _mockExec: (cmd) => { llamadas.push(cmd); }
    });
    
    actuator.triggerAlert('HIGH', 'Mensaje con "comillas" dobles');
    assert.ok(llamadas[1].includes('Mensaje con \\"comillas\\" dobles'));
});

test('ActuatorOutput: ignora disparos si esta deshabilitado', () => {
    let llamadas = [];
    const actuator = new ActuatorOutput({
        enabled: false,
        _mockExec: (cmd) => { llamadas.push(cmd); }
    });
    
    actuator.triggerAlert('SEVERE', 'Test');
    assert.strictEqual(llamadas.length, 0);
});

test('ActuatorOutput: reporta fallos de ejecucion al log sin lanzar error', () => {
    let logs = [];
    const actuator = new ActuatorOutput({
        onLog: (cat, msg) => logs.push(msg),
        _mockExec: (cmd) => { throw new Error('mock command failed'); }
    });
    
    actuator.triggerAlert('SEVERE', 'Test');
    assert.ok(logs.some(l => l.includes('Fallo termux-vibrate')));
    assert.ok(logs.some(l => l.includes('Fallo termux-notification')));
});
