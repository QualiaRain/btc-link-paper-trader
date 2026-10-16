// Replays a list of session actions (advance / order) through the EXISTING JavaScript modules, mirroring
// app.js `start` (dataset + first-frame ingest), `ingestNext`/`replayWork` (advance) and `order` (manual paper
// orders). The Python session service must reproduce these outputs step for step.
//
// The session bookkeeping (version, completed, rejection codes) is the contract of the Python service; the
// accounting is the real engine.js. A rejected call leaves the account and version untouched.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest, manualTrade, getSummary} from '../../engine.js';
import {normalizeSettings, utcMinute} from '../../configuration.js';
import {fetchHistoricalRange} from '../../replay.js';
import {loadSample, sampleCoverage} from '../../market.js';
import {coverageSummary} from '../../history.js';
import {digest} from '../harness.mjs';

const M = 60000;
const ASSETS = ['BTC', 'LINK'];

// Same compaction on both sides: short event lists are compared in full, long ones by count, kinds, ends and trades.
export function eventsOut(events) {
  if (events.length <= 40) return events;
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return {count: events.length, byType, first: events[0], last: events.at(-1),
    trades: events.filter(e => e.type === 'trade').map(e => [e.id, e.time, e.actor, e.asset, e.side, e.qty, e.price, e.fee, e.notional, e.cashDelta])};
}

function candleFetch(candles) {
  return async url => {
    const u = new URL(url), asset = u.pathname.includes('LINK-USD') ? 'LINK' : 'BTC';
    const from = Date.parse(u.searchParams.get('start')), to = Date.parse(u.searchParams.get('end'));
    const rows = candles[asset].filter(c => c.time - M >= from && c.time - M <= to)
      .map(c => [(c.time - M) / 1000, c.price - 1, c.price + 1, c.price, c.price, 1]);
    return {ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(rows)};
  };
}

async function buildDataset(settings, candles) {
  const config = settings.config;
  if (settings.replay.source === 'range') {
    const original = globalThis.fetch;
    globalThis.fetch = candleFetch(candles);
    try {
      const dataset = await fetchHistoricalRange({start: utcMinute(settings.replay.start), end: utcMinute(settings.replay.end),
        halfSpreadBps: settings.replay.halfSpreadBps, warmupMinutes: Math.max(60, 2 * config.lookbackIntervals + 10),
        historyLimit: config.lookbackIntervals + 1, requiredHistory: config.model === 'trend' ? config.lookbackIntervals + 1 : 0});
      return {dataset, cursor: 0, kind: 'historical'};
    } finally { globalThis.fetch = original; }
  }
  const original = globalThis.fetch;
  globalThis.fetch = async url => ({ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
  try {
    const sample = await loadSample();
    const half = settings.replay.halfSpreadBps / 10000;
    const frames = sample.frames.map(f => ({...f, quotes: Object.fromEntries(ASSETS.map(asset => {
      const q = f.quotes[asset];
      return [asset, {...q, bid: q.mid * (1 - half), ask: q.mid * (1 + half),
        source: `Historical Coinbase candle close with ASSUMED ${settings.replay.halfSpreadBps} bps half-spread`}];
    }))}));
    const cursor = config.lookbackIntervals;
    if (cursor >= frames.length - 1) throw new Error('The included sample is too short for this lookback.');
    return {dataset: {...sample, frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time, warmupFrameCount: cursor,
      coverage: sampleCoverage(sample, cursor)}, cursor, kind: 'sample'};
  } finally { globalThis.fetch = original; }
}

const frameView = f => ({time: f.time, quotes: Object.fromEntries(ASSETS.map(a =>
  [a, Object.fromEntries(['bid', 'ask', 'mid', 'observedAt', 'source'].map(k => [k, f.quotes[a][k]]))]))});

const completed = s => s.account.status === 'completed' || s.cursor >= s.dataset.frames.length - 1;

function stateOf(s) {
  const frame = s.dataset.frames[s.cursor];
  return {version: s.version, kind: s.kind, cursor: s.cursor, frameCount: s.dataset.frames.length,
    warmupFrameCount: s.dataset.warmupFrameCount ?? 0, scoreStart: s.dataset.scoreStart, scoreEnd: s.dataset.scoreEnd,
    status: completed(s) ? 'completed' : 'active', currentFrame: frameView(frame),
    nextDecisionAt: s.account.status === 'completed' ? null : (s.account.lastDecisionAt ?? frame.time) + s.account.config.horizonMs,
    manualTradeCount: s.account.ledger.filter(e => e.type === 'trade' && e.actor === 'manual').length,
    summary: getSummary(s.account),
    // The source data's coverage counts and how many fetch receipts back them (none: the sample is bundled and
    // scenario candles are supplied, so the stubbed fetch's receipts are not retrieval evidence).
    coverage: coverageSummary(s.dataset.coverage), receiptCount: 0};
}

function advance(s, action) {
  if (completed(s)) return {code: 'session_completed'};
  const work = structuredClone(s.account), frames = s.dataset.frames, before = work.ledger.length;
  let cursor = s.cursor, ingested = 0;
  const target = (work.lastDecisionAt ?? frames[cursor].time) + work.config.horizonMs;
  while (cursor < frames.length - 1) {
    const frame = frames[++cursor];
    ingest(work, frame); ingested++;
    if (work.status === 'completed') break;
    if (action.mode === 'frames' && ingested >= action.count) break;
    if (action.mode === 'decision' && frame.time >= target) break;
  }
  s.account = work; s.cursor = cursor; s.version++;
  return {events: work.ledger.slice(before), framesIngested: ingested};
}

function order(s, action) {
  if (completed(s)) return {code: 'session_completed'};
  const reject = message => ({code: 'order_rejected', message});
  if (action.side === 'buy' && !(action.dollars > 0)) return reject('A buy needs dollars greater than zero');
  const work = structuredClone(s.account), before = work.ledger.length;
  try {
    manualTrade(work, action.asset, action.side, action.side === 'buy' ? action.dollars : (action.dollars ?? Number.MAX_VALUE),
      s.dataset.frames[s.cursor]);
  } catch (error) { return reject(error.message); }
  const events = work.ledger.slice(before);
  if (!events.some(e => e.type === 'trade'))
    return reject(`The order produced no trade: ${action.side === 'buy' ? 'no cash available' : 'no position to sell'}`);
  s.account = work; s.version++;
  return {events, framesIngested: 0};
}

export async function runSession(scenario) {
  let s;
  try {
    const settings = normalizeSettings(scenario.settings), config = {...settings.config};
    const {dataset, cursor, kind} = await buildDataset(settings, scenario.candles);
    const frames = dataset.frames;
    if (!frames.length || frames[cursor].time !== dataset.scoreStart || frames.at(-1).time !== dataset.scoreEnd)
      throw new Error('Historical data is missing an exact scored boundary. No run was created.');
    config.durationMs = dataset.scoreEnd - dataset.scoreStart;
    if (config.durationMs < config.horizonMs) throw new Error('The scored date range must be at least one forecast horizon long.');
    const account = createAccount(config);
    ingest(account, frames[cursor]);
    s = {account, dataset, cursor, kind, version: 1};
  } catch (error) { return {error: error.message}; }
  const out = {open: stateOf(s), steps: []};
  for (const action of scenario.actions) {
    const result = action.op === 'advance' ? advance(s, action) : order(s, action);
    const step = {action, ...(result.code ? {code: result.code, ...(result.message ? {message: result.message} : {})}
      : {framesIngested: result.framesIngested, events: eventsOut(result.events)}), state: stateOf(s)};
    out.steps.push(step);
  }
  out.final = {account: scenario.fullAccount ? s.account : digest(s.account), summary: getSummary(s.account)};
  return out;
}

export async function runCase(testCase) {
  const out = {};
  for (const scenario of testCase.scenarios) out[scenario.name] = JSON.parse(JSON.stringify(await runSession(scenario)));
  return {name: testCase.name, kind: testCase.kind, scenarios: out};
}
