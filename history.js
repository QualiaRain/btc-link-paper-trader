// Browser-local run records. No network, credentials, or automatic pruning.
import {getSummary} from './engine.js';

const DATABASE = 'paper-trail.runs.v2';
const FORMAT = 'paper-trail-run-v2';
const ENCODING = 'history-catalog-v1';
let databasePromise;

export function canonicalJSON(value) {
  function normalize(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Run evidence contains a non-finite number');
      return item;
    }
    if (Array.isArray(item)) return item.map(v => v === undefined ? null : normalize(v));
    if (item && typeof item === 'object') {
      const output = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) output[key] = normalize(item[key]);
      }
      return output;
    }
    throw new Error('Run evidence must contain JSON values');
  }
  return JSON.stringify(normalize(value));
}

const copy = value => JSON.parse(canonicalJSON(value));

async function digest(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Evidence hashing requires HTTPS or localhost');
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Every original observation and each frame's exact history membership survives.
// Shared close rows alone cannot reproduce nonshared candles or warmup evidence.
function packDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.frames) || dataset.historyEncoding === ENCODING) return dataset;
  const catalogs = {}, indexes = {}, observationKeys = new WeakMap();
  const frames = dataset.frames.map(frame => {
    const {history, ...rest} = frame;
    if (!history) return rest;
    const historyRefs = {};
    for (const [asset, rows] of Object.entries(history)) {
      if (!Array.isArray(rows)) throw new Error('Invalid frame history');
      catalogs[asset] ??= [];
      indexes[asset] ??= new Map();
      const refs = rows.map(row => {
        // Lazy replay slices reuse observation objects. Cache their canonical key
        // so a 31-day, 240-interval run does not serialize each row 241 times.
        let key = row && typeof row === 'object' ? observationKeys.get(row) : undefined;
        if (key === undefined) {
          key = canonicalJSON(row);
          if (row && typeof row === 'object') observationKeys.set(row, key);
        }
        if (!indexes[asset].has(key)) {
          indexes[asset].set(key, catalogs[asset].length);
          catalogs[asset].push(row);
        }
        return indexes[asset].get(key);
      });
      historyRefs[asset] = refs.every((ref, i) => ref === refs[0] + i)
        ? {start: refs[0] ?? 0, length: refs.length} : {indices: refs};
    }
    return {...rest, historyRefs};
  });
  return {...dataset, frames, historyEncoding: ENCODING, historyCatalog: catalogs};
}

function unpackDataset(dataset) {
  if (!dataset || dataset.historyEncoding !== ENCODING) return dataset;
  const {historyEncoding, historyCatalog, ...rest} = dataset;
  if (!historyCatalog || !Array.isArray(rest.frames)) throw new Error('Invalid packed market evidence');
  const frames = rest.frames.map(frame => {
    const {historyRefs, ...other} = frame;
    if (!historyRefs) return other;
    const history = {};
    for (const [asset, refs] of Object.entries(historyRefs)) {
      const catalog = historyCatalog[asset];
      if (!Array.isArray(catalog)) throw new Error('Missing history catalog');
      const ids = Array.isArray(refs.indices) ? refs.indices
        : Number.isSafeInteger(refs.start) && Number.isSafeInteger(refs.length) && refs.start >= 0 && refs.length >= 0
          ? Array.from({length: refs.length}, (_, i) => refs.start + i) : null;
      if (!ids || ids.some(i => !Number.isSafeInteger(i) || i < 0 || i >= catalog.length))
        throw new Error('Invalid history reference');
      history[asset] = ids.map(i => catalog[i]);
    }
    return {...other, history};
  });
  return {...rest, frames};
}

export function packMarket(market) {
  if (!market) return null;
  let result = {...market};
  if (market.dataset) result.dataset = packDataset(market.dataset);
  if (Array.isArray(market.frames)) result = packDataset(result);
  return result;
}

export function unpackMarket(market) {
  if (!market) return null;
  let result = unpackDataset(market);
  if (result.dataset) result = {...result, dataset: unpackDataset(result.dataset)};
  return result;
}

function validateRecord(record) {
  if (record?.format !== FORMAT || typeof record.id !== 'string' || !/^[\w.-]{1,128}$/.test(record.id))
    throw new Error('Invalid run record');
  if (!record.account?.config || !Array.isArray(record.account.ledger) || !Array.isArray(record.account.equity)
      || !record.summary || !record.hashes?.configSha256 || !record.hashes?.marketSha256)
    throw new Error('Incomplete run record');
}

export async function makeRunRecord({id, name, account, market}) {
  if (!account?.config || !Array.isArray(account.ledger)) throw new Error('No account to save');
  const snapshot = copy(account);
  const packedMarket = copy(packMarket(market));
  const now = new Date().toISOString();
  const runId = id ?? crypto.randomUUID();
  const label = String(name ?? `${snapshot.config.mode} · ${snapshot.startedAt === null ? now : new Date(snapshot.startedAt).toISOString()}`).trim().slice(0, 100);
  const config = copy(snapshot.config);
  const [configSha256, marketSha256] = await Promise.all([digest(config), digest(packedMarket)]);
  const record = {format: FORMAT, id: runId, name: label || 'Unnamed run', createdAt: now, updatedAt: now,
    status: snapshot.status, config, summary: getSummary(snapshot), account: snapshot,
    market: packedMarket, hashes: {algorithm: 'SHA-256 / canonical JSON', configSha256, marketSha256},
    manualTradeCount: snapshot.ledger.filter(e => e.type === 'trade' && e.actor === 'manual').length};
  validateRecord(record);
  return record;
}

export function exportRun(record) {
  validateRecord(record);
  return copy({...record, market: packMarket(record.market)});
}

const COVERAGE_KEYS = ['expectedCount', 'observedCount', 'missingCount', 'warmupObservedCount'];

// The per-asset counts of a dataset's coverage block (sample window or scored date range), or null without one.
// Only the counts travel with history listings; the missing minutes themselves stay in the exported record.
export function coverageSummary(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  const out = {};
  for (const asset of ['BTC', 'LINK']) {
    const item = coverage[asset];
    if (!item || typeof item !== 'object' || !COVERAGE_KEYS.every(key => Number.isFinite(item[key]))) return null;
    out[asset] = Object.fromEntries(COVERAGE_KEYS.map(key => [key, item[key]]));
  }
  return out;
}

const receiptCount = dataset => (Array.isArray(dataset?.provenance) ? dataset.provenance.length : 0);

export function runMetadata(record) {
  validateRecord(record);
  const market = record.market ?? {};
  return {id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt,
    status: record.status, config: record.config, summary: record.summary, hashes: record.hashes,
    manualTradeCount: record.manualTradeCount, source: market.source ?? market.dataset?.source ?? market.kind ?? 'Supplied observations',
    scoreStart: market.scoreStart ?? market.dataset?.scoreStart ?? record.account.startedAt,
    scoreEnd: market.scoreEnd ?? market.dataset?.scoreEnd ?? record.summary.valuationAt,
    kind: market.kind ?? null,
    coverage: coverageSummary(market.dataset?.coverage ?? market.coverage),
    receiptCount: receiptCount(market.dataset) || receiptCount(market)};
}

function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Run history storage is unavailable. Export the current run to keep it.'));
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const name of ['runs', 'metadata'])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath: 'id'});
    };
    request.onerror = () => reject(new Error(`Could not open run history: ${request.error?.message ?? 'storage denied'}`));
    request.onblocked = () => reject(new Error('Run history is blocked by another tab. Close it or export this run.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {db.close(); databasePromise = undefined;};
      resolve(db);
    };
  }).catch(error => {databasePromise = undefined; throw error;});
  return databasePromise;
}

export async function saveRun(record) {
  const saved = exportRun(record);
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['runs', 'metadata'], 'readwrite');
    const runs = transaction.objectStore('runs');
    const existing = transaction.objectStore('metadata').get(saved.id);
    existing.onsuccess = () => {
      try {
        if (existing.result) saved.createdAt = existing.result.createdAt;
        runs.put(saved);
        transaction.objectStore('metadata').put(runMetadata(saved));
      } catch (error) {transaction.abort(); reject(error);}
    };
    transaction.oncomplete = () => resolve(saved.id);
    transaction.onerror = transaction.onabort = () => reject(new Error(`Run was not saved (${transaction.error?.message ?? 'storage unavailable or full'}). Export it before starting another run.`));
  });
}

async function readStore(name, id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, 'readonly');
    const request = id === undefined ? transaction.objectStore(name).getAll() : transaction.objectStore(name).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not read saved runs'));
  });
}

export async function listRuns() {
  const rows = await readStore('metadata');
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function getRun(id) {
  const record = await readStore('runs', id);
  if (!record) throw new Error('Saved run not found');
  validateRecord(record);
  return {...record, market: unpackMarket(record.market)};
}

export async function exportAllRuns() {
  const records = await readStore('runs');
  return {format: 'paper-trail-history-v2', exportedAt: new Date().toISOString(),
    notice: 'Browser-local paper runs; partial and manually modified runs are labeled. Not a tamper-proof record.',
    runs: records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(exportRun)};
}
