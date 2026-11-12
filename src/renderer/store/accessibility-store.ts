/**
 * State of the Audit workspace's `Structure` view (tagged-PDF structure tree).
 *
 * Deliberately separate from `audit-store` and `security-store`, for the same
 * reasons those two are separate from each other:
 * - The audit run merges findings page by page; the structure parse is a single
 *   document-level request with its own (much longer) budget. A failure in one
 *   must never look like a failure of the other.
 * - The report is cached per file because parsing walks the whole tagged tree
 *   (bounded to 5000 nodes in the sidecar): entering Structure twice on the
 *   same document must not repeat that work.
 *
 * Nothing here is persisted: the report describes one open document for the
 * current session. `invalidate()` exists so the Audit `Re-run` action can drop
 * the cache and make the next Structure visit parse the document again.
 */
import { create } from 'zustand';
import type { AccessibilityReport } from '../../shared/accessibility-types';
import { ipc } from '../services/ipc-client';

export interface AccessibilityState {
  /** The document the cached report belongs to. */
  filePath: string | null;
  /** Completed `AccessibilityReport`; kept while the same file stays open. */
  report: AccessibilityReport | null;
  loading: boolean;
  /** User-readable message of the last failed read, or null. */
  error: string | null;

  /**
   * Point the store at `filePath` and parse it when needed.
   *
   * A cached report for the same file is reused; a different file (or `null`)
   * drops the old report first, so a Structure view can never show the
   * structure tree of a document that is no longer open.
   */
  open: (filePath: string | null) => void;
  /** Read the document; `force` ignores the cached report. */
  load: (force?: boolean) => Promise<void>;
  /** Drop the cached report (and any in-flight read) without forgetting the file. */
  invalidate: () => void;
  /** Clear every field and drop any in-flight read. */
  reset: () => void;
}

/**
 * Monotonic request token.
 *
 * Module state on purpose: it is never rendered, so a subscriber can neither
 * observe nor restore a stale generation. A response whose token no longer
 * matches the latest request is dropped instead of overwriting newer state.
 */
let currentRequest = 0;

function nextRequest(): number {
  currentRequest += 1;
  return currentRequest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAccessibilityStore = create<AccessibilityState>((set, get) => ({
  filePath: null,
  report: null,
  loading: false,
  error: null,

  open: (filePath) => {
    if (filePath === null) {
      // No document: drop the report and any parse still walking the old one.
      nextRequest();
      set({ filePath: null, report: null, loading: false, error: null });
      return;
    }

    const state = get();

    if (state.filePath !== filePath) {
      // A different document: its structure is unknown, so clear first and
      // only then start the parse (the cleared state must be observable).
      nextRequest();
      set({ filePath, report: null, loading: false, error: null });
      void get().load();
      return;
    }

    // Same document: reuse a completed report and keep waiting for a parse that
    // is already in flight, so toggling the Audit mode never repeats work.
    if (!state.report && !state.loading) {
      void get().load();
    }
  },

  load: async (force = false) => {
    const state = get();
    if (state.filePath === null) return;
    // The cache is the point of this store: only an explicit refresh (or an
    // `invalidate()`), asks the sidecar again.
    if (!force && (state.report || state.loading)) return;

    const token = nextRequest();
    set({ loading: true, error: null });

    try {
      const report = await ipc.accessibilityDocument();
      // Superseded by `open`, `invalidate` or `reset` while the parse was in
      // flight: never publish the structure of a document the user already
      // left.
      if (token !== currentRequest) return;
      set({ report, loading: false, error: null });
    } catch (error) {
      if (token !== currentRequest) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },

  invalidate: () => {
    nextRequest();
    set({ report: null, loading: false, error: null });
  },

  reset: () => {
    nextRequest();
    set({ filePath: null, report: null, loading: false, error: null });
  },
}));
