import { create } from 'zustand';
import type { AnnotationKind, PdfAnnotation } from '../types/annotations';

/** Kind filter value: every kind, or one specific kind. */
export type AnnotationKindFilter = 'all' | AnnotationKind;

/**
 * Current-page annotation state.
 *
 * Annotations are a read-only inspection layer: they are deliberately kept out
 * of `PdfObjectType`, the object layers and the export path, so they get their
 * own small store. The list is page-scoped — `page` is the page the loaded
 * annotations belong to, which lets the overlay and the hit-test ignore data
 * while the next page is still loading.
 */
export interface AnnotationState {
  page: number | null;
  annotations: PdfAnnotation[];
  loading: boolean;
  error: string | null;
  selected: PdfAnnotation | null;
  hovered: PdfAnnotation | null;
  kindFilter: AnnotationKindFilter;
  subtypeFilter: 'all' | string;
  showBoxes: boolean;
  /**
   * Monotonic reload counter. `usePageAnnotations` includes it in its effect
   * dependencies, so `requestReload()` is enough for the Annots tab's Retry
   * button to re-run the loader without owning a document reference.
   */
  reloadKey: number;
  setPageData(page: number, annotations: PdfAnnotation[]): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setSelected(annotation: PdfAnnotation | null): void;
  setHovered(annotation: PdfAnnotation | null): void;
  setKindFilter(filter: AnnotationKindFilter): void;
  setSubtypeFilter(filter: 'all' | string): void;
  setShowBoxes(show: boolean): void;
  requestReload(): void;
  clear(): void;
}

/** Filters and the box toggle survive `clear()`; page data does not. */
const DEFAULT_FILTERS: Pick<AnnotationState, 'kindFilter' | 'subtypeFilter' | 'showBoxes'> = {
  kindFilter: 'all',
  subtypeFilter: 'all',
  // The boxes are the visible half of the feature, so they start enabled.
  showBoxes: true,
};

/**
 * A same-page reload keeps the selection only while the annotation still
 * exists, and then points it at the freshly loaded copy.
 */
function reselect(
  current: PdfAnnotation | null,
  annotations: readonly PdfAnnotation[],
): PdfAnnotation | null {
  if (current === null) return null;
  return annotations.find((annotation) => annotation.id === current.id) ?? null;
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
  page: null,
  annotations: [],
  loading: false,
  error: null,
  selected: null,
  hovered: null,
  reloadKey: 0,
  ...DEFAULT_FILTERS,

  // Loading a page replaces its annotations and ends the request: `loading` and
  // `error` belong to the request, not to the data. A different page can never
  // inherit the previous page's selection or hover.
  setPageData: (page, annotations) =>
    set((state) => {
      const samePage = state.page === page;
      return {
        page,
        annotations,
        loading: false,
        error: null,
        selected: samePage ? reselect(state.selected, annotations) : null,
        hovered: samePage ? reselect(state.hovered, annotations) : null,
      };
    }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSelected: (selected) => set({ selected }),
  setHovered: (hovered) => set({ hovered }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
  // A blank subtype is the list's "all" option; the store normalizes it so
  // callers never have to distinguish `''` from `'all'`.
  setSubtypeFilter: (subtypeFilter) =>
    set({ subtypeFilter: subtypeFilter === '' ? 'all' : subtypeFilter }),
  setShowBoxes: (showBoxes) => set({ showBoxes }),

  // Request state, not page data: `clear()` keeps the counter so a reload
  // requested while the document is closing cannot resurrect old annotations.
  requestReload: () => set((state) => ({ reloadKey: state.reloadKey + 1 })),

  // Dropping the page data must not reset the user's filters or the box toggle:
  // open a new file while `Show boxes` is off and it stays off.
  clear: () =>
    set({
      page: null,
      annotations: [],
      loading: false,
      error: null,
      selected: null,
      hovered: null,
    }),
}));
