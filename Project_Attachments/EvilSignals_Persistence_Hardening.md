# EvilSignals-Executor — Persistence Hardening Plan

**Audience:** the agent maintaining `C:\Users\Trader\Documents\Trading\EvilSignals-Executor`
**Author:** Beast Mode Signals Executor agent, 2026-04-18
**Status:** advisory — John authorizes the work; scope and sequencing are up to the EvilSignals agent

---

## Why this document exists

While porting the EvilSignals persistence pattern over to the Beast Mode executor, three durability weaknesses in the current EvilSignals implementation were identified. They are not blocking bugs — the system has been running in production — but each one represents a latent data-loss or state-corruption risk. This document spells out the problems, the fixes, and the order in which they should be tackled.

File and line references point to EvilSignals-Executor `main` as of 2026-04-18.

Out of scope for this doc: edgeable, IBOB, iceberg, rithmic, zones, and the `logs/archive/` folder — unchanged.

---

## Weakness 1 — No atomic writes

### Problem

Every hot-path persisted file is written with a direct `fs.writeFileSync(file, data)` call. If the Node process is killed (Ctrl-C, OS reboot, hard crash, OOM) during that call, the target file is left truncated or partially written. On next boot, `JSON.parse` throws and the state is silently lost (the catch blocks in the load functions swallow the error and fall back to default state).

Affected call sites:

| File | Line | What it writes |
|---|---|---|
| `src/risk.js` | 87 | `logs/daily-pnl.json` — every P&L mutation, bias flip, circuit breaker event |
| `src/executor.js` | 282 | `logs/active-trades.json` — every open-trade state change |
| `src/journal.js` | 46 | `logs/journal-YYYY-MM-DD.json` — every journal update |
| `src/orders.js` | 56 | `logs/.token.json` — token refresh (lower stakes; re-auth recovers) |

Risk: a crash during a Friday-afternoon losing streak could silently reset `consecutiveLosses` and `dailyPnl` to zero on reboot, disabling the circuit breaker and allowing further losses on Monday.

### Fix

Introduce an `atomicWrite(file, data)` helper and use it at every full-rewrite site:

```js
function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}
```

`rename` is atomic on POSIX and on Windows (same volume). A crash between `writeFileSync` and `renameSync` leaves the old file intact and a stray `.tmp` file — safe to reboot from.

**Where to put it:** either a new `src/fsutil.js` exporting `atomicWrite`, or an inline copy in `risk.js`, `executor.js`, and `journal.js`. Beast Mode took the inline approach because only one call site uses it per module.

**Beast Mode reference:** `Beast_Mode_Signals_Executor/src/risk.js` `savePnlState()`.

### Priority: HIGHEST. Low risk, high immediate value. Do this first.

---

## Weakness 2 — No schema version on persisted records

### Problem

None of the persisted files carry a schema-version field. When the shape of a record changes in code (new field added, field semantics shifted, a value gets re-denominated from points to dollars), older files on disk silently rehydrate with missing or obsolete fields. There is no way at load time to say "this file was written by an older code version, apply migration X."

Affected files:

- `logs/daily-pnl.json` — top-level object, no version field
- `logs/active-trades.json` — dict of `contractId → state`, no version on envelope or entries
- `logs/journal-YYYY-MM-DD.json` — array of trade records, no version on any entry

This is not hurting anything today because the code and the on-disk files evolve together and the trader runs a single version. It will hurt the first time you want to change the shape of a persisted record and keep history readable — that moment becomes a migration archaeology dig.

### Fix

Stamp every persisted record (or file envelope) with `_v: <integer>` starting at `1`. No migration logic required yet — just the version stamp. When migrations become necessary, the load functions branch on `entry._v`:

```js
if (!entry._v || entry._v === 1) {
    // current shape
} else if (entry._v === 2) {
    // future shape
} else {
    console.warn(`[load] unknown schema version ${entry._v}, skipping`);
    return;
}
```

Touchpoints:

- `src/risk.js:59-68` — add `_v: 1` to the object literal inside `savePnlState()`. `restorePnlState()` at line 74 can ignore the field for now; read it when the first migration is introduced.
- `src/executor.js:281-283` — wrap the cache object, e.g. `{ _v: 1, trades: {...} }`, and update `loadCache()` to read `parsed.trades` instead of the raw object. Adds one indirection but gains version discipline.
- `src/journal.js:43-48` — add `_v: 1` to each array entry at write time. `loadDay()` can filter out or warn on unknown versions.

**Beast Mode reference:** `Beast_Mode_Signals_Executor/src/db.js` uses `SCHEMA_VERSION = 1` and stamps every `insert`/`update` line. `src/risk.js` stamps `_v: 1` in the daily-pnl envelope.

### Priority: MEDIUM. Trivial to add, zero runtime cost, pays off the first time you evolve a schema.

---

## Weakness 3 — `active-trades.json` and `journal-YYYY-MM-DD.json` duplicate the trade record

### Problem

A single trade lives in two files during its lifetime:

- `logs/active-trades.json` holds it keyed by `contractId` while open
- `logs/journal-YYYY-MM-DD.json` holds the same trade in that day's array

On close, `active-trades.json` deletes the entry and `journal` finalizes it. Observations from the EvilSignals-Executor code:

- Every state-change site has to decide which file to update. Some sites update both (e.g. `executor.js:1774-1781` where `saveCache()` and `journal.setActualEntry()` run back-to-back — a successful first write + crashed second write leaves the two files disagreeing).
- No single source of truth. If they disagree, which one wins on boot?
- Answering "give me the full event history for trade N" requires reading both files and correlating by timestamps.
- The "active" vs "archive" split is a storage concern leaking into the write path.

### Fix

Consolidate into one append-only JSONL log keyed by trade id:

```
logs/trades.jsonl
{"_op":"insert","_v":1,"id":1,"timestamp":"2026-04-18T14:22:03Z","status":"OPEN",...}
{"_op":"update","_v":1,"id":1,"actualEntryPrice":21487.25}
{"_op":"update","_v":1,"id":1,"status":"TP1","pnlDollars":125.00,"exitTime":"..."}
```

### On boot

Stream the file. For each line: `_op:"insert"` → push onto the in-memory trade array. `_op:"update"` → find by id and `Object.assign` the fields. Track `nextId` as `max(id) + 1`.

### At runtime

- "Active trades" is `trades.filter(t => t.status === 'OPEN')`
- "Today's journal" is `trades.filter(t => tradingDay(t.timestamp) === today)`
- "All history" is just `trades`

### Benefits

- One write per state change, always an append — atomic at the line level on every modern filesystem. Crash mid-write at worst leaves a trailing partial line the parser skips.
- Single source of truth. No reconciliation logic.
- Easy to grep: `grep '"id":42' trades.jsonl` gives the full event history.
- The trading-day boundary becomes a read-time concern, not a file-split concern.

### Migration path (suggested sequencing)

1. Add `trades.jsonl` writes alongside existing `active-trades.json` and `journal-*.json` writes for one release. Dual-write, single-read-preferred (from legacy) while you verify the new log reconstructs state correctly.
2. Write a one-time backfill script that replays existing `journal-*.json` files into `trades.jsonl` (needed so historical P&L stays visible in the dashboard).
3. After one clean trading-day rollover where `trades.jsonl` reconstructs identically to the legacy files, switch reads to `trades.jsonl` only.
4. Stop writing the legacy files. Move the old files to `logs/archive/` (that folder exists and is where retired data belongs per John's convention).

### Audit first

Before doing any of this, grep the codebase (and any dashboards, analytics scripts, or one-off tools John runs) for direct reads of `active-trades.json` or the dated journal files. Those consumers need to migrate to `trades.jsonl` or to a read-shim that simulates the old files. Known reads:

- `src/executor.js` — `loadCache()` reads `active-trades.json`
- `src/journal.js` — `loadDay()` reads dated journals, called by dashboard stats queries (search for callers)
- `public/index.html` (if the dashboard reads journals via a REST endpoint, not directly)

### Priority: LOWEST. Biggest scope, biggest cleanup, biggest audit. Defer until weaknesses 1 and 2 are stable and you have a quiet trading period to land it.

---

## Appendix — what Beast Mode did

As of 2026-04-18, the Beast Mode executor's persistence layer looks like this:

| File | Purpose | Write pattern |
|---|---|---|
| `logs/trades.jsonl` | Single append-only trade log (no active/journal split) | `fs.appendFileSync` per event |
| `logs/daily-pnl.json` | Daily risk state — P&L, streak, bias, toggle | Atomic tmp + rename per mutation |
| `logs/signals.jsonl` | Audit log of every webhook signal + disposition | `fs.appendFileSync` per signal |

All records carry `_v: 1`. Relevant modules: `src/db.js`, `src/risk.js`, `src/webhook.js`. The Beast Mode executor has a simpler surface (one strategy, one webhook, fewer trade types) so the single-file trade log is a cleaner fit than in EvilSignals. The pattern is still worth adopting in EvilSignals for the durability benefits, just with a staged migration.

---

## Questions this doc does not answer

- **Rotation policy for `trades.jsonl` once it grows large.** Beast Mode defers this until file size matters. EvilSignals may want monthly rotation given higher signal volume. Rotate by moving `trades.jsonl` to `logs/archive/trades-YYYY-MM.jsonl` at trading-day rollover when month changes.
- **SQLite option.** Considered and rejected for Beast Mode (native dep, trader install friction, low volume). Re-evaluate for EvilSignals if trade volume or query complexity justifies it.
- **Backup / off-machine durability.** Neither Beast Mode nor EvilSignals currently replicates state anywhere. Out of scope for this doc.
