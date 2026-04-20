'use strict';

// Staleness reject regression — MUST set BEAST_LOG_DIR before requiring any
// src/* module so the real audit logs (trades.jsonl, signals.jsonl, daily-pnl.json,
// settings.json, .token.json) are untouched.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-test-'));
process.env.BEAST_LOG_DIR = TMP;

// Sanity: confirm paths.js resolves to the temp dir before any other module loads.
const { LOG_DIR } = require('../src/paths');
if (LOG_DIR !== path.resolve(TMP)) {
    console.error(`FAIL  LOG_DIR=${LOG_DIR} did not resolve to ${TMP}`);
    process.exit(1);
}

const express = require('express');
const { createWebhookRouter } = require('../src/webhook');

const app = express();
app.use(express.json());
app.use('/webhook', createWebhookRouter());

const basePayload = {
    instrument: 'NQ1!', direction: 'bearish', action: 'ENTRY', setup: 'BEAST',
    price: 26729.5, stop: 26780, tp1: 26704.25, target: 26679,
    rDist: 50.5, compression: 65.4, entryHour: 10,
    macroTransition: 'M3_to_M1', h4ZoneId: 'pending',
};

async function postSignal(base, body) {
    const r = await fetch(base + '/webhook/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
}

function cleanup() {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

const server = app.listen(0, async () => {
    let failed = 0;
    const base = 'http://127.0.0.1:' + server.address().port;

    try {
        let r = await postSignal(base, { ...basePayload, barCloseMs: Date.now() - 8000 });
        if (r.data.status === 'rejected_stale' && r.data.ageMs > 5000) {
            console.log(`PASS  stale (8s) → rejected_stale ageMs=${r.data.ageMs}`);
        } else {
            console.error(`FAIL  expected rejected_stale, got ${JSON.stringify(r.data)}`); failed++;
        }

        r = await postSignal(base, { ...basePayload });
        if (r.data.status !== 'rejected_stale') {
            console.log(`PASS  legacy (no barCloseMs) → passed staleness gate (status=${r.data.status})`);
        } else {
            console.error('FAIL  legacy should not be rejected_stale'); failed++;
        }

        r = await postSignal(base, { ...basePayload, barCloseMs: Date.now() - 2000 });
        if (r.data.status !== 'rejected_stale') {
            console.log(`PASS  fresh (2s) → passed staleness gate (status=${r.data.status})`);
        } else {
            console.error('FAIL  fresh should not be rejected_stale'); failed++;
        }

        // Confirm isolation: real logs/ must not have been touched. We check
        // by comparing the signals.jsonl in the real logs dir (if any) against
        // its pre-test state isn't feasible here; instead, prove the temp dir
        // did receive writes — and by construction the modules only know about
        // LOG_DIR, so real files couldn't have been hit.
        const tempSignals = path.join(TMP, 'signals.jsonl');
        if (fs.existsSync(tempSignals) && fs.readFileSync(tempSignals, 'utf8').includes('rejected_stale')) {
            console.log('PASS  writes landed in temp dir, not real logs/');
        } else {
            console.error('FAIL  expected test writes in temp signals.jsonl'); failed++;
        }
    } catch (e) {
        console.error('FAIL  test threw:', e.message); failed++;
    } finally {
        server.close();
        cleanup();
        if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
        console.log('\nAll staleness regression tests passed (real logs untouched)');
    }
});
