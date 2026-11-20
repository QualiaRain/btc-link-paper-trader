#!/usr/bin/env node
// What can the protocol's tests do? (research/PROTOCOL.md, "What the tests can and cannot do".) This script
// simulates window returns, runs the tests of research/stats.mjs on them and counts how often each passes: when
// there is nothing to find (the first table) and when one setting has a real mean (the second). The committed
// measurement is research/calibration.json, and the two tables in the protocol are written from that file.
//
//   node research/calibration.mjs            measures at the committed scale and prints both tables. Writes
//                                            nothing. About two and a half processor-hours (the committed
//                                            measurement took 43 minutes on four shared cores).
//   node research/calibration.mjs --quick    a fast look at a small scale (about a minute and a half of processor
//                                            time). Labelled as such and never written to a file.
//   node research/calibration.mjs --write    measures at the committed scale, writes research/calibration.json
//                                            and rewrites the two marked blocks of research/PROTOCOL.md from it.
//   node research/calibration.mjs --check    measures nothing: exit status 0 when the two blocks equal the
//                                            rendering of research/calibration.json, 1 otherwise.
//   node research/calibration.mjs --retired  prints only a comparison of the first version's retired statistics
//                                            with the amended ones (with --quick: at the small scale). It is
//                                            not part of the two tables and is never written.
//   --threads T                              worker threads (default: up to 4). No count depends on T.
//
// Everything is simulated from seeded generators: no market data is read, no clock enters a result, and two runs
// of the same code give the same counts and the same bytes in research/calibration.json. Nothing here places or
// models an order.
//
// THE SIMULATED RETURNS. A window return is made from a standard normal driver x. Unless stated it has mean
// exactly 0 and standard deviation 1:
//   bell-shaped     the return is x
//   skewed          a shifted lognormal, sign * (exp(sigma x) - exp(sigma^2 / 2)) / its standard deviation;
//                   sigma 0.3 has skewness 0.95 and sigma 0.5 has 1.75; sign -1 puts the long tail on the losses
//   idle            exactly half of the windows, chosen at random, return exactly 0 (no trade); it is the
//                   largest idle share the protocol's eligibility rule allows. Standard deviation sqrt(1/2)
//   runs            the driver is a stationary first-order autoregression across windows, its coefficient
//                   chosen so that the RETURNS (after shape) have lag-1 autocorrelation 0.2
//   regimes         the return is 0.5 R + sqrt(0.75) e, with R a stationary first-order autoregression of
//                   coefficient 0.8 and unit variance and e standard normal. Lag-k autocorrelation
//                   0.25 x 0.8^k: 0.2 at lag 1 like the runs, but a good or bad stretch lasts several windows
//   calm/turbulent  a market in two states: a calm window is followed by a calm one with probability 0.95, a
//                   turbulent window by a turbulent one with probability 0.8, and the first window is turbulent
//                   with the stationary probability 0.2. The return is 0.5 + x in a calm window and -2 + 3x in
//                   a turbulent one. Mean 0.8 x 0.5 - 0.2 x 2 = 0, variance 0.8 x 1.25 + 0.2 x 13 = 3.6
//                   (standard deviation 1.90), skewness -11.1 / 3.6^1.5 = -1.63, lag-k autocorrelation
//                   2.5^2 x 0.16 x 0.75^k / 3.6 (0.21 at lag 1)
// SEARCH COLUMNS. A simulated study is 3,360 settings (one family: 134 clusters of 25 near-identical settings and
// one of 10) or 13,200 settings (all families: 528 clusters) over 50 windows. Within a cluster each setting's
// driver is sqrt(0.95) x (the cluster's driver) + sqrt(0.05) x (its own), so two settings of a cluster correlate
// about 0.95 and different clusters are independent. A cluster's idle windows are shared. In the regimes row
// the cluster's driver and each setting's own part are both regime series. In the calm/turbulent row one market
// is shared by every setting of the study. Counted: search-adjusted p < 0.05.
// NOMINEE COLUMNS. A simulated nominee is 24 windows of no-skill returns e. Confirmation column: counted when
// mean > 0 and confirmationP(e).p < 0.01. Buy-and-hold column: a comparison account b = 6 + 15 z in percent per
// window (z standard normal, windows independent) and a long-only rule r = 0.4 b + 3 e, which holds 40% of that
// account and whose intercept is exactly 0; counted when intercept > 0 and buyAndHoldReading(r, b).p < 0.01. The
// last row is that rule with bell-shaped e, and there the confirmation column is applied to r itself.
// SECOND TABLE. Bell-shaped returns. Search column: the true mean is added to setting STRONG_SETTING of the first
// table's bell-shaped 13,200-setting studies. Nominee columns: it is added to e of the first table's bell-shaped
// nominees, so r = 0.4 b + 3 (e + mean) has a true intercept of that many residual standard deviations.
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {searchAdjustedP, confirmationP, buyAndHoldReading, tTestGreaterP, mulberry32} from './stats.mjs';

export const SEED = 20261118;   // also the resampling seed of research/stats.mjs
export const SEARCH = Object.freeze({family: 3360, pooled: 13200, clusterSize: 25, windows: 50, correlation: 0.95, level: 0.05});
// 0.01 is the protocol's 0.05 / k with five nominees; with one nominee the level is 0.05.
export const CONFIRMATION = Object.freeze({windows: 24, level: 0.01, levelOneNominee: 0.05, resamples: 10000});
// The buy-and-hold column: b = mean + sd z in percent per window, and r = share b + scale e.
export const HOLDING = Object.freeze({mean: 6, sd: 15, share: 0.4, scale: 3});
export const STRONG_SETTING = 7;   // the one setting given a true mean in the second table
export const POWER_MEANS = Object.freeze([0.25, 0.5, 0.75, 1]);   // in standard deviations per window
export const FIRST = 300;   // the nominee columns are also counted over each row's first 300 nominees
// Simulated studies per row at each width, studies per row of the second table, nominees per row, and resamples
// per study: the first 2,000 of the protocol's 10,000. The nominee columns always use all 10,000.
export const COMMITTED = Object.freeze({family: 400, pooled: 200, power: 100, nominees: 20000, resamples: 2000});
export const QUICK = Object.freeze({family: 8, pooled: 4, power: 4, nominees: 600, resamples: 500});
export const RETIRED_SCALE = Object.freeze({family: 100, nominees: 4000, resamples: 2000});

// The rows of the protocol's first table, in its order and with its labels.
export const ROWS = Object.freeze([
  {label: 'Independent windows, bell-shaped'},
  {label: 'Left-skewed (skewness −0.95)', sigma: 0.3, sign: -1},
  {label: 'Left-skewed (skewness −1.75)', sigma: 0.5, sign: -1},
  {label: 'Right-skewed (skewness +0.95)', sigma: 0.3},
  {label: 'Half the windows without a trade', idle: true},
  {label: 'Runs (lag-1 autocorrelation 0.2)', rho: 0.2},
  {label: 'Left-skewed (−0.95) and runs', sigma: 0.3, sign: -1, rho: 0.2},
  {label: 'Left-skewed (−1.75) and runs', sigma: 0.5, sign: -1, rho: 0.2},
  {label: 'Regimes: good and bad stretches of several windows (lag-1 autocorrelation 0.2)', regimes: true},
  {label: 'Regimes: calm windows with small gains, turbulent windows with large losses', market: true},
  {label: 'No timing value: 40% invested in a rising market', rising: true},
].map(row => Object.freeze({sigma: 0, sign: 1, rho: 0, idle: false, regimes: false, market: false, rising: false, ...row})));

// ---------------------------------------------------------------------------------------------------------------
// Simulated returns.

// Standard normal draws from pairs of uniform draws (the log and cosine transform).
export const gaussian = random => () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

// driver -> return with mean 0 and standard deviation 1 (see the header).
export function shapeOf({sigma = 0, sign = 1}) {
  if (!sigma) return x => x;
  const v = Math.exp(sigma * sigma), centre = Math.sqrt(v), spread = Math.sqrt((v - 1) * v);
  return x => sign * (Math.exp(sigma * x) - centre) / spread;
}

// Skewness of the returns of a skewed row, by construction: sign * (v + 2) sqrt(v - 1) with v = exp(sigma^2).
export const skewnessOf = ({sigma = 0, sign = 1}) => (sigma ? sign * (Math.exp(sigma * sigma) + 2) * Math.sqrt(Math.exp(sigma * sigma) - 1) : 0);

// The driver's autoregression coefficient g that gives the returns a lag-1 autocorrelation of rho. Two unit
// normals with correlation g, each passed through exp(sigma x), correlate (exp(g sigma^2) - 1) / (exp(sigma^2) - 1).
export const driverCoefficient = ({sigma = 0, rho = 0}) => (sigma ? Math.log(1 + rho * (Math.exp(sigma * sigma) - 1)) / (sigma * sigma) : rho);

// A stationary standard normal series with lag-1 autocorrelation g.
function driver(normal, length, g) {
  const series = new Float64Array(length), fresh = Math.sqrt(1 - g * g);
  for (let w = 0; w < length; w++) series[w] = w ? g * series[w - 1] + fresh * normal() : normal();
  return series;
}

// One driver series of a row, with mean 0 and variance 1 in every window: the row's autoregression, or for the
// regimes row 0.5 R + sqrt(0.75) e (R is drawn first, then e).
function driverOf(row, normal, length) {
  if (!row.regimes) return driver(normal, length, driverCoefficient(row));
  return driver(normal, length, 0.8).map(R => 0.5 * R + Math.sqrt(0.75) * normal());
}

// Which windows are idle: exactly half of them (rounded down), each set of that size equally likely.
function idleWindows(random, length) {
  const order = Array.from({length}, (_, w) => w), idle = new Uint8Array(length);
  for (let i = 0; i < length >> 1; i++) {
    const j = i + Math.floor(random() * (length - i));
    [order[i], order[j]] = [order[j], order[i]];
    idle[order[i]] = 1;
  }
  return idle;
}

// The market of the calm/turbulent row: 1 marks a turbulent window (see the header for the probabilities).
export function marketPath(random, length) {
  const turbulent = new Uint8Array(length);
  for (let w = 0; w < length; w++) turbulent[w] = w ? (turbulent[w - 1] ? random() < 0.8 : random() >= 0.95) : random() < 0.2;
  return turbulent;
}
const inMarket = (turbulent, x) => (turbulent ? -2 + 3 * x : 0.5 + x);

// One setting's no-skill returns from a uniform generator; `mean` (in standard deviations) is added to every
// window. This is the nominee design; simulatedStudy below builds the search design from the same parts.
export function simulatedReturns(row, random, length, mean = 0) {
  const shape = shapeOf(row), idle = row.idle ? idleWindows(random, length) : null;
  const turbulent = row.market ? marketPath(random, length) : null;
  return driverOf(row, gaussian(random), length).map((x, w) => (idle?.[w] ? 0 : turbulent ? inMarket(turbulent[w], x) : shape(x)) + mean);
}

// One simulated study: `settings` series of `windows` returns in clusters of `clusterSize` (the last cluster may
// be smaller). strongMean is added to every window of STRONG_SETTING only.
export function simulatedStudy(row, random, {settings = SEARCH.family, clusterSize = SEARCH.clusterSize,
  windows = SEARCH.windows, correlation = SEARCH.correlation, strongMean = 0} = {}) {
  const shape = shapeOf(row), normal = gaussian(random);
  const shared = Math.sqrt(correlation), own = Math.sqrt(1 - correlation), returns = [];
  const turbulent = row.market ? marketPath(random, windows) : null;   // one market for the whole study
  let cluster, idle;
  for (let c = 0; c < settings; c++) {
    if (c % clusterSize === 0) {
      idle = row.idle ? idleWindows(random, windows) : null;
      cluster = driverOf(row, normal, windows);
    }
    const mean = c === STRONG_SETTING ? strongMean : 0;
    returns.push(driverOf(row, normal, windows).map((x, w) => {
      const mixed = shared * cluster[w] + own * x;
      return (idle?.[w] ? 0 : turbulent ? inMarket(turbulent[w], mixed) : shape(mixed)) + mean;
    }));
  }
  return returns;
}

// Where the random numbers come from. Every simulated nominee and every simulated study has its own.
// Nominees read their own stretch of the one mulberry32 cycle (2^32 draws). mulberry32 advances its state by a
// fixed step per draw, which makes "start `position` draws into the stream of SEED" a seed of its own.
// Studies need up to 2.7 million draws each, and the 6,000 of the committed scale need about 4.6 x 10^9, more
// than that cycle holds. So each study has its own xoshiro128** generator (one cycle of 2^128 - 1 states), whose
// starting state is four draws of the mulberry32 stream that belong to that study alone. Two studies would share
// numbers only if their starting states lay within a few million steps of each other on that cycle: for states
// placed at random, a chance below 1e-20 over all pairs. The mulberry32 cycle is laid out as follows:
//   [0, 2^26)             left to the resampling inside research/stats.mjs, which reads from the start of it
//   [2^26, 2^28)          nominees: 2^8 draws each, 2^16 to a table row, room for twelve rows
//   [2^28, 2^28 + 2^23)   studies: four draws each, 2^16 to a table row at each of the two widths
const NOMINEE_DRAWS = 2 ** 8, ROW_NOMINEES = 2 ** 16, ROW_STUDIES = 2 ** 16, WIDTHS = Object.freeze(['family', 'pooled']);
if (ROWS.length * ROW_NOMINEES * NOMINEE_DRAWS > 2 ** 28 - 2 ** 26 || ROWS.length > 16) throw new Error('The table rows no longer fit their stretches of the random stream');
export const LIMITS = Object.freeze({nominees: ROW_NOMINEES, studies: ROW_STUDIES});
export const streamSeed = position => (SEED + Math.imul(position, 0x6D2B79F5)) >>> 0;
function stream(position, draws) {
  const random = mulberry32(streamSeed(position));
  let used = 0;
  return () => {
    if (++used > draws) throw new RangeError('A simulated dataset read past its stretch of the random stream');
    return random();
  };
}

// xoshiro128** 1.1, the public-domain reference algorithm: uniform doubles in [0, 1) with 32 bits of resolution
// from a state of four 32-bit words that are not all zero.
export function xoshiro128ss(a, b, c, d) {
  if (!(a | b | c | d)) throw new RangeError('xoshiro128** needs a state that is not all zero');
  return () => {
    const times5 = Math.imul(b, 5), result = Math.imul((times5 << 7) | (times5 >>> 25), 9), t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return (result >>> 0) / 4294967296;
  };
}

function checkDataset(row, index, limit) {
  if (!Number.isInteger(row) || row < 0 || row >= ROWS.length) throw new RangeError(`Table row must be 0 to ${ROWS.length - 1}`);
  if (!Number.isInteger(index) || index < 0 || index >= limit) throw new RangeError(`Dataset index must be 0 to ${limit - 1}`);
}

// The starting state of the generator of study `index` of table row `row` at `width` ('family' or 'pooled').
export function studyState(width, row, index) {
  if (!WIDTHS.includes(width)) throw new RangeError(`width must be one of: ${WIDTHS.join(', ')}`);
  checkDataset(row, index, ROW_STUDIES);
  const random = mulberry32(streamSeed(2 ** 28 + 4 * ((WIDTHS.indexOf(width) * 16 + row) * ROW_STUDIES + index)));
  return Array.from({length: 4}, () => random() * 2 ** 32);
}

// Study `index` of table row `row` (search design) at `width`: SEARCH.family or SEARCH.pooled settings.
export function makeStudy(width, row, index, strongMean = 0) {
  return simulatedStudy(ROWS[row], xoshiro128ss(...studyState(width, row, index)), {settings: SEARCH[width], strongMean});
}

// Nominee `index` of table row `row`. e: its no-skill returns over the confirmation windows, with `mean` added
// to every window. Then, from the same stretch of the stream, b: the comparison account, and r = share b +
// scale e: the long-only rule of the buy-and-hold column.
export function makeLongOnly(row, index, mean = 0) {
  checkDataset(row, index, ROW_NOMINEES);
  const random = stream(2 ** 26 + (row * ROW_NOMINEES + index) * NOMINEE_DRAWS, NOMINEE_DRAWS);
  const e = simulatedReturns(ROWS[row], random, CONFIRMATION.windows, mean), normal = gaussian(random);
  const b = e.map(() => HOLDING.mean + HOLDING.sd * normal());
  return {e, b, r: e.map((v, w) => HOLDING.share * b[w] + HOLDING.scale * v)};
}
export const makeNominee = (row, index, mean = 0) => makeLongOnly(row, index, mean).e;

// ---------------------------------------------------------------------------------------------------------------
// RETIRED STATISTICS. The first version of the protocol (commit 5a82208) defined these; Amendment 1 replaced
// them. They are reimplemented here for contrast only (--retired) and are used by nothing else.

// RETIRED search-adjusted p-value ("reality check"): the observed maximum of the plain t statistic, against
// resampled maxima of (mean* - mean) / (sd / sqrt(n)) with the FULL-sample sd, so nothing is re-studentized and
// there is no autocorrelation factor. For complete tables only (no invalid windows), every setting searched.
// The windows drawn are those searchAdjustedP draws for the same seed.
export function retiredRealityCheck({returns, resamples = 10000, seed = SEED}) {
  const windows = returns[0].length, random = mulberry32(seed);
  const drawnWindow = new Uint32Array(resamples * windows), drawnTimes = new Float64Array(resamples * windows);
  const first = new Uint32Array(resamples + 1), times = new Uint32Array(windows);
  for (let b = 0, k = 0; b < resamples; b++) {
    times.fill(0);
    for (let draw = 0; draw < windows; draw++) times[Math.floor(random() * windows)]++;
    for (let w = 0; w < windows; w++) if (times[w]) { drawnWindow[k] = w; drawnTimes[k++] = times[w]; }
    first[b + 1] = k;
  }
  const best = new Float64Array(resamples).fill(-Infinity);
  let observedMax = -Infinity, argmax = -1;
  returns.forEach((row, c) => {
    let sum = 0, squares = 0;
    for (let w = 0; w < windows; w++) {
      if (!Number.isFinite(row[w])) throw new TypeError('The retired statistic is kept for complete tables only');
      sum += row[w];
    }
    const mean = sum / windows;
    for (let w = 0; w < windows; w++) squares += (row[w] - mean) ** 2;
    const se = Math.sqrt(squares / (windows - 1)) / Math.sqrt(windows), t = se === 0 ? 0 : mean / se;
    if (t > observedMax) { observedMax = t; argmax = c; }
    if (se === 0) return;
    for (let b = 0; b < resamples; b++) {
      let total = 0;
      for (let k = first[b], end = first[b + 1]; k < end; k++) total += drawnTimes[k] * row[drawnWindow[k]];
      const statistic = (total / windows - mean) / se;
      if (statistic > best[b]) best[b] = statistic;
    }
  });
  let reached = 0;
  for (let b = 0; b < resamples; b++) if (best[b] >= observedMax || best[b] === -Infinity) reached++;
  return {observedMax, argmax, p: reached / resamples, resamples, seed};
}

// RETIRED confirmation test: the one-sided t-test alone, on the plain t statistic.
export const retiredConfirmationP = xs => tTestGreaterP(xs);

// ---------------------------------------------------------------------------------------------------------------
// Counting. A task is datasets from..to-1 of one table row, with `mean` added as in the second table:
//   {kind: 'search', width, row, from, to, mean, resamples}   simulated studies
//   {kind: 'nominees', row, from, to, mean}                   simulated nominees
// `retired: true` also counts the retired statistics on the same datasets. Every tally is a flat list of counts,
// so the tallies of a row's tasks add up.

export function runTask({kind, width, row, from, to, mean = 0, resamples, retired = false}) {
  if (kind === 'search') {
    // count: p < 0.05. best: also the true setting of the second table holds the best score.
    const tally = {of: to - from, count: 0, best: 0, retired: 0};
    for (let index = from; index < to; index++) {
      const returns = makeStudy(width, row, index, mean);
      const result = searchAdjustedP({returns, eligible: returns.map((_, c) => c), resamples});
      if (result.p < SEARCH.level) { tally.count++; if (result.argmax === STRONG_SETTING) tally.best++; }
      if (retired && retiredRealityCheck({returns, resamples}).p < SEARCH.level) tally.retired++;
    }
    return tally;
  }
  // confirmed: mean > 0 and confirmation p < 0.01 (five nominees). one: the same at 0.05 (one nominee).
  // reading: intercept > 0 and the buy-and-hold reading's p < 0.01. first...: the same among indices below FIRST.
  // (A p-value below one half already implies a mean, or an intercept, above zero: each of these p-values is at
  // least a one-sided t-test's. The conditions are written out as the protocol writes them.)
  const tally = {of: to - from, confirmed: 0, one: 0, reading: 0, firstConfirmed: 0, firstOne: 0, firstReading: 0, retired: 0};
  for (let index = from; index < to; index++) {
    const {e, b, r} = makeLongOnly(row, index, mean), first = index < FIRST ? 1 : 0;
    const tested = ROWS[row].rising ? r : e, confirmation = confirmationP(tested, {resamples: CONFIRMATION.resamples});
    if (confirmation.mean > 0 && confirmation.p < CONFIRMATION.level) { tally.confirmed++; tally.firstConfirmed += first; }
    if (confirmation.mean > 0 && confirmation.p < CONFIRMATION.levelOneNominee) { tally.one++; tally.firstOne += first; }
    const reading = buyAndHoldReading(r, b, {resamples: CONFIRMATION.resamples});
    if (reading.intercept > 0 && reading.p < CONFIRMATION.level) { tally.reading++; tally.firstReading += first; }
    if (retired && retiredConfirmationP(tested) < CONFIRMATION.level) tally.retired++;
  }
  return tally;
}

// Runs every task, on `threads` workers when that is more than one, and returns the tallies in task order.
async function runAll(tasks, threads, progress) {
  const results = new Array(tasks.length);
  let next = 0, done = 0;
  const finished = (i, tally) => { results[i] = tally; progress?.(++done, tasks.length); };
  if (threads <= 1) { for (const [i, task] of tasks.entries()) finished(i, runTask(task)); return results; }
  await Promise.all(Array.from({length: Math.min(threads, tasks.length)}, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {workerData: {calibrationWorker: true}, execArgv: []});
    let current;
    const give = () => {
      if (next >= tasks.length) { worker.terminate().then(resolve, reject); return; }
      current = next++;
      worker.postMessage(tasks[current]);
    };
    worker.on('message', tally => { finished(current, tally); give(); });
    worker.on('error', reject);
    give();
  })));
  return results;
}

// Collects tasks. search() and nominees() split a row's datasets into tasks and return the object that holds the
// row's summed tallies once run() has finished.
function planner(threads, progress) {
  const tasks = [];
  const split = (task, total, size) => {
    const into = {};
    for (let from = 0; from < total; from += size) tasks.push({task: {...task, from, to: Math.min(total, from + size)}, into});
    return into;
  };
  const run = async () => {
    const tallies = await runAll(tasks.map(entry => entry.task), threads, progress);
    tallies.forEach((tally, t) => { for (const [key, count] of Object.entries(tally)) tasks[t].into[key] = (tasks[t].into[key] ?? 0) + count; });
  };
  // About two seconds of work per task at the committed scale.
  return {run, search: (width, row, mean, studies, resamples, retired) => split({kind: 'search', width, row, mean, resamples, retired}, studies, width === 'family' ? 4 : 1),
    nominees: (row, mean, nominees, retired) => split({kind: 'nominees', row, mean, retired}, nominees, 400)};
}

function checkScale(scale, names) {
  for (const name of names) {
    const limit = name === 'nominees' ? ROW_NOMINEES : name === 'resamples' ? 10000 : ROW_STUDIES;
    if (!Number.isInteger(scale[name]) || scale[name] < 1 || scale[name] > limit) throw new RangeError(`${name} must be an integer from 1 to ${limit}`);
  }
}

const STATS_FILE = new URL('./stats.mjs', import.meta.url), JSON_FILE = new URL('./calibration.json', import.meta.url);
const PROTOCOL_FILE = new URL('./PROTOCOL.md', import.meta.url);
export const statsSha256 = () => createHash('sha256').update(readFileSync(STATS_FILE)).digest('hex');

// The whole measurement, as research/calibration.json holds it:
//   statsSha256  SHA-256 of research/stats.mjs when it was measured
//   options      every constant and count of the measurement
//   sizes        one row per ROWS entry: {label, family, pooled, confirmation, buyAndHold}
//   power        one row per POWER_MEANS entry: {mean, pooled, five, one, buyAndHold}
// A search cell is {count, of} (in the second table also best: the count in which the true setting also holds
// the best score); a nominee cell is {count, of, first300}, first300 being the count among the row's first 300
// nominees (all of them when fewer are measured). The last row's search cells are null: not measured.
export async function calibrate({scale = COMMITTED, threads = Math.min(4, availableParallelism()), progress} = {}) {
  checkScale(scale, ['family', 'pooled', 'power', 'nominees', 'resamples']);
  const {family, pooled, power, nominees, resamples} = scale, measuredWith = statsSha256(), plan = planner(threads, progress);
  const sizes = ROWS.map((row, r) => ({
    family: row.rising ? null : plan.search('family', r, 0, family, resamples),
    pooled: row.rising ? null : plan.search('pooled', r, 0, pooled, resamples),
    nominees: plan.nominees(r, 0, nominees)}));
  const powers = POWER_MEANS.map(mean => ({pooled: plan.search('pooled', 0, mean, power, resamples), nominees: plan.nominees(0, mean, nominees)}));
  await plan.run();
  if (statsSha256() !== measuredWith) throw new Error('research/stats.mjs changed while it was being measured');
  const studies = tally => tally && {count: tally.count, of: tally.of};
  const nominee = (tally, key, firstKey) => ({count: tally[key], of: tally.of, first300: tally[firstKey]});
  return {
    statsSha256: measuredWith,
    options: {
      seed: SEED,
      search: {level: SEARCH.level, windows: SEARCH.windows, clusterSize: SEARCH.clusterSize, correlation: SEARCH.correlation, resamples,
        family: {settings: SEARCH.family, studies: family}, pooled: {settings: SEARCH.pooled, studies: pooled}, powerStudies: power, strongSetting: STRONG_SETTING},
      nominees: {windows: CONFIRMATION.windows, perRow: nominees, first: FIRST, resamples: CONFIRMATION.resamples, level: CONFIRMATION.level,
        levelOneNominee: CONFIRMATION.levelOneNominee},
      holding: {...HOLDING},
    },
    sizes: ROWS.map((row, r) => ({label: row.label, family: studies(sizes[r].family), pooled: studies(sizes[r].pooled),
      confirmation: nominee(sizes[r].nominees, 'confirmed', 'firstConfirmed'), buyAndHold: nominee(sizes[r].nominees, 'reading', 'firstReading')})),
    power: POWER_MEANS.map((mean, i) => ({mean, pooled: {...studies(powers[i].pooled), best: powers[i].pooled.best},
      five: nominee(powers[i].nominees, 'confirmed', 'firstConfirmed'), one: nominee(powers[i].nominees, 'one', 'firstOne'),
      buyAndHold: nominee(powers[i].nominees, 'reading', 'firstReading')})),
  };
}

// The retired statistics beside the amended ones on the no-skill rows: [{label, search: {amended, retired},
// confirmation: {amended, retired}}], every leaf {count, of}. Search: p < 0.05 at the family width.
// Confirmation: p < 0.01.
export async function compareRetired({scale = RETIRED_SCALE, threads = Math.min(4, availableParallelism()), progress} = {}) {
  checkScale(scale, ['family', 'nominees', 'resamples']);
  const plan = planner(threads, progress), rows = ROWS.filter(row => !row.rising);
  const tallies = rows.map((_, r) => ({search: plan.search('family', r, 0, scale.family, scale.resamples, true), nominees: plan.nominees(r, 0, scale.nominees, true)}));
  await plan.run();
  return rows.map((row, r) => { const {search, nominees} = tallies[r]; return {label: row.label,
    search: {amended: {count: search.count, of: search.of}, retired: {count: search.retired, of: search.of}},
    confirmation: {amended: {count: nominees.confirmed, of: nominees.of}, retired: {count: nominees.retired, of: nominees.of}}}; });
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering: the two tables as research/PROTOCOL.md holds them, the file research/calibration.json, and the text
// this command prints.

const thousands = n => String(n).replace(/\B(?=(\d{3})+$)/g, ',');

// count / of in percent, in whole-number arithmetic: one decimal below 10%, whole percent from 10% up, halves
// rounded up. `ceiling` rounds up instead, for an upper bound that has to stay true.
function percent(count, of, ceiling = false) {
  const tenths = ceiling ? Math.ceil(1000 * count / of) : Math.floor((2000 * count + of) / (2 * of));
  if (tenths < 100) return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
  return `${ceiling ? Math.ceil(100 * count / of) : Math.floor((200 * count + of) / (2 * of))}%`;
}

// One table cell. A count of zero does not show a rate of zero: it is given with the bound 3 / n, the largest
// rate that would still leave a count of 0 in n likely enough (about 1 chance in 20).
export function cellText(cell) {
  if (!cell) return 'not measured';
  const {count, of} = cell;
  return count ? `${percent(count, of)} (${thousands(count)} of ${thousands(of)})` : `0 of ${thousands(of)} (below ${percent(Math.min(3, of), of, true)})`;
}

const markdownTable = (header, rows) => [header, null, ...rows].map(cells => (cells ? `| ${cells.join(' | ')} |` : `|${'---|'.repeat(header.length)}`)).join('\n');

// The two tables of PROTOCOL.md, "What the tests can and cannot do", as GitHub Markdown, from a measurement.
export function renderProtocolTables({options: {search, nominees}, sizes, power}) {
  const searched = width => `Search-adjusted p < ${search.level}, ${width === 'family' ? 'one family' : 'all families'} (${thousands(search[width].settings)} settings)`;
  const reading = '"More than a share of buy-and-hold: yes"';
  return {
    sizes: markdownTable(['No-skill returns', searched('family'), searched('pooled'), `Confirmation p < ${nominees.level} (${nominees.windows} windows)`,
      `${reading} at p < ${nominees.level} (${nominees.windows} windows)`],
      sizes.map(row => [row.label, ...[row.family, row.pooled, row.confirmation, row.buyAndHold].map(cellText)])),
    power: markdownTable(['True mean per window, in standard deviations', searched('pooled'), `Confirmed with five nominees (p < ${nominees.level})`,
      `Confirmed with one nominee (p < ${nominees.levelOneNominee})`, `${reading} with five nominees`],
      power.map(row => [String(row.mean), ...[row.pooled, row.five, row.one, row.buyAndHold].map(cellText)])),
  };
}

// A marked block of the protocol: where the text between its two markers starts and ends. Each marker has to
// stand exactly once, the start before the end.
function blockOf(text, name) {
  const start = `<!-- calibration:${name}:start -->`, end = `<!-- calibration:${name}:end -->`;
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < from || text.indexOf(start, from + 1) >= 0 || text.indexOf(end, to + 1) >= 0)
    throw new Error(`research/PROTOCOL.md needs the two markers of the ${name} table exactly once each, in order`);
  return {from: from + start.length, to};
}

// The protocol text with its two marked blocks replaced by the tables of `calibration`. Nothing else changes.
export function withProtocolTables(protocolText, calibration) {
  const tables = renderProtocolTables(calibration);
  return ['sizes', 'power'].reduce((text, name) => {
    const block = blockOf(text, name);
    return `${text.slice(0, block.from)}\n${tables[name]}\n${text.slice(block.to)}`;
  }, protocolText);
}

// Whether the protocol's two marked blocks are exactly the tables of `calibration`. False for a text without the
// markers and for a measurement that cannot be rendered.
export function protocolTablesInSync(protocolText, calibration) {
  try { return withProtocolTables(protocolText, calibration) === protocolText; } catch { return false; }
}

// research/calibration.json as text: one line per table row, so that a changed count is one changed line.
export function serialize({statsSha256: hash, options, sizes, power}) {
  const lines = rows => rows.map(row => `    ${JSON.stringify(row)}`).join(',\n');
  return `{\n  "statsSha256": ${JSON.stringify(hash)},\n  "options": ${JSON.stringify(options)},\n  "sizes": [\n${lines(sizes)}\n  ],\n  "power": [\n${lines(power)}\n  ]\n}\n`;
}

// What the command prints: the scale, then the two tables exactly as the protocol holds them.
export function formatCalibration(calibration, {quick = false} = {}) {
  const {search, nominees} = calibration.options, tables = renderProtocolTables(calibration);
  const label = 'QUICK LOOK at a small scale: rough figures, not the committed measurement, and never written to a file.';
  return [
    ...(quick ? [label, ''] : []),
    'How often each test passes when there is nothing to find. Simulated returns: every figure describes the tests,',
    'not a rule and not a market.',
    `Search columns: ${thousands(search.family.studies)} simulated studies per row for one family and ${thousands(search.pooled.studies)} for all families, ` +
      'settings in clusters of',
    `${search.clusterSize} near-identical ones over ${search.windows} windows, the first ${thousands(search.resamples)} of the protocol's 10,000 resamples per study.`,
    `Other columns: ${thousands(nominees.perRow)} simulated nominees per row over ${nominees.windows} windows, ${thousands(nominees.resamples)} resamples per nominee.`,
    'A count of 0 in n is given with the bound 3 / n.',
    '',
    tables.sizes,
    '',
    `How often a real mean is found. Bell-shaped returns, one setting with the true mean: ${thousands(search.powerStudies)} simulated studies per row`,
    `and ${thousands(nominees.perRow)} simulated nominees per row.`,
    '',
    tables.power,
    '',
    `research/stats.mjs as measured: SHA-256 ${calibration.statsSha256}`,
    ...(quick ? ['', label] : []),
  ].join('\n');
}

export function formatRetired(rows, {quick = false} = {}) {
  const {search, confirmation} = rows[0];
  return [
    ...(quick ? ['QUICK LOOK at a small scale: rough figures.', ''] : []),
    'The first version\'s statistics (commit 5a82208, RETIRED by Amendment 1) beside the amended ones, on simulated',
    `returns with nothing to find: ${thousands(search.amended.of)} studies of ${thousands(SEARCH.family)} settings and ${thousands(confirmation.amended.of)} nominees ` +
      'per row. Not part of the',
    'protocol\'s two tables.',
    '',
    markdownTable(['No-skill returns', `Search-adjusted p < ${SEARCH.level}, amended`, `Search p < ${SEARCH.level}, RETIRED`,
      `Confirmation p < ${CONFIRMATION.level}, amended`, `Confirmation p < ${CONFIRMATION.level}, RETIRED (t-test alone)`],
      rows.map(row => [row.label, ...[row.search.amended, row.search.retired, row.confirmation.amended, row.confirmation.retired].map(cellText)])),
  ].join('\n');
}

const USAGE = 'Usage: node research/calibration.mjs [--quick | --write | --check | --retired [--quick]] [--threads T]';
function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--quick', '--write', '--check', '--retired'].includes(flag)) options[flag.slice(2)] = true;
    else if (flag === '--threads') {
      options.threads = Number(argv[++i]);
      if (!Number.isInteger(options.threads) || options.threads < 1) throw new Error('--threads needs a positive integer');
    } else throw new Error(`Unknown option ${flag}. ${USAGE}`);
  }
  const {quick, write, check, retired} = options;
  if ((write && (quick || check || retired)) || (check && (quick || retired || options.threads)))
    throw new Error(`--write and --check stand alone: the committed scale is the only one written or checked. ${USAGE}`);
  return options;
}

async function main(argv) {
  const {quick, write, check, retired, threads} = parseArguments(argv);
  if (check) {
    const inSync = protocolTablesInSync(readFileSync(PROTOCOL_FILE, 'utf8'), JSON.parse(readFileSync(JSON_FILE, 'utf8')));
    console.log(`The two tables of research/PROTOCOL.md ${inSync ? 'equal' : 'DIFFER FROM'} the rendering of research/calibration.json.`);
    return inSync ? 0 : 1;
  }
  let shown = -1;
  const progress = (done, total) => {   // progress goes to stderr; what stdout shows is deterministic
    const step = Math.floor(20 * done / total);
    if (step > shown) { shown = step; process.stderr.write(`${5 * step}% of ${total} tasks\n`); }
  };
  if (retired) { console.log(formatRetired(await compareRetired({scale: quick ? QUICK : RETIRED_SCALE, threads, progress}), {quick})); return 0; }
  if (write) for (const name of ['sizes', 'power']) blockOf(readFileSync(PROTOCOL_FILE, 'utf8'), name);   // the markers, before hours of work
  const calibration = await calibrate({scale: quick ? QUICK : COMMITTED, threads, progress});
  if (write) {
    writeFileSync(JSON_FILE, serialize(calibration));
    writeFileSync(PROTOCOL_FILE, withProtocolTables(readFileSync(PROTOCOL_FILE, 'utf8'), calibration));
  }
  console.log(formatCalibration(calibration, {quick}));
  if (write) console.log('\nWritten: research/calibration.json and the two marked tables of research/PROTOCOL.md.');
  return 0;
}

if (!isMainThread && workerData?.calibrationWorker) {
  parentPort.on('message', task => parentPort.postMessage(runTask(task)));
} else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
