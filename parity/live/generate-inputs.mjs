// Deterministic live-market scenarios (seeded PRNG, fixed clock). Re-run: node parity/live/generate-inputs.mjs
// 'live-fetch' cases feed canned Coinbase responses to market.js fetchLiveMarket; 'live-session' cases drive the
// app.js live flow (start, tick, order) with a canned market that moves with the clock.
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const M = 60000, T0 = Date.UTC(2024, 2, 9, 12), dir = fileURLToPath(new URL('./inputs/', import.meta.url));
mkdirSync(dir, {recursive: true});
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const write = (name, kind, scenarios) => writeFileSync(`${dir}${name}.json`, JSON.stringify({name, kind, scenarios}) + '\n');

// Candle rows [bucket start seconds, low, high, open, close, volume], newest first, like Coinbase.
function candles(seed, p0, vol, from, to) {
  const r = rng(seed), rows = []; let prev = p0;
  for (let t = from; t <= to; t += M) {
    const close = round(prev * Math.exp(vol * (r() - .5)), 4), open = prev;
    rows.push([t / 1000, round(Math.min(open, close) - 0.01, 4), round(Math.max(open, close) + 0.01, 4), open, close, 3.5]);
    prev = close;
  }
  return rows.reverse();
}
const floorMinute = t => Math.floor(t / M) * M;
const series = (seed, from, to) => ({BTC: candles(seed, 61000, .002, floorMinute(from), floorMinute(to)), LINK: candles(seed + 1, 19.2, .004, floorMinute(from), floorMinute(to))});
const latestClose = (rows, now) => rows.find(row => row[0] * 1000 + M <= floorMinute(now))[4];
function ticker(seed, rows, now, {ageMs = 800, halfBps = 2, decimals = 4} = {}) {
  const r = rng(seed), out = {};
  for (const asset of ['BTC', 'LINK']) {
    const mid = latestClose(rows[asset], now) * (1 + (r() - .5) * .0008), half = halfBps / 1e4;
    out[asset] = {trade_id: 1000 + Math.floor(r() * 1000), price: String(round(mid, decimals)), size: '0.0123',
      time: new Date(now - ageMs).toISOString().slice(0, -1) + '456Z',
      bid: String(round(mid * (1 - half), 6)), ask: String(round(mid * (1 + half), 6)), volume: '1234.5'};
  }
  return out;
}

// ---- 1. fetchLiveMarket on canned responses -----------------------------------------------------------------
{
  const now = T0 + 30 * M + 20500, base = series(10, now - 120 * M, now);
  const world = (mutate = () => {}, extra = {}) => { const w = {now, horizonMs: 420000, series: structuredClone(base), ticker: ticker(11, base, now), ...extra};
    mutate(w); return w; };
  const path = (asset, kind) => `/products/${asset}-USD/${kind === 'candles' ? 'candles?granularity=60' : 'ticker'}`;
  write('fetch-live-market', 'live-fetch', [
    {name: 'good-quote-and-history', ...world()},
    {name: 'good-one-minute-horizon-offset-timestamp', ...world(w => { for (const a of ['BTC', 'LINK']) w.ticker[a].time = new Date(now - 2500).toISOString().replace('Z', '').replace(/\.\d+$/, '') + '+00:00'; }, {horizonMs: 60000})},
    {name: 'numeric-ticker-fields-and-string-candles', ...world(w => { w.ticker.BTC.bid = 60999.5; w.ticker.BTC.ask = 61000.5; w.ticker.BTC.price = 61000; w.series.LINK = w.series.LINK.map(r => r.map(String)); })},
    {name: 'history-truncated-to-300-and-incomplete-minute-ignored', ...(() => { const long = series(12, now - 330 * M, now); return {now, horizonMs: 900000, series: long, ticker: ticker(13, long, now)}; })()},
    {name: 'duplicate-minute-with-same-close-is-fine', ...world(w => { w.series.BTC.push([...w.series.BTC[5]]); })},
    {name: 'invalid-rows-after-the-cutoff-are-ignored', ...world(w => { w.series.BTC.unshift([(floorMinute(now) + M) / 1000, -1, 'x', 0, 0, 0]); w.series.BTC.unshift([floorMinute(now) / 1000, 'bad', 1, 1, 1, 1]); })},
    {name: 'crossed-bid-ask', ...world(w => { w.ticker.LINK.bid = '19.5'; w.ticker.LINK.ask = '19.4'; })},
    {name: 'stale-ticker-trade-time', ...world(w => { w.ticker.LINK.time = new Date(now - 150000).toISOString(); })},
    {name: 'future-ticker-trade-time', ...world(w => { w.ticker.BTC.time = new Date(now + 9000).toISOString(); })},
    {name: 'unparseable-ticker-time', ...world(w => { w.ticker.BTC.time = 'last tuesday'; })},
    {name: 'zero-ask-price', ...world(w => { w.ticker.BTC.ask = '0'; })},
    {name: 'non-numeric-bid', ...world(w => { w.ticker.LINK.bid = 'n/a'; })},
    {name: 'missing-last-trade-price', ...world(w => { delete w.ticker.BTC.price; })},
    {name: 'stale-minute-history', now, horizonMs: 420000, ...(() => { const old = series(14, now - 200 * M, now - 8 * M); return {series: old, ticker: ticker(15, old, now)}; })()},
    {name: 'too-few-candles', ...world(w => { w.series.LINK = w.series.LINK.slice(0, 7); })},
    {name: 'candle-with-invalid-price', ...world(w => { w.series.BTC[10][1] = -3; })},
    {name: 'candle-ohlc-bounds-violated', ...world(w => { w.series.LINK[12][2] = 0.5; })},
    {name: 'conflicting-duplicate-minute', ...world(w => { const dup = [...w.series.BTC[8]]; dup[4] = dup[4] + 1; dup[2] = dup[2] + 1; w.series.BTC.push(dup); })},
    {name: 'candle-row-wrong-length', ...world(w => { w.series.BTC[3] = [1, 2, 3]; })},
    {name: 'candle-bucket-not-on-a-minute', ...world(w => { w.series.LINK[4][0] += 7; })},
    {name: 'candle-response-is-not-an-array', ...world(w => { w.routes = {[path('BTC', 'candles')]: {status: 200, json: {message: 'rate limited'}}}; })},
    {name: 'http-500-on-candles', ...world(w => { w.routes = {[path('LINK', 'candles')]: {status: 500, json: {message: 'boom'}}}; })},
    {name: 'http-404-on-ticker', ...world(w => { w.routes = {[path('BTC', 'ticker')]: {status: 404, json: {message: 'NotFound'}}}; })},
    {name: 'ticker-body-is-not-json', ...world(w => { w.routes = {[path('LINK', 'ticker')]: {status: 200, text: '<html>maintenance</html>'}}; }, {invalidJson: true})},
    {name: 'unsupported-horizon', ...world(() => {}, {horizonMs: 120000})},
  ]);
}

// ---- 2. live sessions ------------------------------------------------------------------------------------------
{
  const open = T0 + 25 * M + 1200, horizon = {horizonMs: 60000, lookbackIntervals: 3};
  const build = (name, seed, config, plan, extra = {}) => {
    const last = Math.max(open, ...plan.map(p => p.now)), rows = series(seed, open - 100 * M, last + 30000);
    const tk = (now, i, o = {}) => ticker(seed * 100 + i, rows, now, o);
    return {name, settings: {config: {mode: 'live', ...horizon, ...config}}, series: rows, open: {now: open, ticker: tk(open, 0)},
      steps: plan.map((p, i) => { const {fail, tickerOpts, ...rest} = p; return {...rest, ticker: tk(p.now, i + 1, tickerOpts), ...(fail ? {routes: fail} : {})}; }), ...extra};
  };
  const t = (sec, extra = {}) => ({op: 'tick', now: open + sec * 1000, ...extra});
  const o = (sec, asset, side, dollars, extra = {}) => ({op: 'order', now: open + sec * 1000, asset, side, ...(dollars === undefined ? {} : {dollars}), ...extra});
  const down = (asset, kind) => ({[`/products/${asset}-USD/${kind === 'candles' ? 'candles?granularity=60' : 'ticker'}`]: {status: 500, json: {message: 'unavailable'}}});

  // Ticks at 20 s, a four-minute gap (a gap event: no fills invented), then to completion at the 15 minute duration.
  const gapPlan = [20, 40, 60, 80, 100, 120, 140, 360, 380, 400, 420, 460, 520, 580, 640, 700, 760, 820, 880, 899, 905, 960].map(s => t(s));
  gapPlan.push(t(1000), o(1010, 'BTC', 'buy', 100), o(1020, 'LINK', 'sell'));
  write('live-sessions', 'live-session', [
    build('ticks-gap-and-completion-at-duration', 40, {durationMs: 900000}, gapPlan, {fullAccount: true}),
    build('manual-orders-ingest-a-fresh-frame-then-trade', 41, {durationMs: 1800000, allocationFraction: 0.25}, [
      o(10, 'BTC', 'buy', 100), t(30), o(45, 'LINK', 'buy', 60), o(50, 'BTC', 'sell', 40), o(52, 'BTC', 'sell'), o(54, 'BTC', 'sell'),
      t(70), o(80, 'LINK', 'buy', 30), o(85, 'LINK', 'buy'), o(86, 'LINK', 'buy', 0), o(90, 'LINK', 'sell', 10), o(95, 'LINK', 'sell'), t(130), t(190)]),
    build('stop-loss-after-manual-buys', 42, {durationMs: 1800000, stopLossBps: 6, allocationFraction: 0, feeBps: 15, slippageBps: 4}, [
      o(5, 'BTC', 'buy', 120), o(8, 'LINK', 'buy', 120), t(25), t(50), o(60, 'BTC', 'buy', 100), t(80), t(110), t(140)], {fullAccount: true}),
    build('failed-reads-change-nothing', 43, {durationMs: 1800000}, [
      t(20), t(40, {fail: down('BTC', 'candles')}), t(50, {fail: {...down('LINK', 'ticker')}}),
      o(55, 'BTC', 'buy', 100, {fail: down('BTC', 'ticker')}), t(60, {tickerOpts: {halfBps: 2, ageMs: 130000}}),
      o(70, 'BTC', 'buy', 100), t(80), t(100, {fail: down('LINK', 'candles')}), t(120)]),
    build('same-price-model-five-minute-horizon', 44, {durationMs: 600000, model: 'same-price', horizonMs: 300000}, [
      t(60), t(150), t(240), t(330), o(340, 'LINK', 'buy', 50), t(420), t(500), t(590), t(601), t(700), o(710, 'LINK', 'sell')]),
    {name: 'opening-fetch-fails-no-session', settings: {config: {mode: 'live', ...horizon}}, series: series(45, open - 100 * M, open + M),
      open: {now: open, ticker: ticker(4500, series(45, open - 100 * M, open + M), open), routes: down('LINK', 'ticker')}, steps: []},
  ]);
}
console.log('live inputs written to', dir);
