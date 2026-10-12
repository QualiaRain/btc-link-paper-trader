// Independent JS-parity oracle. It replays an action list through the ROOT engine.js and
// configuration.js (the original browser app's modules, imported dynamically), over frames built
// exactly like app.js start() does for the included sample: cursor = lookback, half-spread quotes
// around candle closes, 300-row causal histories. It shares no code with the Python backend or
// with the TypeScript client/UI, so agreement between them is real evidence of parity.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {candleRows, type Gaps} from './fake-exchange.ts';
import {repo} from './server.ts';

type Json = any; // the root modules are untyped JavaScript

interface Engine {
  createAccount(config: object): Json;
  ingest(account: Json, frame: Json): Json;
  manualTrade(account: Json, asset: string, side: string, dollars: number, frame: Json): Json;
  getSummary(account: Json): Json;
}
interface Configuration { normalizeSettings(input: object): Json }

export type Action =
  | {kind: 'frames'; count: number}
  | {kind: 'decision'}
  | {kind: 'finish'}
  | {kind: 'order'; asset: 'BTC' | 'LINK'; side: 'buy' | 'sell'; dollars?: number};

export interface OracleSnapshot {
  time: number;
  cursor: number;
  frameCount: number;
  status: string;
  cash: number;
  qty: {BTC: number; LINK: number};
  equity: number;
  buyHold: number;
  fees: number;
  tradeCount: number;
  ledgerLength: number;
  ledgerCounts: Record<string, number>;
  lastDecisionAt: number | null;
  scoreStart: number;
  scoreEnd: number;
}

export interface Oracle {
  readonly scoreStart: number;
  readonly scoreEnd: number;
  readonly lookback: number;
  /** Apply one action. An order the engine refuses returns {rejected} and leaves the account untouched. */
  apply(action: Action): {framesIngested: number; rejected?: string};
  snapshot(): OracleSnapshot;
  /** The account's ledger rows, for event-level comparison. */
  ledger(): Json[];
  /** The root engine's live account object (positions with cost basis, forecasts, equity series, ledger). Read only. */
  account(): Json;
  /** The root engine's getSummary() for the current account. */
  summary(): Json;
  /** The latest frame's quotes (what a UI may use to value positions). */
  quotes(): Record<'BTC' | 'LINK', {bid: number; ask: number; mid: number}>;
  /** Cursor the next `decision` action would stop at, without applying it. */
  decisionTarget(): number;
}

let modules: Promise<{engine: Engine; configuration: Configuration; prices: [number, number, number][]}> | undefined;
function load() {
  modules ??= (async () => ({
    engine: await import(repo('engine.js')) as Engine,
    configuration: await import(repo('configuration.js')) as Configuration,
    prices: JSON.parse(readFileSync(repo('data/sample.json'), 'utf8')).prices as [number, number, number][],
  }))();
  return modules;
}

/** `request` is the SettingsInput the API/UI is given (config + replay), normalized by the JS rules. */
export async function createOracle(request: {config?: object; replay?: object} = {config: {}}): Promise<Oracle> {
  const {engine, configuration, prices} = await load();
  const settings = configuration.normalizeSettings({config: {}, ...request});
  const half = settings.replay.halfSpreadBps / 10000;
  const histories: Record<string, {time: number; price: number}[]> = {BTC: [], LINK: []};
  const frames = prices.map(([time, btc, link]) => {
    const quotes: Record<string, object> = {};
    for (const [asset, mid] of [['BTC', btc], ['LINK', link]] as const) {
      histories[asset]!.push({time, price: mid});
      if (histories[asset]!.length > 300) histories[asset]!.shift();
      quotes[asset] = {bid: mid * (1 - half), ask: mid * (1 + half), mid, observedAt: time, receivedAt: time, exchangeTime: time,
        source: `Historical Coinbase candle close with ASSUMED ${settings.replay.halfSpreadBps} bps half-spread`, simulatedQuote: true};
    }
    return {time, quotes, history: {BTC: histories['BTC']!.slice(), LINK: histories['LINK']!.slice()}};
  });
  const lookback = settings.config.lookbackIntervals as number; // app.js start(): nextCursor = lookbackIntervals
  assert.ok(lookback < frames.length - 1, 'sample too short for this lookback');
  return buildOracle(engine, settings.config, frames, lookback);
}

/** app.js start(): freeze the config with the scored duration, create the account and ingest the first scored frame. */
function buildOracle(engine: Engine, baseConfig: Json, frames: Json[], startCursor: number): Oracle {
  const config = {...baseConfig};
  let cursor = startCursor;
  const scoreStart = frames[cursor]!.time, scoreEnd = frames.at(-1)!.time;
  config.durationMs = scoreEnd - scoreStart;
  const account = engine.createAccount(config);
  let frame = frames[cursor]!;
  engine.ingest(account, frame);

  // app.js ingestNext()
  const ingestNext = (): boolean => {
    if (cursor >= frames.length - 1) return false;
    frame = frames[++cursor]!;
    engine.ingest(account, frame);
    return true;
  };
  const snapshot = (): OracleSnapshot => {
    const s = engine.getSummary(account);
    const counts: Record<string, number> = {};
    for (const e of account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return {time: frame.time, cursor, frameCount: frames.length, status: account.status, cash: account.cash,
      qty: {BTC: account.positions.BTC.qty, LINK: account.positions.LINK.qty}, equity: s.equity, buyHold: s.buyHoldEquity,
      fees: s.fees, tradeCount: s.tradeCount, ledgerLength: account.ledger.length, ledgerCounts: counts,
      lastDecisionAt: account.lastDecisionAt, scoreStart, scoreEnd};
  };
  // app.js replayWork('step') stops at the first frame at or after lastDecisionAt + horizon (or the end/completion).
  const target = (): number => (account.lastDecisionAt ?? frame.time) + account.config.horizonMs;

  return {
    scoreStart, scoreEnd, lookback: config.lookbackIntervals,
    snapshot, ledger: () => account.ledger, decisionTarget: target,
    account: () => account, summary: () => engine.getSummary(account), quotes: () => frame.quotes as never,
    apply(action) {
      if (action.kind === 'order') {
        const before = JSON.stringify(account);
        try {
          engine.manualTrade(account, action.asset, action.side, action.dollars ?? Number.MAX_VALUE, frame); // app.js order()
        } catch (error) {
          assert.equal(JSON.stringify(account), before, 'a refused order must not change the account');
          return {framesIngested: 0, rejected: (error as Error).message};
        }
        return {framesIngested: 0};
      }
      let framesIngested = 0;
      const until = target();
      for (;;) {
        if (action.kind === 'frames' && framesIngested >= action.count) break;
        if (!ingestNext()) break;
        framesIngested++;
        if (account.status === 'completed' || cursor >= frames.length - 1) break;
        if (action.kind === 'decision' && frame.time >= until) break;
      }
      return {framesIngested};
    },
  };
}

const NEAR = 1e-9;
const near = (actual: number, expected: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= NEAR, `${what}: ${actual} vs oracle ${expected}`);

/** The API/UI view of an account that the oracle can be compared with. */
export interface Observed {
  time: number;
  cursor: number;
  status: string;
  cash: number;
  qty: {BTC: number; LINK: number};
  equity: number;
  buyHold: number;
  fees: number;
  tradeCount: number;
  ledgerCounts?: Record<string, number>;
}

/** Fails unless the observed session matches the oracle to 1e-9 (counts exactly). */
export function assertParity(oracle: Oracle, observed: Observed, label = 'session'): void {
  const want = oracle.snapshot();
  assert.equal(observed.time, want.time, `${label}: clock`);
  assert.equal(observed.cursor, want.cursor, `${label}: cursor`);
  assert.equal(observed.status === 'completed', want.status === 'completed', `${label}: completed`);
  near(observed.cash, want.cash, `${label}: cash`);
  near(observed.qty.BTC, want.qty.BTC, `${label}: BTC qty`);
  near(observed.qty.LINK, want.qty.LINK, `${label}: LINK qty`);
  near(observed.equity, want.equity, `${label}: equity`);
  near(observed.buyHold, want.buyHold, `${label}: buy-and-hold`);
  near(observed.fees, want.fees, `${label}: fees`);
  assert.equal(observed.tradeCount, want.tradeCount, `${label}: trade count`);
  if (observed.ledgerCounts) assert.deepEqual(observed.ledgerCounts, want.ledgerCounts, `${label}: ledger event counts`);
}

/** Builds `Observed` from a session state and (optionally) its full ledger. */
export function observe(state: {currentFrame: {time: number}; cursor: number; status: string; summary: Json}, ledger?: {type: string}[]): Observed {
  const counts: Record<string, number> = {};
  for (const e of ledger ?? []) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const s = state.summary;
  return {time: state.currentFrame.time, cursor: state.cursor, status: state.status, cash: s.cash,
    qty: {BTC: s.perAsset.BTC.qty, LINK: s.perAsset.LINK.qty}, equity: s.equity, buyHold: s.buyHoldEquity, fees: s.fees,
    tradeCount: s.tradeCount, ...(ledger ? {ledgerCounts: counts} : {})};
}

export interface RangeOracle extends Oracle {
  /** Requests the root replay.js made to the stubbed exchange (one per chunk and asset). */
  readonly fetchCount: number;
  readonly dataset: Json;
}

/**
 * A date-range replay built the way app.js start() builds one: the ROOT replay.js `fetchHistoricalRange` retrieves the
 * series (global fetch stubbed to the same deterministic exchange series the fake server serves, like
 * parity/harness.mjs), then the root engine.js replays it. `request.replay` must have source 'range'.
 */
export async function createRangeOracle(request: {config?: object; replay: {source: 'range'; start: string; end: string; halfSpreadBps?: number}}, gaps: Gaps = {}): Promise<RangeOracle> {
  const {engine, configuration} = await load();
  const replayModule = await import(repo('replay.js')) as {fetchHistoricalRange(options: object): Promise<Json>};
  const settings = configuration.normalizeSettings({config: {}, ...request});
  const config = settings.config;
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url)), asset = u.pathname.includes('LINK-USD') ? 'LINK' : 'BTC';
    fetchCount++;
    const rows = candleRows(asset, Date.parse(u.searchParams.get('start')!), Date.parse(u.searchParams.get('end')!), gaps);
    return {ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(rows)};
  }) as typeof fetch;
  let dataset: Json;
  try {
    dataset = await replayModule.fetchHistoricalRange({start: Date.parse(`${settings.replay.start}:00Z`), end: Date.parse(`${settings.replay.end}:00Z`),
      halfSpreadBps: settings.replay.halfSpreadBps, warmupMinutes: Math.max(60, 2 * config.lookbackIntervals + 10), historyLimit: config.lookbackIntervals + 1,
      requiredHistory: config.model === 'trend' ? config.lookbackIntervals + 1 : 0});
  } finally { globalThis.fetch = original; }
  const oracle = buildOracle(engine, config, dataset.frames, 0);
  return Object.assign(oracle, {fetchCount, dataset});
}
