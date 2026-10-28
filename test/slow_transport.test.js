const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireSim } = require('./helpers.js');
const { RelayAdapter, SlowTransportQueue } = requireSim('relay_adapter.js');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

test('SlowTransportQueue: encola, comprime (mock) y envia con timeout', async () => {
    let sends = [];
    const modem = {
        send: async (payload) => {
            sends.push(payload);
            return true; // Simula envio exitoso (ACK)
        }
    };
    
    const queue = new SlowTransportQueue(modem, { maxRetries: 3, timeoutMs: 100 });
    const frame = { type: 'INTERCOM', payload: 'test' };
    
    queue.enqueue(frame);
    await delay(50);
    
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0], JSON.stringify(frame));
    assert.strictEqual(queue.queue.length, 0, 'Desencolado tras ACK simulado');
});

test('SlowTransportQueue: reintentos tras fallo o timeout', async () => {
    let sends = [];
    const modem = {
        send: async (payload) => {
            sends.push(payload);
            return false; // Simula fallo, provoca reintento
        }
    };
    
    const queue = new SlowTransportQueue(modem, { maxRetries: 2, timeoutMs: 10 });
    // Hack: aceleramos el backoff que por defecto es 1000ms para que el test no demore
    queue._processQueue = async function() {
        if (this.isSending || this.queue.length === 0) return;
        this.isSending = true;
        const msg = this.queue[0];
        try {
            const success = await this._sendWithTimeout(msg.payload);
            if (success) {
                this.queue.shift();
            } else {
                this._handleFailure(msg);
            }
        } catch (e) {
            this._handleFailure(msg);
        }
        this.isSending = false;
        if (this.queue.length > 0) {
            setTimeout(() => this._processQueue(), 5); // 5ms backoff para el test
        }
    };
    
    queue.enqueue({ test: 1 });
    await delay(100);
    
    assert.strictEqual(sends.length, 2, 'Debe haber intentado 2 veces (maxRetries)');
    assert.strictEqual(queue.queue.length, 0, 'Descartado tras agotar reintentos');
});

test('RelayAdapter: enruta mensaje INTERCOM al slowTransport', () => {
    const adap = new RelayAdapter({ networkId: 'LIFELINE-001', name: 'PC' });
    let sends = [];
    adap.setSlowTransport({
        send: async (payload) => {
            sends.push(payload);
            return true;
        }
    }, { timeoutMs: 10 });
    
    // Evitamos peticiones fetch reales
    globalThis.fetch = () => Promise.resolve({ok:true});
    
    const frame = { payload: { type: 'INTERCOM', msg: 'SOS' } };
    adap._sendFrame(frame, 'DATA');
    
    assert.strictEqual(adap.slowTransport.queue.length, 1, 'Frame encolado en SlowTransportQueue');
});
