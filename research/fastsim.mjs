// Fast simulator for the settings search (research/PROTOCOL.md, "Simulation"). Simulated cash only.
//
// It reproduces a date-range replay of the unmodified engine (engine.js ingest; frames as replay.js builds them)
// for one window, and the protocol's four hypothetical rule changes. The answer sheet is the engine itself:
// research/fastsim.test.mjs. Arithmetic is written in the engine's operation order so the comparisons that decide
// trades (buy test, stop loss, fill thresholds) see the same doubles.
//
// What makes it fast: every frame of a replay is a valid frame, forecasts never affect the ledger, and the
// decision cadence depends only on frame times and the horizon. So per (window, horizon, forecast rule, costs)
// the decision schedule, each decision's expectedNetRatio and each forecast's outcome are computed once (`plan`),
// and each setting then walks decisions only, visiting other frames just while a stop loss could fire.
//
// Where PROTOCOL.md could be read two ways, its "Readings" decide. Readings 1 to 5 are cited below at the line that
// implements each; Reading 7 (low-coverage windows) is the caller's, see refusal().
import {MINUTE, DAY, lowerBound} from './windows.mjs';

const MAX_OUTCOME_LATENESS_MS = 30000;     // engine default, fixed by the protocol
const SPAN_TOLERANCE_MS = 60 * MINUTE;       // long lookback: the past observation may be this much older
const FIXED = ['maxQuoteAgeMs', 'maxOutcomeLatenessMs', 'maxDrawdownBps', 'dailyLossBps', 'cashYieldBps'];
// Outcome of the forecast a scheduled decision issues for one asset. NONE: the engine skips that decision
// (insufficient history or horizon past the session end), so there is no forecast and nothing to buy.
const NONE = 0, EXPIRED = 1, HIT = 2, MISS = 3, FLAT = 4;

const finite = x => typeof x === 'number' && Number.isFinite(x);
const fail = message => { throw new Error(message); };

// Same ranges as engine.js createAccount, so nothing is simulated that the engine would refuse to configure.
function readSetting(setting) {
  if (!setting || typeof setting !== 'object') fail('Invalid setting');
  for (const key of FIXED) if (setting[key] !== undefined) fail(`${key} is fixed by the protocol and cannot be set`);
  const {horizonMs, bufferBps, stopLossBps, holdThrough = false, reversal = false, btcLed = false,
    allocationFraction = 0.5, initialCash = 1000} = setting;
  const lookback = setting.lookback ?? undefined, spanMs = setting.spanMs ?? undefined;   // null means not given
  if (!finite(horizonMs) || horizonMs <= 0 || horizonMs > 31 * DAY) fail('Invalid horizonMs');
  if ((lookback === undefined) === (spanMs === undefined)) fail('Give exactly one of lookback or spanMs');
  if (spanMs === undefined && (!Number.isInteger(lookback) || lookback < 1 || lookback > 240))
    fail('lookback must be an integer from 1 to 240');
  if (spanMs !== undefined && (!Number.isSafeInteger(spanMs) || spanMs <= 0)) fail('spanMs must be a positive integer');
  if (!finite(bufferBps) || bufferBps < 0 || bufferBps > 1000) fail('Invalid bufferBps');
  if (!finite(stopLossBps) || stopLossBps < 0 || stopLossBps > 9999) fail('stopLossBps must be between 0 and 9999');
  if (!finite(allocationFraction) || allocationFraction < 0 || allocationFraction > 0.5)
    fail('allocationFraction must be between 0 and 0.5');
  if (!finite(initialCash) || initialCash <= 0 || initialCash > 1e9) fail('Invalid initialCash');
  if (typeof holdThrough !== 'boolean' || typeof reversal !== 'boolean' || typeof btcLed !== 'boolean')
    fail('holdThrough, reversal and btcLed must be booleans');
  return {horizonMs, lookback, spanMs, bufferBps, stopLossBps, holdThrough, reversal, btcLed, allocationFraction,
    initialCash};
}

function readCosts(costs) {
  if (!costs || typeof costs !== 'object') fail('Invalid costs');
  for (const key of FIXED) if (costs[key] !== undefined) fail(`${key} is fixed by the protocol and cannot be set`);
  for (const key of ['feeBps', 'slippageBps', 'halfSpreadBps'])
    if (!finite(costs[key]) || costs[key] < 0 || costs[key] > 1000) fail(`Invalid ${key}`);
  // engine prices(): s = slippageBps/10000, f = feeBps/10000; replay.js: half = halfSpreadBps/10000.
  return {fee: costs.feeBps / 10000, slip: costs.slippageBps / 10000, half: costs.halfSpreadBps / 10000};
}

// Why a run does not exist for this setting, or null. The protocol's 90% coverage floor is NOT applied here: it
// makes a window invalid for every setting (prepared.valid). Under Reading 7 as amended the caller keeps such a
// window in its place and counts it in no statistic; this file computes none and runs any window with two frames.
function refusal(market, prepared, s) {
  if (prepared.shared < 2) return 'fewer than 2 shared minutes';   // no scored span: the engine needs durationMs > 0
  if (prepared.scoreEnd - prepared.scoreStart > 366 * DAY) fail('durationMs exceeds supported maximum');
  if (s.spanMs !== undefined) return null;   // Reading 1: "Family L has no such refusal"
  // Reading 1: "A window is run as if the app replayed [first shared minute, last shared minute]: each asset keeps
  // rows from max(60, 2 x lookback + 10) minutes before the first shared minute, and the run is refused unless each
  // asset has lookback + 1 rows at or before it" (app.js start() and replay.js; the first shared minute is itself
  // one of the rows). Reading 4: under BTC-led the refusal "still applies to each asset's own series".
  // The app's two other range refusals cannot bind on a window that passes the coverage floor: a scored span
  // shorter than one horizon (90% of 28 days is 36,288 shared minutes; the longest horizon is 1,440) and a range
  // over 31 days (a window is 28).
  const first = prepared.scoreStart - Math.max(60, 2 * s.lookback + 10) * MINUTE;
  for (const asset of ['BTC', 'LINK'])
    if (prepared.index[asset][0] - lowerBound(market[asset].time, first) + 1 < s.lookback + 1) return 'insufficient warmup';
  return null;
}

// Scratch reused across calls (everything here is synchronous): the decision schedule and, per asset and
// decision, the engine's expectedNetRatio and the outcome class of the forecast that decision issues.
let capacity = 0, schedule = null, decisions = 0;
const ratio = [null, null], outcome = [null, null];
const issued = new Int32Array(10);   // forecasts per asset and outcome class if no decision were lost to a stop
const lost = new Int32Array(10);     // forecasts never issued because the asset was stopped on the decision frame
const qty = new Float64Array(2), basis = new Float64Array(2), buys = new Int32Array(2), stopped = new Uint8Array(2);

function plan(market, prepared, s, c) {
  const n = prepared.shared, times = prepared.times, horizon = s.horizonMs;
  if (n > capacity) {
    capacity = n; schedule = new Int32Array(n);
    for (let a = 0; a < 2; a++) { ratio[a] = new Float64Array(n); outcome[a] = new Uint8Array(n); }
  }
  // Decision cadence (engine ingest): the first frame, then the first frame at least horizonMs after the last
  // decision. endsAt is the last frame's time, so the last frame completes the run and never decides (Reading 2:
  // "The session ends at the window's last shared minute").
  let count = 0, lastDecisionAt = 0;
  for (let i = 0; i < n - 1; i++)
    if (count === 0 || times[i] - lastDecisionAt >= horizon) { schedule[count++] = i; lastDecisionAt = times[i]; }
  decisions = count;
  planAsset(market, prepared, s, c, 0, 'BTC');
  planAsset(market, prepared, s, c, 1, 'LINK');
}

function planAsset(market, prepared, s, c, a, asset) {
  const n = prepared.shared, times = prepared.times, endsAt = times[n - 1], horizon = s.horizonMs;
  const mid = prepared.close[asset], ratios = ratio[a], outcomes = outcome[a];
  // BTC-led: LINK's drift is BTC's drift at the same frame, from BTC's own history. Anchor and quotes stay LINK's.
  // Reading 4: "BTC's forecast is unavailable" means BTC's drift cannot be computed from BTC's history, which is
  // `usable` below read on BTC's rows; then LINK's decision is skipped.
  const source = s.btcLed ? 'BTC' : asset;
  const clock = market[source].time, price = market[source].close, row = prepared.index[source];
  const long = s.spanMs !== undefined;
  // replay.js: history is the last lookback+1 rows of the series kept from scoreStart - warmupMinutes (Reading 1).
  const oldest = long ? 0 : lowerBound(clock, prepared.scoreStart - Math.max(60, 2 * s.lookback + 10) * MINUTE);
  const sellFactor = (1 - c.half), sellSlip = (1 - c.slip), buyFactor = (1 + c.half), buySlip = (1 + c.slip);
  const feeDown = 1 - c.fee, feeUp = 1 + c.fee;
  issued.fill(0, a * 5, a * 5 + 5);
  let past = -1;
  for (let k = 0; k < decisions; k++) {
    const i = schedule[k], time = times[i], last = row[i], targetAt = time + horizon;
    let usable;
    if (long) {
      // Long lookback: the latest observation at or before time - span, if at most 60 minutes older than that
      // (Reading 5: exactly 60 minutes is included). Without one the decision is skipped (Reading 1).
      const wanted = time - s.spanMs;
      if (k === 0) past = lowerBound(clock, wanted + 1) - 1;
      else while (past + 1 < clock.length && clock[past + 1] <= wanted) past++;
      usable = past >= 0 && wanted - clock[past] <= SPAN_TOLERANCE_MS;
    } else {
      past = last - s.lookback;
      usable = past >= oldest;
    }
    // engine: no prediction -> 'Insufficient ... history'; targetAt > endsAt -> 'Horizon extends past session end'.
    // Reading 2: when the window's nominal last minute is missing for an asset the end is earlier, and "decisions
    // whose horizon would pass it are skipped as the engine skips them". Only the end's time is read, no price.
    if (!usable || targetAt > endsAt) { ratios[k] = NaN; outcomes[k] = NONE; continue; }
    // engine prediction(): drift over the real elapsed time, clipped to +-3% per horizon.
    const elapsed = clock[last] - clock[past];
    let drift = Math.max(-.03, Math.min(.03, Math.log(price[last] / price[past]) * horizon / elapsed));
    if (s.reversal) drift = -drift;   // Reversal: prediction = anchor * exp(-drift)
    const anchor = mid[i], prediction = anchor * Math.exp(drift);
    // engine ingest: expectedNetRatio=(prediction/anchor)*(p.sell/p.buy)*(1-p.fee)/(1+p.fee), with
    // p.sell = bid*(1-s), p.buy = ask*(1+s), bid = mid*(1-half), ask = mid*(1+half).
    ratios[k] = (prediction / anchor) * ((anchor * sellFactor * sellSlip) / (anchor * buyFactor * buySlip)) * feeDown / feeUp;
    // engine settle(): resolved by the first frame at or after the target, which is the next decision frame or
    // the completion frame; more than maxOutcomeLatenessMs late means expired. Direction as in forecastCounts.
    const j = k + 1 < decisions ? schedule[k + 1] : n - 1;
    let result = EXPIRED;
    if (times[j] - targetAt <= MAX_OUTCOME_LATENESS_MS) {
      const eps = 1e-12 * Math.max(1, anchor), predicted = prediction - anchor, observed = mid[j] - anchor;
      result = Math.abs(predicted) <= eps || Math.abs(observed) <= eps ? FLAT
        : Math.sign(predicted) === Math.sign(observed) ? HIT : MISS;
    }
    outcomes[k] = result; issued[a * 5 + result]++;
  }
}

function run(prepared, s, c, detail) {
  const n = prepared.shared, mids = [prepared.close.BTC, prepared.close.LINK];
  const fee = c.fee, feeDown = 1 - fee, feeUp = 1 + fee;
  const sellFactor = 1 - c.half, sellSlip = 1 - c.slip, buyFactor = 1 + c.half, buySlip = 1 + c.slip;
  const required = 1 + s.bufferBps / 10000;                      // engine: buy iff expectedNetRatio > this
  const stopOn = s.stopLossBps !== 0, stopLine = 1 - s.stopLossBps / 10000;
  const allocation = s.allocationFraction, initial = s.initialCash;
  let cash = initial, fills = 0, fees = 0, stops = 0, peak = initial, maxDrawdown = 0, heldBTC = 0, heldLINK = 0;
  qty.fill(0); basis.fill(0); buys.fill(0); lost.fill(0); stopped.fill(0);

  // engine prices().sell and liquidation(): what a position is worth after slippage and the exit fee.
  const exitPrice = (a, i) => mids[a][i] * sellFactor * sellSlip;
  const netValue = i => cash + (qty[0] * exitPrice(0, i) * feeDown + qty[1] * exitPrice(1, i) * feeDown);
  // engine fill(..., 'sell', Number.MAX_VALUE, ...): the whole position; positions of 1e-14 or less do not trade.
  const sell = (a, i) => {
    if (!(qty[a] > 1e-14)) return;
    const notional = qty[a] * exitPrice(a, i), cost = notional * fee;
    cash = Math.max(0, cash + (notional - cost));
    qty[a] = 0; basis[a] = 0; fills++; fees += cost;
  };
  // engine fill(..., 'buy', dollars, ...): spend is fee-inclusive, capped by cash; dust orders do not trade.
  const buy = (a, i, dollars) => {
    const total = Math.min(dollars, cash);
    if (!(total > 1e-10)) return;
    const notional = total / feeUp;
    cash = Math.max(0, cash - total);
    qty[a] += notional / (mids[a][i] * buyFactor * buySlip); basis[a] += total;
    if (qty[a] < 1e-14) { qty[a] = 0; basis[a] = 0; }
    fills++; fees += total - notional; buys[a]++;
  };
  // engine stopPositions(): exit value at or below the fee-inclusive cost basis less the stop, on any frame.
  const stopOut = (a, i) => {
    if (!(qty[a] > 0 && basis[a] > 0 && qty[a] * exitPrice(a, i) * feeDown <= basis[a] * stopLine)) return 0;
    stops++; sell(a, i);
    return 1;
  };
  // engine mark() and getSummary(): one equity point per frame, drawdown from a peak that starts at initialCash.
  const mark = i => {
    const value = netValue(i);
    peak = Math.max(peak, value); maxDrawdown = Math.max(maxDrawdown, 100 * (peak - value) / peak);
    if (qty[0] > 0) heldBTC++;
    if (qty[1] > 0) heldLINK++;
  };
  // The engine's buy test for one asset at decision k. A stopped asset is skipped before any forecast is made
  // ('Stop loss: no same-frame reentry'), so the forecast planned for it is never issued. Only the asset's own
  // stop counts (Reading 4: "A BTC stop-out on that frame does not skip LINK").
  const wantsBuy = (a, k) => {
    const planned = outcome[a][k];
    if (stopped[a]) { if (planned) lost[a * 5 + planned]++; return false; }
    return planned !== NONE && ratio[a][k] > required;
  };

  const ratioBTC = ratio[0], ratioLINK = ratio[1];
  for (let k = 0; k < decisions; k++) {
    // Most decisions at short horizons change nothing: no position, no stop on this frame, and neither buy test
    // passes (a skipped decision has ratio NaN). Only the detail marks would need this frame.
    if (!detail && !(qty[0] > 0 || qty[1] > 0 || stopped[0] || stopped[1] || ratioBTC[k] > required || ratioLINK[k] > required))
      continue;
    const i = schedule[k];
    if (!s.holdThrough) {
      // engine ingest: close everything, size the budget once from cash, then BTC and LINK in order.
      sell(0, i); sell(1, i);
      const budget = cash * allocation;
      if (wantsBuy(0, k)) buy(0, i, budget);
      if (wantsBuy(1, k)) buy(1, i, budget);
    } else {
      // Hold-through (PROTOCOL.md): E is net liquidation value before any decision trade; sell held assets whose
      // test says cash (a skipped decision counts as cash); keep held assets whose test says buy; buy unheld
      // ones with min(allocationFraction x E, available cash), which is what the engine's buy fill does.
      // Reading 3: E is read here, after this frame's stop-loss sales (made when the scan below reached this
      // frame) and before the decision's own sells. "Held" is quantity above zero; an asset whose test says buy
      // is not touched by the sells, so its quantity at its buy line is its quantity where E was read. A kept
      // position keeps qty and basis as they are. A same-frame stop-out is a skipped decision (wantsBuy).
      // "Available cash" is the cash on hand at that asset's buy (buy() caps the order by it).
      const btc = wantsBuy(0, k), link = wantsBuy(1, k), budget = allocation * netValue(i);
      if (!btc) sell(0, i);
      if (!link) sell(1, i);
      if (btc && !(qty[0] > 0)) buy(0, i, budget);
      if (link && !(qty[1] > 0)) buy(1, i, budget);
    }
    if (detail) mark(i);
    // Frames after this decision up to the next decision frame (or the completion frame): only a stop loss can
    // change the account there, so they are visited only while a stop could fire, or for the detail marks.
    const next = k + 1 < decisions ? schedule[k + 1] : n - 1;
    stopped[0] = stopped[1] = 0;
    if (detail || (stopOn && (qty[0] > 0 || qty[1] > 0))) {
      for (let j = i + 1; j <= next; j++) {
        if (stopOn) {
          const btc = stopOut(0, j), link = stopOut(1, j);
          if (j === next) { stopped[0] = btc; stopped[1] = link; }
          else if (!detail && !(qty[0] > 0 || qty[1] > 0)) break;
        }
        if (detail && j < next) mark(j);
      }
    }
  }
  // Completion frame (time >= endsAt): stops were checked above, then the engine closes everything; no decision.
  sell(0, n - 1); sell(1, n - 1);
  if (detail) mark(n - 1);

  const finalValue = netValue(n - 1), buyHoldValue = benchmark(mids, n, initial, c);
  const result = {valid: true, invalidReason: null, finalValue, returnPct: 100 * (finalValue / initial - 1),
    buyHoldValue, buyHoldReturnPct: 100 * (buyHoldValue / initial - 1), fills, fees, stops, decisions,
    perAsset: {BTC: assetCounts(0), LINK: assetCounts(1)}};
  if (detail) { result.maxDrawdownPct = maxDrawdown; result.exposure = {BTC: heldBTC / n, LINK: heldLINK / n}; }
  return result;
}

function assetCounts(a) {
  const count = kind => issued[a * 5 + kind] - lost[a * 5 + kind];
  const expired = count(EXPIRED), directionHits = count(HIT), directionMisses = count(MISS), directionFlat = count(FLAT);
  const settled = directionHits + directionMisses + directionFlat;
  return {forecasts: settled + expired, settled, expired, directionHits, directionMisses, directionFlat, buys: buys[a]};
}

// engine start(): the comparison account puts initialCash/2 into each asset at the first frame, with the same
// costs, and holds; its value is the net liquidation value at the last frame.
function benchmark(mids, n, initial, c) {
  const budget = initial / 2;
  let cash = initial, value = 0;
  for (let a = 0; a < 2; a++) {
    const total = Math.min(budget, cash);
    if (!(total > 1e-10)) continue;
    let size = total / (1 + c.fee) / (mids[a][0] * (1 + c.half) * (1 + c.slip));
    cash = Math.max(0, cash - total);
    if (size < 1e-14) size = 0;
    value += size * (mids[a][n - 1] * (1 - c.half) * (1 - c.slip)) * (1 - c.fee);
  }
  return cash + value;
}

// One window, one setting.
//   market   = {BTC: series, LINK: series}; prepared = prepareWindow(market, window) from ./windows.mjs.
//   setting  = {horizonMs, lookback (1..240 observations) OR spanMs (long lookback), bufferBps, stopLossBps,
//               holdThrough = false, reversal = false, btcLed = false, allocationFraction = 0.5, initialCash = 1000}.
//               Other keys are ignored, except the engine settings the protocol fixes, which throw.
//   costs    = {feeBps, slippageBps, halfSpreadBps}.
// Returns {valid: false, invalidReason} when no run exists for this setting: a lookback setting the app would
// refuse for lack of causal warmup ('insufficient warmup'), or a window without two frames ('fewer than 2 shared
// minutes'). The window-level coverage floor is prepared.valid and is left to the caller (Reading 7). A long
// lookback reads the market as far back as its span reaches; keeping those rows inside the exploration range is
// the loader's job (research/dataset.mjs), not this file's. Otherwise
//   {valid: true, invalidReason: null, finalValue, returnPct, buyHoldValue, buyHoldReturnPct, fills, fees, stops,
//    decisions, perAsset: {BTC, LINK: {forecasts, settled, expired, directionHits, directionMisses, directionFlat,
//    buys}}} and, with options.detail, maxDrawdownPct and exposure: {BTC, LINK}.
// fills and fees count every buy and sell of the paper account (not the comparison account); stops counts
// stop-loss events; decisions counts scheduled decision frames; buys counts buy fills; exposure is the share of
// scored frames after whose processing the asset is held.
export function simulate(market, prepared, setting, costs, options = {detail: false}) {
  const s = readSetting(setting), c = readCosts(costs), reason = refusal(market, prepared, s);
  if (reason) return {valid: false, invalidReason: reason};
  plan(market, prepared, s, c);
  return run(prepared, s, c, options?.detail === true);
}

// Many settings on one window: settings that share horizon, lookback/span, reversal and btcLed share one plan.
// Results are in input order and identical to simulate() without detail.
export function simulateGrid(market, prepared, settings, costs) {
  const c = readCosts(costs), groups = new Map(), results = new Array(settings.length);
  settings.forEach((setting, at) => {
    const s = readSetting(setting), key = `${s.horizonMs}|${s.lookback}|${s.spanMs}|${s.reversal}|${s.btcLed}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({s, at});
  });
  for (const group of groups.values()) {
    const reason = refusal(market, prepared, group[0].s);
    if (!reason) plan(market, prepared, group[0].s, c);
    for (const {s, at} of group) results[at] = reason ? {valid: false, invalidReason: reason} : run(prepared, s, c, false);
  }
  return results;
}
