'use strict';

// Pine v4.2 filter_status routing regression. MUST set BEAST_LOG_DIR before
// requiring any src/* module so real audit logs stay untouched.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-v42-test-'));
process.env.BEAST_LOG_DIR = TMP;

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
    instrument: 'NQ1!', direction: 'bullish', action: 'ENTRY', setup: 'BEAST',
    price: 27440, stop: 27420, tp1: 27450, target: 27460,
    rDist: 20, compression: 35, entryHour: 11,
    macroTransition: 'M2_to_M3', h4ZoneId: 'pending',
    momentum_activation: 0.55, momentum_trail: 0.65, size_multiplier: 1.0,
    cell_id: 'M2->M3 | premium | smt=0 | NY1',
    smt_macro_count: null, overshoot_pts: 1.25, entry_zone_side: 'premium',
    barCloseMs: Date.now() - 1000,
};

async function postSignal(base, body) {
    const r = await fetch(base + '/webhook/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

const FILTERED_FILE = path.join(TMP, 'filtered_signals.jsonl');
const SIGNALS_FILE  = path.join(TMP, 'signals.jsonl');

const server = app.listen(0, async () => {
    let failed = 0;
    const base = 'http://127.0.0.1:' + server.address().port;

    try {
        // 1. MATRIX_SKIP → filtered_signals.jsonl + signals.jsonl(disposition=filtered)
        let r = await postSignal(base, { ...basePayload, filter_status: 'MATRIX_SKIP' });
        if (r.data.status === 'filtered_logged' && r.data.filter_status === 'MATRIX_SKIP') {
            console.log('PASS  MATRIX_SKIP → filtered_logged response');
        } else {
            console.error(`FAIL  MATRIX_SKIP unexpected response ${JSON.stringify(r.data)}`); failed++;
        }

        // 2. PW_SIZE_0 → same routing, different status preserved
        r = await postSignal(base, { ...basePayload, filter_status: 'PW_SIZE_0', barCloseMs: Date.now() });
        if (r.data.status === 'filtered_logged' && r.data.filter_status === 'PW_SIZE_0') {
            console.log('PASS  PW_SIZE_0 → filtered_logged response');
        } else {
            console.error(`FAIL  PW_SIZE_0 unexpected response ${JSON.stringify(r.data)}`); failed++;
        }

        // 3. Verify both filtered rows landed in filtered_signals.jsonl with full payload
        const filteredRows = readJsonl(FILTERED_FILE);
        if (filteredRows.length === 2
            && filteredRows[0].filter_status === 'MATRIX_SKIP'
            && filteredRows[1].filter_status === 'PW_SIZE_0'
            && filteredRows[0].payload.cell_id === basePayload.cell_id
            && filteredRows[0].payload.price === basePayload.price
            && filteredRows[0]._v === 1
            && filteredRows[0].receivedAt) {
            console.log('PASS  filtered_signals.jsonl has 2 rows with full payload + _v + receivedAt');
        } else {
            console.error(`FAIL  filtered_signals.jsonl unexpected: ${JSON.stringify(filteredRows.map(r => ({ fs: r.filter_status, kp: !!r.payload?.cell_id })))}`); failed++;
        }

        // 4. Verify signals.jsonl mirrors with disposition=filtered + filter_status preserved
        const sigRows = readJsonl(SIGNALS_FILE);
        const filteredDispRows = sigRows.filter(s => s.disposition === 'filtered');
        if (filteredDispRows.length === 2
            && filteredDispRows[0].filter_status === 'MATRIX_SKIP'
            && filteredDispRows[1].filter_status === 'PW_SIZE_0') {
            console.log('PASS  signals.jsonl logged 2 rows with disposition=filtered + filter_status');
        } else {
            console.error(`FAIL  signals.jsonl filtered rows unexpected: ${JSON.stringify(filteredDispRows.map(s => ({ d: s.disposition, fs: s.filter_status })))}`); failed++;
        }

        // 5. v4.1 payload (no filter_status) → routes through normally; will hit
        //    the next gate (pnlAudit / risk) and we don't need to assert which —
        //    just that it does NOT come back as filtered_logged.
        r = await postSignal(base, { ...basePayload, barCloseMs: Date.now() });
        if (r.data.status !== 'filtered_logged') {
            console.log(`PASS  v4.1 payload (no filter_status) → not filtered (status=${r.data.status})`);
        } else {
            console.error(`FAIL  v4.1 payload incorrectly filtered: ${JSON.stringify(r.data)}`); failed++;
        }

        // 6. GO explicit → also routes through normally
        r = await postSignal(base, { ...basePayload, filter_status: 'GO', barCloseMs: Date.now() });
        if (r.data.status !== 'filtered_logged') {
            console.log(`PASS  filter_status=GO → not filtered (status=${r.data.status})`);
        } else {
            console.error(`FAIL  GO incorrectly filtered: ${JSON.stringify(r.data)}`); failed++;
        }

        // 7. Invalid filter_status → rejected with bad_filter_status reason
        r = await postSignal(base, { ...basePayload, filter_status: 'BANANA', barCloseMs: Date.now() });
        if (r.status === 400 && /bad_filter_status/.test(r.data.error || '')) {
            console.log('PASS  invalid filter_status → 400 bad_filter_status');
        } else {
            console.error(`FAIL  invalid filter_status not rejected: ${r.status} ${JSON.stringify(r.data)}`); failed++;
        }

        // 8. Confirm filtered_signals.jsonl wasn't polluted by GO / invalid signals
        const filteredAfter = readJsonl(FILTERED_FILE);
        if (filteredAfter.length === 2) {
            console.log('PASS  filtered_signals.jsonl still has only the 2 filtered rows (no GO/invalid leakage)');
        } else {
            console.error(`FAIL  filtered_signals.jsonl grew unexpectedly to ${filteredAfter.length} rows`); failed++;
        }
    } catch (e) {
        console.error('FAIL  test threw:', e.message); failed++;
    } finally {
        server.close();
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
        if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
        console.log('\nAll v4.2 filter-routing regression tests passed (real logs untouched)');
    }
});
