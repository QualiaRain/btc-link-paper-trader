// Runs the EXISTING history.js / market.js / replay.js / app.js-equivalent snapshot construction and reduces the
// outcome to what the Python evidence module must reproduce: packed markets, unpacked frames, canonical JSON
// hashes (history.js digest) and exported run records. No network is used (fetch is stubbed).
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest} from '../../engine.js';
import {normalizeSettings, utcMinute} from '../../configuration.js';
import {loadSample, sampleCoverage} from '../../market.js';
import {fetchHistoricalRange} from '../../replay.js';
import {makeRunRecord, exportRun, packMarket, unpackMarket, canonicalJSON} from '../../history.js';

const M = 60000, ASSETS = ['BTC', 'LINK'];
const here = fileURLToPath(new URL('./', import.meta.url));
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(v => v.toString(16).padStart(2, '0')).join('');
const TEXT_LIMIT = 30000; // canonical text is stored only for small markets; hashes cover the rest
const fail = fn => { try { return {ok: fn()}; } catch (error) { return {error: error.message}; } };

async function summarize(value) {
  const text = canonicalJSON(value);
  return {sha256: await sha(text), length: text.length, ...(text.length <= TEXT_LIMIT ? {text} : {})};
}

// --- hand-built markets: pack/unpack parity, including sparse histories and malformed packed input
async function runPack(scenario) {
  const out = {};
  const packed = fail(() => packMarket(structuredClone(scenario.market)));
  if (packed.error) return {error: packed.error};
  out.packed = await summarize(packed.ok);
  const unpacked = fail(() => unpackMarket(packed.ok));
  out.unpacked = unpacked.error ? {error: unpacked.error} : await summarize(unpacked.ok);
  out.repacked = unpacked.error ? null : (await summarize(packMarket(unpacked.ok))).sha256;
  return out;
}

async function runUnpack(scenario) {
  const result = fail(() => unpackMarket(structuredClone(scenario.market)));
  return result.error ? {error: result.error} : {unpacked: await summarize(result.ok)};
}

// --- browser-shaped datasets and snapshots
function thin(frames, every) {
  if (!every) return frames;
  return frames.map((f, i) => {
    if (i % every || !f.history || f.history.BTC.length < 5) return f;
    const history = Object.fromEntries(ASSETS.map(a => [a, f.history[a].filter((_, j) => j !== 3)]));
    return {...f, history};
  });
}

async function sampleDataset(spec, settings) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
  try {
    const cached = await loadSample();
    const half = settings.replay.halfSpreadBps / 10000;
    let frames = cached.frames.map(f => ({...f, quotes: Object.fromEntries(ASSETS.map(asset => { const q = f.quotes[asset];
      return [asset, {...q, bid: q.mid * (1 - half), ask: q.mid * (1 + half),
        source: `Historical Coinbase candle close with ASSUMED ${settings.replay.halfSpreadBps} bps half-spread`}]; }))}));
    if (spec.frameLimit) frames = frames.slice(0, spec.frameLimit);
    frames = thin(frames, spec.thinEvery);
    const cursor = settings.config.lookbackIntervals;
    // app.js records the whole sample's coverage; a scenario's frameLimit only shortens the run, not the sample.
    const dataset = {...cached, frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time,
      assumptions: {...cached.assumptions, halfSpreadBps: settings.replay.halfSpreadBps}, warmupFrameCount: cursor,
      coverage: sampleCoverage(cached, cursor)};
    return {dataset, kind: 'sample', first: cursor};
  } finally { globalThis.fetch = original; }
}

// Serves supplied closes through the Coinbase candle URL shape; Date.now is a deterministic counter so that
// capturedAt, receivedAt and retrievalElapsedMs are reproducible.
async function rangeDataset(spec, settings) {
  const originalFetch = globalThis.fetch, originalNow = Date.now, originalTimeout = globalThis.setTimeout;
  let tick = 0;
  Date.now = () => spec.clockBase + 7 * tick++;
  globalThis.setTimeout = (fn, ms, ...args) => ms >= 15000 ? originalTimeout(fn, ms, ...args) : originalTimeout(fn, 0, ...args);
  globalThis.fetch = async url => {
    const u = new URL(url), asset = u.pathname.includes('LINK-USD') ? 'LINK' : 'BTC';
    const from = Date.parse(u.searchParams.get('start')), to = Date.parse(u.searchParams.get('end'));
    const rows = spec.candles[asset].filter(c => c.time - M >= from && c.time - M <= to)
      .map(c => [(c.time - M) / 1000, c.price - 1, c.price + 1, c.price, c.price, 1]).reverse();
    return {ok: true, status: 200, headers: new Headers({date: 'Sat, 09 Mar 2024 12:00:00 GMT'}), text: async () => JSON.stringify(rows)};
  };
  try {
    const config = settings.config;
    const dataset = await fetchHistoricalRange({start: utcMinute(settings.replay.start), end: utcMinute(settings.replay.end),
      halfSpreadBps: settings.replay.halfSpreadBps, warmupMinutes: Math.max(60, 2 * config.lookbackIntervals + 10),
      historyLimit: config.lookbackIntervals + 1, requiredHistory: config.model === 'trend' ? config.lookbackIntervals + 1 : 0});
    return {dataset, kind: 'historical', first: 0};
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; globalThis.setTimeout = originalTimeout; }
}

// app.js marketSnapshot(): {kind, dataset, cursor, lastObservedFrame, scoreStart, scoreEnd, settings}
const snapshot = (kind, dataset, cursor, settings, account) => ({kind, dataset, cursor, lastObservedFrame: dataset.frames[cursor],
  scoreStart: dataset?.scoreStart ?? account?.startedAt, scoreEnd: dataset?.scoreEnd ?? account?.endsAt, settings});

async function runSnapshots(scenario) {
  try {
    const settings = normalizeSettings(scenario.settings);
    const built = scenario.dataset.source === 'sample' ? await sampleDataset(scenario.dataset, settings)
      : await rangeDataset(scenario.dataset, settings);
    const {dataset, kind, first} = built;
    const config = {...settings.config, durationMs: dataset.scoreEnd - dataset.scoreStart};
    const account = createAccount(config);
    ingest(account, dataset.frames[first]);
    const cursors = [];
    for (const spec of scenario.cursors) {
      const cursor = spec < 0 ? dataset.frames.length + spec : spec;
      const record = await makeRunRecord({id: 'evidence-run', name: 'evidence', account: structuredClone(account),
        market: snapshot(kind, dataset, cursor, settings, account)});
      const exported = exportRun(record);
      const unpacked = unpackMarket(record.market);
      cursors.push({cursor, marketSha256: record.hashes.marketSha256, configSha256: record.hashes.configSha256,
        market: await summarize(record.market), exportedMarketSha256: (await summarize(exported.market)).sha256,
        ...(scenario.skipFramesHash ? {} : {framesSha256: (await summarize(unpacked.dataset.frames)).sha256}),
        lastObservedFrameSha256: (await summarize(unpacked.lastObservedFrame)).sha256,
        frameCount: dataset.frames.length, catalog: Object.fromEntries(ASSETS.map(a => [a, record.market.dataset.historyCatalog[a].length])),
        refKinds: [...new Set(record.market.dataset.frames.flatMap(f => Object.values(f.historyRefs ?? {}).map(r => r.indices ? 'indices' : 'range')))].sort()});
    }
    return {kind, scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd, capturedAt: dataset.capturedAt,
      dataset: scenario.dataset.source === 'range' ? await summarize({...dataset, frames: dataset.frames.map(f => ({time: f.time, quotes: f.quotes, history: f.history}))}) : undefined,
      cursors};
  } catch (error) { return {error: error.message}; }
}

// --- existing browser-saved runs
async function runFixture(scenario) {
  const record = JSON.parse(readFileSync(here + scenario.path, 'utf8'));
  const unpacked = unpackMarket(record.market);
  const repacked = packMarket(unpacked);
  return {recordMarketSha256: record.hashes.marketSha256, marketSha256: await sha(canonicalJSON(record.market)),
    unpacked: await summarize(unpacked), repackedSha256: await sha(canonicalJSON(repacked)),
    frames: unpacked.dataset.frames.length, cursor: record.market.cursor,
    firstHistory: unpacked.dataset.frames[0].history, lastHistory: unpacked.dataset.frames.at(-1).history};
}

export async function runCase(testCase) {
  const runner = {'pack-market': runPack, 'unpack-market': runUnpack, 'app-snapshot': runSnapshots, fixture: runFixture}[testCase.kind];
  if (!runner) throw new Error(`Unknown evidence kind ${testCase.kind}`);
  const out = {};
  for (const scenario of testCase.scenarios) out[scenario.name] = JSON.parse(JSON.stringify(await runner(scenario)));
  return {name: testCase.name, kind: testCase.kind, scenarios: out};
}
