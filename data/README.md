# Historical sample and live market data

`sample.json` contains actual Coinbase Exchange completed one-minute candle closes for BTC-USD and LINK-USD. Each compact row is `[UTC close timestamp in milliseconds, BTC close, LINK close]`. Only exact timestamps observed for both assets are included: 1,648 shared observations across a 1,800-minute requested window. The 152 missing shared minutes are not filled.

The replay constructs **assumed** quotes around each candle close using the configured half-spread, 3 basis points by default (6 from bid to ask). The app overrides the file's numeric `halfSpreadBps` assumption with the configured value, but the file's descriptive `spread` text still reads 2 bps and is carried into run records unchanged. These are not archived executable bid/ask quotes. A replay quote's receipt time is simulated historical time. The model omits market impact, queue position and liquidity constraints; application fees must be disclosed separately.

`market.js` builds histories at runtime using only observations at or before each frame. Histories retain at most 300 observations. Gaps mean seven observations need not span exactly seven minutes; strategy calculations must use actual elapsed time.

Live mode requests real public Coinbase ticker bid/ask and completed one-minute candles. The ticker exchange timestamp describes the last trade, while `observedAt` and `receivedAt` describe local HTTP receipt time. The module rejects invalid prices, crossed quotes, stale or future exchange timestamps, stale history and connection errors. It never silently substitutes replay prices in live mode.

The same recent minute history is used for every horizon. Extrapolating a short recent trend to seven hours or a day is an assumption, not validated forecasting skill. Historical replay profitability is not evidence of future profitability.

Official API documentation:
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker

Public ticker and candle responses were observed returning `Access-Control-Allow-Origin: *` during implementation on October 11, 2026. This confirms the response header at that time; availability and browser connectivity can change.
