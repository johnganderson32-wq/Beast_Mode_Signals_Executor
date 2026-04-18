'use strict';

// Pre-trade gate stack + session risk state.
//
// Ported from EvilSignals-Executor/src/risk.js with Beast Mode adaptations:
//   * all caps denominated in dollars
//   * session close is a HARD stop until 18:00 ET Globex reopen
//   * max open positions enforced PER FAMILY (NQ / GC / ES) — no hedging
//   * consec-loss streak reset by any win; manual FLATTEN does NOT count

const fs        = require('fs');
const path      = require('path');
const settings  = require('./settings');

const LOG_DIR   = path.join(__dirname, '..', 'logs');
const PNL_FILE  = path.join(LOG_DIR, 'daily-pnl.json');

// Globex reopen is fixed at 18:00 ET — end of the closed window.
const GLOBEX_START = '18:00';

// ---------------------------------------------------------------------------
// TRANSIENT STATE
// ---------------------------------------------------------------------------
let tradingEnabled        = false;
let dailyPnl              = 0;              // dollars
let dailyDate             = null;           // YYYY-MM-DD trading day
let consecutiveLosses     = 0;
let circuitBreakerFiredAt = null;           // ms timestamp; null = not active
let directionBias         = { NQ: 'ALL', GC: 'ALL', ES: 'ALL' };
let signalsExecuted       = 0;
let signalsMissed         = 0;
let signalsTotal          = 0;

// ---------------------------------------------------------------------------
// TRADING-DAY STRING
// Matches dashboard.tradingDayStr(): at/after 18:00 ET rolls to next calendar
// day. Saturday/Sunday roll back to Friday so weekend events land correctly.
// ---------------------------------------------------------------------------
function tradingDayET() {
    const now    = new Date();
    const etHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(now));
    const ref = new Date(etHour >= 18 ? now.getTime() + 24 * 60 * 60 * 1000 : now.getTime());
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
    }).format(ref);
    if      (weekday === 'Sat') ref.setTime(ref.getTime() - 1 * 24 * 60 * 60 * 1000);
    else if (weekday === 'Sun') ref.setTime(ref.getTime() - 2 * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ref);
}

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------
// Atomic write: write to .tmp then rename. rename() is atomic on POSIX and
// on Windows (same volume). If we crash between write and rename, the old
// daily-pnl.json is intact and a stray .tmp is all that's left behind.
function savePnlState() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const data = JSON.stringify({
            _v:   1,
            date: dailyDate,
            pnl:  dailyPnl,
            tradingEnabled,
            consecutiveLosses,
            circuitBreakerFiredAt,
            bias: directionBias,
            signalsExecuted, signalsMissed, signalsTotal,
        });
        const tmp = PNL_FILE + '.tmp';
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, PNL_FILE);
    } catch {}
}

function restorePnlState() {
    try {
        if (!fs.existsSync(PNL_FILE)) return;
        const s     = JSON.parse(fs.readFileSync(PNL_FILE, 'utf8'));
        const today = tradingDayET();
        if (s.date !== today) return;

        dailyDate             = today;
        dailyPnl              = Number(s.pnl) || 0;
        tradingEnabled        = !!s.tradingEnabled;
        consecutiveLosses     = Number(s.consecutiveLosses) || 0;
        circuitBreakerFiredAt = s.circuitBreakerFiredAt || null;
        if (s.bias && typeof s.bias === 'object') {
            for (const k of ['NQ', 'GC', 'ES']) {
                if (['ALL', 'LONG', 'SHORT'].includes(s.bias[k])) directionBias[k] = s.bias[k];
            }
        }
        signalsExecuted = Number(s.signalsExecuted) || 0;
        signalsMissed   = Number(s.signalsMissed)   || 0;
        signalsTotal    = Number(s.signalsTotal)    || 0;

        // If the pause window has already expired while we were offline, resume now
        const pauseMs = settings.get('pauseDuration') * 60_000;
        if (circuitBreakerFiredAt && pauseMs > 0 && Date.now() - circuitBreakerFiredAt >= pauseMs) {
            circuitBreakerFiredAt = null;
            consecutiveLosses     = 0;
            tradingEnabled        = true;
            savePnlState();
            console.log('[risk] Circuit breaker pause expired while offline — trading RESUMED');
        }
        console.log(`[risk] Restored session — dailyPnl=$${dailyPnl.toFixed(2)} streak=${consecutiveLosses} trading=${tradingEnabled ? 'ON' : 'OFF'}`);
    } catch (e) {
        console.warn(`[risk] restorePnlState: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// DAILY ROLLOVER
// On new trading day: reset P&L, streak, bias, counts; force tradingEnabled=OFF
// so the trader must explicitly re-enable each session.
// ---------------------------------------------------------------------------
function checkDailyReset() {
    const today = tradingDayET();
    if (today === dailyDate) return;
    if (dailyDate !== null) {
        console.log(`[risk] New trading day — reset dailyPnl (was $${dailyPnl.toFixed(2)}) streak (was ${consecutiveLosses})`);
    }
    dailyDate             = today;
    dailyPnl              = 0;
    consecutiveLosses     = 0;
    circuitBreakerFiredAt = null;
    directionBias         = { NQ: 'ALL', GC: 'ALL', ES: 'ALL' };
    signalsExecuted       = 0;
    signalsMissed         = 0;
    signalsTotal          = 0;
    tradingEnabled        = false;
    console.log('[risk] New session — trading OFF by default');
    savePnlState();
}

// ---------------------------------------------------------------------------
// SESSION-CLOSE GATE
// Hard stop: no entries from sessionClose (inclusive) through 18:00 ET Globex
// reopen (exclusive). sessionClose blank = never blocks.
// ---------------------------------------------------------------------------
function isPastSessionClose() {
    const close = String(settings.get('sessionClose') || '').trim();
    if (!close) return false;
    const [closeH, closeM] = close.split(':').map(Number);
    const [reopenH, reopenM] = GLOBEX_START.split(':').map(Number);
    if (isNaN(closeH) || isNaN(closeM)) return false;

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find(p => p.type === 'hour').value);
    const min  = Number(parts.find(p => p.type === 'minute').value);
    const cur  = hour * 60 + min;
    return cur >= (closeH * 60 + closeM) && cur < (reopenH * 60 + reopenM);
}

// ---------------------------------------------------------------------------
// CONSEC-LOSS AUTO-RESUME (polled every 30s)
// ---------------------------------------------------------------------------
function checkCircuitBreakerResume() {
    if (tradingEnabled || !circuitBreakerFiredAt) return;
    const pauseMs = settings.get('pauseDuration') * 60_000;
    if (pauseMs > 0 && Date.now() - circuitBreakerFiredAt >= pauseMs) {
        circuitBreakerFiredAt = null;
        consecutiveLosses     = 0;
        tradingEnabled        = true;
        savePnlState();
        console.log(`[risk] Circuit breaker expired — trading RESUMED after ${settings.get('pauseDuration')}m pause`);
    }
}

setInterval(checkCircuitBreakerResume, 30_000).unref();

// ---------------------------------------------------------------------------
// PRE-TRADE GATE
// Returns { ok: true } or { ok: false, reason: string }.
// openFamilies is a Set of product families currently holding OPEN trades.
// ---------------------------------------------------------------------------
function check({ direction, family, slDollars, openFamilies }) {
    checkDailyReset();
    checkCircuitBreakerResume();

    // 1. Profit cap — auto-disables trading on first hit
    const profitCap = Number(settings.get('dailyProfitCap')) || 0;
    if (profitCap > 0 && dailyPnl >= profitCap) {
        if (tradingEnabled) {
            tradingEnabled = false;
            savePnlState();
            console.warn(`[risk] PROFIT CAP HIT — $${dailyPnl.toFixed(2)} ≥ +$${profitCap} — trading DISABLED`);
        }
        return { ok: false, reason: 'daily_profit_cap' };
    }

    // 2. Master trading switch
    if (!tradingEnabled) {
        return { ok: false, reason: 'trading_disabled' };
    }

    // 3. Loss cap — auto-disables on first hit
    const lossCap = Number(settings.get('dailyLossCap')) || 0;
    if (lossCap > 0 && dailyPnl <= -lossCap) {
        if (tradingEnabled) {
            tradingEnabled = false;
            savePnlState();
            console.warn(`[risk] LOSS CAP HIT — $${dailyPnl.toFixed(2)} ≤ -$${lossCap} — trading DISABLED`);
        }
        return { ok: false, reason: 'daily_loss_cap' };
    }

    // 4. Session close hard stop
    if (isPastSessionClose()) {
        return { ok: false, reason: 'session_closed' };
    }

    // 5. Per-family max open position (no hedging)
    if (family && openFamilies && openFamilies.has(family)) {
        return { ok: false, reason: `max_positions_${family.toLowerCase()}` };
    }

    // 6. Direction bias lock
    if (family && !checkBias(direction, family)) {
        const bias = directionBias[family] || 'ALL';
        return { ok: false, reason: `bias_${family.toLowerCase()}_${bias.toLowerCase()}_only` };
    }

    // 7. Per-trade loss cap — only meaningful when dynamicSizing is OFF.
    //    When dynamicSizing is ON, webhook.js computes qty from slDollars and
    //    will block separately if qty < 1.
    if (!settings.get('dynamicSizing')) {
        const perTradeCap = Number(settings.get('perTradeLossCap')) || 0;
        if (perTradeCap > 0 && slDollars != null && slDollars > perTradeCap) {
            return { ok: false, reason: 'per_trade_loss_cap' };
        }
    }

    return { ok: true };
}

// Silent, read-only — for dashboard status display. Never mutates state.
function getBlockReason(openFamilies = new Set()) {
    checkDailyReset();
    const profitCap = Number(settings.get('dailyProfitCap')) || 0;
    const lossCap   = Number(settings.get('dailyLossCap'))   || 0;

    if (profitCap > 0 && dailyPnl >= profitCap) return { reason: 'daily_profit_cap', pnl: dailyPnl, cap: profitCap };
    if (!tradingEnabled) {
        const pauseMs  = settings.get('pauseDuration') * 60_000;
        const resumeAt = circuitBreakerFiredAt && pauseMs > 0 ? circuitBreakerFiredAt + pauseMs : null;
        return { reason: 'trading_disabled', resumeAt };
    }
    if (lossCap > 0 && dailyPnl <= -lossCap) return { reason: 'daily_loss_cap', pnl: dailyPnl, cap: lossCap };
    if (isPastSessionClose())                return { reason: 'session_closed', reopens: GLOBEX_START };
    return null;
}

// ---------------------------------------------------------------------------
// STATE MUTATIONS
// ---------------------------------------------------------------------------
function addPnl(dollars) {
    checkDailyReset();
    dailyPnl += dollars;
    const sign = dollars >= 0 ? '+' : '';
    console.log(`[risk] Daily P&L: $${dailyPnl.toFixed(2)} (${sign}$${dollars.toFixed(2)})`);
    savePnlState();
}

// Called on every trade close with the final status + dollar P&L.
//   status 'STOPPED' with pnl <= 0 → increments streak
//   status 'TP1' / 'TARGET'        → resets streak
//   status 'MANUAL'                → skipped (trader intervention)
function recordTradeResult(status, pnlDollars) {
    if (!status || status === 'MANUAL') return;

    if (status === 'STOPPED' && !(pnlDollars > 0)) {
        consecutiveLosses++;
        savePnlState();
        const limit    = settings.get('consecutiveLossLimit');
        const limitStr = limit > 0 ? ` / ${limit}` : '';
        console.log(`[risk] Consecutive losses: ${consecutiveLosses}${limitStr}`);

        if (limit > 0 && consecutiveLosses >= limit) {
            tradingEnabled        = false;
            circuitBreakerFiredAt = Date.now();
            savePnlState();
            const pauseM = settings.get('pauseDuration');
            const msg = pauseM > 0 ? `trading paused for ${pauseM}m` : 'trading DISABLED until next session';
            console.warn(`[risk] CIRCUIT BREAKER — ${consecutiveLosses} consecutive losses → ${msg}`);
        }
    } else if (status === 'TP1' || status === 'TARGET') {
        if (consecutiveLosses > 0) {
            console.log(`[risk] Consecutive loss streak reset (was ${consecutiveLosses})`);
            consecutiveLosses = 0;
            savePnlState();
        }
    }
}

function setTradingEnabled(enabled) {
    tradingEnabled = !!enabled;
    savePnlState();
    console.log(`[risk] Trading ${tradingEnabled ? 'ENABLED' : 'DISABLED'}`);
}

function setBias(family, value) {
    if (!['NQ', 'GC', 'ES'].includes(family)) return;
    if (!['ALL', 'LONG', 'SHORT'].includes(value)) return;
    directionBias[family] = value;
    savePnlState();
    console.log(`[risk] ${family} bias → ${value}`);
}

function checkBias(direction, family) {
    const bias = directionBias[family] || 'ALL';
    if (bias === 'ALL') return true;
    const isLong = String(direction).toLowerCase() === 'bullish';
    if (bias === 'LONG'  && !isLong) return false;
    if (bias === 'SHORT' &&  isLong) return false;
    return true;
}

function incrementSignals(executed) {
    checkDailyReset();
    signalsTotal++;
    if (executed) signalsExecuted++; else signalsMissed++;
    savePnlState();
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------
module.exports = {
    check,
    getBlockReason,
    addPnl,
    recordTradeResult,
    setTradingEnabled,
    setBias,
    checkBias,
    incrementSignals,
    restorePnlState,
    getBias:              (family) => family ? (directionBias[family] || 'ALL') : { ...directionBias },
    getDailyPnl:          () => { checkDailyReset(); return dailyPnl; },
    getConsecutiveLosses: () => consecutiveLosses,
    getSignalCounts:      () => ({ executed: signalsExecuted, missed: signalsMissed, total: signalsTotal }),
    isTradingEnabled:     () => tradingEnabled,
    getCircuitBreakerResumeAt: () => {
        if (!circuitBreakerFiredAt) return null;
        const pauseMs = settings.get('pauseDuration') * 60_000;
        return pauseMs > 0 ? circuitBreakerFiredAt + pauseMs : null;
    },
};
