#!/usr/bin/env node
// Guarded candle fetcher for the exploration protocol (research/PROTOCOL.md, "Data boundary").
// Public read-only market data: no orders, credentials, keys or wallets. node: built-ins only.
//
// HARD GUARD. A candle bucket may be requested or stored only if
//   EXPLORATION_FROM (2020-01-01T00:00:00Z) <= bucketStart < RESERVED_FROM (2025-09-30T00:00:00Z).
// The bounds are constants of research/dataset.mjs. No option, flag or environment variable moves them. They are
// checked (1) on `from`/`to` before any request, (2) where every request URL is built, (3) on every row received
// and (4) on every row written. A received row outside the bounds fails the month; none of that month is stored.
//
// Retrieval mirrors replay.js `fetchHistoricalRange` and its `request`:
//   * URL: `${base}/products/${asset}-USD/candles?` + URLSearchParams({granularity:'60',start:iso,end:iso});
//   * chunks: `for(let t=first-MINUTE;t<e;t+=299*MINUTE)chunks.push([t,Math.min(t+299*MINUTE,e)])`, i.e. bucket
//     starts t .. t+299 minutes inclusive (at most 300 buckets), consecutive chunks sharing one bucket so that the
//     shared row is compared (`conflicting duplicate candle`);
//   * row validation and the duplicate comparison, character for character;
//   * HTTP 429 and 5xx, network errors and timeouts are retried with backoff*2**attempt; other statuses and
//     invalid JSON fail at once; a receipt {url, receivedAt, httpDate, sha256, rowCount, attempts} is kept per
//     stored response.
// Deliberate differences from replay.js, each forced by the guard or by the task:
//   * replay.js clips its last chunk at `e`, the end CLOSE, which read as a bucket start is one bucket past the
//     last wanted one (a row it then drops with `time>e`). For the final month that bucket is the first reserved
//     one, so every month's last chunk is clipped at its last wanted bucket instead. Nothing outside [from, to) is
//     ever requested. This relies on the exchange reading `end` as inclusive, which cannot be checked offline, so
//     each month records whether its last wanted bucket came back and a warning line is printed when it did not.
//   * rows are filtered per request: a valid in-bounds row outside the chunk that was asked for is ignored the
//     way replay.js ignores rows outside its range (`if(time<first||time>e)continue;`), so every stored row was
//     returned by a request that asked for it, and that request's receipt holds the body hash.
//   * work is month by month per asset (resumable), the two assets run as two concurrent request streams, the
//     receipt hash covers the raw body bytes and carries rowCount, redirects are not followed, and the retry
//     count, pause and backoff are parameters.
//   * an empty answer (HTTP 200, `[]`) is stored as what it is, no rows: nothing is filled in and the month does
//     not fail. Each month records how many of its answers were empty.
//
// LIMITS ON WAITING AND RETRYING. Node turns a timer above 2**31-1 ms into a 1 ms timer, so an unbounded wait would
// become no wait at all. No single wait (pause, retry backoff, Retry-After, request timeout) is longer than
// MAX_WAIT_MS, 5 minutes: larger options are refused, and a larger Retry-After is waited for 5 minutes and logged.
// The public exchange is never asked again sooner than 200 ms, between requests or between attempts of one request,
// and one request is attempted at most 10 times. A loopback test server is exempt from the 200 ms floor and from
// the 10-attempt ceiling, not from the 5 minute maximum.
import {mkdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {ASSETS, DEFAULT_DIR, EXPLORATION_FROM, FORMAT, MINUTE, RESERVED_FROM, ROW_BYTES, SOURCE, assertBucketAllowed,
  manifestBounds, manifestPath, monthKey, monthPaths, monthRange, readManifest, readMonth, sha256Hex} from './dataset.mjs';

export {SOURCE};                            // defined in dataset.mjs, where storeCompleteness compares it
export const COINBASE_URL = 'https://api.exchange.coinbase.com';
export const LOOPBACK_SOURCE = 'Loopback test server: synthetic candles, not market data';
export const MAX_WAIT_MS = 5 * MINUTE;      // the longest single wait, whatever asked for it
const CHUNK = 299 * MINUTE;                 // replay.js: `t+=299*MINUTE`
const MIN_PUBLIC_WAIT_MS = 200;             // public host: shortest pause between requests and shortest retry backoff
const MAX_PUBLIC_ATTEMPTS = 10;             // public host: most attempts for one request
const STOPPED = Symbol('another stream failed');

const iso = t => new Date(t).toISOString();
// Every wait goes through here, clamped to MAX_WAIT_MS however it was computed (the option checks and
// retryDelayMs already keep every caller below it).
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, MAX_WAIT_MS)));
const utf8 = new TextDecoder();

// A UTC date YYYY-MM-DD naming a bucket start (00:00:00Z of that day).
function day(value, name) {
  const t = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isSafeInteger(t) || iso(t).slice(0, 10) !== value) throw new Error(`${name} must be a UTC calendar date YYYY-MM-DD`);
  return t;
}

// Exactly the Coinbase default, or a loopback http URL for tests. The URL class parses; hostnames compare exactly;
// `href === origin + '/'` leaves no room for credentials, a path, a query or a fragment.
function resolveBase(baseUrl) {
  if (baseUrl === COINBASE_URL) return {origin: COINBASE_URL, loopback: false, source: SOURCE};
  let url = null;
  try { url = new URL(baseUrl); } catch {}
  if (typeof baseUrl !== 'string' || !url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.href !== `${url.origin}/`)
    throw new Error(`baseUrl must be exactly ${COINBASE_URL} or a loopback http://127.0.0.1:<port> or http://localhost:<port> URL; refused: ${baseUrl}`);
  return {origin: url.origin, loopback: true, source: LOOPBACK_SOURCE};
}

// The only place a request URL is made, so the only way to ask for a bucket: both ends pass the hard guard first.
// Same text as replay.js builds.
function candleUrl(origin, asset, start, end) {
  assertBucketAllowed(start, `${asset} request start`);
  assertBucketAllowed(end, `${asset} request end`);
  if (end < start || end - start > CHUNK) throw new Error(`${asset}: a request spans at most 300 buckets`);
  return `${origin}/products/${asset}-USD/candles?` + new URLSearchParams({granularity: '60', start: iso(start), end: iso(end)});
}

// The UTC months of [fromMs, toMs) with their wanted bucket starts [from, to) and replay.js-shaped chunks.
// In replay.js terms `first-MINUTE` is `from` and `e` is `to` (the close of bucket to-MINUTE); only the clip differs.
function planMonths(fromMs, toMs) {
  const plans = [];
  for (let from = fromMs; from < toMs;) {
    const month = monthKey(from), to = Math.min(monthRange(month)[1], toMs), chunks = [];
    for (let t = from; t < to; t += CHUNK) chunks.push([t, Math.min(t + CHUNK, to - MINUTE)]);
    plans.push({month, from, to, chunks});
    from = to;
  }
  return plans;
}

// A numeric Retry-After header (seconds) in milliseconds; NaN for anything else (an HTTP date is not honoured).
const retryAfterMs = header => (typeof header === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(header) ? Number(header) * 1000 : NaN);
// backoffMs*2**attempt as in replay.js (`wait(500*2**attempt)`).
const backoffDelayMs = (attempt, backoffMs) => (backoffMs > 0 ? backoffMs * 2 ** attempt : 0);

// The wait before the next attempt: the backoff, or a numeric Retry-After when that is larger, and never more
// than MAX_WAIT_MS (see LIMITS above: an uncapped value past 2**31-1 ms would be retried at once).
export function retryDelayMs(attempt, backoffMs, retryAfter) {
  const backoff = backoffDelayMs(attempt, backoffMs), asked = retryAfterMs(retryAfter);
  return Math.min(MAX_WAIT_MS, asked > backoff ? asked : backoff);
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.tmp`;
  try { writeFileSync(temporary, data); renameSync(temporary, path); }
  catch (error) { try { rmSync(temporary, {force: true}); } catch {} throw error; }
}

const duration = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

// Fetch [from, to) (UTC dates naming bucket starts; from inclusive, to exclusive) into `dir`, month by month per
// asset. Complete months whose stored range covers the wanted one and whose two files still match the manifest are
// skipped without a request; everything else is fetched again and replaced. Resolves to a summary; rejects on the
// first failure, leaving every month completed so far in place.
export async function fetchCandles({from = '2020-01-01', to = '2025-09-30', assets = ASSETS, dir = DEFAULT_DIR,
  baseUrl = COINBASE_URL, pauseMs = 250, maxAttempts = 6, backoffMs = 500, timeoutMs = 15000,
  fetchImpl = globalThis.fetch, log = console.error} = {}) {
  // ---- the hard guard and every other refusal, before any request exists
  const fromMs = day(from, 'from'), toMs = day(to, 'to');
  if (fromMs < EXPLORATION_FROM) throw new Error(`from ${from} is before the exploration range, which starts at ${iso(EXPLORATION_FROM)}; refused, there is no override`);
  if (toMs > RESERVED_FROM) throw new Error(`to ${to} reaches the reserved range: no bucket starting at or after ${iso(RESERVED_FROM)} is requested; refused, there is no override`);
  if (fromMs >= toMs) throw new Error('from must be earlier than to');
  const base = resolveBase(baseUrl);
  if (!Array.isArray(assets) || !assets.length || new Set(assets).size !== assets.length || !assets.every(a => ASSETS.includes(a)))
    throw new Error(`assets must be a non-empty list without repeats from ${ASSETS.join(', ')}`);
  if (typeof dir !== 'string' || !dir) throw new Error('dir must be a path');
  // Waits: each a finite number inside [0, MAX_WAIT_MS] (see LIMITS above), with a floor for the public host.
  const within = (value, least) => typeof value === 'number' && Number.isFinite(value) && value >= least && value <= MAX_WAIT_MS;
  if (!within(pauseMs, 0)) throw new Error(`pauseMs must be a number from 0 to ${MAX_WAIT_MS} (5 minutes)`);
  if (!base.loopback && pauseMs < MIN_PUBLIC_WAIT_MS) throw new Error(`pauseMs below ${MIN_PUBLIC_WAIT_MS} is refused for the public exchange`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  if (!base.loopback && maxAttempts > MAX_PUBLIC_ATTEMPTS) throw new Error(`maxAttempts above ${MAX_PUBLIC_ATTEMPTS} is refused for the public exchange`);
  if (!within(backoffMs, 0)) throw new Error(`backoffMs must be a number from 0 to ${MAX_WAIT_MS} (5 minutes)`);
  if (!base.loopback && backoffMs < MIN_PUBLIC_WAIT_MS) throw new Error(`backoffMs below ${MIN_PUBLIC_WAIT_MS} is refused for the public exchange`);
  if (!within(timeoutMs, 0) || timeoutMs === 0) throw new Error(`timeoutMs must be a positive number of at most ${MAX_WAIT_MS} (5 minutes)`);
  if (typeof fetchImpl !== 'function' || typeof log !== 'function') throw new Error('fetchImpl and log must be functions');

  // ---- plan: which months, which chunks, which are already complete
  const manifest = readManifest(dir) ?? {format: FORMAT, source: base.source, bounds: manifestBounds(), assets: {}};
  if (manifest.source !== base.source) throw new Error(`${manifestPath(dir)} was fetched from "${manifest.source}"; refusing to mix it with "${base.source}"`);
  const months = planMonths(fromMs, toMs), todo = {}, note = {};
  for (const asset of assets) {
    todo[asset] = months.filter(plan => {
      const entry = manifest.assets[asset]?.months[plan.month];
      if (entry?.complete !== true) return true;
      if (!(Date.parse(entry.from) <= plan.from && Date.parse(entry.to) >= plan.to)) {
        note[`${asset} ${plan.month}`] = ' (refetched: the stored range did not cover the wanted one)';
        return true;
      }
      // A month is kept only when its entry binds a receipts file and both files still match it (readMonth).
      if (typeof entry.receiptsSha256 !== 'string') {
        note[`${asset} ${plan.month}`] = ' (refetched: the manifest entry bound no receipts)';
        return true;
      }
      try { readMonth(dir, asset, plan.month, entry); return false; }
      catch { note[`${asset} ${plan.month}`] = ' (refetched: the stored files did not match the manifest)'; return true; }
    });
    for (const plan of todo[asset]) for (const [start, end] of plan.chunks) candleUrl(base.origin, asset, start, end);
  }
  const total = assets.reduce((sum, asset) => sum + todo[asset].reduce((n, plan) => n + plan.chunks.length, 0), 0);
  const began = performance.now(), stop = {error: null}, requests = Object.fromEntries(assets.map(a => [a, 0]));
  let done = 0;

  // replay.js `request`, with maxAttempts, backoffMs and timeoutMs as parameters and Retry-After honoured.
  async function request(url, label) {
    for (let attempt = 0; ; attempt++) {
      if (stop.error) throw STOPPED;
      // The timer stays armed until the whole body has been read, so a server that sends its headers and then
      // stalls is cut off like one that never answers.
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure = null, retryAfter = null;
      try {
        // Redirects are not followed: a redirect could lead to another host or another time range.
        const response = await fetchImpl(url, {signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'manual'});
        const body = Buffer.from(await response.arrayBuffer());
        if (!response.ok) {
          failure = new Error(`HTTP ${response.status}`);
          failure.retryable = response.status === 429 || response.status >= 500;
          retryAfter = response.headers.get('retry-after');
        } else {
          let rows;
          // A fixed text: the parser's own message quotes the body, and no response text belongs in an error.
          try { rows = JSON.parse(utf8.decode(body)); }
          catch { failure = new Error(`invalid JSON (${body.length} bytes)`); failure.retryable = false; }
          if (!failure) return {rows, retries: attempt, receipt: {url, receivedAt: Date.now(), httpDate: response.headers.get('date'),
            sha256: sha256Hex(body), rowCount: Array.isArray(rows) ? rows.length : 0, attempts: attempt + 1}};
        }
      } catch (error) {
        failure = new Error(controller.signal.aborted ? `timed out after ${timeoutMs} ms`
          : `network error (${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error})`);
      } finally { clearTimeout(timer); }
      if (attempt === maxAttempts - 1 || failure.retryable === false)
        throw new Error(`${label}: ${failure.message} on attempt ${attempt + 1} of ${maxAttempts}: ${url}`);
      // The next attempt is never sooner than the stream's own pause, and a wait the server asked for is logged:
      // it can last minutes, during which nothing else is printed for this asset.
      const asked = retryAfterMs(retryAfter), wait = Math.max(pauseMs, retryDelayMs(attempt, backoffMs, retryAfter));
      if (asked > backoffDelayMs(attempt, backoffMs))
        log(`${label}: ${failure.message}; Retry-After asks for ${retryAfter.trim()} s${asked > MAX_WAIT_MS ? `, more than the ${duration(MAX_WAIT_MS)} maximum` : ''}: ` +
          `waiting ${duration(wait)} before attempt ${attempt + 2} of ${maxAttempts}`);
      await sleep(wait);
    }
  }

  function store(asset, plan, seen, receipts, duplicates, emptyResponses) {
    const times = [...seen.keys()].sort((a, b) => a - b), bytes = Buffer.alloc(times.length * ROW_BYTES);
    times.forEach((time, i) => {
      const bucket = assertBucketAllowed(time - MINUTE, `${asset} ${plan.month} row to store`);
      if (bucket < plan.from || bucket >= plan.to) throw new Error(`${asset} ${plan.month}: a row outside the wanted range reached storage`);
      const [, low, high, open, close, volume] = seen.get(time);
      [time, low, high, open, close, volume].forEach((value, j) => bytes.writeDoubleLE(value, i * ROW_BYTES + j * 8));
    });
    const files = monthPaths(dir, asset, plan.month), receiptBytes = Buffer.from(receipts.map(receipt => JSON.stringify(receipt) + '\n').join(''));
    // Candles, then receipts, then the manifest entry that binds both by SHA-256. A stop between any two of the
    // three writes leaves a file that disagrees with the entry on disk (or no entry), which readMonth refuses and
    // the next run refetches; receipts are never left describing another fetch than the stored rows unnoticed.
    writeAtomic(files.candles, bytes);
    writeAtomic(files.receipts, receiptBytes);
    const entry = (manifest.assets[asset] ??= {months: {}}).months[plan.month] = {rows: times.length, firstClose: times[0] ?? null,
      lastClose: times.at(-1) ?? null, sha256: sha256Hex(bytes), requests: receipts.length, receipts: receipts.length,
      receiptsSha256: sha256Hex(receiptBytes), emptyResponses, lastBucketPresent: seen.has(plan.to), fetchedAt: iso(Date.now()),
      complete: true, from: iso(plan.from), to: iso(plan.to), duplicateRows: duplicates};
    // The manifest is rewritten after every month, assets and months in a fixed order whatever finished first.
    const sorted = Object.fromEntries(ASSETS.filter(a => manifest.assets[a]).map(a => [a, {months:
      Object.fromEntries(Object.keys(manifest.assets[a].months).sort().map(month => [month, manifest.assets[a].months[month]]))}]));
    writeAtomic(manifestPath(dir), JSON.stringify({...manifest, assets: sorted}, null, 2) + '\n');
    return entry;
  }

  // One sequential request stream per asset; pauseMs separates its requests (replay.js: `if(completed)await wait(350)`).
  async function stream(asset) {
    for (const plan of todo[asset]) {
      const seen = new Map(), receipts = [], label = `${asset} ${plan.month}`;
      let duplicates = 0, retries = 0, empty = 0;
      for (const [start, end] of plan.chunks) {
        if (stop.error) throw STOPPED;
        if (requests[asset]++ && pauseMs > 0) await sleep(pauseMs);
        const url = candleUrl(base.origin, asset, start, end), response = await request(url, label), rows = response.rows;
        // From here to the duplicate check: replay.js, with the guard and the per-request filter added. Messages
        // name the month and the request, never a price.
        if (!Array.isArray(rows)) throw new Error(`${asset}: invalid candle response (${plan.month}): ${url}`);
        if (!rows.length) empty++;
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 6) throw new Error(`${asset}: invalid candle row (${plan.month}): ${url}`);
          const [bucket, low, high, open, close, volume] = row;
          if (!Number.isSafeInteger(bucket) || bucket % 60 || ![low, high, open, close, volume].every(v => typeof v === 'number' && Number.isFinite(v)) ||
              Math.min(low, high, open, close) <= 0 || volume < 0 || low > Math.min(open, close) || high < Math.max(open, close))
            throw new Error(`${asset}: invalid candle values (${plan.month}): ${url}`);
          // HARD GUARD on every row received.
          assertBucketAllowed(bucket * 1000, `${label} response row from ${url}`);
          if (bucket * 1000 < start || bucket * 1000 > end) continue;
          const time = bucket * 1000 + MINUTE;
          if (seen.has(time)) {
            duplicates++;
            if (JSON.stringify(seen.get(time)) !== JSON.stringify(row)) throw new Error(`${asset}: conflicting duplicate candle at ${iso(time)} (${plan.month}): ${url}`);
          } else seen.set(time, row);
        }
        receipts.push(response.receipt); retries += response.retries; done++;
      }
      const entry = store(asset, plan, seen, receipts, duplicates, empty);
      log(`${label}: ${entry.rows} rows from ${receipts.length} requests${retries ? `, ${retries} retries` : ''}` +
        `${empty ? `, ${empty} empty ${empty === 1 ? 'response' : 'responses'}` : ''}${note[label] ?? ''}; ` +
        `${done}/${total} requests done, ETA ${duration((performance.now() - began) / done * (total - done))}`);
      // Either that minute has no candle at the exchange, or the exchange read the request's `end` as exclusive
      // (then no request shares a row with the next one, and every month ends like this). The month is stored as
      // returned and stays complete; this line and the manifest's lastBucketPresent are how it is noticed.
      if (!entry.lastBucketPresent)
        log(`warning: ${label}: no candle came back for the last wanted minute, the bucket starting ${iso(plan.to - MINUTE)}. ` +
          `It is stored as missing; nothing is filled in. Rows returned twice where requests overlap this month: ${duplicates} ` +
          '(0 in every month would mean the exchange leaves out the last bucket of each request).');
    }
  }

  await Promise.all(assets.map(asset => stream(asset).catch(error => { if (error !== STOPPED) stop.error ??= error; })));
  if (stop.error) throw stop.error;
  // Per asset over the months of [from, to), fetched now or kept from an earlier run: rows, the months that had
  // empty answers with how many, and the months whose last wanted bucket did not come back.
  return {format: FORMAT, dir, source: base.source, from, to, bounds: manifestBounds(), requests: done,
    elapsedMs: Math.round(performance.now() - began),
    assets: Object.fromEntries(assets.map(asset => {
      const entries = months.map(plan => manifest.assets[asset].months[plan.month]);
      return [asset, {months: months.length, fetched: todo[asset].length, skipped: months.length - todo[asset].length,
        requests: requests[asset], rows: entries.reduce((sum, entry) => sum + entry.rows, 0),
        emptyResponses: Object.fromEntries(months.map((plan, i) => [plan.month, entries[i].emptyResponses ?? 0]).filter(([, count]) => count > 0)),
        lastBucketMissing: months.filter((plan, i) => entries[i].lastBucketPresent === false).map(plan => plan.month)}];
    }))};
}

// ---- command line: no base URL flag and no bounds flag exist, on purpose
const USAGE = 'usage: node research/fetch-candles.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--assets BTC,LINK] [--dir path] [--pause-ms n]';

async function main(argv, env) {
  const {values} = parseArgs({args: argv, strict: true, allowPositionals: false, options: {from: {type: 'string'},
    to: {type: 'string'}, assets: {type: 'string'}, dir: {type: 'string'}, 'pause-ms': {type: 'string'}, help: {type: 'boolean'}}});
  if (values.help) { console.log(USAGE); return null; }
  const options = {};
  if (values.from !== undefined) options.from = values.from;
  if (values.to !== undefined) options.to = values.to;
  if (values.assets !== undefined) options.assets = values.assets.split(',');
  if (values.dir !== undefined) options.dir = values.dir;
  if (values['pause-ms'] !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(values['pause-ms'])) throw new Error('--pause-ms must be a number of milliseconds');
    options.pauseMs = Number(values['pause-ms']);
  }
  // Two things Node's built-in fetch needs behind a proxy, neither of which it reports clearly when missing.
  if (env.HTTPS_PROXY || env.https_proxy) {
    if (env.NODE_USE_ENV_PROXY !== '1')
      console.error('hint: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1; Node\'s built-in fetch ignores the proxy unless NODE_USE_ENV_PROXY=1');
    if (!env.NODE_EXTRA_CA_CERTS)
      console.error('hint: HTTPS_PROXY is set but NODE_EXTRA_CA_CERTS is not; a proxy that re-signs TLS needs its CA bundle there ' +
        '(NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem), or every request fails as a network error naming a certificate');
  }
  return fetchCandles(options);
}

let invoked = false;
try { invoked = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch {}
if (invoked) {
  main(process.argv.slice(2), process.env).then(summary => {
    if (summary) console.log(JSON.stringify({ok: true, ...summary}, null, 2));
  }, error => {
    console.error(`fetch-candles: ${error.message}`);
    if (error.code?.startsWith?.('ERR_PARSE_ARGS')) console.error(USAGE);
    console.log(JSON.stringify({ok: false, error: error.message}, null, 2));
    process.exitCode = 1;
  });
}
