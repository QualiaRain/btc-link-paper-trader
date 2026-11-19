// The study runner: research/PROTOCOL.md executed end to end as one command.
//
//   node research/study.mjs --data .research-data --out research/results [--workers 4]
//
// Simulated cash only. This is exploration, not evidence: it can nominate a setting for a pre-registered held-out
// test and nothing more. No order, key, wallet or real-money path exists here, and none may be added.
//
// Each step is an exported function so research/study.test.mjs can drive a scaled-down protocol:
//   1 loadMarket, prepareWindows   the data, the protocol's windows, coverage and validity
//   2 runDesignGrid                every setting on every valid DESIGN window (worker threads)
//   3 scoreDesign                  eligibility, the score T and the reality check, per family and pooled
//   4 nominate                     the protocol's "Nomination" section
//   5 confirmNominees              the one look at the confirmation windows, nominees only
//   6 exactCheck                   nominees rerun through the unmodified engine
//   7 defaultSettingReport, costHurdle, gitState   what is reported whatever the outcome
//   8 runStudy                     all of it, written to <out>/exploration.json
//
// Order matters: nothing reads a confirmation-window price before the nominees are fixed (step 1 counts which
// minutes exist; steps 2 to 4 are handed the design windows and a market cut off at the last design minute).
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, normalize} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {MINUTE, ASSETS, PROTOCOL, protocolWindows, prepareWindow, assertSeries, lowerBound} from './windows.mjs';
import {simulate} from './fastsim.mjs';
import {mean, sampleSd, tStat, tTestGreaterP, ols, realityCheck, signTestPValue} from './stats.mjs';
import {DEFAULT_DIR, loadSeries, publicManifest, manifestPath, sha256Hex} from './dataset.mjs';
import {FAMILIES, HORIZON_MINUTES, allSettings, neighbours, DEFAULT_SETTING, COSTS} from './settings.mjs';
import {runTask} from './study-worker.mjs';

export const FORMAT = 'paper-trail-exploration-v1';
export const NOMINATION_TOP = 10;       // "the family's ten highest-scoring eligible settings"
export const TOP_REPORTED = 20;         // highest-scoring eligible settings listed per family
export const EXACT_TOLERANCE = 1e-9;    // relative, on finalValue; fills must be equal
export const NO_ENGINE_REFERENCE = 'no engine reference; covered by the hold-through oracle test';
export const DEFAULTS = Object.freeze({data: DEFAULT_DIR, out: 'research/results', workers: 4, resamples: 10000});

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const iso = time => (Number.isFinite(time) ? new Date(time).toISOString() : null);
const share = (values, test) => (values.length ? values.filter(test).length / values.length : NaN);
const summary = values => ({n: values.length, mean: mean(values), sd: sampleSd(values), T: tStat(values)});
function median(values) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort(), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// How ambiguous protocol text was read. Fixed text, written into every exploration.json so a reader of the
// results sees the reading that produced them.
export const READINGS = Object.freeze([
  'Family X: the table\'s 1,920 settings fix four horizons, so "horizons up to 60 minutes" is read as 1, 5, 7 and ' +
    '15 minutes; including 60 minutes would give 2,400 settings and a total other than 12,720.',
  'Neighbours: the up-to-four settings exactly one grid step away on the lookback axis (span for family L) or on ' +
    'the buffer axis, same horizon, stop and switches. Diagonal settings are not neighbours. Neighbours need not ' +
    'be eligible; each has the score T of the Measures section (0 when sd is 0 or fewer than two valid windows). ' +
    'A setting with no neighbour in the searched grid cannot qualify.',
  'Eligible: at least one fill in at least half of the valid design windows, counted as 2 x (windows with a fill) ' +
    '>= (valid windows). A setting with no valid design window is vacuously eligible with T = 0; its mean is ' +
    'undefined, so it can never be nominated.',
  'Ties in T are broken by enumeration order (research/settings.mjs).',
  'Reality check: every design window is a column that can be drawn, including a window invalid for some or all ' +
    'settings (ignored for those settings). Statistic, seed and conventions are those of research/stats.mjs ' +
    'realityCheck; p = 0 means below 1/resamples.',
  'Confirmation uses the confirmation windows valid for the nominee; k is the number of nominees; the t-test is ' +
    'one-sided with n - 1 degrees of freedom; "cost-robust" needs mean(r) > 0 at feeBps 10 on the same windows.',
  'Direction sign test: the app\'s two-sided exact sign test (report-card.js) on direction hits against misses, ' +
    'flat forecasts excluded, pooled over the nominee\'s confirmation windows, per asset, default costs.',
  'Cost hurdle: at every scored minute of a valid window (design and confirmation) whose minute one horizon later ' +
    'exists for that asset anywhere in its series, the absolute log move over the horizon; the median over those ' +
    'minutes against 2 x (feeBps + slippageBps + halfSpreadBps).',
  'Exact check: nominees without hold-through are rerun window by window through the unmodified engine (families ' +
    'R, X and L through the crafted-history emulation of research/engine-run.mjs). Hold-through cannot run on the ' +
    'unmodified engine.',
  'The default setting and the cost hurdle read confirmation windows; they are computed after the nominees are ' +
    'fixed and feed no selection.',
]);
const REALITY_CHECK_CAVEAT = 'The statistic is the protocol\'s, implemented to the letter. research/stats.mjs ' +
  'documents (KNOWN LIMIT) that this p-value is too small when many settings are searched over about 50 windows; ' +
  'it is reported with the nominees and is not a gate.';
const STATUS = 'Exploration, not evidence. Simulated cash only; no orders exist. A confirmed nominee would justify ' +
  'writing a held-out contract for that one setting and nothing more.';

// ---------------------------------------------------------------------------------------------------------------
// Step 1: the market, the windows, coverage and validity.

// Both assets from the candle store research/fetch-candles.mjs wrote; every stored month is verified on load and
// no row outside the exploration bounds can be returned (research/dataset.mjs). Also what identifies the data:
// the SHA-256 of manifest.json and the committable per-month manifest (row counts, close range, SHA-256).
export function loadMarket(dir = DEFAULT_DIR) {
  const market = Object.fromEntries(ASSETS.map(asset => [asset, loadSeries(dir, asset)]));
  return {market, manifest: publicManifest(dir), manifestSha256: sha256Hex(readFileSync(manifestPath(dir)))};
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
    return tasks.map((task, i) => {
      const result = runTask(context, task);
      onDone(i + 1, tasks.length);
      return result;
    });
  }
  if (!tasks.length) return [];
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length), pool = [];
    let next = 0, done = 0, settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      Promise.all(pool.map(worker => worker.terminate())).then(() => settle(value));
    };
    const feed = worker => {
      if (next >= tasks.length) return;
      const id = next++;
      worker.postMessage({id, task: tasks[id]});
    };
    for (let i = 0; i < Math.min(workers, tasks.length); i++) {
      const worker = new Worker(new URL('./study-worker.mjs', import.meta.url),
        {workerData: {...context, role: 'study-worker'}});
      pool.push(worker);
      worker.on('message', ({id, result, error}) => {
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
// Step 3: eligibility, the score T and the reality check (PROTOCOL.md, "Measures").

// One row per setting over its valid design windows: n, mean, sd, T = mean / (sd / sqrt(n)) (0 when sd is 0),
// the windows with at least one fill, and eligibility: a fill in at least half of the valid windows.
export function scoreRows(settings, returns, fills) {
  return settings.map((setting, s) => {
    const valid = [];
    let traded = 0, fillSum = 0;
    for (let w = 0; w < returns[s].length; w++) {
      if (Number.isNaN(returns[s][w])) continue;
      valid.push(returns[s][w]); fillSum += fills[s][w];
      if (fills[s][w] > 0) traded++;
    }
    return {id: setting.id, family: setting.family, ...summary(valid), traded, eligible: 2 * traded >= valid.length,
      sharePositive: share(valid, r => r > 0), meanFills: valid.length ? fillSum / valid.length : NaN};
  });
}

// Per family and for all families pooled: how many settings, how many eligible, how many with a positive design
// mean, the best T and its search-adjusted p-value. The reality check resamples the same windows for every
// setting and for every call (one seed, fixed in research/stats.mjs), so family and pooled values are comparable.
export function scoreDesign({settings, returns, fills, resamples = DEFAULTS.resamples}) {
  const rows = scoreRows(settings, returns, fills);
  const block = family => {
    const members = rows.flatMap((row, s) => (family === null || row.family === family ? [s] : []));
    const eligible = members.filter(s => rows[s].eligible);
    const check = realityCheck({returns, eligible, resamples});
    const best = eligible.reduce((top, s) => (top === -1 || rows[s].T > rows[top].T ? s : top), -1);
    // The same statistic computed twice, here and inside realityCheck: a disagreement means misaligned tables.
    if (best !== check.argmax || (best !== -1 && rows[best].T !== check.observedMax))
      throw new Error('Reality check and score table disagree on the best eligible setting');
    return {settings: members.length, withValidWindows: members.filter(s => rows[s].n > 0).length,
      eligible: eligible.length, positiveMean: members.filter(s => rows[s].mean > 0).length,
      eligiblePositiveMean: eligible.filter(s => rows[s].mean > 0).length,
      bestT: best === -1 ? null : rows[best].T, bestId: best === -1 ? null : rows[best].id,
      realityCheck: {p: check.p, resamples: check.resamples, seed: check.seed,
        windowsResampled: returns[0]?.length ?? 0}};
  };
  const present = FAMILIES.filter(family => rows.some(row => row.family === family));
  return {rows, families: Object.fromEntries(present.map(family => [family, block(family)])), pooled: block(null)};
}

// ---------------------------------------------------------------------------------------------------------------
// Step 4: nomination (PROTOCOL.md, "Nomination (design set only)").

// One family. `settings` are the family's searched settings in enumeration order; `scores` maps a setting id to
// {eligible, T, mean}. Eligible settings are taken in descending T (ties in enumeration order). The first with
// mean > 0 whose neighbours have a median T above 0 is the nominee; only the ten highest-scoring are looked at.
export function nominateFamily(settings, scores, top = NOMINATION_TOP) {
  const ranked = settings.filter(setting => scores.get(setting.id).eligible)
    .map((setting, order) => ({setting, order, T: scores.get(setting.id).T}))
    .sort((a, b) => b.T - a.T || a.order - b.order);
  const considered = [];
  for (const {setting} of ranked.slice(0, top)) {
    const {T, mean: designMean} = scores.get(setting.id);
    const near = neighbours(setting, settings).map(other => ({id: other.id, T: scores.get(other.id).T}));
    const neighbourMedianT = median(near.map(other => other.T));
    const qualifies = designMean > 0 && neighbourMedianT > 0;
    const reason = qualifies ? 'nominee' : !(designMean > 0) ? 'mean(r) is not above 0'
      : near.length ? 'neighbours\' median T is not above 0' : 'no neighbour in the searched grid';
    considered.push({rank: considered.length + 1, id: setting.id, T, mean: designMean, neighbours: near,
      neighbourMedianT, qualifies, reason});
    if (qualifies) return {nominee: setting, considered};
  }
  return {nominee: null, considered};
}

// Every family: at most one nominee each, so at most five.
export function nominate({settings, rows}) {
  const scores = new Map(rows.map(row => [row.id, row])), families = {};
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

// The protocol's three labels from a nominee's confirmation returns at default costs (r), the same windows rerun
// at feeBps 10 (rFee10), and the number of nominees k.
export function confirmationLabel({r, rFee10, k}) {
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error('k is the number of nominees, 1 to 5');
  const threshold = 0.05 / k, meanDefault = mean(r), p = tTestGreaterP(r), meanFee10 = mean(rFee10);
  const confirmed = meanDefault > 0 && p < threshold;
  const label = !confirmed ? 'not confirmed' : meanFee10 > 0 ? 'confirmed and cost-robust' : 'confirmed at default costs';
  return {label, mean: meanDefault, p, threshold, meanFee10};
}

// Nominees only, each run once on the valid confirmation windows: default costs with detail, then feeBps 10 and
// feeBps 40. `windows` and `prepared` are the confirmation windows and their prepared forms, index-aligned.
export function confirmNominees({market, windows, prepared, nominees}) {
  if (nominees.length > 5) throw new Error('At most five nominees');
  for (const window of windows)
    if (window.set !== 'confirmation') throw new Error(`Window ${window.index} is not a confirmation window`);
  const k = nominees.length;
  return nominees.map(setting => {
    const perWindow = [], invalidForSetting = [];
    windows.forEach((window, i) => {
      if (!prepared[i].valid) return;                    // invalid for every setting; listed under invalidWindows
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
    const r = perWindow.map(w => w.r), b = perWindow.map(w => w.b);
    const rFee10 = perWindow.map(w => w.rFee10), rFee40 = perWindow.map(w => w.rFee40);
    const costRun = values => ({...summary(values), p: tTestGreaterP(values), sharePositive: share(values, v => v > 0)});
    const worst = perWindow.reduce((low, w) => (low === null || w.r < low.r ? w : low), null);
    return {id: setting.id, family: setting.family, k, ...confirmationLabel({r, rFee10, k}), ...summary(r),
      sharePositive: share(r, v => v > 0), worst: worst && {index: worst.index, r: worst.r},
      meanFills: mean(perWindow.map(w => w.fills)), meanFees: mean(perWindow.map(w => w.fees)), meanComparison: mean(b),
      // r regressed on b across windows: is the return more than a diluted share of buy-and-hold?
      regression: ols(r, b),
      direction: Object.fromEntries(ASSETS.map(asset => {
        const [hits, misses, flat] = [0, 1, 2].map(at => perWindow.reduce((sum, w) => sum + w.direction[asset][at], 0));
        return [asset, {hits, misses, flat, hitRate: hits + misses ? hits / (hits + misses) : NaN,
          signTestP: signTestPValue(hits, misses)}];
      })),
      fee10: costRun(rFee10), fee40: costRun(rFee40), invalidForSetting, perWindow};
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Step 6: the exact check.

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

// Every nominee without hold-through is rerun through the unmodified engine on all its valid design and
// confirmation windows (family P directly; R, X and L through the crafted-history emulation of
// research/engine-run.mjs). `expected` maps `${id}|${windowIndex}` to the recorded {r, fills} of every window
// above the coverage floor. Any disagreement throws: the study fails rather than report a nominee the engine
// does not reproduce. Hold-through changes trading and cannot run on the unmodified engine; such nominees are
// returned with the note NO_ENGINE_REFERENCE.
export async function exactCheck({market, windows, nominees, expected, protocol = PROTOCOL,
  workers = DEFAULTS.workers, onDone}) {
  const checkable = nominees.filter(setting => !setting.holdThrough);
  // The fresh fast simulation repeats the recorded one exactly: with detail on confirmation windows, without on design.
  const tasks = checkable.flatMap(setting => windows.map(window =>
    ({kind: 'engine', window: {...window}, setting, costs: COSTS.default, detail: window.set === 'confirmation'})));
  const context = {market: workers ? shareUntil(market, Infinity) : market, protocol: {...protocol}};
  const results = await runTasks(workers, context, tasks, onDone);
  const problems = [], checks = new Map(checkable.map(setting => [setting.id, {
    reference: setting.family === 'P' ? 'unmodified engine'
      : 'unmodified engine, crafted-history emulation (research/engine-run.mjs)',
    tolerance: EXACT_TOLERANCE, windowsCompared: 0, windowsRefusedByBoth: 0, maxRelativeDifference: 0, fillsEqual: true}]));
  results.forEach((result, t) => {
    const {setting, window} = tasks[t], check = checks.get(setting.id);
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
  return nominees.map(setting =>
    ({id: setting.id, ...(checks.get(setting.id) ?? {reference: null, note: NO_ENGINE_REFERENCE})}));
}

// ---------------------------------------------------------------------------------------------------------------
// Step 7: reported whatever the outcome.

// The default setting on every window, design and confirmation: r, b and fills per window, the mean and the share
// of windows with r > 0, over all valid windows and per set. Call it only after the nominees are fixed.
export function defaultSettingReport({market, windows, prepared}) {
  const perWindow = windows.map((window, i) => {
    const row = {index: window.index, set: window.set};
    if (!prepared[i].valid) return {...row, invalid: prepared[i].invalidReason};
    const at = simulate(market, prepared[i], DEFAULT_SETTING, COSTS.default);
    return at.valid ? {...row, r: at.returnPct, b: at.buyHoldReturnPct, fills: at.fills} : {...row, invalid: at.invalidReason};
  });
  const over = rows => {
    const ran = rows.filter(w => w.invalid === undefined), r = ran.map(w => w.r);
    return {...summary(r), sharePositive: share(r, v => v > 0), meanComparison: mean(ran.map(w => w.b)),
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

// The commit of the code that ran, through git itself, and whether the working tree differs from it.
export function gitState(directory = REPOSITORY) {
  try {
    const git = (...args) =>
      execFileSync('git', args, {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return {commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== ''};
  } catch { return {commit: null, dirty: null}; }
}

// ---------------------------------------------------------------------------------------------------------------
// Step 8: everything, in order, and the written record.

// A path is recorded as given only when it is relative and stays inside the working directory; anything else
// (an absolute path may hold a user or machine name) is recorded as changed without its value.
const WITHHELD = '(a path outside the working directory; not recorded)';
const shownPath = path =>
  (typeof path === 'string' && !isAbsolute(path) && !normalize(path).startsWith('..') ? path : WITHHELD);

// The settings to search: the protocol's 12,720, or a subset of them (dry runs and tests). A setting that is not
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
  return grid.filter(setting => wanted.has(setting.id));   // always in enumeration order
}

const OPTIONS = ['data', 'out', 'workers', 'resamples', 'protocol', 'settings', 'market', 'log'];

// options: {data = '.research-data', out = 'research/results' (null: nothing written), workers = 4,
//   resamples = 10000, protocol = PROTOCOL, settings = the 12,720 (or a subset of them),
//   market = null (an in-memory {BTC, LINK} market instead of the candle store: synthetic dry runs),
//   log = line => {}}.
// Every option that differs from its default is listed under "deviations" in the result.
// Returns {results, path, bytes}; `results` is exactly what exploration.json holds (after a JSON round trip):
//   format, status
//   protocol        {file, sha256, windows, costs, nominationTop, realityCheck: {resamples, seed, caveat}}
//   deviations      [{option, value, default}]: every option that differs from its default
//   readings        how ambiguous protocol text was read (READINGS)
//   code            {commit, dirty}
//   data            {source, manifestSha256, rows, firstClose, lastClose, manifest (per-month rows and SHA-256)}
//   windows         one row per window: index, set, start, end, expected, observed, missing, shared, missingShared,
//                   sharedFraction, scoreStart, scoreEnd, valid, invalidReason
//   invalidWindows  the windows invalid for every setting
//   designGrid      {settings, designWindows, validDesignWindows, simulations, costs, audit}
//   pooled          all families: {settings, withValidWindows, eligible, positiveMean, eligiblePositiveMean, bestT,
//                   bestId, realityCheck: {p, resamples, seed, windowsResampled}}
//   nominees        [{family, id, setting, design: {rank, mean, sd, n, T, sharePositive, meanFills, neighbours,
//                   neighbourMedianT, realityCheckP, perWindow}, confirmation: {k, label, mean, p, threshold,
//                   meanFee10, n, sd, T, sharePositive, worst, meanFills, meanFees, meanComparison, regression,
//                   direction, fee10, fee40, invalidForSetting, perWindow}, exactCheck}]
//   families        per family: the fields of `pooled`, refusedForWarmup {window: settings}, top (the 20
//                   highest-scoring eligible settings: id, mean, sd, n, T, sharePositive, meanFills,
//                   windowsWithFills), nomination {nominee, considered}, scores {ids, mean, T, n, windowsWithFills}
//                   for every searched setting
//   defaultSetting  {id, description, n, mean, sd, T, sharePositive, meanComparison, meanFills, design,
//                   confirmation, perWindow: [{index, set, r, b, fills} or {index, set, invalid}]}
//   costHurdle      {roundTripBps, windows, horizons: [{horizonMinutes, BTC, LINK: {minutes, medianAbsLogMoveBps,
//                   shareOfDefaultRoundTrip}}]}
//   timing          {startedAt, wallSeconds, steps, workers}
// Two runs of the same code on the same data differ in `timing` only.
export async function runStudy(options = {}) {
  const unknown = Object.keys(options).filter(key => !OPTIONS.includes(key));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  const {data = DEFAULTS.data, out = DEFAULTS.out, workers = DEFAULTS.workers, resamples = DEFAULTS.resamples,
    protocol = PROTOCOL, market: given = null, log = () => {}} = options;
  if (!Number.isInteger(workers) || workers < 0 || workers > 64) throw new Error('workers must be an integer from 0 to 64');
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error('resamples must be a positive integer');
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
  const code = gitState(), settings = searchedSettings(options.settings);

  const deviations = [], deviate = (option, value, standard) => deviations.push({option, value, default: standard});
  if (given) {
    deviate('market', 'an in-memory market supplied by the caller (a synthetic or test market, not the candle store)',
      'the candle store named by data');
  } else if (data !== DEFAULTS.data) deviate('data', shownPath(data), DEFAULTS.data);
  if (out !== DEFAULTS.out) deviate('out', out === null ? null : shownPath(out), DEFAULTS.out);
  if (workers !== DEFAULTS.workers) deviate('workers', workers, DEFAULTS.workers);
  if (resamples !== DEFAULTS.resamples) deviate('resamples', resamples, DEFAULTS.resamples);
  if (Object.keys({...PROTOCOL, ...protocol}).some(key => protocol[key] !== PROTOCOL[key]))
    deviate('protocol', {...protocol, from: iso(protocol.from)}, {...PROTOCOL, from: iso(PROTOCOL.from)});
  if (options.settings) {
    deviate('settings', {settings: settings.length,
      perFamily: Object.fromEntries(FAMILIES.map(f => [f, settings.filter(s => s.family === f).length])),
      idsSha256: sha256Hex(settings.map(s => s.id).join('\n'))}, 'the 12,720 settings of the protocol table');
  }

  // 1. The market, the windows, coverage and validity.
  const loaded = await timed('load', () => (given ? {market: given, manifest: null, manifestSha256: null} : loadMarket(data)));
  const market = loaded.market;
  for (const asset of ASSETS) assertSeries(market[asset], asset);
  const {windows, prepared, coverage} = await timed('windows', () => prepareWindows(market, protocol));
  const design = windows.filter(w => w.set === 'design'), confirmation = windows.filter(w => w.set === 'confirmation');

  // 2. The design grid. Only `design` goes in.
  const grid = await timed('designGrid', () => runDesignGrid({market, designWindows: design, settings, protocol,
    workers, onDone: progress('design windows')}));
  grid.columns.forEach((column, c) => {
    if (column.valid !== prepared[design[c].index].valid)
      throw new Error(`Design window ${column.index}: validity differs between the grid and the coverage table`);
  });

  // 3 and 4. Scores, reality checks, nominees. From here on the nominees are fixed.
  const scores = await timed('scores', () => scoreDesign({settings, returns: grid.returns, fills: grid.fills, resamples}));
  const nomination = nominate({settings, rows: scores.rows});
  const nominees = nomination.nominees, at = new Map(settings.map((setting, s) => [setting.id, s]));

  // 5. Confirmation: nominees only, one look.
  const confirmed = await timed('confirmation', () => confirmNominees({market, windows: confirmation,
    prepared: confirmation.map(w => prepared[w.index]), nominees}));

  // 6. Exact check against the unmodified engine: what the study recorded for each nominee, window by window.
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
        const {id, n, mean: m, sd, T, sharePositive, meanFills, traded} = scores.rows[s];
        return {id, mean: m, sd, n, T, sharePositive, meanFills, windowsWithFills: traded};
      }),
      nomination: {nominee: picked.nominee?.id ?? null, considered: picked.considered},
      // Every searched setting of the family, in enumeration order: parallel arrays. Eligible is
      // 2 * windowsWithFills >= n.
      scores: {ids: column('id'), mean: column('mean'), T: column('T'), n: column('n'), windowsWithFills: column('traded')}};
  }

  const perAsset = value => Object.fromEntries(ASSETS.map(asset => [asset, value(market[asset].time)]));
  const results = {
    format: FORMAT,
    status: STATUS,
    protocol: {file: 'research/PROTOCOL.md', sha256: sha256Hex(readFileSync(new URL('./PROTOCOL.md', import.meta.url))),
      windows: {...protocol, from: iso(protocol.from)}, costs: COSTS, nominationTop: NOMINATION_TOP,
      realityCheck: {resamples, seed: scores.pooled.realityCheck.seed, caveat: REALITY_CHECK_CAVEAT}},
    deviations,
    readings: READINGS,
    code,
    data: {source: given ? 'in-memory market supplied by the caller; NOT the candle store'
        : 'candle store (research/fetch-candles.mjs)',
      manifestSha256: loaded.manifestSha256, rows: perAsset(time => time.length),
      firstClose: perAsset(time => iso(time[0])), lastClose: perAsset(time => iso(time.at(-1))),
      manifest: loaded.manifest},
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
    nominees: nominees.map((setting, n) => {
      const s = at.get(setting.id), row = scores.rows[s];
      const picked = nomination.families[setting.family].considered.at(-1);   // the nominee is the last one considered
      return {family: setting.family, id: setting.id, setting,
        design: {rank: picked.rank, mean: row.mean, sd: row.sd, n: row.n, T: row.T, sharePositive: row.sharePositive,
          meanFills: row.meanFills, neighbours: picked.neighbours, neighbourMedianT: picked.neighbourMedianT,
          realityCheckP: {family: scores.families[setting.family].realityCheck.p, pooled: scores.pooled.realityCheck.p,
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
  let path = null;
  if (out !== null) {
    mkdirSync(out, {recursive: true});
    path = join(out, 'exploration.json');
    writeFileSync(path, text);
  }
  return {results: JSON.parse(text), path, bytes: Buffer.byteLength(text)};
}

// The short plain summary the command prints.
export function summaryText(results, written = null) {
  const {code, data, windows, invalidWindows, designGrid, families, pooled, nominees, defaultSetting, costHurdle: hurdle,
    deviations, timing} = results;
  const absent = value => value === null || value === undefined;
  const number = (value, digits = 2) => (absent(value) ? 'n/a' : value.toFixed(digits));
  const signed = value => (absent(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`);
  const small = (value, floor = 0.0001) => (absent(value) ? 'n/a' : value < floor ? `< ${floor}` : value.toFixed(4));
  const p = check => small(check.p, 1 / check.resamples);
  const count = set => windows.filter(w => w.set === set).length;
  const row = (name, f, nominee = '') => [name.padEnd(6), String(f.settings).padStart(9), String(f.eligible).padStart(9),
    String(f.positiveMean).padStart(7), number(f.bestT).padStart(8), p(f.realityCheck).padStart(17), nominee].join(' ').trimEnd();
  const invalid = !invalidWindows.length ? 'none'
    : `${invalidWindows.length} (window ${invalidWindows.slice(0, 12).map(w => w.index).join(', ')}` +
      `${invalidWindows.length > 12 ? ', ...' : ''})`;
  const lines = [
    'Exploration study: simulated cash only. Exploration, not evidence.',
    ...(data.manifestSha256 ? [] : ['DRY RUN: this run did not read the candle store. Its numbers check the pipeline ' +
      'and say nothing about real prices.']),
    `Code ${code.commit ?? 'unknown commit'}${code.dirty ? ' (working tree has uncommitted changes)' : ''}; ` +
      `data: ${data.source}${data.manifestSha256 ? `, manifest sha256 ${data.manifestSha256.slice(0, 16)}...` : ''}`,
    `Windows: ${windows.length} (${count('design')} design, ${count('confirmation')} confirmation); ` +
      `invalid for every setting: ${invalid}`,
    `Design grid: ${designGrid.settings} settings, ${designGrid.simulations} simulations on ` +
      `${designGrid.validDesignWindows} valid design windows, ${number(timing.steps.designGrid, 1)} s on ` +
      `${timing.workers} workers`,
    '',
    'family  settings  eligible  mean>0  best T   reality-check p  nominee',
    ...Object.entries(families).map(([family, f]) => row(family, f, ` ${f.nomination.nominee ?? 'none'}`)),
    row('all', pooled),
    '(the reality-check p-value is known to be too small for a search this wide; see protocol.realityCheck.caveat)',
    '',
    nominees.length ? `Nominees: ${nominees.length}`
      : 'Nominees: none. No family had a qualifying setting among its ten highest-scoring.',
    ...nominees.map(({id, design, confirmation: c, exactCheck: check}) =>
      `  ${id}: design mean ${signed(design.mean)} (T ${number(design.T)}, ${design.n} windows); ` +
      `confirmation mean ${signed(c.mean)} over ${c.n} windows, p ${small(c.p)} against ${number(c.threshold, 4)}, ` +
      `feeBps 10 mean ${signed(c.fee10.mean)}: ${c.label.toUpperCase()}; ` +
      `engine check: ${check.reference ? `${check.windowsCompared} windows agree` : check.note}`),
    '',
    `Default setting (${defaultSetting.description}): mean ${signed(defaultSetting.mean)} over ${defaultSetting.n} ` +
      `windows, share of windows above 0: ${number(defaultSetting.sharePositive)}; buy-and-hold comparison mean ` +
      `${signed(defaultSetting.meanComparison)}`,
    `Cost hurdle (median absolute move against a ${hurdle.roundTripBps.default} bps round trip): ` +
      hurdle.horizons.map(h => `${h.horizonMinutes}m BTC ${number(h.BTC.medianAbsLogMoveBps, 1)} / LINK ` +
        `${number(h.LINK.medianAbsLogMoveBps, 1)} bps`).join('; '),
    `Deviations: ${deviations.length ? deviations.map(d => d.option).join(', ') : 'none'}`,
    `Wall time ${number(timing.wallSeconds, 1)} s` +
      `${written ? `; wrote ${written.path} (${(written.bytes / 1e6).toFixed(2)} MB)` : ''}`,
  ];
  return lines.join('\n');
}

const USAGE = 'Usage: node research/study.mjs [--data .research-data] [--out research/results] [--workers 4]';

export async function main(argv) {
  const options = {log: line => console.error(line)};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--help') { console.log(USAGE); return 0; }
    if (!['--data', '--out', '--workers'].includes(flag) || value === undefined) {
      console.error(`Unknown or incomplete argument: ${flag}\n${USAGE}`);
      return 1;
    }
    options[flag.slice(2)] = flag === '--workers' ? Number(value) : value;
  }
  try {
    const {results, path, bytes} = await runStudy(options);
    console.log(summaryText(results, {path, bytes}));
    return 0;
  } catch (error) {
    console.error(`Study failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
