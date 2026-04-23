'use strict';

// ProjectX API client.
// Order types: 1=Limit  2=Market  4=Stop
// Side:        0=Buy    1=Sell
// Position.type: 1=Long  0=Short (matches EvilSignals production)

const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const settings  = require('./settings');
const contracts = require('./contracts');
const { LOG_DIR } = require('./paths');

const BASE         = (process.env.PROJECTX_API_URL || 'https://gateway-rtc.main.topstepx.com/api').replace(/\/$/, '');
const TOKEN_FILE   = path.join(LOG_DIR, '.token.json');
const TOKEN_MAX_MS = 12 * 60 * 60 * 1000;

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
// TOKEN PERSISTENCE
// ---------------------------------------------------------------------------
function saveToken(tok) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: tok, savedAt: Date.now() }));
    } catch {}
}

function loadSavedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const { token: tok, savedAt } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (!tok) return null;
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
    if (data?.success === false || !data?.token) {
        token        = null;
        tokenSavedAt = 0;
        throw new Error(`Auth failed: ${JSON.stringify(data)}`);
    }
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

// Retry on transport / 5xx only. A business error (HTTP 200 with
// success=false, e.g. "custom tag already in use") means the broker already
// saw the request — retrying would double-book or get rejected for duplicate
// tag. Fail fast on those.
async function post(urlPath, body, tag) {
    const MAX = 3;
    let lastErr;
    for (let i = 0; i < MAX; i++) {
        try {
            const { data } = await http.post(urlPath, body);
            if (data?.success === false) {
                const err = new Error(data.errorMessage || 'API success=false');
                err.noRetry = true;
                throw err;
            }
            return data;
        } catch (e) {
            lastErr = e;
            const msg = e?.response?.data?.errorMessage || e.message;
            console.warn(`[projectx] ${tag} attempt ${i + 1}/${MAX}: ${msg}`);
            if (e.noRetry) break;
            if (i < MAX - 1) await sleep(500 * (i + 1));
        }
    }
    throw new Error(lastErr?.response?.data?.errorMessage || lastErr?.message || 'API error');
}

// ---------------------------------------------------------------------------
// CROSS-ROUTE GUARD — defense-in-depth assertion that every order, cancel,
// modify, or flatten targets the account the user has actively selected in
// the UI (persisted to logs/settings.json → accountId). Anything else is
// refused BEFORE the POST to ProjectX — no chance of reaching the broker,
// no chance of filling.
//
// Catches (all hypothetical future regressions):
//   - env-fallback drift if someone reintroduces Number(process.env.PROJECTX_ACCOUNT_ID)
//   - stale closure holding an old accountId after a mid-session UI change
//   - typo / variable-shadowing in a new trade path
//   - any code that reads account from a settings source we don't know about
//
// Does NOT protect against:
//   - user deliberately selecting a wrong account in the UI
//   - platform-side copy-trading / master-follower mirroring at TopstepX
// Those are out of scope — this guards the code path, not the business
// decision or the broker layer.
//
// BEAST deviates from EAI: EAI supports three concurrent strategy accounts
// (EAI / IBOB / TMAG) so its "selected set" is a 3-element filter. BEAST has
// exactly one live account — settings.get('accountId') — so the guard is a
// single-value equality check. Settings is read on every call so mid-session
// UI changes take effect immediately with no restart.
// ---------------------------------------------------------------------------
function verifyAccountIntent(acctId, context = 'unspecified') {
    const selected = parseInt(settings.get('accountId'), 10) || null;
    const target = Number(acctId);
    if (!Number.isFinite(target) || target <= 0) {
        console.error(`[CROSS-ROUTE-BLOCK] REFUSING ${context}: accountId=${acctId} is not a valid ID. Selected BEAST=${selected}`);
        throw new Error(`cross_route_guard: invalid accountId ${acctId} (context=${context})`);
    }
    if (selected == null || target !== selected) {
        console.error(`[CROSS-ROUTE-BLOCK] REFUSING ${context}: accountId=${target} is NOT the currently-selected BEAST account ${selected}. Order NOT sent to broker.`);
        throw new Error(`cross_route_guard: accountId ${target} not currently selected`);
    }
}

// ---------------------------------------------------------------------------
// CONTRACT / QTY HELPERS
// ---------------------------------------------------------------------------
// Map product family → contract ID key in settings (mini default; micro
// overrides when configured). The user keeps ONE active contract ID per
// family; dashboard picks between mini/micro via the select.
const FAMILY_CONTRACT_KEY = { NQ: 'nqContractId', GC: 'gcContractId', ES: 'esContractId' };

function getContractIdForFamily(family) {
    const key = FAMILY_CONTRACT_KEY[family];
    if (!key) throw new Error(`No contract key for family ${family}`);
    const id = settings.get(key) || process.env[`${family}_CONTRACT_ID`];
    if (!id) throw new Error(`No contract ID configured for family ${family}`);
    return id;
}

// Fixed qty — pulled by product code (MNQ vs ENQ, MGC vs GC, MES vs ES).
function getFixedQty(contractId) {
    const code = contracts.productCodeFromContractId(contractId) || '';
    const key  = `${code.toLowerCase()}Contracts`;
    const n    = parseInt(settings.get(key), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// SIDE MAPPING — TopstepX: 0=Buy, 1=Sell (matches EvilSignals production)
// ---------------------------------------------------------------------------
function sidesForDirection(direction) {
    const isBull = String(direction).toLowerCase() === 'bullish';
    return { entrySide: isBull ? 0 : 1, exitSide: isBull ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// ORDER PLACEMENT
// ---------------------------------------------------------------------------
// Returns { orderIds: { entry, sl, tp1, target }, qty, contractId }
// Throws with `stage`, `orderIds`, and `contractId` attached so the caller can
// run safety flatten when entry filled but a protective order failed.
async function placeOrder({ family, direction, stop, tp1, target, qty, mode }) {
    await ensureAuth();

    const accountId = parseInt(settings.get('accountId'), 10) || null;
    if (!accountId) throw new Error('No accountId selected — open dashboard Settings and save an account before placing trades');
    verifyAccountIntent(accountId, `placeOrder ${family} ${direction}`);

    const isMomentum = String(mode || '').toLowerCase() === 'momentum';
    const contractId = getContractIdForFamily(family);
    const { entrySide, exitSide } = sidesForDirection(direction);
    const ts         = Date.now();

    // Round protective prices to the contract's tick size
    const slPrice    = contracts.roundToTick(stop,   contractId);
    const tp1Price   = contracts.roundToTick(tp1,    contractId);
    const tgtPrice   = contracts.roundToTick(target, contractId);

    const orderIds = {};

    // 1. Market entry — failure here means no position opened, no cleanup needed
    try {
        const entryRes = await post('/Order/place', {
            accountId, contractId,
            type:      2,
            side:      entrySide,
            size:      qty,
            customTag: `BEAST:ENTRY:${ts}`,
        }, 'ENTRY');
        orderIds.entry = entryRes?.orderId ?? entryRes?.id ?? null;
        console.log(`[projectx] Entry: ${direction} ${qty}x ${contractId} (id=${orderIds.entry})`);
    } catch (e) {
        throw Object.assign(e, { stage: 'entry', orderIds, contractId });
    }

    // 2-4. Protective orders — any failure here leaves a naked position. The
    // caller must run flattenPosition + cancel working orders on catch.
    try {
        const slRes = await post('/Order/place', {
            accountId, contractId,
            type:       4,
            side:       exitSide,
            size:       qty,
            stopPrice:  slPrice,
            customTag:  `BEAST:SL:${ts}`,
        }, 'SL');
        orderIds.sl = slRes?.orderId ?? slRes?.id ?? null;
        console.log(`[projectx] SL @ ${slPrice} (id=${orderIds.sl})`);

        // Momentum mode: no fixed TP orders — the full position exits via the
        // trailing SL which walks up/down as favorable excursion builds. TP1
        // and TARGET order slots stay null in the returned orderIds.
        if (!isMomentum) {
            const tp1Qty = qty === 1 ? 1 : qty - 1;
            const tp1Res = await post('/Order/place', {
                accountId, contractId,
                type:       1,
                side:       exitSide,
                size:       tp1Qty,
                limitPrice: tp1Price,
                customTag:  `BEAST:TP1:${ts}`,
            }, 'TP1');
            orderIds.tp1 = tp1Res?.orderId ?? tp1Res?.id ?? null;
            console.log(`[projectx] TP1 @ ${tp1Price} (${tp1Qty}ct, id=${orderIds.tp1})`);

            if (qty >= 2) {
                const tgtRes = await post('/Order/place', {
                    accountId, contractId,
                    type:       1,
                    side:       exitSide,
                    size:       1,
                    limitPrice: tgtPrice,
                    customTag:  `BEAST:TARGET:${ts}`,
                }, 'TARGET');
                orderIds.target = tgtRes?.orderId ?? tgtRes?.id ?? null;
                console.log(`[projectx] Target @ ${tgtPrice} (1ct, id=${orderIds.target})`);
            }
        } else {
            console.log(`[projectx] momentum mode — TP1/TARGET skipped, exit via trailing SL`);
        }
    } catch (e) {
        throw Object.assign(e, { stage: 'protective', orderIds, contractId });
    }

    return { orderIds, qty, contractId };
}

// ---------------------------------------------------------------------------
// POSITIONS & ORDERS
// ---------------------------------------------------------------------------
async function getOpenPositions(acctId) {
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    const data = await post('/Position/searchOpen', { accountId }, 'POS');
    return data?.positions || [];
}

async function getOpenOrders(acctId) {
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    const data = await post('/Order/searchOpen', { accountId }, 'ORD');
    return data?.orders || [];
}

// Modify a working order. TopstepX supports changing size / stopPrice /
// limitPrice on a resting order atomically — single call, no cancel+replace
// race window. This is how we shrink the SL from full-qty to runner-qty
// when TP1 fills, so the SL can't over-fill and create a reverse position.
async function modifyOrder(orderId, fields, acctId) {
    if (orderId == null) throw new Error('modifyOrder: orderId required');
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    verifyAccountIntent(accountId, `modifyOrder ${orderId}`);
    return post('/Order/modify', { accountId, orderId, ...fields }, `MODIFY:${orderId}`);
}

async function cancelOrder(orderId, acctId) {
    if (orderId == null) return;
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    verifyAccountIntent(accountId, `cancelOrder ${orderId}`);
    try {
        const { data } = await http.post('/Order/cancel', { accountId, orderId });
        if (data?.success === false && data.errorCode !== 5) {
            console.warn(`[projectx] Cancel ${orderId}: errorCode=${data.errorCode}`);
        }
    } catch (e) {
        console.warn(`[projectx] Cancel ${orderId} failed: ${e.message}`);
    }
}

async function cancelAllOrdersFor(contractId, acctId) {
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    verifyAccountIntent(accountId, `cancelAllOrdersFor ${contractId}`);
    const openOrders = await getOpenOrders(accountId);
    const rel = openOrders.filter(o => o.contractId === contractId);
    for (const o of rel) {
        await cancelOrder(o.orderId ?? o.id, accountId);
    }
    if (rel.length) console.log(`[projectx] Cancelled ${rel.length} working orders for ${contractId}`);
}

// Look up a filled order's fill price. Tries historical / closed / search endpoints.
async function getFilledOrder(orderId, acctId) {
    if (orderId == null) return null;
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    const id        = Number(orderId);
    const endpoints = [
        ['/Order/searchHistorical', { accountId, orderId: id }],
        ['/Order/searchClosed',     { accountId, orderId: id }],
        ['/Order/search',           { accountId, orderId: id, status: 2 }],
    ];
    for (const [p, body] of endpoints) {
        try {
            const { data } = await http.post(p, body);
            const orders = data?.orders || data?.results || [];
            const found  = orders.find(o => (o.orderId ?? o.id) === id) || orders[0];
            if (found && (found.fillPrice ?? found.filledPrice ?? found.avgFillPrice) != null) {
                return found;
            }
        } catch {}
    }
    return null;
}

// Market-close the position for contractId (if any), then cancel working orders.
// Returns { closed: boolean, closeOrderId: number|null, contractId }
async function flattenPosition(contractId, acctId) {
    await ensureAuth();
    const accountId = acctId || parseInt(settings.get('accountId'), 10) || null;
    verifyAccountIntent(accountId, `flattenPosition ${contractId}`);

    let closeOrderId = null;
    try {
        const positions = await getOpenPositions(accountId);
        const pos = positions.find(p => p.contractId === contractId);
        if (pos && (pos.size > 0)) {
            const exitSide = pos.type === 1 ? 1 : 0;   // long (type 1) → sell=1; short (type 0) → buy=0
            const res = await post('/Order/place', {
                accountId,
                contractId,
                type:      2,
                side:      exitSide,
                size:      pos.size,
                customTag: `BEAST:FLAT:${Date.now()}`,
            }, 'FLATTEN');
            closeOrderId = res?.orderId ?? res?.id ?? null;
            console.log(`[projectx] Flattened ${contractId} (${pos.size}ct, closeId=${closeOrderId})`);
        }
    } catch (e) {
        console.error(`[projectx] flattenPosition(${contractId}): ${e.message}`);
    }

    await cancelAllOrdersFor(contractId, accountId);
    return { closed: closeOrderId != null, closeOrderId, contractId };
}

// Poll for the closing fill price. Returns the fill price (number) or null.
async function waitForFillPrice(orderId, acctId, { maxAttempts = 10, intervalMs = 400 } = {}) {
    for (let i = 0; i < maxAttempts; i++) {
        const filled = await getFilledOrder(orderId, acctId);
        const price  = filled?.fillPrice ?? filled?.filledPrice ?? filled?.avgFillPrice ?? null;
        if (price != null) return Number(price);
        await sleep(intervalMs);
    }
    return null;
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function getAuthStatus() {
    if (!token) return { connected: false, reason: 'no token' };
    const exp = decodeTokenExpiry(token);
    if (exp && Date.now() >= exp) return { connected: false, reason: 'token expired' };
    return { connected: true, expiresAt: exp ? new Date(exp).toISOString() : null };
}

module.exports = {
    authenticate, ensureAuth, placeOrder, getAuthStatus,
    getOpenPositions, getOpenOrders,
    modifyOrder,
    cancelOrder, cancelAllOrdersFor,
    flattenPosition, getFilledOrder, waitForFillPrice,
    getContractIdForFamily, getFixedQty,
    sidesForDirection,
    verifyAccountIntent,  // exported for inline unit tests + external audit
    getToken: () => token,
};
