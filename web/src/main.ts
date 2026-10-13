import {ApiError, PaperTrailClient, type RunMetadata, type RunRecord, type Settings, type SettingsInput} from './client.ts';
import {HistoryView} from './history-view.ts';
import {RunPanels} from './run-panels.ts';
import {SessionView} from './session-view.ts';
import {SnapshotView} from './snapshot-view.ts';
import {Workspace, currentRun as pointer} from './workspace.ts';
import {EDITABLE_FIELDS, SettingsDraft, hoursOf, percent, yieldPercentOf, type EditableField, type RequestOptions} from './settings-draft.ts';

const query = new URLSearchParams(location.search);
const client = new PaperTrailClient({baseUrl: query.get('api') ?? ''});
/** `?liveTickMs=<n>` shortens the live tick interval (tests); the default is 10 s. */
const liveTickMs = Math.max(50, Number(query.get('liveTickMs')) || 10_000);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const money = (n: number): string => n.toLocaleString('en-US', {style: 'currency', currency: 'USD'});
const pct = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const FIELDS = ['initialCash', 'lookbackIntervals', 'bufferBps', 'stopLossBps', 'maxDrawdownBps', 'dailyLossBps', 'feeBps', 'slippageBps'] as const;
let currentRun: string | null = null;
let draft: SettingsDraft;
type View = 'config' | 'run' | 'history';
let historyView: HistoryView;
let snapshots: SnapshotView;
let sessions: SessionView;
const refreshHistory = async (): Promise<void> => { await historyView?.refresh(); };

function showView(view: View): void {
  for (const name of ['config', 'run', 'history'] as const) {
    $(`${name}-view`).hidden = name !== view;
    const tab = $(`view-${name}`);
    if (name === view) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
}

function notify(text: string, error = false): void {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
const fail = (error: unknown): void => notify(error instanceof ApiError || error instanceof Error ? error.message : String(error), true);

function download(payload: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}));
  const link = Object.assign(document.createElement('a'), {href: url, download: name});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Validates, then makes `settings` the base of the draft and shows it. Throws before touching anything. */
function applySettings(settings: Settings): void {
  draft.replaceBase(settings);
  const c = settings.config;
  for (const key of FIELDS) $<HTMLInputElement>(key).value = String(c[key] ?? 0);
  $<HTMLSelectElement>('horizonMs').value = String(c.horizonMs);
  $<HTMLSelectElement>('model').value = c.model;
  $<HTMLInputElement>('allocation').value = percent(c.allocationFraction);
  $<HTMLInputElement>('halfSpreadBps').value = String(settings.replay.halfSpreadBps);
  $<HTMLSelectElement>('replaySource').value = settings.replay.source;
  $<HTMLInputElement>('rangeStart').value = settings.replay.start;
  $<HTMLInputElement>('rangeEnd').value = settings.replay.end;
  $<HTMLInputElement>('liveHours').value = hoursOf(c.durationMs);
  $<HTMLInputElement>('cashYield').value = yieldPercentOf(c.cashYieldBps ?? 0);
  rangeVisibility();
}

function rangeVisibility(): void {
  $('range-fields').hidden = $<HTMLSelectElement>('replaySource').value !== 'range';
  sessions?.refreshLabels();
}

const readSettings = (options: RequestOptions = {}): SettingsInput => draft.request(field => $<HTMLInputElement | HTMLSelectElement>(field).value, options);

function showResult(run: RunMetadata): void {
  currentRun = run.id;
  const s = run.summary;
  $('result').hidden = false;
  $('result-name').textContent = `· ${run.name ?? run.id}`;
  const rows: [string, string][] = [
    ['Net value', money(s.equity)], ['Return', pct(s.returnPct)], ['Buy & hold', money(s.buyHoldEquity)],
    ['Max drawdown', `${s.maxDrawdownPct.toFixed(2)}%`], ['Fees paid', money(s.fees)], ['Paper trades', String(s.tradeCount)],
    ['Forecasts scored', `${s.settledForecasts} of ${s.forecastCount}`], ['Missed (expired)', String(s.expiredForecasts)],
  ];
  $('metrics').replaceChildren(...rows.map(([label, value]) => {
    const item = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    item.append(dt, dd);
    return item;
  }));
}

async function guarded(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { fail(error); }
}

async function main(): Promise<void> {
  const [health, defaults] = await Promise.all([client.health(), client.defaults()]);
  $<HTMLSelectElement>('horizonMs').replaceChildren(...defaults.horizonsMs.map(ms => {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = ms >= 3600000 ? `${ms / 3600000} h` : `${ms / 60000} min`;
    return option;
  }));
  draft = new SettingsDraft(defaults.settings);
  applySettings(defaults.settings);
  $('replaySource').addEventListener('change', rangeVisibility);
  for (const field of EDITABLE_FIELDS) {
    const mark = (): void => draft.markEdited(field as EditableField);
    $(field).addEventListener('input', mark);
    $(field).addEventListener('change', mark);
  }
  const workspace = new Workspace();
  const panels = new RunPanels();
  const runName = (): string | null => $<HTMLInputElement>('name').value.trim() || null;
  sessions = new SessionView({
    client, panels, workspace, readSettings, runName, download, onSaved: refreshHistory, liveTickMs,
    replaySource: () => ($<HTMLSelectElement>('replaySource').value === 'range' ? 'range' : 'sample'),
    onStarted: () => { snapshots.close(); showView('run'); },
    requestArchive: () => void archive(workspace, panels),
  });
  snapshots = new SnapshotView({client, panels, sessions, showView});
  historyView = new HistoryView({
    client, workspace, sessions, snapshots, download, notify, showView,
    applySettings: (settings, name) => { applySettings(settings); $<HTMLInputElement>('name').value = name; },
  });
  for (const view of ['config', 'run', 'history'] as const) {
    $(`view-${view}`).addEventListener('click', () => { showView(view); if (view === 'history') void refreshHistory(); });
  }
  notify(`Connected to Python API v${health.apiVersion}. Defaults: ${money(defaults.settings.config.initialCash)} simulated cash.`);
  await refreshHistory();

  $('settings').addEventListener('submit', event => {
    event.preventDefault();
    void guarded(async () => {
      const button = $<HTMLButtonElement>('run');
      button.disabled = true;
      try {
        notify('Running replay on the Python backend…');
        const result = await client.createReplay({settings: readSettings({mode: 'replay', source: 'sample'}), name: $<HTMLInputElement>('name').value.trim() || null});
        showResult(result.run);
        await refreshHistory();
        notify(`Replay complete: ${result.summary.tradeCount} paper trades, ${result.summary.settledForecasts} scored forecasts. Saved to run history.`);
      } finally { button.disabled = false; }
    });
  });
  $('export-run').addEventListener('click', () => void guarded(async () => {
    const id = currentRun; // the selection may change while the request is in flight
    if (!id) return;
    const record: RunRecord = await client.exportRun(id);
    download(record, `paper-trail-${id}-run.json`);
    notify('Run exported with frozen settings, results, evidence and hashes.');
  }));
  $('export-settings').addEventListener('click', () => void guarded(async () => {
    const id = currentRun;
    if (!id) return;
    download(await client.exportSettings(id), `paper-trail-${id}-settings.json`);
    notify('Settings exported. Import them before starting another run.');
  }));
  $<HTMLInputElement>('settings-file').addEventListener('change', event => void (async () => {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error('Settings file is too large. Import a settings JSON file under 1 MB.');
      const normalized = await client.normalizeSettings(JSON.parse(await file.text()) as SettingsInput);
      applySettings(normalized);
      notify(normalized.config.mode === 'live'
        ? 'Settings validated by the API and applied. They are live-session settings: use “Start live paper session”. No run has started.'
        : 'Settings validated by the API and applied. No run has started.');
    } catch (error) {
      notify(`Settings were not applied: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally { input.value = ''; }
  })());
  $<HTMLInputElement>('run-file').addEventListener('change', event => void guarded(async () => {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 50_000_000) throw new Error('Run file is too large to import.');
      showResult(await client.importRun(JSON.parse(await file.text()) as object));
      await refreshHistory();
      notify('Saved run passed integrity checks (hashes and summary) and was added to history. These checks detect corruption, not tampering.');
    } finally { input.value = ''; }
  }));
  await workspace.exclusive('restore', restore);
}

/** Save the live session and close it, then return to Config (the original app's "Save & start another"). */
async function archive(workspace: Workspace, panels: RunPanels): Promise<void> {
  await workspace.exclusive('archive', async () => {
    if (!(await sessions.archive())) { sessions.notify('The session could not be saved, so it was left open.', true); return; }
    snapshots.close();
    panels.clear();
    pointer.clear();
    $<HTMLInputElement>('name').value = '';
    showView('config');
    notify('Previous run is available in History. Configure a new run.');
    await refreshHistory();
  });
}

/** After a reload: reattach to the live session (paused), else show its saved snapshot read-only. */
async function restore(): Promise<void> {
  const saved = pointer.read();
  if (!saved) return;
  try {
    if (saved.sessionId) {
      const outcome = await sessions.reattach(saved.sessionId, saved.name ?? '');
      if (outcome === 'attached') {
        showView('run');
        const s = sessions.session!;
        sessions.notify(`Reattached to your live session (paused, version ${s.version}). Nothing advanced while the page was closed.`);
        return;
      }
      const why = outcome === 'closed' ? 'was closed' : 'no longer exists';
      if (await snapshots.open(saved.runId, `Your live session ${why}. Showing its last saved snapshot, read-only.`)) return;
    } else if (saved.readOnly) {
      if (await snapshots.open(saved.runId, 'Reopened your last read-only snapshot.')) return;
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) { fail(error); return; }
  }
  pointer.clear();
  sessions.notify('Your previous session no longer exists and had no saved snapshot, so there is nothing to restore.', true);
}

main().catch(error => fail(new Error(`${error instanceof Error ? error.message : error} Start it with: python -m uvicorn --factory paper_trail.api:create_app (see docs/BACKEND_MIGRATION.md).`)));
