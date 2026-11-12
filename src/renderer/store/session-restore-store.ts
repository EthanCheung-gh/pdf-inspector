import { create } from 'zustand';
import type { SessionTabKind } from './session-store';

/**
 * Progress/failure state of the startup session restore (work package Q2).
 *
 * Kept out of `session-store` on purpose: that store owns what is *persisted*
 * (tabs, active index, the recent list), while this one is pure runtime UI
 * state. Nothing here is written to localStorage — a failed restore must not
 * feed back into the saved session (the restore engine re-saves the surviving
 * tabs at the end instead, so dead entries are evicted naturally).
 *
 * The engine owns every transition; components only read it (the status bar and
 * the dismissable failure notice are wired in Q3). `restoring`/`done`/`total`
 * describe the run, `failed` lists the skipped documents (name + kind only — no
 * path, so a notice can never leak a location) and `error` is a fatal problem
 * such as a broken plan, never a per-document failure.
 */

/** One session tab that could not be restored (missing file, dead web id, ...). */
export interface SessionRestoreFailure {
  /** Display name of the tab, as shown in the tab bar. */
  name: string;
  kind: SessionTabKind;
}

/** The runtime fields of the restore state (no actions). */
export interface SessionRestoreProgress {
  /** True while documents are being re-opened. */
  restoring: boolean;
  /** Documents attempted so far (successful or skipped). */
  done: number;
  /** Documents the restore plan intended to open. */
  total: number;
  /** Skipped documents, in attempt order. */
  failed: SessionRestoreFailure[];
  /** Why the whole run stopped early, or null. Never thrown to the UI. */
  error: string | null;
}

export interface SessionRestoreState extends SessionRestoreProgress {
  /** Start a run of `total` documents and drop the previous run's outcome. */
  begin: (total: number) => void;
  /** Count one attempted document. */
  advance: () => void;
  /**
   * Record a document that was skipped; the attempt count is unaffected.
   *
   * Idempotent by `kind` + `name`: the record deliberately carries no locator,
   * so two entries with the same kind and name are treated as one document. A
   * notice therefore counts documents, not attempts, and a tab that is opened
   * again (or reported twice) can never inflate the "N could not be restored"
   * number.
   */
  recordFailure: (failure: SessionRestoreFailure) => void;
  /** Mark the run finished; progress and failures stay readable for the UI. */
  finish: () => void;
  /** Stop the run because of a fatal problem (reported, never thrown). */
  fail: (error: string) => void;
  /**
   * Clear the outcome (the dismissable notice / status bar does this). The run
   * state is otherwise left untouched: dismissing a notice never restores.
   */
  dismiss: () => void;
  /** Back to the idle defaults (tests, or a full app reset). */
  reset: () => void;
}

export const INITIAL_SESSION_RESTORE_PROGRESS: SessionRestoreProgress = {
  restoring: false,
  done: 0,
  total: 0,
  failed: [],
  error: null,
};

/** Clamp a planned document count into a sane, non-negative integer. */
const normalizeTotal = (total: number): number =>
  Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;

export const useSessionRestoreStore = create<SessionRestoreState>((set, get) => ({
  ...INITIAL_SESSION_RESTORE_PROGRESS,

  begin: (total) =>
    set({
      restoring: normalizeTotal(total) > 0,
      done: 0,
      total: normalizeTotal(total),
      failed: [],
      error: null,
    }),

  advance: () => {
    const { done, total } = get();
    // Never report more attempts than planned: a retried/new phase must not push
    // the status line past "5/5".
    set({ done: total > 0 ? Math.min(total, done + 1) : done + 1 });
  },

  recordFailure: (failure) =>
    set((state) => {
      // The same document can be attempted twice (a tab that is opened again, or
      // a second phase re-activating an already-restored one); a notice must
      // count documents, not attempts.
      const duplicate = state.failed.some(
        (entry) => entry.kind === failure.kind && entry.name === failure.name,
      );
      return duplicate ? {} : { failed: [...state.failed, failure] };
    }),

  finish: () => set({ restoring: false }),

  fail: (error) => set({ restoring: false, error }),

  dismiss: () => set({ failed: [], error: null }),

  reset: () => set({ ...INITIAL_SESSION_RESTORE_PROGRESS }),
}));
