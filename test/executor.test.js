'use strict';

// Executor sanity check — settleTrade P&L math + outcome classification.
// MUST set BEAST_LOG_DIR before requiring src/* so the real audit files
// (trades.jsonl, signals.jsonl, daily-pnl.json) are untouched.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-exec-'));
process.env.BEAST_LOG_DIR = TMP;
process.env.COMMISSION_MNQ = '0.62'; // per-contract round-turn for predictable math

// Sanity: confirm paths.js resolves to the temp dir before anything else loads
const { LOG_DIR } = require('../src/paths');
if (LOG_DIR !== path.resolve(TMP)) {
    console.error(`FAIL  LOG_DIR=${LOG_DIR} != ${TMP}`);
    process.exit(1);
}

// Seed settings so buildState() gets an accountId
require('../src/settings').merge({ accountId: '99999999' });

const db       = require('../src/db');
const risk     = require('../src/risk');
const executor = require('../src/executor');

// Stub network-dependent px methods so settleTrade doesn't try to hit TopstepX.
// getFilledOrder is called only when a fillPrice wasn't captured from RTC;
// our tests set fill prices directly so this shouldn't be reached — but guard.
const px = require('../src/projectx');
px.getFilledOrder     = async () => null;
px.cancelAllOrdersFor = async () => {};
px.getOpenPositions   = async () => [];
px.getOpenOrders      = async () => [];

function cleanup() {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

async function run() {
    let failed = 0;
    risk.setTradingEnabled(true);   // otherwise addPnl warnings clutter output

    // ── Scenario 1: 4-lot MNQ bearish, full winner (TP1 + target) ───────────
    {
        const trade = db.insert({
            instrument: 'NQ1!', family: 'NQ', contractId: 'CON.F.US.MNQ.M26',
            direction: 'bearish', qty: 4,
            entryPrice: 26870.5, stop: 26895, tp1: 26858.25, target: 26846,
            rDist: 24.5,
        });
        db.update(trade.id, {
            orderIds: { entry: 1001, sl: 1002, tp1: 1003, target: 1004 },
        });
        executor.registerTrade(db.getById(trade.id));

        const st = executor._state()['CON.F.US.MNQ.M26'];
        assert.ok(st, 'state registered');
        assert.strictEqual(st.tp1Qty, 3);
        assert.strictEqual(st.tp2Qty, 1);

        // Simulate fills arriving via onOrder/onTrade
        st.tp1FillPrice = 26858.25; st.tp1Booked = true;
        st.tp2FillPrice = 26846;    st.tp2Booked = true;

        const pnlBefore = risk.getDailyPnl();
        await executor.settleTrade('CON.F.US.MNQ.M26', 'TARGET', 'TEST');
        const closed = db.getById(trade.id);

        assert.strictEqual(closed.status, 'TARGET');
        // Blended exit: (3*26858.25 + 1*26846)/4 = 26855.1875 → rounded 26855.19
        assert.ok(Math.abs(closed.exitPrice - 26855.19) < 0.01, `exit=${closed.exitPrice}`);
        // Bearish points: entry 26870.5 - blended 26855.1875 = 15.3125 → 15.31
        assert.ok(Math.abs(closed.pnlPoints - 15.31) < 0.01, `points=${closed.pnlPoints}`);
        // Dollars: 15.3125 × 4ct × $2/pt = $122.50 gross; commission 4 × $0.62 = $2.48; net $120.02
        assert.ok(Math.abs(closed.pnlDollars - 120.02) < 0.01, `net=${closed.pnlDollars}`);
        assert.strictEqual(closed.commission, 2.48);
        assert.ok(Math.abs(risk.getDailyPnl() - pnlBefore - 120.02) < 0.01, 'risk.dailyPnl updated');
        console.log(`PASS  4ct full winner → TARGET, exit ${closed.exitPrice}, net $${closed.pnlDollars}, commission $${closed.commission}`);
    }

    // ── Scenario 2: 4-lot bearish, TP1 hits then SL on runner ──────────────
    {
        const trade = db.insert({
            instrument: 'NQ1!', family: 'NQ', contractId: 'CON.F.US.MNQ.M26',
            direction: 'bearish', qty: 4,
            entryPrice: 26800, stop: 26820, tp1: 26790, target: 26780,
            rDist: 20,
        });
        db.update(trade.id, { orderIds: { entry: 2001, sl: 2002, tp1: 2003, target: 2004 } });
        executor.registerTrade(db.getById(trade.id));

        const st = executor._state()['CON.F.US.MNQ.M26'];
        st.tp1FillPrice = 26790; st.tp1Booked = true;     // +10 pts × 3ct
        st.slFillPrice  = 26820; st.slBooked  = true;     // -20 pts × 1ct runner
        await executor.settleTrade('CON.F.US.MNQ.M26', 'TP1', 'TEST');

        const closed = db.getById(trade.id);
        assert.strictEqual(closed.status, 'TP1');
        // Points total: +10*3 + (-20)*1 = 30 - 20 = 10. Avg per contract = 10/4 = 2.5
        assert.ok(Math.abs(closed.pnlPoints - 2.5) < 0.01, `points=${closed.pnlPoints}`);
        // Dollars: 10 × $2 = $20 gross; commission $2.48; net $17.52
        assert.ok(Math.abs(closed.pnlDollars - 17.52) < 0.01, `net=${closed.pnlDollars}`);
        console.log(`PASS  4ct TP1+SL partial → TP1, net $${closed.pnlDollars}`);
    }

    // ── Scenario 3: 4-lot bearish, SL hit before any TP1 ───────────────────
    {
        const trade = db.insert({
            instrument: 'NQ1!', family: 'NQ', contractId: 'CON.F.US.MNQ.M26',
            direction: 'bearish', qty: 4,
            entryPrice: 26800, stop: 26820, tp1: 26790, target: 26780,
            rDist: 20,
        });
        db.update(trade.id, { orderIds: { entry: 3001, sl: 3002, tp1: 3003, target: 3004 } });
        executor.registerTrade(db.getById(trade.id));

        const st = executor._state()['CON.F.US.MNQ.M26'];
        st.slFillPrice = 26820; st.slBooked = true;       // -20 pts × 4ct
        await executor.settleTrade('CON.F.US.MNQ.M26', 'STOPPED', 'TEST');

        const closed = db.getById(trade.id);
        assert.strictEqual(closed.status, 'STOPPED');
        // Points: -20 × 4 = -80. Avg -20.
        assert.ok(Math.abs(closed.pnlPoints - (-20)) < 0.01, `points=${closed.pnlPoints}`);
        // Dollars: -80 × $2 = -$160 gross; commission $2.48; net -$162.48
        assert.ok(Math.abs(closed.pnlDollars - (-162.48)) < 0.01, `net=${closed.pnlDollars}`);
        console.log(`PASS  4ct full stop → STOPPED, net $${closed.pnlDollars}`);
    }

    // ── Scenario 4: 1-ct MNQ bullish TP1-only exit (qty=1 has no target) ──
    {
        const trade = db.insert({
            instrument: 'NQ1!', family: 'NQ', contractId: 'CON.F.US.MNQ.M26',
            direction: 'bullish', qty: 1,
            entryPrice: 26800, stop: 26780, tp1: 26810, target: 26820,
            rDist: 20,
        });
        db.update(trade.id, { orderIds: { entry: 4001, sl: 4002, tp1: 4003 } });
        executor.registerTrade(db.getById(trade.id));

        const st = executor._state()['CON.F.US.MNQ.M26'];
        assert.strictEqual(st.tp1Qty, 1);
        assert.strictEqual(st.tp2Qty, 0);
        st.tp1FillPrice = 26810; st.tp1Booked = true;
        await executor.settleTrade('CON.F.US.MNQ.M26', 'TP1', 'TEST');

        const closed = db.getById(trade.id);
        assert.strictEqual(closed.status, 'TP1');
        // Bullish: +10 pts × 1ct = $20 gross; commission 1 × $0.62 = $0.62; net $19.38
        assert.ok(Math.abs(closed.pnlDollars - 19.38) < 0.01, `net=${closed.pnlDollars}`);
        console.log(`PASS  1ct bullish TP1 → TP1, net $${closed.pnlDollars}`);
    }

    // ── Scenario 5: classifyOutcome is idempotent on re-entry ──────────────
    // Register a 2nd trade, settle it, then try to settle again — should no-op.
    {
        const trade = db.insert({
            instrument: 'NQ1!', family: 'NQ', contractId: 'CON.F.US.MNQ.M26',
            direction: 'bullish', qty: 2,
            entryPrice: 26800, stop: 26790, tp1: 26810, target: 26820,
            rDist: 10,
        });
        db.update(trade.id, { orderIds: { entry: 5001, sl: 5002, tp1: 5003, target: 5004 } });
        executor.registerTrade(db.getById(trade.id));
        const st = executor._state()['CON.F.US.MNQ.M26'];
        st.tp1FillPrice = 26810; st.tp1Booked = true;
        st.tp2FillPrice = 26820; st.tp2Booked = true;
        await executor.settleTrade('CON.F.US.MNQ.M26', 'TARGET', 'TEST');

        const pnlAfterFirst = risk.getDailyPnl();
        // Second call should be a no-op (trade removed from cache + settled flag)
        await executor.settleTrade('CON.F.US.MNQ.M26', 'TARGET', 'TEST');
        assert.strictEqual(risk.getDailyPnl(), pnlAfterFirst);
        console.log(`PASS  settleTrade idempotent on double-call`);
    }

    console.log('\nAll executor sanity tests passed');
    cleanup();
    if (failed) process.exit(1);
}

run().catch(e => { console.error('THREW:', e); cleanup(); process.exit(1); });
