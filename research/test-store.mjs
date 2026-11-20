// An honest candle store for TESTS ONLY: what research/fetch-candles.mjs writes for the answers a test supplies.
// research/study.mjs never imports this file. node: built-ins only.
//
// writeTestStore runs the fetcher itself (fetchCandles), answered by a stub that serves the rows the test gives, so
// a test store is what a fetch of those answers stores, by construction: the same candle files, receipts files (one
// receipt per request of at most 300 buckets, naming the exchange's origin or a loopback one), manifest entries, row
// counts and hashes, all written by the fetcher's own code. Two things a real fetch takes from the world are fixed,
// so that a test store is the same on every run: the clock (every receipt's receivedAt and every entry's fetchedAt
// is `now`) and the Date header (the IMF-fixdate of `now`, or none). The fetcher runs in a worker thread whose clock
// is fixed and whose 200 ms pauses on the exchange's host pass at once; nothing in the caller's process is changed.
// The caller waits for the worker (Atomics.wait), so writeTestStore is synchronous.
import {realpathSync, rmSync} from 'node:fs';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData} from 'node:worker_threads';
import {ASSETS, CHUNK, DEFAULT_DIR, EXCHANGE_ORIGIN, EXPLORATION_FROM, LOOPBACK_SOURCE, MINUTE, RESERVED_FROM, ROW_VALUES, SOURCE,
  explorationMonths, monthKey, monthPaths, monthRange, readManifest} from './dataset.mjs';
import {fetchCandles} from './fetch-candles.mjs';

// The default clock of a test store: later than every bucket of the exploration range, so its answers are dated.
export const TEST_STORE_NOW = Date.parse('2026-11-19T07:57:37.000Z');
const WAIT_MS = 60000;                      // the longest writeTestStore waits for its worker (a whole store takes about 1 s)
const PUBLIC_PAUSE_MS = 200;                // the fetcher's least pause on the exchange's host, passed at once in the worker
const iso = t => new Date(t).toISOString();

// Where a directory is, or would be once created: the real path of its nearest existing ancestor with the rest of
// the path added, so that a symbolic link to the default store is found out. (A link whose target does not exist
// cannot be written through: creating a directory through it fails.)
function realTarget(path) {
  const rest = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { return join(realpathSync(at), ...rest.reverse()); } catch {}
    if (dirname(at) === at) return resolve(path);
    rest.push(basename(at));
  }
}

// A month's rows as the store holds them, checked and packed: ROW_VALUES numbers a row.
function packRows(asset, month, rows) {
  const [start, end] = monthRange(month), from = Math.max(start, EXPLORATION_FROM), to = Math.min(end, RESERVED_FROM);
  const where = `writeTestStore: rowsFor(${asset}, ${month})`;
  if (!Array.isArray(rows)) throw new Error(`${where} is not an array of rows`);
  const packed = new Float64Array(rows.length * ROW_VALUES);
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== ROW_VALUES || !row.every(value => typeof value === 'number' && Number.isFinite(value)))
      throw new Error(`${where} row ${i} is not ${ROW_VALUES} finite numbers [closeTimeMs, low, high, open, close, volume]`);
    if (!Number.isSafeInteger(row[0]) || row[0] % MINUTE || row[0] - MINUTE < from || row[0] - MINUTE >= to)
      throw new Error(`${where} row ${i}: ${row[0]} is not the close of a minute whose bucket starts in ${iso(from)} to ${iso(to)}`);
    if (i && !(row[0] > rows[i - 1][0])) throw new Error(`${where}: rows are not strictly increasing at row ${i}`);
    packed.set(row, i * ROW_VALUES);
  });
  return packed;
}

// Writes an honest store into `dir` and returns {dir, source, requests, rows, log}: dir as an absolute path, the
// label, the number of requests the fetcher made, rows written per asset ({BTC, LINK} for the assets written) and
// the lines the fetcher printed (their ETA figures are timings and vary from run to run). With source SOURCE, the
// default `dated` and `now`, every month of the range written and at least one row in each, the store is what
// storeCompleteness calls usable. Options:
//   rowsFor(asset, month)  required. The rows to store for that asset and 'YYYY-MM' month, called once for each
//                          pair written: an array of [closeTimeMs, low, high, open, close, volume] (the store's
//                          own row), closeTimeMs strictly increasing, each a minute close whose bucket start
//                          (closeTimeMs - 60000) lies in the month clipped to the exploration bounds. The values are
//                          answered to the fetcher, which refuses what the exchange would never send (replay.js row
//                          validation: 0 < low <= min(open, close), high >= max(open, close), volume >= 0).
//                          [] stores the month with no row, every answer empty, as an exchange outage would.
//   source                 required, SOURCE or LOOPBACK_SOURCE: the two labels the fetcher writes. SOURCE runs it on
//                          the exchange's base URL (receipts name https://api.exchange.coinbase.com), LOOPBACK_SOURCE
//                          on `loopbackUrl`. Nothing is contacted either way: the stub answers every request.
//   months = every month of the exploration range   the 'YYYY-MM' months to write, any order, no repeats.
//   assets = ['BTC', 'LINK']   the assets to write, each for every month in `months`.
//   dated = true           true: every answer carries the Date header IMF-fixdate(now), e.g. "Thu, 19 Nov 2026
//                          07:57:37 GMT"; false: no answer carries one (httpDate null in every receipt); or a
//                          function (asset, month, index) -> boolean deciding it per answer, index counting the
//                          month's requests from 0 in the fetcher's order (bucket starts from + index * 299 min).
//   now = TEST_STORE_NOW   milliseconds, a safe integer: every receipt's receivedAt and every entry's fetchedAt, and
//                          the time the Date header states (to the second). The default, 2026-11-19T07:57:37.000Z,
//                          is later than every bucket, so with dated answers an exchange-labelled store is usable.
//   loopbackUrl = 'http://127.0.0.1:9'   with LOOPBACK_SOURCE, the base URL the fetcher is given (its rule: http on
//                          127.0.0.1 or localhost with a port), whose origin the receipts name.
// The store is the fetcher's: a directory that already holds a store keeps its other months and must carry the
// same label (the fetcher refuses to mix two), and every listed month is written anew, its candle file deleted
// first, which is how the fetcher is told to fetch a month again. Refused, before anything is written: the default
// store (.research-data under the working directory, compared by real path, so also through a symbolic link) and
// any directory inside it.
export function writeTestStore(dir, {rowsFor, source, months = explorationMonths(), assets = ASSETS, dated = true, now = TEST_STORE_NOW,
  loopbackUrl = 'http://127.0.0.1:9'} = {}) {
  if (typeof dir !== 'string' || !dir) throw new Error('writeTestStore: dir must be a path');
  const target = realTarget(dir), store = realTarget(DEFAULT_DIR);
  if (target === store || target.startsWith(store + sep))
    throw new Error(`writeTestStore: ${dir} is the default store ${DEFAULT_DIR} or inside it; a test store is never written there; refused`);
  if (typeof rowsFor !== 'function') throw new Error('writeTestStore: rowsFor must be a function (asset, month) -> rows');
  if (source !== SOURCE && source !== LOOPBACK_SOURCE) throw new Error('writeTestStore: source must be SOURCE or LOOPBACK_SOURCE, the labels the fetcher writes');
  const range = explorationMonths();
  if (!Array.isArray(months) || !months.length || new Set(months).size !== months.length || !months.every(month => range.includes(month)))
    throw new Error('writeTestStore: months must be a non-empty list without repeats of months from 2020-01 to 2025-09');
  if (!Array.isArray(assets) || !assets.length || new Set(assets).size !== assets.length || !assets.every(asset => ASSETS.includes(asset)))
    throw new Error(`writeTestStore: assets must be a non-empty list without repeats from ${ASSETS.join(', ')}`);
  if (typeof dated !== 'boolean' && typeof dated !== 'function') throw new Error('writeTestStore: dated must be true, false or a function (asset, month, index) -> boolean');
  if (!Number.isSafeInteger(now)) throw new Error('writeTestStore: now must be a whole number of milliseconds');
  const existing = readManifest(dir);
  if (existing && existing.source !== source) throw new Error(`writeTestStore: ${dir} holds a store labelled "${existing.source}", not "${source}"`);

  // The rows, and which answers carry a date, per asset and month; then the months in runs of consecutive months,
  // one fetch each, from the first day of the run to the day after it (2025-09 ends at 2025-09-30).
  const sorted = range.filter(month => months.includes(month)), rows = {}, undated = {};
  for (const asset of assets) {
    rows[asset] = {}; undated[asset] = {};
    for (const month of sorted) {
      rows[asset][month] = packRows(asset, month, rowsFor(asset, month));
      const [start, end] = monthRange(month), from = Math.max(start, EXPLORATION_FROM), requests = Math.ceil((Math.min(end, RESERVED_FROM) - from) / CHUNK);
      undated[asset][month] = Array.from({length: requests}, (_, index) => !(typeof dated === 'function' ? dated(asset, month, index) : dated));
    }
  }
  const runs = [];
  for (const month of sorted) {
    const last = runs.at(-1);
    if (last && range.indexOf(month) === range.indexOf(last.months.at(-1)) + 1) last.months.push(month); else runs.push({months: [month]});
  }
  for (const run of runs) [run.from, run.to] = [iso(Math.max(monthRange(run.months[0])[0], EXPLORATION_FROM)).slice(0, 10),
    iso(Math.min(monthRange(run.months.at(-1))[1], RESERVED_FROM)).slice(0, 10)];
  for (const asset of assets) for (const month of sorted) rmSync(monthPaths(dir, asset, month).candles, {force: true});

  const task = {dir: resolve(dir), baseUrl: source === SOURCE ? EXCHANGE_ORIGIN : loopbackUrl, pauseMs: source === SOURCE ? PUBLIC_PAUSE_MS : 0,
    runs, assets, rows, undated, now, httpDate: new Date(now).toUTCString()};
  const signal = new Int32Array(new SharedArrayBuffer(4)), {port1, port2} = new MessageChannel();
  const buffers = assets.flatMap(asset => sorted.map(month => rows[asset][month].buffer));
  // No command-line option of the caller's process is passed on: some (node --input-type=module -e) stop a worker
  // from starting, and none is needed to run the fetcher.
  const worker = new Worker(new URL(import.meta.url), {workerData: {writeTestStore: task, port: port2, signal}, transferList: [port2, ...buffers], execArgv: []});
  worker.unref();
  const waited = Atomics.wait(signal, 0, 0, WAIT_MS), reply = receiveMessageOnPort(port1)?.message;
  port1.close();
  if (waited === 'timed-out' || !reply) {
    worker.terminate();
    throw new Error(`writeTestStore: no answer from its worker within ${WAIT_MS / 1000} s (a worker that cannot start never answers)`);
  }
  if (reply.error) throw new Error(`writeTestStore: ${reply.error}`);
  return reply.summary;
}

// ---- in the worker: the fetcher, answered by a stub, with a fixed clock
async function fetchInWorker({dir, baseUrl, pauseMs, runs, assets, rows, undated, now, httpDate}) {
  Date.now = () => now;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => (pauseMs > 0 && ms === pauseMs ? setImmediate(callback, ...args) : realSetTimeout(callback, ms, ...args));
  // The exchange's answer to a request: the stored rows whose bucket it asks for, newest first, each [bucket start
  // in seconds, low, high, open, close, volume], as JSON; with a Date header unless that answer is to have none.
  const stub = async url => {
    const target = new URL(url), asset = /^\/products\/(BTC|LINK)-USD\/candles$/.exec(target.pathname)[1];
    const start = Date.parse(target.searchParams.get('start')), end = Date.parse(target.searchParams.get('end')), month = monthKey(start);
    const stored = rows[asset][month], count = stored.length / ROW_VALUES, answer = [];
    let low = 0, high = count;                      // the first row whose bucket starts at or after `start`
    while (low < high) { const middle = (low + high) >>> 1; if (stored[middle * ROW_VALUES] - MINUTE < start) low = middle + 1; else high = middle; }
    let last = low;
    while (last < count && stored[last * ROW_VALUES] - MINUTE <= end) last++;
    for (let i = last - 1; i >= low; i--) {
      const at = i * ROW_VALUES;
      answer.push([(stored[at] - MINUTE) / 1000, ...stored.subarray(at + 1, at + ROW_VALUES)]);
    }
    const index = Math.round((start - Math.max(monthRange(month)[0], EXPLORATION_FROM)) / CHUNK);
    return new Response(JSON.stringify(answer), {headers: undated[asset][month][index] ? {} : {date: httpDate}});
  };
  const log = [], written = {requests: 0, rows: Object.fromEntries(assets.map(asset => [asset, 0]))};
  for (const {from, to} of runs) {
    const summary = await fetchCandles({from, to, assets, dir, baseUrl, pauseMs, fetchImpl: stub, log: line => log.push(line)});
    written.requests += summary.requests;
    for (const asset of assets) written.rows[asset] += summary.assets[asset].rows;
  }
  return {dir, source: baseUrl === EXCHANGE_ORIGIN ? SOURCE : LOOPBACK_SOURCE, ...written, log};
}

// Started from a promise, not awaited at the top level: the module finishes loading at once, so the worker is never
// terminated (writeTestStore's timeout) while its module evaluation is pending, which Node 22 can abort the whole
// process on (the pattern research/engine-run.mjs dropped).
if (!isMainThread && workerData?.writeTestStore) {
  const {port, signal} = workerData;
  const answer = reply => {
    port.postMessage(reply);
    port.close();
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  };
  fetchInWorker(workerData.writeTestStore).then(summary => answer({summary}), error => answer({error: error?.message ?? String(error)}));
}
