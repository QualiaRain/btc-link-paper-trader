// The study runner: research/PROTOCOL.md, as amended, executed end to end as one command.
//
//   node research/study.mjs [--data .research-data] [--out research/results] [--report research/RESULTS.md]
//     [--workers 4] [--allow-incomplete-store] [--allow-uncommitted] [--overwrite]
//
// Simulated cash only. This is exploration, not evidence: it can nominate a setting for a pre-registered held-out
// test and nothing more. No order, key, wallet or real-money path exists here, and none may be added.
//
// Each step is an exported function so research/study.test.mjs can drive a scaled-down protocol:
//   0 the refusals in runStudy     an incomplete or non-exchange store, uncommitted code, an earlier record
//   1 loadMarket, prepareWindows   the data, the protocol's windows, coverage and validity
//   2 runDesignGrid                every setting on every valid DESIGN window (worker threads)
//   3 scoreDesign                  eligibility, the score T and the search-adjusted p-value, per family and pooled
//   4 nominate                     the protocol's "Nomination" section
//   5 confirmNominees, comparisonAccountRow   the one look at the confirmation windows: each nominee's label with
//                                  its buy-and-hold reading, and the comparison account's own row
//   6 exactCheck                   every nominee rerun through an engine
//   7 defaultSettingReport, costHurdle, codeState   what is reported whatever the outcome
//   8 runStudy                     all of it, written to <out>/exploration.json and to the report (RESULTS.md)
//
// Order matters: no confirmation-window price enters a calculation before the nominees are fixed. Step 1 checks
// the series and prepares every window (it copies closes and counts minutes, and computes nothing from a price);
// steps 2 to 4 are handed the design windows and a market cut off at the last design minute.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, normalize} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {MINUTE, ASSETS, PROTOCOL, protocolWindows, prepareWindow, assertSeries, lowerBound} from './windows.mjs';
import {simulate} from './fastsim.mjs';
import {mean, sampleSd, tStat, lag1Autocorrelation, autocorrelationAt, autocorrelationFactor, score, skewness,
  searchAdjustedP, confirmationP, buyAndHoldReading, ols, signTestPValue} from './stats.mjs';
import {DEFAULT_DIR, RESERVED_FROM, SOURCE, explorationMonths, loadSeries, publicManifest, manifestPath, sha256Hex,
  storeCompleteness, receiptsSummary} from './dataset.mjs';
import {FAMILIES, HORIZON_MINUTES, TOTAL_SETTINGS, allSettings, familySettings, neighbours, DEFAULT_SETTING,
  COSTS} from './settings.mjs';
import {ENGINE_FILE} from './engine-run.mjs';
import {runTask} from './study-worker.mjs';
import {renderResults, pValue, labelWithReading} from './report.mjs';

// v3: the record of Amendment 2 (the buy-and-hold reading beside every label, the comparison account's own row,
// the descriptive figures of Reading 9, the calibration block, what an overwritten record said of itself).
export const FORMAT = 'paper-trail-exploration-v3';
export const NOMINATION_TOP = 10;       // "the ten highest-scoring distinct settings"
export const TOP_REPORTED = 20;         // highest-scoring eligible settings listed per family
export const EXACT_TOLERANCE = 1e-9;    // relative, on finalValue; fills must be equal
const TIE_TOLERANCE = 1e-12;            // research/stats.mjs: scores closer than this (relative; absolute below 1) tie
export const DEFAULTS = Object.freeze({data: DEFAULT_DIR, out: 'research/results', report: 'research/RESULTS.md',
  workers: 4, resamples: 10000});

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
// Every module that runs in a study, relative to the repository root (PROTOCOL.md, Simulation: "the SHA-256 of
// every module that ran"). replay.js does not execute here: it is the text research/engine-run.mjs builds its
// frames after, hashed so that the record names which text that was.
export const MODULES = Object.freeze(['research/study.mjs', 'research/study-worker.mjs', 'research/report.mjs',
  'research/fastsim.mjs', 'research/windows.mjs', 'research/settings.mjs', 'research/stats.mjs',
  'research/dataset.mjs', 'research/engine-run.mjs', 'research/holdthrough-oracle.mjs', 'engine.js', 'replay.js',
  'report-card.js']);
const PROTOCOL_FILE = 'research/PROTOCOL.md';
// "The figures are measured by node research/calibration.mjs on simulated returns and recorded in
// research/calibration.json. The two tables below are written from that file" (PROTOCOL.md, "What the tests can and
// cannot do"). Read, never imported: the study runs none of the calibration.
const CALIBRATION_FILE = 'research/calibration.json';
// "The reference is the unmodified engine at commit 6f6b693": the SHA-256 of `git show 6f6b693:engine.js`.
export const REFERENCE_ENGINE = Object.freeze({commit: '6f6b693',
  sha256: 'aaed70f6e241435c50108927fa625be6f7dc439cfb0bf4006bdabdabf050ea05'});
if (ENGINE_FILE !== join(REPOSITORY, 'engine.js'))
  throw new Error('research/engine-run.mjs runs another engine.js than the one this file hashes');

// Which engine a nominee is rerun through (PROTOCOL.md, Simulation: "families P, R, X and L through the unmodified
// engine (R, X and L by feeding it the history their rule reads), hold-through nominees through
// research/holdthrough-oracle.mjs ... The record states which reference each nominee was checked against").
export const REFERENCES = Object.freeze({
  engine: 'unmodified engine',
  history: 'unmodified engine fed the history the rule reads',
  oracle: 'engine with its scheduled-decision branch replaced (hold-through oracle)',
});
// Reversed, BTC-led and long-lookback rules read another history than the app's rule: research/engine-run.mjs
// hands the engine that history. With hold-through on, a long-lookback setting does so on the oracle engine.
export const feedsHistory = setting => Boolean(setting.reversal || setting.btcLed || setting.spanMs !== undefined);
export const referenceFor = setting =>
  (setting.holdThrough ? REFERENCES.oracle : feedsHistory(setting) ? REFERENCES.history : REFERENCES.engine);

const iso = time => (Number.isFinite(time) ? new Date(time).toISOString() : null);
function median(values) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort(), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
// One series ALIGNED to its windows, NaN where a window is invalid for the setting: n, mean, sd, the plain t, and
// the protocol's score T = t x sqrt((1 - a) / (1 + a)) with its lag-1 autocorrelation a (before the floor at 0)
// and its skewness. research/stats.mjs reads adjacency from the positions, so the series is never compacted.
const describeSeries = xs => ({n: xs.reduce((count, x) => count + (x === x ? 1 : 0), 0), mean: mean(xs), sd: sampleSd(xs),
  t: tStat(xs), lag1: lag1Autocorrelation(xs), factor: autocorrelationFactor(xs), T: score(xs), skewness: skewness(xs)});
const sharePositive = xs => {
  let n = 0, positive = 0;
  for (const x of xs) { if (x === x) n++; if (x > 0) positive++; }
  return n ? positive / n : NaN;
};

// The protocol's nine Readings, word for word (research/study.test.mjs compares them with PROTOCOL.md). Written
// into every record and report.
export const READINGS = Object.freeze([
  '*Warmup.* A window is run as if the app replayed `[first shared minute, last shared minute]`: each asset keeps ' +
    'rows from `max(60, 2 × lookback + 10)` minutes before the first shared minute, and the run is refused unless ' +
    'each asset has `lookback + 1` rows at or before it. Family L has no such refusal; a decision without a usable ' +
    '`past` is skipped.',
  '*Session end.* The session ends at the window\'s last shared minute. When the window\'s nominal last minute is ' +
    'missing for an asset, that end is earlier, and decisions whose horizon would pass it are skipped as the engine ' +
    'skips them. No price is involved; only decisions within one horizon of the end are affected.',
  '*Hold-through.* `E` is read after that frame\'s stop-loss sales and before the decision\'s own sells. "Held" ' +
    'means quantity above zero at that point. A kept position is never resized and keeps its original fee-inclusive ' +
    'cost basis for the stop loss. A same-frame stop-out is a skipped decision, as in the engine. "Available cash" ' +
    'is the cash on hand at that asset\'s buy.',
  '*BTC-led.* "BTC\'s forecast is unavailable" means BTC\'s drift cannot be computed from BTC\'s history. A BTC ' +
    'stop-out on that frame does not skip LINK. The app\'s warmup refusal still applies to each asset\'s own series.',
  '*Long lookback.* "At most 60 minutes older" includes exactly 60 minutes.',
  '*Neighbours* (used in Nomination) are the up to four settings one grid step away on exactly one of the two axes ' +
    '(lookback or span, and buffer), same horizon, stop and switches. They count whether or not they are eligible.',
  '*Invalid windows.* A window that is invalid for a setting (low coverage, which is invalid for every setting, or ' +
    'refused for that setting) enters none of that setting\'s counts, means, standard deviations or scores, and it ' +
    'keeps its place in the window order: the windows either side of it are not an adjacent pair for the ' +
    'autocorrelation. For the search-adjusted p-value every one of the 50 design windows can be drawn in a ' +
    'resample, valid or not, and a drawn window adds nothing to a setting it is invalid for. For the confirmation ' +
    'p-value the resamples draw from the nominee\'s valid confirmation windows only.',
  '*Comparison account.* `b` is defined on every window above the coverage floor. The buy-and-hold reading uses ' +
    'the windows valid for the nominee; the comparison account\'s own row uses every confirmation window above the ' +
    'floor and the same `k`.',
  '*Descriptive figures.* The autocorrelation at lag `j` pairs valid windows exactly `j` places apart and divides ' +
    'by the same sum of squared deviations as lag 1; it is reported as computed, not floored. The halves of the ' +
    'confirmation set are windows 50 to 61 and 62 to 73. "The third in which `b` was lowest" is the `floor(n / 3)` ' +
    'of the nominee\'s `n` valid confirmation windows with the smallest `b`, ties to the earlier window.',
]);
// Readings this file had to make that the protocol does not state. Each is flagged as such in the record. What
// an invalid window does (Reading 7) was among them until Amendment 2 put it into the protocol.
export const FURTHER_READINGS = Object.freeze([
  'Eligible: "a fill in at least half of them" is counted as 2 x (valid design windows with at least one buy or ' +
    'sell of the paper account) >= (valid design windows).',
  'Identical design returns: two eligible settings of a family count once when their returns are equal in every ' +
    'design window and invalid in the same windows, compared as the numbers the simulator returned. They are ' +
    'represented by the first of them in the family\'s grid order.',
  '"How many distinct return vectors the ten considered settings held" is reported as three numbers per family: ' +
    'the distinct settings considered (ten, or fewer when the family has fewer distinct eligible settings), the ' +
    'eligible settings those stand for once identical ones are counted in, and the distinct return vectors among ' +
    'the ten highest-scoring eligible settings before identical ones are counted once.',
  'Neighbours: each neighbour\'s T is the score of the Measures section over its own valid design windows (0 when ' +
    'sd is 0 or it has fewer than two). The median of two or four values is the mean of the middle two. A setting ' +
    'with no neighbour in the searched grid, possible only when a subset is searched, cannot qualify.',
  'Statistics follow the conventions of research/stats.mjs: "sd is 0" means no spread beyond rounding, a ' +
    'resampled statistic within 1e-12 of the observed score counts as at least it, both tests use the seed ' +
    '20261118, and a search-adjusted p-value of 0 means below 1 / resamples. "How many had a positive design mean" ' +
    'counts every searched setting of the family; the count among eligible settings is reported beside it.',
  'The best T of a family, and of all families, is the one research/stats.mjs names for the search-adjusted ' +
    'p-value: two scores within 1e-12 of each other (relative to the score, absolute below 1) are a tie, and a tie ' +
    'goes to the earlier setting in grid order. Nomination ranks by T as computed: only exactly equal scores are ' +
    'ties there.',
  'Confirmation: k is the number of nominees over all families. The feeBps 10 and feeBps 40 reruns use the same ' +
    'windows; their p-values are reported, not used.',
  'Buy-and-hold reading: b is the comparison account at the same cost level as r ("same costs"), so the feeBps 10 ' +
    'and feeBps 40 reruns each have a reading of their own. They are reported, not used: the reading beside a ' +
    'label is the one at default costs.',
  'The comparison account\'s own row: b does not depend on the setting, so it is read from the run of one ' +
    'long-lookback setting, which exists on every window above the coverage floor. "Did simply holding pass?" is ' +
    'answered by the conditions of "confirmed at default costs": at least the minimum of valid confirmation ' +
    'windows, mean(b) > 0 and a confirmation p-value below 0.05 / k. With no nominee there is no k: the numbers ' +
    'are reported without a bar.',
  'Descriptive figures: the two halves are the first and the second half of the confirmation windows by position ' +
    '(windows 50 to 61 and 62 to 73 in the protocol\'s own run; a list of odd length, possible only in a ' +
    'scaled-down run, gives its middle window to the first half). The lowest third is taken on b at default costs.',
  'Direction sign test: the app\'s two-sided exact sign test (report-card.js) on direction hits against misses, ' +
    'flat forecasts excluded, pooled over the nominee\'s valid confirmation windows, per asset, at default costs.',
  'Cost hurdle: at every scored minute of a valid window (design and confirmation) whose minute one horizon later ' +
    'exists for that asset anywhere in its series, the absolute log move over the horizon; the median over those ' +
    'minutes against the round trip 2 x (feeBps + slippageBps + halfSpreadBps).',
  'Engine check: every nominee is rerun on all its design and confirmation windows above the coverage floor. The ' +
    'final value must agree within 1e-9 relative and the number of fills exactly, and a window refused for the ' +
    'setting must be refused by both. A long-lookback nominee with hold-through runs on the hold-through oracle, ' +
    'fed the history its rule reads.',
  'The default setting and the cost hurdle read confirmation windows. They are computed after the nominees are ' +
    'fixed and feed no selection.',
]);
// PROTOCOL.md, "What a result would and would not establish", as amended: "If the buy-and-hold reading beside it
// is no ... it justifies nothing further. If the reading is yes, it would justify writing a held-out contract for
// that setting and nothing more".
const STATUS = 'Exploration, not evidence. Simulated cash only; no orders exist. A confirmed nominee whose ' +
  'buy-and-hold reading is "no" justifies nothing further; one whose reading is "yes" would justify writing a ' +
  'held-out contract for that one setting and nothing more.';
// What the record gives as the source of the data in a dry run.
const DRY_RUN_SOURCE = 'in-memory market supplied by the caller; NOT the candle store';

// ---------------------------------------------------------------------------------------------------------------
// Step 1: the market, the windows, coverage and validity.

// Both assets from the candle store research/fetch-candles.mjs wrote; every stored month is verified on load and
// no row outside the exploration bounds can be returned (research/dataset.mjs). Also what identifies the data:
// the SHA-256 of manifest.json, the committable per-month manifest (row counts, close range, SHA-256 of the
// series and of the receipts) and what the receipts files on disk are (PROTOCOL.md, Data boundary).
export function loadMarket(dir = DEFAULT_DIR) {
  const market = Object.fromEntries(ASSETS.map(asset => [asset, loadSeries(dir, asset)]));
  return {market, manifest: publicManifest(dir), manifestSha256: sha256Hex(readFileSync(manifestPath(dir))),
    receipts: receiptsSummary(dir)};
}

// The protocol's windows, each prepared once (setting-independent), and one coverage row per window: minutes
// expected, observed and missing per asset and shared, the scored span, and the window-level validity rule
// (invalid for every setting when fewer than 90% of its minutes are observed for both assets).
export function prepareWindows(market, protocol = PROTOCOL) {
  const windows = protocolWindows(protocol);
  const prepared = windows.map(window => prepareWindow(market, window, protocol));
  const coverage = windows.map((window, i) => {
    const p = prepared[i];
    return {index: window.index, set: window.set, start: iso(window.start), end: iso(window.end),
      expected: p.expected, observed: {...p.observed},
      missing: Object.fromEntries(ASSETS.map(asset => [asset, p.expected - p.observed[asset]])),
      shared: p.shared, missingShared: p.expected - p.shared, sharedFraction: p.sharedFraction,
      scoreStart: iso(p.scoreStart), scoreEnd: iso(p.scoreEnd), valid: p.valid, invalidReason: p.invalidReason};
  });
  return {windows, prepared, coverage};
}

// ---------------------------------------------------------------------------------------------------------------
// Worker threads. Results come back in task order whatever the scheduling, and with workers = 0 the same task
// function runs in this thread, so the worker count cannot change a result.

// Each asset's rows with time <= lastClose, copied into SharedArrayBuffer-backed arrays (one copy, every worker).
function shareUntil(market, lastClose) {
  return Object.fromEntries(ASSETS.map(asset => {
    const {time, close} = market[asset], rows = lowerBound(time, lastClose + 1);
    const copy = source => {
      const out = new Float64Array(new SharedArrayBuffer(rows * Float64Array.BYTES_PER_ELEMENT));
      out.set(source.subarray(0, rows));
      return out;
    };
    return [asset, {time: copy(time), close: copy(close)}];
  }));
}

async function runTasks(workers, context, tasks, onDone = () => {}) {
  if (!workers) {
    const results = [];
    for (const task of tasks) {
      results.push(await runTask(context, task));
      onDone(results.length, tasks.length);
    }
    return results;
  }
  if (!tasks.length) return [];
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length), pool = [];
    let next = 0, done = 0, settled = false;
    // A worker is terminated only once it has loaded its modules (its first message says so) or is gone. Node 22
    // aborts the whole process when a thread is terminated while a module with a top-level await is still being
    // evaluated in it, and research/engine-run.mjs is such a module; an early error in one worker would otherwise
    // take the process down while the others are still starting.
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      Promise.all(pool.map(({worker, loaded}) => loaded.then(() => worker.terminate()))).then(() => settle(value));
    };
    const feed = worker => {
      if (next >= tasks.length) return;
      const id = next++;
      worker.postMessage({id, task: tasks[id]});
    };
    for (let i = 0; i < Math.min(workers, tasks.length); i++) {
      const worker = new Worker(new URL('./study-worker.mjs', import.meta.url),
        {workerData: {...context, role: 'study-worker'}});
      pool.push({worker, loaded: new Promise(loaded => { for (const event of ['message', 'error', 'exit']) worker.once(event, loaded); })});
      worker.on('message', ({ready, id, result, error}) => {
        if (ready) return;
        if (error) return finish(reject, new Error(`Worker task ${id} failed: ${error}`));
        results[id] = result;
        onDone(++done, tasks.length);
        if (done === tasks.length) finish(resolve, results); else feed(worker);
      });
      worker.on('error', error => finish(reject, error));
      worker.on('exit', code => finish(reject, new Error(`A study worker stopped early (exit code ${code})`)));
      feed(worker);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: the design grid.

// Every setting on every DESIGN window at default costs. `designWindows` is the only window input, and three
// things keep a confirmation window out: each window must carry set === 'design'; each must BE that design window
// of `protocol` (same index, start and end, so a relabelled confirmation window is refused); and the market
// handed to the simulations is a copy cut off at the last design minute, so later prices are not there to read.
// Returns, per setting (in the order of `settings`), the return in percent and the fills per design window, in
// the order of `designWindows`: NaN marks a window invalid for that setting (window below the coverage floor, or
// a run the app would refuse for lack of causal warmup).
export async function runDesignGrid({market, designWindows, settings, protocol = PROTOCOL,
  workers = DEFAULTS.workers, onDone}) {
  const own = protocolWindows(protocol);
  for (const window of designWindows) {
    const listed = own[window?.index];
    if (window?.set !== 'design' || listed?.set !== 'design' || listed.start !== window.start || listed.end !== window.end)
      throw new Error(`The design grid takes design windows only: window ${window?.index} (${window?.set}) is refused`);
  }
  const lastDesignClose = designWindows.reduce((latest, window) => Math.max(latest, window.end), -Infinity);
  const context = {market: shareUntil(market, lastDesignClose), settings, costs: COSTS.default, protocol: {...protocol}};
  const tasks = designWindows.map(window => ({kind: 'grid', window: {...window}}));
  const results = await runTasks(workers, context, tasks, onDone);

  const width = designWindows.length, allReturns = new Float64Array(settings.length * width).fill(NaN);
  const allFills = new Int32Array(settings.length * width);
  results.forEach((result, column) => {
    if (result.index !== designWindows[column].index) throw new Error('Design grid results are out of order');
    for (let s = 0; s < settings.length; s++) {
      allReturns[s * width + column] = result.returns[s];
      allFills[s * width + column] = result.fills[s];
    }
  });
  return {
    returns: settings.map((_, s) => allReturns.subarray(s * width, (s + 1) * width)),
    fills: settings.map((_, s) => allFills.subarray(s * width, (s + 1) * width)),
    columns: results.map(r => ({index: r.index, valid: r.valid, invalidReason: r.invalidReason, refused: r.refused})),
    // The spy: which windows the simulations were given, and the last close of the market they could see.
    audit: {windows: results.map(r => r.index), lastDesignClose,
      lastVisibleClose: results.reduce((latest, r) => Math.max(latest, r.lastVisibleClose), -Infinity)},
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Step 3: eligibility, the score T and the search-adjusted p-value (PROTOCOL.md, "Measures").

// One row per setting. `returns[s]` and `fills[s]` are aligned to the design windows (NaN = invalid for that
// setting). "Eligible: the setting has at least 40 valid design windows and places at least one fill in at least
// half of them" (the 40 is protocol.minValidDesignWindows). "Score: T(c) = mean(r) / (sd(r) / sqrt(n)) x
// sqrt((1 - a) / (1 + a)) over its valid design windows": research/stats.mjs score(); t is the first factor alone.
export function scoreRows(settings, returns, fills, protocol = PROTOCOL) {
  return settings.map((setting, s) => {
    const r = returns[s], stats = describeSeries(r);
    let traded = 0, fillSum = 0;
    for (let w = 0; w < r.length; w++) {
      if (Number.isNaN(r[w])) continue;
      fillSum += fills[s][w];
      if (fills[s][w] > 0) traded++;
    }
    return {id: setting.id, family: setting.family, ...stats, traded,
      eligible: stats.n >= protocol.minValidDesignWindows && 2 * traded >= stats.n,
      sharePositive: sharePositive(r), meanFills: stats.n ? fillSum / stats.n : NaN};
  });
}

// Per family and for all families pooled: how many settings, how many eligible, how many with a positive design
// mean, the best T (with its skewness, lag-1 autocorrelation and valid windows) and its search-adjusted p-value.
// "Search-adjusted p-value: resample the design windows with replacement 10,000 times (seed fixed in code, the
// same resampled windows for every setting) ... Reported per family and for all families pooled": research/stats.mjs
// searchAdjustedP, handed every design window as a column and the eligible settings of the block. The draws depend
// only on the seed and the number of columns, so a family and the pooled block see the same resampled windows.
export function scoreDesign({settings, returns, fills, protocol = PROTOCOL, resamples = DEFAULTS.resamples}) {
  const rows = scoreRows(settings, returns, fills, protocol);
  const block = family => {
    const members = rows.flatMap((row, s) => (family === null || row.family === family ? [s] : []));
    const eligible = members.filter(s => rows[s].eligible);
    const check = searchAdjustedP({returns, eligible, resamples});
    // Ties go to the earlier setting in grid order, here and in searchAdjustedP, and research/stats.mjs counts two
    // scores within its tie tolerance as a tie: a later setting holds the best T only when it is above the best so
    // far by more than that (a series and its reverse have scores that differ in their last bits).
    const best = eligible.reduce((top, s) =>
      (top === -1 || rows[s].T > rows[top].T + TIE_TOLERANCE * Math.max(1, Math.abs(rows[top].T)) ? s : top), -1);
    // The same statistic computed twice, here and inside searchAdjustedP: a disagreement means misaligned tables.
    if (best !== check.argmax || (best !== -1 && rows[best].T !== check.observedMax))
      throw new Error('The search-adjusted p-value and the score table disagree on the best eligible setting');
    const {id, T, t, lag1, factor, skewness: skew, n, mean: m, sd} = rows[best] ?? {};
    return {settings: members.length, withValidWindows: members.filter(s => rows[s].n > 0).length,
      eligible: eligible.length, positiveMean: members.filter(s => rows[s].mean > 0).length,
      eligiblePositiveMean: eligible.filter(s => rows[s].mean > 0).length,
      best: best === -1 ? null : {id, T, t, lag1, factor, skewness: skew, n, mean: m, sd},
      // With nothing eligible there is nothing to search and no p-value.
      searchAdjusted: {p: best === -1 ? null : check.p, resamples: check.resamples, seed: check.seed,
        windowsResampled: returns[0]?.length ?? 0}};
  };
  const present = FAMILIES.filter(family => rows.some(row => row.family === family));
  return {rows, families: Object.fromEntries(present.map(family => [family, block(family)])), pooled: block(null)};
}

// ---------------------------------------------------------------------------------------------------------------
// Step 4: nomination (PROTOCOL.md, "Nomination (design set only)").

// "Identical window for window": equal in every design window and invalid in the same ones.
const sameReturns = (a, b) => a.length === b.length && a.every((x, w) => x === b[w] || (x !== x && b[w] !== b[w]));

// One family. `settings` are the family's searched settings in grid order; `scores` maps a setting id to
// {eligible, T, mean, returns} with `returns` its design returns. "Take eligible settings in descending T, ties in
// the order the family's grid is enumerated. Settings whose design returns are identical window for window count
// once, represented by the first of them. The first of the ten highest-scoring distinct settings that has
// mean(r) > 0 and whose neighbours have a median T above 0 is that family's nominee. If none of the ten
// qualifies, the family nominates nothing."
// Returns {nominee, considered, tenConsidered}: `considered` is the walk, ending at the nominee; `tenConsidered`
// says what the ten were: their ids, how many distinct return vectors they held (their number), how many eligible
// settings they stand for with identical ones counted in, and how many distinct return vectors the ten
// highest-scoring eligible settings held before identical ones were counted once.
export function nominateFamily(settings, scores, top = NOMINATION_TOP) {
  const ranked = settings.filter(setting => scores.get(setting.id).eligible)
    .map((setting, order) => ({setting, order, ...scores.get(setting.id)}))
    .sort((a, b) => b.T - a.T || a.order - b.order);
  const ten = [];
  let distinctAmongPlainTopTen = 0;
  for (const [position, entry] of ranked.entries()) {
    // Identical returns give an identical T, so past the tenth distinct setting only its ties can still be twins.
    if (ten.length === top && entry.T < ten[top - 1].T) break;
    const first = ten.find(kept => sameReturns(kept.returns, entry.returns));
    if (first) first.identical.push(entry.setting.id);
    else if (ten.length < top) ten.push({...entry, identical: []});
    if (!first && position < top) distinctAmongPlainTopTen++;
  }
  const considered = [];
  let nominee = null;
  for (const {setting, T, mean: designMean, identical} of ten) {
    const near = neighbours(setting, settings).map(other => ({id: other.id, T: scores.get(other.id).T}));
    const neighbourMedianT = median(near.map(other => other.T));
    const qualifies = designMean > 0 && neighbourMedianT > 0;
    const reason = qualifies ? 'nominee' : !(designMean > 0) ? 'mean(r) is not above 0'
      : near.length ? 'neighbours\' median T is not above 0' : 'no neighbour in the searched grid';
    considered.push({rank: considered.length + 1, id: setting.id, T, mean: designMean, identical, neighbours: near,
      neighbourMedianT, qualifies, reason});
    if (qualifies) { nominee = setting; break; }
  }
  return {nominee, considered, tenConsidered: {ids: ten.map(kept => kept.setting.id), distinctReturnVectors: ten.length,
    eligibleSettingsStoodFor: ten.reduce((sum, kept) => sum + 1 + kept.identical.length, 0), distinctAmongPlainTopTen}};
}

// Every family: at most one nominee each, so "at most five nominees". `rows` are scoreRows() of `settings` and
// `returns` the design returns they were computed from, index-aligned.
export function nominate({settings, rows, returns}) {
  const scores = new Map(rows.map((row, s) => [row.id, {eligible: row.eligible, T: row.T, mean: row.mean, returns: returns[s]}]));
  const families = {};
  for (const family of FAMILIES) {
    const members = settings.filter(setting => setting.family === family);
    if (members.length) families[family] = nominateFamily(members, scores);
  }
  const nominees = Object.values(families).flatMap(f => (f.nominee ? [f.nominee] : []));
  if (nominees.length > 5) throw new Error('More than five nominees');
  return {families, nominees};
}

// ---------------------------------------------------------------------------------------------------------------
// Step 5: confirmation (PROTOCOL.md, "Confirmation (one look at windows 50 to 73)").

const checkNominees = (k, least) => {
  if (!Number.isInteger(k) || k < least || k > 5) throw new Error(`k is the number of nominees, ${least} to 5`);
};

// The protocol's three labels. r: a nominee's confirmation returns at default costs; rFee10: the same windows
// rerun at feeBps 10; both aligned to the confirmation windows (NaN = invalid for the nominee); k: the number of
// nominees. "Confirmed at default costs: at least 20 valid confirmation windows, mean(r) > 0, and confirmation
// p-value < 0.05 / k. Confirmed and cost-robust: additionally mean(r) > 0 when rerun with feeBps 10. Otherwise
// not confirmed." The p-value is research/stats.mjs confirmationP: the larger of Student's t and the studentized
// resample, both on the score T. `test` holds its parts; `conditions` says which condition held.
export function confirmationLabel({r, rFee10, k, minValidWindows = PROTOCOL.minValidConfirmationWindows,
  resamples = DEFAULTS.resamples}) {
  checkNominees(k, 1);
  const threshold = 0.05 / k, test = confirmationP(r, {resamples}), meanFee10 = mean(rFee10);
  const conditions = {enoughWindows: test.n >= minValidWindows, positiveMean: test.mean > 0,
    pBelowThreshold: test.p < threshold, positiveMeanFee10: meanFee10 > 0};
  const confirmed = conditions.enoughWindows && conditions.positiveMean && conditions.pBelowThreshold;
  const label = !confirmed ? 'not confirmed' : conditions.positiveMeanFee10 ? 'confirmed and cost-robust' : 'confirmed at default costs';
  return {label, conditions, threshold, minValidWindows, meanFee10, test};
}

// "More than a share of buy-and-hold: yes or no" (PROTOCOL.md, Confirmation, as amended). r: a nominee's
// confirmation returns; b: the comparison account's at the same costs; both aligned to the confirmation windows
// (NaN = invalid for the nominee); k: the number of nominees. "Fit r = intercept + slope × b by least squares over
// the nominee's valid confirmation windows. The reading's p-value is the larger of the fit's one-sided p-value for
// intercept > 0 (Student's t, n − 2 degrees of freedom) and the confirmation p-value defined above computed on the
// series r − slope × b. Yes needs at least 20 valid windows, intercept > 0 and that p-value < 0.05 / k; anything
// else is no." The calculation is research/stats.mjs buyAndHoldReading; the rule is applied here.
// Returns {reading: 'yes' | 'no', conditions, threshold, minValidWindows, n, intercept, slope, seIntercept,
// seSlope, pFit, adjusted, p}: `adjusted` holds the parts of the confirmation calculation on r − slope × b (its
// score under the name T, as everywhere in the record) and p is the larger of pFit and adjusted.p.
export function moreThanAShareOfBuyAndHold({r, b, k, minValidWindows = PROTOCOL.minValidConfirmationWindows,
  resamples = DEFAULTS.resamples}) {
  checkNominees(k, 1);
  const threshold = 0.05 / k, {adjusted: {score: T, ...adjusted}, ...fit} = buyAndHoldReading(r, b, {resamples});
  const conditions = {enoughWindows: fit.n >= minValidWindows, positiveIntercept: fit.intercept > 0,
    pBelowThreshold: fit.p < threshold};
  const yes = conditions.enoughWindows && conditions.positiveIntercept && conditions.pBelowThreshold;
  return {reading: yes ? 'yes' : 'no', conditions, threshold, minValidWindows, ...fit, adjusted: {...adjusted, T}};
}

// The descriptive figures of Reading 9 for one nominee at default costs. r and b are its returns and the comparison
// account's, aligned to `windows`, the confirmation windows (NaN = invalid for the nominee).
// Returns {autocorrelation: [lag 1, 2, 3, 4], halves: [{windows: [first, last], n, mean} x 2], lowestThird:
// {n, windows, mean, meanComparison}}; lowestThird.windows are in ascending b, and meanComparison is the mean of b
// over them.
export function descriptiveFigures(windows, r, b) {
  const count = xs => xs.reduce((n, x) => n + (x === x ? 1 : 0), 0);
  // "The halves of the confirmation set are windows 50 to 61 and 62 to 73": the first and the second half of the
  // confirmation windows by position, each with its number of valid windows. A list of odd length (a scaled-down
  // run) gives its middle window to the first half.
  const middle = Math.ceil(windows.length / 2);
  const half = (from, to) => ({windows: to > from ? [windows[from].index, windows[to - 1].index] : null,
    n: count(r.slice(from, to)), mean: mean(r.slice(from, to))});
  // '"The third in which b was lowest" is the floor(n / 3) of the nominee's n valid confirmation windows with the
  // smallest b, ties to the earlier window.'
  const valid = [...r.keys()].filter(w => r[w] === r[w]);
  const lowest = valid.toSorted((one, other) => b[one] - b[other] || one - other).slice(0, Math.floor(valid.length / 3));
  return {
    // "The autocorrelation at lag j pairs valid windows exactly j places apart and divides by the same sum of
    // squared deviations as lag 1; it is reported as computed, not floored" (research/stats.mjs autocorrelationAt).
    autocorrelation: [1, 2, 3, 4].map(lag => autocorrelationAt(r, lag)),
    halves: [half(0, middle), half(middle, windows.length)],
    lowestThird: {n: lowest.length, windows: lowest.map(w => windows[w].index), mean: mean(lowest.map(w => r[w])),
      meanComparison: mean(lowest.map(w => b[w]))}};
}

// One cost level of one account on the confirmation windows: the score T with its parts and both p-values
// (`test` is research/stats.mjs confirmationP of `values`), the share of windows above 0 and the worst window.
// `perWindow` holds the windows that ran, `key` names the return in them and `name` the field it has in `worst`.
function costLevel(perWindow, key, values, {score: T, ...test}, name = 'r') {
  const worst = perWindow.reduce((low, w) => (low === null || w[key] < low[key] ? w : low), null);
  return {...test, T, sharePositive: sharePositive(values), worst: worst && {index: worst.index, [name]: worst[key]}};
}

// Nominees only, each run once on the valid confirmation windows at each cost level: default costs with detail,
// then feeBps 10 and feeBps 40. `windows` and `prepared` are the confirmation windows and their prepared forms,
// index-aligned. A window invalid for a nominee keeps its place in every series (Reading 7). Each nominee gets
// its label and, beside it, the buy-and-hold reading at default costs (moreThanAShareOfBuyAndHold), with the fit
// behind it and the reading of each rerun under buyAndHold. Reported alongside, not pass/fail: the share of
// windows with r > 0, the worst window, skewness, the autocorrelation at lags 1 to 4, the two halves and the
// lowest third (descriptiveFigures), average fills and fees, the direction sign test, and the rerun at feeBps 40.
export function confirmNominees({market, windows, prepared, nominees, protocol = PROTOCOL, resamples = DEFAULTS.resamples}) {
  if (nominees.length > 5) throw new Error('At most five nominees');
  for (const window of windows)
    if (window.set !== 'confirmation') throw new Error(`Window ${window.index} is not a confirmation window`);
  const k = nominees.length, minValidWindows = protocol.minValidConfirmationWindows;
  return nominees.map(setting => {
    const perWindow = [], invalidForSetting = [];
    windows.forEach((window, i) => {
      if (!prepared[i].valid) return;                    // Reading 7; listed under invalidWindows
      const run = costs => simulate(market, prepared[i], setting, costs, {detail: true});
      const at = run(COSTS.default);
      if (!at.valid) { invalidForSetting.push({index: window.index, reason: at.invalidReason}); return; }
      const fee10 = run(COSTS.fee10), fee40 = run(COSTS.fee40);
      perWindow.push({index: window.index, r: at.returnPct, b: at.buyHoldReturnPct, fills: at.fills, fees: at.fees,
        stops: at.stops, maxDrawdownPct: at.maxDrawdownPct, exposure: at.exposure, rFee10: fee10.returnPct,
        rFee40: fee40.returnPct, bFee10: fee10.buyHoldReturnPct, bFee40: fee40.buyHoldReturnPct,
        direction: Object.fromEntries(ASSETS.map(asset => [asset,
          [at.perAsset[asset].directionHits, at.perAsset[asset].directionMisses, at.perAsset[asset].directionFlat]]))});
    });
    // Aligned to the confirmation windows: NaN where the window is invalid for every setting or for this one.
    const ran = new Map(perWindow.map(w => [w.index, w])), aligned = key => windows.map(w => ran.get(w.index)?.[key] ?? NaN);
    const r = aligned('r'), b = aligned('b'), rFee10 = aligned('rFee10'), rFee40 = aligned('rFee40');
    const {label, conditions, threshold, meanFee10, test} = confirmationLabel({r, rFee10, k, minValidWindows, resamples});
    // "Each nominee is run once on the confirmation windows, at each cost level": one reading per level, b at
    // that level's costs. The one beside the label is the one at default costs.
    const reading = (returns, comparison) => moreThanAShareOfBuyAndHold({r: returns, b: comparison, k, minValidWindows, resamples});
    const buyAndHold = {...reading(r, b), fee10: reading(rFee10, aligned('bFee10')), fee40: reading(rFee40, aligned('bFee40'))};
    // b is defined wherever the nominee ran (Reading 8), so the fit is over the nominee's valid windows.
    if (buyAndHold.n !== test.n) throw new Error(`${setting.id}: the buy-and-hold fit is not over the nominee's valid confirmation windows`);
    return {id: setting.id, family: setting.family, k, label, moreThanAShareOfBuyAndHold: buyAndHold.reading,
      conditions, threshold, minValidWindows, meanFee10,
      ...costLevel(perWindow, 'r', r, test), fee10: costLevel(perWindow, 'rFee10', rFee10, confirmationP(rFee10, {resamples})),
      fee40: costLevel(perWindow, 'rFee40', rFee40, confirmationP(rFee40, {resamples})),
      meanFills: mean(perWindow.map(w => w.fills)), meanFees: mean(perWindow.map(w => w.fees)), meanComparison: mean(b),
      // r regressed on b across windows, with what the reading does not use (tIntercept, r2).
      regression: ols(r, b),
      buyAndHold,
      ...descriptiveFigures(windows, r, b),
      direction: Object.fromEntries(ASSETS.map(asset => {
        const [hits, misses, flat] = [0, 1, 2].map(at => perWindow.reduce((sum, w) => sum + w.direction[asset][at], 0));
        return [asset, {hits, misses, flat, hitRate: hits + misses ? hits / (hits + misses) : NaN,
          signTestP: signTestPValue(hits, misses)}];
      })),
      invalidForSetting, perWindow};
  });
}

// The run the comparison account's return is read from. b does not depend on the setting (research/fastsim.mjs
// benchmark(): half the initial cash into each asset at the first scored minute, held to the last, same costs),
// and a long-lookback setting has a run on every window above the coverage floor (Reading 1: "Family L has no such
// refusal"), which is where Reading 8 defines b.
const COMPARISON_CARRIER = familySettings('L').find(setting => setting.id === 'L-h1440-span40320-b320-s0-hold0');

// The comparison account's own row (PROTOCOL.md, Confirmation, "Reported alongside": "the comparison account's own
// returns b on the confirmation windows put through the same confirmation calculation (did simply holding
// pass?)"; Reading 8: "b is defined on every window above the coverage floor ... the comparison account's own row
// uses every confirmation window above the floor and the same k"). `windows` and `prepared` are the confirmation
// windows and their prepared forms; k is the number of nominees, 0 to 5.
// Returns {k, threshold, minValidWindows, passed, conditions: {enoughWindows, positiveMean, pBelowThreshold}, the
// confirmation calculation on b at default costs (n, mean, sd, t, lag1, factor, T, skewness, pT, pResample, p,
// sharePositive, worst), fee10, fee40 (the same at those costs), perWindow: [{index, b, bFee10, bFee40}]}.
// `passed` is what "confirmed at default costs" asks of a nominee: at least the minimum of valid windows,
// mean(b) > 0 and p < 0.05 / k. With no nominee there is no k and no bar: threshold, passed and
// conditions.pBelowThreshold are null and the numbers stand alone. Call it only after the nominees are fixed.
export function comparisonAccountRow({market, windows, prepared, k, protocol = PROTOCOL, resamples = DEFAULTS.resamples}) {
  checkNominees(k, 0);
  const perWindow = [];
  windows.forEach((window, i) => {
    if (window.set !== 'confirmation') throw new Error(`Window ${window.index} is not a confirmation window`);
    if (!prepared[i].valid) return;                      // below the coverage floor: b is not defined there
    const held = costs => {
      const run = simulate(market, prepared[i], COMPARISON_CARRIER, costs);
      if (!run.valid) throw new Error(`Window ${window.index}: no run to read the comparison account from (${run.invalidReason})`);
      return run.buyHoldReturnPct;
    };
    perWindow.push({index: window.index, b: held(COSTS.default), bFee10: held(COSTS.fee10), bFee40: held(COSTS.fee40)});
  });
  const ran = new Map(perWindow.map(w => [w.index, w]));
  const level = key => {
    const values = windows.map(w => ran.get(w.index)?.[key] ?? NaN);
    return costLevel(perWindow, key, values, confirmationP(values, {resamples}), 'b');
  };
  const row = level('b'), threshold = k ? 0.05 / k : null, minValidWindows = protocol.minValidConfirmationWindows;
  const conditions = {enoughWindows: row.n >= minValidWindows, positiveMean: row.mean > 0,
    pBelowThreshold: k ? row.p < threshold : null};
  return {k, threshold, minValidWindows,
    passed: k ? conditions.enoughWindows && conditions.positiveMean && conditions.pBelowThreshold : null, conditions,
    ...row, fee10: level('bFee10'), fee40: level('bFee40'), perWindow};
}

// ---------------------------------------------------------------------------------------------------------------
// Step 6: the engine check.

// One window of one nominee. `result` is what research/study-worker.mjs engineTask returned ({windowValid, fast,
// engine}); `recorded` is what the study recorded for that window at default costs, {r, fills} with r NaN when
// the run was refused, or undefined when the window is below the coverage floor. Three things must agree: the
// engine and the fresh fast simulation (finalValue within 1e-9 relative, fills equal, the same refusal), and the
// fresh fast simulation and the recorded value (identical). Returns {problems, compared, refused, difference}.
export function compareExact(result, recorded) {
  const outcome = {problems: [], compared: false, refused: false, difference: 0};
  if (result.windowValid !== (recorded !== undefined))
    outcome.problems.push('window validity differs from the coverage table');
  if (outcome.problems.length || !result.windowValid) return outcome;
  const {fast, engine} = result, ran = r => (r.valid ? 'ran' : `refused (${r.invalidReason})`);
  if (fast.valid !== engine.valid || fast.invalidReason !== engine.invalidReason)
    outcome.problems.push(`the engine ${ran(engine)}, the fast simulator ${ran(fast)}`);
  const asRecorded = fast.valid ? fast.returnPct === recorded.r && fast.fills === recorded.fills : Number.isNaN(recorded.r);
  if (!asRecorded) outcome.problems.push('a fresh fast simulation differs from the value the study recorded');
  if (!fast.valid || !engine.valid) { outcome.refused = !fast.valid && !engine.valid; return outcome; }
  outcome.compared = true;
  outcome.difference = Math.abs(fast.finalValue - engine.finalValue) /
    Math.max(Math.abs(fast.finalValue), Math.abs(engine.finalValue), Number.MIN_VALUE);
  if (!(outcome.difference <= EXACT_TOLERANCE))
    outcome.problems.push(`finalValue ${fast.finalValue} (fast) against ${engine.finalValue} (engine)`);
  if (fast.fills !== engine.fills) outcome.problems.push(`fills ${fast.fills} (fast) against ${engine.fills} (engine)`);
  return outcome;
}

// "Every nominee is additionally rerun window by window through an engine before it is reported: families P, R,
// X and L through the unmodified engine (R, X and L by feeding it the history their rule reads), hold-through
// nominees through research/holdthrough-oracle.mjs" (PROTOCOL.md, Simulation). `windows` are all windows, design
// and confirmation; `expected` maps `${id}|${windowIndex}` to the recorded {r, fills} of every window above the
// coverage floor. Any disagreement throws: the study fails rather than report a nominee its engine does not
// reproduce. Each entry names the reference it used (referenceFor) and whether that engine was fed the history the
// rule reads (feedsHistory).
export async function exactCheck({market, windows, nominees, expected, protocol = PROTOCOL,
  workers = DEFAULTS.workers, onDone}) {
  // The fresh fast simulation repeats the recorded one exactly: with detail on confirmation windows, without on design.
  const tasks = nominees.flatMap(setting => windows.map(window =>
    ({kind: 'engine', window: {...window}, setting, costs: COSTS.default, detail: window.set === 'confirmation'})));
  const context = {market: workers ? shareUntil(market, Infinity) : market, protocol: {...protocol}};
  const results = await runTasks(workers, context, tasks, onDone);
  const problems = [], checks = nominees.map(setting => ({id: setting.id, reference: referenceFor(setting),
    fedHistory: feedsHistory(setting), tolerance: EXACT_TOLERANCE, windowsCompared: 0, windowsRefusedByBoth: 0,
    maxRelativeDifference: 0, fillsEqual: true}));
  results.forEach((result, t) => {
    const {setting, window} = tasks[t], check = checks[nominees.indexOf(setting)];
    const outcome = compareExact(result, expected.get(`${setting.id}|${window.index}`));
    for (const problem of outcome.problems) problems.push(`${setting.id}, window ${window.index}: ${problem}`);
    if (outcome.compared) check.windowsCompared++;
    if (outcome.refused) check.windowsRefusedByBoth++;
    check.maxRelativeDifference = Math.max(check.maxRelativeDifference, outcome.difference);
  });
  if (problems.length) {
    throw new Error('Exact check FAILED: the engine does not reproduce the study\'s numbers. ' +
      `${problems.length} problem(s): ${problems.slice(0, 10).join('; ')}`);
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 7: reported whatever the outcome.

// "The default setting (seven-minute horizon, seven lookback, 10 bps buffer, no stop) on all 74 windows": r, b and
// fills per window, and over all windows and per set the statistics of r, the share of windows with r > 0 and the
// comparison account's mean. Call it only after the nominees are fixed.
export function defaultSettingReport({market, windows, prepared}) {
  const perWindow = windows.map((window, i) => {
    const row = {index: window.index, set: window.set};
    if (!prepared[i].valid) return {...row, invalid: prepared[i].invalidReason};
    const at = simulate(market, prepared[i], DEFAULT_SETTING, COSTS.default);
    return at.valid ? {...row, r: at.returnPct, b: at.buyHoldReturnPct, fills: at.fills} : {...row, invalid: at.invalidReason};
  });
  const over = rows => {
    const r = rows.map(w => w.r ?? NaN), ran = rows.filter(w => w.invalid === undefined);
    return {...describeSeries(r), sharePositive: sharePositive(r), meanComparison: mean(ran.map(w => w.b)),
      meanFills: mean(ran.map(w => w.fills))};
  };
  return {id: DEFAULT_SETTING.id, description: 'seven-minute horizon, seven lookback, 10 bps buffer, no stop',
    ...over(perWindow), design: over(perWindow.filter(w => w.set === 'design')),
    confirmation: over(perWindow.filter(w => w.set === 'confirmation')), perWindow};
}

// The cost hurdle for every supported horizon: per asset, the median absolute log move over the horizon across
// the scored minutes of valid windows, taken at every scored minute whose target minute (one horizon later) also
// exists for that asset, against the round trip in bps = 2 x (feeBps + slippageBps + halfSpreadBps).
export function costHurdle({market, prepared, horizonMinutes = HORIZON_MINUTES}) {
  const valid = prepared.filter(p => p.valid), moves = new Float64Array(valid.reduce((sum, p) => sum + p.shared, 0));
  const roundTripBps = Object.fromEntries(Object.entries(COSTS).map(([name, c]) =>
    [name, 2 * (c.feeBps + c.slippageBps + c.halfSpreadBps)]));
  const horizons = horizonMinutes.map(minutes => {
    const row = {horizonMinutes: minutes};
    for (const asset of ASSETS) {
      const {time, close} = market[asset];
      let count = 0;
      for (const p of valid) {
        const rows = p.index[asset];
        let target = rows.length ? rows[0] : 0;        // two pointers: scored minutes and targets both increase
        for (let i = 0; i < p.shared; i++) {
          const wanted = p.times[i] + minutes * MINUTE;
          while (target < time.length && time[target] < wanted) target++;
          if (target < time.length && time[target] === wanted)
            moves[count++] = Math.abs(Math.log(close[target] / close[rows[i]]));
        }
      }
      const medianBps = 10000 * median(moves.subarray(0, count));
      row[asset] = {minutes: count, medianAbsLogMoveBps: medianBps,
        shareOfDefaultRoundTrip: medianBps / roundTripBps.default};
    }
    return row;
  });
  return {roundTripBps, windows: valid.length, horizons};
}

// What identifies the code that ran (PROTOCOL.md, Simulation: "the SHA-256 of every module that ran, including
// whether engine.js still equals the one at 6f6b693"): the commit, the SHA-256 of every module and of the
// protocol text, each one's state against that commit ('committed', 'modified', 'untracked', or 'unknown' when
// git cannot say), whether any tracked file of the repository is modified, whether a research module is
// untracked, and the engine against the pinned reference. `problems` lists everything that keeps the commit from
// naming the code; runStudy refuses a run on the candle store while it is not empty.
export function codeState() {
  const files = [...MODULES, PROTOCOL_FILE], hash = file => sha256Hex(readFileSync(join(REPOSITORY, file)));
  let facts = null;
  try {
    const git = (...args) => execFileSync('git', args, {cwd: REPOSITORY, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const listed = text => new Set(text.split('\0').filter(Boolean));
    facts = {commit: git('rev-parse', 'HEAD').trim(), tracked: listed(git('ls-files', '-z', '--', ...files)),
      changed: listed(git('diff', '--name-only', '--relative', '-z', 'HEAD', '--', ...files)),
      trackedFilesModified: git('status', '--porcelain', '--untracked-files=no') !== ''};
  } catch { /* not a git checkout, or no git: every state is 'unknown' */ }
  const state = file => (!facts ? 'unknown' : !facts.tracked.has(file) ? 'untracked' : facts.changed.has(file) ? 'modified' : 'committed');
  const modules = MODULES.map(file => ({file, sha256: hash(file), state: state(file)}));
  const engineSha256 = modules.find(m => m.file === 'engine.js').sha256;
  const engine = {file: 'engine.js', sha256: engineSha256, referenceCommit: REFERENCE_ENGINE.commit,
    referenceSha256: REFERENCE_ENGINE.sha256, equalsReference: engineSha256 === REFERENCE_ENGINE.sha256};
  const protocol = {file: PROTOCOL_FILE, sha256: hash(PROTOCOL_FILE), state: state(PROTOCOL_FILE)};
  const problems = [...modules, protocol].filter(m => m.state !== 'committed')
    .map(m => (m.state === 'unknown' ? `git cannot say whether ${m.file} is committed` : `${m.file} is ${m.state}`));
  if (!engine.equalsReference)
    problems.push(`engine.js is not the engine at commit ${REFERENCE_ENGINE.commit}, the protocol's reference`);
  return {commit: facts?.commit ?? null, node: process.version, trackedFilesModified: facts?.trackedFilesModified ?? null,
    researchModulesUntracked: facts ? modules.some(m => m.file.startsWith('research/') && m.state === 'untracked') : null,
    allModulesCommitted: modules.every(m => m.state === 'committed'), modules, engine, protocol, problems};
}

// ---------------------------------------------------------------------------------------------------------------
// Step 8: everything, in order, and the written record.

// A path is recorded as given only when it is relative and stays inside the working directory; anything else
// (an absolute path may hold a user or machine name) is recorded as changed without its value.
const WITHHELD = '(a path outside the working directory; not recorded)';
const shownPath = path =>
  (typeof path === 'string' && !isAbsolute(path) && !normalize(path).startsWith('..') ? path : WITHHELD);

// The settings to search: the protocol's 13,200, or a subset of them (dry runs and tests). A setting that is not
// in the protocol's grid, exactly as research/settings.mjs enumerates it, is refused.
function searchedSettings(subset) {
  const grid = allSettings();
  if (subset === null || subset === undefined) return grid;
  const known = new Map(grid.map(setting => [setting.id, JSON.stringify(setting)]));
  const wanted = new Set(subset.map(setting => {
    if (known.get(setting?.id) !== JSON.stringify(setting))
      throw new Error(`Not a setting of the protocol's grid: ${setting?.id}`);
    return setting.id;
  }));
  if (wanted.size !== subset.length) throw new Error('The settings option lists a setting twice');
  return grid.filter(setting => wanted.has(setting.id));   // always in grid order
}

// A protocol object has exactly the fields of PROTOCOL. A scaled-down test protocol passes its own smaller
// minimums of valid windows; one without them is refused, not read as "no minimum".
function checkProtocol(protocol) {
  const fields = Object.keys(PROTOCOL), unknown = Object.keys(protocol ?? {}).filter(key => !fields.includes(key));
  if (!protocol || unknown.length) throw new Error(`protocol: unknown field ${unknown.join(', ')}`);
  const whole = (key, least) => {
    if (!Number.isInteger(protocol[key]) || protocol[key] < least) throw new Error(`protocol.${key} must be an integer of at least ${least}`);
  };
  if (!Number.isSafeInteger(protocol.from) || protocol.from % MINUTE) throw new Error('protocol.from must be a UTC minute in milliseconds');
  whole('windowDays', 1); whole('windowCount', 1); whole('designCount', 0);
  whole('minValidDesignWindows', 1); whole('minValidConfirmationWindows', 1);
  if (protocol.designCount > protocol.windowCount) throw new Error('protocol.designCount exceeds protocol.windowCount');
  if (!(protocol.minSharedFraction > 0 && protocol.minSharedFraction <= 1)) throw new Error('protocol.minSharedFraction must be above 0 and at most 1');
}

const fileFacts = path => {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return {path: shownPath(path), sha256: sha256Hex(bytes), bytes: bytes.length, modifiedAt: statSync(path).mtime.toISOString()};
};

// What an earlier exploration.json said of itself, when it can be read as a record of this study: its format, its
// banner lines and its data source. Null when the file is absent or is not such a record.
function replacedRecord(path) {
  try {
    const old = JSON.parse(readFileSync(path, 'utf8'));
    const lines = Array.isArray(old.banner) && old.banner.every(line => typeof line === 'string');
    return lines && typeof old.data?.source === 'string'
      ? {format: typeof old.format === 'string' ? old.format : null, banner: old.banner, dataSource: old.data.source} : null;
  } catch { return null; }
}

// What keeps a store from being the protocol's (PROTOCOL.md, Data boundary: "every month from 2020-01 to 2025-09
// present and complete for both assets, fetched from the exchange. A month that holds no row for an asset is not
// complete"), in words, from what research/dataset.mjs storeCompleteness returned. Its problems are of three
// kinds, told apart by how their text begins: at most one per asset-month of the range, one per month the manifest
// lists outside the range, and one per candle or receipts file that no manifest entry names.
function storeShortfalls(store) {
  const beginning = text => store.problems.filter(p => p.problem.startsWith(text)).length;
  const outside = beginning('outside the exploration range'), unnamed = beginning('not in the manifest');
  const months = store.problems.length - outside - unnamed;
  return [
    ...(store.sourceIsExchange ? [] : [`its source is "${store.source}", not the exchange ("${SOURCE}")`]),
    ...(months ? [`${months} of the ${ASSETS.length * explorationMonths().length} asset-months from 2020-01 to 2025-09 ` +
      'are missing, partial, without a row or do not verify'] : []),
    ...(outside ? [`its manifest lists ${outside} month${outside === 1 ? '' : 's'} outside 2020-01 to 2025-09`] : []),
    ...(unnamed ? [`${unnamed} candle or receipts file${unnamed === 1 ? ' in its directory is' : 's in its directory are'} ` +
      'named by no manifest entry'] : [])];
}

// The measurement behind the protocol's two tables, identified, and held against the statistics that ran:
// {file, sha256 (of research/calibration.json), statsSha256 (the research/stats.mjs it says it was measured with),
// statsSha256ThatRan, measuredWithTheStatsThatRan}. A file that is missing, or names no statsSha256, leaves
// nulls: the tables' version of the statistics is then not known.
function calibrationState(code) {
  const ran = code.modules.find(m => m.file === 'research/stats.mjs').sha256;
  let bytes = null, measuredWith = null;
  try {
    bytes = readFileSync(join(REPOSITORY, CALIBRATION_FILE));
    const named = JSON.parse(bytes.toString('utf8'))?.statsSha256;
    if (typeof named === 'string') measuredWith = named;
  } catch { /* missing or not JSON */ }
  return {file: CALIBRATION_FILE, sha256: bytes && sha256Hex(bytes), statsSha256: measuredWith, statsSha256ThatRan: ran,
    measuredWithTheStatsThatRan: measuredWith === null ? null : measuredWith === ran};
}

const OPTIONS = ['data', 'out', 'report', 'workers', 'resamples', 'protocol', 'settings', 'market', 'log',
  'allowIncompleteStore', 'allowUncommitted', 'overwrite'];

// options: {data = '.research-data', out = 'research/results' (null: nothing is written, neither file),
//   report = 'research/RESULTS.md', workers = 4, resamples = 10000 (both tests), protocol = PROTOCOL,
//   settings = the 13,200 (or a subset of them),
//   market = null (an in-memory {BTC, LINK} market instead of the candle store: a dry run),
//   allowIncompleteStore = false (run on a store that is not the complete exchange store),
//   allowUncommitted = false (run on the candle store although the code is not committed code),
//   overwrite = false (replace an earlier exploration.json and report), log = line => {}}.
// Refusals, in this order and before anything is simulated: a store that is not complete or not from the exchange;
// on the store path, code that is not committed or an engine.js that is not the reference; an existing record. Each
// has its option, and every option that differs from its default is a deviation in the record, with its reason.
// A market holding a close after 2025-09-30T00:00:00Z is refused whatever its source; that has no option.
// Returns {results, path, bytes, reportPath, report}: `results` is exactly what exploration.json holds (after a
// JSON round trip) and `report` the Markdown that renderResults(results) gives, written to `reportPath`:
//   format, status, banner (the lines that must stand first in the summary and in the report; [] for a protocol run)
//   protocol        {file, sha256, windows, costs, nominationTop, resampling: {resamples, seed}}
//   deviations      [{option, value, default, reason, ...}]
//   readings        {protocol: the seven Readings, notInProtocol: FURTHER_READINGS}
//   code            codeState(): {commit, node, trackedFilesModified, researchModulesUntracked,
//                   allModulesCommitted, modules: [{file, sha256, state}], engine, protocol, problems}
//   data            {source, kind, completeExchangeStore, completeness: {complete, sourceIsExchange, problems},
//                   manifestSha256, rows, firstClose, lastClose, manifest, receipts}
//   previousRun     null, or the replaced files: {exploration, report: {path, sha256, bytes, modifiedAt} | null}
//   windows         one row per window: index, set, start, end, expected, observed, missing, shared, missingShared,
//                   sharedFraction, scoreStart, scoreEnd, valid, invalidReason
//   invalidWindows  the windows invalid for every setting
//   designGrid      {settings, designWindows, validDesignWindows, simulations, costs, audit}
//   pooled          all families: {settings, withValidWindows, eligible, positiveMean, eligiblePositiveMean,
//                   best: {id, T, t, lag1, factor, skewness, n, mean, sd}, searchAdjusted: {p, resamples, seed,
//                   windowsResampled}}
//   nominees        [{family, id, setting, design: {rank, n, mean, sd, t, lag1, factor, T, skewness, sharePositive,
//                   meanFills, identical, neighbours, neighbourMedianT, searchAdjustedP, perWindow},
//                   confirmation: {k, label, conditions, threshold, minValidWindows, meanFee10, n, mean, sd, t,
//                   lag1, factor, T, skewness, pT, pResample, p, sharePositive, worst, fee10, fee40, meanFills,
//                   meanFees, meanComparison, regression, direction, invalidForSetting, perWindow},
//                   exactCheck: {id, reference, fedHistory, tolerance, windowsCompared, windowsRefusedByBoth,
//                   maxRelativeDifference, fillsEqual}}]
//   families        per family: the fields of `pooled`, refusedForWarmup {window: settings}, top (the 20
//                   highest-scoring eligible settings), nomination {nominee, considered, tenConsidered}, scores
//                   {ids, mean, T, n, windowsWithFills} for every searched setting
//   defaultSetting  {id, description, n, mean, sd, t, lag1, factor, T, skewness, sharePositive, meanComparison,
//                   meanFills, design, confirmation, perWindow: [{index, set, r, b, fills} or {index, set, invalid}]}
//   costHurdle      {roundTripBps, windows, horizons: [{horizonMinutes, BTC, LINK: {minutes, medianAbsLogMoveBps,
//                   shareOfDefaultRoundTrip}}]}
//   timing          {startedAt, wallSeconds, steps, workers}
// Two runs of the same code on the same data differ in `timing` only.
export async function runStudy(options = {}) {
  const unknown = Object.keys(options).filter(key => !OPTIONS.includes(key));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  const {data = DEFAULTS.data, out = DEFAULTS.out, report = DEFAULTS.report, workers = DEFAULTS.workers,
    resamples = DEFAULTS.resamples, protocol = PROTOCOL, market: given = null, log = () => {},
    allowIncompleteStore = false, allowUncommitted = false, overwrite = false} = options;
  if (!Number.isInteger(workers) || workers < 0 || workers > 64) throw new Error('workers must be an integer from 0 to 64');
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error('resamples must be a positive integer');
  if (typeof data !== 'string' || (out !== null && typeof out !== 'string') || typeof report !== 'string')
    throw new Error('data and report must be paths, and out a path or null');
  for (const [name, value] of Object.entries({allowIncompleteStore, allowUncommitted, overwrite}))
    if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  if (given && (allowIncompleteStore || allowUncommitted))
    throw new Error('allowIncompleteStore and allowUncommitted belong to a run on the candle store; a run on an in-memory market is a dry run');
  checkProtocol(protocol);
  const settings = searchedSettings(options.settings);
  const startedAt = new Date().toISOString(), began = performance.now(), steps = {};
  const timed = async (name, work) => {
    const from = performance.now(), value = await work();
    steps[name] = (performance.now() - from) / 1000;
    log(`${name}: ${steps[name].toFixed(1)} s`);
    return value;
  };
  const progress = label => (done, total) => {
    if (done === total || done % 10 === 0) log(`  ${label}: ${done}/${total}`);
  };
  const deviations = [], banner = [];
  const deviate = (option, value, standard, reason, more = {}) => deviations.push({option, value, default: standard, reason, ...more});
  const passed = name => `The caller passed ${name}.`;

  // 0a. The store (PROTOCOL.md, Data boundary: "The study runs only on a complete store: every month from 2020-01
  // to 2025-09 present and complete for both assets, fetched from the exchange. A month that holds no row for an
  // asset is not complete. ... Anything else is refused unless an explicit option is given, and that option is
  // recorded as a deviation at the top of the results"). research/dataset.mjs storeCompleteness reads the store's
  // own records, and its `usable` is that condition in one field.
  let store = null;
  if (given) {
    banner.push('DRY RUN: this run did NOT use the complete exchange store. It ran on an in-memory market supplied ' +
      'by the caller (a synthetic or test market). Its numbers check the pipeline and say nothing about real prices.');
    deviate('market', 'an in-memory market supplied by the caller', 'the candle store named by data',
      'A dry run of the pipeline: no candle store was read, so nothing here is a result of the protocol.');
  } else {
    store = await timed('store', () => storeCompleteness(data));
    const wrong = store.usable ? [] : storeShortfalls(store), line = p => `  ${`${p.asset} ${p.month}`.trim()}: ${p.problem}`;
    if (!store.usable && !allowIncompleteStore) {
      const named = store.problems.slice(0, 8).map(line);
      throw new Error(['The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). ' +
        `This store is not it: ${wrong.join('; ')}.`, ...named,
        ...(store.problems.length > named.length ? [`  and ${store.problems.length - named.length} more`] : []),
        'Fetch what is missing with research/fetch-candles.mjs, or pass --allow-incomplete-store: the run is then ' +
        'marked at its top as not a run on the complete exchange store'].join('\n'));
    }
    if (!store.usable) banner.push('NOT A PROTOCOL RUN: this run did NOT use the complete exchange store ' +
      `(--allow-incomplete-store): ${wrong.join('; ')}. Its numbers are not results of research/PROTOCOL.md.`);
    if (allowIncompleteStore) deviate('allowIncompleteStore', true, false, !store.usable
      ? `${passed('--allow-incomplete-store')} The protocol runs only on the complete exchange store, and this store is not it: ${wrong.join('; ')}.`
      : `${passed('--allow-incomplete-store')} It changed nothing: the store was complete, and its label and receipts name the exchange.`,
      {storeSource: store.source, sourceIsExchange: store.sourceIsExchange, problems: store.problems});
    if (data !== DEFAULTS.data) deviate('data', shownPath(data), DEFAULTS.data,
      'The candle store was read from another directory than the protocol names; the manifest hash identifies what was read.');
  }

  // 0b. The code (PROTOCOL.md, Simulation: "the SHA-256 of every module that ran"). A dry run records it; a run
  // on the candle store is refused unless the commit names every module that runs and engine.js is the reference.
  const code = codeState();
  if (!given) {
    if (code.problems.length && !allowUncommitted)
      throw new Error(`The record could not name the code that ran: ${code.problems.join('; ')}. Commit the code ` +
        'first, or pass --allow-uncommitted: the run is then recorded as a deviation');
    if (code.problems.length) banner.push(`CODE NOT COMMITTED (--allow-uncommitted): ${code.problems.join('; ')}.`);
    if (allowUncommitted) deviate('allowUncommitted', true, false, code.problems.length
      ? `${passed('--allow-uncommitted')} The commit in this record does not name the code that ran: ${code.problems.join('; ')}. The module hashes do.`
      : `${passed('--allow-uncommitted')} It changed nothing: every module that ran was committed and engine.js was the reference engine.`,
      {problems: code.problems});
  }

  // 0c. An earlier record (PROTOCOL.md, Always reported: "A second run does not silently replace an earlier record").
  // Only the two output paths are looked at: a record written elsewhere is not seen, and the report says so. What
  // the replaced record said of itself (its banner lines and data source) is kept, and the banner is worded from it:
  // a replaced dry run is not an earlier look at the candle store's confirmation windows.
  const paths = out === null ? null : {exploration: join(out, 'exploration.json'), report};
  const existing = paths ? Object.values(paths).filter(path => existsSync(path)) : [];
  if (existing.length && !overwrite)
    throw new Error(`An earlier record exists (${existing.join(', ')}) and is not replaced silently. Move it away, ` +
      'write elsewhere with --out and --report, or pass --overwrite: the replaced files\' SHA-256 and modification ' +
      'times are then kept in the new record');
  const previousRun = existing.length ? {exploration: fileFacts(paths.exploration), report: fileFacts(paths.report),
    record: replacedRecord(paths.exploration)} : null;
  const tags = lines => (lines.length ? lines.map(text => text.split(':')[0]).join(', ') : 'none');
  const replaced = !previousRun ? null
    : !previousRun.record ? 'what the replaced exploration.json recorded could not be read, so it is counted as an ' +
      'earlier look at the confirmation windows'
    : previousRun.record.dataSource === DRY_RUN_SOURCE ? 'the replaced record was a dry run on an in-memory market ' +
      `(its banner: ${tags(previousRun.record.banner)}), not a run on the candle store`
    : `the replaced record was a run on a candle store (source "${previousRun.record.dataSource}"; its banner: ` +
      `${tags(previousRun.record.banner)}), so the confirmation windows had been looked at before this run`;
  if (previousRun) banner.push(`REPLACES AN EARLIER RECORD (--overwrite): ${replaced}. The replaced files are identified under previousRun.`);
  if (overwrite) deviate('overwrite', true, false, previousRun
    ? `${passed('--overwrite')} An earlier record was replaced: ${replaced}. Its SHA-256 and modification time are under previousRun.`
    : `${passed('--overwrite')} It changed nothing: no earlier record existed at the output paths.`);

  // The remaining options.
  if (out !== DEFAULTS.out) deviate('out', out === null ? null : shownPath(out), DEFAULTS.out, out === null
    ? 'Nothing was written to disk: the caller asked for the record in memory only.'
    : 'The record was written to another directory than the protocol names.');
  if (out !== null && report !== DEFAULTS.report) deviate('report', shownPath(report), DEFAULTS.report,
    'The report was written to another file than research/RESULTS.md.');
  if (workers !== DEFAULTS.workers) deviate('workers', workers, DEFAULTS.workers,
    'The number of worker threads was chosen by the caller. It does not change any result (research/study.test.mjs checks this).');
  if (resamples !== DEFAULTS.resamples) deviate('resamples', resamples, DEFAULTS.resamples,
    'The caller changed the number of resamples of both tests; the protocol fixes 10,000.');
  const changedProtocol = Object.keys(PROTOCOL).some(key => protocol[key] !== PROTOCOL[key]);
  if (changedProtocol) deviate('protocol', {...protocol, from: iso(protocol.from)}, {...PROTOCOL, from: iso(PROTOCOL.from)},
    'The caller supplied other windows or minimums than the protocol\'s: a scaled-down run of the pipeline.');
  if (options.settings) deviate('settings', {settings: settings.length,
    perFamily: Object.fromEntries(FAMILIES.map(f => [f, settings.filter(s => s.family === f).length])),
    idsSha256: sha256Hex(settings.map(s => s.id).join('\n'))}, `the ${TOTAL_SETTINGS.toLocaleString('en-US')} settings of the protocol table`,
    'The caller searched a subset of the protocol\'s grid.');
  const reshaped = [changedProtocol && 'the windows or minimums', options.settings && 'the settings searched',
    resamples !== DEFAULTS.resamples && 'the number of resamples'].filter(Boolean);
  if (reshaped.length) banner.push(`CHANGED FROM THE PROTOCOL: ${reshaped.join(', ')} (see Deviations).`);

  // 1. The market, the windows, coverage and validity. A close after the last one of the exploration range is
  // refused whatever the source (PROTOCOL.md, Data boundary: "Nothing in that range, and nothing after it, is
  // fetched, read or simulated by this exploration"). The last allowed bucket closes at RESERVED_FROM.
  const loaded = await timed('load', () => (given ? {market: given, manifest: null, manifestSha256: null, receipts: null} : loadMarket(data)));
  const market = loaded.market;
  for (const asset of ASSETS) {
    assertSeries(market[asset], asset);
    const last = market[asset].time.at(-1);
    if (last > RESERVED_FROM)
      throw new Error(`${asset}: the market holds a close at ${iso(last)}, later than ${iso(RESERVED_FROM)}, the last ` +
        'close of the exploration range. Nothing after it is read or simulated by this study; refused, there is no override');
  }
  const {windows, prepared, coverage} = await timed('windows', () => prepareWindows(market, protocol));
  const design = windows.filter(w => w.set === 'design'), confirmation = windows.filter(w => w.set === 'confirmation');

  // 2. The design grid. Only `design` goes in.
  const grid = await timed('designGrid', () => runDesignGrid({market, designWindows: design, settings, protocol,
    workers, onDone: progress('design windows')}));
  grid.columns.forEach((column, c) => {
    if (column.valid !== prepared[design[c].index].valid)
      throw new Error(`Design window ${column.index}: validity differs between the grid and the coverage table`);
  });

  // 3 and 4. Scores, search-adjusted p-values, nominees. From here on the nominees are fixed.
  const scores = await timed('scores', () => scoreDesign({settings, returns: grid.returns, fills: grid.fills, protocol, resamples}));
  const nomination = nominate({settings, rows: scores.rows, returns: grid.returns});
  const nominees = nomination.nominees, at = new Map(settings.map((setting, s) => [setting.id, s]));

  // 5. Confirmation: nominees only, one look, and the comparison account's own row with the same k.
  const lookedAt = {market, windows: confirmation, prepared: confirmation.map(w => prepared[w.index]), protocol, resamples};
  const [confirmed, comparison] = await timed('confirmation', () => [confirmNominees({...lookedAt, nominees}),
    comparisonAccountRow({...lookedAt, k: nominees.length})]);
  // The comparison account is one account whatever setting ran beside it: each nominee's b is the row's own b.
  const held = new Map(comparison.perWindow.map(w => [w.index, w]));
  for (const {id, perWindow} of confirmed) for (const w of perWindow)
    if (!['b', 'bFee10', 'bFee40'].every(key => held.get(w.index)?.[key] === w[key]))
      throw new Error(`Confirmation window ${w.index}: the comparison account's return beside ${id} is not its own row's`);

  // 6. The engine check: what the study recorded for each nominee, window by window.
  const expected = new Map();
  nominees.forEach((setting, n) => {
    const s = at.get(setting.id), key = index => `${setting.id}|${index}`;
    design.forEach((window, c) => {
      if (grid.columns[c].valid) expected.set(key(window.index), {r: grid.returns[s][c], fills: grid.fills[s][c]});
    });
    confirmed[n].perWindow.forEach(w => expected.set(key(w.index), {r: w.r, fills: w.fills}));
    confirmed[n].invalidForSetting.forEach(w => expected.set(key(w.index), {r: NaN, fills: 0}));
  });
  const exact = await timed('exactCheck', () => exactCheck({market, windows, nominees, expected, protocol, workers,
    onDone: progress('engine reruns')}));

  // 7. Reported whatever the outcome.
  const defaultSetting = await timed('defaultSetting', () => defaultSettingReport({market, windows, prepared}));
  const hurdle = await timed('costHurdle', () => costHurdle({market, prepared}));

  const families = {};
  for (const [family, block] of Object.entries(scores.families)) {
    const members = settings.flatMap((setting, s) => (setting.family === family ? [s] : []));
    const ranked = members.filter(s => scores.rows[s].eligible)
      .sort((a, b) => scores.rows[b].T - scores.rows[a].T || a - b);
    const refusals = {};
    design.forEach((window, c) => {
      const refused = grid.columns[c].valid ? members.filter(s => Number.isNaN(grid.returns[s][c])).length : 0;
      if (refused) refusals[window.index] = refused;
    });
    const picked = nomination.families[family], column = key => members.map(s => scores.rows[s][key]);
    families[family] = {...block,
      // Design windows on which the app would refuse settings of this family for lack of causal warmup,
      // as window -> number of settings refused.
      refusedForWarmup: refusals,
      top: ranked.slice(0, TOP_REPORTED).map(s => {
        const {id, n, mean: m, sd, t, lag1, T, skewness: skew, sharePositive: positive, meanFills, traded} = scores.rows[s];
        return {id, mean: m, sd, n, t, lag1, T, skewness: skew, sharePositive: positive, meanFills, windowsWithFills: traded};
      }),
      nomination: {nominee: picked.nominee?.id ?? null, considered: picked.considered, tenConsidered: picked.tenConsidered},
      // Every searched setting of the family, in grid order: parallel arrays. Eligible is
      // n >= minValidDesignWindows and 2 * windowsWithFills >= n.
      scores: {ids: column('id'), mean: column('mean'), T: column('T'), n: column('n'), windowsWithFills: column('traded')}};
  }

  // The modules are hashed again: the record must name the code that ran, not code that changed under the run.
  const after = codeState();
  const moved = code.modules.filter((m, i) => after.modules[i].sha256 !== m.sha256).map(m => m.file);
  if (moved.length) throw new Error(`A module changed while the study ran (${moved.join(', ')}); nothing was written`);

  const perAsset = value => Object.fromEntries(ASSETS.map(asset => [asset, value(market[asset].time)]));
  const results = {
    format: FORMAT,
    status: STATUS,
    banner,
    protocol: {file: PROTOCOL_FILE, sha256: code.protocol.sha256, windows: {...protocol, from: iso(protocol.from)},
      costs: COSTS, nominationTop: NOMINATION_TOP, resampling: {resamples, seed: scores.pooled.searchAdjusted.seed}},
    deviations,
    readings: {protocol: READINGS, notInProtocol: FURTHER_READINGS},
    code,
    calibration: calibrationState(code),
    data: {source: given ? DRY_RUN_SOURCE : store.source,
      kind: given ? 'in-memory market' : 'candle store (research/fetch-candles.mjs)',
      completeExchangeStore: Boolean(store?.usable),
      completeness: store && {complete: store.complete, sourceIsExchange: store.sourceIsExchange, usable: store.usable,
        problems: store.problems, emptyResponseMonths: store.emptyResponseMonths,
        lastBucketMissingMonths: store.lastBucketMissingMonths, rowsByMonth: store.rowsByMonth},
      manifestSha256: loaded.manifestSha256, rows: perAsset(time => time.length),
      firstClose: perAsset(time => iso(time[0])), lastClose: perAsset(time => iso(time.at(-1))),
      manifest: loaded.manifest, receipts: loaded.receipts},
    previousRun,
    windows: coverage,
    invalidWindows: coverage.filter(w => !w.valid)
      .map(w => ({index: w.index, set: w.set, reason: w.invalidReason, sharedFraction: w.sharedFraction})),
    designGrid: {settings: settings.length, designWindows: design.length,
      validDesignWindows: grid.columns.filter(c => c.valid).length,
      simulations: grid.columns.reduce((sum, c) => sum + (c.valid ? settings.length - c.refused : 0), 0),
      costs: COSTS.default,
      audit: {windowsSimulated: grid.audit.windows, lastDesignClose: iso(grid.audit.lastDesignClose),
        lastCloseVisibleToTheGrid: iso(grid.audit.lastVisibleClose),
        firstConfirmationClose: confirmation.length ? iso(confirmation[0].start) : null}},
    pooled: scores.pooled,
    comparisonAccount: comparison,
    nominees: nominees.map((setting, n) => {
      const s = at.get(setting.id), row = scores.rows[s];
      const picked = nomination.families[setting.family].considered.at(-1);   // the nominee is the last one considered
      return {family: setting.family, id: setting.id, setting,
        design: {rank: picked.rank, n: row.n, mean: row.mean, sd: row.sd, t: row.t, lag1: row.lag1, factor: row.factor,
          T: row.T, skewness: row.skewness, sharePositive: row.sharePositive, meanFills: row.meanFills,
          identical: picked.identical, neighbours: picked.neighbours, neighbourMedianT: picked.neighbourMedianT,
          searchAdjustedP: {family: scores.families[setting.family].searchAdjusted.p, pooled: scores.pooled.searchAdjusted.p,
            note: 'of the best T in the family and in all families; reported, not a gate'},
          perWindow: design.map((window, c) => ({index: window.index, r: grid.returns[s][c], fills: grid.fills[s][c]}))},
        confirmation: confirmed[n], exactCheck: exact[n]};
    }),
    families,
    defaultSetting,
    costHurdle: hurdle,
    timing: {startedAt, wallSeconds: (performance.now() - began) / 1000, steps, workers},
  };

  // One top-level key per line: valid JSON that stays readable in a diff. NaN and infinities become null.
  const line = ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const text = `{\n${Object.entries(results).map(line).join(',\n')}\n}\n`;
  const written = JSON.parse(text), markdown = renderResults(written);
  if (paths) {
    // Without --overwrite the files are created, never replaced, also when one appeared while the study ran:
    // both paths are looked at again before either is written, and each is then opened for creation only.
    const appeared = overwrite ? [] : Object.values(paths).filter(path => existsSync(path));
    if (appeared.length) throw new Error(`A record appeared while the study ran (${appeared.join(', ')}); nothing was written`);
    const flag = overwrite ? 'w' : 'wx';
    mkdirSync(out, {recursive: true});
    mkdirSync(dirname(report), {recursive: true});
    writeFileSync(paths.exploration, text, {flag});
    writeFileSync(paths.report, markdown, {flag});
  }
  return {results: written, path: paths?.exploration ?? null, bytes: Buffer.byteLength(text),
    reportPath: paths?.report ?? null, report: markdown};
}

// The short plain summary the command prints. Its first lines are the record's banner, if it has one.
export function summaryText(results, written = null) {
  const {banner, code, data, windows, invalidWindows, designGrid, families, pooled, nominees, defaultSetting,
    costHurdle: hurdle, deviations, timing, protocol} = results;
  const absent = value => value === null || value === undefined;
  const number = (value, digits = 2) => (absent(value) ? 'n/a' : value.toFixed(digits));
  const signed = value => (absent(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`);
  const count = set => windows.filter(w => w.set === set).length;
  const row = (name, f, nominee = '') => [name.padEnd(6), String(f.settings).padStart(9), String(f.eligible).padStart(9),
    String(f.positiveMean).padStart(7), number(f.best?.T).padStart(8), pValue(f.searchAdjusted.p, f.searchAdjusted.resamples).padStart(18),
    nominee].join(' ').trimEnd();
  const invalid = !invalidWindows.length ? 'none'
    : `${invalidWindows.length} (window ${invalidWindows.slice(0, 12).map(w => w.index).join(', ')}` +
      `${invalidWindows.length > 12 ? ', ...' : ''})`;
  const lines = [
    ...banner,
    'Exploration study: simulated cash only. Exploration, not evidence.',
    `Code ${code.commit ?? 'unknown commit'}${code.problems.length ? ` (this commit does not name the code that ran: ${code.problems.length} problem(s) under code.problems)` : ''}; ` +
      `data: ${data.source}${data.manifestSha256 ? `, manifest sha256 ${data.manifestSha256.slice(0, 16)}...` : ''}`,
    `Windows: ${windows.length} (${count('design')} design, ${count('confirmation')} confirmation); ` +
      `invalid for every setting: ${invalid}`,
    `Design grid: ${designGrid.settings} settings, ${designGrid.simulations} simulations on ` +
      `${designGrid.validDesignWindows} valid design windows, ${number(timing.steps.designGrid, 1)} s on ` +
      `${timing.workers} workers`,
    '',
    'family  settings  eligible  mean>0   best T  search-adjusted p  nominee',
    ...Object.entries(families).map(([family, f]) => row(family, f, ` ${f.nomination.nominee ?? 'none'}`)),
    row('all', pooled),
    '(search-adjusted p: of the best T among that many settings; reported, not a gate)',
    '',
    nominees.length ? `Nominees: ${nominees.length}`
      : 'Nominees: none. No family had a qualifying setting among its ten highest-scoring distinct settings.',
    ...nominees.map(({id, design, confirmation: c, exactCheck: check}) =>
      `  ${id}: design mean ${signed(design.mean)} (T ${number(design.T)}, ${design.n} windows); ` +
      `confirmation mean ${signed(c.mean)} over ${c.n} windows (at least ${c.minValidWindows} needed), ` +
      `p ${pValue(c.p)} against ${number(c.threshold, 4)}, feeBps 10 mean ${signed(c.fee10.mean)}: ${c.label.toUpperCase()}; ` +
      `engine check: ${check.windowsCompared} windows agree with the ${check.reference}` +
      `${check.fedHistory && check.reference === REFERENCES.oracle ? ', fed the history the rule reads' : ''}`),
    '',
    `Default setting (${defaultSetting.description}): mean ${signed(defaultSetting.mean)} over ${defaultSetting.n} ` +
      `windows, share of windows above 0: ${number(defaultSetting.sharePositive)}; buy-and-hold comparison mean ` +
      `${signed(defaultSetting.meanComparison)}`,
    `Cost hurdle (median absolute move against a ${hurdle.roundTripBps.default} bps round trip): ` +
      hurdle.horizons.map(h => `${h.horizonMinutes}m BTC ${number(h.BTC.medianAbsLogMoveBps, 1)} / LINK ` +
        `${number(h.LINK.medianAbsLogMoveBps, 1)} bps`).join('; '),
    `Deviations from ${protocol.file}: ${deviations.length ? deviations.map(d => d.option).join(', ') : 'none'}`,
    `Wall time ${number(timing.wallSeconds, 1)} s` +
      `${written?.path ? `; wrote ${written.path} (${(written.bytes / 1e6).toFixed(2)} MB) and ${written.reportPath}` : ''}`,
  ];
  return lines.join('\n');
}

const USAGE = `Usage: node research/study.mjs [options]
  --data <dir>               the candle store research/fetch-candles.mjs wrote (default ${DEFAULTS.data})
  --out <dir>                where exploration.json is written (default ${DEFAULTS.out})
  --report <file>            where the report is written (default ${DEFAULTS.report})
  --workers <n>              worker threads, 0 to 64 (default ${DEFAULTS.workers}); results do not depend on it
  --allow-incomplete-store   run although the store is not the complete exchange store; marked at the top of the results
  --allow-uncommitted        run although a module that runs is not committed; recorded as a deviation
  --overwrite                replace an earlier exploration.json and report; their SHA-256 and times are recorded
  --help                     print this text
Simulated cash only. Exploration, not evidence.`;
const VALUE_FLAGS = {'--data': 'data', '--out': 'out', '--report': 'report', '--workers': 'workers'};
const SWITCHES = {'--allow-incomplete-store': 'allowIncompleteStore', '--allow-uncommitted': 'allowUncommitted',
  '--overwrite': 'overwrite'};

export async function main(argv) {
  const options = {log: line => console.error(line)};
  if (argv.includes('--help')) { console.log(USAGE); return 0; }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(SWITCHES, flag)) { options[SWITCHES[flag]] = true; continue; }
    const value = argv[++i];
    if (!Object.hasOwn(VALUE_FLAGS, flag) || value === undefined) {
      console.error(`Unknown or incomplete argument: ${flag}\n${USAGE}`);
      return 1;
    }
    options[VALUE_FLAGS[flag]] = flag === '--workers' ? Number(value) : value;
  }
  try {
    const {results, path, bytes, reportPath} = await runStudy(options);
    console.log(summaryText(results, {path, bytes, reportPath}));
    return 0;
  } catch (error) {
    console.error(`Study failed: ${error.message}`);
    return 1;
  }
}

// Run as a command (compared by real path, so a checkout reached through a symbolic link still runs).
let invoked = false;
try { invoked = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch {}
if (invoked) process.exitCode = await main(process.argv.slice(2));
