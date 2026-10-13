// Fails when parity/live/expected/*.json no longer matches what the existing JavaScript produces for
// parity/live/inputs/*.json. Python is compared against the same goldens in backend/tests/test_parity_live.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runCase} from './harness.mjs';

const inputs = fileURLToPath(new URL('./inputs/', import.meta.url)), expected = fileURLToPath(new URL('./expected/', import.meta.url));
const files = readdirSync(inputs).filter(f => f.endsWith('.json')).sort();

test('every live input has a golden output and vice versa', () => {
  assert.deepEqual(readdirSync(expected).filter(f => f.endsWith('.json')).sort(), files);
});

for (const file of files) {
  test(`JavaScript still produces the committed live golden for ${file}`, async () => {
    const actual = await runCase(JSON.parse(readFileSync(inputs + file, 'utf8')));
    assert.deepEqual(actual, JSON.parse(readFileSync(expected + file, 'utf8')));
  });
}
