# Research: can any setting of this rule make money after costs?

> **Work in progress at this commit.** The protocol's second amendment is written. The code and the protocol's
> two measured tables are still being brought to it, so some research tests fail here, and three things described
> below are not in place yet: the buy-and-hold reading, `calibration.json` and `npm run test:research`.

**Status: built, and checked on synthetic data only. The study has not been run. No result exists.**
The environment it was built in cannot reach the exchange, so no exploration candle has been fetched. Nothing in
this directory says that any rule makes or loses money on 2020 to 2025 prices.

Simulated cash only. Nothing here places, models or prepares a real order.

## What is here

| File | What it is |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | The rules, fixed before any data: which candles, which 13,200 settings, how a setting is chosen on 2020 to 2023 and checked once on 2023 to 2025, and what a result would and would not establish. Amended twice, both times before any data; every change is listed with its reason at the end |
| `fetch-candles.mjs`, `dataset.mjs` | Downloads Coinbase one-minute candles for BTC-USD and LINK-USD into `.research-data/` (ignored by git), keeping a receipt for every response. Refuses anything from `2025-09-30T00:00Z` on, with no override: that range is reserved for a held-out test |
| `fastsim.mjs`, `engine-run.mjs`, `holdthrough-oracle.mjs` | A fast simulator for the search, and the runners that replay every nominee through the app's own `engine.js` |
| `stats.mjs`, `calibration.mjs`, `calibration.json` | The protocol's statistics, and the measurement of how often each test passes when there is nothing to find (the tables in the protocol are written from `calibration.json`) |
| `study.mjs`, `study-worker.mjs`, `settings.mjs`, `report.mjs` | The study command. It writes `research/RESULTS.md` and `research/results/exploration.json` |
| `sample-cost-hurdle.mjs` | A descriptive look at the bundled sample only (below) |
| `*.test.mjs` | The harness's own tests: `npm run test:research` |

## Run it

Node 22 or later, from the repository root, on a machine that can reach `api.exchange.coinbase.com`.

```sh
node research/fetch-candles.mjs    # once; about 20,300 requests. Stop and restart at will: finished months are kept
node research/study.mjs            # about two minutes on four cores
```

- The download is paced at four requests a second at most. Expect two to three hours. That figure is an estimate
  from the request count: the fetcher has only ever talked to a local test server.
- Behind a proxy, Node's built-in `fetch` needs `NODE_USE_ENV_PROXY=1`.
- `study.mjs` refuses to run unless every month from 2020-01 to 2025-09 is present for both assets and the code is
  committed. Each refusal names the option that overrides it, and an override is printed as the first line of the
  results.
- The study looks at the confirmation windows once. A second run does not replace an earlier record unless
  `--overwrite` is given, and then the report says so.
- Read `RESULTS.md` from the top. It says what was run, lists every deviation, and labels each nominee as
  **not confirmed**, **confirmed at default costs** or **confirmed and cost-robust**, with **more than a share of
  buy-and-hold: yes or no** beside it.

## How to read a result

- **Most likely: nothing confirmed.** That would mean none of the 13,200 settings searched was confirmed on those
  windows at those costs. It would not show that no rule could be.
- **Confirmed, buy-and-hold reading "no".** The setting had a positive mean modeled return, and that return cannot
  be told apart from simply holding part of the two assets while they rose. It justifies nothing further.
- **Confirmed, buy-and-hold reading "yes".** A reason to write a held-out contract for that one setting and test it
  on data nobody has looked at. Not a finding by itself: the protocol measures how often its own tests pass with
  nothing to find, and under plausible conditions (good and bad months coming in streaks) that is several times
  more often than their stated level.
- Once the study has been run, every day from 2020-01-01 to 2025-09-29 has been used to choose settings. A later
  contract must not draw its test windows from that range.

## What the bundled sample already says about costs

`node research/sample-cost-hurdle.mjs` reads only `data/sample.json` (about 30 hours, already used by every earlier
report). At the default costs one round trip takes 14 basis points. A typical move over the horizon has to be
larger than that before any direction call can pay.

| Horizon | Whole horizons in the sample | BTC mean move | BTC break-even accuracy | LINK mean move | LINK break-even accuracy |
|---|---|---|---|---|---|
| 1 min | 1,799 | 1.2 bps | none (above 100%) | 4.2 bps | none (above 100%) |
| 5 min | 359 | 2.8 bps | none (above 100%) | 9.2 bps | none (above 100%) |
| 7 min (default) | 257 | 3.3 bps | none (above 100%) | 10.9 bps | none (above 100%) |
| 15 min | 119 | 4.8 bps | none (above 100%) | 16.7 bps | 91.9% |
| 60 min | 29 | 9.2 bps | none (above 100%) | 37.3 bps | 68.8% |
| 420 min | 4 | 14.6 bps | 98.0% | 94.0 bps | 57.5% |
| 1,440 min | 1 | 33.2 bps | 71.1% | 56.1 bps | 62.5% |

- In this sample, at the default seven-minute horizon and at every horizon up to an hour for BTC, the typical
  move is smaller than the cost of trading it. No accuracy makes that pay.
- Only the slow horizons leave any room, and the sample holds four and one of those: it says almost nothing
  about them. That is the gap the study is built to fill.
- Grade: **Self-reported** (one agent's run of the script on the bundled sample; the break-even column is a
  yardstick that assumes right and wrong calls move the same distance). 30 hours is one short stretch of one
  month.

## How this was checked

Every number below comes from synthetic prices or the bundled sample.

- The fast simulator agrees with the unmodified `engine.js` and with the patched hold-through engine on every case
  two independent verifier agents built, including their own simulators written from the protocol text.
- Replacing every price after a minute changed nothing decided at or before that minute, and scrambling everything
  after the last design minute left the nominees byte-identical.
- The fetcher's range guard held under attack: odd dates, look-alike hosts, flags, environment variables,
  redirects.
- Independent verification found real defects, all before any data: a selection test that passed far too often
  with nothing to find, a table describing the tests that was too optimistic, and a study that accepted an
  incomplete candle store. Each is recorded with its fix under "Amendments" in the protocol.

What was not checked: the live exchange (rate limits, whether every 2020 to 2025 candle passes validation), and
anything about real prices.
