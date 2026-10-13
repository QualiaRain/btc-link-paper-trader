# Paper Trail

A browser-local BTC/LINK paper-trading experiment with configurable rules, historical replay, live public quotes and exportable run history. The default balance is **$1,000 simulated cash**. No wallet, exchange credentials or real orders are involved.

**[Open the app](https://qualiarain.github.io/btc-link-paper-trader/)** · [Source](https://github.com/QualiaRain/btc-link-paper-trader)

## Configure and run

Use the **Config**, **Run** and **History** views. These are navigation views, not an authentication or administrative security boundary.

In Config, choose starting cash, forecast horizon, trend or same-price rule, lookback intervals, entry buffer, allocation per asset, stop loss, account drawdown and daily loss limits, fees, slippage and live-session duration. Defaults are $1,000 cash, a seven-minute horizon, seven lookback intervals, a ten-basis-point entry buffer, up to 50% per asset, no stop loss, no account limits, no idle cash yield, two-basis-point fees and two-basis-point slippage per fill, and a three-basis-point assumed replay half-spread. Ten basis points equals 0.10%.

Cost defaults model the cheapest venue verified for a Massachusetts retail account in October 2026: Binance.US spot, which has charged 0% maker / 0.02% taker for all users with no volume tiers since April 22, 2026 ([announcement](https://blog.binance.us/zero-fee-trading/)). The app buys at the ask and sells at the bid, so it uses the 2 bps taker fee. Binance.US books are thin and the app prices fills from Coinbase quotes, so the default replay half-spread is 3 bps rather than 2 as an allowance; it is an assumption, not a measured Binance.US spread. One full round trip costs about 0.14%.

Those defaults are only valid if you can actually trade there: confirm that sign-up works in your state, that LINK/USD is open, and that live spreads are no wider than assumed. Other venues cost far more at entry tiers. Coinbase Advanced's US entry taker fee is 0.90% per fill ([announcement](https://www.coinbase.com/blog/were-lowering-fees-for-many-active-traders-on-coinbase-advanced), effective September 16, 2026), about 1.9% per round trip. A result that only survives at the cheapest venue's costs is fragile, so rerun any promising run at your actual venue's fee.

Settings freeze when the run starts. To change them, save the current run and start another. Settings JSON can be exported and imported before starting; invalid values and unknown configuration fields are rejected before anything is applied.

- **Included sample:** try the bundled real Coinbase minute closes immediately. The first configured lookback intervals provide warmup; scored results begin afterward.
- **UTC date range:** fetch up to 31 days of completed Coinbase minute candles. Inputs are UTC minute-close boundaries. Both BTC and LINK must contain the exact start and end; otherwise the fetch fails without creating a run. Warmup comes before the scored start and does not earn returns or enter accuracy totals. Progress and cancellation are available during retrieval.
- **Live paper account:** poll public Coinbase bid/ask snapshots every ten seconds while this tab is visible. Live duration is configurable, defaulting to 48 hours.

Replay can play slowly, advance to the next decision, or finish in responsive batches. It closes positions with modeled exit costs on the exact final historical frame. Historical duration is the selected scored end minus start; live duration does not shorten a replay. Reload restores the latest saved current snapshot **paused**. Hidden tabs pause active runs. No off-tab or gap trades are invented.

## Rule, costs and comparisons

The trend forecast uses the log-price change over the chosen number of earlier completed observations, scaled by actual elapsed time to the selected horizon and clipped to ±0.03 log return per forecast. Missing minutes are never filled. The same-price rule forecasts the current midpoint.

At each decision, the engine closes existing positions and freezes a new future forecast. It buys only when predicted upside clears spread, both modeled fees, both slippage charges and the entry buffer. Allocation uses the selected fraction of available cash per asset, up to 50%. Accounts are long only, without leverage. The stop loss checks net liquidation value against fee-inclusive position cost at observed frames; zero disables it. A gap can produce a loss larger than the selected threshold. Manual paper trades are labeled and make the result a modified strategy run.

Two optional account limits sit above the rule and always win. The **max drawdown** limit compares net liquidation value with its highest observed value, starting from initial cash; a breach closes positions with modeled exit costs and stops new entries for the rest of the session. The **daily loss** limit compares net liquidation value with the first observed value of the UTC day; a breach closes positions and stops new entries until the next UTC day. Both are checked at observed frames before each decision, so a gap can overshoot them, and zero disables either. While halted, the rule still issues and scores forecasts, and each blocked decision records whether it would have bought. Manual buys are refused during a halt.

Buys use ask plus slippage; sells use bid minus slippage; each pays a fee. All values include hypothetical exit costs. Replay bid/ask is constructed using the configurable **assumed half-spread** on each side of the candle close. It is not archived order-book data. Live spread comes from the public ticker.

The comparison account invests half the initial balance in BTC and half in LINK at the same first quotes and costs, then holds. Idle cash in the paper account earns the configured **idle cash yield**, an annual rate compounded continuously over elapsed time, including unobserved gaps; the default is 0%. The cash comparison line grows at the same rate, and the comparison account holds no cash. A profitable replay does not establish a reliable edge. Repeatedly tuning settings against observed results can overfit them. This is a simple experimental rule, not a trained or validated trading model.

## Saved history and exports

Snapshots save on start, pause, completion, manual orders, archive and export; live runs also periodically save while active. Each run has a stable ID. Saving another snapshot updates that run rather than adding a duplicate. **History** lists full or partial status, frozen settings, account value, return, benchmark, drawdown and manual changes.

Open a saved run as a **read-only snapshot**, copy its settings to a separate new run, download its settings or full evidence, or export all saved runs. The current-session pointer is small; full records use IndexedDB. Storage failures are shown explicitly and do not discard the current account. Use Export run to keep a separate copy if browser storage is unavailable or full. Browsers can evict site data, so local storage is not a backup.

Run JSON includes full account/ledger/forecasts, summary, config, quote/source evidence, selected boundaries and hashes. Repeated causal history is compacted into a catalog with exact per-frame references; restoring reconstructs the original observations, including warmup and nonshared source minutes. Records are editable by their owner. Hashes help identify evidence changes; they do not make a record tamper proof or establish executable fills.

## Data and scoring

The included sample contains real shared BTC/LINK completed minute observations from October 10–11, 2026. [Bundled provenance](data/README.md). Date-range replay retrieves the selected public source series and saves fetch evidence/coverage. Sparse shared minutes remain gaps.

Public endpoints:

- [Coinbase Exchange ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker): bid/ask, last-trade price and exchange last-trade timestamp.
- [Coinbase Exchange candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles): completed one-minute candles.

Local HTTP receipt time is quote availability time. The exchange ticker timestamp belongs to the last trade, not a separately timestamped bid/ask update. Forecasts score against the first qualifying later midpoint with a fixed **30-second maximum observation lateness**; missed targets expire and are excluded from accuracy. Errors are reported per asset. Longer horizons extrapolate a short recent trend and provide no new calibration evidence.

Public snapshots do not establish executable orders. Latency, queue position, market impact, liquidity constraints, taxes and funding are not modeled. Millisecond trading is unsupported. A good historical run or a short live pilot does not prove future profit.

## Local development

No build or package installation is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080`. Serve over HTTP; direct file URLs can block module and data requests. Evidence hashing requires HTTPS or localhost.

With Node.js 22 or later, run `npm test`. `engine.js` handles deterministic accounting/forecasts, `market.js` reads public data, `history.js` manages run evidence and IndexedDB, and `app.js` handles the views. There are no dependencies or order-submission endpoints.
