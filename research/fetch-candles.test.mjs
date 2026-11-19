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
import {COINBASE_URL, LOOPBACK_SOURCE, SOURCE, fetchCandles, retryDelayMs} from './fetch-candles.mjs';
import {ASSETS, EXPLORATION_FROM, MINUTE, RESERVED_FROM, coverage, loadSeries, publicManifest, seriesFromRows} from './dataset.mjs';

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
async function startServer(t) {
  const state = {requests: [], count: {BTC: 0, LINK: 0}, fault: () => undefined, hung: []};
  const server = http.createServer((req, res) => {
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
const readManifestFile = dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const readReceipts = (dir, asset, month) =>
  fs.readFileSync(path.join(dir, 'receipts', asset, `${month}.jsonl`), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
function filesIn(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? filesIn(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]).sort();
}
// A store written by hand in the documented layout, to test the loader on its own.
function writeStore(dir, asset, month, rows, overrides = {}, bounds = {from: iso(EXPLORATION_FROM), to: iso(RESERVED_FROM)}) {
  const bytes = Buffer.alloc(rows.length * 48), file = path.join(dir, 'manifest.json');
  rows.forEach((row, i) => row.forEach((value, j) => bytes.writeDoubleLE(value, i * 48 + j * 8)));
  fs.mkdirSync(path.dirname(candleFile(dir, asset, month)), {recursive: true});
  fs.writeFileSync(candleFile(dir, asset, month), bytes);
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {format: 'paper-trail-research-candles-v1', source: 'written by hand in a test', bounds, assets: {}};
  (manifest.assets[asset] ??= {months: {}}).months[month] = {rows: rows.length, firstClose: rows[0]?.[0] ?? null,
    lastClose: rows.at(-1)?.[0] ?? null, sha256: sha(bytes), requests: 0, fetchedAt: '2020-01-01T00:00:00.000Z', complete: true, ...overrides};
  fs.writeFileSync(file, JSON.stringify(manifest));
}
const handRow = (bucketStart, close = 100) => [bucketStart + MINUTE, close - 1, close + 1, close, close, 2];

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
  const spy = async () => { calls++; throw new Error('a refused configuration made a request'); };
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
  t.mock.timers.enable({apis: ['setTimeout']});   // the pauses of both fetchers pass without waiting
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
      assert.deepEqual({...entry, fetchedAt: null}, {rows: expected[asset].length, firstClose: FROM + MINUTE, lastClose: RESERVED_FROM,
        sha256: sha(fs.readFileSync(candleFile(dir, asset, '2025-09'))), requests: 15, fetchedAt: null, complete: true,
        from: '2025-09-27T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z', duplicateRows: duplicates});
      assert.equal(receipts.reduce((sum, receipt) => sum + receipt.rowCount, 0), entry.rows + entry.duplicateRows);
    }
    assert.deepEqual(publicManifest(dir), manifest);
    assert.doesNotMatch(JSON.stringify(publicManifest(dir)), /https?:\/\/|url|receipt/i);
  });

  await t.test('the summary and one progress line per completed month', () => {
    assert.deepEqual({...summary, elapsedMs: null}, {format: 'paper-trail-research-candles-v1', dir, source: LOOPBACK_SOURCE,
      from: '2025-09-27', to: '2025-09-30', bounds: {from: '2020-01-01T00:00:00.000Z', to: '2025-09-30T00:00:00.000Z'}, requests: 30, elapsedMs: null,
      assets: {BTC: {months: 1, fetched: 1, skipped: 0, requests: 15, rows: expected.BTC.length},
        LINK: {months: 1, fetched: 1, skipped: 0, requests: 15, rows: expected.LINK.length}}});
    // The two streams interleave, so the first month to finish reports between 15 and 29 requests done.
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
    assert.deepEqual(again.assets.BTC, {months: 1, fetched: 0, skipped: 1, requests: 0, rows: expected.BTC.length});
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
    assert.match(lines[0], /^BTC 2025-09: .*refetched: the stored file did not match the manifest.*15\/15 requests done/);
    assert.deepEqual(readRows(file), expected.BTC);
    assert.equal(loadSeries(dir, 'BTC').time.length, expected.BTC.length);
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
  assert.deepEqual(resumed.assets.BTC, {months: 2, fetched: 1, skipped: 1, requests: 5, rows: expectedRows('BTC', AUG, TO).length});
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), expectedRows('BTC', SEP, TO));
  assert.equal(readRows(candleFile(dir, 'BTC', '2025-09'))[0][0], SEP + MINUTE);
  assert.deepEqual([...loadSeries(dir, 'BTC').time], expectedRows('BTC', AUG, TO).map(row => row[0]));
  assert.throws(() => loadSeries(dir, 'LINK'), /LINK: no complete months/);

  // A month written to disk but never recorded in the manifest (a stop between the two writes) counts as not done.
  const manifest = readManifestFile(dir);
  delete manifest.assets.BTC.months['2025-09'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual([...loadSeries(dir, 'BTC').time], expectedRows('BTC', AUG, SEP).map(row => row[0]));
  await fetchCandles(options);
  assert.deepEqual(server.state.requests.slice(13).map(request => [request.start, request.end]), chunksOf(SEP, TO));

  // A month stored for a narrower range than is wanted now is fetched again in full; the others are left alone.
  const wider = await fetchCandles({...options, from: '2025-08-30'});
  assert.deepEqual(server.state.requests.slice(18).map(request => [request.start, request.end]), chunksOf(utc('2025-08-30'), SEP));
  assert.deepEqual(wider.assets.BTC, {months: 2, fetched: 1, skipped: 1, requests: 10, rows: expectedRows('BTC', utc('2025-08-30'), TO).length});
  assert.equal(readManifestFile(dir).assets.BTC.months['2025-08'].from, '2025-08-30T00:00:00.000Z');
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-08')), expectedRows('BTC', utc('2025-08-30'), SEP));
  assert.deepEqual(filesIn(dir), ['candles/BTC/2025-08.f64', 'candles/BTC/2025-09.f64', 'manifest.json',
    'receipts/BTC/2025-08.jsonl', 'receipts/BTC/2025-09.jsonl']);
  assert.equal(readReceipts(dir, 'BTC', '2025-08').length, 10);
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
  await t.test('invalid JSON is not retried', async () => {
    const dir = tmp(t);
    server.state.fault = faults({'BTC 2': {body: '[[1759017600, 1, 2, 1, 2, 3'}});
    await assert.rejects(run(dir), /BTC 2025-09: invalid JSON \(.*\) on attempt 1 of 6/);
    assert.equal(server.state.requests.length, 2);
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
});

test('retry delay is backoff * 2**attempt, or a numeric Retry-After when that is larger', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(attempt => retryDelayMs(attempt, 500, null)), [500, 1000, 2000, 4000, 8000]);
  assert.equal(retryDelayMs(0, 500, '2'), 2000);
  assert.equal(retryDelayMs(0, 500, ' 1.5 '), 1500);
  assert.equal(retryDelayMs(3, 500, '2'), 4000);          // the backoff is larger
  assert.equal(retryDelayMs(0, 500, '0'), 500);
  for (const header of ['Wed, 21 Oct 2026 07:28:00 GMT', 'soon', '-5', '1e9', '', undefined, 30])
    assert.equal(retryDelayMs(1, 500, header), 1000);
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
  // The proxy hint: printed when HTTPS_PROXY is set and NODE_USE_ENV_PROXY is not 1.
  const hint = /^hint: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1/m, refused = ['--dir', dir, '--to', '2025-10-01'];
  assert.match((await cli(refused, NO_NETWORK, {HTTPS_PROXY: 'http://127.0.0.1:9'})).stderr, hint);
  assert.doesNotMatch((await cli(refused, NO_NETWORK, {HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1'})).stderr, hint);
  assert.doesNotMatch((await cli(refused, NO_NETWORK)).stderr, hint);
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
    assets: {BTC: {months: 1, fetched: 1, skipped: 0, requests: 5, rows: rows.length}}});
  assert.ok(summary.elapsedMs >= 4 * 200 - 50, 'four pauses of 200 ms separate five requests');
  assert.deepEqual(server.state.requests.map(request => [request.start, request.end]), chunksOf(utc('2025-09-29'), RESERVED_FROM));
  assert.deepEqual(readRows(candleFile(dir, 'BTC', '2025-09')), rows);
  assert.ok(readReceipts(dir, 'BTC', '2025-09').every(receipt => receipt.url.startsWith('https://api.exchange.coinbase.com/products/BTC-USD/candles?')));
});
