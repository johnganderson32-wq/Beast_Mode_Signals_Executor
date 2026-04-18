# Beast Mode Signals Executor

## What This Repo Is

Standalone webhook executor for the BEAST Mode strategy. Receives TradingView alert payloads from the BEAST Mode Pine Script indicator and places orders on ProjectX (TopstepX). Built for distribution to a trader group — each trader self-hosts via `npm install && npm start`.

This repo is **execution only**. All strategy research, backtesting, and the Pine Script indicator live in the parent project: `C:\Users\Trader\Documents\Trading\EvilSignals-Executor`. Do not duplicate strategy logic here.

**Owner:** John (BetioChaps)
**GitHub:** `johnganderson32-wq/Beast_Mode_Signals_Executor`
**Parent repo:** `johnganderson32-wq/evilsignals-executor`

---

## Architecture

```
src/
  index.js      — Express server, port 3100, serves public/ SPA
  webhook.js    — POST /webhook/signal — validates, gates via risk.js, sizes, places orders
  projectx.js   — ProjectX auth + order placement + cancel/flatten/fill retrieval
  risk.js       — Dollar-denominated gate stack + session state (ported from EvilSignals)
  contracts.js  — Tick-size / $/pt table, family normalization, tick rounding
  settings.js   — User-configurable settings (contracts, caps, session)
  db.js         — In-memory trade store + analytics (WR, expectancy, PF, net $)
  dashboard.js  — REST API, per-family bias, broker-side flatten, trade-close hooks
  log-stream.js — console → SSE ring buffer for the live log pane
public/
  index.html    — Black-background SPA: Executor + Performance tabs
Project_Attachments/
  Daily_Operational_Guide.txt
  Setup_Guide.txt
logs/
  .token.json    — persisted ProjectX JWT
  daily-pnl.json — persisted session risk state (P&L, streak, bias, counts)
```

---

## ProjectX Order Sequence

Three or four orders per signal (no bracket API):

1. **Market entry** (type 2) — full qty, side: 1=Buy (bullish), 0=Sell (bearish)
2. **Stop SL** (type 4) — full qty at `stop` price, exit side
3. **Limit TP1** (type 1) — qty-1 contracts at `tp1` (or full qty if qty=1), exit side
4. **Limit Target** (type 1) — 1 contract runner at `target` (only when qty >= 2), exit side

Custom tag pattern: `BEAST:{ENTRY|SL|TP1|TARGET|FLAT}:{timestamp}`

Auth pattern ported from `EvilSignals-Executor/src/orders.js`:
- Token persisted to `logs/.token.json`
- JWT `exp` decoded; 401 interceptor re-authenticates and retries once
- 3-attempt retry with 500ms backoff on all API calls

---

## Contract Specs

All math lives in `src/contracts.js`. Product code is parsed from the ProjectX contract ID (`CON.F.US.<CODE>.<EXPIRY>`).

| Code | Tick size | Tick value | $/pt  | Family |
|------|-----------|-----------|-------|--------|
| ENQ  | 0.25      | $5.00     | $20   | NQ     |
| MNQ  | 0.25      | $0.50     | $2    | NQ     |
| GC   | 0.10      | $10.00    | $100  | GC     |
| MGC  | 0.10      | $1.00     | $10   | GC     |
| ES   | 0.25      | $12.50    | $50   | ES     |
| MES  | 0.25      | $1.25     | $5    | ES     |

---

## Enforced Risk Gates (src/risk.js)

All caps are in **dollars**. Gate stack evaluated in order inside `risk.check()`:

1. **Daily profit cap** — if `dailyPnl ≥ cap`, trading auto-disables; signals blocked.
2. **Master trading toggle** — OFF blocks everything. Resets to OFF on every new trading day.
3. **Daily loss cap** — if `dailyPnl ≤ -cap`, trading auto-disables.
4. **Session close (hard stop)** — `sessionClose` (HH:MM ET) through 18:00 ET Globex reopen blocks all entries.
5. **Per-family open position** — no hedging. One NQ *or* MNQ at a time; one GC *or* MGC; one ES *or* MES.
6. **Direction bias** — per family (`NQ`/`GC`/`ES`): ALL / LONG / SHORT.
7. **Per-trade loss cap** — when Dynamic Sizing is OFF: if SL-dollar risk with fixed qty > cap, block.

### Dynamic Sizing

Toggle in the settings panel. When ON:
- `qty = floor(perTradeLossCap$ / (slPoints × $/pt))` per contract, clamped to product-specific fixed qty only if dynamic is OFF
- `perTradeLossCap = 0` while Dynamic Sizing is ON blocks every signal
- If computed qty < 1 (risk insufficient for one contract), the signal is blocked
When OFF, fixed contract quantities per product code are used.

### Consecutive Loss Circuit Breaker

`recordTradeResult(status, pnlDollars)` runs on every trade close:
- `STOPPED` with `pnl ≤ 0` → increments streak
- `TP1` or `TARGET` → resets streak
- `MANUAL` (including FLATTEN) → skipped; trader intervention does not count

When `consecutiveLossLimit` is hit:
- Trading toggles OFF
- `circuitBreakerFiredAt = Date.now()`
- A 30s interval auto-resumes trading after `pauseDuration` minutes (0 = rest of day)

### Session / Trading-Day Rollover

- Trading day: ≥18:00 ET rolls to the next calendar day
- Saturday / Sunday → Friday
- On rollover: P&L resets to $0, streak to 0, bias to ALL, `tradingEnabled = false`
- State persisted to `logs/daily-pnl.json` (survives restart within the same session)

---

## Flatten (broker-side)

`POST /api/flatten` does the full close cycle:

1. For each open trade's `contractId`, call `px.flattenPosition(contractId)`
2. Places an opposing market order for the full open size → captures `closeOrderId`
3. Cancels all working orders for that contract
4. Polls `/Order/searchHistorical` / `searchClosed` / `search` for the fill price
5. Updates each affected DB row: status=MANUAL, exitPrice, pnlPoints, pnlDollars, rMultiple
6. Flips dailyPnl by the realized $ amount
7. Does NOT touch the consecutive-loss streak (MANUAL is a streak no-op)

---

## Webhook Payload (from Pine Script indicator)

```json
{
  "instrument":      "NQ",
  "direction":       "bullish",
  "action":          "ENTRY",
  "setup":           "BEAST",
  "price":           21500.25,
  "stop":            21450.25,
  "tp1":             21525.25,
  "target":          21550.25,
  "rDist":           50.0,
  "compression":     38.5,
  "entryHour":       11,
  "macroTransition": "M2_to_M3",
  "h4ZoneId":        "pending"
}
```

**Required:** instrument, direction, action, setup, price, stop, tp1, target
**Validated:** action must be "ENTRY", setup must be "BEAST", direction in {bullish, bearish}

---

## Strategy Context (read-only — do not build strategy here)

**BEAST Mode** = macro zone Inside bar breakout on 1-minute NQ.

**Macro zones per hour:** M1 Opening (:00–:09), Dead (:10–:19), M2 Killzone (:20–:39), Dead (:40–:49), M3 Closing (:50–:59)

**Inside detection:** at zone completion (:09/:39/:59), if currentHigh < prevHigh AND currentLow > prevLow → Inside zone. Inside expires when the next zone completes.

**Entry:** first 1m close above Inside High (bull) or below Inside Low (bear) in a non-dead zone.

**Risk unit:** `rDist` = Inside zone range (insideHigh − insideLow). SL = entry ± rDist. TP1 = entry ± 0.5×rDist. Target = entry ± 1.0×rDist.

**Set F filters (OOS confirmed — 71.4% WR, +0.071 EV, 461 trades):** hours 08/11/13/14/16 ET; H4 exclusions SH_D/TERM_D/FS_D (pending in Pine v3); min rDist 20 pts; M3→M1 allowed; compression ≤40% (optional).

**Pine Script:** `EvilSignals-Executor/tradingview/Beast_Mode/BEAST_Mode_v1.pine`

---

## Dashboard (public/index.html)

Two tabs: **EXECUTOR** (active trade + live log + settings) and **PERFORMANCE** (stats, trade history, net-by-month in $). Black background, orange accent. Auto-refreshes every 5s (status) / 15s (health).

**Header widgets:** ProjectX / RTC / Ngrok dots, ATM badge (Standard / Momentum), per-family bias buttons (NQ / GC / ES), TRADING ON/OFF toggle.

**Active trade card:** shows entry/SL/TP1/target/qty, plus a red "TRADING DISABLED — <reason>" banner driven by `risk.getBlockReason()`.

**Settings panel:** account, per-family contract IDs, per-product fixed quantities, Dynamic Sizing pill, Daily/Profit/Per-Trade caps ($), session close, consec-loss limit + pause, ATM strategy (momentum deferred).

---

## RTC / Momentum Build Path (future)

`atmStrategy = 'momentum'` is UI-visible but not yet wired. Build path when ready:

1. Port `src/monitor.js` from `EvilSignals-Executor` (SignalR quote connection)
2. Subscribe to NQ / GC / ES tick feed
3. Implement momentum trail logic — same `activationPct` + `trailPct` pattern as EAI
4. RTC dot goes green when the SignalR client is connected

---

## Build Status and Priority List

**Done:**
- [x] Express webhook server with payload validation
- [x] ProjectX 3-order sequence (market + stop + limit + runner)
- [x] In-memory trade store with analytics
- [x] Dashboard SPA (2 tabs)
- [x] Dollar-denominated gate stack (daily loss/profit, session close, streak, per-family positions, bias, dynamic sizing)
- [x] Broker-side FLATTEN with real fill price retrieval
- [x] Session-state persistence (`logs/daily-pnl.json`)

**Priority list (in order):**
1. **Live signal test** — TV → ngrok → executor → verify gates + orders + dashboard flow end-to-end
2. **Persistent trade store** — SQLite or JSONL so trade history survives restart (separate from daily-pnl.json)
3. **Automated outcome detection** — subscribe to ProjectX user hub / poll fills so STOPPED/TP1/TARGET update without manual entry
4. **H4 zone classification** — Pine v3 populates `h4ZoneId`; executor filters SH_D/TERM_D/FS_D
5. **RTC quote feed + momentum trail** — see build path above
6. **Contract roll helper** — dashboard button to advance expiry codes

---

## Code Style / Rules

- Express 5 (path-to-regexp v8): catch-all routes use `/{*splat}` not `*`
- ProjectX order types: 1=Limit, 2=Market, 4=Stop. Side: 0=Sell, 1=Buy
- All risk caps are DOLLARS. Points/ticks only used inside order placement math.
- Do not add EAI/IBOB/TMAG/ZTAR logic — this executor handles BEAST signals only
- Do not add PM2 — traders run `npm start` directly
- Keep the trader setup path simple: `git clone → npm install → .env → npm start`
- Commit immediately after every code change
- All Pine Script work happens in the EvilSignals-Executor repo, not here
