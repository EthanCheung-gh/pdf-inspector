import { create } from 'zustand';
import { PdfObject, PdfMetadata, PageData } from '../types/pdf-objects';

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
    }),

  setPage: (page) => set({ currentPage: page, pageData: null, hoveredObject: null, selectedObject: null }),

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
}));
