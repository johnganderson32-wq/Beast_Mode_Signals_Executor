'use strict';

// ProjectX API client
// Docs: https://gateway.main.topstepx.com/swagger/index.html

const BASE_URL = (process.env.PROJECTX_BASE_URL || 'https://gateway.main.topstepx.com').replace(/\/$/, '');

let _token     = null;
let _tokenExp  = 0;   // unix ms

async function _post(path, body, authRequired = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (authRequired && _token) {
        headers['Authorization'] = `Bearer ${_token}`;
    }
    const res = await fetch(`${BASE_URL}${path}`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ProjectX ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

async function authenticate() {
    const data = await _post('/api/Auth/loginKey', {
        userName: process.env.PROJECTX_USERNAME,
        apiKey:   process.env.PROJECTX_API_KEY,
    }, false);

    if (!data.token) {
        throw new Error(`ProjectX auth failed: ${JSON.stringify(data)}`);
    }
    _token    = data.token;
    // Tokens are valid for 24 h; refresh 30 min before expiry
    _tokenExp = Date.now() + (23.5 * 60 * 60 * 1000);
    console.log('[projectx] Authenticated');
    return _token;
}

async function ensureAuth() {
    if (!_token || Date.now() >= _tokenExp) {
        await authenticate();
    }
}

// instrument: 'NQ' | 'GC' → maps to CONTRACT_ID from env
function contractId(instrument) {
    const key = `${instrument.toUpperCase()}_CONTRACT_ID`;
    const id  = process.env[key];
    if (!id) throw new Error(`No contract ID configured for ${instrument} (set ${key} in .env)`);
    return id;
}

function contractQty(instrument) {
    const key = `${instrument.toUpperCase()}_CONTRACTS`;
    return parseInt(process.env[key] || '1', 10);
}

// Place a market order with bracket (SL + TP)
// direction: 'bullish' | 'bearish'
async function placeOrder({ instrument, direction, stop, tp1, target }) {
    await ensureAuth();

    const accountId = process.env.PROJECTX_ACCOUNT_ID;
    if (!accountId) throw new Error('PROJECTX_ACCOUNT_ID not set in .env');

    const side = direction === 'bullish' ? 'Buy' : 'Sell';
    const qty  = contractQty(instrument);
    const cId  = contractId(instrument);

    // ProjectX bracket order: entry + SL + TP
    // TP1 is treated as the primary exit; target (1R) left as a separate limit
    const body = {
        accountId:  parseInt(accountId, 10),
        contractId: cId,
        type:       'Market',
        side,
        size:       qty,
        // Bracket legs
        stopPrice:  stop,
        limitPrice: tp1,
    };

    const res = await _post('/api/Order/place', body);
    console.log(`[projectx] Order placed: ${side} ${qty}x ${instrument} SL=${stop} TP=${tp1}`, res);
    return res;
}

module.exports = { authenticate, placeOrder };
