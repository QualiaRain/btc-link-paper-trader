// A loopback stand-in for the public exchange endpoints the Python backend reads:
//   GET /products/{BTC|LINK}-USD/candles?granularity=60[&start=ISO&end=ISO]   (rows newest first)
//   GET /products/{BTC|LINK}-USD/ticker
// Prices come from one deterministic series (`closeAt`), also used by the test oracle, so the server
// and the independent JS replay see exactly the same market. Failures and delays can be injected per
// request, and every request is logged. Nothing here talks to the internet.
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

export const MINUTE = 60000;
export type Asset = 'BTC' | 'LINK';

/** Deterministic close price of the minute that ends at `closeTime`, rounded so JSON round-trips exactly. */
export function closeAt(asset: Asset, closeTime: number): number {
  const m = closeTime / MINUTE;
  if (asset === 'BTC') return Math.round(61000 * (1 + 0.02 * Math.sin(m / 37) + 0.0012 * Math.sin(m / 5.3) + 0.00002 * (m % 997)) * 100) / 100;
  return Math.round(19 * (1 + 0.03 * Math.sin(m / 41 + 1) + 0.0015 * Math.sin(m / 4.1) + 0.00003 * (m % 811)) * 10000) / 10000;
}

/** Minutes (as close times) that the exchange does not report for an asset. */
export type Gaps = Partial<Record<Asset, ReadonlySet<number>>>;

/** Candle rows for buckets whose START lies in [fromMs, toMs], newest first: [bucket seconds, low, high, open, close, volume]. */
export function candleRows(asset: Asset, fromMs: number, toMs: number, gaps: Gaps = {}): number[][] {
  const rows: number[][] = [];
  for (let bucket = Math.ceil(fromMs / MINUTE) * MINUTE; bucket <= toMs; bucket += MINUTE) {
    const close = closeAt(asset, bucket + MINUTE);
    if (gaps[asset]?.has(bucket + MINUTE)) continue;
    rows.push([bucket / 1000, close - 1, close + 1, close, close, 1]);
  }
  return rows.reverse();
}

export interface LoggedRequest { kind: 'candles' | 'ticker' | 'other'; asset: Asset | null; path: string; start: number | null; end: number | null; at: number }
export interface Rule {
  /** Which requests it applies to. */
  match: (request: LoggedRequest) => boolean;
  /** Answer with this HTTP status (default: normal answer). */
  status?: number;
  body?: string;
  /** Hold the answer this long (cut short by `releaseDelays()` / `stop()`). */
  delayMs?: number;
  /** Apply to this many matching requests, then stop applying (default: all). */
  times?: number;
}

export interface FakeExchange {
  baseUrl: string;
  requests: LoggedRequest[];
  gaps: Gaps;
  inject(rule: Rule): void;
  clearRules(): void;
  releaseDelays(): void;
  count(kind?: LoggedRequest['kind']): number;
  stop(): Promise<void>;
}

export async function startFakeExchange(options: {gaps?: Gaps} = {}): Promise<FakeExchange> {
  const requests: LoggedRequest[] = [];
  const rules: (Rule & {used: number})[] = [];
  const gaps: Gaps = options.gaps ?? {};
  let release = new AbortController();

  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    release.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/products\/(BTC|LINK)-USD\/(candles|ticker)$/.exec(url.pathname);
    const asset = (match?.[1] ?? null) as Asset | null;
    const kind = match ? (match[2] as 'candles' | 'ticker') : 'other';
    const start = url.searchParams.get('start'), end = url.searchParams.get('end');
    const logged: LoggedRequest = {kind, asset, path: request.url ?? '', start: start ? Date.parse(start) : null, end: end ? Date.parse(end) : null, at: Date.now()};
    requests.push(logged);
    const rule = rules.find(r => r.match(logged) && (r.times === undefined || r.used < r.times));
    if (rule) {
      rule.used++;
      if (rule.delayMs) await sleep(rule.delayMs);
      if (rule.status !== undefined) {
        response.writeHead(rule.status, {'content-type': 'application/json'}).end(rule.body ?? '{}');
        return;
      }
    }
    if (!asset || kind === 'other') { response.writeHead(404, {'content-type': 'application/json'}).end('{"message":"NotFound"}'); return; }
    const now = Date.now();
    let body: unknown;
    if (kind === 'ticker') {
      const mid = closeAt(asset, Math.floor(now / MINUTE) * MINUTE + MINUTE);
      body = {trade_id: now, price: String(mid), size: '0.01', time: new Date(now).toISOString(), bid: String(Math.round(mid * 0.9999 * 10000) / 10000),
        ask: String(Math.round(mid * 1.0001 * 10000) / 10000), volume: '1'};
    } else if (logged.start !== null && logged.end !== null) {
      body = candleRows(asset, logged.start, logged.end, gaps);
    } else {
      body = candleRows(asset, Math.floor(now / MINUTE) * MINUTE - 299 * MINUTE, Math.floor(now / MINUTE) * MINUTE, gaps); // latest 300 buckets, current one included
    }
    response.writeHead(200, {'content-type': 'application/json', date: new Date().toUTCString()}).end(JSON.stringify(body));
  }

  const server: Server = createServer((request, response) => { void handle(request, response).catch(() => { response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl, requests, gaps,
    inject: rule => { rules.push({...rule, used: 0}); },
    clearRules: () => { rules.length = 0; },
    releaseDelays: () => { release.abort(); release = new AbortController(); },
    count: kind => requests.filter(r => kind === undefined || r.kind === kind).length,
    stop: async () => { release.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
