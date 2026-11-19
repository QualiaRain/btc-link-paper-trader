#!/usr/bin/env node
// How strict are the protocol's two tests when nothing has skill? (research/PROTOCOL.md, "What the two tests can
// and cannot do".) This script simulates returns whose true mean is exactly zero, runs the search-adjusted
// p-value and the confirmation p-value of research/stats.mjs on them, and prints how often each falls below
// its level: the SIZE of each test. A second, smaller table measures how often a real mean is detected.
//
//   node research/calibration.mjs [--datasets N] [--quick] [--resamples R] [--settings S] [--threads T]
//
//   --datasets N    simulated studies per row for the search test (default 1,600). The confirmation test uses
//                   10 x N simulated nominees per row.
//   --quick         a fast look: 200 studies, 2,000 nominees, 1,000 resamples per study (about half a minute).
//   --resamples R   resamples per simulated study in the search test (default 2,000: the first 2,000 of the
//                   protocol's 10,000, which cost five times as much). On the first 400 studies of the first
//                   and of the seventh row, 2,000 and 10,000 resamples disagreed on "p < 0.05" in 1 and in 4
//                   studies (--datasets 400 --resamples 10000 reproduces the 10,000 side). The confirmation
//                   test always uses the protocol's 10,000.
//   --settings S    settings searched in each simulated study (default 300, the protocol's table), still in
//                   clusters of 25. The study itself pools 13,200, and the size of the search test depends on
//                   the width: --settings 13200 --datasets 200 --resamples 500 measures it there (about 30
//                   minutes of processor time).
//   --threads T     worker threads (default: up to 4). The numbers do not depend on T.
//
// The default run takes about 25 minutes of processor time, 6 to 9 minutes on four cores. Its standard errors
// are below a fifth of every figure in its first table.
//
// Everything is simulated from a seeded generator: no market data is read, no clock enters a result, and two
// runs with the same options print the same table. Nothing here places or models an order.
//
// The simulated data. A window return is shape(x), with x a standard normal driver and shape chosen so that
// the return has mean exactly 0 and standard deviation 1:
//   bell-shaped     shape(x) = x
//   skewed          a shifted lognormal, sign * (exp(sigma x) - exp(sigma^2 / 2)) / its standard deviation;
//                   sigma 0.3 has skewness 0.95 and sigma 0.5 has 1.75; sign -1 puts the long tail on the losses
//   idle            exactly half of the windows, chosen at random, return exactly 0 (no trade); it is the
//                   largest idle share the protocol's eligibility rule allows
//   in runs         the driver is a stationary first-order autoregression across windows, its coefficient
//                   chosen so that the RETURNS (after shape) have lag-1 autocorrelation 0.2
// Search test: 300 settings in 12 clusters of 25 near-identical settings over 50 windows. Within a cluster each
// setting's driver is sqrt(0.95) x (the cluster's driver) + sqrt(0.05) x (its own), so two settings of a cluster
// correlate about 0.95 and different clusters are independent; a cluster's idle windows are shared.
// Confirmation test: one setting over 24 windows.
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {fileURLToPath} from 'node:url';
import {searchAdjustedP, confirmationP, tTestGreaterP, mulberry32} from './stats.mjs';

export const SEED = 20261118;   // also the resampling seed of research/stats.mjs
export const SEARCH = Object.freeze({settings: 300, clusterSize: 25, windows: 50, correlation: 0.95, level: 0.05});
export const CONFIRMATION = Object.freeze({windows: 24, levels: Object.freeze([0.01, 0.05])});
export const STRONG_SETTING = 7;   // the one setting given a true mean in the detection table
export const DETECTION_MEANS = Object.freeze([0.3, 0.5, 0.75, 1]);   // in standard deviations per window

// The rows of the protocol's table. Left-skewed data comes in two strengths, alone and in runs.
export const ROWS = Object.freeze([
  {label: 'Independent, bell-shaped'},
  {label: 'Left-skewed (skewness -0.95)', sigma: 0.3, sign: -1},
  {label: 'Left-skewed (skewness -1.75)', sigma: 0.5, sign: -1},
  {label: 'Right-skewed (skewness +0.95)', sigma: 0.3},
  {label: 'Half the windows without a trade', idle: true},
  {label: 'In runs (lag-1 autocorrelation 0.2)', rho: 0.2},
  {label: 'Left-skewed (-0.95) and in runs (0.2)', sigma: 0.3, sign: -1, rho: 0.2},
  {label: 'Left-skewed (-1.75) and in runs (0.2)', sigma: 0.5, sign: -1, rho: 0.2},
].map(row => Object.freeze({sigma: 0, sign: 1, rho: 0, idle: false, ...row})));

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

// Skewness of the returns of a row, by construction: sign * (v + 2) sqrt(v - 1) with v = exp(sigma^2).
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

// One setting's no-skill returns from a uniform generator; `mean` (in standard deviations) is added to every
// window. This is the confirmation design; simulatedStudy below builds the search design from the same parts.
export function simulatedReturns(row, random, length, mean = 0) {
  const shape = shapeOf(row), idle = row.idle ? idleWindows(random, length) : null;
  return driver(gaussian(random), length, driverCoefficient(row)).map((x, w) => (idle?.[w] ? 0 : shape(x)) + mean);
}

// One simulated study: `settings` series of `windows` returns in clusters of `clusterSize`. strongMean is
// added to every window of STRONG_SETTING only.
export function simulatedStudy(row, random, {settings = SEARCH.settings, clusterSize = SEARCH.clusterSize,
  windows = SEARCH.windows, correlation = SEARCH.correlation, strongMean = 0} = {}) {
  const shape = shapeOf(row), g = driverCoefficient(row), normal = gaussian(random);
  const shared = Math.sqrt(correlation), own = Math.sqrt(1 - correlation), returns = [];
  let cluster, idle;
  for (let c = 0; c < settings; c++) {
    if (c % clusterSize === 0) {
      idle = row.idle ? idleWindows(random, windows) : null;
      cluster = driver(normal, windows, g);
    }
    const mean = c === STRONG_SETTING ? strongMean : 0;
    returns.push(driver(normal, windows, g).map((x, w) => (idle?.[w] ? 0 : shape(shared * cluster[w] + own * x)) + mean));
  }
  return returns;
}

// Every simulated study and nominee reads its own stretch of the one mulberry32 cycle (2^32 draws), so no two
// of them share a random number. mulberry32 advances its state by a fixed step per draw, which makes "start
// `position` draws into the stream of SEED" a seed of its own. The cycle is laid out as follows:
//   [0, 2^26)       left to the resampling inside research/stats.mjs, which reads from the start of that stream
//   [2^26, 2^28)    nominees: 2^8 draws each, up to 2^16 per table row
//   [2^28, 2^32)    studies: an equal span per table row, 128 draws per setting (a setting needs 105 at 50
//                   windows), so the number of studies a row can hold shrinks as the search widens
const NOMINEE_DRAWS = 2 ** 8, ROW_NOMINEES = 2 ** 16, SETTING_DRAWS = 128, ROW_SPAN = Math.floor((2 ** 32 - 2 ** 28) / ROWS.length);
if (ROWS.length * ROW_NOMINEES * NOMINEE_DRAWS > 2 ** 28 - 2 ** 26) throw new Error('The table rows no longer fit their stretches of the random stream');
export const LIMITS = Object.freeze({nominees: ROW_NOMINEES, studies: (settings = SEARCH.settings) => Math.floor(ROW_SPAN / (SETTING_DRAWS * settings))});
export const streamSeed = position => (SEED + Math.imul(position, 0x6D2B79F5)) >>> 0;
function stream(position, draws) {
  const random = mulberry32(streamSeed(position));
  let used = 0;
  return () => {
    if (++used > draws) throw new RangeError('A simulated dataset read past its stretch of the random stream');
    return random();
  };
}

// Study `index` of table row `row` (search design; options as for simulatedStudy), and nominee `index` of that
// row (confirmation design).
export function makeStudy(row, index, options = {}) {
  const draws = SETTING_DRAWS * (options.settings ?? SEARCH.settings), limit = Math.floor(ROW_SPAN / draws);
  if (!Number.isInteger(index) || index < 0 || index >= limit) throw new RangeError(`Study index must be 0 to ${limit - 1} at this width`);
  return simulatedStudy(ROWS[row], stream(2 ** 28 + row * ROW_SPAN + index * draws, draws), options);
}
export function makeNominee(row, index, mean = 0) {
  if (!Number.isInteger(index) || index < 0 || index >= ROW_NOMINEES) throw new RangeError(`Nominee index must be 0 to ${ROW_NOMINEES - 1}`);
  const position = 2 ** 26 + (row * ROW_NOMINEES + index) * NOMINEE_DRAWS;
  return simulatedReturns(ROWS[row], stream(position, NOMINEE_DRAWS), CONFIRMATION.windows, mean);
}

// ---------------------------------------------------------------------------------------------------------------
// RETIRED STATISTICS. The first version of the protocol (commit 5a82208) defined these; Amendment 1 replaced
// them. They are reimplemented here for contrast only and are used by nothing else.

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
// Counting. A task is {test: 'search' | 'confirmation', row, from, to, mean, resamples, settings}: datasets
// from..to-1 of one table row. mean 0 is the no-skill table and also runs the retired statistics; any other mean
// is the detection table.

export function runTask({test, row, from, to, mean = 0, resamples, settings = SEARCH.settings}) {
  const tally = {datasets: to - from, amended: [0, 0], retired: [0, 0], found: 0};
  for (let index = from; index < to; index++) {
    if (test === 'search') {
      const returns = makeStudy(row, index, {settings, strongMean: mean});
      const result = searchAdjustedP({returns, eligible: returns.map((_, c) => c), resamples});
      if (result.p < SEARCH.level) { tally.amended[0]++; if (result.argmax === STRONG_SETTING) tally.found++; }
      if (!mean && retiredRealityCheck({returns, resamples}).p < SEARCH.level) tally.retired[0]++;
    } else {
      const xs = makeNominee(row, index, mean), amended = confirmationP(xs).p, retired = retiredConfirmationP(xs);
      CONFIRMATION.levels.forEach((level, i) => {
        if (amended < level) tally.amended[i]++;
        if (retired < level) tally.retired[i]++;
      });
    }
  }
  return tally;
}

// A share of `total` with its standard error (binomial).
export function share(count, total) {
  const value = count / total;
  return {count, total, share: value, se: Math.sqrt(value * (1 - value) / total)};
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

// The whole measurement. Returns {options, rows: [{label, skewness, lag1, search: {amended, retired},
// confirmation: [{level, amended, retired}]}], detection: [{mean, search: {detected, found}, confirmation:
// [{level, detected}]}]}, every leaf a share() of its datasets.
export async function calibrate({datasets = 1600, nominees = 10 * datasets, resamples = 2000, settings = SEARCH.settings,
  threads = Math.min(4, availableParallelism()), progress} = {}) {
  if (!Number.isInteger(settings) || settings < SEARCH.clusterSize) throw new RangeError(`settings must be an integer of at least ${SEARCH.clusterSize}`);
  for (const [name, value, limit] of [['datasets', datasets, LIMITS.studies(settings)], ['nominees', nominees, ROW_NOMINEES]])
    if (!Number.isInteger(value) || value < 4 || value > limit) throw new RangeError(`${name} must be an integer from 4 to ${limit}`);
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  const tasks = [], sum = () => ({datasets: 0, amended: [0, 0], retired: [0, 0], found: 0});
  // About a second of work per task at the default width, whatever the width.
  const studies = Math.max(1, Math.round(20 * SEARCH.settings / settings));
  const split = (test, row, mean, total, size, into) => {
    for (let from = 0; from < total; from += size) tasks.push({task: {test, row, from, to: Math.min(total, from + size), mean, resamples, settings}, into});
  };
  const rows = ROWS.map(() => ({search: sum(), confirmation: sum()}));
  const detection = DETECTION_MEANS.map(() => ({search: sum(), confirmation: sum()}));
  ROWS.forEach((_, row) => { split('search', row, 0, datasets, studies, rows[row].search); split('confirmation', row, 0, nominees, 400, rows[row].confirmation); });
  // The detection table reuses the bell-shaped row's data with a mean added, on a quarter of the datasets.
  DETECTION_MEANS.forEach((mean, i) => {
    split('search', 0, mean, datasets >> 2, studies, detection[i].search);
    split('confirmation', 0, mean, nominees >> 2, 400, detection[i].confirmation);
  });
  const tallies = await runAll(tasks.map(entry => entry.task), threads, progress);
  tallies.forEach((tally, t) => {
    const into = tasks[t].into;
    into.datasets += tally.datasets; into.found += tally.found;
    for (const i of [0, 1]) { into.amended[i] += tally.amended[i]; into.retired[i] += tally.retired[i]; }
  });
  return {
    options: {datasets, nominees, resamples, settings, confirmationResamples: 10000, seed: SEED},
    rows: ROWS.map((row, r) => ({label: row.label, skewness: skewnessOf(row), lag1: row.rho, idle: row.idle,
      search: {amended: share(rows[r].search.amended[0], rows[r].search.datasets), retired: share(rows[r].search.retired[0], rows[r].search.datasets)},
      confirmation: CONFIRMATION.levels.map((level, i) => ({level, amended: share(rows[r].confirmation.amended[i], rows[r].confirmation.datasets),
        retired: share(rows[r].confirmation.retired[i], rows[r].confirmation.datasets)}))})),
    detection: DETECTION_MEANS.map((mean, d) => ({mean,
      search: {detected: share(detection[d].search.amended[0], detection[d].search.datasets), found: share(detection[d].search.found, detection[d].search.datasets)},
      confirmation: CONFIRMATION.levels.map((level, i) => ({level, detected: share(detection[d].confirmation.amended[i], detection[d].confirmation.datasets)}))})),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Printing.

const percent = ({share: value, se}, digits) => `${(100 * value).toFixed(digits)} ±${(100 * se).toFixed(digits)}`;
const thousands = n => n.toLocaleString('en-US');
const line = cells => cells.map((cell, i) => (i ? cell.padStart(13) : cell.padEnd(40))).join('').trimEnd();

export function formatCalibration({options, rows, detection}) {
  const S = SEARCH, C = CONFIRMATION, quarter = n => thousands(n >> 2);
  return [
    'Size of the two tests on simulated data with no skill (every true mean exactly 0).',
    'Each figure is a share in percent ± its standard error. "amended" is research/stats.mjs as the protocol',
    'now defines it; "RETIRED" is the first version\'s statistic (commit 5a82208), kept in this file for contrast.',
    `A test exactly as strict as it claims would show ${100 * S.level} under Search and ${C.levels.map(level => 100 * level).join(' and ')} under the confirmation levels.`,
    '',
    `Search test: share of studies with search-adjusted p < ${S.level}. ${thousands(options.settings)} settings in clusters of ` +
      `${S.clusterSize} (within-cluster`,
    `correlation ${S.correlation}), ${S.windows} windows, ${thousands(options.datasets)} studies per row, ${thousands(options.resamples)} resamples per study.`,
    `Confirmation test: share of nominees with confirmation p below the level. One setting, ${C.windows} windows,`,
    `${thousands(options.nominees)} nominees per row, ${thousands(options.confirmationResamples)} resamples per nominee.`,
    '',
    line(['', 'Search', 'Search', ...C.levels.flatMap(level => [`Conf. <${level}`, `Conf. <${level}`])]),
    line(['No-skill data', 'amended', 'RETIRED', ...C.levels.flatMap(() => ['amended', 'RETIRED'])]),
    ...rows.map(row => line([row.label, percent(row.search.amended, 1), percent(row.search.retired, 1),
      ...row.confirmation.flatMap(c => [percent(c.amended, 2), percent(c.retired, 2)])])),
    '',
    'Detection of a real mean (bell-shaped data, the amended tests only). Search: one of the settings has the',
    `mean, ${quarter(options.datasets)} studies; "detected" is p < ${S.level}, "and found" also needs that setting to hold the best score.`,
    `Confirmation: the nominee has the mean, ${quarter(options.nominees)} nominees.`,
    '',
    line(['', 'Search', 'Search', ...C.levels.map(level => `Conf. <${level}`)]),
    line(['True mean per window', 'detected', 'and found', ...C.levels.map(() => 'detected')]),
    ...detection.map(d => line([`${d.mean} standard deviations`, percent(d.search.detected, 1), percent(d.search.found, 1),
      ...d.confirmation.map(c => percent(c.detected, 1))])),
  ].join('\n');
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], number = () => {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a positive integer`);
      return value;
    };
    if (flag === '--quick') Object.assign(options, {datasets: 200, resamples: 1000, ...options});
    else if (flag === '--datasets') options.datasets = number();
    else if (flag === '--resamples') options.resamples = number();
    else if (flag === '--settings') options.settings = number();
    else if (flag === '--threads') options.threads = number();
    else throw new Error(`Unknown option ${flag}. Usage: node research/calibration.mjs [--datasets N] [--quick] [--resamples R] [--settings S] [--threads T]`);
  }
  return options;
}

if (!isMainThread && workerData?.calibrationWorker) {
  parentPort.on('message', task => parentPort.postMessage(runTask(task)));
} else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    let shown = -1;
    const progress = (done, total) => {   // progress goes to stderr; the table on stdout is deterministic
      const tenth = Math.floor(10 * done / total);
      if (tenth > shown) { shown = tenth; process.stderr.write(`${10 * tenth}% of ${total} tasks\n`); }
    };
    console.log(formatCalibration(await calibrate({...options, progress})));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
