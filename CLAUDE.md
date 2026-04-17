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
  webhook.js    — POST /webhook/signal — validates payload, records trade, places orders
  projectx.js   — ProjectX auth (token file + JWT decode + 401 retry) + 3-order placement
  db.js         — In-memory trade store + analytics engine (WR, expectancy, PF, net monthly)
  dashboard.js  — REST API: GET /api/trades, GET /api/stats, PATCH /api/trades/:id
public/
  index.html    — Black-background SPA: Analytics / Trades / Open tabs
Project_Attachments/
  Daily_Operational_Guide.txt  — John's daily ops reference
  Setup_Guide.txt              — Trader onboarding (clone → .env → npm start → ngrok → TV alert)
```

---

## ProjectX Order Sequence

Three separate orders per signal (no bracket API):

1. **Market entry** (type 2) — full qty, side: 1=Buy (bullish), 0=Sell (bearish)
2. **Stop SL** (type 4) — full qty at `stop` price, exit side
3. **Limit TP1** (type 1) — qty-1 contracts at `tp1` (or full qty if qty=1), exit side
4. **Limit Target** (type 1) — 1 contract runner at `target` (only when qty >= 2), exit side

Custom tag pattern: `BEAST:ENTRY/SL/TP1/TARGET:{timestamp}`

Auth pattern ported from `EvilSignals-Executor/src/orders.js`:
- Token persisted to `logs/.token.json` (survives restarts without re-login)
- JWT `exp` decoded to detect expiry
- 401 interceptor re-authenticates and retries once
- 3-attempt retry with 500ms backoff on all API calls

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

**Required fields:** instrument, direction, action, setup, price, stop, tp1, target
**Validated:** action must be "ENTRY", setup must be "BEAST", direction must be "bullish" or "bearish"
**Optional metadata:** rDist, compression, entryHour, macroTransition, h4ZoneId

---

## Strategy Context (read-only reference — do not build strategy logic here)

**BEAST Mode** = macro zone Inside bar breakout on 1-minute NQ.

**Macro zones per hour:**
- M1 Opening (:00–:09), Dead (:10–:19), M2 Killzone (:20–:39), Dead (:40–:49), M3 Closing (:50–:59)

**Inside detection:** At zone completion (:09/:39/:59), if currentHigh < prevHigh AND currentLow > prevLow → Inside zone. One-macro window rule: Inside expires when next zone completes.

**Entry:** First 1m close above Inside High (bull) or below Inside Low (bear) in a non-dead zone.

**Risk unit:** rDist = Inside zone range (insideHigh - insideLow)
- SL = entry ± rDist
- TP1 = entry ± 0.5 × rDist
- Target = entry ± 1.0 × rDist

**Set F filters (backtested, confirmed OOS — 71.4% WR, +0.071 EV, 461 trades):**
- Hour gate: 08, 11, 13, 14, 16 ET only
- H4 zone exclusions: SH_D, TERM_D, FS_D (not yet implemented in Pine — h4ZoneId = "pending")
- Min rDist: 20 pts
- M3→M1 transitions allowed
- Compression sweet spot: ≤40% (optional, not default)

**Pine Script indicator:** `EvilSignals-Executor/tradingview/Beast_Mode/BEAST_Mode_v1.pine`
**Backtester engine:** `EvilSignals-Executor/backtester/lib/beast-mode-engine.js`
**Backtester runner:** `EvilSignals-Executor/backtester/beast_mode_nq.js`

---

## .env Keys

```
PORT=3100
WEBHOOK_SECRET=                    # optional — x-webhook-secret header check
PROJECTX_API_URL=https://gateway-rtc.main.topstepx.com/api
PROJECTX_USERNAME=
PROJECTX_API_KEY=
PROJECTX_ACCOUNT_ID=
NQ_CONTRACT_ID=CON.F.US.ENQ.M26   # rolls quarterly (H=Mar, M=Jun, U=Sep, Z=Dec)
GC_CONTRACT_ID=CON.F.US.MGC.Q25   # only if GC is enabled
NQ_CONTRACTS=2                     # 1=TP1 only; 2+=TP1 + runner at target
GC_CONTRACTS=1
```

---

## Dashboard

Black background, orange accent. Three tabs:
- **Analytics:** Win Rate, Expectancy (R), Profit Factor, Net Points, Wins/Losses, Net by Month grid
- **Trades:** Full history with manual outcome entry (dropdown: TP1/TARGET/STOPPED/MANUAL + exit price)
- **Open:** Active positions only

Auto-refreshes every 30s. REST API at `/api/trades`, `/api/trades/open`, `/api/stats`.

**Known limitation:** Trade store is in-memory — resets on server restart. Persistent storage (SQLite or flat file) is a future build item.

---

## Build Status and Next Steps

**Done:**
- [x] Express webhook server with payload validation
- [x] ProjectX 3-order sequence (market + stop + limit)
- [x] In-memory trade store with analytics
- [x] Dashboard SPA (black-bg, 3 tabs)
- [x] Auth pattern ported from production executor
- [x] Setup Guide and Daily Operational Guide

**Next:**
- [ ] **Live signal test** — fire paper signal through TV → ngrok → executor, verify 3 orders land
- [ ] **Persistent trade store** — survive server restarts (SQLite or JSONL file)
- [ ] **Automated outcome detection** — monitor ProjectX for SL/TP fills instead of manual entry
- [ ] **H4 zone classification** — Pine v3 will populate h4ZoneId; executor will filter SH_D/TERM_D/FS_D
- [ ] **ATM/trail features** — after basic execution validated; model on Anti-Martingale ATM from parent executor
- [ ] **Contract roll helper** — script or dashboard button to update NQ_CONTRACT_ID on quarterly rolls

---

## Code Style / Rules

- Express 5 (path-to-regexp v8): catch-all routes use `/{*splat}` not `*`
- ProjectX order types: 1=Limit, 2=Market, 4=Stop. Side: 0=Sell, 1=Buy
- Do not add EAI/IBOB/TMAG/ZTAR logic — this executor handles BEAST signals only
- Do not add PM2 — traders run `npm start` directly
- Keep the trader setup path simple: `git clone → npm install → .env → npm start`
- Commit immediately after every code change
- All Pine Script work happens in the EvilSignals-Executor repo, not here
