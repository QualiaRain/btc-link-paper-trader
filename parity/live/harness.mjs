// Runs the EXISTING market.js `fetchLiveMarket` (with a stubbed global fetch and a fixed Date.now) and the live
// session flow of app.js (start('live') -> trimLive -> ingest, liveTick, order live branch) through engine.js.
// The Python service must reproduce these outputs. No network is ever used.
//
// A "world" is {series, ticker, routes?}: the candle endpoint returns series[asset], the ticker endpoint
// ticker[asset]; `routes` overrides any path with {status, json|text}.
import {createAccount, ingest, manualTrade, getSummary} from '../../engine.js';
import {normalizeSettings} from '../../configuration.js';
import {fetchLiveMarket} from '../../market.js';
import {canonicalJSON} from '../../history.js';
import {digest} from '../harness.mjs';

const BASE = 'https://api.exchange.coinbase.com';
const ASSETS = ['BTC', 'LINK'];
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(v => v.toString(16).padStart(2, '0')).join('');

function route(world, path) {
  const override = world.routes?.[path];
  if (override) return override;
  for (const asset of ASSETS) {
    if (path === `/products/${asset}-USD/candles?granularity=60`) return {status: 200, json: world.series[asset]};
    if (path === `/products/${asset}-USD/ticker`) return {status: 200, json: world.ticker[asset]};
  }
  return {status: 404, json: {message: 'NotFound'}};
}

async function live(world, now, horizonMs) {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  globalThis.fetch = async url => {
    const r = route(world, String(url).slice(BASE.length));
    const status = r.status ?? 200;
    return {ok: status >= 200 && status < 300, status,
      json: async () => r.text !== undefined ? JSON.parse(r.text) : structuredClone(r.json)};
  };
  Date.now = () => now;
  try { return await fetchLiveMarket(horizonMs); } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
}

// V8's SyntaxError text is not reproducible in Python; both sides report only the URL prefix for non-JSON bodies.
export const normalizeError = (message, world) =>
  world.invalidJson ? message.replace(/^(Market data unavailable \([^)]*\): ).*$/s, '$1<invalid json>') : message;

export async function runFetch(scenario) {
  try { return {frame: await live(scenario, scenario.now, scenario.horizonMs)}; }
  catch (error) { return {error: normalizeError(error.message, scenario)}; }
}

// ---- live sessions ---------------------------------------------------------------------------------------
export function eventsOut(events) {
  if (events.length <= 40) return events;
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return {count: events.length, byType, first: events[0], last: events.at(-1),
    trades: events.filter(e => e.type === 'trade').map(e => [e.id, e.time, e.actor, e.asset, e.side, e.qty, e.price, e.fee, e.notional, e.cashDelta])};
}

const frameView = f => ({time: f.time, quotes: Object.fromEntries(ASSETS.map(a =>
  [a, Object.fromEntries(['bid', 'ask', 'mid', 'observedAt', 'source'].map(k => [k, f.quotes[a][k]]))]))});

function trimLive(frame, lookback) {
  for (const asset of ASSETS) frame.history[asset] = frame.history[asset].slice(-lookback - 1);
  return frame;
}

function stateOf(s) {
  const frame = s.frames.at(-1), a = s.account;
  return {version: s.version, kind: 'live', cursor: s.frames.length - 1, frameCount: s.frames.length, warmupFrameCount: 0,
    scoreStart: a.startedAt ?? frame.time, scoreEnd: a.endsAt ?? frame.time + a.config.durationMs,
    status: a.status === 'completed' ? 'completed' : 'active', currentFrame: frameView(frame),
    nextDecisionAt: a.status === 'completed' ? null : (a.lastDecisionAt ?? frame.time) + a.config.horizonMs,
    manualTradeCount: a.ledger.filter(e => e.type === 'trade' && e.actor === 'manual').length, summary: getSummary(a)};
}

async function freshFrame(s, world, now) {
  return trimLive(await live(world, now, s.account.config.horizonMs), s.account.config.lookbackIntervals);
}

async function tick(s, step) {
  if (s.account.status === 'completed') return {code: 'session_completed'};
  let next;
  try { next = await freshFrame(s, step, step.now); } catch (error) { return {code: 'live_unavailable', message: normalizeError(error.message, step)}; }
  const work = structuredClone(s.account), before = work.ledger.length;
  ingest(work, next);
  s.account = work; s.frames.push(next); s.version++;
  return {events: work.ledger.slice(before), framesIngested: 1};
}

async function order(s, step) {
  if (s.account.status === 'completed') return {code: 'session_completed'};
  const reject = message => ({code: 'order_rejected', message});
  if (step.side === 'buy' && !(step.dollars > 0)) return reject('A buy needs dollars greater than zero');
  let next;
  try { next = await freshFrame(s, step, step.now); } catch (error) { return {code: 'live_unavailable', message: normalizeError(error.message, step)}; }
  const work = structuredClone(s.account), before = work.ledger.length;
  try {
    ingest(work, next);
    manualTrade(work, step.asset, step.side, step.side === 'buy' ? step.dollars : (step.dollars ?? Number.MAX_VALUE), next);
  } catch (error) { return reject(error.message); }
  const events = work.ledger.slice(before);
  if (!events.some(e => e.type === 'trade'))
    return reject(`The order produced no trade: ${step.side === 'buy' ? 'no cash available' : 'no position to sell'}`);
  s.account = work; s.frames.push(next); s.version++;
  return {events, framesIngested: 1};
}

export async function runSession(scenario) {
  let s;
  try {
    const settings = normalizeSettings(scenario.settings), config = {...settings.config};
    const open = {...scenario.open, series: scenario.series};
    const frame = trimLive(await live(open, open.now, config.horizonMs), config.lookbackIntervals);
    const account = createAccount(config);
    ingest(account, frame);
    s = {settings, account, frames: [frame], version: 1};
  } catch (error) { return {error: normalizeError(error.message, scenario.open ?? {})}; }
  const out = {open: stateOf(s), steps: []};
  for (const action of scenario.steps) {
    const step = {...action, series: scenario.series};
    const result = action.op === 'tick' ? await tick(s, step) : await order(s, step);
    const { now, ticker, routes, invalidJson, ...shown } = action;
    out.steps.push({action: shown, ...(result.code ? {code: result.code, ...(result.message ? {message: result.message} : {})}
      : {framesIngested: result.framesIngested, events: eventsOut(result.events)}), state: stateOf(s)});
  }
  const a = s.account, frame = s.frames.at(-1);
  const market = {kind: 'live', dataset: {source: s.frames[0].source, documentation: s.frames[0].documentation,
    assumptions: s.frames[0].assumptions, frames: s.frames}, cursor: 0, lastObservedFrame: frame,
    scoreStart: a.startedAt, scoreEnd: a.endsAt, settings: s.settings};
  out.final = {account: scenario.fullAccount ? a : digest(a), summary: getSummary(a),
    market: {frameCount: s.frames.length, sha256: await sha(canonicalJSON(market))}};
  return out;
}

export async function runCase(testCase) {
  const runner = {'live-fetch': runFetch, 'live-session': runSession}[testCase.kind];
  const out = {};
  for (const scenario of testCase.scenarios) out[scenario.name] = JSON.parse(JSON.stringify(await runner(scenario)));
  return {name: testCase.name, kind: testCase.kind, scenarios: out};
}
