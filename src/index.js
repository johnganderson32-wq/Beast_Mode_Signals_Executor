'use strict';

require('dotenv').config();

// Log stream must be required early to monkey-patch console before other modules log
require('./log-stream');

const express    = require('express');
const path       = require('path');
const settings   = require('./settings');
const risk       = require('./risk');
const { createWebhookRouter }   = require('./webhook');
const { createDashboardRouter } = require('./dashboard');
const db         = require('./db');
const journal    = require('./journal');
const pnlAudit   = require('./pnlAudit');

risk.restorePnlState();
db.loadFromDisk();

// One-time journal backfill — if no journal-*.json files exist (first boot
// after the audit/journal port 2026-04-22), seed from the flat trades.jsonl.
// Idempotent: if any journal day files already exist, skip.
try {
    if (journal.getJournalDates().length === 0) {
        const existing = db.getAll();
        if (existing.length > 0) {
            console.log(`[beast-executor] No journal files found — backfilling from trades.jsonl (${existing.length} trade(s))`);
            journal.backfillFromDb(existing);
        }
    }
} catch (e) {
    console.error(`[beast-executor] journal backfill failed: ${e.message}`);
}

const PORT = parseInt(process.env.PORT || '3100', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/webhook', createWebhookRouter());
app.use('/api',     createDashboardRouter());

// Serve dashboard SPA on all non-API routes
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const px           = require('./projectx');
const executor     = require('./executor');
const sessionClose = require('./sessionClose');

app.listen(PORT, async () => {
    console.log(`[beast-executor] Listening on http://localhost:${PORT}`);
    console.log(`[beast-executor] Webhook endpoint: POST /webhook/signal`);
    console.log(`[beast-executor] Trading: ${risk.isTradingEnabled() ? 'ON' : 'OFF'}`);
    // Authenticate with ProjectX on boot so the dashboard dot goes green
    try {
        await px.authenticate();
    } catch (e) {
        console.error(`[beast-executor] ProjectX auth failed on boot: ${e.message}`);
    }

    // Start the RTC hub + 5s poll. Boot the executor even if RTC start fails —
    // the poll fallback still reconciles fills by REST alone.
    try {
        const tok = px.getToken();
        const acctId = parseInt(settings.get('accountId'), 10) || null;
        if (!acctId) {
            console.warn('[beast-executor] No accountId in logs/settings.json — RTC will not subscribe until user selects an account in the dashboard');
        }
        await executor.start(tok, acctId);
    } catch (e) {
        console.error(`[executor] start failed: ${e.message} — 5s REST poll still active`);
    }

    // Arm the scheduled force-flatten at sessionClose ET. Blank sessionClose
    // = no schedule (consistent with risk.js:isPastSessionClose semantics).
    try {
        sessionClose.start();
    } catch (e) {
        console.error(`[session-close] start failed: ${e.message}`);
    }

    // Init pnlAudit — wire the flatten handler so a $10 cumulative trip
    // force-flattens through the same path as scheduled session-close.
    // setImmediate defers the flatten so the halt log write returns first.
    try {
        pnlAudit.init({
            flattenHandler: (reason) => {
                setImmediate(() => {
                    sessionClose._flattenNow(reason).catch((e) => {
                        console.error(`[AUDIT] halt-flatten failed: ${e.message}`);
                    });
                });
            },
        });
    } catch (e) {
        console.error(`[AUDIT] pnlAudit.init failed: ${e.message}`);
    }

    // Account switch from UI → restart RTC so SignalR order/position/trade
    // subscriptions repoint to the new account. Order placement already reads
    // settings.get('accountId') fresh, but the hub subscriptions are locked
    // in at startRtc() and must be torn down + rebuilt.
    let rtcRestartInFlight = false;
    settings.onChange(async (keys) => {
        if (!keys.has('accountId')) return;
        if (rtcRestartInFlight) return;
        rtcRestartInFlight = true;
        try {
            const newAcctId = parseInt(settings.get('accountId'), 10) || null;
            console.log(`[beast-executor] accountId changed → restarting RTC on account ${newAcctId}`);
            await executor.stop();
            const tok = px.getToken();
            if (!tok) {
                console.warn('[beast-executor] no PX token — RTC restart skipped');
                return;
            }
            await executor.start(tok, newAcctId);
            console.log(`[beast-executor] RTC re-subscribed to account ${newAcctId}`);
        } catch (e) {
            console.error(`[beast-executor] RTC restart failed: ${e.message}`);
        } finally {
            rtcRestartInFlight = false;
        }
    });
});
