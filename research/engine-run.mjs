// The answer sheet: one window run through the REAL engine. Simulated cash only.
//
// Frames are built the way replay.js fetchHistoricalRange builds them after retrieval (per-asset rows kept from
// scoreStart - warmupMinutes, the causal-warmup refusal, shared minutes as frames, a lazy history view of the last
// lookback+1 rows) and ingested the way app.js start()/replayWork and backend replay.py run_replay do. This file
// reads only scoreStart, scoreEnd and the shared count from the prepared window; it rebuilds frames from the
// market itself, so it also checks the frame indexing that research/fastsim.mjs takes from prepareWindow.
// PROTOCOL.md Readings 1 and 2: the window is run as if the app replayed [first shared minute, last shared minute].
//
// Family P is the engine as it is. Families R, X and L only change which prices the forecast sees, so they are
// emulated by handing the unmodified engine a crafted frame.history ("R, X and L by feeding it the history their
// rule reads", PROTOCOL.md, Simulation):
//   reversal      - the same rows with each price replaced by K/price (K = 1): log(last/past) flips sign.
//   btcLed        - LINK's rows replaced by BTC's rows at that frame; quotes (anchor, fills) stay LINK's.
//   long lookback - lookbackIntervals 1 with the two rows [past, last], or [last] alone when the rule says skip
//                   (one row is fewer than lookbackIntervals + 1, which the engine skips as insufficient history).
// Where emulation could differ from a native implementation:
//   - reversal: log((K/last)/(K/past)) is -log(last/past) only up to rounding (a verifier measured at most 3.6e-16
//     absolute on tick-rounded prices), so the emulated drift can differ from the native -drift in its last bits.
//     That can only matter for a comparison sitting exactly on a threshold (the buy test, the +-3% clip, the
//     flat-direction epsilon); the verifier built two such cases (a buffer chosen to the last digit, and prices one
//     ulp apart) in which the emulation makes no buy where the native rule buys. Zero drift and clipped drift are
//     exact either way. No ledger arithmetic depends on the forecast value itself. A fills mismatch on a reversal
//     run is therefore first a question about this emulation, not about the simulator.
//   - btcLed: drift arithmetic is identical. Reading 4: "BTC's forecast is unavailable" is BTC's history being
//     insufficient; a BTC stop on the same frame does not skip LINK; the app's warmup refusal is still applied
//     to both assets' own series, although LINK's history is then unused.
//   - long lookback: drift arithmetic is identical. The app's warmup rule and refusal are not applied (Reading 1;
//     the protocol lets history reach back before the window); the engine config records lookbackIntervals 1.
//     Reading 5: a past observation exactly 60 minutes older than wanted is used.
// holdThrough changes trading, not the forecast, and cannot be emulated this way. It runs only on an engine passed
// in by the caller: research/holdthrough-oracle.mjs loadHoldThroughEngine(), "the same engine with only its
// scheduled-decision branch replaced" (PROTOCOL.md, Simulation). The frames are the same whichever engine runs.
import {fileURLToPath} from 'node:url';
import {MINUTE, ASSETS, lowerBound} from './windows.mjs';

// The reference engine and the file it was loaded from, kept as one URL so that the path a caller hashes is the
// module that ran.
const ENGINE_URL = new URL('../engine.js', import.meta.url);
export const ENGINE_FILE = fileURLToPath(ENGINE_URL);
const UNMODIFIED = await import(ENGINE_URL.href);

const FIXED = ['maxQuoteAgeMs', 'maxOutcomeLatenessMs', 'maxDrawdownBps', 'dailyLossBps', 'cashYieldBps'];
const RECIPROCAL = 1;   // K in price -> K/price

// engine = {createAccount, ingest, getSummary} replaces the unmodified engine. A holdThrough setting needs one (the
// hold-through oracle), because the engine passed in IS the trading rule: setting.holdThrough itself changes
// nothing here. Without an override, or with the unmodified engine's own ingest passed back in, it throws. The
// reverse pairing cannot be checked here: an engine that holds through does so whatever the setting says, so the
// caller passes it for hold-through settings only.
export function runEngine(market, prepared, setting, costs, {engine} = {}) {
  for (const key of FIXED)
    if (setting[key] !== undefined || costs[key] !== undefined) throw new Error(`${key} is fixed by the protocol and cannot be set`);
  const {horizonMs, bufferBps, stopLossBps, holdThrough = false, reversal = false, btcLed = false,
    allocationFraction = 0.5, initialCash = 1000} = setting;
  const lookback = setting.lookback ?? undefined, spanMs = setting.spanMs ?? undefined;   // null means not given
  const {feeBps, slippageBps, halfSpreadBps} = costs;
  if (engine != null && !['createAccount', 'ingest', 'getSummary'].every(name => typeof engine[name] === 'function'))
    throw new Error('engine must be {createAccount, ingest, getSummary}');
  const {createAccount, ingest, getSummary} = engine ?? UNMODIFIED;
  if (holdThrough && ingest === UNMODIFIED.ingest)
    throw new Error('holdThrough is not supported by runEngine on the unmodified engine: it changes trading and needs ' +
      'its own oracle. Pass {engine} from research/holdthrough-oracle.mjs loadHoldThroughEngine()');
  if ((lookback === undefined) === (spanMs === undefined)) throw new Error('Give exactly one of lookback or spanMs');
  if (spanMs !== undefined && (!Number.isSafeInteger(spanMs) || spanMs <= 0)) throw new Error('spanMs must be a positive integer');
  if (typeof halfSpreadBps !== 'number' || !Number.isFinite(halfSpreadBps) || halfSpreadBps < 0 || halfSpreadBps > 1000)
    throw new Error('Invalid assumed half-spread');   // replay.js
  // The 90% coverage floor (prepared.valid) is the caller's window-level check; a run only needs two frames.
  if (prepared.shared < 2) return {valid: false, invalidReason: 'fewer than 2 shared minutes'};

  const s = prepared.scoreStart, e = prepared.scoreEnd, long = spanMs !== undefined;
  const lookbackIntervals = long ? 1 : lookback;
  // app.js start(): what a range replay asks of fetchHistoricalRange.
  const warmupMinutes = Math.max(60, 2 * lookbackIntervals + 10), historyLimit = lookbackIntervals + 1;
  const requiredHistory = lookbackIntervals + 1;
  // replay.js keeps rows with first <= time <= e. Long lookback instead keeps whatever the series has back to the
  // oldest row the rule could ever accept for this window (span plus the 60-minute tolerance before scoreStart).
  const first = long ? s - spanMs - 60 * MINUTE : s - warmupMinutes * MINUTE;
  const series = {}, clock = {};
  for (const asset of ASSETS) {
    const {time, close} = market[asset], from = lowerBound(time, first), to = lowerBound(time, e + 1);
    series[asset] = Array.from({length: to - from}, (_, i) => ({time: time[from + i], price: close[from + i]}));
    clock[asset] = time.subarray(from, to);
  }
  if (!long) for (const asset of ASSETS) {
    // replay.js: refuse unless requiredHistory causal observations exist at the scored start. No run is created.
    const available = series[asset].filter(row => row.time <= s).length;
    if (available < requiredHistory) return {valid: false, invalidReason: 'insufficient warmup'};
  }

  const rows = (asset, indices, time) => {
    const source = btcLed ? 'BTC' : asset, at = indices[source];
    let view;
    if (!long) view = series[source].slice(Math.max(0, at - historyLimit + 1), at + 1);   // replay.js, verbatim
    else {
      const wanted = time - spanMs, past = lowerBound(clock[source], wanted + 1) - 1;
      const usable = past >= 0 && wanted - clock[source][past] <= 60 * MINUTE;
      view = usable ? [series[source][past], series[source][at]] : [series[source][at]];
    }
    return reversal ? view.map(row => ({time: row.time, price: RECIPROCAL / row.price})) : view;
  };

  // replay.js frame construction: BTC rows inside [s, e] whose timestamp LINK also has; assumed quotes around the
  // close; history exposed as a lazy getter.
  const maps = Object.fromEntries(ASSETS.map(a => [a, new Map(series[a].map((r, i) => [r.time, i]))]));
  const frames = [], half = halfSpreadBps / 10000;
  for (const row of series.BTC) {
    if (row.time < s || row.time > e || !maps.LINK.has(row.time)) continue;
    const indices = {BTC: maps.BTC.get(row.time), LINK: maps.LINK.get(row.time)}, quotes = {};
    for (const a of ASSETS) {
      const mid = series[a][indices[a]].price;
      quotes[a] = {bid: mid * (1 - half), ask: mid * (1 + half), mid, observedAt: row.time,
        source: `Historical Coinbase close with ASSUMED ${halfSpreadBps} bps half-spread`, simulatedQuote: true};
    }
    const frame = {time: row.time, quotes};
    Object.defineProperty(frame, 'history', {enumerable: true,
      get: () => Object.fromEntries(ASSETS.map(a => [a, rows(a, indices, row.time)]))});
    frames.push(frame);
  }
  // app.js start() / replay.py run_replay: exact scored boundaries, and the scored span becomes the duration.
  if (!frames.length || frames[0].time !== s || frames.at(-1).time !== e)
    throw new Error('Prepared window does not match the market: scored boundary frames are missing');
  const account = createAccount({initialCash, horizonMs, feeBps, slippageBps, bufferBps, model: 'trend', mode: 'replay',
    durationMs: e - s, maxQuoteAgeMs: 60000, maxOutcomeLatenessMs: 30000, lookbackIntervals, allocationFraction,
    stopLossBps, maxDrawdownBps: 0, dailyLossBps: 0, cashYieldBps: 0});
  const held = {BTC: 0, LINK: 0};
  for (const frame of frames) {
    ingest(account, frame);
    for (const a of ASSETS) if (account.positions[a].qty > 0) held[a]++;
    if (account.status === 'completed') break;
  }

  const summary = getSummary(account), ledger = account.ledger;
  const trades = ledger.filter(ev => ev.type === 'trade' && ev.actor !== 'benchmark');
  // Every scheduled decision frame leaves one 'decision' or 'decision_skipped' event per asset.
  const decisionFrames = new Set(ledger.filter(ev => ev.type === 'decision' || ev.type === 'decision_skipped').map(ev => ev.time));
  const perAsset = Object.fromEntries(ASSETS.map(a => {
    const forecasts = account.forecasts.filter(f => f.asset === a), counts = summary.perAsset[a];
    return [a, {forecasts: forecasts.length, settled: counts.count,
      expired: forecasts.filter(f => f.status === 'expired').length, directionHits: counts.directionHits,
      directionMisses: counts.directionMisses, directionFlat: counts.directionFlat,
      buys: trades.filter(t => t.asset === a && t.side === 'buy').length}];
  }));
  return {valid: true, invalidReason: null, finalValue: summary.equity, returnPct: summary.returnPct,
    buyHoldValue: summary.buyHoldEquity, buyHoldReturnPct: summary.buyHoldReturnPct, fills: summary.tradeCount,
    fees: summary.fees, stops: ledger.filter(ev => ev.type === 'stop_loss').length, decisions: decisionFrames.size,
    perAsset, maxDrawdownPct: summary.maxDrawdownPct,
    exposure: {BTC: held.BTC / frames.length, LINK: held.LINK / frames.length}};
}
