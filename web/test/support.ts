// Shared Chromium helpers for the browser tests that drive the full page (sessions, panels, history).
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium, type Browser, type Page} from 'playwright-core';
import {PaperTrailClient} from '../src/client.ts';
import {assertParity, type Observed, type Oracle} from './oracle.ts';
import {repo, type RunningApi} from './server.ts';

export async function launch(): Promise<{browser?: Browser; problem: string}> {
  const executablePath = process.env['CHROMIUM_PATH'] ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  try {
    return {browser: await chromium.launch({executablePath, args: ['--no-proxy-server', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]}), problem: ''};
  } catch (error) {
    const problem = (error as Error).message.split('\n')[0] ?? 'unknown error';
    if (process.env['REQUIRE_BROWSER']) throw new Error(`REQUIRE_BROWSER is set but Chromium could not start: ${problem}`);
    return {problem};
  }
}

export interface Seen {
  /** `METHOD /path` of every /v1 request, in order. */
  order: string[];
  /** Parsed JSON responses of session endpoints. */
  responses: {method: string; url: string; request: string | null; body: any}[];
  maxAdvanceInFlight: number;
  maxTickInFlight: number;
  advanceBodies: any[];
}

export async function openPage(browser: Browser, api: RunningApi, options: {query?: string} = {}): Promise<{page: Page; seen: Seen}> {
  const page = await browser.newPage({acceptDownloads: true});
  const seen: Seen = {order: [], responses: [], maxAdvanceInFlight: 0, maxTickInFlight: 0, advanceBodies: []};
  let inFlight = 0, ticksInFlight = 0;
  page.on('request', request => {
    if (request.url().endsWith('/tick')) seen.maxTickInFlight = Math.max(seen.maxTickInFlight, ++ticksInFlight);
    if (!request.url().includes('/v1/')) return;
    seen.order.push(`${request.method()} ${new URL(request.url()).pathname}`);
    if (request.url().endsWith('/advance')) {
      seen.advanceBodies.push(request.postDataJSON());
      seen.maxAdvanceInFlight = Math.max(seen.maxAdvanceInFlight, ++inFlight);
    }
  });
  page.on('requestfinished', request => { if (request.url().endsWith('/advance')) inFlight--; if (request.url().endsWith('/tick')) ticksInFlight--; });
  page.on('requestfailed', request => { if (request.url().endsWith('/advance')) inFlight--; if (request.url().endsWith('/tick')) ticksInFlight--; });
  page.on('response', async response => {
    if (!response.url().includes('/v1/sessions')) return;
    let body: any;
    try { body = await response.json(); } catch { body = undefined; }
    seen.responses.push({method: response.request().method(), url: response.url(), request: response.request().postData(), body});
  });
  await page.goto(api.baseUrl + (options.query ?? ''));
  await connected(page);
  return {page, seen};
}
export const connected = (page: Page) =>
  page.waitForFunction(() => document.getElementById('notice')!.textContent!.startsWith('Connected'));

/** Requirement: no session response may contain a frame time later than state.currentFrame.time. */
export function assertNoFutureFrames(seen: Seen): void {
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

export interface View extends Observed {
  id: string; runId: string; version: number; busy: boolean; playing: boolean; panel: string; snapshot: boolean;
  notice: string; noticeIsError: boolean; activity: string[]; frameCount: number;
}
export const read = (page: Page): Promise<View> => page.evaluate(() => {
  const d = (id: string) => document.getElementById(id)!;
  const raw = (id: string) => Number(d(id).dataset['raw']);
  const panel = d('session-panel');
  return {
    id: panel.dataset['sessionId']!, runId: panel.dataset['runId']!, version: Number(panel.dataset['version']), panel: panel.dataset['status']!,
    busy: panel.dataset['busy'] === 'true', playing: panel.dataset['playing'] === 'true', snapshot: panel.dataset['snapshot'] === 'true',
    notice: d('s-notice').textContent!, noticeIsError: d('s-notice').classList.contains('error'),
    activity: Array.from(d('s-activity').querySelectorAll('li')).map(li => li.textContent!),
    time: Number(d('s-clock').dataset['time']), cursor: Number(d('s-cursor').dataset['cursor']), frameCount: Number(d('s-cursor').dataset['frameCount']),
    status: d('s-status').textContent!.toLowerCase(), cash: raw('s-cash'), equity: raw('s-equity'), buyHold: raw('s-buyhold'),
    fees: raw('s-fees'), tradeCount: raw('s-trades'), qty: {BTC: raw('s-qty-BTC'), LINK: raw('s-qty-LINK')},
  };
});
export const idle = (page: Page) => page.waitForFunction(() => {
  const p = document.getElementById('session-panel')!.dataset;
  return p['busy'] === 'false' && p['playing'] === 'false';
});

/** Click a control that calls the API and wait until the call has landed and the page is idle again. */
export async function press(page: Page, selector: string, urlPart: string): Promise<void> {
  await Promise.all([page.waitForResponse(r => r.url().includes(urlPart) && r.request().method() !== 'GET'), page.click(selector)]);
  await idle(page);
}
export async function startSession(page: Page): Promise<View> {
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/v1/sessions') && r.request().method() === 'POST'), page.click('#s-start')]);
  await page.waitForFunction(() => document.getElementById('session-panel')!.dataset['status'] === 'active');
  await idle(page);
  return read(page);
}

export async function assertMatchesOracle(page: Page, client: PaperTrailClient, oracle: Oracle, label: string): Promise<View> {
  const view = await read(page);
  assertParity(oracle, view, `${label} (page)`);
  const account = await client.getSessionAccount(view.id);
  const counts: Record<string, number> = {};
  for (const e of account.account.ledger) counts[e.type] = (counts[e.type] ?? 0) + 1;
  assert.deepEqual(counts, oracle.snapshot().ledgerCounts, `${label}: ledger event counts`);
  assert.equal(account.state.version, view.version, `${label}: the page tracks the server version`);
  return view;
}

// ---- Run view panels -------------------------------------------------------------------------------
export interface PanelsTruth {
  account: {positions: Record<'BTC' | 'LINK', {qty: number; costBasis: number}>; forecasts: any[]; equity: any[]; ledger: any[]; config: {slippageBps: number; feeBps: number; model: string}};
  summary: any;
  quotes: Record<'BTC' | 'LINK', {bid: number}> | null;
}

export const readPanels = (page: Page) => page.evaluate(() => {
  const d = (id: string) => document.getElementById(id)!;
  const path = (id: string) => d(id) as unknown as SVGPathElement;
  const svg = d('chart-svg');
  const chartNode = (id: string) => ({d: path(id).getAttribute('d')!, points: Number(path(id).dataset['points']), last: Number(path(id).dataset['last'])});
  const assets: Record<string, any> = {};
  for (const a of ['BTC', 'LINK']) {
    const raw = (k: string) => d(`a-${a}-${k}`).dataset['raw'];
    assets[a] = {qty: Number(raw('qty')), cost: Number(raw('cost')), netLiq: raw('netliq') === undefined ? null : Number(raw('netliq')),
      forecast: raw('forecast') === undefined ? null : Number(raw('forecast')), target: raw('target') === undefined ? null : Number(raw('target')),
      status: raw('fstatus'), lateness: d(`a-${a}-fstatus`).dataset['lateness'],
      scored: Number(d(`a-${a}-counts`).dataset['scored']), pending: Number(d(`a-${a}-counts`).dataset['pending']), missed: Number(d(`a-${a}-counts`).dataset['missed']),
      mae: raw('mae'), same: raw('same')};
  }
  const ledger = d('ledger');
  const report: Record<string, {data: Record<string, string>; verdict: string; tone: string; lines: string[]}> = {};
  for (const a of ['BTC', 'LINK']) {
    const row = d(`report-${a}`), pill = row.querySelector('.report-verdict')!;
    report[a] = {data: {...row.dataset} as Record<string, string>, verdict: pill.textContent!, tone: pill.className,
      lines: Array.from(row.querySelectorAll('.report-line')).map(line => line.textContent!)};
  }
  return {
    report, reportVisible: !d('report-card').hidden && d('report-card').offsetParent !== null,
    chart: {label: svg.getAttribute('aria-label')!, count: Number(svg.dataset['points']), lo: Number(svg.dataset['yLo']), hi: Number(svg.dataset['yHi']),
      top: Number(svg.dataset['plotTop']), bottom: Number(svg.dataset['plotBottom']), strategy: chartNode('chart-strategy'), buyHold: chartNode('chart-buyhold'), cash: chartNode('chart-cash')},
    assets,
    ledger: {total: Number(ledger.dataset['total']), filter: ledger.dataset['filter']!, trades: Number(ledger.dataset['trades']), decisions: Number(ledger.dataset['decisions']),
      all: Number(ledger.dataset['all']), rows: Array.from(ledger.querySelectorAll('tr')).map(r => (r as HTMLElement).dataset['type'] ?? '')},
    metrics: {equity: Number(d('m-equity').dataset['raw']), buyHold: Number(d('m-buyhold').dataset['raw']), fees: Number(d('m-fees').dataset['raw']), trades: Number(d('m-trades').dataset['raw']),
      forecasts: d('m-forecasts').textContent!},
    coverage: {text: d('m-coverage').textContent!, ...d('m-coverage').dataset} as unknown as CoverageShown,
  };
});

/** The Data coverage line: per-asset minute counts, receipts and the run's own gap counts, as the page states them. */
export interface CoverageShown {
  text: string; btcObserved: string; btcExpected: string; btcMissing: string; linkObserved: string; linkExpected: string; linkMissing: string;
  receipts: string; gaps: string; invalid: string;
}
export const SAMPLE_COVERAGE = {observed: 1648, expected: 1800, missing: 152}; // data/README.md: 1,648 shared observations of 1,800 minutes
export const SAMPLE_COVERAGE_LINE = 'Sample window (warmup included): BTC 1,648 of 1,800 minutes observed, 152 missing · LINK 1,648 of 1,800 minutes observed, 152 missing · 0 fetch receipts (bundled data, no fetch) · 0 observation gaps · 0 invalid frames.';

/** The coverage line equals the API's own numbers (coverage counts, receipts) and summary (gaps, invalid frames). */
export function assertCoverageShown(shown: CoverageShown, truth: {coverage?: Record<string, {observedCount: number; expectedCount: number; missingCount: number}> | null; receiptCount?: number | null; summary: {gapEvents?: number | null; invalidFrames?: number | null}}, label: string): void {
  for (const asset of ['btc', 'link'] as const) {
    const c = truth.coverage?.[asset.toUpperCase()];
    assert.equal(shown[`${asset}Observed`], c ? String(c.observedCount) : '', `${label}: ${asset} observed`);
    assert.equal(shown[`${asset}Expected`], c ? String(c.expectedCount) : '', `${label}: ${asset} expected`);
    assert.equal(shown[`${asset}Missing`], c ? String(c.missingCount) : '', `${label}: ${asset} missing`);
    if (c) assert.ok(shown.text.includes(`${asset.toUpperCase()} ${c.observedCount.toLocaleString('en-US')} of ${c.expectedCount.toLocaleString('en-US')} minutes observed, ${c.missingCount.toLocaleString('en-US')} missing`), `${label}: ${shown.text}`);
  }
  assert.equal(shown.receipts, truth.receiptCount == null ? '' : String(truth.receiptCount), `${label}: receipts`);
  assert.equal(shown.gaps, truth.summary.gapEvents == null ? '' : String(truth.summary.gapEvents), `${label}: gaps`);
  assert.equal(shown.invalid, truth.summary.invalidFrames == null ? '' : String(truth.summary.invalidFrames), `${label}: invalid frames`);
  if (truth.summary.gapEvents == null) assert.ok(shown.text.includes('gap and invalid-frame counts not recorded'), `${label}: ${shown.text}`);
  if (!truth.coverage) assert.ok(/not recorded for this run|no minute coverage is expected/.test(shown.text), `${label}: ${shown.text}`);
}

const near = (a: number, b: number, what: string, tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const lastPoint = (d: string): [number, number] => { const all = [...d.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)]; const m = all.at(-1)!; return [Number(m[1]), Number(m[2])]; };
const money2 = (n: number) => n.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});

/** The rendered chart, positions, forecasts and ledger counts must equal the truth (oracle or saved record) to 1e-9. */
export async function assertRunPanels(page: Page, truth: PanelsTruth, label: string): Promise<Awaited<ReturnType<typeof readPanels>>> {
  const ui = await readPanels(page);
  const equity = truth.account.equity, last = equity.at(-1);
  // chart: one path point per equity point, ending at the truth's last values, drawn at the right height
  assert.equal(ui.chart.count, equity.length, `${label}: chart points`);
  for (const [name, series, pick] of [['strategy', ui.chart.strategy, (p: any) => p.value], ['buy-and-hold', ui.chart.buyHold, (p: any) => p.buyHoldValue], ['cash', ui.chart.cash, (p: any) => p.cashValue]] as const) {
    assert.equal(series.points, equity.length, `${label}: ${name} data-points`);
    assert.equal((series.d.match(/[ML]/g) ?? []).length, equity.length, `${label}: ${name} path points`);
    near(series.last, pick(last), `${label}: ${name} end value`);
    const y = lastPoint(series.d)[1];
    const expected = ui.chart.top + (ui.chart.hi - pick(last)) / (ui.chart.hi - ui.chart.lo) * (ui.chart.bottom - ui.chart.top);
    assert.ok(Math.abs(y - expected) <= 0.006, `${label}: ${name} ends at y=${y}, expected ${expected}`);
  }
  assert.ok(ui.chart.label.includes(money2(last.value)) && ui.chart.label.includes(money2(last.buyHoldValue)), `${label}: accessible label: ${ui.chart.label}`);
  // header metrics
  near(ui.metrics.equity, truth.summary.equity, `${label}: net value`);
  near(ui.metrics.buyHold, truth.summary.buyHoldEquity, `${label}: buy-and-hold`);
  near(ui.metrics.fees, truth.summary.fees, `${label}: fees`);
  assert.equal(ui.metrics.trades, truth.summary.tradeCount);
  // positions and forecasts
  const slip = truth.account.config.slippageBps / 10000, fee = truth.account.config.feeBps / 10000;
  let netLiqTotal = 0;
  for (const asset of ['BTC', 'LINK'] as const) {
    const a = ui.assets[asset], position = truth.account.positions[asset];
    near(a.qty, position.qty, `${label}: ${asset} qty`);
    near(a.cost, position.costBasis, `${label}: ${asset} cost basis`);
    if (truth.quotes) {
      const expectedNet = position.qty * truth.quotes[asset].bid * (1 - slip) * (1 - fee);
      near(a.netLiq, expectedNet, `${label}: ${asset} net liquidation`);
      netLiqTotal += expectedNet;
    }
    const fs = truth.account.forecasts.filter(f => f.asset === asset);
    const latest = fs.at(-1);
    if (latest) {
      near(a.forecast, latest.prediction, `${label}: ${asset} latest forecast`);
      near(a.target, latest.targetAt, `${label}: ${asset} target`);
      assert.equal(a.status, latest.status, `${label}: ${asset} forecast status`);
      assert.equal(a.lateness, latest.latenessMs == null ? '' : String(latest.latenessMs), `${label}: ${asset} lateness`);
    } else assert.equal(a.forecast, null);
    for (const [key, status] of [['scored', 'settled'], ['pending', 'pending'], ['missed', 'expired']] as const)
      assert.equal(a[key], fs.filter(f => f.status === status).length, `${label}: ${asset} ${key}`);
    const per = truth.summary.perAsset[asset];
    for (const [shown, want, what] of [[a.mae, per.mae, 'MAE'], [a.same, per.samePriceMae, 'same-price MAE']] as const) {
      if (want == null) assert.equal(shown, '', `${label}: ${asset} ${what} pending`);
      else near(Number(shown), want, `${label}: ${asset} ${what}`);
    }
  }
  if (truth.quotes) near(truth.summary.cash + netLiqTotal, truth.summary.equity, `${label}: cash + net liquidation = net value`, 1e-6);
  await assertReportCard(ui, truth, label);
  // ledger counts (benchmark rows are never listed)
  const rows = truth.account.ledger.filter(e => e.actor !== 'benchmark');
  assert.equal(ui.ledger.all, rows.length, `${label}: activity events`);
  assert.equal(ui.ledger.trades, rows.filter(e => e.type === 'trade').length, `${label}: trades`);
  assert.equal(ui.ledger.decisions, rows.filter(e => e.type === 'decision').length, `${label}: decisions`);
  return ui;
}

// ---- Forecast report card ------------------------------------------------------------------------------
type RootReportCard = {MIN_FORECASTS: number; gradeAsset(stats: any, model: string): any};
let rootCard: Promise<RootReportCard> | undefined;
const chance = (p: number): string => (p < 0.001 ? 'less than 0.1%' : `${(100 * p).toFixed(p < 0.01 ? 1 : 0)}%`);

/** The lines app.js reportCardPanel() writes for one asset (markup removed), from the ROOT report-card.js grade. */
function appReportLines(g: any, m: any, digits: number, min: number): string[] {
  const lines: string[] = [];
  if (g.verdict === 'baseline') lines.push('This run uses the same-price rule, which never predicts a direction. Choose the trend rule in Config to grade it.');
  else if (g.verdict === 'none') lines.push('Forecasts are graded once their target time arrives.');
  else {
    lines.push(g.decided ? `Called the direction right in ${g.hits} of ${g.decided} forecasts (${g.hitRatePct.toFixed(0)}%)${g.flat ? ` · ${g.flat} with no move skipped` : ''}.` : `No forecast predicted a move that was then observed${g.flat ? ` (${g.flat} skipped)` : ''}.`);
    if (g.verdict === 'too_few') lines.push(`Needs at least ${min} forecasts with a predicted and an observed move; has ${g.decided}.`);
    else {
      lines.push(`A rule with no skill scores 50%. Coin flips would land at least this far from 50% ${chance(g.pValue)} of the time.`);
      lines.push(`This many forecasts can only spot an edge of more than about ${g.detectablePts.toFixed(0)} points either side of 50%.`);
    }
    if (g.maeChangePct != null) lines.push(`For reference, average miss ${money(m.mae, digits)} vs ${money(m.samePriceMae, digits)} when guessing “no change”.`);
  }
  return lines;
}
const money = (n: number, digits: number) => n.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits});

/** The report card shows the ROOT report-card.js grade of the truth's summary, worded like app.js. A summary saved
 *  before the counts existed is shown as not graded rather than graded from zeros. */
export async function assertReportCard(ui: Awaited<ReturnType<typeof readPanels>>, truth: PanelsTruth, label: string): Promise<void> {
  const js = await (rootCard ??= import(repo('report-card.js')) as Promise<RootReportCard>);
  assert.ok(ui.reportVisible, `${label}: report card visible`);
  for (const asset of ['BTC', 'LINK'] as const) {
    const per = truth.summary.perAsset[asset], g = js.gradeAsset(per, truth.account.config.model), shown = ui.report[asset]!;
    for (const key of ['count', 'hits', 'misses', 'flat', 'decided', 'hitRatePct', 'detectablePts', 'maeChangePct', 'pValue'])
      assert.equal(shown.data[key], String(g[key]), `${label}: ${asset} report ${key}`);
    if (per.directionHits === undefined && g.verdict !== 'baseline' && g.verdict !== 'none') {
      assert.equal(shown.data['verdict'], 'unavailable', `${label}: ${asset} saved before the report card`);
      assert.equal(shown.verdict, 'Not graded');
      assert.deepEqual(shown.lines, ['This run was saved before the report card existed, so its summary has no direction counts to grade.']);
      continue;
    }
    assert.equal(shown.data['verdict'], g.verdict, `${label}: ${asset} verdict`);
    assert.equal(shown.verdict, g.label, `${label}: ${asset} verdict label`);
    assert.equal(shown.tone, `report-verdict${g.verdict === 'better' ? ' good' : g.verdict === 'worse' ? ' bad' : ''}`);
    assert.deepEqual(shown.lines, appReportLines(g, per, asset === 'BTC' ? 2 : 4, js.MIN_FORECASTS), `${label}: ${asset} report wording`);
  }
}

/** Pretend the tab is hidden or visible again (what a real tab switch does to document.visibilityState). */
export const setVisibility = (page: Page, hidden: boolean) => page.evaluate(h => {
  Object.defineProperty(document, 'visibilityState', {value: h ? 'hidden' : 'visible', configurable: true});
  Object.defineProperty(document, 'hidden', {value: h, configurable: true});
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
