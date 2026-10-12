// The settings the UI will send: the normalized settings last applied (defaults or an import) as the
// base, overlaid with only the fields the user actually edited. Fields the form does not show
// (timing limits, duration, ...) therefore travel unchanged, and an unedited value is never rebuilt
// from its on-screen representation (e.g. 0.07 -> "7" -> 7.000000000000001 -> 0.07000000000000001).
import type {Settings, SettingsInput} from './client.ts';

export const EDITABLE_FIELDS = ['initialCash', 'horizonMs', 'model', 'lookbackIntervals', 'bufferBps', 'allocation',
  'stopLossBps', 'feeBps', 'slippageBps', 'halfSpreadBps'] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

/** Throws, before anything is applied, for settings this slice cannot run. */
export function assertSupported(settings: Settings): void {
  if (settings.replay.source !== 'sample') {
    throw new Error(`This preview only replays the included sample; date-range settings (${settings.replay.start || '?'} → ${settings.replay.end || '?'}) `
      + 'are not supported yet, so nothing was applied. Use the original app for date-range replays.');
  }
  if (settings.config.mode !== 'replay') {
    throw new Error('This preview only runs replays; settings for a live session were not applied.');
  }
}

/** A percentage for display without binary floating point noise (0.07 -> "7"). */
export const percent = (fraction: number): string => String(Number((fraction * 100).toPrecision(12)));

function finiteNumber(raw: string): number {
  const text = raw.trim();
  if (!text || !Number.isFinite(Number(text))) throw new Error('Complete every numeric field with a finite number.');
  return Number(text);
}

export class SettingsDraft {
  #base: Settings;
  readonly #edited = new Set<EditableField>();

  constructor(base: Settings) {
    assertSupported(base);
    this.#base = structuredClone(base);
  }

  /** Adopt newly applied settings; earlier edits are discarded with the old base. */
  replaceBase(base: Settings): void {
    assertSupported(base);
    this.#base = structuredClone(base);
    this.#edited.clear();
  }

  get base(): Settings { return this.#base; }
  markEdited(field: EditableField): void { this.#edited.add(field); }
  get edited(): ReadonlySet<EditableField> { return this.#edited; }

  /** `read` returns the form's current text for a field; it is consulted only for edited fields. */
  request(read: (field: EditableField) => string): SettingsInput {
    const config: Record<string, unknown> = {...this.#base.config};
    let halfSpreadBps = this.#base.replay.halfSpreadBps;
    for (const field of this.#edited) {
      const raw = read(field);
      if (field === 'model') config['model'] = raw;
      else if (field === 'allocation') config['allocationFraction'] = finiteNumber(raw) / 100;
      else if (field === 'halfSpreadBps') halfSpreadBps = finiteNumber(raw);
      else config[field] = finiteNumber(raw);
    }
    return {config: config as SettingsInput['config'], replay: {source: 'sample', halfSpreadBps}};
  }
}
