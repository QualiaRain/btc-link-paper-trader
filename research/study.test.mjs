// The study runner (research/study.mjs) on a scaled-down protocol and SYNTHETIC markets: every step of
// research/PROTOCOL.md, as amended twice, is driven before any real exploration data exists. Candle stores are
// written by research/fetch-candles.mjs itself through research/test-store.mjs, answered by a stub; nothing is
// fetched. Nothing here is market data and no number in this file says anything about real prices. Simulated cash
// only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {createAccount} from '../engine.js';
import {MINUTE, DAY, ASSETS, PROTOCOL, protocolWindows, prepareWindow, lowerBound} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine, ENGINE_FILE} from './engine-run.mjs';
import {loadHoldThroughEngine} from './holdthrough-oracle.mjs';
import {syntheticMarket} from './synthetic.mjs';
import {mean, sampleSd, tStat, tTestGreaterP, score, lag1Autocorrelation, autocorrelationFactor, autocorrelationAt, skewness,
  searchAdjustedP, confirmationP, buyAndHoldReading, ols, signTestPValue, mulberry32} from './stats.mjs';
import {SOURCE, LOOPBACK_SOURCE, EXPLORATION_FROM, RESERVED_FROM, explorationMonths, manifestPath, monthPaths,
  monthRange, sha256Hex, storeCompleteness} from './dataset.mjs';
import {writeTestStore} from './test-store.mjs';
import {FAMILIES, AXES, familySettings, allSettings, neighbours, DEFAULT_SETTING, COSTS} from './settings.mjs';
import {runStudy, summaryText, prepareWindows, runDesignGrid, scoreRows, scoreDesign, nominateFamily, confirmationLabel,
  moreThanAShareOfBuyAndHold, readingConditions, heldConditions, descriptiveFigures, confirmNominees, comparisonAccountRow, compareExact, exactCheck, costHurdle,
  codeState, READINGS, FURTHER_READINGS, MODULES, REFERENCE_ENGINE, REFERENCES, referenceFor, feedsHistory} from './study.mjs';
import {renderResults, pValue, labelWithReading, calibrationNote, OUTCOME_BOUNDS, TESTS_SECTION, INDEPENDENCE, TEST_LIMITS,
  RISING_MARKET, SECTIONS} from './report.mjs';
import {gridTask, engineTask} from './study-worker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Temporary directories are removed when the process ends, also when the file stops before any test has run.
const temporary = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'paper-trail-study-')); temporary.push(dir); return dir; };
process.on('exit', () => { for (const dir of temporary) rmSync(dir, {recursive: true, force: true}); });
const byId = Object.fromEntries(allSettings().map(setting => [setting.id, setting]));
const LABELS = ['confirmed at default costs', 'confirmed and cost-robust', 'not confirmed'];
const plain = value => JSON.parse(JSON.stringify(value));   // what a record holds after its JSON round trip
// The two words the repository reserves for claims it does not make, and a third the report must not use.
const RESERVED = new RegExp(`\\b(${['ed' + 'ge', 'al' + 'pha', 'guar' + 'anteed'].join('|')})\\b`, 'i');
// A report quotes the protocol's "What a result would and would not establish" word for word, and that text holds
// one reserved word inside its own negation ("not a trading ..."). Everything else in a report is held to RESERVED.
const unquoted = report => OUTCOME_BOUNDS.reduce((text, quoted) => text.split(`> ${quoted}`).join(''), report);
// Every printed label, and what follows it: the buy-and-hold reading must stand right beside it (PROTOCOL.md,
// Confirmation: "Stated beside the label of every nominee, wherever the label is printed").
const PRINTED_LABEL = /(CONFIRMED AT DEFAULT COSTS|CONFIRMED AND COST-ROBUST|NOT CONFIRMED)(.{0,40})/g;
const labelsAlone = text => [...text.matchAll(PRINTED_LABEL)].filter(([, , after]) => !/^; more than a share of buy-and-hold: (yes|no)\b/.test(after));

// ---------------------------------------------------------------------------------------------------------------
// The scaled-down protocol: 20 windows of 2 days, 10 design + 10 confirmation, 920 of the 13,200 settings, and
// its own smaller minimums of valid windows (the protocol's are 40 and 20), passed through the protocol object.
const FROM = Date.UTC(2021, 0, 1);
const SCALED = Object.freeze({from: FROM, windowDays: 2, windowCount: 20, designCount: 10, minSharedFraction: 0.9,
  minValidDesignWindows: 8, minValidConfirmationWindows: 8});
const WINDOWS = protocolWindows(SCALED);
const DESIGN = WINDOWS.filter(w => w.set === 'design'), CONFIRMATION = WINDOWS.filter(w => w.set === 'confirmation');
// One lookback x buffer plane or two per family: 60-minute horizon for P, H, R and L, 15 minutes for X.
const SEARCHED = allSettings().filter(s => (s.family === 'L' ? s.horizonMs === 60 * MINUTE && s.stopLossBps === 0
  : s.family === 'X' ? s.horizonMs === 15 * MINUTE && s.stopLossBps === 0
  : s.horizonMs === 60 * MINUTE && [0, 300].includes(s.stopLossBps)));
const searchedAt = Object.fromEntries(SEARCHED.map((setting, i) => [setting.id, i]));

const without = (series, from, to) => {
  const rows = [...series.time.keys()].filter(i => series.time[i] < from || series.time[i] > to);
  return {time: Float64Array.from(rows, i => series.time[i]), close: Float64Array.from(rows, i => series.close[i])};
};
// A synthetic market shaped like the real store: its first close is one minute after the protocol's start (window
// 0's own first minute cannot exist, so no lookback setting has warmup there), a few minutes are missing, and
// LINK loses eight hours inside windows 3 (design) and 14 (confirmation), which puts both below the 90% floor.
// regimeDrift is the strength of four-hour trends; 0 makes a driftless random walk.
function scaledMarket(seed, regimeDrift) {
  const quiet = {missing: 0.004, gapRate: 0.0005, longGapRate: 0};
  const market = syntheticMarket({seed, start: FROM + MINUTE, minutes: SCALED.windowCount * SCALED.windowDays * 1440 - 1,
    regimeMinutes: 240, BTC: {...quiet, regimeDrift}, LINK: {...quiet, missing: 0.008, regimeDrift: regimeDrift * 1.5}});
  for (const index of [3, 14]) market.LINK = without(market.LINK, WINDOWS[index].start + 600 * MINUTE, WINDOWS[index].start + 1080 * MINUTE);
  return market;
}
const TREND = scaledMarket(1, 0.0002);
const dryRun = (workers, dir = null, market = TREND) => runStudy({market, protocol: SCALED, settings: SEARCHED, resamples: 300,
  workers, out: dir, ...(dir ? {report: join(dir, 'RESULTS.md')} : {})});
// A rising market with nothing to time: both assets drift up 0.004% a minute (about 12% a two-day window) without
// trends, so a long-only rule gains by being invested and by nothing else (PROTOCOL.md, the last row of the first
// table: "No timing value: 40% invested in a rising market").
function risingMarket(seed) {
  const quiet = {missing: 0.004, gapRate: 0.0005, longGapRate: 0, drift: 0.00004, regimeDrift: 0};
  return syntheticMarket({seed, start: FROM + MINUTE, minutes: SCALED.windowCount * SCALED.windowDays * 1440 - 1, BTC: quiet,
    LINK: {...quiet, missing: 0.008}});
}

// The dry run, four times: twice on two workers (written to disk), once in this thread, once on four workers.
const started = performance.now();
const [A, B] = [await dryRun(2, scratch()), await dryRun(2, scratch())];
const [C, D] = [await dryRun(0), await dryRun(4)];
const dryRunSeconds = (performance.now() - started) / 4000;
const R = A.results;
// The same design grid again, outside runStudy: what the recorded scores and nominations are checked against.
const GRID = await runDesignGrid({market: TREND, designWindows: DESIGN, settings: SEARCHED, protocol: SCALED, workers: 0});

test('the grid is the amended protocol table: 3,360 + 3,360 + 3,360 + 2,400 + 720 = 13,200 settings', () => {
  assert.deepEqual(FAMILIES.map(family => familySettings(family).length), [3360, 3360, 3360, 2400, 720]);
  const all = allSettings();
  assert.equal(all.length, 13200);
  assert.equal(new Set(all.map(s => s.id)).size, 13200, 'ids are unique');
  // The table, transcribed a second time. With unique ids and these counts, each family is the full product.
  const values = (family, key) => [...new Set(familySettings(family).map(s => s[key]))];
  const minutes = list => list.map(m => m * MINUTE);
  for (const family of ['P', 'H', 'R', 'X']) {
    // Amendment 1: "P for the five horizons up to 60 minutes {1, 5, 7, 15, 60}".
    assert.deepEqual(values(family, 'horizonMs'), minutes(family === 'X' ? [1, 5, 7, 15, 60] : [1, 5, 7, 15, 60, 420, 1440]));
    assert.deepEqual(values(family, 'lookback'), [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]);
    assert.deepEqual(values(family, 'bufferBps'), [0, 5, 10, 20, 40, 80, 160, 320]);
    assert.deepEqual(values(family, 'stopLossBps'), [0, 100, 300, 1000]);
    assert.deepEqual(values(family, 'spanMs'), [undefined]);
    assert.deepEqual([values(family, 'holdThrough'), values(family, 'reversal'), values(family, 'btcLed')],
      [[family === 'H'], [family === 'R'], [family === 'X']]);
  }
  assert.deepEqual(values('L', 'spanMs'), minutes([4 * 60, 8 * 60, 12 * 60, 1440, 2 * 1440, 3 * 1440, 5 * 1440, 7 * 1440, 14 * 1440, 28 * 1440]));
  assert.deepEqual(values('L', 'horizonMs'), minutes([60, 420, 1440]));
  assert.deepEqual(values('L', 'bufferBps'), [0, 20, 80, 320]);
  assert.deepEqual(values('L', 'stopLossBps'), [0, 300, 1000]);
  assert.deepEqual([values('L', 'holdThrough'), values('L', 'reversal'), values('L', 'btcLed'), values('L', 'lookback')],
    [[false, true], [false], [false], [undefined]]);
  assert.equal(new Set(all.map(s => JSON.stringify({...s, id: 0, grid: 0, family: 0}))).size, 13200, 'no two settings simulate the same rule');
});

test('the default setting is the app\'s default rule and the costs are the protocol\'s', () => {
  const app = createAccount({}).config;   // engine.js defaults
  assert.deepEqual([DEFAULT_SETTING.horizonMs, DEFAULT_SETTING.lookback, DEFAULT_SETTING.bufferBps, DEFAULT_SETTING.stopLossBps],
    [app.horizonMs, app.lookbackIntervals, app.bufferBps, app.stopLossBps]);
  assert.deepEqual([DEFAULT_SETTING.horizonMs, DEFAULT_SETTING.lookback, DEFAULT_SETTING.bufferBps, DEFAULT_SETTING.stopLossBps,
    DEFAULT_SETTING.family, DEFAULT_SETTING.id], [7 * MINUTE, 7, 10, 0, 'P', 'P-h7-l7-b10-s0']);
  assert.deepEqual(byId[DEFAULT_SETTING.id], DEFAULT_SETTING, 'a member of family P\'s grid');
  assert.deepEqual(COSTS, {default: {feeBps: 2, slippageBps: 2, halfSpreadBps: 3}, fee10: {feeBps: 10, slippageBps: 2, halfSpreadBps: 3},
    fee40: {feeBps: 40, slippageBps: 2, halfSpreadBps: 3}});
  assert.deepEqual([app.feeBps, app.slippageBps], [COSTS.default.feeBps, COSTS.default.slippageBps]);
});

test('every one of the 13,200 settings is accepted by the fast simulator', () => {
  const start = Date.UTC(2022, 5, 1), market = syntheticMarket({seed: 5, start, minutes: 3 * 1440, BTC: {longGapRate: 0}, LINK: {longGapRate: 0}});
  const prepared = prepareWindow(market, {start: start + DAY, end: start + 2 * DAY - MINUTE});
  const all = allSettings(), results = simulateGrid(market, prepared, all, COSTS.default);
  assert.equal(results.length, 13200);
  assert.ok(results.every(r => r.valid && Number.isFinite(r.returnPct)), 'a day of warmup is enough for every lookback');
  assert.ok(results.filter(r => r.fills > 0).length > 1000, 'and many of them trade');
  const at = all.findIndex(s => s.id === DEFAULT_SETTING.id);
  assert.deepEqual(results[at], simulate(market, prepared, DEFAULT_SETTING, COSTS.default));
});

test('coverage and validity per window on a hand-built market: exactly 90% shared is valid, one minute fewer is not', () => {
  // Three one-day windows (1,440 minutes each). BTC lacks minutes 0-99 of day 0. LINK lacks minutes 50-249 of day 0,
  // the last 144 minutes of day 1 and the last 145 of day 2.
  const day = index => FROM + index * DAY, minute = (index, m) => day(index) + m * MINUTE;
  const series = keep => {
    const time = [];
    for (let d = 0; d < 3; d++) for (let m = 0; m < 1440; m++) if (keep(d, m)) time.push(minute(d, m));
    return {time: Float64Array.from(time), close: Float64Array.from(time, (_, i) => 100 + (i % 7))};
  };
  const market = {BTC: series((d, m) => !(d === 0 && m < 100)),
    LINK: series((d, m) => !(d === 0 && m >= 50 && m < 250) && !(d === 1 && m >= 1296) && !(d === 2 && m >= 1295))};
  const {windows, prepared, coverage} = prepareWindows(market, {from: FROM, windowDays: 1, windowCount: 3, designCount: 2, minSharedFraction: 0.9});
  assert.deepEqual(windows.map(w => [w.index, w.set]), [[0, 'design'], [1, 'design'], [2, 'confirmation']]);
  assert.deepEqual(coverage, [
    {index: 0, set: 'design', start: '2021-01-01T00:00:00.000Z', end: '2021-01-01T23:59:00.000Z', expected: 1440,
      observed: {BTC: 1340, LINK: 1240}, missing: {BTC: 100, LINK: 200}, shared: 1190, missingShared: 250, sharedFraction: 1190 / 1440,
      scoreStart: '2021-01-01T04:10:00.000Z', scoreEnd: '2021-01-01T23:59:00.000Z', valid: false, invalidReason: 'insufficient shared coverage'},
    {index: 1, set: 'design', start: '2021-01-02T00:00:00.000Z', end: '2021-01-02T23:59:00.000Z', expected: 1440,
      observed: {BTC: 1440, LINK: 1296}, missing: {BTC: 0, LINK: 144}, shared: 1296, missingShared: 144, sharedFraction: 0.9,
      scoreStart: '2021-01-02T00:00:00.000Z', scoreEnd: '2021-01-02T21:35:00.000Z', valid: true, invalidReason: null},
    {index: 2, set: 'confirmation', start: '2021-01-03T00:00:00.000Z', end: '2021-01-03T23:59:00.000Z', expected: 1440,
      observed: {BTC: 1440, LINK: 1295}, missing: {BTC: 0, LINK: 145}, shared: 1295, missingShared: 145, sharedFraction: 1295 / 1440,
      scoreStart: '2021-01-03T00:00:00.000Z', scoreEnd: '2021-01-03T21:34:00.000Z', valid: false, invalidReason: 'insufficient shared coverage'}]);
  assert.deepEqual(prepared.map(p => p.valid), [false, true, false]);
});

test('neighbours (Reading 6): one grid step on exactly one of the two axes, same horizon, stop and switches', () => {
  const P = familySettings('P'), ids = (id, all) => neighbours(byId[id], all).map(s => s.id);
  assert.deepEqual(ids('P-h7-l7-b10-s0', P), ['P-h7-l5-b10-s0', 'P-h7-l7-b5-s0', 'P-h7-l7-b20-s0', 'P-h7-l10-b10-s0']);
  assert.deepEqual(ids('P-h1-l1-b0-s0', P), ['P-h1-l1-b5-s0', 'P-h1-l2-b0-s0'], 'a corner has two');
  assert.deepEqual(ids('R-h1440-l240-b320-s1000', familySettings('R')), ['R-h1440-l180-b320-s1000', 'R-h1440-l240-b160-s1000']);
  assert.deepEqual(ids('H-h60-l1-b40-s300', familySettings('H')), ['H-h60-l1-b20-s300', 'H-h60-l1-b80-s300', 'H-h60-l2-b40-s300'], 'the end of one axis: three');
  assert.deepEqual(ids('X-h60-l240-b0-s100', familySettings('X')), ['X-h60-l180-b0-s100', 'X-h60-l240-b5-s100'], 'the 60-minute horizon Amendment 1 gave family X');
  assert.deepEqual(ids('L-h420-span1440-b20-s300-hold1', familySettings('L')), ['L-h420-span720-b20-s300-hold1',
    'L-h420-span1440-b0-s300-hold1', 'L-h420-span1440-b80-s300-hold1', 'L-h420-span2880-b20-s300-hold1']);
  // Looked up among all settings at once: still the same family, horizon, stop and switches.
  assert.deepEqual(ids('P-h7-l7-b10-s0', allSettings()), ids('P-h7-l7-b10-s0', P));
  // Neighbours absent from the searched list are simply absent.
  assert.deepEqual(ids('P-h7-l7-b10-s0', P.filter(s => s.lookback !== 5 && s.bufferBps !== 20)), ['P-h7-l7-b5-s0', 'P-h7-l10-b10-s0']);
  assert.throws(() => neighbours({family: 'P', horizonMs: MINUTE}, P), /familySettings/);

  // Whole families: each plane of 15 lookbacks x 8 buffers has 14*8 + 15*7 = 217 neighbouring pairs, each L plane
  // of 10 spans x 4 buffers has 9*4 + 10*3 = 66; the relation is symmetric and never leaves its plane. Family X
  // has 5 horizons x 4 stops = 20 planes, family L 3 horizons x 3 stops x 2 switches = 18.
  for (const [family, pairs] of [['X', 20 * 217], ['L', 18 * 66]]) {
    const all = familySettings(family), near = new Map(all.map(s => [s.id, neighbours(s, all)]));
    assert.equal([...near.values()].reduce((sum, list) => sum + list.length, 0), 2 * pairs);
    for (const s of all) for (const other of near.get(s.id)) {
      assert.ok(near.get(other.id).includes(s), 'symmetric');
      assert.deepEqual([other.horizonMs, other.stopLossBps, other.holdThrough, other.reversal, other.btcLed],
        [s.horizonMs, s.stopLossBps, s.holdThrough, s.reversal, s.btcLed]);
      const moved = ['lookback', 'spanMs', 'bufferBps'].filter(key => other[key] !== s[key]);
      assert.equal(moved.length, 1, 'exactly one of lookback/span and buffer differs');
    }
  }
});

test('eligibility and the score T on hand-built returns and fills', () => {
  const settings = familySettings('P').slice(0, 9), _ = NaN, three = {...PROTOCOL, minValidDesignWindows: 3};
  const returns = [[1, 2, 3, _, _, _], [1, 2, 3, 4, _, _], [1, 2, _, 3, 4, _], [1, -1, 0.5, 2, 0, _], [1, -1, 0.5, 2, 0, _],
    [0, 0, 0, 0, 0, 0], [_, _, _, _, _, _], [4, 4, 4, _, _, _], [1, 2, _, _, _, _]];
  const fills = [[2, 2, 0, 9, 9, 9], [1, 1, 0, 0, 9, 9], [2, 2, 9, 2, 2, 9], [2, 2, 2, 0, 0, 9], [2, 2, 0, 0, 0, 9],
    [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [2, 2, 2, 0, 0, 0], [2, 2, 9, 9, 9, 9]];
  const rows = scoreRows(settings, returns, fills, three), near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} against ${b}`);
  // [1, 2, 3]: mean 2, sd 1, t = 2 / (1 / sqrt(3)); deviations -1, 0, 1 have adjacent products 0, so a = 0 and
  // T = t; fills in 2 of its 3 valid windows, and 3 valid windows meet the minimum of this hand-built protocol.
  assert.deepEqual(plain(rows[0]), {id: settings[0].id, family: 'P', n: 3, mean: 2, sd: 1, t: 2 / (1 / Math.sqrt(3)), lag1: 0, factor: 1,
    T: 2 / (1 / Math.sqrt(3)), skewness: 0, traded: 2, eligible: true, sharePositive: 1, meanFills: 4 / 3});
  // [1, 2, 3, 4]: t = sqrt(15); deviations -1.5, -0.5, 0.5, 1.5 give products 0.75 - 0.25 + 0.75 over squares 5:
  // a = 0.25, the factor is sqrt(0.75 / 1.25) and T = sqrt(15 x 0.6) = 3. Exactly half its windows have a fill.
  near(rows[1].t, Math.sqrt(15)); near(rows[1].lag1, 0.25); near(rows[1].factor, Math.sqrt(0.6)); near(rows[1].T, 3);
  assert.deepEqual([rows[1].n, rows[1].traded, rows[1].eligible], [4, 2, true], 'exactly half counts as "at least half"');
  // The same four returns around an invalid window: the two windows either side of it are not adjacent, so the
  // products are 0.75 + 0.75 and a = 0.3. A compacted series would give 0.25.
  near(rows[2].lag1, 0.3); near(rows[2].T, Math.sqrt(15) * Math.sqrt(0.7 / 1.3));
  assert.deepEqual([rows[2].n, rows[2].mean, rows[2].T], [4, 2.5, score(returns[2])]);
  assert.deepEqual([rows[3].n, rows[3].traded, rows[3].eligible], [5, 3, true], '3 of 5 valid windows is at least half');
  assert.deepEqual([rows[4].n, rows[4].traded, rows[4].eligible], [5, 2, false], '2 of 5 is not');
  assert.deepEqual([rows[3].T, rows[3].t, rows[3].lag1, rows[3].skewness, rows[3].sharePositive],
    [score(returns[3]), tStat(returns[3]), lag1Autocorrelation(returns[3]), skewness(returns[3]), 3 / 5]);
  assert.equal(rows[3].T, rows[3].t * autocorrelationFactor(returns[3]));
  // A setting that never trades returns exactly zero: T is 0 and it is not eligible.
  assert.deepEqual([rows[5].mean, rows[5].sd, rows[5].T, rows[5].eligible], [0, 0, 0, false]);
  // No valid window at all: not eligible, T 0, no mean.
  assert.deepEqual([rows[6].n, rows[6].T, rows[6].eligible, Number.isNaN(rows[6].mean)], [0, 0, false, true]);
  // Identical returns: sd is 0, so T is 0 by the protocol's convention although the mean is positive.
  assert.deepEqual([rows[7].mean, rows[7].sd, rows[7].T, rows[7].eligible], [4, 0, 0, true]);
  // Amendment 1: too few valid windows is not eligible, whatever it traded. Two windows, fills in both.
  assert.deepEqual([rows[8].n, rows[8].traded, rows[8].eligible], [2, 2, false]);
  // With the protocol's own minimum of 40 valid design windows none of these rows is eligible, and a row with 40
  // valid windows of 50 is while one with 39 is not.
  assert.deepEqual(scoreRows(settings, returns, fills).map(row => row.eligible), Array(9).fill(false));
  const forty = [0, 1].map(short => Float64Array.from({length: 50}, (_, w) => (w < 10 + short ? NaN : (w % 3) - 0.5)));
  assert.deepEqual(scoreRows(settings.slice(0, 2), forty, [Array(50).fill(1), Array(50).fill(1)]).map(row => [row.n, row.eligible]),
    [[40, true], [39, false]]);
});

// A score table for family P in which every setting is ineligible with T 0 and mean 0 unless listed. Each listed
// setting gets design returns of its own unless the entry gives them (the fifth value).
function table(entries) {
  const P = familySettings('P'), scores = new Map(P.map(s => [s.id, {eligible: false, T: 0, mean: 0, returns: [0]}]));
  entries.forEach(([id, T, meanReturn, eligible = true, returns = [1000 + P.findIndex(s => s.id === id)]]) => {
    assert.ok(scores.has(id), id);
    scores.set(id, {eligible, T, mean: meanReturn, returns});
  });
  return [P, scores];
}

// The Nomination section written a second time, as plainly as possible and without research/settings.mjs
// neighbours(): the nominee's id or null. `axes` are the family's lookback (or span) and buffer values.
function plainNomination(settings, scores, top = 10) {
  const eligible = settings.filter(s => scores.get(s.id).eligible);
  const ranked = eligible.map((s, order) => ({s, order})).sort((a, b) => scores.get(b.s.id).T - scores.get(a.s.id).T || a.order - b.order);
  const seen = new Set(), distinct = [];
  for (const {s} of ranked) {
    const key = JSON.stringify(Array.from(scores.get(s.id).returns, x => (Number.isNaN(x) ? 'invalid' : x)));
    if (!seen.has(key)) { seen.add(key); distinct.push(s); }
  }
  const step = (a, b) => {
    const axes = AXES[a.family], first = a.family === 'L' ? axes.spanMinutes.map(m => m * MINUTE) : axes.lookback;
    const one = a.family === 'L' ? 'spanMs' : 'lookback';
    return Math.abs(first.indexOf(a[one]) - first.indexOf(b[one])) + Math.abs(axes.bufferBps.indexOf(a.bufferBps) - axes.bufferBps.indexOf(b.bufferBps));
  };
  for (const s of distinct.slice(0, top)) {
    const near = settings.filter(o => o.family === s.family && o.horizonMs === s.horizonMs && o.stopLossBps === s.stopLossBps &&
      o.holdThrough === s.holdThrough && o.reversal === s.reversal && o.btcLed === s.btcLed && step(s, o) === 1)
      .map(o => scores.get(o.id).T).sort((a, b) => a - b);
    const middle = near.length >> 1, median = !near.length ? NaN : near.length % 2 ? near[middle] : (near[middle - 1] + near[middle]) / 2;
    if (scores.get(s.id).mean > 0 && median > 0) return s.id;
  }
  return null;
}

test('nomination on hand-built score tables: descending T, identical returns once, ties in grid order', () => {
  // The best eligible setting qualifies: mean > 0 and its four neighbours' T (-1, 0.5, 1, 2) have median 0.75.
  // Neighbours count whether or not they are eligible.
  let result = nominateFamily(...table([['P-h60-l30-b20-s0', 3, 0.5], ['P-h60-l20-b20-s0', 1, 1, false], ['P-h60-l45-b20-s0', 2, 1, false],
    ['P-h60-l30-b10-s0', -1, -1], ['P-h60-l30-b40-s0', 0.5, 1]]));
  assert.equal(result.nominee.id, 'P-h60-l30-b20-s0');
  assert.deepEqual(result.considered, [{rank: 1, id: 'P-h60-l30-b20-s0', T: 3, mean: 0.5, identical: [], neighbourMedianT: 0.75, qualifies: true, reason: 'nominee',
    neighbours: [{id: 'P-h60-l20-b20-s0', T: 1}, {id: 'P-h60-l30-b10-s0', T: -1}, {id: 'P-h60-l30-b40-s0', T: 0.5}, {id: 'P-h60-l45-b20-s0', T: 2}]}]);
  // The ten considered are the three eligible settings, in descending T: all distinct, standing for themselves.
  assert.deepEqual(result.tenConsidered, {ids: ['P-h60-l30-b20-s0', 'P-h60-l30-b40-s0', 'P-h60-l30-b10-s0'], distinctReturnVectors: 3,
    eligibleSettingsStoodFor: 3, distinctAmongPlainTopTen: 3});

  // Descending T: the first fails on its neighbours (median of -2, -1, 0, 3 is -0.5), the second on its mean, the
  // third (a corner: two neighbours, median 0.3) is the nominee; the fourth would qualify but is never reached.
  result = nominateFamily(...table([
    ['P-h60-l30-b20-s0', 5, 1], ['P-h60-l20-b20-s0', -1, -1, false], ['P-h60-l45-b20-s0', -2, -1, false], ['P-h60-l30-b10-s0', 3, 1, false],
    ['P-h60-l1-b320-s0', 4, -0.1], ['P-h60-l2-b320-s0', 9, 9, false], ['P-h60-l1-b160-s0', 9, 9, false],
    ['P-h60-l240-b0-s0', 3.5, 2], ['P-h60-l180-b0-s0', 0.2, 1, false], ['P-h60-l240-b5-s0', 0.4, 1, false],
    ['P-h5-l30-b20-s0', 3.4, 1], ['P-h5-l20-b20-s0', 1, 1, false], ['P-h5-l45-b20-s0', 1, 1, false], ['P-h5-l30-b10-s0', 1, 1, false], ['P-h5-l30-b40-s0', 1, 1, false]]));
  assert.equal(result.nominee.id, 'P-h60-l240-b0-s0');
  assert.deepEqual(result.considered.map(c => [c.rank, c.id, c.neighbourMedianT, c.qualifies, c.reason]), [
    [1, 'P-h60-l30-b20-s0', -0.5, false, 'neighbours\' median T is not above 0'],
    [2, 'P-h60-l1-b320-s0', 9, false, 'mean(r) is not above 0'],
    [3, 'P-h60-l240-b0-s0', (0.2 + 0.4) / 2, true, 'nominee']]);
  assert.deepEqual(result.tenConsidered.ids, ['P-h60-l30-b20-s0', 'P-h60-l1-b320-s0', 'P-h60-l240-b0-s0', 'P-h5-l30-b20-s0'], 'the ten are named whether or not the walk reaches them');

  // A median of exactly 0 is not "above 0" (here: neighbours that never trade), and an ineligible setting is
  // never a candidate however high its T.
  result = nominateFamily(...table([['P-h60-l30-b20-s0', 3, 0.5], ['P-h7-l7-b10-s0', 50, 5, false]]));
  assert.equal(result.nominee, null);
  assert.deepEqual(result.considered.map(c => [c.id, c.neighbourMedianT, c.qualifies]), [['P-h60-l30-b20-s0', 0, false]]);
  // Nor is a mean of exactly 0 "above 0", whatever the neighbours score.
  const around = id => [['-l30-', '-l20-'], ['-l30-', '-l45-'], ['-b20-', '-b10-'], ['-b20-', '-b40-']].map(([from, to]) => [id.replace(from, to), 2, 1, false]);
  result = nominateFamily(...table([['P-h60-l30-b20-s0', 3, 0], ...around('P-h60-l30-b20-s0')]));
  assert.deepEqual([result.nominee, result.considered.map(c => [c.mean, c.neighbourMedianT, c.reason])], [null, [[0, 2, 'mean(r) is not above 0']]]);
  assert.equal(nominateFamily(...table([['P-h60-l30-b20-s0', 3, 1e-9], ...around('P-h60-l30-b20-s0')])).nominee.id, 'P-h60-l30-b20-s0');

  // Ties in T go to the earlier setting in grid order, whatever order the table lists them in. Both have returns
  // of their own, so both count: a tie is not a twin.
  const near = id => [-1, 1].flatMap(step => [[id.replace('-l30-', step < 0 ? '-l20-' : '-l45-'), 1, 1, false],
    [id.replace('-b20-', step < 0 ? '-b10-' : '-b40-'), 1, 1, false]]);
  result = nominateFamily(...table([['P-h60-l30-b20-s0', 2, 1], ...near('P-h60-l30-b20-s0'), ['P-h15-l30-b20-s0', 2, 1], ...near('P-h15-l30-b20-s0')]));
  assert.equal(result.nominee.id, 'P-h15-l30-b20-s0');
  assert.deepEqual([result.tenConsidered.ids, result.tenConsidered.distinctReturnVectors], [['P-h15-l30-b20-s0', 'P-h60-l30-b20-s0'], 2]);

  // The ten highest-scoring eligible settings all fail; the eleventh would qualify. The family nominates nothing.
  const planes = [1, 5, 7, 15, 60, 420, 1440].map(h => `P-h${h}-l30-b20-s0`).concat([1, 5, 7, 15].map(h => `P-h${h}-l30-b20-s100`));
  const eleven = planes.map((id, i) => [id, 20 - i, 1]);
  const [P, scores] = table([...eleven, ...near(planes[10])]);
  result = nominateFamily(P, scores);
  assert.equal(result.nominee, null);
  assert.deepEqual(result.considered.map(c => c.id), planes.slice(0, 10));
  assert.ok(result.considered.every(c => !c.qualifies && c.neighbourMedianT === 0 && c.mean > 0));
  assert.equal(nominateFamily(P, scores, 11).nominee.id, planes[10], 'only the limit of ten keeps the eleventh out');
  // Nothing eligible: nothing considered.
  assert.deepEqual(nominateFamily(...table([])), {nominee: null, considered: [],
    tenConsidered: {ids: [], distinctReturnVectors: 0, eligibleSettingsStoodFor: 0, distinctAmongPlainTopTen: 0}});

  // Amendment 1: "Settings whose design returns are identical window for window count once, represented by the
  // first of them." The best return vector is shared by four settings that differ only in a stop that never
  // binds; they are listed here in reverse, and the one that comes first in the grid (s0) stands for all four.
  // Under the first version they filled four of the ten places and the setting ranked thirteenth was out of
  // reach; counted once, it is the tenth distinct setting, and it is the nominee.
  const twin = [5, 6, NaN, 7], stops = [1000, 300, 100, 0].map(stop => [`P-h60-l30-b20-s${stop}`, 30, 1, true, twin]);
  const others = [1, 5, 7, 15, 420, 1440].map((h, i) => [`P-h${h}-l30-b20-s0`, 20 - i, -1])
    .concat([[`P-h1-l30-b20-s100`, 12, -1], [`P-h5-l30-b20-s100`, 11, -1]]);
  const tenth = 'P-h7-l30-b20-s100', eleventh = 'P-h15-l30-b20-s100';
  const [Q, shared] = table([...stops, ...others, [tenth, 10, 1], ...near(tenth), [eleventh, 9, 1], ...near(eleventh)]);
  result = nominateFamily(Q, shared);
  assert.equal(result.nominee.id, tenth);
  assert.deepEqual(result.considered.map(c => [c.rank, c.id, c.identical]), [
    [1, 'P-h60-l30-b20-s0', ['P-h60-l30-b20-s100', 'P-h60-l30-b20-s300', 'P-h60-l30-b20-s1000']],
    ...others.map(([id], i) => [i + 2, id, []]), [10, tenth, []]]);
  assert.deepEqual(result.considered.map(c => c.reason), ['neighbours\' median T is not above 0', ...Array(8).fill('mean(r) is not above 0'), 'nominee']);
  // The ten considered held ten distinct return vectors and stand for thirteen eligible settings; the ten
  // highest-scoring eligible settings before the once-only rule held seven.
  assert.deepEqual({...result.tenConsidered, ids: null}, {ids: null, distinctReturnVectors: 10, eligibleSettingsStoodFor: 13, distinctAmongPlainTopTen: 7});
  assert.equal(result.tenConsidered.ids.includes(eleventh), false);
  // "Identical window for window": the same numbers with another window invalid, or one number changed, are a
  // different vector, and equal T alone makes no twin. A twin of the tenth that follows it in the ranking counts.
  const [S, almost] = table([['P-h60-l30-b20-s0', 30, 1, true, twin], ['P-h60-l30-b20-s100', 30, 1, true, [5, 6, 7, NaN]],
    ['P-h60-l30-b20-s300', 30, 1, true, [5, 6, NaN, 7.5]], ['P-h60-l30-b20-s1000', 30, 1, true, [5, 6, NaN, 7]]]);
  result = nominateFamily(S, almost, 3);
  assert.deepEqual(result.tenConsidered, {ids: ['P-h60-l30-b20-s0', 'P-h60-l30-b20-s100', 'P-h60-l30-b20-s300'], distinctReturnVectors: 3,
    eligibleSettingsStoodFor: 4, distinctAmongPlainTopTen: 3});
  assert.deepEqual(result.considered[0].identical, ['P-h60-l30-b20-s1000']);

  // Every table above, and 300 random ones with ties, twins and missing neighbours, against the rule written a
  // second time (plainNomination). Family L is used for the random tables: 720 settings in planes of 10 x 4.
  for (const [settings, table_] of [[P, scores], [Q, shared], [S, almost]])
    assert.equal(nominateFamily(settings, table_).nominee?.id ?? null, plainNomination(settings, table_));
  const L = familySettings('L'), random = mulberry32(20261119), walked = new Set();
  let nominated = 0, twins = 0;
  for (let round = 0; round < 300; round++) {
    const hard = round % 4, sharing = round % 5 ? 0.3 : 0;   // from most settings qualifying to few; every fifth table has no twins
    const vectors = Array.from({length: 6}, (_, v) => [v, random() < 0.5 ? NaN : 1, Math.floor(random() * 3)]);
    const drawn = new Map(L.map(setting => {
      const returns = random() < sharing ? vectors[Math.floor(random() * 6)] : [random(), random(), random()];
      // Twins share their T (it is computed from the returns); other settings draw T from a few values, so ties are common.
      const T = returns === vectors[0] ? 3 : vectors.includes(returns) ? vectors.indexOf(returns) - 2 : Math.floor(random() * 9) / 2 - 1.5 - hard / 2;
      return [setting.id, {eligible: random() < 0.15, T, mean: random() < 0.7 - 0.2 * hard ? 1 : random() < 0.5 ? 0 : -1, returns}];
    }));
    const searched = round % 3 ? L : L.filter(() => random() < 0.8);   // every third table lacks some neighbours
    const got = nominateFamily(searched, drawn);
    assert.equal(got.nominee?.id ?? null, plainNomination(searched, drawn), `random table ${round}`);
    assert.ok(got.considered.length <= 10 && got.tenConsidered.distinctReturnVectors <= 10);
    assert.ok(got.tenConsidered.distinctAmongPlainTopTen <= got.tenConsidered.distinctReturnVectors);
    if (got.nominee) nominated++;
    if (got.tenConsidered.eligibleSettingsStoodFor > got.tenConsidered.distinctReturnVectors) twins++;
    walked.add(got.considered.length);
  }
  // The random tables cover both outcomes, twins and no twins, and walks of every length from 1 to 10.
  assert.ok(nominated > 150 && nominated < 270 && twins > 150 && twins < 280, `${nominated} nominated, ${twins} tables with twins among the ten`);
  assert.deepEqual([...walked].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('confirmation labels on hand-built return vectors: the larger of two p-values, at least 20 windows, 0.05 / k', () => {
  const label = (r, rFee10, k, more = {}) => confirmationLabel({r, rFee10, k, ...more}).label, _ = NaN;
  // Twenty windows repeating 3.4, -1.6, 1.4, -0.6, 2.4: mean 1, squared deviations 4 x 17.2 = 68.8, sd = sqrt(68.8 / 19),
  // t = 1 / (sd / sqrt(20)) = 2.3502. Its lag-1 autocorrelation is negative, so the factor is 1 and T = t.
  // Student's t with 19 degrees of freedom gives p = 0.01486; the studentized resample gives 0.0188 (seed fixed in
  // code); the confirmation p-value is the larger.
  const r = Array.from({length: 20}, (_, i) => [3.4, -1.6, 1.4, -0.6, 2.4][i % 5]), costly = r.map(x => x - 0.5), dear = r.map(x => x - 1.5);
  const test_ = confirmationP(r);
  assert.ok(Math.abs(test_.t - 1 / Math.sqrt(68.8 / 19 / 20)) < 1e-12 && test_.lag1 < 0 && test_.factor === 1 && test_.score === test_.t);
  assert.ok(Math.abs(test_.pT - 0.014861) < 1e-6 && test_.pResample === 0.0188 && test_.p === 0.0188, JSON.stringify(test_));
  assert.equal(test_.pT, tTestGreaterP(r), 'with no autocorrelation to correct, the first p-value is the plain t-test');
  // The bar is 0.05 / k: 0.0188 passes 0.05 (k = 1) and 0.025 (k = 2) and fails 0.0167 (k = 3), 0.0125 and 0.01.
  // The t-test alone (0.01486) would have passed k = 3: the first version's rule confirmed this vector.
  assert.deepEqual([1, 2, 3, 4, 5].map(k => label(r, costly, k)),
    ['confirmed and cost-robust', 'confirmed and cost-robust', 'not confirmed', 'not confirmed', 'not confirmed']);
  assert.ok(test_.pT < 0.05 / 3 && test_.p >= 0.05 / 3);
  assert.equal(label(r, dear, 1), 'confirmed at default costs', 'feeBps 10 mean is -0.5');
  const level = Array.from({length: 20}, (unused, i) => (i % 2 ? -1 : 1));
  assert.deepEqual([mean(level), label(r, level, 1)], [0, 'confirmed at default costs'], 'a feeBps 10 mean of exactly 0 is not above 0');
  assert.deepEqual(confirmationLabel({r, rFee10: costly, k: 2}), {label: 'confirmed and cost-robust', threshold: 0.025, minValidWindows: 20,
    meanFee10: mean(costly), conditions: {enoughWindows: true, positiveMean: true, pBelowThreshold: true, positiveMeanFee10: true}, test: test_});
  assert.deepEqual(confirmationLabel({r, rFee10: dear, k: 3}).conditions, {enoughWindows: true, positiveMean: true, pBelowThreshold: false, positiveMeanFee10: false});
  // The other way round: twenty windows repeating -0.4, -0.4, -0.4, -0.4, 6.6 (mean 1, a gain in one window of five).
  // Squared deviations 4 x 39.2 = 156.8, t = 1 / sqrt(156.8 / 19 / 20) = 1.557, Student's t gives 0.068 and the
  // resample 0.0397. The larger decides: not confirmed even alone, where the resample by itself would have passed.
  const lumpy = Array.from({length: 20}, (unused, i) => (i % 5 === 4 ? 6.6 : -0.4)), lumped = confirmationP(lumpy);
  assert.ok(Math.abs(lumped.t - 1 / Math.sqrt(156.8 / 19 / 20)) < 1e-12 && Math.abs(lumped.pT - 0.06802) < 1e-5 && lumped.pResample === 0.0397 && lumped.p === lumped.pT, JSON.stringify(lumped));
  assert.deepEqual([label(lumpy, lumpy, 1), lumped.pResample < 0.05, lumped.skewness > 1], ['not confirmed', true, true]);
  // "p-value < 0.05 / k" is strict. With 100 resamples the windows 3.5, -1.5, 1.5, -0.5, 2.5 (four times) have a
  // resample p-value of exactly 1 in 100, above their t-test's 0.0091: equal to the bar of five nominees, not below it.
  const onTheBar = Array.from({length: 20}, (unused, i) => [3.5, -1.5, 1.5, -0.5, 2.5][i % 5]), hundred = {resamples: 100};
  assert.deepEqual([confirmationP(onTheBar, hundred).p, 0.05 / 5, confirmationP(onTheBar, hundred).pT < 0.01], [0.01, 0.01, true]);
  assert.deepEqual([4, 5].map(k => label(onTheBar, onTheBar, k, hundred)), ['confirmed and cost-robust', 'not confirmed']);

  // Amendment 1: "at least 20 valid confirmation windows". Twenty windows alternating 1 and 2 have mean 1.5 and
  // t = 13.1 and are confirmed at k = 5; the same series with one window invalid has 19 and is not, although its
  // p-value is as small. Windows 50 to 73 are 24, so four invalid ones still leave enough and five do not.
  const alternating = Array.from({length: 20}, (_, i) => 1 + (i % 2)), nineteen = [...alternating.slice(0, 19), _];
  assert.equal(label(alternating, alternating, 5), 'confirmed and cost-robust');
  assert.equal(label(nineteen, nineteen, 5), 'not confirmed');
  assert.deepEqual([confirmationLabel({r: nineteen, rFee10: nineteen, k: 5}).conditions, confirmationP(nineteen).n, confirmationP(nineteen).p < 0.01],
    [{enoughWindows: false, positiveMean: true, pBelowThreshold: true, positiveMeanFee10: true}, 19, true]);
  const windows24 = invalid => Array.from({length: 24}, (unused, i) => (i < invalid ? NaN : 1 + (i % 2)));
  assert.deepEqual([4, 5].map(invalid => label(windows24(invalid), windows24(invalid), 5)), ['confirmed and cost-robust', 'not confirmed']);
  // A scaled-down protocol passes its own minimum.
  assert.equal(label(nineteen, nineteen, 5, {minValidWindows: 19}), 'confirmed and cost-robust');
  assert.equal(label(alternating, alternating, 5, {minValidWindows: 21}), 'not confirmed');

  // Amendment 1: the score carries the autocorrelation factor. Twenty windows rising from 0.1 to 2.0 have a plain
  // t of 7.9 (p below one in a million) but a lag-1 autocorrelation of 0.85: T is 2.26 and p is 0.0182, which is
  // not confirmed among three nominees or more.
  const rising = Array.from({length: 20}, (_, i) => 0.1 * (i + 1)), risen = confirmationP(rising);
  assert.ok(tTestGreaterP(rising) < 1e-6 && Math.abs(risen.lag1 - 0.85) < 1e-9 && Math.abs(risen.score - 2.2601) < 1e-4 && risen.p === 0.0182, JSON.stringify(risen));
  assert.deepEqual([2, 3, 5].map(k => label(rising, rising, k)), ['confirmed and cost-robust', 'not confirmed', 'not confirmed']);

  // A positive mean that is not significant, a negative mean, and a negative mean with a positive feeBps 10 rerun.
  const noisy = Array.from({length: 20}, (_, i) => [5, -4, 6, -3][i % 4]), losing = alternating.map(x => -x);
  assert.equal(label(noisy, noisy, 1), 'not confirmed');
  assert.equal(label(losing, losing, 1), 'not confirmed');
  assert.equal(label(losing, alternating, 1), 'not confirmed');
  // Identical returns in every window have sd 0: T is 0 and p is 1 by the protocol's convention, however positive.
  assert.deepEqual([label(Array(20).fill(4), Array(20).fill(4), 1), confirmationP(Array(20).fill(4)).p], ['not confirmed', 1]);
  // One window, or none, shows nothing.
  assert.equal(label([5], [5], 1, {minValidWindows: 1}), 'not confirmed');
  assert.equal(label([], [], 1, {minValidWindows: 1}), 'not confirmed');
  assert.throws(() => confirmationLabel({r, rFee10: r, k: 0}), /number of nominees/);
  assert.throws(() => confirmationLabel({r, rFee10: r, k: 6}), /number of nominees/);
});

test('"more than a share of buy-and-hold" on hand-built returns: yes, and no for each of its reasons', () => {
  // Amendment 2: "Fit r = intercept + slope × b by least squares over the nominee's valid confirmation windows ...
  // Yes needs at least 20 valid windows, intercept > 0 and that p-value < 0.05 / k; anything else is no." Here b is
  // 24 comparison returns and r = c + 0.4 b + e, with e a fixed pattern of twelve, rounded to 0.001: the fitted
  // slope is 0.377 whatever c is, and the intercept is c + 0.04.
  const b = [3.1, -2.4, 5.6, 0.8, -4.2, 1.9, 6.3, -1.1, 2.7, -3.5, 4.4, 0.2, -0.9, 3.8, -2.2, 1.5, 5.1, -3.9, 0.6, 2.9, -1.7, 4.8, -0.4, 1.2];
  const e = [1.2, -1, 0.4, -0.8, 0.2, 0.6, -1.2, 1, -0.4, 0, 0.8, -0.6];
  const series = (c, slope = 0.4, base = b) => base.map((x, w) => Math.round((c + slope * x + e[w % 12]) * 1000) / 1000);
  const reading = (r, k, more = {}) => moreThanAShareOfBuyAndHold({r, b, k, ...more});
  const label = (r, k) => confirmationLabel({r, rFee10: r, k}).label;

  // Yes: c = 1, intercept 1.04, fit p 2.5e-6, below every bar from 0.05 / 1 to 0.05 / 5.
  const strong = series(1), yes = reading(strong, 5), parts = buyAndHoldReading(strong, b);
  assert.deepEqual([1, 2, 3, 4, 5].map(k => reading(strong, k).reading), ['yes', 'yes', 'yes', 'yes', 'yes']);
  assert.ok(Math.abs(yes.intercept - 1.0405108) < 1e-6 && Math.abs(yes.slope - 0.3767374) < 1e-6 && yes.p < 3e-6, JSON.stringify(yes));
  // Its numbers are research/stats.mjs buyAndHoldReading's, the score of the adjusted series under the name T.
  const {adjusted: {score: T, ...adjusted}, ...fit} = parts;
  assert.deepEqual(yes, {reading: 'yes', conditions: {enoughWindows: true, positiveIntercept: true, pBelowThreshold: true}, threshold: 0.01,
    minValidWindows: 20, ...fit, adjusted: {...adjusted, T}});

  // No because of the bar: c = 0.35, intercept 0.39 above 0, fit p 0.01757 (the larger: the adjusted series' p is
  // 0.0119). Yes with one or two nominees, no with three to five. With five, the label itself is "confirmed": the
  // confirmation p-value of r is 0.0065, below 0.01. The label and the reading answer different questions.
  const middling = series(0.35), atBar = reading(middling, 5);
  assert.ok(Math.abs(atBar.pFit - 0.0175715) < 1e-6 && atBar.adjusted.p === 0.0119 && atBar.p === atBar.pFit && atBar.intercept > 0, JSON.stringify(atBar));
  assert.deepEqual([1, 2, 3, 4, 5].map(k => reading(middling, k).reading), ['yes', 'yes', 'no', 'no', 'no']);
  assert.deepEqual(atBar.conditions, {enoughWindows: true, positiveIntercept: true, pBelowThreshold: false});
  assert.deepEqual([label(middling, 5), Math.abs(confirmationP(middling).p - 0.0065372) < 1e-6], ['confirmed and cost-robust', true]);
  // The larger of the two p-values: at c = 0.6 the adjusted series' resample (0.0007) is above the fit's 0.00065.
  const close = reading(series(0.6), 5);
  assert.ok(close.pFit < close.adjusted.p && close.p === close.adjusted.p && close.p === 0.0007, JSON.stringify(close));
  // And it can decide the reading: with the noise in runs (lag-1 autocorrelation 0.19, so the score of r − slope × b
  // is shrunk), at c = 0.6 the fit alone (p 0.0088) would pass four nominees' bar of 0.0125; the adjusted series'
  // confirmation p-value, 0.0162, does not. No.
  const runs = [1.2, 1, 0.8, -0.8, -1, -1.2, 1.1, 0.9, -0.9, -1.1, 0.5, -0.5];
  const inRuns = b.map((x, w) => Math.round((0.6 + 0.4 * x + runs[w % 12]) * 1000) / 1000), decided = reading(inRuns, 4);
  assert.ok(decided.pFit < 0.0125 && decided.adjusted.p > 0.0125 && decided.p === decided.adjusted.p && decided.adjusted.lag1 > 0.19, JSON.stringify(decided));
  assert.deepEqual([decided.reading, decided.conditions], ['no', {enoughWindows: true, positiveIntercept: true, pBelowThreshold: false}]);

  // No because the intercept is not above 0: a market that rose (b + 3 in every window) and r = -0.5 + 0.9 b + e.
  // The label is confirmed with five nominees (confirmation p 8.5e-6): all of that mean is time spent invested.
  const rose = b.map(x => x + 3), invested = series(-0.5, 0.9, rose), held = moreThanAShareOfBuyAndHold({r: invested, b: rose, k: 5});
  assert.equal(label(invested, 5), 'confirmed and cost-robust');
  assert.ok(held.intercept < -0.38 && Math.abs(held.slope - 0.8767) < 1e-4 && held.p > 0.9, JSON.stringify(held));
  assert.deepEqual([held.reading, held.conditions], ['no', {enoughWindows: true, positiveIntercept: false, pBelowThreshold: false}]);

  // No for too few windows: the strong series with five windows invalid has 19, and its p-value (0.0004) would pass.
  // A scaled-down protocol passes its own minimum.
  const nineteen = strong.map((x, w) => (w % 5 === 2 ? NaN : x)), few = reading(nineteen, 5);
  assert.deepEqual([few.n, few.p < 0.001, few.reading, few.conditions], [19, true, 'no', {enoughWindows: false, positiveIntercept: true, pBelowThreshold: true}]);
  assert.equal(reading(nineteen, 5, {minValidWindows: 19}).reading, 'yes');
  // No line can be fitted to a comparison account without spread: the reading is no, p 1.
  const flat = moreThanAShareOfBuyAndHold({r: strong, b: Array(24).fill(2), k: 1});
  assert.deepEqual([flat.reading, flat.p, flat.intercept, flat.conditions.positiveIntercept], ['no', 1, NaN, false]);
  assert.throws(() => reading(strong, 0), /number of nominees/);
  assert.throws(() => reading(strong, 6), /number of nominees/);
  // What is printed beside a label, in the summary, RESULTS.md and exploration.json alike.
  assert.equal(labelWithReading({label: 'confirmed at default costs', moreThanAShareOfBuyAndHold: 'no'}),
    'CONFIRMED AT DEFAULT COSTS; more than a share of buy-and-hold: no');
  assert.throws(() => labelWithReading({label: 'not confirmed'}), /needs its buy-and-hold reading/);
});

test('the bars of the reading and of the comparison row are strict, and their minimum of windows is inclusive', () => {
  // study3 finding 2: no hand-built case sat exactly on these edges, so "<=" for "<" (or ">=" for ">") survived. At
  // full size they can be met: with 10,000 resamples a resample p-value can equal 0.05 / k exactly for k = 1, 2, 4
  // and 5, and a confirmation set that loses four windows to the floor has exactly 20.
  const at = {threshold: 0.05 / 5, minValidWindows: 20};
  assert.deepEqual(readingConditions({n: 20, intercept: 0.4, p: 0.01}, at), {enoughWindows: true, positiveIntercept: true, pBelowThreshold: false});
  assert.deepEqual(readingConditions({n: 20, intercept: 0, p: 0.001}, at), {enoughWindows: true, positiveIntercept: false, pBelowThreshold: true});
  assert.deepEqual(readingConditions({n: 20, intercept: 1e-12, p: 0.00999}, at), {enoughWindows: true, positiveIntercept: true, pBelowThreshold: true});
  assert.deepEqual(readingConditions({n: 19, intercept: 0.4, p: 0.001}, at), {enoughWindows: false, positiveIntercept: true, pBelowThreshold: true});
  assert.deepEqual(readingConditions({n: 20, intercept: NaN, p: NaN}, at), {enoughWindows: true, positiveIntercept: false, pBelowThreshold: false});
  assert.deepEqual(readingConditions({n: 24, intercept: 2, p: 0.0125}, {threshold: 0.05 / 4, minValidWindows: 20}).pBelowThreshold, false);
  // "Did simply holding pass?": the conditions of "confirmed at default costs" with the nominees' bar, or no bar.
  const five = {k: 5, minValidWindows: 20};
  assert.deepEqual(heldConditions({n: 20, mean: 0.3, p: 0.01}, five), {enoughWindows: true, positiveMean: true, pBelowThreshold: false});
  assert.deepEqual(heldConditions({n: 20, mean: 0, p: 0.001}, five), {enoughWindows: true, positiveMean: false, pBelowThreshold: true});
  assert.deepEqual(heldConditions({n: 20, mean: 0.3, p: 0.00999}, five), {enoughWindows: true, positiveMean: true, pBelowThreshold: true});
  assert.deepEqual(heldConditions({n: 19, mean: 0.3, p: 0.001}, five), {enoughWindows: false, positiveMean: true, pBelowThreshold: true});
  assert.deepEqual(heldConditions({n: 20, mean: 0.3, p: 0.025}, {k: 2, minValidWindows: 20}).pBelowThreshold, false);
  assert.deepEqual(heldConditions({n: 20, mean: 0.3, p: 0.001}, {k: 0, minValidWindows: 20}), {enoughWindows: true, positiveMean: true, pBelowThreshold: null});
  // And these are the rules the two calculations apply.
  const b = Array.from({length: 24}, (unused, w) => [3.1, -2.4, 5.6, 0.8, -4.2, 1.9][w % 6] + w / 10);
  const r = b.map((x, w) => 0.6 + 0.4 * x + [1.2, -1, 0.4, -0.8, 0.2, 0.6, -1.2, 1, -0.4, 0, 0.8, -0.6][w % 12]);
  for (const k of [1, 3, 5]) {
    const h = moreThanAShareOfBuyAndHold({r, b, k, resamples: 200});
    assert.deepEqual(h.conditions, readingConditions(h, {threshold: 0.05 / k, minValidWindows: 20}));
  }
});

test('a reading of no for too few windows, or with no fitted line, is not given the protocol\'s words for a fit that was read', () => {
  // study3 finding 4: a nominee whose fit had intercept +19.6% and p below 0.0001 read no only for lack of windows,
  // and the report then quoted "cannot be told apart from holding the fraction slope" beside that fit.
  const NO_MEANS = '"*No* means the nominee\'s return on these windows cannot be told apart';
  const bullet = (record, id) => renderResults(record).split('\n').find(line => line.startsWith(`- **${id}**`));
  const tooFew = structuredClone(R), c = tooFew.nominees[0].confirmation, h = c.buyAndHold;
  Object.assign(h, {reading: 'no', n: h.minValidWindows - 1, intercept: 19.6, p: 0.00005,
    conditions: {enoughWindows: false, positiveIntercept: true, pBelowThreshold: true}});
  c.moreThanAShareOfBuyAndHold = 'no';
  const few = bullet(tooFew, tooFew.nominees[0].id);
  assert.ok(few.includes(`its buy-and-hold reading is no, because it has ${h.n} valid windows and needs at least ${h.minValidWindows}: ` +
    'too few valid windows to read, and the protocol counts that as no, whatever the fit on them shows.'), few);
  assert.ok(!few.includes(NO_MEANS) && !few.includes('Here the slope is'), few);
  // No line can be fitted (a comparison account without spread): nothing was read either. The report is rendered
  // from the record after its JSON round trip, where the fit's NaN is null.
  Object.assign(h, {n: h.minValidWindows, intercept: null, slope: null, p: 1, conditions: {enoughWindows: true, positiveIntercept: false, pBelowThreshold: false}});
  const flat = bullet(tooFew, tooFew.nominees[0].id);
  assert.ok(flat.includes('because no line can be fitted, and the reading\'s p-value 1.0000 is not below') &&
    flat.includes(': with no fitted line there is nothing to read, and the protocol counts that as no.') && !flat.includes(NO_MEANS), flat);
  // A fit that was read and is no keeps the protocol's words, with its slope.
  Object.assign(h, {intercept: -0.4, slope: 0.877, p: 0.93, conditions: {enoughWindows: true, positiveIntercept: false, pBelowThreshold: false}});
  const read = bullet(tooFew, tooFew.nominees[0].id);
  assert.ok(read.includes(`In the protocol's words, ${NO_MEANS}`) && read.includes('Here the slope is 0.877.'), read);
});

test('descriptive figures (Reading 9) on hand-built returns: lags 1 to 4, the halves, the lowest third with a refused window and ties', () => {
  // The protocol's own 24 confirmation windows, 50 to 73. Windows 53 and 65 are refused for this nominee: r is NaN
  // there and b is not (the comparison account is defined on every window above the floor, Reading 8).
  const windows = protocolWindows(PROTOCOL).filter(w => w.set === 'confirmation'), _ = NaN;
  assert.deepEqual([windows.length, windows[0].index, windows.at(-1).index], [24, 50, 73]);
  const r = [1.5, -0.5, 2, _, 0.25, 1, -1.5, 3, 0.5, -0.25, 1.75, 2.5, -1, 0.75, 1.25, _, 2.25, -0.75, 0.5, 1, -2, 3.5, 0.25, 1.5];
  // The lowest b of all is at window 53, which is refused. Among valid windows the seven lowest (floor(22 / 3) = 7)
  // are 56 (-6), 62 (-5), 51 and 67 (-4, a tie), 70 (-3), and then -2 is held by 54, 58 and 72: ties go to the earlier
  // window, so 54 and 58 are in and 72 is out.
  const b = [1, -4, 2, -9, -2, 3, -6, 0.5, -2, 4, 1.5, 2.5, -5, 3.5, 1, -8, 2, -4, 5, 0, -3, 6, -2, 1];
  const figures = descriptiveFigures(windows, r, b);
  assert.deepEqual(figures.autocorrelation, [1, 2, 3, 4].map(lag => autocorrelationAt(r, lag)));
  // Reading 7: the refused windows keep their places, so 52 and 54 are not a pair at lag 1 (nor 64 and 66).
  const compact = r.filter(x => x === x);
  assert.notEqual(figures.autocorrelation[0], autocorrelationAt(compact, 1));
  assert.ok(figures.autocorrelation.every(Number.isFinite) && figures.autocorrelation.some(a => a < 0), 'reported as computed, not floored');
  // "The halves of the confirmation set are windows 50 to 61 and 62 to 73", each with its number of valid windows.
  const valid = values => values.filter(x => x === x);
  assert.deepEqual(figures.halves, [{windows: [50, 61], n: 11, mean: mean(valid(r.slice(0, 12)))}, {windows: [62, 73], n: 11, mean: mean(valid(r.slice(12)))}]);
  const lowest = [56, 62, 51, 67, 70, 54, 58];
  assert.deepEqual(figures.lowestThird, {n: 7, windows: lowest, mean: mean(lowest.map(index => r[index - 50])),
    meanComparison: mean(lowest.map(index => b[index - 50]))});
  // A list of odd length (a scaled-down run) gives its middle window to the first half.
  const odd = descriptiveFigures(windows.slice(0, 7), r.slice(0, 7), b.slice(0, 7));
  assert.deepEqual(odd.halves.map(h => [h.windows, h.n]), [[[50, 53], 3], [[54, 56], 3]]);
  assert.deepEqual([odd.lowestThird.n, odd.lowestThird.windows], [2, [56, 51]]);
  // floor(n / 3) is rounded down: eight valid windows give two, not three.
  const eight = descriptiveFigures(windows.slice(0, 9), r.slice(0, 9), b.slice(0, 9));
  assert.deepEqual([eight.lowestThird.n, eight.lowestThird.windows], [2, [56, 51]]);
  // A valid window without the comparison account's b is a defect of the caller.
  assert.throws(() => descriptiveFigures(windows, r, b.map((x, w) => (w === 4 ? NaN : x))), /Window 54: r without the comparison account's b/);
});

test('the comparison account\'s own row (Reading 8): every confirmation window above the floor, the nominees\' k and bar, or no bar', () => {
  const prepared = CONFIRMATION.map(w => prepareWindow(TREND, w, SCALED)), base = {market: TREND, windows: CONFIRMATION, prepared, protocol: SCALED, resamples: 300};
  const row = comparisonAccountRow({...base, k: 4});
  // Window 14 is below the coverage floor; every other confirmation window has b, whichever setting ran beside it.
  assert.deepEqual(row.perWindow.map(w => w.index), [10, 11, 12, 13, 15, 16, 17, 18, 19]);
  for (const [i, w] of CONFIRMATION.entries()) {
    const held = row.perWindow.find(entry => entry.index === w.index);
    if (!held) continue;
    for (const setting of [DEFAULT_SETTING, byId['X-h15-l180-b40-s0']])
      assert.deepEqual([COSTS.default, COSTS.fee10, COSTS.fee40].map(costs => simulate(TREND, prepared[i], setting, costs).buyHoldReturnPct),
        [held.b, held.bFee10, held.bFee40], `window ${w.index}`);
  }
  // The confirmation calculation on b aligned to the confirmation windows, at each cost level.
  const aligned = key => CONFIRMATION.map(w => row.perWindow.find(entry => entry.index === w.index)?.[key] ?? NaN);
  for (const [level, key] of [[row, 'b'], [row.fee10, 'bFee10'], [row.fee40, 'bFee40']]) {
    const {score: T, ...test_} = confirmationP(aligned(key), {resamples: 300});
    assert.deepEqual({...level, fee10: null, fee40: null, perWindow: null, k: null, threshold: null, minValidWindows: null, passed: null, conditions: null,
      sharePositive: null, worst: null}, {...test_, T, fee10: null, fee40: null, perWindow: null, k: null, threshold: null, minValidWindows: null,
      passed: null, conditions: null, sharePositive: null, worst: null});
    const values = row.perWindow.map(entry => entry[key]);
    assert.deepEqual(level.worst, {index: row.perWindow[values.indexOf(Math.min(...values))].index, b: Math.min(...values)});
  }
  // "Did simply holding pass?": the conditions of "confirmed at default costs", with the nominees' k.
  assert.deepEqual([row.k, row.threshold, row.minValidWindows, row.n], [4, 0.0125, 8, 9]);
  assert.deepEqual(row.conditions, {enoughWindows: true, positiveMean: row.mean > 0, pBelowThreshold: row.p < 0.0125});
  assert.equal(row.passed, row.conditions.enoughWindows && row.conditions.positiveMean && row.conditions.pBelowThreshold);
  assert.equal(row.passed, false, 'this market drifts in trends both ways: holding it does not pass');
  // With no nominee there is no k and no bar: the same numbers, standing alone.
  const alone = comparisonAccountRow({...base, k: 0});
  assert.deepEqual([alone.k, alone.threshold, alone.passed, alone.conditions.pBelowThreshold], [0, null, null, null]);
  assert.deepEqual({...alone, k: 4, threshold: 0.0125, passed: row.passed, conditions: row.conditions}, row);
  // On a rising market simply holding passes the same test, with five nominees' bar of 0.01.
  const rising = risingMarket(1), risen = comparisonAccountRow({market: rising, windows: CONFIRMATION, prepared: CONFIRMATION.map(w => prepareWindow(rising, w, SCALED)),
    protocol: SCALED, resamples: 300, k: 5});
  assert.deepEqual([risen.n, risen.passed, risen.mean > 5, risen.p < 0.01], [10, true, true, true]);
  assert.throws(() => comparisonAccountRow({...base, k: 6}), /number of nominees, 0 to 5/);
  assert.throws(() => comparisonAccountRow({...base, windows: DESIGN, prepared: DESIGN.map(w => prepareWindow(TREND, w, SCALED)), k: 1}), /not a confirmation window/);
  // In the dry run's record, the row with the dry run's four nominees.
  assert.deepEqual(R.comparisonAccount, plain(row));
});

test('Readings 7 and 8 on the confirmation side: an invalid window keeps its place; the reading uses the nominee\'s windows, the row every one above the floor', () => {
  // Ten hours before window 16 are taken out of both assets: window 15 falls below the coverage floor (invalid for
  // every setting, like window 14), and window 16 keeps its coverage but no lookback setting has causal warmup there
  // (refused for that setting). A long-lookback setting is never refused (Reading 1).
  const cut = Object.fromEntries(ASSETS.map(asset => [asset, without(TREND[asset], WINDOWS[16].start - 600 * MINUTE, WINDOWS[16].start - MINUTE)]));
  const prepared = CONFIRMATION.map(w => prepareWindow(cut, w, SCALED));
  assert.deepEqual(prepared.map(p => p.valid), CONFIRMATION.map(w => ![14, 15].includes(w.index)));
  const nominees = [byId['P-h60-l10-b160-s300'], byId['L-h60-span240-b0-s0-hold1']];
  const [lookback, long] = confirmNominees({market: cut, windows: CONFIRMATION, prepared, nominees, protocol: SCALED, resamples: 300});
  assert.deepEqual(lookback.invalidForSetting, [{index: 16, reason: 'insufficient warmup'}]);
  assert.deepEqual([lookback.perWindow.map(w => w.index), long.perWindow.map(w => w.index), long.invalidForSetting],
    [[10, 11, 12, 13, 17, 18, 19], [10, 11, 12, 13, 16, 17, 18, 19], []]);
  // "It enters none of that setting's counts, means, standard deviations or scores, and it keeps its place in the
  // window order": the statistics are those of the returns aligned to the ten windows with NaN in place, so 13 and
  // 17 are not an adjacent pair. Taking the three windows out of the list is the other reading, and gives another
  // autocorrelation.
  const aligned = (c, key) => CONFIRMATION.map(w => c.perWindow.find(row => row.index === w.index)?.[key] ?? NaN);
  for (const c of [lookback, long]) {
    const r = aligned(c, 'r'), {score: T, ...test_} = confirmationP(r, {resamples: 300});
    assert.deepEqual([c.n, c.mean, c.sd, c.lag1, c.T, c.pT, c.pResample, c.p], [test_.n, test_.mean, test_.sd, test_.lag1, T, test_.pT, test_.pResample, test_.p]);
    assert.notEqual(c.lag1, lag1Autocorrelation(r.filter(x => x === x)));
    assert.deepEqual(c.autocorrelation, [1, 2, 3, 4].map(lag => autocorrelationAt(r, lag)));
    // Reading 8: "The buy-and-hold reading uses the windows valid for the nominee".
    assert.equal(c.buyAndHold.n, c.n);
  }
  assert.deepEqual([lookback.n, long.n, lookback.halves.map(h => h.n)], [7, 8, [4, 3]]);
  // "... the comparison account's own row uses every confirmation window above the floor and the same k": window 16
  // is in it, although the lookback nominee was refused there.
  const row = comparisonAccountRow({market: cut, windows: CONFIRMATION, prepared, protocol: SCALED, resamples: 300, k: 2});
  assert.deepEqual([row.perWindow.map(w => w.index), row.n, row.k, row.threshold], [[10, 11, 12, 13, 16, 17, 18, 19], 8, 2, 0.025]);
});

test('the design grid refuses anything that is not a design window of the protocol', async () => {
  const run = designWindows => runDesignGrid({market: TREND, designWindows, settings: SEARCHED.slice(0, 3), protocol: SCALED, workers: 0});
  await assert.rejects(run([CONFIRMATION[0]]), /design windows only: window 10 \(confirmation\) is refused/);
  await assert.rejects(run([...DESIGN, CONFIRMATION[0]]), /design windows only/);
  // Relabelling does not help: the window must be that design window of the protocol.
  await assert.rejects(run([{...CONFIRMATION[0], set: 'design'}]), /design windows only/);
  await assert.rejects(run([{...DESIGN[1], start: CONFIRMATION[0].start, end: CONFIRMATION[0].end}]), /design windows only/);
  await assert.rejects(run([{...DESIGN[1], end: DESIGN[1].end + DAY}]), /design windows only/);
  // The unit of work checks the label again, before it prepares anything.
  assert.throws(() => gridTask({market: TREND, settings: SEARCHED.slice(0, 3), costs: COSTS.default, protocol: SCALED}, {window: CONFIRMATION[0]}),
    /not a design window|design windows only/);
});

test('the design grid cannot see confirmation prices: replacing every one of them changes nothing', async () => {
  const lastDesignClose = DESIGN.at(-1).end, settings = SEARCHED.filter((_, i) => i % 9 === 0);
  const poisoned = Object.fromEntries(ASSETS.map(asset => [asset, {time: TREND[asset].time,
    close: TREND[asset].close.map((price, i) => (TREND[asset].time[i] > lastDesignClose ? price * (1 + (i % 7)) : price))}]));
  const [clean, dirty] = [await runDesignGrid({market: TREND, designWindows: DESIGN, settings, protocol: SCALED, workers: 2}),
    await runDesignGrid({market: poisoned, designWindows: DESIGN, settings, protocol: SCALED, workers: 2})];
  assert.deepEqual(dirty.returns, clean.returns);
  assert.deepEqual(dirty.fills, clean.fills);
  assert.ok(clean.returns.some(row => row.some(r => r !== 0 && !Number.isNaN(r))), 'the grid did trade');
  // The spy: the windows the simulations were handed and the last close of the market they held.
  assert.deepEqual(clean.audit.windows, DESIGN.map(w => w.index));
  assert.ok(clean.audit.lastVisibleClose <= lastDesignClose && lastDesignClose < CONFIRMATION[0].start);
  // The same audit in the written record of the dry run.
  assert.deepEqual(R.designGrid.audit.windowsSimulated, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(Date.parse(R.designGrid.audit.lastCloseVisibleToTheGrid) <= Date.parse(R.designGrid.audit.lastDesignClose));
  assert.ok(Date.parse(R.designGrid.audit.lastDesignClose) < Date.parse(R.designGrid.audit.firstConfirmationClose));
  // A confirmation window prepared on what the grid can see holds no minute at all.
  const visible = Object.fromEntries(ASSETS.map(asset => [asset, without(TREND[asset], lastDesignClose + 1, Infinity)]));
  assert.equal(prepareWindow(visible, CONFIRMATION[0], SCALED).shared, 0);
  // And the whole design side of a study, nominees included, is the same when every confirmation price is replaced.
  const again = await runStudy({market: poisoned, protocol: SCALED, settings: SEARCHED, resamples: 300, workers: 0, out: null});
  assert.deepEqual([again.results.families, again.results.pooled, again.results.nominees.map(n => [n.id, n.design])],
    [C.results.families, C.results.pooled, C.results.nominees.map(n => [n.id, n.design])]);
  assert.notDeepEqual(again.results.nominees.map(n => n.confirmation.mean), C.results.nominees.map(n => n.confirmation.mean));
});

test('an error inside a worker thread stops the grid instead of hanging it; runStudy refuses what it does not know', async () => {
  const broken = [{...SEARCHED[0], bufferBps: -5}];
  await assert.rejects(runDesignGrid({market: TREND, designWindows: DESIGN, settings: broken, protocol: SCALED, workers: 2}), /Invalid bufferBps/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, settings: broken, out: null}), /Not a setting of the protocol's grid/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, settings: [SEARCHED[0], SEARCHED[0]], out: null}), /twice/);
  await assert.rejects(runStudy({market: TREND, limitPerFamily: 3}), /Unknown option: limitPerFamily/);
  // A protocol object without its minimums of valid windows (the first version's shape) is refused, not read as
  // "no minimum"; so is a field the protocol does not have.
  const {minValidDesignWindows, minValidConfirmationWindows, ...first} = SCALED;
  await assert.rejects(runStudy({market: TREND, protocol: first, out: null}), /protocol\.minValidDesignWindows must be an integer of at least 1/);
  await assert.rejects(runStudy({market: TREND, protocol: {...first, minValidDesignWindows}, out: null}), /protocol\.minValidConfirmationWindows/);
  await assert.rejects(runStudy({market: TREND, protocol: {...SCALED, minimumWindows: 3}, out: null}), /protocol: unknown field minimumWindows/);
  // The two options that let a run on the candle store go ahead mean nothing for an in-memory market.
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, allowIncompleteStore: true, out: null}), /belong to a run on the candle store/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, allowUncommitted: true, out: null}), /belong to a run on the candle store/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, overwrite: 'yes', out: null}), /overwrite must be true or false/);

  // When a task fails, the pool stops every worker, but none that is still loading its modules: Node 22 aborts
  // the whole process (a V8 check in AsyncModuleExecutionFulfilled, signal SIGTRAP) when a thread is terminated
  // while a module with a top-level await is being evaluated, and research/engine-run.mjs was one until it imported
  // the engine statically (the next test checks that no module of a study worker has one now). Measured on the
  // pool as it was: with 16 workers and a task that fails at once, the process died within 1 to 34 attempts in
  // 6 runs of 6. Here every terminate() is watched instead: it must come after the worker's first message (its
  // "loaded" notice), or after the worker has gone. An early one is held back and counted, so a pool that does it
  // fails this test instead of taking the test process down.
  const send = Worker.prototype.postMessage, stop = Worker.prototype.terminate, seen = new WeakMap(), early = [];
  Worker.prototype.postMessage = function (...args) {
    if (!seen.has(this)) {
      const state = {loaded: false};
      state.done = new Promise(resolve => { for (const event of ['message', 'error', 'exit']) this.once(event, () => { state.loaded = true; resolve(); }); });
      seen.set(this, state);
    }
    return send.apply(this, args);
  };
  Worker.prototype.terminate = function () {
    const state = seen.get(this);
    if (!state || state.loaded) return stop.call(this);
    early.push(this.threadId);
    return state.done.then(() => stop.call(this));
  };
  let stopped = 0;
  try {
    const nominees = [{...SEARCHED[0], id: 'broken', bufferBps: -5}, SEARCHED[0], SEARCHED[1]];
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = early.length;
      await assert.rejects(exactCheck({market: TREND, windows: WINDOWS, nominees, expected: new Map(), protocol: SCALED, workers: 16}), /Worker task \d+ failed: Error: Invalid bufferBps/);
      stopped += early.length - before;
    }
  } finally {
    Worker.prototype.postMessage = send;
    Worker.prototype.terminate = stop;
  }
  assert.deepEqual([early, stopped], [[], 0], `${early.length} workers were terminated before they had loaded`);
  // The notice itself: a study worker's first message says that it has loaded, also when a task is already
  // waiting for it (here one it can only answer with an error).
  const worker = new Worker(new URL('./study-worker.mjs', import.meta.url), {workerData: {role: 'study-worker'}});
  worker.postMessage({id: 0, task: {kind: 'nothing'}});
  const notice = await once(worker, 'message');
  await worker.terminate();
  assert.deepEqual(notice, [{ready: true}]);
});

test('research/engine-run.mjs imports engine.js statically, the file ENGINE_FILE names, and a study worker can be terminated while it loads', async () => {
  // The module the static import loads is the file ENGINE_FILE names and the study hashes. In the source: the one
  // import of engine.js and the URL ENGINE_FILE is made from name the same file.
  const source = readFileSync(join(ROOT, 'research', 'engine-run.mjs'), 'utf8'), at = pathToFileURL(join(ROOT, 'research', 'engine-run.mjs'));
  const imports = [...source.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map(([, specifier]) => specifier).filter(specifier => specifier.endsWith('engine.js'));
  const urls = [...source.matchAll(/new URL\('([^']+)', import\.meta\.url\)/g)].map(([, specifier]) => specifier);
  assert.deepEqual([imports, urls], [['../engine.js'], ['../engine.js']]);
  assert.equal(fileURLToPath(new URL(imports[0], at)), ENGINE_FILE);
  assert.equal(ENGINE_FILE, join(ROOT, 'engine.js'));
  assert.doesNotMatch(source, /await import\(|^const [A-Z_]+ = await /m);
  // At run time: runEngine refuses a hold-through setting on the unmodified engine by comparing the engine it is
  // handed with the one it imported. Handed the module at ENGINE_FILE, it refuses: that module is the one it runs.
  // A second instance of the same file (another URL) is another module, which it does not recognise, and runs.
  const prepared = prepareWindow(TREND, WINDOWS[8], SCALED), hold = byId['H-h60-l30-b10-s0'];
  const same = await import(pathToFileURL(ENGINE_FILE).href), another = await import(`${pathToFileURL(ENGINE_FILE).href}?another`);
  const tried = engine => {
    try { return runEngine(TREND, prepared, hold, COSTS.default, {engine}).valid ? 'ran' : 'did not run'; }
    catch (error) { return /^holdThrough is not supported by runEngine on the unmodified engine/.test(error.message) ? 'refused as the unmodified engine' : error.message; }
  };
  assert.deepEqual([prepared.valid, hold.holdThrough, tried(undefined), tried(same), tried(another)],
    [true, true, 'refused as the unmodified engine', 'refused as the unmodified engine', 'ran']);

  // No module a study worker loads has a top-level await, so terminating a worker while it loads cannot hit Node
  // 22's abort. require() refuses exactly such a module graph (ERR_REQUIRE_ASYNC_MODULE): the graphs of the study
  // worker and of research/engine-run.mjs load, and a module with a top-level await is refused (the check works).
  const dir = scratch();
  writeFileSync(join(dir, 'waits.mjs'), 'await Promise.resolve();\nexport const done = true;\n');
  const required = file => spawnSync(process.execPath, ['--experimental-require-module', '--no-warnings', '-e',
    `try { require(${JSON.stringify(file)}); console.log('loaded'); } catch (error) { console.log(error.code); }`], {encoding: 'utf8', cwd: ROOT});
  assert.deepEqual([join(ROOT, 'research', 'study-worker.mjs'), join(ROOT, 'research', 'engine-run.mjs'), join(dir, 'waits.mjs')].map(file => required(file).stdout.trim()),
    ['loaded', 'loaded', 'ERR_REQUIRE_ASYNC_MODULE']);
  // And the event itself, about 1 s: sixteen study workers terminated as soon as the first of them answers (the
  // others still loading), eight times over, in a process of its own. With the top-level await, a process doing
  // this twenty times died in 2 of 12 runs (Node v22.23.5, measured before this test was written), so this part
  // alone would rarely catch it again; the require() check above always does. Now the process must finish. A script file,
  // not --input-type: a worker inherits the process's options and cannot start a file under that one.
  writeFileSync(join(dir, 'terminate-while-loading.mjs'), `import {Worker} from 'node:worker_threads';
const url = new URL(${JSON.stringify(new URL('./study-worker.mjs', import.meta.url).href)});
let early = 0;
for (let round = 0; round < 8; round++) {
  const pool = Array.from({length: 16}, () => {
    const worker = new Worker(url, {workerData: {role: 'study-worker'}});
    worker.loaded = false;
    worker.once('message', () => { worker.loaded = true; });
    return worker;
  });
  await new Promise(resolve => { for (const worker of pool) worker.once('message', resolve); });
  early += pool.filter(worker => !worker.loaded).length;
  await Promise.all(pool.map(worker => worker.terminate()));
}
console.log('terminated while loading: ' + early);
`);
  const stress = spawnSync(process.execPath, [join(dir, 'terminate-while-loading.mjs')], {encoding: 'utf8', cwd: ROOT, timeout: 60000});
  assert.deepEqual([stress.status, stress.signal], [0, null], stress.stderr.slice(-2000));
  assert.match(stress.stdout, /^terminated while loading: [1-9]\d*\n$/, 'some workers were terminated before their loaded notice');
});

// What two runs of the same study may differ in: the timing and code lines of the record, and in the report the
// status block (commit, module states, start time), which ends where the nominees begin.
const stableRecord = path => readFileSync(path, 'utf8').split('\n').filter(line => !/^"(timing|code)": /.test(line)).join('\n');
const stableReport = text => text.slice(0, text.indexOf('# Exploration results')) + text.slice(text.indexOf('## Nominees and their labels'));

test('dry run: determinism, and the worker count does not change a result', () => {
  // Two runs with the same options write the same two files, apart from the timing and the code lines (git state
  // belongs to the working tree, which other work may touch between two runs; it is checked further down).
  assert.equal(stableRecord(A.path), stableRecord(B.path));
  assert.equal(stableReport(A.report), stableReport(B.report));
  assert.ok(stableReport(A.report).length > 0.8 * A.report.length, 'almost all of the report is compared');
  assert.deepEqual(JSON.parse(readFileSync(A.path, 'utf8')), A.results, 'what is returned is what is written');
  assert.equal(readFileSync(A.path).length, A.bytes);
  // The report on disk is the report returned, and it is a function of the record alone.
  assert.equal(readFileSync(A.reportPath, 'utf8'), A.report);
  assert.equal(renderResults(JSON.parse(readFileSync(A.path, 'utf8'))), A.report);
  // Zero workers (this thread), two and four: identical apart from timing, code and the recorded options.
  const core = ({results}) => ({...results, timing: null, code: null, deviations: results.deviations.filter(d => !['workers', 'out', 'report'].includes(d.option))});
  assert.deepEqual(core(C), core(A));
  assert.deepEqual(core(D), core(A));
  assert.deepEqual([A, C, D].map(run => run.results.deviations.find(d => d.option === 'workers')?.value), [2, 0, undefined]);
  assert.deepEqual([A, C, D].map(run => run.results.timing.workers), [2, 0, 4]);
  assert.deepEqual([C.path, C.reportPath, typeof C.report], [null, null, 'string'], 'with out: null nothing is written');
});

test('dry run: every step leaves its part of the record', () => {
  // Amendment 2 changed what a record holds (the buy-and-hold reading, the comparison account's row, Reading 9's
  // figures, the calibration block, what a replaced record said): format v3, where Amendment 1's record was v2.
  assert.equal(R.format, 'paper-trail-exploration-v3');
  assert.match(R.status, /^Exploration, not evidence\./);
  // The status follows the amended protocol: a confirmed nominee whose reading is "no" justifies nothing further.
  assert.ok(R.status.includes('A confirmed nominee whose buy-and-hold reading is "no" justifies nothing further; one whose reading is "yes" ' +
    'would justify writing a held-out contract for that one setting and nothing more.') && R.status.includes('independent of one another'));
  // The measurement behind the protocol's two tables, held against the statistics that ran.
  const calibrationFile = readFileSync(join(ROOT, 'research', 'calibration.json'));
  assert.deepEqual(R.calibration, {file: 'research/calibration.json', sha256: sha256Hex(calibrationFile), statsSha256: JSON.parse(calibrationFile).statsSha256,
    statsSha256ThatRan: R.code.modules.find(m => m.file === 'research/stats.mjs').sha256,
    measuredWithTheStatsThatRan: JSON.parse(calibrationFile).statsSha256 === sha256Hex(readFileSync(join(ROOT, 'research', 'stats.mjs')))});
  assert.ok(A.bytes < 2e6);
  // Every non-default option is a recorded deviation with its reason; a path outside the working directory is
  // not written down. The banner says first that this is a dry run.
  assert.deepEqual(R.deviations.map(d => d.option), ['market', 'out', 'report', 'workers', 'resamples', 'protocol', 'settings']);
  assert.ok(R.deviations.every(d => typeof d.reason === 'string' && d.reason.length > 20 && 'default' in d));
  assert.deepEqual({...R.deviations.find(d => d.option === 'out'), reason: null},
    {option: 'out', value: '(an absolute path, or one outside the working directory; not recorded)', default: 'research/results', reason: null});
  assert.deepEqual(R.deviations.find(d => d.option === 'settings').value.perFamily, {P: 240, H: 240, R: 240, X: 120, L: 80});
  assert.deepEqual(R.deviations.find(d => d.option === 'protocol').value, {...SCALED, from: '2021-01-01T00:00:00.000Z'});
  assert.match(R.banner[0], /^DRY RUN: this run did NOT use the complete exchange store\./);
  assert.match(R.banner[1], /^CHANGED FROM THE PROTOCOL: the windows or minimums, the settings searched, the number of resamples/);
  assert.match(R.data.source, /NOT the candle store/);
  assert.deepEqual([R.data.manifestSha256, R.data.completeExchangeStore, R.data.completeness, R.data.receipts, R.previousRun], [null, false, null, null, null]);
  assert.deepEqual(R.protocol.resampling, {resamples: 300, seed: 20261118});
  assert.deepEqual(R.protocol.windows, {...SCALED, from: '2021-01-01T00:00:00.000Z'});
  assert.ok(R.timing.wallSeconds > 0 && Object.keys(R.timing.steps).length === 8);

  // Step 1: coverage of all 20 windows; windows 3 and 14 are below the floor for every setting.
  assert.equal(R.windows.length, 20);
  for (const w of R.windows) {
    assert.equal(w.expected, 2880);
    assert.deepEqual([w.missing.BTC, w.missing.LINK, w.missingShared], [2880 - w.observed.BTC, 2880 - w.observed.LINK, 2880 - w.shared]);
    assert.ok(w.shared <= Math.min(w.observed.BTC, w.observed.LINK) && w.sharedFraction === w.shared / 2880);
    assert.equal(w.valid, w.sharedFraction >= 0.9);
  }
  assert.equal(R.windows[0].scoreStart, '2021-01-01T00:01:00.000Z', 'window 0 starts at the first close that can exist');
  assert.deepEqual(R.invalidWindows.map(w => [w.index, w.set, w.reason]),
    [[3, 'design', 'insufficient shared coverage'], [14, 'confirmation', 'insufficient shared coverage']]);

  // Step 2: 920 settings on the nine valid design windows, less the 840 lookback settings refused on window 0.
  assert.deepEqual([R.designGrid.settings, R.designGrid.designWindows, R.designGrid.validDesignWindows, R.designGrid.simulations],
    [920, 10, 9, 9 * 920 - 840]);
  assert.deepEqual(Object.keys(R.families), FAMILIES);
  assert.deepEqual(FAMILIES.map(f => R.families[f].refusedForWarmup), [{0: 240}, {0: 240}, {0: 240}, {0: 120}, {}]);

  // Step 3: per family and pooled, against scoreRows() on the grid computed again outside runStudy.
  const rows = scoreRows(SEARCHED, GRID.returns, GRID.fills, SCALED);
  let eligible = 0, positive = 0, best = -Infinity;
  for (const family of FAMILIES) {
    const f = R.families[family], members = SEARCHED.filter(s => s.family === family), own = rows.filter(row => row.family === family);
    assert.deepEqual(f.scores.ids, members.map(s => s.id));
    assert.deepEqual([f.scores.T, f.scores.mean, f.scores.n, f.scores.windowsWithFills], plain(['T', 'mean', 'n', 'traded'].map(key => own.map(row => row[key]))));
    // "At least 8 valid design windows" here, and a fill in at least half of them.
    const isEligible = f.scores.ids.map((_, i) => f.scores.n[i] >= 8 && 2 * f.scores.windowsWithFills[i] >= f.scores.n[i]);
    assert.deepEqual(isEligible, own.map(row => row.eligible));
    assert.deepEqual([f.settings, f.eligible, f.positiveMean, f.eligiblePositiveMean], [members.length, isEligible.filter(Boolean).length,
      f.scores.mean.filter(m => m > 0).length, f.scores.mean.filter((m, i) => m > 0 && isEligible[i]).length]);
    assert.ok(f.scores.n.every(n => n === (family === 'L' ? 9 : 8)), 'lookback families lose window 0 to the warmup rule');
    // The best T, ties to the earlier setting in grid order, with the skewness, autocorrelation and valid windows
    // the protocol asks for beside it.
    const top = own.filter(row => row.eligible).reduce((high, row) => (high === null || row.T > high.T ? row : high), null);
    assert.deepEqual(f.best, plain({id: top.id, T: top.T, t: top.t, lag1: top.lag1, factor: top.factor, skewness: top.skewness, n: top.n, mean: top.mean, sd: top.sd}));
    assert.equal(f.best.T, Math.max(...f.scores.T.filter((_, i) => isEligible[i])));
    // The search-adjusted p-value: research/stats.mjs on every design window as a column and the eligible settings.
    const at = SEARCHED.flatMap((s, i) => (s.family === family && rows[i].eligible ? [i] : []));
    assert.deepEqual(f.searchAdjusted, {p: searchAdjustedP({returns: GRID.returns, eligible: at, resamples: 300}).p, resamples: 300, seed: 20261118, windowsResampled: 10});
    // The 20 highest-scoring eligible settings, in descending T.
    assert.equal(f.top.length, Math.min(20, f.eligible));
    assert.deepEqual([f.top[0].id, f.top[0].T], [f.best.id, f.best.T]);
    f.top.forEach((row, i) => {
      assert.ok(i === 0 || row.T <= f.top[i - 1].T);
      assert.ok(row.n >= 8 && 2 * row.windowsWithFills >= row.n && Number.isFinite(row.mean + row.sd + row.sharePositive + row.meanFills + row.lag1 + row.skewness));
      assert.equal(row.T, f.scores.T[f.scores.ids.indexOf(row.id)]);
    });
    eligible += f.eligible; positive += f.positiveMean; best = Math.max(best, f.best.T);
  }
  assert.deepEqual([R.pooled.settings, R.pooled.eligible, R.pooled.positiveMean, R.pooled.best.T], [920, eligible, positive, best]);
  assert.equal(R.pooled.searchAdjusted.p, searchAdjustedP({returns: GRID.returns, eligible: rows.flatMap((row, i) => (row.eligible ? [i] : [])), resamples: 300}).p);
  assert.ok(R.pooled.searchAdjusted.p >= Math.min(...FAMILIES.map(f => R.families[f].searchAdjusted.p)), 'the best of all families is not rarer than the best of one');
  // One family's best setting again, by a path that shares nothing with the grid: simulate() window by window,
  // aligned to the ten design windows with NaN where the window is invalid for the setting.
  const runs = DESIGN.map(w => prepareWindow(TREND, w, SCALED)).map(p => (p.valid ? simulate(TREND, p, byId[R.families.P.best.id], COSTS.default) : {valid: false}));
  const again = runs.map(r => (r.valid ? r.returnPct : NaN)), first = R.families.P.top[0], ran = runs.filter(r => r.valid);
  assert.deepEqual(again.map(Number.isNaN), [true, false, false, true, false, false, false, false, false, false], 'window 0 has no warmup, window 3 no coverage');
  assert.deepEqual([ran.length, mean(again), sampleSd(again), tStat(again), lag1Autocorrelation(again), score(again), skewness(again)],
    [first.n, first.mean, first.sd, first.t, first.lag1, first.T, first.skewness]);
  assert.deepEqual([mean(ran.map(r => r.fills)), ran.filter(r => r.fills > 0).length, ran.filter(r => r.returnPct > 0).length / ran.length],
    [first.meanFills, first.windowsWithFills, first.sharePositive]);

  // Step 4: the recorded nomination of each family is what the rule gives on the grid computed again, by
  // nominateFamily and by the rule written a second time.
  let folded = 0;
  for (const family of FAMILIES) {
    const f = R.families[family], members = SEARCHED.filter(s => s.family === family);
    const scores = new Map(SEARCHED.map((s, i) => [s.id, {eligible: rows[i].eligible, T: rows[i].T, mean: rows[i].mean, returns: GRID.returns[i]}]));
    const derived = nominateFamily(members, scores);
    assert.equal(f.nomination.nominee, derived.nominee?.id ?? null);
    assert.equal(f.nomination.nominee, plainNomination(members, scores));
    assert.deepEqual([f.nomination.considered, f.nomination.tenConsidered], plain([derived.considered, derived.tenConsidered]));
    // The ten considered are distinct and in descending T; identical settings are folded into the first of them.
    const ten = f.nomination.tenConsidered, vectors = ten.ids.map(id => JSON.stringify([...GRID.returns[searchedAt[id]]]));
    assert.deepEqual([ten.ids.length, new Set(vectors).size, ten.distinctReturnVectors], [10, 10, 10]);
    assert.ok(f.nomination.considered.length <= 10 && ten.distinctAmongPlainTopTen <= 10 && ten.eligibleSettingsStoodFor >= 10);
    for (const c of f.nomination.considered) for (const id of c.identical)
      assert.deepEqual([...GRID.returns[searchedAt[id]]], [...GRID.returns[searchedAt[c.id]]]);
    folded += ten.eligibleSettingsStoodFor - 10;
  }
  // On this market family H's ten highest-scoring eligible settings are five rules, each at two stops that never
  // bind (the first version's ten); counted once, its ten considered are ten rules standing for twenty settings.
  assert.deepEqual(R.families.H.nomination.tenConsidered.distinctAmongPlainTopTen, 5);
  assert.deepEqual([R.families.H.nomination.tenConsidered.eligibleSettingsStoodFor, folded > 0], [20, true]);
  // Trend following is nominated in P, H, X and L; the reversed rule has no positive mean among its ten and
  // nominates nothing.
  assert.deepEqual(R.nominees.map(n => n.family), ['P', 'H', 'X', 'L']);
  assert.equal(R.families.R.nomination.nominee, null);
  assert.equal(R.families.R.nomination.considered.length, 10);
  assert.ok(R.families.R.nomination.considered.every(c => !c.qualifies));

  // Step 5: confirmation, nominees only, on the nine valid confirmation windows of ten.
  for (const nominee of R.nominees) {
    const c = nominee.confirmation, at = new Map(c.perWindow.map(w => [w.index, w]));
    const aligned = key => CONFIRMATION.map(w => at.get(w.index)?.[key] ?? NaN), r = aligned('r'), valid = c.perWindow.map(w => w.r);
    assert.deepEqual(nominee.setting, plain(byId[nominee.id]));
    assert.deepEqual(c.perWindow.map(w => w.index), [10, 11, 12, 13, 15, 16, 17, 18, 19]);
    assert.deepEqual([c.k, c.threshold, c.n, c.minValidWindows], [4, 0.05 / 4, 9, 8]);
    // The label and its p-value: confirmationP on the returns aligned to the ten confirmation windows.
    const labelled = confirmationLabel({r, rFee10: aligned('rFee10'), k: 4, minValidWindows: 8, resamples: 300});
    assert.deepEqual({label: c.label, conditions: c.conditions, threshold: c.threshold, meanFee10: c.meanFee10},
      {label: labelled.label, conditions: labelled.conditions, threshold: labelled.threshold, meanFee10: labelled.meanFee10});
    assert.ok(LABELS.includes(c.label));
    for (const [level, key] of [[c, 'r'], [c.fee10, 'rFee10'], [c.fee40, 'rFee40']]) {
      const series = aligned(key), {score: T, ...rest} = confirmationP(series, {resamples: 300}), ranValues = c.perWindow.map(w => w[key]);
      assert.deepEqual({...level, sharePositive: null, worst: null}, plain({...(level === c ? c : {}), ...rest, T, sharePositive: null, worst: null}));
      assert.deepEqual([level.mean, level.sd, level.t, level.lag1, level.skewness, level.T], plain([mean(series), sampleSd(series), tStat(series),
        lag1Autocorrelation(series), skewness(series), score(series)]));
      assert.equal(level.p, Math.max(level.pT, level.pResample));
      assert.equal(level.sharePositive, ranValues.filter(v => v > 0).length / 9);
      assert.deepEqual(level.worst, {index: c.perWindow[ranValues.indexOf(Math.min(...ranValues))].index, r: Math.min(...ranValues)});
    }
    assert.deepEqual([c.meanFills, c.meanFees], [mean(c.perWindow.map(w => w.fills)), mean(c.perWindow.map(w => w.fees))]);
    // r regressed on b (not the other way round), and the comparison account's own mean.
    assert.deepEqual(c.regression, plain(ols(valid, c.perWindow.map(w => w.b))));
    assert.ok(c.regression.n === 9 && Number.isFinite(c.regression.intercept + c.regression.slope));
    assert.equal(c.meanComparison, mean(c.perWindow.map(w => w.b)));
    // The buy-and-hold reading beside the label, at default costs, and at feeBps 10 and 40 (reported, not used):
    // research/stats.mjs on r and b aligned to the confirmation windows, with the nominees' k, at each level's costs.
    const read = (rKey, bKey) => moreThanAShareOfBuyAndHold({r: aligned(rKey), b: aligned(bKey), k: 4, minValidWindows: 8, resamples: 300});
    assert.deepEqual(c.buyAndHold, plain({...read('r', 'b'), fee10: read('rFee10', 'bFee10'), fee40: read('rFee40', 'bFee40')}));
    assert.deepEqual([c.moreThanAShareOfBuyAndHold, c.labelWithReading], [c.buyAndHold.reading, labelWithReading(c)]);
    assert.deepEqual([c.buyAndHold.n, c.buyAndHold.slope, c.buyAndHold.intercept], [c.regression.n, c.regression.slope, c.regression.intercept]);
    // In the record the reading stands beside the label: the two fields, then the two as printed.
    const keys = Object.keys(c), at_ = keys.indexOf('label');
    assert.deepEqual(keys.slice(at_, at_ + 3), ['label', 'moreThanAShareOfBuyAndHold', 'labelWithReading']);
    // Reading 9, at default costs: the shape of the returns. Window 14, below the floor, keeps its place in the
    // first half (10 to 14), which therefore has four valid windows.
    assert.deepEqual({autocorrelation: c.autocorrelation, halves: c.halves, lowestThird: c.lowestThird}, plain(descriptiveFigures(CONFIRMATION, r, aligned('b'))));
    assert.deepEqual([c.halves.map(h => [h.windows, h.n]), c.lowestThird.n], [[[[10, 14], 4], [[15, 19], 5]], 3]);
    // The comparison account beside this nominee is the comparison account's own row, window by window.
    for (const w of c.perWindow)
      assert.deepEqual(R.comparisonAccount.perWindow.find(row => row.index === w.index), {index: w.index, b: w.b, bFee10: w.bFee10, bFee40: w.bFee40});
    for (const asset of ASSETS) {
      const d = c.direction[asset];
      assert.deepEqual([d.hits, d.misses, d.flat], [0, 1, 2].map(at => c.perWindow.reduce((sum, w) => sum + w.direction[asset][at], 0)));
      assert.ok(d.hits + d.misses > 0 && d.signTestP === signTestPValue(d.hits, d.misses) && d.hitRate === d.hits / (d.hits + d.misses));
    }
    // The design side of the nominee: its rank among the ten, its neighbours, its windows, its statistics.
    const g = nominee.design, own = rows[searchedAt[nominee.id]];
    assert.equal(g.perWindow.length, 10);
    assert.deepEqual(g.perWindow.filter(w => w.r === null).map(w => w.index), nominee.family === 'L' ? [3] : [0, 3]);
    assert.ok(g.mean > 0 && g.neighbourMedianT > 0 && g.rank >= 1 && g.rank <= 10);
    assert.deepEqual([g.n, g.mean, g.sd, g.t, g.lag1, g.factor, g.T, g.skewness], plain([own.n, own.mean, own.sd, own.t, own.lag1, own.factor, own.T, own.skewness]));
    assert.deepEqual(g.searchAdjustedP.family, R.families[nominee.family].searchAdjusted.p);
    assert.deepEqual(g.searchAdjustedP.pooled, R.pooled.searchAdjusted.p);
    // A confirmation window run again here with the plain simulator gives the recorded return.
    const p = prepareWindow(TREND, WINDOWS[16], SCALED), w = c.perWindow.find(row => row.index === 16);
    const once = simulate(TREND, p, byId[nominee.id], COSTS.default);
    assert.deepEqual([once.returnPct, once.buyHoldReturnPct, once.fills, once.fees, once.stops], [w.r, w.b, w.fills, w.fees, w.stops]);
    for (const asset of ASSETS)
      assert.deepEqual(w.direction[asset], [once.perAsset[asset].directionHits, once.perAsset[asset].directionMisses, once.perAsset[asset].directionFlat]);
    assert.equal(simulate(TREND, p, byId[nominee.id], COSTS.fee10).returnPct, w.rFee10);
    assert.equal(simulate(TREND, p, byId[nominee.id], COSTS.fee40).returnPct, w.rFee40);
  }
  const labels = Object.fromEntries(R.nominees.map(n => [n.family, n.confirmation.labelWithReading]));
  assert.deepEqual(labels, {P: 'CONFIRMED AND COST-ROBUST; more than a share of buy-and-hold: yes', H: 'CONFIRMED AND COST-ROBUST; more than a share of buy-and-hold: yes',
    X: 'NOT CONFIRMED; more than a share of buy-and-hold: no', L: 'CONFIRMED AND COST-ROBUST; more than a share of buy-and-hold: yes'});
  // With this scaled-down protocol's minimum raised above the nine valid windows nothing is confirmed, whatever
  // the p-values: "at least 20 valid confirmation windows" at this scale. The reading needs as many: it is no.
  const strict = confirmNominees({market: TREND, windows: CONFIRMATION, prepared: CONFIRMATION.map(w => prepareWindow(TREND, w, SCALED)),
    nominees: R.nominees.map(n => byId[n.id]), protocol: {...SCALED, minValidConfirmationWindows: 10}, resamples: 300});
  assert.deepEqual(strict.map(c => [c.label, c.conditions.enoughWindows, c.n, c.p, c.moreThanAShareOfBuyAndHold, c.buyAndHold.conditions.enoughWindows, c.buyAndHold.p]),
    R.nominees.map(n => ['not confirmed', false, 9, n.confirmation.p, 'no', false, n.confirmation.buyAndHold.p]));

  // Step 6: every nominee through an engine, and which one (PROTOCOL.md, Simulation).
  const exact = Object.fromEntries(R.nominees.map(n => [n.family, n.exactCheck]));
  assert.deepEqual({...exact.P, maxRelativeDifference: 0}, {id: exact.P.id, reference: 'unmodified engine', fedHistory: false, tolerance: 1e-9,
    windowsCompared: 17, windowsRefusedByBoth: 1, maxRelativeDifference: 0, fillsEqual: true});
  assert.deepEqual(FAMILIES.filter(f => exact[f]).map(f => [f, exact[f].reference, exact[f].fedHistory, exact[f].windowsCompared, exact[f].windowsRefusedByBoth]), [
    ['P', 'unmodified engine', false, 17, 1],
    ['H', 'engine with its scheduled-decision branch replaced (hold-through oracle)', false, 17, 1],
    ['X', 'unmodified engine fed the history the rule reads', true, 17, 1],
    // Long lookback with hold-through: the oracle engine, handed the two-row history the long-lookback rule reads.
    ['L', 'engine with its scheduled-decision branch replaced (hold-through oracle)', true, 18, 0]]);
  assert.ok(Object.values(exact).every(check => check.maxRelativeDifference <= 1e-9 && check.fillsEqual));
  assert.deepEqual([byId[exact.H.id].holdThrough, byId[exact.L.id].holdThrough], [true, true]);

  // Step 7: the default setting on all 20 windows, and the cost hurdle.
  const d = R.defaultSetting, did = d.perWindow.filter(w => w.invalid === undefined);
  assert.equal(d.id, 'P-h7-l7-b10-s0');
  assert.deepEqual(d.perWindow.filter(w => w.invalid !== undefined).map(w => [w.index, w.invalid]),
    [[0, 'insufficient warmup'], [3, 'insufficient shared coverage'], [14, 'insufficient shared coverage']]);
  assert.deepEqual([d.n, d.mean, d.sharePositive], [17, mean(did.map(w => w.r)), did.filter(w => w.r > 0).length / 17]);
  assert.equal(d.T, score(d.perWindow.map(w => w.r ?? NaN)));
  assert.deepEqual([d.design.n, d.confirmation.n], [8, 9]);
  for (const index of [1, 16]) {   // one design and one confirmation window, run again here at default costs
    const once = simulate(TREND, prepareWindow(TREND, WINDOWS[index], SCALED), DEFAULT_SETTING, COSTS.default);
    assert.deepEqual(d.perWindow[index], {index, set: WINDOWS[index].set, r: once.returnPct, b: once.buyHoldReturnPct, fills: once.fills});
  }
  assert.ok(did.every(w => Number.isFinite(w.r) && Number.isFinite(w.b)) && did.some(w => w.fills > 0));
  assert.deepEqual(R.costHurdle.roundTripBps, {default: 14, fee10: 30, fee40: 90});
  assert.deepEqual(R.costHurdle.horizons.map(h => h.horizonMinutes), [1, 5, 7, 15, 60, 420, 1440]);
  assert.equal(R.costHurdle.windows, 18);
  for (const h of R.costHurdle.horizons) for (const asset of ASSETS)
    assert.ok(h[asset].minutes > 20000 && h[asset].medianAbsLogMoveBps > 0 && h[asset].shareOfDefaultRoundTrip === h[asset].medianAbsLogMoveBps / 14);

  // The plain summary: its first line says what the run was not, it names every nominee with its label, the
  // buy-and-hold reading beside it and the reference it was checked against, gives the comparison account's own
  // row, and makes no claim.
  const text = summaryText(R, A);
  assert.deepEqual(text.split('\n').slice(0, 3), [...R.banner, 'Exploration study: simulated cash only. Exploration, not evidence.']);
  assert.ok(text.includes(`wrote ${A.path}`) && text.includes(`and ${A.reportPath}`));
  for (const nominee of R.nominees)
    assert.ok(text.includes(`${nominee.id}:`) && text.includes(`: ${labelWithReading(nominee.confirmation)}; engine check: `) && text.includes(nominee.exactCheck.reference));
  // Beside each label stand the reading's fit and the reading's own p-value, the larger of the fit's and the adjusted
  // series' (study3 finding 1: the summary once called it the fit's p). A record whose fit p differs shows the reading's.
  const signed = value => `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
  for (const {confirmation: c} of R.nominees)
    assert.ok(text.includes(`buy-and-hold fit intercept ${signed(c.buyAndHold.intercept)}, slope ${c.buyAndHold.slope.toFixed(3)}, ` +
      `reading p ${pValue(c.buyAndHold.p)}: ${labelWithReading(c)}`), c.buyAndHold.p);
  const apart = structuredClone(R), moved = apart.nominees[0].confirmation.buyAndHold;
  moved.pFit = moved.p > 0.5 ? moved.p - 0.4 : moved.p + 0.4;
  assert.ok(summaryText(apart).includes(`reading p ${pValue(moved.p)}: `) && !summaryText(apart).includes(`reading p ${pValue(moved.pFit)}: `));
  assert.ok(text.includes('windows agree with the engine with its scheduled-decision branch replaced (hold-through oracle), fed the history the rule reads'));
  assert.ok(text.includes(`Comparison account (half BTC, half LINK, held) on 9 confirmation windows above the coverage floor: mean ` +
    `+${R.comparisonAccount.mean.toFixed(3)}%, confirmation p ${pValue(R.comparisonAccount.p)} against 0.0125: simply holding did not pass the test a nominee is confirmed by\n`));
  // The label never stands alone: in the summary, in RESULTS.md and in the record, each one has its reading beside it.
  assert.deepEqual([labelsAlone(text), labelsAlone(A.report), labelsAlone(readFileSync(A.path, 'utf8'))], [[], [], []]);
  assert.equal([...A.report.matchAll(PRINTED_LABEL)].length, 2 * R.nominees.length, 'twice in the report: with the nominees, and in each one\'s section');
  // The summary says nothing about the protocol's tables while they were measured with the statistics that ran.
  assert.equal(text.includes('measured with another version'), !R.calibration.measuredWithTheStatsThatRan);
  // Neither the summary, the record nor the report uses a reserved word, nor anything that looks like an address.
  // The report quotes the protocol's own negation word for word and is held to the rule everywhere else.
  for (const written of [text, readFileSync(A.path, 'utf8'), unquoted(A.report)]) {
    assert.doesNotMatch(written, RESERVED);
    assert.doesNotMatch(written, /@/);
  }
});

test('RISING-MARKET CONTROL: on markets that only rise, confirmed nominees read "no" beside their label, and simply holding passes', async () => {
  // Amendment 2: "A long-only rule gains whenever the two assets rise, so a mean above zero can be nothing more than
  // time spent invested." On these synthetic markets nothing can be timed and both assets rise about 12% a window:
  // the search nominates, the confirmation test confirms what is only time invested, and the reading beside each
  // label says so. A fixed seed; another could confirm fewer nominees without a defect (seed 3 confirms two, both "no").
  for (const seed of [6]) {
    const run = await runStudy({market: risingMarket(seed), protocol: SCALED, settings: SEARCHED, resamples: 300, workers: 2, out: null});
    const {results, report} = run, text = summaryText(results), json = JSON.stringify(results);
    const confirmed = results.nominees.filter(n => n.confirmation.label !== 'not confirmed');
    assert.ok(confirmed.length >= 2, `seed ${seed}: ${results.nominees.map(n => n.confirmation.labelWithReading).join(', ')}`);
    for (const {id, confirmation: c} of confirmed) {
      assert.equal(c.moreThanAShareOfBuyAndHold, 'no', `seed ${seed}: ${id}`);
      // RESULTS.md explains the "no" in the protocol's words, with the fit: intercept, slope, both standard errors,
      // both p-values and the bar.
      const section = report.slice(report.indexOf(`### ${id}\n`), report.indexOf('\n### ', report.indexOf(`### ${id}\n`) + 1) >>> 0);
      const h = c.buyAndHold;
      for (const words of [`Label: **${labelWithReading(c)}**.`, `fitted by least squares over ${h.n} valid windows: intercept ${h.intercept < 0 ? '' : '+'}${h.intercept.toFixed(3)}% ` +
        `(standard error ${h.seIntercept.toFixed(3)}; one-sided p-value for intercept > 0, Student's t with n − 2 degrees of freedom: ${pValue(h.pFit)}), ` +
        `slope ${h.slope.toFixed(3)} (standard error ${h.seSlope.toFixed(3)}); the confirmation p-value of the series r − slope × b: ${pValue(h.adjusted.p)}; ` +
        `the reading's p-value, the larger of the two: ${pValue(h.p)}, against 0.05 / ${c.k} = ${(0.05 / c.k).toFixed(4)}.`,
        'Reading: **no**.', 'In the protocol\'s words, "*No* means the nominee\'s return on these windows cannot be told apart from holding the fraction ' +
        `\`slope\` of the comparison account." Here the slope is ${h.slope.toFixed(3)}.`])
        assert.ok(section.includes(words), `seed ${seed}, ${id}: ${words}`);
      assert.ok(report.includes(`- **${id}** (`) && report.includes(`): **${labelWithReading(c)}**. Measured: `));
      assert.ok(text.includes(`: ${labelWithReading(c)}; engine check: `));
      assert.ok(json.includes(`"label":"${c.label}","moreThanAShareOfBuyAndHold":"no","labelWithReading":"${labelWithReading(c)}"`));
    }
    // Simply holding passed the same test, on the same windows, with the nominees' bar.
    const held = results.comparisonAccount;
    assert.deepEqual([held.k, held.passed], [results.nominees.length, true]);
    assert.ok(report.includes(`Measured: simply holding PASSED the test a nominee is confirmed by, on these windows and with the nominees' bar`));
    assert.ok(text.includes('simply holding PASSED the test a nominee is confirmed by'));
    assert.deepEqual([labelsAlone(text), labelsAlone(report), labelsAlone(json)], [[], [], []]);
    // Nothing in the report says that no setting was confirmed: some were.
    assert.ok(!report.includes('settings this run searched was confirmed') && !report.includes('settings it searched was confirmed'));
  }
});

test('the engine check: every family agrees with its engine, hold-through through the oracle, and a planted difference fails loudly', async () => {
  const picks = ['P-h60-l30-b10-s300', 'R-h60-l7-b0-s0', 'X-h15-l10-b0-s0', 'L-h60-span240-b0-s0-hold0', 'H-h60-l30-b10-s0',
    'L-h60-span240-b0-s0-hold1'].map(id => byId[id]);
  const windows = WINDOWS.slice(7, 12), expected = new Map();   // three design windows and two confirmation windows
  for (const setting of picks) for (const window of windows) {
    const prepared = prepareWindow(TREND, window, SCALED);
    if (!prepared.valid) continue;
    const r = simulate(TREND, prepared, setting, COSTS.default, {detail: window.set === 'confirmation'});
    expected.set(`${setting.id}|${window.index}`, {r: r.returnPct, fills: r.fills});
  }
  // "The record states which reference each nominee was checked against."
  assert.deepEqual(picks.map(referenceFor), [REFERENCES.engine, REFERENCES.history, REFERENCES.history, REFERENCES.history, REFERENCES.oracle, REFERENCES.oracle]);
  assert.deepEqual(picks.map(feedsHistory), [false, true, true, true, false, true]);
  assert.deepEqual(REFERENCES, {engine: 'unmodified engine', history: 'unmodified engine fed the history the rule reads',
    oracle: 'engine with its scheduled-decision branch replaced (hold-through oracle)'});
  const checks = await exactCheck({market: TREND, windows, nominees: picks, expected, protocol: SCALED, workers: 2});
  assert.deepEqual(checks.map(c => [c.id, c.reference, c.fedHistory, c.windowsCompared, c.windowsRefusedByBoth]),
    picks.map(s => [s.id, referenceFor(s), feedsHistory(s), 5, 0]));
  assert.ok(checks.every(c => c.maxRelativeDifference <= 1e-9 && c.fillsEqual && c.tolerance === 1e-9));
  assert.ok([...expected.values()].filter(v => v.fills > 0).length > 20, 'the compared runs traded');
  assert.deepEqual(await exactCheck({market: TREND, windows, nominees: picks, expected, protocol: SCALED, workers: 0}), checks);

  // The engine side of each comparison is the engine itself (research/engine-run.mjs), not a second fast run:
  // the same numbers as runEngine called here.
  const context = {market: TREND, protocol: SCALED}, window = WINDOWS[8], prepared = prepareWindow(TREND, window, SCALED);
  const engine = runEngine(TREND, prepared, picks[0], COSTS.default), fast = simulate(TREND, prepared, picks[0], COSTS.default);
  assert.deepEqual(await engineTask(context, {window, setting: picks[0], costs: COSTS.default}), {index: 8, windowValid: true,
    fast: {valid: true, finalValue: fast.finalValue, returnPct: fast.returnPct, fills: fast.fills},
    engine: {valid: true, finalValue: engine.finalValue, returnPct: engine.returnPct, fills: engine.fills}});
  assert.ok(engine.fills > 0);
  // Hold-through (F10 of the first review): the unmodified engine refuses it, so the rerun is on the oracle engine,
  // which holds positions the unmodified engine would sell and rebuy, hence fewer fills on the same window.
  const hold = await loadHoldThroughEngine();
  for (const setting of [picks[4], picks[5]]) {
    assert.throws(() => runEngine(TREND, prepared, setting, COSTS.default), /holdThrough is not supported by runEngine/);
    const oracle = runEngine(TREND, prepared, setting, COSTS.default, {engine: hold}), task = await engineTask(context, {window, setting, costs: COSTS.default});
    assert.deepEqual(task.engine, {valid: true, finalValue: oracle.finalValue, returnPct: oracle.returnPct, fills: oracle.fills});
    const sellsAndRebuys = runEngine(TREND, prepared, {...setting, holdThrough: false}, COSTS.default);
    assert.ok(oracle.fills > 0 && oracle.fills < sellsAndRebuys.fills, `${oracle.fills} fills held through, ${sellsAndRebuys.fills} without`);
  }
  assert.deepEqual(await engineTask(context, {window: WINDOWS[3], setting: picks[0], costs: COSTS.default}), {index: 3, windowValid: false});

  // A recorded value that is not what the simulators give stops the study, for a hold-through nominee as for any.
  for (const id of ['P-h60-l30-b10-s300', 'H-h60-l30-b10-s0']) {
    const key = `${id}|9`, tampered = new Map(expected).set(key, {...expected.get(key), r: expected.get(key).r + 1e-7});
    await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: tampered, protocol: SCALED, workers: 0}),
      new RegExp(`Exact check FAILED.*${id}, window 9: a fresh fast simulation differs`));
    const miscounted = new Map(expected).set(key, {...expected.get(key), fills: expected.get(key).fills + 1});
    await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: miscounted, protocol: SCALED, workers: 2}), /Exact check FAILED/);
    const missing = new Map(expected); missing.delete(key);
    await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: missing, protocol: SCALED, workers: 0}), /window validity differs/);
  }

  // The comparison itself, on hand-built runs: 1e-9 relative on finalValue, fills exactly, the same refusal.
  const ran = (finalValue, fills) => ({valid: true, finalValue, returnPct: 100 * (finalValue / 1000 - 1), fills});
  const recorded = {r: ran(1010, 4).returnPct, fills: 4}, refusal = {valid: false, invalidReason: 'insufficient warmup'};
  assert.deepEqual(compareExact({windowValid: true, fast: ran(1010, 4), engine: ran(1010, 4)}, recorded), {problems: [], compared: true, refused: false, difference: 0});
  assert.deepEqual(compareExact({windowValid: true, fast: ran(1010, 4), engine: ran(1010 * (1 + 5e-10), 4)}, recorded).problems, []);
  assert.match(compareExact({windowValid: true, fast: ran(1010, 4), engine: ran(1010 * (1 + 5e-9), 4)}, recorded).problems[0], /finalValue 1010 \(fast\) against/);
  assert.match(compareExact({windowValid: true, fast: ran(1010, 4), engine: ran(1010, 6)}, recorded).problems[0], /fills 4 \(fast\) against 6 \(engine\)/);
  assert.match(compareExact({windowValid: true, fast: ran(1010, 4), engine: refusal}, recorded).problems[0], /the engine refused \(insufficient warmup\), the fast simulator ran/);
  assert.deepEqual(compareExact({windowValid: true, fast: refusal, engine: refusal}, {r: NaN, fills: 0}), {problems: [], compared: false, refused: true, difference: 0});
  assert.match(compareExact({windowValid: true, fast: refusal, engine: refusal}, recorded).problems[0], /differs from the value the study recorded/);
  assert.deepEqual(compareExact({windowValid: false}, undefined).problems, []);
  assert.match(compareExact({windowValid: false}, recorded).problems[0], /window validity differs/);
});

test('the cost hurdle on a hand-built market', () => {
  const t = minute => FROM + minute * MINUTE, series = rows => ({time: Float64Array.from(rows, r => t(r[0])), close: Float64Array.from(rows, r => r[1])});
  // BTC lacks minute 3; LINK has a minute 6 after the window. Scored (shared) minutes of the window: 0, 1, 2, 4, 5.
  const market = {BTC: series([[0, 100], [1, 101], [2, 100], [4, 102], [5, 103]]),
    LINK: series([[0, 10], [1, 10.1], [2, 10.1], [3, 10.3], [4, 10.2], [5, 10.2], [6, 10.4]])};
  const prepared = prepareWindow(market, {start: t(0), end: t(5)}, {minSharedFraction: 0.5});
  assert.deepEqual([prepared.valid, prepared.shared], [true, 5]);
  const {horizons, roundTripBps, windows} = costHurdle({market, prepared: [prepared], horizonMinutes: [1, 2]});
  const move = (to, from) => Math.abs(Math.log(to / from)), bps = 10000;
  assert.deepEqual([roundTripBps, windows], [{default: 14, fee10: 30, fee40: 90}, 1]);
  // One minute. BTC: 0->1, 1->2 and 4->5 exist (2->3 and 5->6 do not): median of three. LINK: its minutes 3 and 6
  // exist although they are not scored minutes, so 0->1, 1->2, 2->3, 4->5 and 5->6 all count: median of five.
  const middle = [move(101, 100), move(100, 101), move(103, 102)].sort()[1];
  assert.deepEqual(horizons[0].BTC, {minutes: 3, medianAbsLogMoveBps: bps * middle, shareOfDefaultRoundTrip: bps * middle / 14});
  assert.deepEqual([horizons[0].LINK.minutes, horizons[0].LINK.medianAbsLogMoveBps], [5, bps * move(10.1, 10)]);
  // Two minutes. BTC: 0->2 (no move) and 2->4: the median of two is their mean. LINK: 0->2, 1->3, 2->4, 4->6.
  assert.deepEqual([horizons[1].BTC.minutes, horizons[1].BTC.medianAbsLogMoveBps], [2, bps * (0 + move(102, 100)) / 2]);
  assert.deepEqual([horizons[1].LINK.minutes, horizons[1].LINK.medianAbsLogMoveBps], [4, bps * (move(10.1, 10) + move(10.4, 10.2)) / 2]);
  // A window below the coverage floor contributes nothing.
  const none = costHurdle({market, prepared: [prepareWindow(market, {start: t(0), end: t(5)}, {minSharedFraction: 0.9})], horizonMinutes: [1]});
  assert.deepEqual([none.windows, none.horizons[0].BTC.minutes, Number.isNaN(none.horizons[0].BTC.medianAbsLogMoveBps)], [0, 0, true]);
});

test('the search-adjusted p-value is handed every design window as a column, the invalid one included, and eligible settings only', () => {
  const two = {...PROTOCOL, minValidDesignWindows: 2}, _ = NaN;
  // Window 2 is invalid for every setting (Reading 7): it enters no statistic, but it stays a design window.
  const grid = {settings: SEARCHED.slice(0, 2), returns: [[1, -2, _, 3, -1, 2, 0.5], [_, _, _, _, _, _, _]],
    fills: [[2, 2, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0]]};
  const scored = scoreDesign({...grid, protocol: two, resamples: 200});
  assert.deepEqual([scored.pooled.settings, scored.pooled.withValidWindows, scored.pooled.eligible, scored.pooled.best.id], [2, 1, 1, SEARCHED[0].id]);
  assert.deepEqual(scored.pooled.searchAdjusted, {p: scored.families.P.searchAdjusted.p, resamples: 200, seed: 20261118, windowsResampled: 7});
  assert.deepEqual([scored.pooled.best.T, scored.pooled.best.n], [score([1, -2, _, 3, -1, 2, 0.5]), 6]);
  assert.equal(scored.pooled.searchAdjusted.p, searchAdjustedP({returns: grid.returns, eligible: [0], resamples: 200}).p);
  assert.ok(scored.pooled.searchAdjusted.p > 0.05 && scored.pooled.searchAdjusted.p < 0.7, `p = ${scored.pooled.searchAdjusted.p}`);
  // The reading this is: seven columns are resampled and windows 1 and 3 are not adjacent. Taking the invalid
  // window out of the table is the other reading, and it is not the same number.
  const compact = searchAdjustedP({returns: grid.returns.map(row => row.filter((_, w) => w !== 2)), eligible: [0], resamples: 200});
  assert.ok(compact.p !== scored.pooled.searchAdjusted.p || compact.observedMax !== scored.pooled.best.T);

  // Only eligible settings are searched: a third setting with the highest T of all but fills in too few windows
  // changes neither the best T nor its p-value, and neither does a fourth with too few valid windows.
  const more = {settings: SEARCHED.slice(0, 4), returns: [...grid.returns, [5, 5.1, _, 5.2, 5, 5.1, 5.3], [_, _, _, _, _, 5, 5.1]],
    fills: [...grid.fills, [2, 0, 0, 0, 2, 0, 0], [0, 0, 0, 0, 0, 2, 2]]};
  const wider = scoreDesign({...more, protocol: {...PROTOCOL, minValidDesignWindows: 3}, resamples: 200});
  assert.deepEqual(wider.rows.map(row => [row.n, row.eligible, row.T > scored.pooled.best.T]), [[6, true, false], [0, false, false], [6, false, true], [2, false, true]]);
  assert.deepEqual([wider.pooled.eligible, wider.pooled.best.id, wider.pooled.best.T, wider.pooled.searchAdjusted.p],
    [1, SEARCHED[0].id, scored.pooled.best.T, scored.pooled.searchAdjusted.p]);
  assert.notEqual(wider.pooled.searchAdjusted.p, searchAdjustedP({returns: more.returns, eligible: [0, 2], resamples: 200}).p);
  // With nothing eligible there is nothing to search: no best setting and no p-value, not a p-value of 1.
  const none = scoreDesign({...grid, resamples: 200});   // the protocol's own minimum of 40 valid windows
  assert.deepEqual([none.pooled.eligible, none.pooled.best, none.pooled.searchAdjusted.p], [0, null, null]);
});

test('the best T is the one research/stats.mjs names: scores within 1e-12 of each other tie, and a tie goes to the earlier setting', () => {
  // A series and its reverse have the same score as written; computed, the reverse's is 4.4e-16 higher here. The
  // two are a tie (research/stats.mjs, conventions), so the earlier setting holds the best T, in the table as in the
  // search-adjusted p-value, and the study's own cross-check of the two does not stop the run.
  const x = [1.57, 3.78, 3.81, 1.29, 2.91, -1.97, 1.1, -0.03, 2.35, 1.3, 2.53, 3.86], reversed = x.toReversed();
  assert.ok(score(reversed) > score(x) && score(reversed) - score(x) < 1e-12 * score(x), `${score(x)} ${score(reversed)}`);
  const twelve = {...PROTOCOL, minValidDesignWindows: 12}, fills = [Array(12).fill(2), Array(12).fill(2)];
  const tied = scoreDesign({settings: SEARCHED.slice(0, 2), returns: [x, reversed], fills, protocol: twelve, resamples: 200});
  assert.deepEqual([tied.pooled.best.id, tied.pooled.best.T, tied.families.P.best.id], [SEARCHED[0].id, score(x), SEARCHED[0].id]);
  assert.equal(searchAdjustedP({returns: [x, reversed], eligible: [0, 1], resamples: 200}).argmax, 0);
  // Above the tolerance the later setting holds it.
  const higher = x.map(v => v + 0.01), apart = scoreDesign({settings: SEARCHED.slice(0, 2), returns: [x, higher], fills, protocol: twelve, resamples: 200});
  assert.deepEqual([apart.pooled.best.id, apart.pooled.best.T], [SEARCHED[1].id, score(higher)]);
  // Nomination ranks by T as computed: only exactly equal scores are ties there, so the reverse comes first.
  const scores = new Map([[SEARCHED[0].id, {eligible: true, T: score(x), mean: mean(x), returns: x}],
    [SEARCHED[1].id, {eligible: true, T: score(reversed), mean: mean(reversed), returns: reversed}]]);
  assert.deepEqual(nominateFamily(SEARCHED.slice(0, 2), scores).tenConsidered.ids, [SEARCHED[1].id, SEARCHED[0].id]);
});

test('RANDOM-WALK CONTROL: on driftless markets the pipeline labels no nominee confirmed', async () => {
  // No rule can predict a driftless random walk, and every trade costs about 14 bps a round trip. The search still
  // turns up settings whose design mean happens to be positive (that is what a search does); the one look at the
  // confirmation windows must not confirm any of them. Fixed seeds: by construction a false confirmation has at
  // most a 5% chance per study, so one appearing under another seed would not by itself be a defect.
  const outcomes = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const {results, report} = await runStudy({market: scaledMarket(seed, 0), protocol: SCALED, settings: SEARCHED, resamples: 200, workers: 0, out: null});
    assert.ok(results.pooled.eligible > 500, 'the searched settings do trade');
    for (const nominee of results.nominees) {
      assert.equal(nominee.confirmation.label, 'not confirmed', `seed ${seed}: ${nominee.id}`);
      assert.ok(Object.values(REFERENCES).includes(nominee.exactCheck.reference) && nominee.exactCheck.windowsCompared >= 17);
      outcomes.push(`seed ${seed} ${nominee.id}: design mean ${nominee.design.mean.toFixed(2)}%, confirmation mean ${nominee.confirmation.mean.toFixed(2)}%, p ${nominee.confirmation.p.toFixed(3)}`);
    }
    // The best of 920 no-skill settings is not rare: its search-adjusted p-value is nowhere near small.
    assert.ok(results.pooled.searchAdjusted.p > 0.2, `seed ${seed}: pooled search-adjusted p ${results.pooled.searchAdjusted.p}`);
    // "Not confirmed" is bounded as the protocol bounds it, as a measured fact of this run only because nothing was
    // confirmed, with the number of settings this run searched (finding 15 of the second round).
    assert.ok(report.includes('- Measured: none of the 920 settings this run searched was confirmed on these windows at these costs.\n'));
    assert.ok(report.includes('Measured: this run searched 920 settings on 10 design windows and ran ') &&
      report.includes('; none of the 920 settings it searched was confirmed on these windows at these costs.\n'));
    assert.ok(report.includes('It does not show that a smaller positive mean is absent.'));
    // The label is never printed without the buy-and-hold reading beside it.
    assert.deepEqual([labelsAlone(report), labelsAlone(summaryText(results))], [[], []]);
  }
  // The control is not vacuous: the search did nominate, and those nominees did not hold up.
  assert.ok(outcomes.length >= 5, outcomes.join('\n'));
});

test('the record carries the protocol\'s nine Readings word for word, further readings apart, and the report quotes its bounds and limits', () => {
  const protocol = readFileSync(join(ROOT, 'research', 'PROTOCOL.md'), 'utf8');
  const joined = block => block.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
  // "### Readings" up to "## Measures": nine numbered items since Amendment 2 (the first two versions had seven).
  const items = protocol.split('### Readings')[1].split('## Measures')[0].split(/\n(?=\d+\. )/).slice(1).map(item => joined(item.replace(/^\d+\. /, '')));
  assert.equal(items.length, 9);
  assert.deepEqual([...READINGS], items);
  assert.deepEqual(R.readings, {protocol: items, notInProtocol: [...FURTHER_READINGS]});
  assert.ok(FURTHER_READINGS.length > 0 && FURTHER_READINGS.every(text => !items.includes(text)));
  // What Readings 7 to 9 now state is no longer stated a second time among the further readings: none of their
  // distinctive phrases appears there.
  for (const phrase of ['keeps its place', 'adjacent', 'can be drawn', 'valid confirmation windows only', 'above the floor',
    'windows valid for the nominee', 'same k', 'places apart', 'not floored', 'windows 50 to 61', '62 to 73', 'floor(n / 3)',
    'ties to the earlier window'])
    assert.deepEqual([phrase, FURTHER_READINGS.filter(text => text.includes(phrase))], [phrase, []]);
  assert.ok(items.slice(6).every(item => ['keeps its place', 'above the floor', 'floor(n / 3)'].some(phrase => item.includes(phrase))), 'the phrases are the Readings\' own');

  // "What a result would and would not establish", as it now stands: both paragraphs, word for word (finding 15:
  // the report introduces them as the protocol's text instead of stating them about the run). The first version of
  // this test expected one phrase reworded; the report now quotes, and a quotation is not reworded.
  const bounds = protocol.split('## What a result would and would not establish')[1].split('## Amendments')[0].trim().split(/\n\n/).map(joined);
  assert.deepEqual([...OUTCOME_BOUNDS], bounds);
  assert.ok(bounds[0].includes('If nothing is confirmed, that finding is bounded the same way'), 'the amended, conditional sentence');
  // Its one reserved word stands inside the protocol's own negation.
  assert.deepEqual(OUTCOME_BOUNDS.join(' ').match(new RegExp(RESERVED.source, 'gi')), ['ed' + 'ge']);
  assert.ok(OUTCOME_BOUNDS[0].includes(`nothing more: not a trading ${'ed' + 'ge'}, not executable fills, not future profit.`));

  // The limits, as the amended section has them, pointing to its two tables instead of repeating their figures.
  assert.ok(protocol.includes(`\n## ${TESTS_SECTION}\n`), 'the section title as amended');
  const section = protocol.split(`## ${TESTS_SECTION}`)[1].split('## Always reported')[0];
  const listed = section.split('Limits that no test on these windows can remove:')[1].split('**How often a real mean is found.**')[0].trim()
    .split(/\n(?=- )/).map(item => joined(item.replace(/^- /, '')));
  assert.deepEqual(listed.map(text => text.split('**')[1]), ['Rare large losses.', 'Dependence between windows.', 'Low power.']);
  // The report lists exactly the protocol's three (study3 finding 0: it once added a fourth under the same heading).
  assert.deepEqual(TEST_LIMITS.map(text => text.split('**')[1]), ['Rare large losses.', 'Dependence between windows.', 'Low power.']);
  // The rising-market point stands apart: it is the first table's last row, read, and the protocol does not list it.
  assert.ok(section.includes('- **A rising market** (the last row).'), 'the first table\'s last row, read');
  assert.ok(!listed.some(text => text.includes('rising market')) && !RISING_MARKET.includes('**'));
  assert.doesNotMatch(RISING_MARKET, /%|\d\.\d|\d,\d{3}|times/);
  assert.equal(TEST_LIMITS[0], listed[0], 'the first limit holds no figure of a table and is the protocol\'s text');
  // The protocol's bold sentence, word for word.
  assert.ok(listed[1].includes(`So the limit is stated instead: **${INDEPENDENCE}**`) && TEST_LIMITS[1].includes(`So the limit is stated instead: **${INDEPENDENCE}**`));
  assert.ok(listed[2].endsWith('"Not confirmed" does not show that a smaller positive mean is absent.') && TEST_LIMITS[2].endsWith('"Not confirmed" does not show that a smaller positive mean is absent.'));
  // No figure of the two tables is repeated: no percentage, no decimal, no count of settings, and the tables are named.
  for (const text of TEST_LIMITS) assert.doesNotMatch(text, /%|\d\.\d|\d,\d{3}|times/);
  for (const name of ['How often each test passes when there is nothing to find', 'How often a real mean is found'])
    assert.ok(section.includes(`**${name}.**`) && TEST_LIMITS.some(text => text.includes(`("${name}")`)), name);
});

test('RESULTS.md: every required section in order, the dry-run banner first, and the wording rules', () => {
  const report = A.report, lines = report.split('\n');
  // The first line says the run did NOT use the complete exchange store; then every other banner line, then the title.
  assert.equal(lines[0], `> **${R.banner[0]}**`);
  assert.match(lines[0], /^> \*\*DRY RUN: this run did NOT use the complete exchange store\./);
  assert.deepEqual(lines.slice(0, R.banner.length + 2), [...R.banner.map(line => `> **${line}**`), '', '# Exploration results']);
  assert.match(report, /\*\*This is exploration, not evidence\.\*\*/);
  // The sections, each once, in the order the task fixes.
  assert.deepEqual(lines.filter(line => line.startsWith('## ')).map(line => line.slice(3)), [...SECTIONS]);
  assert.deepEqual([...SECTIONS], ['Status: what was run', 'Nominees and their labels', 'The default setting on all windows', 'Per family',
    'Each nominee: design and confirmation numbers', 'Engine check', 'Cost hurdle', 'Coverage, invalid windows and receipts', 'Readings',
    'Deviations', 'What this result would and would not establish']);
  const section = name => report.slice(report.indexOf(`## ${name}\n`), report.indexOf('\n## ', report.indexOf(`## ${name}\n`) + 1) >>> 0);

  // Status: commit and module identity, the data's manifest hash (none here), the run time.
  const status = section('Status: what was run');
  assert.ok(status.includes(`- Protocol. Measured: \`research/PROTOCOL.md\`, SHA-256 \`${R.protocol.sha256}\``) && status.includes(`commit \`${R.code.commit ?? 'unknown'}\``));
  for (const module of R.code.modules) assert.ok(status.includes(`| \`${module.file}\` | \`${module.sha256}\` | ${module.state} |`), module.file);
  assert.ok(status.includes('`engine.js` equals the engine at commit `6f6b693`: yes'));
  assert.ok(status.includes('manifest SHA-256 none (no store was read)') && status.includes(`started ${R.timing.startedAt}`));
  assert.ok(status.includes('complete exchange store: no;') && status.includes('7, each with its reason under "Deviations"'));
  // The calibration behind the protocol's tables, and the sentence that is there only when it was measured with
  // another research/stats.mjs (the line is checked both ways below).
  assert.ok(status.includes(`- Calibration. Measured: \`research/calibration.json\`, SHA-256 \`${R.calibration.sha256}\`, says the protocol's two tables were ` +
    `measured with \`research/stats.mjs\` SHA-256 \`${R.calibration.statsSha256}\`; the \`research/stats.mjs\` that ran has SHA-256 ` +
    `\`${R.calibration.statsSha256ThatRan}\`; the same: ${R.calibration.measuredWithTheStatsThatRan ? 'yes' : 'no'}.`));
  // Only the output paths are looked at for an earlier record, and the report says so (finding 16).
  assert.ok(status.includes('- Earlier record. Measured: none was replaced. Only the two output paths are checked for an earlier record ' +
    '(`exploration.json` in the output directory, and the report): a record written to any other path is not seen.'));
  // The nominees with their labels, each with the buy-and-hold reading beside it, in plain words.
  const nominees = section('Nominees and their labels');
  for (const {id, confirmation: c} of R.nominees) assert.ok(nominees.includes(`- **${id}** (`) && nominees.includes(`**${labelWithReading(c)}**`));
  assert.ok(nominees.includes('rerun with feeBps 10 its mean return stayed above 0'));
  assert.ok(nominees.includes('on these windows at these costs this setting was not confirmed, because its mean return is not above 0, and its confirmation p-value is not below 0.0125'));
  assert.ok(nominees.includes('and its return is more than a share of buy-and-hold: on 9 valid windows the fit\'s intercept is above 0 and the reading\'s p-value '));
  assert.ok(nominees.includes('and its buy-and-hold reading is no, because the fit\'s intercept is not above 0, and the reading\'s p-value '));
  assert.ok(nominees.includes('It does not show that a smaller positive mean is absent.'));
  assert.equal(nominees.includes('settings this run searched was confirmed'), false, 'that sentence is for a run in which nothing was confirmed');
  // The comparison account's own row: the numbers, and whether simply holding passed with the nominees' bar.
  assert.ok(nominees.includes('The comparison account\'s own row: half BTC, half LINK, bought once and held, same costs, put through the same ' +
    'confirmation calculation on every confirmation window above the coverage floor (Reading 8). Measured:\n\n| Cost level | Valid windows |'));
  assert.ok(nominees.includes(`| default (feeBps 2) | 9 | +${R.comparisonAccount.mean.toFixed(3)}% | ${R.comparisonAccount.sd.toFixed(3)} | `));
  assert.ok(nominees.includes('Measured: simply holding did not pass the test a nominee is confirmed by, on these windows and with the nominees\' bar: ' +
    `at least 8 valid windows: yes (9); mean above 0: yes (+${R.comparisonAccount.mean.toFixed(3)}%); confirmation p below 0.05 / 4 = 0.0125: no ` +
    `(${pValue(R.comparisonAccount.p)}).`));
  // The default setting, the per-family table and each nominee at the three cost levels.
  assert.ok(section('The default setting on all windows').includes('`P-h7-l7-b10-s0` (seven-minute horizon, seven lookback, 10 bps buffer, no stop) ran on 17 of 20 windows'));
  const families = section('Per family');
  assert.ok(families.includes('| Family | Settings | Eligible | Positive design mean (among eligible) | Distinct among the ten considered | Best T | ' +
    'Best setting | Skewness | Lag-1 autocorrelation | Valid windows | Search-adjusted p | Nominee |'));
  for (const family of FAMILIES) assert.ok(families.includes(`\n| ${family} | ${R.families[family].settings} | ${R.families[family].eligible} | `));
  assert.ok(families.includes('\n| all | 920 | ') && families.includes('the ten highest-scoring eligible settings held 5 distinct return vectors'));
  const each = section('Each nominee: design and confirmation numbers');
  for (const {id} of R.nominees) assert.ok(each.includes(`### ${id}\n`));
  assert.equal(each.split('| default (feeBps 2) | 9 |').length - 1, 4);
  assert.equal(each.split('| feeBps 10 | 9 |').length - 1, 4);
  assert.equal(each.split('| feeBps 40 | 9 |').length - 1, 4);
  // A resample share of 0 among this run's 300 resamples is "below 1 in 300", never "below 1 in 10,000".
  assert.ok(R.nominees.some(n => n.confirmation.fee10.pResample === 0) && each.includes(' | < 0.004 | ') && !each.includes('< 0.0001 | < 0.0001'));
  for (const words of ['Reported alongside, not pass/fail', 'r = intercept + slope × b fitted by least squares over 9 valid windows: intercept ',
    'one-sided p-value for intercept > 0, Student\'s t with n − 2 degrees of freedom', 'the confirmation p-value of the series r − slope × b',
    'the reading\'s p-value, the larger of the two', 'Direction sign test, two-sided', 'Worst window', 'Skewness', 'Lag-1 autocorrelation',
    'average fees per window', 'p (Student t)', 'p (resample)', 'The shape of the returns (Reading 9): descriptive figures, not tests.'])
    assert.ok(each.includes(words), words);
  // Each nominee: the label with its reading, the fit behind the reading, and the shape of its returns.
  for (const {id, confirmation: c} of R.nominees) {
    const own = each.slice(each.indexOf(`### ${id}\n`), each.indexOf('\n### ', each.indexOf(`### ${id}\n`) + 1) >>> 0), h = c.buyAndHold;
    assert.ok(own.includes(`Label: **${labelWithReading(c)}**. Measured: `), id);
    assert.ok(own.includes(`(standard error ${h.seIntercept.toFixed(3)}; one-sided p-value for intercept > 0, Student's t with n − 2 degrees of freedom: ` +
      `${pValue(h.pFit)}), slope ${h.slope.toFixed(3)} (standard error ${h.seSlope.toFixed(3)}); the confirmation p-value of the series r − slope × b: ` +
      `${pValue(h.adjusted.p)}; the reading's p-value, the larger of the two: ${pValue(h.p)}, against 0.05 / 4 = 0.0125.`), id);
    assert.ok(own.includes(`Reading: **${h.reading}**.`) && own.includes(`the reading at feeBps 10 is ${h.fee10.reading} (p ${pValue(h.fee10.p)}), at feeBps 40 ` +
      `${h.fee40.reading} (p ${pValue(h.fee40.p)}).`), id);
    assert.equal(own.includes('In the protocol\'s words, "*No* means the nominee\'s return on these windows cannot be told apart from holding the ' +
      'fraction `slope` of the comparison account."'), h.reading === 'no', id);
    assert.ok(own.includes(`the autocorrelation of r at lags 1 to 4: ${c.autocorrelation.map(a => a.toFixed(2).replace(/^-(0\.00)$/, '$1')).join(', ')}; ` +
      `the mean of r in the first half of the confirmation windows, windows 10 to 14: `) && own.includes(' over 4 valid windows, and in the second half, ' +
      'windows 15 to 19: ') && own.includes(` over 5 valid windows; the mean of r over the 3 valid windows in which b was lowest (windows ${c.lowestThird.windows.join(', ')}, lowest b first): `), id);
  }
  // The engine check and its references, the cost hurdle, coverage with the invalid windows, and no receipts here.
  const engine = section('Engine check');
  for (const {id, family, exactCheck: e} of R.nominees)
    assert.ok(engine.includes(`| \`${id}\` | ${e.reference}${family === 'L' ? ', fed the history the rule reads' : ''} | ${e.windowsCompared} | ${e.windowsRefusedByBoth} |`), id);
  assert.equal(section('Cost hurdle').split('\n').filter(line => /^\| \d+ \|/.test(line)).length, 7);
  const coverage = section('Coverage, invalid windows and receipts');
  assert.equal(coverage.split('\n').filter(line => /^\| \d+ \| (design|confirmation) \|/.test(line)).length, 20);
  assert.ok(coverage.includes('3 (design, insufficient shared coverage, 82.4% shared), 14 (confirmation, insufficient shared coverage, 81.6% shared)'));
  assert.ok(coverage.includes('receipts: none. This run read no candle store'));
  // The Readings, the further ones flagged; the deviations with reasons; the limits.
  const readings = section('Readings');
  READINGS.forEach((text, i) => assert.ok(readings.includes(`\n${i + 1}. ${text}\n`)));
  assert.ok(readings.indexOf('**They are not in the protocol**') > readings.indexOf(`9. ${READINGS[8]}`));
  for (const text of FURTHER_READINGS) assert.ok(readings.indexOf(`- ${text}`) > readings.indexOf('**They are not in the protocol**'));
  const deviations = section('Deviations');
  R.deviations.forEach((d, i) => assert.ok(deviations.includes(`\n${i + 1}. **${d.option}**: `) && deviations.includes(`Reason: ${d.reason}`), d.option));
  // The last section quotes the protocol's bounds as the protocol's text, then the limits, then what this run did.
  const limits = section('What this result would and would not establish');
  assert.ok(limits.startsWith('## What this result would and would not establish\n\nThe protocol bounds either outcome as follows:\n\n' +
    `> ${OUTCOME_BOUNDS[0]}\n>\n> ${OUTCOME_BOUNDS[1]}\n\nThe "limits measured above" in that quotation are the protocol's limits that ` +
    `no test on these windows can remove (\`research/PROTOCOL.md\`, "${TESTS_SECTION}"; the measured figures are in its two tables):\n\n` +
    TEST_LIMITS.map(text => `- ${text}\n`).join('') + '\nNot one of those limits, from the same section\'s reading of its first table ' +
    `(A rising market, the last row): ${RISING_MARKET}\n\n`));
  assert.ok(limits.endsWith('Measured: this run searched 920 settings on 10 design windows and ran 4 nominees on 10 confirmation windows; 3 of them were ' +
    'confirmed, each with its buy-and-hold reading beside its label above.\n'));
  // Finding 15: outside the quotation nothing says that no setting was confirmed, here where three were.
  for (const words of ['no setting among', 'settings this run searched was confirmed', 'settings it searched was confirmed'])
    assert.equal(unquoted(report).includes(words), false, words);
  // The stale text of Amendment 1 is gone: the old title of the protocol's section, its 300 settings and an option
  // research/calibration.mjs does not have.
  for (const words of ['What the two tests can and cannot do', '300 settings', '--settings N', 'Two limits']) assert.equal(report.includes(words), false, words);
  assert.ok(families.includes(`is the first table of \`research/PROTOCOL.md\`, "${TESTS_SECTION}", measured there at the width of one family of P, H or R and of all families pooled`));

  // Wording. Every number the run produced is labelled Measured: outside the Readings and the limits, a line of
  // prose that holds a digit says Measured or is fixed text of the protocol (headings, the legend of a table),
  // and every table follows a line that says Measured.
  const fixed = [/^# /, /^## /, /^### /, /^> \*\*/, /^- The search-adjusted p-value answers/,
    /^- Settings whose design returns are identical/, /^ {3}- /, /^\d+\. \*\*/, /^Written by `node research\/study\.mjs`/];
  let measured = false, body = true;
  for (const line of lines) {
    if (line.startsWith('## ')) body = !['## Readings', '## What this result would and would not establish'].includes(line);
    if (!line.trim()) continue;
    if (line.startsWith('|')) { assert.ok(measured, `a table without a Measured line before it: ${line.slice(0, 80)}`); continue; }
    measured = line.includes('Measured');
    if (body && /\d/.test(line) && !measured) assert.ok(fixed.some(pattern => pattern.test(line)), `a number without Measured: ${line.slice(0, 120)}`);
  }
  assert.ok(lines.filter(line => line.includes('Measured')).length > 30);
  // No reserved word outside the protocol's quoted negation, no address, nothing but plain text.
  assert.doesNotMatch(unquoted(report), RESERVED);
  assert.ok(unquoted(report).length < report.length - 900, 'the quotation was found and taken out');
  assert.doesNotMatch(report, /@|undefined|NaN|\[object/);
  // F13 of the first review: a p-value of 0 is printed as "below 1 / resamples", rounded up to one digit.
  assert.deepEqual([pValue(0, 10000), pValue(0, 300), pValue(0, 200), pValue(1 / 300, 300), pValue(0.5, 300), pValue(null, 300), pValue(0.00003)],
    ['< 0.0001', '< 0.004', '< 0.005', '0.0033', '0.5000', 'n/a', '< 0.0001']);
  for (const text of [report, summaryText(R)]) assert.doesNotMatch(text, /< 0\.\d{6,}|\d\.\d{9,}/);
  // A value that rounds to zero is printed as zero, without a minus sign.
  const tiny = renderResults({...R, defaultSetting: {...R.defaultSetting, mean: -0.0001, sd: 0.004}, pooled: {...R.pooled, best: {...R.pooled.best, skewness: -0.001, lag1: -0.004}}});
  assert.ok(tiny.includes('| all | 17 | +0.000% | 0.004 | ') && tiny.includes(`\` | 0.00 | 0.00 | ${R.pooled.best.n} | `));
  assert.doesNotMatch(tiny, /-0\.0+(%| \|)/);

  // A run with no nominee and nothing eligible: the same sections, "None" where there is nothing, n/a not a number.
  // The comparison account's row is the same numbers with no k and no bar.
  const alone = {...R.comparisonAccount, k: 0, threshold: null, passed: null, conditions: {...R.comparisonAccount.conditions, pBelowThreshold: null}};
  const empty = renderResults({...R, banner: [], deviations: [], nominees: [], comparisonAccount: alone,
    pooled: {...R.pooled, eligible: 0, best: null, searchAdjusted: {...R.pooled.searchAdjusted, p: null}}});
  assert.equal(empty.split('\n')[0], '# Exploration results', 'without a banner the title is the first line');
  assert.deepEqual(empty.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3)), [...SECTIONS]);
  assert.ok(empty.includes('## Deviations\n\nNone.\n') && empty.includes('Measured: no nominee.') && empty.includes('Deviations from the protocol. Measured: none.'));
  // Nothing eligible says so, rather than describing ten highest-scoring settings that did not exist (study3
  // finding 6); with eligible settings and no nominee the sentence about the ten stands.
  assert.ok(empty.includes(`Measured: no nominee. No setting was eligible (at least ${R.protocol.windows.minValidDesignWindows} valid design ` +
    'windows and a fill in at least half of them), so no family had a setting to nominate'));
  const unqualified = renderResults({...R, banner: [], deviations: [], nominees: [], comparisonAccount: alone});
  assert.ok(R.pooled.eligible > 0 && unqualified.includes('Measured: no nominee. No family had a setting among its ten highest-scoring distinct settings'));
  // Receipts are called the exchange's only for the complete exchange store, whose every receipt names it (study3
  // finding 3: a loopback store run with --allow-incomplete-store was described as exchange responses).
  const withStore = exchange => renderResults({...R, data: {...R.data, completeExchangeStore: exchange,
    receipts: {BTC: {files: 1, receipts: 2, sha256: {'2020-01': 'a'.repeat(64)}}},
    manifest: {assets: {BTC: {months: {'2020-01': {rows: 3, receipts: 2, sha256: 'b'.repeat(64)}}}}},
    completeness: {emptyResponseMonths: [], lastBucketMissingMonths: [], rowsByMonth: {BTC: {'2020-01': 3}}}}});
  const [exchangeStore, otherStore] = [true, false].map(withStore);
  assert.ok(exchangeStore.includes('receipts, one per stored exchange response: BTC 2 receipts in 1 files.') &&
    exchangeStore.includes('months with an exchange answer that held no row'));
  assert.ok(otherStore.includes('receipts, one per stored response: BTC 2 receipts in 1 files.') &&
    otherStore.includes('months with an answer that held no row') && !otherStore.includes('exchange response') && !otherStore.includes('exchange answer'));
  assert.ok(empty.includes('- Measured: none of the 920 settings this run searched was confirmed on these windows at these costs.\n'));
  assert.ok(empty.includes('Measured: this run searched 920 settings on 10 design windows and ran 0 nominees on 10 confirmation windows; none of the 920 ' +
    'settings it searched was confirmed on these windows at these costs.\n'));
  assert.ok(empty.includes(`Measured: there is no nominee, so there is no k and no bar: the numbers above stand alone (at least 8 valid windows: yes (9); ` +
    `mean above 0: yes (+${R.comparisonAccount.mean.toFixed(3)}%); confirmation p-value ${pValue(R.comparisonAccount.p)}).`));
  assert.ok(empty.includes('| all | 920 | 0 | ') && empty.includes('| n/a | none | n/a | n/a | n/a | n/a |'));
  assert.deepEqual(labelsAlone(empty), []);
  // When the protocol's tables were measured with another research/stats.mjs, the status block says so in bold, and
  // the summary in a line of its own; when that is not known, both say that.
  const other = {...R.calibration, statsSha256: '0'.repeat(64), measuredWithTheStatsThatRan: false};
  const unknown = {...R.calibration, sha256: null, statsSha256: null, measuredWithTheStatsThatRan: null};
  const [differs, notKnown] = [other, unknown].map(calibration => [renderResults({...R, calibration}), summaryText({...R, calibration})]);
  const sentence = `The protocol's tables were measured with another version of research/stats.mjs than the one that ran: research/calibration.json names ` +
    `SHA-256 0000000000000000..., the research/stats.mjs that ran has ${R.calibration.statsSha256ThatRan.slice(0, 16)}...`;
  assert.deepEqual(calibrationNote(other), [sentence]);
  assert.ok(differs[0].includes(`; the same: no. **${sentence}**\n`) && differs[1].includes(`\n${sentence}\n`));
  assert.ok(notKnown[0].includes('SHA-256 none (no such file), says the protocol\'s two tables were measured with `research/stats.mjs` SHA-256 unknown') &&
    notKnown[0].includes('the same: unknown. **Which version of research/stats.mjs the protocol\'s tables were measured with is not known: ' +
    'research/calibration.json is missing or names none.**') && notKnown[1].includes('\nWhich version of research/stats.mjs'));
  assert.deepEqual(calibrationNote({...R.calibration, measuredWithTheStatsThatRan: true}), []);
});

test('a close after 2025-09-30T00:00:00Z is refused whatever the source of the market', async () => {
  // Four one-day windows ending where the exploration range ends. The last allowed bucket starts 2025-09-29T23:59Z
  // and closes at 2025-09-30T00:00:00Z: a market ending there runs, one with a single later close does not.
  const days = {from: RESERVED_FROM - 4 * DAY, windowDays: 1, windowCount: 4, designCount: 2, minSharedFraction: 0.9, minValidDesignWindows: 1,
    minValidConfirmationWindows: 1};
  const settings = SEARCHED.filter(s => s.family === 'P').slice(0, 3), quiet = {missing: 0, gapRate: 0, longGapRate: 0};
  const until = last => syntheticMarket({seed: 3, start: RESERVED_FROM - 4 * DAY + MINUTE, minutes: (last - (RESERVED_FROM - 4 * DAY)) / MINUTE, BTC: quiet, LINK: quiet});
  const run = market => runStudy({market, protocol: days, settings, resamples: 50, workers: 0, out: null});
  const allowed = until(RESERVED_FROM);
  assert.equal(new Date(allowed.BTC.time.at(-1)).toISOString(), '2025-09-30T00:00:00.000Z');
  const {results} = await run(allowed);
  assert.deepEqual([results.data.lastClose.BTC, results.windows.length, results.designGrid.simulations > 0], ['2025-09-30T00:00:00.000Z', 4, true]);
  await assert.rejects(run(until(RESERVED_FROM + MINUTE)), /BTC: the market holds a close at 2025-09-30T00:01:00\.000Z, later than 2025-09-30T00:00:00\.000Z.*there is no override/);
  // One asset alone is enough, and so is a market that lies wholly in the reserved range (the first review's F12).
  await assert.rejects(run({BTC: allowed.BTC, LINK: until(RESERVED_FROM + MINUTE).LINK}), /LINK: the market holds a close at 2025-09-30T00:01/);
  const later = Date.parse('2025-10-01T00:00:00Z');
  await assert.rejects(runStudy({market: syntheticMarket({seed: 3, start: later + MINUTE, minutes: 2 * 1440, BTC: quiet, LINK: quiet}),
    protocol: {...days, from: later}, settings, resamples: 50, workers: 0, out: null}), /later than 2025-09-30T00:00:00\.000Z/);
});

test('an earlier record is not replaced silently: refusal, then --overwrite with the replaced files on record', async () => {
  const dir = scratch(), paths = {out: dir, report: join(dir, 'RESULTS.md')}, few = SEARCHED.filter(s => s.family === 'L').slice(0, 8);
  const run = (more = {}) => runStudy({market: TREND, protocol: SCALED, settings: few, resamples: 50, workers: 0, ...paths, ...more});
  const first = await run(), before = {json: readFileSync(first.path), report: readFileSync(first.reportPath)};
  assert.deepEqual([first.results.previousRun, first.results.deviations.some(d => d.option === 'overwrite')], [null, false]);
  // A second run into the same place is refused before it simulates anything, and nothing on disk changes.
  await assert.rejects(run(), /An earlier record exists \(.*exploration\.json, .*RESULTS\.md\) and is not replaced silently.*--overwrite/);
  assert.deepEqual([readFileSync(first.path), readFileSync(first.reportPath)], [before.json, before.report]);
  // Either file alone is an earlier record.
  await assert.rejects(run({out: scratch()}), /An earlier record exists \(.*RESULTS\.md\)/);
  await assert.rejects(run({report: join(scratch(), 'RESULTS.md')}), /An earlier record exists \(.*exploration\.json\)/);
  // With the option the files are replaced and the new record says what they were.
  const second = await run({overwrite: true}), was = second.results.previousRun;
  assert.deepEqual([was.exploration.sha256, was.exploration.bytes, was.report.sha256, was.report.bytes],
    [sha256Hex(before.json), before.json.length, sha256Hex(before.report), before.report.length]);
  for (const file of [was.exploration, was.report]) assert.match(file.modifiedAt, /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(second.results.banner.filter(line => line.startsWith('REPLACES AN EARLIER RECORD (--overwrite)')).length, 1);
  assert.equal(first.results.banner.some(line => line.startsWith('REPLACES')), false);
  // Finding 16: what the replaced record said of itself is kept (its banner lines and its data source), and the
  // banner says what was replaced, here a dry run, which is not a run on the candle store. The first version of this
  // test expected "so this is not the first look at the confirmation windows" whatever had been replaced.
  assert.deepEqual(was.record, {format: 'paper-trail-exploration-v3', banner: first.results.banner, dataSource: first.results.data.source});
  const what = 'the replaced record was a dry run on an in-memory market supplied by its caller (its banner: DRY RUN, CHANGED FROM THE PROTOCOL), ' +
    'not a run on the candle store';
  const replacing = run => run.results.banner.find(line => line.startsWith('REPLACES AN EARLIER RECORD'));
  assert.equal(replacing(second), `REPLACES AN EARLIER RECORD (--overwrite): ${what}. The replaced files are identified under previousRun.`);
  const deviation = second.results.deviations.find(d => d.option === 'overwrite');
  assert.equal(deviation.reason, `The caller passed --overwrite. An earlier record was replaced: ${what}. Its SHA-256 and modification time are under previousRun.`);
  assert.ok(second.report.includes(`the earlier exploration file was replaced (SHA-256 \`${sha256Hex(before.json)}\``));
  assert.ok(second.report.includes(`the earlier report file was replaced (SHA-256 \`${sha256Hex(before.report)}\``));
  assert.ok(second.report.includes(`; the replaced exploration.json recorded the data source "${first.results.data.source}" and the banner "DRY RUN", ` +
    '"CHANGED FROM THE PROTOCOL". Only the two output paths are checked for an earlier record'));
  assert.deepEqual([readFileSync(second.path, 'utf8') === before.json.toString(), JSON.parse(readFileSync(second.path, 'utf8')).previousRun], [false, was]);
  // A replaced exploration.json that is not a record of this study, and a report alone, are each counted as an
  // earlier look, since nothing says otherwise.
  writeFileSync(second.path, '{"not": "a record"}\n');
  const third = await run({overwrite: true});
  assert.deepEqual([third.results.previousRun.record, replacing(third)], [null, 'REPLACES AN EARLIER RECORD (--overwrite): the replaced ' +
    'exploration.json could not be read as a record of this study, so it is counted as an earlier look at the confirmation windows. The replaced ' +
    'files are identified under previousRun.']);
  rmSync(third.path);
  const fourth = await run({overwrite: true});
  assert.deepEqual([fourth.results.previousRun.exploration, fourth.results.previousRun.record], [null, null]);
  assert.match(replacing(fourth), /^REPLACES AN EARLIER RECORD \(--overwrite\): only a report was there, with no exploration\.json to say what it recorded, so it is counted as an earlier look/);
  assert.ok(fourth.report.includes('; what the replaced files recorded could not be read from an exploration.json. Only the two output paths are checked'));
  // A record that appears while a study runs (another run finishing first) is not replaced either: both paths are
  // looked at again before anything is written.
  const late = scratch(), there = join(late, 'RESULTS.md');
  const appear = line => { if (line.startsWith('windows')) writeFileSync(there, 'another run\'s report\n'); };
  await assert.rejects(run({out: late, report: there, log: appear}), /A record appeared while the study ran \(.*RESULTS\.md\); nothing was written/);
  assert.deepEqual([readFileSync(there, 'utf8'), existsSync(join(late, 'exploration.json'))], ['another run\'s report\n', false]);
  // The option given where nothing exists replaces nothing, and says so.
  const fresh = scratch(), nothing = await run({out: fresh, report: join(fresh, 'RESULTS.md'), overwrite: true});
  assert.deepEqual([nothing.results.previousRun, nothing.results.deviations.find(d => d.option === 'overwrite').reason.includes('It changed nothing')], [null, true]);
});

test('the modules that ran are identified: hashes, state against the commit, and the engine against commit 6f6b693', async () => {
  const state = codeState();
  // Every module is hashed as it is on disk, and the list is the import graph of the study, engine included.
  assert.deepEqual(state.modules.map(m => m.file), [...MODULES]);
  for (const m of state.modules) assert.equal(m.sha256, sha256Hex(readFileSync(join(ROOT, m.file))), m.file);
  assert.deepEqual([...MODULES].sort(), ['engine.js', 'replay.js', 'report-card.js', 'research/dataset.mjs', 'research/engine-run.mjs', 'research/fastsim.mjs',
    'research/holdthrough-oracle.mjs', 'research/report.mjs', 'research/settings.mjs', 'research/stats.mjs', 'research/study-worker.mjs', 'research/study.mjs',
    'research/windows.mjs']);
  const imported = new Set(['research/study.mjs']);
  for (const file of imported) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:from\s+|import\(|new URL\()'(\.{1,2}\/[^']+\.m?js)'/g)) imported.add(join(dirname(file), specifier));
  }
  assert.deepEqual([...imported].sort(), MODULES.filter(file => file !== 'replay.js').sort(), 'every file the study imports is hashed (replay.js is hashed as the reference text)');
  // The pinned reference: the engine at commit 6f6b693, which is the engine in the working tree.
  assert.deepEqual(REFERENCE_ENGINE, {commit: '6f6b693', sha256: 'aaed70f6e241435c50108927fa625be6f7dc439cfb0bf4006bdabdabf050ea05'});
  assert.deepEqual(state.engine, {file: 'engine.js', sha256: REFERENCE_ENGINE.sha256, referenceCommit: '6f6b693', referenceSha256: REFERENCE_ENGINE.sha256, equalsReference: true});
  let atCommit = null;
  try { atCommit = execFileSync('git', ['show', '6f6b693:engine.js'], {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26}); } catch { /* history not available here */ }
  if (atCommit) assert.equal(sha256Hex(atCommit), REFERENCE_ENGINE.sha256, 'git show 6f6b693:engine.js');
  // The record of a run holds the same block, and its states are words, not a single "dirty" flag.
  assert.deepEqual(R.code.modules.map(m => [m.file, m.sha256]), state.modules.map(m => [m.file, m.sha256]));
  assert.deepEqual(Object.keys(R.code), ['commit', 'node', 'trackedFilesModified', 'researchModulesUntracked', 'allModulesCommitted', 'modules', 'engine', 'protocol', 'problems']);
  assert.ok(R.code.commit === null || /^[0-9a-f]{40}$/.test(R.code.commit));
  assert.ok(R.code.modules.every(m => ['committed', 'modified', 'untracked', 'unknown'].includes(m.state)));
  assert.equal(R.code.allModulesCommitted, R.code.modules.every(m => m.state === 'committed'));
  assert.equal(R.code.problems.length, [...R.code.modules, R.code.protocol].filter(m => m.state !== 'committed').length);
  assert.deepEqual([R.code.node, R.code.protocol.file, R.code.protocol.sha256], [process.version, 'research/PROTOCOL.md', R.protocol.sha256]);

  // A module that changes while a study runs: the record could not say which code produced its numbers, so the
  // run stops and writes nothing. Run from a copy of the study, so that the file changed is the copy's.
  const {repo} = committedCopy(), copy = await import(pathToFileURL(join(repo, 'research', 'study.mjs')).href);
  const dir = scratch(), few = SEARCHED.filter(s => s.family === 'L').slice(0, 4);
  let changed = false;
  const change = line => {
    if (changed || !line.startsWith('windows')) return;
    changed = true;
    appendFileSync(join(repo, 'research', 'settings.mjs'), '\n// changed during the run\n');
  };
  await assert.rejects(copy.runStudy({market: TREND, protocol: SCALED, settings: few, resamples: 50, workers: 0, out: dir, report: join(dir, 'RESULTS.md'), log: change}),
    /A module changed while the study ran \(research\/settings\.mjs\); nothing was written/);
  assert.deepEqual([changed, existsSync(join(dir, 'exploration.json')), existsSync(join(dir, 'RESULTS.md'))], [true, false, false]);
});

// Candle stores for the tests, written by research/fetch-candles.mjs itself through research/test-store.mjs: a stub
// answers its requests, nothing is contacted, and the receipts are dated and name the origin a fetch of that label
// names. (The first version of this file wrote stores by hand, one receipt a month with the url "synthetic" and no
// HTTP date; research/dataset.mjs now rightly refuses such receipts.) `rowsFor` gives each asset and month its rows,
// by default one row at the month's first minute: every month then holds a row, and every window is below the
// coverage floor, which is all a test of the refusals needs.
const firstMinute = (asset, month) => [[Math.max(monthRange(month)[0], EXPLORATION_FROM) + MINUTE, 10, 10, 10, 10, 1]];
// A market's rows, each month's own (by bucket start), or the first minute where the market has none.
const marketRows = market => (asset, month) => {
  const {time, close} = market[asset], [start, end] = monthRange(month), rows = [];
  for (let i = lowerBound(time, start + MINUTE); i < time.length && time[i] <= end; i++) rows.push([time[i], close[i], close[i], close[i], close[i], 1]);
  return rows.length ? rows : firstMinute(asset, month);
};
function testStore(dir, {rowsFor = firstMinute, source = SOURCE, ...more} = {}) {
  writeTestStore(dir, {rowsFor, source, ...more});
  return dir;
}
// Two whole stores, written once each and copied where a test changes one: the exchange's, which is the
// protocol's store, and one fetched from a loopback test server (complete, and not the exchange's).
const STORES = {};
const storeCopy = (source = SOURCE) => {
  STORES[source] ??= testStore(scratch(), {source});
  const dir = scratch();
  cpSync(STORES[source], dir, {recursive: true});
  return dir;
};

test('the store is checked before anything else: only a usable store passes; empty months, stray files and other labels are refused', async () => {
  const run = (data, more = {}) => runStudy({data, out: null, workers: 0, ...more});
  // An honest store: every month of both assets fetched (through a stub) from the exchange's host, each holding a
  // row, the receipts dated. It is usable, and the study goes past the store.
  const honest = storeCopy(), checked = storeCompleteness(honest);
  assert.deepEqual([checked.complete, checked.sourceIsExchange, checked.usable, checked.problems], [true, true, true, []]);
  const passed = await run(honest, {allowUncommitted: true, settings: SEARCHED.slice(0, 4)});
  assert.deepEqual([passed.results.data.completeExchangeStore, passed.results.data.completeness.usable, passed.results.banner.filter(line => line.startsWith('NOT A PROTOCOL RUN'))],
    [true, true, []]);
  assert.deepEqual(passed.results.data.completeness, plain({...checked, source: undefined}));

  // A store missing months: BTC fetched for 2020 only and LINK for its first half, 120 of the 138 asset-months
  // missing. Refused with the count and the first problems by name, each with what repairs it (the first review's
  // F1: such a store ran and the record said "Deviations: none").
  const short = testStore(scratch(), {months: explorationMonths().filter(month => month < '2021-01'), assets: ['BTC']});
  testStore(short, {months: explorationMonths().filter(month => month < '2020-07'), assets: ['LINK']});
  await assert.rejects(run(short), error => {
    const lines = error.message.split('\n');
    assert.equal(lines[0], 'The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store is not it: 120 of the 138 ' +
      'asset-months from 2020-01 to 2025-09 are missing, incomplete, without a row, or not borne out by their own files and receipts.');
    assert.deepEqual(lines.slice(1, 3), ['  BTC 2021-01: missing: the manifest has no entry for this month; run research/fetch-candles.mjs again',
      '  BTC 2021-02: missing: the manifest has no entry for this month; run research/fetch-candles.mjs again']);
    assert.deepEqual(lines.slice(9), ['  and 112 more', 'Each problem ends with what repairs it: research/fetch-candles.mjs writes .research-data unless it is ' +
      'given --dir with the directory this run was given as --data.', 'Or pass --allow-incomplete-store: the run is then marked at its top as not a run on ' +
      'the complete exchange store']);
    return true;
  });
  // Amendment 2: "A month that holds no row for an asset is not complete." One month without a row (every answer
  // empty, as in an exchange outage) is enough.
  const empty = storeCopy();
  testStore(empty, {months: ['2023-04'], assets: ['LINK'], rowsFor: () => []});
  await assert.rejects(run(empty), error => {
    assert.deepEqual(error.message.split('\n').slice(0, 2), ['The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store ' +
      'is not it: 1 of the 138 asset-months from 2020-01 to 2025-09 are missing, incomplete, without a row, or not borne out by their own files and receipts.',
      '  LINK 2023-04: holds no row; delete candles/LINK/2023-04.f64 in the store directory and run research/fetch-candles.mjs again']);
    return true;
  });
  // A stray file is not an asset-month: it is counted and named as a file (with its path, not as an asset and month).
  const stray = storeCopy();
  writeFileSync(join(stray, 'candles', 'BTC', '2020-03.f64.bak'), 'a copy\n');
  await assert.rejects(run(stray), error => {
    assert.deepEqual(error.message.split('\n').slice(0, 2), ['The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store ' +
      'is not it: 1 file or link in its directory is named by no manifest entry.', '  not in the manifest: candles/BTC/2020-03.f64.bak is in the store ' +
      'directory and no manifest entry names it; delete it or move it out of the store directory']);
    assert.doesNotMatch(error.message, /asset-month|BTC 2020-03/);
    // No fetch repairs a stray file, so the fetcher's --dir is not offered as what repairs it (study3 finding 7).
    assert.equal(error.message.split('\n')[2], 'Each problem ends with what repairs it.');
    assert.doesNotMatch(error.message, /fetch-candles/);
    return true;
  });
  // More problems than there are asset-months: 120 missing months, an entry for a month outside the range and 20
  // stray files are 141 problems, each kind counted as what it is.
  const crowded = scratch();
  cpSync(short, crowded, {recursive: true});
  const manifest = JSON.parse(readFileSync(manifestPath(crowded), 'utf8'));
  manifest.assets.BTC.months['2025-10'] = manifest.assets.BTC.months['2020-01'];
  writeFileSync(manifestPath(crowded), JSON.stringify(manifest));
  for (let i = 0; i < 20; i++) writeFileSync(join(crowded, `notes-${String(i).padStart(2, '0')}.txt`), 'a note\n');
  await assert.rejects(run(crowded), error => {
    assert.ok(error.message.startsWith('The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store is not it: 120 of the ' +
      '138 asset-months from 2020-01 to 2025-09 are missing, incomplete, without a row, or not borne out by their own files and receipts; its manifest has 1 ' +
      'entry for months outside 2020-01 to 2025-09; 20 files or links in its directory are named by no manifest entry.\n'), error.message);
    // Eight named and 133 more: 141 problems, not described as asset-months.
    assert.ok(error.message.includes('\n  and 133 more\n') && !/141 of|of the 141/.test(error.message));
    return true;
  });
  // A store whose label is not the exchange's is refused although every month is there (F3), and fetching into it
  // would not change that.
  const other = storeCopy(LOOPBACK_SOURCE);
  const labelled = storeCompleteness(other);
  assert.deepEqual([labelled.complete, labelled.usable], [true, false]);
  await assert.rejects(run(other), error => {
    assert.equal(error.message, 'The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store is not it: its source is ' +
      `"${LOOPBACK_SOURCE}", not the exchange ("${SOURCE}").\nA store with another label is not made the exchange store by fetching into it: ` +
      'research/fetch-candles.mjs fetches from the exchange into a directory of its own.\nOr pass --allow-incomplete-store: the run is then marked at its top ' +
      'as not a run on the complete exchange store');
    return true;
  });
  // No store at all, and options that are not an explicit permission, change nothing.
  await assert.rejects(run(scratch()), /no manifest; fetch with research\/fetch-candles\.mjs first/);
  await assert.rejects(run(short, {overwrite: true, allowUncommitted: true}), /The study runs only on the complete exchange store/);
  // The store is looked at first: before the settings are simulated, before git is asked, before a record is written.
  const out = scratch();
  await assert.rejects(runStudy({data: empty, out, report: join(out, 'RESULTS.md'), workers: 0}), /The study runs only on the complete exchange store/);
  assert.deepEqual([existsSync(join(out, 'exploration.json')), existsSync(join(out, 'RESULTS.md'))], [false, false]);
});

// The repository's study, copied to a directory of its own and committed there: the modules that run, the
// protocol text, the measurement behind its tables (research/calibration.json, which the study reads and hashes)
// and nothing else. A run from this copy has a git state this test controls, whatever the state of the working
// tree the tests themselves run from.
function committedCopy({leaveUntracked = []} = {}) {
  const repo = scratch(), files = [...MODULES, 'research/PROTOCOL.md', 'research/calibration.json'];
  for (const file of files) { mkdirSync(dirname(join(repo, file)), {recursive: true}); copyFileSync(join(ROOT, file), join(repo, file)); }
  const git = (...args) => execFileSync('git', args, {cwd: repo, stdio: ['ignore', 'pipe', 'pipe']});
  git('init', '-q');
  git('add', '--', ...files.filter(file => !leaveUntracked.includes(file)));
  git('-c', 'user.name=study test', '-c', 'user.email=none', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'the study as copied');
  return {repo, study: join(repo, 'research', 'study.mjs'), head: git('rev-parse', 'HEAD').toString().trim()};
}

test('the command line on a complete store: one command writes exploration.json and RESULTS.md, with no deviation', () => {
  const {study, head} = committedCopy(), run = (cwd, ...args) => spawnSync(process.execPath, [study, ...args], {encoding: 'utf8', cwd});
  const help = run(ROOT, '--help');
  assert.equal(help.status, 0);
  for (const flag of ['--data <dir>', '--out <dir>', '--report <file>', '--workers <n>', '--allow-incomplete-store', '--allow-uncommitted', '--overwrite', '--help'])
    assert.ok(help.stdout.includes(`  ${flag} `), flag);
  for (const bad of [['--from', '2026-01-01'], ['--workers'], ['--limit', '3'], ['--market', 'x'], ['--resamples', '10'], ['--overwrite=yes']]) {
    const refused = run(ROOT, ...bad);
    assert.deepEqual([refused.status, refused.stdout], [1, '']);
    assert.match(refused.stderr, /Unknown or incomplete argument/);
  }
  const nowhere = scratch(), failed = run(nowhere, '--workers', '1');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Study failed: .*no manifest; fetch with research\/fetch-candles\.mjs first/);
  assert.equal(existsSync(join(nowhere, 'research')), false);

  // A working directory holding .research-data: a store with every month of 2020-01 to 2025-09 for both assets,
  // written by the fetcher through a stub on the exchange's host, of which the first 56 days hold synthetic prices
  // and every later month one row at its first minute (a usable store: every month holds a row; windows 0 and 1 are
  // valid, the other 72 are below the coverage floor). The first version of this test left the later months without
  // a row; Amendment 2 refuses such a store.
  const cwd = scratch(), few = {missing: 0.004, gapRate: 0.0005, longGapRate: 0};
  const store = testStore(join(cwd, '.research-data'), {rowsFor: marketRows(syntheticMarket({seed: 9, start: EXPLORATION_FROM + MINUTE,
    minutes: 56 * 1440 - 1, BTC: few, LINK: few}))});
  const checked = storeCompleteness(store);
  assert.equal(checked.usable, true);
  const done = run(cwd);   // no flag at all: the protocol's own run
  assert.equal(done.status, 0, done.stderr);
  const written = readFileSync(join(cwd, 'research', 'results', 'exploration.json')), results = JSON.parse(written.toString());
  const report = readFileSync(join(cwd, 'research', 'RESULTS.md'), 'utf8');
  // No banner and no deviation: the first line of the summary and of the report is the plain one.
  assert.match(done.stdout, /^Exploration study: simulated cash only\. Exploration, not evidence\.\nCode [0-9a-f]{40}; data: Coinbase Exchange public completed one-minute candles/);
  assert.match(done.stdout, /Deviations from research\/PROTOCOL\.md: none\n/);
  assert.match(done.stdout, /wrote research\/results\/exploration\.json \(\d+\.\d\d MB\) and research\/RESULTS\.md\n$/);
  assert.deepEqual([results.banner, results.deviations, results.previousRun], [[], [], null]);
  assert.equal(report.split('\n')[0], '# Exploration results');
  assert.ok(report.includes('## Deviations\n\nNone.\n') && report.includes('Deviations from the protocol. Measured: none.'));
  assert.equal(report, renderResults(results));
  assert.deepEqual(report.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3)), [...SECTIONS]);
  assert.doesNotMatch(`${done.stdout}${unquoted(report)}`, RESERVED);
  // The data: the manifest's own source, the completeness check with its lists, the manifest hash and the receipts
  // on disk.
  assert.deepEqual([results.data.source, results.data.kind, results.data.completeExchangeStore, results.data.completeness],
    [SOURCE, 'candle store (research/fetch-candles.mjs)', true, plain({...checked, source: undefined})]);
  assert.deepEqual(Object.keys(results.data.completeness), ['complete', 'sourceIsExchange', 'usable', 'problems', 'emptyResponseMonths',
    'lastBucketMissingMonths', 'rowsByMonth']);
  assert.equal(results.data.manifestSha256, sha256Hex(readFileSync(manifestPath(store))));
  assert.deepEqual(Object.keys(results.data.manifest.assets.BTC.months), explorationMonths());
  const requests = explorationMonths().reduce((sum, month) => sum + Math.ceil((Math.min(monthRange(month)[1], RESERVED_FROM) - Math.max(monthRange(month)[0], EXPLORATION_FROM)) / (299 * MINUTE)), 0);
  assert.deepEqual([results.data.receipts.BTC.files, results.data.receipts.BTC.receipts, results.data.receipts.LINK.files, results.data.receipts.LINK.receipts],
    [69, requests, 69, requests]);
  assert.equal(results.data.receipts.BTC.sha256['2020-02'], sha256Hex(readFileSync(monthPaths(store, 'BTC', '2020-02').receipts)));
  // RESULTS.md lists, from the store's own records, the months with empty answers, those whose last bucket did not
  // come back and those without a row, and says what "fetched from the exchange" rests on (finding 14).
  const listed = entries => ASSETS.map(asset => {
    const months = entries.filter(entry => entry.asset === asset).map(entry => entry.month);
    return `${asset} ${months.length ? `${months.length} (${months.join(', ')})` : 'none'}`;
  }).join('; ');
  assert.ok(checked.emptyResponseMonths.length > 100 && checked.lastBucketMissingMonths.length > 100);
  assert.ok(report.includes(`receipts, one per stored exchange response: BTC ${requests.toLocaleString('en-US')} receipts in 69 files, LINK ` +
    `${requests.toLocaleString('en-US')} receipts in 69 files.\n\nMeasured, from the store's own records: months with an exchange answer that held no row: ` +
    `${listed(checked.emptyResponseMonths)}. Months whose last wanted minute did not come back: ${listed(checked.lastBucketMissingMonths)}. Months that hold ` +
    'no row: BTC none; LINK none.\n\n"Fetched from the exchange" is read from the store\'s own records: the source label in its manifest and the origin ' +
    'each receipt names. That catches accidents and cannot prove where a file came from.\n'));
  assert.ok(report.includes('complete exchange store: yes (read from the store\'s own records, its source label and the origin each receipt names, which ' +
    'cannot prove where a file came from); manifest SHA-256 '));
  const february = results.data.manifest.assets.BTC.months['2020-02'];
  assert.ok(report.includes(`| 2020-02 | ${february.rows.toLocaleString('en-US')} | ${february.receipts} | \`${february.sha256.slice(0, 16)}\` | ` +
    `\`${results.data.receipts.BTC.sha256['2020-02'].slice(0, 16)}\` | `));
  assert.equal(report.split('\n').filter(line => /^\| 20\d\d-\d\d \| /.test(line)).length, 69);
  assert.equal(results.data.firstClose.BTC, '2020-01-01T00:01:00.000Z');
  // The protocol's tables were measured with the research/stats.mjs that ran: nothing is said about them.
  assert.deepEqual([results.calibration.measuredWithTheStatsThatRan, done.stdout.includes('measured with another version')], [true, false]);
  // The code: the commit of the copy names every module that ran.
  assert.deepEqual([results.code.commit, results.code.allModulesCommitted, results.code.trackedFilesModified, results.code.researchModulesUntracked, results.code.problems,
    results.code.engine.equalsReference], [head, true, false, false, [], true]);
  assert.ok(results.code.modules.every(m => m.state === 'committed') && results.code.protocol.state === 'committed');
  assert.ok(report.includes(`commit \`${head}\`; every module that ran is committed at that commit: yes; tracked files modified anywhere in the repository: no; research modules untracked: no`));
  // The protocol at full size: 74 windows, 13,200 settings; window 0 has no warmup inside the range, so every
  // lookback setting is refused there and family L runs.
  assert.deepEqual(results.protocol.windows, {...PROTOCOL, from: '2020-01-01T00:00:00.000Z'});
  assert.deepEqual(results.protocol.resampling, {resamples: 10000, seed: 20261118});
  assert.deepEqual([results.windows.length, results.windows.filter(w => w.set === 'design').length, results.windows.filter(w => w.valid).map(w => w.index)], [74, 50, [0, 1]]);
  assert.deepEqual(results.invalidWindows.slice(0, 2).map(w => [w.index, w.reason]), [[2, 'fewer than 2 shared minutes'], [3, 'fewer than 2 shared minutes']]);
  assert.deepEqual([results.designGrid.settings, results.designGrid.designWindows, results.designGrid.validDesignWindows, results.designGrid.simulations], [13200, 50, 2, 13200 + 720]);
  assert.deepEqual(FAMILIES.map(f => [results.families[f].settings, results.families[f].refusedForWarmup]),
    [[3360, {0: 3360}], [3360, {0: 3360}], [3360, {0: 3360}], [2400, {0: 2400}], [720, {}]]);
  assert.ok(results.families.P.scores.n.every(n => n === 1) && results.families.L.scores.n.every(n => n === 2));
  // "At least 40 valid design windows": with two, nothing is eligible, nothing is nominated and there is no
  // p-value. The first build nominated a setting here on two design windows.
  assert.deepEqual(FAMILIES.map(f => [results.families[f].eligible, results.families[f].best, results.families[f].searchAdjusted.p, results.families[f].nomination.nominee]),
    Array(5).fill([0, null, null, null]));
  assert.deepEqual([results.nominees, results.pooled.eligible], [[], 0]);
  assert.ok(report.includes('Measured: no nominee.') && report.includes('- Measured: none of the 13,200 settings this run searched was confirmed on these windows at these costs.\n'));
  assert.ok(report.includes('Measured: no nominee. No setting was eligible (at least 40 valid design windows and a fill in at least half of them)'));
  assert.ok(done.stdout.includes('Nominees: none. No setting was eligible (at least 40 valid design windows and a fill in at least half of them).\n'));
  // The comparison account's own row on no window above the floor, with no nominee and so no bar.
  assert.deepEqual([results.comparisonAccount.n, results.comparisonAccount.k, results.comparisonAccount.passed, results.comparisonAccount.perWindow], [0, 0, null, []]);
  assert.ok(done.stdout.includes('Comparison account (half BTC, half LINK, held) on 0 confirmation windows above the coverage floor: mean n/a, confirmation p 1.0000 (no nominee, so no bar)\n'));
  assert.deepEqual([results.defaultSetting.n, results.defaultSetting.perWindow.length, results.defaultSetting.perWindow[0].invalid], [1, 74, 'insufficient warmup']);
  assert.equal(results.costHurdle.windows, 2);

  // A second run does not silently replace the record; with --overwrite it does, and says what it replaced.
  const again = run(cwd);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Study failed: An earlier record exists \(research\/results\/exploration\.json, research\/RESULTS\.md\) and is not replaced silently/);
  assert.equal(readFileSync(join(cwd, 'research', 'RESULTS.md'), 'utf8'), report);
  const replaced = run(cwd, '--overwrite', '--workers', '2');
  assert.equal(replaced.status, 0, replaced.stderr);
  const second = JSON.parse(readFileSync(join(cwd, 'research', 'results', 'exploration.json'), 'utf8'));
  // What was replaced was a run on the candle store: that is an earlier look at its confirmation windows.
  assert.ok(replaced.stdout.startsWith(`REPLACES AN EARLIER RECORD (--overwrite): the replaced record was a run on a candle store (source "${SOURCE}"; its ` +
    'banner: none), so the confirmation windows had been looked at before this run. The replaced files are identified under previousRun.\n'));
  assert.deepEqual(second.deviations.map(d => d.option), ['overwrite', 'workers']);
  assert.deepEqual([second.previousRun.exploration.path, second.previousRun.exploration.sha256, second.previousRun.report.path, second.previousRun.report.sha256],
    ['research/results/exploration.json', sha256Hex(written), 'research/RESULTS.md', sha256Hex(report)]);
  assert.deepEqual(second.previousRun.record, {format: 'paper-trail-exploration-v3', banner: [], dataSource: SOURCE});
  // Apart from what a second run must differ in, it is the same record: the study is reproducible.
  const same = record => ({...record, timing: null, banner: null, deviations: null, previousRun: null});
  assert.deepEqual(same(second), same(results));
});

test('the command line refuses an incomplete store and uncommitted code; each explicit option is recorded at the top', () => {
  const {repo, study} = committedCopy(), dir = scratch();
  const run = (...args) => spawnSync(process.execPath, [study, '--workers', '0', ...args], {encoding: 'utf8', cwd: dir});
  const target = name => ['--out', join(dir, name), '--report', join(dir, name, 'RESULTS.md')];
  const read = name => [JSON.parse(readFileSync(join(dir, name, 'exploration.json'), 'utf8')), readFileSync(join(dir, name, 'RESULTS.md'), 'utf8')];
  // Stores of one row a month, written by the fetcher through a stub: every run below is a matter of the refusals,
  // not of prices. (The first version wrote them by hand, with receipts research/dataset.mjs now refuses.)
  const complete = storeCopy();
  const short = testStore(join(dir, 'short'), {months: explorationMonths().filter(month => month < '2025-08')});
  const other = storeCopy(LOOPBACK_SOURCE);
  const missing = 'missing: the manifest has no entry for this month; run research/fetch-candles.mjs again';

  // An incomplete store: refused with what is missing; with the option it runs, and the first line of the summary
  // and of RESULTS.md says the run did NOT use the complete exchange store.
  let refused = run('--data', short, ...target('a'));
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes('\nStudy failed: The study runs only on the complete exchange store (research/PROTOCOL.md, Data boundary). This store is not ' +
    'it: 4 of the 138 asset-months from 2020-01 to 2025-09 are missing, incomplete, without a row, or not borne out by their own files and receipts.\n' +
    ['BTC 2025-08', 'BTC 2025-09', 'LINK 2025-08', 'LINK 2025-09'].map(month => `  ${month}: ${missing}\n`).join('') + 'Each problem ends with what ' +
    'repairs it: research/fetch-candles.mjs writes .research-data unless it is given --dir with the directory this run was given as --data.\nOr pass ' +
    '--allow-incomplete-store'), refused.stderr);
  assert.equal(existsSync(join(dir, 'a')), false);
  let allowed = run('--data', short, ...target('a'), '--allow-incomplete-store');
  assert.equal(allowed.status, 0, allowed.stderr);
  let [results, report] = read('a');
  const first = 'NOT A PROTOCOL RUN: this run did NOT use the complete exchange store (--allow-incomplete-store): 4 of the 138 asset-months from 2020-01 to 2025-09 ' +
    'are missing, incomplete, without a row, or not borne out by their own files and receipts. Its numbers are not results of research/PROTOCOL.md.';
  assert.deepEqual([allowed.stdout.split('\n')[0], report.split('\n')[0], results.banner], [first, `> **${first}**`, [first]]);
  assert.deepEqual(results.deviations.map(d => d.option), ['allowIncompleteStore', 'data', 'out', 'report', 'workers']);
  assert.deepEqual({...results.deviations[0], reason: null}, {option: 'allowIncompleteStore', value: true, default: false, reason: null, storeSource: SOURCE, sourceIsExchange: true,
    problems: ['BTC', 'LINK'].flatMap(asset => ['2025-08', '2025-09'].map(month => ({asset, month, problem: missing})))});
  assert.match(results.deviations[0].reason, /^The caller passed --allow-incomplete-store\. The protocol runs only on the complete exchange store, and this store is not it: 4 of the 138/);
  assert.deepEqual([results.data.completeExchangeStore, results.data.completeness.complete, results.data.completeness.usable, results.data.completeness.problems.length],
    [false, false, false, 4]);
  assert.ok(report.includes('1. **allowIncompleteStore**: `true` where the protocol\'s run has `false`. Reason: The caller passed --allow-incomplete-store.'));
  assert.ok(report.includes(`   - LINK 2025-09: ${missing}`) && report.includes('complete exchange store: no ('));
  // The months without a row are listed from rowsByMonth: here the four that were never fetched.
  assert.ok(report.includes('Months that hold no row: BTC 2 (2025-08, 2025-09); LINK 2 (2025-08, 2025-09).'));

  // A complete store that is not the exchange's: the same refusal and the same first line.
  refused = run('--data', other, ...target('b'));
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`This store is not it: its source is "${LOOPBACK_SOURCE}", not the exchange`));
  allowed = run('--data', other, ...target('b'), '--allow-incomplete-store');
  assert.equal(allowed.status, 0, allowed.stderr);
  [results, report] = read('b');
  assert.ok(allowed.stdout.startsWith('NOT A PROTOCOL RUN: this run did NOT use the complete exchange store (--allow-incomplete-store): its source is ' +
    `"${LOOPBACK_SOURCE}", not the exchange`));
  assert.match(report, /^> \*\*NOT A PROTOCOL RUN: this run did NOT use the complete exchange store/);
  assert.deepEqual([results.data.source, results.data.completeness.sourceIsExchange, results.deviations[0].sourceIsExchange, results.deviations[0].problems], [LOOPBACK_SOURCE, false, false, []]);
  assert.deepEqual([results.data.completeness.complete, results.data.completeExchangeStore], [true, false], 'every month is there, and it is still not the exchange store');
  assert.ok(report.includes('complete exchange store: no ('));
  // The option on a store that needs none is still on record, and says that it changed nothing.
  allowed = run('--data', complete, ...target('c'), '--allow-incomplete-store', '--allow-uncommitted');
  assert.equal(allowed.status, 0, allowed.stderr);
  [results, report] = read('c');
  assert.deepEqual([results.banner, results.deviations.map(d => d.option)], [[], ['allowIncompleteStore', 'data', 'allowUncommitted', 'out', 'report', 'workers']]);
  assert.ok(results.deviations.filter(d => d.option.startsWith('allow')).every(d => d.reason.includes('It changed nothing')));
  assert.equal(report.split('\n')[0], '# Exploration results');

  // Code that is not the committed code (F4): a module changed after the commit is refused on the candle store,
  // by name, and so is a research module that was never committed.
  appendFileSync(join(repo, 'research', 'stats.mjs'), '\n// changed after the commit\n');
  refused = run('--data', complete, ...target('d'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Study failed: The record could not name the code that ran: research\/stats\.mjs is modified\. Commit the code first, or pass --allow-uncommitted/);
  assert.equal(existsSync(join(dir, 'd')), false);
  allowed = run('--data', complete, ...target('d'), '--allow-uncommitted');
  assert.equal(allowed.status, 0, allowed.stderr);
  [results, report] = read('d');
  assert.equal(allowed.stdout.split('\n')[0], 'CODE NOT COMMITTED (--allow-uncommitted): research/stats.mjs is modified.');
  assert.deepEqual([results.code.allModulesCommitted, results.code.trackedFilesModified, results.code.researchModulesUntracked, results.code.problems,
    results.code.modules.filter(m => m.state !== 'committed').map(m => [m.file, m.state])], [false, true, false, ['research/stats.mjs is modified'], [['research/stats.mjs', 'modified']]]);
  assert.equal(results.code.modules.find(m => m.file === 'research/stats.mjs').sha256, sha256Hex(readFileSync(join(repo, 'research', 'stats.mjs'))), 'the hash is of the code that ran');
  assert.deepEqual({...results.deviations.find(d => d.option === 'allowUncommitted'), reason: null}, {option: 'allowUncommitted', value: true, default: false, reason: null,
    problems: ['research/stats.mjs is modified']});
  assert.ok(report.includes('every module that ran is committed at that commit: no; tracked files modified anywhere in the repository: yes; research modules untracked: no'));
  assert.ok(report.includes('| `research/stats.mjs` | `' + sha256Hex(readFileSync(join(repo, 'research', 'stats.mjs'))) + '` | modified |'));
  // research/calibration.json names the research/stats.mjs the protocol's tables were measured with, and that is no
  // longer the one that ran: the record says so, and so do the status block of RESULTS.md and the printed summary.
  const calibration = readFileSync(join(repo, 'research', 'calibration.json'));
  assert.deepEqual(results.calibration, {file: 'research/calibration.json', sha256: sha256Hex(calibration), statsSha256: JSON.parse(calibration).statsSha256,
    statsSha256ThatRan: sha256Hex(readFileSync(join(repo, 'research', 'stats.mjs'))), measuredWithTheStatsThatRan: false});
  const [note] = calibrationNote(results.calibration);
  assert.ok(note.startsWith('The protocol\'s tables were measured with another version of research/stats.mjs than the one that ran'));
  assert.ok(report.includes(`; the same: no. **${note}**\n`) && allowed.stdout.includes(`\n${note}\n`));

  // The protocol text is part of what the commit must name: its hash is in the record.
  appendFileSync(join(repo, 'research', 'PROTOCOL.md'), '\nA sentence added after the commit.\n');
  refused = run('--data', complete, ...target('g'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /The record could not name the code that ran: research\/stats\.mjs is modified; research\/PROTOCOL\.md is modified\./);

  const untracked = committedCopy({leaveUntracked: ['research/report.mjs']});
  refused = spawnSync(process.execPath, [untracked.study, '--workers', '0', '--data', complete, ...target('e')], {encoding: 'utf8', cwd: dir});
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /The record could not name the code that ran: research\/report\.mjs is untracked\./);
  allowed = spawnSync(process.execPath, [untracked.study, '--workers', '0', '--data', complete, ...target('e'), '--allow-uncommitted'], {encoding: 'utf8', cwd: dir});
  assert.equal(allowed.status, 0, allowed.stderr);
  [results] = read('e');
  assert.deepEqual([results.code.researchModulesUntracked, results.code.trackedFilesModified, results.code.problems], [true, false, ['research/report.mjs is untracked']]);
  // An engine.js that is not the engine at commit 6f6b693 is not the protocol's reference, committed or not.
  appendFileSync(join(untracked.repo, 'engine.js'), '\n// not the reference engine\n');
  refused = spawnSync(process.execPath, [untracked.study, '--workers', '0', '--data', complete, ...target('f')], {encoding: 'utf8', cwd: dir});
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /research\/report\.mjs is untracked; engine\.js is modified; engine\.js is not the engine at commit 6f6b693, the protocol's reference/);
});

test('timing of the dry run', t => {
  t.diagnostic(`scaled-down dry run (920 settings, 20 windows of 2 days): ${dryRunSeconds.toFixed(2)} s per run on average`);
});

// The whole protocol at full size, on a synthetic market as long as the exploration range: 74 windows of 28 days,
// 13,200 settings, 10,000 resamples. Opt-in, because it takes a minute or two on four free cores:
//   STUDY_FULL_DRY_RUN=1 node --test research/study.test.mjs
test('full-size dry run on a synthetic market (opt-in)', {skip: !process.env.STUDY_FULL_DRY_RUN}, async t => {
  const gaps = {missing: 0.004, gapRate: 0.0005, longGapRate: 0.00002};
  const market = syntheticMarket({seed: 11, start: EXPLORATION_FROM + MINUTE, minutes: (RESERVED_FROM - EXPLORATION_FROM) / MINUTE,
    BTC: gaps, LINK: {...gaps, missing: 0.008, gapRate: 0.001}});
  const dir = scratch(), {results, bytes, report} = await runStudy({market, out: dir, report: join(dir, 'RESULTS.md')});
  assert.deepEqual(results.deviations.map(d => d.option), ['market', 'out', 'report']);
  assert.deepEqual([results.windows.length, results.designGrid.settings, results.designGrid.designWindows], [74, 13200, 50]);
  assert.deepEqual(FAMILIES.map(f => results.families[f].settings), [3360, 3360, 3360, 2400, 720]);
  assert.equal(results.defaultSetting.perWindow.length, 74);
  assert.ok(results.nominees.length <= 5 && results.nominees.every(n => LABELS.includes(n.confirmation.label)));
  assert.ok(bytes < 2.5e6, `${bytes} bytes`);
  assert.match(report, /^> \*\*DRY RUN: this run did NOT use the complete exchange store\./);
  // At full size too, no label is printed without its buy-and-hold reading, and the comparison account has its row.
  assert.deepEqual([labelsAlone(report), labelsAlone(summaryText(results)), results.comparisonAccount.k], [[], [], results.nominees.length]);
  t.diagnostic(`full-size dry run: ${results.designGrid.simulations} design simulations in ${results.timing.steps.designGrid.toFixed(1)} s on ` +
    `${results.timing.workers} workers; scores and search-adjusted p-values ${results.timing.steps.scores.toFixed(1)} s; engine reruns ` +
    `${results.timing.steps.exactCheck.toFixed(1)} s; whole study ${results.timing.wallSeconds.toFixed(1)} s; exploration.json ${(bytes / 1e6).toFixed(2)} MB; ` +
    `nominees ${results.nominees.map(n => `${n.id} ${n.confirmation.labelWithReading}`).join(', ') || 'none'}`);
});
