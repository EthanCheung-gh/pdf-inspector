// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageNavigation } from '../usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';

vi.mock('../../services/ipc-client', () => ({
  ipc: { extractPage: vi.fn() },
}));

import { ipc } from '../../services/ipc-client';

const pageData = () => ({
  width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('usePageNavigation', () => {
  beforeEach(() => {
    usePdfStore.setState({
      pageCount: 10, currentPage: 1, pageData: null, allObjects: [],
      hoveredObject: null, selectedObject: null, error: null, isLoading: false,
    });
    vi.clearAllMocks();
  });

  it('navigates to a page and sets page data', async () => {
    const data = pageData();
    vi.mocked(ipc.extractPage).mockResolvedValue(data);
    const { result } = renderHook(() => usePageNavigation());

    await act(async () => { await result.current.navigate(3); });

    expect(usePdfStore.getState().currentPage).toBe(3);
    expect(usePdfStore.getState().pageData).toEqual(data);
    expect(usePdfStore.getState().isLoading).toBe(false);
  });

  it('does not let stale data, error, or loading state overwrite the latest request', async () => {
    const first = deferred<ReturnType<typeof pageData>>();
    const second = deferred<ReturnType<typeof pageData>>();
    vi.mocked(ipc.extractPage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => usePageNavigation());

    let firstNavigation!: Promise<void>;
    let secondNavigation!: Promise<void>;
    act(() => {
      firstNavigation = result.current.navigate(2);
      secondNavigation = result.current.navigate(5);
    });

    await act(async () => { second.resolve(pageData()); await secondNavigation; });
    await act(async () => { first.reject(new Error('stale failure')); await firstNavigation; });

    const state = usePdfStore.getState();
    expect(state.currentPage).toBe(5);
    expect(state.pageData).toEqual(pageData());
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it('ignores out-of-range pages', async () => {
    const { result } = renderHook(() => usePageNavigation());
    await act(async () => { await result.current.navigate(0); });
    expect(ipc.extractPage).not.toHaveBeenCalled();
  });

  it('sets an error that includes the underlying failure for the latest extraction', async () => {
    vi.mocked(ipc.extractPage).mockRejectedValue(new Error('Extraction failed'));
    const { result } = renderHook(() => usePageNavigation());

    await act(async () => { await result.current.navigate(3); });

    // The cause (timeout, restart, sidecar error) must stay visible so a failed
    // page is diagnosable instead of collapsing into one generic sentence.
    expect(usePdfStore.getState().error).toBe(
      'Failed to load page data: Extraction failed. Please try again.',
    );
    expect(usePdfStore.getState().isLoading).toBe(false);
  });

  it('keeps the generic message when the failure has no detail', async () => {
    vi.mocked(ipc.extractPage).mockRejectedValue(new Error('   '));
    const { result } = renderHook(() => usePageNavigation());

    await act(async () => { await result.current.navigate(3); });

    expect(usePdfStore.getState().error).toBe('Failed to load page data. Please try again.');
  });

  it('does not double the final period of a multi-sentence failure', async () => {
    vi.mocked(ipc.extractPage).mockRejectedValue(
      new Error('Sidecar repeatedly crashes. Please restart the application.'),
    );
    const { result } = renderHook(() => usePageNavigation());

    await act(async () => { await result.current.navigate(3); });

    expect(usePdfStore.getState().error).toBe(
      'Failed to load page data: Sidecar repeatedly crashes. Please restart the application. Please try again.',
    );
  });
});
