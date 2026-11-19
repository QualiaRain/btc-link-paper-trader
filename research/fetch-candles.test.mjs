// Tests for research/fetch-candles.mjs and research/dataset.mjs.
// Nothing here reaches the network. Every request goes to a node:http server on 127.0.0.1 or to a stub, and the
// command-line runs get a preloaded fetch that cannot leave the machine. Candles are synthetic, from a counter-based
// PRNG with fixed seeds (no Math.random, no clock in any asserted value). The one piece of market data read is the
// bundled data/sample.json, to check coverage() against the counts data/README.md states.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fetchHistoricalRange} from '../replay.js';
import {COINBASE_URL, LOOPBACK_SOURCE, MAX_WAIT_MS, SOURCE, fetchCandles, retryDelayMs} from './fetch-candles.mjs';
import {ASSETS, EXPLORATION_FROM, MINUTE, RESERVED_FROM, SOURCE as DATASET_SOURCE, coverage, explorationMonths, loadSeries,
  publicManifest, receiptsSummary, seriesFromRows, storeCompleteness} from './dataset.mjs';

const CLI = fileURLToPath(new URL('./fetch-candles.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../data/sample.json', import.meta.url));
const utc = text => Date.parse(`${text}T00:00:00Z`);
const iso = t => new Date(t).toISOString();
const sha = data => createHash('sha256').update(data).digest('hex');
const quiet = () => {};

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-candles-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// ---- synthetic candles: a pure function of (asset, bucket), so overlapping requests agree and tests can recompute
const SEED = {BTC: 0x1234abcd, LINK: 0x0badcafe};
function mix(a, b) {
  let x = Math.imul(a ^ (b + 0x9e3779b9), 0x85ebca6b) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0x27d4eb2f) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
const unit = (asset, minute, k) => mix(mix(SEED[asset], minute), k) / 2 ** 32;
// Buckets that always exist, so the tests can rely on a range's first and last minute.
const ALWAYS = new Set(['2025-08-31', '2025-09-01', '2025-09-27', '2025-09-28', '2025-09-29', '2020-01-01']
  .flatMap(day => [utc(day) / 1000, (utc(day) + 86400000 - MINUTE) / 1000]));
// Missing minutes: about 5% at random, plus a daily hole of 40 minutes (LINK) or 3 minutes (BTC).
function missing(asset, bucket) {
  if (ALWAYS.has(bucket)) return false;
  const minute = bucket / 60, ofDay = minute % 1440;
  return unit(asset, minute, 9) < 0.05 || (asset === 'LINK' ? ofDay >= 600 && ofDay < 640 : ofDay >= 100 && ofDay < 103);
}
// Coinbase's row: [bucketSeconds, low, high, open, close, volume]. Integer ticks keep low <= open, close <= high exact.
function candle(asset, bucket) {
  if (missing(asset, bucket)) return null;
  const minute = bucket / 60, scale = asset === 'BTC' ? 100 : 1000, base = asset === 'BTC' ? 6000000 : 15000;
  const open = base + Math.round(base * 0.05 * Math.sin(minute / 700)) + Math.floor(unit(asset, minute, 1) * 200) - 100;
  const close = open + Math.floor(unit(asset, minute, 2) * 41) - 20;
  const low = Math.min(open, close) - Math.floor(unit(asset, minute, 3) * 15);
  const high = Math.max(open, close) + Math.floor(unit(asset, minute, 4) * 15);
  return [bucket, low / scale, high / scale, open / scale, close / scale, Math.floor(unit(asset, minute, 5) * 1e6) / 1e4];
}
// What the store must hold for bucket starts [from, to): [closeTimeMs, low, high, open, close, volume], time order.
function expectedRows(asset, from, to) {
  const rows = [];
  for (let t = from; t < to; t += MINUTE) { const row = candle(asset, t / 1000); if (row) rows.push([t + MINUTE, ...row.slice(1)]); }
  return rows;
}
// replay.js: `for(let t=first-MINUTE;t<e;t+=299*MINUTE)chunks.push([t,Math.min(t+299*MINUTE,e)])`, with the last
// chunk clipped at the last wanted bucket (the mirror test below checks this against replay.js itself).
function chunksOf(from, to) {
  const chunks = [];
  for (let t = from; t < to; t += 299 * MINUTE) chunks.push([t, Math.min(t + 299 * MINUTE, to - MINUTE)]);
  return chunks;
}

// ---- a loopback exchange: Coinbase's response shape (newest first), its 300-bucket limit, and injected faults
let realRequests = 0;                       // requests that reached any loopback server of this file
async function startServer(t) {
  const state = {requests: [], count: {BTC: 0, LINK: 0}, fault: () => undefined, hung: []};
  const server = http.createServer((req, res) => {
    realRequests++;
    const url = new URL(req.url, 'http://loopback.invalid');
    const asset = /^\/products\/(BTC|LINK)-USD\/candles$/.exec(url.pathname)?.[1];
    const start = Date.parse(url.searchParams.get('start')), end = Date.parse(url.searchParams.get('end'));
    const record = {url: req.url, asset, start, end, n: asset ? ++state.count[asset] : 0, status: null, sha256: null, rowCount: null};
    state.requests.push(record);
    const send = (status, body, headers = {}) => {
      record.status = status; record.sha256 = sha(body);
      res.writeHead(status, {'content-type': 'application/json', ...headers}); res.end(body);
    };
    if (req.method !== 'GET' || !asset || url.searchParams.get('granularity') !== '60' || !Number.isFinite(start) ||
        !Number.isFinite(end) || start % MINUTE || end % MINUTE || end < start) return send(400, '{"message":"bad request"}');
    if ((end - start) / MINUTE + 1 > 300) return send(400, '{"message":"more than 300 buckets requested"}');
    const fault = state.fault(record) ?? {};
    if (fault.hang) { record.status = 'hang'; state.hung.push(res); return; }
    // Headers and the start of a body, then silence: the response never ends.
    if (fault.stall) { record.status = 'stalled'; res.writeHead(200, {'content-type': 'application/json'}); res.write('[[17590'); state.hung.push(res); return; }
    if (fault.destroy) { record.status = 'destroyed'; req.socket.destroy(); return; }
    if (fault.status) return send(fault.status, fault.body ?? '{"message":"synthetic failure"}', fault.headers);
    if (fault.body !== undefined) return send(200, fault.body);
    let rows = [];
    for (let bucket = end / 1000; bucket >= start / 1000; bucket -= 60) { const row = candle(asset, bucket); if (row) rows.push(row); }
    if (fault.rows) rows = fault.rows(rows, record);
    record.rowCount = rows.length;
    // Not the text JSON.stringify would give back: a receipt must hash the bytes that were sent, not a re-encoding.
    send(200, `[${rows.map(row => JSON.stringify(row)).join(',\n ')}]\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const res of state.hung) res.destroy();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return {state, baseUrl: `http://127.0.0.1:${server.address().port}`};
}
// Faults keyed by "<ASSET> <n>": the n-th request that asset's stream makes (retries count), deterministic because
// each asset is one sequential stream.
const faults = table => ({asset, n}) => table[`${asset} ${n}`];

// ---- reading the store without the code under test
function readRows(file) {
  const bytes = fs.readFileSync(file), rows = [];
  assert.equal(bytes.length % 48, 0);
  for (let offset = 0; offset < bytes.length; offset += 48) rows.push([0, 8, 16, 24, 32, 40].map(k => bytes.readDoubleLE(offset + k)));
  return rows;
}
const candleFile = (dir, asset, month) => path.join(dir, 'candles', asset, `${month}.f64`);
const receiptsFile = (dir, asset, month) => path.join(dir, 'receipts', asset, `${month}.jsonl`);
const manifestFile = dir => path.join(dir, 'manifest.json');
const readManifestFile = dir => JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8'));
const readReceipts = (dir, asset, month) =>
  fs.readFileSync(receiptsFile(dir, asset, month), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
function filesIn(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? filesIn(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]).sort();
}
// A store written by hand in the documented layout, to test the loader on its own. Without `receipts` the entry
// binds no receipts file (the first version's shape); with a list of receipt objects it binds one, as the fetcher does.
function writeStore(dir, asset, month, rows, overrides = {}, bounds = {from: iso(EXPLORATION_FROM), to: iso(RESERVED_FROM)}, receipts = null, source = 'written by hand in a test') {
  const bytes = Buffer.alloc(rows.length * 48), file = manifestFile(dir), bound = {};
  rows.forEach((row, i) => row.forEach((value, j) => bytes.writeDoubleLE(value, i * 48 + j * 8)));
  fs.mkdirSync(path.dirname(candleFile(dir, asset, month)), {recursive: true});
  fs.writeFileSync(candleFile(dir, asset, month), bytes);
  if (receipts) {
    const text = receipts.map(receipt => JSON.stringify(receipt) + '\n').join('');
    fs.mkdirSync(path.dirname(receiptsFile(dir, asset, month)), {recursive: true});
    fs.writeFileSync(receiptsFile(dir, asset, month), text);
    Object.assign(bound, {requests: receipts.length, receipts: receipts.length, receiptsSha256: sha(text)});
  }
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {format: 'paper-trail-research-candles-v1', source, bounds, assets: {}};
  (manifest.assets[asset] ??= {months: {}}).months[month] = {rows: rows.length, firstClose: rows[0]?.[0] ?? null,
    lastClose: rows.at(-1)?.[0] ?? null, sha256: sha(bytes), requests: 0, fetchedAt: '2020-01-01T00:00:00.000Z', complete: true, ...bound, ...overrides};
  fs.writeFileSync(file, JSON.stringify(manifest));
}
const handRow = (bucketStart, close = 100) => [bucketStart + MINUTE, close - 1, close + 1, close, close, 2];
const editManifest = (dir, change) => { const manifest = readManifestFile(dir); change(manifest); fs.writeFileSync(manifestFile(dir), JSON.stringify(manifest)); };

// A stub exchange for fetchImpl: the synthetic candles of the buckets a request names, newest first as the exchange
// sends them. `keep(asset, bucketSeconds, request)` can drop rows; nothing is connected to.
const stubExchange = (keep = () => true) => async url => {
  const target = new URL(url), asset = /^\/products\/(BTC|LINK)-USD\/candles$/.exec(target.pathname)[1], rows = [];
  const request = {asset, start: Date.parse(target.searchParams.get('start')), end: Date.parse(target.searchParams.get('end'))};
  for (let bucket = request.end / 1000; bucket >= request.start / 1000; bucket -= 60) {
    const row = candle(asset, bucket);
    if (row && keep(asset, bucket, request)) rows.push(row);
  }
  return new Response(JSON.stringify(rows), {headers: {date: 'Mon, 29 Sep 2025 00:00:00 GMT'}});
};

// ORDER MATTERS: a test may mock timers only before the first real HTTP request of this file, so the tests that do
// are placed ahead of every test that talks to the loopback server. Node's HTTP client keeps a real timer on each
// idle socket and clears it when the socket closes. While setTimeout is mocked, clearTimeout is mocked too and does
// not clear a real timer; that timer then fires seconds later, after its connection is gone, and fails the file with
// an uncaught exception, but only in a run that lasts long enough to see it. The check below turns that into a plain
// failure at the point of the mistake.
function mockTimers(t) {
  assert.equal(realRequests, 0, 'a test that mocks timers must run before any test that makes a real HTTP request');
  t.mock.timers.enable({apis: ['setTimeout']});
}

// A virtual clock on node:test's mock timers. Only setTimeout is mocked, so the fetcher's pauses, retry waits and
// request timeouts pass without real waiting, while `now` counts the milliseconds they were armed for. `settle`
// lets the code run up to its next timer, then moves the clock one step, until the promise settles. Every wait in
// the tests that use it is a multiple of the step, so every time read from `now` is exact.
function virtualClock(t) {
  mockTimers(t);
  const clock = {now: 0, async settle(promise, stepMs = 10, limitMs = 3600000) {
    let done = false;
    const start = clock.now, outcome = promise.then(value => ({value}), error => ({error})).finally(() => { done = true; });
    for (;;) {
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
      if (done) return outcome;
      assert.ok(clock.now - start < limitMs, `the fetch did not settle within ${limitMs} virtual ms`);
      clock.now += stepMs; t.mock.timers.tick(stepMs);
    }
  }};
  return clock;
}

// =====================================================================================================================

test('guard: reserved and pre-exploration dates are refused before any request reaches the server', async t => {
  const server = await startServer(t), dir = tmp(t);
  const run = options => fetchCandles({dir, baseUrl: server.baseUrl, pauseMs: 0, log: quiet, ...options});
  await assert.rejects(run({from: '2025-09-27', to: '2025-10-01'}), /to 2025-10-01 reaches the reserved range.*no override/);
  await assert.rejects(run({from: '2025-09-27', to: '2026-10-01'}), /reserved range/);
  await assert.rejects(run({to: '2025-10-01'}), /reserved range/);
  await assert.rejects(run({from: '2019-12-31', to: '2020-01-02'}), /from 2019-12-31 is before the exploration range.*no override/);
  await assert.rejects(run({from: '2019-12-31'}), /before the exploration range/);
  await assert.rejects(run({from: '2025-09-30', to: '2025-09-30'}), /from must be earlier than to/);
  await assert.rejects(run({from: '2025-09-29', to: '2025-09-28'}), /from must be earlier than to/);
  for (const bad of ['2025-9-29', '2025-09-29T00:00:00Z', '2025-02-30', '2025-13-01', '', 20250929, null, new Date(utc('2025-09-29'))]) {
    await assert.rejects(run({from: bad, to: '2025-09-30'}), /from must be a UTC calendar date/);
    await assert.rejects(run({from: '2025-09-01', to: bad}), /to must be a UTC calendar date/);
  }
  for (const assets of [[], ['ETH'], ['BTC', 'BTC'], 'BTC', ['BTC', 'LINK', 'ETH']])
    await assert.rejects(run({from: '2025-09-29', to: '2025-09-30', assets}), /assets must be/);
  assert.equal(server.state.requests.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('guard: only the Coinbase default or a loopback http URL is accepted as base URL, and the public pause has a floor', async t => {
  const server = await startServer(t), dir = tmp(t), port = new URL(server.baseUrl).port;
  let calls = 0;
  // Answers HTTP 418, which is not retried: a configuration that should have been refused but made a request fails
  // its assertion at once instead of waiting through retries.
  const spy = async () => { calls++; return new Response('{"message":"a refused configuration made a request"}', {status: 418}); };
  const run = options => fetchCandles({from: '2025-09-29', to: '2025-09-30', dir, pauseMs: 250, fetchImpl: spy, log: quiet, ...options});
  // \u0040 is the at sign: a userinfo part must not smuggle in another host.
  for (const baseUrl of ['http://example.com', `http://example.com:${port}`, 'https://example.com', `http://127.0.0.1.example.com:${port}`,
    `http://localhost.example.com:${port}`, `http://localhost.:${port}`, 'https://api.exchange.coinbase.com.example.com',
    'https://api.exchange.coinbase.com:8443', 'https://api.exchange.coinbase.com/', 'https://api.exchange.coinbase.com/v2',
    'http://api.exchange.coinbase.com', 'https://API.exchange.coinbase.com', `https://127.0.0.1:${port}`, `http://user:secret\u0040127.0.0.1:${port}`,
    `http://127.0.0.1:${port}\u0040example.com`, `http://127.0.0.1:${port}/proxy`, `http://127.0.0.1:${port}/?to=2026`, `http://[::1]:${port}`,
    `http://0.0.0.0:${port}`, `http://127.0.0.2:${port}`, `ftp://127.0.0.1:${port}`, `//127.0.0.1:${port}`, 'not a url', '', null, 7,
    new URL(server.baseUrl)])
    await assert.rejects(run({baseUrl}), /baseUrl must be exactly https:\/\/api\.exchange\.coinbase\.com or a loopback/, String(baseUrl));
  // The public exchange is never asked faster than one request per 200 ms per stream; loopback may be.
  await assert.rejects(run({pauseMs: 199}), /pauseMs below 200 is refused/);
  await assert.rejects(run({baseUrl: COINBASE_URL, pauseMs: 0}), /pauseMs below 200 is refused/);
  await assert.rejects(run({baseUrl: server.baseUrl, pauseMs: -1}), /pauseMs must be/);
  await assert.rejects(run({baseUrl: server.baseUrl, maxAttempts: 0}), /maxAttempts must be/);
  // Nor is it retried sooner than 200 ms after a failure, or more than 10 times for one request.
  await assert.rejects(run({backoffMs: 199}), /backoffMs below 200 is refused for the public exchange/);
  await assert.rejects(run({backoffMs: 0, maxAttempts: 300}), /refused for the public exchange/);
  await assert.rejects(run({maxAttempts: 11}), /maxAttempts above 10 is refused for the public exchange/);
  await assert.rejects(run({maxAttempts: 300}), /maxAttempts above 10 is refused for the public exchange/);
  for (const maxAttempts of [1.5, Infinity, NaN, '6', null])
    await assert.rejects(run({baseUrl: server.baseUrl, maxAttempts}), /maxAttempts must be a positive integer/);
  // No single wait may be longer than 5 minutes, on any host. Node turns a timer above 2**31-1 ms into a 1 ms
  // timer, so such a pause would be no pause and such a timeout would fail every request at once.
  assert.equal(MAX_WAIT_MS, 300000);
  for (const baseUrl of [COINBASE_URL, server.baseUrl]) for (const wait of [300001, 2 ** 31 - 1, 2 ** 31, 1e300, Infinity, NaN, -1, '250', null, 250n]) {
    await assert.rejects(run({baseUrl, pauseMs: wait}), /pauseMs must be a number from 0 to 300000 \(5 minutes\)/, String(wait));
    await assert.rejects(run({baseUrl, backoffMs: wait}), /backoffMs must be a number from 0 to 300000 \(5 minutes\)/, String(wait));
    await assert.rejects(run({baseUrl, timeoutMs: wait}), /timeoutMs must be a positive number of at most 300000 \(5 minutes\)/, String(wait));
  }
  await assert.rejects(run({baseUrl: server.baseUrl, timeoutMs: 0}), /timeoutMs must be a positive number/);
  assert.equal(calls, 0);
  assert.equal(server.state.requests.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  // Both loopback spellings are accepted (a stub answers, so no name resolution is involved).
  for (const baseUrl of [`http://localhost:${port}`, `http://127.0.0.1:${port}/`]) {
    const urls = [];
    const summary = await fetchCandles({from: '2025-09-29', to: '2025-09-30', assets: ['BTC'], dir: tmp(t), baseUrl, pauseMs: 0,
      fetchImpl: async url => { urls.push(String(url)); return new Response('[]'); }, log: quiet});
    assert.equal(summary.requests, 5);
    assert.ok(urls.every(url => url.startsWith(`${baseUrl.replace(/\/$/, '')}/products/BTC-USD/candles?granularity=60&start=2025-09-29T`)));
  }
});

test('request URLs are the ones replay.js builds, except that the last chunk stops short of the reserved bucket', async t => {
  mockTimers(t);                                  // the pauses of both fetchers pass without waiting
  const settle = async (promise, stepMs) => {
    let done = false;
    const outcome = promise.then(value => ({value}), error => ({error})).finally(() => { done = true; });
    for (let i = 0; !done; i++) {
      assert.ok(i < 5000, 'the fetch did not settle');
      t.mock.timers.tick(stepMs);
      await new Promise(resolve => setImmediate(resolve));
    }
    return outcome;
  };
  const from = utc('2025-09-29'), byAsset = (urls, asset) => urls.filter(url => url.includes(`/products/${asset}-USD/`));
  // replay.js itself, on the same buckets: its `first-MINUTE` is 2025-09-29T00:00Z, its `e` the close 2025-09-30T00:00Z.
  const theirs = [], realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async url => { theirs.push(String(url)); return new Response('[]'); };
  const replay = await settle(fetchHistoricalRange({start: from + 61 * MINUTE, end: RESERVED_FROM, warmupMinutes: 60}), 350);
  globalThis.fetch = realFetch;
  assert.match(replay.error.message, /Exact start\/end close missing/);   // the stub serves no rows; only the URLs matter
  const mine = [];
  const stub = async url => { mine.push(String(url)); return new Response('[]', {headers: {date: 'Mon, 29 Sep 2025 00:00:00 GMT'}}); };
  const result = await settle(fetchCandles({from: '2025-09-29', to: '2025-09-30', dir: tmp(t), pauseMs: 200, fetchImpl: stub, log: quiet}), 200);
  assert.equal(result.error, undefined);
  assert.equal(result.value.source, SOURCE);
  for (const asset of ASSETS) {
    const a = byAsset(mine, asset), b = byAsset(theirs, asset);
    assert.equal(a.length, 5);
    assert.equal(b.length, 5);
    assert.deepEqual(a.slice(0, 4), b.slice(0, 4));
    const last = new URL(a[4]), theirLast = new URL(b[4]);
    assert.equal(last.origin + last.pathname, theirLast.origin + theirLast.pathname);
    assert.equal(last.searchParams.get('granularity'), '60');
    assert.equal(last.searchParams.get('start'), theirLast.searchParams.get('start'));
    assert.equal(theirLast.searchParams.get('end'), '2025-09-30T00:00:00.000Z');   // replay.js asks for one bucket past its last close
    assert.equal(last.searchParams.get('end'), '2025-09-29T23:59:00.000Z');        // the guard: the reserved bucket is never asked for
  }
  assert.equal(byAsset(mine, 'BTC')[0],
    'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2025-09-29T00%3A00%3A00.000Z&end=2025-09-29T04%3A59%3A00.000Z');
});

// The defaults a real run uses (pauseMs 250, backoffMs 500, maxAttempts 6, timeoutMs 15000) on the public host. A
// stub answers in place of the exchange and the clock is virtual, so nothing is contacted and nothing is waited for.
test('pacing with the default options on the public host, under a virtual clock', async t => {
  const clock = virtualClock(t), day = {from: '2025-09-29', to: '2025-09-30'};
  const assetOf = url => /\/products\/(BTC|LINK)-USD\//.exec(String(url))[1];
  const empty = () => new Response('[]'), status = (code, headers = {}) => new Response('{"message":"synthetic"}', {status: code, headers});

  await t.test('250 ms between the requests of a stream, one stream per asset, one request in flight per stream', async () => {
    const zero = clock.now, at = {BTC: [], LINK: []}, flying = {BTC: 0, LINK: 0}, most = {BTC: 0, LINK: 0, both: 0};
    const result = await clock.settle(fetchCandles({...day, dir: tmp(t), log: quiet, fetchImpl: async url => {
      const asset = assetOf(url);
      at[asset].push(clock.now - zero);
      flying[asset]++;
      most[asset] = Math.max(most[asset], flying[asset]); most.both = Math.max(most.both, flying.BTC + flying.LINK);
      await new Promise(resolve => setImmediate(resolve));          // the answer takes a moment, so overlaps would show
      flying[asset]--;
      return empty();
    }}));
    assert.equal(result.error, undefined);
    assert.equal(result.value.source, SOURCE);
    assert.deepEqual(at, {BTC: [0, 250, 500, 750, 1000], LINK: [0, 250, 500, 750, 1000]});
    assert.deepEqual(most, {BTC: 1, LINK: 1, both: 2});
  });

  await t.test('500 ms * 2**n between the attempts of a request, six attempts, then the run fails', async () => {
    const zero = clock.now, at = [];
    const result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, fetchImpl: async () => { at.push(clock.now - zero); return status(429); }}));
    assert.match(result.error.message, /^BTC 2025-09: HTTP 429 on attempt 6 of 6: https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-USD\//);
    assert.deepEqual(at, [0, 500, 1500, 3500, 7500, 15500]);
    assert.equal(clock.now - zero, 15500);                // nothing is waited for after the last attempt
  });

  await t.test('an attempt is never made sooner after the one before than the stream\'s own pause', async () => {
    const zero = clock.now, at = [];
    const result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, pauseMs: 5000,
      fetchImpl: async () => { at.push(clock.now - zero); return status(503); }}), 50);
    assert.match(result.error.message, /HTTP 503 on attempt 6 of 6/);
    assert.deepEqual(at, [0, 5000, 10000, 15000, 20000, 28000]);   // waits of max(5000, 500 * 2**n): the last backoff is 8000
  });

  await t.test('a request is given 15000 ms, then cut off and tried again', async () => {
    const zero = clock.now, started = [], cut = [];
    const never = (url, {signal}) => new Promise((resolve, reject) => {
      started.push(clock.now - zero);
      signal.addEventListener('abort', () => { cut.push(clock.now - zero); reject(signal.reason); });
    });
    const result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, maxAttempts: 2, fetchImpl: never}), 10, 120000);
    assert.match(result.error.message, /^BTC 2025-09: timed out after 15000 ms on attempt 2 of 2: https:\/\/api\.exchange\.coinbase\.com\//);
    assert.deepEqual({started, cut}, {started: [0, 15500], cut: [15000, 30500]});
  });

  await t.test('the 15000 ms cover the body: headers at once and a body that never comes are cut off the same way', async () => {
    const zero = clock.now, started = [], cut = [];
    const stalls = async (url, {signal}) => {
      started.push(clock.now - zero);
      return {ok: true, status: 200, headers: new Headers(), arrayBuffer: () => new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => { cut.push(clock.now - zero); reject(signal.reason); }))};
    };
    const result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, maxAttempts: 2, fetchImpl: stalls}), 10, 120000);
    assert.match(result.error.message, /^BTC 2025-09: timed out after 15000 ms on attempt 2 of 2: /);
    assert.deepEqual({started, cut}, {started: [0, 15500], cut: [15000, 30500]});
  });

  await t.test('Retry-After is waited out when it is longer than the backoff, logged, and capped at 5 minutes', async () => {
    const zero = clock.now, at = [], lines = [];
    // Five 429 answers, then success. 2147484 s is above 2**31-1 ms: uncapped, Node would retry after 1 ms.
    const asked = ['1', '0.2', '2147484', ' 86400 ', 'Wed, 21 Oct 2026 07:28:00 GMT'];
    const result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: line => lines.push(line), fetchImpl: async () => {
      at.push(clock.now - zero);
      return at.length <= asked.length ? status(429, {'retry-after': asked[at.length - 1]}) : empty();
    }}), 250);
    assert.equal(result.error, undefined);
    // Waits: 1000 (Retry-After 1 s over backoff 500), 1000 (backoff over 0.2 s), 300000 and 300000 (the cap), 8000
    // (backoff; an HTTP date is not honoured), then the stream's 250 ms pauses.
    assert.deepEqual(at, [0, 1000, 2000, 302000, 602000, 610000, 610250, 610500, 610750, 611000]);
    assert.deepEqual(lines.filter(line => line.includes('Retry-After')), [
      'BTC 2025-09: HTTP 429; Retry-After asks for 1 s: waiting 1s before attempt 2 of 6',
      'BTC 2025-09: HTTP 429; Retry-After asks for 2147484 s, more than the 5m00s maximum: waiting 5m00s before attempt 4 of 6',
      'BTC 2025-09: HTTP 429; Retry-After asks for 86400 s, more than the 5m00s maximum: waiting 5m00s before attempt 5 of 6']);
    assert.match(lines.at(-2), /^BTC 2025-09: 0 rows from 5 requests, 5 retries, 5 empty responses; 5\/5 requests done, ETA 0s$/);
  });

  await t.test('the longest pause allowed, 5 minutes, and the lowest floor of the public host are waited in full', async () => {
    let zero = clock.now, at = [];
    let result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, pauseMs: 300000,
      fetchImpl: async () => { at.push(clock.now - zero); return empty(); }}), 1000);
    assert.equal(result.error, undefined);
    assert.deepEqual(at, [0, 300000, 600000, 900000, 1200000]);
    zero = clock.now; at = [];
    result = await clock.settle(fetchCandles({...day, assets: ['BTC'], dir: tmp(t), log: quiet, pauseMs: 200, backoffMs: 200, maxAttempts: 10,
      fetchImpl: async () => { at.push(clock.now - zero); return status(500); }}), 100);
    assert.match(result.error.message, /HTTP 500 on attempt 10 of 10/);
    assert.deepEqual(at, [0, 200, 600, 1400, 3000, 6200, 12600, 25400, 51000, 102200]);
  });

  await t.test('a failure in one stream stops the other before its next request, without another pause', async () => {
    const zero = clock.now, at = {BTC: [], LINK: []};
    const result = await clock.settle(fetchCandles({...day, dir: tmp(t), log: quiet, fetchImpl: async url => {
      const asset = assetOf(url);
      at[asset].push(clock.now - zero);
      if (asset === 'BTC') return status(404);
      await new Promise(resolve => setImmediate(resolve));          // LINK's answer arrives after BTC's failure
      return empty();
    }}));
    assert.match(result.error.message, /^BTC 2025-09: HTTP 404 on attempt 1 of 6: /);
    assert.deepEqual(at, {BTC: [0], LINK: [0]});          // LINK had four more requests to make
    assert.ok(clock.now - zero < 250, `settled after ${clock.now - zero} virtual ms`);
  });

  await t.test('...and before its next attempt, when it is waiting to retry', async () => {
    const zero = clock.now, at = {BTC: [], LINK: []};
    const result = await clock.settle(fetchCandles({...day, dir: tmp(t), log: quiet, fetchImpl: async url => {
      const asset = assetOf(url);
      at[asset].push(clock.now - zero);
      if (asset === 'LINK') return status(500);
      return at.BTC.length === 1 ? empty() : status(404);
    }}));
    assert.match(result.error.message, /^BTC 2025-09: HTTP 404 on attempt 1 of 6: /);
    assert.deepEqual(at, {BTC: [0, 250], LINK: [0]});     // LINK's second attempt was due at 500, after BTC failed at 250
    assert.equal(clock.now - zero, 500);
  });
});

test('a range ending at the reserved boundary: requests, stored rows, receipts, manifest, resume, loader and coverage', async t => {
  const server = await startServer(t), dir = tmp(t), lines = [];
  const FROM = utc('2025-09-27'), TO = RESERVED_FROM, chunks = chunksOf(FROM, TO);
  const expected = Object.fromEntries(ASSETS.map(asset => [asset, expectedRows(asset, FROM, TO)]));
  const options = {from: '2025-09-27', to: '2025-09-30', dir, baseUrl: server.baseUrl, pauseMs: 0, backoffMs: 1, log: line => lines.push(line)};
  // A 429 then success, a 500 then success, a 503 then success and a dropped connection then success.
  server.state.fault = faults({'BTC 3': {status: 429, headers: {'retry-after': '0'}}, 'LINK 5': {status: 500}, 'BTC 8': {status: 503}, 'LINK 2': {destroy: true}});
  const summary = await fetchCandles(options);
  server.state.fault = () => undefined;
  const firstRun = server.state.requests.slice();

  await t.test('no request names a bucket at or after RESERVED_FROM, or outside [from, to), or more than 300 buckets', () => {
    assert.equal(chunks.length, 15);
    assert.equal(firstRun.length, 2 * 15 + 4);
    for (const request of firstRun) {
      const url = new URL(request.url, server.baseUrl);
      assert.deepEqual([...url.searchParams.keys()], ['granularity', 'start', 'end']);
      assert.equal(url.searchParams.get('granularity'), '60');
      assert.equal(url.searchParams.get('start'), iso(request.start));
      assert.equal(url.searchParams.get('end'), iso(request.end));
      assert.ok(request.start >= FROM && request.start <= request.end && request.end < RESERVED_FROM, request.url);
      assert.ok((request.end - request.start) / MINUTE + 1 <= 300, request.url);
    }
    assert.equal(Math.max(...firstRun.map(request => request.end)), RESERVED_FROM - MINUTE);   // the last allowed bucket is asked for
    for (const asset of ASSETS) {
      const mine = firstRun.filter(request => request.asset === asset);
      // Every chunk once successfully, in order: 300 buckets each, consecutive chunks sharing exactly one bucket.
      assert.deepEqual(mine.filter(request => request.status === 200).map(request => [request.start, request.end]), chunks);
      chunks.slice(1).forEach(([start], i) => assert.equal(start, chunks[i][1]));
      chunks.slice(0, -1).forEach(([start, end]) => assert.equal((end - start) / MINUTE + 1, 300));
      // Every failed attempt is followed by a retry of the same URL.
      mine.forEach((request, i) => { if (request.status !== 200) assert.equal(mine[i + 1].url, request.url); });
      assert.equal(mine.filter(request => request.status !== 200).length, 2);
    }
    assert.deepEqual(firstRun.map(request => request.status).filter(status => status !== 200).sort(), [429, 500, 503, 'destroyed'].sort());
  });

  await t.test('stored rows are sorted, unique, inside the bounds and carry bucket start + 60 s as their time', () => {
    assert.deepEqual(filesIn(dir), ['candles/BTC/2025-09.f64', 'candles/LINK/2025-09.f64', 'manifest.json',
      'receipts/BTC/2025-09.jsonl', 'receipts/LINK/2025-09.jsonl']);
    for (const asset of ASSETS) {
      const rows = readRows(candleFile(dir, asset, '2025-09'));
      assert.ok(rows.length > 3500 && rows.length < 4320, 'the synthetic series has missing minutes');
      rows.forEach((row, i) => {
        assert.ok(Number.isSafeInteger(row[0]) && row[0] % MINUTE === 0);
        assert.ok(row[0] - MINUTE >= FROM && row[0] - MINUTE < RESERVED_FROM, 'bucket start inside [from, RESERVED_FROM)');
        if (i) assert.ok(row[0] > rows[i - 1][0], 'strictly increasing, so unique');
      });
      assert.deepEqual(rows, expected[asset]);            // every observed minute, no filled minute, all six values
      assert.equal(rows[0][0], FROM + MINUTE);
      assert.equal(rows.at(-1)[0], RESERVED_FROM);        // the bucket starting 2025-09-29T23:59Z closes at the boundary and is kept
    }
  });

  await t.test('receipts match the responses and the manifest matches the files', () => {
    const manifest = readManifestFile(dir);
    assert.deepEqual(Object.keys(manifest), ['format', 'source', 'bounds', 'assets']);
    assert.equal(manifest.format, 'paper-trail-research-candles-v1');
    assert.equal(manifest.source, LOOPBACK_SOURCE);
    assert.deepEqual(manifest.bounds, {from: '2020-01-01T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z'});
    assert.deepEqual(Object.keys(manifest.assets), ASSETS);
    for (const asset of ASSETS) {
      const receipts = readReceipts(dir, asset, '2025-09'), entry = manifest.assets[asset].months['2025-09'];
      assert.equal(receipts.length, 15);
      receipts.forEach((receipt, i) => {
        assert.deepEqual(Object.keys(receipt), ['url', 'receivedAt', 'httpDate', 'sha256', 'rowCount', 'attempts']);
        const seen = firstRun.filter(request => server.baseUrl + request.url === receipt.url), served = seen.filter(request => request.status === 200);
        assert.equal(served.length, 1);
        assert.deepEqual([served[0].asset, served[0].start, served[0].end], [asset, ...chunks[i]]);
        assert.equal(receipt.sha256, served[0].sha256);   // SHA-256 of the raw body the server sent
        assert.equal(receipt.rowCount, served[0].rowCount);
        assert.equal(receipt.attempts, seen.length);
        assert.ok(Number.isSafeInteger(receipt.receivedAt));
        assert.ok(Number.isFinite(Date.parse(receipt.httpDate)));
      });
      assert.deepEqual(receipts.map(receipt => receipt.attempts).filter(attempts => attempts !== 1), [2, 2]);
      const duplicates = chunks.slice(1).filter(([start]) => candle(asset, start / 1000)).length;
      assert.ok(duplicates > 0);
      assert.ok(Number.isFinite(Date.parse(entry.fetchedAt)));
      // The entry binds both files of the month by SHA-256 and says how the month ended: no empty answer, and the
      // last wanted bucket (2025-09-29T23:59Z) came back.
      assert.deepEqual({...entry, fetchedAt: null}, {rows: expected[asset].length, firstClose: FROM + MINUTE, lastClose: RESERVED_FROM,
        sha256: sha(fs.readFileSync(candleFile(dir, asset, '2025-09'))), requests: 15, receipts: 15,
        receiptsSha256: sha(fs.readFileSync(receiptsFile(dir, asset, '2025-09'))), emptyResponses: 0, lastBucketPresent: true,
        fetchedAt: null, complete: true, from: '2025-09-27T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z', duplicateRows: duplicates});
      assert.equal(receipts.reduce((sum, receipt) => sum + receipt.rowCount, 0), entry.rows + entry.duplicateRows);
    }
    // The committable manifest carries each month's receipt count and the SHA-256 of its receipts file, and
    // nothing a receipt holds: no request URL, no receive time, no local path.
    const committable = publicManifest(dir), text = JSON.stringify(committable);
    assert.deepEqual(committable, manifest);
    for (const asset of ASSETS)
      assert.deepEqual([committable.assets[asset].months['2025-09'].receipts, committable.assets[asset].months['2025-09'].receiptsSha256],
        [15, sha(fs.readFileSync(receiptsFile(dir, asset, '2025-09')))]);
    assert.doesNotMatch(text, /https?:\/\/|"url"|receivedAt|httpDate|127\.0\.0\.1|products/i);
    assert.ok(!text.includes(dir));
    // receiptsSummary reads the receipts files themselves.
    assert.deepEqual(receiptsSummary(dir), Object.fromEntries(ASSETS.map(asset => [asset,
      {files: 1, receipts: 15, sha256: {'2025-09': sha(fs.readFileSync(receiptsFile(dir, asset, '2025-09')))}}])));
  });

  await t.test('the summary and one progress line per completed month', () => {
    assert.deepEqual({...summary, elapsedMs: null}, {format: 'paper-trail-research-candles-v1', dir, source: LOOPBACK_SOURCE,
      from: '2025-09-27', to: '2025-09-30', bounds: {from: '2020-01-01T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z'}, requests: 30, elapsedMs: null,
      assets: {BTC: {months: 1, fetched: 1, skipped: 0, requests: 15, rows: expected.BTC.length, emptyResponses: {}, lastBucketMissing: []},
        LINK: {months: 1, fetched: 1, skipped: 0, requests: 15, rows: expected.LINK.length, emptyResponses: {}, lastBucketMissing: []}}});
    // The two streams interleave, so the first month to finish reports between 15 and 29 requests done. No
    // warning line: every month's last bucket came back, and the one Retry-After (0 s) was shorter than the backoff.
    assert.equal(lines.length, 2);
    for (const asset of ASSETS)
      assert.equal(lines.filter(line => new RegExp(`^${asset} 2025-09: ${expected[asset].length} rows from 15 requests, 2 retries; (1[5-9]|2\\d|30)/30 requests done, ETA \\d+s$`).test(line)).length, 1, lines.join('\n'));
    assert.match(lines[1], /; 30\/30 requests done, ETA 0s$/);
  });

  await t.test('a second run makes zero requests and changes nothing', async () => {
    const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    lines.length = 0;
    const again = await fetchCandles(options);
    assert.equal(server.state.requests.length, firstRun.length);
    assert.equal(again.requests, 0);
    assert.deepEqual(again.assets.BTC, {months: 1, fetched: 0, skipped: 1, requests: 0, rows: expected.BTC.length, emptyResponses: {}, lastBucketMissing: []});
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
    assert.deepEqual(lines, []);
    // A narrower range inside what is stored is also complete; the stored range is not shrunk.
    await fetchCandles({...options, from: '2025-09-28', to: '2025-09-29'});
    assert.equal(server.state.requests.length, firstRun.length);
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
  });

  await t.test('loadSeries round-trips the stored closes and filters by close time, both ends inclusive', () => {
    for (const asset of ASSETS) {
      const series = loadSeries(dir, asset), rows = expected[asset];
      assert.ok(series.time instanceof Float64Array && series.close instanceof Float64Array);
      assert.deepEqual([...series.time], rows.map(row => row[0]));
      assert.deepEqual([...series.close], rows.map(row => row[4]));
      const a = rows[100][0], b = rows[900][0], part = loadSeries(dir, asset, {fromClose: a, toClose: b});
      assert.deepEqual([...part.time], rows.slice(100, 901).map(row => row[0]));
      assert.deepEqual([...part.close], rows.slice(100, 901).map(row => row[4]));
      assert.equal(loadSeries(dir, asset, {fromClose: a + 1}).time.length, rows.length - 101);
      assert.equal(loadSeries(dir, asset, {toClose: b - 1}).time.length, 900);
      assert.equal(loadSeries(dir, asset, {fromClose: RESERVED_FROM + MINUTE}).time.length, 0);
    }
    assert.throws(() => loadSeries(dir, 'ETH'), /Unknown asset/);
    assert.throws(() => loadSeries(dir, 'BTC', {fromClose: '2025-09-27'}), /millisecond timestamps/);
  });

  await t.test('coverage() counts expected, observed and shared minute closes', () => {
    const market = {BTC: loadSeries(dir, 'BTC'), LINK: loadSeries(dir, 'LINK')};
    const count = (start, end) => {
      const result = {expected: 0, observed: {BTC: 0, LINK: 0}, shared: 0};
      for (let close = start; close <= end; close += MINUTE) {
        const [btc, link] = ASSETS.map(asset => close - MINUTE >= FROM && close - MINUTE < TO && candle(asset, (close - MINUTE) / 1000) !== null);
        result.expected++; result.observed.BTC += btc; result.observed.LINK += link; result.shared += btc && link;
      }
      return {...result, sharedFraction: result.shared / result.expected};
    };
    const whole = coverage(market, FROM + MINUTE, TO);
    assert.deepEqual(whole, count(FROM + MINUTE, TO));
    assert.equal(whole.expected, 3 * 1440);
    assert.deepEqual(whole.observed, {BTC: expected.BTC.length, LINK: expected.LINK.length});
    assert.ok(whole.shared < whole.observed.LINK && whole.observed.LINK < whole.observed.BTC && whole.observed.BTC < whole.expected);
    const day = [utc('2025-09-28') + MINUTE, utc('2025-09-29')];
    assert.deepEqual(coverage(market, ...day), count(...day));
    assert.equal(coverage(market, ...day).expected, 1440);
    // A range reaching past the stored data still expects every minute of the range.
    const wide = [FROM - 60 * MINUTE, TO + 60 * MINUTE];
    assert.deepEqual(coverage(market, ...wide), count(...wide));
    assert.equal(coverage(market, ...wide).expected, 3 * 1440 + 121);
    assert.deepEqual(coverage(market, FROM + MINUTE, FROM + MINUTE), {expected: 1, observed: {BTC: 1, LINK: 1}, shared: 1, sharedFraction: 1});
  });

  await t.test('loadSeries rejects a tampered file, and the next run fetches that month again', async () => {
    const file = candleFile(dir, 'BTC', '2025-09'), bytes = fs.readFileSync(file);
    bytes[bytes.length - 12] ^= 1;                        // one bit of the last close
    fs.writeFileSync(file, bytes);
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-09: candle file SHA-256 disagrees with the manifest/);
    assert.equal(loadSeries(dir, 'LINK').time.length, expected.LINK.length);
    fs.writeFileSync(file, bytes.subarray(0, bytes.length - 48));
    assert.throws(() => loadSeries(dir, 'BTC'), /SHA-256 disagrees/);
    fs.rmSync(file);
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-09: candle file unreadable \(ENOENT\)/);
    const seenBefore = server.state.requests.length;
    lines.length = 0;
    const repaired = await fetchCandles(options);
    assert.deepEqual(server.state.requests.slice(seenBefore).map(request => request.asset), Array(15).fill('BTC'));
    assert.deepEqual([repaired.assets.BTC.fetched, repaired.assets.LINK.fetched, repaired.requests], [1, 0, 15]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^BTC 2025-09: .*refetched: the stored files did not match the manifest.*15\/15 requests done/);
    assert.deepEqual(readRows(file), expected.BTC);
    assert.equal(loadSeries(dir, 'BTC').time.length, expected.BTC.length);
  });

  await t.test('loadSeries rejects receipts that are not the ones the manifest binds, and the next run fetches that month again', async () => {
    const file = receiptsFile(dir, 'LINK', '2025-09'), original = fs.readFileSync(file, 'utf8'), lineList = original.trimEnd().split('\n');
    const refetchesLink = async () => {
      const seenBefore = server.state.requests.length;
      lines.length = 0;
      const repaired = await fetchCandles(options);
      assert.deepEqual(server.state.requests.slice(seenBefore).map(request => request.asset), Array(15).fill('LINK'));
      assert.deepEqual([repaired.assets.BTC.fetched, repaired.assets.LINK.fetched, repaired.requests], [0, 1, 15]);
      assert.match(lines[0], /^LINK 2025-09: .*refetched: the stored files did not match the manifest/);
      assert.equal(loadSeries(dir, 'LINK').time.length, expected.LINK.length);
      assert.equal(readReceipts(dir, 'LINK', '2025-09').length, 15);
    };
    // One character of one receipt changed; a receipt removed; a receipt of another fetch added; the file gone.
    const tampered = [[original.replace('"attempts":1', '"attempts":7'), /LINK 2025-09: receipts file SHA-256 disagrees with the manifest/],
      [lineList.slice(1).join('\n') + '\n', /receipts file SHA-256 disagrees/],
      [original + lineList[0] + '\n', /receipts file SHA-256 disagrees/],
      [null, /LINK 2025-09: receipts file unreadable \(ENOENT\)/]];
    for (const [text, message] of tampered) {
      assert.notEqual(text, original);
      if (text === null) fs.rmSync(file); else fs.writeFileSync(file, text);
      assert.throws(() => loadSeries(dir, 'LINK'), message);
      assert.equal(loadSeries(dir, 'BTC').time.length, expected.BTC.length);      // the other asset is not affected
      await refetchesLink();
    }
    // A manifest entry whose receipt count is wrong for the file it binds is refused too.
    const before = fs.readFileSync(manifestFile(dir), 'utf8');
    editManifest(dir, manifest => { manifest.assets.LINK.months['2025-09'].receipts = 14; });
    assert.throws(() => loadSeries(dir, 'LINK'), /LINK 2025-09: receipts file holds 15 receipts, the manifest says 14/);
    // An entry that binds no receipts at all (the first version's shape) still loads, but is not kept on a rerun.
    editManifest(dir, manifest => { const entry = manifest.assets.LINK.months['2025-09']; delete entry.receipts; delete entry.receiptsSha256; });
    assert.equal(loadSeries(dir, 'LINK').time.length, expected.LINK.length);
    const seenBefore = server.state.requests.length;
    lines.length = 0;
    await fetchCandles(options);
    assert.equal(server.state.requests.length, seenBefore + 15);
    assert.match(lines[0], /^LINK 2025-09: .*refetched: the manifest entry bound no receipts/);
    assert.deepEqual({...JSON.parse(before).assets.LINK.months['2025-09'], fetchedAt: null, receiptsSha256: null},
      {...readManifestFile(dir).assets.LINK.months['2025-09'], fetchedAt: null, receiptsSha256: null});
  });
});

test('an interrupted month is fetched again; complete months are not', async t => {
  const server = await startServer(t), dir = tmp(t);
  const AUG = utc('2025-08-31'), SEP = utc('2025-09-01'), TO = utc('2025-09-02');
  const options = {from: '2025-08-31', to: '2025-09-02', assets: ['BTC'], dir, baseUrl: server.baseUrl, pauseMs: 0, backoffMs: 1, log: quiet};
  // Five chunks per day: the eighth request is the third chunk of September. A 404 is not retried.
  server.state.fault = faults({'BTC 8': {status: 404}});
  await assert.rejects(fetchCandles(options), /BTC 2025-09: HTTP 404 on attempt 1 of 6/);
  assert.equal(server.state.requests.length, 8);
  assert.deepEqual(filesIn(dir), ['candles/BTC/2025-08.f64', 'manifest.json', 'receipts/BTC/2025-08.jsonl']);
  assert.deepEqual(Object.keys(readManifestFile(dir).assets.BTC.months), ['2025-08']);
  // The row whose bucket starts 2025-08-31T23:59Z closes at 2025-09-01T00:00Z and belongs to August.
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-08')), expectedRows('BTC', AUG, SEP));
  assert.equal(readRows(candleFile(dir, 'BTC', '2025-08')).at(-1)[0], SEP);
  assert.deepEqual([...loadSeries(dir, 'BTC').time], expectedRows('BTC', AUG, SEP).map(row => row[0]));

  server.state.fault = () => undefined;
  const resumed = await fetchCandles(options);
  const second = server.state.requests.slice(8);
  assert.deepEqual(second.map(request => [request.start, request.end]), chunksOf(SEP, TO));   // September only, from its first chunk
  assert.deepEqual(resumed.assets.BTC, {months: 2, fetched: 1, skipped: 1, requests: 5, rows: expectedRows('BTC', AUG, TO).length, emptyResponses: {}, lastBucketMissing: []});
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expectedRows('BTC', SEP, TO));
  assert.equal(readRows(candleFile(dir, 'BTC', '2025-09'))[0][0], SEP + MINUTE);
  assert.deepEqual([...loadSeries(dir, 'BTC').time], expectedRows('BTC', AUG, TO).map(row => row[0]));
  assert.throws(() => loadSeries(dir, 'LINK'), /LINK: no complete months/);

  // A month written to disk but never recorded in the manifest (a stop before the last write) counts as not done.
  const manifest = readManifestFile(dir);
  delete manifest.assets.BTC.months['2025-09'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual([...loadSeries(dir, 'BTC').time], expectedRows('BTC', AUG, SEP).map(row => row[0]));
  await fetchCandles(options);
  assert.deepEqual(server.state.requests.slice(13).map(request => [request.start, request.end]), chunksOf(SEP, TO));

  // A month stored for a narrower range than is wanted now is fetched again in full; the others are left alone.
  const wider = await fetchCandles({...options, from: '2025-08-30'});
  assert.deepEqual(server.state.requests.slice(18).map(request => [request.start, request.end]), chunksOf(utc('2025-08-30'), SEP));
  assert.deepEqual(wider.assets.BTC, {months: 2, fetched: 1, skipped: 1, requests: 10, rows: expectedRows('BTC', utc('2025-08-30'), TO).length, emptyResponses: {}, lastBucketMissing: []});
  assert.equal(readManifestFile(dir).assets.BTC.months['2025-08'].from, '2025-08-30T00:00:00.000Z');
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-08')), expectedRows('BTC', utc('2025-08-30'), SEP));
  assert.deepEqual(filesIn(dir), ['candles/BTC/2025-08.f64', 'candles/BTC/2025-09.f64', 'manifest.json',
    'receipts/BTC/2025-08.jsonl', 'receipts/BTC/2025-09.jsonl']);
  assert.equal(readReceipts(dir, 'BTC', '2025-08').length, 10);
});

// store() makes three writes per month: candles, receipts, then the manifest entry that binds both by SHA-256. Here
// a month stored for a narrow range is being replaced by a wider fetch when one of the three fails. A directory at a
// file's temporary path makes exactly that write fail, as a full disk would.
test('an interrupted replacement never leaves receipts of another fetch than the stored rows without the loader noticing', async t => {
  const NARROW = {from: '2025-09-10', to: '2025-09-12'}, WIDE = {from: '2025-09-08', to: '2025-09-14'};
  const narrowRows = expectedRows('BTC', utc('2025-09-10'), utc('2025-09-12')), wideRows = expectedRows('BTC', utc('2025-09-08'), utc('2025-09-14'));
  const setup = async (exchange = stubExchange()) => {
    const dir = tmp(t), seen = {requests: 0};
    const run = range => fetchCandles({...range, assets: ['BTC'], dir, baseUrl: 'http://127.0.0.1:9', pauseMs: 0, log: quiet,
      fetchImpl: url => { seen.requests++; return exchange(url); }});
    await run(NARROW);
    return {dir, run, seen};
  };
  const state = dir => ({manifestRequests: readManifestFile(dir).assets.BTC.months['2025-09'].requests,
    receiptLines: readReceipts(dir, 'BTC', '2025-09').length, storedRows: readRows(candleFile(dir, 'BTC', '2025-09')).length});
  const contents = dir => Object.fromEntries(filesIn(dir).map(file => [file, sha(fs.readFileSync(path.join(dir, file)))]));
  const block = file => { fs.mkdirSync(`${file}.tmp`); return () => fs.rmdirSync(`${file}.tmp`); };
  const narrow = {manifestRequests: 10, receiptLines: 10, storedRows: narrowRows.length};
  assert.ok(wideRows.length > narrowRows.length);

  await t.test('stopped at the first write (candles): nothing of the stored month has changed', async () => {
    const {dir, run, seen} = await setup(), before = contents(dir);
    assert.deepEqual(state(dir), narrow);
    const unblock = block(candleFile(dir, 'BTC', '2025-09'));
    await assert.rejects(run(WIDE));
    unblock();
    assert.deepEqual(contents(dir), before);              // candles, receipts and manifest are all still the narrow fetch
    assert.equal(loadSeries(dir, 'BTC').time.length, narrowRows.length);
    seen.requests = 0;
    assert.equal((await run(NARROW)).requests, 0);        // consistent, so the stored range needs no request
    assert.equal(seen.requests, 0);
  });

  await t.test('stopped at the second write (receipts): the new candles disagree with the manifest, so the month is refused and refetched', async () => {
    const {dir, run, seen} = await setup();
    const unblock = block(receiptsFile(dir, 'BTC', '2025-09'));
    await assert.rejects(run(WIDE));
    unblock();
    assert.deepEqual(state(dir), {manifestRequests: 10, receiptLines: 10, storedRows: wideRows.length});   // the torn state
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-09: candle file SHA-256 disagrees with the manifest/);
    seen.requests = 0;
    assert.equal((await run(NARROW)).requests, 10);
    assert.equal(seen.requests, 10);
    assert.deepEqual(state(dir), narrow);
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), narrowRows);
    assert.equal(loadSeries(dir, 'BTC').time.length, narrowRows.length);
  });

  await t.test('stopped at the third write (manifest): the month is refused and refetched', async () => {
    const {dir, run} = await setup();
    const unblock = block(manifestFile(dir));
    await assert.rejects(run(WIDE));
    unblock();
    assert.deepEqual(state(dir), {manifestRequests: 10, receiptLines: 29, storedRows: wideRows.length});
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-09: candle file SHA-256 disagrees with the manifest/);
    assert.equal((await run(NARROW)).requests, 10);
    assert.deepEqual(state(dir), narrow);
  });

  await t.test('the same stop when the wider fetch returns the very same rows: only the receipts binding can tell, and it does', async () => {
    // An exchange that has candles for 2025-09-10 and 2025-09-11 only: the wide fetch stores identical candle bytes.
    const {dir, run, seen} = await setup(stubExchange((asset, bucket) => bucket * 1000 >= utc('2025-09-10') && bucket * 1000 < utc('2025-09-12')));
    const candlesBefore = sha(fs.readFileSync(candleFile(dir, 'BTC', '2025-09')));
    const unblock = block(manifestFile(dir));
    await assert.rejects(run(WIDE));
    unblock();
    assert.equal(sha(fs.readFileSync(candleFile(dir, 'BTC', '2025-09'))), candlesBefore);
    // The candle file still matches the manifest entry, which says 10 requests for 09-10..09-12; the receipts on
    // disk are the 29 of the wide fetch. Without the binding this month would load and be skipped as it is.
    assert.deepEqual(state(dir), {manifestRequests: 10, receiptLines: 29, storedRows: narrowRows.length});
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-09: receipts file SHA-256 disagrees with the manifest/);
    seen.requests = 0;
    assert.equal((await run(NARROW)).requests, 10);
    assert.equal(seen.requests, 10);
    assert.deepEqual(state(dir), narrow);
    assert.equal(loadSeries(dir, 'BTC').time.length, narrowRows.length);
  });
});

test('an empty answer and a missing month-end bucket are recorded and warned about; nothing is filled in and the month does not fail', async t => {
  const base = {assets: ['BTC'], baseUrl: 'http://127.0.0.1:9', pauseMs: 0};
  const warning = (asset, month, bucket, duplicates) => `warning: ${asset} ${month}: no candle came back for the last wanted minute, the bucket starting ${bucket}. ` +
    `It is stored as missing; nothing is filled in. Rows returned twice where requests overlap this month: ${duplicates} ` +
    '(0 in every month would mean the exchange leaves out the last bucket of each request).';
  const DAY = utc('2025-09-28'), NEXT = utc('2025-09-29'), dayRows = expectedRows('BTC', DAY, NEXT);

  await t.test('one empty answer among normal ones: its minutes are simply absent, and the month says how many answers were empty', async () => {
    const dir = tmp(t), lines = [], exchange = stubExchange();
    let n = 0;
    const summary = await fetchCandles({...base, from: '2025-09-28', to: '2025-09-29', dir, log: line => lines.push(line),
      fetchImpl: url => (++n === 3 ? Promise.resolve(new Response('[]')) : exchange(url))});
    // The third of five requests came back empty. Its first and last bucket were also asked for by its neighbours.
    const [holeStart, holeEnd] = chunksOf(DAY, NEXT)[2];
    const expected = dayRows.filter(row => row[0] - MINUTE <= holeStart || row[0] - MINUTE >= holeEnd);
    assert.ok(expected.length < dayRows.length - 250 && expected.length > 1000);
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expected);
    const entry = readManifestFile(dir).assets.BTC.months['2025-09'];
    assert.deepEqual([entry.complete, entry.emptyResponses, entry.lastBucketPresent, entry.requests, entry.receipts, entry.rows], [true, 1, true, 5, 5, expected.length]);
    assert.deepEqual(readReceipts(dir, 'BTC', '2025-09').map(receipt => receipt.rowCount === 0), [false, false, true, false, false]);
    assert.deepEqual(lines, [`BTC 2025-09: ${expected.length} rows from 5 requests, 1 empty response; 5/5 requests done, ETA 0s`]);
    assert.deepEqual(summary.assets.BTC, {months: 1, fetched: 1, skipped: 0, requests: 5, rows: expected.length, emptyResponses: {'2025-09': 1}, lastBucketMissing: []});
    assert.deepEqual([publicManifest(dir).assets.BTC.months['2025-09'].emptyResponses, publicManifest(dir).assets.BTC.months['2025-09'].lastBucketPresent], [1, true]);
  });

  await t.test('every answer empty: a complete month of zero rows, counted, warned about, and not asked for again', async () => {
    const dir = tmp(t), lines = [];
    let calls = 0;
    const options = {...base, from: '2025-09-28', to: '2025-09-29', dir, log: line => lines.push(line), fetchImpl: async () => { calls++; return new Response('[]'); }};
    const summary = await fetchCandles(options), entry = readManifestFile(dir).assets.BTC.months['2025-09'];
    assert.deepEqual({...entry, fetchedAt: null}, {rows: 0, firstClose: null, lastClose: null, sha256: sha(''), requests: 5, receipts: 5,
      receiptsSha256: sha(fs.readFileSync(receiptsFile(dir, 'BTC', '2025-09'))), emptyResponses: 5, lastBucketPresent: false, fetchedAt: null, complete: true,
      from: '2025-09-28T00:00:00.000Z', to: '2025-09-29T00:00:00.000Z', duplicateRows: 0});
    assert.deepEqual(lines, ['BTC 2025-09: 0 rows from 5 requests, 5 empty responses; 5/5 requests done, ETA 0s', warning('BTC', '2025-09', '2025-09-28T23:59:00.000Z', 0)]);
    assert.deepEqual(summary.assets.BTC, {months: 1, fetched: 1, skipped: 0, requests: 5, rows: 0, emptyResponses: {'2025-09': 5}, lastBucketMissing: ['2025-09']});
    assert.equal(fs.readFileSync(candleFile(dir, 'BTC', '2025-09')).length, 0);
    assert.equal(loadSeries(dir, 'BTC').time.length, 0);
    // What was answered is what is stored. A second run asks nothing; its summary still names the month.
    lines.length = 0;
    const again = await fetchCandles(options);
    assert.equal(calls, 5);
    assert.deepEqual(again.assets.BTC, {months: 1, fetched: 0, skipped: 1, requests: 0, rows: 0, emptyResponses: {'2025-09': 5}, lastBucketMissing: ['2025-09']});
    assert.deepEqual(lines, []);
    // Deleting the month's candle file is how it is fetched again.
    fs.rmSync(candleFile(dir, 'BTC', '2025-09'));
    const refetched = await fetchCandles({...options, fetchImpl: stubExchange()});
    assert.deepEqual(refetched.assets.BTC, {months: 1, fetched: 1, skipped: 0, requests: 5, rows: dayRows.length, emptyResponses: {}, lastBucketMissing: []});
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), dayRows);
  });

  await t.test('an exchange that reads `end` as exclusive: every month ends one bucket short, stays complete, and says so', async () => {
    const dir = tmp(t), lines = [];
    const summary = await fetchCandles({...base, assets: ASSETS, from: '2025-08-30', to: '2025-09-03', dir, log: line => lines.push(line),
      fetchImpl: stubExchange((asset, bucket, request) => bucket * 1000 < request.end)});
    for (const asset of ASSETS) for (const [month, from, to] of [['2025-08', utc('2025-08-30'), utc('2025-09-01')], ['2025-09', utc('2025-09-01'), utc('2025-09-03')]]) {
      const entry = readManifestFile(dir).assets[asset].months[month];
      // Each request's last bucket arrives only as the next request's first one, so no row arrives twice and the
      // month's last bucket never arrives. Every other observed minute is stored, and none is invented.
      const expected = expectedRows(asset, from, to - MINUTE);
      assert.deepEqual(readRows(candleFile(dir, asset, month)), expected);
      assert.deepEqual([entry.complete, entry.lastBucketPresent, entry.duplicateRows, entry.emptyResponses, entry.rows, entry.lastClose < to],
        [true, false, 0, 0, expected.length, true]);
      assert.ok(lines.includes(warning(asset, month, iso(to - MINUTE), 0)), lines.join('\n'));
      assert.equal(loadSeries(dir, asset).time.length, expectedRows(asset, utc('2025-08-30'), utc('2025-09-01') - MINUTE).length + expectedRows(asset, utc('2025-09-01'), utc('2025-09-03') - MINUTE).length);
    }
    assert.equal(lines.filter(line => line.startsWith('warning: ')).length, 4);
    assert.equal(lines.length, 8);
    for (const asset of ASSETS) assert.deepEqual([summary.assets[asset].lastBucketMissing, summary.assets[asset].emptyResponses], [['2025-08', '2025-09'], {}]);
  });

  await t.test('a month whose last minute has no candle at an exchange that reads `end` as inclusive: the same warning, told apart by its overlap count', async () => {
    const dir = tmp(t), lines = [];
    const summary = await fetchCandles({...base, from: '2025-09-28', to: '2025-09-29', dir, log: line => lines.push(line),
      fetchImpl: stubExchange((asset, bucket) => bucket * 1000 !== NEXT - MINUTE)});
    const entry = readManifestFile(dir).assets.BTC.months['2025-09'], duplicates = chunksOf(DAY, NEXT).slice(1).filter(([start]) => candle('BTC', start / 1000)).length;
    assert.ok(duplicates >= 3);
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), dayRows.slice(0, -1));
    assert.deepEqual([entry.complete, entry.lastBucketPresent, entry.duplicateRows, entry.emptyResponses], [true, false, duplicates, 0]);
    assert.deepEqual(lines.slice(1), [warning('BTC', '2025-09', '2025-09-28T23:59:00.000Z', duplicates)]);
    assert.deepEqual(summary.assets.BTC.lastBucketMissing, ['2025-09']);
  });
});

test('a response row outside the bounds throws and nothing from that month is stored', async t => {
  const server = await startServer(t);
  const reserved = [RESERVED_FROM / 1000, 61000.25, 61020.5, 61010.5, 61015.75, 1.5];
  const early = [(EXPLORATION_FROM - MINUTE) / 1000, 7150.25, 7160.5, 7155.5, 7158.75, 1.5];
  const cases = [
    {from: '2025-09-29', to: '2025-09-30', key: 'LINK 5', rows: rows => [reserved, ...rows],
      message: /LINK 2025-09 response row from http:\/\/127\.0\.0\.1:\d+\/products\/LINK-USD\/candles\?\S+: bucket start 2025-09-30T00:00:00\.000Z is outside the exploration range/},
    {from: '2025-09-29', to: '2025-09-30', key: 'LINK 1', rows: rows => [...rows, [(RESERVED_FROM + 400 * 86400000) / 1000, ...reserved.slice(1)]], message: /outside the exploration range/},
    {from: '2020-01-01', to: '2020-01-02', key: 'LINK 1', rows: rows => [...rows, early], message: /bucket start 2019-12-31T23:59:00\.000Z is outside the exploration range/}
  ];
  for (const {from, to, key, rows, message} of cases) {
    const dir = tmp(t);
    server.state.count = {BTC: 0, LINK: 0};
    server.state.fault = faults({[key]: {rows}});
    const error = await fetchCandles({from, to, assets: ['LINK'], dir, baseUrl: server.baseUrl, pauseMs: 0, log: quiet}).then(() => null, e => e);
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /61000\.25|61020\.5|61015\.75|7150\.25|7160\.5|7158\.75/);   // the bucket is named, its prices are not repeated
    assert.deepEqual(filesIn(dir), []);
    // With both assets the run still fails, and the offending asset's month is in neither the files nor the manifest.
    server.state.count = {BTC: 0, LINK: 0};
    await assert.rejects(fetchCandles({from, to, dir, baseUrl: server.baseUrl, pauseMs: 0, log: quiet}), message);
    assert.ok(filesIn(dir).every(file => !file.includes('LINK')));
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')) && 'LINK' in readManifestFile(dir).assets, false);
  }
});

test('in-bounds rows outside the requested chunk are ignored, as replay.js ignores rows outside its range', async t => {
  const server = await startServer(t), dir = tmp(t);
  const FROM = utc('2025-09-28'), TO = utc('2025-09-29'), chunks = chunksOf(FROM, TO);
  const fake = bucketStart => [bucketStart / 1000, 1, 4, 2, 3, 5];            // valid values no synthetic candle has
  server.state.fault = faults({
    'BTC 1': {rows: rows => [fake(chunks[0][1] + MINUTE), ...rows, fake(FROM - MINUTE)]},   // just after the chunk (same month), just before the range
    'BTC 3': {rows: rows => [fake(chunks[4][0] + 7 * MINUTE), ...rows, fake(utc('2020-01-01'))]},
    'BTC 5': {rows: rows => [fake(TO), ...rows]}                                         // the first bucket after the range, still in bounds
  });
  const summary = await fetchCandles({from: '2025-09-28', to: '2025-09-29', assets: ['BTC'], dir, baseUrl: server.baseUrl, pauseMs: 0, log: quiet});
  assert.equal(summary.requests, 5);
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expectedRows('BTC', FROM, TO));
  const receipts = readReceipts(dir, 'BTC', '2025-09');
  assert.deepEqual(receipts.map(receipt => receipt.rowCount), server.state.requests.map(request => request.rowCount));   // the receipt counts every row of the body
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.rowCount, 0), summary.assets.BTC.rows + readManifestFile(dir).assets.BTC.months['2025-09'].duplicateRows + 5);
});

test('a conflicting duplicate, invalid JSON, invalid rows and non-retryable statuses fail at once; retries are bounded', async t => {
  const server = await startServer(t);
  const run = (dir, extra = {}) => {
    server.state.count = {BTC: 0, LINK: 0}; server.state.requests.length = 0;
    return fetchCandles({from: '2025-09-28', to: '2025-09-29', assets: ['BTC'], dir, baseUrl: server.baseUrl, pauseMs: 0, backoffMs: 1, log: quiet, ...extra});
  };
  const nothingStored = dir => assert.deepEqual(filesIn(dir), []);
  const shared = chunksOf(utc('2025-09-28'), utc('2025-09-29'))[1][0] / 1000;   // the bucket chunks 1 and 2 both ask for
  assert.notEqual(candle('BTC', shared), null);

  await t.test('conflicting duplicate', async () => {
    const dir = tmp(t);
    server.state.fault = faults({'BTC 2': {rows: rows => rows.map(row => (row[0] === shared ? [...row.slice(0, 5), row[5] + 0.0001] : row))}});
    await assert.rejects(run(dir), new RegExp(`^Error: BTC: conflicting duplicate candle at ${iso(shared * 1000 + MINUTE).replace('.', '\\.')} \\(2025-09\\): http://127`));
    assert.equal(server.state.requests.length, 2);
    nothingStored(dir);
  });
  await t.test('invalid JSON is not retried, and its error repeats no text of the response', async () => {
    const dir = tmp(t);
    server.state.fault = faults({'BTC 2': {body: '[[1759017600, 1, 2, 1, 2, 3'}});
    await assert.rejects(run(dir), /BTC 2025-09: invalid JSON \(27 bytes\) on attempt 1 of 6/);
    assert.equal(server.state.requests.length, 2);
    // A malformed body that carries a row of the reserved range: the message gives the body's size and the request.
    const body = '[[1759190400,61000.25,61020.5,61010.5,61015.75,,1.5]]';
    server.state.fault = faults({'BTC 1': {body}});
    const error = await run(dir).then(() => null, e => e);
    assert.match(error.message, new RegExp(`^BTC 2025-09: invalid JSON \\(${body.length} bytes\\) on attempt 1 of 6: http://127\\.0\\.0\\.1:\\d+/products/BTC-USD/candles\\?granularity=60&start=2025-09-28T00%3A00%3A00\\.000Z&end=2025-09-28T04%3A59%3A00\\.000Z$`));
    assert.doesNotMatch(error.message, /1759190400|61000|61020|61010|61015|Unexpected|token/);
    nothingStored(dir);
  });
  await t.test('row validation is replay.js row validation', async () => {
    const good = candle('BTC', shared), dir = tmp(t);
    const bad = {
      'invalid candle response': '{"message":"NotFound"}',
      'invalid candle row': JSON.stringify([good.slice(0, 5)]),
      'invalid candle values': [[shared + 1, ...good.slice(1)], [String(shared), ...good.slice(1)], [shared, good[1], good[2], good[3], good[4], -1],
        [shared, 0, good[2], good[3], good[4], 1], [shared, good[3] + 1, good[2], good[3], good[4], 1], [shared, good[1], good[4] - 1, good[3], good[4] + 1, 1],
        [shared, good[1], good[2], good[3], null, 1], [shared, good[1], good[2], good[3], String(good[4]), 1], [shared, good[1], good[2], good[3], 1e400, 1]]
        .map(row => JSON.stringify([row]))
    };
    for (const [message, bodies] of Object.entries(bad)) for (const body of [bodies].flat()) {
      server.state.fault = faults({'BTC 1': {body}});
      await assert.rejects(run(dir), new RegExp(`^Error: BTC: ${message} \\(2025-09\\): http://127\\.0\\.0\\.1:\\d+/products/BTC-USD/candles\\?granularity=60&start=2025-09-28T00%3A00%3A00\\.000Z&end=2025-09-28T04%3A59%3A00\\.000Z$`), body);
      assert.equal(server.state.requests.length, 1);
    }
    nothingStored(dir);
  });
  await t.test('HTTP 4xx other than 429, and redirects, are not retried', async () => {
    const dir = tmp(t);
    for (const status of [400, 403, 404]) {
      server.state.fault = faults({'BTC 1': {status}});
      await assert.rejects(run(dir), new RegExp(`BTC 2025-09: HTTP ${status} on attempt 1 of 6`));
      assert.equal(server.state.requests.length, 1);
    }
    // A redirect could name another host or another time range. Here it points back at this server and at reserved
    // buckets, so following it would show up as a second request.
    const location = `${server.baseUrl}/products/BTC-USD/candles?granularity=60&start=2025-09-30T00:00:00.000Z&end=2025-09-30T04:59:00.000Z`;
    server.state.fault = faults({'BTC 1': {status: 302, headers: {location}}});
    await assert.rejects(run(dir), /BTC 2025-09: HTTP 302 on attempt 1 of 6/);
    assert.equal(server.state.requests.length, 1);        // the redirect was not followed
    nothingStored(dir);
  });
  await t.test('429, 5xx and network errors are retried up to maxAttempts, then fail', async () => {
    const dir = tmp(t);
    for (const [fault, message] of [[{status: 500}, /HTTP 500 on attempt 3 of 3/], [{status: 429}, /HTTP 429 on attempt 3 of 3/], [{destroy: true}, /network error \(.+\) on attempt 3 of 3/]]) {
      server.state.fault = ({n}) => (n >= 2 ? fault : undefined);
      await assert.rejects(run(dir, {maxAttempts: 3}), message);
      assert.equal(server.state.requests.length, 1 + 3);
    }
    server.state.fault = ({n}) => (n >= 2 ? {status: 503} : undefined);
    await assert.rejects(run(dir, {maxAttempts: 1}), /HTTP 503 on attempt 1 of 1/);
    assert.equal(server.state.requests.length, 2);
    nothingStored(dir);
  });
  await t.test('a request that times out is retried', async () => {
    const dir = tmp(t);
    server.state.fault = faults({'BTC 2': {hang: true}});
    const summary = await run(dir, {timeoutMs: 150});
    assert.equal(summary.requests, 5);
    assert.equal(server.state.requests[1].status, 'hang');
    const hung = server.state.requests[1].url;
    assert.ok(server.state.requests.slice(2).some(request => request.url === hung && request.status === 200), 'the hung request was sent again');
    assert.ok(readReceipts(dir, 'BTC', '2025-09').find(receipt => receipt.url === server.baseUrl + hung).attempts >= 2);
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expectedRows('BTC', utc('2025-09-28'), utc('2025-09-29')));
  });
  await t.test('a response that sends its headers and then stalls is cut off by the same timeout, and retried', async () => {
    // Raced against a real 5 s timer so that a timeout which no longer covers the body fails here instead of hanging.
    const within5s = async promise => {
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(resolve, 5000, 'still waiting after 5 s'); });
      try { return await Promise.race([promise.then(value => ({value}), error => ({error})), late]); } finally { clearTimeout(timer); }
    };
    const dir = tmp(t);
    server.state.fault = faults({'BTC 2': {stall: true}});
    const once = await within5s(run(dir, {timeoutMs: 150}));
    assert.notEqual(once, 'still waiting after 5 s');
    assert.equal(once.error, undefined);
    assert.equal(once.value.requests, 5);
    assert.deepEqual(server.state.requests.map(request => request.status), [200, 'stalled', 200, 200, 200, 200]);
    assert.equal(server.state.requests[2].url, server.state.requests[1].url);
    assert.equal(readReceipts(dir, 'BTC', '2025-09')[1].attempts, 2);
    assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expectedRows('BTC', utc('2025-09-28'), utc('2025-09-29')));
    // Stalling every time: the run fails with the timeout after maxAttempts attempts, and nothing is stored.
    const other = tmp(t);
    server.state.fault = ({n}) => (n >= 2 ? {stall: true} : undefined);
    const always = await within5s(run(other, {timeoutMs: 100, maxAttempts: 3}));
    assert.notEqual(always, 'still waiting after 5 s');
    assert.match(always.error.message, /^BTC 2025-09: timed out after 100 ms on attempt 3 of 3: http:\/\/127/);
    assert.deepEqual(server.state.requests.map(request => request.status), [200, 'stalled', 'stalled', 'stalled']);
    nothingStored(other);
  });
});

test('retry delay is backoff * 2**attempt, or a numeric Retry-After when that is larger, and never more than 5 minutes', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(attempt => retryDelayMs(attempt, 500, null)), [500, 1000, 2000, 4000, 8000]);
  assert.equal(retryDelayMs(0, 500, '2'), 2000);
  assert.equal(retryDelayMs(0, 500, ' 1.5 '), 1500);
  assert.equal(retryDelayMs(3, 500, '2'), 4000);          // the backoff is larger
  assert.equal(retryDelayMs(0, 500, '0'), 500);
  for (const header of ['Wed, 21 Oct 2026 07:28:00 GMT', 'soon', '-5', '1e9', '', undefined, 30])
    assert.equal(retryDelayMs(1, 500, header), 1000);
  // The cap. 2147484 s is the first whole Retry-After above 2**31-1 ms, which Node would wait out in 1 ms.
  assert.equal(retryDelayMs(0, 500, '299'), 299000);
  for (const header of ['300', '301', '2147483', '2147484', '86400', '9'.repeat(30), '9'.repeat(400)])
    assert.equal(retryDelayMs(0, 500, header), 300000, header.slice(0, 12));
  assert.deepEqual([9, 10, 30, 31, 1023, 1024, 5000].map(attempt => retryDelayMs(attempt, 500, null)), [256000, 300000, 300000, 300000, 300000, 300000, 300000]);
  assert.deepEqual([0, 31, 1024, 5000].map(attempt => retryDelayMs(attempt, 0, null)), [0, 0, 0, 0]);   // no backoff stays no backoff
  assert.equal(retryDelayMs(1024, 0, '7'), 7000);
  // Whatever the inputs, the result is a wait setTimeout takes at face value.
  for (const attempt of [0, 1, 5, 31, 32, 64, 1023, 1024, 1100]) for (const backoff of [0, 1, 200, 500, 300000])
    for (const header of [null, '0', '1', '299.5', '300', '2147484', '9'.repeat(400), 'soon']) {
      const delay = retryDelayMs(attempt, backoff, header);
      assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= 300000, `${attempt} ${backoff} ${String(header).slice(0, 8)} -> ${delay}`);
    }
});

test('a store from one source is not mixed with another', async t => {
  const server = await startServer(t), dir = tmp(t);
  const options = {from: '2025-09-29', to: '2025-09-30', assets: ['BTC'], dir, pauseMs: 250, log: quiet};
  await fetchCandles({...options, baseUrl: server.baseUrl, pauseMs: 0});
  let calls = 0;
  await assert.rejects(fetchCandles({...options, assets: ['LINK'], fetchImpl: async () => { calls++; return new Response('[]'); }}),
    /was fetched from "Loopback test server: synthetic candles, not market data"; refusing to mix/);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------------------------------------------------

test('loadSeries reads only what the manifest vouches for and never a row outside the exploration bounds', async t => {
  const JAN = utc('2020-01-01'), FEB = utc('2020-02-01');
  await t.test('complete months join in time order; incomplete months and other assets are left out', () => {
    const dir = tmp(t);
    const january = [handRow(JAN, 7000), handRow(JAN + 5 * MINUTE, 7001), handRow(FEB - MINUTE, 7002)];
    const february = [handRow(FEB, 7003), handRow(FEB + 2 * MINUTE, 7004)];
    writeStore(dir, 'BTC', '2020-02', february);
    writeStore(dir, 'BTC', '2020-01', january);
    writeStore(dir, 'BTC', '2020-03', [handRow(utc('2020-03-01'), 1)], {complete: false});
    writeStore(dir, 'BTC', '2020-04', []);
    const series = loadSeries(dir, 'BTC');
    assert.deepEqual([...series.time], [JAN + MINUTE, JAN + 6 * MINUTE, FEB, FEB + MINUTE, FEB + 3 * MINUTE]);
    assert.deepEqual([...series.close], [7000, 7001, 7002, 7003, 7004]);
    assert.deepEqual([...loadSeries(dir, 'BTC', {fromClose: FEB, toClose: FEB + MINUTE}).close], [7002, 7003]);
    assert.throws(() => loadSeries(dir, 'LINK'), /LINK: no complete months/);
    assert.deepEqual(Object.keys(publicManifest(dir).assets.BTC.months), ['2020-01', '2020-02', '2020-04']);
    assert.throws(() => loadSeries(tmp(t), 'BTC'), /no manifest/);
    assert.throws(() => publicManifest(tmp(t)), /no manifest/);
  });
  await t.test('rows outside the bounds are refused even when file and manifest agree', () => {
    const cases = [
      ['2025-09', [handRow(RESERVED_FROM - MINUTE), handRow(RESERVED_FROM)], /BTC 2025-09 row 1: bucket start 2025-09-30T00:00:00\.000Z is outside the exploration range/],
      ['2025-10', [handRow(utc('2025-10-01'))], /bucket start 2025-10-01T00:00:00\.000Z is outside the exploration range/],
      ['2026-10', [handRow(utc('2026-10-10'))], /outside the exploration range/],
      ['2019-12', [handRow(EXPLORATION_FROM - MINUTE)], /bucket start 2019-12-31T23:59:00\.000Z is outside the exploration range/],
      ['2020-01', [[JAN + MINUTE + 1, 1, 1, 1, 1, 1]], /outside the exploration range/],                     // not a minute close
      ['2020-01', [[NaN, 1, 1, 1, 1, 1]], /outside the exploration range/]
    ];
    for (const [month, rows, message] of cases) {
      const dir = tmp(t);
      writeStore(dir, 'BTC', month, rows);
      assert.throws(() => loadSeries(dir, 'BTC'), message);
    }
    const dir = tmp(t);
    writeStore(dir, 'BTC', '2025-09', [handRow(RESERVED_FROM - MINUTE)]);     // the last allowed bucket closes at the boundary
    assert.deepEqual([...loadSeries(dir, 'BTC').time], [RESERVED_FROM]);
  });
  await t.test('a file that disagrees with its manifest entry, or is not a sorted month of minute closes, is refused', () => {
    const rows = [handRow(JAN, 7000), handRow(JAN + MINUTE, 7001)];
    const cases = [
      [rows, {rows: 3}, /holds 2 rows, the manifest says 3/],
      [rows, {sha256: '0'.repeat(64)}, /SHA-256 disagrees/],
      [rows, {firstClose: JAN}, /first\/last close disagree/],
      [rows, {lastClose: JAN + 3 * MINUTE}, /first\/last close disagree/],
      [[rows[1], rows[0]], {}, /not strictly increasing at row 1/],
      [[rows[0], rows[0]], {}, /not strictly increasing at row 1/],
      [[handRow(FEB, 7000)], {}, /belongs to another month/],
      [[handRow(JAN, 0)], {}, /invalid close at row 0/],
      [[handRow(JAN, -5)], {}, /invalid close at row 0/]
    ];
    for (const [stored, overrides, message] of cases) {
      const dir = tmp(t);
      writeStore(dir, 'BTC', '2020-01', stored, overrides);
      assert.throws(() => loadSeries(dir, 'BTC'), message);
    }
    const dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows);
    fs.appendFileSync(candleFile(dir, 'BTC', '2020-01'), Buffer.alloc(7));
    assert.throws(() => loadSeries(dir, 'BTC'), /SHA-256 disagrees/);
  });
  await t.test('a manifest of another format or written under other bounds is refused', () => {
    const rows = [handRow(JAN, 7000)];
    let dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows, {}, {from: '2020-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z'});
    assert.throws(() => loadSeries(dir, 'BTC'), /written under other bounds/);
    assert.throws(() => publicManifest(dir), /written under other bounds/);
    dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows);
    const manifest = readManifestFile(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({...manifest, format: 'paper-trail-research-candles-v2'}));
    assert.throws(() => loadSeries(dir, 'BTC'), /not a paper-trail-research-candles-v1 manifest/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"format":');
    assert.throws(() => loadSeries(dir, 'BTC'), /unreadable manifest/);
  });
  await t.test('an entry that binds a receipts file is held to it; an entry that binds none loads as before', () => {
    const rows = [handRow(JAN, 7000), handRow(JAN + MINUTE, 7001)];
    const receipts = [{url: 'synthetic:1', receivedAt: 1, httpDate: null, sha256: sha('1'), rowCount: 1, attempts: 1},
      {url: 'synthetic:2', receivedAt: 2, httpDate: null, sha256: sha('2'), rowCount: 1, attempts: 1}];
    const bound = (overrides = {}) => { const dir = tmp(t); writeStore(dir, 'BTC', '2020-01', rows, overrides, undefined, receipts); return dir; };
    let dir = bound();
    assert.deepEqual([...loadSeries(dir, 'BTC').close], [7000, 7001]);
    assert.deepEqual(receiptsSummary(dir), {BTC: {files: 1, receipts: 2, sha256: {'2020-01': sha(fs.readFileSync(receiptsFile(dir, 'BTC', '2020-01')))}},
      LINK: {files: 0, receipts: 0, sha256: {}}});
    for (const [overrides, message] of [[{receiptsSha256: '0'.repeat(64)}, /BTC 2020-01: receipts file SHA-256 disagrees with the manifest/],
      [{receiptsSha256: null}, /receipts file SHA-256 disagrees/], [{receiptsSha256: ''}, /receipts file SHA-256 disagrees/],
      [{receipts: 3}, /BTC 2020-01: receipts file holds 2 receipts, the manifest says 3/], [{receipts: undefined}, /holds 2 receipts, the manifest says undefined/]])
      assert.throws(() => loadSeries(bound(overrides), 'BTC'), message);
    dir = bound();
    const boundSha = readManifestFile(dir).assets.BTC.months['2020-01'].receiptsSha256;
    assert.equal(receiptsSummary(dir).BTC.sha256['2020-01'], boundSha);
    fs.appendFileSync(receiptsFile(dir, 'BTC', '2020-01'), '\n');
    assert.throws(() => loadSeries(dir, 'BTC'), /receipts file SHA-256 disagrees/);
    // receiptsSummary states what is on disk, not what the manifest claims: here the two differ.
    assert.deepEqual(receiptsSummary(dir).BTC, {files: 1, receipts: 2, sha256: {'2020-01': sha(fs.readFileSync(receiptsFile(dir, 'BTC', '2020-01')))}});
    assert.notEqual(receiptsSummary(dir).BTC.sha256['2020-01'], boundSha);
    fs.rmSync(receiptsFile(dir, 'BTC', '2020-01'));
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2020-01: receipts file unreadable \(ENOENT\)/);
    assert.deepEqual(receiptsSummary(dir).BTC, {files: 0, receipts: 0, sha256: {}});
    // Only the manifest's complete months count: not a month marked incomplete, not a file the manifest does not list.
    dir = bound();
    writeStore(dir, 'BTC', '2020-02', [handRow(FEB, 7002)], {complete: false}, undefined, receipts.slice(0, 1));
    writeStore(dir, 'LINK', '2020-03', [handRow(utc('2020-03-01'), 20)], {}, undefined, [...receipts, ...receipts]);
    fs.writeFileSync(receiptsFile(dir, 'LINK', '2020-04'), JSON.stringify(receipts[0]) + '\n');
    assert.deepEqual(receiptsSummary(dir), {BTC: {files: 1, receipts: 2, sha256: {'2020-01': sha(fs.readFileSync(receiptsFile(dir, 'BTC', '2020-01')))}},
      LINK: {files: 1, receipts: 4, sha256: {'2020-03': sha(fs.readFileSync(receiptsFile(dir, 'LINK', '2020-03')))}}});
    // No binding in the entry (the first version's shape, and stores written by hand): candles only, receipts not read.
    dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows);
    assert.deepEqual([...loadSeries(dir, 'BTC').close], [7000, 7001]);
    assert.deepEqual(receiptsSummary(dir), {BTC: {files: 0, receipts: 0, sha256: {}}, LINK: {files: 0, receipts: 0, sha256: {}}});
    assert.deepEqual(publicManifest(dir).assets.BTC.months['2020-01'], {rows: 2, firstClose: JAN + MINUTE, lastClose: JAN + 2 * MINUTE,
      sha256: sha(fs.readFileSync(candleFile(dir, 'BTC', '2020-01'))), requests: 0, receipts: null, receiptsSha256: null, emptyResponses: null,
      lastBucketPresent: null, fetchedAt: '2020-01-01T00:00:00.000Z', complete: true, from: null, to: null, duplicateRows: null});
    assert.throws(() => receiptsSummary(tmp(t)), /no manifest; fetch with research\/fetch-candles\.mjs first/);
  });
});

// PROTOCOL.md: "The study runs only on a complete store: every month from 2020-01 to 2025-09 present and complete for
// both assets, fetched from the exchange."
const monthBounds = month => { const [year, number] = month.split('-').map(Number); return [Date.UTC(year, number - 1, 1), Date.UTC(year, number, 1)]; };
// The part of a month inside the exploration bounds: all of it, except that 2025-09 stops at 2025-09-30T00:00Z.
const wholeMonth = month => { const [start, end] = monthBounds(month); return [Math.max(start, EXPLORATION_FROM), Math.min(end, RESERVED_FROM)]; };
// A whole store written by hand in the amended layout: every exploration month for both assets, each with its first
// and last bucket as rows, one bound receipt, and the range it stands for.
function writeWholeStore(dir, source = SOURCE) {
  for (const asset of ASSETS) for (const month of explorationMonths()) {
    const [from, to] = wholeMonth(month);
    writeStore(dir, asset, month, [handRow(from, 100), handRow(to - MINUTE, 101)],
      {from: iso(from), to: iso(to), duplicateRows: 0, emptyResponses: 0, lastBucketPresent: true}, undefined,
      [{url: `synthetic:${asset}:${month}`, receivedAt: 0, httpDate: null, sha256: sha(`${asset} ${month}`), rowCount: 2, attempts: 1}], source);
  }
}

test('storeCompleteness: every month of 2020-01 to 2025-09, whole, for both assets, with files that verify; the source is reported beside it', async t => {
  const months = explorationMonths();
  assert.equal(months.length, 69);
  assert.deepEqual([months[0], months[1], months[11], months[12], months[49], months.at(-2), months.at(-1)],
    ['2020-01', '2020-02', '2020-12', '2021-01', '2024-02', '2025-08', '2025-09']);
  assert.deepEqual(months, [...new Set(months)].sort());
  assert.equal(SOURCE, DATASET_SOURCE);                   // the fetcher re-exports the label dataset.mjs defines
  assert.equal(DATASET_SOURCE, 'Coinbase Exchange public completed one-minute candles (https://api.exchange.coinbase.com)');
  assert.throws(() => storeCompleteness(tmp(t)), /no manifest; fetch with research\/fetch-candles\.mjs first/);

  const dir = tmp(t);
  writeWholeStore(dir);
  const whole = {complete: true, source: SOURCE, sourceIsExchange: true, problems: []};
  await t.test('a whole store is complete, and both series load from it', () => {
    assert.deepEqual(storeCompleteness(dir), whole);
    for (const asset of ASSETS) {
      const series = loadSeries(dir, asset);
      assert.deepEqual([series.time.length, series.time[0], series.time.at(-1)], [138, EXPLORATION_FROM + MINUTE, RESERVED_FROM]);
    }
    assert.deepEqual(Object.keys(receiptsSummary(dir).BTC.sha256), months);
    assert.deepEqual([receiptsSummary(dir).BTC.files, receiptsSummary(dir).BTC.receipts, receiptsSummary(dir).LINK.files, receiptsSummary(dir).LINK.receipts], [69, 69, 69, 69]);
    assert.deepEqual(Object.keys(publicManifest(dir).assets.LINK.months), months);
  });

  await t.test('the source is reported, not judged: only the exact exchange label is sourceIsExchange', () => {
    const original = fs.readFileSync(manifestFile(dir), 'utf8');
    for (const source of [LOOPBACK_SOURCE, 'synthetic test store', `${SOURCE} `, SOURCE.toLowerCase(), 'https://api.exchange.coinbase.com', '']) {
      editManifest(dir, manifest => { manifest.source = source; });
      assert.deepEqual(storeCompleteness(dir), {complete: true, source, sourceIsExchange: false, problems: []});
    }
    fs.writeFileSync(manifestFile(dir), original);
    assert.deepEqual(storeCompleteness(dir), whole);
  });

  await t.test('each way a month can fall short is named, and nothing else is', () => {
    const flip = file => { const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes); };
    const entryOf = (manifest, asset, month) => manifest.assets[asset].months[month];
    const cases = [
      ['no entry', 'LINK', '2021-07', manifest => { delete manifest.assets.LINK.months['2021-07']; }, /^missing: the manifest has no entry for this month$/],
      ['not complete', 'BTC', '2020-01', manifest => { entryOf(manifest, 'BTC', '2020-01').complete = false; }, /^not marked complete$/],
      ['complete is not true', 'BTC', '2020-01', manifest => { entryOf(manifest, 'BTC', '2020-01').complete = 'yes'; }, /^not marked complete$/],
      ['ends one minute early', 'BTC', '2023-02', manifest => { entryOf(manifest, 'BTC', '2023-02').to = '2023-02-28T23:59:00.000Z'; },
        /^stored for 2023-02-01T00:00:00\.000Z to 2023-02-28T23:59:00\.000Z, which does not cover the whole month 2023-02-01T00:00:00\.000Z to 2023-03-01T00:00:00\.000Z$/],
      ['starts one minute late', 'LINK', '2024-02', manifest => { entryOf(manifest, 'LINK', '2024-02').from = '2024-02-01T00:01:00.000Z'; },
        /^stored for 2024-02-01T00:01:00\.000Z to 2024-03-01T00:00:00\.000Z, which does not cover the whole month 2024-02-01T00:00:00\.000Z to 2024-03-01T00:00:00\.000Z$/],
      // The last month runs through the bucket starting 2025-09-29T23:59Z: its range must reach 2025-09-30T00:00Z.
      ['the last month stops a bucket short', 'BTC', '2025-09', manifest => { entryOf(manifest, 'BTC', '2025-09').to = '2025-09-29T23:59:00.000Z'; },
        /^stored for 2025-09-01T00:00:00\.000Z to 2025-09-29T23:59:00\.000Z, which does not cover the whole month 2025-09-01T00:00:00\.000Z to 2025-09-30T00:00:00\.000Z$/],
      ['the first month starts a day late', 'LINK', '2020-01', manifest => { entryOf(manifest, 'LINK', '2020-01').from = '2020-01-02T00:00:00.000Z'; },
        /which does not cover the whole month 2020-01-01T00:00:00\.000Z to 2020-02-01T00:00:00\.000Z$/],
      ['no range recorded', 'BTC', '2022-11', manifest => { delete entryOf(manifest, 'BTC', '2022-11').from; delete entryOf(manifest, 'BTC', '2022-11').to; },
        /^stored for an unrecorded range, which does not cover the whole month 2022-11-01T00:00:00\.000Z to 2022-12-01T00:00:00\.000Z$/],
      ['a range that is not a date', 'BTC', '2022-11', manifest => { entryOf(manifest, 'BTC', '2022-11').to = 1669852800000; }, /^stored for an unrecorded range/],
      ['no receipts bound', 'LINK', '2020-03', manifest => { delete entryOf(manifest, 'LINK', '2020-03').receiptsSha256; delete entryOf(manifest, 'LINK', '2020-03').receipts; },
        /^no receipts file is bound to this month \(the entry has no receiptsSha256\)$/],
      ['candle file changed', 'BTC', '2021-01', () => flip(candleFile(dir, 'BTC', '2021-01')), /^does not verify against the manifest: candle file SHA-256 disagrees with the manifest$/],
      ['candle file gone', 'LINK', '2025-09', () => fs.rmSync(candleFile(dir, 'LINK', '2025-09')), /^does not verify against the manifest: candle file unreadable \(ENOENT\)$/],
      ['row count wrong', 'BTC', '2024-12', manifest => { entryOf(manifest, 'BTC', '2024-12').rows = 3; }, /^does not verify against the manifest: candle file holds 2 rows, the manifest says 3$/],
      ['receipts file changed', 'BTC', '2021-01', () => flip(receiptsFile(dir, 'BTC', '2021-01')), /^does not verify against the manifest: receipts file SHA-256 disagrees with the manifest$/],
      ['receipts file gone', 'LINK', '2022-06', () => fs.rmSync(receiptsFile(dir, 'LINK', '2022-06')), /^does not verify against the manifest: receipts file unreadable \(ENOENT\)$/]
    ];
    const snapshot = () => Object.fromEntries(filesIn(dir).map(file => [file, fs.readFileSync(path.join(dir, file))]));
    const restore = saved => { for (const [file, bytes] of Object.entries(saved)) fs.writeFileSync(path.join(dir, file), bytes); };
    const saved = snapshot();
    for (const [name, asset, month, damage, problem] of cases) {
      const manifest = readManifestFile(dir);
      damage(manifest);
      if (damage.length) fs.writeFileSync(manifestFile(dir), JSON.stringify(manifest));
      const result = storeCompleteness(dir);
      assert.deepEqual([result.complete, result.source, result.sourceIsExchange, result.problems.length], [false, SOURCE, true, 1], name);
      assert.deepEqual([result.problems[0].asset, result.problems[0].month], [asset, month], name);
      assert.deepEqual(Object.keys(result.problems[0]), ['asset', 'month', 'problem']);
      assert.match(result.problems[0].problem, problem, name);
      restore(saved);
      assert.deepEqual(storeCompleteness(dir), whole, `restored after: ${name}`);
    }
    // Several at once come back in asset order, then month order; an asset absent from the manifest lacks every month.
    editManifest(dir, manifest => { delete manifest.assets.LINK; delete manifest.assets.BTC.months['2025-09']; manifest.assets.BTC.months['2020-05'].complete = false; });
    const many = storeCompleteness(dir);
    assert.equal(many.complete, false);
    assert.deepEqual(many.problems.map(problem => [problem.asset, problem.month]), [['BTC', '2020-05'], ['BTC', '2025-09'], ...months.map(month => ['LINK', month])]);
    assert.ok(many.problems.slice(2).every(problem => /^missing: /.test(problem.problem)));
    restore(saved);
  });

  await t.test('months the fetcher stored: whole months pass, a month fetched for part of its days does not', async () => {
    const fetched = tmp(t);
    const run = to => fetchCandles({from: '2025-08-01', to, dir: fetched, baseUrl: 'http://127.0.0.1:9', pauseMs: 0, log: quiet, fetchImpl: stubExchange()});
    const about = month => storeCompleteness(fetched).problems.filter(problem => problem.month === month).map(problem => [problem.asset, problem.problem]);
    // To 2025-09-29: September lacks its last day, the day whose 23:59 bucket is the last one of the exploration range.
    await run('2025-09-29');
    assert.deepEqual(about('2025-08'), []);
    const short = 'stored for 2025-09-01T00:00:00.000Z to 2025-09-29T00:00:00.000Z, which does not cover the whole month 2025-09-01T00:00:00.000Z to 2025-09-30T00:00:00.000Z';
    assert.deepEqual(about('2025-09'), [['BTC', short], ['LINK', short]]);
    // To 2025-09-30, the furthest the fetcher goes: September is whole. The other 67 months are still missing.
    const summary = await run('2025-09-30');
    assert.deepEqual([summary.assets.BTC.fetched, summary.assets.BTC.skipped], [1, 1]);
    assert.deepEqual(about('2025-09'), []);
    const result = storeCompleteness(fetched);
    assert.deepEqual([result.complete, result.source, result.sourceIsExchange, result.problems.length], [false, LOOPBACK_SOURCE, false, 2 * 67]);
    assert.ok(result.problems.every(problem => problem.problem === 'missing: the manifest has no entry for this month' && problem.month < '2025-08'));
    assert.equal(readManifestFile(fetched).assets.BTC.months['2025-09'].lastClose, RESERVED_FROM);
    assert.deepEqual(receiptsSummary(fetched).BTC, {files: 2, receipts: 150 + 140, sha256: Object.fromEntries(['2025-08', '2025-09'].map(month =>
      [month, sha(fs.readFileSync(receiptsFile(fetched, 'BTC', month)))]))});
  });
});

test('seriesFromRows and coverage on the bundled sample and on small synthetic series', () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const market = {BTC: seriesFromRows(sample.prices.map(row => [row[0], row[1]])), LINK: seriesFromRows(sample.prices.map(row => [row[0], row[2]]))};
  assert.ok(market.BTC.time instanceof Float64Array && market.BTC.close instanceof Float64Array);
  assert.deepEqual([...market.LINK.close], sample.prices.map(row => row[2]));
  // data/README.md: 1,648 shared observations across a 1,800-minute requested window, 152 missing.
  assert.deepEqual(coverage(market, sample.periodStart, sample.periodEnd), {expected: 1800, observed: {BTC: 1648, LINK: 1648}, shared: 1648, sharedFraction: 1648 / 1800});

  const at = minutes => minutes.map(m => [m * MINUTE, 10 + m]);
  const small = {BTC: seriesFromRows(at([1, 2, 3, 5, 9])), LINK: seriesFromRows(at([2, 3, 4, 5, 6]))};
  assert.deepEqual(coverage(small, MINUTE, 6 * MINUTE), {expected: 6, observed: {BTC: 4, LINK: 5}, shared: 3, sharedFraction: 0.5});
  assert.deepEqual(coverage(small, 3 * MINUTE, 5 * MINUTE), {expected: 3, observed: {BTC: 2, LINK: 3}, shared: 2, sharedFraction: 2 / 3});
  assert.deepEqual(coverage(small, 7 * MINUTE, 8 * MINUTE), {expected: 2, observed: {BTC: 0, LINK: 0}, shared: 0, sharedFraction: 0});
  assert.deepEqual(coverage(small, 0, 10 * MINUTE), {expected: 11, observed: {BTC: 5, LINK: 5}, shared: 3, sharedFraction: 3 / 11});
  assert.deepEqual(coverage({BTC: seriesFromRows([]), LINK: seriesFromRows([])}, 0, 0), {expected: 1, observed: {BTC: 0, LINK: 0}, shared: 0, sharedFraction: 0});
  // Only minute closes can be covered: an observation between minutes, or a repeated one, is refused where it would be counted.
  const series = times => ({time: Float64Array.from(times), close: Float64Array.from(times, () => 1)});
  for (const times of [[MINUTE, MINUTE + 1, 2 * MINUTE], [MINUTE, MINUTE, 2 * MINUTE], [2 * MINUTE, MINUTE]]) {
    assert.throws(() => coverage({BTC: series(times), LINK: small.LINK}, MINUTE, 2 * MINUTE), /BTC times must be strictly increasing minute closes/);
    assert.throws(() => coverage({BTC: small.BTC, LINK: series(times)}, MINUTE, 2 * MINUTE), /LINK times must be strictly increasing minute closes/);
  }
  assert.equal(coverage({BTC: series([MINUTE, MINUTE + 1, 2 * MINUTE]), LINK: small.LINK}, 2 * MINUTE, 3 * MINUTE).observed.BTC, 1);
  for (const [start, end] of [[MINUTE + 1, 2 * MINUTE], [MINUTE, 2 * MINUTE + 1], [2 * MINUTE, MINUTE], [NaN, MINUTE], ['0', MINUTE]])
    assert.throws(() => coverage(small, start, end), /startClose and endClose must be UTC minute closes/);
  assert.throws(() => coverage({BTC: small.BTC}, 0, MINUTE), /market\.LINK is not a series/);

  const M = MINUTE;
  for (const rows of [[[2 * M, 1], [M, 1]], [[M, 1], [M, 2]], [[M, 0]], [[M, -1]], [[M, NaN]], [[M, Infinity]], [[M + 1, 1]], [[M + 0.5, 1]], [[String(M), 1]],
    [[M, '1']], [[M, 1, 1]], [[M]], [{time: M, price: 1}], 'rows'])
    assert.throws(() => seriesFromRows(rows), /seriesFromRows/, JSON.stringify(rows));
  assert.deepEqual([...seriesFromRows([[0, 1], [M, 2.5], [7 * M, 3]]).time], [0, M, 7 * M]);
});

// ---------------------------------------------------------------------------------------------------------------------

// The command line has no base URL flag, so its runs get a preloaded fetch: one that fails the run if anything is
// requested, or one that hands requests for the Coinbase origin to the loopback server.
const NO_NETWORK = 'globalThis.fetch = () => { console.error("NETWORK ATTEMPT"); process.exit(97); };';
const TO_LOOPBACK = `const real = globalThis.fetch; globalThis.fetch = (url, init) => {
  const target = new URL(url);
  if (target.origin !== 'https://api.exchange.coinbase.com') { console.error('NETWORK ATTEMPT'); process.exit(97); }
  return real(process.env.TEST_CANDLE_SERVER + target.pathname + target.search, init);
};`;
function cli(args, preload, env = {}) {
  return new Promise(resolve => execFile(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, CLI, ...args],
    {env: {PATH: process.env.PATH, ...env}}, (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr})));
}

test('command line: refusals exit 1 before any request, with no flag that moves the bounds or the host', async t => {
  const dir = tmp(t);
  for (const [args, message] of [
    [['--to', '2025-10-01'], /reserved range/],
    [['--from', '2019-12-31'], /before the exploration range/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', '0'], /pauseMs below 200 is refused/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', 'fast'], /--pause-ms must be a number/],
    // A pause above 2**31-1 ms would be no pause at all in Node; anything above 5 minutes is refused.
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', '2147483648'], /pauseMs must be a number from 0 to 300000 \(5 minutes\)/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', '300001'], /pauseMs must be a number from 0 to 300000/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', '9'.repeat(400)], /pauseMs must be a number from 0 to 300000/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--pause-ms', '1e3'], /--pause-ms must be a number/],
    [['--from', '2025-09-29', '--to', '2025-09-30', '--assets', 'BTC,ETH'], /assets must be/],
    [['--base-url', 'http://127.0.0.1:1'], /Unknown option '--base-url'/],
    [['--force'], /Unknown option '--force'/],
    [['--reserved-from', '2026-01-01'], /Unknown option '--reserved-from'/],
    [['2025-10-01'], /positional/i]
  ]) {
    const result = await cli(['--dir', dir, ...args], NO_NETWORK);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /NETWORK ATTEMPT/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.error, message);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  // The proxy hints: one when HTTPS_PROXY is set and NODE_USE_ENV_PROXY is not 1, one when HTTPS_PROXY is set and
  // NODE_EXTRA_CA_CERTS is not (a proxy that re-signs TLS needs its CA bundle there).
  const hint = /^hint: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1/m, refused = ['--dir', dir, '--to', '2025-10-01'];
  const caHint = /^hint: HTTPS_PROXY is set but NODE_EXTRA_CA_CERTS is not; a proxy that re-signs TLS needs its CA bundle there \(NODE_EXTRA_CA_CERTS=\/path\/to\/ca-bundle\.pem\)/m;
  const bundle = path.join(tmp(t), 'ca-bundle.pem'), proxy = {HTTPS_PROXY: 'http://127.0.0.1:9'};
  fs.writeFileSync(bundle, '');
  const hints = async env => { const {stderr} = await cli(refused, NO_NETWORK, env); return [hint.test(stderr), caHint.test(stderr)]; };
  assert.match((await cli(refused, NO_NETWORK, {HTTPS_PROXY: 'http://127.0.0.1:9'})).stderr, hint);
  assert.doesNotMatch((await cli(refused, NO_NETWORK, {HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1'})).stderr, hint);
  assert.doesNotMatch((await cli(refused, NO_NETWORK)).stderr, hint);
  assert.deepEqual(await hints(proxy), [true, true]);
  assert.deepEqual(await hints({https_proxy: 'http://127.0.0.1:9'}), [true, true]);
  assert.deepEqual(await hints({...proxy, NODE_USE_ENV_PROXY: '1'}), [false, true]);
  assert.deepEqual(await hints({...proxy, NODE_EXTRA_CA_CERTS: bundle}), [true, false]);
  assert.deepEqual(await hints({...proxy, NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: bundle}), [false, false]);
  assert.deepEqual(await hints({}), [false, false]);
  assert.deepEqual(await hints({NODE_EXTRA_CA_CERTS: bundle}), [false, false]);
  assert.match((await cli(['--help'], NO_NETWORK)).stdout, /^usage: node research\/fetch-candles\.mjs \[--from YYYY-MM-DD\]/);
});

test('command line: a small fetch prints progress on stderr and a JSON summary on stdout, exit code 0', async t => {
  const server = await startServer(t), dir = tmp(t), rows = expectedRows('BTC', utc('2025-09-29'), RESERVED_FROM);
  const result = await cli(['--from', '2025-09-29', '--to', '2025-09-30', '--assets', 'BTC', '--dir', dir, '--pause-ms', '200'], TO_LOOPBACK,
    {TEST_CANDLE_SERVER: server.baseUrl});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^BTC 2025-09: ${rows.length} rows from 5 requests; 5/5 requests done, ETA 0s$`, 'm'));
  const summary = JSON.parse(result.stdout);
  assert.deepEqual({...summary, elapsedMs: null}, {ok: true, format: 'paper-trail-research-candles-v1', dir, source: SOURCE, from: '2025-09-29', to: '2025-09-30',
    bounds: {from: '2020-01-01T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z'}, requests: 5, elapsedMs: null,
    assets: {BTC: {months: 1, fetched: 1, skipped: 0, requests: 5, rows: rows.length, emptyResponses: {}, lastBucketMissing: []}}});
  assert.ok(summary.elapsedMs >= 4 * 200 - 50, 'four pauses of 200 ms separate five requests');
  assert.deepEqual(server.state.requests.map(request => [request.start, request.end]), chunksOf(utc('2025-09-29'), RESERVED_FROM));
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), rows);
  assert.ok(readReceipts(dir, 'BTC', '2025-09').every(receipt => receipt.url.startsWith('https://api.exchange.coinbase.com/products/BTC-USD/candles?')));
});
