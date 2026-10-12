// End to end: the compiled TypeScript client drives stepwise sessions on the real Python API
// (uvicorn child process, loopback only). Every step is compared with an independent oracle that
// replays the same actions through the original JavaScript engine (test/oracle.ts).
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, PaperTrailClient, type SessionState, type SessionStep} from '../src/client.ts';
import {assertParity, createOracle, observe, type Action, type Oracle} from './oracle.ts';
import {startApi, type RunningApi} from './server.ts';

let api: RunningApi;
let client: PaperTrailClient;
before(async () => { api = await startApi(); client = new PaperTrailClient({baseUrl: api.baseUrl}); });
after(() => api?.stop());

const rejects = (promise: Promise<unknown>, status: number, code: string): Promise<void> =>
  assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.status === status && error.code === code,
    `expected HTTP ${status} ${code}`);

/** Nothing the API returns may be later than the session's current frame (only deadlines like targetAt/nextDecisionAt are). */
function assertCausal(state: SessionState, extra: {time?: number}[] = []): void {
  const now = state.currentFrame.time;
  assert.ok(state.currentFrame.quotes.BTC.observedAt <= now && state.currentFrame.quotes.LINK.observedAt <= now);
  assert.ok(state.summary.valuationAt === null || state.summary.valuationAt <= now);
  for (const row of extra) assert.ok((row.time ?? 0) <= now, `row at ${row.time} is later than the clock ${now}`);
}

/** Applies the same action to the API and the oracle and requires identical outcomes. */
async function both(id: string, state: SessionState, oracle: Oracle, action: Action): Promise<SessionStep> {
  let step: SessionStep;
  if (action.kind === 'order') {
    const {asset, side, dollars} = action;
    step = await client.placeOrder(id, dollars === undefined ? {asset, side} : {asset, side, dollars}, state.version);
  } else {
    step = await client.advance(id, action.kind === 'frames' ? {mode: 'frames', count: action.count} : {mode: action.kind}, state.version);
  }
  const expected = oracle.apply(action);
  assert.equal(expected.rejected, undefined);
  assert.equal(step.framesIngested, expected.framesIngested, `${action.kind}: frames ingested`);
  assert.ok(step.state.version > state.version, 'version increases on every change');
  const account = await client.getSessionAccount(id);
  assert.deepEqual(account.state, step.state, 'account endpoint reports the same state');
  assertParity(oracle, observe(step.state, account.account.ledger), action.kind);
  assertCausal(step.state, [...account.account.ledger, ...account.account.equity, ...step.events]);
  return step;
}

describe('stepwise sessions through the TypeScript client (real API, JS oracle)', () => {
  it('starts at the first scored frame and matches the oracle', async () => {
    const oracle = await createOracle();
    const state = await client.createSession({settings: {config: {}}, name: 'e2e start'});
    assert.equal(state.status, 'active');
    assert.equal(state.kind, 'sample');
    assert.equal(state.cursor, oracle.lookback);
    assert.equal(state.currentFrame.time, oracle.scoreStart);
    assert.equal(state.scoreStart, oracle.scoreStart);
    assert.equal(state.scoreEnd, oracle.scoreEnd);
    assert.equal(state.warmupFrameCount, oracle.lookback);
    assert.equal(state.savedVersion, null);
    assert.equal(state.manualTradeCount, 0);
    assert.ok(Number.isInteger(state.version) && state.runId.length > 0);
    assert.equal((await client.getSession(state.id)).version, state.version);
    const account = await client.getSessionAccount(state.id);
    assertParity(oracle, observe(state, account.account.ledger), 'start');
    assertCausal(state, [...account.account.ledger, ...account.account.equity]);
    await client.closeSession(state.id);
  });

  it('advances by frames, to the next decision and to the end, equal to the oracle at every step', async () => {
    const oracle = await createOracle();
    let state = await client.createSession({settings: {config: {}}});
    const {id} = state;
    const plan: Action[] = [{kind: 'frames', count: 1}, {kind: 'frames', count: 3}, {kind: 'decision'}, {kind: 'frames', count: 8},
      {kind: 'decision'}, {kind: 'decision'}, {kind: 'frames', count: 25}];
    for (const action of plan) {
      const target = oracle.decisionTarget();
      const step = await both(id, state, oracle, action);
      if (action.kind === 'decision') assert.ok(step.state.currentFrame.time >= target, 'stopped at the decision frame');
      state = step.state;
    }
    const finish = await both(id, state, oracle, {kind: 'finish'});
    assert.equal(finish.state.status, 'completed');
    assert.equal(finish.state.currentFrame.time, oracle.scoreEnd);
    assert.equal(finish.state.cursor, finish.state.frameCount - 1);
    assert.equal(finish.state.nextDecisionAt, null);
    assert.ok(finish.events.some(e => e.type === 'complete'));
    assert.ok(oracle.snapshot().tradeCount > 0, 'the comparison is not vacuous: the default run trades');
    // Negative control: an oracle with different assumptions must disagree, so the comparison can fail.
    const other = await createOracle({config: {}, replay: {source: 'sample', halfSpreadBps: 9}});
    other.apply({kind: 'finish'});
    assert.ok(Math.abs(other.snapshot().equity - finish.state.summary.equity) > 1e-6);
    await client.closeSession(id);
  });

  it('manual buy and sell match the oracle, with events and counters', async () => {
    const oracle = await createOracle();
    let state = await client.createSession({settings: {config: {}}});
    const {id} = state;
    state = (await both(id, state, oracle, {kind: 'frames', count: 3})).state;
    const buy = await both(id, state, oracle, {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100});
    assert.ok(buy.events.some(e => e.type === 'trade' && (e as any).actor === 'manual' && (e as any).side === 'buy' && (e as any).asset === 'BTC'));
    assert.ok(buy.state.summary.perAsset.BTC.qty > 0);
    assert.equal(buy.state.manualTradeCount, 1);
    state = buy.state;
    state = (await both(id, state, oracle, {kind: 'frames', count: 1})).state; // stay inside the first decision horizon
    const link = await both(id, state, oracle, {kind: 'order', asset: 'LINK', side: 'buy', dollars: 50});
    const sell = await both(id, link.state, oracle, {kind: 'order', asset: 'BTC', side: 'sell'});
    assert.equal(sell.state.summary.perAsset.BTC.qty, 0);
    assert.equal(sell.state.manualTradeCount, 3);
    const partial = await both(id, sell.state, oracle, {kind: 'order', asset: 'LINK', side: 'sell', dollars: 20});
    assert.ok(partial.state.summary.perAsset.LINK.qty > 0, 'a dollar-sized sell leaves part of the position');
    await both(id, partial.state, oracle, {kind: 'decision'});
    await client.closeSession(id);
  });

  it('rejects stale versions with 409 and currentVersion, changing nothing', async () => {
    const state = await client.createSession({settings: {config: {}}});
    const step = await client.advance(state.id, {mode: 'frames', count: 2}, state.version);
    const attempts: (() => Promise<unknown>)[] = [
      () => client.advance(state.id, {mode: 'frames', count: 1}, state.version),
      () => client.placeOrder(state.id, {asset: 'BTC', side: 'buy', dollars: 100}, state.version),
      () => client.saveSession(state.id, state.version),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'stale_session'
        && error.currentVersion === step.state.version);
    }
    assert.deepEqual(await client.getSession(state.id), step.state, 'a stale call changes nothing');
    await client.closeSession(state.id);
  });

  it('returns typed order and request errors', async () => {
    const state = await client.createSession({settings: {config: {}}});
    const v = state.version;
    await rejects(client.placeOrder(state.id, {asset: 'BTC', side: 'sell'}, v), 422, 'order_rejected'); // no position
    await rejects(client.placeOrder(state.id, {asset: 'BTC', side: 'buy'}, v), 422, 'order_rejected'); // buy needs dollars
    await rejects(client.placeOrder(state.id, {asset: 'LINK', side: 'buy', dollars: 0}, v), 422, 'order_rejected');
    await rejects(client.placeOrder(state.id, {asset: 'LINK', side: 'buy', dollars: -5}, v), 422, 'order_rejected');
    await rejects(client.placeOrder(state.id, {asset: 'DOGE' as never, side: 'buy', dollars: 5}, v), 422, 'invalid_request');
    await rejects(client.advance(state.id, {mode: 'frames', count: 0}, v), 422, 'invalid_request');
    await rejects(client.advance(state.id, {mode: 'frames', count: 1001}, v), 422, 'invalid_request');
    await rejects(client.getSession('no-such-session'), 404, 'session_not_found');
    await rejects(client.advance('no-such-session', {mode: 'finish'}, 1), 404, 'session_not_found');
    assert.deepEqual(await client.getSession(state.id), state, 'rejected calls do not change the session');
    await client.closeSession(state.id);
  });

  it('completed sessions refuse further stepping and orders, but can still be saved and exported', async () => {
    const oracle = await createOracle();
    const state = await client.createSession({settings: {config: {}}});
    const done = await both(state.id, state, oracle, {kind: 'finish'});
    assert.equal(done.state.status, 'completed');
    const v = done.state.version;
    await rejects(client.advance(state.id, {mode: 'frames', count: 1}, v), 409, 'session_completed');
    await rejects(client.advance(state.id, {mode: 'decision'}, v), 409, 'session_completed');
    await rejects(client.advance(state.id, {mode: 'finish'}, v), 409, 'session_completed');
    await rejects(client.placeOrder(state.id, {asset: 'BTC', side: 'buy', dollars: 100}, v), 409, 'session_completed');
    assert.deepEqual(await client.getSession(state.id), done.state);
    const saved = await client.saveSession(state.id, v, 'completed e2e');
    assert.equal(saved.run.summary.status, 'completed');
    await client.closeSession(state.id);
  });

  it('saves a snapshot under the session run id, exports results and settings, and lists the run', async () => {
    const oracle = await createOracle();
    const request = {config: {}, replay: {source: 'sample' as const, halfSpreadBps: 2}};
    let state = await client.createSession({settings: request, name: 'e2e snapshot'});
    const {id, runId} = state;
    state = (await both(id, state, oracle, {kind: 'frames', count: 2})).state;
    state = (await both(id, state, oracle, {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100})).state;
    state = (await both(id, state, oracle, {kind: 'frames', count: 1})).state;
    state = (await both(id, state, oracle, {kind: 'order', asset: 'BTC', side: 'sell'})).state;
    state = (await both(id, state, oracle, {kind: 'decision'})).state;

    assert.ok(!(await client.listRuns()).some(run => run.id === runId), 'nothing is in history before a save');
    const saved = await client.saveSession(id, state.version, 'e2e snapshot');
    assert.equal(saved.run.id, runId, 'a snapshot keeps the session run id');
    assert.equal(saved.state.savedVersion, saved.state.version);
    assert.ok(saved.state.version >= state.version);
    assertParity(oracle, observe(saved.state), 'after save');

    const exported = await client.exportRun(runId);
    assert.equal(exported.format, 'paper-trail-run-v2');
    assert.equal(exported.id, runId);
    assert.match(exported.hashes.configSha256, /^[0-9a-f]{64}$/);
    assert.match(exported.hashes.marketSha256, /^[0-9a-f]{64}$/);
    assert.equal(exported.manualTradeCount, 2);
    const counts: Record<string, number> = {};
    for (const e of exported.account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
    assertParity(oracle, {...observe(saved.state), ledgerCounts: counts, cash: exported.account.cash,
      qty: {BTC: exported.account.positions.BTC.qty, LINK: exported.account.positions.LINK.qty}}, 'exported record');
    near(exported.summary.equity, oracle.snapshot().equity);
    near(exported.summary.buyHoldEquity, oracle.snapshot().buyHold);
    assert.equal(exported.summary.tradeCount, oracle.snapshot().tradeCount);
    assert.ok(exported.account.ledger.every(e => e.time <= state.currentFrame.time), 'the snapshot holds nothing from the future');

    const settings = await client.exportSettings(runId);
    assert.equal(settings.format, 'paper-trail-settings-v2');
    assert.deepEqual(await client.normalizeSettings(settings), settings);
    assert.equal(settings.config.initialCash, 1000);

    const listed = (await client.listRuns()).find(run => run.id === runId);
    assert.ok(listed, 'the saved run is in history');
    assert.equal(listed.name, 'e2e snapshot');
    assert.equal(listed.manualTradeCount, 2);

    // Later progress, saved again, replaces the snapshot under the same id (still one history row).
    const step = await client.advance(id, {mode: 'frames', count: 4}, saved.state.version);
    oracle.apply({kind: 'frames', count: 4});
    const again = await client.saveSession(id, step.state.version);
    assert.equal(again.run.id, runId);
    assert.equal((await client.listRuns()).filter(run => run.id === runId).length, 1);
    assert.equal((await client.exportRun(runId)).summary.equity, again.state.summary.equity);
    assertParity(oracle, observe(again.state), 'second save');

    const closed = await client.closeSession(id);
    assert.equal(closed.status, 'closed');
    assert.ok((await client.listRuns()).some(run => run.id === runId), 'the snapshot survives closing');
    await rejects(client.advance(id, {mode: 'frames', count: 1}, closed.version), 409, 'session_closed');
    await rejects(client.placeOrder(id, {asset: 'BTC', side: 'buy', dollars: 100}, closed.version), 409, 'session_closed');
  });

  it('keeps imported nondefault timing settings through start, save and export', async () => {
    const settings = await client.normalizeSettings({config: {maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, horizonMs: 300000}});
    const state = await client.createSession({settings});
    assert.equal(state.config.maxQuoteAgeMs, 45000);
    assert.equal(state.config.maxOutcomeLatenessMs, 12000);
    const saved = await client.saveSession(state.id, state.version);
    const record = await client.exportRun(saved.run.id);
    assert.equal(record.config['maxQuoteAgeMs'], 45000);
    assert.equal(record.config['maxOutcomeLatenessMs'], 12000);
    const back = await client.exportSettings(saved.run.id);
    assert.equal(back.config.maxQuoteAgeMs, 45000);
    assert.equal(back.config.maxOutcomeLatenessMs, 12000);
    await client.closeSession(state.id);
  });

  it('runs a nondefault configuration identically to the oracle', async () => {
    const request = {config: {initialCash: 2500, horizonMs: 900000, lookbackIntervals: 20, feeBps: 25, slippageBps: 10, bufferBps: 5, stopLossBps: 120, allocationFraction: 0.4},
      replay: {source: 'sample' as const, halfSpreadBps: 3.5}};
    const oracle = await createOracle(request);
    let state = await client.createSession({settings: request});
    assert.equal(state.cursor, 20);
    for (const action of [{kind: 'decision'}, {kind: 'frames', count: 40}, {kind: 'order', asset: 'LINK', side: 'buy', dollars: 300}, {kind: 'decision'}, {kind: 'finish'}] as Action[]) {
      state = (await both(state.id, state, oracle, action)).state;
    }
    assert.equal(state.status, 'completed');
    await client.closeSession(state.id);
  });
});

const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) <= 1e-9, `${a} vs ${b}`);

