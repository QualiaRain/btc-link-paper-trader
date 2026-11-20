// Tests for research/fetch-candles.mjs, research/dataset.mjs and research/test-store.mjs.
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
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fetchHistoricalRange} from '../replay.js';
import {COINBASE_URL, LOOPBACK_SOURCE, MAX_WAIT_MS, SOURCE, fetchCandles, retryDelayMs} from './fetch-candles.mjs';
import {ASSETS, CHUNK, EXCHANGE_ORIGIN, EXPLORATION_FROM, LOOPBACK_SOURCE as DATASET_LOOPBACK_SOURCE, MINUTE, RESERVED_FROM,
  REMAKE_MANIFEST, SOURCE as DATASET_SOURCE, coverage, explorationMonths, httpDates, loadSeries, publicManifest, readManifest, receiptDated,
  receiptsSummary, seriesFromRows, storeCompleteness} from './dataset.mjs';
import {TEST_STORE_NOW, writeTestStore} from './test-store.mjs';

const CLI = fileURLToPath(new URL('./fetch-candles.mjs', import.meta.url));
const TEST_STORE = fileURLToPath(new URL('./test-store.mjs', import.meta.url)), DATASET = fileURLToPath(new URL('./dataset.mjs', import.meta.url));
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

// ---- receipts written by hand, in the shape the fetcher gives them
// An answer's Date header and receive time: later than every bucket of the exploration range, as an answer about a
// minute is (dataset.mjs receiptDated). The same instant as a test store's clock (test-store.mjs).
const HTTP_DATE = 'Thu, 19 Nov 2026 07:57:37 GMT', RECEIVED_AT = Date.parse('2026-11-19T07:57:37.000Z');
assert.equal(RECEIVED_AT, TEST_STORE_NOW);
// The end of every problem text that fetching the month again repairs (dataset.mjs storeCompleteness): with the
// month's candle file to delete when there is one.
// The file is named relative to the store directory, and the text says so (data4 finding 3).
const refetch = (asset, month) => `; delete candles/${asset}/${month}.f64 in the store directory and run research/fetch-candles.mjs again`;
const RUN_AGAIN = '; run research/fetch-candles.mjs again';
// The end of every problem text about a file or link that no manifest entry names; a link may stand for this
// store's own files moved elsewhere, and then deleting it would cost a fetch of all it held (data4 finding 4).
const MOVE_IT = '; delete it or move it out of the store directory';
const LINK_REMEDY = `${MOVE_IT}; if it points to files of this store, put them in its place instead (a store directory that is itself a link is read through)`;
// The problem of a month the manifest lists outside the exploration range, which fetching does not repair.
const outsideRange = (asset, month) => 'outside the exploration range: the manifest lists this month, which no fetch writes; ' +
  `delete its entry from manifest.json, and candles/${asset}/${month}.f64 and receipts/${asset}/${month}.jsonl where they exist, in the store directory`;
// The URL of one request, as the fetcher builds it (the mirror test below holds that text against replay.js).
const requestUrl = (origin, asset, start, end) => `${origin}/products/${asset}-USD/candles?` + new URLSearchParams({granularity: '60', start: iso(start), end: iso(end)});
// The receipts a fetch of the bucket starts [from, to) would bind to these stored rows: one per request, in request
// order, each counting the rows whose bucket it asked for. A bucket two requests share is counted by both, as the
// exchange returns it twice.
function receiptsFor(asset, from, to, rows, {origin = COINBASE_URL, httpDate = HTTP_DATE} = {}) {
  return chunksOf(from, to).map(([start, end]) => ({url: requestUrl(origin, asset, start, end), receivedAt: RECEIVED_AT, httpDate,
    sha256: sha(`${asset} ${iso(start)}`), rowCount: rows.filter(row => row[0] - MINUTE >= start && row[0] - MINUTE <= end).length, attempts: 1}));
}
// Receipts as the text of a .jsonl file; a string stands for a line that is taken as it is.
const receiptsText = receipts => receipts.map(receipt => (typeof receipt === 'string' ? receipt : JSON.stringify(receipt)) + '\n').join('');
// A hand edit that covers its tracks: a month's receipts file is replaced and its manifest entry bound to the new
// file by SHA-256 and line count, so the loader has nothing to object to.
function rebindReceipts(dir, asset, month, text) {
  const lines = text.split('\n').filter(line => line.length).length;
  fs.writeFileSync(receiptsFile(dir, asset, month), text);
  editManifest(dir, manifest => Object.assign(manifest.assets[asset].months[month], {requests: lines, receipts: lines, receiptsSha256: sha(text)}));
}

const monthBounds = month => { const [year, number] = month.split('-').map(Number); return [Date.UTC(year, number - 1, 1), Date.UTC(year, number, 1)]; };
// The part of a month inside the exploration bounds: all of it, except that 2025-09 stops at 2025-09-30T00:00Z.
const wholeMonth = month => { const [start, end] = monthBounds(month); return [Math.max(start, EXPLORATION_FROM), Math.min(end, RESERVED_FROM)]; };
// The rows of a month in the stores written by hand below: the first bucket of every request of its fetch, and its
// last bucket. So no answer is empty, the last wanted bucket is there, and each bucket two requests share came back
// twice: requests + 1 rows, requests - 1 of them returned twice.
const monthRows = month => { const [from, to] = wholeMonth(month); return [...chunksOf(from, to).map(([start]) => handRow(start, 100)), handRow(to - MINUTE, 101)]; };
// One whole month written by hand as a fetch of it would leave it: rows, one receipt per request, and a manifest
// entry that says what the receipts say. `receipts` and `overrides` are where a test departs from that.
function writeWholeMonth(dir, asset, month, {source = SOURCE, origin = COINBASE_URL, rows = monthRows(month), receipts, overrides = {}} = {}) {
  const [from, to] = wholeMonth(month), bound = receipts ?? receiptsFor(asset, from, to, rows, {origin});
  writeStore(dir, asset, month, rows, {from: iso(from), to: iso(to), duplicateRows: bound.reduce((sum, receipt) => sum + receipt.rowCount, 0) - rows.length,
    emptyResponses: bound.filter(receipt => receipt.rowCount === 0).length, lastBucketPresent: rows.at(-1)?.[0] === to, ...overrides}, undefined, bound, source);
}
// A whole store written by hand: every month of the exploration range for both assets, labelled `source`, with
// receipts that name `origin`.
function writeWholeStore(dir, source = SOURCE, origin = COINBASE_URL) {
  for (const asset of ASSETS) for (const month of explorationMonths()) writeWholeMonth(dir, asset, month, {source, origin});
}
// What storeCompleteness returns for such a store, whatever its label.
const wholeStoreResult = (source = SOURCE) => ({complete: true, source, sourceIsExchange: source === SOURCE, usable: source === SOURCE, problems: [],
  emptyResponseMonths: [], lastBucketMissingMonths: [],
  rowsByMonth: Object.fromEntries(ASSETS.map(asset => [asset, Object.fromEntries(explorationMonths().map(month => [month, monthRows(month).length]))]))});

// ---- test stores (test-store.mjs), and the answers they stand for
// The rows of a test store month: monthRows, with LINK's prices a tenth of BTC's so that the two cannot be mixed up.
const testRows = (asset, month) => monthRows(month).map(([close, , , open]) => handRow(close - MINUTE, asset === 'BTC' ? open : open / 10));
// The answers writeTestStore's stub gives, as its documentation states them: the rows whose bucket a request asks
// for, newest first, each [bucket start in seconds, low, high, open, close, volume], as JSON, with the Date header
// HTTP_DATE (the IMF-fixdate of TEST_STORE_NOW) unless `dated(asset, month, index)` says otherwise. Written here
// again, on its own, so that the store writeTestStore leaves can be held against a fetch of these answers.
function answersFrom(rowsFor, dated = () => true) {
  const months = new Map();
  return async url => {
    const target = new URL(url), asset = /^\/products\/(BTC|LINK)-USD\/candles$/.exec(target.pathname)[1];
    const start = Date.parse(target.searchParams.get('start')), end = Date.parse(target.searchParams.get('end')), month = iso(start).slice(0, 7);
    if (!months.has(`${asset} ${month}`)) months.set(`${asset} ${month}`, rowsFor(asset, month));
    const rows = months.get(`${asset} ${month}`).filter(([close]) => close - MINUTE >= start && close - MINUTE <= end).reverse();
    const body = JSON.stringify(rows.map(([close, ...values]) => [(close - MINUTE) / 1000, ...values]));
    return new Response(body, {headers: dated(asset, month, (start - wholeMonth(month)[0]) / CHUNK) ? {date: HTTP_DATE} : {}});
  };
}
// Every file of a store with its bytes, to tell two stores apart byte for byte.
const storeBytes = dir => Object.fromEntries(filesIn(dir).map(file => [file, fs.readFileSync(path.join(dir, file)).toString('base64')]));
// The clock a test store is written with, for a fetch made in this process: receivedAt and fetchedAt are Date.now().
function fixedClock(t) {
  const realNow = Date.now;
  Date.now = () => TEST_STORE_NOW;
  t.after(() => { Date.now = realNow; });
}

// A stub exchange for fetchImpl: the synthetic candles of the buckets a request names, newest first as the exchange
// sends them. `keep(asset, bucketSeconds, request)` can drop rows; nothing is connected to.
const stubExchange = (keep = () => true) => async url => {
  const target = new URL(url), asset = /^\/products\/(BTC|LINK)-USD\/candles$/.exec(target.pathname)[1], rows = [];
  const request = {asset, start: Date.parse(target.searchParams.get('start')), end: Date.parse(target.searchParams.get('end'))};
  for (let bucket = request.end / 1000; bucket >= request.start / 1000; bucket -= 60) {
    const row = candle(asset, bucket);
    if (row && keep(asset, bucket, request)) rows.push(row);
  }
  return new Response(JSON.stringify(rows), {headers: {date: HTTP_DATE}});
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
  const stub = async url => { mine.push(String(url)); return new Response('[]', {headers: {date: HTTP_DATE}}); };
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
    // These answers carry no Date header, so on the exchange's host the month's line also counts them as not dated.
    assert.match(lines.at(-2), /^BTC 2025-09: 0 rows from 5 requests, 5 retries, 5 empty responses, 5 answers not dated; 5\/5 requests done, ETA 0s$/);
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

// The run a real fetch makes: every option at its default but the directory, so the public host, 250 ms between the
// requests of a stream, and a store labelled as the exchange's. A stub answers and the clock is virtual: nothing is
// contacted and nothing is waited for. What the fetcher leaves must be what storeCompleteness accepts.
test('the default run, answered by a stub under a virtual clock, leaves a store that is complete and usable', async t => {
  const clock = virtualClock(t), dir = tmp(t), urls = [];
  // Each answer holds the request's first and last bucket and carries an HTTP date, as an answer over HTTP does.
  const rowsOf = url => {
    const target = new URL(url), [start, end] = ['start', 'end'].map(name => Date.parse(target.searchParams.get(name)) / 1000);
    return JSON.stringify([...new Set([end, start])].map(bucket => [bucket, 1, 4, 2, 3, 5]));
  };
  const result = await clock.settle(fetchCandles({dir, log: quiet, fetchImpl: async url => { urls.push(String(url)); return new Response(rowsOf(url), {headers: {date: HTTP_DATE}}); }}),
    250, 4 * 3600000);
  assert.equal(result.error, undefined);
  assert.deepEqual([result.value.source, result.value.requests, result.value.from, result.value.to], [SOURCE, 20300, '2020-01-01', '2025-09-30']);
  assert.equal(urls.filter(url => url.startsWith('https://api.exchange.coinbase.com/products/')).length, 20300);
  // Every month of the range for both assets: whole, with rows, bound to receipts that name the exchange, carry a
  // date, are as many as the month's requests, cover it and count its rows.
  const usable = storeCompleteness(dir);
  assert.deepEqual([usable.complete, usable.sourceIsExchange, usable.usable, usable.problems], [true, true, true, []]);
  assert.deepEqual(usable, wholeStoreResult());           // the store the tests below write by hand is this one, month for month
  // The same run, one month of it, answered by a stub that sets no Date header: labelled as the exchange's all the
  // same, because the label follows the base URL, and reported, because no answer over HTTP comes without a date.
  // The fetcher says so at the first such answer, and the month's line counts them.
  const bare = tmp(t), lines = [];
  const dateless = await clock.settle(fetchCandles({from: '2025-09-01', assets: ['BTC'], dir: bare, log: line => lines.push(line),
    fetchImpl: async url => new Response(rowsOf(url))}), 250);
  assert.equal(dateless.error, undefined);
  const reported = storeCompleteness(bare);
  assert.deepEqual([reported.source, reported.sourceIsExchange, reported.usable, reported.problems.filter(problem => problem.month === '2025-09')],
    [SOURCE, true, false, [{asset: 'BTC', month: '2025-09', problem: 'receipt 1 carries no HTTP date in a format RFC 9110 allows that is later than ' +
      `2025-09-01T05:00:00.000Z, the close of the last bucket it asks for, and this store is labelled as fetched from the exchange${refetch('BTC', '2025-09')}`},
    {asset: 'LINK', month: '2025-09', problem: `missing: the manifest has no entry for this month${RUN_AGAIN}`}]]);
  assert.deepEqual([lines.length, lines[0], lines[1]], [2, 'warning: BTC 2025-09: an answer is not dated: storeCompleteness needs a Date header in a format ' +
    'RFC 9110 allows and a receive time, both later than 2025-09-01T05:00:00.000Z, when the last bucket asked for closed (Date header: null, ' +
    `received ${iso(JSON.parse(fs.readFileSync(receiptsFile(bare, 'BTC', '2025-09'), 'utf8').split('\n')[0]).receivedAt)}). Every month holding such an answer ` +
    'is reported and the study refuses the store; each month\'s line counts them. Only this first one is shown: ' +
    'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2025-09-01T00%3A00%3A00.000Z&end=2025-09-01T04%3A59%3A00.000Z',
  'BTC 2025-09: 141 rows from 140 requests, 140 answers not dated; 140/140 requests done, ETA 0s']);
});

// On the exchange's host an answer must be dated (dataset.mjs receiptDated: an HTTP date RFC 9110 allows, and a
// receive time, both later than the close of the last bucket asked for), or storeCompleteness reports its month. The
// fetcher says so once, at the first answer that is not, and each month's line counts them. A loopback test server
// is exempt: its store is never the exchange's.
test('on the exchange\'s host the first answer that is not dated is shown at once, and each month\'s line counts them', async t => {
  const clock = virtualClock(t), dir = tmp(t), lines = [];
  // The n-th request of each asset's stream, over 2025-08-31 and 2025-09-01 (five requests a day): which Date header
  // lines its answer carries. Undated: a date before the last bucket asked for closed (and after the first one
  // closed, so that holding the date to the first bucket would pass it: data4 finding 1), a text V8 reads as a date
  // and RFC 9110 does not ("stub 1", read as 2001), no header, and "0".
  const headers = {'BTC 1': [HTTP_DATE, HTTP_DATE], 'BTC 2': ['Thursday, 19-Nov-26 07:57:37 GMT'], 'BTC 3': ['Thu Nov 19 07:57:37 2026'],
    'BTC 4': ['Sun, 31 Aug 2025 16:00:00 GMT'], 'BTC 5': ['stub 1'], 'BTC 7': [], 'LINK 9': ['0']};
  const count = {BTC: 0, LINK: 0}, answers = stubExchange();
  const fetchImpl = async url => {
    const asset = /\/products\/(BTC|LINK)-USD\//.exec(url)[1], dates = headers[`${asset} ${++count[asset]}`] ?? [HTTP_DATE];
    return new Response(await (await answers(url)).text(), {headers: dates.map(date => ['date', date])});
  };
  const result = await clock.settle(fetchCandles({from: '2025-08-31', to: '2025-09-02', dir, log: line => lines.push(line), fetchImpl}), 250);
  assert.equal(result.error, undefined);
  const fourth = chunksOf(utc('2025-08-31'), utc('2025-09-01'))[3];
  assert.ok(Date.parse('2025-08-31T16:00:00Z') > fourth[0] + MINUTE && Date.parse('2025-08-31T16:00:00Z') < fourth[1] + MINUTE, 'between the first and the last close');
  assert.deepEqual(lines.filter(line => line.startsWith('warning: ')), ['warning: BTC 2025-08: an answer is not dated: storeCompleteness needs a Date header ' +
    `in a format RFC 9110 allows and a receive time, both later than ${iso(fourth[1] + MINUTE)}, when the last bucket asked for closed (Date header: ` +
    `"Sun, 31 Aug 2025 16:00:00 GMT", received ${iso(readReceipts(dir, 'BTC', '2025-08')[3].receivedAt)}). Every month holding such an answer is reported and ` +
    `the study refuses the store; each month's line counts them. Only this first one is shown: ${requestUrl(COINBASE_URL, 'BTC', ...fourth)}`]);
  const month = (asset, name) => lines.find(line => line.startsWith(`${asset} ${name}: `)).replace(/; \d+\/20 requests done, ETA \d+s$/, '');
  const rows = (asset, from, to) => expectedRows(asset, utc(from), utc(to)).length;
  assert.deepEqual(['BTC', 'LINK'].flatMap(asset => ['2025-08', '2025-09'].map(name => month(asset, name))), [
    `BTC 2025-08: ${rows('BTC', '2025-08-31', '2025-09-01')} rows from 5 requests, 2 answers not dated`,
    `BTC 2025-09: ${rows('BTC', '2025-09-01', '2025-09-02')} rows from 5 requests, 1 answer not dated`,
    `LINK 2025-08: ${rows('LINK', '2025-08-31', '2025-09-01')} rows from 5 requests`,
    `LINK 2025-09: ${rows('LINK', '2025-09-01', '2025-09-02')} rows from 5 requests, 1 answer not dated`]);
  // The counts are storeCompleteness's own test, receipt by receipt; two joined Date lines and the obsolete forms pass.
  const undated = (asset, name) => readReceipts(dir, asset, name).map((receipt, i) => [i + 1, receiptDated(receipt, Date.parse(new URL(receipt.url).searchParams.get('end')))])
    .filter(([, dated]) => !dated).map(([n]) => n);
  assert.deepEqual([undated('BTC', '2025-08'), undated('BTC', '2025-09'), undated('LINK', '2025-08'), undated('LINK', '2025-09')], [[4, 5], [2], [], [4]]);
  assert.equal(readReceipts(dir, 'BTC', '2025-08')[0].httpDate, `${HTTP_DATE}, ${HTTP_DATE}`);
  // A loopback test server: the same answers without any Date header are neither shown nor counted.
  const quietLines = [];
  const loopback = await clock.settle(fetchCandles({from: '2025-08-31', to: '2025-09-02', dir: tmp(t), baseUrl: 'http://127.0.0.1:9', pauseMs: 0,
    log: line => quietLines.push(line), fetchImpl: async url => new Response(await (await answers(url)).text())}), 250);
  assert.equal(loopback.error, undefined);
  assert.deepEqual([quietLines.length, quietLines.filter(line => /date/i.test(line))], [4, []]);
});

// A refusal says how to repair what it refuses. Every problem that fetching the month again repairs ends with
// "; delete candles/<ASSET>/<YYYY-MM>.f64 in the store directory and run research/fetch-candles.mjs again", or "; run
// research/fetch-candles.mjs again" when there is no candle file to delete. Here each is followed to the letter on a
// whole exchange store, and the fetcher, run again, leaves the store byte for byte as an honest fetch left it: the
// month's candles, receipts and manifest entry replaced, nothing else touched.
test('every problem that fetching the month again repairs says so, and doing what it says repairs the month', async t => {
  const clock = virtualClock(t), dir = tmp(t);
  fixedClock(t);
  writeTestStore(dir, {rowsFor: testRows, source: SOURCE});
  const honest = storeBytes(dir), fetchImpl = answersFrom(testRows);
  assert.deepEqual(storeCompleteness(dir), wholeStoreResult());
  const receiptsOf = (asset, month) => readReceipts(dir, asset, month);
  const damages = [
    ['an answer without a usable date', 'LINK', '2022-03', () => writeTestStore(dir, {rowsFor: testRows, source: SOURCE, assets: ['LINK'], months: ['2022-03'],
      dated: (asset, month, index) => index !== 68}), /^receipt 69 carries no HTTP date in a format RFC 9110 allows that is later than /],
    ['every answer empty', 'BTC', '2023-11', () => writeTestStore(dir, {rowsFor: (asset, month) => (month === '2023-11' ? [] : testRows(asset, month)), source: SOURCE,
      assets: ['BTC'], months: ['2023-11']}), /^holds no row$/],
    ['a receipt replaced by a copy of the one before', 'BTC', '2021-06', () => rebindReceipts(dir, 'BTC', '2021-06',
      receiptsText(receiptsOf('BTC', '2021-06').map((receipt, i, all) => (i === 4 ? all[3] : receipt)))), /^the receipts' requests do not cover the stored range/],
    ['a request of 301 buckets', 'LINK', '2020-07', () => rebindReceipts(dir, 'LINK', '2020-07', receiptsText(receiptsOf('LINK', '2020-07').map((receipt, i) =>
      (i === 0 ? {...receipt, url: requestUrl(COINBASE_URL, 'LINK', utc('2020-07-01'), utc('2020-07-01') + 300 * MINUTE)} : receipt)))), /^receipt 1 asks for the buckets .*, 301 of them/],
    ['a request that reaches the reserved range', 'BTC', '2025-09', () => rebindReceipts(dir, 'BTC', '2025-09', receiptsText(receiptsOf('BTC', '2025-09').map((receipt, i, all) =>
      (i === all.length - 1 ? {...receipt, url: requestUrl(COINBASE_URL, 'BTC', chunksOf(...wholeMonth('2025-09')).at(-1)[0], RESERVED_FROM)} : receipt)))),
    /^receipt 140 asks for the buckets .* which are not all inside the exploration range/],
    ['receipts that name a loopback server', 'LINK', '2024-04', () => rebindReceipts(dir, 'LINK', '2024-04', receiptsText(receiptsOf('LINK', '2024-04').map(receipt =>
      ({...receipt, url: receipt.url.replace(COINBASE_URL, 'http://127.0.0.1:9')})))), /^receipt 1 names http:\/\/127\.0\.0\.1:9/],
    // A range wider than the month: the fetcher keeps such a month (it covers what is wanted), so the candle file
    // must go for it to be fetched again; the remedy says so.
    ['a stored range a day wider than the month', 'BTC', '2022-01', () => editManifest(dir, manifest => { manifest.assets.BTC.months['2022-01'].from = '2021-12-31T00:00:00.000Z'; }),
      /^stored for 2021-12-31T00:00:00\.000Z to 2022-02-01T00:00:00\.000Z, which is not exactly the whole month /],
    ['not marked complete', 'LINK', '2023-01', () => editManifest(dir, manifest => { manifest.assets.LINK.months['2023-01'].complete = false; }), /^not marked complete$/],
    ['no receipts bound', 'BTC', '2020-02', () => editManifest(dir, manifest => { delete manifest.assets.BTC.months['2020-02'].receiptsSha256; }), /^no receipts file is bound/],
    ['the candle file gone', 'LINK', '2021-11', () => fs.rmSync(candleFile(dir, 'LINK', '2021-11')), /^does not verify against the manifest: candle file unreadable \(ENOENT\)$/],
    ['no manifest entry, the files left behind', 'BTC', '2024-12', () => editManifest(dir, manifest => { delete manifest.assets.BTC.months['2024-12']; }),
      /^missing: the manifest has no entry for this month$/],
    ['no manifest entry and no files', 'LINK', '2020-01', () => { editManifest(dir, manifest => { delete manifest.assets.LINK.months['2020-01']; });
      fs.rmSync(candleFile(dir, 'LINK', '2020-01')); fs.rmSync(receiptsFile(dir, 'LINK', '2020-01')); }, /^missing: the manifest has no entry for this month$/]
  ];
  for (const [name, asset, month, damage, shortfall] of damages) {
    damage();
    const problems = storeCompleteness(dir).problems.filter(problem => !problem.problem.startsWith('not in the manifest'));
    assert.deepEqual(problems.map(problem => [problem.asset, problem.month]), [[asset, month]], name);
    // The text: what falls short, then what to do. Done to the letter: the file it names deleted (its path is in the
    // store directory, as the text says), the fetcher run.
    const remedy = /^(.*); (?:delete (candles\/(?:BTC|LINK)\/\d{4}-\d{2}\.f64) in the store directory and )?run research\/fetch-candles\.mjs again$/.exec(problems[0].problem);
    assert.ok(remedy, `${name}: ${problems[0].problem}`);
    assert.match(remedy[1], shortfall, name);
    assert.equal(remedy[2] === undefined, !fs.existsSync(candleFile(dir, asset, month)), `${name}: a candle file to delete is named when there is one`);
    if (remedy[2]) fs.rmSync(path.join(dir, remedy[2]));
    const result = await clock.settle(fetchCandles({dir, log: quiet, fetchImpl}), 250, 4 * 3600000);
    assert.equal(result.error, undefined, name);
    // Exactly that month was fetched again, and the store is the honest one, byte for byte: whatever the damage
    // touched (rows, receipts, the manifest entry) has been replaced by what a fetch stores.
    assert.deepEqual([result.value.requests, result.value.assets[asset].fetched], [chunksOf(...wholeMonth(month)).length, 1], name);
    assert.deepEqual(storeBytes(dir), honest, name);
    assert.deepEqual(storeCompleteness(dir), wholeStoreResult(), name);
  }
});

// test-store.mjs writes a store by running the fetcher on answers a test gives. For the same answers, a fetch made
// here through a stub, into a directory of its own, leaves the same files with the same bytes: candles, receipts and
// manifest. The answers include every kind a fetch meets: dense minutes with gaps, buckets two requests share, an
// answer with no row, a month whose last bucket has no candle, and an answer without a Date header.
test('writeTestStore leaves what the fetcher leaves for the same answers, file for file and byte for byte', async t => {
  const clock = virtualClock(t);
  fixedClock(t);
  const hole = chunksOf(...wholeMonth('2025-08'))[10];
  const rowsFor = (asset, month) => expectedRows(asset, ...wholeMonth(month)).filter(([close]) =>
    !(month === '2025-08' && close - MINUTE >= hole[0] && close - MINUTE <= hole[1]) && !(asset === 'LINK' && month === '2020-01' && close === utc('2020-02-01')));
  const dated = (asset, month, index) => !(asset === 'BTC' && month === '2025-09' && index === 3);
  for (const [source, baseUrl, months, from, to] of [[SOURCE, COINBASE_URL, ['2025-08', '2025-09'], '2025-08-01', '2025-09-30'],
    [LOOPBACK_SOURCE, 'http://127.0.0.1:9', ['2020-01'], '2020-01-01', '2020-02-01']]) {
    const mine = tmp(t), theirs = tmp(t);
    const written = writeTestStore(mine, {rowsFor, source, months, dated});
    const fetched = await clock.settle(fetchCandles({from, to, dir: theirs, baseUrl, pauseMs: source === SOURCE ? 250 : 0, log: quiet,
      fetchImpl: answersFrom(rowsFor, dated)}), 250, 4 * 3600000);
    assert.equal(fetched.error, undefined);
    assert.deepEqual(filesIn(mine), filesIn(theirs));
    assert.deepEqual(storeBytes(mine), storeBytes(theirs), source);
    assert.deepEqual([written.dir, written.source, written.requests, written.rows],
      [mine, source, fetched.value.requests, Object.fromEntries(ASSETS.map(asset => [asset, fetched.value.assets[asset].rows]))]);
    // What the answers held: an empty one, a month without its last bucket, a receipt without a date.
    const manifest = readManifestFile(mine);
    if (source === SOURCE) {
      assert.deepEqual([manifest.assets.BTC.months['2025-08'].emptyResponses, manifest.assets.LINK.months['2025-08'].emptyResponses], [1, 1]);
      assert.equal(readReceipts(mine, 'BTC', '2025-09')[3].httpDate, null);
      assert.ok(readReceipts(mine, 'BTC', '2025-09').every((receipt, i) => i === 3 || (receipt.httpDate === HTTP_DATE && receipt.receivedAt === TEST_STORE_NOW)));
      assert.ok(manifest.assets.BTC.months['2025-08'].duplicateRows > 100);
    } else assert.deepEqual([manifest.assets.LINK.months['2020-01'].lastBucketPresent, manifest.assets.BTC.months['2020-01'].fetchedAt], [false, iso(TEST_STORE_NOW)]);
  }
});

// What other test files (research/study.test.mjs) build their stores with: an honest store, which storeCompleteness
// accepts and loadSeries reads, written only where a test says and never into the default store.
test('writeTestStore: a whole honest store that storeCompleteness accepts and loadSeries reads, and never the default store', async t => {
  const months = explorationMonths(), dir = tmp(t);
  const written = writeTestStore(dir, {rowsFor: testRows, source: SOURCE});
  assert.deepEqual({...written, log: written.log.length}, {dir, source: SOURCE, requests: 20300, rows: {BTC: 10219, LINK: 10219}, log: 138});
  assert.deepEqual(storeCompleteness(dir), wholeStoreResult());
  for (const asset of ASSETS) {
    const series = loadSeries(dir, asset), stored = months.flatMap(month => testRows(asset, month));
    assert.deepEqual([[...series.time], [...series.close]], [stored.map(row => row[0]), stored.map(row => row[4])]);
  }
  // The fetcher's receipts: one per request of at most 300 buckets, naming the exchange, dated by the store's clock.
  const receipts = readReceipts(dir, 'LINK', '2021-06');
  assert.deepEqual(receipts.map(receipt => receipt.url), chunksOf(...wholeMonth('2021-06')).map(([start, end]) => requestUrl(COINBASE_URL, 'LINK', start, end)));
  assert.ok(receipts.every(receipt => receipt.httpDate === HTTP_DATE && receipt.receivedAt === TEST_STORE_NOW && receipt.attempts === 1));
  assert.equal(readManifestFile(dir).assets.BTC.months['2025-09'].fetchedAt, '2026-11-19T07:57:37.000Z');
  // The same rows under the loopback label: complete and not usable, its receipts naming the loopback URL given.
  const loopback = tmp(t);
  writeTestStore(loopback, {rowsFor: testRows, source: LOOPBACK_SOURCE, loopbackUrl: 'http://localhost:8080'});
  assert.deepEqual(storeCompleteness(loopback), wholeStoreResult(LOOPBACK_SOURCE));
  assert.ok(readReceipts(loopback, 'BTC', '2020-01').every(receipt => receipt.url.startsWith('http://localhost:8080/products/BTC-USD/candles?') && receipt.httpDate === HTTP_DATE));
  // Answers without a Date header under the exchange label: what a stub that sets none leaves, and reported.
  const undated = tmp(t);
  writeTestStore(undated, {rowsFor: testRows, source: SOURCE, months: ['2025-09', '2020-01'], dated: false});
  assert.deepEqual(storeCompleteness(undated).problems.filter(problem => ['2020-01', '2025-09'].includes(problem.month)), ASSETS.flatMap(asset => ['2020-01', '2025-09'].map(month => ({
    asset, month, problem: `receipt 1 carries no HTTP date in a format RFC 9110 allows that is later than ${iso(chunksOf(...wholeMonth(month))[0][1] + MINUTE)}, the close of ` +
      `the last bucket it asks for, and this store is labelled as fetched from the exchange${refetch(asset, month)}`}))));
  // Every answer of those months, the last one of each included, carries no date (data4 finding 2).
  assert.ok(['2025-09', '2020-01'].every(month => ASSETS.every(asset => {
    const receipts = readReceipts(undated, asset, month);
    return receipts.length === chunksOf(...wholeMonth(month)).length && receipts.every(receipt => receipt.httpDate === null);
  })));
  // A store that is there already: the listed months are written anew, the others kept; another label is refused.
  writeTestStore(dir, {rowsFor: (asset, month) => testRows(asset, month).slice(0, 2), source: SOURCE, assets: ['LINK'], months: ['2022-04', '2022-02']});
  const rewritten = storeCompleteness(dir);
  assert.deepEqual([rewritten.complete, rewritten.usable, rewritten.rowsByMonth.LINK['2022-02'], rewritten.rowsByMonth.LINK['2022-04'], rewritten.rowsByMonth.BTC],
    [true, true, 2, 2, wholeStoreResult().rowsByMonth.BTC]);
  assert.deepEqual(rewritten.lastBucketMissingMonths, [{asset: 'LINK', month: '2022-02'}, {asset: 'LINK', month: '2022-04'}]);
  assert.throws(() => writeTestStore(dir, {rowsFor: testRows, source: LOOPBACK_SOURCE, months: ['2022-02']}),
    /^Error: writeTestStore: .* holds a store labelled "Coinbase Exchange public completed one-minute candles \(https:\/\/api\.exchange\.coinbase\.com\)", not "Loopback test server/);
  assert.equal(storeCompleteness(dir).rowsByMonth.LINK['2022-02'], 2);    // refused before anything was written
  // Options that are not what the documentation says are refused; so are rows the exchange would never send.
  const at = (month, minute, close = 100) => handRow(wholeMonth(month)[0] + minute * MINUTE, close);
  for (const [options, message] of [
    [{source: SOURCE}, /rowsFor must be a function/], [{rowsFor: testRows}, /source must be SOURCE or LOOPBACK_SOURCE/],
    [{rowsFor: testRows, source: 'synthetic test store'}, /source must be SOURCE or LOOPBACK_SOURCE/],
    [{rowsFor: testRows, source: SOURCE, months: ['2025-10']}, /months must be a non-empty list/], [{rowsFor: testRows, source: SOURCE, months: []}, /months must be/],
    [{rowsFor: testRows, source: SOURCE, months: ['2021-06', '2021-06']}, /months must be/], [{rowsFor: testRows, source: SOURCE, assets: ['ETH']}, /assets must be/],
    [{rowsFor: testRows, source: SOURCE, dated: 'yes'}, /dated must be true, false or a function/], [{rowsFor: testRows, source: SOURCE, now: 1.5}, /now must be a whole number/],
    [{rowsFor: () => 'rows', source: SOURCE, months: ['2021-06']}, /rowsFor\(BTC, 2021-06\) is not an array of rows/],
    [{rowsFor: () => [at('2021-06', 0).slice(0, 5)], source: SOURCE, months: ['2021-06']}, /rowsFor\(BTC, 2021-06\) row 0 is not 6 finite numbers/],
    [{rowsFor: () => [at('2021-07', 0)], source: SOURCE, months: ['2021-06']},
      /rowsFor\(BTC, 2021-06\) row 0: 1625097660000 is not the close of a minute whose bucket starts in 2021-06-01T00:00:00\.000Z to 2021-07-01T00:00:00\.000Z/],
    [{rowsFor: () => [handRow(RESERVED_FROM)], source: SOURCE, months: ['2025-09']}, /rowsFor\(BTC, 2025-09\) row 0: .* to 2025-09-30T00:00:00\.000Z/],
    // A close at the month's first instant is the previous month's last bucket: never served for this month, so it
    // is refused rather than silently left out (data4 finding 2).
    [{rowsFor: () => [at('2021-06', -1)], source: SOURCE, months: ['2021-06']},
      /rowsFor\(BTC, 2021-06\) row 0: 1622505600000 is not the close of a minute whose bucket starts in 2021-06-01T00:00:00\.000Z to 2021-07-01T00:00:00\.000Z/],
    [{rowsFor: () => [at('2021-06', 5), at('2021-06', 5)], source: SOURCE, months: ['2021-06']}, /rows are not strictly increasing at row 1/],
    [{rowsFor: () => [[at('2021-06', 5)[0], 101, 102, 100, 100, 1]], source: SOURCE, months: ['2021-06'], assets: ['BTC']}, /^Error: writeTestStore: BTC: invalid candle values \(2021-06\)/],
    [{rowsFor: testRows, source: LOOPBACK_SOURCE, months: ['2021-06'], loopbackUrl: 'http://example.com'}, /^Error: writeTestStore: baseUrl must be exactly/]])
    assert.throws(() => writeTestStore(tmp(t), options), message, String(message));
  assert.throws(() => writeTestStore('', {rowsFor: testRows, source: SOURCE}), /dir must be a path/);
  // The default store, .research-data under the working directory, is refused by its real path: named in any
  // spelling, through a symbolic link, or as a directory inside it. Run in a child process whose working directory is
  // a scratch directory with a .research-data of its own, so that a mistake would write there, never in the repository.
  const cwd = tmp(t), store = path.join(cwd, '.research-data');
  fs.mkdirSync(store);
  fs.symlinkSync(store, path.join(cwd, 'link'));
  const dirs = ['.research-data', './.research-data/', store, 'link', '.research-data/inner', 'link/inner/deeper', 'own'];
  const script = `
    import {writeTestStore} from ${JSON.stringify(pathToFileURL(TEST_STORE).href)};
    import {SOURCE} from ${JSON.stringify(pathToFileURL(DATASET).href)};
    const outcomes = [];
    for (const dir of JSON.parse(process.env.TEST_DIRS)) {
      try { outcomes.push('wrote ' + writeTestStore(dir, {rowsFor: () => [], source: SOURCE, months: ['2025-09'], assets: ['BTC']}).requests + ' answers'); }
      catch (error) { outcomes.push(error.message); }
    }
    console.log(JSON.stringify(outcomes));`;
  const attempt = (where, tried) => new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', script],
    {cwd: where, env: {PATH: process.env.PATH, TEST_DIRS: JSON.stringify(tried)}}, (error, stdout, stderr) => resolve({stdout, stderr})));
  const refusal = dir => `writeTestStore: ${dir} is the default store .research-data or inside it; a test store is never written there; refused`;
  const {stdout, stderr} = await attempt(cwd, dirs);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), [...dirs.slice(0, -1).map(refusal), 'wrote 140 answers']);
  assert.deepEqual([fs.readdirSync(store), filesIn(path.join(cwd, 'own'))], [[], ['candles/BTC/2025-09.f64', 'manifest.json', 'receipts/BTC/2025-09.jsonl']]);
  // A default store that is itself a symbolic link (to a data disk, say) is found out through that link: naming the
  // directory it points to, or one inside it, is refused as well (data4 finding 2).
  const elsewhere = tmp(t), disk = tmp(t);
  fs.symlinkSync(disk, path.join(elsewhere, '.research-data'));
  const throughLink = [disk, path.join(disk, 'inner'), '.research-data', '.research-data/inner'];
  const linked = await attempt(elsewhere, throughLink);
  assert.equal(linked.stderr, '');
  assert.deepEqual(JSON.parse(linked.stdout), throughLink.map(refusal));
  assert.deepEqual(fs.readdirSync(disk), []);
  // The module, and so its worker, finishes loading without a pending top-level await, which require() refuses
  // (study3 finding 10): a worker terminated while its module evaluation is pending can abort Node 22.
  const required = await new Promise(resolve => execFile(process.execPath, ['--experimental-require-module', '--no-warnings', '-e',
    `require(${JSON.stringify(TEST_STORE)}); console.log('loaded')`], (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
  assert.deepEqual(required, {code: 0, stdout: 'loaded\n', stderr: ''});
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
  // The failure the run must report is the blocked write's own: the open of that file's temporary path, refused
  // because a directory is there. Not the error of the cleanup that follows it (removing a directory fails too).
  const blockedWrite = file => ({name: 'Error', code: 'EISDIR', syscall: 'open', path: `${file}.tmp`});
  const narrow = {manifestRequests: 10, receiptLines: 10, storedRows: narrowRows.length};
  assert.ok(wideRows.length > narrowRows.length);

  await t.test('stopped at the first write (candles): nothing of the stored month has changed', async () => {
    const {dir, run, seen} = await setup(), before = contents(dir);
    assert.deepEqual(state(dir), narrow);
    const unblock = block(candleFile(dir, 'BTC', '2025-09'));
    await assert.rejects(run(WIDE), blockedWrite(candleFile(dir, 'BTC', '2025-09')));
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
    await assert.rejects(run(WIDE), blockedWrite(receiptsFile(dir, 'BTC', '2025-09')));
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
    await assert.rejects(run(WIDE), blockedWrite(manifestFile(dir)));
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
    await assert.rejects(run(WIDE), blockedWrite(manifestFile(dir)));
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

  await t.test('a whole month of empty answers: the fetcher stores and keeps what it was told, and storeCompleteness reports a month that holds no row', async () => {
    const dir = tmp(t);
    let calls = 0;
    const options = {...base, from: '2025-09-01', to: '2025-09-30', dir, log: quiet, fetchImpl: async () => { calls++; return new Response('[]'); }};
    const summary = await fetchCandles(options);
    assert.deepEqual([calls, summary.assets.BTC.rows, summary.assets.BTC.emptyResponses], [140, 0, {'2025-09': 140}]);
    // PROTOCOL.md: "A month that holds no row for an asset is not complete." Its receipts are in order: they name the
    // loopback origin of a loopback store, cover the month and count the no rows it stores.
    const result = storeCompleteness(dir);
    assert.deepEqual(result.problems.filter(problem => problem.month === '2025-09'), [{asset: 'BTC', month: '2025-09', problem: `holds no row${refetch('BTC', '2025-09')}`},
      {asset: 'LINK', month: '2025-09', problem: `missing: the manifest has no entry for this month${RUN_AGAIN}`}]);
    assert.deepEqual([result.complete, result.usable, result.rowsByMonth.BTC['2025-09'], result.emptyResponseMonths, result.lastBucketMissingMonths],
      [false, false, 0, [{asset: 'BTC', month: '2025-09', emptyResponses: 140}], [{asset: 'BTC', month: '2025-09'}]]);
    await fetchCandles(options);
    assert.equal(calls, 140);                             // not asked for again: deleting the month's candle file is how
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
  await t.test('a manifest of another format or written under other bounds is refused', async () => {
    const rows = [handRow(JAN, 7000)];
    let dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows, {}, {from: '2020-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z'});
    assert.throws(() => loadSeries(dir, 'BTC'), /written under other bounds/);
    assert.throws(() => publicManifest(dir), /written under other bounds/);
    // Each bound is compared on its own: a manifest whose `from` alone differs, one whose `to` alone differs, one
    // with a bound missing and one with no bounds at all are refused by everything that reads a manifest.
    const refused = /manifest\.json: written under other bounds than \[2020-01-01T00:00:00\.000Z, 2025-09-30T00:00:00\.000Z\); refused; move manifest\.json out of the store directory and run research\/fetch-candles\.mjs again, which then fetches every month anew$/;
    for (const bounds of [{from: '2019-01-01T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z'}, {from: '2020-01-01T00:00:00.000Z', to: '2025-10-01T00:00:00.000Z'},
      {from: '2020-01-01T00:00:00Z', to: '2025-09-30T00:00:00.000Z'}, {to: '2025-09-30T00:00:00.000Z'}, {from: '2020-01-01T00:00:00.000Z'}, {}, null, undefined]) {
      dir = tmp(t);
      writeStore(dir, 'BTC', '2020-01', rows);
      assert.deepEqual([...loadSeries(dir, 'BTC').close], [7000]);              // the same store under the protocol's bounds loads
      editManifest(dir, manifest => { if (bounds === undefined) delete manifest.bounds; else manifest.bounds = bounds; });
      for (const read of [() => loadSeries(dir, 'BTC'), () => publicManifest(dir), () => storeCompleteness(dir), () => receiptsSummary(dir)])
        assert.throws(read, refused, JSON.stringify(bounds));
    }
    dir = tmp(t);
    writeStore(dir, 'BTC', '2020-01', rows);
    const manifest = readManifestFile(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({...manifest, format: 'paper-trail-research-candles-v2'}));
    assert.throws(() => loadSeries(dir, 'BTC'), /not a paper-trail-research-candles-v1 manifest/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"format":');
    assert.throws(() => loadSeries(dir, 'BTC'), /unreadable manifest/);
    // Every refusal of a manifest names it and says what repairs it (data4 finding 5): the fetcher reads the manifest
    // first and refuses the same way, so running it again alone repairs nothing. Moving the manifest out does: the
    // directory then holds no manifest, and the fetcher fetches every month anew and writes one.
    const file = path.join(dir, 'manifest.json');
    for (const text of ['', '{"format":', '[]', JSON.stringify({...manifest, format: 'v2'}), JSON.stringify({...manifest, source: 7}),
      JSON.stringify({...manifest, assets: {ETH: {months: {}}}}), JSON.stringify({...manifest, assets: {BTC: []}}),
      JSON.stringify({...manifest, assets: {BTC: {months: {'2020-1': {}}}}}), JSON.stringify({...manifest, assets: {BTC: {months: {'2020-01': 1}}}})]) {
      fs.writeFileSync(file, text);
      for (const read of [() => readManifest(dir), () => storeCompleteness(dir), () => loadSeries(dir, 'BTC')])
        assert.throws(read, error => error.message.startsWith(`${file}: `) && error.message.endsWith(REMAKE_MANIFEST), text);
      await assert.rejects(fetchCandles({from: '2020-01-01', to: '2020-01-02', dir, baseUrl: 'http://127.0.0.1:9', pauseMs: 0, log() {},
        fetchImpl: async () => { throw new Error('no request is made'); }}), error => error.message.endsWith(REMAKE_MANIFEST), text);
    }
    fs.renameSync(file, path.join(tmp(t), 'manifest.json'));
    assert.equal(readManifest(dir), null);
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
// both assets, fetched from the exchange. A month that holds no row for an asset is not complete. 'Fetched from the
// exchange' is read from the store's own records (its source label and the request receipts bound to each month)".
test('storeCompleteness: every month of 2020-01 to 2025-09, whole, with rows, for both assets, with files that verify; the label is reported beside it', async t => {
  const months = explorationMonths();
  assert.equal(months.length, 69);
  assert.deepEqual([months[0], months[1], months[11], months[12], months[49], months.at(-2), months.at(-1)],
    ['2020-01', '2020-02', '2020-12', '2021-01', '2024-02', '2025-08', '2025-09']);
  assert.deepEqual(months, [...new Set(months)].sort());
  assert.equal(SOURCE, DATASET_SOURCE);                   // the fetcher re-exports the labels dataset.mjs defines
  assert.equal(DATASET_SOURCE, 'Coinbase Exchange public completed one-minute candles (https://api.exchange.coinbase.com)');
  assert.equal(LOOPBACK_SOURCE, DATASET_LOOPBACK_SOURCE);
  assert.equal(DATASET_LOOPBACK_SOURCE, 'Loopback test server: synthetic candles, not market data');
  assert.equal(COINBASE_URL, EXCHANGE_ORIGIN);            // the origin the fetcher asks is the one an exchange store's receipts must name
  assert.equal(EXCHANGE_ORIGIN, 'https://api.exchange.coinbase.com');
  assert.equal(CHUNK, 299 * MINUTE);                      // the step chunksOf() above takes from replay.js
  assert.throws(() => storeCompleteness(tmp(t)), /no manifest; fetch with research\/fetch-candles\.mjs first/);

  const dir = tmp(t);
  writeWholeStore(dir);
  const whole = wholeStoreResult(), requests = Object.fromEntries(months.map(month => [month, chunksOf(...wholeMonth(month)).length]));
  const said = result => result.problems.map(problem => `${problem.asset} ${problem.month}: ${problem.problem}`);
  // The store is put back byte for byte after each damage: changed and deleted files rewritten, added ones removed.
  const snapshot = () => Object.fromEntries(filesIn(dir).map(file => [file, fs.readFileSync(path.join(dir, file))]));
  const restore = saved => {
    for (const file of filesIn(dir)) if (!(file in saved)) fs.rmSync(path.join(dir, file));
    for (const [file, bytes] of Object.entries(saved)) {
      const target = path.join(dir, file);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes); }
    }
  };
  const saved = snapshot();

  await t.test('a whole store is complete and usable, and both series load from it', () => {
    assert.deepEqual(storeCompleteness(dir), whole);
    assert.deepEqual(Object.keys(storeCompleteness(dir)), ['complete', 'source', 'sourceIsExchange', 'usable', 'problems', 'emptyResponseMonths',
      'lastBucketMissingMonths', 'rowsByMonth']);
    assert.deepEqual([whole.complete, whole.sourceIsExchange, whole.usable], [true, true, true]);
    // A month of 31, 29, 28 and 30 days and the last month, which stops at 2025-09-30T00:00Z: requests, then rows.
    assert.deepEqual(['2020-01', '2020-02', '2021-02', '2021-06', '2025-09'].map(month => requests[month]), [150, 140, 135, 145, 140]);
    assert.deepEqual(['2020-01', '2020-02', '2021-02', '2021-06', '2025-09'].map(month => whole.rowsByMonth.LINK[month]), [151, 141, 136, 146, 141]);
    assert.deepEqual([Object.keys(whole.rowsByMonth), Object.keys(whole.rowsByMonth.BTC), Object.keys(whole.rowsByMonth.LINK)], [ASSETS, months, months]);
    for (const asset of ASSETS) {
      const series = loadSeries(dir, asset);
      assert.deepEqual([series.time.length, series.time[0], series.time.at(-1)], [10150 + 69, EXPLORATION_FROM + MINUTE, RESERVED_FROM]);
    }
    assert.deepEqual(Object.keys(receiptsSummary(dir).BTC.sha256), months);
    assert.deepEqual([receiptsSummary(dir).BTC.files, receiptsSummary(dir).BTC.receipts, receiptsSummary(dir).LINK.files, receiptsSummary(dir).LINK.receipts], [69, 10150, 69, 10150]);
    assert.deepEqual(Object.keys(publicManifest(dir).assets.LINK.months), months);
  });

  await t.test('the label is reported, and the receipts are held to the origin it names: usable is the exchange label on receipts that name the exchange', () => {
    // A label the fetcher never writes names no origin: the same files are a complete store, and not the exchange's.
    for (const source of ['synthetic test store', `${SOURCE} `, SOURCE.toLowerCase(), 'https://api.exchange.coinbase.com', '']) {
      editManifest(dir, manifest => { manifest.source = source; });
      assert.deepEqual(storeCompleteness(dir), {...whole, source, sourceIsExchange: false, usable: false});
    }
    // The loopback label on receipts that name the exchange: label and receipts contradict each other in every month.
    editManifest(dir, manifest => { manifest.source = LOOPBACK_SOURCE; });
    assert.deepEqual(storeCompleteness(dir), {...whole, complete: false, source: LOOPBACK_SOURCE, sourceIsExchange: false, usable: false,
      problems: ASSETS.flatMap(asset => months.map(month => ({asset, month,
        problem: `receipt 1 names https://api.exchange.coinbase.com, and this store is labelled as fetched from a loopback test server${refetch(asset, month)}`})))});
    restore(saved);
    assert.deepEqual(storeCompleteness(dir), whole);
    // The other way round, the edit a verifier made: a store whose receipts name a loopback server is complete under
    // its own label and never usable; with its label changed to the exchange's, every month's receipts say otherwise.
    const loopback = tmp(t);
    writeWholeStore(loopback, LOOPBACK_SOURCE, 'http://127.0.0.1:9');
    assert.deepEqual(storeCompleteness(loopback), {...whole, source: LOOPBACK_SOURCE, sourceIsExchange: false, usable: false});
    editManifest(loopback, manifest => { manifest.source = SOURCE; });
    assert.deepEqual(storeCompleteness(loopback), {...whole, complete: false, usable: false,
      problems: ASSETS.flatMap(asset => months.map(month => ({asset, month,
        problem: `receipt 1 names http://127.0.0.1:9, and this store is labelled as fetched from https://api.exchange.coinbase.com${refetch(asset, month)}`})))});
  });

  await t.test('each way a month can fall short is named, and nothing else is', () => {
    const flip = file => { const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes); };
    const entryOf = (manifest, asset, month) => manifest.assets[asset].months[month];
    const cases = [
      ['no entry', 'LINK', '2021-07', manifest => { delete manifest.assets.LINK.months['2021-07']; fs.rmSync(candleFile(dir, 'LINK', '2021-07')); fs.rmSync(receiptsFile(dir, 'LINK', '2021-07')); },
        /^missing: the manifest has no entry for this month$/],
      ['not complete', 'BTC', '2020-01', manifest => { entryOf(manifest, 'BTC', '2020-01').complete = false; }, /^not marked complete$/],
      ['complete is not true', 'BTC', '2020-01', manifest => { entryOf(manifest, 'BTC', '2020-01').complete = 'yes'; }, /^not marked complete$/],
      ['ends one minute early', 'BTC', '2023-02', manifest => { entryOf(manifest, 'BTC', '2023-02').to = '2023-02-28T23:59:00.000Z'; },
        /^stored for 2023-02-01T00:00:00\.000Z to 2023-02-28T23:59:00\.000Z, which is not exactly the whole month 2023-02-01T00:00:00\.000Z to 2023-03-01T00:00:00\.000Z$/],
      ['starts one minute late', 'LINK', '2024-02', manifest => { entryOf(manifest, 'LINK', '2024-02').from = '2024-02-01T00:01:00.000Z'; },
        /^stored for 2024-02-01T00:01:00\.000Z to 2024-03-01T00:00:00\.000Z, which is not exactly the whole month 2024-02-01T00:00:00\.000Z to 2024-03-01T00:00:00\.000Z$/],
      // The last month runs through the bucket starting 2025-09-29T23:59Z: its range must reach 2025-09-30T00:00Z.
      ['the last month stops a bucket short', 'BTC', '2025-09', manifest => { entryOf(manifest, 'BTC', '2025-09').to = '2025-09-29T23:59:00.000Z'; },
        /^stored for 2025-09-01T00:00:00\.000Z to 2025-09-29T23:59:00\.000Z, which is not exactly the whole month 2025-09-01T00:00:00\.000Z to 2025-09-30T00:00:00\.000Z$/],
      ['the first month starts a day late', 'LINK', '2020-01', manifest => { entryOf(manifest, 'LINK', '2020-01').from = '2020-01-02T00:00:00.000Z'; },
        /which is not exactly the whole month 2020-01-01T00:00:00\.000Z to 2020-02-01T00:00:00\.000Z$/],
      // A range wider than the month (Amendment 2 round, finding 0): no fetch stores one, so it is no longer taken as
      // covering the month. With its receipts rewritten to match, such a range let requests for reserved buckets pass.
      ['ends one minute late', 'BTC', '2023-02', manifest => { entryOf(manifest, 'BTC', '2023-02').to = '2023-03-01T00:01:00.000Z'; },
        /^stored for 2023-02-01T00:00:00\.000Z to 2023-03-01T00:01:00\.000Z, which is not exactly the whole month 2023-02-01T00:00:00\.000Z to 2023-03-01T00:00:00\.000Z$/],
      ['the last month reaches the first reserved bucket', 'BTC', '2025-09', manifest => { entryOf(manifest, 'BTC', '2025-09').to = '2025-09-30T00:01:00.000Z'; },
        /^stored for 2025-09-01T00:00:00\.000Z to 2025-09-30T00:01:00\.000Z, which is not exactly the whole month 2025-09-01T00:00:00\.000Z to 2025-09-30T00:00:00\.000Z$/],
      ['the last month reaches into October', 'LINK', '2025-09', manifest => { entryOf(manifest, 'LINK', '2025-09').to = '2025-10-01T00:00:00.000Z'; },
        /^stored for 2025-09-01T00:00:00\.000Z to 2025-10-01T00:00:00\.000Z, which is not exactly the whole month /],
      ['the first month starts before the range', 'LINK', '2020-01', manifest => { entryOf(manifest, 'LINK', '2020-01').from = '2019-12-31T00:00:00.000Z'; },
        /^stored for 2019-12-31T00:00:00\.000Z to 2020-02-01T00:00:00\.000Z, which is not exactly the whole month 2020-01-01T00:00:00\.000Z to 2020-02-01T00:00:00\.000Z$/],
      ['no range recorded', 'BTC', '2022-11', manifest => { delete entryOf(manifest, 'BTC', '2022-11').from; delete entryOf(manifest, 'BTC', '2022-11').to; },
        /^stored for an unrecorded range, which is not exactly the whole month 2022-11-01T00:00:00\.000Z to 2022-12-01T00:00:00\.000Z$/],
      ['a range that is not a date', 'BTC', '2022-11', manifest => { entryOf(manifest, 'BTC', '2022-11').to = 1669852800000; }, /^stored for an unrecorded range/],
      ['no receipts bound', 'LINK', '2020-03', manifest => { delete entryOf(manifest, 'LINK', '2020-03').receiptsSha256; delete entryOf(manifest, 'LINK', '2020-03').receipts; },
        /^no receipts file is bound to this month \(the entry has no receiptsSha256\)$/],
      ['candle file changed', 'BTC', '2021-01', () => flip(candleFile(dir, 'BTC', '2021-01')), /^does not verify against the manifest: candle file SHA-256 disagrees with the manifest$/],
      ['candle file gone', 'LINK', '2025-09', () => fs.rmSync(candleFile(dir, 'LINK', '2025-09')), /^does not verify against the manifest: candle file unreadable \(ENOENT\)$/],
      ['row count wrong', 'BTC', '2024-12', manifest => { entryOf(manifest, 'BTC', '2024-12').rows = 3; }, /^does not verify against the manifest: candle file holds 151 rows, the manifest says 3$/],
      ['receipts file changed', 'BTC', '2021-01', () => flip(receiptsFile(dir, 'BTC', '2021-01')), /^does not verify against the manifest: receipts file SHA-256 disagrees with the manifest$/],
      ['receipts file gone', 'LINK', '2022-06', () => fs.rmSync(receiptsFile(dir, 'LINK', '2022-06')), /^does not verify against the manifest: receipts file unreadable \(ENOENT\)$/],
      // Amendment 2: "A month that holds no row for an asset is not complete." Here every answer of the month was
      // empty, the files and the entry agree on that, and the receipts cover the month.
      ['no row', 'LINK', '2022-03', () => writeWholeMonth(dir, 'LINK', '2022-03', {rows: []}), /^holds no row$/],
      // What the bound receipts say: one way here, a file replaced and re-bound to its entry by hand. The test after
      // this one goes through every way they can disagree with the label and the entry.
      ['receipts of another month, re-bound', 'LINK', '2024-07', () => rebindReceipts(dir, 'LINK', '2024-07', fs.readFileSync(receiptsFile(dir, 'LINK', '2024-06'), 'utf8')),
        /^receipt 1 asks for the buckets 2024-06-01T00:00:00\.000Z to 2024-06-01T04:59:00\.000Z, which are not all inside the stored range 2024-07-01T00:00:00\.000Z to 2024-08-01T00:00:00\.000Z$/]
    ];
    // Every one of these is repaired by fetching the month again, and its text ends saying how: with the month's candle
    // file to delete, except where there is none (the first case and the candle file gone).
    const noCandleFile = new Set(['no entry', 'candle file gone']);
    for (const [name, asset, month, damage, problem] of cases) {
      const manifest = readManifestFile(dir);
      damage(manifest);
      if (damage.length) fs.writeFileSync(manifestFile(dir), JSON.stringify(manifest));
      const result = storeCompleteness(dir), remedy = noCandleFile.has(name) ? RUN_AGAIN : refetch(asset, month);
      assert.deepEqual([result.complete, result.source, result.sourceIsExchange, result.usable, result.problems.length], [false, SOURCE, true, false, 1], `${name}: ${said(result).join(' | ')}`);
      assert.deepEqual([result.problems[0].asset, result.problems[0].month], [asset, month], name);
      assert.deepEqual(Object.keys(result.problems[0]), ['asset', 'month', 'problem']);
      assert.ok(result.problems[0].problem.endsWith(remedy), `${name}: ${result.problems[0].problem}`);
      assert.match(result.problems[0].problem.slice(0, -remedy.length), problem, name);
      restore(saved);
      assert.deepEqual(storeCompleteness(dir), whole, `restored after: ${name}`);
    }
    // Another spelling of the same instants is the same range.
    editManifest(dir, manifest => Object.assign(manifest.assets.BTC.months['2023-02'], {from: '2023-02-01T00:00:00Z', to: '2023-03-01T00:00:00.000+00:00'}));
    assert.deepEqual(storeCompleteness(dir), whole);
    restore(saved);
    // Several at once come back in asset order, then month order; an asset absent from the manifest lacks every month.
    // The files of the months that lost their entry are still on disk, and each is reported after those: a candle or
    // receipts file that no manifest entry names.
    editManifest(dir, manifest => { delete manifest.assets.LINK; delete manifest.assets.BTC.months['2025-09']; manifest.assets.BTC.months['2020-05'].complete = false; });
    const many = storeCompleteness(dir), unnamed = (kind, asset, month, extension) =>
      `${asset} ${month}: not in the manifest: ${kind}/${asset}/${month}.${extension} is in the store directory and no manifest entry names it${MOVE_IT}`;
    assert.deepEqual([many.complete, many.usable], [false, false]);
    assert.deepEqual(said(many), [`BTC 2020-05: not marked complete${refetch('BTC', '2020-05')}`,
      `BTC 2025-09: missing: the manifest has no entry for this month${refetch('BTC', '2025-09')}`,
      ...months.map(month => `LINK ${month}: missing: the manifest has no entry for this month${refetch('LINK', month)}`),
      unnamed('candles', 'BTC', '2025-09', 'f64'), ...months.map(month => unnamed('candles', 'LINK', month, 'f64')),
      unnamed('receipts', 'BTC', '2025-09', 'jsonl'), ...months.map(month => unnamed('receipts', 'LINK', month, 'jsonl'))]);
    assert.deepEqual(Object.keys(many.problems.at(-1)), ['asset', 'month', 'problem']);
    // The rows of a month that is not marked complete, or has no entry, are not rows the loader reads: 0.
    assert.deepEqual(many.rowsByMonth, {BTC: {...whole.rowsByMonth.BTC, '2020-05': 0, '2025-09': 0}, LINK: Object.fromEntries(months.map(month => [month, 0]))});
    restore(saved);
    assert.deepEqual(storeCompleteness(dir), whole);
  });

  await t.test('a month the manifest lists outside 2020-01 to 2025-09 is a problem, with rows or without', () => {
    // The first held-out month with rows, as a verifier added it: the loader refuses the store, and now the check says why.
    writeStore(dir, 'BTC', '2025-10', [handRow(utc('2025-10-01'))], {from: '2025-10-01T00:00:00.000Z', to: '2025-11-01T00:00:00.000Z'}, undefined,
      receiptsFor('BTC', utc('2025-10-01'), utc('2025-11-01'), [handRow(utc('2025-10-01'))]));
    assert.throws(() => loadSeries(dir, 'BTC'), /BTC 2025-10 row 0: bucket start 2025-10-01T00:00:00\.000Z is outside the exploration range/);
    assert.deepEqual(storeCompleteness(dir), {...whole, complete: false, usable: false, problems: [{asset: 'BTC', month: '2025-10', problem: outsideRange('BTC', '2025-10')}]});
    restore(saved);
    // Without rows such a month loads, and it is no more the protocol's store. Either asset, before the range or
    // after it; they follow the months of the range, asset by asset in month order.
    for (const [asset, month] of [['LINK', '2026-10'], ['BTC', '2025-10'], ['LINK', '2019-12'], ['BTC', '2019-12'], ['BTC', '1999-01']]) writeStore(dir, asset, month, []);
    editManifest(dir, manifest => { delete manifest.assets.BTC.months['2020-01']; });
    fs.rmSync(candleFile(dir, 'BTC', '2020-01')); fs.rmSync(receiptsFile(dir, 'BTC', '2020-01'));
    assert.equal(loadSeries(dir, 'LINK').time.length, 10150 + 69);
    const result = storeCompleteness(dir), outside = (asset, month) => `${asset} ${month}: ${outsideRange(asset, month)}`;
    assert.deepEqual([result.complete, result.usable], [false, false]);
    assert.deepEqual(said(result), [`BTC 2020-01: missing: the manifest has no entry for this month${RUN_AGAIN}`, outside('BTC', '1999-01'), outside('BTC', '2019-12'),
      outside('BTC', '2025-10'), outside('LINK', '2019-12'), outside('LINK', '2026-10')]);
    assert.deepEqual(Object.keys(result.rowsByMonth.BTC), months);          // the months of the range, and no other
    restore(saved);
    assert.deepEqual(storeCompleteness(dir), whole);
  });

  await t.test('a file or symbolic link in the directory that no manifest entry names is a problem; operating-system litter is not', () => {
    const put = (root, file) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), 'anything'); };
    const unnamed = file => `not in the manifest: ${file} is in the store directory and no manifest entry names it${MOVE_IT}`;
    const unnamedLink = file => `not in the manifest: ${file} is a symbolic link (not followed) in the store directory and no manifest entry names it${LINK_REMEDY}`;
    // Candles of the held-out range lying in the data directory, as a verifier left them, and their receipts. The
    // loader never reads them; the check says they are there.
    put(dir, 'candles/BTC/2025-10.f64'); put(dir, 'receipts/BTC/2025-10.jsonl');
    assert.equal(loadSeries(dir, 'BTC').time.length, 10150 + 69);
    assert.deepEqual(storeCompleteness(dir), {...whole, complete: false, usable: false, problems: [{asset: 'BTC', month: '2025-10', problem: unnamed('candles/BTC/2025-10.f64')},
      {asset: 'BTC', month: '2025-10', problem: unnamed('receipts/BTC/2025-10.jsonl')}]});
    restore(saved);
    // Every other file too, whatever its name or place (Amendment 2 round, finding 4): before, only files under the
    // two trees and .f64 or .jsonl files elsewhere counted, and a note or a copy beside the manifest passed.
    for (const file of ['notes.txt', 'copy/readme.md']) put(dir, file);
    assert.deepEqual(storeCompleteness(dir), {...whole, complete: false, usable: false, problems: [{asset: 'copy', month: 'readme', problem: unnamed('copy/readme.md')},
      {asset: '', month: 'notes', problem: unnamed('notes.txt')}]});
    restore(saved);
    fs.rmdirSync(path.join(dir, 'copy'));
    // Not reported: the manifest's own temporary file, directories that hold no file, and operating-system litter
    // (Finder's .DS_Store and "._" AppleDouble files, Windows' Thumbs.db and desktop.ini) wherever it lies; and the
    // other files an operating system or file system makes by itself, which a verifier found refusing an honest store
    // (data4 finding 0): KDE's .directory, Finder's Icon\r, .localized and .apdisk, Windows' ehthumbs.db, and the
    // placeholders NFS and FUSE keep for a file deleted while open.
    for (const file of ['manifest.json.tmp', '.DS_Store', 'candles/.DS_Store', 'candles/BTC/._2021-06.f64', 'receipts/LINK/Thumbs.db', 'receipts/desktop.ini', '._manifest.json',
      'candles/.directory', 'Icon\r', 'candles/Icon\r', '.localized', '.apdisk', 'receipts/ehthumbs.db', 'candles/BTC/.nfs000000000123456700000001',
      'receipts/LINK/.fuse_hidden0000000a00000001'])
      put(dir, file);
    for (const empty of ['candles/BTC/2021-06.f64.tmp', 'receipts/ETH']) fs.mkdirSync(path.join(dir, empty));
    assert.deepEqual(storeCompleteness(dir), whole);
    restore(saved);
    for (const empty of ['candles/BTC/2021-06.f64.tmp', 'receipts/ETH']) fs.rmdirSync(path.join(dir, empty));
    assert.deepEqual(storeCompleteness(dir), whole);

    // Each kind of such a file, one at a time, in a store that holds one month. Its other 137 asset-months are
    // missing and are named first; `asset` and `month` are the file's directory and its name up to the first dot.
    const small = tmp(t), unnamedFiles = () => storeCompleteness(small).problems.slice(137);
    writeWholeMonth(small, 'BTC', '2021-06');
    assert.deepEqual([storeCompleteness(small).problems.length, unnamedFiles()], [137, []]);
    const cases = [
      ['candles/BTC/2025-10.f64', 'BTC', '2025-10'], ['receipts/BTC/2025-10.jsonl', 'BTC', '2025-10'],
      // The files of a month of the range whose entry was never written (a fetch stopped before its last write).
      ['candles/LINK/2021-06.f64', 'LINK', '2021-06'], ['receipts/LINK/2021-06.jsonl', 'LINK', '2021-06'],
      // What a write stopped half way leaves behind; a file of an asset the store does not have; a file deeper down.
      ['candles/BTC/2021-06.f64.tmp', 'BTC', '2021-06'], ['candles/ETH/2020-01.f64', 'ETH', '2020-01'], ['receipts/BTC/old/2020-01.jsonl', 'old', '2020-01'],
      ['candles/notes.txt', 'candles', 'notes'], ['receipts/BTC/2021-06.jsonl.bak', 'BTC', '2021-06'],
      ['2025-10.f64', '', '2025-10'], ['copy/LINK-2025-11.jsonl', 'copy', 'LINK-2025-11'],
      // The names a verifier put beside a usable store, which passed before (finding 4).
      ['old/candles/BTC/2025-10.f64.bak', 'BTC', '2025-10'], ['backup/candles/BTC/2025-10.f64.gz', 'BTC', '2025-10'], ['extra/2025-10.F64', 'extra', '2025-10'],
      ['2025-10.csv', '', '2025-10'], ['raw/BTC-USD-2025-10.json', 'raw', 'BTC-USD-2025-10'], ['candles.tar', '', 'candles'],
      // A litter name on something that is not a regular file is no litter: a file inside a directory so named.
      ['.DS_Store/2025-10.f64', '.DS_Store', '2025-10']
    ];
    // A file removed, and the directories it leaves empty.
    const remove = (root, file) => {
      fs.rmSync(path.join(root, file));
      for (let at = path.dirname(path.join(root, file)); at !== root && fs.readdirSync(at).length === 0; at = path.dirname(at)) fs.rmdirSync(at);
    };
    for (const [file, asset, month] of cases) {
      put(small, file);
      assert.deepEqual(unnamedFiles(), [{asset, month, problem: unnamed(file)}], file);
      remove(small, file);
    }
    // Close to litter and not litter (data4 finding 1): a candle file whose name begins with a dot, held-out
    // candles under a name the litter rule could have hidden; placeholders that are not NFS's or FUSE's (no hex
    // digits); and an editor's swap, backup, autosave or lock file of the manifest, which shows it was opened by hand.
    for (const [file, asset, month] of [['candles/BTC/.2025-10.f64', 'BTC', ''], ['.nfs-2025-10.f64', '', ''], ['receipts/.fuse_hidden', 'receipts', ''],
      ['.manifest.json.swp', '', ''], ['manifest.json~', '', 'manifest'], ['#manifest.json#', '', '#manifest'], ['.#manifest.json', '', ''], ['Icon', '', 'Icon']]) {
      put(small, file);
      assert.deepEqual(unnamedFiles(), [{asset, month, problem: unnamed(file)}], file);
      remove(small, file);
    }
    // Symbolic links, each reported as itself and never followed: a link to a directory that holds a candle file (the
    // file is not reported, nothing behind a link is looked at), to a file, a link under a litter name, and one whose
    // target does not exist.
    const elsewhere = tmp(t);
    put(elsewhere, '2025-10.f64');
    const links = [['more', elsewhere, '', 'more'], ['candles/BTC/2025-10.f64', path.join(elsewhere, '2025-10.f64'), 'BTC', '2025-10'],
      ['.DS_Store', path.join(elsewhere, '2025-10.f64'), '', ''], ['receipts/LINK/2020-01.jsonl', path.join(elsewhere, 'gone.jsonl'), 'LINK', '2020-01']];
    for (const [file, target, asset, month] of links) {
      fs.mkdirSync(path.dirname(path.join(small, file)), {recursive: true});
      fs.symlinkSync(target, path.join(small, file));
      assert.deepEqual(unnamedFiles(), [{asset, month, problem: unnamedLink(file)}], file);
      remove(small, file);
    }
    // A store directory that is itself a symbolic link is read through: it is where the store lives, not part of it.
    const linked = path.join(tmp(t), 'store');
    fs.symlinkSync(small, linked);
    assert.deepEqual(storeCompleteness(linked), storeCompleteness(small));
    // Several come back depth first in name order, after the months of the range and the months the manifest lists
    // outside it.
    for (const [file] of cases) put(small, file);
    fs.symlinkSync(elsewhere, path.join(small, 'more'));
    writeStore(small, 'LINK', '2025-10', []);
    assert.deepEqual(unnamedFiles(), [{asset: 'LINK', month: '2025-10', problem: outsideRange('LINK', '2025-10')},
      ...['.DS_Store/2025-10.f64', '2025-10.csv', '2025-10.f64', 'backup/candles/BTC/2025-10.f64.gz', 'candles/BTC/2021-06.f64.tmp', 'candles/BTC/2025-10.f64',
        'candles/ETH/2020-01.f64', 'candles/LINK/2021-06.f64', 'candles/notes.txt', 'candles.tar', 'copy/LINK-2025-11.jsonl', 'extra/2025-10.F64', 'more',
        'old/candles/BTC/2025-10.f64.bak', 'raw/BTC-USD-2025-10.json', 'receipts/BTC/2021-06.jsonl.bak', 'receipts/BTC/2025-10.jsonl', 'receipts/BTC/old/2020-01.jsonl',
        'receipts/LINK/2021-06.jsonl'].map(file => {
        if (file === 'more') return {asset: '', month: 'more', problem: unnamedLink('more')};
        const [, asset, month] = cases.find(([name]) => name === file);
        return {asset, month, problem: unnamed(file)};
      })]);
    // The month's own two files are named by its entry, and stay unreported.
    assert.deepEqual(storeCompleteness(small).problems.filter(problem => problem.asset === 'BTC' && problem.month === '2021-06' && !problem.problem.includes('.tmp') && !problem.problem.includes('.bak')), []);
  });

  await t.test('what the manifest notes per month comes back with the verdict: empty answers, a missing last bucket, rows', () => {
    // Two months that are complete and say something worth stating in a record: three answers of BTC 2022-02 were
    // empty, and no row came back for the last wanted bucket of LINK 2023-07 (the entry's notes; rows are untouched).
    editManifest(dir, manifest => { manifest.assets.BTC.months['2022-02'].emptyResponses = 3; manifest.assets.LINK.months['2023-07'].lastBucketPresent = false; });
    assert.deepEqual(storeCompleteness(dir), {...whole, emptyResponseMonths: [{asset: 'BTC', month: '2022-02', emptyResponses: 3}],
      lastBucketMissingMonths: [{asset: 'LINK', month: '2023-07'}]});
    // Both lists are in asset order, then month order, and leave out a month that is not marked complete (the loader
    // does not read it) and a month outside the range.
    editManifest(dir, manifest => {
      for (const [asset, month, empty] of [['LINK', '2020-01', 1], ['BTC', '2025-09', 140], ['BTC', '2020-01', 2], ['LINK', '2021-12', 7]])
        Object.assign(manifest.assets[asset].months[month], {emptyResponses: empty, lastBucketPresent: false});
      manifest.assets.LINK.months['2021-12'].complete = false;
      for (const month of ['2024-01', '2024-02']) Object.assign(manifest.assets.LINK.months[month], {emptyResponses: 0, lastBucketPresent: true});
      delete manifest.assets.LINK.months['2024-03'].emptyResponses; delete manifest.assets.LINK.months['2024-03'].lastBucketPresent;
    });
    writeStore(dir, 'BTC', '2025-10', [], {emptyResponses: 150, lastBucketPresent: false});
    const result = storeCompleteness(dir);
    assert.deepEqual(result.emptyResponseMonths, [{asset: 'BTC', month: '2020-01', emptyResponses: 2}, {asset: 'BTC', month: '2022-02', emptyResponses: 3},
      {asset: 'BTC', month: '2025-09', emptyResponses: 140}, {asset: 'LINK', month: '2020-01', emptyResponses: 1}]);
    assert.deepEqual(result.lastBucketMissingMonths, [{asset: 'BTC', month: '2020-01'}, {asset: 'BTC', month: '2025-09'}, {asset: 'LINK', month: '2020-01'}, {asset: 'LINK', month: '2023-07'}]);
    assert.deepEqual(result.rowsByMonth, {BTC: whole.rowsByMonth.BTC, LINK: {...whole.rowsByMonth.LINK, '2021-12': 0}});
    assert.deepEqual(said(result), [`LINK 2021-12: not marked complete${refetch('LINK', '2021-12')}`, `BTC 2025-10: ${outsideRange('BTC', '2025-10')}`]);
    restore(saved);
    assert.deepEqual(storeCompleteness(dir), whole);
  });

  await t.test('months the fetcher stored: whole months pass, a month fetched for part of its days does not', async () => {
    const fetched = tmp(t);
    const run = to => fetchCandles({from: '2025-08-01', to, dir: fetched, baseUrl: 'http://127.0.0.1:9', pauseMs: 0, log: quiet, fetchImpl: stubExchange()});
    const about = month => storeCompleteness(fetched).problems.filter(problem => problem.month === month).map(problem => [problem.asset, problem.problem]);
    // To 2025-09-29: September lacks its last day, the day whose 23:59 bucket is the last one of the exploration range.
    await run('2025-09-29');
    assert.deepEqual(about('2025-08'), []);
    const short = asset => 'stored for 2025-09-01T00:00:00.000Z to 2025-09-29T00:00:00.000Z, which is not exactly the whole month 2025-09-01T00:00:00.000Z to ' +
      `2025-09-30T00:00:00.000Z${refetch(asset, '2025-09')}`;
    assert.deepEqual(about('2025-09'), [['BTC', short('BTC')], ['LINK', short('LINK')]]);
    // To 2025-09-30, the furthest the fetcher goes: September is whole. The other 67 months are still missing.
    const summary = await run('2025-09-30');
    assert.deepEqual([summary.assets.BTC.fetched, summary.assets.BTC.skipped], [1, 1]);
    assert.deepEqual(about('2025-09'), []);
    const result = storeCompleteness(fetched);
    assert.deepEqual([result.complete, result.source, result.sourceIsExchange, result.usable, result.problems.length], [false, LOOPBACK_SOURCE, false, false, 2 * 67]);
    assert.ok(result.problems.every(problem => problem.problem === `missing: the manifest has no entry for this month${RUN_AGAIN}` && problem.month < '2025-08'));
    assert.equal(readManifestFile(fetched).assets.BTC.months['2025-09'].lastClose, RESERVED_FROM);
    assert.deepEqual(receiptsSummary(fetched).BTC, {files: 2, receipts: 150 + 140, sha256: Object.fromEntries(['2025-08', '2025-09'].map(month =>
      [month, sha(fs.readFileSync(receiptsFile(fetched, 'BTC', month)))]))});
    // The rows it reports are the rows the loader reads, month by month; a month without an entry has none.
    for (const asset of ASSETS) {
      assert.deepEqual(Object.entries(result.rowsByMonth[asset]).filter(([, rows]) => rows > 0), [['2025-08', expectedRows(asset, utc('2025-08-01'), utc('2025-09-01')).length],
        ['2025-09', expectedRows(asset, utc('2025-09-01'), RESERVED_FROM).length]]);
      assert.equal(Object.values(result.rowsByMonth[asset]).reduce((sum, rows) => sum + rows, 0), loadSeries(fetched, asset).time.length);
    }
    assert.deepEqual([result.emptyResponseMonths, result.lastBucketMissingMonths], [[], []]);
  });
});

// What the bound receipts say. Every store below agrees with its manifest hash for hash, so the loader loads it:
// nothing but reading the receipts can tell these months from fetched ones. That raises the cost of an accident or of
// a hand edit; it proves nothing about where a file came from, and the last case of each kind says what passes.
test('storeCompleteness reads each month\'s bound receipts and holds them against the label and the manifest entry', async t => {
  const MONTH = '2021-06', [FROM, TO] = wholeMonth(MONTH), rows = monthRows(MONTH), chunks = chunksOf(FROM, TO), EXCHANGE = 'https://api.exchange.coinbase.com';
  const goodFor = (month, options) => receiptsFor('BTC', ...wholeMonth(month), monthRows(month), options), good = options => goodFor(MONTH, options);
  assert.deepEqual([iso(FROM), iso(TO), chunks.length, rows.length, good().reduce((sum, receipt) => sum + receipt.rowCount, 0)],
    ['2021-06-01T00:00:00.000Z', '2021-07-01T00:00:00.000Z', 145, 146, 290]);
  // A store that holds one month of BTC (June 2021 unless said): written as a fetch of it would leave it, then given
  // `receipts` by a hand edit that binds them (rebindReceipts). Returns what storeCompleteness says about the month,
  // [] for nothing. Each problem must end saying that fetching the month again repairs it; that end is checked and
  // cut off here, and the rest returned.
  const said = ({month = MONTH, source = SOURCE, receipts = goodFor(month), stored = monthRows(month), overrides = {}} = {}) => {
    const dir = tmp(t);
    writeWholeMonth(dir, 'BTC', month, {source, rows: stored, receipts: goodFor(month), overrides});
    rebindReceipts(dir, 'BTC', month, receiptsText(receipts));
    assert.equal(loadSeries(dir, 'BTC').time.length, stored.length);        // the loader has no objection
    const result = storeCompleteness(dir), mine = result.problems.filter(problem => problem.asset === 'BTC' && problem.month === month);
    // The other 137 asset-months are missing, and at most one thing is said about this one.
    assert.deepEqual([result.complete, result.usable, result.problems.length - mine.length, mine.length <= 1], [false, false, 137, true]);
    return mine.map(({problem}) => {
      assert.ok(problem.endsWith(refetch('BTC', month)), problem);
      return problem.slice(0, -refetch('BTC', month).length);
    });
  };
  const change = (n, edit) => good().map((receipt, i) => (i === n - 1 ? edit(receipt) : receipt));     // receipt n, counted from 1
  const url = (start, end, {origin = COINBASE_URL, asset = 'BTC'} = {}) => requestUrl(origin, asset, start, end);
  const asks = (n, start, end) => change(n, receipt => ({...receipt, url: url(start, end)}));
  const line = n => `line ${n} of the receipts file is not a JSON receipt`;
  const notRequest = n => `receipt ${n} does not name a one-minute candle request for BTC-USD`;
  const names = (n, origin, label) => `receipt ${n} names ${origin}, and this store is labelled as fetched from ${label}`;
  const outside = (n, start, end) => `receipt ${n} asks for the buckets ${iso(start)} to ${iso(end)}, which are not all inside the stored range 2021-06-01T00:00:00.000Z to 2021-07-01T00:00:00.000Z`;
  // Receipt n of June: no date later than the close of its last bucket, or received no later than that close.
  const noDate = n => `receipt ${n} carries no HTTP date in a format RFC 9110 allows that is later than ${iso(chunks[n - 1][1] + MINUTE)}, ` +
    'the close of the last bucket it asks for, and this store is labelled as fetched from the exchange';
  const early = (n, at) => `receipt ${n} was received at ${iso(at)}, not later than ${iso(chunks[n - 1][1] + MINUTE)}, the close of the last bucket it asks for, ` +
    'and this store is labelled as fetched from the exchange';
  const bounds = (n, start, end) => `receipt ${n} asks for the buckets ${iso(start)} to ${iso(end)}, which are not all inside the exploration range ` +
    '2020-01-01T00:00:00.000Z to 2025-09-30T00:00:00.000Z';
  const tooMany = (n, start, end) => `receipt ${n} asks for the buckets ${iso(start)} to ${iso(end)}, ${(end - start) / MINUTE + 1} of them, and a request of the fetcher asks for at most 300`;
  const count = n => `holds ${n} receipts, and a fetch of the stored range 2021-06-01T00:00:00.000Z to 2021-07-01T00:00:00.000Z makes 145 requests`;
  const gap = start => `the receipts' requests do not cover the stored range: none asks for the bucket starting ${iso(start)}`;
  const fewer = (counted, stored = 146, twice = 144) => `the receipts count ${counted} rows, fewer than the ${stored} stored rows plus ${twice} returned twice`;

  await t.test('receipts as a fetch leaves them say nothing; nor does their order, a body with rows the fetcher ignored, or a field more', () => {
    assert.deepEqual(said(), []);
    assert.deepEqual(said({receipts: good().reverse()}), []);
    assert.deepEqual(said({receipts: change(3, receipt => ({...receipt, rowCount: receipt.rowCount + 7}))}), []);
    assert.deepEqual(said({receipts: change(3, receipt => ({...receipt, note: 'one more field'}))}), []);
  });

  await t.test('a line that is not a JSON receipt', () => {
    assert.deepEqual(said({receipts: ['not a receipt']}), [line(1)]);       // the file a verifier bound: one line of text, re-hashed
    for (const text of ['not a receipt', '{"url":', '[]', 'null', '7', '"text"', '{}'])
      assert.deepEqual(said({receipts: change(3, () => text)}), [line(3)], text);
    for (const key of ['url', 'receivedAt', 'sha256', 'rowCount', 'attempts'])
      assert.deepEqual(said({receipts: change(5, ({[key]: left, ...rest}) => rest)}), [line(5)], `without ${key}`);
    for (const [key, value] of [['url', 5], ['url', null], ['url', ['https://api.exchange.coinbase.com']], ['receivedAt', '0'], ['receivedAt', 1.5], ['httpDate', 5],
      ['httpDate', [HTTP_DATE]], ['sha256', 'abc'], ['sha256', sha('x').toUpperCase()], ['sha256', `${sha('x')}0`], ['sha256', [sha('x')]], ['sha256', null],
      ['rowCount', -1], ['rowCount', 1.5], ['rowCount', '2'], ['rowCount', null], ['attempts', 0], ['attempts', 1.5], ['attempts', '1']])
      assert.deepEqual(said({receipts: change(145, receipt => ({...receipt, [key]: value}))}), [line(145)], `${key}: ${value}`);
  });

  await t.test('a URL that is not a one-minute candle request for this asset', () => {
    const [start, end] = chunks[0], right = url(start, end);
    assert.equal(right, 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2021-06-01T00%3A00%3A00.000Z&end=2021-06-01T04%3A59%3A00.000Z');
    for (const wrong of ['synthetic:BTC:2021-06', 'synthetic://verifier/BTC/2020-01/0', '', 'not a url', '/products/BTC-USD/candles?granularity=60',
      url(start, end, {asset: 'LINK'}), right.replace('/candles?', '/ticker?'), right.replace('/candles?', '/candles/?'), right.replace('BTC-USD', 'BTC-EUR'),
      right.replace('/products/', '/v2/products/'), right.replace('granularity=60', 'granularity=3600'), right.replace('granularity=60&', ''), right.replace(/&end=.*/, ''),
      right.replace(/start=[^&]*/, 'start=2021-06-01'), right.replace(/start=[^&]*/, `start=${start}`), url(start + 30000, end), url(start, end + 1),
      right.replace('https://', 'ftp://')])
      assert.deepEqual(said({receipts: change(1, receipt => ({...receipt, url: wrong}))}), [notRequest(1)], wrong);
    // The receipts of the other asset's month, as a swap of two months' receipts and bindings leaves them.
    assert.deepEqual(said({receipts: receiptsFor('LINK', FROM, TO, rows)}), [notRequest(1)]);
    assert.deepEqual(said({receipts: change(77, receipt => ({...receipt, url: url(...chunks[76], {asset: 'LINK'})}))}), [notRequest(77)]);
    // Whatever the store is labelled (here its other receipts name an origin that suits each label).
    for (const source of [LOOPBACK_SOURCE, 'written by hand in a test'])
      assert.deepEqual(said({source, receipts: good({origin: 'http://127.0.0.1:9'}).map((receipt, i) => (i === 1 ? {...receipt, url: 'synthetic'} : receipt))}), [notRequest(2)], source);
  });

  await t.test('an origin that is not the one the label names', () => {
    // Labelled as fetched from the exchange: every receipt must name its origin, exactly.
    for (const origin of ['http://127.0.0.1:9', 'http://localhost:8080', 'https://api.exchange.coinbase.com.example.com', 'http://api.exchange.coinbase.com',
      'https://api.exchange.coinbase.com:8443', 'https://api.pro.coinbase.com', 'https://example.com'])
      assert.deepEqual(said({receipts: good({origin})}), [names(1, origin, EXCHANGE)], origin);
    assert.deepEqual(said({receipts: change(99, receipt => ({...receipt, url: url(...chunks[98], {origin: 'http://127.0.0.1:9'})}))}), [names(99, 'http://127.0.0.1:9', EXCHANGE)]);
    // Labelled as a loopback test store: a loopback origin, the fetcher's rule for one (http, 127.0.0.1 or localhost).
    for (const origin of ['http://127.0.0.1:9', 'http://localhost:8080', 'http://127.0.0.1'])
      assert.deepEqual(said({source: LOOPBACK_SOURCE, receipts: good({origin})}), [], origin);
    for (const origin of [EXCHANGE, 'https://127.0.0.1:9', 'http://127.0.0.2:9', 'http://localhost.example.com', 'http://example.com'])
      assert.deepEqual(said({source: LOOPBACK_SOURCE, receipts: good({origin})}), [names(1, origin, 'a loopback test server')], origin);
    // Any other label names no origin, so none is asked for. Such a store is not usable whatever its receipts say.
    for (const origin of [EXCHANGE, 'http://127.0.0.1:9', 'https://example.com'])
      assert.deepEqual(said({source: 'written by hand in a test', receipts: good({origin})}), [], origin);
  });

  await t.test('a request that reaches outside the range the entry says was stored', () => {
    assert.deepEqual(said({receipts: asks(1, FROM - MINUTE, chunks[0][1])}), [outside(1, FROM - MINUTE, chunks[0][1])]);          // starts one bucket early
    assert.deepEqual(said({receipts: asks(145, chunks[144][0], TO)}), [outside(145, chunks[144][0], TO)]);                       // ends at the first bucket of July
    assert.deepEqual(said({receipts: asks(9, chunks[8][1], chunks[8][0])}), [outside(9, chunks[8][1], chunks[8][0])]);           // ends before it starts
    const july = utc('2024-07-01');
    assert.deepEqual(said({receipts: asks(3, july, july + 299 * MINUTE)}), [outside(3, july, july + 299 * MINUTE)]);             // another month's request
    // The first and the last bucket of the range are inside it: the receipts of a fetch ask for both.
    assert.deepEqual([new URL(good()[0].url).searchParams.get('start'), new URL(good()[144].url).searchParams.get('end')], ['2021-06-01T00:00:00.000Z', '2021-06-30T23:59:00.000Z']);
  });

  // Amendment 2 round, finding 0: a request was held to the entry's own range only, so receipts asking for reserved
  // buckets, or for a whole month at once, passed when the entry's range was edited along with them. Now the range
  // must be the month (the other test), and each request must pass the hard guard's own bucketAllowed at both ends
  // and ask for at most the fetcher's 300 buckets.
  await t.test('a request for a bucket outside the exploration range, or for more than 300 buckets', () => {
    const [september, january] = [chunksOf(...wholeMonth('2025-09')), chunksOf(...wholeMonth('2020-01'))];
    const asksIn = (month, n, start, end) => goodFor(month).map((receipt, i) => (i === n - 1 ? {...receipt, url: url(start, end)} : receipt));
    // The last request of the range rewritten to end at the first reserved bucket, as replay.js's chunking would ask.
    assert.deepEqual(said({month: '2025-09', receipts: asksIn('2025-09', 140, september[139][0], RESERVED_FROM)}), [bounds(140, september[139][0], RESERVED_FROM)]);
    // A request for the reserved day; one for the minute before the range.
    assert.deepEqual(said({month: '2025-09', receipts: asksIn('2025-09', 7, RESERVED_FROM, RESERVED_FROM + 299 * MINUTE)}),
      [bounds(7, RESERVED_FROM, RESERVED_FROM + 299 * MINUTE)]);
    assert.deepEqual(said({month: '2020-01', receipts: asksIn('2020-01', 1, EXPLORATION_FROM - MINUTE, january[0][1])}), [bounds(1, EXPLORATION_FROM - MINUTE, january[0][1])]);
    // With the entry's range edited to match the receipts, the range is named first: no fetch stores it.
    assert.deepEqual(said({month: '2025-09', receipts: asksIn('2025-09', 140, september[139][0], RESERVED_FROM), overrides: {to: '2025-09-30T00:01:00.000Z'}}),
      ['stored for 2025-09-01T00:00:00.000Z to 2025-09-30T00:01:00.000Z, which is not exactly the whole month 2025-09-01T00:00:00.000Z to 2025-09-30T00:00:00.000Z']);
    // 301 buckets in one request; every request asking for the whole month at once; 300 buckets pass (every receipt of a fetch).
    assert.deepEqual(said({receipts: asks(1, FROM, FROM + 300 * MINUTE)}), [tooMany(1, FROM, FROM + 300 * MINUTE)]);
    assert.deepEqual(said({receipts: good().map(receipt => ({...receipt, url: url(FROM, TO - MINUTE)}))}), [tooMany(1, FROM, TO - MINUTE)]);
    assert.ok(good().slice(0, -1).every(receipt => { const target = new URL(receipt.url).searchParams; return Date.parse(target.get('end')) - Date.parse(target.get('start')) === 299 * MINUTE; }));
  });

  // Amendment 2 round, findings 1 and 3: dated means an HTTP date in a format RFC 9110 allows, found by pattern so
  // that two joined Date lines count, later than the close of the last bucket asked for, and received after it too.
  await t.test('a receipt that is not dated, in a store labelled as fetched from the exchange', () => {
    assert.deepEqual(said({receipts: good({httpDate: null})}), [noDate(1)]);                // what a stub that sets no Date header leaves
    const close = chunks[30][1] + MINUTE;                   // receipt 31's: 2021-06-07T10:30Z, a Monday
    assert.equal(iso(close), '2021-06-07T10:30:00.000Z');
    for (const httpDate of [null, '', 'synthetic', 'no date at all',
      // Texts V8's Date.parse reads, which RFC 9110 does not allow: they passed before.
      'stub 1', 'none 1', '0', '2026-11-19T07:57:37Z', 'Thu, 19 Nov 2026 07:57:37 UTC', 'Thursday, 19 Nov 2026 07:57:37 GMT', 'Thu, 19 Nov 26 07:57:37 GMT',
      'Thu,19 Nov 2026 07:57:37 GMT',
      // Names in another case: RFC 9110 writes them case-sensitive.
      'thu, 19 nov 2026 07:57:37 gmt', 'thu, 19 Nov 2026 07:57:37 GMT', 'Thu, 19 Nov 2026 07:57:37 gmt', 'Thu, 19 NOV 2026 07:57:37 GMT', 'thursday, 19-Nov-26 07:57:37 GMT',
      'thu Nov 19 07:57:37 2026',
      // Days not on the calendar (one rolling into the next month, one into the next year, day 00), and times no clock shows.
      'Mon, 31 Feb 2026 07:57:37 GMT', 'Thu, 32 Dec 2026 07:57:37 GMT', 'Thu, 00 Nov 2026 07:57:37 GMT', 'Thu, 19 Nov 2026 24:00:00 GMT',
      'Thu, 19 Nov 2026 07:60:00 GMT', 'Thu, 19 Nov 2026 07:57:61 GMT',
      // Dates in a right form that are not later than the close: decades early, a second early, the close itself.
      'Thu, 01 Jan 1970 00:00:00 GMT', 'Mon, 07 Jun 2021 10:29:59 GMT', 'Mon, 07 Jun 2021 10:30:00 GMT', 'Monday, 07-Jun-21 10:30:00 GMT', 'Mon Jun  7 10:30:00 2021'])
      assert.deepEqual(said({receipts: change(31, receipt => ({...receipt, httpDate}))}), [noDate(31)], String(httpDate));
    assert.deepEqual(said({receipts: change(31, ({httpDate, ...rest}) => rest)}), [noDate(31)]);         // the field left out
    // Received no later than the close: a fixture's 0, before 1970, the close itself.
    for (const receivedAt of [0, -1, close - 1, close])
      assert.deepEqual(said({receipts: change(31, receipt => ({...receipt, receivedAt}))}), [early(31, receivedAt)], String(receivedAt));
    assert.deepEqual(said({receipts: change(31, receipt => ({...receipt, receivedAt: 0, httpDate: null}))}), [noDate(31)]);    // the date is named first
    // Dated: the IMF-fixdate a server sends; two Date lines, which fetch joins with ", " (an early one beside a later
    // one is enough); the two obsolete forms, an RFC 850 two-digit year read against the receive time; a leap
    // second; one second after the close, received a millisecond after it. The day name is not checked against the
    // date (RFC 9110 does not ask a recipient to).
    for (const [httpDate, receivedAt] of [[HTTP_DATE, RECEIVED_AT], [`${HTTP_DATE}, ${HTTP_DATE}`, RECEIVED_AT], [`Thu, 01 Jan 1970 00:00:00 GMT, ${HTTP_DATE}`, RECEIVED_AT],
      ['Thursday, 19-Nov-26 07:57:37 GMT', RECEIVED_AT], ['Thu Nov 19 07:57:37 2026', RECEIVED_AT], ['Wed Nov  4 07:57:37 2026', RECEIVED_AT],
      ['Wed, 31 Dec 2025 23:59:60 GMT', RECEIVED_AT], ['Mon, 07 Jun 2021 10:30:01 GMT', close + 1], ['Fri, 19 Nov 2026 07:57:37 GMT', RECEIVED_AT],
      [`date: ${HTTP_DATE}`, RECEIVED_AT]])
      assert.deepEqual(said({receipts: change(31, receipt => ({...receipt, httpDate, receivedAt}))}), [], httpDate);
    // An RFC 850 year is the latest with its two digits at most 50 years after the receive year: 76 is 2076 when
    // received in 2026, 77 is 1977.
    assert.deepEqual([httpDates('Monday, 01-Jan-76 00:00:00 GMT', RECEIVED_AT), httpDates('Saturday, 01-Jan-77 00:00:00 GMT', RECEIVED_AT),
      httpDates('Monday, 01-Jan-76 00:00:00 GMT', NaN)], [[Date.parse('2076-01-01T00:00:00Z')], [Date.parse('1977-01-01T00:00:00Z')], []]);
    assert.deepEqual(httpDates(`${HTTP_DATE}, Thursday, 19-Nov-26 07:57:37 GMT, Thu Nov 19 07:57:37 2026`, RECEIVED_AT), Array(3).fill(RECEIVED_AT));
    assert.deepEqual([httpDates(null, RECEIVED_AT), httpDates(7, RECEIVED_AT), httpDates(['x'], RECEIVED_AT)], [[], [], []]);
    assert.deepEqual([receiptDated(null, 0), receiptDated({receivedAt: RECEIVED_AT, httpDate: HTTP_DATE}, RECEIVED_AT - 61000),
      receiptDated({receivedAt: RECEIVED_AT, httpDate: HTTP_DATE}, RECEIVED_AT - 60000)], [false, true, false]);
    // The two-digit year is read against the receipt's own receive time, never the clock of the check, so a verdict
    // does not change with the day it is made (data4 finding 1): received in 2021, 72 is 1972, not dated today or in
    // any later year; 21 is 2021.
    const in2021 = Date.parse('2021-06-07T11:00:00Z');
    assert.deepEqual([receiptDated({receivedAt: in2021, httpDate: 'Tuesday, 07-Jun-72 11:00:00 GMT'}, close - MINUTE),
      receiptDated({receivedAt: in2021, httpDate: 'Monday, 07-Jun-21 10:45:00 GMT'}, close - MINUTE)], [false, true]);
    // A four-digit year below 100 is no date: Date.UTC would read it as 19xx, which the check refuses to do.
    assert.deepEqual([httpDates('Sat, 01 Jan 0050 00:00:00 GMT', RECEIVED_AT), httpDates('Sat Jan  1 00:00:00 0050', RECEIVED_AT),
      httpDates('Fri, 01 Jan 0100 00:00:00 GMT', RECEIVED_AT)], [[], [], [Date.UTC(100, 0, 1)]]);
    // No other store is asked for one.
    for (const source of [LOOPBACK_SOURCE, 'written by hand in a test'])
      assert.deepEqual(said({source, receipts: good({origin: 'http://127.0.0.1:9', httpDate: null}).map(receipt => ({...receipt, receivedAt: 0}))}), [], source);
  });

  await t.test('not as many receipts as a fetch of the stored range makes requests', () => {
    assert.deepEqual(said({receipts: good().slice(0, -1)}), [count(144)]);
    assert.deepEqual(said({receipts: good().slice(1)}), [count(144)]);
    assert.deepEqual(said({receipts: [...good(), good()[7]]}), [count(146)]);
    assert.deepEqual(said({receipts: []}), [count(0)]);
    // The receipts of a fetch of ten days, under an entry edited to say the whole month (a verifier's edit).
    assert.deepEqual(said({receipts: receiptsFor('BTC', utc('2021-06-10'), utc('2021-06-20'), rows)}), [count(49)]);
  });

  await t.test('as many receipts as requests, and a bucket of the stored range that none of them asks for', () => {
    const copy = (n, of) => change(n, () => good()[of - 1]);                // receipt n replaced by a copy of receipt `of`
    assert.deepEqual(said({receipts: copy(5, 4)}), [gap(chunks[4][0] + MINUTE)]);           // request 4 still asks for request 5's first bucket, which they share
    assert.deepEqual(said({receipts: copy(1, 2)}), [gap(FROM)]);
    assert.deepEqual(said({receipts: copy(145, 1)}), [gap(chunks[144][0] + MINUTE)]);
    assert.deepEqual(said({receipts: asks(3, chunks[2][0], chunks[2][0])}), [gap(chunks[2][0] + MINUTE)]);                // a request for one bucket
    assert.deepEqual(said({receipts: asks(3, chunks[2][0], chunks[2][1] - 2 * MINUTE)}), [gap(chunks[2][1] - MINUTE)]);    // two buckets short
    assert.deepEqual(said({receipts: asks(145, chunks[144][0], TO - 2 * MINUTE)}), [gap(TO - MINUTE)]);                   // the last bucket of the month
    // One bucket short is still covered: the next request asks for that bucket too. That is what sharing one is for.
    assert.deepEqual(said({receipts: asks(3, chunks[2][0], chunks[2][1] - MINUTE)}), []);
    // A request that lies inside a longer one asks for nothing new, and the walk keeps the longer one's end (finding
    // 8: no test failed when it took the shorter one's). 144 requests of 300 buckets tile June exactly and do not
    // share a bucket; the 145th asks for 11 buckets inside the first. No fetch asks this, and nothing is missing.
    const tiles = Array.from({length: 144}, (_, k) => ({...good()[k], url: url(FROM + 300 * k * MINUTE, FROM + (300 * k + 299) * MINUTE)}));
    assert.equal(Date.parse(new URL(tiles.at(-1).url).searchParams.get('end')), TO - MINUTE);
    assert.deepEqual(said({receipts: [tiles[0], {...good()[144], url: url(FROM + 10 * MINUTE, FROM + 20 * MINUTE)}, ...tiles.slice(1)]}), []);
    // The same with the 145th inside the last tile, and a tile cut short by one bucket: that bucket is missing.
    assert.deepEqual(said({receipts: [...tiles.slice(0, -1), {...tiles.at(-1), url: url(TO - 300 * MINUTE, TO - 2 * MINUTE)}, {...good()[144], url: url(TO - 250 * MINUTE, TO - 240 * MINUTE)}]}),
      [gap(TO - MINUTE)]);
  });

  // dataset.mjs says it above the check: rows added by hand are noticed only up to the entry's own duplicateRows,
  // rows removed by hand are not noticed, and these checks guard against accidents, not edits. Each case below adds
  // or removes rows in the candle file and rewrites the entry's rows and SHA-256 to match; no receipt is touched.
  await t.test('receipts that count fewer rows than the month stores; rows added by hand pass up to the entry\'s duplicateRows, rows removed pass', () => {
    assert.deepEqual(said({receipts: change(10, receipt => ({...receipt, rowCount: receipt.rowCount - 1}))}), [fewer(289)]);
    assert.deepEqual(said({receipts: good().map(receipt => ({...receipt, rowCount: 0}))}), [fewer(0)]);
    // `n` minutes filled in by hand after the month's first row: 146 + n rows; the receipts count 290.
    const filled = n => [rows[0], ...Array.from({length: n}, (_, i) => handRow(FROM + (i + 1) * MINUTE, 99)), ...rows.slice(1)];
    // One row added, duplicateRows left at 144: noticed.
    assert.deepEqual(said({stored: filled(1), overrides: {duplicateRows: 144}}), [fewer(290, 147)]);
    // Not noticed (finding 2): the same row with duplicateRows lowered by one in the same edit; as many rows as
    // duplicateRows said, with the field removed. One row more than that is noticed.
    assert.deepEqual(said({stored: filled(1), overrides: {duplicateRows: 143}}), []);
    assert.deepEqual(said({stored: filled(144), overrides: {duplicateRows: undefined}}), []);
    assert.deepEqual(said({stored: filled(145), overrides: {duplicateRows: undefined}}), [fewer(290, 291, 0)]);
    // Not noticed either: rows removed by hand, as a verifier cut a month to its first half. The receipts then count
    // more rows than are stored, as they may.
    assert.deepEqual(said({stored: rows.slice(0, 73), overrides: {duplicateRows: 72}}), []);
    // An entry that does not say how many rows came back twice is held to its stored rows alone.
    assert.deepEqual(said({overrides: {duplicateRows: undefined}}), []);
    assert.deepEqual(said({overrides: {duplicateRows: undefined}, receipts: change(1, receipt => ({...receipt, rowCount: 0})).map(receipt => ({...receipt, rowCount: Math.min(receipt.rowCount, 1)}))}),
      [fewer(144, 146, 0)]);
  });

  await t.test('a month that holds no row, whatever its receipts say', () => {
    assert.deepEqual(said({stored: [], receipts: good().map(receipt => ({...receipt, rowCount: 0}))}), ['holds no row']);   // every answer empty: what the fetcher stores then
    assert.deepEqual(said({stored: []}), ['holds no row']);
    assert.deepEqual(said({stored: [], source: LOOPBACK_SOURCE, receipts: ['not a receipt']}), ['holds no row']);
  });

  await t.test('one problem a month: the first receipt that disagrees, by the first check it fails, and the whole file after every receipt', () => {
    // A stub's store from a loopback base, relabelled as the exchange's: the origin, before the date its receipts lack.
    assert.deepEqual(said({receipts: good({origin: 'http://127.0.0.1:9', httpDate: null})}), [names(1, 'http://127.0.0.1:9', EXCHANGE)]);
    // Receipt 1 names another origin and line 2 is not a receipt: receipt 1 comes first.
    assert.deepEqual(said({receipts: [{...good()[0], url: url(...chunks[0], {origin: 'https://example.com'})}, 'not a receipt', ...good().slice(2)]}), [names(1, 'https://example.com', EXCHANGE)]);
    // A receipt without a date among too few receipts that count too few rows: the receipt comes first, then the number.
    const short = change(4, receipt => ({...receipt, httpDate: null})).slice(0, 100).map(receipt => ({...receipt, rowCount: 0}));
    assert.deepEqual(said({receipts: short}), [noDate(4)]);
    assert.deepEqual(said({receipts: short.map(receipt => ({...receipt, httpDate: HTTP_DATE}))}), [count(100)]);
    // Enough receipts, a bucket nobody asks for, and too few rows counted: the bucket comes before the rows.
    assert.deepEqual(said({receipts: change(5, () => good()[3]).map(receipt => ({...receipt, rowCount: 0}))}), [gap(chunks[4][0] + MINUTE)]);
  });
});

// The reproduction of the verifier who found that the receipts were never read, step by step, on a store the fetcher
// wrote: 20,300 requests answered by a stub, nothing connected to.
test('a whole store the fetcher wrote is complete as it is, and a hand edit of its manifest is contradicted by its receipts', async t => {
  const dir = tmp(t), months = explorationMonths();
  // One row an answer, the request's first bucket.
  const oneRow = async url => new Response(JSON.stringify([[Date.parse(new URL(url).searchParams.get('start')) / 1000, 1, 4, 2, 3, 5]]));
  const run = extra => fetchCandles({dir, baseUrl: 'http://127.0.0.1:9', pauseMs: 0, fetchImpl: oneRow, log: quiet, ...extra});
  const verdict = () => { const result = storeCompleteness(dir); return [result.complete, result.sourceIsExchange, result.usable, result.problems.map(problem => `${problem.asset} ${problem.month}: ${problem.problem}`)]; };
  const swap = (a, b, keys) => { for (const key of keys) [a[key], b[key]] = [b[key], a[key]]; };
  const swapFiles = (a, b) => { const [x, y] = [fs.readFileSync(a), fs.readFileSync(b)]; fs.writeFileSync(a, y); fs.writeFileSync(b, x); };
  const loopback = 'receipt 1 names http://127.0.0.1:9, and this store is labelled as fetched from https://api.exchange.coinbase.com';

  // 1. As fetched: every month present, whole, with rows, and receipts that agree. A loopback store: complete, not usable.
  assert.equal((await run({})).requests, 20300);
  const fetched = storeCompleteness(dir);
  assert.deepEqual(fetched, {complete: true, source: LOOPBACK_SOURCE, sourceIsExchange: false, usable: false, problems: [], emptyResponseMonths: [],
    // This stub never answers with a month's last bucket, and the fetcher noted that for every month.
    lastBucketMissingMonths: ASSETS.flatMap(asset => months.map(month => ({asset, month}))),
    rowsByMonth: Object.fromEntries(ASSETS.map(asset => [asset, Object.fromEntries(months.map(month => [month, chunksOf(...wholeMonth(month)).length]))]))});
  assert.equal((await run({})).requests, 0);              // and the fetcher keeps every month of it

  // 2. One month fetched again for ten of its days only.
  fs.rmSync(candleFile(dir, 'LINK', '2021-06'));
  await run({from: '2021-06-10', to: '2021-06-20', assets: ['LINK']});
  assert.deepEqual(verdict(), [false, false, false, ['LINK 2021-06: stored for 2021-06-10T00:00:00.000Z to 2021-06-20T00:00:00.000Z, which is not exactly the whole month ' +
    `2021-06-01T00:00:00.000Z to 2021-07-01T00:00:00.000Z${refetch('LINK', '2021-06')}`]]);
  // 3. Its entry edited to say the whole month: the 49 bound receipts are not the 145 of a whole June.
  editManifest(dir, manifest => Object.assign(manifest.assets.LINK.months['2021-06'], {from: '2021-06-01T00:00:00.000Z', to: '2021-07-01T00:00:00.000Z'}));
  assert.equal(loadSeries(dir, 'LINK').time.length, 10150 - 145 + 49);      // the loader has no objection to it
  assert.deepEqual(verdict(), [false, false, false, ['LINK 2021-06: holds 49 receipts, and a fetch of the stored range 2021-06-01T00:00:00.000Z to ' +
    `2021-07-01T00:00:00.000Z makes 145 requests${refetch('LINK', '2021-06')}`]]);
  fs.rmSync(candleFile(dir, 'LINK', '2021-06'));
  assert.equal((await run({assets: ['LINK']})).requests, 145);              // repaired, as the text says: that month, whole
  assert.deepEqual(storeCompleteness(dir), fetched);

  // 4. The source label edited to the exchange's: every receipt of the store names 127.0.0.1.
  editManifest(dir, manifest => { manifest.source = SOURCE; });
  assert.deepEqual(verdict(), [false, true, false, ASSETS.flatMap(asset => months.map(month => `${asset} ${month}: ${loopback}${refetch(asset, month)}`))]);
  editManifest(dir, manifest => { manifest.source = LOOPBACK_SOURCE; });
  assert.deepEqual(storeCompleteness(dir), fetched);

  // 5. The receipts files of two months swapped: the loader's hash check sees it.
  const unbound = 'does not verify against the manifest: receipts file SHA-256 disagrees with the manifest';
  swapFiles(receiptsFile(dir, 'BTC', '2021-03'), receiptsFile(dir, 'LINK', '2024-07'));
  assert.deepEqual(verdict(), [false, false, false, [`BTC 2021-03: ${unbound}${refetch('BTC', '2021-03')}`, `LINK 2024-07: ${unbound}${refetch('LINK', '2024-07')}`]]);
  // 6. ...and their bindings swapped as well: the loader loads both months, and the receipts name the wrong asset.
  editManifest(dir, manifest => swap(manifest.assets.BTC.months['2021-03'], manifest.assets.LINK.months['2024-07'], ['receipts', 'receiptsSha256', 'requests']));
  assert.deepEqual([loadSeries(dir, 'BTC').time.length, loadSeries(dir, 'LINK').time.length], [10150, 10150]);
  assert.deepEqual(verdict(), [false, false, false, [`BTC 2021-03: receipt 1 does not name a one-minute candle request for BTC-USD${refetch('BTC', '2021-03')}`,
    `LINK 2024-07: receipt 1 does not name a one-minute candle request for LINK-USD${refetch('LINK', '2024-07')}`]]);
  swapFiles(receiptsFile(dir, 'BTC', '2021-03'), receiptsFile(dir, 'LINK', '2024-07'));
  editManifest(dir, manifest => swap(manifest.assets.BTC.months['2021-03'], manifest.assets.LINK.months['2024-07'], ['receipts', 'receiptsSha256', 'requests']));
  assert.deepEqual(storeCompleteness(dir), fetched);

  // 7. The same month of the two assets exchanged whole: candles, receipts and entries. Each file matches its entry.
  swapFiles(candleFile(dir, 'BTC', '2023-05'), candleFile(dir, 'LINK', '2023-05'));
  swapFiles(receiptsFile(dir, 'BTC', '2023-05'), receiptsFile(dir, 'LINK', '2023-05'));
  editManifest(dir, manifest => { [manifest.assets.BTC.months['2023-05'], manifest.assets.LINK.months['2023-05']] = [manifest.assets.LINK.months['2023-05'], manifest.assets.BTC.months['2023-05']]; });
  assert.deepEqual([loadSeries(dir, 'BTC').time.length, loadSeries(dir, 'LINK').time.length], [10150, 10150]);
  assert.deepEqual(verdict(), [false, false, false, [`BTC 2023-05: receipt 1 does not name a one-minute candle request for BTC-USD${refetch('BTC', '2023-05')}`,
    `LINK 2023-05: receipt 1 does not name a one-minute candle request for LINK-USD${refetch('LINK', '2023-05')}`]]);
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
function cli(args, preload, env = {}, {nodeArgs = [], cwd} = {}) {
  return new Promise(resolve => execFile(process.execPath, [...nodeArgs, '--import', `data:text/javascript,${encodeURIComponent(preload)}`, CLI, ...args],
    {env: {PATH: process.env.PATH, ...env}, cwd}, (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr})));
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
  // NODE_EXTRA_CA_CERTS is not (a proxy that re-signs TLS needs its CA bundle there). Each says what else supplies
  // the thing, so it stays true when that is how it is supplied.
  const hint = /^hint: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1; Node's built-in fetch ignores the proxy unless NODE_USE_ENV_PROXY=1 or --use-env-proxy$/m;
  const caHint = new RegExp('^hint: HTTPS_PROXY is set but NODE_EXTRA_CA_CERTS is not; a proxy that re-signs TLS needs its CA bundle there ' +
    '\\(NODE_EXTRA_CA_CERTS=/path/to/ca-bundle\\.pem\\), or every request fails as a network error naming a certificate, ' +
    'unless the CA is supplied another way, for example --use-openssl-ca$', 'm');
  const refused = ['--dir', dir, '--to', '2025-10-01'];
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
  // Supplied through an option of Node itself, on its command line or in NODE_OPTIONS: that hint is left out, and the
  // other one is not. --use-openssl-ca is an option of every Node 22; the other two are tried where this build has them.
  const hintsWith = async (env, nodeArgs = []) => {
    const {code, stderr} = await cli(refused, NO_NETWORK, env, {nodeArgs});
    assert.equal(code, 1, stderr);                        // the run itself is the refused one: nothing is requested
    assert.match(stderr, /reserved range/);
    return [hint.test(stderr), caHint.test(stderr)];
  };
  const options = [['--use-openssl-ca', [true, false]], ['--use-system-ca', [true, false]], ['--use-env-proxy', [false, true]]]
    .filter(([option]) => option === '--use-openssl-ca' || process.allowedNodeEnvironmentFlags.has(option));
  for (const [option, expected] of options) {
    assert.deepEqual(await hintsWith(proxy, [option]), expected, `${option} on the command line`);
    assert.deepEqual(await hintsWith({...proxy, NODE_OPTIONS: option}), expected, `${option} in NODE_OPTIONS`);
    assert.deepEqual(await hintsWith({...proxy, NODE_OPTIONS: `--no-warnings  ${option}`}), expected, `${option} after another option in NODE_OPTIONS`);
    assert.deepEqual(await hintsWith({NODE_OPTIONS: option}), [false, false], `${option} without a proxy`);
  }
  assert.deepEqual(await hintsWith({...proxy, NODE_USE_ENV_PROXY: '1'}, ['--use-openssl-ca']), [false, false]);
  assert.deepEqual(await hintsWith({...proxy, NODE_EXTRA_CA_CERTS: bundle, NODE_OPTIONS: '--no-warnings'}), [true, false]);   // an option that supplies neither
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

// The command line passes no fetch of its own, so it may use the default store: .research-data under the working
// directory. Run in a scratch working directory; the loopback server answers in place of the exchange.
test('command line: without --dir the store is .research-data under the working directory, labelled as the exchange\'s', async t => {
  const server = await startServer(t), cwd = tmp(t), rows = expectedRows('BTC', utc('2025-09-29'), RESERVED_FROM);
  const result = await cli(['--from', '2025-09-29', '--to', '2025-09-30', '--assets', 'BTC', '--pause-ms', '200'], TO_LOOPBACK, {TEST_CANDLE_SERVER: server.baseUrl}, {cwd});
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout), store = path.join(cwd, '.research-data');
  assert.deepEqual([summary.ok, summary.dir, summary.source, summary.requests, summary.assets.BTC.rows], [true, '.research-data', SOURCE, 5, rows.length]);
  assert.deepEqual(fs.readdirSync(cwd), ['.research-data']);
  assert.deepEqual(filesIn(store), ['candles/BTC/2025-09.f64', 'manifest.json', 'receipts/BTC/2025-09.jsonl']);
  assert.deepEqual(readRows(candleFile(store, 'BTC', '2025-09')), rows);
  // Its receipts are what storeCompleteness asks of an exchange store: the exchange's origin, and dated (the Date
  // header node:http sends, an IMF-fixdate of the time of the answer, later than every bucket asked for).
  const receipts = readReceipts(store, 'BTC', '2025-09');
  assert.ok(receipts.every(receipt => receipt.url.startsWith('https://api.exchange.coinbase.com/products/BTC-USD/candles?') &&
    receiptDated(receipt, Date.parse(new URL(receipt.url).searchParams.get('end')))));
  assert.doesNotMatch(result.stderr, /not dated/);
  assert.deepEqual(storeCompleteness(store).problems.filter(problem => problem.asset === 'BTC' && problem.month === '2025-09').map(problem => problem.problem),
    ['stored for 2025-09-29T00:00:00.000Z to 2025-09-30T00:00:00.000Z, which is not exactly the whole month 2025-09-01T00:00:00.000Z to 2025-09-30T00:00:00.000Z' +
      refetch('BTC', '2025-09')]);
});

// The store's label follows the base URL, not what answered: a stub on the default base would be written down as
// exchange data. Each call below runs in a child process whose working directory is a scratch directory, so that a
// default store would appear there, and never in the repository, if the refusal were gone.
test('a caller-supplied fetch never writes into the default store: without a directory of its own the call is refused before any request', async t => {
  const cwd = tmp(t), refusal = 'a caller-supplied fetchImpl must come with a dir of its own, other than the default store .research-data: what a stub answers is never written there; refused';
  const loopback = {baseUrl: 'http://127.0.0.1:9', pauseMs: 0};
  const cases = [
    [{}, refusal],                                        // the default base and no directory: what a verifier's stub did
    [{dir: '.research-data'}, refusal],                   // the default store, named
    [{dir: './.research-data/'}, refusal],
    [{dir: path.join(cwd, '.research-data')}, refusal],
    [loopback, refusal],                                  // whatever the base: the directory is what is protected
    [{...loopback, dir: '.research-data'}, refusal],
    [{to: '2025-10-01'}, 'to 2025-10-01 reaches the reserved range: no bucket starting at or after 2025-09-30T00:00:00.000Z is requested; refused, there is no override'],
    [{...loopback, dir: 'own'}, 'fetched 0 rows into own'],     // a directory of its own: the stub is asked
    [{...loopback, dir: path.join(cwd, 'own', 'second')}, `fetched 0 rows into ${path.join(cwd, 'own', 'second')}`]
  ];
  const script = `
    import {fetchCandles} from ${JSON.stringify(pathToFileURL(CLI).href)};
    const outcomes = [];
    for (const options of JSON.parse(process.env.TEST_CASES)) {
      let calls = 0;
      const stub = async () => { calls++; return new Response('[]'); };
      const outcome = await fetchCandles({from: '2025-09-29', to: '2025-09-30', assets: ['BTC'], log() {}, fetchImpl: stub, ...options})
        .then(summary => 'fetched ' + summary.assets.BTC.rows + ' rows into ' + summary.dir, error => error.message);
      outcomes.push([outcome, calls]);
    }
    console.log(JSON.stringify(outcomes));`;
  const {stdout, stderr} = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', script],
    {cwd, env: {PATH: process.env.PATH, TEST_CASES: JSON.stringify(cases.map(([options]) => options))}}, (error, stdout, stderr) => resolve({stdout, stderr})));
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), cases.map(([, outcome]) => [outcome, outcome.startsWith('fetched') ? 5 : 0]));
  assert.deepEqual(filesIn(cwd), ['own/candles/BTC/2025-09.f64', 'own/manifest.json', 'own/receipts/BTC/2025-09.jsonl',
    'own/second/candles/BTC/2025-09.f64', 'own/second/manifest.json', 'own/second/receipts/BTC/2025-09.jsonl']);   // and no .research-data
});
