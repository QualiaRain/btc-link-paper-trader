// Exploration dataset for research/PROTOCOL.md ("Data boundary"): the hard bounds, the on-disk candle store that
// research/fetch-candles.mjs writes, and the loader every simulator reads it through. node: built-ins only.
//
// Conventions mirrored from the app:
//   * A candle is stamped with its close: bucketStartSeconds*1000 + 60000
//     (replay.js: `const time=bucket*1000+MINUTE;`, "Candle bucket start +60 seconds").
//   * A series is one asset's observed minute closes in strictly increasing time order. Missing minutes are never
//     filled (replay.js: "per-asset histories retain separate observed minutes, never filled").
//
// On-disk layout under a data directory (default ".research-data", ignored by git):
//   candles/<ASSET>/<YYYY-MM>.f64    little-endian Float64 rows of 6 values [closeTimeMs, low, high, open, close,
//                                    volume], sorted by time, unique; a row belongs to the UTC month of its BUCKET
//                                    START (closeTimeMs - 60000), so a month's last row closes at the next month's
//                                    00:00:00.
//   receipts/<ASSET>/<YYYY-MM>.jsonl one JSON line per stored HTTP response
//                                    {url, receivedAt, httpDate, sha256, rowCount, attempts}.
//   manifest.json                    {format, source, bounds: {from, to}, assets: {<ASSET>: {months: {"YYYY-MM":
//                                    {rows, firstClose, lastClose, sha256, requests, fetchedAt, complete: true,
//                                    from, to, duplicateRows}}}}}; sha256 is of the .f64 bytes.
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export const MINUTE = 60000;
export const ASSETS = ['BTC', 'LINK'];

// The data boundary. These bound candle BUCKET STARTS: a bucket is allowed iff
// EXPLORATION_FROM <= bucketStartMs < RESERVED_FROM. They are constants of the pre-registered protocol; no option,
// flag or environment variable changes them, here or in the fetcher.
export const EXPLORATION_FROM = Date.parse('2020-01-01T00:00:00Z');
export const RESERVED_FROM = Date.parse('2025-09-30T00:00:00Z');

export const FORMAT = 'paper-trail-research-candles-v1';
export const DEFAULT_DIR = '.research-data';
export const ROW_VALUES = 6;
export const ROW_BYTES = ROW_VALUES * 8;

const iso = t => new Date(t).toISOString();
const describe = t => (Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? iso(t) : String(t));

export function bucketAllowed(bucketStartMs) {
  return Number.isSafeInteger(bucketStartMs) && bucketStartMs % MINUTE === 0 &&
    bucketStartMs >= EXPLORATION_FROM && bucketStartMs < RESERVED_FROM;
}

// The one statement of the hard guard, shared by the fetcher (requests, received rows, stored rows) and the loader.
export function assertBucketAllowed(bucketStartMs, what) {
  if (bucketAllowed(bucketStartMs)) return bucketStartMs;
  throw new Error(`${what}: bucket start ${describe(bucketStartMs)} is outside the exploration range ` +
    `[${iso(EXPLORATION_FROM)}, ${iso(RESERVED_FROM)}); refused, there is no override`);
}

// "YYYY-MM" of the UTC month a bucket start falls in, and that month's [start, end) in milliseconds.
export const monthKey = bucketStartMs => iso(bucketStartMs).slice(0, 7);
export function monthRange(key) {
  const match = typeof key === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!match) throw new Error(`Invalid month key: ${key}`);
  return [Date.UTC(+match[1], +match[2] - 1, 1), Date.UTC(+match[1], +match[2], 1)];
}

export const manifestPath = dir => join(dir, 'manifest.json');
export const monthPaths = (dir, asset, month) => ({
  candles: join(dir, 'candles', asset, `${month}.f64`),
  receipts: join(dir, 'receipts', asset, `${month}.jsonl`)
});
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const manifestBounds = () => ({from: iso(EXPLORATION_FROM), to: iso(RESERVED_FROM)});

function assertAsset(asset) {
  if (!ASSETS.includes(asset)) throw new Error(`Unknown asset: ${asset}`);
}

// The parsed manifest, or null when the directory has none. A manifest of another format, or one written under
// other bounds, is refused rather than read.
export function readManifest(dir = DEFAULT_DIR) {
  const path = manifestPath(dir);
  if (!existsSync(path)) return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${path}: unreadable manifest (${error.message})`); }
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const bounds = manifestBounds();
  if (!plain(manifest) || manifest.format !== FORMAT) throw new Error(`${path}: not a ${FORMAT} manifest`);
  if (manifest.bounds?.from !== bounds.from || manifest.bounds?.to !== bounds.to)
    throw new Error(`${path}: written under other bounds than [${bounds.from}, ${bounds.to}); refused`);
  if (typeof manifest.source !== 'string' || !plain(manifest.assets)) throw new Error(`${path}: incomplete manifest`);
  for (const [asset, block] of Object.entries(manifest.assets)) {
    assertAsset(asset);
    if (!plain(block) || !plain(block.months)) throw new Error(`${path}: ${asset} has no months block`);
    for (const [month, entry] of Object.entries(block.months)) {
      monthRange(month);
      if (!plain(entry)) throw new Error(`${path}: ${asset} ${month} is not an entry`);
    }
  }
  return manifest;
}

// Read and verify one stored month against its manifest entry. Throws when the file is missing, its SHA-256 or row
// count disagrees with the manifest, or any row is not a strictly increasing minute close whose bucket start lies
// inside the exploration bounds and inside this UTC month.
export function readMonth(dir, asset, month, entry) {
  assertAsset(asset);
  const [monthStart, monthEnd] = monthRange(month), label = `${asset} ${month}`;
  let bytes;
  try { bytes = readFileSync(monthPaths(dir, asset, month).candles); }
  catch (error) { throw new Error(`${label}: candle file unreadable (${error.code ?? error.message})`); }
  if (sha256Hex(bytes) !== entry?.sha256) throw new Error(`${label}: candle file SHA-256 disagrees with the manifest`);
  if (bytes.length % ROW_BYTES || bytes.length / ROW_BYTES !== entry.rows)
    throw new Error(`${label}: candle file holds ${bytes.length / ROW_BYTES} rows, the manifest says ${entry.rows}`);
  const rows = entry.rows, time = new Float64Array(rows), close = new Float64Array(rows);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let previous = -Infinity;
  for (let i = 0; i < rows; i++) {
    const t = view.getFloat64(i * ROW_BYTES, true), price = view.getFloat64(i * ROW_BYTES + 32, true);
    const bucket = assertBucketAllowed(t - MINUTE, `${label} row ${i}`);
    if (bucket < monthStart || bucket >= monthEnd) throw new Error(`${label}: row ${i} (${iso(t)}) belongs to another month`);
    if (!(t > previous)) throw new Error(`${label}: rows are not strictly increasing at row ${i}`);
    if (!(Number.isFinite(price) && price > 0)) throw new Error(`${label}: invalid close at row ${i}`);
    time[i] = t; close[i] = price; previous = t;
  }
  if ((rows ? time[0] : null) !== entry.firstClose || (rows ? time[rows - 1] : null) !== entry.lastClose)
    throw new Error(`${label}: first/last close disagree with the manifest`);
  return {time, close};
}

// One asset's minute closes across ALL complete months of the manifest, {time: Float64Array, close: Float64Array},
// strictly increasing. Every complete month is verified (readMonth) on every call, whatever the filter;
// {fromClose, toClose} then keeps closes with fromClose <= time <= toClose (both inclusive, both optional).
export function loadSeries(dir = DEFAULT_DIR, asset, {fromClose = -Infinity, toClose = Infinity} = {}) {
  assertAsset(asset);
  if (typeof fromClose !== 'number' || typeof toClose !== 'number' || Number.isNaN(fromClose) || Number.isNaN(toClose))
    throw new Error('fromClose and toClose must be millisecond timestamps');
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`${manifestPath(dir)}: no manifest; fetch with research/fetch-candles.mjs first`);
  const months = Object.entries(manifest.assets[asset]?.months ?? {})
    .filter(([, entry]) => entry.complete === true).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!months.length) throw new Error(`${asset}: no complete months in ${dir}`);
  const parts = [];
  let total = 0, previous = -Infinity;
  for (const [month, entry] of months) {
    const {time, close} = readMonth(dir, asset, month, entry);
    if (!time.length) continue;
    if (!(time[0] > previous)) throw new Error(`${asset} ${month}: overlaps the month before it`);
    previous = time[time.length - 1];
    const from = lowerBound(time, fromClose), to = lowerBound(time, toClose, true);
    if (to > from) { parts.push([time.subarray(from, to), close.subarray(from, to)]); total += to - from; }
  }
  const time = new Float64Array(total), close = new Float64Array(total);
  let offset = 0;
  for (const [t, c] of parts) { time.set(t, offset); close.set(c, offset); offset += t.length; }
  return {time, close};
}

// The same shape from [[timeMs, close], ...] (the bundled sample, synthetic series). Times must be strictly
// increasing minute closes and closes finite and positive, as market.js demands of the sample ("Replay times must
// increase", "Invalid market price"). No exploration bounds apply here: this never touches the candle store, and
// the bundled sample lies outside them.
export function seriesFromRows(rows) {
  if (!Array.isArray(rows)) throw new Error('seriesFromRows: rows must be an array of [timeMs, close]');
  const time = new Float64Array(rows.length), close = new Float64Array(rows.length);
  let previous = -Infinity;
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== 2) throw new Error(`seriesFromRows: row ${i} is not [timeMs, close]`);
    const [t, price] = row;
    if (!Number.isSafeInteger(t) || t % MINUTE || !(t > previous)) throw new Error(`seriesFromRows: times must be strictly increasing minute closes (row ${i})`);
    if (typeof price !== 'number' || !Number.isFinite(price) || !(price > 0)) throw new Error(`seriesFromRows: invalid close (row ${i})`);
    time[i] = t; close[i] = price; previous = t;
  });
  return {time, close};
}

// First index whose time is >= t (or > t with `after`), by binary search over a strictly increasing array.
function lowerBound(time, t, after = false) {
  let low = 0, high = time.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time[middle] < t || (after && time[middle] === t)) low = middle + 1; else high = middle;
  }
  return low;
}

// Minute closes in [startClose, endClose], both inclusive: how many the range holds (expected), how many each asset
// observed, and how many both observed (shared: the minutes a replay scores, replay.js builds a frame only where
// `maps.LINK.has(row.time)`). Same counting as replay.js coverage: expectedCount = (e-s)/MINUTE+1. An observation
// that is not a minute close is refused, not counted: it would make coverage exceed what the range can hold.
export function coverage(market, startClose, endClose) {
  if (![startClose, endClose].every(t => Number.isSafeInteger(t) && t % MINUTE === 0) || endClose < startClose)
    throw new Error('coverage: startClose and endClose must be UTC minute closes with startClose <= endClose');
  const expected = (endClose - startClose) / MINUTE + 1, observed = {}, span = {};
  for (const asset of ASSETS) {
    const time = market?.[asset]?.time;
    if (!(time instanceof Float64Array)) throw new Error(`coverage: market.${asset} is not a series`);
    const from = lowerBound(time, startClose), to = lowerBound(time, endClose, true);
    for (let i = from; i < to; i++)
      if (time[i] % MINUTE || (i > from && !(time[i] > time[i - 1]))) throw new Error(`coverage: ${asset} times must be strictly increasing minute closes`);
    observed[asset] = to - from; span[asset] = {time, from, to};
  }
  let shared = 0, i = span.BTC.from, j = span.LINK.from;
  const btc = span.BTC.time, link = span.LINK.time;
  while (i < span.BTC.to && j < span.LINK.to) {
    if (btc[i] < link[j]) i++;
    else if (btc[i] > link[j]) j++;
    else { shared++; i++; j++; }
  }
  return {expected, observed, shared, sharedFraction: shared / expected};
}

// The manifest content suitable for committing: format, source, bounds and each complete month's row count, close
// range, request count, fetch time and SHA-256, months in time order. No receipts, no request URLs, no local paths.
export function publicManifest(dir = DEFAULT_DIR) {
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`${manifestPath(dir)}: no manifest; fetch with research/fetch-candles.mjs first`);
  const assets = {};
  for (const asset of ASSETS) {
    if (!manifest.assets[asset]) continue;
    const months = {};
    for (const month of Object.keys(manifest.assets[asset].months).sort()) {
      const entry = manifest.assets[asset].months[month];
      if (entry.complete !== true) continue;
      months[month] = {rows: entry.rows, firstClose: entry.firstClose, lastClose: entry.lastClose, sha256: entry.sha256,
        requests: entry.requests, fetchedAt: entry.fetchedAt, complete: true,
        from: entry.from, to: entry.to, duplicateRows: entry.duplicateRows};
    }
    assets[asset] = {months};
  }
  return {format: manifest.format, source: manifest.source, bounds: {...manifest.bounds}, assets};
}
