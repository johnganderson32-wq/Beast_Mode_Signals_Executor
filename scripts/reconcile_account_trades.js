'use strict';
// One-shot reconciliation: pull all broker trades for account 13146982
// from 2026-04-20 through now, group by orderId, and cross-reference
// against BEAST's audit log (logs/trades.jsonl). Read-only.

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const px    = require('../src/projectx');

const ACCT         = 13146982;
const WINDOW_START = '2026-04-20T00:00:00Z';
const WINDOW_END   = new Date().toISOString();
const TRADES_FILE  = path.join(__dirname, '..', 'logs', 'trades.jsonl');

function loadAuditTrades() {
    const trades = new Map();
    for (const line of fs.readFileSync(TRADES_FILE, 'utf8').split('\n').filter(Boolean)) {
        const r = JSON.parse(line);
        if (r._op === 'insert') {
            trades.set(r.id, { ...r, _updates: [] });
        } else if (r._op === 'update') {
            const t = trades.get(r.id);
            if (t) {
                t._updates.push(r);
                for (const [k, v] of Object.entries(r)) {
                    if (k === '_op' || k === '_v' || k === 'id') continue;
                    if (k === 'orderIds' && t.orderIds) Object.assign(t.orderIds, v);
                    else t[k] = v;
                }
            }
        }
    }
    return [...trades.values()].sort((a, b) => a.id - b.id);
}

(async () => {
    await px.authenticate();
    const token = px.getToken();
    const H = { headers: { Authorization: `Bearer ${token}` } };

    const tR = await axios.post(
        'https://api.topstepx.com/api/Trade/search',
        { accountId: ACCT, startTimestamp: WINDOW_START, endTimestamp: WINDOW_END },
        H
    );
    const brokerTrades = (tR.data.trades || []).filter(t => !t.voided);

    // Group broker fills by orderId
    const fillsByOrder = new Map();
    for (const t of brokerTrades) {
        if (!fillsByOrder.has(t.orderId)) fillsByOrder.set(t.orderId, []);
        fillsByOrder.get(t.orderId).push(t);
    }

    console.log(`\n====== BROKER TRADE/SEARCH — account ${ACCT} ======`);
    console.log(`Window: ${WINDOW_START}  →  ${WINDOW_END}`);
    console.log(`Total non-voided executions: ${brokerTrades.length}`);
    console.log(`Distinct orderIds: ${fillsByOrder.size}`);

    let grossPnl = 0;
    let totalFees = 0;
    let totalComm = 0;
    for (const t of brokerTrades) {
        if (t.profitAndLoss != null) grossPnl += t.profitAndLoss;
        totalFees += (t.fees ?? 0);
        totalComm += (t.commission ?? 0);
    }
    console.log(`Sum profitAndLoss on this account: $${grossPnl.toFixed(2)}`);
    console.log(`Sum fees:       $${totalFees.toFixed(2)}`);
    console.log(`Sum commission: $${totalComm.toFixed(2)}`);
    console.log(`Net after fees + comm:             $${(grossPnl - totalFees - totalComm).toFixed(2)}`);

    // BEAST audit log
    const audit = loadAuditTrades();
    console.log(`\n====== BEAST AUDIT LOG (logs/trades.jsonl) ======`);
    console.log(`Total inserts: ${audit.length}`);

    const auditOrderIds = new Set();
    console.log(`\n--- Per BEAST trade row: broker match? ---`);
    for (const a of audit) {
        const entryId  = a.orderIds?.entry;
        const slId     = a.orderIds?.sl;
        const tp1Id    = a.orderIds?.tp1;
        const targetId = a.orderIds?.target;
        [entryId, slId, tp1Id, targetId].forEach(x => { if (x) auditOrderIds.add(x); });

        const match = entryId ? fillsByOrder.has(entryId) : false;
        const brokerFills = entryId ? (fillsByOrder.get(entryId) || []) : [];
        console.log(`id=${a.id} ${a.timestamp?.slice(0,19)}Z qty=${a.qty} ${a.direction} status=${a.status} pnl=$${a.pnlDollars ?? 'null'} entryOrderId=${entryId || '(none)'} brokerHasEntry=${match} brokerEntryFills=${brokerFills.length}`);
    }

    // Broker orders NOT referenced by any BEAST audit row
    const unaudited = [];
    for (const [oid, fills] of fillsByOrder) {
        if (!auditOrderIds.has(oid)) unaudited.push({ orderId: oid, fills });
    }
    console.log(`\n--- Broker orderIds NOT in BEAST audit (${unaudited.length}) ---`);
    for (const u of unaudited) {
        const f = u.fills;
        const totalSize = f.reduce((s, x) => s + (x.size || 0), 0);
        const totalPnl  = f.reduce((s, x) => s + (x.profitAndLoss || 0), 0);
        const firstTs   = f[0]?.creationTimestamp;
        const contract  = f[0]?.contractId;
        console.log(`  orderId=${u.orderId}  ${contract}  firstFill=${firstTs}  fills=${f.length}  totalSize=${totalSize}  sumPnl=$${totalPnl.toFixed(2)}`);
    }

    // Per-entry-order: full fill detail for BEAST rows
    console.log(`\n--- Detailed fills for each BEAST entry-order ---`);
    for (const a of audit) {
        const entryId = a.orderIds?.entry;
        if (!entryId) continue;
        const groupIds = [a.orderIds.entry, a.orderIds.sl, a.orderIds.tp1, a.orderIds.target].filter(Boolean);
        const allFills = groupIds.flatMap(id => fillsByOrder.get(id) || []);
        if (allFills.length === 0) {
            console.log(`BEAST id=${a.id}: NO broker fills found for any of its order IDs ${groupIds.join(',')}`);
            continue;
        }
        const sidePnl = allFills.reduce((s, x) => s + (x.profitAndLoss || 0), 0);
        const fees    = allFills.reduce((s, x) => s + (x.fees || 0), 0);
        const comm    = allFills.reduce((s, x) => s + (x.commission || 0), 0);
        console.log(`\nBEAST id=${a.id} (${a.timestamp?.slice(0,19)}Z ${a.direction} qty=${a.qty}): broker pnl=$${sidePnl.toFixed(2)}  fees=$${fees.toFixed(2)}  comm=$${comm.toFixed(2)}  net=$${(sidePnl-fees-comm).toFixed(2)}  (BEAST recorded pnl=$${a.pnlDollars}, comm=$${a.commission})`);
        for (const f of allFills) {
            const side = f.side === 0 ? 'BUY ' : 'SELL';
            const tag  = f.customTag ? ` tag=${f.customTag}` : '';
            console.log(`  ${f.creationTimestamp}  ${side} ${f.size}@${f.price}  orderId=${f.orderId}  pnl=${f.profitAndLoss ?? 0}  fees=${f.fees ?? 0}  comm=${f.commission ?? 0}${tag}`);
        }
    }
})().catch(e => { console.error('ERROR:', e.message, e.response?.data); process.exit(1); });
