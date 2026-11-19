// The answer sheet for research/fastsim.mjs is the engine (research/engine-run.mjs). Every random case below is run
// through both and must agree: counts exactly, money within 1e-9 relative. Families P, R, X and L are judged by the
// unmodified engine (R, X and L by feeding it the history their rule reads); hold-through, which the unmodified
// engine cannot run, by the engine with only its scheduled-decision branch replaced (research/holdthrough-oracle.mjs).
// Those are the references PROTOCOL.md, "Simulation", names. A slow literal model of the protocol text, written
// natively in this file, must give the same run as the engine on every case.
//
// Simulated cash only. Two simulators agreeing says nothing about whether any setting makes money.
import test from 'node:test';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as unmodified from '../engine.js';
import {PROTOCOL, MINUTE, DAY, ASSETS, protocolWindows, prepareWindow} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine, ENGINE_FILE} from './engine-run.mjs';
import {loadHoldThroughEngine} from './holdthrough-oracle.mjs';
import {mulberry32, syntheticMarket, sampleMarket} from './synthetic.mjs';

const holdThroughEngine = await loadHoldThroughEngine();
// The engine that judges a setting: the unmodified one, or for hold-through the one with its decision branch
// replaced (runEngine refuses hold-through on anything else).
const engineFor = setting => (setting.holdThrough ? holdThroughEngine : unmodified);
const judge = (market, prepared, setting, costs) =>
  runEngine(market, prepared, setting, costs, setting.holdThrough ? {engine: holdThroughEngine} : {});
// The same run with the engine's account kept, for the tests that read its ledger to show what a run contained.
function judgeWithLedger(market, prepared, setting, costs) {
  const api = engineFor(setting);
  let account = null;
  const result = runEngine(market, prepared, setting, costs,
    {engine: {...api, createAccount: config => (account = api.createAccount(config))}});
  return {result, account};
}

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
].map(indexed);
// A market with what the window generator needs: its first and last minute and each asset's observed minutes.
function indexed(m) {
  return {...m, first: Math.min(m.market.BTC.time[0], m.market.LINK.time[0]),
    last: Math.max(m.market.BTC.time.at(-1), m.market.LINK.time.at(-1)),
    has: Object.fromEntries(ASSETS.map(a => [a, new Set(m.market[a].time)]))};
}

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

// Markets and settings for comparisons that sit exactly ON a threshold: inputs the simulator accepts and no protocol
// run uses, chosen so that they land there. Every close is base x 2^k for a small whole k, so with no costs the
// products and quotients the simulators form are exact: a flat lookback puts expectedNetRatio on a 0 bps hurdle, a
// halving after a buy puts the exit value on a 5000 bps stop line (a quartering on a 7500 bps one). A horizon of a
// whole number of minutes plus 30 seconds puts the first frame after a target exactly 30 seconds late, the engine's
// outcome tolerance. A tiny allocation or a dust-sized account puts orders at or under the engine's floor of 1e-10
// dollars and positions under its floor of 1e-14 units.
function steppedMarket(seed, minutes, missing) {
  const random = mulberry32(seed);
  const series = base => {
    const time = [], close = [];
    for (let m = 0, k = 0; m < minutes; m++) {
      const move = random(), absent = random() < missing;
      if (move < 0.2) k = Math.min(4, k + 1); else if (move < 0.4) k = Math.max(-4, k - 1);
      if (!absent || m === 0) { time.push(START + m * MINUTE); close.push(base * 2 ** k); }
    }
    return {time: Float64Array.from(time), close: Float64Array.from(close)};
  };
  return {BTC: series(2 ** 15), LINK: series(16)};
}
const TIE_HORIZONS = [30, 60, 90, 150, 300].map(seconds => seconds * 1000);
const FREE = {feeBps: 0, slippageBps: 0, halfSpreadBps: 0};
const ON_THRESHOLD = {name: 'threshold',
  markets: [{name: 'stepped', market: steppedMarket(11, 3000, 0)}, {name: 'stepped with gaps', market: steppedMarket(12, 3000, 0.04)},
    {name: 'stepped and sparse', market: steppedMarket(13, 3000, 0.25)}].map(indexed),
  setting(random, family, n) {
    const setting = {horizonMs: TIE_HORIZONS[n % TIE_HORIZONS.length], bufferBps: pick(random, [0, 0, 0, 10]),
      stopLossBps: pick(random, [0, 2500, 5000, 5000, 7500])};
    if (family.includes('L')) setting.spanMs = pick(random, [1, 2, 3, 5, 30]) * MINUTE;
    else setting.lookback = pick(random, [1, 1, 2, 3, 5]);
    if (family.includes('H')) setting.holdThrough = true;
    if (family.includes('R')) setting.reversal = true;
    if (family.includes('X')) setting.btcLed = true;
    // From $1,000: orders of 5e-11 to 1e-9 dollars. Or a whole account of 1.5e-10 to 1e-9 dollars.
    const size = random();
    if (size < 0.2) setting.allocationFraction = pick(random, [5e-14, 1e-13, 2e-13, 1e-12]);
    else if (size < 0.4) setting.initialCash = pick(random, [1.5e-10, 2e-10, 3e-10, 1e-9]);
    return setting;
  },
  costs: random => (random() < 0.75 ? {...FREE}
    : {feeBps: pick(random, [0, 2]), slippageBps: pick(random, [0, 2]), halfSpreadBps: pick(random, [0, 3])}),
  // A few minutes to six hours: at a half-minute horizon every frame decides.
  window(random, m) {
    const span = (m.last - m.first) / MINUTE, length = int(random, 2, 360);
    let start = m.first + int(random, 0, span - length) * MINUTE, end = start + length * MINUTE;
    if (random() < 0.3) start = oneSided(m, start, +1) ?? start;
    if (random() < 0.3) end = oneSided(m, end, -1) ?? end;
    return {start, end: Math.max(start, end)};
  }};

// A slow, literal model of engine.js ingest (same step order, same arithmetic) with the protocol's four rule
// changes written natively, as PROTOCOL.md defines them and its Readings 1 to 5 settle them. It is checked against
// an engine on every case (P directly; R, X and L through runEngine's emulation; hold-through on the engine with
// its decision branch replaced), so the native rule changes and the emulated ones are held to each other.
// `kept` counts held assets left untouched at a decision.
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
  // The comparison account: half the cash into each asset at the first frame by the engine's own buy fill (no
  // order of 1e-10 dollars or less, no position under 1e-14 units), held.
  const bench = {BTC: 0, LINK: 0};
  let benchCash = initialCash;
  for (const a of ASSETS) {
    const total = Math.min(initialCash / 2, benchCash);
    if (!(total > 1e-10)) continue;
    bench[a] = total / (1 + fee) / entry(a, frames[0]); benchCash = Math.max(0, benchCash - total);
    if (bench[a] < 1e-14) bench[a] = 0;
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

// What the engine's own ledger says a run contained, for the comparisons that sit exactly ON a threshold:
//   lateBy30s            forecasts settled exactly maxOutcomeLatenessMs (30 s) after their target
//   onHurdle             decisions whose expectedNetRatio equals the required ratio (not above it: no buy)
//   onStopLine           stop losses whose exit value equals the stop line (at or below it: stopped)
//   dustOrders           buy decisions with cash on hand that made no fill: an order of 1e-10 dollars or less
//   wipedBuys            buys that left under 1e-14 units, which the engine sets to nothing
//   benchmarkDustOrders, benchmarkWiped   the same two for the comparison account's two opening buys
const TIES = ['lateBy30s', 'onHurdle', 'onStopLine', 'dustOrders', 'wipedBuys', 'benchmarkDustOrders', 'benchmarkWiped'];
function census(account, t) {
  const {initialCash, allocationFraction, maxOutcomeLatenessMs} = account.config;
  assert.ok(allocationFraction > 0 && initialCash > 0, 'census: an order of exactly nothing is not a dust order');
  for (const f of account.forecasts) if (f.status === 'settled' && f.latenessMs === maxOutcomeLatenessMs) t.lateBy30s++;
  let cash = initialCash, benchmarkBuys = 0;
  account.ledger.forEach((entry, at) => {
    if (entry.type === 'stop_loss' && entry.netLiquidation === entry.costBasis * (1 - entry.thresholdBps / 10000)) t.onStopLine++;
    if (entry.type === 'trade' && entry.actor === 'benchmark') { benchmarkBuys++; if (entry.qty < 1e-14) t.benchmarkWiped++; }
    else if (entry.type === 'trade') { cash += entry.cashDelta; if (entry.side === 'buy' && entry.qty < 1e-14) t.wipedBuys++; }
    if (entry.type !== 'decision') return;
    if (entry.expectedNetRatio === entry.requiredNetRatio) t.onHurdle++;
    // The engine writes a buy decision and then fills it; no fill with cash on hand means the order was dust.
    const next = account.ledger[at + 1];
    const filled = next?.type === 'trade' && next.side === 'buy' && next.asset === entry.asset && next.time === entry.time;
    if (entry.action === 'buy' && cash > 0 && !filled) t.dustOrders++;
  });
  t.benchmarkDustOrders += 2 - benchmarkBuys;
}

// One differential block: `count` random cases of a family, every horizon and every market in turn. `variant`
// ({name, markets, setting, costs, window}) swaps in the on-threshold generators above and reads the engine's ledger.
const totals = {};
function fuzz(family, count, seed, variant = null) {
  const random = mulberry32(seed), markets = variant?.markets ?? MARKETS;
  const t = totals[variant ? `${variant.name} ${family}` : family] = {cases: 0, ran: 0, refused: 0, tooShort: 0, lowCoverage: 0,
    oneSided: 0, fills: 0, buys: 0, stops: 0, expired: 0, settled: 0, hits: 0, misses: 0, flat: 0, skipped: 0, historySkips: 0,
    stopSkips: 0, kept: 0, unlikeEngine: 0, inputs: new Set(), maxLookback: 0, ...Object.fromEntries(TIES.map(key => [key, 0]))};
  for (let n = 0; n < count; n++) {
    const lively = random() < 0.5, m = markets[n % markets.length];
    const setting = variant ? variant.setting(random, family, n) : randomSetting(random, family, n, lively);
    const costs = variant ? variant.costs(random) : randomCosts(random, lively);
    const window = variant ? variant.window(random, m) : randomWindow(random, m, setting.horizonMs);
    const prepared = prepareWindow(m.market, window);
    const label = `${variant ? `${variant.name} ` : ''}${family} #${n} on ${m.name} ${JSON.stringify({window, setting, costs})}`;
    const fast = simulate(m.market, prepared, setting, costs, {detail: true});
    const literal = reference(m.market, prepared, setting, costs);
    // Every case is judged by an engine (the one with its decision branch replaced for hold-through), and so is the
    // literal model.
    const {result: expected, account} = variant ? judgeWithLedger(m.market, prepared, setting, costs)
      : {result: judge(m.market, prepared, setting, costs)};
    agree(fast, expected, label);
    agree(literal, expected, `literal model, ${label}`);
    if (variant && expected.valid) census(account, t);
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
  // Amendment 1: "at least 40 valid design windows" to be eligible, "at least 20 valid confirmation windows" to be
  // confirmed. The rest of the constants are the first version's.
  assert.ok(Object.isFrozen(PROTOCOL));
  assert.deepEqual({...PROTOCOL}, {from: Date.parse('2020-01-01T00:00:00Z'), windowDays: 28, windowCount: 74, designCount: 50,
    minSharedFraction: 0.9, minValidDesignWindows: 40, minValidConfirmationWindows: 20});
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
  // The coverage floor is the caller's check (Reading 7: a low-coverage window is dropped for every setting before
  // any statistic is computed): the flag is the window's, not a run's, and a window below the floor still runs,
  // identically in both simulators.
  const low = simulate(market, strict, setting, costs, {detail: true});
  assert.equal(low.valid, true); assert.equal(low.decisions, 4);
  agree(low, runEngine(market, strict, setting, costs), 'window below the coverage floor');
  // "Invalid for every setting if fewer than 90% of its minutes are observed for both assets": of a 28-day window's
  // 40,320 minutes, 36,288 shared ones are exactly 90% and valid; 36,287 are not.
  const start = Date.UTC(2021, 0, 1), month = Float64Array.from({length: 40320}, (_, m) => start + m * MINUTE);
  const dense = {time: month, close: month.map(() => 100)}, without = gap => {
    const time = month.filter((_, m) => m < 20000 || m >= 20000 + gap);
    return {time, close: time.map(() => 10)};
  };
  const lacking = lost => prepareWindow({BTC: dense, LINK: without(lost)}, {start, end: start + 28 * DAY - MINUTE});
  const exactly = lacking(4032), under = lacking(4033);
  assert.deepEqual([exactly.shared, exactly.sharedFraction, exactly.valid, exactly.invalidReason], [36288, 0.9, true, null]);
  assert.deepEqual([under.shared, under.valid, under.invalidReason], [36287, false, 'insufficient shared coverage']);
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

test('runEngine: the engine file it names, an engine passed in, and hold-through only on an engine that holds through', async () => {
  // ENGINE_FILE is the repository's engine.js, and the module at that path is the one this file imports as unmodified.
  assert.ok(isAbsolute(ENGINE_FILE));
  assert.equal(ENGINE_FILE, fileURLToPath(new URL('../engine.js', import.meta.url)));
  const named = await import(pathToFileURL(ENGINE_FILE).href);
  assert.equal(named.ingest, unmodified.ingest);
  // Twenty hours of the bundled sample. Passing no engine, or the unmodified one, is the same run, and an engine
  // passed in is the one that runs: it sees every frame up to the one that completes the account.
  const m = MARKETS[0], prepared = prepareWindow(m.market, {start: m.first + 300 * MINUTE, end: m.first + 1500 * MINUTE});
  const setting = {horizonMs: 15 * MINUTE, lookback: 5, bufferBps: 0, stopLossBps: 0}, costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  const plain = runEngine(m.market, prepared, setting, costs);
  assert.ok(plain.valid && plain.fills > 0);
  for (const options of [{}, {engine: undefined}, {engine: null}, {engine: named}])
    assert.deepEqual(runEngine(m.market, prepared, setting, costs, options), plain, JSON.stringify(Object.keys(options)));
  let ingested = 0;
  const counting = {...unmodified, ingest: (account, frame) => { ingested++; return unmodified.ingest(account, frame); }};
  assert.deepEqual(runEngine(m.market, prepared, setting, costs, {engine: counting}), plain);
  assert.equal(ingested, prepared.shared);
  for (const broken of [{}, {createAccount: unmodified.createAccount, ingest: unmodified.ingest}, 'engine.js'])
    assert.throws(() => runEngine(m.market, prepared, setting, costs, {engine: broken}), /engine must be/);
  // Hold-through runs only on an engine passed in, and not on the unmodified engine passed back in.
  const held = {...setting, holdThrough: true};
  for (const options of [undefined, {}, {engine: unmodified}, {engine: named}])
    assert.throws(() => runEngine(m.market, prepared, held, costs, options), /holdThrough is not supported/);
  const oracle = runEngine(m.market, prepared, held, costs, {engine: holdThroughEngine});
  agree(simulate(m.market, prepared, held, costs, {detail: true}), oracle, 'hold-through on the engine passed in');
  assert.ok(oracle.fills > 0 && oracle.fills < plain.fills, `${oracle.fills} fills held through, ${plain.fills} by the engine's rule`);
  // Without warmup no run exists, whichever engine is passed.
  const early = prepareWindow(m.market, {start: m.first, end: m.first + 600 * MINUTE});
  assert.deepEqual(runEngine(m.market, early, held, costs, {engine: holdThroughEngine}), {valid: false, invalidReason: 'insufficient warmup'});
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
    agree(fast, judge(market, prepared, setting, free), JSON.stringify(setting));
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
    const fast = both(from, 79, {...minute, holdThrough: true});
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

// Hand-built markets below: [minute, close] rows from a fixed minute, and a run through both simulators and the
// literal model, which must agree before anything is asserted about it.
const HAND = Date.UTC(2024, 4, 6);
const rows = pairs => ({time: Float64Array.from(pairs, pair => HAND + pair[0] * MINUTE), close: Float64Array.from(pairs, pair => pair[1])});
const minutes = (from, to) => Array.from({length: to - from + 1}, (_, i) => from + i);
function byHand(market, [from, to], setting, costs = FREE) {
  const prepared = prepareWindow(market, {start: HAND + from * MINUTE, end: HAND + to * MINUTE}), label = JSON.stringify(setting);
  const fast = simulate(market, prepared, setting, costs, {detail: true}), expected = judge(market, prepared, setting, costs);
  agree(fast, expected, label);
  agree(reference(market, prepared, setting, costs), expected, `literal model, ${label}`);
  const {maxDrawdownPct, exposure, ...common} = fast;
  assert.deepEqual(simulateGrid(market, prepared, [setting], costs), [common], `simulateGrid, ${label}`);
  return {...fast, scoreStart: (prepared.scoreStart - HAND) / MINUTE, scoreEnd: (prepared.scoreEnd - HAND) / MINUTE};
}
const counts = (run, asset) => [run.perAsset[asset].forecasts, run.perAsset[asset].buys];

test('Reading 1 by hand: rows are kept from max(60, 2 x lookback + 10) minutes before the first shared minute, and lookback + 1 are needed', () => {
  // Lookback 30: 70 minutes of warmup, 31 rows needed. LINK has every minute from -100. BTC has thirty old rows and
  // then minutes 0..20, so the window from minute -5 has its first shared minute at 0. BTC closed at 90 up to minute
  // -70, at 110 on its later old rows and at 100 from minute 0: its test says buy only against a close of 90.
  const setting = {horizonMs: MINUTE, lookback: 30, bufferBps: 0, stopLossBps: 0}, window = [-5, 20];
  const market = old => ({BTC: rows([...old, ...minutes(0, 20)].map(m => [m, m < -69 ? 90 : m < 0 ? 110 : 100])),
    LINK: rows(minutes(-100, 20).map(m => [m, 10]))});
  // Old rows -70..-41: with minute 0 that is exactly 31 rows from minute -70 on, so the run exists. The first
  // decision reads the row exactly 70 minutes back (the 31st from the end) and buys BTC; the next reads minute -69.
  const exact = byHand(market(minutes(-70, -41)), window, setting);
  assert.deepEqual([exact.valid, exact.scoreStart, exact.decisions, exact.fills, exact.finalValue], [true, 0, 20, 2, 1000]);
  assert.deepEqual([counts(exact, 'BTC'), counts(exact, 'LINK')], [[20, 1], [20, 0]]);
  // The oldest row one minute further back (-71): not kept, 30 rows, refused. And thirty rows that all lie within
  // 70 minutes of the window's nominal start (-75..-46) but not of the first shared minute: 26 kept, refused.
  for (const old of [[-71, ...minutes(-69, -41)], minutes(-75, -46)]) {
    const short = byHand(market(old), window, setting);
    assert.deepEqual([short.valid, short.invalidReason, short.scoreStart], [false, 'insufficient warmup', 0]);
  }
  // Reading 4, last sentence: under BTC-led the refusal still applies to each asset's own series. With the two
  // series swapped it is LINK that has 31 rows or 30, and LINK's own history is never read.
  const swap = ({BTC, LINK}) => ({BTC: LINK, LINK: BTC}), led = {...setting, btcLed: true};
  const ledExact = byHand(swap(market(minutes(-70, -41))), window, led);
  assert.deepEqual([ledExact.valid, ledExact.decisions, ledExact.fills, counts(ledExact, 'LINK')], [true, 20, 0, [20, 0]]);
  assert.equal(byHand(swap(market([-71, ...minutes(-69, -41)])), window, led).invalidReason, 'insufficient warmup');
  // "Family L has no such refusal; a decision without a usable past is skipped": a 75-minute span on the same
  // market runs. Its decisions at minutes 0..4 want BTC's minutes -75..-71, before BTC's first row, and are skipped;
  // the one at minute 5 finds minute -70 (a close of 90: bought), the later ones find closes of 110.
  const long = byHand(market(minutes(-70, -41)), window, {horizonMs: MINUTE, spanMs: 75 * MINUTE, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([long.valid, long.decisions, counts(long, 'BTC'), counts(long, 'LINK')], [true, 20, [15, 1], [20, 0]]);
});

test('Reading 2 by hand: the session ends at the last shared minute, and only decisions within one horizon of it change', () => {
  // Five-minute horizon. BTC rises 1% a minute, so its test always says buy; LINK is flat, so its test never does.
  const setting = {horizonMs: 5 * MINUTE, lookback: 1, bufferBps: 0, stopLossBps: 0};
  const btc = (last, scale = () => 1) => rows(minutes(-1, last).map(m => [m, Math.round(3000000 * 1.01 ** m * scale(m)) / 100]));
  const link = last => rows(minutes(-1, last).map(m => [m, 15]));
  // Every minute observed: decisions at 0, 5, 10 and 15; the forecast issued at 15 targets minute 20, the end.
  const full = byHand({BTC: btc(20), LINK: link(20)}, [0, 20], setting);
  assert.deepEqual([full.scoreEnd, full.decisions, full.fills, counts(full, 'BTC'), counts(full, 'LINK')], [20, 4, 8, [4, 4], [4, 0]]);
  // LINK's last three minutes missing: the session ends at 17. The decision at 15 would pass it and is skipped
  // (BTC, sold by that decision's close, is not bought back); the decisions at 0, 5 and 10 are the same.
  const at17 = byHand({BTC: btc(20), LINK: link(17)}, [0, 20], setting);
  assert.deepEqual([at17.scoreEnd, at17.decisions, at17.fills, counts(at17, 'BTC'), counts(at17, 'LINK')], [17, 4, 6, [3, 3], [3, 0]]);
  // LINK's last five minutes missing: the session ends at 15, which completes the run instead of deciding. Either
  // way BTC was last sold at minute 15, so the money is the same.
  const at15 = byHand({BTC: btc(20), LINK: link(15)}, [0, 20], setting);
  assert.deepEqual([at15.scoreEnd, at15.decisions, at15.fills, counts(at15, 'BTC')], [15, 3, 6, [3, 3]]);
  assert.equal(at15.finalValue, at17.finalValue);
  assert.ok(full.finalValue > at17.finalValue && at17.finalValue > 1000);
  // No price is involved: BTC's closes after the last shared minute can be anything.
  const garbled = byHand({BTC: btc(20, m => (m > 17 ? 1000 : 1)), LINK: link(17)}, [0, 20], setting);
  assert.deepEqual(garbled, at17);
});

test('Reading 4 by hand: a BTC stop-out does not skip LINK, an unusable BTC history does', () => {
  // BTC closes 100, 100, 100, 110, 108, 108, 108, 108 and LINK stays at 7. Lookback 3, one-minute horizon, a 100 bps
  // stop, the window from minute 3. Both are bought at minute 3 on BTC's 10% rise. At minute 4 BTC, down 1.8%, is
  // stopped out and its decision skipped; LINK still decides on BTC's drift (100 to 108) and is bought again.
  const closes = [100, 100, 100, 110, 108, 108, 108, 108];
  const market = {BTC: rows(closes.map((close, m) => [m, close])), LINK: rows(closes.map((_, m) => [m, 7]))};
  const led = byHand(market, [3, 7], {horizonMs: MINUTE, lookback: 3, bufferBps: 0, stopLossBps: 100, btcLed: true});
  assert.deepEqual([led.decisions, led.stops, led.fills, counts(led, 'BTC'), counts(led, 'LINK')], [4, 1, 10, [3, 2], [4, 3]]);
  // On its own history LINK, flat, is never bought.
  const own = byHand(market, [3, 7], {horizonMs: MINUTE, lookback: 3, bufferBps: 0, stopLossBps: 100});
  assert.deepEqual([own.stops, counts(own, 'BTC'), counts(own, 'LINK')], [1, [3, 2], [4, 0]]);
  // "BTC's forecast is unavailable" is BTC's drift not being computable from BTC's history. That cannot happen in
  // the searched grid once the warmup refusal has passed; long lookback with BTC-led (not searched) shows the rule.
  // BTC is observed at minute 0 and from minute 62, LINK every minute; the span is 30 minutes. At minute 91 BTC wants
  // minute 61 and has only minute 0, 61 minutes older: no BTC forecast, so LINK is skipped too, although LINK's own
  // minute 61 exists. At minute 90 (minute 0 is exactly 60 minutes older) and from 92 both decide.
  const gapped = {BTC: rows([0, ...minutes(62, 100)].map(m => [m, 40000 + 40 * m])), LINK: rows(minutes(0, 100).map(m => [m, 20 + m / 50]))};
  const span = {horizonMs: MINUTE, spanMs: 30 * MINUTE, bufferBps: 0, stopLossBps: 0};
  const skipped = byHand(gapped, [90, 96], {...span, btcLed: true});
  assert.deepEqual([skipped.decisions, counts(skipped, 'BTC'), counts(skipped, 'LINK')], [6, [5, 5], [5, 5]]);
  const alone = byHand(gapped, [90, 96], span);
  assert.deepEqual([alone.decisions, counts(alone, 'BTC'), counts(alone, 'LINK')], [6, [5, 5], [6, 6]]);
});

// Five comparisons in fastsim.mjs whose wrong edits a verifier found passing this file. A protocol run has whole-
// minute horizons, $1,000 and half of it per asset. For each comparison: what a protocol run would need to reach it,
// and whether any other input with whole-minute closes and $1,000 does.
//   1 planAsset: an outcome at most 30 s late settles.  A protocol run never: at whole-minute horizons an outcome is
//     0 or at least 60 s late. A horizon that ends on a half minute reaches it.
//   2 buy: no order of 1e-10 dollars or less.  A protocol run only with an account fallen to about 2e-10 dollars or,
//     under hold-through, cash of 1e-10 dollars or less left by an earlier buy (a kept position matching the cash to
//     13 digits). An allocation near 1e-13, where the protocol fixes one half, reaches it.
//   3 benchmark: the same floor for the comparison account.  Its two orders are half the starting cash, $500 each,
//     whatever the prices, the costs and the setting: with $1,000 no input can tell a wrong edit of this comparison
//     from the right one. It is pinned below only with accounts of 2e-10 and 3e-10 dollars.
//   4 buy: no position under 1e-14 units.  A protocol run only at a close above 5e16 dollars (for a $500 order). An
//     allocation near 2e-13 reaches it: the money involved (2e-10 dollars) is far inside the 1e-9 tolerance, so it
//     shows in the exposure and, under hold-through, in the fills.
//   5 benchmark: the same floor.  Only at a close above 5e16 dollars, in a protocol run or any other with $1,000.
// The two hand-built tests that follow and the on-threshold block of the fuzz reach all five on inputs of that kind
// (and on dust-sized accounts), which the simulator accepts and the protocol never uses. They show that the
// simulator agrees with the engine there, and nothing about a protocol run: that is what the rest of this file is for.
test('outside the protocol\'s inputs, by hand: an outcome exactly 30 seconds late settles, one 90 seconds late expires', () => {
  // BTC rises and LINK falls 0.1% a minute; both lack minute 6. One observation of lookback, no costs, no buffer:
  // BTC's test says buy at every decision, LINK's never.
  const observed = [...minutes(0, 5), ...minutes(7, 10)];
  const market = {BTC: rows(observed.map(m => [m, Math.round(3000000 * 1.001 ** m) / 100])),
    LINK: rows(observed.map(m => [m, Math.round(15000 * 0.999 ** m) / 1000]))};
  const outcomes = (run, asset) => { const c = run.perAsset[asset]; return [c.forecasts, c.settled, c.expired, c.directionHits]; };
  // A 30-second horizon decides on every frame. Each forecast is resolved by the next frame, 30 seconds after its
  // target, except the one issued at minute 5, which waits for minute 7: 90 seconds late.
  const half = byHand(market, [1, 10], {horizonMs: 30000, lookback: 1, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([half.decisions, half.fills, outcomes(half, 'BTC'), outcomes(half, 'LINK')], [8, 16, [8, 7, 1, 7], [8, 7, 1, 7]]);
  // A 90-second horizon decides at minutes 1, 3, 5, 7 and 9: each target (2.5, 4.5, 6.5, 8.5) is followed 30 seconds
  // later by a frame, and the forecast at minute 9 would pass the end.
  const oneAndHalf = byHand(market, [1, 10], {horizonMs: 90000, lookback: 1, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([oneAndHalf.decisions, oneAndHalf.fills, outcomes(oneAndHalf, 'BTC'), outcomes(oneAndHalf, 'LINK')],
    [5, 8, [4, 4, 0, 4], [4, 4, 0, 4]]);
  // At a whole minute the same gap makes the outcome 60 seconds late and every other one exactly on time.
  const whole = byHand(market, [1, 10], {horizonMs: MINUTE, lookback: 1, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([whole.decisions, outcomes(whole, 'BTC')], [8, [8, 7, 1, 7]]);
  // The tolerance from both sides: at a 45-second horizon the next frame is 15 seconds late and settles the forecast;
  // at a 20-second horizon it is 40 seconds late, and every forecast expires.
  const early = byHand(market, [1, 10], {horizonMs: 45000, lookback: 1, bufferBps: 0, stopLossBps: 0});
  const late = byHand(market, [1, 10], {horizonMs: 20000, lookback: 1, bufferBps: 0, stopLossBps: 0});
  assert.deepEqual([outcomes(early, 'BTC'), outcomes(late, 'BTC'), outcomes(late, 'LINK')], [[8, 7, 1, 7], [8, 0, 8, 0], [8, 0, 8, 0]]);
});

test('outside the protocol\'s inputs, by hand: no order of 1e-10 dollars or less, no position under 1e-14 units', () => {
  // BTC doubles into minute 1 and then stays; LINK stays at 16 and halves on the last minute. No costs, no buffer,
  // one observation of lookback: the only buy the rule ever wants is BTC at minute 1, sold at minute 2.
  const market = (scale, later = 2 ** 15) => ({BTC: rows([2 ** 14, 2 ** 15, ...Array(4).fill(later)].map((close, m) => [m, close * scale])),
    LINK: rows([16, 16, 16, 16, 16, 8].map((close, m) => [m, close]))});
  const rule = {horizonMs: MINUTE, lookback: 1, bufferBps: 0, stopLossBps: 0};
  const run = (setting, scale = 1, later = undefined) => {
    const r = byHand(market(scale, later), [1, 5], {...rule, ...setting});
    return [r.fills, r.perAsset.BTC.buys, r.exposure.BTC, r.finalValue, r.buyHoldValue];
  };
  // The protocol's own sizes: $500 of BTC, 500 / 32768 units, held for one of the five frames. The comparison
  // account ends with its $500 of BTC and half its $500 of LINK.
  assert.deepEqual(run({}), [2, 1, 0.2, 1000, 750]);
  // $1,000 with an allocation of 5e-14: an order of 5e-11 dollars is not made.
  assert.deepEqual(run({allocationFraction: 5e-14}), [0, 0, 0, 1000, 750]);
  // $1,000 with an allocation of 2e-13: an order of 2e-10 dollars is made, buys 6.1e-15 BTC, and the engine sets a
  // position that small to nothing. The fill is counted, nothing is held, and the 2e-10 dollars are gone.
  assert.ok(1000 * 2e-13 > 1e-10 && 1000 * 2e-13 / 2 ** 15 < 1e-14);
  assert.deepEqual(run({allocationFraction: 2e-13}), [1, 1, 0, 1000 - 1000 * 2e-13, 750]);
  // An account of 2e-10 dollars: half of it is exactly 1e-10, which is not above the floor. Neither account buys.
  assert.equal(2e-10 / 2, 1e-10);
  assert.deepEqual(run({initialCash: 2e-10}), [0, 0, 0, 2e-10, 2e-10]);
  // An account of 3e-10 dollars: orders of 1.5e-10 are made. Both accounts' BTC (4.6e-15 units) is set to nothing;
  // the comparison account keeps its LINK, worth half of what it paid.
  assert.deepEqual(run({initialCash: 3e-10}), [1, 1, 0, 3e-10 / 2, 3e-10 / 4]);
  // $1,000 with BTC at 2^57 dollars: $500 buys 3.5e-15 units, which both accounts lose the same way.
  assert.ok(500 / 2 ** 57 < 1e-14);
  assert.deepEqual(run({}, 2 ** 42), [1, 1, 0, 500, 250]);
  // An account whose half buys exactly 1e-14 BTC: that is not under the floor, so the position stays, and a sale
  // needs more than the floor, so it is never sold. It is held on all five frames and still counted at its value.
  const stuck = 1e-14 * 2 ** 16;
  assert.equal(stuck / 2 / 2 ** 15, 1e-14);
  assert.deepEqual(run({initialCash: stuck}), [1, 1, 1, stuck, 0.75 * stuck]);
  // Reading 3, '"Held" means quantity above zero', at that floor: with BTC doubling again into minute 2 its test
  // says buy while exactly 1e-14 units are held. Hold-through keeps them and buys nothing more.
  assert.deepEqual(run({initialCash: stuck, holdThrough: true}, 1, 2 ** 16), [1, 1, 1, 1.5 * stuck, 1.25 * stuck]);
  // And with the two series swapped, so that it is LINK that is held at the floor and kept.
  const {BTC, LINK} = market(1, 2 ** 16), swapped = byHand({BTC: LINK, LINK: BTC}, [1, 5], {...rule, initialCash: stuck, holdThrough: true});
  assert.deepEqual([swapped.fills, swapped.perAsset.LINK.buys, swapped.exposure.LINK, swapped.finalValue], [1, 1, 1, 1.5 * stuck]);
});

test('differential fuzz: the fast simulator against the engine', async t => {
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

  await t.test('hold-through (H, and L with hold-through) against the engine with its decision branch replaced', () => {
    const f = fuzz('H', 196, 7), g = fuzz('LH', 84, 8);
    assert.ok(f.ran >= 120 && g.ran >= 60, `${f.ran} and ${g.ran} cases ran`);
    assert.ok(f.kept > 0 && g.kept > 0, 'positions were held through decisions');
    assert.ok(f.unlikeEngine > 0, 'holding through changed the fills against the engine rule');
    assert.ok(f.stops > 0 && f.buys > 0 && f.stopSkips > 0);
  });

  await t.test('outside the protocol\'s inputs: comparisons exactly on the 30-second tolerance, the buy hurdle, the stop line ' +
    'and the dust floors', t => {
    const cases = {P: 300, H: 150, R: 60, X: 60, L: 60, LH: 60}, families = Object.keys(cases);
    families.forEach((family, at) => fuzz(family, cases[family], 20 + at, ON_THRESHOLD));
    const of = family => totals[`threshold ${family}`], sum = key => families.reduce((n, family) => n + of(family)[key], 0);
    // The engine's ledger shows that each kind of tie occurred, under the app's rule and under hold-through.
    for (const family of ['P', 'H']) for (const key of TIES) assert.ok(of(family)[key] > 0, `on a threshold, ${family}: no ${key}`);
    for (const family of families) {
      const f = of(family);
      assert.ok(f.ran >= 0.7 * f.cases && f.buys > 0 && f.onHurdle > 0 && f.lateBy30s > 0, `on a threshold, ${family}: ${f.ran} of ${f.cases} ran`);
      t.diagnostic(`on a threshold, ${family}: ${f.cases} cases, ${f.ran} ran, ${f.fills} fills, ${f.stops} stop-outs, ${f.expired} expired; ` +
        TIES.map(key => `${key} ${f[key]}`).join(', '));
    }
    assert.ok(of('H').kept > 0 && of('LH').kept > 0 && sum('stops') > 0 && sum('expired') > 0);
    for (const horizon of TIE_HORIZONS) assert.ok(of('P').inputs.has(`horizon ${horizon / MINUTE}`), `no run at ${horizon / 1000} s`);
  });

  await t.test('the fuzz has teeth: buys, stop-outs, expired forecasts, skipped decisions and refused windows all occurred', t => {
    const unmodifiedJudged = ['P', 'R', 'X', 'L', 'RX', 'LRX'], all = [...unmodifiedJudged, 'H', 'LH'];
    const sum = (key, families = all) => families.reduce((n, family) => n + totals[family][key], 0);
    for (const key of ['ran', 'refused', 'lowCoverage', 'oneSided', 'fills', 'buys', 'stops', 'expired', 'settled', 'hits', 'misses',
      'flat', 'skipped', 'historySkips', 'stopSkips'])
      assert.ok(sum(key, unmodifiedJudged) > 0, `no ${key} among the cases judged by the unmodified engine`);
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

test('family X at the 60-minute horizon, which Amendment 1 added to its grid: all 480 settings agree with the engine fed BTC history for LINK', t => {
  // The first version's grid stopped family X at 15 minutes; the amended table searches "the five horizons up to 60
  // minutes", which adds 15 lookbacks x 8 buffers x 4 stops at 60 minutes. Every one of them runs here at the
  // protocol's costs on two days of a synthetic market with gaps and jumps, through simulateGrid (the search's own
  // path), simulate and the unmodified engine handed BTC's rows as LINK's history.
  const start = Date.UTC(2022, 5, 1), costs = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
  const market = syntheticMarket({seed: 607, start: start - DAY, minutes: 3 * 1440,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0.0001, volatility: 0.0012, jumpRate: 0.004, jumpSize: 0.012},
    LINK: {missing: 0.01, gapRate: 0.001, longGapRate: 0.0001, volatility: 0.0018, jumpRate: 0.004, jumpSize: 0.016}});
  const prepared = prepareWindow(market, {start, end: start + 2 * DAY - MINUTE});
  assert.equal(prepared.valid, true);
  const settings = [];
  for (const lookback of GRID_LOOKBACKS) for (const bufferBps of [0, 5, 10, 20, 40, 80, 160, 320]) for (const stopLossBps of [0, 100, 300, 1000])
    settings.push({horizonMs: 60 * MINUTE, lookback, bufferBps, stopLossBps, btcLed: true});
  assert.equal(settings.length, 480);
  const grid = simulateGrid(market, prepared, settings, costs);
  const seen = {decisions: 0, fills: 0, linkBuys: 0, stops: 0, expired: 0, traded: 0, unlikeOwnHistory: 0};
  settings.forEach((setting, at) => {
    const label = `X at 60 minutes ${JSON.stringify(setting)}`, fast = simulate(market, prepared, setting, costs, {detail: true});
    agree(fast, runEngine(market, prepared, setting, costs), label);
    const {maxDrawdownPct, exposure, ...common} = fast;
    assert.deepEqual(grid[at], common, `${label}: simulateGrid differs`);
    // The same setting on LINK's own history, to show that BTC's drift is what decided for LINK. "BTC unchanged":
    // on this market its forecasts, their outcomes and its buys are the same either way (their sizes need not be:
    // BTC shares its cash with LINK).
    const own = simulate(market, prepared, {...setting, btcLed: false}, costs);
    assert.deepEqual(own.perAsset.BTC, fast.perAsset.BTC, `${label}: BTC's forecasts and buys changed`);
    seen.decisions += fast.decisions; seen.fills += fast.fills; seen.linkBuys += fast.perAsset.LINK.buys; seen.stops += fast.stops;
    seen.expired += fast.perAsset.LINK.expired;
    if (fast.perAsset.LINK.buys > 0) seen.traded++;
    if (own.perAsset.LINK.buys !== fast.perAsset.LINK.buys) seen.unlikeOwnHistory++;
  });
  t.diagnostic(`480 settings on ${prepared.shared} frames: ${seen.decisions} hourly decisions, ${seen.fills} fills, ${seen.linkBuys} LINK buys ` +
    `(${seen.traded} settings bought LINK, ${seen.unlikeOwnHistory} bought it a different number of times than on LINK's own history), ` +
    `${seen.stops} stop-outs, ${seen.expired} expired LINK forecasts`);
  assert.ok(seen.decisions >= 480 * 40 && seen.traded >= 300 && seen.unlikeOwnHistory >= 300 && seen.stops > 0 && seen.expired > 0);

  // Reading 4 at this horizon, by hand: 240 observations of lookback, a 100 bps stop, the protocol's costs. BTC
  // climbs 5% over the three hours before minute 0, holds, and falls 2% in the minute before the decision at minute
  // 60. That decision stops BTC out and skips it, while LINK (flat, bought at minute 0 on BTC's drift) is bought
  // again: BTC is still up on its close of four hours earlier.
  const climb = m => (m <= -180 ? 30000 : m <= 0 ? 31500 + 1500 * m / 180 : m < 60 ? 31500 : 30870);
  const hand = {BTC: rows(minutes(-500, 180).map(m => [m, Math.round(climb(m) * 100) / 100])), LINK: rows(minutes(-500, 180).map(m => [m, 15]))};
  const led = byHand(hand, [0, 180], {horizonMs: 60 * MINUTE, lookback: 240, bufferBps: 0, stopLossBps: 100, btcLed: true}, costs);
  assert.deepEqual([led.decisions, led.stops, counts(led, 'BTC'), counts(led, 'LINK')], [3, 1, [2, 2], [3, 3]]);
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
    {horizonMs: 60 * MINUTE, lookback: 15, bufferBps: 10, stopLossBps: 300, btcLed: true},   // X at its longest horizon
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
