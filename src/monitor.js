'use strict';

// SignalR user hub — real-time order / position / trade events from TopstepX.
// Simplified from EvilSignals-Executor/src/monitor.js: BEAST has no momentum
// trail or quote-feed requirements, so the market hub is omitted entirely.
//
// Events delivered to the handler bag:
//   onOrder({ id, contractId, status, ... })    — any order status change
//   onPosition({ contractId, size, averagePrice, ... })
//   onTrade({ contractId, orderId, price, ... }) — execution events

const signalR = require('@microsoft/signalr');

const USER_HUB_URL = 'https://rtc.topstepx.com/hubs/user';

let hub          = null;
let connected    = false;
let handlers     = {};
let currentToken = null;
let currentAcct  = null;
let onPermanentCloseCallback = null;

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
}

async function stopRtc() {
    if (hub) {
        try { await hub.stop(); } catch {}
        hub       = null;
        connected = false;
    }
}

module.exports = {
    startRtc,
    stopRtc,
    isConnected: () => connected,
    getAccountId: () => currentAcct,
};
