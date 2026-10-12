// Computes, with the EXISTING browser modules, the saved-run market and its hash for a complete sample replay
// (app.js start('replay') + Finish replay + makeRunRecord). Input: normalized-settings JSON as argv[2].
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest} from '../../../engine.js';
import {normalizeSettings} from '../../../configuration.js';
import {loadSample} from '../../../market.js';
import {makeRunRecord, exportRun} from '../../../history.js';

globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
const settings = normalizeSettings(JSON.parse(process.argv[2]));
const cached = await loadSample();
const half = settings.replay.halfSpreadBps / 10000;
const frames = cached.frames.map(f => ({...f, quotes: Object.fromEntries(['BTC', 'LINK'].map(asset => {
  const q = f.quotes[asset];
  return [asset, {...q, bid: q.mid * (1 - half), ask: q.mid * (1 + half),
    source: `Historical Coinbase candle close with ASSUMED ${settings.replay.halfSpreadBps} bps half-spread`}];
}))}));
const cursor0 = settings.config.lookbackIntervals;
const dataset = {...cached, frames, scoreStart: frames[cursor0].time, scoreEnd: frames.at(-1).time,
  assumptions: {...cached.assumptions, halfSpreadBps: settings.replay.halfSpreadBps}, warmupFrameCount: cursor0};
const account = createAccount({...settings.config, durationMs: dataset.scoreEnd - dataset.scoreStart});
ingest(account, frames[cursor0]);
let cursor = cursor0;
while (cursor < frames.length - 1) { ingest(account, frames[++cursor]); if (account.status === 'completed') break; }
const market = {kind: 'sample', dataset, cursor, lastObservedFrame: frames[cursor], scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd, settings};
const record = exportRun(await makeRunRecord({id: 'js-run', name: 'js', account: structuredClone(account), market}));
process.stdout.write(JSON.stringify({marketSha256: record.hashes.marketSha256, configSha256: record.hashes.configSha256, cursor: record.market.cursor}));
