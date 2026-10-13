// Run view in real Chromium: equity chart, positions and forecasts, and the activity ledger,
// compared with the independent JS oracle (root engine.js) at 1e-9.
import {after, before, describe, it, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {Browser, Page} from 'playwright-core';
import {PaperTrailClient} from '../src/client.ts';
import {createOracle, type Action, type Oracle} from './oracle.ts';
import {repo, startApi, type RunningApi} from './server.ts';
import {assertNoFutureFrames, assertMatchesOracle, assertRunPanels, idle, launch, openPage, press, read, readPanels, startSession, type Seen} from './support.ts';

let api: RunningApi;
let client: PaperTrailClient;
let browser: Browser | undefined;
let problem = '';
before(async () => { api = await startApi(); client = new PaperTrailClient({baseUrl: api.baseUrl}); ({browser, problem} = await launch()); });
after(async () => { await browser?.close(); api?.stop(); });

async function scenario(t: TestContext, body: (ctx: {page: Page; seen: Seen; oracle: Oracle}) => Promise<void>): Promise<void> {
  if (!browser) { t.skip(`no Chromium available: ${problem}`); return; }
  const {page, seen} = await openPage(browser, api);
  try { await body({page, seen, oracle: await createOracle()}); assertNoFutureFrames(seen); }
  finally { await page.close(); }
}
const truth = (oracle: Oracle) => ({account: oracle.account(), summary: oracle.summary(), quotes: oracle.quotes()});

async function drive(page: Page, oracle: Oracle, steps: [string, string, Action][]): Promise<void> {
  for (const [selector, url, action] of steps) { await press(page, selector, url); oracle.apply(action); }
}

describe('Run view panels (real Chromium, real API, JS oracle)', () => {
  it('shows nothing before a run, then the chart, positions, forecasts and ledger equal the oracle at every stage', t => scenario(t, async ({page, oracle}) => {
    await page.click('#view-run');
    assert.equal(await page.locator('#run-empty').isVisible(), true);
    assert.equal(await page.locator('#run-body').isHidden(), true);
    await page.click('#view-config');
    await startSession(page); // the page moves to the Run view by itself
    assert.equal(await page.locator('#run-view').isVisible(), true);
    assert.equal(await page.locator('#config-view').isHidden(), true);
    assert.equal(await page.getAttribute('#view-run', 'aria-current'), 'page');
    await assertRunPanels(page, truth(oracle), 'start');
    await drive(page, oracle, [['#s-next-frame', '/advance', {kind: 'frames', count: 1}], ['#s-next-frame', '/advance', {kind: 'frames', count: 1}],
      ['#s-buy-BTC', '/orders', {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100}], ['#s-buy-LINK', '/orders', {kind: 'order', asset: 'LINK', side: 'buy', dollars: 100}]]);
    const held = await assertRunPanels(page, truth(oracle), 'two manual positions');
    assert.ok(held.assets['BTC']!.qty > 0 && held.assets['LINK']!.qty > 0);
    await drive(page, oracle, [['#s-next-decision', '/advance', {kind: 'decision'}], ['#s-next-decision', '/advance', {kind: 'decision'}], ['#s-next-decision', '/advance', {kind: 'decision'}]]);
    const settled = await assertRunPanels(page, truth(oracle), 'after three decisions');
    assert.ok(settled.assets['BTC']!.scored + settled.assets['LINK']!.scored > 0, 'some forecasts are scored, so MAE comparisons are not vacuous');
    await drive(page, oracle, [['#s-buy-BTC', '/orders', {kind: 'order', asset: 'BTC', side: 'buy', dollars: 100}]]);
    const open = await assertRunPanels(page, truth(oracle), 'open position');
    assert.ok(open.assets['BTC']!.qty > 0 && open.assets['BTC']!.netLiq! > 0);
    assert.match(await page.locator('#run-badge').textContent() ?? '', /^Sample replay · paused$/);
  }));

  it('ledger filter counts equal the oracle trades and decisions; the table shows the newest rows first', t => scenario(t, async ({page, oracle}) => {
    await startSession(page);
    await drive(page, oracle, [['#s-finish', '/advance', {kind: 'finish'}]]);
    const done = await assertRunPanels(page, truth(oracle), 'finished');
    assert.ok(done.chart.count > 1000, 'a whole replay is drawn point for point');
    assert.equal(done.chart.count, oracle.account().equity.length);
    const nonBenchmark = oracle.account().ledger.filter((e: any) => e.actor !== 'benchmark');
    const want = {all: nonBenchmark.length, trades: nonBenchmark.filter((e: any) => e.type === 'trade').length, decisions: nonBenchmark.filter((e: any) => e.type === 'decision').length};
    assert.ok(want.trades > 0 && want.decisions > 0 && want.all > want.trades + want.decisions);
    for (const filter of ['all', 'trades', 'decisions'] as const) {
      await page.selectOption('#ledger-filter', filter);
      const ui = (await readPanels(page)).ledger;
      assert.equal(ui.filter, filter);
      assert.equal(ui.total, want[filter], `${filter} total`);
      assert.equal(ui.rows.length, Math.min(80, want[filter]), `${filter} rows shown`);
      if (filter !== 'all') assert.ok(ui.rows.every(type => type === (filter === 'trades' ? 'trade' : 'decision')));
    }
    assert.match(await page.locator('#ledger-note').textContent() ?? '', new RegExp(`^Showing 80 of ${want.decisions} events`));
    await page.selectOption('#ledger-filter', 'trades');
    const firstRow = await page.locator('#ledger tr').first().locator('td').first().textContent();
    const newest = nonBenchmark.filter((e: any) => e.type === 'trade').at(-1);
    assert.equal(firstRow, new Date(newest.time).toISOString().slice(11, 19), 'newest trade first');
  }));

  it('the forecast report card grades the whole sample replay exactly like the root report-card.js', t => scenario(t, async ({page, oracle}) => {
    await startSession(page);
    const early = await readPanels(page);
    assert.deepEqual([early.report['BTC']!.data['verdict'], early.report['LINK']!.data['verdict']], ['none', 'none'], 'nothing is scored at the first frame');
    await drive(page, oracle, [['#s-finish', '/advance', {kind: 'finish'}]]);
    const done = await assertRunPanels(page, truth(oracle), 'finished sample'); // compares every grade field with the root module
    const js = await import(repo('report-card.js')) as {reportCard(summary: object, model: string): Record<string, any>};
    const card = js.reportCard(oracle.summary(), 'trend');
    for (const asset of ['BTC', 'LINK'] as const) {
      const per = oracle.summary().perAsset[asset], shown = done.report[asset]!;
      assert.ok(per.directionHits + per.directionMisses >= 30, 'enough decided forecasts for a p-value');
      assert.equal(Number(shown.data['hits']), per.directionHits);
      assert.equal(Number(shown.data['decided']), per.directionHits + per.directionMisses);
      assert.equal(Number(shown.data['flat']), per.directionFlat);
      assert.equal(Number(shown.data['pValue']), card[asset].pValue);
      assert.equal(shown.verdict, card[asset].label);
    }
    // The bundled sample under the default rule (engine.js PR #6): neither asset shows skill.
    assert.deepEqual([card['BTC'].verdict, card['LINK'].verdict], ['unclear', 'unclear']);
    assert.match(done.report['BTC']!.lines.join(' '), /^Called the direction right in \d+ of \d+ forecasts \(\d+%\)/);
    assert.match(await page.locator('#report-note').textContent() ?? '', /^Direction only: calling it right doesn’t mean/);
  }));

  it('updates the ledger and chart as a play run progresses, and ends equal to the oracle', t => scenario(t, async ({page, seen, oracle}) => {
    await startSession(page);
    await page.click('#s-play');
    await page.waitForFunction(() => Number(document.getElementById('chart-svg')?.dataset['points'] ?? 0) >= 40);
    await page.click('#s-play');
    await idle(page);
    const view = await read(page);
    assert.ok(view.cursor >= oracle.lookback + 8 && (view.cursor - oracle.lookback) % 8 === 0);
    oracle.apply({kind: 'frames', count: view.cursor - oracle.lookback});
    await assertMatchesOracle(page, client, oracle, 'after play');
    await assertRunPanels(page, truth(oracle), 'after play');
    assert.equal(seen.maxAdvanceInFlight, 1);
  }));
});
