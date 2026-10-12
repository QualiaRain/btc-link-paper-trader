// Stepwise session panel. The server owns the replay and reveals it causally; this module only
// sends actions and shows what the API returns. Its rules mirror the browser app's ownership guards:
//  * every response's version is tracked and sent back as `expectedVersion`;
//  * an operation is tied to the session generation it started in, so a late response can never
//    update a newer (or closed) session;
//  * manual orders and stepping happen only while paused, idle and outside an exclusive transition
//    (history actions, archiving) and never while a read-only snapshot is on screen;
//  * a stale_session conflict refetches state and tells the person; the action is never retried.
import {ApiError, PaperTrailClient, type Account, type Advance, type CandleJob, type LedgerEvent, type Order, type SessionState, type SessionStep, type SettingsInput} from './client.ts';
import type {RequestOptions} from './settings-draft.ts';
import {el, money, utc} from './format.ts';
import type {RunPanels} from './run-panels.ts';
import {currentRun, type Workspace} from './workspace.ts';

const ASSETS = ['BTC', 'LINK'] as const;
const PLAY_FRAMES = 8;
const PLAY_DELAY_MS = 100;
const PLAY_SYNC_MS = 400; // while playing, the full account is refetched at most this often
const ACTIVITY_LIMIT = 60;
const JOB_POLL_MS = 500;

const clockTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** A session that is unknown or already closed needs no further closing. */
const alreadyGone = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.code === 'session_closed');

export interface SessionViewDeps {
  client: PaperTrailClient;
  panels: RunPanels;
  workspace: Workspace;
  /** The settings the form would send for a start button. May throw a readable Error (e.g. an incomplete date range). */
  readSettings(options: RequestOptions): SettingsInput;
  /** Which replay source the form currently selects (decides the start button's label). */
  replaySource(): 'sample' | 'range';
  /** Live tick interval in ms (10 s unless overridden for tests). */
  liveTickMs: number;
  runName(): string | null;
  download(payload: unknown, name: string): void;
  /** Called after a snapshot reached run history. */
  onSaved(): Promise<void> | void;
  /** A new session is on screen: leave any snapshot, show the Run view. */
  onStarted(): void;
  /** The person asked to save, close this session and configure another. */
  requestArchive(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class SessionView {
  readonly #deps: SessionViewDeps;
  #session: SessionState | null = null;
  #runName = '';
  #account: Account | null = null;
  #accountVersion = -1;
  #lastSync = 0;
  #generation = 0;
  #busy = false;
  #syncing = false;
  #creating = false;
  #playing = false;
  #playToken = 0;
  #pauseRequested = false;
  #snapshotOpen = false;
  #activity: string[] = [];
  #idleWaiters: (() => void)[] = [];
  #fetch: {id: string; cancelled: boolean} | null = null;
  #liveRunning = false;
  #liveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SessionViewDeps) {
    this.#deps = deps;
    const on = (id: string, action: () => unknown): void => $(id).addEventListener('click', () => void Promise.resolve(action()).catch(error => this.#fail(error)));
    on('s-start', () => this.start('replay'));
    on('s-start-live', () => this.start('live'));
    on('s-tick', () => this.#tick('Tick now'));
    on('fetch-cancel', () => this.#cancelFetch());
    on('s-next-frame', () => this.#advance({mode: 'frames', count: 1}, 'Next frame'));
    on('s-next-decision', () => this.#advance({mode: 'decision'}, 'Next decision'));
    on('s-play', () => this.togglePlay());
    on('s-finish', () => this.#advance({mode: 'finish'}, 'Finish'));
    on('s-save', () => this.save());
    on('s-export', () => this.exportRun());
    on('s-close', () => this.close());
    on('s-archive', () => this.#deps.requestArchive());
    for (const asset of ASSETS) {
      on(`s-buy-${asset}`, () => this.#order({asset, side: 'buy', dollars: 100}));
      on(`s-sell-${asset}`, () => this.#order({asset, side: 'sell'}));
    }
    deps.workspace.onChange(() => this.#render());
    document.addEventListener('visibilitychange', () => this.#visibilityChanged());
    this.#render();
  }

  get session(): SessionState | null { return this.#session; }

  // ---- notices and activity -------------------------------------------------------------------
  #notice(text: string, error = false): void {
    $('s-notice').textContent = text;
    $('s-notice').classList.toggle('error', error);
  }
  #fail(error: unknown): void {
    this.#notice(error instanceof Error ? error.message : String(error), true);
  }
  notify(text: string, error = false): void { this.#notice(text, error); }
  #log(text: string): void {
    this.#activity.unshift(text);
    this.#activity.length = Math.min(this.#activity.length, ACTIVITY_LIMIT);
  }
  #stamp(s: SessionState): string { return clockTime(s.currentFrame.time); }

  // ---- state ----------------------------------------------------------------------------------
  /** Adopt a server state unless it is for another session or older than what is shown. */
  #adopt(state: SessionState): void {
    const current = this.#session;
    if (!current || state.id !== current.id || state.version < current.version) return;
    this.#session = state;
    if (state.status !== 'active') { this.#stopPlay(); this.#stopLive(); }
  }
  #stopPlay(): void {
    this.#playing = false;
    this.#playToken++;
  }
  get #working(): boolean { return this.#busy || this.#syncing || this.#creating; }

  /** Resolves once nothing is playing or in flight for the current session (used before archiving, opening snapshots...). */
  whenIdle(): Promise<void> {
    if (!this.#working && !this.#playing) return Promise.resolve();
    return new Promise(resolve => this.#idleWaiters.push(resolve));
  }
  /** Stop playing (if it is) and wait for the in-flight tick to land. */
  async pause(): Promise<void> {
    this.#stopLive();
    if (this.#playing) { this.#stopPlay(); this.#pauseRequested = true; this.#render(); }
    await this.whenIdle();
  }

  setSnapshotOpen(open: boolean): void {
    this.#snapshotOpen = open;
    if (open) { this.#stopPlay(); this.#stopLive(); }
    else this.#paint();
    this.#render();
  }

  // ---- account panels ---------------------------------------------------------------------------
  #paint(): void {
    const s = this.#session, account = this.#account;
    if (this.#snapshotOpen || !s || !account) return;
    const live = s.kind === 'live';
    const mode = s.status === 'completed' ? 'complete' : (live ? this.#liveRunning : this.#playing) ? 'running' : 'paused';
    this.#deps.panels.show({
      name: this.#runName || `Session ${s.runId.slice(0, 8)}`,
      badge: `${live ? 'Live paper' : s.kind === 'sample' ? 'Sample replay' : 'UTC replay'} · ${mode}`,
      detail: `${s.summary.tradeCount} fills · ${s.config.model} · ${s.config.horizonMs / 60000} min horizon · ${utc(s.scoreStart)} → ${utc(s.scoreEnd)} · ${live ? 'latest quotes' : 'clock'} ${utc(s.currentFrame.time)}`,
      account, summary: s.summary, quotes: s.currentFrame.quotes,
    });
  }

  /** Fetch the full account for the panels. While playing this is throttled; the ledger is appended from step events meanwhile. */
  async #sync(force: boolean): Promise<void> {
    const s = this.#session;
    if (!s) return;
    if (!force && (this.#playing || this.#liveRunning) && Date.now() - this.#lastSync < PLAY_SYNC_MS) return;
    const generation = this.#generation;
    this.#syncing = true;
    try {
      const result = await this.#deps.client.getSessionAccount(s.id);
      if (generation !== this.#generation) return;
      const current = this.#session;
      if (!current || result.state.version < current.version) return; // a newer state is already shown
      if (result.state.version > current.version) this.#adopt(result.state);
      this.#account = result.account;
      this.#accountVersion = result.state.version;
      this.#lastSync = Date.now();
      this.#paint();
    } catch (error) {
      if (generation === this.#generation) this.#fail(error);
    } finally {
      if (generation === this.#generation) { this.#syncing = false; this.#render(); }
    }
  }

  #appendEvents(before: SessionState, step: {state: SessionState; events: LedgerEvent[]}): void {
    if (!this.#account || this.#accountVersion !== before.version || this.#snapshotOpen) return;
    this.#account.ledger.push(...step.events);
    this.#accountVersion = step.state.version;
    this.#deps.panels.showLedger(this.#account);
  }

  // ---- start / close / reattach ---------------------------------------------------------------
  async start(kind: 'replay' | 'live' = 'replay'): Promise<void> {
    if (this.#creating || this.#deps.workspace.locked) return;
    let settings: SettingsInput;
    try { settings = this.#deps.readSettings({mode: kind}); } catch (error) { this.#fail(error); return; }
    const range = kind === 'replay' && settings.replay?.source === 'range';
    const previous = this.#session;
    const generation = ++this.#generation; // invalidates every in-flight operation of the old session
    this.#stopPlay();
    this.#stopLive();
    this.#busy = false;
    this.#syncing = false;
    this.#creating = true;
    $('fetch-summary').textContent = '';
    this.#render();
    try {
      let candleJobId: string | undefined;
      if (range) {
        // The old session (if any) stays as it is until the candles are in hand; nothing can step it meanwhile.
        const job = await this.#fetchCandles(settings, generation);
        if (!job || generation !== this.#generation) return;
        candleJobId = job;
      }
      if (previous) {
        this.#notice('Closing the previous session…');
        try { await this.#deps.client.closeSession(previous.id); }
        catch (error) {
          if (!alreadyGone(error)) {
            this.#notice(`The previous session could not be closed, so no new session was started: ${(error as Error).message}`, true);
            return;
          }
        }
        if (generation !== this.#generation) return;
        this.#session = null;
        this.#account = null;
        this.#render();
      }
      this.#notice(kind === 'live' ? 'Starting a live paper session (fetching fresh public quotes)…' : 'Starting a stepwise session on the Python backend…');
      const state = await this.#deps.client.createSession({settings, name: this.#deps.runName(), ...(candleJobId ? {candleJobId} : {})});
      if (generation !== this.#generation) {
        void this.#deps.client.closeSession(state.id).catch(() => undefined); // never leave an unowned session behind
        return;
      }
      this.#session = state;
      this.#account = null;
      this.#runName = this.#deps.runName() ?? '';
      this.#activity = [];
      currentRun.write({runId: state.runId, sessionId: state.id, name: this.#runName});
      this.#log(`${this.#stamp(state)} ${state.kind === 'live' ? 'Live session started at the first observed quotes' : 'Session started at the first scored frame'}`);
      this.#snapshotOpen = false;
      this.#deps.onStarted();
      await this.#sync(true);
      this.#notice(state.kind === 'live'
        ? `Live paper session started at ${utc(state.currentFrame.time)}. Fresh public quotes are fetched by the server every ${this.#deps.liveTickMs / 1000} s while this tab is visible.`
        : `Session started at ${utc(state.currentFrame.time)}. Warmup is excluded; later frames stay hidden until you advance.`);
      if (state.kind === 'live') this.#startLive();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof ApiError && error.code === 'live_unavailable') this.#notice(`Live quotes unavailable: ${error.message}. No live session was started.`, true);
      else this.#fail(error);
    } finally {
      if (generation === this.#generation) { this.#creating = false; this.#render(); }
    }
  }

  // ---- date-range retrieval (candle job) -------------------------------------------------------------
  /** Runs a candle job to completion, showing progress. Returns the job id, or null (with a notice) if it was cancelled, failed or superseded. */
  async #fetchCandles(settings: SettingsInput, generation: number): Promise<string | null> {
    const {client} = this.#deps;
    const replay = settings.replay ?? {};
    const job = await client.createCandleJob({start: replay.start ?? '', end: replay.end ?? '',
      lookbackIntervals: settings.config.lookbackIntervals ?? 7, model: settings.config.model ?? 'trend'});
    const handle = {id: job.id, cancelled: false};
    this.#fetch = handle;
    $('fetch-state').hidden = false;
    try {
      let state: CandleJob = job;
      for (;;) {
        this.#showProgress(state);
        if (generation !== this.#generation) { void client.cancelCandleJob(job.id).catch(() => undefined); return null; }
        if (state.status !== 'running') break;
        await sleep(JOB_POLL_MS);
        state = await client.getCandleJob(job.id);
      }
      if (state.status === 'cancelled' || handle.cancelled) { this.#notice('Historical fetch canceled. No run was created.'); return null; }
      if (state.status === 'failed') { this.#notice(`Historical fetch failed: ${state.error ?? 'unknown error'}. No run was created.`, true); return null; }
      const coverage = (state.coverage ?? {}) as Record<string, {expectedCount?: number; observedCount?: number; missingCount?: number}>;
      $('fetch-summary').textContent = `Retrieved ${state.receipts.length} request${state.receipts.length === 1 ? '' : 's'} · `
        + (['BTC', 'LINK'] as const).map(a => `${a} ${coverage[a]?.observedCount ?? '?'} of ${coverage[a]?.expectedCount ?? '?'} minutes (${coverage[a]?.missingCount ?? '?'} missing)`).join(' · ');
      return job.id;
    } finally {
      if (this.#fetch === handle) this.#fetch = null;
      $('fetch-state').hidden = true;
    }
  }

  #showProgress(job: CandleJob): void {
    const bar = $<HTMLProgressElement>('fetch-progress');
    bar.max = Math.max(1, job.progress.total);
    bar.value = job.progress.completed;
    $('fetch-label').textContent = job.progress.message ?? `${job.progress.phase} ${job.progress.completed}/${job.progress.total}`;
  }

  async #cancelFetch(): Promise<void> {
    const handle = this.#fetch;
    if (!handle) return;
    handle.cancelled = true;
    $('fetch-label').textContent = 'Cancelling…';
    await this.#deps.client.cancelCandleJob(handle.id);
  }

  /** Reattach to a session that outlived a page reload. It comes back paused at the server's version. */
  async reattach(sessionId: string, name = ''): Promise<'attached' | 'closed' | 'missing'> {
    if (this.#creating) return 'missing';
    const generation = ++this.#generation;
    this.#stopLive();
    this.#creating = true;
    this.#render();
    try {
      let state: SessionState;
      try { state = await this.#deps.client.getSession(sessionId); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) return 'missing';
        throw error;
      }
      if (generation !== this.#generation) return 'missing';
      if (state.status === 'closed') return 'closed';
      this.#session = state;
      this.#account = null;
      this.#runName = name;
      this.#activity = [];
      this.#log(`${this.#stamp(state)} Reattached to the live session (paused, version ${state.version})`);
      currentRun.write({runId: state.runId, sessionId: state.id, name});
      await this.#sync(true);
      return 'attached';
    } finally {
      if (generation === this.#generation) { this.#creating = false; this.#render(); }
    }
  }

  async close(quiet = false): Promise<void> {
    const current = this.#session;
    if (!current || this.#creating) return;
    ++this.#generation;
    this.#stopPlay();
    this.#stopLive();
    this.#busy = false;
    this.#syncing = false;
    this.#session = null;
    this.#account = null;
    currentRun.clear();
    if (!this.#snapshotOpen) this.#deps.panels.clear();
    this.#render();
    const unsaved = current.savedVersion !== current.version;
    try {
      await this.#deps.client.closeSession(current.id);
      if (!quiet) this.#notice(unsaved ? 'Session closed. Progress after the last snapshot was discarded; saved snapshots remain in run history.' : 'Session closed. The saved snapshot remains in run history.');
    } catch (error) {
      if (alreadyGone(error)) { if (!quiet) this.#notice('Session closed.'); }
      else this.#fail(error);
    }
  }

  /** Save (if there is unsaved progress), then close the session. Returns false when the save failed and the session stays open. */
  async archive(): Promise<boolean> {
    if (!this.#session) return true;
    await this.pause();
    const s = this.#session;
    if (!s) return true;
    if (s.savedVersion !== s.version && !(await this.save())) return false;
    await this.close(true);
    return true;
  }

  // ---- operations -----------------------------------------------------------------------------
  /** Runs one server call for the current session. Returns true when its result was applied. */
  async #act<T>(call: (session: SessionState) => Promise<T>, apply: (result: T) => void): Promise<boolean> {
    const session = this.#session;
    if (!session || this.#working) return false;
    const generation = this.#generation;
    this.#busy = true;
    this.#render();
    try {
      const result = await call(session);
      if (generation !== this.#generation) return false; // the session was replaced or closed meanwhile
      apply(result);
      this.#render();
      await this.#sync(false);
      return true;
    } catch (error) {
      if (generation !== this.#generation) return false;
      this.#stopPlay();
      await this.#handleError(error, session, generation);
      return false;
    } finally {
      if (generation === this.#generation) { this.#busy = false; this.#render(); }
    }
  }

  async #handleError(error: unknown, session: SessionState, generation: number): Promise<void> {
    if (!(error instanceof ApiError)) { this.#fail(error); return; }
    if (error.code === 'stale_session') {
      const held = error.currentVersion ?? '?';
      try {
        const fresh = await this.#deps.client.getSession(session.id);
        if (generation !== this.#generation) return;
        this.#adopt(fresh);
        await this.#sync(true);
      } catch (refetch) {
        if (generation !== this.#generation) return;
        this.#fail(refetch);
        return;
      }
      if (generation !== this.#generation) return;
      this.#log(`${clockTime(this.#session?.currentFrame.time ?? session.currentFrame.time)} Stale action ignored (had version ${session.version}, server at ${held})`);
      this.#notice(`Stale session: this session changed elsewhere (you had version ${session.version}, the server is at ${held}). The latest state was loaded and your action was not applied. Repeat it if you still want it.`, true);
      return;
    }
    if (error.code === 'session_completed') {
      try {
        const fresh = await this.#deps.client.getSession(session.id);
        if (generation === this.#generation) { this.#adopt(fresh); await this.#sync(true); }
      } catch { /* the notice below is enough */ }
      if (generation !== this.#generation) return;
      this.#log(`${clockTime(this.#session?.currentFrame.time ?? session.currentFrame.time)} Rejected: ${error.message}`);
      this.#notice(`Session completed: ${error.message}`, true);
      return;
    }
    if (error.code === 'live_unavailable') {
      this.#log(`${this.#stamp(session)} Live quotes unavailable: ${error.message}`);
      this.#notice(`Live quotes unavailable: ${error.message}. The session was not changed.`, true);
      return;
    }
    if (error.code === 'order_rejected') {
      this.#log(`${this.#stamp(session)} Order rejected: ${error.message}`);
      this.#notice(`Order rejected: ${error.message}`, true);
      return;
    }
    if (error.status === 404) {
      this.#session = null;
      this.#account = null;
      currentRun.clear();
      this.#deps.panels.clear();
      this.#notice(`The session no longer exists on the server (${error.message}). Start a new one.`, true);
      return;
    }
    this.#fail(error);
  }

  #describe(events: LedgerEvent[]): string[] {
    const lines: string[] = [];
    for (const event of events) {
      const e = event as LedgerEvent & Record<string, unknown>;
      if (e['actor'] === 'benchmark') continue;
      if (e.type === 'trade') {
        const who = e['actor'] === 'manual' ? 'Manual' : 'Auto';
        const btc = e['asset'] === 'BTC';
        lines.push(`${clockTime(e.time)} ${who} ${String(e['side'])} ${String(e['asset'])} ${Number(e['qty']).toFixed(btc ? 6 : 3)} @ ${money(Number(e['price']), btc ? 2 : 4)} (fee ${money(Number(e['fee']))})`);
      } else if (e.type === 'complete') lines.push(`${clockTime(e.time)} Replay complete; positions closed with modeled exit costs`);
    }
    return lines;
  }

  #applyStep(step: SessionStep, label: string): void {
    const before = this.#session!;
    this.#adopt(step.state);
    this.#appendEvents(before, step);
    const now = this.#session!;
    for (const line of this.#describe(step.events).reverse()) this.#log(line);
    const frames = `${step.framesIngested} frame${step.framesIngested === 1 ? '' : 's'}`;
    this.#log(`${this.#stamp(now)} ${label}: ${frames} ingested`);
    if (label === 'Play') return;
    this.#notice(now.status === 'completed'
      ? (now.kind === 'live' ? 'The live session reached its configured duration. Positions were closed with modeled exit costs.' : 'Replay complete at the exact final close. Positions were closed with modeled exit costs.')
      : `${label}: ${frames} ingested, now at ${utc(now.currentFrame.time)}.`);
  }

  async #advance(advance: Advance, label: string): Promise<boolean> {
    if (!this.#canStep()) return false;
    return this.#act(session => this.#deps.client.advance(session.id, advance, session.version), step => this.#applyStep(step, label));
  }

  /** Live sessions: the server fetches fresh public quotes and ingests them. 502 leaves the session unchanged. */
  async #tick(label: string): Promise<boolean> {
    if (!this.#canTick()) return false;
    return this.#act(session => this.#deps.client.tickSession(session.id, session.version), step => this.#applyStep(step, label));
  }

  async #order(order: Order): Promise<boolean> {
    if (!this.#canOrder()) return false;
    return this.#act(
      session => this.#deps.client.placeOrder(session.id, order, session.version),
      step => {
        const before = this.#session!;
        this.#adopt(step.state);
        this.#appendEvents(before, step);
        for (const line of this.#describe(step.events).reverse()) this.#log(line);
        this.#notice(`Manual paper ${order.side} ${order.asset} recorded. This run now includes manual changes.`);
      });
  }

  async togglePlay(): Promise<void> {
    if (this.#session?.kind === 'live') { this.#toggleLive(); return; }
    if (this.#playing) {
      this.#stopPlay();
      this.#pauseRequested = true; // the loop announces the pause once its in-flight tick has landed
      this.#render();
      this.#notice('Pausing after the current step…');
      return;
    }
    if (!this.#canStep()) return;
    this.#playing = true;
    const token = ++this.#playToken;
    const generation = this.#generation;
    this.#notice('Playing recorded observations…');
    this.#render();
    while (this.#playing && this.#playToken === token && this.#generation === generation) {
      const applied = await this.#advance({mode: 'frames', count: PLAY_FRAMES}, 'Play');
      if (!applied || this.#playToken !== token || this.#generation !== generation) break;
      if (this.#session?.status !== 'active') break;
      await sleep(PLAY_DELAY_MS);
    }
    if (this.#generation !== generation) return;
    const ownLoop = this.#playToken === token;
    if (ownLoop) this.#playing = false;
    const pausedByPerson = !ownLoop && this.#pauseRequested && !this.#playing;
    if (ownLoop || pausedByPerson) await this.#sync(true); // the panels catch up with everything the throttle skipped
    if (this.#generation !== generation) return;
    if (ownLoop) {
      if (this.#session?.status === 'completed') this.#notice('Replay complete at the exact final close. Positions were closed with modeled exit costs.');
    } else if (pausedByPerson) {
      const s = this.#session;
      if (s) this.#notice(`Paused at ${utc(s.currentFrame.time)}. No further frames are being ingested.`);
    }
    this.#pauseRequested = false;
    this.#render();
    this.#paint();
  }

  // ---- live ticking: only while the page is visible, never overlapping, paused when hidden ---------------
  #visible(): boolean { return document.visibilityState === 'visible' && !document.hidden; }
  #canTick(): boolean {
    const s = this.#session;
    return !!s && s.kind === 'live' && s.status === 'active' && !this.#working && !this.#deps.workspace.locked && !this.#snapshotOpen;
  }
  #startLive(): void {
    this.#liveRunning = true;
    this.#scheduleTick();
    this.#render();
    this.#paint();
  }
  #stopLive(): void {
    this.#liveRunning = false;
    if (this.#liveTimer !== null) clearTimeout(this.#liveTimer);
    this.#liveTimer = null;
  }
  #scheduleTick(): void {
    if (this.#liveTimer !== null) clearTimeout(this.#liveTimer);
    this.#liveTimer = null;
    if (!this.#liveRunning || !this.#visible()) return;
    const generation = this.#generation;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = null;
      if (!this.#liveRunning || generation !== this.#generation) return;
      void (this.#visible() && this.#canTick() ? this.#tick('Live tick') : Promise.resolve()).finally(() => {
        if (this.#liveRunning && generation === this.#generation) this.#scheduleTick();
      });
    }, this.#deps.liveTickMs);
  }
  #toggleLive(): void {
    if (this.#liveRunning) {
      this.#stopLive();
      this.#notice('Live ticking paused. Manual orders still fetch fresh quotes.');
      this.#render();
      this.#paint();
      return;
    }
    if (this.#session?.status !== 'active') return;
    this.#startLive();
    this.#notice(`Live ticking resumed every ${this.#deps.liveTickMs / 1000} s while this tab is visible.`);
    void this.#tick('Live tick');
  }
  #visibilityChanged(): void {
    if (!this.#liveRunning) return;
    if (!this.#visible()) {
      if (this.#liveTimer !== null) clearTimeout(this.#liveTimer);
      this.#liveTimer = null;
      this.#notice('Live ticking is paused while this tab is hidden; observations resume when it is visible again.');
      this.#render();
      return;
    }
    this.#notice('Tab visible again: live ticking resumed.');
    void this.#tick('Live tick').finally(() => this.#scheduleTick());
  }

  refreshLabels(): void { this.#render(); }

  /** Manual orders work in replay and live sessions (a live order fetches its own fresh quote server-side). */
  #canOrder(): boolean {
    const s = this.#session;
    return !!s && s.status === 'active' && !this.#working && !this.#deps.workspace.locked && !this.#snapshotOpen && !this.#playing;
  }

  #canStep(): boolean {
    const s = this.#session;
    return !!s && s.kind !== 'live' && s.status === 'active' && !this.#working && !this.#deps.workspace.locked && !this.#snapshotOpen;
  }

  async save(): Promise<boolean> {
    if (this.#snapshotOpen) return false;
    const name = this.#deps.runName();
    const saved = await this.#act(
      session => this.#deps.client.saveSession(session.id, session.version, name),
      result => {
        this.#adopt(result.state);
        if (name) this.#runName = name;
        currentRun.write({runId: result.state.runId, sessionId: result.state.id, name: this.#runName});
        this.#log(`${this.#stamp(result.state)} Snapshot saved to run history as ${result.run.id}`);
        this.#notice(`Snapshot saved to run history (run ${result.run.id}). Closing this session keeps it.`);
      });
    if (saved) await this.#deps.onSaved();
    return saved;
  }

  async exportRun(): Promise<void> {
    if (this.#snapshotOpen) return;
    let exported: {runId: string; record: unknown} | null = null;
    const name = this.#deps.runName();
    const saved = await this.#act(
      async session => {
        const result = await this.#deps.client.saveSession(session.id, session.version, name);
        return {result, record: await this.#deps.client.exportRun(result.run.id)}; // run id captured with the save
      },
      ({result, record}) => {
        this.#adopt(result.state);
        exported = {runId: result.run.id, record};
        this.#log(`${this.#stamp(result.state)} Snapshot saved and exported (${result.run.id})`);
      });
    const done = exported as {runId: string; record: unknown} | null;
    if (!saved || !done) return;
    this.#deps.download(done.record, `paper-trail-${done.runId}-run.json`);
    this.#notice('Snapshot saved, then exported with frozen settings, results, evidence and hashes.');
    await this.#deps.onSaved();
  }

  // ---- rendering ------------------------------------------------------------------------------
  #render(): void {
    const s = this.#session;
    const root = $('session-panel');
    const locked = this.#deps.workspace.locked;
    root.dataset['status'] = s?.status ?? 'none';
    root.dataset['version'] = String(s?.version ?? '');
    root.dataset['sessionId'] = s?.id ?? '';
    root.dataset['runId'] = s?.runId ?? '';
    root.dataset['playing'] = String(this.#playing);
    root.dataset['kind'] = s?.kind ?? '';
    root.dataset['live'] = String(this.#liveRunning);
    root.dataset['busy'] = String(this.#working || locked);
    root.dataset['snapshot'] = String(this.#snapshotOpen);
    $('s-state').hidden = !s || this.#snapshotOpen;
    $('s-empty').hidden = !!s;
    $('s-background').hidden = !s || !this.#snapshotOpen;
    const idle = !!s && s.status === 'active' && !this.#working && !this.#playing && !locked && !this.#snapshotOpen;
    const set = (id: string, enabled: boolean): void => { $<HTMLButtonElement>(id).disabled = !enabled; };
    const live = s?.kind === 'live';
    set('s-start', !this.#creating && !locked);
    set('s-start-live', !this.#creating && !locked);
    for (const id of ['s-next-frame', 's-next-decision', 's-finish']) $(id).hidden = live;
    $('s-tick').hidden = !live;
    set('s-next-frame', idle && !live);
    set('s-next-decision', idle && !live);
    set('s-finish', idle && !live);
    set('s-tick', live && this.#canTick());
    set('s-play', !!s && s.status === 'active' && !this.#creating && !locked && !this.#snapshotOpen && (live || this.#playing || !this.#working));
    $('s-play').textContent = live ? (this.#liveRunning ? 'Pause live' : 'Resume live') : this.#playing ? 'Pause' : 'Play';
    $('s-live-note').hidden = !live;
    const quiet = !!s && !this.#working && !this.#playing && !locked && !this.#snapshotOpen;
    set('s-save', quiet);
    set('s-export', quiet);
    set('s-archive', quiet);
    set('s-close', !!s && !this.#creating && !locked);
    for (const asset of ASSETS) { set(`s-buy-${asset}`, idle); set(`s-sell-${asset}`, idle); }
    const range = this.#deps.replaySource() === 'range';
    $('s-start').textContent = s ? (range ? 'Close and fetch a new replay' : 'Close and start a new session') : (range ? 'Fetch & start replay' : 'Start session');
    $('s-start-live').textContent = s ? 'Close and start a live paper session' : 'Start live paper session';
    if (s) this.#renderState(s);
    $('s-activity').replaceChildren(...this.#activity.map(text => el('li', '', text)));
    if (!this.#working && !this.#playing) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  #renderState(s: SessionState): void {
    const clock = $('s-clock');
    clock.textContent = utc(s.currentFrame.time);
    clock.dataset['time'] = String(s.currentFrame.time);
    const live = s.kind === 'live';
    $('s-status').textContent = s.status === 'completed' ? 'Completed' : live ? (this.#liveRunning ? 'Live · ticking' : 'Live · paused') : this.#playing ? 'Playing' : 'Paused';
    const progress = $<HTMLProgressElement>('s-progress');
    progress.hidden = live;
    progress.max = Math.max(1, s.frameCount - 1);
    progress.value = s.cursor;
    $('s-cursor').textContent = live ? `${s.frameCount} live observation${s.frameCount === 1 ? '' : 's'}` : `Frame ${s.cursor + 1} of ${s.frameCount}`;
    $('s-live-note').textContent = live
      ? `Paper session until ${utc(s.scoreEnd)}. ${this.#liveRunning ? `Fresh public quotes are fetched every ${this.#deps.liveTickMs / 1000} s while this tab is visible.` : 'Ticking is paused; use Tick now or Resume live.'}`
      : '';
    $('s-cursor').dataset['cursor'] = String(s.cursor);
    $('s-cursor').dataset['frameCount'] = String(s.frameCount);
    const metrics: [string, number, string][] = [
      ['s-cash', s.summary.cash, money(s.summary.cash)],
      ['s-equity', s.summary.equity, money(s.summary.equity)],
      ['s-buyhold', s.summary.buyHoldEquity, money(s.summary.buyHoldEquity)],
      ['s-fees', s.summary.fees, money(s.summary.fees)],
      ['s-trades', s.summary.tradeCount, String(s.summary.tradeCount)],
    ];
    for (const [id, raw, text] of metrics) { $(id).textContent = text; $(id).dataset['raw'] = String(raw); }
    for (const asset of ASSETS) {
      const quote = s.currentFrame.quotes[asset];
      const qty = s.summary.perAsset[asset].qty;
      $(`s-price-${asset}`).textContent = money(quote.mid, asset === 'BTC' ? 2 : 4);
      $(`s-qty-${asset}`).textContent = qty.toFixed(asset === 'BTC' ? 6 : 3);
      $(`s-qty-${asset}`).dataset['raw'] = String(qty);
    }
    $('s-saved').textContent = s.savedVersion === null ? 'Not saved yet' : s.savedVersion === s.version ? 'Saved (up to date)' : 'Saved earlier; newer progress unsaved';
    $('s-run-id').textContent = s.runId;
    $('s-manual').textContent = String(s.manualTradeCount);
  }
}
