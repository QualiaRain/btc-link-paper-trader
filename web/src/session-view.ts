// Stepwise session panel. The server owns the replay and reveals it causally; this module only
// sends actions and shows what the API returns. Its rules mirror the browser app's ownership guards:
//  * every response's version is tracked and sent back as `expectedVersion`;
//  * an operation is tied to the session generation it started in, so a late response can never
//    update a newer (or closed) session;
//  * manual orders and stepping happen only while paused and idle;
//  * a stale_session conflict refetches state and tells the person; the action is never retried.
import {ApiError, PaperTrailClient, type Advance, type LedgerEvent, type Order, type SessionState, type SettingsInput} from './client.ts';

const ASSETS = ['BTC', 'LINK'] as const;
const PLAY_FRAMES = 8;
const PLAY_DELAY_MS = 100;
const ACTIVITY_LIMIT = 60;

const money = (n: number, digits = 2): string => n.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits});
const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const clockTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface SessionViewDeps {
  client: PaperTrailClient;
  /** The settings the form would send (sample replay only). May throw a readable Error. */
  readSettings(): SettingsInput;
  runName(): string | null;
  download(payload: unknown, name: string): void;
  /** Called after a snapshot reached run history. */
  onSaved(): Promise<void> | void;
}

/** A session that is unknown or already closed needs no further closing. */
const alreadyGone = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.code === 'session_closed');

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class SessionView {
  readonly #deps: SessionViewDeps;
  #session: SessionState | null = null;
  #generation = 0;
  #busy = false;
  #creating = false;
  #playing = false;
  #playToken = 0;
  #pauseRequested = false;
  #activity: string[] = [];

  constructor(deps: SessionViewDeps) {
    this.#deps = deps;
    const on = (id: string, action: () => Promise<unknown>): void => $(id).addEventListener('click', () => void action().catch(error => this.#fail(error)));
    on('s-start', () => this.start());
    on('s-next-frame', () => this.#advance({mode: 'frames', count: 1}, 'Next frame'));
    on('s-next-decision', () => this.#advance({mode: 'decision'}, 'Next decision'));
    on('s-play', () => this.togglePlay());
    on('s-finish', () => this.#advance({mode: 'finish'}, 'Finish'));
    on('s-save', () => this.save());
    on('s-export', () => this.exportRun());
    on('s-close', () => this.close());
    for (const asset of ASSETS) {
      on(`s-buy-${asset}`, () => this.#order({asset, side: 'buy', dollars: 100}));
      on(`s-sell-${asset}`, () => this.#order({asset, side: 'sell'}));
    }
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
    if (state.status !== 'active') this.#stopPlay();
  }
  #stopPlay(): void {
    this.#playing = false;
    this.#playToken++;
  }

  // ---- start / close --------------------------------------------------------------------------
  async start(): Promise<void> {
    if (this.#creating) return;
    let settings: SettingsInput;
    try { settings = this.#deps.readSettings(); } catch (error) { this.#fail(error); return; }
    const previous = this.#session;
    const generation = ++this.#generation; // invalidates every in-flight operation of the old session
    this.#stopPlay();
    this.#busy = false;
    this.#creating = true;
    this.#render();
    try {
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
        this.#render();
      }
      this.#notice('Starting a stepwise session on the Python backend…');
      const state = await this.#deps.client.createSession({settings, name: this.#deps.runName()});
      if (generation !== this.#generation) {
        void this.#deps.client.closeSession(state.id).catch(() => undefined); // never leave an unowned session behind
        return;
      }
      this.#session = state;
      this.#activity = [];
      this.#log(`${this.#stamp(state)} Session started at the first scored frame`);
      this.#notice(`Session started at ${utc(state.currentFrame.time)}. Warmup is excluded; later frames stay hidden until you advance.`);
    } catch (error) {
      if (generation === this.#generation) this.#fail(error);
    } finally {
      if (generation === this.#generation) { this.#creating = false; this.#render(); }
    }
  }

  async close(): Promise<void> {
    const current = this.#session;
    if (!current || this.#creating) return;
    ++this.#generation;
    this.#stopPlay();
    this.#busy = false;
    this.#session = null;
    this.#render();
    const unsaved = current.savedVersion !== current.version;
    try {
      await this.#deps.client.closeSession(current.id);
      this.#notice(unsaved ? 'Session closed. Progress after the last snapshot was discarded; saved snapshots remain in run history.' : 'Session closed. The saved snapshot remains in run history.');
    } catch (error) {
      if (alreadyGone(error)) this.#notice('Session closed.');
      else this.#fail(error);
    }
  }

  // ---- operations -----------------------------------------------------------------------------
  /** Runs one server call for the current session. Returns true when its result was applied. */
  async #act<T>(call: (session: SessionState) => Promise<T>, apply: (result: T) => void): Promise<boolean> {
    const session = this.#session;
    if (!session || this.#busy || this.#creating) return false;
    const generation = this.#generation;
    this.#busy = true;
    this.#render();
    try {
      const result = await call(session);
      if (generation !== this.#generation) return false; // the session was replaced or closed meanwhile
      apply(result);
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
      } catch (refetch) {
        if (generation !== this.#generation) return;
        this.#fail(refetch);
        return;
      }
      this.#log(`${clockTime(this.#session?.currentFrame.time ?? session.currentFrame.time)} Stale action ignored (had version ${session.version}, server at ${held})`);
      this.#notice(`Stale session: this session changed elsewhere (you had version ${session.version}, the server is at ${held}). The latest state was loaded and your action was not applied. Repeat it if you still want it.`, true);
      return;
    }
    if (error.code === 'session_completed') {
      try {
        const fresh = await this.#deps.client.getSession(session.id);
        if (generation === this.#generation) this.#adopt(fresh);
      } catch { /* the notice below is enough */ }
      this.#log(`${clockTime(this.#session?.currentFrame.time ?? session.currentFrame.time)} Rejected: ${error.message}`);
      this.#notice(`Session completed: ${error.message}`, true);
      return;
    }
    if (error.code === 'order_rejected') {
      this.#log(`${this.#stamp(session)} Order rejected: ${error.message}`);
      this.#notice(`Order rejected: ${error.message}`, true);
      return;
    }
    if (error.status === 404) {
      this.#session = null;
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

  async #advance(advance: Advance, label: string): Promise<boolean> {
    if (!this.#canStep()) return false;
    return this.#act(
      session => this.#deps.client.advance(session.id, advance, session.version),
      step => {
        this.#adopt(step.state);
        const now = this.#session!;
        for (const line of this.#describe(step.events).reverse()) this.#log(line);
        const frames = `${step.framesIngested} frame${step.framesIngested === 1 ? '' : 's'}`;
        this.#log(`${this.#stamp(now)} ${label}: ${frames} ingested`);
        if (label !== 'Play') {
          this.#notice(now.status === 'completed'
            ? 'Replay complete at the exact final close. Positions were closed with modeled exit costs.'
            : `${label}: ${frames} ingested, now at ${utc(now.currentFrame.time)}.`);
        }
      });
  }

  async #order(order: Order): Promise<boolean> {
    if (!this.#canStep()) return false;
    return this.#act(
      session => this.#deps.client.placeOrder(session.id, order, session.version),
      step => {
        this.#adopt(step.state);
        for (const line of this.#describe(step.events).reverse()) this.#log(line);
        this.#notice(`Manual paper ${order.side} ${order.asset} recorded. This run now includes manual changes.`);
      });
  }

  async togglePlay(): Promise<void> {
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
    if (this.#playToken === token) {
      this.#playing = false;
      if (this.#session?.status === 'completed') this.#notice('Replay complete at the exact final close. Positions were closed with modeled exit costs.');
    } else if (this.#pauseRequested && !this.#playing) {
      const s = this.#session;
      if (s) this.#notice(`Paused at ${utc(s.currentFrame.time)}. No further frames are being ingested.`);
    }
    this.#pauseRequested = false;
    this.#render();
  }

  #canStep(): boolean {
    const s = this.#session;
    return !!s && s.status === 'active' && !this.#busy && !this.#creating;
  }

  async save(): Promise<boolean> {
    const name = this.#deps.runName();
    const saved = await this.#act(
      session => this.#deps.client.saveSession(session.id, session.version, name),
      result => {
        this.#adopt(result.state);
        this.#log(`${this.#stamp(result.state)} Snapshot saved to run history as ${result.run.id}`);
        this.#notice(`Snapshot saved to run history (run ${result.run.id}). Closing this session keeps it.`);
      });
    if (saved) await this.#deps.onSaved();
    return saved;
  }

  async exportRun(): Promise<void> {
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
    root.dataset['status'] = s?.status ?? 'none';
    root.dataset['version'] = String(s?.version ?? '');
    root.dataset['sessionId'] = s?.id ?? '';
    root.dataset['playing'] = String(this.#playing);
    root.dataset['busy'] = String(this.#busy || this.#creating);
    $('s-state').hidden = !s;
    $('s-empty').hidden = !!s;
    const idle = !!s && s.status === 'active' && !this.#busy && !this.#creating && !this.#playing;
    const set = (id: string, enabled: boolean): void => { $<HTMLButtonElement>(id).disabled = !enabled; };
    set('s-start', !this.#creating);
    set('s-next-frame', idle);
    set('s-next-decision', idle);
    set('s-finish', idle);
    set('s-play', !!s && s.status === 'active' && !this.#creating && (this.#playing || !this.#busy));
    $('s-play').textContent = this.#playing ? 'Pause' : 'Play';
    set('s-save', !!s && !this.#busy && !this.#creating && !this.#playing);
    set('s-export', !!s && !this.#busy && !this.#creating && !this.#playing);
    set('s-close', !!s && !this.#creating);
    for (const asset of ASSETS) { set(`s-buy-${asset}`, idle); set(`s-sell-${asset}`, idle); }
    $('s-start').textContent = s ? 'Close and start a new session' : 'Start session';
    if (s) this.#renderState(s);
    $('s-activity').replaceChildren(...this.#activity.map(text => Object.assign(document.createElement('li'), {textContent: text})));
  }

  #renderState(s: SessionState): void {
    const clock = $('s-clock');
    clock.textContent = utc(s.currentFrame.time);
    clock.dataset['time'] = String(s.currentFrame.time);
    $('s-status').textContent = s.status === 'completed' ? 'Completed' : this.#playing ? 'Playing' : 'Paused';
    const progress = $<HTMLProgressElement>('s-progress');
    progress.max = Math.max(1, s.frameCount - 1);
    progress.value = s.cursor;
    $('s-cursor').textContent = `Frame ${s.cursor + 1} of ${s.frameCount}`;
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
