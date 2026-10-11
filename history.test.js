import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccount} from './engine.js';
import {canonicalJSON, packMarket, unpackMarket, makeRunRecord, exportRun, runMetadata, listRuns} from './history.js';

test('packed histories preserve exact warmup and asset-specific gaps, not just shared closes', () => {
  const p = (time, price) => ({time, price});
  const market = {kind: 'range', dataset: {source: 'test', frames: [
    {time: 180000, history: {BTC: [p(60000, 10), p(120000, 11), p(180000, 12)], LINK: [p(60000, 2), p(180000, 3)]}, quotes: {BTC: {mid: 12}, LINK: {mid: 3}}},
    {time: 240000, history: {BTC: [p(120000, 11), p(180000, 12), p(240000, 13)], LINK: [p(180000, 3), p(240000, 4)]}, provenance: {receivedAt: 250000}},
    // A late additional older observation must not appear in earlier frames.
    {time: 300000, history: {BTC: [p(180000, 12), p(240000, 13), p(300000, 14)], LINK: [p(120000, 2.5), p(240000, 4), p(300000, 5)]}}
  ]}};
  const packed = packMarket(market);
  assert.equal(packed.dataset.historyEncoding, 'history-catalog-v1');
  assert.deepEqual(unpackMarket(JSON.parse(JSON.stringify(packed))), market);
  assert.deepEqual(packMarket(packed), packed);
  assert.equal(market.dataset.frames[0].history.LINK.length, 2);
});

test('evidence snapshots are immutable and canonical hashes identify settings/data changes', async () => {
  const account = createAccount();
  const market = {kind: 'live', frames: [{time: 1, history: {BTC: [{time: 0, price: 10}], LINK: []}}]};
  const first = await makeRunRecord({id: 'run-1', name: '<name>', account, market});
  const same = await makeRunRecord({id: 'run-1', account, market});
  assert.equal(first.hashes.configSha256, same.hashes.configSha256);
  assert.equal(first.hashes.marketSha256, same.hashes.marketSha256);
  market.frames[0].history.BTC[0].price = 99;
  account.cash = 0;
  assert.equal(first.account.cash, 1000);
  assert.equal(unpackMarket(first.market).frames[0].history.BTC[0].price, 10);
  const changedData = await makeRunRecord({account: createAccount(), market});
  assert.notEqual(first.hashes.marketSha256, changedData.hashes.marketSha256);
  const changedConfig = await makeRunRecord({account: createAccount({feeBps: 11}), market});
  assert.notEqual(first.hashes.configSha256, changedConfig.hashes.configSha256);
  assert.equal(first.name, '<name>');
  assert.equal(canonicalJSON({b: 2, a: 1}), canonicalJSON({a: 1, b: 2}));
});

test('export and history metadata distinguish partial/manual runs with results and settings', async () => {
  const account = createAccount({feeBps: 12});
  account.status = 'running';
  account.ledger.push({id: 1, type: 'trade', actor: 'manual', fee: 1});
  const run = await makeRunRecord({id: 'partial', account, market: {scoreStart: '2026-10-01T00:00:00Z'}});
  const metadata = runMetadata(run);
  assert.equal(metadata.status, 'running');
  assert.equal(metadata.manualTradeCount, 1);
  assert.equal(metadata.config.feeBps, 12);
  assert.equal(metadata.summary.fees, 1);
  assert.equal(metadata.scoreStart, '2026-10-01T00:00:00Z');
  const exported = exportRun(run);
  assert.deepEqual(exported.config, exported.account.config);
  assert.equal(exported.summary.equity, 1000);
  assert.throws(() => exportRun({format: 'other'}), /Invalid run record/);
  assert.throws(() => canonicalJSON({bad: Infinity}), /non-finite/);
});

test('unavailable persistent storage is an explicit failure, not a false save', async () => {
  if (!globalThis.indexedDB) await assert.rejects(listRuns(), /storage is unavailable/);
});
