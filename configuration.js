import {createAccount} from './engine.js';

export const HORIZONS = [60000, 300000, 420000, 900000, 3600000, 25200000, 86400000];
export const CONFIG_FIELDS = ['initialCash','horizonMs','model','lookbackIntervals','bufferBps',
  'allocationFraction','stopLossBps','maxDrawdownBps','dailyLossBps','feeBps','slippageBps','durationMs','maxQuoteAgeMs','maxOutcomeLatenessMs'];

export function utcMinute(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('Choose a valid UTC date and minute.');
  const time = Date.parse(value + ':00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,16) !== value)
    throw new Error('Choose a valid UTC date and minute.');
  return time;
}

export function normalizeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings object.');
  const raw = input.config ?? input.account?.config;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings need a config object.');
  const config = {};
  for (const field of Object.keys(raw)) if (!CONFIG_FIELDS.includes(field) && field !== 'mode')
    throw new Error(`Unknown configuration field: ${field}`);
  for (const field of CONFIG_FIELDS) if (Object.hasOwn(raw, field)) config[field] = raw[field];
  config.mode = raw.mode ?? 'replay';
  const normalized = createAccount(config).config;
  if (!HORIZONS.includes(normalized.horizonMs)) throw new Error('Choose one of the supported forecast horizons.');
  const replay = input.replay ?? input.market?.settings?.replay ?? {};
  const source = replay.source ?? 'sample';
  if (!['sample','range'].includes(source)) throw new Error('Replay source must be sample or range.');
  const halfSpreadBps = replay.halfSpreadBps ?? 2;
  if (typeof halfSpreadBps !== 'number' || !Number.isFinite(halfSpreadBps) || halfSpreadBps < 0 || halfSpreadBps > 1000)
    throw new Error('Assumed replay half-spread must be between 0 and 1,000 basis points.');
  const start = replay.start ?? '', end = replay.end ?? '';
  if (source === 'range') {
    const first = utcMinute(start), last = utcMinute(end);
    if (last <= first || last-first > 31*86400000) throw new Error('Choose an increasing UTC range of at most 31 days.');
    if (last > Math.floor(Date.now()/60000)*60000) throw new Error('Historical end must be a completed minute.');
  } else if ((start && typeof start !== 'string') || (end && typeof end !== 'string')) {
    throw new Error('Invalid historical date fields.');
  }
  return {format:'paper-trail-settings-v2',config:normalized,replay:{source,start,end,halfSpreadBps}};
}
