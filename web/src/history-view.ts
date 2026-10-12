// Run history: list saved runs and act on them. Every action that can change the page's run
// (open snapshot, use settings, export all) runs inside the workspace's exclusive transition,
// pauses the live session first, and re-checks which session it started against before applying.
import {ApiError, PaperTrailClient, type RunMetadata, type Settings} from './client.ts';
import {el, money, utc, utcIso} from './format.ts';
import type {SessionView} from './session-view.ts';
import type {SnapshotView} from './snapshot-view.ts';
import {assertSupported} from './settings-draft.ts';
import type {Workspace} from './workspace.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface HistoryDeps {
  client: PaperTrailClient;
  workspace: Workspace;
  sessions: SessionView;
  snapshots: SnapshotView;
  download(payload: unknown, name: string): void;
  notify(text: string, error?: boolean): void;
  /** Validates and applies settings to the form; throws before changing anything if unsupported. */
  applySettings(settings: Settings, runName: string): void;
  showView(view: 'config' | 'run' | 'history'): void;
}

export class HistoryView {
  readonly #deps: HistoryDeps;

  constructor(deps: HistoryDeps) {
    this.#deps = deps;
    $('history-export-all').addEventListener('click', () => void this.exportAll());
  }

  async refresh(): Promise<RunMetadata[]> {
    const {client} = this.#deps;
    try {
      const runs = await client.listRuns();
      $('history-count').textContent = `(${runs.length})`;
      $('history-status').textContent = runs.length
        ? `${runs.length} saved run${runs.length === 1 ? '' : 's'}. Snapshots overwrite the same run ID; exports include the full evidence.`
        : 'No saved runs yet. Start a session, then save, finish or export it.';
      $('history').replaceChildren(...runs.map(run => this.#card(run)));
      return runs;
    } catch (error) {
      $('history-status').textContent = `History unavailable: ${(error as Error).message}. The current session can still be exported.`;
      return [];
    }
  }

  #card(run: RunMetadata): HTMLElement {
    const c = run.config as Record<string, any>, s = run.summary;
    const card = el('article', 'panel history-card');
    card.dataset['runId'] = run.id;
    card.append(el('h3', '', run.name || 'Unnamed run'));
    card.append(el('p', 'muted small', `${run.status === 'completed' ? 'Complete' : 'Partial snapshot'} · ${c['mode']}${run.manualTradeCount > 0 ? ' · manual changes' : ''} · saved ${utcIso(run.updatedAt)}`));
    const metrics = el('div', 'history-metrics');
    for (const [key, label, value, raw] of [['equity', 'Net value', money(s.equity), s.equity], ['return', 'Return', `${s.returnPct.toFixed(2)}%`, s.returnPct],
      ['buyhold', 'Buy & hold', money(s.buyHoldEquity), s.buyHoldEquity], ['drawdown', 'Drawdown', `${s.maxDrawdownPct.toFixed(2)}%`, s.maxDrawdownPct]] as const) {
      const item = el('div');
      const value$ = el('strong', '', value);
      value$.dataset['field'] = key;
      value$.dataset['raw'] = String(raw);
      item.append(el('span', '', label), value$);
      metrics.append(item);
    }
    card.append(metrics);
    card.append(el('p', 'muted small', `${money(c['initialCash'], 0)} cash · ${c['model']} · ${c['horizonMs'] / 60000} min horizon · ${c['lookbackIntervals']} lookback · ${Number((c['allocationFraction'] * 100).toPrecision(12))}% per asset · buffer ${c['bufferBps']} bps · stop ${c['stopLossBps'] || 'off'}${c['stopLossBps'] ? ' bps' : ''} · fee/slippage ${c['feeBps']}/${c['slippageBps']} bps`));
    card.append(el('p', 'muted small', `${utc(run.scoreStart ?? s.valuationAt)} → ${utc(run.scoreEnd)} · ${s.settledForecasts} scored, ${s.expiredForecasts} missed · ${run.source || 'Source in export'}`));
    const actions = el('div', 'actions history-actions');
    const button = (label: string, action: string, handler: () => Promise<void>): void => {
      const b = el('button', '', label);
      b.type = 'button';
      b.dataset['action'] = action;
      b.addEventListener('click', () => void handler().catch(error => this.#deps.notify((error as Error).message, true)));
      actions.append(b);
    };
    button('Open snapshot', 'open', () => this.openSnapshot(run.id));
    button('Use settings', 'use-settings', () => this.useSettings(run.id));
    button('Export run ↓', 'export-run', async () => {
      this.#deps.download(await this.#deps.client.exportRun(run.id), `paper-trail-${run.id}-run.json`);
      this.#deps.notify('Run exported with frozen settings, results, evidence and hashes.');
    });
    button('Export settings ↓', 'export-settings', async () => {
      this.#deps.download(await this.#deps.client.exportSettings(run.id), `paper-trail-${run.id}-settings.json`);
      this.#deps.notify('Settings exported. Import them before starting another run.');
    });
    card.append(actions);
    return card;
  }

  async openSnapshot(id: string): Promise<void> {
    const ran = await this.#deps.workspace.exclusive('open snapshot', async () => {
      try { await this.#deps.snapshots.open(id); }
      catch (error) {
        this.#deps.notify(error instanceof ApiError && error.status === 404 ? 'That run is no longer saved, so there is nothing to open.' : (error as Error).message, true);
      }
    });
    if (!ran) this.#deps.notify('Another history action is still running. Try again in a moment.', true);
  }

  /** Settings export -> form. An active session is saved and closed first, only after the settings proved usable. */
  async useSettings(id: string): Promise<void> {
    const {sessions, client} = this.#deps;
    const ran = await this.#deps.workspace.exclusive('use settings', async () => {
      await sessions.pause();
      const owner = sessions.session?.id ?? null;
      let settings: Settings;
      try { settings = await client.exportSettings(id); } catch (error) { this.#deps.notify((error as Error).message, true); return; }
      if ((sessions.session?.id ?? null) !== owner) { this.#deps.notify('The session changed while the settings were loading, so nothing was applied.', true); return; }
      try { assertSupported(settings); } catch (error) { this.#deps.notify(`Settings were not applied: ${(error as Error).message}`, true); return; }
      if (sessions.session && !(await sessions.archive())) { this.#deps.notify('The current session could not be saved, so it was left open and nothing was applied.', true); return; }
      this.#deps.snapshots.close();
      const name = (await client.listRuns()).find(run => run.id === id)?.name ?? '';
      this.#deps.applySettings(settings, `${name} · new run`.slice(0, 100));
      this.#deps.showView('config');
      this.#deps.notify('Saved settings copied. Starting a new session creates a separate run ID and ledger.');
      await this.refresh();
    });
    if (!ran) this.#deps.notify('Another history action is still running. Try again in a moment.', true);
  }

  async exportAll(): Promise<void> {
    const {sessions, client} = this.#deps;
    const ran = await this.#deps.workspace.exclusive('export all', async () => {
      try {
        await sessions.pause();
        const s = sessions.session;
        if (s && s.savedVersion !== s.version && !(await sessions.save())) {
          this.#deps.notify('The live session could not be saved, so its latest progress is not in this export.', true);
        }
        const all = await client.exportAllRuns();
        this.#deps.download(all, 'paper-trail-all-runs.json');
        this.#deps.notify(`All ${all.runs.length} saved run snapshots exported.`);
      } catch (error) { this.#deps.notify(`Could not export history: ${(error as Error).message}`, true); }
    });
    if (!ran) this.#deps.notify('Another history action is still running. Try again in a moment.', true);
  }
}
