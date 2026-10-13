// Date-range replays (candle jobs) and live paper sessions through the real page in Chromium, with the
// real Python API reading a loopback fake exchange. Range sessions are compared with the ROOT replay.js +
// engine.js; live sessions (wall-clock quotes) are checked structurally and with the original history.js.
import {after, before, describe, it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Browser, Page} from 'playwright-core';
import {PaperTrailClient} from '../src/client.ts';
import {startFakeExchange, type FakeExchange} from './fake-exchange.ts';
import {createRangeOracle, type RangeOracle} from './oracle.ts';
import {startApi, type RunningApi} from './server.ts';
import {assertMatchesOracle, assertNoFutureFrames, assertRunPanels, idle, launch, openPage, press, read, setVisibility, type Seen} from './support.ts';
import {verifyRecord} from './verify.ts';

let api: RunningApi;
let fake: FakeExchange;
let client: PaperTrailClient;
let browser: Browser | undefined;
let problem = '';
before(async () => {
  fake = await startFakeExchange();
  api = await startApi({env: {PAPER_TRAIL_CANDLE_BASE_URL: fake.baseUrl, PAPER_TRAIL_LIVE_BASE_URL: fake.baseUrl}});
  client = new PaperTrailClient({baseUrl: api.baseUrl});
  ({browser, problem} = await launch());
});
after(async () => { await browser?.close(); api?.stop(); await fake?.stop(); });

const RANGE = {start: '2024-03-09T08:00', end: '2024-03-09T15:00'};
const SHORT = {start: '2024-03-09T12:00', end: '2024-03-09T13:00'};
const COSTS = {bufferBps: 0, horizonMs: 300000, feeBps: 1, slippageBps: 0};
// The page leaves the half-spread at its default, so the oracle does too (both read configuration.js's default).
const rangeRequest = (range: {start: string; end: string}) => ({config: COSTS, replay: {source: 'range' as const, ...range}});

async function scenario(t: TestContext, query: string, body: (ctx: {page: Page; seen: Seen}) => Promise<void>): Promise<void> {
  if (!browser) { t.skip(`no Chromium available: ${problem}`); return; }
  const {page, seen} = await openPage(browser, api, {query});
  try {
    await body({page, seen});
    if (seen.responses.some(r => r.body?.state || r.body?.currentFrame)) assertNoFutureFrames(seen);
  } finally { fake.clearRules(); fake.releaseDelays(); await page.close(); }
}
// For scenarios that never start a session there are no session responses to check for future frames.
async function scenarioNoSession(t: TestContext, body: (ctx: {page: Page; seen: Seen}) => Promise<void>): Promise<void> {
  if (!browser) { t.skip(`no Chromium available: ${problem}`); return; }
  const {page, seen} = await openPage(browser, api);
  try { await body({page, seen}); } finally { fake.clearRules(); fake.releaseDelays(); await page.close(); }
}

/** Fill the Config form for a date-range replay with the cheap-cost settings that make the series trade. */
async function configureRange(page: Page, range: {start: string; end: string}, name = ''): Promise<void> {
  await page.click('#view-config');
  await page.selectOption('#replaySource', 'range');
  await page.fill('#rangeStart', range.start);
  await page.fill('#rangeEnd', range.end);
  await page.selectOption('#horizonMs', '300000');
  await page.fill('#bufferBps', '0');
  await page.fill('#feeBps', '1');
  await page.fill('#slippageBps', '0');
  if (name) await page.fill('#name', name);
}
const waitActive = (page: Page) => page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'active', undefined, {timeout: 60_000});
const sessionNotice = (page: Page) => page.locator('#s-notice').innerText();
const waitSessionNotice = (page: Page, prefix: string) =>
  page.waitForFunction(text => document.getElementById('s-notice')!.textContent!.startsWith(text), prefix, {timeout: 60_000});
const truth = (oracle: RangeOracle) => ({account: oracle.account(), summary: oracle.summary(), quotes: oracle.quotes()});

describe('date-range replay through the page (fake exchange)', () => {
  it('shows fetch progress, then starts a session whose scored range, finish result and export evidence match the root replay.js oracle', t => scenario(t, '', async ({page}) => {
    const requestsBefore = fake.count('candles');
    const runsBefore = (await client.listRuns()).length;
    fake.inject({match: r => r.kind === 'candles', delayMs: 700}); // slow enough for progress to be seen between polls
    await configureRange(page, RANGE, 'range browser run');
    assert.equal(await page.locator('#s-start').innerText(), 'Fetch & start replay');
    await page.evaluate(() => {
      (window as any).__progress = [];
      const bar = document.getElementById('fetch-progress') as HTMLProgressElement;
      new MutationObserver(() => (window as any).__progress.push([bar.value, bar.max])).observe(bar, {attributes: true});
    });
    await page.click('#s-start');
    await page.locator('#fetch-state').waitFor({state: 'visible'});
    assert.equal(await page.locator('#s-start').isDisabled(), true, 'one start at a time');
    await waitActive(page);
    await idle(page);
    const progress = await page.evaluate(() => (window as any).__progress as [number, number][]);
    assert.ok(progress.length >= 3, `progress was shown: ${JSON.stringify(progress)}`);
    assert.ok(progress.every(([value, max]) => value >= 0 && value <= max), 'the bar never exceeds its maximum');
    assert.equal(progress.at(-1)![1], 4, 'the maximum is the four batches (two per asset)');
    assert.ok(progress.some(([value]) => value > 0 && value < 4), 'the bar advanced through intermediate values');
    assert.deepEqual(progress.map(p => p[0]), [...progress.map(p => p[0])].sort((a, b) => a - b), 'and never went backwards');
    assert.equal(await page.locator('#fetch-state').isHidden(), true);
    assert.match(await page.locator('#fetch-summary').innerText(), /^Retrieved 4 requests · BTC 421 of 421 minutes \(0 missing\) · LINK 421 of 421 minutes \(0 missing\)$/);
    assert.equal(fake.count('candles') - requestsBefore, 4);
    fake.clearRules();

    const view = await read(page);
    const server = await client.getSession(view.id);
    assert.equal(server.kind, 'historical');
    assert.equal(server.scoreStart, Date.parse(`${RANGE.start}:00Z`));
    assert.equal(server.scoreEnd, Date.parse(`${RANGE.end}:00Z`));
    assert.equal((await client.listRuns()).length, runsBefore, 'nothing is in history before a save');
    const oracle = await createRangeOracle(rangeRequest(RANGE));
    assert.equal(oracle.fetchCount, 4);
    await assertMatchesOracle(page, client, oracle, 'range start');
    await press(page, '#s-next-frame', '/advance');
    oracle.apply({kind: 'frames', count: 1});
    await press(page, '#s-next-decision', '/advance');
    oracle.apply({kind: 'decision'});
    await assertMatchesOracle(page, client, oracle, 'range decision');
    await press(page, '#s-finish', '/advance');
    oracle.apply({kind: 'finish'});
    const done = await assertMatchesOracle(page, client, oracle, 'range finished');
    assert.equal(done.status, 'completed');
    assert.equal(done.time, Date.parse(`${RANGE.end}:00Z`));
    assert.ok(oracle.snapshot().tradeCount > 0, 'the comparison is not vacuous');
    await assertRunPanels(page, truth(oracle), 'range panels');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(record.name, 'range browser run');
    assert.equal(record.market.dataset.provenance.length, fake.count('candles') - requestsBefore, 'exported receipts equal the exchange request count');
    const checked = verifyRecord(record);
    assert.ok(checked.configHashOk && checked.marketHashOk && checked.historyRestored, JSON.stringify(checked));
    assert.equal(checked.futureFrames, 0);
    assert.equal(record.market.settings.replay.source, 'range');
    assert.equal(record.market.settings.replay.start, RANGE.start);
    assert.equal(record.summary.equity, oracle.summary().equity);
    assert.equal((await client.listRuns()).length, runsBefore + 1);
  }));

  it('skips minutes the exchange does not report, like the root replay.js', t => scenario(t, '', async ({page}) => {
    fake.gaps['BTC'] = new Set([Date.parse('2024-03-09T12:10:00Z'), Date.parse('2024-03-09T12:11:00Z')]);
    fake.gaps['LINK'] = new Set([Date.parse('2024-03-09T12:30:00Z')]);
    try {
      await configureRange(page, SHORT);
      await page.click('#s-start');
      await waitActive(page);
      await idle(page);
      assert.match(await page.locator('#fetch-summary').innerText(), /BTC 59 of 61 minutes \(2 missing\) · LINK 60 of 61 minutes \(1 missing\)/);
      const oracle = await createRangeOracle(rangeRequest(SHORT), fake.gaps);
      const view = await read(page);
      assert.equal(view.frameCount, 58);
      assert.equal(view.frameCount, oracle.snapshot().frameCount);
      await press(page, '#s-finish', '/advance');
      oracle.apply({kind: 'finish'});
      await assertMatchesOracle(page, client, oracle, 'gapped');
      await assertRunPanels(page, truth(oracle), 'gapped panels');
    } finally { delete fake.gaps['BTC']; delete fake.gaps['LINK']; }
  }));

  it('imported timing limits and a date range survive import -> fetch -> session -> export', t => scenario(t, '', async ({page}) => {
    const file = {name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'paper-trail-settings-v2',
      config: {...COSTS, maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000}, replay: {source: 'range', ...SHORT, halfSpreadBps: 3}}))};
    await page.setInputFiles('#settings-file', file);
    await page.waitForFunction(() => (document.getElementById('replaySource') as HTMLSelectElement).value === 'range');
    assert.equal(await page.inputValue('#rangeStart'), SHORT.start);
    await page.click('#s-start');
    await waitActive(page);
    await idle(page);
    const view = await read(page);
    const config = (await client.getSession(view.id)).config;
    assert.equal(config.maxQuoteAgeMs, 45000);
    assert.equal(config.maxOutcomeLatenessMs, 12000);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(record.config.maxQuoteAgeMs, 45000);
    assert.equal(record.config.maxOutcomeLatenessMs, 12000);
    assert.equal(record.market.settings.replay.halfSpreadBps, 3);
    assert.equal(record.market.settings.replay.start, SHORT.start);
  }));

  it('Cancel during retrieval creates no session and no run', t => scenarioNoSession(t, async ({page, seen}) => {
    const runsBefore = (await client.listRuns()).length;
    const requestsBefore = fake.count('candles');
    fake.inject({match: r => r.kind === 'candles', delayMs: 30_000});
    await configureRange(page, SHORT);
    await page.click('#s-start');
    await page.locator('#fetch-state').waitFor({state: 'visible'});
    while (fake.count('candles') === requestsBefore) await new Promise(resolve => setTimeout(resolve, 50)); // the exchange has the request and is holding it
    await page.click('#fetch-cancel');
    await waitSessionNotice(page, 'Historical fetch canceled. No run was created.');
    await idle(page);
    assert.equal(await page.locator('#fetch-state').isHidden(), true);
    assert.equal((await read(page)).panel, 'none');
    assert.equal((await client.listRuns()).length, runsBefore);
    assert.equal(seen.order.filter(line => line === 'POST /v1/sessions').length, 0, 'no session was ever requested');
    assert.ok(seen.order.some(line => /^POST \/v1\/candle-jobs\/[0-9a-f]+\/cancel$/.test(line)));
    assert.equal(await page.locator('#s-start').isEnabled(), true, 'the person can start again');
  }));

  it('an HTTP 500 from the exchange shows an error and creates no session or run', t => scenarioNoSession(t, async ({page, seen}) => {
    const runsBefore = (await client.listRuns()).length;
    fake.inject({match: r => r.kind === 'candles', status: 500, body: '{"message":"boom"}'});
    await configureRange(page, SHORT);
    await page.click('#s-start');
    await waitSessionNotice(page, 'Historical fetch failed');
    await idle(page);
    assert.match(await sessionNotice(page), /^Historical fetch failed: Coinbase HTTP 500\. No run was created\.$/);
    assert.equal(await page.locator('#s-notice').evaluate(node => node.classList.contains('error')), true);
    assert.equal((await read(page)).panel, 'none');
    assert.equal((await client.listRuns()).length, runsBefore);
    assert.equal(seen.order.filter(line => line === 'POST /v1/sessions').length, 0);
  }));

  it('a job used with changed settings surfaces job_mismatch and creates nothing', t => scenarioNoSession(t, async ({page, seen}) => {
    const runsBefore = (await client.listRuns()).length;
    await configureRange(page, SHORT);
    await page.route('**/v1/sessions', async route => { // the lookback changes after the job was made
      const body = route.request().postDataJSON();
      body.settings.config.lookbackIntervals = 9;
      await route.continue({postData: JSON.stringify(body)});
    });
    await page.click('#s-start');
    await waitSessionNotice(page, 'This candle job was created for');
    assert.match(await sessionNotice(page), /lookback 7.*lookback 9|settings ask for/);
    await idle(page);
    assert.equal((await read(page)).panel, 'none');
    assert.equal((await client.listRuns()).length, runsBefore);
    const response = seen.responses.find(r => r.method === 'POST' && r.url.endsWith('/v1/sessions'));
    assert.equal(response?.body.error.code, 'job_mismatch');
  }));

  it('an incomplete or backwards date range is refused before anything is requested', t => scenarioNoSession(t, async ({page, seen}) => {
    await page.selectOption('#replaySource', 'range');
    await page.click('#s-start');
    assert.match(await sessionNotice(page), /^Choose a UTC start and end minute for the date range\./);
    await page.fill('#rangeStart', SHORT.end);
    await page.fill('#rangeEnd', SHORT.start);
    await page.click('#s-start');
    assert.match(await sessionNotice(page), /^The range end must be after its start/);
    assert.equal(seen.order.filter(line => line.includes('candle-jobs')).length, 0);
  }));
});

describe('live paper sessions through the page (fake exchange)', () => {
  it('starts, ticks now three times, survives a 502 unchanged, trades manually, and exports a verifying record', t => scenario(t, '', async ({page}) => {
    await page.fill('#name', 'live browser run');
    await page.fill('#allocation', '25'); // automatic entries leave half the cash, so the manual buy below always has cash
    await page.click('#s-start-live');
    await waitActive(page);
    await idle(page);
    const first = await read(page);
    const panel = page.locator('#session-panel');
    assert.equal(await panel.getAttribute('data-kind'), 'live');
    assert.match(await page.locator('#run-badge').innerText(), /^Live paper · running$/);
    assert.equal(await page.locator('#s-next-frame').isHidden(), true, 'replay stepping is not offered');
    assert.equal(await page.locator('#s-tick').isVisible(), true);
    assert.equal(await page.locator('#s-play').innerText(), 'Pause live');
    assert.match(await page.locator('#s-cursor').innerText(), /^1 live observation$/);
    assert.ok(Math.abs(first.time - Date.now()) < 15_000);
    await page.click('#s-play'); // pause the automatic ticking so only "Tick now" moves the session
    assert.equal(await page.locator('#s-play').innerText(), 'Resume live');
    let last = first;
    for (let i = 1; i <= 3; i++) {
      await page.waitForTimeout(5);
      await press(page, '#s-tick', '/tick');
      const view = await read(page);
      assert.equal(view.frameCount, 1 + i, 'frames count increments');
      assert.equal(view.version, last.version + 1, 'version increments');
      assert.ok(view.time > last.time);
      assert.equal((await client.getSession(view.id)).version, view.version);
      last = view;
    }
    assert.match(await page.locator('#s-cursor').innerText(), /^4 live observations$/);
    // The exchange fails: the notice says so and nothing changes.
    fake.inject({match: r => r.kind === 'ticker', status: 503, body: '{}'});
    await press(page, '#s-tick', '/tick');
    fake.clearRules();
    const failed = await read(page);
    assert.match(failed.notice, /^Live quotes unavailable: .*\. The session was not changed\.$/);
    assert.equal(failed.noticeIsError, true);
    assert.equal(failed.version, last.version);
    assert.equal(failed.frameCount, last.frameCount);
    assert.deepEqual((await client.getSession(failed.id)).version, last.version);
    // A manual order trades at a fresh frame.
    await press(page, '#s-buy-BTC', '/orders');
    const traded = await read(page);
    assert.equal(traded.tradeCount, last.tradeCount + 1);
    assert.equal(traded.frameCount, last.frameCount + 1, 'the order fetched a fresh frame first');
    assert.equal(traded.version, last.version + 1);
    assert.ok(traded.qty.BTC > 0);
    const account = (await client.getSessionAccount(traded.id)).account;
    assert.equal(await page.locator('#chart-svg').getAttribute('data-points'), String(account.equity.length));
    // Save + export, verified with the original app's own record checks.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    const checked = verifyRecord(record);
    assert.ok(checked.configHashOk && checked.marketHashOk, JSON.stringify(checked));
    assert.equal(checked.futureFrames, 0);
    assert.equal(record.name, 'live browser run');
    assert.equal(record.config.mode, 'live');
    assert.equal(record.manualTradeCount, 1);
    assert.equal(record.id, traded.runId);
  }));

  it('ticks automatically only while the page is visible: stops when hidden, resumes when visible, never overlapping', t => scenario(t, '?liveTickMs=300', async ({page, seen}) => {
    await page.click('#s-start-live');
    await waitActive(page);
    const ticks = () => seen.order.filter(line => line.endsWith('/tick')).length;
    const tickers = () => fake.requests.filter(r => r.kind === 'ticker').length;
    await page.waitForFunction(() => Number(document.getElementById('s-cursor')!.dataset['frameCount']) >= 3, undefined, {timeout: 30_000});
    assert.ok(ticks() >= 2, 'automatic ticks happened without any click');
    assert.equal(await page.locator('#session-panel').getAttribute('data-live'), 'true');

    await setVisibility(page, true);
    await page.waitForTimeout(400); // let an in-flight tick land
    await idle(page);
    const frozen = {ticks: ticks(), tickers: tickers(), frames: (await read(page)).frameCount};
    await page.waitForTimeout(1500); // five intervals' worth of hidden time
    assert.deepEqual({ticks: ticks(), tickers: tickers(), frames: (await read(page)).frameCount}, frozen, 'no tick request while the tab is hidden');
    assert.match(await sessionNotice(page), /paused while this tab is hidden/);

    await setVisibility(page, false);
    await page.waitForFunction(count => Number(document.getElementById('s-cursor')!.dataset['frameCount']) > count, frozen.frames, {timeout: 30_000});
    assert.ok(ticks() > frozen.ticks, 'ticking resumed when the page became visible again');
    assert.equal(seen.maxTickInFlight, 1, 'ticks never overlap');

    // Pausing stops the timer for good; Resume starts it again.
    await page.click('#s-play');
    await page.waitForTimeout(500);
    await idle(page);
    const paused = ticks();
    await page.waitForTimeout(1000);
    assert.equal(ticks(), paused, 'a paused live session does not tick');
    await page.click('#s-play');
    await page.waitForTimeout(800);
    assert.ok(ticks() > paused, 'resumed');
    assert.equal(seen.maxTickInFlight, 1);
  }));

  it('imported live settings (timing limits, duration) survive into the live session and its export', t => scenario(t, '', async ({page}) => {
    const file = {name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'paper-trail-settings-v2',
      config: {mode: 'live', maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, durationMs: 5_400_000, feeBps: 7}, replay: {source: 'sample', halfSpreadBps: 2}}))};
    await page.setInputFiles('#settings-file', file);
    await page.waitForFunction(() => (document.getElementById('liveHours') as HTMLInputElement).value === '1.5');
    await page.fill('#slippageBps', '4'); // one explicit edit on top of the import
    await page.click('#s-start-live');
    await waitActive(page);
    await idle(page);
    await page.click('#s-play'); // pause the automatic ticks; this test is about the settings
    const view = await read(page);
    const live = await client.getSession(view.id);
    assert.equal(live.config.mode, 'live');
    assert.equal(live.config.maxQuoteAgeMs, 45000);
    assert.equal(live.config.maxOutcomeLatenessMs, 12000);
    assert.equal(live.config.feeBps, 7);
    assert.equal(live.config.slippageBps, 4);
    assert.equal(live.scoreEnd - live.scoreStart, 5_400_000);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(record.config.maxQuoteAgeMs, 45000);
    assert.equal(record.config.maxOutcomeLatenessMs, 12000);
  }));

  it('a live start while the exchange is down shows the error and leaves no session', t => scenarioNoSession(t, async ({page}) => {
    fake.inject({match: r => r.kind === 'ticker', status: 500, body: '{}'});
    await page.click('#s-start-live');
    await waitSessionNotice(page, 'Live quotes unavailable');
    await idle(page);
    assert.match(await sessionNotice(page), /No live session was started\.$/);
    assert.equal((await read(page)).panel, 'none');
    fake.clearRules();
    await page.click('#s-start-live');
    await waitActive(page);
    assert.equal(await page.locator('#session-panel').getAttribute('data-kind'), 'live');
  }));
});
