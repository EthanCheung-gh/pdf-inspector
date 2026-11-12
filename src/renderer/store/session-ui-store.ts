import { create } from 'zustand';

/**
 * Runtime UI state for the recent-documents surfaces (work package Q3).
 *
 * Kept out of `session-store` because nothing here is persisted, and out of the
 * components because the dialog has more than one entry point: the empty state
 * (rendered inside `PdfViewport`) and the `File: Recent documents…` palette
 * command (registered in `App`) both need to open the same, single dialog. A
 * shared flag lets `App` mount the dialog once instead of threading props from
 * every caller up to the shell.
 *
 * Like `session-restore-store`, this is deliberately tiny and synchronous.
 */
export interface SessionUiState {
  /** Whether the recent-documents dialog is open. */
  recentDialogOpen: boolean;
  openRecentDialog: () => void;
  closeRecentDialog: () => void;
  /** Explicit setter for callers that already know the target state. */
  setRecentDialogOpen: (open: boolean) => void;
  /** Back to the defaults (tests, or a full app reset). */
  reset: () => void;
}

export const useSessionUiStore = create<SessionUiState>((set) => ({
  recentDialogOpen: false,

  openRecentDialog: () => set({ recentDialogOpen: true }),
  closeRecentDialog: () => set({ recentDialogOpen: false }),
  setRecentDialogOpen: (open) => set({ recentDialogOpen: open }),
  reset: () => set({ recentDialogOpen: false }),
}));
