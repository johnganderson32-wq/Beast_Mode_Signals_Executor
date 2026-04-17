'use strict';

// ProjectX API client — modelled after EvilSignals-Executor/src/orders.js
// Order types: 1=Limit  2=Market  4=Stop
// Side:        0=Sell   1=Buy

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE         = (process.env.PROJECTX_API_URL || 'https://gateway-rtc.main.topstepx.com/api').replace(/\/$/, '');
const TOKEN_FILE   = path.join(__dirname, '..', 'logs', '.token.json');
const TOKEN_MAX_MS = 12 * 60 * 60 * 1000; // 12 h — actual JWT exp decoded below

let token        = null;
let tokenSavedAt = 0;
let isRefreshing = false;

const http = axios.create({ baseURL: BASE, timeout: 15_000 });

http.interceptors.request.use(cfg => {
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    return cfg;
});

http.interceptors.response.use(
    res => res,
    async err => {
        const status = err.response?.status;
        if (status === 401 && !err.config._retried && !isRefreshing) {
            err.config._retried = true;
            isRefreshing = true;
            try {
                await authenticate({ force: true });
                err.config.headers.Authorization = `Bearer ${token}`;
                return http(err.config);
            } finally {
                isRefreshing = false;
            }
        }
        return Promise.reject(err);
    }
);

// ---------------------------------------------------------------------------
// TOKEN PERSISTENCE — avoids re-login on restart
// ---------------------------------------------------------------------------
function saveToken(tok) {
    try {
        fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: tok, savedAt: Date.now() }));
    } catch {}
}

function loadSavedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const { token: tok, savedAt } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (Date.now() - savedAt < TOKEN_MAX_MS) return { tok, savedAt };
    } catch {}
    return null;
}

function decodeTokenExpiry(tok) {
    try {
        const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
        return payload.exp ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
async function authenticate({ force = false } = {}) {
    if (!force) {
        const saved = loadSavedToken();
        if (saved) {
            token        = saved.tok;
            tokenSavedAt = saved.savedAt;
            const age = Math.round((Date.now() - saved.savedAt) / 60000);
            console.log(`[projectx] Reusing saved token (${age}m old)`);
            return token;
        }
    }
    const { data } = await axios.post(`${BASE}/Auth/loginKey`, {
        userName: process.env.PROJECTX_USERNAME,
        apiKey:   process.env.PROJECTX_API_KEY,
    });
    token        = data.token;
    tokenSavedAt = Date.now();
    saveToken(token);
    console.log('[projectx] Authenticated (fresh login)');
    return token;
}

async function ensureAuth() {
    if (!token || Date.now() - tokenSavedAt >= TOKEN_MAX_MS) {
        await authenticate({ force: false });
    }
}

// ---------------------------------------------------------------------------
// CORE POST — 3 attempts with backoff
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function post(urlPath, body, tag) {
    const MAX = 3;
    let lastErr;
    for (let i = 0; i < MAX; i++) {
        try {
            const { data } = await http.post(urlPath, body);
            if (data?.success === false) {
                throw new Error(data.errorMessage || 'API success=false');
            }
            return data;
        } catch (e) {
            lastErr = e;
            const msg = e?.response?.data?.errorMessage || e.message;
            console.warn(`[projectx] ${tag} attempt ${i + 1}/${MAX}: ${msg}`);
            if (i < MAX - 1) await sleep(500 * (i + 1));
        }
    }
    throw new Error(lastErr?.response?.data?.errorMessage || lastErr?.message || 'API error');
}

// ---------------------------------------------------------------------------
// CONTRACT HELPERS
// Normalize any TV ticker variant to the product family key used in .env:
//   NQ1!, MNQ1!, ENQ1!, MNQM2026, NQ  →  "NQ"
//   GC1!, MGC1!, MGCM2026, GC         →  "GC"
// ---------------------------------------------------------------------------
const PRODUCT_MAP = {
    NQ: 'NQ', MNQ: 'NQ', ENQ: 'NQ',
    GC: 'GC', MGC: 'GC',
};

function normalizeInstrument(raw) {
    const upper = raw.toUpperCase().trim();
    // Try direct map first (handles "NQ", "MNQ", "GC", "MGC" exactly)
    if (PRODUCT_MAP[upper]) return PRODUCT_MAP[upper];
    // Strip trailing "1!", "2!" (TV continuous contract suffix)
    let clean = upper.replace(/\d+!$/, '');
    if (PRODUCT_MAP[clean]) return PRODUCT_MAP[clean];
    // Strip TradingView expiry suffix (e.g. MNQM2026 → MNQ)
    clean = upper.replace(/[FGHJKMNQUVXZ]\d{4}$/, '');
    if (PRODUCT_MAP[clean]) return PRODUCT_MAP[clean];
    return clean;
}

function getContractId(instrument) {
    const family = normalizeInstrument(instrument);
    const key = `${family}_CONTRACT_ID`;
    const id  = process.env[key];
    if (!id) throw new Error(`No contract ID configured for ${instrument} → ${family} (set ${key} in .env)`);
    return id;
}

function getQty(instrument) {
    const family = normalizeInstrument(instrument);
    const key = `${family}_CONTRACTS`;
    return parseInt(process.env[key] || '1', 10);
}

// ---------------------------------------------------------------------------
// ORDER PLACEMENT
// Entry = market; SL = stop order; TP1 + Target = limit orders
//
// With 1 contract: only TP1 limit is placed (target omitted)
// With 2+ contracts: qty-1 at TP1, 1 at target
// ---------------------------------------------------------------------------
async function placeOrder({ instrument, direction, stop, tp1, target }) {
    await ensureAuth();

    const accountId = parseInt(process.env.PROJECTX_ACCOUNT_ID, 10);
    if (!accountId) throw new Error('PROJECTX_ACCOUNT_ID not set in .env');

    const contractId = getContractId(instrument);
    const qty        = getQty(instrument);
    const entrySide  = direction === 'bullish' ? 1 : 0;
    const exitSide   = direction === 'bullish' ? 0 : 1;
    const ts         = Date.now();

    // 1. Market entry
    const entryResult = await post('/Order/place', {
        accountId,
        contractId,
        type:      2,          // Market
        side:      entrySide,
        size:      qty,
        customTag: `BEAST:ENTRY:${ts}`,
    }, 'ENTRY');
    console.log(`[projectx] Entry: ${direction} ${qty}x ${instrument}`, entryResult);

    // 2. Stop loss
    await post('/Order/place', {
        accountId,
        contractId,
        type:      4,          // Stop
        side:      exitSide,
        size:      qty,
        stopPrice: stop,
        customTag: `BEAST:SL:${ts}`,
    }, 'SL');
    console.log(`[projectx] SL placed @ ${stop}`);

    // 3. TP1 limit (all contracts if qty=1, qty-1 if qty>1)
    const tp1Qty = qty === 1 ? 1 : qty - 1;
    await post('/Order/place', {
        accountId,
        contractId,
        type:       1,         // Limit
        side:       exitSide,
        size:       tp1Qty,
        limitPrice: tp1,
        customTag:  `BEAST:TP1:${ts}`,
    }, 'TP1');
    console.log(`[projectx] TP1 placed @ ${tp1} (${tp1Qty} ct)`);

    // 4. Target limit (runner — only when qty >= 2)
    if (qty >= 2) {
        await post('/Order/place', {
            accountId,
            contractId,
            type:       1,     // Limit
            side:       exitSide,
            size:       1,
            limitPrice: target,
            customTag:  `BEAST:TARGET:${ts}`,
        }, 'TARGET');
        console.log(`[projectx] Target placed @ ${target} (1 ct)`);
    }

    return { entryResult, stop, tp1, target, qty };
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------
module.exports = { authenticate, ensureAuth, placeOrder };
