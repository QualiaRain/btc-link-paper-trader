// Read-only display of a saved run. This module only ever calls GET /v1/runs/{id}; it has no
// access to the session mutators, so a snapshot can never step, order or save.
import type {PaperTrailClient, RunRecord} from './client.ts';
import {utc, utcIso} from './format.ts';
import {haltNote, type RunPanels} from './run-panels.ts';
import type {SessionView} from './session-view.ts';
import {currentRun} from './workspace.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface SnapshotDeps {
  client: Pick<PaperTrailClient, 'getRun'>;
  panels: RunPanels;
  sessions: SessionView;
  showView(view: 'config' | 'run' | 'history'): void;
}

export class SnapshotView {
  readonly #deps: SnapshotDeps;
  #generation = 0;
  #record: RunRecord | null = null;

  constructor(deps: SnapshotDeps) {
    this.#deps = deps;
    $('snapshot-close').addEventListener('click', () => this.close());
    this.#render();
  }

  get isOpen(): boolean { return this.#record !== null; }
  get runId(): string | null { return this.#record?.id ?? null; }

  /** Pauses any live session, then shows the saved record. Returns false if it was superseded or could not be read. */
  async open(id: string, notice?: string): Promise<boolean> {
    const generation = ++this.#generation;
    await this.#deps.sessions.pause();
    const record = await this.#deps.client.getRun(id);
    if (generation !== this.#generation) return false;
    if (!record.account?.config) throw new Error('Saved run is missing its account.');
    this.#record = record;
    const mode = record.config['mode'] === 'live' ? 'Live paper' : (record.market?.['kind'] === 'historical' ? 'UTC replay' : 'Sample replay');
    const quotes = (record.market?.['lastObservedFrame'] as {quotes?: any} | undefined)?.quotes ?? null;
    this.#deps.sessions.setSnapshotOpen(true);
    this.#deps.panels.show({
      name: record.name,
      badge: `${mode} · read-only snapshot · ${record.status === 'completed' ? 'complete' : 'partial'}`,
      detail: `${record.summary.tradeCount} fills · ${record.account.config.model} · ${record.account.config.horizonMs / 60000} min horizon · ${utc(record.account.startedAt)} → ${utc(record.account.endsAt)}${haltNote(record.summary)}`,
      account: record.account, summary: record.summary, quotes,
    });
    if (!this.#deps.sessions.session) currentRun.write({runId: record.id, name: record.name, readOnly: true});
    this.#render();
    this.#deps.showView('run');
    this.#deps.sessions.notify(notice ?? 'Read-only snapshot opened. Its results will not change. Use History → Use settings for a new run.');
    return true;
  }

  /** Leave the snapshot: back to the paused live session when there is one, else to Config. */
  close(): void {
    ++this.#generation;
    if (!this.#record) return;
    this.#record = null;
    this.#deps.sessions.setSnapshotOpen(false);
    if (!this.#deps.sessions.session) {
      this.#deps.panels.clear();
      currentRun.clear();
      this.#deps.showView('config');
    }
    this.#render();
  }

  #render(): void {
    const record = this.#record;
    $('snapshot-banner').hidden = !record;
    if (!record) return;
    const live = !!this.#deps.sessions.session;
    $('snapshot-text').textContent = `Read-only snapshot of “${record.name}” (run ${record.id}), saved ${utcIso(record.updatedAt)}. Its results will not change; stepping, orders and saving are off.`;
    $('snapshot-close').textContent = live ? 'Back to live session' : 'Close snapshot';
  }
}
