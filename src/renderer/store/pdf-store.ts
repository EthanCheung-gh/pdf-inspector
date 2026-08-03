import { create } from 'zustand';
import { PdfObject, PdfMetadata, PageData, PdfOutlineItem } from '../types/pdf-objects';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SearchMatch } from '../services/pdf-search';
import { ObjectSubset, FilterCriteria, filterByProperties } from '../services/object-filter';

export interface PdfState {
  // File state
  filePath: string | null;
  metadata: PdfMetadata | null;
  pageCount: number;
  currentPage: number;
  zoom: number;

  // Data
  pageData: PageData | null;

  // Selection
  allObjects: PdfObject[];
  hoveredObject: PdfObject | null;
  selectedObject: PdfObject | null;

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

  // Text selection mode
  textSelectionMode: boolean;

  // Text search
  searchQuery: string;
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  searchOpen: boolean;

  // Export progress
  exportProgress: { done: number; total: number } | null;

  // Object subset (region selection / property filter)
  regionMode: boolean;
  filterCriteria: FilterCriteria;
  subset: ObjectSubset | null;

  // Actions
  setFile: (path: string, meta: PdfMetadata) => void;
  setPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setPageData: (data: PageData) => void;
  setHoveredObject: (obj: PdfObject | null) => void;
  setSelectedObject: (obj: PdfObject | null) => void;
  toggleOverlay: (type: string) => void;
  setLoading: (loading: boolean) => void;
  setSidecarRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  clearSelection: () => void;
  setPdfDocRef: (doc: PDFDocumentProxy | null) => void;
  setOutline: (outline: PdfOutlineItem[] | null) => void;
  setFitWidthZoom: (zoom: number | null) => void;
  setTextSelectionMode: (mode: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchMatches: (matches: SearchMatch[]) => void;
  setCurrentMatchIndex: (index: number) => void;
  setSearchOpen: (open: boolean) => void;
  clearSearch: () => void;
  setExportProgress: (progress: { done: number; total: number } | null) => void;
  setRegionMode: (on: boolean) => void;
  setFilterCriteria: (criteria: FilterCriteria) => void;
  setSubset: (subset: ObjectSubset | null) => void;
  clearSubset: () => void;
}

export const usePdfStore = create<PdfState>((set, get) => ({
  filePath: null,
  metadata: null,
  pageCount: 0,
  currentPage: 1,
  zoom: 1.0,

  pageData: null,

  allObjects: [],
  hoveredObject: null,
  selectedObject: null,

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
  textSelectionMode: false,
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  searchOpen: false,
  exportProgress: null,
  regionMode: false,
  filterCriteria: {},
  subset: null,

  setFile: (path, meta) =>
    set({
      filePath: path,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: false,
      exportProgress: null,
      subset: null,
    }),

  setPage: (page) =>
    set({ currentPage: page, pageData: null, hoveredObject: null, selectedObject: null, subset: null }),

  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(5, zoom)) }),

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
  setSelectedObject: (obj) => set({ selectedObject: obj }),
  toggleOverlay: (type) =>
    set((state) => ({
      overlayVisibility: {
        ...state.overlayVisibility,
        [type]: !state.overlayVisibility[type],
      },
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setSidecarRunning: (running) => set({ sidecarRunning: running }),
  setError: (error) => set({ error }),
  clearSelection: () => set({ hoveredObject: null, selectedObject: null }),
  setPdfDocRef: (doc) => set({ pdfDocRef: doc }),
  setOutline: (outline) => set({ outline }),
  setFitWidthZoom: (zoom) => {
    if (zoom === null) {
      set({ fitWidthZoom: null });
      return;
    }

    const clamped = Math.max(0.25, Math.min(5, zoom));
    set({ fitWidthZoom: clamped, zoom: clamped });
  },
  setTextSelectionMode: (mode) => set({ textSelectionMode: mode }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMatches: (matches) => set({ searchMatches: matches }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  clearSearch: () =>
    set({ searchQuery: '', searchMatches: [], currentMatchIndex: -1, searchOpen: false }),
  setExportProgress: (progress) => set({ exportProgress: progress }),

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
}));
