'use strict';

const readline = require('readline');
const { tokenize } = require('./args.js');

function renderResult(result, out, opts = {}) {
    if (!result) return;
    if (result.ok === false) {
        out.error(result.error || 'operación fallida');
        return;
    }
    if (result.text !== undefined && result.text !== null && result.text !== '') {
        if (opts.json) out.data(result);
        else out.text(result.text);
        return;
    }
    if (opts.json) {
        out.data(result);
        return;
    }
    out.data(result);
}

async function runRepl(session, exec, out, opts = {}) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: !!process.stdin.isTTY,
        prompt: 'lifeline> ',
    });

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        try { rl.close(); } catch (e) { /* ya cerrado */ }
    };

    if (!out.json) {
        out.text('');
        out.text('Lifeline Core · consola headless. Escribí "help" o "quit".');
        out.text(`Sesión: ${session.name} (${session.id}) · ${session.role} · ${session.alertState}`);
        out.text('');
    }
    rl.prompt();

    rl.on('line', async (line) => {
        const argv = tokenize(line);
        if (argv.length === 0) { rl.prompt(); return; }
        try {
            const result = await exec(argv);
            renderResult(result, out, opts);
            if (result && result.quit) { close(); return; }
            if (result && result.shutdown) { close(); return; }
        } catch (e) {
            out.error(e);
        }
        if (!closed) rl.prompt();
    });

    await new Promise((resolve) => {
        rl.on('close', resolve);
        rl.on('SIGINT', () => {
            out.text('');
            close();
        });
    });
}

module.exports = { runRepl, renderResult };
