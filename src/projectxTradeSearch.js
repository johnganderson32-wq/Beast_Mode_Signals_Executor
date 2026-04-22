'use strict';

// ---------------------------------------------------------------------------
// ProjectX Trade Search — broker-side fill + realized P&L ingest (BEAST Mode)
//
// POST {PROJECTX_API_URL}/Trade/search
// Auth: same JWT Bearer as every other /Order/* and /Position/* call.
// One batch call per session-end (16:30 ET).
//
// Ported from EvilSignals-Executor/src/projectxTradeSearch.js (2026-04-22).
// Adaptations from EAI:
//   - orders.getToken() → px.getToken()  (BEAST's projectx module is imported
//     as `px`; the token accessor exists: `getToken: () => token`).
//   - log() → console.log (no logger.js in BEAST).
//
// Docs reference: EvilSignals-Executor memory/reference_projectx_trade_search.md
//
// All errors bubble with context — no silent catches. Empty trades array is
// a valid response (no trades this session) and returns [].
// ---------------------------------------------------------------------------

const axios = require('axios');
const px    = require('./projectx');

const BASE = process.env.PROJECTX_API_URL;

function assertEnv() {
    if (!BASE) {
        throw new Error('PROJECTX_API_URL not set — cannot call /Trade/search');
    }
}

// POST /Trade/search for a single account window.
// Returns the raw trades array (possibly empty).
async function fetchSessionTrades({ accountId, startTimestamp, endTimestamp }) {
    assertEnv();
    if (!accountId)      throw new Error('fetchSessionTrades: accountId required');
    if (!startTimestamp) throw new Error('fetchSessionTrades: startTimestamp required');
    if (!endTimestamp)   throw new Error('fetchSessionTrades: endTimestamp required');

    const token = px.getToken();
    if (!token) {
        throw new Error('fetchSessionTrades: no auth token — call px.authenticate() first');
    }

    const body = {
        accountId:      Number(accountId),
        startTimestamp,
        endTimestamp,
    };

    let resp;
    try {
        resp = await axios.post(`${BASE}/Trade/search`, body, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15_000,
        });
    } catch (e) {
        const status = e?.response?.status;
        const apiMsg = e?.response?.data?.errorMessage || e?.response?.data?.message;
        const msg    = apiMsg || e.message;
        console.warn(`[TRADE_SEARCH] POST /Trade/search failed (acct=${accountId} status=${status ?? 'n/a'}): ${msg}`);
        throw new Error(`/Trade/search request failed: ${msg}`);
    }

    const data = resp?.data;
    if (!data || data.success === false) {
        const apiMsg = data?.errorMessage || `errorCode=${data?.errorCode ?? 'unknown'}`;
        console.warn(`[TRADE_SEARCH] /Trade/search returned success=false (acct=${accountId}): ${apiMsg}`);
        throw new Error(`/Trade/search rejected: ${apiMsg}`);
    }

    const trades = Array.isArray(data.trades) ? data.trades : [];
    console.log(`[TRADE_SEARCH] acct=${accountId} window ${startTimestamp} → ${endTimestamp}: ${trades.length} trade(s)`);
    return trades;
}

module.exports = {
    fetchSessionTrades,
};
