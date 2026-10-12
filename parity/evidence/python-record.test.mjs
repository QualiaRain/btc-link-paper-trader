// Verifies run records CREATED BY PYTHON (fixtures/python-run-*.json, produced by backend/scripts/make_python_run_fixtures.py)
// with the REAL history.js, configuration.js and engine.js: the hashes verify, the packed market unpacks to frames,
// the shape app.js installRecord()/openSaved() relies on is present, and the JavaScript engine reproduces the
// Python account from the unpacked frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {canonicalJSON, exportRun, packMarket, unpackMarket, runMetadata} from '../../history.js';
import {normalizeSettings} from '../../configuration.js';
import {createAccount, ingest, manualTrade, getSummary} from '../../engine.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const files = readdirSync(dir).filter(f => f.startsWith('python-run-') && f.endsWith('.json')).sort();
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(value))))]
  .map(v => v.toString(16).padStart(2, '0')).join('');

test('the Python-created fixtures cover sample, range, completed, partial and manual runs', () => {
  assert.deepEqual(files, ['python-run-range-partial.json', 'python-run-sample-completed.json', 'python-run-sample-partial-manual.json']);
});

for (const file of files) {
  const record = JSON.parse(readFileSync(dir + file, 'utf8'));
  test(`${file}: history.js accepts the record and its hashes verify`, async () => {
    assert.equal(record.format, 'paper-trail-run-v2');
    const exported = exportRun(record); // validateRecord + canonical copy; throws on an incomplete record
    assert.equal(canonicalJSON(exported), canonicalJSON(record));
    assert.equal(record.hashes.algorithm, 'SHA-256 / canonical JSON');
    assert.equal(await sha(record.config), record.hashes.configSha256);
    assert.equal(await sha(record.market), record.hashes.marketSha256);
    assert.equal(canonicalJSON(record.market), canonicalJSON(packMarket(record.market)), 'market is stored packed');
    const meta = runMetadata(record);
    assert.equal(meta.scoreStart, record.market.dataset.scoreStart);
    assert.equal(meta.scoreEnd, record.market.dataset.scoreEnd);
  });

  test(`${file}: unpackMarket reconstructs frames with history and re-packs identically`, () => {
    const market = unpackMarket(record.market);
    const frames = market.dataset.frames;
    assert.ok(frames.length > 100);
    for (const frame of frames) {
      assert.equal(frame.historyRefs, undefined);
      for (const asset of ['BTC', 'LINK']) {
        assert.ok(frame.history[asset].length >= 1);
        assert.ok(frame.history[asset].every(row => Number.isSafeInteger(row.time) && row.price > 0));
        assert.equal(frame.history[asset].at(-1).time, frame.time);
      }
    }
    assert.equal(canonicalJSON(packMarket(market)), canonicalJSON(record.market));
    assert.equal(market.dataset.historyEncoding, undefined);
  });

  test(`${file}: shape that installRecord()/openSaved() reads is present`, () => {
    // app.js: !record?.account?.config || !record.market?.lastObservedFrame -> throws 'Saved run is missing ...'
    assert.ok(record.account.config && Array.isArray(record.account.ledger) && Array.isArray(record.account.equity));
    const market = unpackMarket(record.market);
    assert.ok(record.market.lastObservedFrame);
    assert.equal(canonicalJSON(market.lastObservedFrame), canonicalJSON(market.dataset.frames[record.market.cursor]));
    const settings = normalizeSettings({...record.market.settings, config: record.config}); // applySettings input
    assert.equal(settings.config.mode, 'replay');
    assert.ok(Number.isInteger(record.market.cursor) && market.dataset.frames[record.market.cursor]);
    assert.ok(['sample', 'historical'].includes(record.market.kind));
    assert.equal(record.market.scoreStart, market.dataset.scoreStart);
    assert.deepEqual(record.account.config, record.config);
    assert.equal(typeof record.name, 'string');
    assert.ok(/^[\w.-]{1,128}$/.test(record.id));
  });

  test(`${file}: the JavaScript engine reproduces the Python account from the unpacked frames`, () => {
    const market = unpackMarket(record.market);
    const frames = market.dataset.frames, first = record.market.kind === 'sample' ? market.dataset.warmupFrameCount : 0;
    const account = createAccount(record.config);
    ingest(account, frames[first]);
    for (let i = first + 1; i <= record.market.cursor && account.status !== 'completed'; i++) ingest(account, frames[i]);
    if (record.manualTradeCount === 1) manualTrade(account, 'BTC', 'buy', 100, frames[record.market.cursor]);
    assert.deepEqual(JSON.parse(JSON.stringify(getSummary(account))), record.summary);
    assert.equal(canonicalJSON(account.ledger), canonicalJSON(record.account.ledger));
  });
}
