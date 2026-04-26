'use strict';

// ---------------------------------------------------------------------------
// Per-day trade journal — BEAST Mode.
//
// Ported from EvilSignals-Executor/src/journal.js (2026-04-22).
// Adaptations from EAI:
//   - Trimmed signal-classification fields (ML, regime, dim, lbCombo, bayesian,
//     nn, tiltAlignment) — those are EAI-specific. BEAST keeps its own payload
//     fields (compression, entryHour, macroTransition, rDist, h4ZoneId).
//   - Dropped logBlockedSignal (BEAST's webhook already logs rejected signals
//     to logs/signals.jsonl — no duplicate path needed).
//   - Dropped journal-qa-data.json machinery (EAI-only Edgeable export source).
//   - Uses console.log/warn directly (BEAST has no logger module).
//
// Storage: logs/journal-YYYY-MM-DD.json — one file per trading day.
// Trading-day rollover: 18:00 ET advances to next calendar day (Globex
// session boundary). Matches risk.js and sessionClose.js conventions.
//
// Role in BEAST:
//   - `src/db.js` (trades.jsonl) stays as the live/in-flight trade store and
//     the source of truth for open-trade rebuild on boot.
//   - `src/journal.js` is the closed-trade system of record consumed by the
//     Performance tab and the 16:30 ET P&L audit reconciliation.
//   - Webhook calls openTrade() when a BEAST signal is accepted.
//   - Executor.settleTrade (and manual paths: dashboard flatten + PATCH
//     /trades/:id) call finalizeTrade() on close.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');
const { atomicWrite } = require('./fsutil');

function journalFile(date) {
    return path.join(LOG_DIR, `journal-${date}.json`);
}

// Trading-day string: ≥18:00 ET = next calendar day (Globex session).
// daysBack: 0 = current session day, 1 = previous session day (for getLastTrade).
function tradingDayStr(daysBack = 0) {
    const now    = new Date();
    const etHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(now));
    const ref = new Date(etHour >= 18 ? now.getTime() + 24 * 60 * 60 * 1000 : now.getTime());
    if (daysBack > 0) ref.setTime(ref.getTime() - daysBack * 24 * 60 * 60 * 1000);
    // Never file under Sat/Sun — roll back to Friday.
    const etWeekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
    }).format(ref);
    if      (etWeekday === 'Sat') ref.setTime(ref.getTime() - 1 * 24 * 60 * 60 * 1000);
    else if (etWeekday === 'Sun') ref.setTime(ref.getTime() - 2 * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
}

function loadDay(date) {
    try {
        const f = journalFile(date || tradingDayStr());
        if (!fs.existsSync(f)) return [];
        return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
    } catch { return []; }
}

function saveDay(date, records) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        atomicWrite(journalFile(date), JSON.stringify(records, null, 2));
    } catch (e) {
        console.warn(`[journal] saveDay ${date}: ${e.message}`);
    }
}

// Called when a BEAST signal is accepted and orders are placed.
// `trade` is the record returned by db.insert (already has id, direction,
// entry/stop/tp1/target, family, contractId, qty, rDist, compression, etc).
// `accountId` is the broker account the orders were placed against (captured
// at entry time so account-switch mid-trade doesn't misattribute history).
function openTrade(trade, { accountId, tickSize, tickValue, orderIds } = {}) {
    const today   = tradingDayStr();
    const records = loadDay(today);
    const side    = String(trade.direction).toLowerCase() === 'bullish' ? 'LONG' : 'SHORT';
    records.push({
        _v:         1,
        id:         trade.id,
        date:       today,
        accountId:  accountId != null ? Number(accountId) : null,
        setupType:  'BEAST',
        symbol:     trade.instrument,
        family:     trade.family     || null,
        contractId: trade.contractId || null,
        side,
        size:       trade.qty || null,
        entryPrice: trade.entryPrice,
        tp1Price:   trade.tp1,
        tp2Price:   trade.target,
        slPrice:    trade.stop,
        tickSize:   tickSize  != null ? Number(tickSize)  : null,
        tickValue:  tickValue != null ? Number(tickValue) : null,
        rDist:      trade.rDist           ?? null,
        compression:     trade.compression     ?? null,
        entryHour:       trade.entryHour       ?? null,
        macroTransition: trade.macroTransition ?? null,
        h4ZoneId:        trade.h4ZoneId        ?? null,
        // v4 fields — null on v3 payloads
        momentumActivation: trade.momentumActivation ?? null,
        momentumTrail:      trade.momentumTrail      ?? null,
        sizeMultiplier:     trade.sizeMultiplier     ?? null,
        cellId:             trade.cellId             ?? null,
        smtMacroCount:      trade.smtMacroCount      ?? null,
        overshootPts:       trade.overshootPts       ?? null,
        entryZoneSide:      trade.entryZoneSide      ?? null,
        // Order IDs flattened from trade.orderIds so pnlReconcile can match
        // broker /Trade/search rows against the executor's orders.
        entryOrderId: orderIds?.entry  ?? trade.orderIds?.entry  ?? null,
        slOrderId:    orderIds?.sl     ?? trade.orderIds?.sl     ?? null,
        tp1OrderId:   orderIds?.tp1    ?? trade.orderIds?.tp1    ?? null,
        tp2OrderId:   orderIds?.target ?? trade.orderIds?.target ?? null,
        pnl:        0,            // gross realized; commission subtracted on finalize
        commission: 0,
        actualEntry: null,        // filled in when RTC captures entry fill
        outcome:    'OPEN',       // OPEN | TP1 | TARGET | STOPPED | MANUAL
        openedAt:   trade.timestamp || new Date().toISOString(),
        closedAt:   null,
        peakMfe:    null,
        peakMae:    null,
        rMultiple:  null,
    });
    saveDay(today, records);
}

// Persist actual entry fill (from RTC position event / trade event). Once
// set, we don't overwrite — the first capture is the real entry price.
function setActualEntry(localTradeId, fillPrice) {
    const today = tradingDayStr();
    const records = loadDay(today);
    const rec = records.find(r => r.id === localTradeId);
    if (!rec || rec.actualEntry != null) return;
    rec.actualEntry = Number(fillPrice);
    saveDay(today, records);
}

// Patch arbitrary fields onto an existing record. Walks today then yesterday
// in case the trade opened late on a session that has since rolled.
function patchTrade(localTradeId, fields) {
    for (let daysBack = 0; daysBack <= 1; daysBack++) {
        const dateStr = tradingDayStr(daysBack);
        const records = loadDay(dateStr);
        const rec = records.find(r => r.id === localTradeId);
        if (rec) {
            Object.assign(rec, fields);
            saveDay(dateStr, records);
            return true;
        }
    }
    return false;
}

// Correct a closed trade's P&L and/or commission to broker-canonical values.
// Called from the 16:30 ET audit when a delta is detected. Returns deltas
// applied so the caller can log/surface them, or null if trade not found.
function correctTradePnl(localTradeId, newPnl, date, newCommission) {
    for (let daysBack = 0; daysBack <= 7; daysBack++) {
        const dateStr = date || tradingDayStr(daysBack);
        const records = loadDay(dateStr);
        const rec = records.find(r => r.id === localTradeId);
        if (!rec) {
            if (date) return null;  // explicit date — don't keep walking
            continue;
        }
        const pnlDelta  = newPnl        != null ? newPnl        - (rec.pnl        || 0) : 0;
        const commDelta = newCommission != null ? newCommission - (rec.commission || 0) : 0;
        if (newPnl        != null) rec.pnl        = newPnl;
        if (newCommission != null) rec.commission = newCommission;
        // Recompute rMultiple from corrected values
        const stopPts = rec.slPrice != null && rec.entryPrice != null ? Math.abs(rec.entryPrice - rec.slPrice) : 0;
        if (stopPts > 0 && rec.tickSize && rec.tickValue && rec.size) {
            const riskDollars = (stopPts / rec.tickSize) * rec.tickValue * rec.size;
            if (riskDollars > 0) rec.rMultiple = parseFloat(((rec.pnl - rec.commission) / riskDollars).toFixed(3));
        }
        saveDay(dateStr, records);
        return { pnlDelta, commDelta };
    }
    return null;
}

// Accumulate P&L as legs resolve (TP1 partial, then TP2/SL runner).
function addTradePnl(localTradeId, pnlDelta) {
    const today = tradingDayStr();
    const records = loadDay(today);
    const rec = records.find(r => r.id === localTradeId);
    if (!rec) return;
    rec.pnl = (rec.pnl || 0) + pnlDelta;
    saveDay(today, records);
}

// Mark trade as fully closed with final outcome + commission.
function finalizeTrade(localTradeId, outcome, commission = 0, peakMfe = null, peakMae = null) {
    const today = tradingDayStr();
    const records = loadDay(today);
    const rec = records.find(r => r.id === localTradeId);
    if (!rec) return;
    rec.outcome    = outcome;
    rec.commission = commission;
    rec.closedAt   = new Date().toISOString();
    if (peakMfe != null) rec.peakMfe = parseFloat(Number(peakMfe).toFixed(2));
    if (peakMae != null) rec.peakMae = parseFloat(Number(peakMae).toFixed(2));
    const stopPts = Math.abs((rec.entryPrice || 0) - (rec.slPrice || 0));
    if (stopPts > 0 && rec.tickSize && rec.tickValue && rec.size) {
        const riskDollars = (stopPts / rec.tickSize) * rec.tickValue * rec.size;
        if (riskDollars > 0) {
            const netPnl  = (rec.pnl || 0) - commission;
            rec.rMultiple = parseFloat((netPnl / riskDollars).toFixed(3));
        }
    }
    saveDay(today, records);
}

// Stats for a given date (defaults to current trading day).
function getStats(date, accountId) {
    let records = loadDay(date || tradingDayStr());
    if (accountId) records = records.filter(r => String(r.accountId || '') === String(accountId));
    const closed = records.filter(r => r.outcome !== 'OPEN');
    const net    = r => (r.pnl || 0) - (r.commission || 0);
    const wins   = closed.filter(r => net(r) >  0.01);
    const losses = closed.filter(r => net(r) < -0.01);
    const be     = closed.filter(r => Math.abs(net(r)) <= 0.01);
    return {
        total:    closed.length,
        wins:     wins.length,
        losses:   losses.length,
        be:       be.length,
        winRate:  closed.length ? Math.round(wins.length / closed.length * 100) : 0,
        totalPnl: Math.round(closed.reduce((s, r) => s + net(r), 0) * 100) / 100,
        open:     records.filter(r => r.outcome === 'OPEN').length,
        trades:   records,
    };
}

function getHistory(date) {
    return loadDay(date || tradingDayStr());
}

// Aggregate stats across all journal files — powers Performance tab "ALL TIME".
function getAggregateStats(accountId) {
    let allRecords = [];
    const byDay    = [];
    try {
        const files = fs.readdirSync(LOG_DIR)
            .filter(f => f.startsWith('journal-') && f.endsWith('.json'))
            .sort();
        for (const f of files) {
            const date    = f.slice(8, 18);
            let records   = loadDay(date);
            if (accountId) records = records.filter(r => String(r.accountId || '') === String(accountId));
            if (!records.length) continue;
            const closed  = records.filter(r => r.outcome !== 'OPEN');
            const dnet    = r => (r.pnl || 0) - (r.commission || 0);
            const wins    = closed.filter(r => dnet(r) >  0.01);
            const losses  = closed.filter(r => dnet(r) < -0.01);
            const be      = closed.filter(r => Math.abs(dnet(r)) <= 0.01);
            byDay.push({
                date,
                total:   closed.length,
                wins:    wins.length,
                losses:  losses.length,
                be:      be.length,
                winRate: closed.length ? Math.round(wins.length / closed.length * 100) : 0,
                pnl:     Math.round(closed.reduce((s, r) => s + dnet(r), 0) * 100) / 100,
            });
            allRecords = allRecords.concat(records);
        }
    } catch {}
    const closed = allRecords.filter(r => r.outcome !== 'OPEN');
    const anet   = r => (r.pnl || 0) - (r.commission || 0);
    const wins   = closed.filter(r => anet(r) >  0.01);
    const losses = closed.filter(r => anet(r) < -0.01);
    const be     = closed.filter(r => Math.abs(anet(r)) <= 0.01);
    return {
        total:    closed.length,
        wins:     wins.length,
        losses:   losses.length,
        be:       be.length,
        winRate:  closed.length ? Math.round(wins.length / closed.length * 100) : 0,
        totalPnl: Math.round(closed.reduce((s, r) => s + anet(r), 0) * 100) / 100,
        byDay,
    };
}

// Distinct accountIds found across all journals — lets the Performance tab
// build a per-account filter automatically as accounts rotate.
function getDistinctAccounts() {
    const accounts = new Set();
    try {
        const files = fs.readdirSync(LOG_DIR)
            .filter(f => f.startsWith('journal-') && f.endsWith('.json'));
        for (const f of files) {
            const records = loadDay(f.slice(8, 18));
            records.forEach(r => { if (r.accountId) accounts.add(String(r.accountId)); });
        }
    } catch {}
    return [...accounts].sort();
}

// Most recently closed trade — checks today then yesterday.
function getLastTrade(accountId = null) {
    const acctStr = accountId != null ? String(accountId) : null;
    for (let daysBack = 0; daysBack <= 1; daysBack++) {
        const dateStr = tradingDayStr(daysBack);
        const records = loadDay(dateStr);
        const closed  = records.filter(r => {
            if (r.outcome === 'OPEN') return false;
            if (acctStr !== null && String(r.accountId) !== acctStr) return false;
            return true;
        });
        if (closed.length) return closed[closed.length - 1];
    }
    return null;
}

// List of journal dates (YYYY-MM-DD) on disk, sorted descending (newest first).
// Used by Performance tab to populate the date picker.
function getJournalDates() {
    try {
        return fs.readdirSync(LOG_DIR)
            .filter(f => f.startsWith('journal-') && f.endsWith('.json'))
            .map(f => f.slice(8, 18))
            .sort()
            .reverse();
    } catch { return []; }
}

// One-time backfill: read legacy trades from db.js and write them into
// per-day journal files keyed by exitTime (closed) or timestamp (open).
// Skips trades already present in the journal (idempotent). Returns the
// number of records written. Called from index.js on boot.
function backfillFromDb(dbTrades) {
    let written = 0;
    if (!Array.isArray(dbTrades) || !dbTrades.length) return 0;
    // Group source records by trading day.
    const byDay = new Map();
    for (const t of dbTrades) {
        const tsIso = t.exitTime || t.timestamp;
        if (!tsIso) continue;
        // Compute trading day for this timestamp (18:00 ET rollover).
        const dt = new Date(tsIso);
        const etHour = Number(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', hour12: false,
        }).format(dt));
        const ref = new Date(etHour >= 18 ? dt.getTime() + 24 * 60 * 60 * 1000 : dt.getTime());
        const etWeekday = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', weekday: 'short',
        }).format(ref);
        if      (etWeekday === 'Sat') ref.setTime(ref.getTime() - 1 * 24 * 60 * 60 * 1000);
        else if (etWeekday === 'Sun') ref.setTime(ref.getTime() - 2 * 24 * 60 * 60 * 1000);
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(t);
    }

    for (const [day, dayTrades] of byDay) {
        const existing = loadDay(day);
        const existingIds = new Set(existing.map(r => r.id));
        let dirty = false;
        for (const t of dayTrades) {
            if (existingIds.has(t.id)) continue;
            const side = String(t.direction || '').toLowerCase() === 'bullish' ? 'LONG' : 'SHORT';
            const outcome = t.status === 'OPEN' ? 'OPEN' : t.status || 'MANUAL';
            // Legacy trades carry pnlDollars as NET (gross - commission). Split
            // back into pnl + commission so the audit/reconcile math works.
            const commission = Number(t.commission) || 0;
            const netDollars = t.pnlDollars != null ? Number(t.pnlDollars) : 0;
            const grossPnl   = t.pnlDollars != null ? netDollars + commission : 0;
            existing.push({
                _v:         1,
                id:         t.id,
                date:       day,
                accountId:  null,            // unknown for legacy rows
                setupType:  'BEAST',
                symbol:     t.instrument,
                family:     t.family     || null,
                contractId: t.contractId || null,
                side,
                size:       t.qty || null,
                entryPrice: t.entryPrice,
                tp1Price:   t.tp1,
                tp2Price:   t.target,
                slPrice:    t.stop,
                tickSize:   null,
                tickValue:  null,
                rDist:      t.rDist ?? null,
                compression:     t.compression     ?? null,
                entryHour:       t.entryHour       ?? null,
                macroTransition: t.macroTransition ?? null,
                h4ZoneId:        t.h4ZoneId        ?? null,
                // v4 fields — null on v3 payloads
                momentumActivation: t.momentumActivation ?? null,
                momentumTrail:      t.momentumTrail      ?? null,
                sizeMultiplier:     t.sizeMultiplier     ?? null,
                cellId:             t.cellId             ?? null,
                smtMacroCount:      t.smtMacroCount      ?? null,
                overshootPts:       t.overshootPts       ?? null,
                entryZoneSide:      t.entryZoneSide      ?? null,
                entryOrderId: t.orderIds?.entry  ?? null,
                slOrderId:    t.orderIds?.sl     ?? null,
                tp1OrderId:   t.orderIds?.tp1    ?? null,
                tp2OrderId:   t.orderIds?.target ?? null,
                pnl:        t.pnlDollars != null ? Math.round(grossPnl * 100) / 100 : 0,
                commission,
                actualEntry: null,
                outcome,
                openedAt:   t.timestamp || null,
                closedAt:   t.exitTime || null,
                exitPrice:  t.exitPrice ?? null,
                peakMfe:    null,
                peakMae:    null,
                rMultiple:  t.rMultiple ?? null,
                _backfilled: true,
            });
            written++;
            dirty = true;
        }
        if (dirty) saveDay(day, existing);
    }
    return written;
}

module.exports = {
    tradingDayStr,
    loadDay,
    saveDay,
    openTrade,
    setActualEntry,
    patchTrade,
    addTradePnl,
    correctTradePnl,
    finalizeTrade,
    getStats,
    getHistory,
    getAggregateStats,
    getDistinctAccounts,
    getLastTrade,
    getJournalDates,
    backfillFromDb,
};
