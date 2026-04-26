'use strict';

// Trade store backed by an append-only JSONL log at logs/trades.jsonl.
// In-memory array is the source of truth at runtime; disk is the source of
// truth across restarts. Every insert/update appends one line:
//   {"_op":"insert","_v":1,"id":1,"status":"OPEN",...}
//   {"_op":"update","_v":1,"id":1,"status":"TP1","exitPrice":...}
// On boot, loadFromDisk() streams the file and folds updates into inserts
// by id to rebuild the array. Append-only writes are atomic per line, so a
// crash mid-write at worst leaves a trailing partial line that the parser
// skips. No schema migration is wired up yet; _v:1 is stamped on every
// record so future migrations can branch on version.

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const SCHEMA_VERSION = 1;
const TRADES_FILE = path.join(LOG_DIR, 'trades.jsonl');

const trades = [];
let nextId = 1;

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendLine(obj) {
    try {
        ensureLogDir();
        fs.appendFileSync(TRADES_FILE, JSON.stringify(obj) + '\n');
    } catch (e) {
        console.warn(`[db] append failed: ${e.message}`);
    }
}

function loadFromDisk() {
    try {
        if (!fs.existsSync(TRADES_FILE)) {
            console.log('[db] No trades.jsonl found — starting with empty trade store');
            return;
        }
        const raw   = fs.readFileSync(TRADES_FILE, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        let inserted = 0;
        let updated  = 0;
        let skipped  = 0;

        for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch { skipped++; continue; }
            if (!entry || typeof entry !== 'object' || !entry._op) { skipped++; continue; }

            if (entry._op === 'insert') {
                const { _op, ...rec } = entry;
                trades.push(rec);
                if (typeof rec.id === 'number' && rec.id >= nextId) nextId = rec.id + 1;
                inserted++;
            } else if (entry._op === 'update') {
                const t = trades.find(x => x.id === entry.id);
                if (t) {
                    const { _op, id, _v, ...fields } = entry;
                    Object.assign(t, fields);
                    updated++;
                } else {
                    skipped++;
                }
            }
        }
        const openCount = trades.filter(t => t.status === 'OPEN').length;
        console.log(`[db] Loaded trades.jsonl — ${trades.length} trades (${openCount} OPEN), ${updated} updates applied${skipped ? `, ${skipped} lines skipped` : ''}`);
    } catch (e) {
        console.warn(`[db] loadFromDisk: ${e.message}`);
    }
}

function insert(trade) {
    const record = {
        _v:              SCHEMA_VERSION,
        id:              nextId++,
        timestamp:       new Date().toISOString(),
        instrument:      trade.instrument,
        family:          trade.family          || null,
        contractId:      trade.contractId      || null,
        direction:       trade.direction,
        qty:             trade.qty             || null,
        entryPrice:      trade.entryPrice,
        stop:            trade.stop,
        tp1:             trade.tp1,
        target:          trade.target,
        rDist:           trade.rDist,
        compression:     trade.compression,
        entryHour:       trade.entryHour,
        macroTransition: trade.macroTransition,
        h4ZoneId:        trade.h4ZoneId,
        // v4 fields — frozen at registration; null on v3 payloads
        momentumActivation: trade.momentumActivation ?? null,
        momentumTrail:      trade.momentumTrail      ?? null,
        sizeMultiplier:     trade.sizeMultiplier     ?? null,
        cellId:             trade.cellId             ?? null,
        smtMacroCount:      trade.smtMacroCount      ?? null,
        overshootPts:       trade.overshootPts       ?? null,
        entryZoneSide:      trade.entryZoneSide      ?? null,
        mode:            trade.mode || 'standard',   // 'standard' | 'momentum' — frozen at registration
        status:          'OPEN',    // OPEN | TP1 | TARGET | STOPPED | MANUAL
        exitPrice:       null,
        exitTime:        null,
        rMultiple:       null,
        pnlPoints:       null,
        pnlDollars:      null,        // NET: gross - commission (matches broker-account impact)
        commission:      null,        // round-turn, qty-inclusive
        orderIds:        trade.orderIds || {}, // { entry, sl, tp1, target }
    };
    trades.push(record);
    appendLine({ _op: 'insert', ...record });
    return record;
}

function update(id, fields) {
    const t = trades.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, fields);
    appendLine({ _op: 'update', _v: SCHEMA_VERSION, id, ...fields });
    return t;
}

function getAll() {
    return trades.slice();
}

function getOpen() {
    return trades.filter(t => t.status === 'OPEN');
}

function getById(id) {
    return trades.find(t => t.id === id) || null;
}

// Analytics computed on demand from closed trades
function getStats() {
    const closed = trades.filter(t => t.status !== 'OPEN');
    if (closed.length === 0) {
        return { trades: 0, winRate: null, expectancy: null, profitFactor: null, netPoints: null, netDollars: null };
    }

    const wins    = closed.filter(t => t.status === 'TP1' || t.status === 'TARGET');
    const losses  = closed.filter(t => t.status === 'STOPPED');
    const winRate = wins.length / closed.length;

    const totalWin  = wins.reduce((s, t)  => s + (t.rMultiple || 0), 0);
    const totalLoss = losses.reduce((s, t) => s + Math.abs(t.rMultiple || 0), 0);

    const expectancy   = (totalWin - totalLoss) / closed.length;
    const profitFactor = totalLoss === 0 ? null : totalWin / totalLoss;
    const netPoints    = closed.reduce((s, t) => s + (t.pnlPoints  || 0), 0);
    const netDollars   = closed.reduce((s, t) => s + (t.pnlDollars || 0), 0);

    // Net by calendar month (YYYY-MM)
    const monthly = {};
    for (const t of closed) {
        const mo = t.exitTime ? t.exitTime.slice(0, 7) : t.timestamp.slice(0, 7);
        monthly[mo] = (monthly[mo] || 0) + (t.pnlDollars || 0);
    }

    return {
        trades:       closed.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      Math.round(winRate * 1000) / 10,
        expectancy:   Math.round(expectancy * 100) / 100,
        profitFactor: profitFactor !== null ? Math.round(profitFactor * 100) / 100 : null,
        netPoints:    Math.round(netPoints  * 100) / 100,
        netDollars:   Math.round(netDollars * 100) / 100,
        monthly,
    };
}

module.exports = { insert, update, getAll, getOpen, getById, getStats, loadFromDisk };
