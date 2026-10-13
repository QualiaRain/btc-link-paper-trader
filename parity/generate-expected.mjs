// Regenerates golden outputs from the EXISTING JavaScript. Review the diff before committing.
import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runCase} from './harness.mjs';

const inputs = fileURLToPath(new URL('./inputs/', import.meta.url)), expected = fileURLToPath(new URL('./expected/', import.meta.url));
mkdirSync(expected, {recursive: true});
for (const file of readdirSync(inputs).filter(f => f.endsWith('.json')).sort()) {
  const result = await runCase(JSON.parse(readFileSync(inputs + file, 'utf8')));
  writeFileSync(expected + file, JSON.stringify(result) + '\n');
}
console.log('expected outputs written');
