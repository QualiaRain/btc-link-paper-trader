// Runs the EXISTING replay.js `fetchHistoricalRange` against a stubbed global fetch that serves canned
// HTTP responses, and reduces the outcome to what the Python CandleFetcher must reproduce exactly:
// series, coverage, receipt fields except timestamps, request URLs (incl. retries), wait delays,
// progress events and error messages. No network is used.
import {fetchHistoricalRange} from '../../replay.js';

const M = 60000;
const DEFAULT_DATE = 'Tue, 02 Jan 2024 03:04:05 GMT';

// Serves `data` ({BTC:[{time,price}],LINK:[...]}) through the Coinbase candle URL shape. `scripts` overrides
// individual attempts: key `${asset}:${chunkIndex}` -> list of behaviours (the last repeats).
export function makeResponder(scenario) {
  const urls = [], chunkStarts = {BTC: [], LINK: []}, attempts = {};
  const normal = (asset, from, to, extra = []) => {
    const rows = scenario.data[asset].filter(c => c.time - M >= from && c.time - M <= to)
      .map(c => [(c.time - M) / 1000, c.price - 1, c.price + 1, c.price, c.price, 1]).reverse();
    return JSON.stringify([...rows, ...extra]);
  };
  const respond = async url => {
    urls.push(String(url));
    const u = new URL(url), asset = u.pathname.includes('LINK-USD') ? 'LINK' : 'BTC';
    const start = u.searchParams.get('start'), from = Date.parse(start), to = Date.parse(u.searchParams.get('end'));
    if (!chunkStarts[asset].includes(start)) chunkStarts[asset].push(start);
    const key = `${asset}:${chunkStarts[asset].indexOf(start)}`;
    const n = attempts[key] = (attempts[key] ?? -1) + 1;
    const list = scenario.scripts?.[key] ?? [{ok: true}];
    const step = list[Math.min(n, list.length - 1)];
    if (step.throw) throw new TypeError('Failed to fetch');
    const headers = new Headers(step.headers ?? {date: DEFAULT_DATE});
    let body, status = step.status ?? 200;
    if (step.body !== undefined) body = step.body;
    else if (step.rows) body = JSON.stringify(step.rows);
    else body = normal(asset, from, to, step.extraRows ?? []);
    return {ok: status >= 200 && status < 300, status, headers, text: async () => body};
  };
  return {respond, urls};
}

function describeError(error) {
  if (error instanceof SyntaxError) return {kind: 'syntax'};
  if (error instanceof TypeError) return {kind: 'network'};
  const out = {kind: 'error', message: error.message, retryable: error.retryable ?? null};
  if (error.coverage) out.coverage = JSON.parse(JSON.stringify(error.coverage));
  return out;
}

export async function runFetch(scenario) {
  const realFetch = globalThis.fetch, realSetTimeout = globalThis.setTimeout;
  const {respond, urls} = makeResponder(scenario);
  const delays = [], progress = [];
  globalThis.fetch = respond;
  // Waits (350 ms spacing, 500/1000 ms back-off) run instantly but are recorded; the 15 s request timeout stays real.
  globalThis.setTimeout = (fn, ms, ...args) => ms >= 15000 ? realSetTimeout(fn, ms, ...args) : (delays.push(ms), realSetTimeout(fn, 0, ...args));
  try {
    const dataset = await fetchHistoricalRange({...scenario.params,
      onProgress: p => progress.push([p.phase, p.completed, p.total, p.asset ?? null, p.message])});
    const rows = dataset.evidence.rawResponses;
    return {series: dataset.evidence.prices, coverage: dataset.coverage,
      provenance: dataset.provenance.map((p, i) => ({asset: p.asset, url: p.url, httpDate: p.httpDate, sha256: p.sha256,
        attempts: p.attempts, rowCount: rows[i].rows.length})),
      sharedCount: dataset.frames.length, requests: urls, delays, progress};
  } catch (error) {
    return {error: describeError(error), requests: urls, delays};
  } finally { globalThis.fetch = realFetch; globalThis.setTimeout = realSetTimeout; }
}

export async function runCase(testCase) {
  const out = {};
  for (const scenario of testCase.scenarios) out[scenario.name] = JSON.parse(JSON.stringify(await runFetch(scenario)));
  return {name: testCase.name, kind: testCase.kind, scenarios: out};
}
