// Produces saved runs exactly as the browser app does (history.js makeRunRecord over an app.js-style
// market snapshot), to prove the Python service can import existing saved runs.
// Re-run: node parity/make-browser-records.mjs   (timestamps in the records change; hashes stay valid)
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest, manualTrade} from '../engine.js';
import {normalizeSettings} from '../configuration.js';
import {loadSample} from '../market.js';
import {makeRunRecord, exportRun} from '../history.js';

globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
const out = fileURLToPath(new URL('./fixtures/', import.meta.url));
const sample = await loadSample();
const settings = normalizeSettings({config: {lookbackIntervals: 7, horizonMs: 300000, bufferBps: 0, feeBps: 1, slippageBps: 0, initialCash: 1000}, replay: {source: 'sample', halfSpreadBps: 0.5}});
const frames = sample.frames.slice(0, 140);
const cursor = settings.config.lookbackIntervals;
const dataset = {...sample, frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time, warmupFrameCount: cursor};

async function record(name, id, play) {
  const config = {...settings.config, durationMs: dataset.scoreEnd - dataset.scoreStart};
  const account = createAccount(config);
  ingest(account, frames[cursor]);
  const last = play(account);
  const market = {kind: 'sample', dataset, cursor: last, lastObservedFrame: frames[last], scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd, settings};
  const saved = exportRun(await makeRunRecord({id, name, account: structuredClone(account), market}));
  writeFileSync(`${out}${name}.json`, JSON.stringify(saved) + '\n');
  console.log(name, saved.status, 'trades', saved.summary.tradeCount, 'manual', saved.manualTradeCount);
}

// A finished replay.
await record('browser-run-completed', 'browser-completed-1', account => {
  let i = cursor;
  while (i < frames.length - 1) { i++; ingest(account, frames[i]); if (account.status === 'completed') break; }
  return i;
});
// A paused partial snapshot that includes a manual order (a "modified strategy run").
await record('browser-run-partial-manual', 'browser-partial-1', account => {
  let i = cursor;
  while (i < cursor + 40) { i++; ingest(account, frames[i]); }
  manualTrade(account, 'BTC', 'buy', 100, frames[i]);
  return i;
});
// A paused live-mode snapshot (live sessions are importable too, though the service only replays).
{
  const config = {...settings.config, mode: 'live', durationMs: 7200000};
  const account = createAccount(config);
  const liveFrames = frames.slice(0, 40).map(f => ({...f, quotes: Object.fromEntries(['BTC', 'LINK'].map(a => [a, {...f.quotes[a], simulatedQuote: false, source: 'Coinbase Exchange public ticker bid/ask'}]))}));
  for (const f of liveFrames) ingest(account, f);
  const market = {kind: 'live', dataset: {source: 'Coinbase Exchange public REST', frames: liveFrames}, cursor: 39, lastObservedFrame: liveFrames.at(-1), settings: {...settings, config}};
  const saved = exportRun(await makeRunRecord({id: 'browser-live-1', name: 'browser-run-live-partial', account: structuredClone(account), market}));
  writeFileSync(`${out}browser-run-live-partial.json`, JSON.stringify(saved) + '\n');
  console.log('browser-run-live-partial', saved.status, saved.config.mode);
}
