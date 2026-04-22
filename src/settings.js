'use strict';

// User-configurable settings. Seeded from .env on boot, mutated live from the
// dashboard, then persisted to logs/settings.json so values survive restarts.
// Transient session state (tradingEnabled, dailyPnl, bias, streaks) lives in
// risk.js, not here.
//
// Precedence at boot:
//   1. defaults from .env
//   2. overlay from logs/settings.json (whatever the dashboard last saved)
//
// Any edit via set()/merge() is persisted immediately via atomic tmp+rename,
// matching the daily-pnl.json pattern.

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const SCHEMA_VERSION = 1;
const SETTINGS_FILE  = path.join(LOG_DIR, 'settings.json');

const store = {
    // accountId is INTENTIONALLY not seeded from process.env.PROJECTX_ACCOUNT_ID.
    // Authoritative source is logs/settings.json (persisted dashboard selection).
    // If the file is missing or the user hasn't clicked Save, accountId stays
    // empty and every incoming signal rejects with no_account_id until the UI
    // writes a value. Rationale (2026-04-22): .env was being used as an ambient
    // fallback, routing trades into whichever account happened to be in .env
    // rather than the account the user had selected in the UI.
    accountId:            '',

    // Contract IDs — one per family
    nqContractId:         process.env.NQ_CONTRACT_ID      || '',
    gcContractId:         process.env.GC_CONTRACT_ID      || '',
    esContractId:         process.env.ES_CONTRACT_ID      || '',

    // Fixed contract qty per product (used when dynamicSizing is OFF)
    nqContracts:          parseInt(process.env.NQ_CONTRACTS  || '2', 10),
    mnqContracts:         parseInt(process.env.MNQ_CONTRACTS || process.env.NQ_CONTRACTS || '2', 10),
    gcContracts:          parseInt(process.env.GC_CONTRACTS  || '1', 10),
    mgcContracts:         parseInt(process.env.MGC_CONTRACTS || process.env.GC_CONTRACTS || '1', 10),
    esContracts:          parseInt(process.env.ES_CONTRACTS  || '0', 10),
    mesContracts:         parseInt(process.env.MES_CONTRACTS || '0', 10),

    // Risk limits — all in dollars (0 = disabled where noted)
    dailyLossCap:         parseFloat(process.env.DAILY_LOSS_CAP_USD   || '0'),
    dailyProfitCap:       parseFloat(process.env.DAILY_PROFIT_CAP_USD || '0'),
    perTradeLossCap:      parseFloat(process.env.PER_TRADE_LOSS_CAP_USD || '0'),

    // Session close — HH:MM ET. Hard stop; no new entries until 18:00 ET reopen.
    sessionClose:         process.env.SESSION_CLOSE_TIME || '',

    // Consecutive loss circuit breaker — 0 = disabled
    consecutiveLossLimit: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT       || '0', 10),
    pauseDuration:        parseInt(process.env.CONSECUTIVE_LOSS_PAUSE_MINS  || '0', 10),

    // Dynamic sizing — when ON, qty = floor(perTradeLossCap / (rDist × $/pt))
    dynamicSizing:        process.env.DYNAMIC_SIZING_ENABLED === 'true',

    // Placeholder for future momentum trail build — metadata only until monitor.js port
    atmStrategy:          (process.env.ATM_STRATEGY || 'standard').toLowerCase(),
};

function persist() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const tmp  = SETTINGS_FILE + '.tmp';
        const body = JSON.stringify({ _v: SCHEMA_VERSION, settings: { ...store } }, null, 2);
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, SETTINGS_FILE);
    } catch (e) {
        console.warn(`[settings] persist failed: ${e.message}`);
    }
}

function restorePersisted() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw  = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const data = raw && typeof raw === 'object' ? (raw.settings || raw) : null;
        if (!data || typeof data !== 'object') return;
        let applied = 0;
        for (const [k, v] of Object.entries(data)) {
            if (k in store) { store[k] = v; applied++; }
        }
        console.log(`[settings] Restored from logs/settings.json (${applied} keys)`);
    } catch (e) {
        console.warn(`[settings] restore failed: ${e.message} — using .env defaults`);
    }
}

// Change listeners — invoked with (changedKeys: Set<string>) whenever set() or
// merge() actually mutates the store. Used by sessionClose.js to reschedule
// the force-flatten timer when the user edits sessionClose live from the
// dashboard without restarting the process.
const listeners = new Set();

function notify(keys) {
    if (!keys || keys.size === 0) return;
    for (const fn of listeners) {
        try { fn(keys); }
        catch (e) { console.warn(`[settings] listener failed: ${e.message}`); }
    }
}

function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
}

function get(key) {
    return store[key];
}

function set(key, value) {
    if (!(key in store)) return;
    const prev = store[key];
    store[key] = value;
    persist();
    if (prev !== value) notify(new Set([key]));
}

function getAll() {
    return { ...store };
}

function merge(partial) {
    const changedKeys = new Set();
    for (const [k, v] of Object.entries(partial || {})) {
        if (k in store) {
            if (store[k] !== v) changedKeys.add(k);
            store[k] = v;
        }
    }
    if (changedKeys.size > 0) {
        persist();
        notify(changedKeys);
    }
}

// Apply persisted overrides on top of the env-seeded defaults above.
restorePersisted();

module.exports = { get, set, getAll, merge, onChange };
