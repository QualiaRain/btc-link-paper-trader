// The TypeScript client against the real Python API with a loopback fake exchange behind it:
// date-range replays through candle jobs (checked against the ROOT replay.js + engine.js) and live paper sessions.
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, PaperTrailClient, type CandleJob, type SessionState} from '../src/client.ts';
import {startFakeExchange, MINUTE, type FakeExchange} from './fake-exchange.ts';
import {assertParity, createRangeOracle, observe} from './oracle.ts';
import {startApi, type RunningApi} from './server.ts';
import {verifyRecord} from './verify.ts';

let api: RunningApi;
let fake: FakeExchange;
let client: PaperTrailClient;
before(async () => {
  fake = await startFakeExchange();
  api = await startApi({env: {PAPER_TRAIL_CANDLE_BASE_URL: fake.baseUrl, PAPER_TRAIL_LIVE_BASE_URL: fake.baseUrl}});
  client = new PaperTrailClient({baseUrl: api.baseUrl});
});
after(async () => { api?.stop(); await fake?.stop(); });

const SHORT = {start: '2024-03-09T12:00', end: '2024-03-09T13:00'};
const LONG = {start: '2024-03-09T08:00', end: '2024-03-09T15:00'};
const TRADING = {bufferBps: 0, horizonMs: 300000, feeBps: 1, slippageBps: 0};
const rangeSettings = (range: {start: string; end: string}, config: object = {}) => ({config, replay: {source: 'range' as const, ...range, halfSpreadBps: 2}});

async function finishedJob(range: {start: string; end: string}, lookback = 7): Promise<CandleJob> {
  let job = await client.createCandleJob({...range, lookbackIntervals: lookback, model: 'trend'});
  for (let i = 0; i < 200 && job.status === 'running'; i++) { await new Promise(r => setTimeout(r, 100)); job = await client.getCandleJob(job.id); }
  return job;
}
const code = async (promise: Promise<unknown>): Promise<[number, string]> => {
  try { await promise; } catch (error) { if (error instanceof ApiError) return [error.status, error.code]; throw error; }
  throw new Error('expected an ApiError');
};

describe('date-range replays through candle jobs (fake exchange, root replay.js oracle)', () => {
  it('a completed job feeds a session equal to the root replay.js + engine.js replay, with matching receipts and a verifying record', async () => {
    const before = fake.count('candles');
    const job = await finishedJob(LONG);
    assert.equal(job.status, 'completed');
    assert.equal(job.receipts.length, fake.count('candles') - before, 'one receipt per request the exchange saw');
    assert.equal(job.receipts.length, 4);
    assert.equal((job.coverage as any).BTC.missingCount, 0);
    const oracle = await createRangeOracle(rangeSettings(LONG, TRADING));
    assert.equal(oracle.fetchCount, job.receipts.length, 'root replay.js made the same requests');
    let state: SessionState = await client.createSession({settings: rangeSettings(LONG, TRADING), candleJobId: job.id, name: 'range e2e'});
    assert.equal(state.kind, 'historical');
    assert.equal(state.scoreStart, Date.parse(`${LONG.start}:00Z`));
    assert.equal(state.scoreEnd, Date.parse(`${LONG.end}:00Z`));
    assertParity(oracle, observe(state, (await client.getSessionAccount(state.id)).account.ledger), 'range start');
    for (const action of [{mode: 'frames' as const, count: 5}, {mode: 'decision' as const}, {mode: 'finish' as const}]) {
      const step = await client.advance(state.id, action, state.version);
      oracle.apply(action.mode === 'frames' ? {kind: 'frames', count: action.count} : {kind: action.mode});
      state = step.state;
      assertParity(oracle, observe(state, (await client.getSessionAccount(state.id)).account.ledger), `range ${action.mode}`);
    }
    assert.equal(state.status, 'completed');
    assert.ok(oracle.snapshot().tradeCount > 0);
    const saved = await client.saveSession(state.id, state.version);
    const record = await client.exportRun(saved.run.id);
    const dataset = (record.market as any).dataset;
    assert.equal(dataset.provenance.length, fake.count('candles') - before, 'exported receipts equal the exchange request count');
    const checked = verifyRecord(record);
    assert.ok(checked.configHashOk && checked.marketHashOk && checked.historyRestored, JSON.stringify(checked));
    assert.equal(checked.futureFrames, 0);
    assert.equal(checked.scoreStart, Date.parse(`${LONG.start}:00Z`));
    await client.closeSession(state.id);
  });

  it('skips gaps in the series exactly like the root replay.js', async () => {
    const gapTimes = [Date.parse('2024-03-09T12:10:00Z'), Date.parse('2024-03-09T12:11:00Z'), Date.parse('2024-03-09T12:30:00Z')];
    fake.gaps['BTC'] = new Set(gapTimes);
    fake.gaps['LINK'] = new Set([Date.parse('2024-03-09T12:20:00Z')]);
    try {
      const job = await finishedJob(SHORT);
      assert.equal(job.status, 'completed');
      assert.equal((job.coverage as any).BTC.missingCount, 3);
      assert.equal((job.coverage as any).LINK.missingCount, 1);
      const oracle = await createRangeOracle(rangeSettings(SHORT), fake.gaps);
      const state = await client.createSession({settings: rangeSettings(SHORT), candleJobId: job.id});
      assert.equal(state.frameCount, 61 - 4, 'minutes missing for either asset are not scored');
      assert.equal(state.frameCount, oracle.snapshot().frameCount);
      const done = await client.advance(state.id, {mode: 'finish'}, state.version);
      oracle.apply({kind: 'finish'});
      assertParity(oracle, observe(done.state, (await client.getSessionAccount(state.id)).account.ledger), 'gapped finish');
      const ledgerTimes = new Set((await client.getSessionAccount(state.id)).account.equity.map(p => p.time));
      for (const gap of [...gapTimes, Date.parse('2024-03-09T12:20:00Z')]) assert.equal(ledgerTimes.has(gap), false, `no frame at the gap ${new Date(gap).toISOString()}`);
      await client.closeSession(state.id);
    } finally { delete fake.gaps['BTC']; delete fake.gaps['LINK']; }
  });

  it('a failing exchange fails the job and creates no session or run', async () => {
    const runsBefore = (await client.listRuns()).length;
    fake.inject({match: r => r.kind === 'candles', status: 500, body: '{"message":"boom"}'});
    try {
      const job = await finishedJob({start: '2024-03-09T09:00', end: '2024-03-09T09:30'});
      assert.equal(job.status, 'failed');
      assert.match(job.error ?? '', /Coinbase HTTP 500/);
      assert.deepEqual(await code(client.createSession({settings: rangeSettings({start: '2024-03-09T09:00', end: '2024-03-09T09:30'}), candleJobId: job.id})), [409, 'job_failed']);
    } finally { fake.clearRules(); }
    assert.equal((await client.listRuns()).length, runsBefore);
  });

  it('a cancelled job cannot start a session; unknown, mismatching and not-ready jobs report their codes', async () => {
    fake.inject({match: r => r.kind === 'candles', delayMs: 30_000});
    try {
      const slow = await client.createCandleJob({start: '2024-03-09T10:00', end: '2024-03-09T10:30', lookbackIntervals: 7, model: 'trend'});
      assert.deepEqual(await code(client.createSession({settings: rangeSettings({start: '2024-03-09T10:00', end: '2024-03-09T10:30'}), candleJobId: slow.id})), [409, 'job_not_ready']);
      const cancelled = await client.cancelCandleJob(slow.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.deepEqual(await code(client.createSession({settings: rangeSettings({start: '2024-03-09T10:00', end: '2024-03-09T10:30'}), candleJobId: slow.id})), [409, 'job_cancelled']);
    } finally { fake.releaseDelays(); fake.clearRules(); }
    assert.deepEqual(await code(client.createSession({settings: rangeSettings(SHORT), candleJobId: 'no-such-job'})), [404, 'job_not_found']);
    const job = await finishedJob(SHORT);
    assert.equal(job.status, 'completed');
    // Changing the lookback after the job was made is refused: the job's warmup was sized for another one.
    assert.deepEqual(await code(client.createSession({settings: rangeSettings(SHORT, {lookbackIntervals: 9}), candleJobId: job.id})), [422, 'job_mismatch']);
    assert.deepEqual(await code(client.createSession({settings: rangeSettings({start: SHORT.start, end: '2024-03-09T12:30'}), candleJobId: job.id})), [422, 'job_mismatch']);
    const ok = await client.createSession({settings: rangeSettings(SHORT), candleJobId: job.id});
    assert.equal(ok.status, 'active');
    await client.closeSession(ok.id);
  });
});

describe('live paper sessions (fake exchange)', () => {
  it('starts, ticks (frames and version increase), keeps state on a 502, trades manually, and saves a verifying record', async () => {
    // Automatic entries use at most half the cash, so the manual buy below always has cash to spend.
    const settings = {config: {mode: 'live' as const, durationMs: 7_200_000, allocationFraction: 0.25}};
    let state = await client.createSession({settings, name: 'live e2e'});
    assert.equal(state.kind, 'live');
    assert.equal(state.status, 'active');
    assert.equal(state.frameCount, 1);
    assert.equal(state.config.mode, 'live');
    assert.ok(Math.abs(state.currentFrame.time - Date.now()) < 10_000, 'the live clock is the receipt time of fresh quotes');
    assert.equal(state.scoreEnd - state.scoreStart, 7_200_000);
    let last = state;
    for (let i = 1; i <= 3; i++) {
      await new Promise(r => setTimeout(r, 5)); // frame times must increase
      const step = await client.tickSession(state.id, last.version);
      assert.equal(step.framesIngested, 1);
      assert.equal(step.state.frameCount, 1 + i);
      assert.equal(step.state.version, last.version + 1);
      assert.ok(step.state.currentFrame.time > last.currentFrame.time);
      last = step.state;
    }
    // A failing exchange leaves the session exactly as it was.
    fake.inject({match: r => r.kind === 'ticker', status: 503, body: '{}'});
    try { assert.deepEqual(await code(client.tickSession(state.id, last.version)), [502, 'live_unavailable']); }
    finally { fake.clearRules(); }
    assert.deepEqual(await client.getSession(state.id), last);
    assert.deepEqual(await code(client.advance(state.id, {mode: 'frames', count: 1}, last.version)), [409, 'wrong_session_kind']);
    assert.deepEqual(await code(client.tickSession(state.id, last.version - 1)), [409, 'stale_session']);
    // A manual order fetches a fresh frame first and trades at it.
    const trades = last.summary.tradeCount;
    const order = await client.placeOrder(state.id, {asset: 'BTC', side: 'buy', dollars: 100}, last.version);
    assert.equal(order.state.summary.tradeCount, trades + 1);
    assert.equal(order.state.manualTradeCount, 1);
    assert.equal(order.framesIngested, 1);
    assert.equal(order.state.frameCount, last.frameCount + 1);
    state = order.state;
    const saved = await client.saveSession(state.id, state.version);
    const record = await client.exportRun(saved.run.id);
    const checked = verifyRecord(record);
    assert.ok(checked.configHashOk && checked.marketHashOk, 'hashes verify with the original history.js');
    assert.equal(checked.futureFrames, 0);
    assert.equal(record.manualTradeCount, 1);
    assert.equal(record.config['mode'], 'live');
    await client.closeSession(state.id);
  });

  it('a replay session refuses tick; a live session cannot be started with candles', async () => {
    const replay = await client.createSession({settings: {config: {}}});
    assert.deepEqual(await code(client.tickSession(replay.id, replay.version)), [409, 'wrong_session_kind']);
    await client.closeSession(replay.id);
    const rejected = await code(client.createSession({settings: {config: {mode: 'live'}}, candleJobId: 'x'}));
    assert.equal(rejected[0], 422);
  });

  it('start fails with 502 live_unavailable and creates nothing when the exchange is down', async () => {
    fake.inject({match: r => r.kind === 'ticker', status: 500, body: '{}'});
    try { assert.deepEqual(await code(client.createSession({settings: {config: {mode: 'live'}}})), [502, 'live_unavailable']); }
    finally { fake.clearRules(); }
  });
});
void MINUTE;
