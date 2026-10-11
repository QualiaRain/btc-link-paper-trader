# Paper Trail

A $1,000 **simulated** BTC/LINK account you can actually try: recorded market replay, live public quotes, a forecast ledger, explicit trading costs, and cash/buy-and-hold benchmarks.

**[Open the app](https://qualiarain.github.io/btc-link-paper-trader/)**

## Try it

1. Click **Try market replay**. It starts a fresh $1,000 account using actual recorded Coinbase prices.
2. Use **Next decision** to inspect the next forecast and any paper trades, or **Finish replay** to see the full sample.
3. Compare the account with $1,000 cash and a 50/50 BTC/LINK buy-and-hold account. All invested values include hypothetical exit costs.
4. **Export ledger** downloads the frozen forecasts, observations, decisions, fills, costs, settings and source evidence as JSON.

Alternatively, **Start live paper account** uses current public Coinbase bid/ask quotes. No exchange login, API key, wallet, deposit or real order is involved. Sessions run only while the page is visible, pause when the tab is hidden, and restore paused after a reload. Each browser has its own account; this is not a shared hosted ledger.

## The fixed rule

The default challenger estimates a 7-minute future midpoint using the log-price change over seven earlier completed observations, scaled by actual elapsed time and capped at ±0.03 log return per forecast. This is a deliberately simple price-only rule, **not a trained or validated trading model**. The earlier daily-price experiment did not establish an edge.

At each decision:

- Close existing paper positions at observed bid minus the slippage assumption and fees.
- Freeze a future price forecast before observing its outcome.
- Buy only when the estimated net upside exceeds current spread, modeled round-trip fees/slippage, and an additional 10-basis-point buffer. Otherwise keep cash.
- Spend at most half the available account cash per asset. No short positions or leverage.

Horizon choices: 1, 5, 7 or 15 minutes; 1 or 7 hours; or 24 hours. Settings are fixed for an account. Archive it to try different rules. The same-price baseline rule should remain in cash after costs. Manual paper orders are labeled separately and change the account’s performance, so a manually modified account is no longer a pure automatic-strategy test.

The session limit is 48 hours from its first observed frame. Replay ends when the supplied historical sample ends, which is sooner. Remaining forecasts stay pending until qualifying later evidence exists. Live connection gaps do not create fictitious intervening trades. Closing or resuming after a target does not recreate the price that was missed.

## Costs and comparisons

- Default fee: **10 bps per fill (0.10%)**, an editable assumption, not an exchange-specific quote.
- Default slippage: **2 bps per fill (0.02%)**, also an assumption.
- Replay spread: **2 bps on each side** of the actual recorded candle close; historical bid/ask was not captured.
- Live spread: actual bid/ask returned by Coinbase’s public ticker, at local receipt time.
- Buys use ask plus slippage; sells use bid minus slippage; fees are charged on both sides.
- The 50/50 buy-and-hold benchmark invests $500 per asset at the same initial quotes, fees and slippage, then holds. Cash earns zero. Both invested accounts are marked at net liquidation value after modeled exit costs.

Public snapshots do not establish executable fills. Latency, queue position, market impact, funding, taxes and liquidity constraints are not modeled. Millisecond trading is not supported: decimal timestamp precision does not provide a low-latency streaming feed or prove executable accuracy.

## Data and scoring

Replay contains 1,648 exact shared BTC/LINK completed minute observations from October 10–11, 2026, captured on October 11. Missing shared minutes are skipped rather than filled. [Data provenance](data/README.md).

Live mode reads only these unauthenticated public endpoints, polling every 10 seconds:

- [Coinbase Exchange ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker): bid/ask, last-trade price and exchange last-trade timestamp.
- [Coinbase Exchange candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles): completed one-minute warmup observations. Longer forecast horizons still extrapolate the same short recent trend.

The local HTTP receipt time is the quote’s availability time; the ticker’s exchange timestamp describes the last trade, not a separately timestamped order-book update. Forecast issue/target/outcome times are saved in UTC. Forecasts score against the first qualifying subsequent midpoint, with a **30-second maximum observation lateness**. Missed targets expire and are excluded from accuracy metrics. Accuracy is reported per asset; pooled BTC/LINK dollar errors would not be a useful comparison.

Records are browser-local and editable by their owner; exports are transparent evidence, not a tamper-proof public audit. A good historical result or a 48-hour pilot does not establish reliable future profit.

## Run locally

No build or package installation is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080` in a browser. Serve the directory over HTTP; opening `index.html` as a local file will block module/data requests in many browsers.

With Node.js 22 or later:

```sh
npm test
```

`engine.js` is the pure accounting/forecast engine; `market.js` only reads public data; `app.js` manages browser-local sessions and presentation. There are no dependencies or order-submission endpoints.

Built with AI assistance. Test results, assumptions and limitations are included so the claim can be checked.
