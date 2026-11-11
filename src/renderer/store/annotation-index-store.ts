import { create } from 'zustand';
import type { AnnotationKind } from '../types/annotations';
import type {
  AnnotationIndexEntry,
  AnnotationIndexResult,
  AnnotationIndexSummary,
} from '../services/annotation-index';

/** Kind filter value: every kind, or one specific kind. */
export type AnnotationIndexKindFilter = 'all' | AnnotationKind;

export type AnnotationIndexStatus = 'idle' | 'indexing' | 'ready' | 'error';

/** Scanned pages out of the document total. */
export interface AnnotationIndexProgress {
  done: number;
  total: number;
}

/**
 * Whole-document annotation index state.
 *
 * The index is a long-running, cancellable read of the entire document, so its
 * lifecycle (`status`/`progress`) is kept away from the current-page store: a
 * background index never touches what the Annots tab shows for the active page.
 * `documentKey` guards every write so a slow index for a closed document can
 * never publish into the next one.
 */
export interface AnnotationIndexState {
  /** `filePath` + `sourceUrl` of the indexed document, or null when unset. */
  documentKey: string | null;
  status: AnnotationIndexStatus;
  progress: AnnotationIndexProgress | null;
  result: AnnotationIndexResult | null;
  error: string | null;
  query: string;
  kindFilter: AnnotationIndexKindFilter;
  subtypeFilter: 'all' | string;

  start(documentKey: string, total: number): void;
  setProgress(done: number, total: number): void;
  finish(documentKey: string, result: AnnotationIndexResult): void;
  fail(documentKey: string, error: string): void;
  reset(): void;
  setQuery(query: string): void;
  setKindFilter(filter: AnnotationIndexKindFilter): void;
  setSubtypeFilter(filter: 'all' | string): void;
}

/** Search/filter state an idle index starts from. */
const DEFAULT_FILTERS: Pick<AnnotationIndexState, 'query' | 'kindFilter' | 'subtypeFilter'> = {
  query: '',
  kindFilter: 'all',
  subtypeFilter: 'all',
};

const IDLE_STATE: Pick<
  AnnotationIndexState,
  'documentKey' | 'status' | 'progress' | 'result' | 'error'
> = {
  documentKey: null,
  status: 'idle',
  progress: null,
  result: null,
  error: null,
};

/**
 * A stable empty array so selectors on an unindexed document keep the same
 * reference between renders.
 */
const EMPTY_ANNOTATIONS: AnnotationIndexEntry[] = [];
Object.freeze(EMPTY_ANNOTATIONS);

/** Annotations of the finished index (empty while idle/indexing). */
export function selectIndexAnnotations(state: AnnotationIndexState): AnnotationIndexEntry[] {
  return state.result?.annotations ?? EMPTY_ANNOTATIONS;
}

/** Summary of the finished index, or null while it is still being built. */
export function selectIndexSummary(state: AnnotationIndexState): AnnotationIndexSummary | null {
  return state.result?.summary ?? null;
}

/** Coerce any reported pair into a monotonic, in-range progress value. */
function normalizeProgress(done: number, total: number): AnnotationIndexProgress {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeDone = Number.isFinite(done) ? Math.min(Math.max(0, Math.floor(done)), safeTotal) : 0;
  return { done: safeDone, total: safeTotal };
}

export const useAnnotationIndexStore = create<AnnotationIndexState>((set) => ({
  ...IDLE_STATE,
  ...DEFAULT_FILTERS,

  // A new run always starts from a clean request state, and switching documents
  // drops the previous document's query and result. Its kind/subtype filters are
  // view preferences and survive, like the current-page store's filters do.
  start: (documentKey, total) =>
    set((state) => ({
      documentKey,
      status: 'indexing',
      progress: normalizeProgress(0, total),
      result: null,
      error: null,
      query: state.documentKey === documentKey ? state.query : '',
    })),

  // Only a running index may report progress: a late report from a superseded
  // run must not overwrite the finished or failed state.
  setProgress: (done, total) =>
    set((state) =>
      state.status === 'indexing' ? { progress: normalizeProgress(done, total) } : {},
    ),

  // Stale completions are dropped instead of trusting the caller to cancel.
  finish: (documentKey, result) =>
    set((state) => {
      if (state.documentKey !== documentKey) return {};
      const total = state.progress?.total ?? result.scannedPages;
      return {
        status: 'ready',
        result,
        error: null,
        progress: normalizeProgress(result.scannedPages, total),
      };
    }),

  fail: (documentKey, error) =>
    set((state) => {
      if (state.documentKey !== documentKey) return {};
      return { status: 'error', error, result: null };
    }),

  // Closing a document clears the whole index, search and filters. Reopening
  // the same file must not resurrect a stale list or a previous search.
  reset: () => set({ ...IDLE_STATE, ...DEFAULT_FILTERS }),

  setQuery: (query) => set({ query }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
  // A blank subtype is the list's "all" option; normalize it once here.
  setSubtypeFilter: (subtypeFilter) =>
    set({ subtypeFilter: subtypeFilter === '' ? 'all' : subtypeFilter }),
}));
