// Shared coordination for the page: an exclusive-transition lock (so history actions, archiving and
// session starts never interleave) and the per-viewer "current run" pointer kept in localStorage.
// localStorage is only a convenience for this browser; the server stays the source of truth.

export class Workspace {
  #locked: string | null = null;
  readonly #listeners = new Set<() => void>();

  get locked(): boolean { return this.#locked !== null; }
  get lockedBy(): string | null { return this.#locked; }
  onChange(listener: () => void): void { this.#listeners.add(listener); }

  /** Runs `work` only if no other transition is in flight. Returns whether it ran. */
  async exclusive(label: string, work: () => Promise<void>): Promise<boolean> {
    if (this.#locked !== null) return false;
    this.#locked = label;
    this.#emit();
    try { await work(); return true; }
    finally { this.#locked = null; this.#emit(); }
  }
  #emit(): void { for (const listener of this.#listeners) listener(); }
}

const KEY = 'paper-trail.ts.current-run';
export interface CurrentRun { runId: string; name?: string; sessionId?: string; readOnly?: boolean }

export const currentRun = {
  read(): CurrentRun | null {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) as Partial<CurrentRun> : null;
      return parsed && typeof parsed.runId === 'string' ? parsed as CurrentRun : null;
    } catch { return null; }
  },
  write(value: CurrentRun): void { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* per-viewer convenience only */ } },
  clear(): void { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};
