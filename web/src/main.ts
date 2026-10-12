import {ApiError, PaperTrailClient, type RunMetadata, type RunRecord, type Settings, type SettingsInput} from './client.ts';

const client = new PaperTrailClient({baseUrl: new URLSearchParams(location.search).get('api') ?? ''});
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const money = (n: number): string => n.toLocaleString('en-US', {style: 'currency', currency: 'USD'});
const pct = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
const FIELDS = ['initialCash', 'lookbackIntervals', 'bufferBps', 'stopLossBps', 'feeBps', 'slippageBps'] as const;
let currentRun: string | null = null;

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

function applySettings(settings: Settings): void {
  const c = settings.config;
  for (const key of FIELDS) $<HTMLInputElement>(key).value = String(c[key]);
  $<HTMLSelectElement>('horizonMs').value = String(c.horizonMs);
  $<HTMLSelectElement>('model').value = c.model;
  $<HTMLInputElement>('allocation').value = String(c.allocationFraction * 100);
  $<HTMLInputElement>('halfSpreadBps').value = String(settings.replay.halfSpreadBps);
}

function readSettings(): SettingsInput {
  const num = (id: string): number => {
    const raw = $<HTMLInputElement>(id).value.trim();
    if (!raw || !Number.isFinite(Number(raw))) throw new Error('Complete every numeric field with a finite number.');
    return Number(raw);
  };
  return {
    config: {
      initialCash: num('initialCash'), horizonMs: num('horizonMs'), model: $<HTMLSelectElement>('model').value as 'trend' | 'same-price',
      lookbackIntervals: num('lookbackIntervals'), bufferBps: num('bufferBps'), allocationFraction: num('allocation') / 100,
      stopLossBps: num('stopLossBps'), feeBps: num('feeBps'), slippageBps: num('slippageBps'),
    },
    replay: {source: 'sample', halfSpreadBps: num('halfSpreadBps')},
  };
}

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

async function refreshHistory(): Promise<void> {
  const runs = await client.listRuns();
  $('history-count').textContent = `(${runs.length})`;
  $('history').replaceChildren(...runs.map(run => {
    const row = document.createElement('div');
    row.className = 'run';
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = run.name ?? run.id;
    const detail = document.createElement('span');
    detail.className = 'muted small';
    detail.textContent = `${run.status} · ${money(run.summary.equity)} (${pct(run.summary.returnPct)}) · ${run.config['model']} · saved ${run.updatedAt ?? ''}`;
    text.append(title, detail);
    const open = Object.assign(document.createElement('button'), {type: 'button', textContent: 'Show'});
    open.addEventListener('click', () => showResult(run));
    row.append(text, open);
    return row;
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
  applySettings(defaults.settings);
  notify(`Connected to Python API v${health.apiVersion}. Defaults: ${money(defaults.settings.config.initialCash)} simulated cash.`);
  await refreshHistory();

  $('settings').addEventListener('submit', event => {
    event.preventDefault();
    void guarded(async () => {
      const button = $<HTMLButtonElement>('run');
      button.disabled = true;
      try {
        notify('Running replay on the Python backend…');
        const result = await client.createReplay({settings: readSettings(), name: $<HTMLInputElement>('name').value.trim() || null});
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
  $<HTMLInputElement>('settings-file').addEventListener('change', event => void guarded(async () => {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error('Settings file is too large. Import a settings JSON file under 1 MB.');
      applySettings(await client.normalizeSettings(JSON.parse(await file.text()) as SettingsInput));
      notify('Settings validated by the API and applied. No run has started.');
    } finally { input.value = ''; }
  }));
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
}

main().catch(error => fail(new Error(`${error instanceof Error ? error.message : error} Start it with: python -m uvicorn --factory paper_trail.api:create_app (see docs/BACKEND_MIGRATION.md).`)));
