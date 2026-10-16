// Prints a run record exported exactly as the CURRENT browser app does (history.js makeRunRecord + exportRun over an
// app.js-style market snapshot of the bundled sample), like parity/make-browser-records.mjs but written to stdout.
// Argument: the number of frames to play after the first scored frame (default: to completion).
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest} from '../../../engine.js';
import {normalizeSettings} from '../../../configuration.js';
import {loadSample, sampleCoverage} from '../../../market.js';
import {makeRunRecord, exportRun} from '../../../history.js';

globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
const sample = await loadSample();
const settings = normalizeSettings({config: {lookbackIntervals: 7, horizonMs: 300000, bufferBps: 0}, replay: {source: 'sample', halfSpreadBps: 0.5}});
const frames = sample.frames.slice(0, 200), cursor = settings.config.lookbackIntervals;
const dataset = {...sample, frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time, warmupFrameCount: cursor,
  coverage: sampleCoverage(sample, cursor)}; // the current app records the sample's coverage with the run
const account = createAccount({...settings.config, durationMs: dataset.scoreEnd - dataset.scoreStart});
ingest(account, frames[cursor]);
const steps = process.argv[2] ? Number(process.argv[2]) : Infinity;
let i = cursor;
while (i < frames.length - 1 && i - cursor < steps) { i++; ingest(account, frames[i]); if (account.status === 'completed') break; }
const market = {kind: 'sample', dataset, cursor: i, lastObservedFrame: frames[i], scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd, settings};
process.stdout.write(JSON.stringify(exportRun(await makeRunRecord({id: 'browser-current', name: 'current browser export', account: structuredClone(account), market}))));
