// Typed client for the versioned Python API. Request and response types come from
// ../contract/openapi.json via `npm run types`; nothing here re-implements replay or accounting.
import type {components} from './api-types.ts';

type Schemas = components['schemas'];
export type Settings = Schemas['Settings'];
export type SettingsInput = Schemas['SettingsInput'];
export type ReplayRequest = Schemas['ReplayRequest'];
export type ReplayResult = Schemas['ReplayResult'];
export type RunMetadata = Schemas['RunMetadata'];
export type RunRecord = Schemas['RunRecord'];
export type Summary = Schemas['Summary'];
export type Account = Schemas['Account'];
export type Health = Schemas['Health'];
export type Defaults = Schemas['Defaults'];
export type CandleSeries = Schemas['CandleSeries'];

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  /** Origin of the API, e.g. `http://127.0.0.1:8000`. Empty uses the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class PaperTrailClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor({baseUrl = '', fetch: fetchImpl}: ClientOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '');
    // Browsers throw "Illegal invocation" if fetch is called with a non-window receiver.
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: body === undefined ? undefined : {'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
      });
    } catch (error) {
      throw new ApiError(0, 'network_error', `Paper Trail API unreachable: ${(error as Error).message}`);
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
    if (!response.ok) {
      const detail = (payload as Schemas['ApiError'] | undefined)?.error;
      throw new ApiError(response.status, detail?.code ?? 'http_error', detail?.message ?? `API returned HTTP ${response.status}`);
    }
    return payload as T;
  }

  health(): Promise<Health> { return this.#call('GET', '/v1/health'); }
  defaults(): Promise<Defaults> { return this.#call('GET', '/v1/defaults'); }
  normalizeSettings(settings: SettingsInput): Promise<Settings> { return this.#call('POST', '/v1/settings/normalize', settings); }
  createReplay(request: ReplayRequest): Promise<ReplayResult> { return this.#call('POST', '/v1/replays', request); }
  async listRuns(): Promise<RunMetadata[]> { return (await this.#call<Schemas['RunList']>('GET', '/v1/runs')).runs; }
  getRun(id: string): Promise<RunRecord> { return this.#call('GET', `/v1/runs/${encodeURIComponent(id)}`); }
  /** Results export: the full run record (frozen settings, ledger, summary, evidence hashes). */
  exportRun(id: string): Promise<RunRecord> { return this.#call('GET', `/v1/runs/${encodeURIComponent(id)}/export`); }
  /** Settings export: importable via `normalizeSettings` before starting a new run. */
  exportSettings(id: string): Promise<Settings> { return this.#call('GET', `/v1/runs/${encodeURIComponent(id)}/settings`); }
  /** Import a `paper-trail-run-v2` record exported by the browser app or by this service. */
  importRun(record: object): Promise<RunMetadata> { return this.#call('POST', '/v1/runs/import', record); }
}
