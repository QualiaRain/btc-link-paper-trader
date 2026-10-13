// The settings the UI will send: the normalized settings last applied (defaults or an import) as the
// base, overlaid with only the fields the user actually edited. Fields the form does not show
// (timing limits, ...) therefore travel unchanged, and an unedited value is never rebuilt
// from its on-screen representation (e.g. 0.07 -> "7" -> 7.000000000000001 -> 0.07000000000000001).
import type {Settings, SettingsInput} from './client.ts';

export const EDITABLE_FIELDS = ['initialCash', 'horizonMs', 'model', 'lookbackIntervals', 'bufferBps', 'allocation',
  'stopLossBps', 'maxDrawdownBps', 'dailyLossBps', 'feeBps', 'slippageBps', 'halfSpreadBps', 'replaySource', 'rangeStart', 'rangeEnd',
  'liveHours', 'cashYield'] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

/** What a start button asks for. Replay sessions use the form's source; the one-shot replay is sample-only. */
export interface RequestOptions { mode?: 'replay' | 'live'; source?: 'sample' | 'range' }

const MINUTE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A percentage for display without binary floating point noise (0.07 -> "7"). */
export const percent = (fraction: number): string => String(Number((fraction * 100).toPrecision(12)));
/** Live duration in hours for display (3,600,000 ms -> "1"). */
export const hoursOf = (durationMs: number): string => String(Number((durationMs / 3_600_000).toPrecision(12)));
/** Annual cash yield in percent for display (450 bps -> "4.5"); the form edits percent, the config stores bps. */
export const yieldPercentOf = (bps: number): string => String(Number((bps / 100).toPrecision(12)));

function finiteNumber(raw: string): number {
  const text = raw.trim();
  if (!text || !Number.isFinite(Number(text))) throw new Error('Complete every numeric field with a finite number.');
  return Number(text);
}

export class SettingsDraft {
  #base: Settings;
  readonly #edited = new Set<EditableField>();

  constructor(base: Settings) {
    this.#base = structuredClone(base);
  }

  /** Adopt newly applied settings; earlier edits are discarded with the old base. */
  replaceBase(base: Settings): void {
    this.#base = structuredClone(base);
    this.#edited.clear();
  }

  get base(): Settings { return this.#base; }
  markEdited(field: EditableField): void { this.#edited.add(field); }
  get edited(): ReadonlySet<EditableField> { return this.#edited; }

  /** `read` returns the form's current text for a field; it is consulted only for edited fields. */
  request(read: (field: EditableField) => string, options: RequestOptions = {}): SettingsInput {
    const config: Record<string, unknown> = {...this.#base.config};
    const replay = {...this.#base.replay};
    for (const field of this.#edited) {
      const raw = read(field);
      if (field === 'model') config['model'] = raw;
      else if (field === 'allocation') config['allocationFraction'] = finiteNumber(raw) / 100;
      else if (field === 'halfSpreadBps') replay.halfSpreadBps = finiteNumber(raw);
      else if (field === 'replaySource') replay.source = raw === 'range' ? 'range' : 'sample';
      else if (field === 'rangeStart') replay.start = raw.trim();
      else if (field === 'rangeEnd') replay.end = raw.trim();
      else if (field === 'liveHours') config['durationMs'] = finiteNumber(raw) * 3_600_000;
      else if (field === 'cashYield') config['cashYieldBps'] = finiteNumber(raw) * 100;
      else config[field] = finiteNumber(raw);
    }
    if (options.mode) config['mode'] = options.mode;
    const source = options.source ?? replay.source;
    if (config['mode'] === 'live') return {config: config as SettingsInput['config'], replay: {source: 'sample', halfSpreadBps: replay.halfSpreadBps}};
    if (source === 'range') {
      if (!MINUTE_FORMAT.test(replay.start) || !MINUTE_FORMAT.test(replay.end)) throw new Error('Choose a UTC start and end minute for the date range.');
      if (replay.end <= replay.start) throw new Error('The range end must be after its start (at most 31 days).');
    }
    return {config: config as SettingsInput['config'],
      replay: source === 'range' ? {source, start: replay.start, end: replay.end, halfSpreadBps: replay.halfSpreadBps} : {source: 'sample', halfSpreadBps: replay.halfSpreadBps}};
  }
}
