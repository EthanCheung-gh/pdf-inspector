import { create } from 'zustand';

/**
 * Pointer position in PDF points, kept out of the persisted workspace store:
 * mousemove fires many times per second and must not write localStorage.
 */
export interface CursorPdfPoint {
  x: number;
  y: number;
}

interface CursorState {
  cursorPdfPoint: CursorPdfPoint | null;
  setCursorPdfPoint: (point: CursorPdfPoint | null) => void;
}

export const useCursorStore = create<CursorState>((set) => ({
  cursorPdfPoint: null,
  setCursorPdfPoint: (point) => set({ cursorPdfPoint: point }),
}));
