// History, read-only snapshots, "Use settings", export-all, reload reattachment, archiving and
// races between history actions and a running step: real Chromium, real API, JS oracle.
import {after, before, describe, it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Browser, Page} from 'playwright-core';
import {PaperTrailClient, type RunRecord} from '../src/client.ts';
import {createOracle, assertParity, observe, type Oracle} from './oracle.ts';
import {repo, startApi, type RunningApi} from './server.ts';
import {assertCoverageShown, assertMatchesOracle, assertNoFutureFrames, assertRunPanels, connected, idle, launch, openPage, press, read, readPanels, startSession, SAMPLE_COVERAGE_LINE, type Seen} from './support.ts';

let api: RunningApi;
let client: PaperTrailClient;
let browser: Browser | undefined;
let problem = '';
const fixture = (name: string): RunRecord => JSON.parse(readFileSync(repo(`parity/fixtures/${name}.json`), 'utf8')) as RunRecord;
const COMPLETED = fixture('browser-run-completed'), PARTIAL = fixture('browser-run-partial-manual'), LIVE = fixture('browser-run-live-partial');

before(async () => {
  api = await startApi();
  client = new PaperTrailClient({baseUrl: api.baseUrl});
  for (const record of [COMPLETED, PARTIAL, LIVE]) await client.importRun(record);
  ({browser, problem} = await launch());
});
after(async () => { await browser?.close(); api?.stop(); });

async function scenario(t: TestContext, body: (ctx: {page: Page; seen: Seen; oracle: Oracle}) => Promise<void>): Promise<void> {
  if (!browser) { t.skip(`no Chromium available: ${problem}`); return; }
  const {page, seen} = await openPage(browser, api);
  try { await body({page, seen, oracle: await createOracle()}); assertNoFutureFrames(seen); }
  finally { await page.close(); }
}
const truth = (oracle: Oracle) => ({account: oracle.account(), summary: oracle.summary(), quotes: oracle.quotes()});
const card = (page: Page, runId: string) => page.locator(`#history [data-run-id="${runId}"]`);
const notice = (page: Page) => page.locator('#notice').innerText();
const visible = (page: Page, selector: string) => page.locator(selector).isVisible();
const MUTATING = /\/(advance|orders|save)$/;

async function openHistory(page: Page, runId?: string): Promise<void> {
  await page.click('#view-history');
  if (runId) await card(page, runId).waitFor();
}
async function step(page: Page, oracle: Oracle, selector: string, url: string, action: Parameters<Oracle['apply']>[0]): Promise<void> {
  await press(page, selector, url);
  oracle.apply(action);
}

describe('history, snapshots and reload (real Chromium, real API, JS oracle)', () => {
  it('lists runs saved in the page and imported ones; opens any as a read-only snapshot without a mutating request', t => scenario(t, async ({page, seen, oracle}) => {
    await page.fill('#name', 'history source');
    const live = await startSession(page);
    await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1});
    await step(page, oracle, '#s-buy-BTC', '/orders', {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100});
    await press(page, '#s-save', '/save');
    await openHistory(page, live.runId);
    for (const id of [COMPLETED.id, PARTIAL.id, LIVE.id]) assert.equal(await card(page, id).count(), 1, `imported ${id} is listed`);
    const mine = card(page, live.runId);
    assert.match(await mine.innerText(), /history source[\s\S]*Partial snapshot · replay · manual changes · saved/);
    assert.equal(Number(await mine.locator('[data-field=equity]').getAttribute('data-raw')), oracle.summary().equity);
    assert.match(await card(page, COMPLETED.id).innerText(), /Complete · replay/);
    assert.match(await card(page, LIVE.id).innerText(), /live/);
    assert.match(await page.locator('#history-count').innerText(), /^\(\d+\)$/);
    const listed = await client.listRuns();
    assert.equal(await page.locator('#history [data-run-id]').count(), listed.length);
    // Coverage is part of the answer: each card says what its data held and how it was obtained. The sample run
    // states data/README.md's numbers; the three legacy browser exports say what they did not record.
    const coverageOf = (id: string) => card(page, id).locator('[data-field=coverage]').innerText();
    assert.equal(await coverageOf(live.runId), SAMPLE_COVERAGE_LINE);
    const mineListed = listed.find(run => run.id === live.runId)!;
    assert.deepEqual(mineListed.coverage, {BTC: {expectedCount: 1800, observedCount: 1648, missingCount: 152, warmupObservedCount: oracle.lookback},
      LINK: {expectedCount: 1800, observedCount: 1648, missingCount: 152, warmupObservedCount: oracle.lookback}});
    assert.equal(mineListed.receiptCount, 0);
    assert.equal(await coverageOf(COMPLETED.id), 'Minute coverage not recorded for this run · 0 fetch receipts (bundled data, no fetch) · gap and invalid-frame counts not recorded.');
    assert.equal(await coverageOf(LIVE.id), 'Live quotes: no minute coverage is expected · gap and invalid-frame counts not recorded.');
    assert.equal(LIVE.account.ledger.filter(e => e.type === 'gap').length, 1, 'the legacy live export really holds a gap, which is never shown as zero');

    // A snapshot of the run an active session owns still opens read-only.
    const mark = seen.order.length;
    await mine.locator('[data-action=open]').click();
    await page.locator('#snapshot-banner').waitFor({state: 'visible'});
    assert.equal(await visible(page, '#run-view'), true);
    assert.match(await page.locator('#snapshot-text').innerText(), /^Read-only snapshot of “history source” \(run /);
    assert.equal(await page.locator('#snapshot-close').innerText(), 'Back to live session');
    for (const id of ['s-next-frame', 's-next-decision', 's-play', 's-finish', 's-save', 's-export', 's-buy-BTC', 's-sell-BTC', 's-archive'])
      assert.equal(await page.locator(`#${id}`).isVisible() && await page.locator(`#${id}`).isEnabled(), false, `${id} is not usable on a snapshot`);
    assert.equal(await page.locator('#s-state').isHidden(), true);
    await assertRunPanels(page, truth(oracle), 'snapshot of the live session\'s run');
    assertCoverageShown((await readPanels(page)).coverage, {coverage: mineListed.coverage, receiptCount: 0, summary: oracle.summary()}, 'snapshot coverage');
    assert.equal((await readPanels(page)).coverage.text, SAMPLE_COVERAGE_LINE);
    const requests = seen.order.slice(mark);
    assert.ok(requests.every(line => line.startsWith('GET ')) && !requests.some(line => MUTATING.test(line)), `only reads: ${requests.join(', ')}`);
    assert.ok(requests.includes(`GET /v1/runs/${live.runId}`));

    // Imported browser runs open through the same read-only code.
    await page.click('#snapshot-close');
    assert.equal(await page.locator('#snapshot-banner').isHidden(), true);
    await assertMatchesOracle(page, client, oracle, 'back on the live session'); // version and numbers untouched
    await openHistory(page, PARTIAL.id);
    await card(page, PARTIAL.id).locator('[data-action=open]').click();
    await page.locator('#snapshot-banner').waitFor({state: 'visible'});
    const quotes = (PARTIAL.market as any).lastObservedFrame.quotes;
    await assertRunPanels(page, {account: PARTIAL.account as any, summary: PARTIAL.summary, quotes}, 'imported partial run');
    const panels = await readPanels(page);
    assert.equal(panels.assets['BTC']!.cost, 100);
    assert.equal(panels.assets['BTC']!.qty, PARTIAL.account.positions.BTC.qty);
    assert.equal(panels.chart.count, PARTIAL.account.equity.length);
    assert.match(await page.locator('#run-badge').innerText(), /read-only snapshot · partial/);
    assertCoverageShown(panels.coverage, {coverage: null, receiptCount: 0, summary: PARTIAL.summary}, 'legacy partial snapshot');
    assert.equal(panels.coverage.text, 'Minute coverage not recorded for this run · 0 fetch receipts (bundled data, no fetch) · gap and invalid-frame counts not recorded.');
    await openHistory(page, COMPLETED.id);
    await card(page, COMPLETED.id).locator('[data-action=open]').click();
    await page.waitForFunction(() => document.getElementById('run-name-label')!.textContent === 'browser-run-completed');
    await assertRunPanels(page, {account: COMPLETED.account as any, summary: COMPLETED.summary, quotes: (COMPLETED.market as any).lastObservedFrame.quotes}, 'imported completed run');
    assert.equal(seen.order.filter(line => MUTATING.test(line)).length, 3, 'only the three live actions from before mutated anything');
    // Closing the last snapshot returns to the paused live session, which still steps normally.
    await page.click('#snapshot-close');
    await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1});
    await assertMatchesOracle(page, client, oracle, 'live session after snapshots');
  }));

  it('Use settings starts a session that keeps imported timing limits; live-mode settings apply after saving and closing the open session', t => scenario(t, async ({page}) => {
    const settings = await client.normalizeSettings({config: {maxQuoteAgeMs: 45000, maxOutcomeLatenessMs: 12000, horizonMs: 300000, feeBps: 12}});
    const source = await client.createSession({settings, name: 'timing source'});
    const saved = await client.saveSession(source.id, source.version, 'timing source');
    await client.closeSession(source.id);
    await page.reload();
    await connected(page);
    await openHistory(page, saved.run.id);
    await card(page, saved.run.id).locator('[data-action=use-settings]').click();
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Saved settings copied'));
    assert.equal(await visible(page, '#config-view'), true);
    assert.equal(await page.inputValue('#horizonMs'), '300000');
    assert.equal(await page.inputValue('#feeBps'), '12');
    assert.equal(await page.inputValue('#name'), 'timing source · new run');
    const started = await startSession(page);
    const config = (await client.getSession(started.id)).config;
    assert.equal(config.maxQuoteAgeMs, 45000);
    assert.equal(config.maxOutcomeLatenessMs, 12000);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#s-export')]);
    const record = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(record.config.maxQuoteAgeMs, 45000);
    assert.equal(record.config.maxOutcomeLatenessMs, 12000);
    assert.equal(record.name, 'timing source · new run');

    // Settings of a live-mode run apply too: the open session is saved and closed first, then the form shows them.
    await idle(page);
    const open = await read(page);
    await openHistory(page, LIVE.id);
    await card(page, LIVE.id).locator('[data-action=use-settings]').click();
    await page.waitForFunction(() => (document.getElementById('feeBps') as HTMLInputElement).value === '1');
    await idle(page); // the form fills inside the history transition; the start buttons re-enable once it releases the workspace
    assert.equal(await page.inputValue('#liveHours'), '2');
    assert.equal(await page.locator('#s-start-live').isEnabled(), true);
    const closed = await client.getSession(open.id);
    assert.equal(closed.status, 'closed');
    assert.notEqual(closed.savedVersion, null, 'the open session was saved before it was closed');
  }));

  it('Export all runs equals GET /v1/runs/{id} for each run, saving the live session first', t => scenario(t, async ({page, oracle}) => {
    const live = await startSession(page);
    for (let i = 0; i < 2; i++) await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1});
    assert.equal((await client.getSession(live.id)).savedVersion, null);
    await openHistory(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#history-export-all')]);
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('All '));
    assert.equal(download.suggestedFilename(), 'paper-trail-all-runs.json');
    const file = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    assert.equal(file.format, 'paper-trail-history-v2');
    const listed = await client.listRuns();
    assert.deepEqual(file.runs.map((r: RunRecord) => r.id).sort(), listed.map(r => r.id).sort());
    for (const run of file.runs as RunRecord[]) assert.deepEqual(run, await client.getRun(run.id), `${run.id}: export-all equals the stored run`);
    const mine = (file.runs as RunRecord[]).find(r => r.id === live.runId)!;
    assert.ok(mine, 'the unsaved live session was saved first');
    assert.equal(mine.summary.equity, oracle.summary().equity);
    assert.equal((await client.getSession(live.id)).status, 'active', 'the session stays open');
    assert.equal((await read(page)).version, (await client.getSession(live.id)).version);
    // Per-run exports from the cards download the same records.
    const [one] = await Promise.all([page.waitForEvent('download'), card(page, COMPLETED.id).locator('[data-action=export-run]').click()]);
    assert.deepEqual(JSON.parse(readFileSync((await one.path())!, 'utf8')), await client.exportRun(COMPLETED.id));
    const [two] = await Promise.all([page.waitForEvent('download'), card(page, COMPLETED.id).locator('[data-action=export-settings]').click()]);
    assert.deepEqual(JSON.parse(readFileSync((await two.path())!, 'utf8')), await client.exportSettings(COMPLETED.id));
  }));

  it('reload reattaches to the live session at the same version, paused; once it is closed, the saved snapshot is shown with a notice', t => scenario(t, async ({page, oracle}) => {
    const started = await startSession(page);
    for (let i = 0; i < 3; i++) await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1});
    await step(page, oracle, '#s-buy-BTC', '/orders', {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100});
    const before = await read(page);
    await page.reload();
    await connected(page);
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'active');
    await idle(page);
    const after = await read(page);
    assert.equal(after.id, started.id);
    assert.equal(after.version, before.version, 'the version is restored');
    assert.equal(after.playing, false);
    assert.equal(after.cursor, before.cursor);
    assert.equal(await visible(page, '#run-view'), true);
    assert.match(after.notice, /^Reattached to your live session \(paused, version \d+\)/);
    await assertMatchesOracle(page, client, oracle, 'reattached');
    await assertRunPanels(page, truth(oracle), 'reattached panels');
    await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1}); // the restored version is accepted by the server
    await assertMatchesOracle(page, client, oracle, 'step after reattaching');

    await press(page, '#s-save', '/save');
    const final = await read(page);
    await client.closeSession(final.id); // ended elsewhere
    await page.reload();
    await connected(page);
    await page.locator('#snapshot-banner').waitFor({state: 'visible'});
    const view = await read(page);
    assert.equal(view.panel, 'none');
    assert.match(view.notice, /^Your live session was closed\. Showing its last saved snapshot, read-only\./);
    assert.equal(await visible(page, '#run-view'), true);
    await assertRunPanels(page, truth(oracle), 'snapshot after the session closed');

    // A session closed before any save leaves nothing to show; the page says so and clears its pointer.
    await page.click('#snapshot-close');
    await page.click('#view-config');
    const second = await startSession(page);
    await client.closeSession(second.id);
    await page.reload();
    await connected(page);
    await page.waitForFunction(() => document.getElementById('s-notice')!.textContent!.startsWith('Your previous session'));
    assert.match(await page.locator('#s-notice').innerText(), /no longer exists and had no saved snapshot/);
    assert.equal((await read(page)).panel, 'none');
    await page.reload();
    await connected(page);
    assert.equal(await page.locator('#s-notice').innerText(), 'No session yet.', 'the pointer was cleared');
  }));

  it('Save & start another saves and closes the session, clears the pointer and returns to Config', t => scenario(t, async ({page, oracle}) => {
    await page.fill('#name', 'archived run');
    const live = await startSession(page);
    for (let i = 0; i < 2; i++) await step(page, oracle, '#s-next-frame', '/advance', {kind: 'frames', count: 1});
    await step(page, oracle, '#s-buy-LINK', '/orders', {kind: 'order', asset: 'LINK', side: 'buy', dollars: 100});
    await Promise.all([page.waitForResponse(r => r.request().method() === 'DELETE'), page.click('#s-archive')]);
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'none');
    await idle(page);
    assert.equal(await visible(page, '#config-view'), true);
    assert.match(await notice(page), /^Previous run is available in History/);
    assert.equal(await page.inputValue('#name'), '');
    const closed = await client.getSession(live.id);
    assert.equal(closed.status, 'closed');
    assert.notEqual(closed.savedVersion, null, 'archiving saved first');
    const record = await client.getRun(live.runId);
    assert.equal(record.name, 'archived run');
    assertParity(oracle, observe({currentFrame: {time: oracle.snapshot().time}, cursor: oracle.snapshot().cursor, status: closed.status, summary: record.summary}), 'archived record');
    assert.equal(record.manualTradeCount, 1);
    await openHistory(page, live.runId);
    await page.reload();
    await connected(page);
    assert.equal((await read(page)).panel, 'none', 'nothing to reattach after archiving');
    assert.equal(await visible(page, '#config-view'), true);
  }));

  it('history actions racing a running step corrupt neither the session nor the snapshot or archive', t => scenario(t, async ({page, seen, oracle}) => {
    const started = await startSession(page);
    // Race 1: Open snapshot while Play is running.
    await page.click('#s-play');
    await page.waitForFunction(lookback => Number(document.getElementById('s-cursor')!.dataset['cursor']) >= lookback + 8, oracle.lookback);
    await page.click('#view-history');
    await card(page, COMPLETED.id).waitFor();
    await card(page, COMPLETED.id).locator('[data-action=open]').click();
    await page.locator('#snapshot-banner').waitFor({state: 'visible'});
    await idle(page);
    const paused = await read(page);
    assert.equal(paused.playing, false, 'opening a snapshot paused the run');
    assert.equal(paused.snapshot, true);
    await assertRunPanels(page, {account: COMPLETED.account as any, summary: COMPLETED.summary, quotes: (COMPLETED.market as any).lastObservedFrame.quotes}, 'snapshot opened mid-play');
    await page.waitForTimeout(300);
    assert.equal((await read(page)).cursor, paused.cursor, 'nothing advances behind a snapshot');
    assert.equal((await client.getSession(started.id)).version, paused.version, 'page and server agree on the version');
    await page.click('#snapshot-close');
    oracle.apply({kind: 'frames', count: paused.cursor - oracle.lookback});
    await assertMatchesOracle(page, client, oracle, 'live session after the racing snapshot');
    await assertRunPanels(page, truth(oracle), 'live panels after the racing snapshot');

    // Race 2: Use settings (which archives) while Play is running.
    await page.click('#s-play');
    await page.waitForFunction(from => Number(document.getElementById('s-cursor')!.dataset['cursor']) >= from + 8, paused.cursor);
    await page.click('#view-history');
    await card(page, PARTIAL.id).locator('[data-action=use-settings]').click();
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Saved settings copied'));
    await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'none');
    assert.equal(seen.maxAdvanceInFlight, 1, 'ticks never overlapped, even across the history action');
    const closed = await client.getSession(started.id);
    assert.equal(closed.status, 'closed');
    assert.ok(closed.cursor > paused.cursor);
    oracle.apply({kind: 'frames', count: closed.cursor - paused.cursor});
    const record = await client.getRun(started.runId);
    assert.equal(record.summary.equity, oracle.summary().equity, 'the archived record is exactly where the run stopped');
    const ledger = (await client.exportRun(started.runId)).account.ledger;
    assert.equal(ledger.length, oracle.account().ledger.length);
    assert.notEqual(closed.savedVersion, null, 'the archive saved before closing');
    assert.equal(await page.inputValue('#feeBps'), '1', 'the saved run\'s settings are in the form');
    assert.equal(await page.inputValue('#horizonMs'), '300000');
    assert.equal(await visible(page, '#config-view'), true);
  }));
});
