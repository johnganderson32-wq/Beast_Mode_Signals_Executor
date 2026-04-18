'use strict';

const express    = require('express');
const db         = require('./db');
const px         = require('./projectx');
const settings   = require('./settings');
const logStream  = require('./log-stream');

// Required fields from the BEAST Mode Pine payload
const REQUIRED = ['instrument', 'direction', 'action', 'setup', 'price', 'stop', 'tp1', 'target'];

function validate(payload) {
    for (const field of REQUIRED) {
        if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
            return `Missing field: ${field}`;
        }
    }
    if (String(payload.action).toUpperCase() !== 'ENTRY') {
        return `Unsupported action: ${payload.action}`;
    }
    if (String(payload.setup).toUpperCase() !== 'BEAST') {
        return `Unsupported setup: ${payload.setup}`;
    }
    if (!['bullish', 'bearish'].includes(String(payload.direction).toLowerCase())) {
        return `Invalid direction: ${payload.direction}`;
    }
    return null;
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

        // Reject empty payloads (TV multi-destination blank delivery)
        if (!payload || Object.keys(payload).length === 0) {
            console.log('[webhook] Empty payload — ignored');
            return res.status(200).json({ status: 'ignored', reason: 'empty' });
        }

        const err = validate(payload);
        if (err) {
            console.warn(`[webhook] Invalid payload: ${err}`, payload);
            return res.status(400).json({ error: err });
        }

        const {
            instrument, direction, price: entryPrice,
            stop, tp1, target, rDist, compression,
            entryHour, macroTransition, h4ZoneId,
        } = payload;

        console.log(`[webhook] BEAST ${direction.toUpperCase()} ${instrument}  entry=${entryPrice}  SL=${stop}  TP1=${tp1}  T=${target}`);

        // ── Trading enabled check ──
        if (!settings.get('tradingEnabled')) {
            console.log('[webhook] Signal blocked — trading is disabled');
            return res.status(200).json({ status: 'blocked', reason: 'trading_disabled' });
        }

        // ── Bias check ──
        const nqBias = settings.get('nqBias');
        const dir    = String(direction).toLowerCase();
        if (nqBias !== 'ALL') {
            if (nqBias === 'LONG' && dir === 'bearish') {
                console.log('[webhook] Signal blocked — NQ bias is LONG only, got bearish');
                return res.status(200).json({ status: 'blocked', reason: 'bias_long_only' });
            }
            if (nqBias === 'SHORT' && dir === 'bullish') {
                console.log('[webhook] Signal blocked — NQ bias is SHORT only, got bullish');
                return res.status(200).json({ status: 'blocked', reason: 'bias_short_only' });
            }
        }

        // Record the trade
        const trade = db.insert({
            instrument, direction, entryPrice, stop, tp1, target,
            rDist:           rDist           ?? null,
            compression:     compression     ?? null,
            entryHour:       entryHour       ?? null,
            macroTransition: macroTransition ?? null,
            h4ZoneId:        h4ZoneId        ?? null,
        });

        // Place order via ProjectX
        let orderResult = null;
        let orderError  = null;
        try {
            orderResult = await px.placeOrder({ instrument, direction, stop, tp1, target });
            logStream.addLine(`[ENTRY] BEAST ${direction.toUpperCase()} ${instrument} entry=${entryPrice} SL=${stop} TP1=${tp1} T=${target}`);
        } catch (e) {
            orderError = e.message;
            console.error(`[webhook] Order failed: ${e.message}`);
            db.update(trade.id, { status: 'MANUAL', exitTime: new Date().toISOString() });
        }

        return res.status(200).json({
            status:   orderError ? 'order_failed' : 'accepted',
            tradeId:  trade.id,
            order:    orderResult,
            error:    orderError,
        });
    });

    return router;
}

module.exports = { createWebhookRouter };
