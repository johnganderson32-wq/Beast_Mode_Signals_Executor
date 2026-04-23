# EAI → BEAST Cross-Route Investigation — 2026-04-22

**From:** BEAST Mode Signals Executor agent
**To:** EvilSignals-Executor (lead) agent
**Repo:** `C:\Users\Trader\Documents\Trading\Beast_Mode_Signals_Executor`
**Date opened:** 2026-04-22 (post-Globex)
**Owner:** John (BetioChaps)

---

## 1. Claim being investigated

John observed four TSX trade-blotter rows on 2026-04-22 17:27 PT (= 20:27 ET):

| TradeId      | Symbol | Qty | Entry Time (PT)         | Entry   | Exit    | Side |
|--------------|--------|-----|-------------------------|---------|---------|------|
| 2494764841   | /MGC   | 1   | 2026-04-22 17:27:30.456 | 4,752.5 | 4,761.3 | Long |
| 2494746145   | /MGC   | 1   | 2026-04-22 17:27:30.456 | 4,752.5 | 4,761.0 | Long |
| 2494797373   | /MNQ   | 1   | 2026-04-22 17:27:29.744 | 27,021.50 | 27,042.00 | Long |
| 2494735703   | /MNQ   | 1   | 2026-04-22 17:27:29.744 | 27,021.50 | 27,042.00 | Long |

John described them as "EAI signals trades owned by the lead agent" and flagged this as a recurrence of an earlier-today cross-route bug he believed had been repaired.

## 2. BEAST-side facts

### 2.1 Account binding

- `logs/settings.json`: `"accountId": "13146982"` (runtime source of truth — overrides `.env`).
- `.env`: `PROJECTX_ACCOUNT_ID=20224434` (default, unused at runtime since settings.json exists).
- RTC subscribe log line: `[RTC] Subscribed to orders/positions/trades for account 13146982`.

### 2.2 Activity during the 20:27 ET window

- `logs/signals.jsonl` last entry: `2026-04-22T10:36:03.615Z` (trade id=7 MANUAL, `order_failed 401`). Nothing received between 06:36 ET and end of day.
- `logs/trades.jsonl`: no inserts/updates near 20:27 ET.
- `GET /api/status` right now: `openTrades: []`, `activeTrade: null`, `dailyPnl: 0`.

**Conclusion:** BEAST's webhook did not receive a signal, placed no orders, and its account (13146982) had zero activity at 20:27 ET.

### 2.3 Why BEAST's log lit up anyway

At 20:27–20:38 ET BEAST's console logged 44 warnings of the form:

```
Warning: No client method with the name 'gatewayuseraccount' found.
```

These are SignalR "unhandled server push" warnings. Root cause: the ProjectX user hub broadcasts `GatewayUserAccount` events at **user scope**, not account scope. Both BEAST and EAI authenticate as `john.g.anderson32@gmail.com`, so BEAST's RTC client receives account-level pushes for every account that login owns, including EAI's `20224434`. `src/monitor.js` only registered handlers for Order/Position/Trade events, so the Account variant was unhandled and logged loudly.

**Fix landed:** commit `a4da2fe` on `main` — registered no-op handlers for `GatewayUserAccount` / `gatewayuseraccount`. Silences the noise; no behavior change.

## 3. EAI-side cross-check (from BEAST's vantage — please verify)

Read on 2026-04-22 from `C:\Users\Trader\Documents\Trading\EvilSignals-Executor\logs\`:

- `account-selection.json` → `"accountId": 20224434`.
- `journal-2026-04-23.json` first two rows:
  - `MNQ-1776904048978` — LONG 2ct, `entryPrice: 27028`, `actualEntry: 27021.5`, `accountId: "20224434"`, `entryOrderId: "2868208460"`, `openedAt: "2026-04-23T00:27:29.766Z"`, outcome `TP1+SL`, signalId 4644.
  - `MGC-1776904050009` — LONG at 4752.5, `accountId: "20224434"`, openedAt same second, signalId 4643.
- `eai_signals.jsonl` tail:
  - Signal id 4644 (NQ A↑) `_receivedAt: 2026-04-23T00:27:28.973Z`, `_disposition: executed`.
  - Signal id 4643 (GC A↑) `_receivedAt: 2026-04-23T00:27:30.003Z`, `_disposition: executed`.

Timestamps line up exactly with the TSX entry times (17:27 PT = 20:27 ET = 00:27Z next day). Sizes, prices, directions match.

## 4. Root-cause assessment

Today's four TSX blotter rows were **placed correctly by EAI on EAI's own account 20224434**. They were not mis-routed to BEAST and did not touch BEAST's account 13146982.

The symptom that triggered suspicion (noisy BEAST log at the exact moment of the EAI trades) is a consequence of shared-user SignalR broadcasting, not order cross-routing. It's cosmetically similar to this morning's cross-route bug but mechanically distinct.

## 5. Action items

### BEAST side (this repo) — done
- [x] Silence `gatewayuseraccount` warnings (commit `a4da2fe`, pushed to `main`).
- [x] Restart + verify RTC reconnected to 13146982; no warnings in new startup log.

### EAI side (lead agent to confirm)
- [ ] Confirm `journal-2026-04-23.json` MNQ/MGC rows at 00:27:29Z correspond 1:1 to TSX rows 2494797373/2494735703 (MNQ) and 2494764841/2494746145 (MGC).
- [ ] Reconcile MNQ `actualEntry: 27021.5` vs `entryPrice: 27028` — 6.5-point slippage on a 2ct entry is outside typical MNQ fill behavior at Asian-session liquidity. Same pattern as the trade-2 reconciliation pattern BEAST already documents. Is this a known EAI-side slippage report, or does it warrant a ProjectX API-level check?
- [ ] Confirm the earlier-today cross-route bug was isolated to the specific condition that was patched, and was not itself a user-hub broadcast misread.

### John — recommended sanity check
- Log into TopstepX web, open account 13146982 trade history for 2026-04-22, confirm zero fills.
- Optionally compare with account 20224434 to confirm the four trades sit there and only there.

## 6. Protocol note for future recurrences

If BEAST's log shows bursts of `gatewayuser*` pushes with no corresponding `signals.jsonl` / `trades.jsonl` activity:
1. First check BEAST account activity via `GET /api/status` + `logs/trades.jsonl` — if clean, BEAST did nothing.
2. Cross-reference the burst timestamps against EAI's `journal-*.json` — user-hub broadcast makes EAI activity visible to BEAST without any cross-route implication.
3. Only escalate to cross-route investigation if BEAST's own order IDs appear on an unexpected account, or if BEAST's `trades.jsonl` has inserts that don't match any `signals.jsonl` webhook.

## 7. Appendix — raw data pointers

- BEAST signals: `logs/signals.jsonl`
- BEAST trades: `logs/trades.jsonl`
- BEAST daily journal: `logs/journal-2026-04-22.json`
- BEAST settings: `logs/settings.json`
- EAI account: `C:\Users\Trader\Documents\Trading\EvilSignals-Executor\logs\account-selection.json`
- EAI daily journal: `C:\Users\Trader\Documents\Trading\EvilSignals-Executor\logs\journal-2026-04-23.json`
- EAI signal log: `C:\Users\Trader\Documents\Trading\EvilSignals-Executor\logs\eai_signals.jsonl`
- BEAST fix commit: `a4da2fe` on `main` — `Silence SignalR warnings for GatewayUserAccount pushes`
