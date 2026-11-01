import { beforeEach, describe, expect, it } from 'vitest';
import { useCursorStore } from '../cursor-store';

describe('cursor-store', () => {
  beforeEach(() => {
    useCursorStore.setState({ cursorPdfPoint: null });
  });

  it('stores and clears the pointer position', () => {
    expect(useCursorStore.getState().cursorPdfPoint).toBeNull();

    useCursorStore.getState().setCursorPdfPoint({ x: 12.5, y: 34.25 });
    expect(useCursorStore.getState().cursorPdfPoint).toEqual({ x: 12.5, y: 34.25 });

    useCursorStore.getState().setCursorPdfPoint(null);
    expect(useCursorStore.getState().cursorPdfPoint).toBeNull();
  });

  it('is not wrapped in a persisted store', () => {
    // Mousemove updates this store many times per second; it must never touch
    // localStorage, so it has no zustand persist API at all.
    expect('persist' in useCursorStore).toBe(false);
  });
});
