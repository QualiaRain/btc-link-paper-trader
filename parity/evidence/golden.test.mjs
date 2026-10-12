// Fails when parity/evidence/expected no longer matches what the existing history.js/market.js/replay.js produces for the inputs.
// Python is compared with the same goldens in backend/tests/test_parity_candles.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runCase} from './harness.mjs';

const inputs = fileURLToPath(new URL('./inputs/', import.meta.url)), expected = fileURLToPath(new URL('./expected/', import.meta.url));
const files = readdirSync(inputs).filter(f => f.endsWith('.json')).sort();

test('every evidence parity input has a golden output and vice versa', () => {
  assert.ok(files.length >= 1);
  assert.deepEqual(readdirSync(expected).filter(f => f.endsWith('.json')).sort(), files);
});

for (const file of files) {
  test(`history.js still produces the committed golden output for ${file}`, async () => {
    const actual = await runCase(JSON.parse(readFileSync(inputs + file, 'utf8')));
    assert.deepEqual(actual, JSON.parse(readFileSync(expected + file, 'utf8')));
  });
}

test('the goldens exercise sparse histories, gapped ranges, errors and existing browser runs', () => {
  const read = name => JSON.parse(readFileSync(expected + name + '.json', 'utf8')).scenarios;
  const snaps = Object.values(read('app-snapshots'));
  assert.ok(snaps.length >= 8 && snaps.every(s => !s.error));
  assert.ok(snaps.some(s => s.cursors.some(c => c.refKinds.includes('indices'))), 'indices references occur');
  assert.ok(snaps.some(s => s.kind === 'historical' && s.cursors.length >= 3) && snaps.some(s => s.kind === 'sample'));
  assert.ok(new Set(snaps.flatMap(s => s.cursors.map(c => c.marketSha256))).size >= 25, 'cursors give different evidence');
  assert.ok(Object.values(read('unpack-market')).filter(v => v.error).length >= 15);
  assert.ok(Object.values(read('pack-market')).filter(v => v.error).length >= 2);
  for (const v of Object.values(read('fixtures'))) assert.equal(v.recordMarketSha256, v.marketSha256);
});
