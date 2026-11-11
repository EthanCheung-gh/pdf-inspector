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
  DiffIgnoreRegion,
  DiffObjectType,
  DiffOptions,
  DiffPage,
  DiffResult,
  DiffSide,
  DiffSource,
  PickDiffPdfResult,
} from '../../shared/diff-types';
import { normalizeIgnoreRegion } from '../../shared/diff-types';
import {
  clampDiffZoom,
  firstInterestingPageIndex,
  type DiffChangeRef,
  type DiffFilter,
  DEFAULT_DIFF_FILTER,
} from '../services/diff-view';
import {
  clampVisualOpacity,
  DEFAULT_VISUAL_OPACITY,
  type VisualDiffStyle,
} from '../services/visual-diff';

/**
 * Engine defaults, mirrored so the dialog can show concrete values.
 *
 * One deliberate difference from `sidecar.diff.DiffOptions`: the UI ignores
 * `char` objects by default. Word-level changes already report text edits, and
 * a character-level diff of a large text PDF produces millions of one-glyph
 * changes (minutes of CPU, a change list nothing can display), so it is opt-in
 * through the dialog instead of the default.
 */
export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  positionTolerance: 1,
  textTolerance: 'normalized',
  ignoreTypes: ['char'],
  ignoreFonts: false,
  ignoreColors: false,
  ignoreImages: false,
  ignoreRegions: [],
};

/** A copy of the defaults with its own arrays (see `reset`). */
const freshOptions = (): DiffOptions => ({
  ...DEFAULT_DIFF_OPTIONS,
  ignoreTypes: [...DEFAULT_DIFF_OPTIONS.ignoreTypes],
  ignoreRegions: [],
});

export type DiffViewMode = 'side-by-side' | 'overlay' | 'visual';

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
  /** Alpha of the old page in `visual` mode, 0..1. */
  visualOpacity: number;
  /** How `visual` mode composes the two pages. */
  visualStyle: VisualDiffStyle;
  /**
   * True while the panes accept a drag that draws an ignore region. Purely a
   * UI mode: it is never persisted and never travels over the RPC.
   */
  regionMode: boolean;

  openSetup: () => void;
  closeSetup: () => void;

  /** Store one picked side; a cancelled pick leaves the current source alone. */
  acceptPickedSource: (side: DiffSide, picked: PickDiffPdfResult) => void;
  setSource: (side: DiffSide, source: DiffSource | null, name: string | null) => void;
  setOptions: (patch: Partial<DiffOptions>) => void;
  setPositionTolerance: (value: number) => void;
  /**
   * Turn character-level changes on or off. Off (the default) ignores `char`
   * objects; on removes that one entry and leaves every other ignored type
   * alone. Word-level changes are reported either way.
   */
  setCharacterLevelChanges: (enabled: boolean) => void;

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
  setVisualOpacity: (opacity: number) => void;
  setVisualStyle: (style: VisualDiffStyle) => void;

  /** Toggle the draw-a-region mode; leaving it keeps the drawn regions. */
  setRegionMode: (enabled: boolean) => void;
  /** Add one drawn region; an unusable rectangle is ignored, not stored. */
  addIgnoreRegion: (region: DiffIgnoreRegion) => void;
  removeIgnoreRegion: (index: number) => void;
  clearIgnoreRegions: () => void;

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
  options: freshOptions(),
  result: null,
  loading: false,
  error: null,
  pageIndex: 0,
  selection: null,
  viewMode: 'side-by-side' as DiffViewMode,
  zoom: 1,
  filter: { ...DEFAULT_DIFF_FILTER },
  visualOpacity: DEFAULT_VISUAL_OPACITY,
  visualStyle: 'blend' as VisualDiffStyle,
  regionMode: false,
};

const clampTolerance = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_DIFF_OPTIONS.positionTolerance;
  return Math.min(100, Math.max(0, value));
};

/** True when `char` objects are ignored, i.e. character-level diffs are off. */
const hasCharIgnore = (ignoreTypes: readonly DiffObjectType[]): boolean =>
  ignoreTypes.includes('char');

export const useDiffStore = create<DiffState>((set, get) => ({
  ...initialDiffState,

  openSetup: () => set({ setupOpen: true, error: null }),
  closeSetup: () => set({ setupOpen: false }),

  acceptPickedSource: (side, picked) => {
    if (picked.canceled) return;
    get().setSource(side, picked.source, picked.name);
  },

  // A new file means a new comparison: regions drawn for the previous document
  // pair would silently mask unrelated changes in the new one, so they go away
  // with the source that owned them.
  setSource: (side, source, name) =>
    set((state) => ({
      ...(side === 'old'
        ? { oldSource: source, oldName: source ? name : null }
        : { newSource: source, newName: source ? name : null }),
      options: { ...state.options, ignoreRegions: [] },
    })),

  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),

  setPositionTolerance: (value) =>
    set((state) => ({
      options: { ...state.options, positionTolerance: clampTolerance(value) },
    })),

  // Only `char` is added or removed: a user may also have ignored images or
  // tables in the same session, and toggling characters must not re-enable them.
  setCharacterLevelChanges: (enabled) =>
    set((state) => ({
      options: {
        ...state.options,
        ignoreTypes: enabled
          ? state.options.ignoreTypes.filter((type) => type !== 'char')
          : hasCharIgnore(state.options.ignoreTypes)
            ? state.options.ignoreTypes
            : [...state.options.ignoreTypes, 'char'],
      },
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
  setVisualOpacity: (opacity) => set({ visualOpacity: clampVisualOpacity(opacity) }),
  setVisualStyle: (style) => set({ visualStyle: style }),

  setRegionMode: (enabled) => set({ regionMode: enabled }),

  // Drawn regions live in `options`, because that is exactly what the engine
  // consumes: adding one changes the next diff request, nothing else.
  addIgnoreRegion: (region) => {
    const normalized = normalizeIgnoreRegion(region);
    if (!normalized) return;
    set((state) => ({
      options: {
        ...state.options,
        ignoreRegions: [...state.options.ignoreRegions, normalized],
      },
    }));
  },

  removeIgnoreRegion: (index) =>
    set((state) => ({
      options: {
        ...state.options,
        ignoreRegions: state.options.ignoreRegions.filter(
          (_, regionIndex) => regionIndex !== index,
        ),
      },
    })),

  clearIgnoreRegions: () =>
    set((state) => ({ options: { ...state.options, ignoreRegions: [] } })),

  // Entering keeps the result so the same comparison can be reopened without
  // re-running it; leaving only flips the mode, never the Inspect document.
  enterWorkspace: () => set({ active: true, setupOpen: false }),
  exitWorkspace: () => set({ active: false }),

  reset: () => set({ ...initialDiffState, options: freshOptions() }),
}));

/** The page currently shown by both panes, or null before a diff exists. */
export const selectDiffPage = (state: DiffState): DiffPage | null =>
  state.result?.pages[state.pageIndex] ?? null;

/**
 * True when character-level changes are compared.
 *
 * Off by default (see `DEFAULT_DIFF_OPTIONS`): the dialog's checkbox and this
 * selector must always agree, so both read the store's `ignoreTypes`.
 */
export const selectCharacterLevelChanges = (state: DiffState): boolean =>
  !hasCharIgnore(state.options.ignoreTypes);

/** The selected change resolved against the current result. */
export const selectDiffSelection = (
  state: DiffState,
): { pageIndex: number; changeIndex: number; change: DiffChange } | null => {
  const selection = state.selection;
  if (!selection || !state.result) return null;
  const change = state.result.pages[selection.pageIndex]?.changes[selection.changeIndex];
  return change ? { ...selection, change } : null;
};
