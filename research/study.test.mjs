// The study runner (research/study.mjs) on a scaled-down protocol and SYNTHETIC markets: every step of
// research/PROTOCOL.md is driven before any real exploration data exists. Nothing here is market data and no
// number in this file says anything about real prices. Simulated cash only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccount} from '../engine.js';
import {MINUTE, DAY, ASSETS, PROTOCOL, protocolWindows, prepareWindow} from './windows.mjs';
import {simulate, simulateGrid} from './fastsim.mjs';
import {runEngine} from './engine-run.mjs';
import {syntheticMarket} from './synthetic.mjs';
import {mean, sampleSd, tStat, tTestGreaterP, ols, realityCheck, signTestPValue} from './stats.mjs';
import {FORMAT as STORE_FORMAT, EXPLORATION_FROM, RESERVED_FROM, manifestBounds, manifestPath, monthKey, monthPaths, sha256Hex} from './dataset.mjs';
import {FAMILIES, familySettings, allSettings, neighbours, DEFAULT_SETTING, COSTS} from './settings.mjs';
import {runStudy, summaryText, prepareWindows, runDesignGrid, scoreRows, scoreDesign, nominateFamily, confirmationLabel,
  compareExact, exactCheck, costHurdle, NO_ENGINE_REFERENCE} from './study.mjs';
import {gridTask, engineTask} from './study-worker.mjs';

const STUDY = fileURLToPath(new URL('./study.mjs', import.meta.url));
// Temporary directories are removed when the process ends, also when the file stops before any test has run.
const temporary = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'paper-trail-study-')); temporary.push(dir); return dir; };
process.on('exit', () => { for (const dir of temporary) rmSync(dir, {recursive: true, force: true}); });
const byId = Object.fromEntries(allSettings().map(setting => [setting.id, setting]));
const LABELS = ['confirmed at default costs', 'confirmed and cost-robust', 'not confirmed'];

// ---------------------------------------------------------------------------------------------------------------
// The scaled-down protocol: 12 windows of 2 days, 7 design + 5 confirmation, 920 of the 12,720 settings.
const FROM = Date.UTC(2021, 0, 1);
const SCALED = Object.freeze({from: FROM, windowDays: 2, windowCount: 12, designCount: 7, minSharedFraction: 0.9});
const WINDOWS = protocolWindows(SCALED);
const DESIGN = WINDOWS.filter(w => w.set === 'design'), CONFIRMATION = WINDOWS.filter(w => w.set === 'confirmation');
// One lookback x buffer plane or two per family: 60-minute horizon for P, H, R and L, 15 minutes for X.
const SEARCHED = allSettings().filter(s => (s.family === 'L' ? s.horizonMs === 60 * MINUTE && s.stopLossBps === 0
  : s.family === 'X' ? s.horizonMs === 15 * MINUTE && s.stopLossBps === 0
  : s.horizonMs === 60 * MINUTE && [0, 300].includes(s.stopLossBps)));

const without = (series, from, to) => {
  const rows = [...series.time.keys()].filter(i => series.time[i] < from || series.time[i] > to);
  return {time: Float64Array.from(rows, i => series.time[i]), close: Float64Array.from(rows, i => series.close[i])};
};
// A synthetic market shaped like the real store: its first close is one minute after the protocol's start (window
// 0's own first minute cannot exist, so no lookback setting has warmup there), a few minutes are missing, and
// LINK loses eight hours inside windows 3 (design) and 9 (confirmation), which puts both below the 90% floor.
// regimeDrift is the strength of four-hour trends; 0 makes a driftless random walk.
function scaledMarket(seed, regimeDrift) {
  const quiet = {missing: 0.004, gapRate: 0.0005, longGapRate: 0};
  const market = syntheticMarket({seed, start: FROM + MINUTE, minutes: SCALED.windowCount * SCALED.windowDays * 1440 - 1,
    regimeMinutes: 240, BTC: {...quiet, regimeDrift}, LINK: {...quiet, missing: 0.008, regimeDrift: regimeDrift * 1.5}});
  for (const index of [3, 9]) market.LINK = without(market.LINK, WINDOWS[index].start + 600 * MINUTE, WINDOWS[index].start + 1080 * MINUTE);
  return market;
}
const TREND = scaledMarket(1, 0.0002);
const dryRun = (workers, out = null, market = TREND) => runStudy({market, protocol: SCALED, settings: SEARCHED, resamples: 300, workers, out});

// The dry run, four times: twice on two workers (written to disk), once in this thread, once on four workers.
const started = performance.now();
const [A, B] = [await dryRun(2, scratch()), await dryRun(2, scratch())];
const [C, D] = [await dryRun(0), await dryRun(4)];
const dryRunSeconds = (performance.now() - started) / 4000;
const R = A.results;

test('the grid is the protocol table: 3,360 + 3,360 + 3,360 + 1,920 + 720 = 12,720 settings', () => {
  assert.deepEqual(FAMILIES.map(family => familySettings(family).length), [3360, 3360, 3360, 1920, 720]);
  const all = allSettings();
  assert.equal(all.length, 12720);
  assert.equal(new Set(all.map(s => s.id)).size, 12720, 'ids are unique');
  // The table, transcribed a second time. With unique ids and these counts, each family is the full product.
  const values = (family, key) => [...new Set(familySettings(family).map(s => s[key]))];
  const minutes = list => list.map(m => m * MINUTE);
  for (const family of ['P', 'H', 'R', 'X']) {
    assert.deepEqual(values(family, 'horizonMs'), minutes(family === 'X' ? [1, 5, 7, 15] : [1, 5, 7, 15, 60, 420, 1440]));
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
  assert.equal(new Set(all.map(s => JSON.stringify({...s, id: 0, grid: 0, family: 0}))).size, 12720, 'no two settings simulate the same rule');
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

test('every one of the 12,720 settings is accepted by the fast simulator', () => {
  const start = Date.UTC(2022, 5, 1), market = syntheticMarket({seed: 5, start, minutes: 3 * 1440, BTC: {longGapRate: 0}, LINK: {longGapRate: 0}});
  const prepared = prepareWindow(market, {start: start + DAY, end: start + 2 * DAY - MINUTE});
  const all = allSettings(), results = simulateGrid(market, prepared, all, COSTS.default);
  assert.equal(results.length, 12720);
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

test('neighbours: one grid step in lookback (span for L) or in buffer, same horizon, stop and switches', () => {
  const P = familySettings('P'), ids = (id, all) => neighbours(byId[id], all).map(s => s.id);
  assert.deepEqual(ids('P-h7-l7-b10-s0', P), ['P-h7-l5-b10-s0', 'P-h7-l7-b5-s0', 'P-h7-l7-b20-s0', 'P-h7-l10-b10-s0']);
  assert.deepEqual(ids('P-h1-l1-b0-s0', P), ['P-h1-l1-b5-s0', 'P-h1-l2-b0-s0'], 'a corner has two');
  assert.deepEqual(ids('R-h1440-l240-b320-s1000', familySettings('R')), ['R-h1440-l180-b320-s1000', 'R-h1440-l240-b160-s1000']);
  assert.deepEqual(ids('H-h60-l1-b40-s300', familySettings('H')), ['H-h60-l1-b20-s300', 'H-h60-l1-b80-s300', 'H-h60-l2-b40-s300'], 'a border has three');
  assert.deepEqual(ids('L-h420-span1440-b20-s300-hold1', familySettings('L')), ['L-h420-span720-b20-s300-hold1',
    'L-h420-span1440-b0-s300-hold1', 'L-h420-span1440-b80-s300-hold1', 'L-h420-span2880-b20-s300-hold1']);
  // Looked up among all settings at once: still the same family, horizon, stop and switches.
  assert.deepEqual(ids('P-h7-l7-b10-s0', allSettings()), ids('P-h7-l7-b10-s0', P));
  // Neighbours absent from the searched list are simply absent.
  assert.deepEqual(ids('P-h7-l7-b10-s0', P.filter(s => s.lookback !== 5 && s.bufferBps !== 20)), ['P-h7-l7-b5-s0', 'P-h7-l10-b10-s0']);
  assert.throws(() => neighbours({family: 'P', horizonMs: MINUTE}, P), /familySettings/);

  // Whole families: each plane of 15 lookbacks x 8 buffers has 14*8 + 15*7 = 217 neighbouring pairs, each L plane
  // of 10 spans x 4 buffers has 9*4 + 10*3 = 66; the relation is symmetric and never leaves its plane.
  for (const [family, pairs] of [['X', 16 * 217], ['L', 18 * 66]]) {
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
  const settings = familySettings('P').slice(0, 6), _ = NaN;
  const rows = scoreRows(settings,
    [[1, 2, 3, _, _, _], [1, -1, 0.5, 2, 0, _], [1, -1, 0.5, 2, 0, _], [0, 0, 0, 0, 0, 0], [_, _, _, _, _, _], [4, 4, 4, _, _, _]],
    [[2, 2, 0, 9, 9, 9], [2, 2, 2, 0, 0, 9], [2, 2, 0, 0, 0, 9], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [2, 2, 2, 0, 0, 0]]);
  // [1, 2, 3]: mean 2, sd 1, T = 2 / (1 / sqrt(3)); fills in 2 of its 3 valid windows.
  assert.deepEqual({...rows[0]}, {id: settings[0].id, family: 'P', n: 3, mean: 2, sd: 1, T: 2 / (1 / Math.sqrt(3)), traded: 2,
    eligible: true, sharePositive: 1, meanFills: 4 / 3});
  assert.deepEqual([rows[1].n, rows[1].traded, rows[1].eligible], [5, 3, true], '3 of 5 valid windows is at least half');
  assert.deepEqual([rows[2].n, rows[2].traded, rows[2].eligible], [5, 2, false], '2 of 5 is not');
  assert.equal(rows[1].T, tStat([1, -1, 0.5, 2, 0]));
  assert.equal(rows[1].sharePositive, 3 / 5);
  // A setting that never trades returns exactly zero: T is 0 and it is not eligible.
  assert.deepEqual([rows[3].mean, rows[3].sd, rows[3].T, rows[3].eligible], [0, 0, 0, false]);
  // No valid window at all: vacuously eligible, T 0, no mean (so it can never be nominated).
  assert.deepEqual([rows[4].n, rows[4].T, rows[4].eligible, Number.isNaN(rows[4].mean)], [0, 0, true, true]);
  // Identical returns: sd is exactly 0, so T is 0 by the protocol's convention although the mean is positive.
  assert.deepEqual([rows[5].mean, rows[5].sd, rows[5].T], [4, 0, 0]);

  // Exactly half counts as "at least half".
  const half = scoreRows(settings.slice(0, 1), [[1, 2, 3, 4]], [[1, 1, 0, 0]])[0];
  assert.deepEqual([half.traded, half.eligible], [2, true]);
});

// A score table for family P in which every setting is ineligible with T 0 and mean 0 unless listed.
function table(entries) {
  const P = familySettings('P'), scores = new Map(P.map(s => [s.id, {eligible: false, T: 0, mean: 0}]));
  for (const [id, T, meanReturn, eligible = true] of entries) {
    assert.ok(scores.has(id), id);
    scores.set(id, {eligible, T, mean: meanReturn});
  }
  return [P, scores];
}

test('nomination on hand-built score tables', () => {
  // The best eligible setting qualifies: mean > 0 and its four neighbours' T (-1, 0.5, 1, 2) have median 0.75.
  // Neighbours count whether or not they are eligible.
  let result = nominateFamily(...table([['P-h60-l30-b20-s0', 3, 0.5], ['P-h60-l20-b20-s0', 1, 1, false], ['P-h60-l45-b20-s0', 2, 1, false],
    ['P-h60-l30-b10-s0', -1, -1], ['P-h60-l30-b40-s0', 0.5, 1]]));
  assert.equal(result.nominee.id, 'P-h60-l30-b20-s0');
  assert.deepEqual(result.considered, [{rank: 1, id: 'P-h60-l30-b20-s0', T: 3, mean: 0.5, neighbourMedianT: 0.75, qualifies: true, reason: 'nominee',
    neighbours: [{id: 'P-h60-l20-b20-s0', T: 1}, {id: 'P-h60-l30-b10-s0', T: -1}, {id: 'P-h60-l30-b40-s0', T: 0.5}, {id: 'P-h60-l45-b20-s0', T: 2}]}]);

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

  // A median of exactly 0 is not "above 0" (here: neighbours that never trade), and an ineligible setting is
  // never a candidate however high its T.
  result = nominateFamily(...table([['P-h60-l30-b20-s0', 3, 0.5], ['P-h7-l7-b10-s0', 50, 5, false]]));
  assert.equal(result.nominee, null);
  assert.deepEqual(result.considered.map(c => [c.id, c.neighbourMedianT, c.qualifies]), [['P-h60-l30-b20-s0', 0, false]]);

  // Ties in T go to the earlier setting in enumeration order.
  const near = id => [-1, 1].flatMap(step => [[id.replace('-l30-', step < 0 ? '-l20-' : '-l45-'), 1, 1, false],
    [id.replace('-b20-', step < 0 ? '-b10-' : '-b40-'), 1, 1, false]]);
  result = nominateFamily(...table([['P-h60-l30-b20-s0', 2, 1], ...near('P-h60-l30-b20-s0'), ['P-h15-l30-b20-s0', 2, 1], ...near('P-h15-l30-b20-s0')]));
  assert.equal(result.nominee.id, 'P-h15-l30-b20-s0');

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
  assert.deepEqual(nominateFamily(...table([])), {nominee: null, considered: []});
});

test('confirmation labels on hand-built return vectors', () => {
  const r = [1, 2, 3, 4];   // mean 2.5, t = 3.873 on 3 degrees of freedom, one-sided p = 0.015233
  assert.ok(Math.abs(tTestGreaterP(r) - 0.015233146) < 1e-9);
  const label = (r, rFee10, k) => confirmationLabel({r, rFee10, k}).label;
  assert.equal(label(r, [0.5, 1, 1.5, 2], 1), 'confirmed and cost-robust');
  assert.equal(label(r, [-1, -0.5, 0.2, 0.1], 1), 'confirmed at default costs', 'feeBps 10 mean is -0.3');
  assert.equal(label(r, [0, 0, 0, 0], 1), 'confirmed at default costs', 'a feeBps 10 mean of exactly 0 is not above 0');
  // The bar is 0.05 / k: 0.015233 passes 0.0167 (k = 3) and fails 0.0125 (k = 4) and 0.01 (k = 5).
  assert.equal(label(r, [0.5, 1, 1.5, 2], 3), 'confirmed and cost-robust');
  assert.equal(label(r, [0.5, 1, 1.5, 2], 4), 'not confirmed');
  assert.equal(label(r, [0.5, 1, 1.5, 2], 5), 'not confirmed');
  assert.deepEqual(confirmationLabel({r, rFee10: [0.5, 1, 1.5, 2], k: 4}),
    {label: 'not confirmed', mean: 2.5, p: tTestGreaterP(r), threshold: 0.0125, meanFee10: 1.25});
  // A positive mean that is not significant, a negative mean, and a negative mean with a positive feeBps 10 rerun.
  assert.equal(label([5, -4, 6, -3], [5, -4, 6, -3], 1), 'not confirmed');
  assert.equal(label([-1, -2, -3, -4], [-1, -2, -3, -4], 1), 'not confirmed');
  assert.equal(label([-1, -2, -3, -4], [1, 2, 3, 4], 1), 'not confirmed');
  // One window, or none, shows nothing.
  assert.equal(label([5], [5], 1), 'not confirmed');
  assert.equal(label([], [], 1), 'not confirmed');
  assert.throws(() => confirmationLabel({r, rFee10: r, k: 0}), /number of nominees/);
  assert.throws(() => confirmationLabel({r, rFee10: r, k: 6}), /number of nominees/);
});

test('the design grid refuses anything that is not a design window of the protocol', async () => {
  const run = designWindows => runDesignGrid({market: TREND, designWindows, settings: SEARCHED.slice(0, 3), protocol: SCALED, workers: 0});
  await assert.rejects(run([CONFIRMATION[0]]), /design windows only: window 7 \(confirmation\) is refused/);
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
  assert.deepEqual(R.designGrid.audit.windowsSimulated, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(Date.parse(R.designGrid.audit.lastCloseVisibleToTheGrid) <= Date.parse(R.designGrid.audit.lastDesignClose));
  assert.ok(Date.parse(R.designGrid.audit.lastDesignClose) < Date.parse(R.designGrid.audit.firstConfirmationClose));
  // A confirmation window prepared on what the grid can see holds no minute at all.
  const visible = Object.fromEntries(ASSETS.map(asset => [asset, without(TREND[asset], lastDesignClose + 1, Infinity)]));
  assert.equal(prepareWindow(visible, CONFIRMATION[0], SCALED).shared, 0);
});

test('an error inside a worker thread stops the grid instead of hanging it', async () => {
  const broken = [{...SEARCHED[0], bufferBps: -5}];
  await assert.rejects(runDesignGrid({market: TREND, designWindows: DESIGN, settings: broken, protocol: SCALED, workers: 2}), /Invalid bufferBps/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, settings: broken, out: null}), /Not a setting of the protocol's grid/);
  await assert.rejects(runStudy({market: TREND, protocol: SCALED, settings: [SEARCHED[0], SEARCHED[0]], out: null}), /twice/);
  await assert.rejects(runStudy({market: TREND, limitPerFamily: 3}), /Unknown option: limitPerFamily/);
});

test('dry run: determinism, and the worker count does not change a result', () => {
  // Two runs with the same options write the same file, apart from the timing line and the code line (git state
  // belongs to the working tree, which other work may touch between two runs; it is checked below).
  const stable = path => readFileSync(path, 'utf8').split('\n').filter(line => !/^"(timing|code)": /.test(line)).join('\n');
  assert.equal(stable(A.path), stable(B.path));
  assert.deepEqual(JSON.parse(readFileSync(A.path, 'utf8')), A.results, 'what is returned is what is written');
  assert.equal(readFileSync(A.path).length, A.bytes);
  // Zero workers (this thread), two and four: identical apart from timing and the recorded worker option.
  const core = ({results}) => ({...results, timing: null, code: null, deviations: results.deviations.filter(d => !['workers', 'out'].includes(d.option))});
  assert.deepEqual(core(C), core(A));
  assert.deepEqual(core(D), core(A));
  assert.deepEqual([A, C, D].map(run => run.results.deviations.find(d => d.option === 'workers')?.value), [2, 0, undefined]);
  assert.deepEqual([A, C, D].map(run => run.results.timing.workers), [2, 0, 4]);
});

test('dry run: every step leaves its part of the record', () => {
  assert.equal(R.format, 'paper-trail-exploration-v1');
  assert.match(R.status, /Exploration, not evidence/);
  assert.ok(A.bytes < 2e6);
  // Every non-default option is a recorded deviation; a path outside the working directory is not written down.
  assert.deepEqual(R.deviations.map(d => d.option), ['market', 'out', 'workers', 'resamples', 'protocol', 'settings']);
  assert.deepEqual(R.deviations.find(d => d.option === 'out'), {option: 'out', value: '(a path outside the working directory; not recorded)', default: 'research/results'});
  assert.deepEqual(R.deviations.find(d => d.option === 'settings').value.perFamily, {P: 240, H: 240, R: 240, X: 120, L: 80});
  assert.deepEqual(R.deviations.find(d => d.option === 'protocol').value, {...SCALED, from: '2021-01-01T00:00:00.000Z'});
  assert.match(R.data.source, /NOT the candle store/);
  assert.equal(R.data.manifestSha256, null);
  assert.match(R.protocol.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(R.protocol.realityCheck.resamples, 300);
  assert.ok(R.code.commit === null || /^[0-9a-f]{40}$/.test(R.code.commit));
  assert.ok([true, false, null].includes(R.code.dirty));
  assert.ok(R.timing.wallSeconds > 0 && Object.keys(R.timing.steps).length === 8);

  // Step 1: coverage of all 12 windows; windows 3 and 9 are below the floor for every setting.
  assert.equal(R.windows.length, 12);
  for (const w of R.windows) {
    assert.equal(w.expected, 2880);
    assert.deepEqual([w.missing.BTC, w.missing.LINK, w.missingShared], [2880 - w.observed.BTC, 2880 - w.observed.LINK, 2880 - w.shared]);
    assert.ok(w.shared <= Math.min(w.observed.BTC, w.observed.LINK) && w.sharedFraction === w.shared / 2880);
    assert.equal(w.valid, w.sharedFraction >= 0.9);
  }
  assert.equal(R.windows[0].scoreStart, '2021-01-01T00:01:00.000Z', 'window 0 starts at the first close that can exist');
  assert.deepEqual(R.invalidWindows.map(w => [w.index, w.set, w.reason]),
    [[3, 'design', 'insufficient shared coverage'], [9, 'confirmation', 'insufficient shared coverage']]);

  // Step 2: 920 settings on the six valid design windows, less the 840 lookback settings refused on window 0.
  assert.deepEqual([R.designGrid.settings, R.designGrid.designWindows, R.designGrid.validDesignWindows, R.designGrid.simulations],
    [920, 7, 6, 6 * 920 - 840]);
  assert.deepEqual(Object.keys(R.families), FAMILIES);
  assert.deepEqual(FAMILIES.map(f => R.families[f].refusedForWarmup), [{0: 240}, {0: 240}, {0: 240}, {0: 120}, {}]);

  // Step 3: per family and pooled.
  let eligible = 0, positive = 0, best = -Infinity;
  for (const family of FAMILIES) {
    const f = R.families[family], members = SEARCHED.filter(s => s.family === family);
    assert.deepEqual(f.scores.ids, members.map(s => s.id));
    const isEligible = f.scores.ids.map((_, i) => 2 * f.scores.windowsWithFills[i] >= f.scores.n[i]);
    assert.deepEqual([f.settings, f.eligible, f.positiveMean], [members.length, isEligible.filter(Boolean).length, f.scores.mean.filter(m => m > 0).length]);
    assert.ok(f.scores.n.every(n => n === (family === 'L' ? 6 : 5)), 'lookback families lose window 0 to the warmup rule');
    assert.equal(f.bestT, Math.max(...f.scores.T.filter((_, i) => isEligible[i])));
    assert.ok(f.realityCheck.p >= 0 && f.realityCheck.p <= 1 && f.realityCheck.resamples === 300 && f.realityCheck.windowsResampled === 7);
    // The 20 highest-scoring eligible settings, in descending T.
    assert.equal(f.top.length, Math.min(20, f.eligible));
    assert.deepEqual([f.top[0].id, f.top[0].T], [f.bestId, f.bestT]);
    f.top.forEach((row, i) => {
      assert.ok(i === 0 || row.T <= f.top[i - 1].T);
      assert.ok(2 * row.windowsWithFills >= row.n && Number.isFinite(row.mean + row.sd + row.sharePositive + row.meanFills));
      assert.equal(row.T, f.scores.T[f.scores.ids.indexOf(row.id)]);
    });
    eligible += f.eligible; positive += f.positiveMean; best = Math.max(best, f.bestT);
  }
  assert.deepEqual([R.pooled.settings, R.pooled.eligible, R.pooled.positiveMean, R.pooled.bestT], [920, eligible, positive, best]);
  // One family's best setting again, by a path that shares nothing with the grid: simulate() window by window.
  const runs = DESIGN.map(w => prepareWindow(TREND, w, SCALED)).filter(p => p.valid)
    .map(p => simulate(TREND, p, byId[R.families.P.bestId], COSTS.default)).filter(r => r.valid);
  const again = runs.map(r => r.returnPct), first = R.families.P.top[0];
  assert.deepEqual([again.length, mean(again), sampleSd(again), tStat(again)], [first.n, first.mean, first.sd, R.families.P.bestT]);
  assert.deepEqual([mean(runs.map(r => r.fills)), runs.filter(r => r.fills > 0).length, again.filter(r => r > 0).length / again.length],
    [first.meanFills, first.windowsWithFills, first.sharePositive]);

  // Step 4: the recorded nominee of each family is what the nomination rule gives on the recorded score table.
  for (const family of FAMILIES) {
    const f = R.families[family], members = SEARCHED.filter(s => s.family === family);
    const scores = new Map(f.scores.ids.map((id, i) => [id, {eligible: 2 * f.scores.windowsWithFills[i] >= f.scores.n[i], T: f.scores.T[i], mean: f.scores.mean[i]}]));
    const again = nominateFamily(members, scores);
    assert.equal(f.nomination.nominee, again.nominee?.id ?? null);
    assert.deepEqual(f.nomination.considered, JSON.parse(JSON.stringify(again.considered)));
    assert.ok(f.nomination.considered.length <= 10);
  }
  // On this market: trend following is nominated in P, H, X and L; the reversed rule has no positive mean among
  // its ten best and nominates nothing.
  assert.deepEqual(R.nominees.map(n => n.family), ['P', 'H', 'X', 'L']);
  assert.equal(R.families.R.nomination.nominee, null);
  assert.equal(R.families.R.nomination.considered.length, 10);
  assert.ok(R.families.R.nomination.considered.every(c => !c.qualifies));

  // Step 5: confirmation, nominees only, on the four valid confirmation windows.
  for (const nominee of R.nominees) {
    const c = nominee.confirmation, r = c.perWindow.map(w => w.r);
    assert.deepEqual(nominee.setting, JSON.parse(JSON.stringify(byId[nominee.id])));
    assert.deepEqual(c.perWindow.map(w => w.index), [7, 8, 10, 11]);
    assert.deepEqual([c.k, c.threshold, c.n], [4, 0.05 / 4, 4]);
    assert.deepEqual({label: c.label, mean: c.mean, p: c.p, threshold: c.threshold, meanFee10: c.meanFee10},
      confirmationLabel({r, rFee10: c.perWindow.map(w => w.rFee10), k: 4}));
    assert.ok(LABELS.includes(c.label));
    assert.deepEqual([c.mean, c.sd, c.T, c.p], [mean(r), sampleSd(r), tStat(r), tTestGreaterP(r)]);
    assert.equal(c.sharePositive, r.filter(v => v > 0).length / 4);
    assert.deepEqual(c.worst, {index: c.perWindow[r.indexOf(Math.min(...r))].index, r: Math.min(...r)});
    assert.deepEqual([c.meanFills, c.meanFees], [mean(c.perWindow.map(w => w.fills)), mean(c.perWindow.map(w => w.fees))]);
    assert.deepEqual([c.fee10.mean, c.fee40.mean], [mean(c.perWindow.map(w => w.rFee10)), mean(c.perWindow.map(w => w.rFee40))]);
    // r regressed on b (not the other way round), and the comparison account's own mean.
    assert.deepEqual(c.regression, JSON.parse(JSON.stringify(ols(r, c.perWindow.map(w => w.b)))));
    assert.ok(c.regression.n === 4 && Number.isFinite(c.regression.intercept + c.regression.slope));
    assert.equal(c.meanComparison, mean(c.perWindow.map(w => w.b)));
    for (const asset of ASSETS) {
      const d = c.direction[asset];
      assert.deepEqual([d.hits, d.misses, d.flat], [0, 1, 2].map(at => c.perWindow.reduce((sum, w) => sum + w.direction[asset][at], 0)));
      assert.ok(d.hits + d.misses > 0 && d.signTestP === signTestPValue(d.hits, d.misses) && d.hitRate === d.hits / (d.hits + d.misses));
    }
    // The design side of the nominee: its rank among the ten, its neighbours, its windows.
    assert.equal(nominee.design.perWindow.length, 7);
    assert.deepEqual(nominee.design.perWindow.filter(w => w.r === null).map(w => w.index), nominee.family === 'L' ? [3] : [0, 3]);
    assert.ok(nominee.design.mean > 0 && nominee.design.neighbourMedianT > 0 && nominee.design.rank >= 1 && nominee.design.rank <= 10);
    // A confirmation window run again here with the plain simulator gives the recorded return.
    const p = prepareWindow(TREND, WINDOWS[10], SCALED), w = c.perWindow.find(row => row.index === 10);
    const plain = simulate(TREND, p, byId[nominee.id], COSTS.default);
    assert.deepEqual([plain.returnPct, plain.buyHoldReturnPct, plain.fills, plain.fees, plain.stops], [w.r, w.b, w.fills, w.fees, w.stops]);
    for (const asset of ASSETS)
      assert.deepEqual(w.direction[asset], [plain.perAsset[asset].directionHits, plain.perAsset[asset].directionMisses, plain.perAsset[asset].directionFlat]);
    assert.equal(simulate(TREND, p, byId[nominee.id], COSTS.fee10).returnPct, w.rFee10);
    assert.equal(simulate(TREND, p, byId[nominee.id], COSTS.fee40).returnPct, w.rFee40);
  }
  const labels = Object.fromEntries(R.nominees.map(n => [n.family, n.confirmation.label]));
  assert.deepEqual(labels, {P: 'confirmed and cost-robust', H: 'confirmed and cost-robust', X: 'not confirmed', L: 'not confirmed'});

  // Step 6: P through the engine, X through the engine's crafted-history emulation, hold-through without one.
  const exact = Object.fromEntries(R.nominees.map(n => [n.family, n.exactCheck]));
  assert.deepEqual({...exact.P, maxRelativeDifference: 0}, {id: exact.P.id, reference: 'unmodified engine', tolerance: 1e-9, windowsCompared: 9,
    windowsRefusedByBoth: 1, maxRelativeDifference: 0, fillsEqual: true});
  assert.match(exact.X.reference, /crafted-history emulation/);
  assert.deepEqual([exact.X.windowsCompared, exact.X.windowsRefusedByBoth], [9, 1]);
  assert.ok(exact.P.maxRelativeDifference <= 1e-9 && exact.X.maxRelativeDifference <= 1e-9);
  for (const family of ['H', 'L']) {
    assert.equal(byId[exact[family].id].holdThrough, true);
    assert.deepEqual(exact[family], {id: exact[family].id, reference: null, note: 'no engine reference; covered by the hold-through oracle test'});
  }

  // Step 7: the default setting on all 12 windows, and the cost hurdle.
  const d = R.defaultSetting, ran = d.perWindow.filter(w => w.invalid === undefined);
  assert.equal(d.id, 'P-h7-l7-b10-s0');
  assert.deepEqual(d.perWindow.filter(w => w.invalid !== undefined).map(w => [w.index, w.invalid]),
    [[0, 'insufficient warmup'], [3, 'insufficient shared coverage'], [9, 'insufficient shared coverage']]);
  assert.deepEqual([d.n, d.mean, d.sharePositive], [9, mean(ran.map(w => w.r)), ran.filter(w => w.r > 0).length / 9]);
  assert.deepEqual([d.design.n, d.confirmation.n], [5, 4]);
  for (const index of [1, 8]) {   // one design and one confirmation window, run again here at default costs
    const plain = simulate(TREND, prepareWindow(TREND, WINDOWS[index], SCALED), DEFAULT_SETTING, COSTS.default);
    assert.deepEqual(d.perWindow[index], {index, set: WINDOWS[index].set, r: plain.returnPct, b: plain.buyHoldReturnPct, fills: plain.fills});
  }
  assert.ok(ran.every(w => Number.isFinite(w.r) && Number.isFinite(w.b)) && ran.some(w => w.fills > 0));
  assert.deepEqual(R.costHurdle.roundTripBps, {default: 14, fee10: 30, fee40: 90});
  assert.deepEqual(R.costHurdle.horizons.map(h => h.horizonMinutes), [1, 5, 7, 15, 60, 420, 1440]);
  assert.equal(R.costHurdle.windows, 10);
  for (const h of R.costHurdle.horizons) for (const asset of ASSETS)
    assert.ok(h[asset].minutes > 20000 && h[asset].medianAbsLogMoveBps > 0 && h[asset].shareOfDefaultRoundTrip === h[asset].medianAbsLogMoveBps / 14);

  // The plain summary: says what it is, names every nominee with its label, makes no claim.
  const text = summaryText(R, A);
  assert.match(text, /Exploration, not evidence/);
  assert.match(text, /DRY RUN: this run did not read the candle store/);
  for (const nominee of R.nominees) assert.ok(text.includes(`${nominee.id}:`) && text.includes(nominee.confirmation.label.toUpperCase()));
  // Neither the summary nor the record uses the two words the repository reserves for claims it does not make,
  // nor anything that looks like an address.
  const reserved = new RegExp(`\\b(${['ed' + 'ge', 'al' + 'pha'].join('|')})\\b`, 'i');
  for (const written of [text, readFileSync(A.path, 'utf8')]) {
    assert.doesNotMatch(written, reserved);
    assert.doesNotMatch(written, /@/);
  }
});

test('the exact check: settings of P, R, X and L agree with the engine, and a planted difference fails loudly', async () => {
  const picks = ['P-h60-l30-b10-s300', 'R-h60-l7-b0-s0', 'X-h15-l10-b0-s0', 'L-h60-span240-b0-s0-hold0', 'H-h60-l30-b10-s0'].map(id => byId[id]);
  const windows = WINDOWS.slice(4, 9), expected = new Map();   // three design windows and two confirmation windows
  for (const setting of picks) for (const window of windows) {
    const prepared = prepareWindow(TREND, window, SCALED);
    if (!prepared.valid) continue;
    const r = simulate(TREND, prepared, setting, COSTS.default, {detail: window.set === 'confirmation'});
    expected.set(`${setting.id}|${window.index}`, {r: r.returnPct, fills: r.fills});
  }
  const checks = await exactCheck({market: TREND, windows, nominees: picks, expected, protocol: SCALED, workers: 2});
  assert.deepEqual(checks.map(c => [c.id, c.reference?.split(',')[0] ?? c.note, c.windowsCompared]), [
    ['P-h60-l30-b10-s300', 'unmodified engine', 5], ['R-h60-l7-b0-s0', 'unmodified engine', 5], ['X-h15-l10-b0-s0', 'unmodified engine', 5],
    ['L-h60-span240-b0-s0-hold0', 'unmodified engine', 5], ['H-h60-l30-b10-s0', NO_ENGINE_REFERENCE, undefined]]);
  assert.ok(checks.slice(0, 4).every(c => c.maxRelativeDifference <= 1e-9 && c.fillsEqual));
  assert.ok([...expected.values()].filter(v => v.fills > 0).length > 15, 'the compared runs traded');
  assert.deepEqual(await exactCheck({market: TREND, windows, nominees: picks, expected, protocol: SCALED, workers: 0}), checks);

  // The engine side of each comparison is the engine itself (research/engine-run.mjs), not a second fast run:
  // the same numbers as runEngine called here, and its refusal of hold-through, which the fast simulator runs.
  const context = {market: TREND, protocol: SCALED}, window = WINDOWS[5], prepared = prepareWindow(TREND, window, SCALED);
  const engine = runEngine(TREND, prepared, picks[0], COSTS.default), fast = simulate(TREND, prepared, picks[0], COSTS.default);
  assert.deepEqual(engineTask(context, {window, setting: picks[0], costs: COSTS.default}), {index: 5, windowValid: true,
    fast: {valid: true, finalValue: fast.finalValue, returnPct: fast.returnPct, fills: fast.fills},
    engine: {valid: true, finalValue: engine.finalValue, returnPct: engine.returnPct, fills: engine.fills}});
  assert.ok(engine.fills > 0);
  assert.throws(() => engineTask(context, {window, setting: picks[4], costs: COSTS.default}), /holdThrough is not supported by runEngine/);
  assert.deepEqual(engineTask(context, {window: WINDOWS[3], setting: picks[0], costs: COSTS.default}), {index: 3, windowValid: false});

  // A recorded value that is not what the simulators give stops the study.
  const key = 'P-h60-l30-b10-s300|6', tampered = new Map(expected).set(key, {...expected.get(key), r: expected.get(key).r + 1e-7});
  await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: tampered, protocol: SCALED, workers: 0}),
    /Exact check FAILED.*P-h60-l30-b10-s300, window 6: a fresh fast simulation differs/);
  const miscounted = new Map(expected).set(key, {...expected.get(key), fills: expected.get(key).fills + 1});
  await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: miscounted, protocol: SCALED, workers: 2}), /Exact check FAILED/);
  const missing = new Map(expected); missing.delete(key);
  await assert.rejects(exactCheck({market: TREND, windows, nominees: picks, expected: missing, protocol: SCALED, workers: 0}), /window validity differs/);

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

test('the reality check sees every design window as a column, the invalid one included', () => {
  const grid = {settings: SEARCHED.slice(0, 2), returns: [[1, -2, NaN, 3, -1, 2, 0.5], [NaN, NaN, NaN, NaN, NaN, NaN, NaN]],
    fills: [[2, 2, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0]]};
  const scored = scoreDesign({...grid, resamples: 200});
  assert.deepEqual([scored.pooled.settings, scored.pooled.withValidWindows, scored.pooled.eligible, scored.pooled.bestId],
    [2, 1, 2, SEARCHED[0].id]);
  assert.deepEqual(scored.pooled.realityCheck, {p: scored.families.P.realityCheck.p, resamples: 200, seed: 20261118, windowsResampled: 7});
  assert.equal(scored.pooled.bestT, tStat([1, -2, 3, -1, 2, 0.5]));
  assert.ok(scored.pooled.realityCheck.p > 0.05 && scored.pooled.realityCheck.p < 0.6, `p = ${scored.pooled.realityCheck.p}`);

  // Only eligible settings are searched: a third setting with the highest T of all but fills in too few windows
  // changes neither the best T nor its p-value.
  const more = {settings: SEARCHED.slice(0, 3), returns: [...grid.returns, [5, 5.1, NaN, 5.2, 5, 5.1, 5.3]], fills: [...grid.fills, [2, 0, 0, 0, 2, 0, 0]]};
  const wider = scoreDesign({...more, resamples: 200});
  assert.deepEqual(wider.rows.map(row => [row.eligible, row.T > scored.pooled.bestT]), [[true, false], [true, false], [false, true]]);
  assert.deepEqual([wider.pooled.eligible, wider.pooled.bestId, wider.pooled.bestT, wider.pooled.realityCheck.p],
    [2, SEARCHED[0].id, scored.pooled.bestT, scored.pooled.realityCheck.p]);
  assert.equal(wider.pooled.realityCheck.p, realityCheck({returns: more.returns, eligible: [0, 1], resamples: 200}).p);
  assert.notEqual(wider.pooled.realityCheck.p, realityCheck({returns: more.returns, eligible: [0, 1, 2], resamples: 200}).p);
});

test('RANDOM-WALK CONTROL: on driftless markets the pipeline labels no nominee confirmed', async () => {
  // No rule can predict a driftless random walk, and every trade costs about 14 bps a round trip. The search still
  // turns up settings whose design mean happens to be positive (that is what a search does); the one look at the
  // confirmation windows must not confirm any of them. Fixed seeds: by construction a false confirmation has at
  // most a 5% chance per study, so one appearing under another seed would not by itself be a defect.
  const outcomes = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const {results} = await runStudy({market: scaledMarket(seed, 0), protocol: SCALED, settings: SEARCHED, resamples: 200, workers: 0, out: null});
    assert.ok(results.pooled.eligible > 500, 'the searched settings do trade');
    for (const nominee of results.nominees) {
      assert.equal(nominee.confirmation.label, 'not confirmed', `seed ${seed}: ${nominee.id}`);
      assert.ok(nominee.exactCheck.reference || nominee.exactCheck.note);
      outcomes.push(`seed ${seed} ${nominee.id}: design mean ${nominee.design.mean.toFixed(2)}%, confirmation mean ${nominee.confirmation.mean.toFixed(2)}%, p ${nominee.confirmation.p.toFixed(3)}`);
    }
  }
  // The control is not vacuous: the search did nominate, and those nominees did not hold up.
  assert.ok(outcomes.length >= 5, outcomes.join('\n'));
});

// A candle store in the on-disk format of research/dataset.mjs (what research/fetch-candles.mjs writes), filled
// from a synthetic market: one .f64 file per asset and UTC month of the bucket start, and the manifest.
function writeStore(dir, market) {
  const assets = {};
  for (const asset of ASSETS) {
    const {time, close} = market[asset], months = new Map();
    time.forEach((t, i) => { const key = monthKey(t - MINUTE); if (!months.has(key)) months.set(key, []); months.get(key).push(i); });
    assets[asset] = {months: Object.fromEntries([...months].map(([month, rows]) => {
      const bytes = Buffer.alloc(rows.length * 48);
      rows.forEach((i, at) => [time[i], close[i], close[i], close[i], close[i], 1].forEach((value, k) => bytes.writeDoubleLE(value, at * 48 + k * 8)));
      const path = monthPaths(dir, asset, month).candles;
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, bytes);
      return [month, {rows: rows.length, firstClose: time[rows[0]], lastClose: time[rows.at(-1)], sha256: sha256Hex(bytes), requests: 0,
        fetchedAt: '2026-01-01T00:00:00.000Z', complete: true}];
    }))};
  }
  writeFileSync(manifestPath(dir), JSON.stringify({format: STORE_FORMAT, source: 'synthetic test store', bounds: manifestBounds(), assets}));
}

test('the command line: one command from a candle store to exploration.json, and plain refusals', () => {
  const run = (...args) => spawnSync(process.execPath, [STUDY, ...args], {encoding: 'utf8'});
  assert.deepEqual([run('--help').status, run('--help').stdout.trim()], [0, 'Usage: node research/study.mjs [--data .research-data] [--out research/results] [--workers 4]']);
  for (const bad of [['--from', '2026-01-01'], ['--workers'], ['--limit', '3']]) {
    const refused = run(...bad);
    assert.deepEqual([refused.status, refused.stdout], [1, '']);
    assert.match(refused.stderr, /Unknown or incomplete argument/);
  }
  const empty = scratch(), nowhere = join(scratch(), 'results');
  const failed = run('--data', empty, '--out', nowhere, '--workers', '1');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Study failed: .*no manifest; fetch with research\/fetch-candles\.mjs first/);
  assert.throws(() => readFileSync(join(nowhere, 'exploration.json')), /ENOENT/);

  // A store that holds only the first 56 days of the exploration range (synthetic prices). The full protocol
  // runs on it: 74 windows, 12,720 settings; windows 0 and 1 are valid, the other 72 have no data at all.
  const store = scratch(), out = join(scratch(), 'results');
  const few = {missing: 0.004, gapRate: 0.0005, longGapRate: 0};
  writeStore(store, syntheticMarket({seed: 9, start: EXPLORATION_FROM + MINUTE, minutes: 56 * 1440 - 1, BTC: few, LINK: few}));
  const done = run('--data', store, '--out', out, '--workers', '2');
  assert.equal(done.status, 0, done.stderr);
  const results = JSON.parse(readFileSync(join(out, 'exploration.json'), 'utf8'));
  assert.match(done.stdout, /^Exploration study: simulated cash only\. Exploration, not evidence\.\nCode /);
  assert.doesNotMatch(done.stdout, /DRY RUN/);
  assert.match(done.stdout, /Deviations: data, out, workers\n/);
  assert.deepEqual(results.deviations.map(d => [d.option, d.value]), [['data', '(a path outside the working directory; not recorded)'],
    ['out', '(a path outside the working directory; not recorded)'], ['workers', 2]]);
  assert.equal(results.data.manifestSha256, sha256Hex(readFileSync(manifestPath(store))));
  assert.deepEqual(Object.keys(results.data.manifest.assets.BTC.months), ['2020-01', '2020-02']);
  assert.equal(results.data.firstClose.BTC, '2020-01-01T00:01:00.000Z');
  assert.deepEqual(results.protocol.windows, {...PROTOCOL, from: '2020-01-01T00:00:00.000Z'});
  assert.deepEqual([results.windows.length, results.windows.filter(w => w.set === 'design').length, results.windows.filter(w => w.valid).map(w => w.index)],
    [74, 50, [0, 1]]);
  assert.deepEqual(results.invalidWindows.slice(0, 2).map(w => [w.index, w.reason]), [[2, 'fewer than 2 shared minutes'], [3, 'fewer than 2 shared minutes']]);
  assert.deepEqual([results.designGrid.settings, results.designGrid.designWindows, results.designGrid.validDesignWindows], [12720, 50, 2]);
  // Window 0 has no warmup inside the range: every lookback setting is refused there, family L runs.
  assert.deepEqual(FAMILIES.map(f => [results.families[f].settings, results.families[f].refusedForWarmup]),
    [[3360, {0: 3360}], [3360, {0: 3360}], [3360, {0: 3360}], [1920, {0: 1920}], [720, {}]]);
  assert.equal(results.designGrid.simulations, 12720 + 720);
  assert.ok(results.families.P.scores.n.every(n => n === 1) && results.families.L.scores.n.every(n => n === 2));
  // With one valid window T is 0 for every lookback setting, so nothing there can be nominated; whatever family L
  // nominates meets no valid confirmation window and cannot be confirmed.
  assert.deepEqual(['P', 'H', 'R', 'X'].map(f => [results.families[f].bestT, results.families[f].nomination.nominee]), Array(4).fill([0, null]));
  for (const nominee of results.nominees) {
    assert.deepEqual([nominee.family, nominee.confirmation.n, nominee.confirmation.mean, nominee.confirmation.label], ['L', 0, null, 'not confirmed']);
    assert.ok(nominee.exactCheck.note === NO_ENGINE_REFERENCE || nominee.exactCheck.windowsCompared === 2);
  }
  assert.deepEqual([results.defaultSetting.n, results.defaultSetting.perWindow.length, results.defaultSetting.perWindow[0].invalid], [1, 74, 'insufficient warmup']);
  assert.equal(results.costHurdle.windows, 2);
});

test('timing of the dry run', t => {
  t.diagnostic(`scaled-down dry run (920 settings, 12 windows of 2 days): ${dryRunSeconds.toFixed(2)} s per run on average`);
});

// The whole protocol at full size, on a synthetic market as long as the exploration range: 74 windows of 28 days,
// 12,720 settings, 10,000 resamples. Opt-in, because it takes about a minute on four free cores:
//   STUDY_FULL_DRY_RUN=1 node --test research/study.test.mjs
test('full-size dry run on a synthetic market (opt-in)', {skip: !process.env.STUDY_FULL_DRY_RUN}, async t => {
  const gaps = {missing: 0.004, gapRate: 0.0005, longGapRate: 0.00002};
  const market = syntheticMarket({seed: 11, start: EXPLORATION_FROM + MINUTE, minutes: (RESERVED_FROM - EXPLORATION_FROM) / MINUTE,
    BTC: gaps, LINK: {...gaps, missing: 0.008, gapRate: 0.001}});
  const {results, bytes} = await runStudy({market, out: scratch()});
  assert.deepEqual(results.deviations.map(d => d.option), ['market', 'out']);
  assert.deepEqual([results.windows.length, results.designGrid.settings, results.designGrid.designWindows], [74, 12720, 50]);
  assert.deepEqual(FAMILIES.map(f => results.families[f].settings), [3360, 3360, 3360, 1920, 720]);
  assert.equal(results.defaultSetting.perWindow.length, 74);
  assert.ok(results.nominees.length <= 5 && results.nominees.every(n => LABELS.includes(n.confirmation.label)));
  assert.ok(bytes < 2e6, `${bytes} bytes`);
  t.diagnostic(`full-size dry run: ${results.designGrid.simulations} design simulations in ${results.timing.steps.designGrid.toFixed(1)} s on ` +
    `${results.timing.workers} workers; scores and reality checks ${results.timing.steps.scores.toFixed(1)} s; engine reruns ` +
    `${results.timing.steps.exactCheck.toFixed(1)} s; whole study ${results.timing.wallSeconds.toFixed(1)} s; exploration.json ${(bytes / 1e6).toFixed(2)} MB`);
});
