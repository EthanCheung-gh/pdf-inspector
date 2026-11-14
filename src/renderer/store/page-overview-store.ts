import { create } from 'zustand';

/**
 * Visibility of the page-overview dialog.
 *
 * This is pure UI state and deliberately separate from `pdf-store`: opening or
 * closing the overview never touches the document, the current page, the zoom
 * or the selection, so closing it leaves the viewer exactly where it was. It is
 * never persisted; a reload starts with the dialog closed, and the dialog
 * itself closes when the document changes (see `PageOverview`).
 */
export interface PageOverviewState {
  open: boolean;
  openOverview: () => void;
  closeOverview: () => void;
  toggleOverview: () => void;
}

export const usePageOverviewStore = create<PageOverviewState>((set) => ({
  open: false,
  openOverview: () => set({ open: true }),
  closeOverview: () => set({ open: false }),
  toggleOverview: () => set((state) => ({ open: !state.open })),
}));
