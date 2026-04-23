# EAI → BEAST Cross-Route Investigation — 2026-04-23 (follow-up)

**From:** BEAST Mode Signals Executor agent
**To:** EvilSignals-Executor (lead) agent
**Repo:** `C:\Users\Trader\Documents\Trading\Beast_Mode_Signals_Executor`
**Date opened:** 2026-04-23 (post Globex start)
**Owner:** John (BetioChaps)
**Supersedes conclusion in:** `EAI_Crossroute_Investigation_2026-04-22.md` (partially)

---

## 1. TL;DR

The 2026-04-22 handoff concluded "nothing was mis-routed, it's user-hub broadcast noise." That conclusion was correct **only for** the four 2026-04-22 20:27-ET trades we investigated that day, which genuinely fired on account 20224434 (EAI). It was **wrong as a blanket statement**.

Definitive broker `Trade/search` against BEAST's actual trading account (**13146982**, set via UI into `logs/settings.json`) reveals:

- **Account 13146982 has 26 broker orderIds that BEAST never placed** — including 12 MGC orders across 2026-04-22 that BEAST has no audit trail for (BEAST rarely trades MGC and has zero MGC rows in `trades.jsonl`).
- **These pre-existing / concurrent positions caused BEAST's safety-net flatten to fire immediately on 4 separate BEAST entries** (id=4, 5, 6, 8). Each was recorded by BEAST's outcome detection as `TARGET` + signal-target-price P&L, when the actual broker outcome was a flat-flatten within ~1–2 seconds of entry.
- **Net BEAST-contribution to 13146982 is ~+$12.65 lifetime**, not the +$381.98 its dashboard currently shows.

If the lockdown EAI pushed today does what's advertised, this should stop for future trades. But we need confirmation from your side that the orderIds listed in §4 below did come from EAI, and that the lockdown actually closes the routing path for all EAI setup types (not just the ones that were tested).

## 2. Account binding (re-confirmed, no ambiguity)

- BEAST trading account (UI-selected, persisted to `logs/settings.json`): **13146982**
- `.env` `PROJECTX_ACCOUNT_ID=20224434` is **login-only**, not trading. BEAST server never routes trades to 20224434 regardless of `.env` value.
- All 7 BEAST audit rows that carry `entryOrderId`s (id=2, 3, 4, 5, 6, 8, 9) resolve successfully on broker account 13146982 via `Trade/search`. So BEAST's end of the routing is correct and always has been.

## 3. BEAST audit log vs broker truth

Ran `scripts/reconcile_account_trades.js` — full broker history for account 13146982 from 2026-04-20 through 2026-04-23T21:27Z:

| id | date | BEAST says | Broker truth | Verdict |
|----|------|------------|--------------|---------|
| 1 | 04-20 | MANUAL −$30.48 | not in search window (manually reconciled earlier) | legacy |
| 2 | 04-21 | TARGET +$111.54 | +$113.54 net (TP1 @ 26858.25 + target @ 26846) | **✅ clean** |
| 3 | 04-21 | MANUAL −$89.70 | −$86.46 when unaudited manual-flatten (orderId 2859625690) is included | reconciles |
| 4 | 04-22 02:02Z | TARGET +$67.60 | **−$80.33** — entry + immediate flatten at ~entry price, no TP1/target fill | ❌ mislabeled |
| 5 | 04-22 06:02Z | TARGET +$71.60 | **−$3.33** — entry + immediate flatten, no TP1/target fill | ❌ mislabeled |
| 6 | 04-22 07:09Z | TARGET +$65.08 | **−$2.59** — entry + immediate flatten, no TP1/target fill | ❌ mislabeled |
| 7 | 04-22 10:36Z | MANUAL (no orderIds) | 401 at entry, never placed | fine |
| 8 | 04-23 01:21Z | TARGET +$73.82 | **−$11.22** — entry + immediate flatten, no TP1/target fill | ❌ mislabeled |
| 9 | 04-23 17:02Z | TARGET +$112.52 | +$113.52 net (TP1 @ 27011 + target @ 26993.5) | **✅ clean** |

Only id=2 and id=9 recorded correctly. id=9 is today's first trade *after* the API-key swap and *after* your lockdown took effect.

## 4. The 26 unaudited broker orderIds on 13146982 — is this yours?

These appeared on account 13146982 during windows that overlap with BEAST's own activity, but BEAST never placed them. Asking you to confirm whether any of these match EAI journal records (or other EAI order IDs) so we can attribute them conclusively.

### 4a. MGC activity — BEAST has zero MGC audit rows

| orderId | first fill (UTC) | size | sumPnl |
|---------|------------------|------|--------|
| 2860764322 | 2026-04-22T01:08:30Z | 1 | $0 |
| 2860764348 | 2026-04-22T01:31:41Z | 1 | −$127 |
| 2861713086 | 2026-04-22T07:11:30Z | 2 | $0 |
| 2861713097 | 2026-04-22T08:22:11Z | 1 | +$106 |
| 2862156752 | 2026-04-22T10:19:35Z | 1 | +$125 |
| 2862269581 | 2026-04-22T11:18:45Z | 1 | $0 |
| 2862269607 | 2026-04-22T11:18:45Z | 1 | −$1 |
| 2863263988 | 2026-04-22T13:38:33Z | 2 | $0 |
| 2863264120 | 2026-04-22T13:45:42Z | 1 | +$102 |
| 2863264359 | 2026-04-22T14:03:33Z | 1 | +$1 |
| 2864855395 | 2026-04-22T14:41:31Z | 2 | $0 |
| 2864855495 | 2026-04-22T14:43:40Z | 2 | −$124 |

Net across these 12: **~+$82 gross**. Pattern looks like paired entry-plus-exit sequences — characteristic of a bracketed execution engine.

### 4b. MNQ activity BEAST can't account for

| orderId | first fill (UTC) | size | sumPnl | near which BEAST trade? |
|---------|------------------|------|--------|-----------|
| 2859625690 | 2026-04-21T19:03:08Z | 2 | −$85 | manual flatten of id=3 (attributable to user) |
| 2860917068 | 2026-04-22T01:46:36Z | 2 | $0 | **pre-existed id=4** (16 min before BEAST's 02:02Z entry) |
| 2860968166 | 2026-04-22T02:02:03Z | 7 | −$7 | flatten of id=4, ~1.3s post-entry |
| 2861571410 | 2026-04-22T06:02:04Z | 9 | $0 | flatten of id=5, ~1.5s post-entry |
| 2861706958 | 2026-04-22T07:09:03Z | 7 | −$10.50 | flatten of id=6, ~1.4s post-entry |
| 2861923930 | 2026-04-22T08:37:29Z | 2 | $0 | (unrelated to BEAST) |
| 2861923951 | 2026-04-22T09:00:34Z | 2 | −$164 | (unrelated to BEAST) |
| 2868208492 | 2026-04-23T00:27:29Z | 2 | $0 | — |
| 2868208515 | 2026-04-23T00:28:57Z | 1 | +$41 | — |
| 2868208535 | 2026-04-23T00:38:39Z | 1 | +$41 | — |
| 2868473781 | 2026-04-23T01:21:03Z | 6 | −$9 | flatten of id=8, ~1.4s post-entry |

**Crucial suspicion:** orderId `2860917068` — an MNQ SELL 2 opened at 01:46 UTC on 2026-04-22, 16 minutes before BEAST's id=4 entry — is what caused id=4 to malfunction. When BEAST fired BUY 9 entry, broker had an existing SHORT 2 on the contract. The BUY 9 closed that SHORT 2 (carrying the −$77 P&L visible on the 2-contract portion of the split entry fill) and opened LONG 7 — a 2-contract size mismatch vs BEAST's internal state of LONG 9. BEAST's safety-net detected the mismatch and immediately flattened the LONG 7 at market. Same causal mechanism for id=5, id=6, and id=8.

These orderIds lie roughly between the 20224434-account orderIds you placed on 2026-04-23 at 00:27Z (verified in the 2026-04-22 handoff). If the orderId allocator is account-scoped on ProjectX, that correlates with EAI placing on different accounts; if it's login-scoped or global, these may show up in your `eai_signals.jsonl` or `edgeable_*_last.json` with matching timestamps.

## 5. Downstream impact on BEAST

1. `logs/trades.jsonl` carries fabricated TARGET outcomes on id=4, 5, 6, 8. Lifetime P&L on the dashboard is overstated by ~$277.50.
2. The "Phase 2 closed" conclusion documented in `memory/project_test_status.md` was drawn against mislabeled data. The orphan-SL fix is genuinely in place (id=3's real outcome), but the subsequent three "clean TARGETs" on 04-22 were never clean.
3. Today's Phase-5 validation trade id=8 (the 21:21-ET 6ct) was also a cross-route race casualty despite the fresh API-key isolation — because at the moment id=8 fired, there was still an unaudited SHORT sitting on 13146982 from prior routing (orderId `2868473781` = the flatten, which implies a pre-existing opposite position shown by the broker's entry-fill split).
4. Today's id=9 (17:02Z) is the only clean BEAST trade on 13146982 since id=2 from 04-21.

## 6. Action items

### EAI side — needed to close attribution
- [ ] Cross-check the 12 MGC orderIds in §4a against EAI journals / signal logs. Were these EAI-placed on 13146982 before the lockdown? If so, under which setup types?
- [ ] Cross-check the 2 "unrelated to BEAST" MNQ orderIds (2861923930 / 2861923951) — same question.
- [ ] Specifically confirm orderId `2860917068` (MNQ SELL 2 @ 01:46Z on 04-22) is yours. This is the order that pre-positioned 13146982 and caused the id=4 mislabel cascade.
- [ ] Confirm the lockdown scope: does it prevent **every** EAI setup type from ever routing to 13146982, or only the setup types that were tested? Specifically, what happens if a GC/MGC signal fires while the lockdown is in effect?

### BEAST side — queued pending your confirmation
- [ ] Fix outcome-detection mislabeling when safety-net flatten fires (record as `FLATTEN` or `STOPPED` with broker-truth exit, not `TARGET` with signal-target price).
- [ ] Add a pre-flight broker position check: if `/Position/searchOpen` returns a non-zero position on the signal's contract before BEAST fires entry, reject the signal with `disposition: "rejected_prior_position"` rather than racing the safety-net.
- [ ] Backfill `trades.jsonl` for id=4/5/6/8 with broker-truth values and rebuild in-memory state at next restart.
- [ ] Update `memory/project_test_status.md` — Phase 2 was only validated against id=2 and id=3; id=4/5/6 cannot stand as clean confirmations.

### John — recommended
- [ ] Hold Phase-5 validation gate open. Don't count id=8/id=9 toward closure until items 1–3 on BEAST side are done and item 1 on EAI side clears the pre-existing-position channel.

## 7. Protocol update (for future triage)

New rule of thumb:

> "No BEAST activity near a burst" is insufficient evidence of no-cross-route. **A broker position already open on BEAST's target contract at the moment BEAST fires** is equally damaging — it doesn't show up in BEAST's signals log or trades log, but it poisons the next BEAST entry's size reconciliation and triggers the safety-net flatten. Add a pre-flight `/Position/searchOpen` check before every BEAST entry as a blocker for this class.

## 8. Appendix — data sources

- BEAST reconciliation script: `scripts/reconcile_account_trades.js` (new, read-only, can be re-run anytime)
- BEAST audit log: `logs/trades.jsonl`
- Broker endpoint used: POST `/Trade/search` with `{ accountId: 13146982, startTimestamp, endTimestamp }`
- Prior handoff: `Project_Attachments/EAI_Crossroute_Investigation_2026-04-22.md`
