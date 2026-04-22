'use strict';

// Scheduled force-flatten at sessionClose ET.
//
// Why this exists:
//   risk.js:isPastSessionClose() already blocks NEW entries from sessionClose
//   through 18:00 ET Globex reopen. But open positions ride through that
//   window unprotected — TSX maintenance at 17:00–18:00 ET can auto-close at
//   a price we didn't choose. This module runs a one-shot timer that fires
//   AT sessionClose each day, cancels every working order, flattens every
//   open position at market, and writes an audit record per action so the
//   session-end disposition is searchable.
//
// Behaviour rules:
//   - settings.get('sessionClose') = HH:MM ET (same string risk.js reads).
//     Blank / unset = no schedule, consistent with the "blank never blocks"
//     semantic in risk.js.
//   - DST-aware: ET clock time is computed via Intl.DateTimeFormat
//     ('en-US', {timeZone:'America/New_York'}), the same pattern
//     risk.js and EAI's executor.js use. The scheduled ET hour:minute
//     stays fixed across the March/November transitions.
//   - On each fire: flatten, log, then re-arm for tomorrow's sessionClose.
//   - Live edits: subscribes to settings.onChange. If sessionClose changes
//     mid-day (user edits the dashboard) the pending timer is cleared and
//     a fresh one is scheduled against the new value. Blank → cancels.
//
// Logging: one line per cancelled order + one line per flattened position
// gets appended to logs/session-close.jsonl with disposition=session_end_flat,
// matching BEAST's append-only _v:1 JSONL convention (trades.jsonl, signals.jsonl).

const fs   = require('fs');
const path = require('path');

const settings = require('./settings');
const px       = require('./projectx');
const { LOG_DIR } = require('./paths');
const journal               = require('./journal');
const pnlAudit              = require('./pnlAudit');
const pnlReconcile          = require('./pnlReconcile');
const { fetchSessionTrades } = require('./projectxTradeSearch');

const SCHEMA_VERSION = 1;
const AUDIT_FILE     = path.join(LOG_DIR, 'session-close.jsonl');
const DISPOSITION    = 'session_end_flat';

// Globex reopen minute-of-day. Used only to sanity-check that sessionClose is
// before the reopen — it's expected to be, and our scheduler doesn't care
// about the reopen boundary; risk.js owns that gate.
const GLOBEX_START_MIN = 18 * 60;

let pendingTimer = null;
let scheduledForMsUtc = null;   // null = no timer armed; ms epoch otherwise

// ---------------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------------
function writeAudit(entry) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const line = JSON.stringify({
            _v:         SCHEMA_VERSION,
            timestamp:  new Date().toISOString(),
            disposition: DISPOSITION,
            ...entry,
        }) + '\n';
        fs.appendFileSync(AUDIT_FILE, line);
    } catch (e) {
        console.error(`[session-close] audit write failed: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// TIME MATH — DST-aware
// Returns ms-from-now until the next HH:MM ET boundary. If the target minute
// is already past today ET, rolls to the same minute tomorrow ET. Uses
// Intl.DateTimeFormat on the CURRENT instant so DST transitions are handled
// transparently — the ET wall clock is always read fresh.
// ---------------------------------------------------------------------------
function parseHhMm(hhmm) {
    const s = String(hhmm || '').trim();
    if (!s) return null;
    const [hStr, mStr] = s.split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { h, m };
}

function msUntilNextCloseET(hhmm, now = new Date()) {
    const parsed = parseHhMm(hhmm);
    if (!parsed) return null;

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(now);
    const etH = Number(parts.find(p => p.type === 'hour').value);
    const etM = Number(parts.find(p => p.type === 'minute').value);
    const etS = Number(parts.find(p => p.type === 'second').value);

    // minute-of-day deltas; if target has already passed today ET, roll +24h.
    // Using minutes keeps this DST-safe: we're measuring ET wall-clock to
    // ET wall-clock, not UTC offsets.
    let diffMin = (parsed.h * 60 + parsed.m) - (etH * 60 + etM);
    if (diffMin <= 0) diffMin += 24 * 60;

    const msUntil = diffMin * 60_000 - etS * 1_000;
    return Math.max(msUntil, 0);
}

// ---------------------------------------------------------------------------
// FLATTEN — the actual fire
// ---------------------------------------------------------------------------
async function flattenAllOpenPositions(reason = DISPOSITION) {
    const accountId = parseInt(
        require('./settings').get('accountId') || process.env.PROJECTX_ACCOUNT_ID,
        10,
    );
    if (!accountId) {
        console.error('[session-close] no accountId configured — skipping flatten');
        writeAudit({ event: 'skip', reason: 'no_account_id' });
        return { flattened: 0, cancelled: 0 };
    }

    let positions = [];
    let openOrders = [];
    try {
        positions  = await px.getOpenPositions(accountId);
        openOrders = await px.getOpenOrders(accountId);
    } catch (e) {
        console.error(`[session-close] broker read failed: ${e.message}`);
        writeAudit({ event: 'error', accountId, error: e.message });
        return { flattened: 0, cancelled: 0 };
    }

    const openPositions = (positions || []).filter(p => (p?.size || 0) > 0);
    const pendingOrders = (openOrders || []).slice();

    console.log(`[session-close] flattening ${openPositions.length} open position(s) — reason=${reason}`);
    writeAudit({
        event: 'fire',
        accountId,
        reason,
        openPositionCount: openPositions.length,
        pendingOrderCount: pendingOrders.length,
    });

    // STEP 1 — cancel pending working orders first so they don't race the
    // flatten market orders. cancelAllOrdersFor iterates per-contract, which
    // also covers any orphan orders sitting on a contract without an open
    // position (rare but possible after manual cleanup).
    const orderContracts = new Set(pendingOrders.map(o => o.contractId).filter(Boolean));
    for (const posCid of openPositions.map(p => p.contractId)) {
        if (posCid) orderContracts.add(posCid);
    }

    let cancelledCount = 0;
    for (const cid of orderContracts) {
        const rel = pendingOrders.filter(o => o.contractId === cid);
        for (const o of rel) {
            const orderId = o.orderId ?? o.id;
            try {
                await px.cancelOrder(orderId, accountId);
                cancelledCount++;
                writeAudit({
                    event:      'order_cancelled',
                    accountId,
                    contractId: cid,
                    orderId,
                    orderType:  o.type ?? null,
                    side:       o.side ?? null,
                    size:       o.size ?? null,
                });
            } catch (e) {
                console.error(`[session-close] cancel ${orderId} failed: ${e.message}`);
                writeAudit({
                    event:      'order_cancel_failed',
                    accountId,
                    contractId: cid,
                    orderId,
                    error:      e.message,
                });
            }
        }
    }

    // STEP 2 — flatten each open position at MARKET. flattenPosition()
    // already sends a market order; fill price is NOT awaited here (the
    // executor.js POLL + RTC handlers will reconcile fills and update the
    // trade records — same pattern as the manual dashboard flatten).
    let flattenedCount = 0;
    for (const pos of openPositions) {
        try {
            const res = await px.flattenPosition(pos.contractId, accountId);
            flattenedCount++;
            writeAudit({
                event:        'position_flattened',
                accountId,
                contractId:   pos.contractId,
                size:         pos.size,
                positionType: pos.type,      // 1=Long, 0=Short
                closed:       !!res?.closed,
                closeOrderId: res?.closeOrderId ?? null,
            });
        } catch (e) {
            console.error(`[session-close] flatten ${pos.contractId} failed: ${e.message}`);
            writeAudit({
                event:      'position_flatten_failed',
                accountId,
                contractId: pos.contractId,
                size:       pos.size,
                error:      e.message,
            });
        }
    }

    console.log(`[session-close] done — flattened=${flattenedCount} cancelled=${cancelledCount}`);
    writeAudit({
        event: 'complete',
        accountId,
        flattenedCount,
        cancelledCount,
    });
    return { flattened: flattenedCount, cancelled: cancelledCount };
}

// ---------------------------------------------------------------------------
// AUDIT RECONCILE — 16:30 ET broker P&L crosscheck
//
// Runs AFTER the flatten completes. Pulls broker trade fills from
// /Trade/search across every account that traded since prior Globex open,
// reconciles against the journal, hands deltas to pnlAudit. Sequence copied
// from EvilSignals-Executor/src/executor.js:runPnlAuditReconcile (2026-04-22).
// ---------------------------------------------------------------------------
function priorGlobexOpenIso(now = new Date()) {
    const opts = { timeZone: 'America/New_York', hour: 'numeric', hour12: false };
    const etH  = Number(new Intl.DateTimeFormat('en-US', opts).formatToParts(now).find(p => p.type === 'hour').value);
    // 18:00 ET today if already past 18:00 ET; otherwise yesterday 18:00 ET.
    // At 16:30 ET we're before 18:00, so this returns yesterday 18:00 ET.
    const ref = new Date(now);
    if (etH < 18) ref.setTime(ref.getTime() - 24 * 60 * 60 * 1000);
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
    const naiveUtc = new Date(`${d}T18:00:00Z`);
    const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(naiveUtc);
    const get = t => Number(etParts.find(p => p.type === t).value);
    const asEtUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const offsetMs  = asEtUtcMs - naiveUtc.getTime();
    return new Date(naiveUtc.getTime() - offsetMs).toISOString();
}

async function runPnlAuditReconcile() {
    const endTimestamp   = new Date().toISOString();
    const startTimestamp = priorGlobexOpenIso(new Date());

    // Collect every account that could have traded since prior Globex open:
    //   - current settings.accountId (the live account)
    //   - any accountId seen in journal history since rollover
    // Skip duplicates + null/empty IDs.
    const accountIds = [];
    const seen = new Set();

    const liveAid = settings.get('accountId') || process.env.PROJECTX_ACCOUNT_ID;
    if (liveAid != null && String(liveAid).trim() !== '' && !seen.has(String(liveAid))) {
        seen.add(String(liveAid));
        accountIds.push(liveAid);
    }
    try {
        for (const aid of journal.getDistinctAccounts()) {
            if (aid != null && !seen.has(String(aid))) {
                seen.add(String(aid));
                accountIds.push(aid);
            }
        }
    } catch (e) {
        console.warn(`[AUDIT] journal.getDistinctAccounts failed: ${e.message}`);
    }

    if (accountIds.length === 0) {
        console.warn('[AUDIT] no accounts to reconcile — skipping');
        writeAudit({ event: 'audit_skip', reason: 'no_accounts' });
        return;
    }

    console.log(`[AUDIT] Reconcile window ${startTimestamp} → ${endTimestamp} across ${accountIds.length} account(s): ${accountIds.join(', ')}`);

    const allTrades = [];
    for (const aid of accountIds) {
        try {
            const trades = await fetchSessionTrades({
                accountId:      aid,
                startTimestamp,
                endTimestamp,
            });
            for (const t of trades) allTrades.push(t);
        } catch (e) {
            console.warn(`[AUDIT] Trade search failed for acct=${aid}: ${e.message}`);
            writeAudit({ event: 'audit_trade_search_failed', accountId: aid, error: e.message });
            // Continue with other accounts — partial data is better than none.
        }
    }

    const executorOrders = journal.getHistory();
    const recon = pnlReconcile.reconcileSession({ trades: allTrades, executorOrders });

    console.log(
        `[AUDIT] Reconcile: ${recon.deltas.length} delta(s), ` +
        `${recon.unmatchedBrokerTrades.length} unmatched broker trade(s), ` +
        `${recon.unmatchedExecutorOrders.length} unmatched executor order(s)`,
    );
    for (const u of recon.unmatchedBrokerTrades) {
        console.log(`[AUDIT]   UNMATCHED BROKER: tradeId=${u.tradeId} orderId=${u.orderId} contract=${u.contractId} netPnl=$${u.brokerNetPnl}`);
    }
    for (const u of recon.unmatchedExecutorOrders) {
        console.log(`[AUDIT]   UNMATCHED EXECUTOR: id=${u.localTradeId} ${u.symbol} ${u.side} ${u.outcome} ids=${u.executorOrderIds.join(',') || '(none)'}`);
    }

    writeAudit({
        event: 'audit_complete',
        brokerTradeCount:      allTrades.length,
        deltaCount:            recon.deltas.length,
        unmatchedBrokerCount:  recon.unmatchedBrokerTrades.length,
        unmatchedExecutorCount: recon.unmatchedExecutorOrders.length,
    });

    try { pnlAudit.recordSessionDeltas(recon); }
    catch (e) { console.error(`[AUDIT] pnlAudit.recordSessionDeltas: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// SCHEDULER
// ---------------------------------------------------------------------------
function clearPending() {
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        scheduledForMsUtc = null;
    }
}

// Schedule (or re-schedule) the next fire based on the CURRENT settings value.
// Safe to call repeatedly — always cancels the pending timer before re-arming.
function scheduleNext() {
    clearPending();

    const hhmm = settings.get('sessionClose');
    const parsed = parseHhMm(hhmm);
    if (!parsed) {
        console.log('[session-close] sessionClose blank/unset — no flatten scheduled');
        return;
    }
    // Sanity: sessionClose should be before the Globex reopen. If the user
    // enters something past 18:00 ET the scheduler still fires at that time;
    // we just log a note so the operator sees it.
    if (parsed.h * 60 + parsed.m >= GLOBEX_START_MIN) {
        console.warn(`[session-close] sessionClose ${hhmm} ET is at/after 18:00 ET Globex reopen — fire still scheduled`);
    }

    const msUntil = msUntilNextCloseET(hhmm);
    if (msUntil == null) {
        console.warn(`[session-close] failed to compute next fire for "${hhmm}" — not scheduling`);
        return;
    }

    const targetAt = Date.now() + msUntil;
    scheduledForMsUtc = targetAt;
    const etStr = hhmm.trim();
    const mins  = Math.round(msUntil / 60_000);
    console.log(`[session-close] next force-flatten at ${etStr} ET — in ${mins}m (fires at ${new Date(targetAt).toISOString()})`);

    pendingTimer = setTimeout(async () => {
        pendingTimer = null;
        scheduledForMsUtc = null;
        const reason = DISPOSITION;
        // Re-read settings at fire time so a blank value arriving after
        // arming is respected; a cleared schedule should never fire on a
        // stale timer (the onChange listener also clears, this is belt-and-
        // braces).
        const liveClose = settings.get('sessionClose');
        if (!parseHhMm(liveClose)) {
            console.log('[session-close] fire aborted — sessionClose cleared after schedule');
            writeAudit({ event: 'abort', reason: 'sessionClose_cleared_after_schedule' });
            return;
        }
        try {
            await flattenAllOpenPositions(reason);
        } catch (e) {
            console.error(`[session-close] flatten run threw: ${e.message}`);
            writeAudit({ event: 'error', error: e.message });
        }
        // After flatten, reset the cumulative audit counter then run the broker
        // P&L reconciliation. Reset-first matches EAI's spec order: counter
        // reset is step 1 of session-end, so any deltas from this reconcile
        // land cleanly into a fresh counter.
        try { pnlAudit.sessionEndReset(); }
        catch (e) { console.error(`[AUDIT] sessionEndReset: ${e.message}`); }
        try { await runPnlAuditReconcile(); }
        catch (e) {
            console.error(`[AUDIT] runPnlAuditReconcile threw: ${e.message}`);
            writeAudit({ event: 'audit_error', error: e.message });
        }
        // Re-arm for tomorrow. msUntilNextCloseET will see "already past"
        // (we just fired) and roll to the next ET HH:MM ~24h out.
        scheduleNext();
    }, msUntil);
    pendingTimer.unref?.();
}

// Called on boot. Subscribes to settings changes so live edits to
// sessionClose propagate to the scheduler without a restart.
function start() {
    settings.onChange((keys) => {
        if (keys.has('sessionClose')) {
            console.log('[session-close] sessionClose setting changed — rescheduling');
            scheduleNext();
        }
    });
    scheduleNext();
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------
module.exports = {
    start,
    scheduleNext,
    clearPending,
    // Exposed for tests only — do not use at runtime.
    _msUntilNextCloseET: msUntilNextCloseET,
    _parseHhMm:          parseHhMm,
    _flattenNow:         flattenAllOpenPositions,
    _runPnlAuditReconcile: runPnlAuditReconcile,
    _priorGlobexOpenIso:   priorGlobexOpenIso,
    _state: () => ({ scheduledForMsUtc, hasPendingTimer: !!pendingTimer }),
    DISPOSITION,
    AUDIT_FILE,
};
