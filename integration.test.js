import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount, ingest, getSummary} from './engine.js';
import {makeRunRecord, unpackMarket, exportRun} from './history.js';

const START = Date.UTC(2026, 8, 1, 12);
function observedFrames() {
  const histories = {BTC: [], LINK: []}, frames = [];
  for (let i = -8; i <= 30; i++) {
    const time = START + i * 60000;
    for (const asset of ['BTC', 'LINK']) {
      // Different missing observations must survive packing and replay.
      if (asset === 'LINK' && i === 9 || asset === 'BTC' && i === 13) continue;
      const base = asset === 'BTC' ? 60000 : 12;
      histories[asset].push({time, price: base * Math.exp(i < 16 ? i * .004 : (32-i) * .004)});
    }
    if (i < 0 || ['BTC', 'LINK'].some(asset => histories[asset].at(-1).time !== time)) continue;
    frames.push({time, quotes: Object.fromEntries(['BTC', 'LINK'].map(asset => {
      const mid = histories[asset].at(-1).price;
      return [asset, {mid, bid: mid * .9998, ask: mid * 1.0002, observedAt: time, source: 'test candle / assumed spread'}];
    })), history: Object.fromEntries(['BTC', 'LINK'].map(asset => [asset, histories[asset].slice(-5)]))});
  }
  return frames;
}

test('saved replay resumes with identical causal inputs, ledger, and exact final close', async () => {
  const frames = observedFrames();
  const config = {horizonMs: 300000, durationMs: 30*60000, lookbackIntervals: 4,
    allocationFraction: .3, stopLossBps: 100, bufferBps: 5, feeBps: 11};
  const uninterrupted = createAccount(config), paused = createAccount(config);
  for (const frame of frames) ingest(uninterrupted, frame);
  const cursor = 12;
  for (const frame of frames.slice(0, cursor+1)) ingest(paused, frame);
  const record = await makeRunRecord({id: 'resume-fixture', account: paused,
    market: {kind: 'historical', cursor, dataset: {scoreStart: START, scoreEnd: START+30*60000, frames}}});
  // Round trip through the exact downloadable format, not shared-close reconstruction.
  const downloaded = JSON.parse(JSON.stringify(exportRun(record)));
  const restoredMarket = unpackMarket(downloaded.market);
  for (const frame of restoredMarket.dataset.frames.slice(restoredMarket.cursor+1)) ingest(downloaded.account, frame);
  assert.deepEqual(downloaded.account, uninterrupted);
  assert.deepEqual(getSummary(downloaded.account), getSummary(uninterrupted));
  assert.equal(uninterrupted.status, 'completed');
  assert.equal(uninterrupted.lastFrameAt, START+30*60000);
  assert.equal(uninterrupted.positions.BTC.qty, 0);
  assert.equal(uninterrupted.positions.LINK.qty, 0);
  assert.ok(uninterrupted.ledger.some(e => e.type === 'trade' && e.actor === 'auto'));
  assert.ok(uninterrupted.ledger.some(e => e.type === 'stop_loss'));
});
