// Seeded, clock-free inputs for the candle-retrieval parity test. Regenerate: node parity/candles/generate-inputs.mjs
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const M = 60000, out = fileURLToPath(new URL('./inputs/', import.meta.url));
mkdirSync(out, {recursive: true});
const mulberry = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const START = Date.UTC(2024, 2, 9, 12, 0);

// Closes with a few decimals so float formatting is exercised; `skip` removes minutes (offsets from `start`).
function line(seed, base, from, to, skip = []) {
  const rnd = mulberry(seed), rows = [];
  let price = base;
  for (let t = from; t <= to; t += M) {
    price = Math.round((price * (1 + (rnd() - 0.5) * 0.002)) * 100) / 100;
    if (!skip.includes((t - START) / M)) rows.push({time: t, price});
  }
  return rows;
}
const data = (span, warm, skipBtc = [], skipLink = [], seed = 1) => ({
  BTC: line(seed, 61000.5, START - warm * M, START + span * M, skipBtc),
  LINK: line(seed + 100, 18.37, START - warm * M, START + span * M, skipLink)});
const P = (span, warm, extra = {}) => ({start: START, end: START + span * M, halfSpreadBps: 2, warmupMinutes: warm, historyLimit: 8, requiredHistory: 8, ...extra});
const sc = (name, span, warm, o = {}) => ({name, params: P(span, warm, o.params), data: o.data ?? data(span, warm, o.skipBtc, o.skipLink, o.seed), scripts: o.scripts});
const ok = {ok: true}, http = (status, body = '{"message":"x"}') => ({status, body});
const bucketOf = t => (t - M) / 1000;
const good = (t, p) => [bucketOf(t), p - 1, p + 1, p, p, 1];
const priceAt = (d, asset, t) => d[asset].find(r => r.time === t).price;

const scenarios = [];
const add = s => scenarios.push(s);

// --- successful retrievals
add(sc('single-chunk', 120, 30));
add(sc('two-chunks-boundary-duplicates', 340, 30));
add(sc('three-chunks', 700, 60, {seed: 7}));
add(sc('chunk-boundary-exactly-on-end', 537, 60 /* first-1min .. end is exactly 2*299 minutes */, {params: {warmupMinutes: 60}}));
add(sc('string-utc-timestamps', 90, 30, {params: {start: '2024-03-09T12:00:00Z', end: '2024-03-09T13:30:00+00:00'}}));
add(sc('defaults-omitted', 60, 60, {params: {halfSpreadBps: undefined, warmupMinutes: undefined, historyLimit: undefined, requiredHistory: undefined}}));
add(sc('required-history-zero-with-short-warmup-data', 60, 3, {params: {warmupMinutes: 30, requiredHistory: 0}}));
add(sc('shared-and-unshared-gaps', 120, 30, {skipBtc: [5, 6, 100, -12], skipLink: [6, 50, -3, 119]}));
{ // retries
  add(sc('retry-429-then-200', 340, 30, {scripts: {'BTC:0': [http(429), ok], 'LINK:1': [http(500), http(502), ok]}}));
  add(sc('retry-network-error-then-200', 120, 30, {scripts: {'LINK:0': [{throw: true}, ok]}}));
  add(sc('retry-then-missing-date-header', 120, 30, {scripts: {'BTC:0': [http(503), {ok: true, headers: {}}]}}));
}
{ // duplicates and out-of-window rows
  const d = data(120, 30), t = START + 10 * M, p = priceAt(d, 'BTC', t);
  add(sc('identical-duplicate-rows-counted', 120, 30, {data: d, scripts: {'BTC:0': [{extraRows: [good(t, p), good(t, p)]}]}}));
  add(sc('conflicting-duplicate-rows', 120, 30, {data: d, scripts: {'BTC:0': [{extraRows: [[bucketOf(t), p - 1, p + 1, p, p + 0.5, 1]]}]}}));
  add(sc('conflicting-duplicate-volume-only', 120, 30, {data: d, scripts: {'LINK:0': [{extraRows: [[bucketOf(START + 3 * M), 17, 19, 18, 18, 1]].map(r => { const q = priceAt(d, 'LINK', START + 3 * M); return [r[0], q - 1, q + 1, q, q, 2]; })}]}}));
  add(sc('rows-outside-window-ignored', 120, 30, {data: d, scripts: {'BTC:0': [{extraRows: [good(START - 90 * M, 5), good(START + 500 * M, 5), good(START - 31 * M, 7)]}]}}));
}
// --- HTTP / body failures
add(sc('http-500-three-times', 120, 30, {scripts: {'BTC:0': [http(500)]}}));
add(sc('http-429-three-times', 120, 30, {scripts: {'LINK:0': [http(429)]}}));
add(sc('http-404-not-retried', 120, 30, {scripts: {'BTC:0': [http(404)]}}));
add(sc('http-400-on-second-chunk', 340, 30, {scripts: {'BTC:1': [http(400)]}}));
add(sc('http-403-not-retried', 120, 30, {scripts: {'LINK:0': [http(403)]}}));
add(sc('http-301-not-retried', 120, 30, {scripts: {'BTC:0': [http(301)]}}));
add(sc('invalid-json-not-retried', 120, 30, {scripts: {'BTC:0': [{status: 200, body: '<html>oops</html>'}]}}));
add(sc('empty-body-not-retried', 120, 30, {scripts: {'LINK:0': [{status: 200, body: ''}]}}));
add(sc('nan-literal-is-invalid-json', 120, 30, {scripts: {'BTC:0': [{status: 200, body: '[[1710000000,NaN,1,1,1,1]]'}]}}));
add(sc('network-error-three-times', 120, 30, {scripts: {'BTC:0': [{throw: true}]}}));
add(sc('json-object-not-array', 120, 30, {scripts: {'BTC:0': [{status: 200, body: '{"message":"NotFound"}'}]}}));
add(sc('json-null-not-array', 120, 30, {scripts: {'LINK:0': [{status: 200, body: 'null'}]}}));
// --- candle row validation
const rowCase = (name, row, asset = 'BTC') => add(sc(name, 120, 30, {scripts: {[`${asset}:0`]: [{rows: [row]}]}}));
rowCase('row-too-short', [1710000000, 1, 2, 1, 1]);
rowCase('row-too-long', [1710000000, 1, 2, 1, 1, 1, 9]);
rowCase('row-null', null);
rowCase('row-not-array', {a: 1}, 'LINK');
rowCase('row-negative-price', [1710000000, -1, 2, 1, 1, 1]);
rowCase('row-zero-price', [1710000000, 0, 2, 1, 1, 1]);
rowCase('row-string-values', [1710000000, '1', '2', '1', '1', '1']);
rowCase('row-null-value', [1710000000, null, 2, 1, 1, 1]);
rowCase('row-boolean-value', [1710000000, true, 2, 1, 1, 1]);
rowCase('row-low-above-open-close', [1710000000, 5, 6, 3, 4, 1]);
rowCase('row-high-below-open-close', [1710000000, 1, 2, 3, 4, 1]);
rowCase('row-negative-volume', [1710000000, 1, 2, 1, 1, -1]);
rowCase('row-bucket-not-minute', [1710000001, 1, 2, 1, 1, 1], 'LINK');
rowCase('row-bucket-fractional', [1710000000.5, 1, 2, 1, 1, 1]);
rowCase('row-bucket-string', ['1710000000', 1, 2, 1, 1, 1]);
rowCase('row-bucket-overflow', [1e300, 1, 2, 1, 1, 1]);
rowCase('row-huge-value', [1710000000, 1, 1e999, 1, 1, 1]);
// --- boundaries and warmup
add(sc('btc-start-missing', 120, 30, {skipBtc: [0]}));
add(sc('link-end-missing', 120, 30, {skipLink: [120]}));
add(sc('both-boundaries-missing', 120, 30, {skipBtc: [0, 120], skipLink: [0]}));
{
  const d = data(120, 30);
  const keep = (asset, count) => d[asset].filter(r => r.time > START - count * M);
  add(sc('btc-warmup-too-short', 120, 30, {data: {BTC: keep('BTC', 4), LINK: d.LINK}}));
  add(sc('link-warmup-too-short', 120, 30, {data: {BTC: d.BTC, LINK: keep('LINK', 2)}}));
  add(sc('both-warmup-too-short-btc-reported', 120, 30, {data: {BTC: keep('BTC', 1), LINK: keep('LINK', 1)}}));
  add(sc('exactly-enough-warmup', 120, 30, {data: {BTC: keep('BTC', 8), LINK: keep('LINK', 8)}}));
  add(sc('one-short-of-required-warmup', 120, 30, {data: {BTC: keep('BTC', 8), LINK: keep('LINK', 7)}}));
}
// --- argument validation (no request is made)
const bad = (name, params) => add({name, params: P(120, 30, params), data: {BTC: [], LINK: []}});
bad('start-not-minute', {start: START + 1000});
bad('end-not-minute', {end: START + 120 * M + 500});
bad('start-string-without-zone', {start: '2024-03-09T12:00:00'});
bad('start-string-garbage', {start: 'garbage Z'});
bad('start-string-not-minute', {start: '2024-03-09T12:00:30Z'});
bad('start-null', {start: null});
bad('end-before-start', {end: START - M});
bad('end-equals-start', {end: START});
bad('range-over-31-days', {end: START + 31 * 1440 * M + M});
bad('end-in-the-future', {start: Date.UTC(2999, 0, 1), end: Date.UTC(2999, 0, 2)});
bad('warmup-zero', {warmupMinutes: 0});
bad('warmup-too-large', {warmupMinutes: 1441});
bad('warmup-fractional', {warmupMinutes: 30.5});
bad('warmup-shorter-than-history', {warmupMinutes: 5});
bad('history-limit-one', {historyLimit: 1});
bad('history-limit-242', {historyLimit: 242, warmupMinutes: 300});
bad('required-above-limit', {requiredHistory: 9});
bad('required-negative', {requiredHistory: -1});
bad('half-spread-negative', {halfSpreadBps: -1});
bad('half-spread-1001', {halfSpreadBps: 1001});
bad('half-spread-string', {halfSpreadBps: '2'});
add(sc('half-spread-1000-accepted', 60, 30, {params: {halfSpreadBps: 1000}}));
add(sc('half-spread-zero-accepted', 60, 30, {params: {halfSpreadBps: 0}}));

writeFileSync(out + 'retrieval.json', JSON.stringify({name: 'retrieval', kind: 'candles-fetch', scenarios}) + '\n');
console.log('candle inputs written:', scenarios.length, 'scenarios');
