'use strict';

const express    = require('express');
const db         = require('./db');
const settings   = require('./settings');
const logStream  = require('./log-stream');
const px         = require('./projectx');

function createDashboardRouter() {
    const router = express.Router();

    // ── Health (connection dots) ────────────────────────────────────────────
    router.get('/health', async (req, res) => {
        const auth  = px.getAuthStatus();
        // Ngrok: check if our own webhook is reachable via the public URL
        let ngrokOk = false;
        const ngrokUrl = process.env.NGROK_URL || '';
        if (ngrokUrl) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 3000);
                const r = await fetch(`${ngrokUrl}/webhook/signal`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                    signal: ctrl.signal,
                });
                clearTimeout(timer);
                ngrokOk = r.ok;
            } catch {}
        }
        res.json({
            projectx: auth,
            ngrok:    { connected: ngrokOk, url: ngrokUrl || null },
            rtc:      { connected: false, reason: 'not yet implemented' },
        });
    });

    // ── Status ──────────────────────────────────────────────────────────────
    router.get('/status', (req, res) => {
        const allTrades = db.getAll();
        const open      = db.getOpen();
        const today     = tradingDayStr();

        const todayTrades = allTrades.filter(t => (t.timestamp || '').slice(0, 10) === today);
        const todayClosed = todayTrades.filter(t => t.status !== 'OPEN');
        const dailyPnl    = todayClosed.reduce((s, t) => s + (t.pnlPoints || 0), 0);
        const signalsToday = todayTrades.length;

        res.json({
            tradingEnabled: settings.get('tradingEnabled'),
            nqBias:         settings.get('nqBias'),
            activeTrade:    open[0] || null,
            lastTrade:      todayClosed.length ? todayClosed[todayClosed.length - 1] : null,
            dailyPnl:       Math.round(dailyPnl * 100) / 100,
            signalsToday,
            settings:       settings.getAll(),
        });
    });

    // ── Settings ────────────────────────────────────────────────────────────
    router.get('/settings', (req, res) => {
        res.json(settings.getAll());
    });

    router.post('/settings', (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object') {
            return res.status(400).json({ error: 'Invalid body' });
        }
        settings.merge(body);
        console.log('[settings] Updated:', Object.keys(body).join(', '));
        res.json({ ok: true, settings: settings.getAll() });
    });

    // ── Trading toggle ──────────────────────────────────────────────────────
    router.post('/trading/toggle', (req, res) => {
        const current = settings.get('tradingEnabled');
        settings.set('tradingEnabled', !current);
        const state = !current ? 'ON' : 'OFF';
        console.log(`[settings] Trading toggled ${state}`);
        res.json({ tradingEnabled: !current });
    });

    // ── Bias ────────────────────────────────────────────────────────────────
    router.post('/bias', (req, res) => {
        const { instrument, bias } = req.body || {};
        if (!['ALL', 'LONG', 'SHORT'].includes(bias)) {
            return res.status(400).json({ error: 'Invalid bias' });
        }
        // For now only NQ bias is supported
        settings.set('nqBias', bias);
        console.log(`[settings] NQ bias set to ${bias}`);
        res.json({ ok: true, nqBias: bias });
    });

    // ── SSE log stream ──────────────────────────────────────────────────────
    router.get('/log/stream', (req, res) => {
        logStream.addClient(res);
    });

    // ── Flatten ─────────────────────────────────────────────────────────────
    router.post('/flatten', (req, res) => {
        console.warn('[flatten] Manual flatten requested — clearing open trades from DB');
        const openTrades = db.getOpen();
        for (const t of openTrades) {
            db.update(t.id, {
                status:    'MANUAL',
                exitTime:  new Date().toISOString(),
                pnlPoints: 0,
                rMultiple: 0,
            });
        }
        res.json({ ok: true, closed: openTrades.length });
    });

    // ── Trades ──────────────────────────────────────────────────────────────
    router.get('/trades', (req, res) => {
        res.json(db.getAll());
    });

    router.get('/trades/open', (req, res) => {
        res.json(db.getOpen());
    });

    // ── Stats ───────────────────────────────────────────────────────────────
    router.get('/stats', (req, res) => {
        res.json(db.getStats());
    });

    // ── Manual outcome update ───────────────────────────────────────────────
    router.patch('/trades/:id', (req, res) => {
        const id    = parseInt(req.params.id, 10);
        const trade = db.getAll().find(t => t.id === id);
        if (!trade) return res.status(404).json({ error: 'Trade not found' });

        const { status, exitPrice, exitTime } = req.body;
        if (!['TP1', 'TARGET', 'STOPPED', 'MANUAL'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const now  = exitTime || new Date().toISOString();
        const exit = exitPrice != null ? parseFloat(exitPrice) : null;

        let rMultiple = null;
        let pnlPoints = null;
        if (exit !== null && trade.rDist > 0) {
            const raw = exit - trade.entryPrice;
            pnlPoints  = trade.direction === 'bullish' ? raw : -raw;
            rMultiple  = Math.round((pnlPoints / trade.rDist) * 100) / 100;
            pnlPoints  = Math.round(pnlPoints * 100) / 100;
        }

        const updated = db.update(id, { status, exitPrice: exit, exitTime: now, rMultiple, pnlPoints });
        res.json(updated);
    });

    return router;
}

// Trading day string: 18:00+ ET = next calendar day
function tradingDayStr() {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const etHour = parseInt(etStr, 10);
    const ref = etHour >= 18 ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : now;
    return ref.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

module.exports = { createDashboardRouter };
