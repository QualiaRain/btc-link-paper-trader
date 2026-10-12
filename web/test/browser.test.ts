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

  it('rejects date-range settings before applying anything, and then still runs the earlier settings as a sample', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({maxQuoteAgeMs: 45000, horizonMs: 900000}));
      await waitNotice(page, 'Settings validated');
      await page.setInputFiles('#settings-file', settingsFile({horizonMs: 60000, feeBps: 99},
        {source: 'range', start: '2024-03-09T12:00', end: '2024-03-09T13:00', halfSpreadBps: 2}));
      await waitNotice(page, 'Settings were not applied');
      assert.match(await notice(page), /only replays the included sample.*range.*not supported yet.*nothing was applied/i);
      assert.equal(await page.inputValue('#horizonMs'), '900000');
      assert.equal(await page.inputValue('#feeBps'), '10');
      const record = await runAndExport(page);
      assert.equal(record.config.maxQuoteAgeMs, 45000);
      assert.equal(record.config.horizonMs, 900000);
      assert.equal(record.market.settings.replay.source, 'sample');
      assert.equal(record.market.kind, 'sample');
    } finally { await page.close(); }
  });

  it('rejects live-session settings clearly instead of failing at run time', async t => {
    if (skipUnlessBrowser(t)) return;
    const page = await openPage();
    try {
      await page.setInputFiles('#settings-file', settingsFile({mode: 'live', feeBps: 99}));
      await waitNotice(page, 'Settings were not applied');
      assert.match(await notice(page), /replays only|only runs replays/i);
      assert.equal(await page.inputValue('#feeBps'), '10');
    } finally { await page.close(); }
  });
});
