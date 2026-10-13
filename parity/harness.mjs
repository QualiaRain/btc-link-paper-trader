// Runs the EXISTING JavaScript implementation (engine.js, configuration.js, replay.js,
// market.js, history.js) over parity inputs. The Python backend must reproduce these outputs.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccount, ingest, manualTrade, getSummary} from '../engine.js';
import {normalizeSettings, utcMinute} from '../configuration.js';
import {fetchHistoricalRange} from '../replay.js';
import {loadSample} from '../market.js';
import {makeRunRecord, canonicalJSON} from '../history.js';

const M = 60000;
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(v => v.toString(16).padStart(2, '0')).join('');
const fail = fn => { try { return {ok: fn()}; } catch (error) { return {error: error.message}; } };

export function runAccount(scenario) {
  let account;
  try { account = createAccount(scenario.config ?? {}); } catch (error) { return {createError: error.message}; }
  // Simulates an account saved before these settings existed (its frozen config lacks them).
  for (const field of scenario.dropConfigFields ?? []) delete account.config[field];
  const errors = [];
  scenario.steps.forEach((step, index) => {
    try {
      if (step.op === 'ingest') ingest(account, step.frame);
      else manualTrade(account, step.asset, step.side, step.dollars, step.frame);
    } catch (error) { errors.push({step: index, message: error.message}); }
  });
  return {account, summary: getSummary(account), errors};
}

export function runSettings(scenario) {
  return scenario.inputs.map(input => fail(() => normalizeSettings(input)));
}

export async function runCanonical(scenario) {
  const out = [];
  for (const value of scenario.values) { const text = canonicalJSON(value); out.push({text, sha256: await sha(text)}); }
  return out;
}

// Mirrors app.js `start('replay')` after market data is available, then plays to completion.
function finishReplay(settings, dataset, cursor) {
  const config = {...settings.config};
  const frames = dataset.frames;
  if (!frames.length || frames[cursor].time !== dataset.scoreStart || frames.at(-1).time !== dataset.scoreEnd)
    throw new Error('Historical data is missing an exact scored boundary. No run was created.');
  config.durationMs = dataset.scoreEnd - dataset.scoreStart;
  if (config.durationMs < config.horizonMs) throw new Error('The scored date range must be at least one forecast horizon long.');
  const account = createAccount(config);
  ingest(account, frames[cursor]);
  for (let i = cursor + 1; i < frames.length; i++) { ingest(account, frames[i]); if (account.status === 'completed') break; }
  return account;
}

// Long replays keep golden files small: the full ledger is reduced to rows that carry every
// accounting decision (trades, forecast outcomes) plus a thinned equity curve.
export function digest(account) {
  const counts = {};
  for (const e of account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return {config: account.config, cash: account.cash, positions: account.positions, status: account.status,
    startedAt: account.startedAt, endsAt: account.endsAt, lastDecisionAt: account.lastDecisionAt, lastFrameAt: account.lastFrameAt,
    sequence: account.sequence, baseline: account.baseline, ledgerCounts: counts,
    trades: account.ledger.filter(e => e.type === 'trade').map(e => [e.id, e.time, e.actor, e.asset, e.side, e.qty, e.price, e.fee, e.notional, e.cashDelta, e.source]),
    decisions: account.ledger.filter(e => e.type === 'decision' || e.type === 'decision_skipped').map(e => [e.id, e.time, e.asset, e.action ?? e.reason, e.expectedNetRatio ?? null]),
    forecasts: account.forecasts.map(f => [f.id, f.asset, f.status, f.issuedAt, f.targetAt, f.anchor, f.prediction, f.historyEnd, f.actual, f.latenessMs, f.absoluteError, f.baselineAbsoluteError]),
    equity: account.equity.filter((_, i) => i % 20 === 0 || i === account.equity.length - 1).map(p => [p.time, p.value, p.buyHoldValue]),
    equityCount: account.equity.length,
    riskEvents: account.ledger.filter(e => e.type === 'risk_halt' || e.type === 'risk_resume'),
    blockedDecisions: account.ledger.filter(e => e.blockedBy).map(e => [e.id, e.time, e.asset, e.blockedBy, e.wouldBuy]),
    risk: account.risk ?? null, interest: account.interest ?? null};
}

async function describe(settings, account, dataset, compact = false) {
  const record = await makeRunRecord({id: 'parity-run', name: 'parity', account: structuredClone(account),
    market: {kind: 'replay', dataset: {scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd}, settings}});
  return {account: compact ? digest(account) : account, summary: getSummary(account), scoreStart: dataset.scoreStart, scoreEnd: dataset.scoreEnd,
    settingsExport: {...settings, config: {...account.config}},
    record: {status: record.status, config: record.config, summary: record.summary, manualTradeCount: record.manualTradeCount,
      configSha256: record.hashes.configSha256}};
}

export async function runSampleReplay(scenario) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => ({ok: true, status: 200,
    json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))});
  try {
    const settings = normalizeSettings(scenario.settings);
    const config = settings.config;
    const sample = await loadSample();
    const half = settings.replay.halfSpreadBps / 10000;
    const frames = sample.frames.map(f => ({...f, quotes: Object.fromEntries(['BTC', 'LINK'].map(asset => {
      const q = f.quotes[asset];
      return [asset, {...q, bid: q.mid * (1 - half), ask: q.mid * (1 + half),
        source: `Historical Coinbase candle close with ASSUMED ${settings.replay.halfSpreadBps} bps half-spread`}];
    }))}));
    const cursor = config.lookbackIntervals;
    if (cursor >= frames.length - 1) throw new Error('The included sample is too short for this lookback.');
    const dataset = {frames, scoreStart: frames[cursor].time, scoreEnd: frames.at(-1).time};
    return await describe(settings, finishReplay(settings, dataset, cursor), dataset, true);
  } catch (error) { return {error: error.message}; } finally { globalThis.fetch = original; }
}

// Serves the supplied closes through the Coinbase candle URL shape that replay.js requests.
function candleFetch(candles) {
  return async url => {
    const u = new URL(url), asset = u.pathname.includes('LINK-USD') ? 'LINK' : 'BTC';
    const from = Date.parse(u.searchParams.get('start')), to = Date.parse(u.searchParams.get('end'));
    const rows = candles[asset].filter(c => c.time - M >= from && c.time - M <= to)
      .map(c => [(c.time - M) / 1000, c.price - 1, c.price + 1, c.price, c.price, 1]);
    return {ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(rows)};
  };
}

export async function runRangeReplay(scenario) {
  const original = globalThis.fetch;
  globalThis.fetch = candleFetch(scenario.candles);
  try {
    const settings = normalizeSettings(scenario.settings), config = settings.config;
    const dataset = await fetchHistoricalRange({start: utcMinute(settings.replay.start), end: utcMinute(settings.replay.end),
      halfSpreadBps: settings.replay.halfSpreadBps, warmupMinutes: Math.max(60, 2 * config.lookbackIntervals + 10),
      historyLimit: config.lookbackIntervals + 1, requiredHistory: config.model === 'trend' ? config.lookbackIntervals + 1 : 0});
    const result = await describe(settings, finishReplay(settings, dataset, 0), dataset);
    result.frameTimes = dataset.frames.map(f => f.time);
    result.firstHistory = Object.fromEntries(['BTC', 'LINK'].map(a => [a, dataset.frames[0].history[a]]));
    result.lastHistory = Object.fromEntries(['BTC', 'LINK'].map(a => [a, dataset.frames.at(-1).history[a]]));
    result.coverage = Object.fromEntries(['BTC', 'LINK'].map(a => { const c = dataset.coverage[a];
      return [a, {expectedCount: c.expectedCount, observedCount: c.observedCount, missingCount: c.missingCount,
        startPresent: c.startPresent, endPresent: c.endPresent, warmupObservedCount: c.warmupObservedCount}]; }));
    return result;
  } catch (error) { return {error: error.message}; } finally { globalThis.fetch = original; }
}

export async function runCase(testCase) {
  const runner = {account: runAccount, settings: runSettings, canonical: runCanonical,
    'sample-replay': runSampleReplay, 'range-replay': runRangeReplay}[testCase.kind];
  if (!runner) throw new Error(`Unknown parity kind ${testCase.kind}`);
  const out = {};
  for (const scenario of testCase.scenarios) out[scenario.name] = JSON.parse(JSON.stringify(await runner(scenario)));
  return {name: testCase.name, kind: testCase.kind, scenarios: out};
}
