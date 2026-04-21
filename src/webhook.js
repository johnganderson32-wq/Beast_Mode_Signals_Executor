'use strict';

const fs        = require('fs');
const path      = require('path');
const express   = require('express');
const db        = require('./db');
const px        = require('./projectx');
const risk      = require('./risk');
const settings  = require('./settings');
const contracts = require('./contracts');
const logStream = require('./log-stream');
const executor  = require('./executor');
const { LOG_DIR } = require('./paths');

// Required fields from the BEAST Mode Pine payload
const REQUIRED = ['instrument', 'direction', 'action', 'setup', 'price', 'stop', 'tp1', 'target'];

// Max age between Pine bar close and webhook receipt. Past this, the entry
// edge is gone — reject rather than fill stale. Pine v3+ attaches barCloseMs
// (UTC epoch, same scale as Date.now). Payloads without the field are legacy
// and pass through with a warning so we don't hard-fail during rollout.
const STALE_SIGNAL_MS = 5000;

// Append-only audit log of every validated webhook signal and how we handled
// it. Skips auth failures and empty-body pings (those aren't real signals).
const SIGNALS_FILE = path.join(LOG_DIR, 'signals.jsonl');

function logSignal(payload, disposition, extra = {}) {
    try {
        const dir = path.dirname(SIGNALS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const entry = {
            _v:         1,
            receivedAt: new Date().toISOString(),
            disposition,
            ...extra,
            payload,
        };
        fs.appendFileSync(SIGNALS_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn(`[webhook] signals log failed: ${e.message}`);
    }
}

function validate(payload) {
    for (const field of REQUIRED) {
        if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
            return `Missing field: ${field}`;
        }
    }
    if (String(payload.action).toUpperCase() !== 'ENTRY') return `Unsupported action: ${payload.action}`;
    if (String(payload.setup).toUpperCase()  !== 'BEAST') return `Unsupported setup: ${payload.setup}`;
    if (!['bullish', 'bearish'].includes(String(payload.direction).toLowerCase())) {
        return `Invalid direction: ${payload.direction}`;
    }
    return null;
}

// Compute order qty.
//   dynamicSizing ON  → qty = floor(perTradeLossCap$ / (slPts × $/pt))
//                       cap=0 means "block all"
//                       qty<1 means "risk insufficient for 1 contract" → block
//   dynamicSizing OFF → fixed qty per product code from settings
function computeQty({ contractId, slPoints }) {
    const spec = contracts.getSpec(contractId);
    if (!spec) return { qty: 0, reason: 'unknown_contract' };

    if (settings.get('dynamicSizing')) {
        const cap = Number(settings.get('perTradeLossCap')) || 0;
        if (cap <= 0) return { qty: 0, reason: 'per_trade_loss_cap_zero' };
        const dollarsPerContract = slPoints * spec.pointValue;
        if (dollarsPerContract <= 0) return { qty: 0, reason: 'invalid_sl_distance' };
        const qty = Math.floor(cap / dollarsPerContract);
        if (qty < 1) return { qty: 0, reason: 'per_trade_loss_cap_insufficient' };
        return { qty };
    }

    const code = spec.productCode.toLowerCase();
    const qty  = parseInt(settings.get(`${code}Contracts`), 10) || 0;
    if (qty < 1) return { qty: 0, reason: `${code}_contracts_zero` };
    return { qty };
}

function createWebhookRouter() {
    const router = express.Router();

    router.post('/signal', async (req, res) => {
        const secret = process.env.WEBHOOK_SECRET;
        if (secret && req.headers['x-webhook-secret'] !== secret) {
            console.warn('[webhook] Rejected: bad secret');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const payload = req.body;

        if (!payload || Object.keys(payload).length === 0) {
            // Silent drop — covers ngrok self-ping and TV multi-destination blanks
            return res.status(200).json({ status: 'ignored', reason: 'empty' });
        }

        const err = validate(payload);
        if (err) {
            console.warn(`[webhook] Invalid payload: ${err}`, payload);
            logSignal(payload, 'rejected', { reason: err });
            return res.status(400).json({ error: err });
        }

        // ── Staleness gate ──────────────────────────────────────────────────
        // Reject anything older than STALE_SIGNAL_MS after bar close. TV alert
        // dispatcher queue lag spikes at NQ cash open; at 10s the NQ entry is
        // already blown. Missing barCloseMs = legacy payload, warn + proceed.
        let ageMs = null;
        if (payload.barCloseMs != null) {
            ageMs = Date.now() - Number(payload.barCloseMs);
            if (Number.isFinite(ageMs) && ageMs > STALE_SIGNAL_MS) {
                console.warn(`[webhook] REJECTED STALE — ${payload.instrument} ${payload.direction} ageMs=${ageMs} > ${STALE_SIGNAL_MS}`);
                logSignal(payload, 'rejected_stale', { ageMs, budgetMs: STALE_SIGNAL_MS });
                return res.status(200).json({ status: 'rejected_stale', ageMs, budgetMs: STALE_SIGNAL_MS });
            }
        } else {
            console.warn('[webhook] payload missing barCloseMs — legacy alert, staleness check skipped');
        }

        const {
            instrument, direction, price: entryPrice,
            stop, tp1, target, rDist, compression,
            entryHour, macroTransition, h4ZoneId,
        } = payload;

        const family = contracts.normalizeInstrument(instrument);
        const ageTag = ageMs != null ? ` age=${ageMs}ms` : '';
        console.log(`[webhook] BEAST ${direction.toUpperCase()} ${instrument} (${family}) entry=${entryPrice} SL=${stop} TP1=${tp1} T=${target}${ageTag}`);

        // Identify which families currently have OPEN trades (no-hedge gate)
        const openFamilies = new Set(db.getOpen().map(t => t.family).filter(Boolean));

        // Compute SL dollar distance for the per-trade-loss-cap gate (used only
        // when dynamicSizing is OFF). We need a contract ID to get $/pt — if the
        // family isn't configured, the gate falls through and placeOrder will
        // surface the missing-contract error later.
        let slDollarsFixedQty = null;
        try {
            const cid  = px.getContractIdForFamily(family);
            const spec = contracts.getSpec(cid);
            const fixedQty = px.getFixedQty(cid);
            const slPts    = Math.abs(Number(entryPrice) - Number(stop));
            if (spec && fixedQty > 0) slDollarsFixedQty = slPts * spec.pointValue * fixedQty;
        } catch {}

        // ── Pre-trade gate stack ────────────────────────────────────────────
        const gate = risk.check({
            direction,
            family,
            slDollars: slDollarsFixedQty,
            openFamilies,
        });
        if (!gate.ok) {
            console.warn(`[webhook] BLOCKED — ${gate.reason}`);
            risk.incrementSignals(false);
            logSignal(payload, 'blocked', { reason: gate.reason });
            return res.status(200).json({ status: 'blocked', reason: gate.reason });
        }

        // ── Sizing ──────────────────────────────────────────────────────────
        let contractId;
        try {
            contractId = px.getContractIdForFamily(family);
        } catch (e) {
            console.warn(`[webhook] BLOCKED — ${e.message}`);
            risk.incrementSignals(false);
            logSignal(payload, 'blocked', { reason: 'no_contract_id', detail: e.message });
            return res.status(200).json({ status: 'blocked', reason: 'no_contract_id' });
        }
        const slPoints       = Math.abs(Number(entryPrice) - Number(stop));
        const { qty, reason: qtyReason } = computeQty({ contractId, slPoints });
        if (qty < 1) {
            console.warn(`[webhook] BLOCKED — ${qtyReason}`);
            risk.incrementSignals(false);
            logSignal(payload, 'blocked', { reason: qtyReason });
            return res.status(200).json({ status: 'blocked', reason: qtyReason });
        }

        // ── Record trade before placing order ───────────────────────────────
        const trade = db.insert({
            instrument, direction, entryPrice, stop, tp1, target,
            family, contractId, qty,
            rDist:           rDist           ?? null,
            compression:     compression     ?? null,
            entryHour:       entryHour       ?? null,
            macroTransition: macroTransition ?? null,
            h4ZoneId:        h4ZoneId        ?? null,
        });

        // ── Place orders ────────────────────────────────────────────────────
        let orderResult   = null;
        let orderError    = null;
        let orderStage    = null;
        let safetyFlatten = null;
        try {
            orderResult = await px.placeOrder({ family, direction, stop, tp1, target, qty });
            const updated = db.update(trade.id, { orderIds: orderResult.orderIds });
            logStream.addLine(`[ENTRY] BEAST ${direction.toUpperCase()} ${instrument} ${qty}ct entry=${entryPrice} SL=${stop} TP1=${tp1} T=${target}`);
            risk.incrementSignals(true);
            // Hand off to the executor so RTC events + 5s poll drive settlement
            try { executor.registerTrade(updated || trade); }
            catch (regErr) { console.warn(`[webhook] executor.registerTrade: ${regErr.message}`); }
        } catch (e) {
            orderError = e.message;
            orderStage = e.stage || null;
            console.error(`[webhook] Order failed (stage=${orderStage || 'unknown'}): ${e.message}`);

            if (e.orderIds) db.update(trade.id, { orderIds: e.orderIds });

            // Safety net: entry filled but a protective order failed → naked position.
            // Flatten at broker and cancel any working protective orders so we never
            // hold direction without SL.
            if (e.stage === 'protective' && e.orderIds?.entry && e.contractId) {
                console.error(`[webhook] SAFETY FLATTEN — entry ${e.orderIds.entry} filled but protective order failed; closing ${e.contractId}`);
                logStream.addLine(`[SAFETY FLATTEN] ${instrument} — protective order failed after entry; closing position`);
                try {
                    safetyFlatten = await px.flattenPosition(e.contractId);
                } catch (flatErr) {
                    console.error(`[webhook] Safety flatten failed: ${flatErr.message}`);
                    safetyFlatten = { closed: false, error: flatErr.message };
                }
            }

            db.update(trade.id, { status: 'MANUAL', exitTime: new Date().toISOString() });
            risk.incrementSignals(false);
        }

        logSignal(payload, orderError ? 'order_failed' : 'accepted', {
            tradeId: trade.id,
            qty,
            ...(ageMs != null ? { ageMs } : {}),
            ...(orderError     ? { error: orderError, stage: orderStage } : {}),
            ...(safetyFlatten  ? { safetyFlatten } : {}),
        });

        return res.status(200).json({
            status:  orderError ? 'order_failed' : 'accepted',
            tradeId: trade.id,
            qty,
            order:   orderResult,
            error:   orderError,
        });
    });

    return router;
}

module.exports = { createWebhookRouter };
