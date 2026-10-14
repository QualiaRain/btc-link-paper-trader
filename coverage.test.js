// Coverage is part of the answer: the sample's coverage block, the summary's gap and invalid-frame counts, the
// history metadata that carries them, and the one line both the run view and the history cards show.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest, getSummary} from './engine.js';
import {loadSample, sampleCoverage} from './market.js';
import {makeRunRecord, runMetadata, coverageSummary} from './history.js';
import {coverageLine} from './coverage.js';

const M = 60000, T = Date.UTC(2024, 0, 1);
const withSampleFetch = async fn => {
  const prior = globalThis.fetch;
  globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
  try { return await fn(); } finally { globalThis.fetch = prior; }
};
function frame(time) {
  const q = {bid: 99.98, ask: 100.02, mid: 100, observedAt: time, source: 'fixture'};
  const h = [{time: time - M, price: 100}, {time, price: 100}];
  return {time, quotes: {BTC: {...q}, LINK: {...q}}, history: {BTC: h, LINK: h}};
}

test('the bundled sample reports the coverage data/README.md states: 1,648 of 1,800 minutes, 152 missing, both assets', async () => {
  const sample = await withSampleFetch(loadSample);
  const coverage = sampleCoverage(sample, 7);
  for (const asset of ['BTC', 'LINK']) {
    const c = coverage[asset];
    assert.equal(c.expectedCount, 1800);
    assert.equal(c.observedCount, 1648);
    assert.equal(c.missingCount, 152);
    assert.equal(c.missingTimes.length, 152);
    assert.equal(c.missingFraction, 152 / 1800);
    assert.ok(c.startPresent && c.endPresent, 'the sample window starts and ends on an observation');
    assert.equal(c.warmupObservedCount, 7, 'the first `lookback` frames are the run\'s warmup');
    assert.equal(c.duplicateRows, 0);
    // Every listed missing minute is inside the window, on a minute boundary and really absent.
    const times = new Set(sample.frames.map(f => f.time));
    assert.ok(c.missingTimes.every(t => t >= sample.periodStart && t <= sample.periodEnd && t % M === 0 && !times.has(t)));
    assert.equal(c.observedCount + c.missingCount, c.expectedCount);
  }
  assert.deepEqual(coverage.BTC, coverage.LINK, 'the sample keeps only minutes observed for both assets');
  assert.notEqual(coverage.BTC.missingTimes, coverage.LINK.missingTimes, 'each block owns its list');
  // The shape is the one fetchHistoricalRange records for a date range (replay.js coverage[asset]).
  assert.deepEqual(Object.keys(coverage.BTC).sort(), ['duplicateRows', 'endPresent', 'expectedCount', 'missingCount', 'missingFraction', 'missingTimes', 'observedCount', 'startPresent', 'warmupObservedCount']);
  assert.throws(() => sampleCoverage(sample, -1), /warmup/);
  assert.throws(() => sampleCoverage({...sample, periodStart: sample.periodStart + 1}), /minute-close/);
});

test('a sample run record carries the coverage block, and history metadata reduces it to the counts', async () => {
  const sample = await withSampleFetch(loadSample);
  const cursor = 7, frames = sample.frames.slice(0, 60);
  const dataset = {...sample, frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time, warmupFrameCount: cursor,
    coverage: sampleCoverage(sample, cursor)};
  const account = createAccount({durationMs: dataset.scoreEnd - dataset.scoreStart, horizonMs: 300000});
  for (const f of frames.slice(cursor)) ingest(account, f);
  const record = await makeRunRecord({id: 'cov', name: 'coverage', account, market: {kind: 'sample', dataset, cursor: frames.length - 1, lastObservedFrame: frames.at(-1), scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd, settings: {}}});
  assert.equal(record.market.dataset.coverage.BTC.missingCount, 152, 'the export states the sample\'s coverage');
  assert.equal(record.market.dataset.coverage.LINK.missingTimes.length, 152);
  const meta = runMetadata(record);
  assert.equal(meta.kind, 'sample');
  assert.equal(meta.receiptCount, 0, 'the bundled sample has no fetch receipts');
  assert.deepEqual(meta.coverage, {BTC: {expectedCount: 1800, observedCount: 1648, missingCount: 152, warmupObservedCount: 7},
    LINK: {expectedCount: 1800, observedCount: 1648, missingCount: 152, warmupObservedCount: 7}});
  assert.equal(meta.summary.gapEvents, 0);
  assert.equal(meta.summary.invalidFrames, 0);
  // A date-range market: receipts are its provenance entries; a market without coverage lists none.
  const ranged = await makeRunRecord({id: 'range', account, market: {kind: 'historical', dataset: {scoreStart: 1, scoreEnd: 2, coverage: {BTC: {expectedCount: 3, observedCount: 2, missingCount: 1, warmupObservedCount: 8, missingTimes: [5]}, LINK: {expectedCount: 3, observedCount: 3, missingCount: 0, warmupObservedCount: 9, missingTimes: []}}, provenance: [{url: 'a'}, {url: 'b'}, {url: 'c'}]}}});
  const rangeMeta = runMetadata(ranged);
  assert.equal(rangeMeta.receiptCount, 3);
  assert.deepEqual(rangeMeta.coverage.LINK, {expectedCount: 3, observedCount: 3, missingCount: 0, warmupObservedCount: 9});
  assert.equal(runMetadata(await makeRunRecord({id: 'bare', account, market: {kind: 'live', dataset: {frames: []}}})).coverage, null);
  assert.equal(coverageSummary({BTC: {expectedCount: 1}}), null, 'a block missing an asset or a count is not summarised');
  assert.equal(coverageSummary(null), null);
});

test('the summary counts observation gaps and invalid frames, and both are zero when none happened', () => {
  const live = createAccount({mode: 'live', model: 'same-price'});
  ingest(live, frame(T));
  ingest(live, frame(T + 3600000)); // an hour without quotes: a gap event, no intervening fills
  ingest(live, {time: T + 3600000 + 1000, quotes: {BTC: {bid: 1, ask: 1, mid: 1, observedAt: T}, LINK: {}}}); // stale and missing quotes
  ingest(live, {time: T + 3600000 + 2000, quotes: {}});
  const s = getSummary(live);
  assert.equal(s.gapEvents, 1);
  assert.equal(s.invalidFrames, 2);
  assert.equal(live.ledger.filter(e => e.type === 'gap').length, 1);
  assert.equal(live.ledger.filter(e => e.type === 'invalid_frame').length, 2);
  const replay = createAccount({model: 'same-price'});
  ingest(replay, frame(T));
  ingest(replay, frame(T + 3600000)); // replays never record gap events
  assert.deepEqual([getSummary(replay).gapEvents, getSummary(replay).invalidFrames], [0, 0]);
  assert.deepEqual([getSummary(createAccount()).gapEvents, getSummary(createAccount()).invalidFrames], [0, 0]);
});

test('the coverage line reports counts, receipts and gaps, and says when a record did not keep them', () => {
  const coverage = {BTC: {expectedCount: 1800, observedCount: 1648, missingCount: 152}, LINK: {expectedCount: 1800, observedCount: 1648, missingCount: 152}};
  assert.equal(coverageLine({kind: 'sample', mode: 'replay', coverage, receipts: 0, summary: {gapEvents: 0, invalidFrames: 0}}),
    'Sample window (warmup included): BTC 1,648 of 1,800 minutes observed, 152 missing · LINK 1,648 of 1,800 minutes observed, 152 missing · 0 fetch receipts (bundled data, no fetch) · 0 observation gaps · 0 invalid frames.');
  assert.equal(coverageLine({kind: 'historical', mode: 'replay', coverage: {BTC: {expectedCount: 61, observedCount: 59, missingCount: 2}, LINK: {expectedCount: 61, observedCount: 60, missingCount: 1}}, receipts: 1, summary: {gapEvents: 0, invalidFrames: 1}}),
    'Scored range: BTC 59 of 61 minutes observed, 2 missing · LINK 60 of 61 minutes observed, 1 missing · 1 fetch receipt · 0 observation gaps · 1 invalid frame.');
  assert.equal(coverageLine({kind: 'live', mode: 'live', coverage: null, receipts: null, summary: {gapEvents: 1, invalidFrames: 0}}),
    'Live quotes: no minute coverage is expected · 1 observation gap · 0 invalid frames.');
  // Records saved before these fields existed: nothing is shown as zero that was never counted.
  assert.equal(coverageLine({kind: 'sample', mode: 'replay', coverage: null, receipts: null, summary: {settledForecasts: 3}}),
    'Minute coverage not recorded for this run · fetch receipts not recorded · gap and invalid-frame counts not recorded.');
  assert.equal(coverageLine({kind: 'live', mode: 'live', coverage: null, receipts: null, summary: {}}),
    'Live quotes: no minute coverage is expected · gap and invalid-frame counts not recorded.');
});
