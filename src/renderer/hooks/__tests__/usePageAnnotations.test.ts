// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPageAnnotations } from '../../services/annotations';
import { useAnnotationStore } from '../../store/annotation-store';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageBox } from '../../types/pdf-objects';
import { usePageAnnotations } from '../usePageAnnotations';

vi.mock('../../services/annotations', () => ({
  loadPageAnnotations: vi.fn(),
}));

const loadMock = vi.mocked(loadPageAnnotations);

const docA = { name: 'doc-a' } as unknown as PDFDocumentProxy;
const docB = { name: 'doc-b' } as unknown as PDFDocumentProxy;

const MEDIA: PageBox = { x0: 10, y0: 20, x1: 622, y1: 812 };

const annotation = (id: string, page: number): PdfAnnotation => ({
  id,
  page,
  subtype: 'Link',
  kind: 'link',
  rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const resetStores = (): void => {
  useAnnotationStore.getState().clear();
  useAnnotationStore.setState({ kindFilter: 'all', subtypeFilter: 'all', showBoxes: true });
};

describe('usePageAnnotations', () => {
  // Unmount between tests: a still-mounted hook would react to the next test's
  // `reloadKey` bump and call the shared loader mock.
  afterEach(cleanup);

  beforeEach(() => {
    resetStores();
    loadMock.mockReset();
    loadMock.mockResolvedValue([]);
  });

  it('waits for the MediaBox before requesting annotations', async () => {
    renderHook(() => usePageAnnotations(docA, 3, null));

    await Promise.resolve();

    expect(loadMock).not.toHaveBeenCalled();
    expect(useAnnotationStore.getState().page).toBeNull();
    expect(useAnnotationStore.getState().loading).toBe(false);
    // Nothing from a previous page may survive while the page is unknown.
    expect(useAnnotationStore.getState().annotations).toEqual([]);
  });

  it('loads the page with the MediaBox origin and stores the result', async () => {
    const annotations = [annotation('1:a', 2)];
    loadMock.mockResolvedValue(annotations);

    const { rerender } = renderHook(
      ({ page }: { page: number }) => usePageAnnotations(docA, page, MEDIA),
      { initialProps: { page: 2 } },
    );

    await waitFor(() => {
      expect(useAnnotationStore.getState().page).toBe(2);
    });

    expect(loadMock).toHaveBeenCalledWith(docA, 2, { x: 10, y: 20 });
    expect(useAnnotationStore.getState().annotations).toEqual(annotations);
    expect(useAnnotationStore.getState().loading).toBe(false);
    expect(useAnnotationStore.getState().error).toBeNull();

    // Re-rendering with the same page/origin must not re-request (no loops).
    rerender({ page: 2 });
    await Promise.resolve();
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('reloads for a new page and clears the previous selection', async () => {
    loadMock.mockImplementation(async (_doc, page) => [annotation(`${page}:a`, page)]);

    const { rerender } = renderHook(
      ({ page }: { page: number }) => usePageAnnotations(docA, page, MEDIA),
      { initialProps: { page: 1 } },
    );

    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(1));
    const firstAnnotation = useAnnotationStore.getState().annotations[0];
    useAnnotationStore.getState().setSelected(firstAnnotation);
    useAnnotationStore.getState().setHovered(firstAnnotation);

    rerender({ page: 2 });

    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(2));
    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useAnnotationStore.getState().hovered).toBeNull();
    expect(useAnnotationStore.getState().annotations[0].id).toBe('2:a');
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale response that resolves after the page changed', async () => {
    const slowPageOne = deferred<PdfAnnotation[]>();
    const fastPageTwo = deferred<PdfAnnotation[]>();
    loadMock.mockReturnValueOnce(slowPageOne.promise).mockReturnValueOnce(fastPageTwo.promise);

    const { rerender } = renderHook(
      ({ page }: { page: number }) => usePageAnnotations(docA, page, MEDIA),
      { initialProps: { page: 1 } },
    );
    expect(useAnnotationStore.getState().loading).toBe(true);

    rerender({ page: 2 });

    fastPageTwo.resolve([annotation('2:b', 2)]);
    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(2));

    // The page 1 response arrives last and must be dropped.
    slowPageOne.resolve([annotation('1:a', 1)]);
    await waitFor(() => expect(useAnnotationStore.getState().loading).toBe(false));

    expect(useAnnotationStore.getState().page).toBe(2);
    expect(useAnnotationStore.getState().annotations.map((item) => item.id)).toEqual(['2:b']);
  });

  it('ignores a stale response from a previous document', async () => {
    const slowDocA = deferred<PdfAnnotation[]>();
    const fastDocB = deferred<PdfAnnotation[]>();
    loadMock.mockReturnValueOnce(slowDocA.promise).mockReturnValueOnce(fastDocB.promise);

    const { rerender } = renderHook(
      ({ doc, page }: { doc: PDFDocumentProxy; page: number }) =>
        usePageAnnotations(doc, page, MEDIA),
      { initialProps: { doc: docA, page: 1 } },
    );

    rerender({ doc: docB, page: 1 });

    fastDocB.resolve([annotation('1:new', 1)]);
    await waitFor(() => expect(useAnnotationStore.getState().annotations[0]?.id).toBe('1:new'));

    slowDocA.resolve([annotation('1:old', 1)]);
    await Promise.resolve();

    expect(useAnnotationStore.getState().annotations.map((item) => item.id)).toEqual(['1:new']);
  });

  it('surfaces a load error and stops loading', async () => {
    loadMock.mockRejectedValue(new Error('annotations unavailable'));

    renderHook(() => usePageAnnotations(docA, 1, MEDIA));

    await waitFor(() => expect(useAnnotationStore.getState().error).toBe('annotations unavailable'));

    expect(useAnnotationStore.getState().loading).toBe(false);
    expect(useAnnotationStore.getState().annotations).toEqual([]);
  });

  it('falls back to a readable message for a non-Error rejection', async () => {
    loadMock.mockRejectedValue('plain failure');

    renderHook(() => usePageAnnotations(docA, 1, MEDIA));

    await waitFor(() => expect(useAnnotationStore.getState().error).toBe('plain failure'));
  });

  it('clears everything when the document is closed', async () => {
    loadMock.mockResolvedValue([annotation('1:a', 1)]);

    const { rerender } = renderHook(
      ({ doc }: { doc: PDFDocumentProxy | null }) => usePageAnnotations(doc, 1, MEDIA),
      { initialProps: { doc: docA as PDFDocumentProxy | null } },
    );
    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(1));

    rerender({ doc: null });

    const state = useAnnotationStore.getState();
    expect(state.page).toBeNull();
    expect(state.annotations).toEqual([]);
    expect(state.selected).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('keeps filters and the box toggle across page loads', async () => {
    useAnnotationStore.getState().setKindFilter('link');
    useAnnotationStore.getState().setShowBoxes(false);

    const { rerender } = renderHook(
      ({ page }: { page: number }) => usePageAnnotations(docA, page, MEDIA),
      { initialProps: { page: 1 } },
    );
    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(1));

    rerender({ page: 2 });
    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(2));

    expect(useAnnotationStore.getState().kindFilter).toBe('link');
    expect(useAnnotationStore.getState().showBoxes).toBe(false);
  });

  // The Annots tab's Retry button only bumps `reloadKey`; the loader must run
  // again for the page on screen and replace the stored error.
  it('retries the current page when a reload is requested', async () => {
    loadMock
      .mockRejectedValueOnce(new Error('annotations unavailable'))
      .mockResolvedValueOnce([annotation('1:a', 1)]);

    renderHook(() => usePageAnnotations(docA, 1, MEDIA));

    await waitFor(() =>
      expect(useAnnotationStore.getState().error).toBe('annotations unavailable'),
    );

    act(() => {
      useAnnotationStore.getState().requestReload();
    });

    await waitFor(() => expect(useAnnotationStore.getState().page).toBe(1));

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(loadMock).toHaveBeenLastCalledWith(docA, 1, { x: 10, y: 20 });
    expect(useAnnotationStore.getState().error).toBeNull();
    expect(useAnnotationStore.getState().annotations.map((item) => item.id)).toEqual(['1:a']);
  });
});
