// The Run view's read-only panels: header metrics, equity chart, forecast report card, per-asset positions and
// forecasts, and the activity ledger with its filter. They render whatever account they are given (a live
// session's account or a saved record's), so a snapshot is shown by exactly the same code.
import type {Account, Coverage, FrameView, LedgerEvent, Summary} from './client.ts';
import {renderEquityChart} from './chart.ts';
import {digitsFor, el, money, pct, qtyDigits, shortTime, signed, utc} from './format.ts';
import {MIN_FORECASTS, gradeAsset, type Grade} from './report-card.ts';

const ASSETS = ['BTC', 'LINK'] as const;
type Asset = typeof ASSETS[number];
type Row = LedgerEvent & Record<string, any>;
const LEDGER_ROWS = 80;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface RunData {
  name: string;
  badge: string;
  detail: string;
  account: Account;
  summary: Summary;
  /** The latest observed quotes, when known (a live session always has them). */
  quotes: FrameView['quotes'] | null;
  /** How the market data was obtained: decides whether coverage describes the sample window or a scored range. */
  kind: 'sample' | 'historical' | 'live' | null;
  /** Per-asset minute coverage of the source data; null for live runs and records saved without it. */
  coverage: Coverage | null;
  /** Retrieval receipts stored with the run; null when the record does not say (older records) or for live runs. */
  receiptCount: number | null;
}

export interface CoverageFacts {
  kind: RunData['kind'];
  mode: string;
  coverage: Coverage | null | undefined;
  receiptCount: number | null | undefined;
  summary: Pick<Summary, 'gapEvents' | 'invalidFrames'>;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const count = (n: number): string => n.toLocaleString('en-US');

/** app.js coverageLine(): what the data held, what was missing and how it was obtained, plus the run's own gaps. */
export function coverageLine({kind, mode, coverage, receiptCount, summary}: CoverageFacts): string {
  const counts = Number.isFinite(summary.gapEvents) && Number.isFinite(summary.invalidFrames)
    ? `${plural(summary.gapEvents as number, 'observation gap')} · ${plural(summary.invalidFrames as number, 'invalid frame')}`
    : 'gap and invalid-frame counts not recorded';
  if (mode === 'live') return `Live quotes: no minute coverage is expected · ${counts}.`;
  const per = coverage ? ASSETS.map(asset => {
    const c = coverage[asset];
    return c && [c.observedCount, c.expectedCount, c.missingCount].every(Number.isFinite)
      ? `${asset} ${count(c.observedCount)} of ${count(c.expectedCount)} minutes observed, ${count(c.missingCount)} missing` : null;
  }) : null;
  const window = kind === 'sample' ? 'Sample window (warmup included)' : 'Scored range';
  const source = receiptCount == null ? 'fetch receipts not recorded'
    : kind === 'sample' ? `${plural(receiptCount, 'fetch receipt')} (bundled data, no fetch)` : plural(receiptCount, 'fetch receipt');
  return `${per && per.every(Boolean) ? `${window}: ${per.join(' · ')}` : 'Minute coverage not recorded for this run'} · ${source} · ${counts}.`;
}

const ASSET_FIELDS: [string, string][] = [['qty', 'Position'], ['cost', 'Cost basis'], ['netliq', 'Net liquidation'], ['forecast', 'Latest forecast'],
  ['target', 'Target · UTC'], ['fstatus', 'Forecast status'], ['counts', 'Scored · pending · missed'], ['mae', 'Mean absolute error'], ['same', 'Same-price error']];

export class RunPanels {
  #data: RunData | null = null;

  constructor() {
    $('assets').innerHTML = ASSETS.map(asset => `<section class="asset-card" id="asset-${asset}" aria-label="${asset} position and forecast">`
      + `<h3>${asset} <span class="muted small">/ USD</span> <span class="muted small" id="a-${asset}-price"></span></h3><dl>`
      + ASSET_FIELDS.map(([key, label]) => `<div><dt>${label}</dt><dd id="a-${asset}-${key}">—</dd></div>`).join('')
      + `</dl><p class="muted small" id="a-${asset}-late"></p></section>`).join('');
    $('ledger-filter').addEventListener('change', () => { if (this.#data) this.#renderLedger(this.#data.account); });
    this.clear();
  }

  get shown(): RunData | null { return this.#data; }

  clear(): void {
    this.#data = null;
    $('run-empty').hidden = false;
    $('run-body').hidden = true;
    renderEquityChart($('chart'), [], 0);
  }

  show(data: RunData): void {
    this.#data = data;
    $('run-empty').hidden = true;
    $('run-body').hidden = false;
    const {account, summary} = data;
    $('run-name-label').textContent = data.name;
    $('run-badge').textContent = data.badge;
    $('run-detail').textContent = data.detail;
    const initial = account.config.initialCash;
    const metrics: [string, string, number][] = [
      ['m-equity', money(summary.equity), summary.equity],
      ['m-return', `${signed(summary.equity - initial)} (${pct(summary.returnPct)})`, summary.returnPct],
      ['m-buyhold', money(summary.buyHoldEquity), summary.buyHoldEquity],
      ['m-drawdown', `${summary.maxDrawdownPct.toFixed(2)}%`, summary.maxDrawdownPct],
      ['m-fees', money(summary.fees), summary.fees],
      ['m-trades', String(summary.tradeCount), summary.tradeCount],
      ['m-forecasts', `${summary.settledForecasts} scored · ${summary.pendingForecasts} pending · ${summary.expiredForecasts} missed`, summary.settledForecasts],
    ];
    for (const [id, text, raw] of metrics) { $(id).textContent = text; $(id).dataset['raw'] = String(raw); }
    $('m-return').className = summary.returnPct >= 0 ? 'positive' : 'negative';
    const line = $('m-coverage');
    line.textContent = coverageLine({kind: data.kind, mode: account.config.mode, coverage: data.coverage, receiptCount: data.receiptCount, summary});
    for (const asset of ASSETS) {
      const c = data.coverage?.[asset], key = asset.toLowerCase();
      line.dataset[`${key}Observed`] = c ? String(c.observedCount) : '';
      line.dataset[`${key}Expected`] = c ? String(c.expectedCount) : '';
      line.dataset[`${key}Missing`] = c ? String(c.missingCount) : '';
    }
    line.dataset['receipts'] = data.receiptCount == null ? '' : String(data.receiptCount);
    line.dataset['gaps'] = summary.gapEvents == null ? '' : String(summary.gapEvents);
    line.dataset['invalid'] = summary.invalidFrames == null ? '' : String(summary.invalidFrames);
    const yieldBps = account.config.cashYieldBps ?? 0;  // absent in accounts saved before cash yield existed
    $('cash-legend').textContent = `${money(initial, 0)} cash${yieldBps ? ` at ${yieldBps / 100}%/yr` : ''}`;
    renderEquityChart($('chart'), account.equity, initial);
    $('report-grid').replaceChildren(...ASSETS.map(asset => reportRow(asset, summary.perAsset[asset], account.config.model)));
    for (const asset of ASSETS) this.#renderAsset(asset, data);
    this.#renderLedger(account);
  }

  /** Cheap incremental update used between full refreshes: new ledger rows only. */
  showLedger(account: Account): void {
    if (this.#data) { this.#data = {...this.#data, account}; this.#renderLedger(account); }
  }

  #renderAsset(asset: Asset, data: RunData): void {
    const {account, summary, quotes} = data;
    const set = (key: string, text: string, raw?: number | string): void => {
      const node = $(`a-${asset}-${key}`);
      node.textContent = text;
      if (raw === undefined) delete node.dataset['raw']; else node.dataset['raw'] = String(raw);
    };
    const position = account.positions[asset];
    const quote = quotes?.[asset];
    const slip = account.config.slippageBps / 10000, fee = account.config.feeBps / 10000;
    const netLiq = position.qty > 0 && quote ? position.qty * quote.bid * (1 - slip) * (1 - fee) : position.qty > 0 ? null : 0;
    $(`a-${asset}-price`).textContent = quote ? money(quote.mid, digitsFor(asset)) : '';
    set('qty', position.qty.toFixed(qtyDigits(asset)), position.qty);
    set('cost', money(position.costBasis), position.costBasis);
    if (netLiq === null) set('netliq', '—'); else set('netliq', money(netLiq), netLiq);
    const forecasts = account.forecasts.filter(f => f.asset === asset);
    const latest = forecasts.at(-1);
    set('forecast', latest ? money(latest.prediction, digitsFor(asset)) : '—', latest?.prediction);
    set('target', latest ? new Date(latest.targetAt).toISOString().slice(5, 16).replace('T', ' ') : '—', latest?.targetAt);
    const word = latest?.status === 'settled' ? 'Scored' : latest?.status === 'expired' ? 'Missed (expired)' : latest ? 'Pending' : '—';
    set('fstatus', latest?.latenessMs != null ? `${word} · ${(latest.latenessMs / 1000).toFixed(0)}s after target` : word, latest?.status ?? '');
    $(`a-${asset}-fstatus`).dataset['lateness'] = latest?.latenessMs == null ? '' : String(latest.latenessMs);
    const count = (status: string): number => forecasts.filter(f => f.status === status).length;
    set('counts', `${count('settled')} · ${count('pending')} · ${count('expired')}`);
    $(`a-${asset}-counts`).dataset['scored'] = String(count('settled'));
    $(`a-${asset}-counts`).dataset['pending'] = String(count('pending'));
    $(`a-${asset}-counts`).dataset['missed'] = String(count('expired'));
    const per = summary.perAsset[asset];
    set('mae', per.mae == null ? 'pending' : money(per.mae, 4), per.mae ?? '');
    set('same', per.samePriceMae == null ? 'pending' : money(per.samePriceMae, 4), per.samePriceMae ?? '');
    const late = forecasts.filter(f => (f.latenessMs ?? 0) > 0);
    $(`a-${asset}-late`).textContent = late.length
      ? `${late.length} late observation${late.length === 1 ? '' : 's'} · max ${(Math.max(...late.map(f => f.latenessMs ?? 0)) / 1000).toFixed(1)}s after target · over ${account.config.maxOutcomeLatenessMs / 1000}s excluded`
      : '';
  }

  #renderLedger(account: Account): void {
    const filter = $<HTMLSelectElement>('ledger-filter').value;
    const all = (account.ledger as Row[]).filter(e => e.actor !== 'benchmark');
    const rows = all.filter(e => filter === 'all' || (filter === 'trades' && e.type === 'trade') || (filter === 'decisions' && e.type === 'decision'));
    const shown = rows.slice(-LEDGER_ROWS).reverse();
    const body = $('ledger');
    body.dataset['total'] = String(rows.length);
    body.dataset['filter'] = filter;
    body.dataset['trades'] = String(all.filter(e => e.type === 'trade').length);
    body.dataset['decisions'] = String(all.filter(e => e.type === 'decision').length);
    body.dataset['all'] = String(all.length);
    if (!shown.length) {
      const row = el('tr');
      row.append(Object.assign(el('td', 'empty-row', 'No matching activity.'), {colSpan: 5}));
      body.replaceChildren(row);
    } else body.replaceChildren(...shown.map(e => this.#row(account, e)));
    $('ledger-note').textContent = `Showing ${shown.length} of ${rows.length} events. Benchmark trades are separate. Export includes the full ledger, frozen forecasts, rules and source evidence.`;
  }

  #row(account: Account, e: Row): HTMLTableRowElement {
    let title = e.type.replaceAll('_', ' '), detail = String(e['reason'] ?? '');
    const btc = e['asset'] === 'BTC';
    if (e.type === 'trade') {
      title = `${e['actor'] === 'manual' ? 'Manual ' : ''}${e['side']}`;
      detail = `${Number(e['qty']).toFixed(btc ? 6 : 3)} @ ${money(Number(e['price']), btc ? 2 : 4)} · fee ${money(Number(e['fee']))}`;
    } else if (e.type === 'decision') {
      title = e['action'] === 'buy' ? 'Buy signal' : 'Keep cash';
      detail = `Expected net ${((Number(e['expectedNetRatio']) - 1) * 100).toFixed(3)}% · hurdle ${((Number(e['requiredNetRatio']) - 1) * 100).toFixed(2)}%`;
      if (e['blockedBy']) detail += ` · blocked by ${limitName(e['blockedBy'])} limit${e['wouldBuy'] ? '; rule would buy' : ''}`;
    } else if (e.type === 'risk_halt') {
      const drawdown = e['limit'] === 'max_drawdown';
      title = drawdown ? 'Drawdown halt' : 'Daily loss halt';
      detail = `Net ${money(Number(e['netLiquidation']))} vs ${money(Number(e['referenceValue']))} ${drawdown ? 'peak' : 'day open'} · limit ${e['thresholdBps']} bps · `
        + (e['resumesAt'] != null ? `entries resume ${utc(Number(e['resumesAt']))}` : 'no new entries this session');
    } else if (e.type === 'forecast_settled') {
      title = 'Forecast scored';
      detail = `${e['forecastId']} · ${Math.round(Number(e['latenessMs']) / 1000)}s late`;
    } else if (e.type === 'start') detail = `Rules frozen · ${money(account.config.initialCash)} simulated cash`;
    else if (e.type === 'gap') detail = `${(Number(e['gapMs']) / 60000).toFixed(1)} min without observations · no intervening fills`;
    const row = el('tr');
    row.dataset['type'] = e.type;
    const delta = e['cashDelta'] as number | undefined;
    row.append(el('td', '', shortTime(e.time)), el('td', '', title), el('td', '', String(e['asset'] ?? '—')), el('td', '', detail),
      el('td', `numeric ${delta == null ? '' : delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}`, delta == null ? '—' : signed(delta)));
    return row;
  }
}

/** app.js: how likely coin flips are to land this far from 50%. */
export const chance = (p: number): string => (p < 0.001 ? 'less than 0.1%' : `${(100 * p).toFixed(p < 0.01 ? 1 : 0)}%`);

type AssetStats = Summary['perAsset']['BTC'];

/** The report card row for one asset, with the wording of app.js reportCardPanel(). Grades and numbers are exposed
 *  as data attributes so tests can compare them with the root report-card.js. */
export function reportRow(asset: Asset, stats: AssetStats, model: string): HTMLElement {
  const g = gradeAsset(stats, model);
  // Summaries saved before the report card existed have no direction counts; they are not graded from zeros.
  const unavailable = stats.directionHits == null && g.verdict !== 'baseline' && g.verdict !== 'none';
  const row = el('div', 'report-row');
  row.id = `report-${asset}`;
  const data: Record<string, string> = {verdict: unavailable ? 'unavailable' : g.verdict, count: String(g.count), hits: String(g.hits),
    misses: String(g.misses), flat: String(g.flat), decided: String(g.decided), hitRatePct: String(g.hitRatePct),
    detectablePts: String(g.detectablePts), maeChangePct: String(g.maeChangePct), pValue: String(g.pValue)};
  Object.assign(row.dataset, data);
  const head = el('div', 'report-head');
  const tone = unavailable ? '' : g.verdict === 'better' ? ' good' : g.verdict === 'worse' ? ' bad' : '';
  head.append(el('strong', '', asset), el('span', `report-verdict${tone}`, unavailable ? 'Not graded' : g.label));
  row.append(head, ...reportLines(asset, g, stats, unavailable).map(parts => {
    const line = el('p', 'report-line');
    line.append(...parts.map(part => (typeof part === 'string' ? document.createTextNode(part) : el('strong', '', part.strong))));
    return line;
  }));
  return row;
}

type Part = string | {strong: string};

function reportLines(asset: Asset, g: Grade, stats: AssetStats, unavailable: boolean): Part[][] {
  if (g.verdict === 'baseline') return [['This run uses the same-price rule, which never predicts a direction. Choose the trend rule in Config to grade it.']];
  if (g.verdict === 'none') return [['Forecasts are graded once their target time arrives.']];
  if (unavailable) return [['This run was saved before the report card existed, so its summary has no direction counts to grade.']];
  const lines: Part[][] = [];
  lines.push(g.decided
    ? ['Called the direction right in ', {strong: `${g.hits} of ${g.decided}`}, ` forecasts (${(g.hitRatePct as number).toFixed(0)}%)${g.flat ? ` · ${g.flat} with no move skipped` : ''}.`]
    : [`No forecast predicted a move that was then observed${g.flat ? ` (${g.flat} skipped)` : ''}.`]);
  if (g.verdict === 'too_few') lines.push([`Needs at least ${MIN_FORECASTS} forecasts with a predicted and an observed move; has ${g.decided}.`]);
  else {
    lines.push([`A rule with no skill scores 50%. Coin flips would land at least this far from 50% ${chance(g.pValue as number)} of the time.`]);
    lines.push([`This many forecasts can only spot an edge of more than about ${(g.detectablePts as number).toFixed(0)} points either side of 50%.`]);
  }
  if (g.maeChangePct != null) {
    const digits = digitsFor(asset);
    lines.push([`For reference, average miss ${money(stats.mae as number, digits)} vs ${money(stats.samePriceMae as number, digits)} when guessing “no change”.`]);
  }
  return lines;
}

/** How the summary's `tradingHalted` reads in the run detail line ('' when entries are allowed). */
export const haltNote = (summary: Summary): string =>
  summary.tradingHalted ? ` · entries halted by ${limitName(summary.tradingHalted)} limit` : '';

function limitName(limit: unknown): string {
  return limit === 'max_drawdown' ? 'drawdown' : 'daily loss';
}

export const describeUtcRange = (account: Account): string => `${utc(account.startedAt)} → ${utc(account.endsAt)}`;
