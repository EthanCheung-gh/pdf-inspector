import { create } from 'zustand';

/**
 * Which pages the overview grid shows.
 *
 * - `all`: every page of the document (the plain thumbnail grid);
 * - `problems`: pages carrying an audit finding or an annotation issue;
 * - `annotated`: pages carrying at least one annotation.
 *
 * The filter is a view state only: it never starts an analysis, never touches
 * the document and is never persisted.
 */
export type PageOverviewFilter = 'all' | 'problems' | 'annotated';

/**
 * Visibility and filter of the page-overview dialog.
 *
 * This is pure UI state and deliberately separate from `pdf-store`: opening or
 * closing the overview never touches the document, the current page, the zoom
 * or the selection, so closing it leaves the viewer exactly where it was. It is
 * never persisted; a reload starts with the dialog closed, and the dialog
 * itself closes when the document changes (see `PageOverview`).
 *
 * The filter lives here, next to `open`, so an entry point other than the
 * toolbar (the command palette's "pages with problems") can open the overview
 * already filtered. Closing always resets it to `all`: a reopened overview never
 * hides pages because of a filter the user set for a previous look.
 */
export interface PageOverviewState {
  open: boolean;
  filter: PageOverviewFilter;
  /** Open the dialog, optionally on a specific filter (default: `all`). */
  openOverview: (filter?: PageOverviewFilter) => void;
  /** Close the dialog and forget the filter. */
  closeOverview: () => void;
  toggleOverview: () => void;
  setFilter: (filter: PageOverviewFilter) => void;
}

export const usePageOverviewStore = create<PageOverviewState>((set) => ({
  open: false,
  filter: 'all',
  openOverview: (filter = 'all') => set({ open: true, filter }),
  closeOverview: () => set({ open: false, filter: 'all' }),
  // Toggling closed is a close: it resets the filter like `closeOverview`, so
  // `P` never reopens on a filter chosen for a previous visit.
  toggleOverview: () =>
    set((state) => (state.open ? { open: false, filter: 'all' } : { open: true })),
  setFilter: (filter) => set({ filter }),
}));
