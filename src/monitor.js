'use strict';

// SignalR hubs — TopstepX real-time events.
//   User hub   — order / position / trade events (always on)
//   Market hub — real-time quotes for subscribed contracts (used by momentum
//                trail; otherwise harmlessly idle even when no trade is active)
//
// User-hub events delivered to the handler bag:
//   onOrder({ id, contractId, status, ... })    — any order status change
//   onPosition({ contractId, size, averagePrice, ... })
//   onTrade({ contractId, orderId, price, ... }) — execution events
//   onQuote({ contractId, lastPrice, bestBid, bestAsk, ... }) — market hub

const signalR = require('@microsoft/signalr');

const USER_HUB_URL   = 'https://rtc.topstepx.com/hubs/user';
const MARKET_HUB_URL = 'https://rtc.topstepx.com/hubs/market';

let hub          = null;   // user hub
let marketHub    = null;   // market hub (quote feed)
let connected    = false;  // user-hub state (drives the RTC dashboard dot)
let marketConnected = false;
let handlers     = {};
let currentToken = null;
let currentAcct  = null;
let onPermanentCloseCallback = null;

// Quote subscriptions that must be re-armed after a market-hub reconnect.
const subscribedContracts = new Set();

// Last-tick observability — keyed by contractId → { last, bid, ask, ts }
const lastQuotes = new Map();

// ── Deduplication ───────────────────────────────────────────────────────────
// TopstepX fires both "GatewayUserOrder" and "gatewayuserorder" for every
// event, resulting in doubled handler invocations. Dedup by key within 2s.
const recentKeys = new Map();
const DEDUP_MS   = 2_000;

function isDuplicate(key) {
    const now = Date.now();
    for (const [k, t] of recentKeys) {
        if (now - t > DEDUP_MS) recentKeys.delete(k);
    }
    if (recentKeys.has(key)) return true;
    recentKeys.set(key, now);
    return false;
}

function eventKey(name, d) {
    if (name === 'onOrder')    return `ord:${d.id}:${d.status}`;
    if (name === 'onPosition') return `pos:${d.contractId}:${d.size}`;
    if (name === 'onTrade')    return `trd:${d.contractId}:${d.orderId}:${d.price ?? ''}`;
    if (name === 'onQuote')    return `quote:${d.contractId ?? ''}:${d.lastPrice ?? d.last ?? d.bestBid ?? ''}`;
    return `${name}:${JSON.stringify(d)}`;
}

// SignalR wraps payloads inconsistently — unwrap either form
function unwrapEvent(evt) {
    if (!evt || typeof evt !== 'object') return {};
    return ('data' in evt && evt.data) ? evt.data : evt;
}

function dispatch(name, evt) {
    try {
        const d = unwrapEvent(evt);
        if (isDuplicate(eventKey(name, d))) return;
        const fn = handlers[name];
        if (fn) fn(d);
    } catch (e) {
        console.error(`[RTC] ${name} handler error: ${e.message}`);
    }
}

// Quote observer — always record last-tick, then pass to user handler (if any).
function dispatchQuote(contractId, data) {
    const d = { contractId, ...(data || {}) };
    const last = d.lastPrice ?? d.last ?? null;
    const bid  = d.bestBid   ?? d.bid  ?? null;
    const ask  = d.bestAsk   ?? d.ask  ?? null;
    lastQuotes.set(contractId, {
        last: last != null ? Number(last) : null,
        bid:  bid  != null ? Number(bid)  : null,
        ask:  ask  != null ? Number(ask)  : null,
        ts:   Date.now(),
    });
    dispatch('onQuote', d);
}

// ── Market hub — quotes ─────────────────────────────────────────────────────
// GatewayQuote fires with two arguments: (contractId, data)
// data contains: lastPrice, bestBid, bestAsk, volume, change
async function startMarketHub(token) {
    if (marketHub) {
        try { await marketHub.stop(); } catch {}
        marketHub = null;
        marketConnected = false;
    }

    marketHub = new signalR.HubConnectionBuilder()
        .withUrl(`${MARKET_HUB_URL}?access_token=${token}`, {
            skipNegotiation: true,
            transport: signalR.HttpTransportType.WebSockets,
        })
        .configureLogging(signalR.LogLevel.Warning)
        .withAutomaticReconnect()
        .build();

    marketHub.on('GatewayQuote', (contractId, data) => dispatchQuote(contractId, data));
    marketHub.on('gatewayquote', (contractId, data) => dispatchQuote(contractId, data));

    const thisMarketHub = marketHub;

    thisMarketHub.onreconnecting(() => {
        marketConnected = false;
        console.log('[RTC] Market hub reconnecting...');
    });
    thisMarketHub.onreconnected(async () => {
        marketConnected = true;
        console.log('[RTC] Market hub reconnected — re-subscribing quotes');
        for (const cid of subscribedContracts) {
            try { await thisMarketHub.invoke('SubscribeContractQuotes', cid); } catch {}
        }
    });
    thisMarketHub.onclose(err => {
        marketConnected = false;
        console.log(`[RTC] ${err ? `Market hub closed: ${err.message}` : 'Market hub closed'}`);
        if (marketHub !== thisMarketHub) return;
        if (!currentToken) return;
        console.warn('[RTC] Market hub permanently closed — reconnecting in 15s');
        setTimeout(async () => {
            if (marketHub !== thisMarketHub) return;
            try {
                await startMarketHub(currentToken);
                for (const cid of subscribedContracts) {
                    try { await marketHub.invoke('SubscribeContractQuotes', cid); } catch {}
                }
                console.log('[RTC] Market hub recovered — re-subscribed quotes');
            } catch (e) {
                console.warn(`[RTC] Market hub recovery failed: ${e.message}`);
            }
        }, 15_000);
    });

    await marketHub.start();
    marketConnected = true;
    console.log('[RTC] Connected to market hub');
}

async function stopMarketHub() {
    if (marketHub) {
        try { await marketHub.stop(); } catch {}
        marketHub = null;
        marketConnected = false;
    }
}

async function subscribeContractQuote(contractId) {
    if (!contractId) return false;
    subscribedContracts.add(contractId);
    if (!marketHub || !marketConnected) return false;
    try {
        await marketHub.invoke('SubscribeContractQuotes', contractId);
        console.log(`[RTC] Quote feed subscribed for ${contractId}`);
        return true;
    } catch (e) {
        console.warn(`[RTC] Quote subscription failed for ${contractId}: ${e.message}`);
        return false;
    }
}

async function unsubscribeContractQuote(contractId) {
    subscribedContracts.delete(contractId);
    lastQuotes.delete(contractId);
    if (!marketHub) return;
    try { await marketHub.invoke('UnsubscribeContractQuotes', contractId); } catch {}
}

// ── Start / stop ────────────────────────────────────────────────────────────
async function startRtc(token, accountId, eventHandlers, onPermanentClose) {
    handlers     = eventHandlers || {};
    currentToken = token;
    currentAcct  = accountId;
    onPermanentCloseCallback = onPermanentClose || null;

    if (hub) {
        try { await hub.stop(); } catch {}
        hub       = null;
        connected = false;
    }

    hub = new signalR.HubConnectionBuilder()
        .withUrl(`${USER_HUB_URL}?access_token=${token}`, {
            skipNegotiation: true,
            transport: signalR.HttpTransportType.WebSockets,
        })
        .configureLogging(signalR.LogLevel.Warning)
        .withAutomaticReconnect()
        .build();

    // Register both capitalisation variants — dedup handles the double-fire
    hub.on('GatewayUserOrder',    evt => dispatch('onOrder',    evt));
    hub.on('gatewayuserorder',    evt => dispatch('onOrder',    evt));
    hub.on('GatewayUserPosition', evt => dispatch('onPosition', evt));
    hub.on('gatewayuserposition', evt => dispatch('onPosition', evt));
    hub.on('GatewayUserTrade',    evt => dispatch('onTrade',    evt));
    hub.on('gatewayusertrade',    evt => dispatch('onTrade',    evt));
    hub.on('GatewayUserAccount',  () => {});
    hub.on('gatewayuseraccount',  () => {});

    const thisHub = hub;
    let startupComplete = false;

    thisHub.onreconnecting(() => { connected = false; console.log('[RTC] Reconnecting...'); });
    thisHub.onreconnected(() => { connected = true;  console.log('[RTC] Reconnected'); });
    thisHub.onclose(err => {
        connected = false;
        console.log(`[RTC] ${err ? `Closed: ${err.message}` : 'Connection closed'}`);
        if (hub !== thisHub) return;
        if (!onPermanentCloseCallback) return;
        if (!startupComplete) return;
        console.warn('[RTC] Permanently closed — scheduling recovery in 15s');
        setTimeout(() => {
            if (hub !== thisHub) return;
            onPermanentCloseCallback();
        }, 15_000);
    });

    await hub.start();
    connected = true;
    console.log('[RTC] Connected to user hub');

    try {
        await hub.invoke('SubscribeAccounts');
        if (Number.isFinite(accountId) && accountId > 0) {
            await hub.invoke('SubscribeOrders',    accountId);
            await hub.invoke('SubscribePositions', accountId);
            await hub.invoke('SubscribeTrades',    accountId);
            console.log(`[RTC] Subscribed to orders/positions/trades for account ${accountId}`);
        } else {
            console.log('[RTC] No active account — skipping order/position/trade subscriptions');
        }
    } catch (e) {
        connected = false;
        throw new Error(`RTC subscription failed: ${e.message}`);
    }

    startupComplete = true;

    // Market hub is additive — failure here must not break the user hub.
    // Quote feed is only required when atmStrategy='momentum'; in standard
    // mode the market hub runs idle (useful for observability only).
    try {
        await startMarketHub(token);
        for (const cid of subscribedContracts) {
            try { await marketHub.invoke('SubscribeContractQuotes', cid); } catch {}
        }
    } catch (e) {
        console.warn(`[RTC] Market hub unavailable: ${e.message} — standard mode unaffected`);
    }
}

async function stopRtc() {
    await stopMarketHub();
    if (hub) {
        try { await hub.stop(); } catch {}
        hub       = null;
        connected = false;
    }
}

module.exports = {
    startRtc,
    stopRtc,
    subscribeContractQuote,
    unsubscribeContractQuote,
    isConnected:       () => connected,
    isMarketConnected: () => marketConnected,
    getAccountId:      () => currentAcct,
    getLastQuote:      (cid) => lastQuotes.get(cid) || null,
    getSubscribedContracts: () => Array.from(subscribedContracts),
};
