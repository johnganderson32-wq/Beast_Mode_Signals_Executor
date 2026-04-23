'use strict';

const express   = require('express');
const db        = require('./db');
const settings  = require('./settings');
const risk      = require('./risk');
const logStream = require('./log-stream');
const px        = require('./projectx');
const monitor   = require('./monitor');
const contracts = require('./contracts');
const journal   = require('./journal');
const pnlAudit  = require('./pnlAudit');
const { fetchAccounts } = require('../scripts/fetchAccounts');

const ACCOUNTS_TTL_MS = 60 * 1000;
let accountsCache = null;
let accountsCacheAt = 0;

function createDashboardRouter() {
    const router = express.Router();

    // ── Health (connection dots) ────────────────────────────────────────────
    router.get('/health', async (req, res) => {
        const auth = px.getAuthStatus();
        let ngrokOk = false;
        const ngrokUrl = process.env.NGROK_URL || '';
        if (ngrokUrl) {
            try {
                const ctrl  = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 3000);
                const r = await fetch(`${ngrokUrl}/webhook/signal`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    '{}',
                    signal:  ctrl.signal,
                });
                clearTimeout(timer);
                ngrokOk = r.ok;
            } catch {}
        }
        const subs = monitor.getSubscribedContracts ? monitor.getSubscribedContracts() : [];
        const quotes = {};
        if (monitor.getLastQuote) {
            for (const cid of subs) {
                const q = monitor.getLastQuote(cid);
                if (q) quotes[cid] = { last: q.last, bid: q.bid, ask: q.ask, ageMs: Date.now() - q.ts };
            }
        }
        res.json({
            projectx: auth,
            ngrok:    { connected: ngrokOk, url: ngrokUrl || null },
            rtc:      { connected: monitor.isConnected() },
            marketHub:{
                connected:  monitor.isMarketConnected ? monitor.isMarketConnected() : false,
                subscribed: subs,
                quotes,
            },
        });
    });

    // ── Status ──────────────────────────────────────────────────────────────
    router.get('/status', (req, res) => {
        const allTrades   = db.getAll();
        const open        = db.getOpen();
        const today       = tradingDayStr();
        const openFamilies = new Set(open.map(t => t.family).filter(Boolean));

        const todayTrades  = allTrades.filter(t => (t.timestamp || '').slice(0, 10) === today);
        const todayClosed  = todayTrades.filter(t => t.status !== 'OPEN');
        const signalsToday = todayTrades.length;

        res.json({
            tradingEnabled: risk.isTradingEnabled(),
            dailyPnl:       Math.round(risk.getDailyPnl() * 100) / 100,   // dollars
            blockReason:    risk.getBlockReason(openFamilies),
            bias:           risk.getBias(),
            activeTrade:    open[0] || null,
            openTrades:     open,
            lastTrade:      todayClosed.length ? todayClosed[todayClosed.length - 1] : null,
            signalsToday,
            signalCounts:   risk.getSignalCounts(),
            consecutiveLosses: risk.getConsecutiveLosses(),
            circuitBreakerResumeAt: risk.getCircuitBreakerResumeAt(),
            settings:       settings.getAll(),
        });
    });

    // ── Settings ────────────────────────────────────────────────────────────
    router.get('/settings', (req, res) => {
        res.json(settings.getAll());
    });

    // ── Accounts (for account selector dropdown) ───────────────────────────
    router.get('/accounts', async (req, res) => {
        try {
            const now = Date.now();
            if (!accountsCache || now - accountsCacheAt > ACCOUNTS_TTL_MS) {
                const fresh = await fetchAccounts({ onlyActiveAccounts: true });
                accountsCache = fresh.map(a => ({
                    id:       a.id,
                    label:    a.label,
                    canTrade: !!a.canTrade,
                    balance:  a.balance,
                }));
                accountsCacheAt = now;
            }
            const storedId = settings.get('accountId') || '';
            const storedInList = !storedId || accountsCache.some(a => String(a.id) === String(storedId));
            if (storedId && !storedInList) {
                console.warn(`[accounts] stored accountId=${storedId} not in current account list`);
            }
            res.json({ accounts: accountsCache, storedId, storedInList });
        } catch (e) {
            console.error(`[accounts] fetch failed: ${e.message}`);
            res.status(502).json({ error: e.message });
        }
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
        risk.setTradingEnabled(!risk.isTradingEnabled());
        res.json({ tradingEnabled: risk.isTradingEnabled() });
    });

    // ── Direction bias (per family) ─────────────────────────────────────────
    router.post('/bias', (req, res) => {
        const { instrument, bias } = req.body || {};
        const family = contracts.normalizeInstrument(instrument || '');
        if (!['NQ', 'GC', 'ES'].includes(family)) {
            return res.status(400).json({ error: 'instrument must resolve to NQ, GC, or ES' });
        }
        if (!['ALL', 'LONG', 'SHORT'].includes(bias)) {
            return res.status(400).json({ error: 'Invalid bias' });
        }
        risk.setBias(family, bias);
        res.json({ ok: true, family, bias });
    });

    // ── SSE log stream ──────────────────────────────────────────────────────
    router.get('/log/stream', (req, res) => {
        logStream.addClient(res);
    });

    // ── Flatten — broker-side close + DB update with real fill price ────────
    // Manual flatten: does NOT count toward the consecutive-loss streak.
    router.post('/flatten', async (req, res) => {
        console.warn('[flatten] Manual flatten requested');
        const open = db.getOpen();
        if (open.length === 0) return res.json({ ok: true, closed: 0 });

        // Flatten each distinct contract present in open trades
        const byContract = new Map();
        for (const t of open) {
            if (!t.contractId) continue;
            if (!byContract.has(t.contractId)) byContract.set(t.contractId, []);
            byContract.get(t.contractId).push(t);
        }

        let closed = 0;
        for (const [contractId, tradesForContract] of byContract) {
            try {
                const result   = await px.flattenPosition(contractId);
                const fillPx   = result.closeOrderId ? await px.waitForFillPrice(result.closeOrderId) : null;
                const exitTime = new Date().toISOString();

                for (const t of tradesForContract) {
                    let pnlPoints = null, pnlDollars = null, commission = null, rMultiple = null, grossDollars = 0;
                    if (fillPx != null && t.entryPrice != null) {
                        const raw = fillPx - t.entryPrice;
                        pnlPoints  = t.direction === 'bullish' ? raw : -raw;
                        pnlPoints  = Math.round(pnlPoints * 100) / 100;
                        grossDollars = contracts.pointsToDollars(pnlPoints, t.contractId) * (t.qty || 1);
                        commission   = Math.round(contracts.getCommissionPerContract(t.contractId) * (t.qty || 1) * 100) / 100;
                        pnlDollars   = Math.round((grossDollars - commission) * 100) / 100;
                        if (t.rDist > 0) rMultiple = Math.round((pnlPoints / t.rDist) * 100) / 100;
                        risk.addPnl(pnlDollars);
                    }
                    db.update(t.id, {
                        status:     'MANUAL',
                        exitPrice:  fillPx,
                        exitTime,
                        pnlPoints,
                        pnlDollars,
                        commission,
                        rMultiple,
                    });
                    // Mirror to journal so the Performance tab + 16:30 audit see this close.
                    try {
                        journal.addTradePnl(t.id, Math.round(grossDollars * 100) / 100);
                        journal.finalizeTrade(t.id, 'MANUAL', commission || 0);
                    } catch (jerr) { console.warn(`[flatten] journal mirror: ${jerr.message}`); }
                    // MANUAL does not touch the streak
                    closed++;
                }
                logStream.addLine(`[FLATTEN] ${contractId} close=${fillPx ?? 'unknown'} (${tradesForContract.length} trade${tradesForContract.length === 1 ? '' : 's'})`);
            } catch (e) {
                console.error(`[flatten] ${contractId} failed: ${e.message}`);
            }
        }

        res.json({ ok: true, closed });
    });

    // ── Trades ──────────────────────────────────────────────────────────────
    router.get('/trades',      (req, res) => res.json(db.getAll()));
    router.get('/trades/open', (req, res) => res.json(db.getOpen()));

    // ── Stats ───────────────────────────────────────────────────────────────
    router.get('/stats', (req, res) => res.json(db.getStats()));

    // ── Manual outcome update ───────────────────────────────────────────────
    // When the outcome is TP1 / TARGET / STOPPED the streak and P&L move with
    // the update; MANUAL still records but is a streak no-op.
    router.patch('/trades/:id', (req, res) => {
        const id    = parseInt(req.params.id, 10);
        const trade = db.getById(id);
        if (!trade) return res.status(404).json({ error: 'Trade not found' });

        const { status, exitPrice, exitTime } = req.body || {};
        if (!['TP1', 'TARGET', 'STOPPED', 'MANUAL'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const now  = exitTime || new Date().toISOString();
        const exit = exitPrice != null && exitPrice !== '' ? parseFloat(exitPrice) : null;

        let rMultiple = null, pnlPoints = null, pnlDollars = null, commission = null, grossDollars = 0;
        if (exit !== null && trade.entryPrice != null) {
            const raw = exit - trade.entryPrice;
            pnlPoints    = trade.direction === 'bullish' ? raw : -raw;
            pnlPoints    = Math.round(pnlPoints * 100) / 100;
            grossDollars = contracts.pointsToDollars(pnlPoints, trade.contractId) * (trade.qty || 1);
            commission   = Math.round(contracts.getCommissionPerContract(trade.contractId) * (trade.qty || 1) * 100) / 100;
            pnlDollars   = Math.round((grossDollars - commission) * 100) / 100;
            if (trade.rDist > 0) rMultiple = Math.round((pnlPoints / trade.rDist) * 100) / 100;
        }

        const updated = db.update(id, { status, exitPrice: exit, exitTime: now, rMultiple, pnlPoints, pnlDollars, commission });

        // Mirror to journal so /api/journal views + 16:30 audit see this close.
        try {
            if (pnlDollars != null) journal.addTradePnl(id, Math.round(grossDollars * 100) / 100);
            journal.finalizeTrade(id, status, commission || 0);
        } catch (jerr) { console.warn(`[trades PATCH] journal mirror: ${jerr.message}`); }

        // Wire into risk: add P&L (dollars) + update consec-loss streak
        if (pnlDollars != null) risk.addPnl(pnlDollars);
        risk.recordTradeResult(status, pnlDollars || 0);

        res.json(updated);
    });

    // ── Journal views (per-day trade list + stats) ──────────────────────────
    // GET /api/journal/dates             — list of YYYY-MM-DD with journal files
    // GET /api/journal?date=YYYY-MM-DD   — trades + stats for one trading day
    // GET /api/journal/all               — all-time aggregate + per-day rollup
    router.get('/journal/dates', (req, res) => {
        try {
            res.json({ dates: journal.getJournalDates() });
        } catch (e) {
            console.error(`[journal dates] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/journal', (req, res) => {
        try {
            const date      = req.query.date || journal.tradingDayStr();
            const accountId = req.query.accountId || null;
            const stats     = journal.getStats(date, accountId);
            res.json({ date, ...stats });
        } catch (e) {
            console.error(`[journal] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/journal/all', (req, res) => {
        try {
            const accountId = req.query.accountId || null;
            res.json(journal.getAggregateStats(accountId));
        } catch (e) {
            console.error(`[journal all] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // ── P&L audit API ──────────────────────────────────────────────────────
    // GET  /api/audit/queue         — current queue + halt status + thresholds
    // POST /api/audit/manual-flag   — append a manual entry (body: note, orderId?, delta?)
    // POST /api/audit/mark-reviewed — archive queue; clears halt if active
    // POST /api/audit/re-enable     — clears halt only (queue retained)
    router.get('/audit/queue', (req, res) => {
        try {
            const queue = pnlAudit.getQueue();
            const halt  = pnlAudit.getHaltInfo();
            res.json({
                queue,
                halted:          halt.halted,
                haltedAt:        halt.haltedAt,
                cumulativeDelta: halt.cumulativeDelta,
                flagThreshold:   pnlAudit.FLAG_DELTA_USD,
                haltThreshold:   pnlAudit.HALT_DELTA_USD,
            });
        } catch (e) {
            console.error(`[audit queue] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/audit/manual-flag', (req, res) => {
        try {
            const entry = pnlAudit.manualFlag(req.body || {});
            console.log(`[AUDIT] Manual flag added: ${JSON.stringify(entry)}`);
            res.json({ ok: true, entry });
        } catch (e) {
            console.error(`[audit manual-flag] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/audit/mark-reviewed', (req, res) => {
        try {
            const result = pnlAudit.markReviewed();
            console.log(`[AUDIT] Mark-reviewed: archived=${result.archived} clearedHalt=${result.clearedHalt}`);
            res.json({ ok: true, ...result });
        } catch (e) {
            console.error(`[audit mark-reviewed] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/audit/re-enable', (req, res) => {
        try {
            const result = pnlAudit.reEnable();
            console.log(`[AUDIT] Re-enable: clearedHalt=${result.clearedHalt}`);
            res.json({ ok: true, ...result });
        } catch (e) {
            console.error(`[audit re-enable] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

// Trading day string: ≥18:00 ET = next calendar day (matches risk.js)
function tradingDayStr() {
    const now = new Date();
    const etHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(now));
    const ref = new Date(etHour >= 18 ? now.getTime() + 24 * 60 * 60 * 1000 : now.getTime());
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
}

module.exports = { createDashboardRouter };
