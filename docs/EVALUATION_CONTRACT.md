# Evaluation contract: does the trend rule call direction better than chance on unseen data?

> **Status: PROPOSED, not frozen, not run.** Authorization level: agent proposal (Claude Code, 2026-10-14) written
> from J's stated objective ("improve seven-minute BTC forecast accuracy, measured on held-out data against a frozen
> same-price baseline") and the repo's own rule "decide how a strategy will be judged before looking at the data".
> It becomes **FROZEN** only with J's explicit authorization and a complete **Stage A pre-seed freeze record**
> published on `main` before the cutoff below. Stage B records observations later; it cannot complete or repair
> Stage A retroactively. Until Stage A is valid, no held-out window may be fetched. Freezing is not a result.

## Why this exists

`docs/HOW_THIS_WAS_BUILT.md` reports results from one 30-hour sample, warns that tuning on it
would overfit, and says a meaningful test "has not been frozen or run". This file is that test, written down before
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

The pinned settings hash is SHA-256 over the UTF-8 bytes inside the JSON fence above: from the first `{` through
the LF immediately after the final `}`, excluding the fence lines, with LF line endings and no reserialization.
This defines the hashed bytes before the seed is known; it does not include later window boundaries or evidence.

The same-price rule (`"model":"same-price"`) with otherwise identical settings is the baseline run on each window.
Only the prescribed baseline model substitution and per-window `durationMs`, `replay.start` and `replay.end` may
differ from the pinned object. No other setting may change after the freeze. A different setting is a different
contract.

## Data and window selection

- Source: Coinbase Exchange public completed one-minute candles, fetched through the app's own date-range replay
  (`replay.js` / `backend/paper_trail/candles.py`), which records per-asset expected, observed and missing minute
  counts and a SHA-256 receipt per response. Those receipts are part of the result.
- Windows: **three** windows of **28 whole UTC days** each, chosen by `scripts/pick-holdout-windows.mjs` from the
  eligible range **2025-10-01 to 2026-10-01** (exclusive end), excluding the bundled sample's days
  (`2026-10-10/2026-10-12`, already outside the range) and any window listed under "Excluded as already seen" below.
- Seed: a value that does not exist at freeze time, so no one can choose it to pick favourable windows: **the
  BTC-USD one-minute close for the UTC minute `2026-11-01T00:00`**, and nothing else. This is the candle whose
  **bucket starts at `2026-11-01T00:00:00Z`**, available only after it closes at `00:01:00Z`. The replay code labels
  candles by bucket start + 60 seconds; do not accidentally use the preceding bucket. The fetcher parses a numeric
  close, so the seed is JavaScript `String(close)` for that row's close field (`row[4]`), with no rounding, padding,
  whitespace or added input (for example `"68123.45"`). Preserve the raw response, row and receipt in Stage B.
  The freeze commit is deliberately **not** part of the seed: a commit hash is the freezer's to choose and
  could be ground until the picker lands on favourable windows.
- **Timing rule.** The approved specification and complete Stage A record must be committed and pushed to `main`
  **strictly before `2026-11-01T00:00:00Z` (2026-10-31 at 8:00 p.m. Eastern)**, before the seed bucket begins.
  Publication at or after the cutoff is void. A draft PR, local commit or backdated Git timestamp is insufficient;
  retain GitHub publication evidence identifying the commits, `main` and the pre-cutoff time. If timely publication
  cannot be verified, do not run. If this contract is not frozen in time, or a run is declared INVALID, the successor
  contract must name a seed minute later than its own freeze and again publish its complete Stage A before it.
- The picker's `end` is exclusive (00:00 of the day after the window). The app's date-range replay is inclusive
  and requires the exact start and end minute candles for both assets, so each window is run as
  `start` = the picker's `start` and `end` = the picker's `lastMinute` (23:59 of the window's last day).
- **Replacement rule.** A window is replaced if its fetch reports more than **10% missing shared minutes** for
  either asset, or if the fetch is refused because an exact boundary candle is missing for either asset. The
  replacement is the window that appears in the picker's output with `--count` raised by one and is absent from the
  immediately preceding count's full output (the output is sorted by date, so "next" means this, not the next line).
  Keep the seed and all other picker inputs fixed, increment the count cumulatively, and retain rejected draws so
  they cannot re-enter.
  Each replacement and its coverage-based reason is committed in Stage B before fetching that replacement.
  Boundaries are never adjusted by hand, and performance is never a replacement reason.

**Unresolved before freeze:** the existing phrase "missing shared minutes for either asset" is ambiguous. The
code records per-asset `coverage[asset].missingFraction` and separately `evidence.sharedCount`; these are not the
same measure. Before S is approved, specify whether the unchanged **more than 10%** threshold applies to
`1 - sharedCount / expectedCount` (missing shared scored minutes) or to either asset's `missingFraction` (missing
per-asset scored minutes). Disjoint gaps can leave each asset 6% missing but the shared series 12% missing.
This correction does not choose between those rules. Resolve the numerator/denominator in S with J's approval;
an unresolved replacement rule prevents Stage A completion, and the evaluator cannot choose after the seed.

Example of the invocation (the real seed is not known yet):

```sh
node scripts/pick-holdout-windows.mjs --seed "<close>" --from 2025-10-01 --to 2026-10-01 --days 28 --count 3 \
  --exclude "<complete Stage A comma-separated exclusion intervals>"
```

The picker does not load this document or enforce authorization or timing. Supply the frozen exclusions explicitly
as UTC `[start, end)` day intervals; the bundled sample contributes `2026-10-10/2026-10-12`. Do not run this example
with a guessed seed to select evaluation windows. Existing tests use synthetic seeds only, not evaluation draws.

### Excluded as already seen

- The bundled sample (`data/sample.json`, 2026-10-10 10:26 to 2026-10-11 16:25 UTC) and its two calendar days.
- The [PR 7 description](https://github.com/QualiaRain/btc-link-paper-trader/pull/7) labels its three 31-day
  performance runs **synthetic** (author-reported); it supplies no historical-market boundaries. Do not invent dates
  or treat that description as proof of all prior data access. If J or an agent identifies any already-seen
  historical windows before the freeze, add their enclosing UTC day intervals here and to Stage A. Otherwise retain
  the unresolved prior-exposure risk explicitly in Stage A for J's acceptance; those unknown windows stay unexcluded.
  The fixed future seed prevents deliberate draw selection, not accidental overlap with previously seen data.

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

## Procedure: two independently verifiable stages

### Stage A — before the seed: approve and publish the freeze

1. Finalize the rules, pinned settings, exclusions (including any accepted prior-exposure uncertainty), seed source
   and minute, picker inputs, replacement rule (including the missing-minute denominator) and statistical criteria.
   Commit this specification and its code as **S**. Obtain J's explicit approval of that exact specification and
   permission to publish the freeze to `main`.
   Approval of this sequencing correction alone is not approval to freeze, merge or execute the evaluation.
2. In a subsequent commit **F**, fill only the Stage A block below, naming S's full hash, the pinned settings hash,
   final exclusions, J's authorization reference and actual UTC recording time. Set the status to FROZEN only as
   part of that authorized operation. F changes the freeze record/status, not S's rules, settings, exclusions or code.
   Publish S and F on `main` before the strict cutoff and retain independently timestamped GitHub publication evidence.
3. A reviewer verifies S and F are reachable from `main`, the published F contains a complete Stage A, the hash
   recomputes from S, the approved exclusions match, and authorization and publication precede the cutoff. F's own
   hash is obtained from Git after committing and linked by the publication evidence; **F never contains its own
   hash**. No seed value, candle receipt, chosen window or result is required or permitted in Stage A.

### Stage B — after the seed candle closes: record the draw, then evaluate

1. Verify Stage A, its publication evidence and J's explicit authorization to execute Stage B first. A freeze-only
   approval does not authorize execution. Check out S's evaluation code; do not silently use a later
   branch tip or rebuilt defaults. Start a separate append-only evidence record (for example
   `docs/evaluations/2026-11-01/RECORD.md`) using the Stage B template below, referencing both S and F.
2. After `2026-11-01T00:01:00Z`, retrieve only the specified seed-candle evidence, record the observed seed and its
   receipt, and run S's picker with the exact Stage A inputs. Commit the full picker JSON, command, seed evidence
   and receipt **before fetching any selected window**. Retain that selection commit and its publication timestamp.
   If the seed is unavailable, wait for that same completed candle; do not substitute a seed, minute or venue.
3. Fetch each selected window with S's app (browser or local API), using `start` and inclusive `lastMinute`. Run
   the pinned trend and prescribed same-price baseline. Apply only the frozen replacement rule and commit each
   replacement selection before its retrieval. Retain failed/rejected fetch evidence and the original draw.
4. Save every run record; commit the exported records or their SHA-256 hashes and fetch receipts. Record artifact
   locations, retrieval times, missing-minute coverage, expired forecasts and the specification/settings identity.
5. Compute pooled counts from the saved records with a script committed in the evaluation PR and record that
   script's commit separately from S. It may implement the frozen criteria, never change them after seeing data.
   Have a reviewer agent that did not write the script independently recompute the counts from those same records.
6. Append the result, secondary measures, coverage, reviewer evidence and outcome (including INVALID) to Stage B;
   report it in `docs/HOW_THIS_WAS_BUILT.md` with its evidence grade. Evidence fields start pending and are filled
   as events occur. They are not prerequisites for the earlier freeze or for steps that produce that evidence.

These are procedural gates: neither the picker nor the replay UI/API enforces preregistration. The reviewer must
check the two records and their commit/publication history; passing repository tests alone does not validate a freeze.

## Stop conditions and amendments

- Any deviation from this document after the freeze invalidates the run; the deviation and its reason are recorded
  and the run is reported as **INVALID**, not quietly repeated.
- After publication, Stage A and the specification are immutable. Appending the prescribed Stage B observations,
  receipts, deterministic replacements and results in a separate record is evidence collection, not an amendment.
  It cannot alter, backfill or repair Stage A. Preserve prior evidence entries; corrections append the reason and
  superseding evidence rather than erase history. A correction cannot make a deviating run valid retroactively.
- Any change to the frozen specification, settings, exclusions, seed method, picker or criteria is a new contract
  with a new Stage A and a seed minute later than that freeze. Preserve the old contract and record its outcome
  (run, invalid, or superseded) alongside it; do not overwrite the old freeze or reuse a revealed seed.
- No settings exploration on held-out windows. If a different rule is worth testing, write a new contract first and
  draw new windows.

## Stage A pre-seed freeze record (empty until J authorizes freezing)

```text
Approved by:          J, at <UTC time>, in <public authorization reference>
Authorization scope:  <approve specification S and publish its freeze to main; execution scope if granted>
Specification S:      <full existing commit hash: approved rules, settings, picker and evaluation code>
Freeze recorded at:   <actual UTC time; this block is committed later as F>
Pinned settings hash: <sha256 of S's JSON-fence content using the byte rule above>
Excluded as seen:     <final explicit UTC day intervals, identical to S>
Exposure uncertainty: <remaining uncertainty and J's explicit acceptance, or evidence resolving it>
Picker inputs:        --from 2025-10-01 --to 2026-10-01 --days 28 --count 3 --exclude <same intervals>
Replacement metric:   <approved missing-minute numerator/denominator from S; strict >10% threshold>
Seed definition:      Coinbase BTC-USD bucket start 2026-11-01T00:00:00Z; String(row[4]) after close
Publication cutoff:   strictly before 2026-11-01T00:00:00Z on main
Publication evidence: <preselected PR/event location for GitHub's timestamped main publication of S and F>
```

The publication event identifies F after it exists, without a self-referential hash or a post-seed edit to this
block. The actual event must prove timely publication; a planned location or self-written timestamp is not proof.

## Stage B post-seed evidence record (template only; store separately from this contract)

```text
Specification S / freeze record F: <full hashes and pre-cutoff main publication evidence>
Stage A verification: <reviewer, UTC time, authorization/hash/exclusion/publication checks>
Seed candle:          <bucket start, close time, original row, observed numeric close, exact seed string>
Candle receipt:       <URL, fetched-at UTC, HTTP date, response SHA-256, raw-response artifact location>
Picker invocation:    <exact command using S and Stage A inputs>
Chosen windows:       <full committed picker JSON, including exclusive end and inclusive lastMinute>
Selection publication: <selection commit and publication timestamp before the first selected-window fetch>
Replacements:         <append each reason, coverage receipt, raised count, added window and pre-fetch commit>
Evaluation evidence:  <run artifacts or hashes + locations, fetch receipts/times, coverage, expired forecasts>
Analysis / review:    <analysis script commit, pooled counts, drift controls, independent recomputation>
Outcome:              <pending, reported result or INVALID; secondary measures and reporting reference>
```
