import { create } from 'zustand';
import { PdfObject, PdfMetadata, PageData, PdfOutlineItem, PageBox } from '../types/pdf-objects';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SearchMatch, SearchOptions } from '../services/pdf-search';
import { DEFAULT_SEARCH_OPTIONS } from '../services/pdf-search';
import type { FontStat } from '../types/ipc-protocol';
import type { FontBatchProgress } from '../services/font-stats';
import { ObjectSubset, FilterCriteria, filterByProperties } from '../services/object-filter';
import { MAX_FIT_WIDTH_ZOOM, MIN_FIT_WIDTH_ZOOM } from '../services/page-geometry';

/**
 * One cell of a table, identified by its place inside `PageData.tables`.
 *
 * `bbox` is the cell rectangle in the same bottom-left PDF coordinates as the
 * other objects, or `null` when the page data carries no `cellBoxes` for the
 * table (older sidecars) — the Inspector grid then works text-only and the
 * canvas has nothing to highlight.
 */
export interface TableCellRef {
  page: number;
  tableIndex: number;
  row: number;
  col: number;
  bbox: PageBox | null;
}

export interface PdfState {
  // File state
  filePath: string | null;
  /** URL the document was opened from, or null for local files. */
  sourceUrl: string | null;
  /**
   * Display file name supplied by the opening bridge (upload name on the web,
   * basename on the desktop), or null when it is unknown. `filePath` may be an
   * encoded `/doc/<id>/...` URL or a temp copy, so this is the name exports and
   * labels prefer.
   */
  documentName: string | null;
  metadata: PdfMetadata | null;
  pageCount: number;
  currentPage: number;
  zoom: number;
  /**
   * Identity of the document that owns the current page state.
   *
   * Incremented by `setFile` and `resetDocument` (never by a page change), so a
   * page request can remember which document issued it. A response whose epoch
   * no longer matches belongs to a document the user already left and must be
   * dropped instead of being published (or reported as an error) for the new one.
   */
  documentEpoch: number;

  // Data
  pageData: PageData | null;

  // Selection
  allObjects: PdfObject[];
  hoveredObject: PdfObject | null;
  selectedObject: PdfObject | null;

  // Table cell selection (only meaningful while a table is the current object)
  hoveredTableCell: TableCellRef | null;
  selectedTableCell: TableCellRef | null;

  // UI state
  overlayVisibility: Record<string, boolean>;
  isLoading: boolean;
  sidecarRunning: boolean;
  error: string | null;

  // PDF.js document reference (shared for outline destination resolution)
  pdfDocRef: PDFDocumentProxy | null;

  // Outline / bookmarks
  outline: PdfOutlineItem[] | null;

  // Fit-width zoom
  fitWidthZoom: number | null;
  initialFitWidthZoom: boolean;
  /**
   * One-shot request to leave the next fit-to-width pass alone.
   *
   * `PdfViewport` fits a freshly loaded document once, which would overwrite a
   * zoom that came from a tab/session snapshot (a user at 157% would snap back
   * to the fit ratio on every reload). `restoreViewSnapshot` sets this right
   * after applying the snapshot zoom; the fit pass then only publishes the
   * Fit W hint and consumes the flag. It is reset by `setFile`/`resetDocument`,
   * so a normal first open still fits.
   */
  skipInitialFit: boolean;

  // Text selection mode
  textSelectionMode: boolean;

  // Text search
  searchQuery: string;
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  searchOpen: boolean;
  /**
   * Progress of the batched PDF.js text index build, or null when no build is
   * running. Large documents index ten pages per batch, so the toolbar can show
   * `Indexing 40/120…` instead of a silent wait.
   */
  searchIndexProgress: { done: number; total: number } | null;
  /**
   * How the query is interpreted (case/whole word/regex). This is a user
   * preference, so it survives document changes and `clearSearch`.
   */
  searchOptions: SearchOptions;
  /** Whether the match dropdown is showing. */
  searchResultsOpen: boolean;
  /** True when the hit list stopped at the 5,000 match cap. */
  searchTruncated: boolean;
  /** Why the last search could not run (bad regex, oversized pattern), or null. */
  searchError: string | null;

  // Export progress
  exportProgress: { done: number; total: number } | null;

  // Object subset (region selection / property filter)
  regionMode: boolean;
  filterCriteria: FilterCriteria;
  subset: ObjectSubset | null;

  // Actions
  setFile: (
    path: string,
    meta: PdfMetadata,
    sourceUrl?: string | null,
    documentName?: string | null,
  ) => void;
  setPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setPageData: (data: PageData) => void;
  setHoveredObject: (obj: PdfObject | null) => void;
  setSelectedObject: (obj: PdfObject | null) => void;
  setHoveredTableCell: (cell: TableCellRef | null) => void;
  setSelectedTableCell: (cell: TableCellRef | null) => void;
  toggleOverlay: (type: string) => void;
  /** Replace/merge several overlay toggles at once (Layers All/None/Solo). */
  setOverlayVisibility: (visibility: Record<string, boolean>) => void;
  setLoading: (loading: boolean) => void;
  setSidecarRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  clearSelection: () => void;
  setPdfDocRef: (doc: PDFDocumentProxy | null) => void;
  setOutline: (outline: PdfOutlineItem[] | null) => void;
  /**
   * Set both the Fit W zoom and the current zoom (the Fit W button's action).
   * `null` only clears the hint and leaves the current zoom alone.
   */
  setFitWidthZoom: (zoom: number | null) => void;
  /**
   * Publish the Fit W zoom *without* changing the current zoom.
   *
   * Used by the initial fit pass when a restored snapshot must keep its zoom:
   * the button still knows what fit would be, but the document stays as saved.
   */
  setFitWidthHint: (zoom: number) => void;
  /** Ask the next fit-to-width pass to keep the current zoom (one shot). */
  skipNextInitialFit: () => void;
  /** Read and clear the one-shot skip (the fit pass owns the consumption). */
  consumeInitialFitSkip: () => boolean;
  setTextSelectionMode: (mode: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchMatches: (matches: SearchMatch[]) => void;
  setCurrentMatchIndex: (index: number) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchIndexProgress: (progress: { done: number; total: number } | null) => void;
  /** Merge option toggles (Aa / W / .*) into the current search preferences. */
  setSearchOptions: (options: Partial<SearchOptions>) => void;
  setSearchResultsOpen: (open: boolean) => void;
  setSearchResultMeta: (truncated: boolean, error: string | null) => void;
  clearSearch: () => void;
  setExportProgress: (progress: { done: number; total: number } | null) => void;
  fontStats: FontStat[] | null;
  setFontStats: (stats: FontStat[] | null) => void;
  /** Progress of the batched font analysis, or null when no run is active. */
  fontProgress: FontBatchProgress | null;
  setFontProgress: (progress: FontBatchProgress | null) => void;
  setRegionMode: (on: boolean) => void;
  setFilterCriteria: (criteria: FilterCriteria) => void;
  setSubset: (subset: ObjectSubset | null) => void;
  clearSubset: () => void;
  /**
   * Return to the empty state: no document, page 1, zoom 100%, no page data,
   * selection, search, outline, font/audit/export results or subset.
   *
   * Used when the last document tab is closed; a remaining tab is restored from
   * its own snapshot instead, so this is the "nothing is open" case only.
   */
  resetDocument: () => void;
}

export const usePdfStore = create<PdfState>((set, get) => ({
  filePath: null,
  sourceUrl: null,
  documentName: null,
  metadata: null,
  pageCount: 0,
  currentPage: 1,
  zoom: 1.0,
  documentEpoch: 0,

  pageData: null,

  allObjects: [],
  hoveredObject: null,
  selectedObject: null,
  hoveredTableCell: null,
  selectedTableCell: null,

  overlayVisibility: {
    char: true,
    word: true,
    rect: true,
    line: true,
    curve: true,
    image: true,
    table: true,
  },
  isLoading: false,
  sidecarRunning: false,
  error: null,
  pdfDocRef: null,
  outline: null,
  fitWidthZoom: null,
  initialFitWidthZoom: false,
  skipInitialFit: false,
  textSelectionMode: false,
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  searchOpen: false,
  searchIndexProgress: null,
  searchOptions: { ...DEFAULT_SEARCH_OPTIONS },
  searchResultsOpen: false,
  searchTruncated: false,
  searchError: null,
  exportProgress: null,
  fontStats: null,
  fontProgress: null,
  regionMode: false,
  filterCriteria: {},
  subset: null,

  setFile: (path, meta, sourceUrl = null, documentName = null) =>
    set((state) => ({
      filePath: path,
      // Reset with the rest of the document state: opening a local file after a
      // URL drops the URL, opening a URL keeps it for the filename label.
      sourceUrl: sourceUrl ?? null,
      // The bridge's display name belongs to this document only.
      documentName: documentName ?? null,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      // New document: every page request issued for the previous one is stale
      // from here on, even when it is still in flight.
      documentEpoch: state.documentEpoch + 1,
      // Nothing is loading for the new document yet, and the stale request that
      // the epoch bump just invalidated is no longer allowed to clear this flag.
      isLoading: false,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
      // A new document fits normally unless its snapshot asks otherwise later.
      skipInitialFit: false,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: false,
      searchIndexProgress: null,
      // Search results belong to the old document; the option toggles do not.
      searchResultsOpen: false,
      searchTruncated: false,
      searchError: null,
      exportProgress: null,
      fontStats: null,
      fontProgress: null,
      subset: null,
    })),

  // Objects are page-scoped: dropping them with the page data prevents the
  // previous page's boxes from being drawn/hit-tested while the new page is
  // still being extracted.
  setPage: (page) =>
    set({
      currentPage: page,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
      subset: null,
    }),

  // Zoom is clamped to the same range the fit-width geometry uses.
  setZoom: (zoom) => set({ zoom: Math.max(MIN_FIT_WIDTH_ZOOM, Math.min(MAX_FIT_WIDTH_ZOOM, zoom)) }),

  setPageData: (data) =>
    set({
      pageData: data,
      allObjects: [
        ...data.chars,
        ...data.words,
        ...data.rects,
        ...data.lines,
        ...data.curves,
        ...data.images,
        ...data.tables,
      ],
      error: null,
    }),

  setHoveredObject: (obj) => set({ hoveredObject: obj }),
  // Cell state only makes sense while a table stays selected: any other
  // selection (including none) drops it so a stale cell can never be
  // highlighted for a non-table object.
  setSelectedObject: (obj) =>
    set(
      obj && obj.type === 'table'
        ? { selectedObject: obj }
        : { selectedObject: obj, hoveredTableCell: null, selectedTableCell: null },
    ),
  setHoveredTableCell: (cell) => set({ hoveredTableCell: cell }),
  setSelectedTableCell: (cell) => set({ selectedTableCell: cell }),
  toggleOverlay: (type) =>
    set((state) => ({
      overlayVisibility: {
        ...state.overlayVisibility,
        [type]: !state.overlayVisibility[type],
      },
    })),
  setOverlayVisibility: (visibility) =>
    set((state) => ({
      overlayVisibility: {
        ...state.overlayVisibility,
        ...visibility,
      },
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setSidecarRunning: (running) => set({ sidecarRunning: running }),
  setError: (error) => set({ error }),
  clearSelection: () =>
    set({
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
    }),
  setPdfDocRef: (doc) => set({ pdfDocRef: doc }),
  setOutline: (outline) => set({ outline }),
  setFitWidthZoom: (zoom) => {
    if (zoom === null) {
      set({ fitWidthZoom: null });
      return;
    }

    const clamped = Math.max(MIN_FIT_WIDTH_ZOOM, Math.min(MAX_FIT_WIDTH_ZOOM, zoom));
    set({ fitWidthZoom: clamped, zoom: clamped });
  },
  // Hint only: the Fit W button keeps a target to return to while the current
  // zoom stays whatever the restored snapshot asked for.
  setFitWidthHint: (zoom) => {
    const clamped = Math.max(MIN_FIT_WIDTH_ZOOM, Math.min(MAX_FIT_WIDTH_ZOOM, zoom));
    set({ fitWidthZoom: clamped });
  },
  skipNextInitialFit: () => set({ skipInitialFit: true }),
  consumeInitialFitSkip: () => {
    const skip = get().skipInitialFit;
    // One shot: only clear when it was actually set, so a plain fit pass does
    // not write to the store on every document.
    if (skip) set({ skipInitialFit: false });
    return skip;
  },
  setTextSelectionMode: (mode) => set({ textSelectionMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMatches: (matches) => set({ searchMatches: matches }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setSearchIndexProgress: (progress) => set({ searchIndexProgress: progress }),
  setSearchOptions: (options) =>
    set((state) => ({ searchOptions: { ...state.searchOptions, ...options } })),
  setSearchResultsOpen: (open) => set({ searchResultsOpen: open }),
  setSearchResultMeta: (truncated, error) =>
    set({ searchTruncated: truncated, searchError: error }),
  // Closing search also drops the progress row: the hook cancels the build, so
  // a stale `Indexing…` label can never outlive the search box. Options are a
  // user preference and deliberately survive.
  clearSearch: () =>
    set({
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: false,
      searchIndexProgress: null,
      searchResultsOpen: false,
      searchTruncated: false,
      searchError: null,
    }),
  setExportProgress: (progress) => set({ exportProgress: progress }),
  setFontStats: (stats) => set({ fontStats: stats }),
  setFontProgress: (progress) => set({ fontProgress: progress }),

  setRegionMode: (on) =>
    set((state) => ({
      regionMode: on,
      ...(on ? {} : { subset: null }),
    })),

  setFilterCriteria: (criteria) =>
    set((state) => {
      const hasCriteria =
        Boolean(criteria.types?.length) ||
        Boolean(criteria.fontname) ||
        criteria.sizeMin !== undefined ||
        criteria.sizeMax !== undefined ||
        Boolean(criteria.color);
      const subset = hasCriteria
        ? { source: 'filter' as const, mode: 'intersect' as const, objects: filterByProperties(state.allObjects, criteria) }
        : null;
      return { filterCriteria: criteria, subset };
    }),

  setSubset: (subset) => set({ subset }),
  clearSubset: () => set({ subset: null }),

  // Document-scoped state only: overlay/text/region preferences are app-level
  // view settings that outlive a document, so closing the last document leaves
  // them as the user set them.
  resetDocument: () =>
    set((state) => ({
      filePath: null,
      sourceUrl: null,
      documentName: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      zoom: 1.0,
      // Nothing is open: an in-flight page request for the document that just
      // closed must not be published into the empty state either.
      documentEpoch: state.documentEpoch + 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
      isLoading: false,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
      // Nothing is open, so no pending snapshot may suppress the next fit.
      skipInitialFit: false,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: false,
      searchIndexProgress: null,
      searchResultsOpen: false,
      searchTruncated: false,
      searchError: null,
      exportProgress: null,
      fontStats: null,
      fontProgress: null,
      filterCriteria: {},
      subset: null,
    })),
}));
