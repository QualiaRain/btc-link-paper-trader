// Tests for research/holdthrough-oracle.mjs, the independent oracle for the hypothetical hold-through rule.
//
//   1. Hand-computed scenarios on tiny frame sequences, each with its expected ledger written out.
//   2. Seeded property tests: where no asset is bought at two consecutive decisions the patched engine must be the
//      unmodified engine, and on unconstrained sequences every decision is checked against the protocol text.
//
// Frames are built as replay.js builds them and runs are started as app.js start() starts a range replay. The
// oracle is checked only against the engine and against arithmetic done by hand; nothing here reads the fast
// simulator. All data is synthetic and seeded; no test reads a clock.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import * as engine from '../engine.js';
import {holdThroughEngineSource, loadHoldThroughEngine} from './holdthrough-oracle.mjs';

const holdThrough = await loadHoldThroughEngine();
const ASSETS = ['BTC', 'LINK'], MIN = 60000;
const T0 = Date.UTC(2021, 0, 4);   // an arbitrary fixed UTC minute

// Frames as replay.js fetchHistoricalRange builds them once it has the minute closes: one frame for every close in
// [start, end] that both assets have, quotes from the asset's own close with an assumed half-spread, and the
// asset's own last `historyLimit` observations as its history. Missing minutes are never filled.
function rangeFrames(series, start, end, halfSpreadBps, historyLimit) {
  const index = Object.fromEntries(ASSETS.map(asset => [asset, new Map(series[asset].map((row, i) => [row.time, i]))]));
  const half = halfSpreadBps / 10000, frames = [];
  for (const {time} of series.BTC) {
    if (time < start || time > end || !index.LINK.has(time)) continue;
    const quotes = {}, history = {};
    for (const asset of ASSETS) {
      const i = index[asset].get(time), mid = series[asset][i].price;
      quotes[asset] = {bid: mid * (1 - half), ask: mid * (1 + half), mid, observedAt: time};
      history[asset] = series[asset].slice(Math.max(0, i - historyLimit + 1), i + 1);
    }
    frames.push({time, quotes, history});
  }
  return frames;
}

// A range replay as app.js start() and backend/paper_trail/replay.py run_replay run it: the session spans the
// first to the last frame, the first frame starts the account, and frames are ingested until it completes.
function run({createAccount, ingest}, config, frames) {
  const account = createAccount({...config, mode: 'replay', durationMs: frames.at(-1).time - frames[0].time});
  for (const frame of frames) {
    ingest(account, frame);
    if (account.status === 'completed') break;
  }
  return account;
}

// The paper account's own actions. Benchmark fills, the start entry and forecast settlements are left out.
const OWN = new Set(['trade', 'decision', 'decision_skipped', 'stop_loss', 'complete']);
const own = account => account.ledger.filter(entry => OWN.has(entry.type) && entry.actor !== 'benchmark');
const trades = account => own(account).filter(entry => entry.type === 'trade');
// One line per entry: "<minute> <type> <asset> <side, action or skip reason>".
const told = account => own(account).map(entry => [(entry.time - T0) / MIN, entry.type, entry.asset,
  entry.side ?? entry.action ?? (entry.type === 'decision_skipped' ? entry.reason : undefined)]
  .filter(part => part !== undefined).join(' '));

function near(actual, expected, label = 'value') {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${actual} is not ${expected}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Hand-computed scenarios.
//
// One close per asset per minute; the first is the single warmup minute before minute 0. No spread, no slippage,
// a 10 bps fee each way, a 10 bps buffer and a one-observation lookback. The engine's test then says buy when
// exp(drift) x 0.999 / 1.001 > 1.001, with drift = log(close / previous close) x horizon in minutes, capped at
// 0.03: in every scenario below, buy after a minute that rose about 1% or more and cash after a flat or falling one.
// $1,000 at the start, so the first buy is $500 (fee included), which is 500 / 1.001 / 100 BTC at a close of 100.

const FEE = 0.001, QTY = 500 / (1 + FEE) / 100;

function tiny(overrides, BTC, LINK = BTC.map(() => 10)) {
  const rows = closes => closes.map((price, i) => ({time: T0 + (i - 1) * MIN, price}));
  return {
    config: {initialCash: 1000, allocationFraction: 0.5, feeBps: 10, slippageBps: 0, bufferBps: 10, lookbackIntervals: 1, ...overrides},
    frames: rangeFrames({BTC: rows(BTC), LINK: rows(LINK)}, T0, T0 + (BTC.length - 2) * MIN, 0, 2),
  };
}

test('consecutive buys keep the position: no sell/buy pair and no extra fees', () => {
  // One-minute horizon. BTC rises 1% into minutes 0, 1 and 2; LINK is flat. Minute 3 ends the session.
  const {config, frames} = tiny({horizonMs: MIN}, [99, 100, 101, 102.01, 102.01]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '1 decision BTC hold', '1 decision LINK cash',
    '2 decision BTC hold', '2 decision LINK cash',
    '3 trade BTC sell', '3 complete']);
  // Bought once with half of E = $1,000; that same quantity, never topped up or trimmed, is sold on the last frame.
  const [buy, sell] = trades(account);
  near(buy.cashDelta, -500);
  near(buy.qty, QTY);
  near(sell.qty, QTY);
  near(sell.price, 102.01);
  const summary = holdThrough.getSummary(account);
  near(summary.fees, 500 * FEE / (1 + FEE) + QTY * 102.01 * FEE, 'one entry fee and one exit fee');
  near(summary.equity, 500 + QTY * 102.01 * (1 - FEE));
  assert.equal(summary.tradeCount, 2);
  // The unmodified engine sells and rebuys at minutes 1 and 2 on the same frames: three round trips of fees.
  const unmodified = engine.getSummary(run(engine, config, frames));
  assert.equal(unmodified.tradeCount, 6);
  assert.ok(unmodified.fees > 2.9 * summary.fees);
});

test('a buy-to-cash transition sells', () => {
  // BTC rises into minutes 0 and 1 and falls back into minute 2.
  const {config, frames} = tiny({horizonMs: MIN}, [99, 100, 101, 100, 100]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '1 decision BTC hold', '1 decision LINK cash',
    '2 trade BTC sell', '2 decision BTC cash', '2 decision LINK cash',
    '3 complete']);
  near(trades(account)[1].qty, QTY);
  near(account.cash, 500 + QTY * 100 * (1 - FEE));
  assert.deepEqual(account.positions, {BTC: {qty: 0, costBasis: 0}, LINK: {qty: 0, costBasis: 0}});
});

// Two-minute horizon: decisions at minutes 0 and 2, the session ends at minute 4. BTC is bought at 100 and its
// test says buy again at minute 2, so it is kept; LINK's test says buy at minute 2 and LINK is not held.
const kept = btc => tiny({horizonMs: 2 * MIN}, [99, 100, ...btc], [10, 10, 9.9, 10, 10, 10]);

test('an unheld asset is bought with half of E, not half of the cash', () => {
  // BTC falls to 90 and ticks up to 91. E at minute 2 is the $500 cash plus the BTC position at its net exit
  // value, 4.995 x 91 x 0.999 = $454.09. LINK gets half of E, $477.05: not half of the cash ($250), not all of it.
  const {config, frames} = kept([90, 91, 91, 91]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '2 decision BTC hold', '2 decision LINK buy', '2 trade LINK buy',
    '4 trade BTC sell', '4 trade LINK sell', '4 complete']);
  const E = 500 + QTY * 91 * (1 - FEE);
  near(E, 954.0909090909091);
  near(trades(account)[1].cashDelta, -E / 2);

  // min(allocationFraction x E, available cash): with BTC up at 106.05, half of E is $514.60 but only $500 is on
  // hand, so LINK gets the $500.
  const rich = kept([105, 106.05, 106.05, 106.05]);
  const capped = run(holdThrough, rich.config, rich.frames);
  assert.deepEqual(told(capped), told(account));
  assert.ok((500 + QTY * 106.05 * (1 - FEE)) / 2 > 500);
  near(trades(capped)[1].cashDelta, -500);
});

test('sells come before buys, so a LINK exit can fund a BTC entry at the same decision', () => {
  // LINK is bought at 10 (10 x QTY of it), doubles and slips, so at minute 2 its test says cash while BTC's says
  // buy. Half of E is $749, more than the $500 on hand until LINK is sold: BTC, first in order, must wait for it.
  const {config, frames} = tiny({horizonMs: 2 * MIN}, [100, 100, 99, 100, 100, 100], [9.9, 10, 21, 20, 20, 20]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC cash', '0 decision LINK buy', '0 trade LINK buy',
    '2 trade LINK sell', '2 decision BTC buy', '2 trade BTC buy', '2 decision LINK cash',
    '4 trade BTC sell', '4 complete']);
  near(trades(account)[2].cashDelta, -(500 + 10 * QTY * 20 * (1 - FEE)) / 2);
});

test('a stop loss on a held-through position is measured from the original cost basis', () => {
  // Two-minute horizon, 3% stop. Bought at 100 for $500, which is the fee-inclusive cost basis; kept at 110
  // (minute 2) and at 107.5 (minute 4). At minute 3 the close of 106 is 3.6% under 110 but the position still nets
  // $528.94, above 97% of $500: no stop. At minute 5 the close of 97 nets 4.995 x 97 x 0.999 = $484.03: stop.
  const {config, frames} = tiny({horizonMs: 2 * MIN, stopLossBps: 300}, [99, 100, 104, 110, 106, 107.5, 97, 97]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '2 decision BTC hold', '2 decision LINK cash',
    '4 decision BTC hold', '4 decision LINK cash',
    '5 stop_loss BTC', '5 trade BTC sell',
    '6 complete']);
  const stop = account.ledger.find(entry => entry.type === 'stop_loss');
  assert.equal(stop.costBasis, 500);
  near(stop.netLiquidation, QTY * 97 * (1 - FEE));
  assert.ok(stop.netLiquidation <= 500 * 0.97 && QTY * 106 * (1 - FEE) > 500 * 0.97);
  // The unmodified engine rebought at 110, which moved its basis up: the same frames stop it out at minute 3.
  assert.ok(told(run(engine, config, frames)).includes('3 stop_loss BTC'));
});

test('the final frame closes everything', () => {
  // The kept BTC position and the LINK position bought at minute 2 are both open when the session ends.
  const {config, frames} = kept([90, 91, 91, 91]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account).slice(-3), ['4 trade BTC sell', '4 trade LINK sell', '4 complete']);
  assert.equal(account.status, 'completed');
  assert.deepEqual(account.positions, {BTC: {qty: 0, costBasis: 0}, LINK: {qty: 0, costBasis: 0}});
  const summary = holdThrough.getSummary(account);
  assert.equal(summary.equity, account.cash);
  near(account.cash, 500 - (500 + QTY * 91 * (1 - FEE)) / 2      // cash left after the LINK buy
    + QTY * 91 * (1 - FEE)                                       // BTC sold at 91
    + (500 + QTY * 91 * (1 - FEE)) / 2 * (1 - FEE) / (1 + FEE)); // LINK bought and sold at 10: two fees
});

test('a decision whose horizon extends past the session end sells a held asset', () => {
  // Two-minute horizon, three-minute session: the decision at minute 2 would target minute 4. The engine skips it
  // having already closed BTC, so hold-through sells BTC too, although BTC's own test (101 to 102) would say buy.
  const {config, frames} = tiny({horizonMs: 2 * MIN}, [99, 100, 101, 102, 103]);
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '2 trade BTC sell', '2 decision_skipped BTC Horizon extends past session end',
    '2 decision_skipped LINK Horizon extends past session end',
    '3 complete']);
  // "The position the engine would be in": here the whole account is the unmodified engine's.
  assert.deepEqual(account, run(engine, config, frames));
});

test('a decision skipped for insufficient history sells a held asset', () => {
  const {config, frames} = tiny({horizonMs: MIN}, [99, 100, 101, 102, 102]);
  frames[1].history.BTC = frames[1].history.BTC.slice(-1);   // minute 1 arrives with a single BTC observation
  const account = run(holdThrough, config, frames);
  assert.deepEqual(told(account), [
    '0 decision BTC buy', '0 trade BTC buy', '0 decision LINK cash',
    '1 trade BTC sell', '1 decision_skipped BTC Insufficient, stale or conflicting completed history', '1 decision LINK cash',
    '2 decision BTC buy', '2 trade BTC buy', '2 decision LINK cash',
    '3 trade BTC sell', '3 complete']);
  assert.deepEqual(account, run(engine, config, frames));
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Property tests against the unmodified engine.

// Seeded PRNG (mulberry32): the only source of randomness in this file.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random range replay: a configuration, per-asset minute closes with independently missing minutes, and a plan
// for which asset's test says buy at which scheduled decision. Closes follow a random walk except at decision
// minutes, where the close is placed below or above the observation `lookbackIntervals` back: a fall can never
// pass the engine's test, and the rise is sized to clear its hurdle.
//   plan 'spaced':      a decision that buys anything is followed by a decision that buys nothing
//   plan 'alternating': no asset is bought at two consecutive decisions, but one asset may follow the other
//   plan 'free':        unconstrained, so positions are routinely held through
function randomReplay(seed, {plan, fees, limits = true}) {
  const random = prng(seed), pick = list => list[Math.floor(random() * list.length)];
  const config = {
    initialCash: 1000, horizonMs: pick([1, 2, 3, 5, 7]) * MIN, lookbackIntervals: pick([1, 2, 3, 5, 8]),
    bufferBps: pick([0, 5, 10, 40]), stopLossBps: pick([0, 0, 60, 150, 400]), allocationFraction: pick([0.5, 0.5, 0.3]),
    feeBps: pick([2, 10]) * (fees ? 1 : 0), slippageBps: pick([0, 2]),
    maxDrawdownBps: pick([0, 0, 0, 0, 0, 250]) * (limits ? 1 : 0), dailyLossBps: pick([0, 0, 0, 0, 0, 120]) * (limits ? 1 : 0),
  };
  const halfSpreadBps = pick([0, 3]), lookback = config.lookbackIntervals;
  const warmup = pick([0, 1, lookback + 2, lookback + 2, lookback + 2]);   // the short ones leave too little history
  const start = T0, end = T0 + (30 + Math.floor(random() * 90)) * MIN;

  // The minutes each asset has. The scored start and end are always there, as the app requires.
  const times = {BTC: [], LINK: []};
  for (let time = start - warmup * MIN; time <= end; time += MIN)
    for (const asset of ASSETS) if (random() > 0.06 || time === start || time === end) times[asset].push(time);
  const linkTimes = new Set(times.LINK), shared = times.BTC.filter(time => time >= start && linkTimes.has(time));

  // The engine's schedule (ingest): the first frame, then the first frame at least one horizon after the last
  // decision; the frame at the session end completes instead of deciding.
  const wants = new Map();
  let last = null, before = {BTC: false, LINK: false};
  for (const time of shared) {
    if (time >= end || (last !== null && time - last < config.horizonMs)) continue;
    const want = {};
    for (const asset of ASSETS) want[asset] = random() < 0.6 && (plan === 'free' ||
      (!before[asset] && (plan === 'alternating' || !(before.BTC || before.LINK))));
    wants.set(time, before = want);
    last = time;
  }

  const bps = value => value / 10000;
  const costs = (1 - bps(halfSpreadBps)) * (1 - bps(config.slippageBps)) * (1 - bps(config.feeBps)) /
    ((1 + bps(halfSpreadBps)) * (1 + bps(config.slippageBps)) * (1 + bps(config.feeBps)));
  const hurdle = Math.log((1 + bps(config.bufferBps)) / costs), sigma = pick([0.0005, 0.002, 0.006]);
  const series = {};
  for (const asset of ASSETS) {
    let price = asset === 'BTC' ? 30000 : 15;
    series[asset] = [];
    times[asset].forEach((time, i) => {
      const want = wants.get(time)?.[asset], past = series[asset][i - lookback];
      if (want === undefined || !past) price *= Math.exp(sigma * Math.sqrt(3) * (random() + random() + random() + random() - 2));
      else if (want) price = past.price * Math.exp((hurdle + 0.001 + 0.006 * random()) * (time - past.time) / config.horizonMs);
      else price = past.price * Math.exp(-0.004 * random());
      series[asset].push({time, price});
    });
  }
  return {config, frames: rangeFrames(series, start, end, halfSpreadBps, lookback + 1)};
}

// The precondition, read from the unmodified engine's own ledger: every scheduled decision writes one decision or
// decision_skipped entry per asset, and the asset is bought exactly when the action is "buy".
function assertNeverBoughtTwiceRunning(account) {
  for (const asset of ASSETS) {
    const bought = account.ledger.filter(entry => entry.asset === asset && /^decision/.test(entry.type)).map(entry => entry.action === 'buy');
    assert.ok(!bought.some((yes, i) => yes && bought[i + 1]), `${asset} is bought at two consecutive decisions`);
  }
}

// What a set of runs exercised: counts of the account's own ledger entries by kind, plus "handoff", a buy at a
// scheduled decision that also sold the other asset (a stop loss's own sale does not count).
function tally(seen, account) {
  const add = key => seen[key] = (seen[key] ?? 0) + 1;
  const exits = new Set();
  let stopSale = false;
  for (const entry of account.ledger) {
    if (entry.actor === 'benchmark') continue;
    add(entry.type === 'decision_skipped' ? entry.reason : [entry.type, entry.side ?? entry.action].filter(Boolean).join(' '));
    if (entry.type === 'trade' && entry.side === 'sell' && !stopSale) exits.add(entry.time);
    if (entry.type === 'trade' && entry.side === 'buy' && exits.has(entry.time)) add('handoff');
    stopSale = entry.type === 'stop_loss';
  }
  return seen;
}

function eachSeed(count, body) {
  for (let seed = 1; seed <= count; seed++) {
    try {
      body(seed);
    } catch (error) {
      error.message = `seed ${seed}: ${error.message}`;
      throw error;
    }
  }
}

test('property: when no asset is bought at two consecutive decisions, the ledger and summary are the engine\'s, exactly', () => {
  // E and the engine's cash after close() are the same number computed two ways: liquidation() values a position
  // at qty*sell*(1-fee), the closing fill pays notional-notional*fee. The two are bit-identical whenever nothing
  // is held at a decision that buys ('spaced') or the fee is zero, so those are the cases compared exactly here;
  // the remaining case is the next test.
  const seen = {};
  eachSeed(400, seed => {
    const {config, frames} = randomReplay(seed, seed % 2 ? {plan: 'spaced', fees: true} : {plan: 'alternating', fees: false});
    const expected = run(engine, config, frames), actual = run(holdThrough, config, frames);
    assertNeverBoughtTwiceRunning(expected);
    assert.deepEqual(actual, expected);                                    // ledger, forecasts, equity, positions, cash
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));        // and the same key order when exported
    assert.deepEqual(holdThrough.getSummary(actual), engine.getSummary(expected));
    assert.equal(expected.status, 'completed');
    tally(seen, expected);
  });
  // The property is exercised: buys, exits at decisions, one asset following the other, stop losses, every skip
  // reason and account limits all occur.
  for (const [kind, least] of Object.entries({'trade buy': 1000, 'trade sell': 1000, handoff: 100, stop_loss: 50, risk_halt: 5,
    'Stop loss: no same-frame reentry': 10, 'Insufficient, stale or conflicting completed history': 50,
    'Horizon extends past session end': 50})) assert.ok(seen[kind] >= least, `${kind}: ${seen[kind]} of at least ${least}`);
});

// Structural equality, with non-integer numbers compared to a relative tolerance.
function assertSameWithin(tolerance, actual, expected, path = 'account') {
  if (typeof expected === 'number' && typeof actual === 'number' && !(Number.isInteger(expected) && Number.isInteger(actual))) {
    assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${path}: ${actual} is not ${expected}`);
  } else if (expected !== null && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertSameWithin(tolerance, actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

test('property: with a fee, one asset following the other agrees with the engine to rounding in E', () => {
  // Same family as above ("no asset is bought at two consecutive decisions") with a fee and with handoffs: a
  // decision that sells one asset and buys the other. E can then differ from the engine's cash after close() in
  // the last bit, so every entry, forecast, mark and summary field must match in structure and to 1e-12 relative.
  const seen = {};
  eachSeed(200, seed => {
    const {config, frames} = randomReplay(seed, {plan: 'alternating', fees: true});
    const expected = run(engine, config, frames), actual = run(holdThrough, config, frames);
    assertNeverBoughtTwiceRunning(expected);
    assertSameWithin(1e-12, actual, expected);
    assertSameWithin(1e-12, holdThrough.getSummary(actual), engine.getSummary(expected), 'summary');
    tally(seen, expected);
  });
  assert.ok(seen.handoff >= 100, `handoffs: ${seen.handoff}`);
});

// The protocol's hold-through paragraph restated as checks on one account's ledger. It replays the ledger's trades
// to know what is held, what it cost and how much cash there is, so it shares no arithmetic with the patched
// branch. Returns how many stop losses hit a position that had been kept through at least one decision.
function assertFollowsProtocol(account, frames) {
  const {initialCash, allocationFraction, feeBps, slippageBps} = account.config;
  const exitPrice = (frame, asset) => frame.quotes[asset].bid * (1 - slippageBps / 10000) * (1 - feeBps / 10000);
  const frameAt = new Map(frames.map(frame => [frame.time, frame]));
  const book = {cash: initialCash, BTC: 0, LINK: 0}, cost = {}, kept = {};
  const apply = trade => {
    if (trade.side === 'sell') near(trade.qty, book[trade.asset], 'a sale is the whole position');
    else [cost[trade.asset], kept[trade.asset]] = [-trade.cashDelta, false];
    book[trade.asset] = trade.side === 'sell' ? 0 : book[trade.asset] + trade.qty;
    book.cash += trade.cashDelta;
  };
  const entries = own(account);
  let stopsAfterHold = 0;
  for (const time of new Set(entries.map(entry => entry.time))) {
    const now = entries.filter(entry => entry.time === time), stopped = new Set();
    // Stop losses run before the decision (unchanged engine code), each followed by its own sale. The loss is
    // measured from what the position cost when it was bought, however many decisions it was kept through.
    while (now[0]?.type === 'stop_loss') {
      const [stop, sale] = now.splice(0, 2);
      near(stop.costBasis, cost[stop.asset], 'stop-loss cost basis');
      if (kept[stop.asset]) stopsAfterHold++;
      stopped.add(stop.asset);
      apply(sale);
    }
    if (!now.length) continue;
    if (now.at(-1).type === 'complete') {   // the final close
      now.slice(0, -1).forEach(apply);
      assert.deepEqual([book.BTC, book.LINK], [0, 0]);
      continue;
    }
    // A scheduled decision. "Let E be the account's net liquidation value at that frame before any trade."
    const E = book.cash + ASSETS.reduce((sum, asset) => sum + book[asset] * exitPrice(frameAt.get(time), asset), 0);
    const fills = now.filter(entry => entry.type === 'trade');
    const sells = fills.filter(trade => trade.side === 'sell'), buys = fills.filter(trade => trade.side === 'buy');
    assert.deepEqual(fills, [...sells, ...buys], '"First sell ..."');
    assert.deepEqual(buys.map(trade => trade.asset), ASSETS.filter(asset => buys.some(trade => trade.asset === asset)), '"... in the order BTC, LINK"');
    for (const asset of ASSETS) {
      const outcomes = now.filter(entry => entry.type !== 'trade' && entry.asset === asset);
      assert.equal(outcomes.length, 1, 'one decision or decision_skipped entry per asset');
      const [outcome] = outcomes, held = book[asset] > 0;
      // The buy test as the entry records it; a skipped decision has none and counts as cash.
      const saysBuy = outcome.type === 'decision' && outcome.expectedNetRatio > outcome.requiredNetRatio;
      assert.equal(outcome.action, outcome.type === 'decision_skipped' ? undefined : !saysBuy ? 'cash' : held ? 'hold' : 'buy');
      if (stopped.has(asset)) assert.equal(outcome.reason, 'Stop loss: no same-frame reentry');
      // Held and not buy: sold. Held and buy: untouched. Unheld and buy: bought. Unheld and not buy: nothing.
      assert.equal(sells.filter(trade => trade.asset === asset).length, held && !saysBuy ? 1 : 0, `${asset} sells`);
      assert.equal(buys.filter(trade => trade.asset === asset).length, !held && saysBuy ? 1 : 0, `${asset} buys`);
      if (outcome.action === 'hold') kept[asset] = true;
    }
    sells.forEach(apply);
    for (const buy of buys) {
      near(-buy.cashDelta, Math.min(allocationFraction * E, book.cash), '"min(allocationFraction x E, available cash)"');
      apply(buy);
    }
  }
  near(book.cash, account.cash, 'replayed cash');
  return stopsAfterHold;
}

// Every scheduled decision's record apart from what was then done about it: the skip reason, or the forecast and
// the two sides of the buy test.
const tests = account => account.ledger.filter(entry => /^decision/.test(entry.type)).map(entry =>
  [entry.time, entry.asset, entry.reason, entry.forecastId, entry.expectedNetRatio, entry.requiredNetRatio]);

test('property: on unconstrained sequences every decision follows the protocol text', () => {
  const seen = {'stop_loss after hold': 0};
  eachSeed(300, seed => {
    const {config, frames} = randomReplay(seed, {plan: 'free', fees: true, limits: false});
    const account = run(holdThrough, config, frames);
    seen['stop_loss after hold'] += assertFollowsProtocol(account, frames);
    assert.equal(account.status, 'completed');
    // "Compute each asset's forecast and buy test exactly as the engine does": neither depends on what is held, so
    // without stop losses (whose same-frame skips do) they are the unmodified engine's, settlements included.
    if (!config.stopLossBps) {
      const unmodified = run(engine, config, frames);
      assert.deepEqual(account.forecasts, unmodified.forecasts);
      assert.deepEqual(tests(account), tests(unmodified));
    }
    tally(seen, account);
  });
  for (const [kind, least] of Object.entries({'decision hold': 1000, 'decision buy': 1000, 'trade sell': 1000, stop_loss: 100,
    'stop_loss after hold': 50, 'Stop loss: no same-frame reentry': 100}))
    assert.ok(seen[kind] >= least, `${kind}: ${seen[kind]} of at least ${least}`);
});

// ---------------------------------------------------------------------------------------------------------------
// The patch itself.

test('the patch changes only the scheduled-decision branch and refuses an engine it does not recognise', async () => {
  const source = await readFile(new URL('../engine.js', import.meta.url), 'utf8');
  const patched = holdThroughEngineSource(source);
  const branchStart = source.indexOf('  } else if (a.lastDecisionAt===null');
  const afterBranch = source.indexOf('  a.lastFrameAt=frame.time;a.lastValidFrameAt=frame.time;mark(a,frame);return a;');
  assert.ok(branchStart > 0 && afterBranch > branchStart);
  assert.equal(patched.slice(0, branchStart), source.slice(0, branchStart));
  assert.equal(patched.slice(patched.length - (source.length - afterBranch)), source.slice(afterBranch));
  assert.ok(patched.slice(branchStart).includes('function holdThroughDecision('));
  assert.ok(!patched.includes(source.slice(branchStart, afterBranch)));

  // Not found, and found twice: both refuse loudly instead of patching something else.
  assert.throws(() => holdThroughEngineSource(source.replace('const budget=a.cash*a.config.allocationFraction;', 'const budget=a.cash/2;')), /found it 0 times/);
  assert.throws(() => holdThroughEngineSource(source + source), /found it 2 times/);
});
