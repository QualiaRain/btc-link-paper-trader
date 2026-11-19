// The answer sheet for research/fastsim.mjs is the real engine (research/engine-run.mjs). Every random case below
// is run through both and must agree: counts exactly, money within 1e-9 relative. Hold-through, which the
// unmodified engine cannot run, is judged by a slow literal model of the protocol text that is itself checked
// against the engine on every case the engine can run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PROTOCOL, MINUTE, DAY, ASSETS, protocolWindows, prepareWindow} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine} from './engine-run.mjs';
import {mulberry32, syntheticMarket, sampleMarket} from './synthetic.mjs';

const START = Date.UTC(2022, 2, 1);
const MARKETS = [
  {name: 'bundled sample', market: sampleMarket()},
  {name: 'light gaps', market: syntheticMarket({seed: 101, start: START, minutes: 5200,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0}, LINK: {missing: 0.008, gapRate: 0.001, longGapRate: 0}})},
  {name: 'heavy LINK gaps', market: syntheticMarket({seed: 202, start: START, minutes: 5200,
    LINK: {missing: 0.12, gapRate: 0.012, gapMinutes: 25, longGapRate: 0.0006, longGapHours: 2}})},
  {name: 'outages and trends', market: syntheticMarket({seed: 303, start: START, minutes: 5200, correlation: 0.85,
    BTC: {regimeDrift: 0.00015, jumpRate: 0.004, longGapRate: 0.0012, longGapHours: 4},
    LINK: {regimeDrift: 0.0002, jumpRate: 0.004, longGapRate: 0.0012, longGapHours: 4}})},
].map(m => ({...m, first: Math.min(m.market.BTC.time[0], m.market.LINK.time[0]),
  last: Math.max(m.market.BTC.time.at(-1), m.market.LINK.time.at(-1)),
  has: Object.fromEntries(ASSETS.map(a => [a, new Set(m.market[a].time)]))}));

const HORIZONS = [1, 5, 7, 15, 60, 420, 1440].map(minutes => minutes * MINUTE);
const GRID_LOOKBACKS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const int = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = (random, list) => list[Math.floor(random() * list.length)];

// Family letters: P the app's rule, H hold-through, R reversal, X BTC-led, L long lookback (combinable).
// Half the cases are "lively" (short lookback, small buffer, cheap costs) so that runs trade often; the rest
// roam the whole range, including settings that never trade.
function randomSetting(random, family, n, lively = random() < 0.5) {
  const setting = {horizonMs: HORIZONS[n % HORIZONS.length],
    bufferBps: lively ? pick(random, [0, 0, 5, 10]) : random() < 0.7 ? pick(random, [0, 5, 10, 20, 40, 80, 160, 320]) : int(random, 0, 320),
    stopLossBps: pick(random, [0, 0, 0, 5, 14, 14, 100, 300, 1000, 5000])};
  if (family.includes('L')) setting.spanMs = pick(random, lively ? [30, 60, 120, 240] : [30, 120, 240, 480, 720, 1440, 2880, 4320]) * MINUTE;
  else setting.lookback = lively ? pick(random, [1, 1, 2, 3, 5, 7, 10]) : random() < 0.5 ? pick(random, GRID_LOOKBACKS) : int(random, 1, 240);
  if (family.includes('H')) setting.holdThrough = true;
  if (family.includes('R')) setting.reversal = true;
  if (family.includes('X')) setting.btcLed = true;
  if (random() < 0.1) setting.allocationFraction = pick(random, [0, 0.1, 0.25, 0.5]);
  if (random() < 0.1) setting.initialCash = pick(random, [250, 1000, 123456.78]);
  return setting;
}
const randomCosts = (random, lively) => ({feeBps: pick(random, lively ? [2, 2, 10] : [2, 10, 40]), slippageBps: pick(random, [0, 2]),
  halfSpreadBps: pick(random, lively ? [0, 3] : [0, 3, 10])});

// The nearest minute from `time` in direction `step` that exactly one asset observed, if any is close.
function oneSided(m, time, step) {
  for (let t = time, n = 0; n < 240 && t >= m.first && t <= m.last; n++, t += step * MINUTE)
    if (m.has.BTC.has(t) !== m.has.LINK.has(t)) return t;
  return null;
}
function randomWindow(random, m, horizonMs) {
  const span = (m.last - m.first) / MINUTE, horizon = horizonMs / MINUTE;
  // Hundreds to thousands of minutes: many decisions at short horizons, a handful (sometimes none: shorter than
  // one horizon) at the long ones.
  let length = int(random, 150, 1500) + Math.round(horizon * 3 * random());
  const kind = random();
  if (kind < 0.05) length = int(random, 1, 60);
  else if (kind < 0.09) length = int(random, 2500, 5000);
  length = Math.min(length, span - 10);
  let start = m.first + int(random, 0, span - length) * MINUTE;
  if (random() < 0.06) start = m.first + int(random, 0, 40) * MINUTE;   // too early for any warmup
  let end = start + length * MINUTE;
  // Boundaries whose first or last minute is missing for one asset: scoring must move to a shared minute.
  if (random() < 0.3) start = oneSided(m, start, +1) ?? start;
  if (random() < 0.3) end = oneSided(m, end, -1) ?? end;
  return {start, end: Math.max(start, end)};
}

// A slow, literal model of engine.js ingest (same step order, same arithmetic) with the protocol's four rule
// changes written natively. It is checked against the real engine on every case the engine can run (P directly;
// R, X and L through runEngine's emulation), and is then the answer sheet for hold-through, which the unmodified
// engine cannot run. `kept` counts held assets left untouched at a decision.
function reference(market, prepared, setting, costs) {
  const {horizonMs, lookback, spanMs, bufferBps, stopLossBps, holdThrough = false, reversal = false, btcLed = false,
    allocationFraction = 0.5, initialCash = 1000} = setting;
  if (prepared.shared < 2) return {valid: false, invalidReason: 'fewer than 2 shared minutes'};
  const s = prepared.scoreStart, e = prepared.scoreEnd, long = spanMs !== undefined;
  const first = long ? -Infinity : s - Math.max(60, 2 * lookback + 10) * MINUTE;
  const series = {}, at = {};
  for (const a of ASSETS) {
    series[a] = []; at[a] = new Map();
    market[a].time.forEach((time, i) => {
      if (time < first || time > e) return;
      at[a].set(time, series[a].length); series[a].push({time, price: market[a].close[i]});
    });
    if (!long && series[a].filter(row => row.time <= s).length < lookback + 1)
      return {valid: false, invalidReason: 'insufficient warmup'};
  }
  const fee = costs.feeBps / 10000, slip = costs.slippageBps / 10000, half = costs.halfSpreadBps / 10000;
  const mid = (a, t) => series[a][at[a].get(t)].price;
  const exit = (a, t) => mid(a, t) * (1 - half) * (1 - slip), entry = (a, t) => mid(a, t) * (1 + half) * (1 + slip);
  const frames = series.BTC.map(row => row.time).filter(t => t >= s && at.LINK.has(t));
  const book = {cash: initialCash, BTC: {qty: 0, cost: 0}, LINK: {qty: 0, cost: 0}};
  const out = {valid: true, invalidReason: null, fills: 0, fees: 0, stops: 0, decisions: 0, kept: 0,
    perAsset: Object.fromEntries(ASSETS.map(a => [a, {forecasts: 0, settled: 0, expired: 0, directionHits: 0,
      directionMisses: 0, directionFlat: 0, buys: 0}]))};
  const sell = (a, t) => {
    const p = book[a];
    if (!(p.qty > 1e-14)) return;
    const notional = p.qty * exit(a, t), cost = notional * fee;
    book.cash = Math.max(0, book.cash + (notional - cost)); p.qty = 0; p.cost = 0; out.fills++; out.fees += cost;
  };
  const buy = (a, t, dollars) => {
    const p = book[a], total = Math.min(dollars, book.cash);
    if (!(total > 1e-10)) return;
    const notional = total / (1 + fee);
    book.cash = Math.max(0, book.cash - total); p.qty += notional / entry(a, t); p.cost += total;
    if (p.qty < 1e-14) { p.qty = 0; p.cost = 0; }
    out.fills++; out.fees += total - notional; out.perAsset[a].buys++;
  };
  const value = t => book.cash + ASSETS.reduce((sum, a) => sum + book[a].qty * exit(a, t) * (1 - fee), 0);
  const drift = (a, t) => {
    const source = btcLed ? 'BTC' : a, rows = series[source], last = at[source].get(t);
    let past = last - lookback;
    if (long) {
      past = last;
      while (past >= 0 && rows[past].time > t - spanMs) past--;
      if (past >= 0 && t - spanMs - rows[past].time > 60 * MINUTE) past = -1;
    }
    if (past < 0) return null;
    const elapsed = rows[last].time - rows[past].time;
    const d = Math.max(-.03, Math.min(.03, Math.log(rows[last].price / rows[past].price) * horizonMs / elapsed));
    return reversal ? -d : d;
  };
  // The comparison account: half the cash into each asset at the first frame, held.
  const bench = {};
  let benchCash = initialCash;
  for (const a of ASSETS) {
    const total = Math.min(initialCash / 2, benchCash);
    bench[a] = total / (1 + fee) / entry(a, frames[0]); benchCash = Math.max(0, benchCash - total);
  }
  let pending = [], lastDecisionAt = null, peak = initialCash, maxDrawdownPct = 0;
  const held = {BTC: 0, LINK: 0};
  for (const t of frames) {
    pending = pending.filter(f => {   // settle(): the first frame at or after the target resolves the forecast
      if (t < f.targetAt) return true;
      const counts = out.perAsset[f.asset];
      if (t - f.targetAt > 30000) { counts.expired++; return false; }
      const eps = 1e-12 * Math.max(1, f.anchor), predicted = f.prediction - f.anchor, observed = mid(f.asset, t) - f.anchor;
      counts.settled++;
      if (Math.abs(predicted) <= eps || Math.abs(observed) <= eps) counts.directionFlat++;
      else if (Math.sign(predicted) === Math.sign(observed)) counts.directionHits++;
      else counts.directionMisses++;
      return false;
    });
    const stopped = new Set();        // stopPositions()
    if (stopLossBps) for (const a of ASSETS) {
      const p = book[a];
      if (p.qty > 0 && p.cost > 0 && p.qty * exit(a, t) * (1 - fee) <= p.cost * (1 - stopLossBps / 10000)) {
        out.stops++; sell(a, t); stopped.add(a);
      }
    }
    if (t >= e) for (const a of ASSETS) sell(a, t);
    else if (lastDecisionAt === null || t - lastDecisionAt >= horizonMs) {
      out.decisions++;
      const wants = {};               // the engine's forecast and buy test; a skipped decision makes no forecast
      for (const a of ASSETS) {
        wants[a] = false;
        const d = stopped.has(a) ? null : drift(a, t);
        if (d === null || t + horizonMs > e) continue;
        const anchor = mid(a, t), prediction = anchor * Math.exp(d);
        pending.push({asset: a, targetAt: t + horizonMs, anchor, prediction}); out.perAsset[a].forecasts++;
        wants[a] = (prediction / anchor) * (exit(a, t) / entry(a, t)) * (1 - fee) / (1 + fee) > 1 + bufferBps / 10000;
      }
      if (!holdThrough) {
        for (const a of ASSETS) sell(a, t);
        const budget = book.cash * allocationFraction;
        for (const a of ASSETS) if (wants[a]) buy(a, t, budget);
      } else {
        const E = value(t);           // net liquidation value before any trade of this decision
        for (const a of ASSETS) if (!wants[a]) sell(a, t);
        for (const a of ASSETS) if (wants[a]) { if (book[a].qty > 0) out.kept++; else buy(a, t, allocationFraction * E); }
      }
      lastDecisionAt = t;
    }
    const v = value(t);
    peak = Math.max(peak, v); maxDrawdownPct = Math.max(maxDrawdownPct, 100 * (peak - v) / peak);
    for (const a of ASSETS) if (book[a].qty > 0) held[a]++;
  }
  const end = frames.at(-1), finalValue = value(end);
  const buyHoldValue = benchCash + ASSETS.reduce((sum, a) => sum + bench[a] * exit(a, end) * (1 - fee), 0);
  return {...out, finalValue, returnPct: 100 * (finalValue / initialCash - 1), buyHoldValue,
    buyHoldReturnPct: 100 * (buyHoldValue / initialCash - 1), maxDrawdownPct,
    exposure: {BTC: held.BTC / frames.length, LINK: held.LINK / frames.length}};
}

const FLOATS = ['finalValue', 'returnPct', 'buyHoldValue', 'buyHoldReturnPct', 'fees', 'maxDrawdownPct'];
let comparedFloats = 0, identicalFloats = 0;
function near(actual, expected, what) {
  comparedFloats++; if (Object.is(actual, expected) || actual === expected) identicalFloats++;
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected)), `${what}: ${actual} != ${expected}`);
}
function agree(actual, expected, label) {
  assert.equal(actual.valid, expected.valid, `${label}: valid`);
  assert.equal(actual.invalidReason, expected.invalidReason, `${label}: invalidReason`);
  if (!expected.valid) return;
  for (const key of ['fills', 'stops', 'decisions']) assert.equal(actual[key], expected[key], `${label}: ${key}`);
  assert.deepEqual(actual.perAsset, expected.perAsset, `${label}: perAsset`);
  for (const key of FLOATS) near(actual[key], expected[key], `${label}: ${key}`);
  for (const a of ASSETS) near(actual.exposure[a], expected.exposure[a], `${label}: exposure.${a}`);
}

// One differential block: `count` random cases of a family, every horizon and every market in turn.
const totals = {};
function fuzz(family, count, seed) {
  const random = mulberry32(seed);
  const t = totals[family] = {cases: 0, ran: 0, refused: 0, tooShort: 0, lowCoverage: 0, oneSided: 0, fills: 0, buys: 0, stops: 0,
    expired: 0, settled: 0, hits: 0, misses: 0, flat: 0, skipped: 0, historySkips: 0, stopSkips: 0, kept: 0,
    unlikeEngine: 0, inputs: new Set(), maxLookback: 0};
  for (let n = 0; n < count; n++) {
    const lively = random() < 0.5, m = MARKETS[n % MARKETS.length];
    const setting = randomSetting(random, family, n, lively), costs = randomCosts(random, lively);
    const window = randomWindow(random, m, setting.horizonMs);
    const prepared = prepareWindow(m.market, window);
    const label = `${family} #${n} on ${m.name} ${JSON.stringify({window, setting, costs})}`;
    const fast = simulate(m.market, prepared, setting, costs, {detail: true});
    const literal = reference(m.market, prepared, setting, costs);
    // Hold-through has no engine run; everything else is judged by the engine, and so is the literal model.
    const expected = setting.holdThrough ? literal : runEngine(m.market, prepared, setting, costs);
    agree(fast, expected, label);
    if (!setting.holdThrough) agree(literal, expected, `literal model, ${label}`);
    // Without detail the simulator skips most frames; it must be the same run.
    const {maxDrawdownPct, exposure, ...common} = fast;
    assert.deepEqual(simulate(m.market, prepared, setting, costs), common, `${label}: detail and plain runs differ`);

    t.cases++;
    if ([window.start, window.end].some(minute => m.has.BTC.has(minute) !== m.has.LINK.has(minute))) t.oneSided++;
    if (!expected.valid) { if (expected.invalidReason === 'insufficient warmup') t.refused++; else t.tooShort++; continue; }
    // The simulators run any window with two frames; the 90% floor (prepared.valid) is the caller's to apply.
    t.ran++; t.fills += expected.fills; t.stops += expected.stops; t.kept += literal.kept;
    if (!prepared.valid) t.lowCoverage++;
    for (const input of [m.name, `horizon ${setting.horizonMs / MINUTE}`, `stop ${setting.stopLossBps}`, `buffer ${setting.bufferBps}`,
      `fee ${costs.feeBps}`, `slippage ${costs.slippageBps}`, `half-spread ${costs.halfSpreadBps}`]) t.inputs.add(input);
    t.maxLookback = Math.max(t.maxLookback, setting.lookback ?? 0);
    let forecasts = 0;
    for (const a of ASSETS) {
      const c = expected.perAsset[a];
      forecasts += c.forecasts; t.buys += c.buys; t.expired += c.expired; t.settled += c.settled;
      t.hits += c.directionHits; t.misses += c.directionMisses; t.flat += c.directionFlat;
      assert.equal(c.forecasts, c.settled + c.expired, `${label}: a forecast is still pending`);
      assert.equal(c.settled, c.directionHits + c.directionMisses + c.directionFlat, label);
    }
    // Each decision frame makes a forecast or a skip per asset. At most one frame per run (two skips) is skipped
    // for its horizon passing the session end; the rest are stops on the decision frame or missing history.
    const skipped = 2 * expected.decisions - forecasts, others = Math.max(0, skipped - 2);
    t.skipped += skipped;
    if (setting.spanMs !== undefined) { if (!setting.stopLossBps) t.historySkips += others; }
    else if (setting.stopLossBps) t.stopSkips += others;
    else assert.ok(skipped === 0 || skipped === 2, `${label}: a lookback run that was not refused lacked history`);
    if (setting.holdThrough) {
      // Where nothing was ever kept, hold-through is the engine's own rule (budget from E instead of cash).
      const plain = runEngine(m.market, prepared, {...setting, holdThrough: false}, costs);
      if (literal.kept === 0) agree(fast, plain, `hold-through that never held, ${label}`);
      else if (plain.fills !== fast.fills) t.unlikeEngine++;
    }
  }
  return t;
}

test('protocol windows: 74 consecutive 28-day windows, 50 for design then 24 for confirmation', () => {
  const windows = protocolWindows();
  assert.equal(windows.length, 74);
  assert.deepEqual(windows[0], {index: 0, start: Date.parse('2020-01-01T00:00:00Z'),
    end: Date.parse('2020-01-28T23:59:00Z'), set: 'design'});
  for (let k = 1; k < 74; k++) assert.equal(windows[k].start, windows[k - 1].end + MINUTE);
  assert.equal(new Date(windows[49].end).toISOString(), '2023-10-31T23:59:00.000Z');
  assert.equal(new Date(windows[73].end).toISOString(), '2025-09-02T23:59:00.000Z');
  assert.deepEqual(windows.map(w => w.set), [...Array(50).fill('design'), ...Array(24).fill('confirmation')]);
  assert.ok(windows[73].end < Date.parse('2025-09-30T00:00:00Z'), 'the held-out range is not reached');
  assert.equal((windows[5].end - windows[5].start) / MINUTE + 1, 28 * 1440);
});

test('prepareWindow scores from the first to the last shared minute and reports coverage', () => {
  const T = Date.UTC(2024, 0, 1);
  const series = (minutes, base) => ({time: Float64Array.from(minutes, m => T + m * MINUTE),
    close: Float64Array.from(minutes, m => base + m)});
  const market = {BTC: series([0, 1, 2, 3, 5, 6, 7, 9, 10, 11], 100), LINK: series([1, 2, 4, 5, 6, 8, 9, 10, 12], 10)};
  const half = prepareWindow(market, {start: T, end: T + 9 * MINUTE}, {...PROTOCOL, minSharedFraction: 0.5});
  assert.deepEqual({...half, times: [...half.times], index: {BTC: [...half.index.BTC], LINK: [...half.index.LINK]},
    close: {BTC: [...half.close.BTC], LINK: [...half.close.LINK]}},
  {start: T, end: T + 9 * MINUTE, expected: 10, observed: {BTC: 8, LINK: 7}, shared: 5, sharedFraction: 0.5,
    scoreStart: T + MINUTE, scoreEnd: T + 9 * MINUTE, times: [1, 2, 5, 6, 9].map(m => T + m * MINUTE),
    index: {BTC: [1, 2, 4, 5, 7], LINK: [0, 1, 3, 4, 6]}, close: {BTC: [101, 102, 105, 106, 109], LINK: [11, 12, 15, 16, 19]},
    valid: true, invalidReason: null});
  const strict = prepareWindow(market, {start: T, end: T + 9 * MINUTE});
  assert.deepEqual([strict.shared, strict.valid, strict.invalidReason], [5, false, 'insufficient shared coverage']);
  const single = prepareWindow(market, {start: T + 3 * MINUTE, end: T + 5 * MINUTE});
  assert.deepEqual([single.shared, single.valid, single.invalidReason], [1, false, 'fewer than 2 shared minutes']);
  const empty = prepareWindow(market, {start: T + 20 * MINUTE, end: T + 30 * MINUTE});
  assert.deepEqual([empty.shared, empty.scoreStart, empty.scoreEnd, empty.valid], [0, null, null, false]);
  assert.throws(() => prepareWindow(market, {start: T + 1, end: T + MINUTE}), /minute-close/);
  // Without two frames no run exists, for any setting, in either simulator.
  const setting = {horizonMs: MINUTE, spanMs: MINUTE, bufferBps: 0, stopLossBps: 0}, costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  for (const prepared of [single, empty]) {
    const none = {valid: false, invalidReason: 'fewer than 2 shared minutes'};
    assert.deepEqual(simulate(market, prepared, setting, costs), none);
    assert.deepEqual(runEngine(market, prepared, setting, costs), none);
    assert.deepEqual(simulateGrid(market, prepared, [setting, setting], costs), [none, none]);
  }
  // The coverage floor is the caller's check: a window below it still runs, identically in both simulators.
  const low = simulate(market, strict, setting, costs, {detail: true});
  assert.equal(low.valid, true); assert.equal(low.decisions, 4);
  agree(low, runEngine(market, strict, setting, costs), 'window below the coverage floor');
});

test('synthetic markets are deterministic, tick-rounded and have independent gaps', () => {
  const again = syntheticMarket({seed: 202, start: START, minutes: 5200,
    LINK: {missing: 0.12, gapRate: 0.012, gapMinutes: 25, longGapRate: 0.0006, longGapHours: 2}});
  assert.deepEqual(again, MARKETS[2].market);
  assert.notDeepEqual(syntheticMarket({seed: 203, start: START, minutes: 500}), syntheticMarket({seed: 202, start: START, minutes: 500}));
  const random = mulberry32(5), values = Array.from({length: 1000}, random);
  assert.deepEqual(values.slice(0, 3), Array.from({length: 3}, mulberry32(5)));
  assert.ok(values.every(v => v >= 0 && v < 1) && new Set(values).size > 990);
  for (const m of MARKETS.slice(1)) {
    const {BTC, LINK} = m.market;
    assert.ok(BTC.close.every(c => Math.abs(c * 100 - Math.round(c * 100)) < 1e-6), 'BTC closes are whole cents');
    assert.ok(LINK.close.every(c => Math.abs(c * 1000 - Math.round(c * 1000)) < 1e-7), 'LINK closes have 3 decimals');
    assert.ok([...BTC.time].some(t => !m.has.LINK.has(t)) && [...LINK.time].some(t => !m.has.BTC.has(t)), 'one-sided minutes');
    assert.ok(BTC.time.length < 5200 && LINK.time.length < 5200);
  }
  const longest = series => Math.max(...Array.from(series.time.subarray(1), (t, i) => (t - series.time[i]) / MINUTE));
  assert.ok(longest(MARKETS[2].market.LINK) >= 60 && longest(MARKETS[3].market.BTC) >= 60, 'multi-hour gaps exist');
  assert.equal(MARKETS[0].market.BTC.time.length, 1648);
});

test('settings the protocol fixes cannot be set, and bad settings are rejected', () => {
  const m = MARKETS[0], prepared = prepareWindow(m.market, {start: m.first + 300 * MINUTE, end: m.first + 900 * MINUTE});
  const setting = {horizonMs: 7 * MINUTE, lookback: 7, bufferBps: 10, stopLossBps: 0}, costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  assert.equal(simulate(m.market, prepared, setting, costs).valid, true);
  for (const key of ['maxQuoteAgeMs', 'maxOutcomeLatenessMs', 'maxDrawdownBps', 'dailyLossBps', 'cashYieldBps']) {
    for (const value of [0, 60000]) {
      assert.throws(() => simulate(m.market, prepared, {...setting, [key]: value}, costs), /fixed by the protocol/);
      assert.throws(() => simulate(m.market, prepared, setting, {...costs, [key]: value}), /fixed by the protocol/);
      assert.throws(() => simulateGrid(m.market, prepared, [setting, {...setting, [key]: value}], costs), /fixed by the protocol/);
      assert.throws(() => runEngine(m.market, prepared, {...setting, [key]: value}, costs), /fixed by the protocol/);
    }
  }
  assert.throws(() => runEngine(m.market, prepared, {...setting, holdThrough: true}, costs), /holdThrough is not supported/);
  for (const bad of [{lookback: undefined}, {spanMs: 3600000}, {lookback: 0}, {lookback: 241}, {lookback: 7.5},
    {lookback: undefined, spanMs: 0}, {horizonMs: 0}, {bufferBps: -1}, {stopLossBps: 10000}, {allocationFraction: 0.6},
    {initialCash: 0}, {holdThrough: 1}])
    assert.throws(() => simulate(m.market, prepared, {...setting, ...bad}, costs), Error, JSON.stringify(bad));
  assert.throws(() => simulate(m.market, prepared, setting, {feeBps: 2, slippageBps: 2}), /halfSpreadBps/);
  // Keys a caller adds for itself are ignored, and a null lookback or span means "not given".
  const labelled = {...setting, family: 'P', id: 17, spanMs: null, holdThrough: false};
  assert.deepEqual(simulate(m.market, prepared, labelled, costs), simulate(m.market, prepared, setting, costs));
  assert.deepEqual(runEngine(m.market, prepared, labelled, costs), runEngine(m.market, prepared, setting, costs));
});

test('hand-built runs: stops on the completion frame, a two-frame run, a run shorter than its horizon', () => {
  // Both assets rise 0.1% a minute and fall 1% on the very last minute. Costs are zero, so a 5 bps stop can only
  // fire on that last minute, which is the completion frame.
  const T = Date.UTC(2024, 4, 1), free = {feeBps: 0, slippageBps: 0, halfSpreadBps: 0};
  const path = Array.from({length: 80}, (_, m) => m < 79 ? 1.001 ** m : 0.99 * 1.001 ** 78);
  const series = (price, tick) => ({time: Float64Array.from(path, (_, m) => T + m * MINUTE),
    close: Float64Array.from(path, x => Math.round(price * x * tick) / tick)});
  const market = {BTC: series(30000, 100), LINK: series(15, 1000)};
  const both = (from, to, setting) => {
    const prepared = prepareWindow(market, {start: T + from * MINUTE, end: T + to * MINUTE});
    const fast = simulate(market, prepared, setting, free, {detail: true});
    agree(fast, runEngine(market, prepared, setting, free), JSON.stringify(setting));
    agree(reference(market, prepared, setting, free), fast, `literal model ${JSON.stringify(setting)}`);
    return fast;
  };
  const minute = {horizonMs: MINUTE, lookback: 1, bufferBps: 0, stopLossBps: 5};
  // Minutes 65..79: fourteen decisions that each sell and rebuy both assets, then both stop out at the close.
  const stoppedAtEnd = both(65, 79, minute);
  assert.deepEqual([stoppedAtEnd.decisions, stoppedAtEnd.fills, stoppedAtEnd.stops], [14, 56, 2]);
  assert.deepEqual(stoppedAtEnd.perAsset.LINK, {forecasts: 14, settled: 14, expired: 0, directionHits: 13,
    directionMisses: 1, directionFlat: 0, buys: 14});
  assert.equal(stoppedAtEnd.exposure.BTC, 14 / 15);
  assert.ok(stoppedAtEnd.maxDrawdownPct > 0.9 && stoppedAtEnd.finalValue > 1000);
  // Hold-through keeps both positions instead: one buy each. The stop is measured from the entry cost, so the
  // final 1% fall stops out a position entered at minute 72 (up 0.6% by then) but not one entered at minute 65.
  const held = (from, expected) => {
    const prepared = prepareWindow(market, {start: T + from * MINUTE, end: T + 79 * MINUTE});
    const fast = simulate(market, prepared, {...minute, holdThrough: true}, free, {detail: true});
    agree(fast, reference(market, prepared, {...minute, holdThrough: true}, free), 'hold-through');
    assert.deepEqual([fast.decisions, fast.fills, fast.stops, fast.perAsset.BTC.buys, fast.perAsset.LINK.buys], expected);
    assert.equal(fast.exposure.LINK, (79 - from) / (80 - from));
  };
  held(72, [7, 4, 2, 1, 1]);
  held(65, [14, 4, 0, 1, 1]);
  // Two frames: one decision whose target is exactly the end, then the close.
  const two = both(70, 71, minute);
  assert.deepEqual([two.decisions, two.fills, two.stops, two.perAsset.BTC.directionHits], [1, 4, 0, 1]);
  // Shorter than one horizon: the only decision is skipped, the comparison account still buys and holds.
  const short = both(65, 75, {...minute, horizonMs: 15 * MINUTE});
  assert.deepEqual([short.decisions, short.fills, short.perAsset.BTC.forecasts, short.finalValue], [1, 0, 0, 1000]);
  assert.ok(short.buyHoldValue > 1009 && short.buyHoldValue < 1011);
  // No warmup before the first minute of the series: the app would refuse the run.
  const prepared0 = prepareWindow(market, {start: T, end: T + 30 * MINUTE});
  assert.deepEqual(simulate(market, prepared0, minute, free), {valid: false, invalidReason: 'insufficient warmup'});
  assert.deepEqual(runEngine(market, prepared0, minute, free), {valid: false, invalidReason: 'insufficient warmup'});
  // Long lookback is never refused; its decisions are skipped until the span (here 30 minutes) is covered.
  const long = both(0, 79, {horizonMs: 5 * MINUTE, spanMs: 30 * MINUTE, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([long.decisions, long.perAsset.BTC.forecasts], [16, 9]);
});

test('hand-built runs on exact thresholds: the stop line, the buy hurdle and the 60-minute span tolerance', () => {
  // No costs, prices 99, 100, 50, 50, 50, 50 and a 5000 bps stop. Minute 1 buys 5 units for 500; at minute 2 they
  // are worth exactly 250 = 500 x (1 - 0.5), so the stop fires (<=) and that decision is skipped for both assets.
  // From minute 3 the forecast is flat and expectedNetRatio is exactly 1, which is not above 1 + 0 bps: no buy.
  const T = Date.UTC(2024, 4, 1), free = {feeBps: 0, slippageBps: 0, halfSpreadBps: 0}, closes = [99, 100, 50, 50, 50, 50];
  const series = () => ({time: Float64Array.from(closes, (_, m) => T + m * MINUTE), close: Float64Array.from(closes)});
  const market = {BTC: series(), LINK: series()}, prepared = prepareWindow(market, {start: T + MINUTE, end: T + 5 * MINUTE});
  const setting = {horizonMs: MINUTE, lookback: 1, bufferBps: 0, stopLossBps: 5000};
  const fast = simulate(market, prepared, setting, free, {detail: true});
  agree(fast, runEngine(market, prepared, setting, free), 'exact thresholds');
  assert.deepEqual([fast.decisions, fast.fills, fast.stops, fast.finalValue, fast.buyHoldValue, fast.maxDrawdownPct], [4, 4, 2, 500, 500, 50]);
  for (const a of ASSETS) assert.deepEqual(fast.perAsset[a], {forecasts: 3, settled: 3, expired: 0, directionHits: 0,
    directionMisses: 1, directionFlat: 2, buys: 1});
  assert.deepEqual(fast.exposure, {BTC: 0.2, LINK: 0.2});

  // Long lookback with a 30-minute span on a series observed at minute 0 and then from minute 62. The decision at
  // minute 90 wants minute 60 and finds minute 0, exactly 60 minutes older: used. The one at minute 91 wants minute
  // 61 and finds minute 0, 61 minutes older: skipped. From minute 92 the wanted minute itself is observed.
  const minutes = [0, ...Array.from({length: 39}, (_, k) => 62 + k)];
  const gapped = base => ({time: Float64Array.from(minutes, m => T + m * MINUTE), close: Float64Array.from(minutes, m => base + m / 8)});
  const sparse = {BTC: gapped(40000), LINK: gapped(20)}, window = prepareWindow(sparse, {start: T + 90 * MINUTE, end: T + 96 * MINUTE});
  const span = {horizonMs: MINUTE, spanMs: 30 * MINUTE, bufferBps: 0, stopLossBps: 0};
  const long = simulate(sparse, window, span, free, {detail: true});
  agree(long, runEngine(sparse, window, span, free), 'span tolerance');
  agree(long, reference(sparse, window, span, free), 'span tolerance, literal model');
  assert.deepEqual([long.decisions, long.perAsset.BTC.forecasts, long.perAsset.LINK.forecasts, long.perAsset.LINK.buys], [6, 5, 5, 5]);
});

test('differential fuzz: the fast simulator against the unmodified engine', async t => {
  await t.test('family P: the app\'s rule on the sample and three synthetic markets', () => {
    const f = fuzz('P', 420, 1);
    assert.ok(f.cases >= 150 && f.ran >= 250, `${f.ran} of ${f.cases} cases ran`);
    for (const input of [...MARKETS.map(m => m.name), ...[1, 5, 7, 15, 60, 420, 1440].map(h => `horizon ${h}`), 'stop 0', 'stop 5',
      'stop 14', 'stop 100', 'stop 5000', 'buffer 0', 'buffer 320', 'fee 2', 'fee 10', 'fee 40', 'slippage 0', 'slippage 2',
      'half-spread 0', 'half-spread 3', 'half-spread 10']) assert.ok(f.inputs.has(input), `no run with ${input}`);
    assert.ok(f.inputs.has('buffer 0') && f.maxLookback >= 200, `largest lookback that ran: ${f.maxLookback}`);
  });

  await t.test('family R: reversal against the engine fed reciprocal histories', () => {
    const f = fuzz('R', 112, 2);
    assert.ok(f.cases >= 50 && f.ran >= 60, `${f.ran} of ${f.cases} cases ran`);
  });

  await t.test('family X: BTC-led against the engine fed BTC history for LINK', () => {
    const f = fuzz('X', 112, 3);
    assert.ok(f.cases >= 50 && f.ran >= 60, `${f.ran} of ${f.cases} cases ran`);
  });

  await t.test('family L: long lookback against the engine fed two-row histories', () => {
    const f = fuzz('L', 140, 4);
    assert.ok(f.cases >= 50 && f.ran >= 100, `${f.ran} of ${f.cases} cases ran`);
    assert.equal(f.refused, 0, 'the warmup refusal does not apply to long lookback');
    assert.ok(f.historySkips > 0, 'decisions were skipped for a missing or too-old past observation');
  });

  await t.test('combined changes (reversal with BTC-led, on either kind of lookback)', () => {
    const f = fuzz('RX', 56, 5), g = fuzz('LRX', 56, 6);
    assert.ok(f.ran >= 30 && g.ran >= 30 && f.buys > 0 && g.buys > 0, `${f.ran} and ${g.ran} cases ran`);
  });

  await t.test('hold-through (H, and L with hold-through) against the literal model of the protocol text', () => {
    const f = fuzz('H', 196, 7), g = fuzz('LH', 84, 8);
    assert.ok(f.ran >= 120 && g.ran >= 60, `${f.ran} and ${g.ran} cases ran`);
    assert.ok(f.kept > 0 && g.kept > 0, 'positions were held through decisions');
    assert.ok(f.unlikeEngine > 0, 'holding through changed the fills against the engine rule');
    assert.ok(f.stops > 0 && f.buys > 0 && f.stopSkips > 0);
  });

  await t.test('the fuzz has teeth: buys, stop-outs, expired forecasts, skipped decisions and refused windows all occurred', t => {
    const engineJudged = ['P', 'R', 'X', 'L', 'RX', 'LRX'], all = [...engineJudged, 'H', 'LH'];
    const sum = (key, families = all) => families.reduce((n, family) => n + totals[family][key], 0);
    for (const key of ['ran', 'refused', 'lowCoverage', 'oneSided', 'fills', 'buys', 'stops', 'expired', 'settled', 'hits', 'misses',
      'flat', 'skipped', 'historySkips', 'stopSkips']) assert.ok(sum(key, engineJudged) > 0, `no ${key} among engine-judged cases`);
    for (const key of ['buys', 'stops', 'expired', 'skipped', 'refused', 'stopSkips', 'flat', 'oneSided'])
      assert.ok(totals.P[key] > 0, `family P alone has no ${key}`);
    for (const family of ['R', 'X', 'L'])
      for (const key of ['buys', 'stops', 'expired', 'skipped']) assert.ok(totals[family][key] > 0, `family ${family} has no ${key}`);
    assert.ok(totals.R.refused > 0 && totals.X.refused > 0);
    assert.ok(sum('cases') >= 1000);
    for (const family of all) {
      const f = totals[family];
      t.diagnostic(`${family}: ${f.cases} cases, ${f.ran} ran, ${f.refused} refused, ${f.buys} buys, ${f.stops} stop-outs, ` +
        `${f.expired} expired, ${f.skipped} skipped decisions`);
    }
    t.diagnostic(`all: ${sum('cases')} cases, ${sum('ran')} ran (${sum('lowCoverage')} on windows below 90% shared coverage), ` +
      `${sum('refused')} refused for warmup, ${sum('tooShort')} without two frames, ${sum('oneSided')} with a one-sided boundary minute`);
    t.diagnostic(`all: ${sum('fills')} fills, ${sum('buys')} buys, ${sum('stops')} stop-outs, ${sum('expired')} expired and ` +
      `${sum('settled')} settled forecasts (${sum('flat')} flat), ${sum('skipped')} skipped decisions (at least ` +
      `${sum('historySkips')} for history, ${sum('stopSkips')} for a same-frame stop), ${sum('kept')} positions held through`);
    t.diagnostic(`floats compared: ${comparedFloats}, bit-identical: ${identicalFloats}`);
  });
});

test('a protocol-sized window (28 days at the protocol costs) agrees with the engine, the default setting included', () => {
  const start = Date.UTC(2021, 5, 1);
  const market = syntheticMarket({seed: 505, start: start - 3 * DAY, minutes: 31 * 1440,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0.00003}, LINK: {missing: 0.01, gapRate: 0.001, longGapRate: 0.00003}});
  const prepared = prepareWindow(market, {start, end: start + 28 * DAY - MINUTE});
  assert.deepEqual([prepared.expected, prepared.valid, prepared.shared > 38000], [40320, true, true]);
  const costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  for (const setting of [
    {horizonMs: 7 * MINUTE, lookback: 7, bufferBps: 10, stopLossBps: 0},                    // the app's default rule
    {horizonMs: MINUTE, lookback: 2, bufferBps: 5, stopLossBps: 100},
    {horizonMs: 60 * MINUTE, lookback: 30, bufferBps: 20, stopLossBps: 300, reversal: true},
    {horizonMs: 15 * MINUTE, lookback: 5, bufferBps: 0, stopLossBps: 1000, btcLed: true},
    {horizonMs: 420 * MINUTE, spanMs: 2 * DAY, bufferBps: 0, stopLossBps: 300},
  ]) {
    const fast = simulate(market, prepared, setting, costs, {detail: true});
    agree(fast, runEngine(market, prepared, setting, costs), JSON.stringify(setting));
    assert.ok(fast.fills > 20 && fast.perAsset.BTC.expired > 0, JSON.stringify(setting));
  }
});

test('simulateGrid returns exactly what simulate returns, in input order', () => {
  const random = mulberry32(9), costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  let valid = 0, invalid = 0;
  for (const m of MARKETS) {
    const prepared = prepareWindow(m.market, {start: m.first + 420 * MINUTE, end: m.first + 1500 * MINUTE});
    const settings = Array.from({length: 160}, (_, n) => {
      const setting = randomSetting(random, pick(random, ['P', 'P', 'H', 'R', 'X', 'L', 'LH', 'RX']), n);
      // Few distinct forecast rules, so most plans are shared by several settings.
      setting.horizonMs = pick(random, [1, 7, 60, 420]) * MINUTE;
      if (setting.spanMs) setting.spanMs = pick(random, [120, 360]) * MINUTE; else setting.lookback = pick(random, [1, 7, 30, 240]);
      return setting;
    });
    const results = simulateGrid(m.market, prepared, settings, costs);
    assert.equal(results.length, settings.length);
    settings.forEach((setting, n) => {
      assert.deepEqual(results[n], simulate(m.market, prepared, setting, costs), `${m.name} ${JSON.stringify(setting)}`);
      if (results[n].valid) valid++; else invalid++;
    });
  }
  assert.ok(valid > 300 && invalid > 0, `${valid} valid, ${invalid} invalid`);
  assert.deepEqual(simulateGrid(MARKETS[0].market, prepareWindow(MARKETS[0].market, {start: START, end: START + DAY}), [], costs), []);
});

test('speed: well under 3 ms per setting-window without detail on a 14-day window', t => {
  const market = syntheticMarket({seed: 404, start: START, minutes: 16 * 1440,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0.00003}, LINK: {missing: 0.01, gapRate: 0.001, longGapRate: 0.00003}});
  const prepared = prepareWindow(market, {start: START + 2 * DAY, end: START + 16 * DAY - MINUTE});
  assert.equal(prepared.valid, true);
  const settings = [];
  for (const horizonMs of HORIZONS) for (const lookback of [1, 7, 60, 240]) for (const bufferBps of [0, 10, 80]) for (const stopLossBps of [0, 100, 1000])
    for (const holdThrough of [false, true]) settings.push({horizonMs, lookback, bufferBps, stopLossBps, holdThrough});
  simulateGrid(market, prepared, settings.slice(0, 40), {feeBps: 2, slippageBps: 2, halfSpreadBps: 3});   // warm up
  const began = performance.now();
  const results = simulateGrid(market, prepared, settings, {feeBps: 2, slippageBps: 2, halfSpreadBps: 3});
  const each = (performance.now() - began) / settings.length;
  assert.ok(results.every(r => r.valid) && results.some(r => r.fills > 1000));
  t.diagnostic(`${settings.length} settings on ${prepared.shared} frames: ${each.toFixed(3)} ms per setting-window`);
  assert.ok(each < 3, `${each} ms per setting-window`);
});
