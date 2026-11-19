// The fast simulator's hold-through mode (research/fastsim.mjs with holdThrough: true) checked against the
// independent hold-through oracle (research/holdthrough-oracle.mjs: the real engine with only its scheduled-decision
// branch swapped), for family H and for long lookback with hold-through (family L with its switch on).
//
// Frames are built as research/engine-run.mjs builds them, which is how replay.js builds them, and ingested by the
// patched engine. Long lookback uses engine-run's crafted-history emulation: lookbackIntervals 1 with the two rows
// [past, last], or [last] alone when the rule says skip. engine-run.mjs does not export its frame construction, so
// it is repeated in replay() below, and every random case proves the copy: with hold-through off, these frames
// through the unmodified engine must give exactly what runEngine gives.
//
// The oracle's ledger is also read back (audit() below) to show what the compared runs contained: kept positions,
// sells on buy-to-cash and on skipped decisions, stop-outs of kept positions, and buys sized from E, not from cash.
//
// Simulated cash only. Two simulators agreeing says nothing about whether hold-through, or any setting, makes money.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../engine.js';
import {MINUTE, ASSETS, lowerBound, prepareWindow} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine} from './engine-run.mjs';
import {loadHoldThroughEngine} from './holdthrough-oracle.mjs';
import {mulberry32, syntheticMarket, sampleMarket} from './synthetic.mjs';

const holdThrough = await loadHoldThroughEngine();

// One window through an engine ({createAccount, ingest, getSummary}): engine-run.mjs runEngine with the engine
// passed in, less its reversal and BTC-led emulations. setting.holdThrough is not read: the engine passed in is
// the rule. Returns {result} in runEngine's shape, plus the account and frames when a run exists.
function replay(api, market, prepared, setting, costs) {
  const {horizonMs, bufferBps, stopLossBps, allocationFraction = 0.5, initialCash = 1000} = setting;
  const lookback = setting.lookback ?? undefined, spanMs = setting.spanMs ?? undefined;
  const {feeBps, slippageBps, halfSpreadBps} = costs;
  if (prepared.shared < 2) return {result: {valid: false, invalidReason: 'fewer than 2 shared minutes'}};
  const s = prepared.scoreStart, e = prepared.scoreEnd, long = spanMs !== undefined;
  const lookbackIntervals = long ? 1 : lookback;
  // app.js start(): warmupMinutes, historyLimit and requiredHistory of a range replay.
  const warmupMinutes = Math.max(60, 2 * lookbackIntervals + 10), historyLimit = lookbackIntervals + 1;
  // replay.js keeps rows from s - warmupMinutes; long lookback keeps them back to the oldest row the rule could use.
  const first = long ? s - spanMs - 60 * MINUTE : s - warmupMinutes * MINUTE;
  const series = {}, clock = {};
  for (const asset of ASSETS) {
    const {time, close} = market[asset], from = lowerBound(time, first), to = lowerBound(time, e + 1);
    series[asset] = Array.from({length: to - from}, (_, i) => ({time: time[from + i], price: close[from + i]}));
    clock[asset] = time.subarray(from, to);
  }
  // replay.js: no run unless lookback+1 causal observations exist at the scored start. Not applied to long lookback.
  if (!long) for (const asset of ASSETS)
    if (series[asset].filter(row => row.time <= s).length < lookbackIntervals + 1)
      return {result: {valid: false, invalidReason: 'insufficient warmup'}};
  const rows = (asset, at, time) => {
    if (!long) return series[asset].slice(Math.max(0, at - historyLimit + 1), at + 1);   // replay.js, verbatim
    // Long lookback: the latest observation at or before time - span, if at most 60 minutes older than that.
    const wanted = time - spanMs, past = lowerBound(clock[asset], wanted + 1) - 1;
    const usable = past >= 0 && wanted - clock[asset][past] <= 60 * MINUTE;
    return usable ? [series[asset][past], series[asset][at]] : [series[asset][at]];
  };
  // replay.js frame construction: BTC rows in [s, e] that LINK also has, assumed quotes around the close, and the
  // history as a lazy getter.
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
      get: () => Object.fromEntries(ASSETS.map(a => [a, rows(a, indices[a], row.time)]))});
    frames.push(frame);
  }
  assert.ok(frames.length && frames[0].time === s && frames.at(-1).time === e, 'scored boundary frames are missing');
  // app.js start() / replay.py run_replay: the scored span is the duration; ingest until the account completes.
  const account = api.createAccount({initialCash, horizonMs, feeBps, slippageBps, bufferBps, model: 'trend', mode: 'replay',
    durationMs: e - s, maxQuoteAgeMs: 60000, maxOutcomeLatenessMs: 30000, lookbackIntervals, allocationFraction,
    stopLossBps, maxDrawdownBps: 0, dailyLossBps: 0, cashYieldBps: 0});
  const held = {BTC: 0, LINK: 0};
  for (const frame of frames) {
    api.ingest(account, frame);
    for (const a of ASSETS) if (account.positions[a].qty > 0) held[a]++;
    if (account.status === 'completed') break;
  }
  const summary = api.getSummary(account), ledger = account.ledger;
  const trades = ledger.filter(ev => ev.type === 'trade' && ev.actor !== 'benchmark');
  const decisionFrames = new Set(ledger.filter(ev => ev.type === 'decision' || ev.type === 'decision_skipped').map(ev => ev.time));
  const perAsset = Object.fromEntries(ASSETS.map(a => {
    const forecasts = account.forecasts.filter(f => f.asset === a), counts = summary.perAsset[a];
    return [a, {forecasts: forecasts.length, settled: counts.count,
      expired: forecasts.filter(f => f.status === 'expired').length, directionHits: counts.directionHits,
      directionMisses: counts.directionMisses, directionFlat: counts.directionFlat,
      buys: trades.filter(t => t.asset === a && t.side === 'buy').length}];
  }));
  return {account, frames, result: {valid: true, invalidReason: null, finalValue: summary.equity, returnPct: summary.returnPct,
    buyHoldValue: summary.buyHoldEquity, buyHoldReturnPct: summary.buyHoldReturnPct, fills: summary.tradeCount,
    fees: summary.fees, stops: ledger.filter(ev => ev.type === 'stop_loss').length, decisions: decisionFrames.size,
    perAsset, maxDrawdownPct: summary.maxDrawdownPct,
    exposure: {BTC: held.BTC / frames.length, LINK: held.LINK / frames.length}}};
}

// What must agree (PROTOCOL.md, "Simulation": exact for counts, 1e-9 relative for floats): fills, stops, decisions
// and perAsset exactly; finalValue, fees, buyHoldValue and maxDrawdownPct to 1e-9 relative. Exposure (frames held
// over frames, a ratio of counts) is compared as well. `worst` keeps the largest relative difference seen.
const MONEY = ['finalValue', 'fees', 'buyHoldValue', 'maxDrawdownPct'];
const worst = {relative: 0, where: null, compared: 0, identical: 0};
function agree(fast, expected, label) {
  assert.equal(fast.valid, expected.valid, `${label}: valid`);
  assert.equal(fast.invalidReason, expected.invalidReason, `${label}: invalidReason`);
  if (!expected.valid) return;
  for (const key of ['fills', 'stops', 'decisions']) assert.equal(fast[key], expected[key], `${label}: ${key}`);
  assert.deepEqual(fast.perAsset, expected.perAsset, `${label}: perAsset`);
  for (const key of MONEY) {
    const a = fast[key], b = expected[key];
    assert.ok(Number.isFinite(a) && Number.isFinite(b), `${label}: ${key} is not finite`);
    const relative = a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
    worst.compared++;
    if (a === b) worst.identical++;
    if (relative > worst.relative) { worst.relative = relative; worst.where = `${key}, ${label}`; }
    assert.ok(relative <= 1e-9, `${label}: ${key}: ${a} != ${b}`);
  }
  assert.deepEqual(fast.exposure, expected.exposure, `${label}: exposure`);
}

function near(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected)), `${what}: ${actual} != ${expected}`);
}

// What a run through the oracle exercised, read from its ledger. A book (cash and quantities) is rebuilt from the
// trade entries alone, so E and the cash on hand at each buy are computed here, not taken from either simulator.
//   holds                  a held asset whose test says buy again and is left untouched (the kept position)
//   buyToCash              a held asset sold at a scheduled decision because its test says cash
//   historySkipSells       a held asset sold because its decision is skipped for insufficient history,
//   horizonSkipSells       or because its horizon extends past the session end
//   stopsAfterHold         a stop loss on a position that had been kept through at least one decision,
//   keptStoppedAtDecision  and those that fell on a scheduled decision frame (no same-frame reentry then applies)
//   fromE                  a buy beside a kept position that spent allocationFraction x E, visibly more than
//                          allocationFraction x cash,
//   cappedByCash           or all the cash on hand, because allocationFraction x E was more than that
//   handoffs               a buy at a decision that sold the other asset (E counts the position just sold)
const TALLY = ['holds', 'buyToCash', 'historySkipSells', 'horizonSkipSells', 'stopsAfterHold', 'keptStoppedAtDecision',
  'fromE', 'cappedByCash', 'handoffs'];
const newTally = () => Object.fromEntries(TALLY.map(key => [key, 0]));
function audit(account, frames, seen, label) {
  const {initialCash, allocationFraction, feeBps, slippageBps} = account.config;
  const quotes = new Map(frames.map(frame => [frame.time, frame.quotes]));
  // What one unit nets on exit: the bid less slippage and the exit fee (engine liquidation()).
  const exit = (time, asset) => quotes.get(time)[asset].bid * (1 - slippageBps / 10000) * (1 - feeBps / 10000);
  const book = {cash: initialCash, BTC: 0, LINK: 0}, kept = {BTC: false, LINK: false};
  const apply = trade => {
    book.cash += trade.cashDelta;
    if (trade.side === 'sell') book[trade.asset] = 0;
    else { book[trade.asset] += trade.qty; kept[trade.asset] = false; }
  };
  const own = account.ledger.filter(entry => entry.actor !== 'benchmark' &&
    ['trade', 'decision', 'decision_skipped', 'stop_loss', 'complete'].includes(entry.type));
  for (let at = 0; at < own.length;) {
    const time = own[at].time, now = [];
    while (at < own.length && own[at].time === time) now.push(own[at++]);
    const deciding = now.some(entry => entry.type === 'decision' || entry.type === 'decision_skipped');
    // Stop losses run first (unchanged engine code), each followed by its own sale.
    while (now[0]?.type === 'stop_loss') {
      const [stop, sale] = now.splice(0, 2);
      if (kept[stop.asset]) { seen.stopsAfterHold++; if (deciding) seen.keptStoppedAtDecision++; }
      apply(sale);
    }
    if (!deciding) { now.filter(entry => entry.type === 'trade').forEach(apply); continue; }   // the final close
    // "Let E be the account's net liquidation value at that frame before any trade" of the decision.
    const E = book.cash + ASSETS.reduce((sum, asset) => sum + book[asset] * exit(time, asset), 0), cashBefore = book.cash;
    const record = Object.fromEntries(ASSETS.map(asset => [asset, now.find(entry => entry.type !== 'trade' && entry.asset === asset)]));
    const sold = new Set();
    for (const entry of now) {
      if (entry.type !== 'trade') {
        if (entry.action === 'hold') { seen.holds++; kept[entry.asset] = true; }
        continue;
      }
      const mine = record[entry.asset], other = record[ASSETS.find(asset => asset !== entry.asset)];
      if (entry.side === 'sell') {
        sold.add(entry.asset);
        if (mine.type === 'decision') { assert.equal(mine.action, 'cash', label); seen.buyToCash++; }
        else if (/^Horizon/.test(mine.reason)) seen.horizonSkipSells++;
        else { assert.match(mine.reason, /^Insufficient/, label); seen.historySkipSells++; }
      } else {
        const spend = -entry.cashDelta;
        near(spend, Math.min(allocationFraction * E, book.cash), `${label}: a buy is min(allocationFraction x E, available cash)`);
        if (other.action === 'hold') {
          if (allocationFraction * E > book.cash) seen.cappedByCash++;
          else if (spend > allocationFraction * cashBefore * (1 + 1e-6)) seen.fromE++;
        } else if (sold.has(other.asset)) seen.handoffs++;
      }
      apply(entry);
    }
  }
  near(book.cash, account.cash, `${label}: cash rebuilt from the ledger`);
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-built runs: one per sentence of the protocol's hold-through paragraph, with the expected numbers worked out
// by hand. No spread, no slippage, a 10 bps fee each way, a 10 bps buffer, a one-observation lookback: the engine's
// test says buy after a minute that rose about 1% and cash after a flat or falling one. $1,000 at the start, so the
// first buy spends $500, fee included, which is 500 / 1.001 / 100 BTC at a close of 100.

const T0 = Date.UTC(2024, 4, 1), FEE = 0.001, QTY = 500 / (1 + FEE) / 100;
const TINY_COSTS = {feeBps: 10, slippageBps: 0, halfSpreadBps: 0};

// One close per minute from minute -1 (the single warmup observation); null is a minute the asset did not observe.
// The window runs from minute 0 to the last close. Returns the fast simulator's detailed result, already compared
// with the oracle, and the unmodified engine's result on the same frames.
function tiny(setting, btc, link = btc.map(() => 10)) {
  const series = closes => {
    const rows = closes.map((close, i) => [T0 + (i - 1) * MINUTE, close]).filter(row => row[1] !== null);
    return {time: Float64Array.from(rows, row => row[0]), close: Float64Array.from(rows, row => row[1])};
  };
  const market = {BTC: series(btc), LINK: series(link)};
  const prepared = prepareWindow(market, {start: T0, end: T0 + (btc.length - 2) * MINUTE});
  const full = {lookback: 1, bufferBps: 10, stopLossBps: 0, holdThrough: true, ...setting}, label = JSON.stringify({full, btc, link});
  const fast = simulate(market, prepared, full, TINY_COSTS, {detail: true});
  agree(fast, replay(holdThrough, market, prepared, full, TINY_COSTS).result, label);
  return {fast, unmodified: runEngine(market, prepared, {...full, holdThrough: false}, TINY_COSTS)};
}

test('hand-built: a held asset whose test says buy again is left untouched', () => {
  // BTC rises 1% into minutes 0, 1 and 2; minute 3 ends the session. One buy, kept twice, one sale at the close.
  const {fast, unmodified} = tiny({horizonMs: MINUTE}, [99, 100, 101, 102.01, 102.01]);
  assert.deepEqual([fast.decisions, fast.fills, fast.stops, fast.perAsset.BTC.buys, fast.perAsset.LINK.buys], [3, 2, 0, 1, 0]);
  near(fast.finalValue, 500 + QTY * 102.01 * (1 - FEE), 'final value');
  near(fast.fees, 500 * FEE / (1 + FEE) + QTY * 102.01 * FEE, 'one entry fee and one exit fee');
  assert.equal(fast.perAsset.BTC.forecasts, 3);   // a kept position still gets its forecast at every decision
  assert.equal(unmodified.fills, 6);              // the engine's rule sells and rebuys at minutes 1 and 2
});

test('hand-built: a held asset whose test says cash is sold at that decision', () => {
  // BTC falls back into minute 2: sold there at 100, not at the final close of 95.
  const {fast} = tiny({horizonMs: MINUTE}, [99, 100, 101, 100, 95]);
  assert.deepEqual([fast.decisions, fast.fills, fast.perAsset.BTC.buys], [3, 2, 1]);
  near(fast.finalValue, 500 + QTY * 100 * (1 - FEE), 'final value');
  assert.equal(fast.exposure.BTC, 0.5);
});

test('hand-built: an unheld asset is bought with min(allocationFraction x E, available cash)', () => {
  // Two-minute horizon. BTC is bought at 100 and kept at minute 2, where LINK's test says buy for the first time.
  // E is the $500 cash plus BTC at its net exit value, 4.995 x 91 x 0.999 = $454.09: LINK gets half of E, $477.05,
  // not half of the cash ($250) and not all of it.
  const value = btc => QTY * btc * (1 - FEE), roundTrip = (1 - FEE) / (1 + FEE), link = [10, 10, 9.9, 10, 10, 10];
  const sized = tiny({horizonMs: 2 * MINUTE}, [99, 100, 90, 91, 91, 91], link).fast, E = 500 + value(91);
  near(E, 954.0909090909091, 'E');
  assert.deepEqual([sized.decisions, sized.fills, sized.perAsset.BTC.buys, sized.perAsset.LINK.buys], [2, 4, 1, 1]);
  near(sized.finalValue, 500 - E / 2 + value(91) + E / 2 * roundTrip, 'final value, LINK bought with half of E');
  near(sized.fees, 500 * FEE / (1 + FEE) + QTY * 91 * FEE + E / 2 * FEE / (1 + FEE) + E / 2 / (1 + FEE) * FEE, 'fees');
  // With BTC up at 106.05, half of E is $514.60 but only $500 is on hand: LINK gets the $500.
  const capped = tiny({horizonMs: 2 * MINUTE}, [99, 100, 105, 106.05, 106.05, 106.05], link).fast;
  assert.ok((500 + value(106.05)) / 2 > 500);
  near(capped.finalValue, value(106.05) + 500 * roundTrip, 'final value, LINK bought with all the cash');
});

test('hand-built: sells come first, so a LINK exit funds a BTC entry at the same decision', () => {
  // LINK (10 x QTY of it) doubles and slips: at minute 2 its test says cash while BTC's says buy. Half of E is
  // $749, more than the $500 on hand until LINK is sold.
  const {fast} = tiny({horizonMs: 2 * MINUTE}, [100, 100, 99, 100, 100, 100], [9.9, 10, 21, 20, 20, 20]);
  const E = 500 + 10 * QTY * 20 * (1 - FEE);
  assert.deepEqual([fast.fills, fast.perAsset.BTC.buys, fast.perAsset.LINK.buys], [4, 1, 1]);
  near(fast.finalValue, E / 2 + E / 2 * (1 - FEE) / (1 + FEE), 'final value');
});

test('hand-built: the stop loss of a kept position is measured from its original entry cost', () => {
  // Two-minute horizon, 3% stop. Bought at 100 for $500; kept at 110 (minute 2) and at 107.5 (minute 4). The close
  // of 106 at minute 3 is 3.6% under 110 but still nets $528.94: no stop. The close of 97 at minute 5 nets $484.03,
  // under 97% of $500: stopped out there.
  const {fast, unmodified} = tiny({horizonMs: 2 * MINUTE, stopLossBps: 300}, [99, 100, 104, 110, 106, 107.5, 97, 97]);
  assert.deepEqual([fast.decisions, fast.fills, fast.stops, fast.perAsset.BTC.buys], [3, 2, 1, 1]);
  near(fast.finalValue, 500 + QTY * 97 * (1 - FEE), 'final value');
  assert.equal(fast.exposure.BTC, 5 / 7);
  // The engine's rule rebuys at 110, is stopped at minute 3 (106), rebuys at 107.5 and is stopped again at minute 5.
  assert.deepEqual([unmodified.stops, unmodified.fills], [2, 6]);
});

test('hand-built: a kept position stopped out on a decision frame is not bought back on that frame', () => {
  // Two-minute horizon, 3% stop. LINK has no minute 3, so minute 3 is not a frame, but BTC's own history has its
  // close of 90 there. BTC is bought at 100 and kept at 110. At minute 4, a decision frame, its close of 96 nets
  // $479.04, under 97% of $500: stopped out. Its test (90 to 96) would say buy, but the decision is skipped: no
  // forecast and no reentry. Minute 6 buys it back with half of E, which is then all cash.
  const {fast, unmodified} = tiny({horizonMs: 2 * MINUTE, stopLossBps: 300}, [99, 100, 104, 110, 90, 96, 97, 98.5, 98.5, 98.5],
    [10, 10, 10, 10, null, 10, 10, 10, 10, 10]);
  assert.deepEqual([fast.decisions, fast.fills, fast.stops, fast.perAsset.BTC.buys], [4, 4, 1, 2]);
  assert.deepEqual([fast.perAsset.BTC.forecasts, fast.perAsset.LINK.forecasts], [3, 4]);
  const cash = 500 + QTY * 96 * (1 - FEE);
  near(fast.finalValue, cash / 2 + cash / 2 * (1 - FEE) / (1 + FEE), 'final value');
  assert.equal(fast.exposure.BTC, 5 / 8);
  assert.deepEqual([unmodified.stops, unmodified.fills], [1, 6]);   // the engine's rule also sold and rebought at 110
});

test('hand-built: a decision whose horizon passes the session end sells a held asset', () => {
  // Two-minute horizon, three-minute session: the decision at minute 2 is skipped, so BTC is sold there at 102,
  // not at the final 103, although its own test would say buy. This is the unmodified engine's run.
  const {fast, unmodified} = tiny({horizonMs: 2 * MINUTE}, [99, 100, 101, 102, 103]);
  assert.deepEqual([fast.decisions, fast.fills, fast.perAsset.BTC.forecasts], [2, 2, 1]);
  near(fast.finalValue, 500 + QTY * 102 * (1 - FEE), 'final value');
  agree(fast, unmodified, 'the position the engine would be in');
});

test('hand-built, long lookback: a decision skipped for insufficient history sells a held asset; the rebuy is sized from E', () => {
  // No costs, one-minute horizon, 30-minute span. LINK is observed every minute; BTC at minute 0 and from minute
  // 62. Minute 90 wants BTC's minute 60 and finds minute 0, exactly 60 minutes older: used, and both are bought
  // with $500. Minute 91 wants minute 61 and finds minute 0, 61 minutes older: BTC's decision is skipped, so BTC
  // is sold while LINK is kept. Minute 92 finds minute 62: BTC is bought again with half of E, which is less than
  // the cash on hand because LINK has dipped under its entry price (its 30-minute drift is still up, so it is kept).
  const free = {feeBps: 0, slippageBps: 0, halfSpreadBps: 0}, T = Date.UTC(2024, 4, 2);
  const P = m => 40000 + 40 * m, L = m => m < 92 ? 20 + 0.02 * m : 21.5 + 0.02 * (m - 92);
  const observed = (minutes, price) => ({time: Float64Array.from(minutes, m => T + m * MINUTE), close: Float64Array.from(minutes, price)});
  const all = Array.from({length: 101}, (_, m) => m);
  const market = {BTC: observed(all.filter(m => m === 0 || m >= 62), P), LINK: observed(all, L)};
  const prepared = prepareWindow(market, {start: T + 90 * MINUTE, end: T + 96 * MINUTE});
  const setting = {horizonMs: MINUTE, spanMs: 30 * MINUTE, bufferBps: 0, stopLossBps: 0, holdThrough: true};
  const fast = simulate(market, prepared, setting, free, {detail: true});
  const oracle = replay(holdThrough, market, prepared, setting, free);
  agree(fast, oracle.result, 'long lookback, history skip');
  assert.deepEqual([fast.decisions, fast.fills, fast.stops], [6, 6, 0]);
  assert.deepEqual([fast.perAsset.BTC.forecasts, fast.perAsset.BTC.buys, fast.perAsset.LINK.forecasts, fast.perAsset.LINK.buys], [5, 2, 6, 1]);
  const proceeds = 500 * P(91) / P(90), link = m => 500 * L(m) / L(90), E = proceeds + link(92);
  assert.ok(E / 2 < proceeds && E / 2 > proceeds / 2 + 100, 'half of E is neither capped by cash nor near half of the cash');
  near(fast.finalValue, proceeds - E / 2 + E / 2 * P(96) / P(92) + link(96), 'final value');
  assert.deepEqual(fast.exposure, {BTC: 5 / 7, LINK: 6 / 7});
  const seen = newTally();
  audit(oracle.account, oracle.frames, seen, 'long lookback, history skip');
  assert.deepEqual(seen, {...seen, holds: 8, historySkipSells: 1, fromE: 1, buyToCash: 0});
  // The engine's rule on the same frames sells and rebuys at every decision: five BTC and six LINK round trips.
  assert.equal(runEngine(market, prepared, {...setting, holdThrough: false}, free).fills, 22);
});

// ---------------------------------------------------------------------------------------------------------------
// Differential fuzz on the bundled sample and five synthetic markets.

const START = Date.UTC(2022, 2, 1), WEEK = 7 * 1440;
const MARKETS = [
  {name: 'bundled sample', market: sampleMarket()},
  {name: 'light gaps', market: syntheticMarket({seed: 111, start: START, minutes: WEEK,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0}, LINK: {missing: 0.008, gapRate: 0.001, longGapRate: 0}})},
  {name: 'heavy LINK gaps', market: syntheticMarket({seed: 222, start: START, minutes: WEEK,
    LINK: {missing: 0.12, gapRate: 0.012, gapMinutes: 25, longGapRate: 0.0006, longGapHours: 2}})},
  {name: 'outages and trends', market: syntheticMarket({seed: 333, start: START, minutes: WEEK, correlation: 0.85,
    BTC: {regimeDrift: 0.00015, jumpRate: 0.004, longGapRate: 0.0012, longGapHours: 4},
    LINK: {regimeDrift: 0.0002, jumpRate: 0.004, longGapRate: 0.0012, longGapHours: 4}})},
  {name: 'jumps', market: syntheticMarket({seed: 555, start: START, minutes: WEEK,
    BTC: {volatility: 0.0012, regimeDrift: 0.0002, jumpRate: 0.012, jumpSize: 0.015},
    LINK: {volatility: 0.0018, regimeDrift: 0.0003, jumpRate: 0.012, jumpSize: 0.02}})},
  // Long enough for every span the protocol searches (up to 28 days) to be covered before a window starts.
  {name: 'five weeks', long: true, market: syntheticMarket({seed: 444, start: START, minutes: 5 * WEEK,
    BTC: {missing: 0.004, gapRate: 0.0005, longGapRate: 0.0001}, LINK: {missing: 0.01, gapRate: 0.001, longGapRate: 0.0001}})},
].map(m => ({...m, first: Math.min(m.market.BTC.time[0], m.market.LINK.time[0]),
  last: Math.max(m.market.BTC.time.at(-1), m.market.LINK.time.at(-1)),
  has: Object.fromEntries(ASSETS.map(a => [a, new Set(m.market[a].time)]))}));
// Family L draws the long market three times in eight, at the horizons the protocol searches for L.
const ROTATION = {H: MARKETS, L: [...MARKETS, MARKETS.at(-1), MARKETS.at(-1)]};

const HORIZONS = [1, 5, 7, 15, 60, 420, 1440].map(minutes => minutes * MINUTE), LONG_HORIZONS = HORIZONS.slice(4);
const GRID_LOOKBACKS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240], GRID_BUFFERS = [0, 5, 10, 20, 40, 80, 160, 320];
const GRID_SPANS = [4, 8, 12, 24, 48, 72, 120, 168, 336, 672].map(hours => hours * 60 * MINUTE);   // 4h to 28d
const PROTOCOL_COSTS = {feeBps: 2, slippageBps: 2, halfSpreadBps: 3};
const int = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = (random, list) => list[Math.floor(random() * list.length)];

// The protocol's costs, its two cost-robustness reruns (fee 10 and 40), no costs at all, and anything else.
const FREE = {feeBps: 0, slippageBps: 0, halfSpreadBps: 0};
function randomCosts(random) {
  const kind = random();
  if (kind < 0.3) return {...PROTOCOL_COSTS};
  if (kind < 0.4) return {...PROTOCOL_COSTS, feeBps: pick(random, [10, 40])};
  if (kind < 0.5) return {...FREE};
  return {feeBps: pick(random, [0, 2, 2, 10, 40]), slippageBps: pick(random, [0, 2]), halfSpreadBps: pick(random, [0, 3, 10])};
}
// A hold-through setting and its costs: family H (lookback in observations) or family L with its switch on (a time
// span), every horizon in turn. Three kinds of case:
//   lively   short lookback or span and a small buffer: positions are opened, kept and closed often;
//   sticky   no costs and no buffer, so the buy test passes on any rise over the lookback, however long: positions
//            are kept for long stretches, until the drift turns or a stop loss takes them out;
//   roaming  the protocol's grid and beyond, including settings that never trade.
// Long lookback scales the drift by horizon over span, so at horizons under an hour its buy test passes only
// without costs and buffer: most of those cases are sticky.
function randomCase(random, family, n, m) {
  const long = family === 'L' && m.long, horizonMs = long ? LONG_HORIZONS[n % LONG_HORIZONS.length] : HORIZONS[n % HORIZONS.length];
  const kind = random(), sticky = kind < (family === 'L' && horizonMs < 60 * MINUTE ? 0.7 : 0.2), lively = !sticky && kind < 0.75;
  const setting = {horizonMs, holdThrough: true,
    bufferBps: sticky ? 0 : lively ? pick(random, [0, 0, 5, 10]) : random() < 0.7 ? pick(random, GRID_BUFFERS) : int(random, 0, 320),
    stopLossBps: pick(random, sticky ? [0, 5, 14, 30, 50, 100, 300] : [0, 0, 0, 5, 14, 50, 100, 300, 1000, 5000])};
  if (family === 'L') setting.spanMs = long ? pick(random, GRID_SPANS)
    : pick(random, lively ? [30, 60, 120, 240] : [30, 240, 480, 720, 1440]) * MINUTE;
  else setting.lookback = lively ? pick(random, [1, 1, 2, 3, 5, 7, 10]) : random() < 0.5 ? pick(random, GRID_LOOKBACKS) : int(random, 1, 240);
  if (random() < 0.2) setting.allocationFraction = pick(random, [0, 0.1, 0.25, 0.25, 0.4, 0.4]);
  if (random() < 0.1) setting.initialCash = pick(random, [250, 123456.78]);
  return {setting, costs: sticky ? {...FREE} : randomCosts(random)};
}
// The nearest minute from `time` in direction `step` that exactly one asset observed, if any is close.
function oneSided(m, time, step) {
  for (let t = time, n = 0; n < 240 && t >= m.first && t <= m.last; n++, t += step * MINUTE)
    if (m.has.BTC.has(t) !== m.has.LINK.has(t)) return t;
  return null;
}
function randomWindow(random, m, setting) {
  const room = (m.last - m.first) / MINUTE, horizon = setting.horizonMs / MINUTE;
  // The history a setting needs before its first decision: the app's warmup for a lookback (app.js start()), the
  // span and its 60-minute tolerance for long lookback.
  const warmup = setting.spanMs !== undefined ? setting.spanMs / MINUTE + 61 : Math.max(60, 2 * setting.lookback + 10);
  // A few hundred to a few thousand minutes and, where the market allows, more than one horizon.
  let length = int(random, 150, 1500) + Math.round(horizon * (1 + 3 * random()));
  if (random() < 0.04) length = int(random, 1, 60);
  length = Math.min(length, room - 10 - Math.min(warmup, Math.floor(room / 8)));
  // Mostly start where that history exists, so that few runs are refused or have every decision skipped.
  const covered = random() < 0.85 ? Math.min(warmup, room - length) : 0;
  let start = m.first + int(random, covered, room - length) * MINUTE;
  if (random() < 0.05) start = m.first + int(random, 0, 40) * MINUTE;   // too early for a lookback's warmup
  let end = start + length * MINUTE;
  // A first or last minute that one asset lacks: scoring moves to a shared minute.
  if (random() < 0.3) start = oneSided(m, start, +1) ?? start;
  if (random() < 0.3) end = oneSided(m, end, -1) ?? end;
  return {start, end: Math.max(start, end)};
}

function fuzz(family, count, seed) {
  const random = mulberry32(seed);
  const seen = {cases: 0, ran: 0, refused: 0, tooShort: 0, fills: 0, buys: 0, stops: 0, forecasts: 0, fewerFills: 0,
    ...newTally(), inputs: new Set(), keptBy: new Map(), maxSpanHeld: 0};
  for (let n = 0; n < count; n++) {
    const m = ROTATION[family][n % ROTATION[family].length];
    const {setting, costs} = randomCase(random, family, n, m), window = randomWindow(random, m, setting);
    const prepared = prepareWindow(m.market, window), plain = {...setting, holdThrough: false};
    const label = `${family} #${n} on ${m.name} ${JSON.stringify({window, setting, costs})}`;
    const fast = simulate(m.market, prepared, setting, costs, {detail: true});
    const oracle = replay(holdThrough, m.market, prepared, setting, costs);
    agree(fast, oracle.result, label);
    // The search runs without detail and through simulateGrid, where most frames are never visited and settings
    // that differ only in hold-through share one plan: both must be this same run.
    const {maxDrawdownPct, exposure, ...common} = fast;
    assert.deepEqual(simulate(m.market, prepared, setting, costs), common, `${label}: plain and detailed runs differ`);
    const grid = simulateGrid(m.market, prepared, [setting, plain, setting], costs);
    assert.deepEqual([grid[0], grid[2]], [common, common], `${label}: simulateGrid differs`);
    // The frames built here are engine-run's: with hold-through off, the unmodified engine gives runEngine's result.
    const unmodified = runEngine(m.market, prepared, plain, costs);
    assert.deepEqual(replay(engine, m.market, prepared, plain, costs).result, unmodified, `${label}: frames differ from engine-run's`);

    seen.cases++;
    if (!fast.valid) { if (fast.invalidReason === 'insufficient warmup') seen.refused++; else seen.tooShort++; continue; }
    const before = seen.holds;
    audit(oracle.account, oracle.frames, seen, label);
    seen.ran++; seen.fills += fast.fills; seen.stops += fast.stops;
    for (const a of ASSETS) { seen.buys += fast.perAsset[a].buys; seen.forecasts += fast.perAsset[a].forecasts; }
    if (fast.fills < unmodified.fills) seen.fewerFills++;
    const kept = seen.holds - before, horizon = setting.horizonMs / MINUTE;
    for (const key of [m.name, `horizon ${horizon}`]) seen.keptBy.set(key, (seen.keptBy.get(key) ?? 0) + kept);
    if (setting.spanMs) seen.inputs.add(`span ${setting.spanMs / MINUTE}`);
    if (kept && setting.spanMs) seen.maxSpanHeld = Math.max(seen.maxSpanHeld, setting.spanMs);
    for (const input of [m.name, `horizon ${horizon}`, `stop ${setting.stopLossBps}`, `fee ${costs.feeBps}`,
      `slippage ${costs.slippageBps}`, `half-spread ${costs.halfSpreadBps}`, `costs ${Object.values(costs)}`,
      kept ? (setting.stopLossBps ? 'kept with a stop' : 'kept without a stop') : 'nothing kept']) seen.inputs.add(input);
  }
  return seen;
}

const describe = f => `${f.cases} cases, ${f.ran} ran, ${f.refused} refused for warmup, ${f.tooShort} without two frames; ` +
  `${f.fills} fills, ${f.buys} buys, ${f.stops} stop-outs, ${f.forecasts} forecasts; kept ${f.holds}, sold on buy-to-cash ${f.buyToCash}, ` +
  `sold on a skip ${f.historySkipSells} (history) + ${f.horizonSkipSells} (horizon end), stop-outs of kept positions ${f.stopsAfterHold} ` +
  `(${f.keptStoppedAtDecision} on a decision frame), buys sized from E beside a kept position ${f.fromE}, capped by cash ${f.cappedByCash}, ` +
  `after selling the other asset ${f.handoffs}; ${f.fewerFills} runs with fewer fills than the engine's rule`;
const EVERYWHERE = [...MARKETS.map(m => m.name), ...HORIZONS.map(h => `horizon ${h / MINUTE}`)];   // each market, each horizon
const EVERY = [...EVERYWHERE, 'stop 0', 'stop 5', 'stop 14', 'stop 50', 'stop 100', 'stop 300', 'stop 1000',
  'stop 5000', 'kept with a stop', 'kept without a stop', 'fee 0', 'fee 2', 'fee 10', 'fee 40', 'slippage 0', 'slippage 2',
  'half-spread 0', 'half-spread 3', 'half-spread 10', 'costs 2,2,3', 'costs 10,2,3', 'costs 40,2,3'];

test('family H: hold-through in the fast simulator is the oracle\'s run', t => {
  const f = fuzz('H', 378, 71);
  t.diagnostic(`H: ${describe(f)}`);
  assert.ok(f.ran >= 150, `${f.ran} of ${f.cases} cases ran`);
  for (const input of EVERY) assert.ok(f.inputs.has(input), `no run with ${input}`);
  for (const key of EVERYWHERE) assert.ok(f.keptBy.get(key) > 0, `no position was kept: ${key}`);
  // Each sentence of the protocol paragraph was exercised, many times over.
  for (const [key, least] of Object.entries({holds: 3000, buyToCash: 1500, horizonSkipSells: 50, stopsAfterHold: 40,
    keptStoppedAtDecision: 10, fromE: 100, cappedByCash: 150, handoffs: 100, stops: 300, refused: 10, fewerFills: 80}))
    assert.ok(f[key] >= least, `${key}: ${f[key]} of at least ${least}`);
});

test('family L with hold-through: long lookback in the fast simulator is the oracle\'s run on crafted histories', t => {
  const f = fuzz('L', 224, 72);
  t.diagnostic(`L with hold-through: ${describe(f)}; longest span with a kept position ${f.maxSpanHeld / MINUTE / 1440} days`);
  assert.ok(f.ran >= 50, `${f.ran} of ${f.cases} cases ran`);
  assert.equal(f.refused, 0, 'the warmup refusal does not apply to long lookback');
  for (const input of EVERY) assert.ok(f.inputs.has(input), `no run with ${input}`);
  for (const key of EVERYWHERE) assert.ok(f.keptBy.get(key) > 0, `no position was kept: ${key}`);
  for (const span of GRID_SPANS) assert.ok(f.inputs.has(`span ${span / MINUTE}`), `no run with a span of ${span / MINUTE} minutes`);
  assert.ok(f.maxSpanHeld >= 7 * 1440 * MINUTE, 'no position was kept under a span of a week or more');
  for (const [key, least] of Object.entries({holds: 2000, buyToCash: 150, historySkipSells: 5, horizonSkipSells: 40, stopsAfterHold: 40,
    keptStoppedAtDecision: 10, fromE: 25, cappedByCash: 70, handoffs: 5, stops: 100, fewerFills: 40}))
    assert.ok(f[key] >= least, `${key}: ${f[key]} of at least ${least}`);
});

test('dense tiny runs: markets of a few minutes in which almost every decision buys, keeps, sells or stops something', t => {
  // Closes move by a few large steps, each asset misses minutes of its own, and a failure prints a market small
  // enough to follow by hand. Most long lookback runs have an old block of observations (minutes -200 to -190),
  // a three-hour gap and then the run, with a span that makes the past observation go from usable (at most 60
  // minutes older than wanted) to unusable mid-run: the insufficient-history skip, while positions are held.
  const random = mulberry32(73), seen = newTally(), T = Date.UTC(2024, 4, 3);
  let ran = 0, fills = 0, stops = 0;
  for (let n = 0; n < 4000; n++) {
    const minutes = int(random, 6, 19), family = random() < 0.7 ? 'H' : 'L', far = family === 'L' && random() < 0.6;
    const lookback = pick(random, [1, 1, 2, 3]), gap = pick(random, [0, 0, 0.1, 0.25]);
    const moves = pick(random, [[0.012, -0.006, -0.04, 0.03, 0], [0.006, -0.006, 0.02, -0.02], [0.004, -0.002, -0.012, 0.012, 0.0001]]);
    const series = price => {
      const rows = [];
      for (let m = far ? -200 : -8; m <= minutes; m++) {
        if (far && m > -190 && m < -8) continue;
        price *= 1 + pick(random, moves);
        if (m === 0 || m === minutes || random() >= gap) rows.push([m, Math.round(price * 1000) / 1000]);
      }
      return {time: Float64Array.from(rows, row => T + row[0] * MINUTE), close: Float64Array.from(rows, row => row[1])};
    };
    const market = {BTC: series(100), LINK: series(10)}, prepared = prepareWindow(market, {start: T, end: T + minutes * MINUTE});
    const quiet = far && random() < 0.8;   // drift over a three-hour span only passes the buy test without costs
    const setting = {horizonMs: pick(random, [1, 1, 2, 3, 5]) * MINUTE, holdThrough: true,
      bufferBps: quiet ? 0 : pick(random, [0, 0, 10, 40]), stopLossBps: pick(random, [0, 0, 30, 150, 300, 1000])};
    if (family === 'H') setting.lookback = lookback;
    else setting.spanMs = pick(random, far ? [125, 130, 135, 140, 150, 185, 195] : [1, 2, 3, 5]) * MINUTE;
    if (random() < 0.3) setting.allocationFraction = pick(random, [0.1, 0.3, 0.45]);
    const costs = quiet ? {...FREE} : pick(random, [FREE, {feeBps: 10, slippageBps: 0, halfSpreadBps: 0}, PROTOCOL_COSTS,
      {feeBps: 40, slippageBps: 2, halfSpreadBps: 10}]);
    // The whole market in the label, as [minute, close] rows: the window is minute 0 to the last one.
    const rows = ({time, close}) => Array.from(time, (at, i) => [(at - T) / MINUTE, close[i]]);
    const label = `tiny #${n} ${JSON.stringify({setting, costs, BTC: rows(market.BTC), LINK: rows(market.LINK)})}`;
    const fast = simulate(market, prepared, setting, costs, {detail: true});
    const oracle = replay(holdThrough, market, prepared, setting, costs), plain = {...setting, holdThrough: false};
    agree(fast, oracle.result, label);
    const {maxDrawdownPct, exposure, ...common} = fast;
    assert.deepEqual(simulateGrid(market, prepared, [setting, plain, setting], costs).filter((_, at) => at !== 1), [common, common],
      `${label}: simulateGrid differs`);
    assert.deepEqual(replay(engine, market, prepared, plain, costs).result, runEngine(market, prepared, plain, costs),
      `${label}: frames differ from engine-run's`);
    if (!fast.valid) continue;
    ran++; fills += fast.fills; stops += fast.stops;
    audit(oracle.account, oracle.frames, seen, label);
  }
  t.diagnostic(`4000 tiny cases, ${ran} ran; ${fills} fills, ${stops} stop-outs; ${TALLY.map(key => `${key} ${seen[key]}`).join(', ')}`);
  assert.ok(ran >= 3500, `${ran} cases ran`);
  for (const [key, least] of Object.entries({holds: 3000, buyToCash: 2000, historySkipSells: 50, horizonSkipSells: 300, stopsAfterHold: 100,
    keptStoppedAtDecision: 70, fromE: 150, cappedByCash: 250, handoffs: 350}))
    assert.ok(seen[key] >= least, `${key}: ${seen[key]} of at least ${least}`);
});

test('a protocol-sized window (28 days at the protocol costs) with hold-through is the oracle\'s run', t => {
  // The five-week market from its eighth day: 28 whole days, as the protocol's windows are.
  const m = MARKETS.at(-1), start = START + WEEK * MINUTE, day = 1440 * MINUTE;
  const prepared = prepareWindow(m.market, {start, end: start + 28 * day - MINUTE});
  assert.deepEqual([prepared.expected, prepared.valid, prepared.shared > 36000], [40320, true, true]);
  for (const setting of [
    {horizonMs: 7 * MINUTE, lookback: 7, bufferBps: 10, stopLossBps: 0},       // the app's default rule, held through
    {horizonMs: MINUTE, lookback: 2, bufferBps: 5, stopLossBps: 100},
    {horizonMs: 60 * MINUTE, lookback: 30, bufferBps: 20, stopLossBps: 300},
    {horizonMs: 1440 * MINUTE, lookback: 240, bufferBps: 0, stopLossBps: 1000},
    {horizonMs: 420 * MINUTE, spanMs: 2 * day, bufferBps: 0, stopLossBps: 300},
    {horizonMs: 60 * MINUTE, spanMs: 4 * 60 * MINUTE, bufferBps: 20, stopLossBps: 0},
    {horizonMs: 1440 * MINUTE, spanMs: 5 * day, bufferBps: 0, stopLossBps: 1000},
  ].map(setting => ({...setting, holdThrough: true}))) {
    const label = `28 days ${JSON.stringify(setting)}`;
    const fast = simulate(m.market, prepared, setting, PROTOCOL_COSTS, {detail: true});
    const oracle = replay(holdThrough, m.market, prepared, setting, PROTOCOL_COSTS);
    agree(fast, oracle.result, label);
    const {maxDrawdownPct, exposure, ...common} = fast;
    assert.deepEqual(simulateGrid(m.market, prepared, [setting], PROTOCOL_COSTS), [common], `${label}: simulateGrid differs`);
    const seen = newTally();
    audit(oracle.account, oracle.frames, seen, label);
    assert.ok(seen.holds > 0 && seen.buyToCash > 0, `${label}: no position was kept and later sold`);
    t.diagnostic(`${JSON.stringify(setting)}: ${fast.decisions} decisions, ${fast.fills} fills, ${fast.stops} stop-outs, kept ${seen.holds}, ` +
      `sized from E ${seen.fromE}, capped by cash ${seen.cappedByCash}`);
  }
});

test('largest discrepancy between the fast simulator and the oracle', t => {
  t.diagnostic(`${worst.compared} values of ${MONEY.join(', ')} compared, ${worst.identical} bit-identical; ` +
    `largest relative discrepancy ${worst.relative}${worst.where ? ` (${worst.where})` : ''}`);
  assert.ok(worst.compared > 1000 && worst.relative <= 1e-9);
});
