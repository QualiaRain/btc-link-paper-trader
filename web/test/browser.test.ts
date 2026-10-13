// Real-browser regression tests: the built UI (web/public) in Chromium against the real Python API.
// Needs a Chromium: $CHROMIUM_PATH, or /opt/pw-browsers/chromium, or Playwright's own install
// (`npx playwright-core install chromium`). Without one the tests are skipped unless
// REQUIRE_BROWSER=1 (scripts/verify.sh sets it), in which case a missing browser is a failure.
import {after, before, describe, it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {chromium, type Browser, type Page} from 'playwright-core';
import {startApi, type RunningApi} from './server.ts';

let api: RunningApi;
let browser: Browser | undefined;
let launchProblem = '';

before(async () => {
  api = await startApi();
  const executablePath = process.env['CHROMIUM_PATH'] ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  try {
    browser = await chromium.launch({
      executablePath, args: ['--no-proxy-server', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    });
  } catch (error) {
    launchProblem = (error as Error).message.split('\n')[0] ?? 'unknown error';
    if (process.env['REQUIRE_BROWSER']) throw new Error(`REQUIRE_BROWSER is set but Chromium could not start: ${launchProblem}`);
  }
});

after(async () => {
  await browser?.close();
  api?.stop();
});

const settingsFile = (config: Record<string, unknown>, replay: Record<string, unknown> = {source: 'sample', halfSpreadBps: 2}) =>
  ({name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'paper-trail-settings-v2', config, replay}))});

async function openPage(): Promise<Page> {
  const page = await browser!.newPage({acceptDownloads: true});
  await page.goto(api.baseUrl);
  await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Connected'));
  return page;
}
const notice = (page: Page): Promise<string> => page.locator('#notice').innerText();
const waitNotice = (page: Page, prefix: string) =>
  page.waitForFunction(text => document.getElementById('notice')!.textContent!.startsWith(text), prefix);

async function runAndExport(page: Page): Promise<any> {
  await page.click('#run');
  await waitNotice(page, 'Replay complete');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-run')]);
  return JSON.parse(readFileSync((await download.path())!, 'utf8'));
}

describe('settings survive the UI round trip (real Chromium, real Python API)', () => {
  const skipUnlessBrowser = (t: TestContext): boolean => {
    if (!browser) t.skip(`no Chromium available: ${launchProblem}`);
    return !browser;
  };

  it('keeps imported timing and other undisplayed settings, overlaying only edited fields', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({
        mode: 'replay', maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, allocationFraction: 0.07,
        horizonMs: 300000, lookbackIntervals: 9, feeBps: 12,
      }, {source: 'sample', halfSpreadBps: 3}));
      await waitNotice(page, 'Settings validated');
      assert.equal(await page.inputValue('#allocation'), '7', 'allocation is shown without floating point noise');
      await page.fill('#slippageBps', '5'); // the only explicit edit
      const record = await runAndExport(page);
      const c = record.config;
      assert.equal(c.maxQuoteAgeMs, 45000);
      assert.equal(c.maxOutcomeLatenessMs, 12000);
      assert.equal(c.allocationFraction, 0.07, 'an unedited fraction must not be rebuilt from its percentage');
      assert.equal(c.horizonMs, 300000);
      assert.equal(c.lookbackIntervals, 9);
      assert.equal(c.feeBps, 12, 'imported, unedited');
      assert.equal(c.slippageBps, 5, 'edited in the UI');
      assert.equal(c.initialCash, 1000);
      assert.equal(record.account.config.maxQuoteAgeMs, 45000);
      assert.equal(record.market.dataset.assumptions.halfSpreadBps, 3);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-settings')]);
      const exported = JSON.parse(readFileSync((await download.path())!, 'utf8'));
      assert.equal(exported.config.maxQuoteAgeMs, 45000);
      assert.equal(exported.config.maxOutcomeLatenessMs, 12000);
    } finally { await page.close(); }
  });

  it('a later import replaces the earlier one completely', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, horizonMs: 900000}));
      await waitNotice(page, 'Settings validated');
      await page.setInputFiles('#settings-file', settingsFile({horizonMs: 300000}));
      await waitNotice(page, 'Settings validated');
      const c = (await runAndExport(page)).config;
      assert.equal(c.maxQuoteAgeMs, 60000);
      assert.equal(c.maxOutcomeLatenessMs, 30000);
      assert.equal(c.horizonMs, 300000);
    } finally { await page.close(); }
  });

  it('without an import, defaults and only the edited fields are sent', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.fill('#feeBps', '25');
      const c = (await runAndExport(page)).config;
      assert.equal(c.feeBps, 25);
      assert.equal(c.maxQuoteAgeMs, 60000);
      assert.equal(c.initialCash, 1000);
      assert.equal(c.allocationFraction, 0.5);
    } finally { await page.close(); }
  });

  it('risk limits and the cash yield (shown in % per year) travel through the form and show in history and snapshots', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({horizonMs: 300000, bufferBps: 0, maxDrawdownBps: 40, cashYieldBps: 450}));
      await waitNotice(page, 'Settings validated');
      assert.equal(await page.inputValue('#maxDrawdownBps'), '40');
      assert.equal(await page.inputValue('#dailyLossBps'), '0');
      assert.equal(await page.inputValue('#cashYield'), '4.5', 'bps are shown as percent per year');
      await page.fill('#dailyLossBps', '25');
      await page.fill('#cashYield', '20');
      const record = await runAndExport(page);
      const c = record.config;
      assert.deepEqual([c.maxDrawdownBps, c.dailyLossBps, c.cashYieldBps], [40, 25, 2000]);
      assert.ok(record.summary.riskHalts > 0 && record.summary.interestEarned > 0 && record.summary.cashBenchmark > 1000);
      const card = page.locator(`#history [data-run-id="${record.id}"]`);
      await card.waitFor({state: 'attached'});
      assert.match(await card.textContent() ?? '', new RegExp(`${record.summary.riskHalts} risk halts?[\\s\\S]*drawdown limit 40 bps · daily loss 25 bps · cash yield 20%/yr`));
      await page.click('#view-history');
      await card.locator('[data-action=open]').click();
      await page.locator('#snapshot-banner').waitFor({state: 'visible'});
      assert.match(await page.locator('#cash-legend').innerText(), /\$1,000 cash at 20%\/yr/);
      if (record.summary.tradingHalted)
        assert.match(await page.locator('#run-detail').innerText(), /entries halted by (drawdown|daily loss) limit$/);
      await page.selectOption('#ledger-filter', 'decisions');
      const blocked = record.account.ledger.filter((e: any) => e.type === 'decision' && e.blockedBy).length;
      if (blocked) assert.ok(await page.locator('#ledger tr[data-type=decision]', {hasText: 'blocked by'}).count() > 0);
    } finally { await page.close(); }
  });

  it('applies date-range settings and sends them to the candle job; the one-shot replay stays a sample', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({maxQuoteAgeMs: 45000, horizonMs: 900000}));
      await waitNotice(page, 'Settings validated');
      await page.setInputFiles('#settings-file', settingsFile({horizonMs: 60000, feeBps: 99},
        {source: 'range', start: '2024-03-09T12:00', end: '2024-03-09T13:00', halfSpreadBps: 2}));
      await page.waitForFunction(() => (document.getElementById('replaySource') as HTMLSelectElement).value === 'range');
      assert.equal(await page.inputValue('#replaySource'), 'range');
      assert.equal(await page.inputValue('#rangeStart'), '2024-03-09T12:00');
      assert.equal(await page.inputValue('#rangeEnd'), '2024-03-09T13:00');
      assert.equal(await page.locator('#range-fields').isVisible(), true);
      assert.equal(await page.inputValue('#horizonMs'), '60000');
      assert.equal(await page.inputValue('#feeBps'), '99');
      assert.equal(await page.locator('#s-start').innerText(), 'Fetch & start replay');
      // The range is what the start button sends (the request is intercepted: no exchange is configured here).
      let jobRequest: any;
      await page.route('**/v1/candle-jobs', async route => {
        jobRequest = route.request().postDataJSON();
        await route.fulfill({status: 422, contentType: 'application/json', body: JSON.stringify({error: {code: 'invalid_request', message: 'stubbed: nothing was fetched'}})});
      });
      await page.click('#s-start');
      await page.waitForFunction(() => document.getElementById('s-notice')!.textContent!.includes('stubbed: nothing was fetched'));
      assert.deepEqual(jobRequest, {start: '2024-03-09T12:00', end: '2024-03-09T13:00', lookbackIntervals: 7, model: 'trend'});
      assert.equal(await page.locator('#session-panel').getAttribute('data-status'), 'none', 'no session was created');
      // The earlier import was replaced completely; the one-shot replay still replays the included sample with the applied costs.
      const record = await runAndExport(page);
      assert.equal(record.config.maxQuoteAgeMs, 60000);
      assert.equal(record.config.horizonMs, 60000);
      assert.equal(record.config.feeBps, 99);
      assert.equal(record.market.settings.replay.source, 'sample');
      assert.equal(record.market.kind, 'sample');
    } finally { await page.close(); }
  });

  it('applies live-session settings and enables the live start with them', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({mode: 'live', feeBps: 99, durationMs: 7200000}));
      await waitNotice(page, 'Settings validated');
      assert.match(await notice(page), /live-session settings.*Start live paper session/);
      assert.equal(await page.inputValue('#feeBps'), '99');
      assert.equal(await page.inputValue('#liveHours'), '2');
      assert.equal(await page.locator('#s-start-live').isEnabled(), true);
      // Intercepted: the point is what the live start sends, not a real exchange read.
      let created: any;
      await page.route('**/v1/sessions', async route => {
        created = route.request().postDataJSON();
        await route.fulfill({status: 502, contentType: 'application/json', body: JSON.stringify({error: {code: 'live_unavailable', message: 'stubbed exchange'}})});
      });
      await page.click('#s-start-live');
      await page.waitForFunction(() => document.getElementById('s-notice')!.textContent!.startsWith('Live quotes unavailable'));
      assert.equal(created.settings.config.mode, 'live');
      assert.equal(created.settings.config.feeBps, 99);
      assert.equal(created.settings.config.durationMs, 7200000);
      assert.equal(created.candleJobId, undefined);
    } finally { await page.close(); }
  });
});
