# Exploration protocol: can any setting of this rule make money after costs?

> **Status: FIXED at the commit that adds this file, before any exploration data was retrieved.** The only market
> data in the working tree at that commit is the bundled 30-hour sample. Authorization level: agent proposal
> (Claude Code, 2026-11-18), written in answer to J's request "make me money". This is **exploration, not
> evidence**. It can nominate a candidate for a pre-registered held-out test; it cannot establish that any rule
> makes money, and nothing here is frozen as an evaluation contract.

## Why this exists

`docs/HOW_THIS_WAS_BUILT.md` records that on the bundled sample the default seven-minute rule lost money and that
a typical seven-minute move was far smaller than one round trip of costs. The open draft evaluation contract
([PR 9](https://github.com/QualiaRain/btc-link-paper-trader/pull/9)) asks a different question: whether the default
rule calls *direction* better than chance on held-out windows. Neither answers the money question: **is there any
setting of the app's rule, or any small change to the rule, whose return after modeled costs is positive on data
it was not chosen on?**

Answering that needs a search over settings, and a search needs data that a held-out test will never draw from.
This protocol fixes the data, the settings searched, the selection rule and the confirmation rule before the data
exists in this environment, so the result cannot be shaped by having seen it.

## Data boundary (the held-out range is not touched)

- Source: Coinbase Exchange public completed one-minute candles for BTC-USD and LINK-USD, the app's own source.
- **Exploration range: candle buckets starting from `2020-01-01T00:00:00Z` up to, but not including,
  `2025-09-30T00:00:00Z`.** `research/fetch-candles.mjs` refuses any request reaching `2025-09-30T00:00:00Z` or
  later, with no override flag.
- The draft contract's eligible range is `2025-10-01` to `2026-10-01`. Nothing in that range, and nothing after it,
  is fetched, read or simulated by this exploration. The one-day gap before it is deliberate.
- **Consequence for any future contract:** every UTC day from `2020-01-01` to `2025-09-29` has now been used to
  choose settings and must be listed under "Excluded as already seen" if a contract's eligible range ever reaches
  back that far.
- Each response keeps a receipt (URL, receive time, HTTP date, SHA-256 of the raw body, row count). Missing minutes
  are never filled. Raw data stays out of the repository (`.research-data/`, ignored); `research/results/` records
  per-month row counts, coverage and a SHA-256 of each month's normalized series so a re-fetch can be compared.

## Windows

- 74 consecutive windows of 28 whole UTC days, window `k` covering minute closes from
  `2020-01-01T00:00Z + 28k days` through 23:59 of its last day (the same shape the draft contract's picker emits).
- **Design set: windows 0 to 49** (`2020-01-01` to `2023-11-01`). All searching and selection happens here.
- **Confirmation set: windows 50 to 73** (`2023-11-01` to `2025-09-03`). Looked at once, with the nominees fixed.
- Each window is one independent run from $1,000, exactly as the app's date-range replay would run it: warmup before
  the scored start, the comparison account bought at the first scored minute, positions closed on the last.
- The app refuses a range whose exact boundary minute is missing for either asset. Exploration instead scores from
  the first to the last minute of the window observed for **both** assets (stated as a deviation from the app).
- A window is **invalid for every setting** if fewer than 90% of its minutes are observed for both assets, and
  **invalid for one setting** if the app would have refused the run for lack of causal warmup. Invalid windows are
  dropped from that setting's statistics and listed in the results.

## Simulation

The reference is the unmodified engine at commit `6f6b693` (`engine.js`, frames built as `replay.js` builds them).
Fixed for every run: `initialCash` 1000, `allocationFraction` 0.5, `maxQuoteAgeMs` 60000, `maxOutcomeLatenessMs`
30000, `maxDrawdownBps` 0, `dailyLossBps` 0, `cashYieldBps` 0, replay mode. **Costs: `feeBps` 2, `slippageBps` 2,
assumed half-spread 3 bps** (the README's cheapest-venue assumption, about 14 bps per round trip).

The search runs on `research/fastsim.mjs`, a purpose-built simulator. Its answer sheet is the engine itself:
`research/fastsim.test.mjs` runs random settings through both on the bundled sample and on synthetic series with
gaps, and requires final value, comparison value, fills, fees and forecast counts to agree (1e-9 relative for
floats, exact for counts). Every nominee from family P is additionally rerun window by window through the real
engine before it is reported.

## Settings searched

| Family | What it is | Available in the app today | Settings |
|---|---|---|---|
| **P** | The app's rule. `horizonMs` in {1, 5, 7, 15, 60, 420, 1440} minutes (every horizon the app accepts) × `lookbackIntervals` in {1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240} × `bufferBps` in {0, 5, 10, 20, 40, 80, 160, 320} × `stopLossBps` in {0, 100, 300, 1000}, `model` trend | Yes, typed into Config | 3,360 |
| **H** | P with *hold-through*: at a scheduled decision a held asset whose test again says buy is kept instead of sold and rebought | No (engine change) | 3,360 |
| **R** | P with the forecast reversed: the predicted drift is negated, so the rule buys after a fall | No (engine change) | 3,360 |
| **X** | P for horizons up to 60 minutes, with LINK's forecast taken from BTC's drift (BTC unchanged) | No (engine change) | 1,920 |
| **L** | Long lookback: the drift is measured over a time span in {4h, 8h, 12h, 1d, 2d, 3d, 5d, 7d, 14d, 28d} instead of at most 240 observations × horizon in {60, 420, 1440} minutes × buffer in {0, 20, 80, 320} × stop in {0, 300, 1000} × hold-through {off, on} | No (engine change) | 720 |

12,720 settings in all. The same-price model is not searched: it never buys, so it is the cash line (0%).

Exact definitions of the four hypothetical changes, so they cannot drift after the data is seen:

- **Hold-through (H, and L when on).** At a scheduled decision compute each asset's forecast and buy test exactly
  as the engine does. Let `E` be the account's net liquidation value at that frame before any trade. First sell
  every held asset whose test says cash. Then, in the order BTC, LINK: a held asset whose test says buy is left
  untouched; an unheld asset whose test says buy is bought with `min(allocationFraction × E, available cash)`.
  Stop losses, the "no same-frame reentry" rule and the final close are unchanged. A decision the engine skips
  (insufficient history, or a horizon extending past the session end) sells that asset if held, which is the
  position the engine would be in.
- **Reversal (R).** `prediction = anchor × exp(−drift)`, with `drift` computed and clipped exactly as the engine
  computes it. Nothing else changes.
- **BTC-led (X).** LINK's `drift` is BTC's drift at the same frame (from BTC's own history); LINK's anchor and
  quotes stay LINK's. If BTC's forecast is unavailable, LINK's decision is skipped.
- **Long lookback (L).** `past` is the latest observation of that asset at or before `frame.time − span`, provided
  it is at most 60 minutes older than that; otherwise the decision is skipped as insufficient history.
  `drift = clip(log(last/past) × horizonMs / elapsed, ±0.03)` with the actual elapsed time, as in the engine.
  History may reach back before the window's first scored minute, inside the exploration range only.

Families H, R, X and L are evaluated to inform a decision J has not made (whether any rule change is worth
building). Their results are reported; nothing from them is added to the app by this work without J's call.

## Measures

For setting `c` and window `w`: `r(c,w)` = net return of the paper account in percent (final net liquidation value
over $1,000, after every modeled cost), `b(w)` = the comparison account's return (half BTC, half LINK, bought once
and held, same costs). Cash returns 0.

- **Eligible:** the setting places at least one fill in at least half of its valid design windows. A setting that
  never trades cannot be selected for returning exactly zero.
- **Score:** `T(c) = mean(r) / (sd(r) / sqrt(n))` over its valid design windows (`T` is 0 when `sd` is 0).
- **Search-adjusted p-value (reality check):** resample the design windows with replacement 10,000 times (seed
  fixed in code, the same resampled windows for every setting). For each resample take the maximum over eligible
  settings of `(mean*(c) − mean(c)) / (sd(c) / sqrt(n))`. The p-value is the share of resamples whose maximum is at
  least the observed maximum `T`. Reported per family and for all families pooled. It answers: how often would the
  best of this many settings look this good if none had a positive mean?

## Nomination (design set only)

Per family, take eligible settings in descending `T`. The first one with `mean(r) > 0` whose **neighbours** (one
grid step either way in lookback and in buffer; same horizon, stop and switches) have a median `T` above 0 is that
family's nominee. If none of the family's ten highest-scoring eligible settings qualifies, the family nominates
nothing. At most five nominees. The reality-check p-values are reported with them, not used as a gate.

## Confirmation (one look at windows 50 to 73)

Each nominee is run once on the confirmation windows. With `k` nominees:

- **Confirmed at default costs:** `mean(r) > 0` with one-sided t-test `p < 0.05 / k`.
- **Confirmed and cost-robust:** additionally `mean(r) > 0` when rerun with `feeBps` 10 (about 30 bps per round
  trip), following the README's warning that a result surviving only at the cheapest venue's costs is fragile.
- Otherwise **not confirmed**.

Reported alongside, not pass/fail: the intercept and slope of `r` regressed on `b` across windows (is the return
more than a diluted share of buy-and-hold?), the share of windows with `r > 0`, worst window, average fills and fees
per window, the direction sign test on the nominee's forecasts, and the rerun at `feeBps` 40.

## Always reported, whatever the outcome

- The default setting (seven-minute horizon, seven lookback, 10 bps buffer, no stop) on all 74 windows.
- Per family: how many settings were eligible, how many had a positive design mean, the best `T` and its
  reality-check p-value.
- The cost hurdle for every supported horizon: median absolute log move over the horizon against the round trip.
- Coverage: minutes expected, observed and missing per asset and shared, per window; invalid windows; receipts.
- Every deviation from this file, with its reason, under "Deviations" in `research/RESULTS.md`.

## What a result would and would not establish

A confirmed nominee means only that one setting, chosen on 2020 to 2023, also had a positive mean modeled return on
2023 to 2025 at these cost assumptions. It would justify writing a held-out contract for that setting and nothing
more: not a trading edge, not executable fills, not future profit. Replay quotes are candle closes with an assumed
spread; latency, queue position, market impact, taxes and funding are not modeled, and the fee assumption is one
venue's published rate, not a measured cost. "Not confirmed" is bounded the same way: no setting among the 12,720
searched was confirmed on these windows at these costs. Either outcome is reported with the same prominence.

Simulated cash only. No orders, keys, wallets or real-money path exist or are added.
