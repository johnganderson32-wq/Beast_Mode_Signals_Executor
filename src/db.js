'use strict';

// In-memory trade store — persists for the lifetime of the process.
// All trades are kept in insertion order.

const trades = [];
let nextId = 1;

function insert(trade) {
    const record = {
        id:              nextId++,
        timestamp:       new Date().toISOString(),
        instrument:      trade.instrument,
        direction:       trade.direction,
        entryPrice:      trade.entryPrice,
        stop:            trade.stop,
        tp1:             trade.tp1,
        target:          trade.target,
        rDist:           trade.rDist,
        compression:     trade.compression,
        entryHour:       trade.entryHour,
        macroTransition: trade.macroTransition,
        h4ZoneId:        trade.h4ZoneId,
        status:          'OPEN',   // OPEN | TP1 | TARGET | STOPPED | MANUAL
        exitPrice:       null,
        exitTime:        null,
        rMultiple:       null,
        pnlPoints:       null,
    };
    trades.push(record);
    return record;
}

function update(id, fields) {
    const t = trades.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, fields);
    return t;
}

function getAll() {
    return trades.slice();
}

function getOpen() {
    return trades.filter(t => t.status === 'OPEN');
}

// Analytics computed on demand from closed trades
function getStats() {
    const closed = trades.filter(t => t.status !== 'OPEN');
    if (closed.length === 0) {
        return { trades: 0, winRate: null, expectancy: null, profitFactor: null, netPoints: null };
    }

    const wins    = closed.filter(t => t.status === 'TP1' || t.status === 'TARGET');
    const losses  = closed.filter(t => t.status === 'STOPPED');
    const winRate = wins.length / closed.length;

    const totalWin  = wins.reduce((s, t)  => s + (t.rMultiple || 0), 0);
    const totalLoss = losses.reduce((s, t) => s + Math.abs(t.rMultiple || 0), 0);

    const expectancy   = (totalWin - totalLoss) / closed.length;
    const profitFactor = totalLoss === 0 ? null : totalWin / totalLoss;
    const netPoints    = closed.reduce((s, t) => s + (t.pnlPoints || 0), 0);

    // Net by calendar month  (YYYY-MM)
    const monthly = {};
    for (const t of closed) {
        const mo = t.exitTime ? t.exitTime.slice(0, 7) : t.timestamp.slice(0, 7);
        monthly[mo] = (monthly[mo] || 0) + (t.pnlPoints || 0);
    }

    return {
        trades:       closed.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      Math.round(winRate * 1000) / 10,   // percentage, 1 dp
        expectancy:   Math.round(expectancy * 100) / 100,
        profitFactor: profitFactor !== null ? Math.round(profitFactor * 100) / 100 : null,
        netPoints:    Math.round(netPoints * 100) / 100,
        monthly,
    };
}

module.exports = { insert, update, getAll, getOpen, getStats };
