'use strict';

// One-shot reconcile for trade 2 (2026-04-21). The trade closed before the
// RTC layer was deployed, so entryPrice holds the signal price 26870.5
// instead of the actual broker fill 26869.75 — a 0.75-pt × 4ct × $2 = $6
// overstatement of gross. Commission ($1.24/ct all-in) is already correct.
//
// Rewrites trade 2's pnl fields and adjusts risk.dailyPnl by the delta.

require('dotenv').config();

const db   = require('../src/db');
const risk = require('../src/risk');

db.loadFromDisk();
risk.restorePnlState();

const id = 2;
const t  = db.getById(id);
if (!t) { console.error(`trade ${id} not found`); process.exit(1); }

const ACTUAL_ENTRY = 26869.75;
const BLEND_EXIT   = 26855.19;
const QTY          = 4;
const POINT_VALUE  = 2;        // MNQ
const COMMISSION   = 4.96;     // $1.24 all-in × 4ct
const RDIST        = t.rDist || 24.5;

// Per-leg totals from the broker receipt (3ct TP1 + 1ct target)
const GROSS    = 69.00 + 47.50;   // $116.50
const rawPts   = ACTUAL_ENTRY - BLEND_EXIT;              // bearish avg/ct
const avgPts   = Math.round(rawPts * 100) / 100;
const netDol   = Math.round((GROSS - COMMISSION) * 100) / 100;
const rMult    = Math.round((avgPts / RDIST) * 100) / 100;
const prevNet  = t.pnlDollars || 0;
const delta    = Math.round((netDol - prevNet) * 100) / 100;

console.log(`Before: entry=${t.entryPrice} net=$${prevNet} pts=${t.pnlPoints}`);
console.log(`After:  entry=${ACTUAL_ENTRY} net=$${netDol} pts=${avgPts} R=${rMult}`);
console.log(`Delta:  $${delta} → applying to dailyPnl`);

db.update(id, {
    entryPrice: ACTUAL_ENTRY,
    exitPrice:  BLEND_EXIT,
    pnlPoints:  avgPts,
    pnlDollars: netDol,
    commission: COMMISSION,
    rMultiple:  rMult,
});

risk.addPnl(delta);

console.log(`Done. dailyPnl now $${risk.getDailyPnl()}`);
