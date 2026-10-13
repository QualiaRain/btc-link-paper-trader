// Real Chromium against the real Python API: the stepwise session panel, checked against the
// independent JS oracle (test/oracle.ts). Needs a Chromium ($CHROMIUM_PATH, /opt/pw-browsers/chromium or
// Playwright's install); without one the tests are skipped unless REQUIRE_BROWSER=1.
import {after, before, describe, it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {chromium, type Browser, type Page} from 'playwright-core';
import {PaperTrailClient} from '../src/client.ts';
import {assertParity, createOracle, type Observed, type Oracle} from './oracle.ts';
import {startApi, type RunningApi} from './server.ts';

let api: RunningApi;
let client: PaperTrailClient;
let browser: Browser | undefined;
let launchProblem = '';

before(async () => {
  api = await startApi();
  client = new PaperTrailClient({baseUrl: api.baseUrl});
  const executablePath = process.env['CHROMIUM_PATH'] ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  try {
    browser = await chromium.launch({executablePath, args: ['--no-proxy-server', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]});
  } catch (error) {
    launchProblem = (error as Error).message.split('\n')[0] ?? 'unknown error';
    if (process.env['REQUIRE_BROWSER']) throw new Error(`REQUIRE_BROWSER is set but Chromium could not start: ${launchProblem}`);
  }
});
after(async () => { await browser?.close(); api?.stop(); });

// ---- helpers --------------------------------------------------------------------------------------
interface Recorded { method: string; url: string; request: any; body: any }
interface Seen { responses: Recorded[]; maxAdvanceInFlight: number; advanceBodies: any[]; order: string[] }

async function openPage(): Promise<{page: Page; seen: Seen}> {
  const page = await browser!.newPage({acceptDownloads: true});
  const seen: Seen = {responses: [], maxAdvanceInFlight: 0, advanceBodies: [], order: []};
  let inFlight = 0;
  page.on('request', request => {
    if (!request.url().includes('/v1/sessions')) return;
    seen.order.push(`${request.method()} ${new URL(request.url()).pathname}`);
    if (request.url().endsWith('/advance')) {
      seen.advanceBodies.push(request.postDataJSON());
      seen.maxAdvanceInFlight = Math.max(seen.maxAdvanceInFlight, ++inFlight);
    }
  });
  page.on('requestfinished', request => { if (request.url().endsWith('/advance')) inFlight--; });
  page.on('requestfailed', request => { if (request.url().endsWith('/advance')) inFlight--; });
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('/v1/sessions')) return;
    let body: any;
    try { body = await response.json(); } catch { body = undefined; }
    seen.responses.push({method: response.request().method(), url, request: response.request().postData(), body});
  });
  await page.goto(api.baseUrl);
  await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Connected'));
  return {page, seen};
}

/** Requirement: no session response may contain a frame time later than state.currentFrame.time. */
function assertNoFutureFrames(seen: Seen): void {
  let checked = 0;
  for (const {body} of seen.responses) {
    const state = body?.state ?? (body?.currentFrame ? body : undefined);
    if (!state?.currentFrame) continue;
    const now = state.currentFrame.time as number;
    const rows: {time?: number}[] = [...(body.events ?? []), ...(body.account?.ledger ?? []), ...(body.account?.equity ?? [])];
    for (const row of rows) assert.ok((row.time ?? 0) <= now, `a response carried a frame at ${row.time}, later than the clock ${now}`);
    for (const asset of ['BTC', 'LINK']) assert.ok(state.currentFrame.quotes[asset].observedAt <= now);
    assert.ok(state.summary.valuationAt === null || state.summary.valuationAt <= now);
    checked++;
  }
  assert.ok(checked > 0, 'the check saw session responses');
}

interface View extends Observed { id: string; version: number; busy: boolean; playing: boolean; panel: string; notice: string; noticeIsError: boolean; activity: string[]; frameCount: number }
const read = (page: Page): Promise<View> => page.evaluate(() => {
  const d = (id: string) => document.getElementById(id)!;
  const raw = (id: string) => Number(d(id).dataset['raw']);
  const panel = d('session-panel');
  return {
    id: panel.dataset['sessionId']!, version: Number(panel.dataset['version']), panel: panel.dataset['status']!,
    busy: panel.dataset['busy'] === 'true', playing: panel.dataset['playing'] === 'true',
    notice: d('s-notice').textContent!, noticeIsError: d('s-notice').classList.contains('error'),
    activity: Array.from(d('s-activity').querySelectorAll('li')).map(li => li.textContent!),
    time: Number(d('s-clock').dataset['time']), cursor: Number(d('s-cursor').dataset['cursor']), frameCount: Number(d('s-cursor').dataset['frameCount']),
    status: d('s-status').textContent!.toLowerCase(), cash: raw('s-cash'), equity: raw('s-equity'), buyHold: raw('s-buyhold'),
    fees: raw('s-fees'), tradeCount: raw('s-trades'), qty: {BTC: raw('s-qty-BTC'), LINK: raw('s-qty-LINK')},
  };
});
const idle = (page: Page) => page.waitForFunction(() => {
  const p = document.getElementById('session-panel')!.dataset;
  return p['busy'] === 'false' && p['playing'] === 'false';
});

/** Click a control that calls the API and wait until the call has landed and the panel is idle again. */
async function press(page: Page, selector: string, urlPart: string): Promise<void> {
  await Promise.all([page.waitForResponse(r => r.url().includes(urlPart) && r.request().method() !== 'GET'), page.click(selector)]);
  await idle(page);
}
async function startSession(page: Page): Promise<View> {
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/v1/sessions') && r.request().method() === 'POST'), page.click('#s-start')]);
  await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'active');
  await idle(page);
  return read(page);
}

/** The page must show exactly what the oracle computed, and the server's full ledger must agree with the oracle's event counts. */
async function assertMatchesOracle(page: Page, oracle: Oracle, label: string): Promise<View> {
  const view = await read(page);
  assertParity(oracle, view, `${label} (page)`);
  assert.equal(view.frameCount, oracle.snapshot().frameCount);
  const account = await client.getSessionAccount(view.id);
  const counts: Record<string, number> = {};
  for (const e of account.account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
  assert.deepEqual(counts, oracle.snapshot().ledgerCounts, `${label}: ledger event counts`);
  assert.equal(account.state.version, view.version, `${label}: the page tracks the server version`);
  return view;
}

const settingsFile = (config: Record<string, unknown>) =>
  ({name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'paper-trail-settings-v2', config, replay: {source: 'sample', halfSpreadBps: 2}}))});

async function scenario(t: TestContext, body: (ctx: {page: Page; seen: Seen; oracle: Oracle}) => Promise<void>): Promise<void> {
  if (!browser) { t.skip(`no Chromium available: ${launchProblem}`); return; }
  const {page, seen} = await openPage();
  try {
    await body({page, seen, oracle: await createOracle()});
    assertNoFutureFrames(seen);
  } finally { await page.close(); }
}

// ---- tests ----------------------------------------------------------------------------------------
describe('stepwise session panel (real Chromium, real Python API, JS oracle)', () => {
  it('starts at the first scored frame', t => scenario(t, async ({page, oracle}) => {
    assert.equal(await page.locator('#s-start').textContent(), 'Start session');
    assert.equal(await page.locator('#s-next-frame').isDisabled(), true, 'no stepping before a session exists');
    const view = await startSession(page);
    assert.equal(view.time, oracle.scoreStart, 'clock is the first scored frame');
    assert.equal(view.cursor, oracle.lookback);
    assert.equal(view.status, 'paused');
    assert.equal(await page.locator('#s-clock').textContent(), new Date(oracle.scoreStart).toISOString().replace('T', ' ').replace('.000Z', ' UTC'));
    assert.match(await page.locator('#s-cursor').textContent() ?? '', /^Frame 8 of \d+$/);
    await assertMatchesOracle(page, oracle, 'start');
    for (const id of ['s-next-frame', 's-next-decision', 's-play', 's-finish', 's-save', 's-export', 's-close', 's-buy-BTC', 's-sell-BTC', 's-buy-LINK', 's-sell-LINK'])
      assert.equal(await page.locator(`#${id}`).isDisabled(), false, id);
  }));

  it('Next frame three times and Next decision match the oracle', t => scenario(t, async ({page, oracle}) => {
    await startSession(page);
    for (let i = 1; i <= 3; i++) {
      await press(page, '#s-next-frame', '/advance');
      oracle.apply({kind: 'frames', count: 1});
      const view = await assertMatchesOracle(page, oracle, `next frame ${i}`);
      assert.equal(view.cursor, oracle.lookback + i);
    }
    const target = oracle.decisionTarget();
    await press(page, '#s-next-decision', '/advance');
    oracle.apply({kind: 'decision'});
    const view = await assertMatchesOracle(page, oracle, 'next decision');
    assert.ok(view.time >= target, 'stopped at the oracle step target');
    assert.ok(view.cursor > oracle.lookback + 3);
    await press(page, '#s-next-decision', '/advance'); // a second decision, with fills and settlements
    oracle.apply({kind: 'decision'});
    await assertMatchesOracle(page, oracle, 'second decision');
    assert.ok(view.activity.length >= 2 && view.activity[0]!.includes('Next decision'), 'activity is newest first');
  }));

  it('Play runs sequential ticks of eight frames, then Pause stops it', t => scenario(t, async ({page, seen, oracle}) => {
    await startSession(page);
    await page.click('#s-play');
    assert.equal(await page.locator('#s-play').textContent(), 'Pause');
    assert.equal(await page.locator('#s-next-frame').isDisabled(), true, 'stepping is off while playing');
    assert.equal(await page.locator('#s-buy-BTC').isDisabled(), true, 'manual orders are off while playing');
    await page.waitForFunction(lookback => Number(document.getElementById('s-cursor')!.dataset['cursor']) >= lookback + 24, oracle.lookback);
    await page.click('#s-play'); // pause
    assert.equal(await page.locator('#s-play').textContent(), 'Play');
    await idle(page);
    const paused = await read(page);
    assert.equal((paused.cursor - oracle.lookback) % 8, 0, 'play advances in whole ticks of 8');
    assert.ok(paused.cursor >= oracle.lookback + 24);
    await page.waitForTimeout(400);
    assert.equal((await read(page)).cursor, paused.cursor, 'nothing advances after pausing');
    assert.match(await page.locator('#s-notice').textContent() ?? '', /^Paused at /);
    oracle.apply({kind: 'frames', count: paused.cursor - oracle.lookback});
    await assertMatchesOracle(page, oracle, 'after play');
    assert.equal(seen.maxAdvanceInFlight, 1, 'ticks never overlap');
    assert.ok(seen.advanceBodies.length >= 3 && seen.advanceBodies.every(b => b.mode === 'frames' && b.count === 8));
    assert.equal(await page.locator('#s-next-frame').isDisabled(), false, 'paused again');
  }));

  it('manual buy BTC $100 and Sell all match the oracle', t => scenario(t, async ({page, seen, oracle}) => {
    await startSession(page);
    await press(page, '#s-next-frame', '/advance');
    oracle.apply({kind: 'frames', count: 1});
    await press(page, '#s-buy-BTC', '/orders');
    assert.equal(oracle.apply({kind: 'order', asset: 'BTC', side: 'buy', dollars: 100}).rejected, undefined);
    const bought = await assertMatchesOracle(page, oracle, 'buy');
    assert.ok(bought.qty.BTC > 0);
    assert.ok(bought.activity[0]!.includes('Manual buy BTC'), bought.activity[0]);
    assert.match(await page.locator('#s-notice').textContent() ?? '', /^Manual paper buy BTC recorded/);
    await press(page, '#s-next-frame', '/advance');
    oracle.apply({kind: 'frames', count: 1});
    await press(page, '#s-sell-BTC', '/orders');
    oracle.apply({kind: 'order', asset: 'BTC', side: 'sell'});
    const sold = await assertMatchesOracle(page, oracle, 'sell all');
    assert.equal(sold.qty.BTC, 0);
    assert.ok(sold.fees > 0 && sold.tradeCount >= 2);
    const orders = seen.responses.filter(r => r.url.endsWith('/orders')).map(r => JSON.parse(r.request));
    assert.deepEqual(orders.map(o => [o.asset, o.side, o.dollars]), [['BTC', 'buy', 100], ['BTC', 'sell', undefined]]);
    assert.equal(orders[1].dollars, undefined, 'sell all sends no dollar amount');
    assert.ok(orders.every(o => Number.isInteger(o.expectedVersion)));
    const account = await client.getSessionAccount(sold.id);
    assert.equal(account.state.manualTradeCount, 2);
  }));

  it('selling with no position shows an order_rejected notice and changes nothing', t => scenario(t, async ({page, oracle}) => {
    const before = await startSession(page);
    await press(page, '#s-sell-LINK', '/orders');
    const view = await read(page);
    assert.equal(view.noticeIsError, true);
    assert.match(view.notice, /^Order rejected: .*no position to sell/);
    assert.equal(view.version, before.version, 'version unchanged');
    assert.equal(view.tradeCount, 0);
    assert.ok(view.activity[0]!.includes('Order rejected'));
    assert.equal(view.status, 'paused');
    assert.equal(await page.locator('#s-next-frame').isDisabled(), false, 'the session stays usable');
    await assertMatchesOracle(page, oracle, 'after rejected order');
  }));

  it('a stale action shows the stale notice, refreshes, and does not advance further', t => scenario(t, async ({page, oracle}) => {
    const before = await startSession(page);
    const external = await client.advance(before.id, {mode: 'frames', count: 1}, before.version); // another client moves the session
    oracle.apply({kind: 'frames', count: 1});
    assert.equal(external.state.cursor, before.cursor + 1);
    await press(page, '#s-next-frame', '/advance'); // the page still holds the old version
    const view = await read(page);
    assert.equal(view.noticeIsError, true);
    assert.match(view.notice, /^Stale session: .*version/);
    assert.equal(view.cursor, external.state.cursor, 'the page refreshed to the externally advanced state');
    assert.equal(view.version, external.state.version);
    const server = await client.getSession(before.id);
    assert.equal(server.cursor, before.cursor + 1, 'the stale click advanced nothing');
    assert.equal(server.version, external.state.version);
    assert.ok(view.activity[0]!.includes('Stale action ignored'));
    await assertMatchesOracle(page, oracle, 'after stale');
    await press(page, '#s-next-frame', '/advance'); // with fresh state the same action now works, once
    oracle.apply({kind: 'frames', count: 1});
    assert.equal((await assertMatchesOracle(page, oracle, 'retry by hand')).cursor, before.cursor + 2);
  }));

  it('ignores a late response after the session was replaced or closed', t => scenario(t, async ({page, oracle}) => {
    const first = await startSession(page);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/v1/sessions/*/advance', async route => {
      const real = await route.fetch(); // the server processes the first session's advance now...
      await gate; // ...but the page only hears about it later
      await route.fulfill({response: real});
    });
    await page.click('#s-next-frame');
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['busy'] === 'true');
    // Replace the session while that response is still on its way.
    await page.fill('#name', 'second session');
    const second = await startSession(page);
    assert.notEqual(second.id, first.id);
    assert.equal(second.cursor, oracle.lookback);
    assert.equal((await client.getSession(first.id)).status, 'closed', 'starting a new session closed the old one');
    assert.equal((await client.getSession(first.id)).cursor, oracle.lookback + 1, 'the delayed advance did run on the old session');
    release();
    await page.waitForTimeout(500);
    const after = await read(page);
    assert.equal(after.id, second.id);
    assert.equal(after.version, second.version, 'the late response did not touch the new session');
    assert.equal(after.cursor, oracle.lookback);
    assert.equal(after.time, oracle.scoreStart);
    assert.ok(!after.activity.some(line => line.includes('Next frame')), 'no activity from the old session');
    assert.ok(!after.notice.includes('Next frame'), `the old session's operation must not write a notice: ${after.notice}`);
    assert.match(after.notice, /^Session started at /);
    assert.equal(after.busy, false);
    await assertMatchesOracle(page, oracle, 'new session after the late response');

    // Same for Close: a delayed response must not resurrect a closed session.
    await page.unroute('**/v1/sessions/*/advance');
    let release2!: () => void;
    const gate2 = new Promise<void>(resolve => { release2 = resolve; });
    await page.route('**/v1/sessions/*/advance', async route => { const real = await route.fetch(); await gate2; await route.fulfill({response: real}); });
    await page.click('#s-next-frame');
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['busy'] === 'true');
    await Promise.all([page.waitForResponse(r => r.request().method() === 'DELETE'), page.click('#s-close')]);
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'none');
    release2();
    await page.waitForTimeout(500);
    const closed = await read(page);
    assert.equal(closed.panel, 'none');
    assert.match(closed.notice, /^Session closed/, 'the old operation must not overwrite the close notice');
    assert.equal(await page.locator('#s-state').isHidden(), true);
    assert.equal(await page.locator('#s-start').textContent(), 'Start session');
    assert.equal((await client.getSession(second.id)).status, 'closed');
  }));

  it('Finish completes the replay and disables stepping and orders', t => scenario(t, async ({page, oracle}) => {
    await startSession(page);
    await press(page, '#s-finish', '/advance');
    oracle.apply({kind: 'finish'});
    const view = await assertMatchesOracle(page, oracle, 'finish');
    assert.equal(view.status, 'completed');
    assert.equal(view.panel, 'completed');
    assert.equal(view.time, oracle.scoreEnd);
    assert.equal(view.cursor, view.frameCount - 1);
    assert.match(view.notice, /^Replay complete/);
    for (const id of ['s-next-frame', 's-next-decision', 's-play', 's-finish', 's-buy-BTC', 's-sell-BTC', 's-buy-LINK', 's-sell-LINK'])
      assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} is disabled once completed`);
    for (const id of ['s-save', 's-export', 's-close']) assert.equal(await page.locator(`#${id}`).isDisabled(), false, id);
    assert.ok(view.tradeCount > 0);
  }));

  it('Save snapshot, then Export run downloads the saved run; ledger and summary equal the oracle; history lists it', t => scenario(t, async ({page, seen, oracle}) => {
    await page.fill('#name', 'browser session export');
    await startSession(page);
    await press(page, '#s-next-frame', '/advance');
    oracle.apply({kind: 'frames', count: 1});
    await press(page, '#s-buy-BTC', '/orders');
    oracle.apply({kind: 'order', asset: 'BTC', side: 'buy', dollars: 100});
    await press(page, '#s-next-decision', '/advance');
    oracle.apply({kind: 'decision'});
    await press(page, '#s-sell-LINK', '/orders'); // rejected unless the decision bought LINK; the oracle mirrors either outcome
    oracle.apply({kind: 'order', asset: 'LINK', side: 'sell'});
    await press(page, '#s-next-frame', '/advance');
    oracle.apply({kind: 'frames', count: 3});
    await press(page, '#s-next-frame', '/advance');
    await press(page, '#s-next-frame', '/advance');
    await press(page, '#s-finish', '/advance');
    oracle.apply({kind: 'finish'});
    const finished = await assertMatchesOracle(page, oracle, 'before save');
    assert.equal(await page.locator('#s-saved').textContent(), 'Not saved yet');

    await press(page, '#s-save', '/save');
    assert.match(await page.locator('#s-notice').textContent() ?? '', /^Snapshot saved to run history/);
    assert.equal(await page.locator('#s-saved').textContent(), 'Saved (up to date)');
    const afterSave = await read(page);
    assert.ok(afterSave.version > finished.version, 'saving is a versioned change and the page tracks it');

    const before = seen.order.length;
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    await idle(page);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    const sequence = seen.order.slice(before).filter(line => !line.startsWith('GET ')); // reads of the account panels are not changes
    assert.deepEqual(sequence, ['POST /v1/sessions/' + finished.id + '/save'], 'export saves first');
    assert.ok(download.suggestedFilename().startsWith('paper-trail-') && download.suggestedFilename().endsWith('-run.json'));

    const want = oracle.snapshot();
    assert.equal(record.format, 'paper-trail-run-v2');
    assert.equal(record.name, 'browser session export');
    assert.match(record.hashes.configSha256, /^[0-9a-f]{64}$/);
    assert.match(record.hashes.marketSha256, /^[0-9a-f]{64}$/);
    const counts: Record<string, number> = {};
    for (const e of record.account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
    assert.deepEqual(counts, want.ledgerCounts, 'exported ledger equals the oracle ledger by event type');
    assert.equal(record.account.ledger.length, want.ledgerLength);
    const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-9, `${what}: ${a} vs ${b}`);
    near(record.account.cash, want.cash, 'cash');
    near(record.account.positions.BTC.qty, want.qty.BTC, 'BTC qty');
    near(record.account.positions.LINK.qty, want.qty.LINK, 'LINK qty');
    near(record.summary.equity, want.equity, 'equity');
    near(record.summary.buyHoldEquity, want.buyHold, 'buy-and-hold');
    near(record.summary.fees, want.fees, 'fees');
    assert.equal(record.summary.tradeCount, want.tradeCount);
    // The BTC buy, plus the LINK sell when the decision before it had bought LINK.
    const manual = oracle.ledger().filter((e: any) => e.type === 'trade' && e.actor === 'manual').length;
    assert.ok(manual === 1 || manual === 2);
    assert.equal(record.manualTradeCount, manual);

    // The run is in history: through the API and in the page's own list.
    const state = await client.getSession(finished.id);
    assert.equal(record.id, state.runId);
    assert.ok((await client.listRuns()).some(run => run.id === record.id));
    await page.waitForFunction(() => document.getElementById('history')!.textContent!.includes('browser session export'));
    assert.match(await page.locator('#history-count').textContent() ?? '', /^\(\d+\)$/);

    // Closing keeps the snapshot; the same run still exports.
    await Promise.all([page.waitForResponse(r => r.request().method() === 'DELETE'), page.click('#s-close')]);
    assert.equal((await client.exportRun(record.id)).hashes.configSha256, record.hashes.configSha256);
    assert.match(await page.locator('#s-notice').textContent() ?? '', /^Session closed\. The saved snapshot remains/);
  }));

  it('imported nondefault timing settings survive start -> export (maxQuoteAgeMs 45000, maxOutcomeLatenessMs 12000)', t => scenario(t, async ({page}) => {
    await page.setInputFiles('#settings-file', settingsFile({maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, horizonMs: 300000, lookbackIntervals: 9, feeBps: 12}));
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Settings validated'));
    await page.fill('#slippageBps', '5');
    const view = await startSession(page);
    const live = await client.getSession(view.id);
    assert.equal(live.config.maxQuoteAgeMs, 45000);
    assert.equal(live.config.maxOutcomeLatenessMs, 12000);
    assert.equal(live.cursor, 9, 'the imported lookback sets the first scored frame');
    await press(page, '#s-next-frame', '/advance');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(record.config.maxQuoteAgeMs, 45000);
    assert.equal(record.config.maxOutcomeLatenessMs, 12000);
    assert.equal(record.config.horizonMs, 300000);
    assert.equal(record.config.feeBps, 12);
    assert.equal(record.config.slippageBps, 5, 'edited in the UI');
    assert.equal(record.account.config.maxQuoteAgeMs, 45000);
    const settings = await client.exportSettings(record.id);
    assert.equal(settings.config.maxQuoteAgeMs, 45000);
    assert.equal(settings.config.maxOutcomeLatenessMs, 12000);
  }));

  it('starting a new session closes the old one first and the one-shot replay still works', t => scenario(t, async ({page, seen}) => {
    const first = await startSession(page);
    assert.equal(await page.locator('#s-start').textContent(), 'Close and start a new session');
    const second = await startSession(page);
    assert.notEqual(second.id, first.id);
    const tail = seen.order.filter(line => !line.startsWith('GET ')).slice(-2);
    assert.deepEqual(tail, [`DELETE /v1/sessions/${first.id}`, 'POST /v1/sessions'], 'close before create');
    assert.equal((await client.getSession(first.id)).status, 'closed');
    assert.equal((await client.getSession(second.id)).status, 'active');
    await page.click('#view-config'); // starting a session moved the page to the Run view
    await page.click('#run');
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Replay complete'));
    assert.equal((await read(page)).id, second.id, 'a one-shot replay does not disturb the open session');
  }));
});
