# Exploration protocol: can any setting of this rule make money after costs?

> **Status: FIXED before any exploration data was retrieved; amended twice, also before any data.** The first
> version is commit `5a82208` (2026-11-18). Amendment 1 (commit `6c9c9f2`) and Amendment 2, both 2026-11-19,
> correct defects that independent verifiers found; every change is listed with its reason under "Amendments" at
> the end. At each of these commits the only market data in the working tree is the bundled 30-hour sample: no
> exploration candle has been fetched, so no rule in this file was written or changed with knowledge of the data
> it will be applied to.
> Authorization level: agent proposal (Claude Code), written in answer to J's request "make me money". This is
> **exploration, not evidence**. It can nominate a candidate for a pre-registered held-out test; it cannot
> establish that any rule makes money, and nothing here is frozen as an evaluation contract.

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
- **Consequence for any future contract:** once this study is run, every UTC day from `2020-01-01` to `2025-09-29`
  has been used to choose settings and must be listed under "Excluded as already seen" if a contract's eligible
  range ever reaches back that far.
- Each response keeps a receipt (URL, receive time, HTTP date, SHA-256 of the raw body, row count). Missing minutes
  are never filled. Raw data stays out of the repository (`.research-data/`, ignored); `research/results/` records
  per-month row counts, coverage, receipt counts and a SHA-256 of each month's stored series and receipts so a
  re-fetch can be compared.
- **The study runs only on a complete store:** every month from 2020-01 to 2025-09 present and complete for both
  assets, fetched from the exchange. A month that holds no row for an asset is not complete. "Fetched from the
  exchange" is read from the store's own records (its source label and the request receipts bound to each month);
  that catches accidents and cannot prove where a file came from. Anything else is refused unless an explicit
  option is given, and that option is recorded as a deviation at the top of the results.

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
- Window 0 has no earlier data inside the exploration range, so the app's warmup rule refuses it for every setting
  of families P, H, R and X: those families have at most 49 design windows, and "all 74 windows" below means at
  most 73 for them.

## Simulation

The reference is the unmodified engine at commit `6f6b693` (`engine.js`, frames built as `replay.js` builds them).
Fixed for every run: `initialCash` 1000, `allocationFraction` 0.5, `maxQuoteAgeMs` 60000, `maxOutcomeLatenessMs`
30000, `maxDrawdownBps` 0, `dailyLossBps` 0, `cashYieldBps` 0, replay mode. **Costs: `feeBps` 2, `slippageBps` 2,
assumed half-spread 3 bps** (the README's cheapest-venue assumption, about 14 bps per round trip).

The search runs on `research/fastsim.mjs`, a purpose-built simulator. Its answer sheet is the engine itself:
`research/fastsim.test.mjs` runs random settings through both on the bundled sample and on synthetic series with
gaps, and requires final value, comparison value, fills, fees and forecast counts to agree (1e-9 relative for
floats, exact for counts). Every nominee is additionally rerun window by window through an engine before it is
reported: families P, R, X and L through the unmodified engine (R, X and L by feeding it the history their rule
reads), hold-through nominees through `research/holdthrough-oracle.mjs`, which is the same engine with only its
scheduled-decision branch replaced. The record states which reference each nominee was checked against, and the
SHA-256 of every module that ran, including whether `engine.js` still equals the one at `6f6b693`.

## Settings searched

| Family | What it is | Available in the app today | Settings |
|---|---|---|---|
| **P** | The app's rule. `horizonMs` in {1, 5, 7, 15, 60, 420, 1440} minutes (every horizon the app accepts) × `lookbackIntervals` in {1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240} × `bufferBps` in {0, 5, 10, 20, 40, 80, 160, 320} × `stopLossBps` in {0, 100, 300, 1000}, `model` trend | Yes, typed into Config | 3,360 |
| **H** | P with *hold-through*: at a scheduled decision a held asset whose test again says buy is kept instead of sold and rebought | No (engine change) | 3,360 |
| **R** | P with the forecast reversed: the predicted drift is negated, so the rule buys after a fall | No (engine change) | 3,360 |
| **X** | P for the five horizons up to 60 minutes {1, 5, 7, 15, 60}, with LINK's forecast taken from BTC's drift (BTC unchanged) | No (engine change) | 2,400 |
| **L** | Long lookback: the drift is measured over a time span in {4h, 8h, 12h, 1d, 2d, 3d, 5d, 7d, 14d, 28d} instead of at most 240 observations × horizon in {60, 420, 1440} minutes × buffer in {0, 20, 80, 320} × stop in {0, 300, 1000} × hold-through {off, on} | No (engine change) | 720 |

13,200 settings in all. The same-price model is not searched: it never buys, so it is the cash line (0%).

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

### Readings (how each sentence above is applied where it could be read two ways)

1. *Warmup.* A window is run as if the app replayed `[first shared minute, last shared minute]`: each asset keeps
   rows from `max(60, 2 × lookback + 10)` minutes before the first shared minute, and the run is refused unless
   each asset has `lookback + 1` rows at or before it. Family L has no such refusal; a decision without a usable
   `past` is skipped.
2. *Session end.* The session ends at the window's last shared minute. When the window's nominal last minute is
   missing for an asset, that end is earlier, and decisions whose horizon would pass it are skipped as the engine
   skips them. No price is involved; only decisions within one horizon of the end are affected.
3. *Hold-through.* `E` is read after that frame's stop-loss sales and before the decision's own sells. "Held" means
   quantity above zero at that point. A kept position is never resized and keeps its original fee-inclusive cost
   basis for the stop loss. A same-frame stop-out is a skipped decision, as in the engine. "Available cash" is the
   cash on hand at that asset's buy.
4. *BTC-led.* "BTC's forecast is unavailable" means BTC's drift cannot be computed from BTC's history. A BTC
   stop-out on that frame does not skip LINK. The app's warmup refusal still applies to each asset's own series.
5. *Long lookback.* "At most 60 minutes older" includes exactly 60 minutes.
6. *Neighbours* (used in Nomination) are the up to four settings one grid step away on exactly one of the two axes
   (lookback or span, and buffer), same horizon, stop and switches. They count whether or not they are eligible.
7. *Invalid windows.* A window that is invalid for a setting (low coverage, which is invalid for every setting, or
   refused for that setting) enters none of that setting's counts, means, standard deviations or scores, and it
   keeps its place in the window order: the windows either side of it are not an adjacent pair for the
   autocorrelation. For the search-adjusted p-value every one of the 50 design windows can be drawn in a resample,
   valid or not, and a drawn window adds nothing to a setting it is invalid for. For the confirmation p-value the
   resamples draw from the nominee's valid confirmation windows only.
8. *Comparison account.* `b` is defined on every window above the coverage floor. The buy-and-hold reading uses
   the windows valid for the nominee; the comparison account's own row uses every confirmation window above the
   floor and the same `k`.
9. *Descriptive figures.* The autocorrelation at lag `j` pairs valid windows exactly `j` places apart and divides
   by the same sum of squared deviations as lag 1; it is reported as computed, not floored. The halves of the
   confirmation set are windows 50 to 61 and 62 to 73. "The third in which `b` was lowest" is the `floor(n / 3)`
   of the nominee's `n` valid confirmation windows with the smallest `b`, ties to the earlier window.

## Measures

For setting `c` and window `w`: `r(c,w)` = net return of the paper account in percent (final net liquidation value
over $1,000, after every modeled cost), `b(w)` = the comparison account's return (half BTC, half LINK, bought once
and held, same costs). Cash returns 0.

- **Eligible:** the setting has at least 40 valid design windows and places at least one fill in at least half of
  them. A setting that never trades cannot be selected for returning exactly zero.
- **Score:** `T(c) = mean(r) / (sd(r) / sqrt(n)) × sqrt((1 − a) / (1 + a))` over its valid design windows, where
  `a` is the lag-1 autocorrelation of `r` in window order (sum of products of deviations over adjacent valid
  windows, divided by the sum of squared deviations), floored at 0. The second factor shrinks the score of a
  setting whose good and bad windows come in runs, because such windows are not independent observations.
  `T` is 0 when `sd` is 0.
- **Search-adjusted p-value:** resample the design windows with replacement 10,000 times (seed fixed in code, the
  same resampled windows for every setting). In each resample compute, for every eligible setting,
  `(mean*(c) − mean(c)) / (sd*(c) / sqrt(m*(c)))`, where `mean*`, `sd*` and `m*` are taken over the resampled
  windows valid for that setting (settings with fewer than two such windows or `sd*` of 0 are skipped in that
  resample), and take the maximum. The p-value is the share of resamples whose maximum is at least the observed
  maximum `T`. Reported per family and for all families pooled. It answers: how often would the best of this many
  settings look this good if none had a positive mean?

## Nomination (design set only)

Per family, take eligible settings in descending `T`, ties in the order the family's grid is enumerated. Settings
whose design returns are identical window for window count once, represented by the first of them. The first of
the ten highest-scoring distinct settings that has `mean(r) > 0` and whose neighbours have a median `T` above 0 is
that family's nominee. If none of the ten qualifies, the family nominates nothing. At most five nominees. The
search-adjusted p-values are reported with them, not used as a gate.

## Confirmation (one look at windows 50 to 73)

Each nominee is run once on the confirmation windows, at each cost level. With `k` nominees, compute on its valid
confirmation windows the score `T` exactly as defined above, and two one-sided p-values for it: Student's t with
`n − 1` degrees of freedom, and the share of 10,000 resamples of those windows (seed fixed in code) whose
studentized statistic `(mean* − mean) / (sd* / sqrt(n))` is at least `T`. The confirmation p-value is the larger
of the two.

- **Confirmed at default costs:** at least 20 valid confirmation windows, `mean(r) > 0`, and confirmation
  p-value `< 0.05 / k`.
- **Confirmed and cost-robust:** additionally `mean(r) > 0` when rerun with `feeBps` 10 (about 30 bps per round
  trip), following the README's warning that a result surviving only at the cheapest venue's costs is fragile.
- Otherwise **not confirmed**.

**More than a share of buy-and-hold: yes or no.** Stated beside the label of every nominee, wherever the label is
printed. A long-only rule gains whenever the two assets rise, so a mean above zero can be nothing more than time
spent invested. Fit `r = intercept + slope × b` by least squares over the nominee's valid confirmation windows.
The reading's p-value is the larger of the fit's one-sided p-value for `intercept > 0` (Student's t, `n − 2`
degrees of freedom) and the confirmation p-value defined above computed on the series `r − slope × b`. *Yes*
needs at least 20 valid windows, `intercept > 0` and that p-value `< 0.05 / k`; anything else is *no*. *No* means
the nominee's return on these windows cannot be told apart from holding the fraction `slope` of the comparison
account.

Reported alongside, not pass/fail: the comparison account's own returns `b` on the confirmation windows put
through the same confirmation calculation (did simply holding pass?); the intercept and slope with their standard
errors; the share of windows with `r > 0`; the worst window; the skewness of `r` and its autocorrelation at lags 1
to 4; the mean of `r` in each half of the confirmation set and over the third of windows in which `b` was lowest;
average fills and fees per window; the app's two-sided direction sign test on the nominee's forecasts pooled over
its confirmation windows; and the rerun at `feeBps` 40.

## What the tests can and cannot do (measured on simulated data, before any real data)

Every figure in this section describes the tests, not a rule and not a market. The figures are measured on
simulated returns by `node research/calibration.mjs --write`, which records them in `research/calibration.json`
and writes the two tables below from that file; a test fails if the tables differ from it.

**How often each test passes when there is nothing to find.** In every row but the last, every true mean (for the
last column, every true intercept) is exactly zero. A cell near its column's level, 5% for the two search columns
and 1% for the other two, means the test is as strict as it claims. A lower cell means it is stricter than that. A
higher cell means it passes too often, by the ratio of the cell to the level.

<!-- calibration:sizes:start -->
| No-skill returns | Search-adjusted p < 0.05, one family (3,360 settings) | Search-adjusted p < 0.05, all families (13,200 settings) | Confirmation p < 0.01 (24 windows) | "More than a share of buy-and-hold: yes" at p < 0.01 (24 windows) |
|---|---|---|---|---|
| Independent windows, bell-shaped | 2.5% (10 of 400) | 2.0% (4 of 200) | 0.7% (144 of 20,000) | 0.9% (184 of 20,000) |
| Left-skewed (skewness −0.95) | 3.8% (15 of 400) | 1.5% (3 of 200) | 1.2% (244 of 20,000) | 1.5% (309 of 20,000) |
| Left-skewed (skewness −1.75) | 2.3% (9 of 400) | 0.5% (1 of 200) | 1.5% (300 of 20,000) | 2.0% (398 of 20,000) |
| Right-skewed (skewness +0.95) | 2.3% (9 of 400) | 1.0% (2 of 200) | 0.2% (44 of 20,000) | 0.4% (75 of 20,000) |
| Half the windows without a trade | 0.3% (1 of 400) | 0 of 200 (below 1.5%) | 0.5% (102 of 20,000) | 0.6% (121 of 20,000) |
| Runs (lag-1 autocorrelation 0.2) | 16% (65 of 400) | 18% (35 of 200) | 1.3% (263 of 20,000) | 1.7% (348 of 20,000) |
| Left-skewed (−0.95) and runs | 16% (65 of 400) | 17% (33 of 200) | 2.1% (413 of 20,000) | 2.6% (513 of 20,000) |
| Left-skewed (−1.75) and runs | 13% (51 of 400) | 16% (32 of 200) | 2.9% (576 of 20,000) | 3.5% (705 of 20,000) |
| Regimes: good and bad stretches of several windows (lag-1 autocorrelation 0.2) | 89% (354 of 400) | 100% (200 of 200) | 4.8% (962 of 20,000) | 4.9% (970 of 20,000) |
| Regimes: calm windows with small gains, turbulent windows with large losses | 27% (107 of 400) | 30% (60 of 200) | 13% (2,542 of 20,000) | 12% (2,409 of 20,000) |
| No timing value: 40% invested in a rising market | not measured | not measured | 18% (3,673 of 20,000) | 0.8% (159 of 20,000) |
<!-- calibration:sizes:end -->

The search columns simulate the grid as clusters of 25 near-identical settings over 50 windows (the one-family
column's last cluster has 10), with the first 2,000 of the protocol's 10,000 resamples; how alike the real grid's
settings are cannot be known before the data. Families X (2,400 settings) and L (720) have no column of their own.
For the last column each row's returns, multiplied by 3, are added to 40% of a comparison account that gains 6% a
window with a standard deviation of 15%. The last row is that same simulated rule with bell-shaped returns, and
there the confirmation test is applied to its returns as they are: it has no timing value, only time spent
invested in a rising market.

Read row by row:

- **Independent windows** (the first five rows). The confirmation test and the buy-and-hold reading stay within
  about twice their level for every shape measured (at most 1.5% and 2.0%). The search-adjusted p-value is stricter
  than it claims: about half its level for one family and about a fifth for all families pooled, and stricter
  still when half the windows have no trade.
- **Runs** (the next three rows: each window leans toward the one before it). Every test passes too often: the
  search-adjusted p-value about three times its level, the confirmation test and the buy-and-hold reading up to
  three and a half times theirs (1.3% to 3.5% at a 1% level).
- **Regimes** (the two rows after those: good and bad stretches lasting several windows, with about the same lag-1
  autocorrelation as the runs). Every test fails: the search-adjusted p-value passes 27% to 100% of the studies,
  the confirmation test and the buy-and-hold reading about 5% and 12% to 13% of the nominees at a 1% level. These
  are the rows to read before trusting any label.
- **A rising market** (the last row). The confirmation test is right to pass, since the mean really is above zero,
  and it does so in about one sample in five (18%). The buy-and-hold reading stays near its level (0.8%). That is
  why the reading stands beside every label.

Limits that no test on these windows can remove:

- **Rare large losses.** A rule that gains a little in most windows and loses a lot in one window out of twenty
  looks excellent in every sample that happens to contain no such loss; with 24 windows that is about three samples
  in ten. The worst window and the skewness are reported so this shape can be seen, but an unseen loss cannot be.
- **Dependence between windows.** The tests keep their stated level only when windows are independent of one
  another. When each window leans on the one before (runs) they pass up to three and a half times too often. When
  good and bad windows come in stretches lasting several windows (regimes), 24 or 50 windows hold only a handful of
  independent stretches, a sample that happens to hold few bad ones looks excellent, and the confirmation test
  passes five to thirteen times too often. An independent verifier tried substitutes in a scratch measurement that
  is not part of `research/calibration.json` (a t-test on means of blocks of three, four or six windows, and a
  long-run variance with four lags); none brought the confirmation test back to its level on 24 windows. So the
  limit is stated instead: **every label in this protocol assumes that a setting's windows are independent of one
  another, and for these two assets that cannot be assumed.** The autocorrelations of 24 windows barely show such
  stretches: in scratch counts on the simulated regimes the average lag-1 autocorrelation was 0.06 to 0.08 and lags
  2 to 4 were near zero. Lags 1 to 4, the two halves and the lowest third are reported so that the shape of a
  nominee's returns can be seen; none of them is a test.
- **Low power.** The table below shows how often a real mean is found. "Not confirmed" does not show that a
  smaller positive mean is absent.

**How often a real mean is found.** One setting has the true mean shown, in standard deviations of its own window
returns; every other setting has none. The mean is added to the first row's own simulated studies and nominees, so
the rows of this table are not independent of each other or of that row. The first column counts a pass whether or
not the best score belongs to the setting that has the mean (in the 0.25 row none of the four passes did;
`research/calibration.json` records both counts).

<!-- calibration:power:start -->
| True mean per window, in standard deviations | Search-adjusted p < 0.05, all families (13,200 settings) | Confirmed with five nominees (p < 0.01) | Confirmed with one nominee (p < 0.05) | "More than a share of buy-and-hold: yes" with five nominees |
|---|---|---|---|---|
| 0.25 | 4.0% (4 of 100) | 8.9% (1,781 of 20,000) | 28% (5,515 of 20,000) | 8.9% (1,784 of 20,000) |
| 0.5 | 19% (19 of 100) | 40% (8,024 of 20,000) | 71% (14,238 of 20,000) | 37% (7,353 of 20,000) |
| 0.75 | 62% (62 of 100) | 80% (15,904 of 20,000) | 96% (19,115 of 20,000) | 74% (14,869 of 20,000) |
| 1 | 96% (96 of 100) | 97% (19,383 of 20,000) | 100% (19,941 of 20,000) | 95% (18,952 of 20,000) |
<!-- calibration:power:end -->

So with five nominees a mean of 0.75 standard deviations per 28-day window is confirmed about four times in five,
and the pooled search finds it about six times in ten. Over 13 windows a year that mean is a yearly return of about
2.7 times its yearly standard deviation.

## Always reported, whatever the outcome

- The default setting (seven-minute horizon, seven lookback, 10 bps buffer, no stop) on all 74 windows.
- Per family: how many settings were eligible, how many had a positive design mean, how many distinct return
  vectors the ten considered settings held, the best `T` with its skewness, autocorrelation and number of valid
  windows, and its search-adjusted p-value.
- For every nominee: its label with the buy-and-hold reading beside it, and the comparison account's own row.
- The cost hurdle for every supported horizon: median absolute log move over the horizon against the round trip.
- Coverage: minutes expected, observed and missing per asset and shared, per window; invalid windows; receipts.
- Every deviation from this file, with its reason, and the Readings above, in `research/RESULTS.md`, which the
  study command writes together with `research/results/exploration.json`. A second run does not silently replace
  an earlier record.

## What a result would and would not establish

A confirmed nominee means only that one setting, chosen on 2020 to 2023, also had a positive mean modeled return on
2023 to 2025 at these cost assumptions. If the buy-and-hold reading beside it is *no*, that return cannot be told
apart from holding a share of the two assets while they rose, and it justifies nothing further. If the reading is
*yes*, it would justify writing a held-out contract for that setting and nothing more: not a trading edge, not
executable fills, not future profit. Both carry the limits measured above. They pass too often when windows are
not independent of one another, so a pass is a reason to test on untouched data and never a finding by itself. Replay
quotes are candle closes with an assumed spread; latency, queue position, market impact, taxes and funding are not
modeled, and the fee assumption is one venue's published rate, not a measured cost. If nothing is confirmed, that
finding is bounded the same way: none of the settings searched was confirmed on these windows at these costs,
which does not show that no rule could be. Either outcome is reported with the same prominence.

Simulated cash only. No orders, keys, wallets or real-money path exist or are added.

## Amendments

**Amendment 1, 2026-11-19, before any exploration data was retrieved.** The first version (commit `5a82208`) was
built and then attacked by independent verifier agents on synthetic data only. Their findings, and what changed:

| Change | Reason |
|---|---|
| Family X has 2,400 settings (five horizons) and the total is 13,200; the first version said 1,920 and 12,720 | The table's own text ("horizons up to 60 minutes") includes the 60-minute horizon; its count did not. The text is kept and the counts corrected |
| The score is multiplied by the autocorrelation factor | With no skill and window returns in runs (lag-1 autocorrelation 0.2), the search-adjusted p-value fell below 0.05 in about 18% of simulated studies without this factor and 10% with it |
| The search-adjusted p-value re-studentizes inside each resample; the first version divided by the full-sample `sd` | A verifier measured the first version's p `< 0.05` in up to 61% of no-skill studies (and in as few as 1% when returns were right-skewed), depending on search width and skew. It was a flaw in the statistic, not in its code |
| Eligibility requires at least 40 valid design windows | A setting with a handful of valid windows can own the maximum score by chance |
| Identical return vectors count once in nomination; ties follow grid order | The "ten highest-scoring settings" often held only a few distinct rules, as few as two of ten (settings differing in a stop or buffer that never binds) |
| The confirmation p-value is the larger of a t-test and a studentized resample, both on the adjusted score, and needs at least 20 valid windows; the first version used the t-test alone | The t-test alone passed 2% to 7% of no-skill nominees at a 1% level when returns were left-skewed or in runs |
| The study refuses an incomplete or non-exchange candle store | A verifier ran the first build on a store holding 6 of 69 months; it reported nominees and "Deviations: none" |
| Hold-through nominees are rerun through the patched engine; module hashes are recorded | The first build reported them with no engine comparison, and the record did not identify the code that produced it |
| "Readings", the window-0 note and the "What the two tests can and cannot do" section are new text | The builders had to choose between readings in each of these places; the choices are now part of the protocol instead of living only in code |

The data boundary, the windows, the design and confirmation sets, the simulation settings, the cost levels, the
four rule-change definitions and the three confirmation labels are unchanged.

**Amendment 2, 2026-11-19, before any exploration data was retrieved.** The code was brought to Amendment 1 and
attacked again by independent verifier agents, on synthetic data only. The code held; the protocol's own
description of its tests did not. Their findings, and what changed:

| Change | Reason |
|---|---|
| Reading 7 says what an invalid window does: it keeps its place, pairs with nothing, and can still be drawn in a search resample | The earlier sentence ("dropped before any statistic is computed") could also be read as removing the window, and a verifier showed on synthetic prices that the two readings can nominate different settings. The reading already in the code is kept, on the principle that windows 56 days apart are not consecutive; no real window had been seen |
| A month that holds no row is not complete, and "fetched from the exchange" is read from the receipts as well as the label | A verifier's store with 66 of 69 months empty ran as a complete store with "Deviations: none", and an edited source label passed although every receipt in the same store named another host |
| New: "More than a share of buy-and-hold: yes or no" beside every label, and the comparison account's own row | "Confirmed" tests a mean above zero, which a long-only rule meets by being invested while the two assets rise (the last row of the first table). Before this amendment the regression was reported without a reading, leaving the interpretation to be made after the result was known |
| New descriptive figures: autocorrelation at lags 1 to 4, the two halves, the lowest third (Readings 8 and 9) | A verifier measured that the lag-1 autocorrelation of 24 windows averages 0.06 to 0.08 under regimes that make the confirmation test pass five to thirteen times too often, so it cannot warn of them. Lags 2 to 4 cannot either (near zero on the same data); the new figures show the shape of a nominee's returns and are not tests |
| The section on what the tests can do is rewritten. Its tables are written from a committed measurement, the search test is quoted at the width of families P, H and R (3,360) and pooled (13,200), regimes and a rising market have rows, and the power figures are a table | A verifier found the earlier table quoted the search test at 300 settings, a width no family has. Under runs its 10% became 16% at 3,360 settings and 18% at 13,200 in the committed measurement (17% and about 20% in the verifier's own run), while on independent windows the pooled test passed less than half as often as it claims. Five cells were off by more than their sampling error, "up to about twice too lenient" ignored regimes, and "roughly half a standard deviation" overstated what the tests can find |
| "Dependence between windows" is a third stated limit, with the sentence that every label assumes independent windows | Same finding. The committed measurement shows that the runs rows already pass too often, not only the regimes. The verifier tried block means and a long-run variance in a scratch measurement and none restored the level, so the limit is disclosed and not patched |
| The closing sentence about "not confirmed" is now conditional | The report printed it as fixed text in every run, also beside nominees labelled confirmed |

The data boundary, the windows, the design and confirmation sets, the simulation settings, the cost levels, the
settings searched, the four rule-change definitions, the score, both p-values, the nomination rule and the three
confirmation labels are unchanged.
