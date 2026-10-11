// Public read-only data. No credentials, wallets or trading endpoints.
export {fetchHistoricalRange} from './replay.js';
const BASE = 'https://api.exchange.coinbase.com';
const ASSETS = ['BTC', 'LINK'];
const MINUTE = 60_000;
const HORIZONS = new Set([MINUTE, 5*MINUTE, 7*MINUTE, 15*MINUTE, 60*MINUTE, 420*MINUTE, 1440*MINUTE]);
const DOCUMENTATION = {
  ticker: 'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker',
  candles: 'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles'
};

function price(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Invalid market price');
  return number;
}

async function readJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {signal: controller.signal, credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw new Error(`Market source HTTP ${response.status}`);
    const data = await response.json();
    return {data, receivedAt: Date.now(), url: String(url)};
  } catch (error) {
    throw new Error(`Market data unavailable (${url}): ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadSample() {
  const {data} = await readJSON(new URL('./data/sample.json', import.meta.url));
  if (!Array.isArray(data.prices) || data.prices.length < 8) throw new Error('Incomplete replay sample');
  let previous = -Infinity;
  const histories = {BTC: [], LINK: []};
  const halfSpread = Number(data.assumptions.halfSpreadBps) / 10_000;
  if (!Number.isFinite(halfSpread) || halfSpread < 0 || halfSpread >= 1) throw new Error('Invalid assumed spread');
  const frames = data.prices.map(row => {
    const [time, btc, link] = row;
    if (!Number.isSafeInteger(time) || time <= previous) throw new Error('Replay times must increase');
    previous = time;
    const quotes = {};
    for (const [asset, value] of [['BTC', btc], ['LINK', link]]) {
      const mid = price(value);
      histories[asset].push({time, price: mid});
      if (histories[asset].length > 300) histories[asset].shift();
      quotes[asset] = {bid: mid*(1-halfSpread), ask: mid*(1+halfSpread), mid,
        observedAt: time, receivedAt: time, exchangeTime: time,
        source: 'Historical Coinbase candle close with ASSUMED 2 bps half-spread',
        simulatedQuote: true};
    }
    return {time, quotes, history: {BTC: histories.BTC.slice(), LINK: histories.LINK.slice()}};
  });
  return {source: data.source, capturedAt: data.capturedAt, periodStart: data.periodStart,
    periodEnd: data.periodEnd, assumptions: data.assumptions, documentation: data.documentation, frames};
}

function completedHistory(rows, receivedAt) {
  if (!Array.isArray(rows)) throw new Error('Invalid Coinbase candle response');
  const cutoff = Math.floor(receivedAt / MINUTE) * MINUTE;
  const seen = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 6) throw new Error('Invalid candle row');
    const bucket = Number(row[0])*1000;
    if (!Number.isSafeInteger(bucket) || bucket % MINUTE) throw new Error('Invalid minute bucket');
    const closeTime = bucket + MINUTE;
    if (closeTime > cutoff) continue;
    const low = price(row[1]), high = price(row[2]), open = price(row[3]), close = price(row[4]);
    if (low > Math.min(open, close) || high < Math.max(open, close)) throw new Error('Invalid candle OHLC bounds');
    if (seen.has(closeTime) && seen.get(closeTime) !== close) throw new Error('Conflicting duplicate minute');
    seen.set(closeTime, close);
  }
  const history = [...seen].sort((a,b) => a[0]-b[0]).slice(-300).map(([time, price]) => ({time, price}));
  if (history.length < 7) throw new Error('Fewer than seven completed candle observations');
  if (receivedAt-history.at(-1).time > 5*MINUTE) throw new Error('Minute history is stale');
  return history;
}

export async function fetchLiveMarket(horizonMs) {
  if (!HORIZONS.has(horizonMs)) throw new Error('Unsupported forecast horizon');
  const reads = await Promise.all(ASSETS.map(async asset => {
    const [candles, ticker] = await Promise.all([
      readJSON(`${BASE}/products/${asset}-USD/candles?granularity=60`),
      readJSON(`${BASE}/products/${asset}-USD/ticker`)
    ]);
    const exchangeTime = Date.parse(ticker.data.time);
    if (!Number.isFinite(exchangeTime)) throw new Error(`${asset}: invalid exchange timestamp`);
    const age = ticker.receivedAt-exchangeTime;
    if (age < -5000 || age > 120_000) throw new Error(`${asset}: stale or future exchange trade timestamp`);
    const bid = price(ticker.data.bid), ask = price(ticker.data.ask);
    if (bid > ask) throw new Error(`${asset}: crossed bid/ask quote`);
    return {asset, history: completedHistory(candles.data, candles.receivedAt),
      quote: {bid, ask, mid: (bid+ask)/2, observedAt: ticker.receivedAt,
        receivedAt: ticker.receivedAt, exchangeTime, exchangeTimestamp: ticker.data.time,
        lastTradePrice: price(ticker.data.price), source: 'Coinbase Exchange public ticker bid/ask',
        url: ticker.url, simulatedQuote: false},
      provenance: {candlesURL: candles.url, candlesReceivedAt: candles.receivedAt,
        tickerURL: ticker.url, tickerReceivedAt: ticker.receivedAt,
        lastTradeAgeMs: age, candleCount: candles.data.length}};
  }));
  const time = Date.now();
  const quotes = {}, history = {}, provenance = {};
  for (const item of reads) {
    quotes[item.asset] = item.quote;
    history[item.asset] = item.history.filter(point => point.time <= time);
    provenance[item.asset] = item.provenance;
  }
  return {time, quotes, history, provenance, horizonMs, source: 'Coinbase Exchange public REST',
    receivedAt: time, documentation: DOCUMENTATION,
    assumptions: {warmup: 'Up to300 completed one-minute observations for every horizon; missing minutes are not filled.',
      trend: 'The core uses seven prior observations and actual elapsed time. Scaling a short recent trend to long horizons is an assumption, not calibrated predictive evidence.',
      timestamps: 'observedAt is local HTTP receipt time. exchangeTime is last-trade event time, not a separately timestamped order-book update.',
      execution: 'Public snapshots are not executable orders. Paper fills omit latency, market impact and queue position.'}};
}
