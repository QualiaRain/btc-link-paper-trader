# Evaluation contract: does the trend rule call direction better than chance on unseen data?

> **Status: PROPOSED, not frozen, not run.** Authorization level: agent proposal (Claude Code, 2026-10-14) written
> from J's stated objective ("improve seven-minute BTC forecast accuracy, measured on held-out data against a frozen
> same-price baseline") and the repo's own rule "decide how a strategy will be judged before looking at the data".
> It becomes **FROZEN** only when J says so and the freeze block at the end is filled in. Until then nothing below
> is a claim, and no held-out window may be fetched.

## Why this exists

`docs/HOW_THIS_WAS_BUILT.md` records that the only data looked at so far is one 30-hour sample, that tuning on it
would overfit, and that a meaningful test "has not been frozen or run". This file is that test, written down before
any held-out data is retrieved, so the result cannot be shaped by having seen it. It is the external resistance the
project's claims are judged against; the report card in the app is the instrument, not the verdict.

## Hypothesis under test

**H1.** The default trend rule calls the direction of the BTC-USD midpoint seven minutes ahead better than chance on
Coinbase Exchange minute data it has never been run on. **H1-LINK** is the same for LINK-USD, reported separately.

The null is a coin flip: a rule with no skill is right on 50% of decided forecasts.

## Fixed rule and settings

Exactly the app's documented defaults. The pinned object below is what gets hashed at freeze; it is the `config`
of a `paper-trail-settings-v2` export **without** `durationMs` (the app overwrites that with the scored range
length) plus the replay half-spread. Each window's own `start`/`end` come from the picker (next section); they are
the only per-run fields, so a per-window settings export will differ from this object only in `durationMs`,
`replay.start` and `replay.end`.

```json
{"config":{"initialCash":1000,"horizonMs":420000,"model":"trend","lookbackIntervals":7,"bufferBps":10,
 "allocationFraction":0.5,"stopLossBps":0,"maxDrawdownBps":0,"dailyLossBps":0,"cashYieldBps":0,
 "feeBps":2,"slippageBps":2,"maxQuoteAgeMs":60000,"maxOutcomeLatenessMs":30000,"mode":"replay"},
 "replay":{"source":"range","halfSpreadBps":3}}
```

The same-price rule (`"model":"same-price"`) with otherwise identical settings is the baseline run on each window.
No setting other than the per-window boundaries may change after the freeze. A different setting is a different
contract.

## Data and window selection

- Source: Coinbase Exchange public completed one-minute candles, fetched through the app's own date-range replay
  (`replay.js` / `backend/paper_trail/candles.py`), which records per-asset expected, observed and missing minute
  counts and a SHA-256 receipt per response. Those receipts are part of the result.
- Windows: **three** windows of **28 whole UTC days** each, chosen by `scripts/pick-holdout-windows.mjs` from the
  eligible range **2025-10-01 to 2026-10-01** (exclusive end), excluding the bundled sample's days
  (`2026-10-10/2026-10-12`, already outside the range) and any window listed under "Excluded as already seen" below.
- Seed: a value that does not exist at freeze time, so no one can choose it to pick favourable windows: **the
  BTC-USD one-minute close for the UTC minute `2026-11-01T00:00`**, exactly the string the app's candle fetch
  returns for it (for example `"68123.45"`), and nothing else. Record the fetch receipt for that candle next to the
  seed. The freeze commit is deliberately **not** part of the seed: a commit hash is the freezer's to choose and
  could be ground until the picker lands on favourable windows.
- **Timing rule.** The freeze commit must be pushed to `main` before the seed minute passes. A freeze recorded after
  `2026-11-01T00:00Z` is void, because by then every candidate window could have been scored offline. If this
  contract is not frozen in time, or a run is declared INVALID, the successor contract must name a seed minute later
  than its own freeze, and that freeze must again be pushed before the minute passes.
- The picker's `end` is exclusive (00:00 of the day after the window). The app's date-range replay is inclusive
  and requires the exact start and end minute candles for both assets, so each window is run as
  `start` = the picker's `start` and `end` = the picker's `lastMinute` (23:59 of the window's last day).
- **Replacement rule.** A window is replaced if its fetch reports more than **10% missing shared minutes** for
  either asset, or if the fetch is refused because an exact boundary candle is missing for either asset. The
  replacement is the window that appears in the picker's output with `--count` raised by one and is absent from the
  original output (the output is sorted by date, so "next" means this, not the next line). Each replacement is
  recorded with the reason. Boundaries are never adjusted by hand.

Example of the invocation (the real seed is not known yet):

```sh
node scripts/pick-holdout-windows.mjs --seed "<close>" --from 2025-10-01 --to 2026-10-01 --days 28 --count 3
```

### Excluded as already seen

- The bundled sample (`data/sample.json`, 2026-10-10 10:26 to 2026-10-11 16:25 UTC) and its two calendar days.
- The three 31-day runs used to time forecast settling in PR 7 were not recorded by date. If J or an agent recalls
  their boundaries before the freeze, add them here; otherwise they stay unexcluded and this is noted as a known
  contamination risk (the seed makes a deliberate overlap impossible, not an accidental one).

## Primary measure and pass criterion

For each asset, pool `directionHits` and `directionMisses` across the three windows (flat forecasts and expired
forecasts are excluded, exactly as `report-card.js` does) and apply the exact two-sided sign test from
`report-card.js` (`signTestPValue`).

**Drift control.** The same-price baseline forecasts no change, which the engine counts as flat, so it contributes
nothing to hits and misses. A trend follower can beat a coin flip with no skill if a window simply drifts one way.
Therefore, from the same decided forecasts, compute the hit rate of the two constant rules "always up" and
"always down" (the fraction of decided outcomes that moved up, and down). The rule's hit rate must exceed the
better of the two.

- **H1 is supported** only if pooled BTC `p < 0.025`, hits exceed misses, **and** the rule's pooled hit rate exceeds
  the better constant rule's hit rate on the same forecasts.
- **H1 is contradicted** if pooled BTC `p < 0.025` and misses exceed hits.
- A result with `p < 0.025` and hits over misses that fails the drift control is reported as **drift, not skill**.
- Otherwise the result is **no clear skill**, and the detectable-edge half-width (`detectableEdgePts(n)`) is
  reported so the reader knows how small an edge the test could have seen.
- The same three outcomes are reported for LINK. Each asset is judged on its own; one asset's pass is not evidence
  for the other.

Three windows of 28 days at the default horizon are expected to yield several thousand decided forecasts per asset,
enough to detect an edge of roughly one to two percentage points. If a window yields fewer than 30 decided forecasts
for an asset it is still pooled, and the shortfall is reported.

## Secondary measures (descriptive, not pass/fail)

Reported per window and pooled, for the trend run, the same-price run and the buy-and-hold comparison:

- final account value and return, maximum drawdown, number of fills, fees and slippage paid;
- mean absolute error against the same-price forecast (`mae` vs `samePriceMae`);
- the cost hurdle: median absolute seven-minute log move versus the modeled round-trip cost (about 14 bps at the
  default costs). This is what decides whether direction skill could ever be worth trading, and it is reported
  even if H1 passes.

## What a pass would and would not establish

A pass establishes only that, on three pre-chosen windows, the rule's direction calls were unlikely under a coin
flip. It does not establish a trading edge, profitability after costs, executable fills, or anything about other
horizons, assets, venues or periods. A fail or "no clear skill" is reported with the same prominence as a pass, in
`docs/HOW_THIS_WAS_BUILT.md` under "What the results say", with its evidence grade.

## Procedure at run time

1. Confirm the freeze block below is complete and the commit it names is checked out.
2. Fetch the seed candle, record its receipt, run the picker, commit the chosen windows **before** fetching them.
3. Fetch each window with the app (browser or local API). Save every run record; commit the exported records or
   their SHA-256 hashes and the fetch receipts.
4. Compute the pooled counts from the saved records with a script committed in the same PR, and have a reviewer
   agent that did not write that script recompute them from the same records.
5. Report the result with the coverage facts: windows, missing minutes, expired forecasts, receipts, commit.

## Stop conditions and amendments

- Any deviation from this document after the freeze invalidates the run; the deviation and its reason are recorded
  and the run is reported as **INVALID**, not quietly repeated.
- A change to this document after the freeze is a new contract with a new freeze block and a seed minute later than
  that freeze; the old one stays in the file with its outcome (run, invalid, or superseded).
- No settings exploration on held-out windows. If a different rule is worth testing, write a new contract first and
  draw new windows.

## Freeze block (empty until J rules)

```
Frozen by:            J, on <date>, in <PR or message reference>
Freeze commit:        <full hash>, pushed to main at <UTC time>, before the seed minute
Pinned settings hash: <sha256 of the pinned JSON object above, as committed>
Seed candle minute:   2026-11-01T00:00 UTC  (fetched on <date>, receipt sha256 <...>)
Seed string:          <close>
Chosen windows:       <committed JSON from the picker, including lastMinute>
Excluded as seen:     <final list>
```
