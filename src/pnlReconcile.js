'use strict';

// ---------------------------------------------------------------------------
// P&L reconciliation — matches broker /Trade/search closing trades against
// executor journal records and computes per-order deltas.
//
// Matching rule:
//   Each broker trade carries `orderId`. The executor's journal records carry
//   entry/exit order IDs (patched on close). A broker closing trade matches
//   the journal record whose set of order IDs (entryOrderId, slOrderId,
//   tp1OrderId, tp2OrderId) contains the broker trade's orderId.
//
// A single journal record can match multiple broker closing trades (TP1 + SL,
// TP1 + TP2, etc.). That's correct: the per-leg broker P&L is then compared
// against the executor's total realized P&L for that journal row. The spec
// asks for a per-order delta — we emit one delta per broker closing trade,
// with `executor_netPnl` holding the journal's full netPnl so the sum across
// legs equals the executor's view of that journal row.
//
// Half-turns (profitAndLoss === null) and voided trades are skipped.
// Unmatched broker trades + unmatched executor orders are returned for
// John's manual review — not a halt condition.
//
// Ported from EvilSignals-Executor verbatim 2026-04-22. Pure function — no
// filesystem or network side effects. Safe to call repeatedly.
// ---------------------------------------------------------------------------

// Collect the executor order IDs tracked on a journal record.
function executorOrderIdsFor(rec) {
    const ids = [];
    for (const k of ['entryOrderId', 'slOrderId', 'tp1OrderId', 'tp2OrderId']) {
        const v = rec[k];
        if (v != null && v !== '') ids.push(String(v));
    }
    return ids;
}

function reconcileSession({ trades, executorOrders }) {
    const broker = Array.isArray(trades) ? trades : [];
    const recs   = Array.isArray(executorOrders) ? executorOrders : [];

    // Build an index: brokerOrderId -> journal record(s)
    const byOrderId = new Map();
    for (const rec of recs) {
        for (const oid of executorOrderIdsFor(rec)) {
            if (!byOrderId.has(oid)) byOrderId.set(oid, []);
            byOrderId.get(oid).push(rec);
        }
    }

    // Track which executor records were matched at least once
    const matchedRecIds = new Set();

    const deltas = [];
    const unmatchedBrokerTrades = [];

    for (const t of broker) {
        if (t.voided === true) continue;
        if (t.profitAndLoss == null) continue; // half-turn entry

        const brokerPnl     = Number(t.profitAndLoss) || 0;
        const brokerFees    = Number(t.fees) || 0;
        const broker_netPnl = brokerPnl - brokerFees;

        const matches = byOrderId.get(String(t.orderId)) || [];
        if (!matches.length) {
            unmatchedBrokerTrades.push({
                orderId:      t.orderId,
                tradeId:      t.id,
                contractId:   t.contractId,
                timestamp:    t.creationTimestamp,
                brokerNetPnl: parseFloat(broker_netPnl.toFixed(4)),
                brokerFees:   brokerFees,
                reason:       'no_executor_order_id_match',
            });
            continue;
        }

        // Prefer exact single match; if multiple records share an orderId
        // (shouldn't happen in practice but guard for it), take the first.
        const rec = matches[0];
        matchedRecIds.add(rec.id);

        const executorPnl        = Number(rec.pnl) || 0;
        const executorCommission = Number(rec.commission) || 0;
        const executor_netPnl    = executorPnl - executorCommission;
        const delta              = executor_netPnl - broker_netPnl;

        deltas.push({
            orderId:         t.orderId,
            tradeId:         t.id,
            localTradeId:    rec.id,
            contractId:      t.contractId,
            timestamp:       t.creationTimestamp,
            symbol:          rec.symbol || null,
            side:            rec.side   || null,
            delta:           parseFloat(delta.toFixed(4)),
            executor_netPnl: parseFloat(executor_netPnl.toFixed(4)),
            broker_netPnl:   parseFloat(broker_netPnl.toFixed(4)),
        });
    }

    // Executor orders that never matched any broker trade this session — could
    // indicate a broker export gap or an executor-side phantom. Flag for review.
    const unmatchedExecutorOrders = [];
    for (const rec of recs) {
        if (matchedRecIds.has(rec.id)) continue;
        if (rec.outcome === 'OPEN' || rec.type === 'blocked') continue;
        unmatchedExecutorOrders.push({
            localTradeId:     rec.id,
            symbol:           rec.symbol || null,
            side:             rec.side   || null,
            outcome:          rec.outcome || null,
            openedAt:         rec.openedAt || null,
            closedAt:         rec.closedAt || null,
            executorOrderIds: executorOrderIdsFor(rec),
            reason:           'no_broker_trade_match',
        });
    }

    return { deltas, unmatchedBrokerTrades, unmatchedExecutorOrders };
}

module.exports = {
    reconcileSession,
    executorOrderIdsFor,
};
