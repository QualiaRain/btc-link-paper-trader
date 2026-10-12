// End to end: the compiled TypeScript client talks over real HTTP to the real Python API
// (uvicorn in a child process, ephemeral port, temp run directory). No mocks, no network
// beyond loopback. Needs `python3` with backend dependencies (override with $PYTHON).
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ApiError, PaperTrailClient, type RunRecord} from '../src/client.ts';
import {repo, startApi, type RunningApi} from './server.ts';

const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(repo(path), 'utf8')) as T;

let api: RunningApi;
let client: PaperTrailClient;
let baseUrl: string;

before(async () => {
  api = await startApi();
  baseUrl = api.baseUrl;
  client = new PaperTrailClient({baseUrl});
});

after(() => api?.stop());

describe('TypeScript client against the running Python API', () => {
  it('reports health, v1, and the preserved defaults', async () => {
    const health = await client.health();
    assert.deepEqual(health, {status: 'ok', apiVersion: '1', engine: 'paper-trail-python', realTrading: false});
    const {settings, horizonsMs} = await client.defaults();
    assert.equal(settings.config.initialCash, 1000);
    assert.equal(settings.config.horizonMs, 420000);
    assert.equal(settings.config.lookbackIntervals, 7);
    assert.equal(settings.config.feeBps, 10);
    assert.equal(settings.config.slippageBps, 2);
    assert.equal(settings.replay.halfSpreadBps, 2);
    assert.deepEqual(horizonsMs, [60000, 300000, 420000, 900000, 3600000, 25200000, 86400000]);
  });

  it('replays the included sample, matches the JavaScript golden result, and exports results and settings', async () => {
    const result = await client.createReplay({settings: {config: {}}, name: 'e2e default sample'});
    const golden = readJson('parity/expected/sample-replay.json').scenarios.defaults;
    assert.equal(result.run.name, 'e2e default sample');
    assert.equal(result.summary.status, 'completed');
    assert.equal(result.summary.settledForecasts, golden.summary.settledForecasts);
    assert.equal(result.summary.tradeCount, golden.summary.tradeCount);
    assert.ok(Math.abs(result.summary.equity - golden.summary.equity) < 1e-9, `${result.summary.equity} vs JS ${golden.summary.equity}`);
    assert.ok(Math.abs(result.summary.buyHoldEquity - golden.summary.buyHoldEquity) < 1e-9);
    assert.equal(result.account.positions.BTC.qty + result.account.positions.LINK.qty, 0);

    const exported: RunRecord = await client.exportRun(result.run.id);
    assert.equal(exported.format, 'paper-trail-run-v2');
    assert.equal(exported.id, result.run.id);
    assert.deepEqual(exported.summary, result.summary);
    assert.equal(exported.account.ledger.length, result.account.ledger.length);
    assert.match(exported.hashes.configSha256, /^[0-9a-f]{64}$/);

    // The evidence hash is the browser app's: history.js canonicalJSON + SHA-256 over the frozen config.
    const {canonicalJSON} = await import(repo('history.js')) as {canonicalJSON: (v: unknown) => string};
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(exported.config)))).toString('hex');
    assert.equal(exported.hashes.configSha256, digest);

    const settings = await client.exportSettings(result.run.id);
    assert.equal(settings.format, 'paper-trail-settings-v2');
    assert.equal(settings.config.initialCash, 1000);
    assert.deepEqual(await client.normalizeSettings(settings), settings);

    assert.ok((await client.listRuns()).some(run => run.id === result.run.id));
    assert.equal((await client.getRun(result.run.id)).hashes.marketSha256, exported.hashes.marketSha256);
  });

  it('applies configured horizon, risk and cost settings', async () => {
    const result = await client.createReplay({settings: {
      config: {initialCash: 2500, horizonMs: 900000, lookbackIntervals: 20, feeBps: 25, slippageBps: 10, bufferBps: 5, stopLossBps: 120, allocationFraction: 0.4},
      replay: {source: 'sample', halfSpreadBps: 3.5}}});
    const golden = readJson('parity/expected/sample-replay.json').scenarios['lookback-20-fifteen-minute-horizon'];
    assert.equal(result.summary.cashBenchmark, 2500);
    assert.equal(result.account.config.horizonMs, 900000);
    assert.equal(result.account.config.stopLossBps, 120);
    assert.notEqual(result.summary.equity, golden.summary.equity); // different costs/risk from the golden scenario
  });

  it('replays a UTC date range from supplied candles with per-asset warmup', async () => {
    const start = Date.UTC(2024, 2, 9, 12), minute = 60000;
    const rows = (first: number, last: number, base: number) => {
      const out = [];
      for (let t = first; t <= last; t += minute) out.push({time: t, price: base * (1 + 0.0001 * Math.sin(t / minute / 9) + 0.00002 * (t - start) / minute)});
      return out;
    };
    const settings = {config: {horizonMs: 300000}, replay: {source: 'range' as const, start: '2024-03-09T12:00', end: '2024-03-09T13:00', halfSpreadBps: 2}};
    const result = await client.createReplay({settings, candles: {BTC: rows(start - 120 * minute, start + 60 * minute, 61000), LINK: rows(start - 120 * minute, start + 60 * minute, 19)}});
    assert.equal(result.account.startedAt, start);
    assert.equal(result.account.endsAt, start + 60 * minute);
    assert.equal(result.summary.status, 'completed');
    assert.ok(result.summary.forecastCount > 0);
    await assert.rejects(client.createReplay({settings, candles: {BTC: rows(start - 120 * minute, start + 60 * minute, 61000), LINK: rows(start - 2 * minute, start + 60 * minute, 19)}}),
      (error: unknown) => error instanceof ApiError && error.status === 422 && /LINK: only 3 causal observations/.test(error.message));
  });

  it('does not call fetch with the client as its receiver (browsers throw "Illegal invocation")', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      assert.ok(this === undefined || this === globalThis, 'fetch must not be invoked as a client method');
      return original(...args);
    } as typeof fetch;
    try { assert.equal((await new PaperTrailClient({baseUrl}).health()).status, 'ok'); }
    finally { globalThis.fetch = original; }
  });

  it('surfaces validation failures as typed ApiError values without creating runs', async () => {
    const before = (await client.listRuns()).length;
    await assert.rejects(client.createReplay({settings: {config: {horizonMs: 1234}}}),
      (error: unknown) => error instanceof ApiError && error.status === 422 && error.code === 'replay_rejected' && /supported forecast horizons/.test(error.message));
    await assert.rejects(client.normalizeSettings({config: {allocationFraction: 0.9}}),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_settings' && /allocationFraction/.test(error.message));
    await assert.rejects(client.exportRun('missing'), (error: unknown) => error instanceof ApiError && error.status === 404);
    assert.equal((await client.listRuns()).length, before);
  });

  it('imports runs saved by the existing browser app and exports them unchanged', async () => {
    for (const name of ['browser-run-completed', 'browser-run-partial-manual']) {
      const saved = readJson<RunRecord>(`parity/fixtures/${name}.json`);
      const meta = await client.importRun(saved);
      assert.equal(meta.id, saved.id);
      assert.equal(meta.manualTradeCount, saved.manualTradeCount);
      const back = await client.exportRun(saved.id);
      assert.deepEqual(back.hashes, saved.hashes);
      assert.deepEqual(back.account.ledger, saved.account.ledger);
    }
    await assert.rejects(client.importRun({...readJson('parity/fixtures/browser-run-completed.json'), config: {feeBps: 1}}),
      (error: unknown) => error instanceof ApiError && error.status === 422);
  });
});
