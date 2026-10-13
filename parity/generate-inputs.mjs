// Deterministic parity inputs (seeded PRNG, no clock). Re-run: node parity/generate-inputs.mjs
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const M = 60000, T0 = Date.UTC(2024, 0, 2), dir = fileURLToPath(new URL('./inputs/', import.meta.url));
mkdirSync(dir, {recursive: true});
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// Prices are rounded so the JSON is stable and human-readable.
function walk(seed, n, start, vol, drift = 0) { const r = rng(seed); const out = [start];
  for (let i = 1; i < n; i++) out.push(Math.round(out.at(-1) * Math.exp(drift + vol * (r() - .5)) * 1e4) / 1e4); return out; }
const quote = (mid, time, halfBps = 2, extra = {}) => ({mid, bid: Math.round(mid * (1 - halfBps / 1e4) * 1e6) / 1e6,
  ask: Math.round(mid * (1 + halfBps / 1e4) * 1e6) / 1e6, observedAt: time, source: 'parity fixture', ...extra});
function frames(btc, link, {step = M, histLen = 8, t0 = T0, spread = 2} = {}) {
  return btc.map((b, i) => { const time = t0 + i * step;
    const hist = (series) => series.slice(Math.max(0, i - histLen + 1), i + 1).map((price, j, a) => ({time: time - (a.length - 1 - j) * step, price}));
    return {time, quotes: {BTC: quote(b, time, spread), LINK: quote(link[i], time, spread)}, history: {BTC: hist(btc), LINK: hist(link)}}; });
}
const ingestAll = fs => fs.map(frame => ({op: 'ingest', frame}));
const write = (name, kind, scenarios) => writeFileSync(`${dir}${name}.json`, JSON.stringify({name, kind, scenarios}) + '\n');

// 1. Chronology: duplicates, out-of-order, same-time-different-price frames, gaps, completion and post-completion settlement.
{
  const btc = walk(11, 40, 42000, .004, .0004), link = walk(12, 40, 18.5, .008, .0003);
  const base = frames(btc, link);
  const messy = [...base.slice(0, 10), structuredClone(base[9]), structuredClone(base[5]),
    {...structuredClone(base[10]), quotes: {BTC: quote(1, base[10].time), LINK: quote(1, base[10].time)}}, // duplicate time, ignored
    ...base.slice(10, 16), ...base.slice(23, 40)]; // 7-minute gap in the middle
  write('chronology', 'account', [
    {name: 'clean-run', config: {horizonMs: 300000, lookbackIntervals: 3, durationMs: 30 * M, mode: 'replay'}, steps: ingestAll(base)},
    {name: 'duplicates-out-of-order-and-gap', config: {horizonMs: 300000, lookbackIntervals: 3, durationMs: 30 * M}, steps: ingestAll(messy)},
    {name: 'default-horizon-same-price', config: {model: 'same-price', durationMs: 25 * M}, steps: ingestAll(base)},
    {name: 'live-gap-event', config: {mode: 'live', horizonMs: 300000, lookbackIntervals: 3, durationMs: 60 * M}, steps: ingestAll(messy)},
  ]);
}
// 2. Missing / invalid quotes and forecast expiry.
{
  const btc = walk(21, 30, 40000, .003, .0005), link = walk(22, 30, 17, .006, .0004), base = frames(btc, link);
  const damaged = base.map((f, i) => { const g = structuredClone(f);
    if (i === 4) delete g.quotes.LINK;
    if (i === 6) g.quotes.BTC.observedAt = g.time - 120000;           // stale
    if (i === 8) { g.quotes.LINK.bid = g.quotes.LINK.ask + 1; }        // crossed
    if (i === 10) g.quotes.BTC.observedAt = g.time + 1000;            // future
    if (i === 12) g.quotes.LINK.mid = g.quotes.LINK.ask + 1;          // mid outside spread
    if (i === 14) g.quotes = null;                                     // absent
    if (i === 16) g.quotes.BTC.bid = 0;                                // non-positive bid
    return g; });
  // Quote ages alternate between inside and outside a 10 s limit.
  const late = base.map((f, i) => { const g = structuredClone(f);
    for (const a of ['BTC', 'LINK']) g.quotes[a].observedAt = g.time - (i % 2 ? 5000 : 15000); return g; });
  // Irregular spacing: some targets are first observed 20-25 s late (settle), others 45 s late (expire).
  const lateFrames = base.map((f, i) => { const g = structuredClone(f); g.time = f.time + [0, 20000, 45000][i % 3];
    for (const a of ['BTC', 'LINK']) g.quotes[a].observedAt = g.time; return g; });
  // Boundaries: quote age exactly at / 1 ms past the limit; outcome lateness exactly at / 1 ms past the tolerance.
  const aged = ageMs => base.slice(0, 12).map(f => { const g = structuredClone(f); for (const a of ['BTC', 'LINK']) g.quotes[a].observedAt = g.time - ageMs; return g; });
  // Frames from index 4 onward arrive lateMs after their nominal minute, so the first forecast target is observed late.
  const delayed = lateMs => base.slice(0, 14).map((f, i) => { const g = structuredClone(f); if (i >= 4) g.time = f.time + lateMs;
    for (const a of ['BTC', 'LINK']) g.quotes[a].observedAt = g.time; return g; });
  write('missing-quotes', 'account', [
    {name: 'quote-age-exactly-at-limit', config: {horizonMs: 120000, lookbackIntervals: 2, maxQuoteAgeMs: 20000, durationMs: 11 * M}, steps: ingestAll(aged(20000))},
    {name: 'quote-age-one-ms-past-limit', config: {horizonMs: 120000, lookbackIntervals: 2, maxQuoteAgeMs: 20000, durationMs: 11 * M}, steps: ingestAll(aged(20001))},
    {name: 'outcome-lateness-exactly-at-tolerance', config: {horizonMs: 120000, lookbackIntervals: 2, maxOutcomeLatenessMs: 30000, durationMs: 13 * M}, steps: ingestAll(delayed(30000))},
    {name: 'outcome-lateness-one-ms-past-tolerance', config: {horizonMs: 120000, lookbackIntervals: 2, maxOutcomeLatenessMs: 30000, durationMs: 13 * M}, steps: ingestAll(delayed(30001))},
    {name: 'damaged-frames-recorded-as-invalid', config: {horizonMs: 300000, lookbackIntervals: 3, durationMs: 40 * M}, steps: ingestAll(damaged)},
    {name: 'invalid-frame-time-throws', config: {durationMs: 20 * M}, steps: [{op: 'ingest', frame: base[0]}, {op: 'ingest', frame: {quotes: base[1].quotes}}, {op: 'ingest', frame: null}, {op: 'ingest', frame: {time: 'x'}}]},
    {name: 'outcomes-observed-late-expire', config: {horizonMs: 60000, lookbackIntervals: 2, durationMs: 20 * M, maxOutcomeLatenessMs: 30000}, steps: ingestAll(lateFrames)},
    {name: 'quote-age-limit', config: {horizonMs: 60000, lookbackIntervals: 2, maxQuoteAgeMs: 10000, durationMs: 10 * M}, steps: ingestAll(late)},
  ]);
}
// 3. Warmup: insufficient, conflicting, future, unsorted, stale, sparse and non-positive history rows.
{
  const T = T0 + 600 * M, hist = (rows, t) => rows.map(([dt, price]) => ({time: t + dt * M, price}));
  const asset = (h) => ({BTC: h, LINK: h});
  const mk = (time, h, price = 100) => ({time, quotes: {BTC: quote(price, time), LINK: quote(price, time)}, history: asset(h)});
  const six = hist([[-5, 100], [-4, 101], [-3, 102], [-2, 103], [-1, 104], [0, 105]], T);
  const seven = hist([[-6, 100], [-5, 101], [-4, 102], [-3, 103], [-2, 104], [-1, 105], [0, 106]], T);
  const eight = hist([[-7, 100], [-6, 101], [-5, 102], [-4, 103], [-3, 104], [-2, 105], [-1, 106], [0, 107]], T);
  const decide = (name, config, h, price) => ({name, config: {horizonMs: 60000, durationMs: 10 * M, ...config}, steps: [{op: 'ingest', frame: mk(T, h, price)}]});
  write('warmup', 'account', [
    decide('exactly-lookback-plus-one', {lookbackIntervals: 7}, eight, 107),
    decide('one-short-stays-cash', {lookbackIntervals: 7}, seven, 106),
    decide('lookback-1', {lookbackIntervals: 1}, six, 105),
    decide('conflicting-duplicate-timestamps', {lookbackIntervals: 3}, [...eight, {time: T - M, price: 999}], 107),
    decide('identical-duplicate-timestamps-allowed', {lookbackIntervals: 3}, [...eight, {time: T - M, price: 106}], 107),
    decide('future-rows-ignored', {lookbackIntervals: 3}, [...eight, {time: T + M, price: 1e9}], 107),
    decide('unsorted-history', {lookbackIntervals: 3}, [...eight].reverse(), 107),
    decide('stale-last-observation', {lookbackIntervals: 3}, eight.map(r => ({...r, time: r.time - 3 * M})), 107),
    decide('sparse-history-uses-elapsed-time', {lookbackIntervals: 3}, hist([[-14, 100], [-10, 101], [-6, 102], [-3, 103], [-1, 104], [0, 105]], T), 105),
    decide('bad-rows-skipped', {lookbackIntervals: 3}, [{time: T - 9 * M, price: -5}, {time: null, price: 5}, {time: T - 8 * M, price: 0}, ...eight], 107),
    decide('clipped-drift-down', {lookbackIntervals: 2, horizonMs: 86400000, durationMs: 2 * 86400000}, hist([[-2, 100], [-1, 90], [0, 50]], T), 50),
    decide('clipped-drift-up', {lookbackIntervals: 2, horizonMs: 86400000, durationMs: 2 * 86400000}, hist([[-2, 100], [-1, 110], [0, 200]], T), 200),
    // History staleness limit is max(120000, maxQuoteAgeMs): exactly at the limit is allowed, 1 ms beyond is not.
    decide('history-exactly-120000ms-old-allowed', {lookbackIntervals: 3}, eight.map(r => ({...r, time: r.time - 120000})), 107),
    decide('history-120001ms-old-rejected', {lookbackIntervals: 3}, eight.map(r => ({...r, time: r.time - 120001})), 107),
    decide('quote-age-limit-widens-history-limit', {lookbackIntervals: 3, maxQuoteAgeMs: 300000}, eight.map(r => ({...r, time: r.time - 200000})), 107),
    decide('same-price-needs-no-history', {model: 'same-price'}, [], 100),
    decide('missing-history-key', {lookbackIntervals: 3}, undefined, 100),
  ]);
}
// 4. Fees, slippage, buffers and allocation.
{
  const btc = walk(41, 36, 60000, .006, .0012), link = walk(42, 36, 22, .01, .001), base = frames(btc, link);
  const run = (name, config) => ({name, config: {horizonMs: 300000, lookbackIntervals: 3, durationMs: 33 * M, ...config}, steps: ingestAll(base)});
  write('fees-slippage', 'account', [
    run('defaults', {}),
    run('zero-costs-zero-buffer', {feeBps: 0, slippageBps: 0, bufferBps: 0}),
    run('high-costs-block-entries', {feeBps: 500, slippageBps: 300, bufferBps: 50}),
    run('extreme-valid-costs', {feeBps: 999.99, slippageBps: 999, bufferBps: 0}),
    run('wide-spread', {feeBps: 10, slippageBps: 2, bufferBps: 0}),
    run('quarter-allocation-custom-cash', {initialCash: 2500, allocationFraction: .25}),
    run('zero-allocation', {allocationFraction: 0}),
    run('max-allocation-large-buffer', {allocationFraction: .5, bufferBps: 1000}),
    {name: 'invalid-fee-throws', config: {feeBps: 10000}, steps: []},
    {name: 'unknown-field-throws', config: {feeBp: 10}, steps: []},
    {name: 'string-number-throws', config: {initialCash: '1000'}, steps: []},
    {name: 'lookback-non-integer-throws', config: {lookbackIntervals: 2.5}, steps: []},
    {name: 'spread-wide-frames', config: {horizonMs: 300000, lookbackIntervals: 3, durationMs: 33 * M, bufferBps: 0}, steps: ingestAll(frames(btc, link, {spread: 40}))},
  ]);
}
// 5. Positions: manual trades, stop loss, completion, ownership rules.
{
  const up = walk(51, 30, 50000, .002, .001), upL = walk(52, 30, 20, .003, .0008), base = frames(up, upL);
  const crash = frames([...up.slice(0, 12), ...up.slice(12).map(p => p * .9)], upL);
  const f = (i) => structuredClone(base[i]);
  write('positions', 'account', [
    {name: 'manual-buy-sell-round-trip', config: {model: 'same-price', durationMs: 20 * M}, steps: [
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 100, frame: f(0)}, {op: 'manual', asset: 'LINK', side: 'buy', dollars: 1e9, frame: f(1)},
      {op: 'manual', asset: 'LINK', side: 'sell', dollars: 50, frame: f(2)}, {op: 'manual', asset: 'BTC', side: 'sell', dollars: 1e12, frame: f(3)},
      {op: 'manual', asset: 'BTC', side: 'sell', dollars: 10, frame: f(3)}]},
    {name: 'manual-validation-errors', config: {model: 'same-price', durationMs: 5 * M}, steps: [
      {op: 'manual', asset: 'DOGE', side: 'buy', dollars: 10, frame: f(0)}, {op: 'manual', asset: 'BTC', side: 'hold', dollars: 10, frame: f(0)},
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: -1, frame: f(0)}, {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: {time: base[0].time, quotes: null}},
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: f(2)}, {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: f(1)},
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: f(6)}, {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: f(7)}]},
    {name: 'manual-after-automatic-decisions', config: {horizonMs: 300000, lookbackIntervals: 3, bufferBps: 0, durationMs: 25 * M}, steps: [
      ...ingestAll(base.slice(0, 8)), {op: 'manual', asset: 'BTC', side: 'buy', dollars: 40, frame: f(8)}, {op: 'manual', asset: 'LINK', side: 'sell', dollars: 1e9, frame: f(8)},
      ...ingestAll(base.slice(9, 30))]},
    {name: 'stop-loss-breach-and-no-reentry', config: {horizonMs: 300000, lookbackIntervals: 3, bufferBps: 0, stopLossBps: 150, durationMs: 29 * M}, steps: [
      ...ingestAll(crash.slice(0, 13)), {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: crash[13]}, ...ingestAll(crash.slice(14))]},
    {name: 'stop-loss-manual-reentry-same-frame', config: {model: 'same-price', stopLossBps: 100, durationMs: 29 * M}, steps: [
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 400, frame: crash[0]}, ...ingestAll(crash.slice(1, 12)),
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: crash[12]}, {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: crash[13]}]},
    {name: 'completion-closes-positions-and-late-settlement', config: {horizonMs: 300000, lookbackIntervals: 3, bufferBps: 0, durationMs: 12 * M}, steps: [
      ...ingestAll(base.slice(0, 14)), ...ingestAll(base.slice(14, 20)), {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: base[21]}]},
    {name: 'final-forecast-settles-after-completion', config: {horizonMs: 300000, lookbackIntervals: 3, bufferBps: 0, durationMs: 10 * M}, steps: ingestAll([...base.slice(0, 11), {...structuredClone(base[16]), time: base[16].time}])},
  ]);
}
// 6. Settings normalization (exact messages). Dates are fixed in the past or far future.
{
  const range = (start, end, extra = {}) => ({config: {horizonMs: 60000}, replay: {source: 'range', start, end, ...extra}});
  write('settings', 'settings', [{name: 'normalize', inputs: [
    {config: {}}, {config: {mode: 'replay'}}, {config: {mode: 'live'}}, {config: {mode: null, initialCash: 2500}},
    {config: {initialCash: 2500, horizonMs: 300000, model: 'trend', lookbackIntervals: 23, bufferBps: 42, allocationFraction: .3,
      stopLossBps: 180, feeBps: 12, slippageBps: 5, durationMs: 7200000, maxQuoteAgeMs: 60000, maxOutcomeLatenessMs: 30000},
      replay: {source: 'range', start: '2024-03-09T12:00', end: '2024-03-09T13:00', halfSpreadBps: 3.5}},
    {account: {config: {horizonMs: 900000, feeBps: 20}}}, {market: {settings: {replay: {source: 'sample', halfSpreadBps: 7}}}, config: {}},
    {config: {}, replay: {halfSpreadBps: 0}}, {config: {}, replay: {halfSpreadBps: 1000}},
    {config: {lookbackIntervals: 5.0}},
    null, [], 'text', {}, {config: null}, {config: []}, {config: 5}, {account: {}},
    {config: {lookbackInterval: 20}}, {config: {initialCash: '1000'}}, {config: {initialCash: 0}}, {config: {initialCash: 1e9 + 1}},
    {config: {allocationFraction: .51}}, {config: {allocationFraction: -.1}}, {config: {lookbackIntervals: 1.5}}, {config: {lookbackIntervals: 241}},
    {config: {lookbackIntervals: 0}}, {config: {horizonMs: 1234}}, {config: {horizonMs: 86400000 * 32}}, {config: {model: 'magic'}},
    {config: {stopLossBps: 10000}}, {config: {feeBps: -1}}, {config: {slippageBps: 1000.5}}, {config: {bufferBps: 1001}},
    {config: {maxOutcomeLatenessMs: -1}}, {config: {maxOutcomeLatenessMs: 0}}, {config: {durationMs: 366 * 86400000 + 1}}, {config: {maxQuoteAgeMs: 0}},
    {config: {initialCash: true}}, {config: {initialCash: null}},
    {config: {}, replay: {halfSpreadBps: -1}}, {config: {}, replay: {halfSpreadBps: 1001}}, {config: {}, replay: {halfSpreadBps: '2'}},
    {config: {}, replay: {source: 'live'}}, {config: {}, replay: {start: 5}}, {config: {}, replay: {end: 7}}, {config: {}, replay: 'x'},
    range('2024-03-09T12:00', '2024-03-09T13:00'), range('2024-03-09T13:00', '2024-03-09T12:00'), range('2024-03-09T12:00', '2024-03-09T12:00'),
    range('2024-01-01T00:00', '2024-02-01T00:00'), range('2024-01-01T00:00', '2024-02-01T00:01'),
    range('2999-01-01T00:00', '2999-01-02T00:00'), range('2026-02-30T12:00', '2026-03-01T12:00'), range('2024-03-09T12:30Z', '2024-03-09T13:00'),
    range('2024-03-09T12:30:00', '2024-03-09T13:00'), range('2024-03-09T12:30-04:00', '2024-03-09T13:00'), range('', ''), range(undefined, undefined),
    range('2024-13-09T12:00', '2024-13-09T13:00'), range('2024-03-09T24:00', '2024-03-10T01:00'), range('2024-03-09T12:60', '2024-03-10T01:00'),
    range('2024-02-29T23:59', '2024-03-01T00:30'), range('2023-02-29T23:59', '2023-03-01T00:30'),
    // Account risk limits and cash yield: valid extremes, one past each bound, wrong types.
    {config: {maxDrawdownBps: 2500, dailyLossBps: 300, cashYieldBps: 450}}, {config: {maxDrawdownBps: 9999, dailyLossBps: 9999, cashYieldBps: 2000}},
    {config: {maxDrawdownBps: 10000}}, {config: {maxDrawdownBps: -1}}, {config: {dailyLossBps: 9999.5}}, {config: {dailyLossBps: null}},
    {config: {cashYieldBps: 2000.5}}, {config: {cashYieldBps: -0.01}}, {config: {cashYieldBps: '100'}}, {config: {maxDrawdownBps: true}},
    {account: {config: {maxDrawdownBps: 75, cashYieldBps: 12.5}}},
  ]}]);
}
// 7. Canonical JSON / evidence hashing.
write('canonical', 'canonical', [{name: 'values', values: [
  null, true, false, 0, -0, 1, -1, 1.5, 100, 1e21, 1e-7, 1e-6, 123456789012345680000, 0.1 + 0.2, 5e-324, 1.7976931348623157e308,
  123456.789e-10, 4503599627370496.5, 1e300, -2.5e-9, 'text', 'quote " back \\ slash\nnewline\ttab', '  unicode ✓ 𝒳', '',
  [], {}, [1, [2, [3]]], {b: 1, a: {d: 2, c: [3, null]}}, {'𝒳': 1, 'ｚ': 2, a: 3, 'é': 4, Z: 5, '': 6},
  {qty: 8.123456789012345e-7, price: 82723.36, list: [1e-7, 1e21, 0.000001]},
]}]);
// 8. Bundled-sample replays through the same pipeline the browser uses.
write('sample-replay', 'sample-replay', [
  {name: 'defaults', settings: {config: {}}},
  {name: 'lookback-20-fifteen-minute-horizon', settings: {config: {lookbackIntervals: 20, horizonMs: 900000}, replay: {halfSpreadBps: 3.5}}},
  {name: 'same-price-model', settings: {config: {model: 'same-price', initialCash: 1000}}},
  {name: 'costly-with-stop-loss', settings: {config: {feeBps: 25, slippageBps: 10, bufferBps: 5, stopLossBps: 120, allocationFraction: .4, horizonMs: 3600000}, replay: {halfSpreadBps: 6}}},
  {name: 'one-minute-horizon-lookback-1', settings: {config: {horizonMs: 60000, lookbackIntervals: 1, bufferBps: 0}}},
  {name: 'day-horizon-max-lookback', settings: {config: {horizonMs: 86400000, lookbackIntervals: 240}}},
  {name: 'risk-limits-and-cash-yield', settings: {config: {maxDrawdownBps: 40, dailyLossBps: 25, cashYieldBps: 2000, bufferBps: 0, horizonMs: 300000}}},
  {name: 'cash-yield-only', settings: {config: {cashYieldBps: 500, horizonMs: 3600000, lookbackIntervals: 20}}},
]);
// 9. Date-range replays: gaps, per-asset causal warmup, missing boundaries.
{
  const start = Date.UTC(2024, 2, 9, 12), end = start + 90 * M, ts = (a, b) => { const r = []; for (let t = a; t <= b; t += M) r.push(t); return r; };
  const series = (seed, p0, vol, drift, from, to, skip = () => false) => { const w = walk(seed, ts(from, to).length, p0, vol, drift); return ts(from, to).map((time, i) => ({time, price: w[i]})).filter(c => !skip(c.time)); };
  const fmt = t => new Date(t).toISOString().slice(0, 16), settings = (cfg = {}, half = 2, a = start, b = end) =>
    ({config: {horizonMs: 300000, lookbackIntervals: 7, ...cfg}, replay: {source: 'range', start: fmt(a), end: fmt(b), halfSpreadBps: half}});
  const full = (from = start - 120 * M) => ({BTC: series(91, 61000, .003, .0003, from, end), LINK: series(92, 19.2, .006, .0002, from, end)});
  const gappy = {BTC: series(93, 61000, .003, .0003, start - 120 * M, end, t => t === start + 10 * M || t === start + 11 * M || t === start + 40 * M),
    LINK: series(94, 19.2, .006, .0002, start - 120 * M, end, t => (t > start + 20 * M && t < start + 26 * M) || t === start - 3 * M)};
  const shortLink = {BTC: series(95, 61000, .003, .0003, start - 120 * M, end), LINK: series(96, 19.2, .006, .0002, start - 5 * M, end)};
  const boundedWarmup = {BTC: series(97, 61000, .003, .0003, start - 400 * M, end, t => t > start - 20 * M && t < start), LINK: series(98, 19.2, .006, .0002, start - 400 * M, end)};
  write('range-replay', 'range-replay', [
    {name: 'complete-series', settings: settings(), candles: full()},
    {name: 'gaps-in-both-assets-skipped-not-filled', settings: settings(), candles: gappy},
    {name: 'per-asset-warmup-short-for-link-rejected', settings: settings(), candles: shortLink},
    {name: 'warmup-outside-window-dropped', settings: settings({lookbackIntervals: 30}), candles: boundedWarmup},
    {name: 'warmup-before-window-start-ignored-by-bound', settings: settings({lookbackIntervals: 3}), candles: boundedWarmup},
    {name: 'same-price-needs-no-warmup', settings: settings({model: 'same-price'}), candles: shortLink},
    {name: 'missing-exact-end-rejected', settings: settings(), candles: {...full(), BTC: full().BTC.filter(c => c.time !== end)}},
    {name: 'missing-exact-start-rejected', settings: settings(), candles: {...full(), LINK: full().LINK.filter(c => c.time !== start)}},
    {name: 'fees-spread-and-stop', settings: settings({feeBps: 30, slippageBps: 8, bufferBps: 0, stopLossBps: 90, horizonMs: 900000}, 5), candles: full()},
    {name: 'range-shorter-than-horizon-rejected', settings: settings({horizonMs: 3600000}, 2, start, start + 30 * M), candles: full()},
    {name: 'risk-limits-and-cash-yield', settings: settings({maxDrawdownBps: 30, dailyLossBps: 20, cashYieldBps: 1500, bufferBps: 0}), candles: gappy},
  ]);
}
// 10. Account risk limits: drawdown halts for the session, daily loss halts until the next UTC day, manual buys refused.
{
  const up = walk(101, 60, 50000, .002, .0012), upL = walk(102, 60, 20, .003, .001);
  const drop = (series, at, factor) => [...series.slice(0, at), ...series.slice(at).map(p => Math.round(p * factor * 1e4) / 1e4)];
  const crash = frames(drop(up, 12, .97), drop(upL, 12, .97));
  // Starts at 23:40 UTC on 2024-01-01; the crash comes at 23:52, midnight is frame 20.
  const night = frames(drop(up, 12, .97), drop(upL, 12, .97), {t0: T0 - 20 * M});
  const twoDrops = frames(drop(drop(up, 12, .97), 30, .97), drop(drop(upL, 12, .97), 30, .97), {t0: T0 - 20 * M});
  const run = (name, config, fs, extra = {}) => ({name, config: {horizonMs: 300000, lookbackIntervals: 3, bufferBps: 0, durationMs: 50 * M, ...config}, steps: ingestAll(fs), ...extra});
  const at = (fs, i) => structuredClone(fs[i]);
  write('risk-limits', 'account', [
    run('no-limits-configured-no-risk-state', {}, crash),
    run('drawdown-halts-for-the-session', {maxDrawdownBps: 150}, crash),
    run('drawdown-limit-not-reached', {maxDrawdownBps: 500}, crash),
    run('daily-loss-resumes-next-utc-day', {dailyLossBps: 100}, night),
    run('daily-loss-resumes-after-gap-over-midnight', {dailyLossBps: 100}, [...night.slice(0, 17), ...night.slice(26)]),
    run('daily-loss-twice-on-separate-days', {dailyLossBps: 100}, twoDrops),
    run('drawdown-wins-when-both-breach', {maxDrawdownBps: 150, dailyLossBps: 100}, night),
    run('daily-loss-then-drawdown-later', {maxDrawdownBps: 400, dailyLossBps: 100}, twoDrops),
    {name: 'manual-buys-refused-while-halted', config: {model: 'same-price', horizonMs: 3600000, maxDrawdownBps: 9999, dailyLossBps: 100, allocationFraction: 0, durationMs: 50 * M}, steps: [
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 500, frame: at(night, 0)}, {op: 'manual', asset: 'LINK', side: 'buy', dollars: 500, frame: at(night, 1)},
      ...ingestAll(night.slice(2, 13)), {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: at(night, 13)},
      {op: 'manual', asset: 'LINK', side: 'sell', dollars: 10, frame: at(night, 13)}, ...ingestAll(night.slice(14, 20)),
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: at(night, 20)}, ...ingestAll(night.slice(21, 30))]},
    {name: 'manual-buy-refused-after-drawdown', config: {model: 'same-price', horizonMs: 3600000, maxDrawdownBps: 100, allocationFraction: 0, durationMs: 50 * M}, steps: [
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 900, frame: at(crash, 0)}, ...ingestAll(crash.slice(1, 13)),
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 10, frame: at(crash, 13)}, ...ingestAll(crash.slice(14, 40)),
      {op: 'manual', asset: 'LINK', side: 'buy', dollars: 10, frame: at(crash, 40)}]},
    run('saved-before-limits-runs-without-them', {maxDrawdownBps: 150, dailyLossBps: 100, cashYieldBps: 2000}, night,
      {dropConfigFields: ['maxDrawdownBps', 'dailyLossBps', 'cashYieldBps']}),
    {name: 'limit-out-of-range-throws', config: {maxDrawdownBps: 10000}, steps: []},
  ]);
}
// 11. Cash yield: continuous compounding of idle cash over elapsed time (gaps included), stopping at completion.
{
  const H = 60 * M, btc = walk(111, 30, 45000, .01, .002), link = walk(112, 30, 15, .015, .001);
  const hourly = frames(btc, link, {step: H});
  const damaged = hourly.map((f, i) => { const g = structuredClone(f); if (i === 5 || i === 6) g.quotes = null; return g; });
  const run = (name, config, fs, extra = {}) => ({name, config: {horizonMs: H, lookbackIntervals: 3, bufferBps: 0, durationMs: 20 * H, ...config}, steps: ingestAll(fs), ...extra});
  const minute = frames(walk(113, 40, 42000, .004, .0004), walk(114, 40, 18.5, .008, .0003));
  write('cash-yield', 'account', [
    run('max-yield-hourly-with-completion', {cashYieldBps: 2000}, hourly),
    run('yield-over-unobserved-gap', {cashYieldBps: 1000}, [...hourly.slice(0, 7), ...hourly.slice(12)]),
    run('invalid-frames-do-not-reset-the-clock', {cashYieldBps: 1000}, damaged),
    run('quarter-allocation-keeps-more-cash-earning', {cashYieldBps: 2000, allocationFraction: .25}, hourly),
    run('yield-with-stop-loss-and-drawdown', {cashYieldBps: 750, stopLossBps: 60, maxDrawdownBps: 60}, hourly),
    run('zero-yield-default', {}, hourly),
    run('saved-before-yield', {cashYieldBps: 2000}, hourly, {dropConfigFields: ['cashYieldBps']}),
    {name: 'yield-with-manual-orders', config: {model: 'same-price', cashYieldBps: 1500, allocationFraction: 0, durationMs: 20 * H}, steps: [
      {op: 'manual', asset: 'BTC', side: 'buy', dollars: 300, frame: structuredClone(hourly[0])}, ...ingestAll(hourly.slice(1, 4)),
      {op: 'manual', asset: 'BTC', side: 'sell', dollars: 1e9, frame: structuredClone(hourly[6])}, ...ingestAll(hourly.slice(7, 25))]},
    {name: 'live-yield-with-gap', config: {mode: 'live', cashYieldBps: 2000, horizonMs: 300000, lookbackIntervals: 3, durationMs: 60 * M},
      steps: ingestAll([...minute.slice(0, 15), ...minute.slice(23, 40)])},
    {name: 'yield-above-maximum-throws', config: {cashYieldBps: 2001}, steps: []},
  ]);
}
console.log('inputs written to', dir);
