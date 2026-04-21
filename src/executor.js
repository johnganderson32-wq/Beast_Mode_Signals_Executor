'use strict';

// Trade lifecycle executor — SignalR + 5s REST poll fallback.
//
// Handles everything that happens between order placement (webhook.js) and
// trade settlement:
//   1. RTC event handlers update fill prices + flip booked flags
//   2. When every leg of a trade is resolved, settleTrade() closes the record:
//        - db.update(..., status='TP1'|'TARGET'|'STOPPED'|'MANUAL', exitPrice, pnl...)
//        - risk.addPnl() / risk.recordTradeResult()
//        - cancelAllOrdersFor(contractId)   ← closes naked-SL gap
//        - remove from activeTrades cache
//   3. A 5s REST poll reconciles any SignalR event that was dropped
//
// Persistence: activeTrades cache survives restart via logs/active-trades.json.
// On boot, rebuildFromDb() reconstructs state from any OPEN trade record.

const fs        = require('fs');
const path      = require('path');
const db        = require('./db');
const risk      = require('./risk');
const px        = require('./projectx');
const monitor   = require('./monitor');
const settings  = require('./settings');
const contracts = require('./contracts');
const { LOG_DIR } = require('./paths');

const CACHE_FILE = path.join(LOG_DIR, 'active-trades.json');
const SCHEMA_VER = 1;
const POLL_MS    = 5000;
// onTrade (actual execution price) can arrive slightly after the onOrder
// status=2 (trigger price) event. Wait a short beat before resolving P&L so
// the blended exit reflects the real fill, not the stop trigger.
const FILL_SETTLE_MS = 1500;

// ── In-memory cache of open trades, keyed by contractId ─────────────────────
const activeTrades = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Persistence ─────────────────────────────────────────────────────────────
function saveCache() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const tmp = CACHE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ _v: SCHEMA_VER, trades: activeTrades }));
        fs.renameSync(tmp, CACHE_FILE);
    } catch (e) {
        console.warn(`[executor] saveCache: ${e.message}`);
    }
}

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (!raw || raw._v !== SCHEMA_VER || !raw.trades) return;
        for (const [cid, st] of Object.entries(raw.trades)) activeTrades[cid] = st;
        const n = Object.keys(activeTrades).length;
        if (n) console.log(`[executor] Restored ${n} active trade(s) from cache`);
    } catch (e) {
        console.warn(`[executor] loadCache: ${e.message}`);
    }
}

// Rebuild cache entries for any OPEN trade in the db that has its orderIds
// but isn't in the activeTrades cache. Runs on boot — covers the case where
// active-trades.json was lost but trades.jsonl still has the record.
function rebuildFromDb() {
    for (const t of db.getOpen()) {
        if (!t.contractId || activeTrades[t.contractId]) continue;
        if (!t.orderIds || !t.orderIds.entry) continue;
        const st = buildState(t);
        if (st) {
            activeTrades[t.contractId] = st;
            console.log(`[executor] Rebuilt cache for trade ${t.id} (${t.contractId})`);
        }
    }
    saveCache();
}

function buildState(t) {
    const spec = contracts.getSpec(t.contractId);
    if (!spec) return null;
    const side    = String(t.direction).toLowerCase() === 'bullish' ? 0 : 1;
    const qty     = Number(t.qty) || 1;
    const tp1Qty  = qty === 1 ? 1 : qty - 1;
    const tp2Qty  = qty >= 2 ? 1 : 0;
    return {
        tradeId:      t.id,
        contractId:   t.contractId,
        label:        t.instrument,
        direction:    t.direction,
        side,
        exitSide:     side === 0 ? 1 : 0,
        size:         qty,
        tp1Qty,
        tp2Qty,
        entryPrice:       Number(t.entryPrice),
        actualEntryPrice: null,
        slPrice:          Number(t.stop),
        tp1Price:         Number(t.tp1),
        tp2Price:         Number(t.target),
        rDist:            t.rDist ? Number(t.rDist) : null,
        entryOrderId: t.orderIds?.entry  ?? null,
        slOrderId:    t.orderIds?.sl     ?? null,
        tp1OrderId:   t.orderIds?.tp1    ?? null,
        tp2OrderId:   t.orderIds?.target ?? null,
        tp1FillPrice: null,
        tp2FillPrice: null,
        slFillPrice:  null,
        manualCloseFill: null,
        tp1Booked: false,
        tp2Booked: false,
        slBooked:  false,
        slResizedOnTp1: false,  // race guard: SL already shrunk to runner qty
        settled:   false,
        tickSize:              spec.tickSize,
        pointValue:            spec.pointValue,
        commissionPerContract: contracts.getCommissionPerContract(t.contractId),
        accountId:  parseInt(settings.get('accountId') || process.env.PROJECTX_ACCOUNT_ID, 10),
        armedAt:    Date.now(),
    };
}

// Called by webhook.js immediately after a successful placeOrder
function registerTrade(tradeRow) {
    const st = buildState(tradeRow);
    if (!st) {
        console.warn(`[executor] registerTrade: no spec for ${tradeRow.contractId}`);
        return;
    }
    activeTrades[st.contractId] = st;
    saveCache();
    console.log(`[executor] Tracking trade ${st.tradeId} (${st.contractId}) — entry=${st.entryPrice} SL=${st.slPrice} TP1=${st.tp1Price} T=${st.tp2Price} ${st.size}ct`);
}

function removeFromCache(contractId) {
    delete activeTrades[contractId];
    saveCache();
}

// ── Fill price resolution ───────────────────────────────────────────────────
function parseFillPrice(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const raw = obj.filledPrice ?? obj.avgFillPrice ?? obj.fillPrice ?? obj.executionPrice
             ?? obj.executePrice ?? obj.executedPrice ?? obj.averageFillPrice ?? obj.price ?? null;
    return raw != null ? Number(raw) : null;
}

function roundToTick(price, tickSize) {
    if (!tickSize) return price;
    return Math.round(price / tickSize) * tickSize;
}

async function resolveExitPrice(orderId, cachedFill, fallbackPrice, tickSize) {
    if (cachedFill != null) return cachedFill;
    if (orderId != null) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) await sleep(800);
            try {
                const filled = await px.getFilledOrder(orderId);
                const fp = parseFillPrice(filled);
                if (fp != null) return roundToTick(Number(fp), tickSize);
            } catch {}
        }
    }
    return fallbackPrice;
}

// ── P&L math ────────────────────────────────────────────────────────────────
function pointsSigned(fillPrice, entry, direction) {
    const raw = fillPrice - entry;
    return String(direction).toLowerCase() === 'bullish' ? raw : -raw;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ── Core settlement ─────────────────────────────────────────────────────────
// Resolve remaining fill prices, compute final P&L, flip the db record,
// update risk, cancel any still-working protective orders, remove from cache.
async function settleTrade(contractId, outcome, source) {
    const st = activeTrades[contractId];
    if (!st || st.settled) return;
    st.settled = true;                   // race guard against RTC + POLL collisions
    saveCache();

    const entry = st.actualEntryPrice ?? st.entryPrice;

    // Pull fills for any leg flagged as booked but without a captured price.
    if (st.tp1Booked && st.tp1FillPrice == null) st.tp1FillPrice = await resolveExitPrice(st.tp1OrderId, null, st.tp1Price, st.tickSize);
    if (st.tp2Booked && st.tp2FillPrice == null) st.tp2FillPrice = await resolveExitPrice(st.tp2OrderId, null, st.tp2Price, st.tickSize);
    if (st.slBooked  && st.slFillPrice  == null) st.slFillPrice  = await resolveExitPrice(st.slOrderId,  null, st.slPrice,  st.tickSize);

    // Aggregate per-leg points + dollars; blended exit price for the record.
    let totalPoints  = 0;
    let totalDollars = 0;
    let weightedExit = 0;
    let totalQty     = 0;

    function add(fill, qty) {
        if (fill == null || !qty) return;
        const pts = pointsSigned(fill, entry, st.direction);
        totalPoints  += pts * qty;
        totalDollars += pts * st.pointValue * qty;
        weightedExit += fill * qty;
        totalQty     += qty;
    }
    if (st.tp1Booked) add(st.tp1FillPrice, st.tp1Qty);
    if (st.tp2Booked) add(st.tp2FillPrice, st.tp2Qty);
    if (st.slBooked) {
        const slQty = st.tp1Booked ? st.tp2Qty : st.size;  // runner-only if TP1 already booked
        add(st.slFillPrice, slQty);
    }
    if (st.manualCloseFill != null && !st.tp1Booked && !st.tp2Booked && !st.slBooked) {
        add(st.manualCloseFill, st.size);
    }

    const qtySize   = totalQty || st.size;
    const avgPoints = round2(totalPoints / qtySize);
    const blendExit = totalQty > 0 ? round2(weightedExit / totalQty) : null;
    const commission = round2(st.commissionPerContract * qtySize);
    const netDollars = round2(totalDollars - commission);
    const rMultiple  = st.rDist > 0 ? round2(avgPoints / st.rDist) : null;

    db.update(st.tradeId, {
        status:     outcome,
        exitPrice:  blendExit,
        exitTime:   new Date().toISOString(),
        pnlPoints:  avgPoints,
        pnlDollars: netDollars,
        commission,
        rMultiple,
    });

    // Daily P&L + streak bookkeeping (MANUAL skips streak per risk.js)
    risk.addPnl(netDollars);
    risk.recordTradeResult(outcome, netDollars);

    console.log(`[${source}] ${st.label} ${outcome} exit=${blendExit} pts=${avgPoints} net=$${netDollars} comm=$${commission}${rMultiple != null ? ` R=${rMultiple}` : ''}`);

    // Cancel any siblings still working at the broker — closes the naked-SL
    // gap that left a 4-lot BUY stop sitting after full-target on 2026-04-21.
    try { await px.cancelAllOrdersFor(contractId, st.accountId); } catch {}

    // SAFETY NET: after settlement we should be flat. If a stale SL over-filled
    // or any other path left a reverse position, flatten it at market before
    // we remove the cache entry. This is the last line of defense against the
    // 2026-04-21 orphaned-SL incident.
    try {
        const positions = await px.getOpenPositions(st.accountId);
        const residual  = positions.find(p => p.contractId === contractId);
        if (residual && residual.size > 0) {
            console.error(`[SAFETY] ${st.label} residual ${residual.size}ct position after settle — emergency flatten`);
            await px.flattenPosition(contractId, st.accountId);
        }
    } catch (e) {
        console.warn(`[SAFETY] ${st.label} post-settle check failed: ${e.message}`);
    }

    removeFromCache(contractId);
}

// Determine the outcome label given which legs booked.
function classifyOutcome(st) {
    const tp1 = st.tp1Booked, tp2 = st.tp2Booked, sl = st.slBooked;
    if (tp2 && tp1)            return 'TARGET';        // full winner: TP1 + runner to target
    if (tp1 && sl)             return 'TP1';           // partial winner: TP1 then SL on runner
    if (tp1 && !tp2 && !sl && st.tp2Qty === 0) return 'TP1'; // 1-ct trade: TP1 = full exit
    if (sl && !tp1 && !tp2)    return 'STOPPED';
    if (tp2 && !tp1)           return 'TARGET';        // uncommon: target without TP1 (race)
    return 'MANUAL';
}

// ── RTC event handlers ──────────────────────────────────────────────────────
async function handleOrderUpdate(d) {
    const { id, contractId, status } = d;
    const st = activeTrades[contractId];
    if (!st || st.settled) return;
    if (Date.now() < st.armedAt) return;

    // Order filled (status 2)
    if (status !== 2) return;

    const oid = Number(id);
    const fill = parseFillPrice(d);
    const hit = p => p != null ? roundToTick(Number(p), st.tickSize) : null;

    // TP1 filled
    if (st.tp1OrderId && oid === Number(st.tp1OrderId) && !st.tp1Booked) {
        if (fill != null) st.tp1FillPrice = hit(fill);
        st.tp1Booked = true;
        saveCache();
        console.log(`[RTC] ${st.label} TP1 filled @ ${st.tp1FillPrice ?? st.tp1Price}`);

        // CRITICAL: shrink SL from full-qty to runner-qty. If this fails we
        // flatten immediately — leaving a stale full-qty SL is how we ended
        // up short 2ct MNQ @ 26723.75 on 2026-04-21 when SL over-filled.
        if (st.tp2Qty > 0 && st.slOrderId && !st.slResizedOnTp1) {
            st.slResizedOnTp1 = true;
            saveCache();
            try {
                await px.modifyOrder(st.slOrderId, { size: st.tp2Qty }, st.accountId);
                console.log(`[RTC] ${st.label} SL resized ${st.size}→${st.tp2Qty}ct (runner only)`);
            } catch (e) {
                console.error(`[RTC] ${st.label} SL resize FAILED: ${e.message} — emergency flatten`);
                try { await px.flattenPosition(contractId, st.accountId); } catch {}
                await settleTrade(contractId, 'MANUAL', 'RTC-SAFETY');
                return;
            }
        }

        if (st.tp2Qty === 0) {
            await sleep(FILL_SETTLE_MS);
            await settleTrade(contractId, 'TP1', 'RTC');
        }
        return;
    }

    // Target (tp2 runner) filled → full winner
    if (st.tp2OrderId && oid === Number(st.tp2OrderId) && !st.tp2Booked) {
        if (fill != null) st.tp2FillPrice = hit(fill);
        st.tp2Booked = true;
        saveCache();
        console.log(`[RTC] ${st.label} TARGET filled @ ${st.tp2FillPrice ?? st.tp2Price}`);
        await sleep(FILL_SETTLE_MS);
        await settleTrade(contractId, classifyOutcome(st), 'RTC');
        return;
    }

    // SL filled
    if (st.slOrderId && oid === Number(st.slOrderId) && !st.slBooked) {
        if (fill != null) st.slFillPrice = hit(fill);
        st.slBooked = true;
        saveCache();
        console.log(`[RTC] ${st.label} SL filled @ ${st.slFillPrice ?? st.slPrice}`);
        await sleep(FILL_SETTLE_MS);
        await settleTrade(contractId, classifyOutcome(st), 'RTC');
        return;
    }
}

async function handlePositionUpdate(d) {
    const { contractId, size, averagePrice } = d;
    const st = activeTrades[contractId];
    if (!st || st.settled) return;
    if (Date.now() < st.armedAt) return;

    // Capture the actual entry fill for accurate P&L
    if (!st.actualEntryPrice && averagePrice && size > 0) {
        st.actualEntryPrice = roundToTick(Number(averagePrice), st.tickSize);
        const slip = (st.actualEntryPrice - st.entryPrice).toFixed(2);
        console.log(`[ENTRY] ${st.label} actual fill @ ${st.actualEntryPrice} (signal: ${st.entryPrice}, slip: ${slip >= 0 ? '+' : ''}${slip})`);
        // Reflect actual entry price on the trade record for display + downstream P&L
        db.update(st.tradeId, { entryPrice: st.actualEntryPrice });
        saveCache();
    }

    // Position shrunk to the runner size — TP1 fill via position-event path.
    // If the order-event path didn't beat us to the SL resize, do it now.
    if (size > 0 && st.tp2Qty > 0 && size === st.tp2Qty
            && !st.tp1Booked && !st.slResizedOnTp1 && st.slOrderId) {
        st.tp1Booked = true;
        st.slResizedOnTp1 = true;
        saveCache();
        console.log(`[RTC] ${st.label} position shrunk to runner — inferring TP1 fill`);
        try {
            await px.modifyOrder(st.slOrderId, { size: st.tp2Qty }, st.accountId);
            console.log(`[RTC] ${st.label} SL resized ${st.size}→${st.tp2Qty}ct (position-event path)`);
        } catch (e) {
            console.error(`[RTC] ${st.label} SL resize FAILED (pos path): ${e.message} — emergency flatten`);
            try { await px.flattenPosition(st.contractId, st.accountId); } catch {}
            await settleTrade(st.contractId, 'MANUAL', 'RTC-SAFETY');
            return;
        }
    }

    // Position closed — fallback path if an order fill event was dropped
    if (size === 0) {
        if (st.tp1Booked || st.tp2Booked || st.slBooked) return; // RTC order path will settle
        console.log(`[RTC] ${st.label} position flat — deriving outcome via REST`);
        await reconcileFromBroker(st, 'RTC');
    }
}

async function handleTradeUpdate(d) {
    const { contractId, orderId } = d;
    const st = activeTrades[contractId];
    if (!st || st.settled) return;

    // Execution events carry the exact TSX fill price — overwrite trigger
    // prices captured from onOrder so resolveExitPrice uses the real number.
    const fill = parseFillPrice(d);
    if (fill == null) return;
    const price = roundToTick(Number(fill), st.tickSize);
    const oid   = Number(orderId);

    if (oid === Number(st.slOrderId))                              { st.slFillPrice  = price; saveCache(); }
    if (oid === Number(st.tp1OrderId) && st.tp1FillPrice == null) { st.tp1FillPrice = price; saveCache(); }
    if (oid === Number(st.tp2OrderId) && st.tp2FillPrice == null) { st.tp2FillPrice = price; saveCache(); }

    // Entry fill correction — preferred over position.averagePrice when
    // both arrive (trade event carries the exact execution price).
    if (st.entryOrderId && oid === Number(st.entryOrderId)) {
        const prev = st.actualEntryPrice;
        st.actualEntryPrice = price;
        if (prev == null || prev !== price) {
            const slip = (price - st.entryPrice).toFixed(2);
            console.log(`[ENTRY] ${st.label} entry fill (trade event): ${prev ?? '?'} → ${price} (slip ${slip >= 0 ? '+' : ''}${slip})`);
            db.update(st.tradeId, { entryPrice: price });
        }
        saveCache();
    }

    // Unknown orderId = manual TSX close. Record fill so settle uses it.
    const isKnown = [st.slOrderId, st.tp1OrderId, st.tp2OrderId, st.entryOrderId]
        .filter(x => x != null).map(Number).includes(oid);
    if (!isKnown && st.manualCloseFill == null) {
        const entryFill = st.actualEntryPrice ?? st.entryPrice;
        // Late entry fill arriving via onTrade looks like an unknown order;
        // reject fills within 1 tick of entry as false positives.
        const looksLikeEntry = Math.abs(price - entryFill) <= st.tickSize;
        if (!looksLikeEntry) {
            st.manualCloseFill = price;
            console.log(`[RTC] ${st.label} manual close fill captured @ ${price} (orderId=${oid})`);
            saveCache();
        }
    }
}

// ── Reconciliation ─────────────────────────────────────────────────────────
// Called when RTC reports position flat with no booked leg (event dropped),
// OR by the 5s poll when the broker shows position flat but cache says open.
async function reconcileFromBroker(st, source) {
    if (st.settled) return;
    try {
        const openOrders = await px.getOpenOrders(st.accountId);
        const openIds = new Set(openOrders.map(o => String(o.orderId ?? o.id)));
        const tp1Gone = st.tp1OrderId && !openIds.has(String(st.tp1OrderId));
        const tp2Gone = st.tp2OrderId && !openIds.has(String(st.tp2OrderId));
        const slGone  = st.slOrderId  && !openIds.has(String(st.slOrderId));

        // Infer booked flags from which protective orders disappeared
        if (tp1Gone && !st.tp1Booked) st.tp1Booked = true;
        if (tp2Gone && !st.tp2Booked) st.tp2Booked = true;
        if (slGone  && !st.slBooked)  st.slBooked  = true;
        saveCache();

        const outcome = classifyOutcome(st);
        await settleTrade(st.contractId, outcome, source);
    } catch (e) {
        console.warn(`[${source}] ${st.label} reconcile failed: ${e.message} — marking MANUAL`);
        await settleTrade(st.contractId, 'MANUAL', source);
    }
}

// ── 5s REST poll fallback ──────────────────────────────────────────────────
let pollRunning = false;
let pollTimer   = null;

async function pollPositions() {
    if (pollRunning) return;
    if (Object.keys(activeTrades).length === 0) return;
    pollRunning = true;
    try {
        const positions = await px.getOpenPositions();
        for (const st of Object.values(activeTrades)) {
            if (st.settled) continue;
            if (Date.now() < st.armedAt) continue;
            const pos = positions.find(p => p.contractId === st.contractId);
            if (!pos || pos.size === 0) {
                await reconcileFromBroker(st, 'POLL');
            }
        }
    } catch (e) {
        console.warn(`[POLL] ${e.message}`);
    } finally {
        pollRunning = false;
    }
}

function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(pollPositions, POLL_MS);
    pollTimer.unref?.();
}
function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function start(token, accountId) {
    loadCache();
    rebuildFromDb();
    startPoll();
    if (!token) {
        console.warn('[executor] start: no token — RTC not started (call start() again after auth)');
        return;
    }
    await monitor.startRtc(token, accountId, {
        onOrder:    handleOrderUpdate,
        onPosition: handlePositionUpdate,
        onTrade:    handleTradeUpdate,
    }, async () => {
        // Permanent close — re-authenticate and restart RTC with a fresh token
        try {
            await px.authenticate({ force: true });
            const freshTok = px.getToken();
            if (freshTok) await start(freshTok, accountId);
        } catch (e) {
            console.error(`[executor] RTC recovery failed: ${e.message}`);
        }
    });
}

async function stop() {
    stopPoll();
    await monitor.stopRtc();
}

module.exports = {
    start,
    stop,
    registerTrade,
    settleTrade,              // exposed for manual testing only
    _state: () => activeTrades,
    _handleOrderUpdate:    handleOrderUpdate,
    _handlePositionUpdate: handlePositionUpdate,
    _handleTradeUpdate:    handleTradeUpdate,
};
