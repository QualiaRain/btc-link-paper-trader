// Fails when parity/candles/expected no longer matches what the existing replay.js produces for the inputs.
// Python is compared with the same goldens in backend/tests/test_parity_candles.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runCase} from './harness.mjs';

const inputs = fileURLToPath(new URL('./inputs/', import.meta.url)), expected = fileURLToPath(new URL('./expected/', import.meta.url));
const files = readdirSync(inputs).filter(f => f.endsWith('.json')).sort();

test('every candle parity input has a golden output and vice versa', () => {
  assert.ok(files.length >= 1);
  assert.deepEqual(readdirSync(expected).filter(f => f.endsWith('.json')).sort(), files);
});

for (const file of files) {
  test(`replay.js still produces the committed golden output for ${file}`, async () => {
    const actual = await runCase(JSON.parse(readFileSync(inputs + file, 'utf8')));
    assert.deepEqual(actual, JSON.parse(readFileSync(expected + file, 'utf8')));
  });
}

test('the goldens exercise retries, errors, gaps and boundaries', () => {
  const s = JSON.parse(readFileSync(expected + 'retrieval.json', 'utf8')).scenarios;
  const errors = Object.values(s).filter(v => v.error), ok = Object.values(s).filter(v => v.series);
  assert.ok(errors.length >= 15 && ok.length >= 8);
  assert.ok(ok.some(v => v.provenance.some(p => p.attempts === 3)) && ok.some(v => v.provenance.some(p => p.attempts === 2)));
  assert.ok(errors.some(v => v.error.kind === 'syntax') && errors.some(v => v.error.kind === 'network'));
  assert.ok(ok.some(v => v.coverage.BTC.missingCount > 0) && ok.some(v => v.coverage.LINK.duplicateRows > 0));
});
