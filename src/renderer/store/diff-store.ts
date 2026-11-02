/**
 * State of the Diff workspace.
 *
 * Deliberately separate from `pdf-store` and never persisted:
 * - The Inspect document (file, page, zoom, selection) must survive entering
 *   and leaving Diff untouched, so nothing here writes to that store.
 * - Sources may be `File` objects in the browser, which cannot be serialized
 *   to localStorage. A diff is a transient comparison, not a saved workspace.
 */
import { create } from 'zustand';
import type {
  DiffChange,
  DiffOptions,
  DiffPage,
  DiffResult,
  DiffSide,
  DiffSource,
  PickDiffPdfResult,
} from '../../shared/diff-types';
import {
  clampDiffZoom,
  firstInterestingPageIndex,
  type DiffChangeRef,
  type DiffFilter,
  DEFAULT_DIFF_FILTER,
} from '../services/diff-view';

/** Engine defaults, mirrored so the dialog can show concrete values. */
export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  positionTolerance: 1,
  textTolerance: 'normalized',
  ignoreTypes: [],
  ignoreFonts: false,
  ignoreColors: false,
  ignoreImages: false,
};

export type DiffViewMode = 'side-by-side' | 'overlay';

export interface DiffState {
  /** True while the Diff workspace replaces the Inspect panes. */
  active: boolean;
  /** True while `DiffSetupDialog` is open (it is mounted once, at app level). */
  setupOpen: boolean;

  oldSource: DiffSource | null;
  newSource: DiffSource | null;
  oldName: string | null;
  newName: string | null;

  options: DiffOptions;
  result: DiffResult | null;
  loading: boolean;
  error: string | null;

  /** Index into `result.pages`; never a PDF page number. */
  pageIndex: number;
  selection: DiffChangeRef | null;

  viewMode: DiffViewMode;
  zoom: number;
  filter: DiffFilter;

  openSetup: () => void;
  closeSetup: () => void;

  /** Store one picked side; a cancelled pick leaves the current source alone. */
  acceptPickedSource: (side: DiffSide, picked: PickDiffPdfResult) => void;
  setSource: (side: DiffSide, source: DiffSource | null, name: string | null) => void;
  setOptions: (patch: Partial<DiffOptions>) => void;
  setPositionTolerance: (value: number) => void;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  applyResult: (result: DiffResult) => AppliedDiffResult;
  clearResult: () => void;

  setPageIndex: (index: number) => void;
  stepPage: (delta: number) => void;
  selectChange: (selection: DiffChangeRef | null) => void;
  selectChangeAt: (pageIndex: number, changeIndex: number) => void;

  setViewMode: (mode: DiffViewMode) => void;
  setZoom: (zoom: number) => void;
  setFilter: (patch: Partial<DiffFilter>) => void;
  resetFilter: () => void;

  enterWorkspace: () => void;
  exitWorkspace: () => void;
  reset: () => void;
}

/** Result of applying a diff; lets the caller report counts without re-reading. */
export interface AppliedDiffResult {
  pageIndex: number;
  pages: number;
  changes: number;
}

const initialDiffState = {
  active: false,
  setupOpen: false,
  oldSource: null,
  newSource: null,
  oldName: null,
  newName: null,
  options: { ...DEFAULT_DIFF_OPTIONS, ignoreTypes: [] },
  result: null,
  loading: false,
  error: null,
  pageIndex: 0,
  selection: null,
  viewMode: 'side-by-side' as DiffViewMode,
  zoom: 1,
  filter: { ...DEFAULT_DIFF_FILTER },
};

const clampTolerance = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_DIFF_OPTIONS.positionTolerance;
  return Math.min(100, Math.max(0, value));
};

export const useDiffStore = create<DiffState>((set, get) => ({
  ...initialDiffState,

  openSetup: () => set({ setupOpen: true, error: null }),
  closeSetup: () => set({ setupOpen: false }),

  acceptPickedSource: (side, picked) => {
    if (picked.canceled) return;
    get().setSource(side, picked.source, picked.name);
  },

  setSource: (side, source, name) =>
    set(
      side === 'old'
        ? { oldSource: source, oldName: source ? name : null }
        : { newSource: source, newName: source ? name : null },
    ),

  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),

  setPositionTolerance: (value) =>
    set((state) => ({
      options: { ...state.options, positionTolerance: clampTolerance(value) },
    })),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  // A new result always starts at the first page that actually changed and with
  // no selection: a stale selection pointing at the old result's indexes would
  // highlight an unrelated object.
  applyResult: (result) => {
    const pageIndex = firstInterestingPageIndex(result.pages);
    const changes = result.pages.reduce((total, page) => total + page.changes.length, 0);
    set({
      result,
      pageIndex,
      selection: null,
      loading: false,
      error: null,
      filter: { ...DEFAULT_DIFF_FILTER },
    });
    return { pageIndex, pages: result.pages.length, changes };
  },

  clearResult: () =>
    set({ result: null, loading: false, error: null, pageIndex: 0, selection: null }),

  setPageIndex: (index) => {
    const state = get();
    const pages = state.result?.pages.length ?? 0;
    if (pages === 0) {
      set({ pageIndex: 0, selection: null });
      return;
    }
    const clamped = Math.min(pages - 1, Math.max(0, Math.trunc(index)));
    set({
      pageIndex: clamped,
      // A selection only makes sense on its own page.
      selection: state.selection && state.selection.pageIndex === clamped ? state.selection : null,
    });
  },

  stepPage: (delta) => get().setPageIndex(get().pageIndex + delta),

  selectChange: (selection) =>
    set(selection ? { selection, pageIndex: selection.pageIndex } : { selection: null }),

  selectChangeAt: (pageIndex, changeIndex) =>
    get().selectChange({ pageIndex, changeIndex }),

  setViewMode: (mode) => set({ viewMode: mode }),
  setZoom: (zoom) => set({ zoom: clampDiffZoom(zoom) }),
  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
  resetFilter: () => set({ filter: { ...DEFAULT_DIFF_FILTER } }),

  // Entering keeps the result so the same comparison can be reopened without
  // re-running it; leaving only flips the mode, never the Inspect document.
  enterWorkspace: () => set({ active: true, setupOpen: false }),
  exitWorkspace: () => set({ active: false }),

  reset: () => set({ ...initialDiffState, options: { ...DEFAULT_DIFF_OPTIONS, ignoreTypes: [] } }),
}));

/** The page currently shown by both panes, or null before a diff exists. */
export const selectDiffPage = (state: DiffState): DiffPage | null =>
  state.result?.pages[state.pageIndex] ?? null;

/** The selected change resolved against the current result. */
export const selectDiffSelection = (
  state: DiffState,
): { pageIndex: number; changeIndex: number; change: DiffChange } | null => {
  const selection = state.selection;
  if (!selection || !state.result) return null;
  const change = state.result.pages[selection.pageIndex]?.changes[selection.changeIndex];
  return change ? { ...selection, change } : null;
};
