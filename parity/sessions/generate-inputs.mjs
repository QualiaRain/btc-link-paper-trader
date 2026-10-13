// Deterministic session scenarios (seeded PRNG, no clock). Re-run: node parity/sessions/generate-inputs.mjs
// Each scenario is a list of actions: {op:'advance', mode:'frames'|'decision'|'finish', count?} and
// {op:'order', asset, side, dollars?}. Python replays the SAME list through its HTTP API.
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const M = 60000, dir = fileURLToPath(new URL('./inputs/', import.meta.url));
mkdirSync(dir, {recursive: true});
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function walk(seed, n, start, vol, drift = 0) { const r = rng(seed); const out = [start];
  for (let i = 1; i < n; i++) out.push(Math.round(out.at(-1) * Math.exp(drift + vol * (r() - .5)) * 1e4) / 1e4); return out; }
const write = (name, scenarios) => writeFileSync(`${dir}${name}.json`, JSON.stringify({name, kind: 'session', scenarios}) + '\n');

const adv = (mode, count) => ({op: 'advance', mode, ...(count ? {count} : {})});
const frames = n => adv('frames', n), decision = () => adv('decision'), finish = () => adv('finish');
const buy = (asset, dollars) => ({op: 'order', asset, side: 'buy', ...(dollars === undefined ? {} : {dollars})});
const sell = (asset, dollars) => ({op: 'order', asset, side: 'sell', ...(dollars === undefined ? {} : {dollars})});
const sample = (config = {}, half = 2) => ({config, replay: {source: 'sample', halfSpreadBps: half}});

// Sample-source sessions.
write('sample-sessions', [
  {name: 'frames-one-at-a-time', settings: sample(), actions: Array.from({length: 12}, () => frames(1))},
  {name: 'frames-in-batches', settings: sample({horizonMs: 300000}), actions: [frames(5), frames(17), frames(1), frames(250), frames(3)]},
  {name: 'decision-stepping', settings: sample({horizonMs: 900000, lookbackIntervals: 10}), actions: [decision(), decision(), decision(), frames(2), decision(), decision(), decision()]},
  {name: 'finish-then-nothing-more-allowed', settings: sample(), actions: [frames(4), finish(), frames(1), decision(), buy('BTC', 100), sell('LINK')]},
  {name: 'manual-buy-and-sell-mix', settings: sample({allocationFraction: 0.25, bufferBps: 40}), actions: [
    decision(), buy('BTC', 100), buy('LINK', 100), frames(3), sell('BTC'), buy('BTC', 100), buy('BTC', 250.5), frames(2),
    sell('LINK', 40), sell('LINK'), sell('LINK'), decision(), buy('LINK', 100), finish()]},
  {name: 'stop-loss-then-same-frame-buy-rejected', settings: sample({allocationFraction: 0, stopLossBps: 5}), actions: [
    frames(2), buy('BTC', 100), buy('LINK', 100), frames(1), buy('BTC', 100), sell('BTC'), buy('LINK', 100), frames(1), buy('BTC', 100), finish()]},
  {name: 'rejected-orders-leave-state-unchanged', settings: sample({allocationFraction: 0}), actions: [
    sell('BTC'), sell('LINK', 10), buy('BTC'), buy('BTC', 0), buy('LINK', -5), sell('BTC', 0), sell('BTC', -1), frames(2),
    buy('BTC', 100), sell('BTC', 30), sell('LINK')]},
  {name: 'cash-exhausted', settings: sample({allocationFraction: 0, initialCash: 150, feeBps: 25, slippageBps: 5}, 4), actions: [
    buy('BTC', 100), buy('LINK', 100), buy('LINK', 100), buy('BTC', 1), frames(5), sell('BTC'), buy('BTC', 5e6), finish()]},
  {name: 'risk-limits-and-cash-yield', settings: sample({maxDrawdownBps: 40, dailyLossBps: 25, cashYieldBps: 2000, bufferBps: 0, horizonMs: 300000}), actions: [
    frames(60), buy('BTC', 50), frames(120), buy('BTC', 50), sell('BTC'), frames(240), buy('LINK', 50), frames(480), buy('BTC', 50), finish()]},
]);

// Range-source sessions over synthetic closes with missing minutes (a gapped Coinbase-style candle series).
{
  const start = Date.UTC(2024, 2, 9, 12), end = start + 60 * M, ts = (a, b) => { const r = []; for (let t = a; t <= b; t += M) r.push(t); return r; };
  const series = (seed, p0, vol, drift, skip = () => false) => { const times = ts(start - 120 * M, end), w = walk(seed, times.length, p0, vol, drift);
    return times.map((time, i) => ({time, price: w[i]})).filter(c => !skip(c.time)); };
  const gapped = {BTC: series(301, 61000, .004, .0004, t => t === start + 10 * M || t === start + 11 * M || t === start + 33 * M),
    LINK: series(302, 19.2, .008, .0003, t => (t > start + 20 * M && t < start + 26 * M) || t === start - 3 * M || t === start + 47 * M)};
  const fmt = t => new Date(t).toISOString().slice(0, 16);
  const range = (cfg = {}, half = 2) => ({config: {horizonMs: 300000, lookbackIntervals: 5, ...cfg}, replay: {source: 'range', start: fmt(start), end: fmt(end), halfSpreadBps: half}});
  write('range-sessions', [
    {name: 'range-gapped-frames-and-decisions', fullAccount: true, settings: range(), candles: gapped, actions: [
      frames(1), frames(1), decision(), frames(7), decision(), decision(), frames(20), finish(), buy('BTC', 100)]},
    {name: 'range-gapped-manual-orders-and-stop', fullAccount: true, settings: range({stopLossBps: 90, feeBps: 20, slippageBps: 6}, 3), candles: gapped, actions: [
      decision(), buy('BTC', 100), buy('LINK', 60), frames(4), sell('BTC', 50), sell('LINK'), buy('LINK', 100), decision(), frames(9), sell('BTC'), finish()]},
    {name: 'range-same-price-model', fullAccount: true, settings: range({model: 'same-price', horizonMs: 60000}, 1.5), candles: gapped, actions: [
      frames(3), buy('LINK', 80), decision(), sell('LINK', 20), finish()]},
    {name: 'range-risk-limits-and-cash-yield', fullAccount: true, settings: range({maxDrawdownBps: 60, dailyLossBps: 45, cashYieldBps: 2000, bufferBps: 0}), candles: gapped, actions: [
      decision(), buy('BTC', 200), frames(10), buy('LINK', 50), frames(10), buy('BTC', 50), decision(), frames(10), buy('BTC', 50), finish()]},
  ]);
}
console.log('session inputs written to', dir);
