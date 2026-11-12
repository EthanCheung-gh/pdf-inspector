// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageNavigation } from '../usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfMetadata } from '../../types/pdf-objects';

vi.mock('../../services/ipc-client', () => ({
  ipc: { extractPage: vi.fn() },
}));

import { ipc } from '../../services/ipc-client';

const pageData = () => ({
  width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [],
});

const metadata = (pages: number): PdfMetadata => ({
  pages,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
});

/** Open a different document, which is what invalidates in-flight requests. */
function openOtherDocument(pages = 10): void {
  usePdfStore.getState().setFile('/tmp/other.pdf', metadata(pages));
}

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

  // A page request is addressed to "the open document", not to a document id, so
  // a response that arrives after a tab/document switch describes a PDF the user
  // has already left: publishing it would show the wrong page, and reporting it
  // would surface "list index out of range" for a page the new document may not
  // even have.
  it('drops a stale response that arrives after the document was replaced', async () => {
    const first = deferred<ReturnType<typeof pageData>>();
    vi.mocked(ipc.extractPage).mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => usePageNavigation());

    let navigation!: Promise<void>;
    act(() => { navigation = result.current.navigate(9); });

    openOtherDocument(3);
    await act(async () => { first.resolve(pageData()); await navigation; });

    const state = usePdfStore.getState();
    expect(state.pageData).toBeNull();
    expect(state.filePath).toBe('/tmp/other.pdf');
    expect(state.isLoading).toBe(false);
  });

  it('does not report a failure from a request owned by the previous document', async () => {
    const first = deferred<ReturnType<typeof pageData>>();
    vi.mocked(ipc.extractPage).mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => usePageNavigation());

    let navigation!: Promise<void>;
    act(() => { navigation = result.current.navigate(9); });

    openOtherDocument(3);
    await act(async () => {
      first.reject(new Error('list index out of range'));
      await navigation;
    });

    expect(usePdfStore.getState().error).toBeNull();
  });

  it('leaves the new document loading state alone when a stale request settles', async () => {
    const first = deferred<ReturnType<typeof pageData>>();
    vi.mocked(ipc.extractPage).mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => usePageNavigation());

    let navigation!: Promise<void>;
    act(() => { navigation = result.current.navigate(9); });

    openOtherDocument(3);
    // The new document's own navigation is in flight.
    usePdfStore.setState({ isLoading: true });
    await act(async () => { first.resolve(pageData()); await navigation; });

    expect(usePdfStore.getState().isLoading).toBe(true);
  });

  it('forgets a page request superseded by an emptied document', async () => {
    const first = deferred<ReturnType<typeof pageData>>();
    vi.mocked(ipc.extractPage).mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => usePageNavigation());

    let navigation!: Promise<void>;
    act(() => { navigation = result.current.navigate(4); });

    act(() => { usePdfStore.getState().resetDocument(); });
    await act(async () => { first.resolve(pageData()); await navigation; });

    const state = usePdfStore.getState();
    expect(state.pageData).toBeNull();
    expect(state.currentPage).toBe(1);
    expect(state.error).toBeNull();
  });

  it.each([1.5, 2.000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 11])(
    'rejects the invalid page number %p without calling the sidecar',
    async (page) => {
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => { await result.current.navigate(page); });

      expect(ipc.extractPage).not.toHaveBeenCalled();
      expect(usePdfStore.getState().error).toBeNull();
      expect(usePdfStore.getState().currentPage).toBe(1);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not navigate while the page count is %p',
    async (pageCount) => {
      usePdfStore.setState({ pageCount });
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => { await result.current.navigate(1); });

      expect(ipc.extractPage).not.toHaveBeenCalled();
      expect(usePdfStore.getState().isLoading).toBe(false);
    },
  );
});
