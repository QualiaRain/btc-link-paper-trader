# Historical sample and live market data

`sample.json` contains actual Coinbase Exchange completed one-minute candle closes for BTC-USD and LINK-USD. Each compact row is `[UTC close timestamp in milliseconds, BTC close, LINK close]`. Only exact timestamps observed for both assets are included: 1,648 shared observations across a 1,800-minute requested window. The 152 missing shared minutes are not filled.

The replay constructs **assumed** quotes around each candle close: a 2 basis point half-spread, or 4 basis points from bid to ask. These are not archived executable bid/ask quotes. A replay quote's receipt time is simulated historical time. The model omits market impact, queue position and liquidity constraints; application fees must be disclosed separately.

For new sample runs, `market.js` (`sampleCoverage`) computes these counts from `sample.json` and stores them as `market.dataset.coverage` per asset (`expectedCount` 1800, `observedCount` 1648, `missingCount` 152, the 152 `missingTimes`, `warmupObservedCount` = the lookback frames used as warmup). Both assets use the retained shared observations; this cannot recover each asset's independently discarded minutes. The block describes the whole bundled window including warmup, not only frames processed so far. A full date-range block has the same fields but covers the scored range with warmup outside it; backend partial range snapshots retain counts through the revealed frame without a missing-timestamp list. Python computes the identical sample block. Existing historical records without coverage remain unchanged when imported or viewed read-only and display "not recorded".

`market.js` builds histories at runtime using only observations at or before each frame. Histories retain at most 300 observations. Gaps mean seven observations need not span exactly seven minutes; strategy calculations must use actual elapsed time.

Live mode requests real public Coinbase ticker bid/ask and completed one-minute candles. The ticker exchange timestamp describes the last trade, while `observedAt` and `receivedAt` describe local HTTP receipt time. The module rejects invalid prices, crossed quotes, stale or future exchange timestamps, stale history and connection errors. It never silently substitutes replay prices in live mode.

The same recent minute history is used for every horizon. Extrapolating a short recent trend to seven hours or a day is an assumption, not validated forecasting skill. Historical replay profitability is not evidence of future profitability.

Official API documentation:
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker

Public ticker and candle responses were observed returning `Access-Control-Allow-Origin: *` during implementation on October 11, 2026. This confirms the response header at that time; availability and browser connectivity can change.
