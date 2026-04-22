'use strict';

// ---------------------------------------------------------------------------
// P&L AUDIT — cumulative $10 halt + $2 per-order queue (BEAST Mode)
//
// Ported from EvilSignals-Executor/src/pnlAudit.js (2026-04-22).
// Thresholds are identical to EAI (John-set 2026-04-21, not negotiable):
//   FLAG_DELTA_USD = 2.00   — per-order |delta| > $2 → append to audit queue
//   HALT_DELTA_USD = 10.00  — session cumulative |sessionDelta| > $10 → halt all
//
// Adaptations from EAI:
//   - Uses console.log directly (no logger.js in BEAST)
//   - Paths resolved via ./paths.js (LOG_DIR)
//   - Queue/halt files co-exist with EAI's same-named files only if BEAST
//     and EAI share a logs dir (they don't — each repo owns its own).
//
// State:
//   sessionDelta — signed running total of executor_netPnl - broker_netPnl,
//                  reset at 16:30 ET (step 1 of sessionClose sequence).
//   halted       — true after $10 trip; cleared only by manual re-enable.
//   haltedAt     — ISO timestamp of the trip (null when not halted).
//
// Queue files (one JSONL line per event):
//   logs/pnl_audit_queue.jsonl       — flagged or manual entries
//   logs/pnl_audit_halt.jsonl        — halt + re-enable events
//   logs/pnl_audit_queue.YYYY-MM-DD.archived.jsonl — archived on mark-reviewed
//
// Halt callback: pnlAudit.init({ flattenHandler }) — BEAST wires this in
// index.js to call a flatten-all routine on $10 trip. We stay free of
// executor coupling by requiring the caller to pass the handler.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const QUEUE_FILE = path.join(LOG_DIR, 'pnl_audit_queue.jsonl');
const HALT_FILE  = path.join(LOG_DIR, 'pnl_audit_halt.jsonl');

// Thresholds — frozen per John's directive.
const FLAG_DELTA_USD = 2.00;
const HALT_DELTA_USD = 10.00;

// Schema version for both jsonl log types.
const SCHEMA_V = 1;

// ---- in-memory state -------------------------------------------------------
let sessionDelta = 0;     // signed cumulative since last 16:30 ET reset
let halted       = false;
let haltedAt     = null;  // ISO string when halted flipped true

// Halt callback wired via init(). setImmediate-wrapped by the caller so the
// halt write returns before the flatten kicks off.
let onHaltFlatten = null;

// ---- filesystem helpers ----------------------------------------------------
function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonl(file, record) {
    ensureLogDir();
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    try {
        return fs.readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch (e) {
        console.warn(`[AUDIT] readJsonl(${path.basename(file)}) failed: ${e.message}`);
        return [];
    }
}

// ---- public state accessors ------------------------------------------------
function getHaltInfo() {
    return {
        halted,
        haltedAt,
        cumulativeDelta: parseFloat(sessionDelta.toFixed(4)),
    };
}

function isHalted() { return halted; }

// ---- queue operations ------------------------------------------------------
function appendQueueEntry(entry) {
    const rec = {
        _v:       SCHEMA_V,
        _source:  entry._source || 'auto',
        loggedAt: new Date().toISOString(),
        ...entry,
    };
    try { appendJsonl(QUEUE_FILE, rec); }
    catch (e) { console.warn(`[AUDIT] appendQueueEntry failed: ${e.message}`); }
    return rec;
}

function getQueue() {
    return readJsonl(QUEUE_FILE);
}

// ---- halt operations -------------------------------------------------------
function triggerHalt(triggerDelta, contributingDelta) {
    if (halted) return; // idempotent
    halted   = true;
    haltedAt = new Date().toISOString();
    const haltRec = {
        _v:              SCHEMA_V,
        haltedAt,
        cumulativeDelta: parseFloat(sessionDelta.toFixed(4)),
        threshold:       HALT_DELTA_USD,
        triggerDelta,
        contributingDelta,
    };
    try { appendJsonl(HALT_FILE, haltRec); }
    catch (e) { console.warn(`[AUDIT] halt log write failed: ${e.message}`); }
    console.warn(`[AUDIT] CUMULATIVE HALT — |sessionDelta|=$${Math.abs(sessionDelta).toFixed(2)} > $${HALT_DELTA_USD} — flatten + reject all signals until manual re-enable`);
    if (typeof onHaltFlatten === 'function') {
        try { onHaltFlatten('pnl_audit_halt_flat'); }
        catch (e) { console.warn(`[AUDIT] onHaltFlatten handler threw: ${e.message}`); }
    }
}

function clearHalt(source = 'unknown') {
    if (!halted) return false;
    const prev = haltedAt;
    halted   = false;
    haltedAt = null;
    console.log(`[AUDIT] Halt cleared (source=${source}, was haltedAt=${prev})`);
    return true;
}

// ---- delta recording -------------------------------------------------------
// Core path called by executor after the 16:30 ET reconcile. One delta per
// broker closing trade. Order matters:
//   1. Flag-queue every |delta| > $2 (no short-circuit on halt — we still log
//      the row so John sees it in audit).
//   2. Accumulate into sessionDelta.
//   3. If cumulative trips → fire halt.
function recordSessionDeltas(reconRes) {
    const deltas            = reconRes?.deltas                || [];
    const unmatchedBroker   = reconRes?.unmatchedBrokerTrades  || [];
    const unmatchedExecutor = reconRes?.unmatchedExecutorOrders || [];

    console.log(`[AUDIT] Applying ${deltas.length} reconcile delta(s); current sessionDelta=$${sessionDelta.toFixed(2)} halted=${halted}`);

    for (const d of deltas) {
        const absDelta = Math.abs(d.delta);
        if (absDelta > FLAG_DELTA_USD) {
            appendQueueEntry({
                timestamp:        d.timestamp,
                orderId:          d.orderId,
                tradeId:          d.tradeId,
                localTradeId:     d.localTradeId,
                contractId:       d.contractId,
                symbol:           d.symbol,
                side:             d.side,
                delta:            d.delta,
                executor_netPnl:  d.executor_netPnl,
                broker_netPnl:    d.broker_netPnl,
                signalPayloadRef: null, // future: crosswalk to logs/signals.jsonl
            });
            console.log(`[AUDIT] FLAG orderId=${d.orderId} contract=${d.contractId} delta=${d.delta >= 0 ? '+' : ''}$${d.delta.toFixed(2)}`);
        }
        sessionDelta += d.delta;
        if (!halted && Math.abs(sessionDelta) > HALT_DELTA_USD) {
            triggerHalt(sessionDelta, d.delta);
        }
    }

    for (const u of unmatchedBroker) {
        appendQueueEntry({
            _source:       'unmatched_broker',
            timestamp:     u.timestamp,
            orderId:       u.orderId,
            tradeId:       u.tradeId,
            contractId:    u.contractId,
            broker_netPnl: u.brokerNetPnl,
            reason:        u.reason,
        });
    }
    for (const u of unmatchedExecutor) {
        appendQueueEntry({
            _source:          'unmatched_executor',
            localTradeId:     u.localTradeId,
            symbol:           u.symbol,
            side:             u.side,
            outcome:          u.outcome,
            closedAt:         u.closedAt,
            openedAt:         u.openedAt,
            executorOrderIds: u.executorOrderIds,
            reason:           u.reason,
        });
    }
}

// ---- session-end reset -----------------------------------------------------
// Called at 16:30 ET (step 1 of the session-close sequence in sessionClose.js).
// Resets the cumulative counter only. Halted + queue DO NOT auto-clear:
//   - halted is manual-only per John's directive.
//   - queue persists until mark-reviewed.
function sessionEndReset() {
    const prev = sessionDelta;
    sessionDelta = 0;
    console.log(`[AUDIT] Session-end reset — cumulativeDelta $${prev.toFixed(2)} → $0.00 (halted=${halted}, queue retained until mark-reviewed)`);
}

// ---- manual flag -----------------------------------------------------------
function manualFlag({ note, orderId, delta, contractId, symbol, side } = {}) {
    const entry = {
        _source:   'manual',
        note:      note ? String(note) : null,
        timestamp: new Date().toISOString(),
    };
    if (orderId    != null)                     entry.orderId    = orderId;
    if (delta      != null && delta      !== '') entry.delta      = Number(delta);
    if (contractId != null)                     entry.contractId = contractId;
    if (symbol     != null)                     entry.symbol     = symbol;
    if (side       != null)                     entry.side       = side;
    return appendQueueEntry(entry);
}

// ---- mark reviewed ---------------------------------------------------------
// Archive the queue file to logs/pnl_audit_queue.<date>.archived.jsonl and
// clear the halt flag if active. Returns { archived, archivePath, clearedHalt }.
function markReviewed() {
    let archivePath = null;
    let archived    = false;
    if (fs.existsSync(QUEUE_FILE)) {
        const date = new Date().toISOString().slice(0, 10);
        let candidate = path.join(LOG_DIR, `pnl_audit_queue.${date}.archived.jsonl`);
        let i = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(LOG_DIR, `pnl_audit_queue.${date}.${i}.archived.jsonl`);
            i += 1;
        }
        try {
            fs.renameSync(QUEUE_FILE, candidate);
            archivePath = candidate;
            archived    = true;
            console.log(`[AUDIT] Queue archived → ${path.basename(candidate)}`);
        } catch (e) {
            console.error(`[AUDIT] markReviewed archive failed: ${e.message}`);
            throw e;
        }
    }
    const clearedHalt = clearHalt('mark_reviewed');
    return { archived, archivePath, clearedHalt };
}

// ---- re-enable (halt only) ------------------------------------------------
function reEnable() {
    const cleared = clearHalt('re_enable');
    if (!cleared) return { clearedHalt: false };
    try {
        appendJsonl(HALT_FILE, {
            _v:              SCHEMA_V,
            event:           're_enable',
            at:              new Date().toISOString(),
            cumulativeDelta: parseFloat(sessionDelta.toFixed(4)),
        });
    } catch (e) { console.warn(`[AUDIT] re-enable log write failed: ${e.message}`); }
    return { clearedHalt: true };
}

// ---- init ------------------------------------------------------------------
function init({ flattenHandler } = {}) {
    if (typeof flattenHandler === 'function') {
        onHaltFlatten = flattenHandler;
    }
    ensureLogDir();
    console.log(`[AUDIT] pnlAudit initialised — flag=$${FLAG_DELTA_USD} halt=$${HALT_DELTA_USD}`);
}

module.exports = {
    // Session-lifecycle hooks (sessionClose.js wires these into the 16:30 path).
    recordSessionDeltas,
    sessionEndReset,
    // State accessors (webhook + UI read these).
    getHaltInfo,
    isHalted,
    // UI actions (dashboard endpoints call these).
    getQueue,
    manualFlag,
    markReviewed,
    reEnable,
    // Boot-time wiring.
    init,
    // Constants for tests / introspection.
    FLAG_DELTA_USD,
    HALT_DELTA_USD,
    SCHEMA_V,
};
