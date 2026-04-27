'use strict';

// Append-only audit log of webhook signals that Pine v4.2's matrix /
// Power-Window stack rejected (filter_status MATRIX_SKIP or PW_SIZE_0).
// These are pure telemetry — no order, no journal, no risk-state mutation —
// consumed by EAI's matrix-vs-live accuracy analyzer.
//
// Schema: { _v: 1, receivedAt, filter_status, payload }. Full payload preserved
// verbatim so the analyzer can reconstruct simulated $ P&L from price, stop,
// direction, barCloseMs, cell_id, macro_transition, entry_zone_side.
//
// Also owns the in-memory matrix-selectivity counter that powers the
// dashboard's GO / SKIP / PW_0 / TOTAL block. Counters are incremented at
// webhook intake (post-validate, regardless of GO vs filtered branch) and
// rebuilt from signals.jsonl at boot so a mid-day restart doesn't lose the
// session ratio.

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const FILTERED_FILE = path.join(LOG_DIR, 'filtered_signals.jsonl');
const SIGNALS_FILE  = path.join(LOG_DIR, 'signals.jsonl');

// Trading day boundary: ≥18:00 ET rolls to next calendar day; Sat/Sun roll back
// to Friday. Mirrors risk.js tradingDayET() so matrix counters reset in lockstep
// with daily-pnl.json. (Inlined to keep filteredSignals.js self-contained;
// future refactor could move both copies into a shared util.)
function tradingDayFromDate(d) {
    const etHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(d));
    const ref = new Date(etHour >= 18 ? d.getTime() + 24 * 60 * 60 * 1000 : d.getTime());
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
    }).format(ref);
    if      (weekday === 'Sat') ref.setTime(ref.getTime() - 1 * 24 * 60 * 60 * 1000);
    else if (weekday === 'Sun') ref.setTime(ref.getTime() - 2 * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
}
function tradingDayET()       { return tradingDayFromDate(new Date()); }
function isoToTradingDay(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : tradingDayFromDate(d);
}

let counters = { GO: 0, MATRIX_SKIP: 0, PW_SIZE_0: 0, day: null };

function maybeRollover() {
    const today = tradingDayET();
    if (counters.day !== today) {
        counters = { GO: 0, MATRIX_SKIP: 0, PW_SIZE_0: 0, day: today };
    }
}

function incrementCount(filterStatus) {
    maybeRollover();
    const status = filterStatus === 'MATRIX_SKIP' || filterStatus === 'PW_SIZE_0'
        ? filterStatus : 'GO';
    counters[status]++;
}

function getCounts() {
    maybeRollover();
    const total = counters.GO + counters.MATRIX_SKIP + counters.PW_SIZE_0;
    const goPct = total > 0 ? Math.round((counters.GO / total) * 100) : null;
    return {
        GO:          counters.GO,
        MATRIX_SKIP: counters.MATRIX_SKIP,
        PW_SIZE_0:   counters.PW_SIZE_0,
        total,
        goPct,
        day:         counters.day,
    };
}

// Boot-time rebuild from signals.jsonl. Scans every entry whose receivedAt
// falls in today's trading day and increments the matching counter. Skips
// validation rejections (`disposition === 'rejected'`) — those are payloads
// Pine never legitimately emitted and shouldn't sway the selectivity ratio.
function rebuildFromDisk() {
    counters = { GO: 0, MATRIX_SKIP: 0, PW_SIZE_0: 0, day: tradingDayET() };
    if (!fs.existsSync(SIGNALS_FILE)) {
        console.log(`[filteredSignals] No signals.jsonl found — counters start fresh for ${counters.day}`);
        return;
    }
    let scanned = 0;
    try {
        const lines = fs.readFileSync(SIGNALS_FILE, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || isoToTradingDay(entry.receivedAt) !== counters.day) continue;
            if (entry.disposition === 'rejected') continue;
            const status = entry.payload?.filter_status || 'GO';
            if (status === 'MATRIX_SKIP' || status === 'PW_SIZE_0') counters[status]++;
            else counters.GO++;
            scanned++;
        }
    } catch (e) {
        console.warn(`[filteredSignals] rebuildFromDisk: ${e.message}`);
    }
    console.log(`[filteredSignals] Counts for ${counters.day}: GO=${counters.GO} SKIP=${counters.MATRIX_SKIP} PW_0=${counters.PW_SIZE_0} (rebuilt from ${scanned} entries)`);
}

function logFilteredSignal({ payload, filter_status, receivedAt }) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const entry = {
            _v: 1,
            receivedAt: receivedAt || new Date().toISOString(),
            filter_status,
            payload,
        };
        fs.appendFileSync(FILTERED_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn(`[filteredSignals] log write failed: ${e.message}`);
    }
}

module.exports = { logFilteredSignal, incrementCount, getCounts, rebuildFromDisk };
