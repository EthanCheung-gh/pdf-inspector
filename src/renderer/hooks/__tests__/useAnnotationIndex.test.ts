// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildAnnotationIndex, type AnnotationIndexResult } from '../../services/annotation-index';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { annotationDocumentKey, annotationIndexPageTotal, useAnnotationIndex } from '../useAnnotationIndex';

vi.mock('../../services/annotation-index', () => ({
  buildAnnotationIndex: vi.fn(),
}));

const buildMock = vi.mocked(buildAnnotationIndex);

const docA = { name: 'doc-a' } as unknown as PDFDocumentProxy;
const docB = { name: 'doc-b' } as unknown as PDFDocumentProxy;

const EMPTY_SUMMARY = {
  annotations: 0,
  pagesWithAnnotations: 0,
  links: 0,
  forms: 0,
  markup: 0,
  notes: 0,
  stamps: 0,
  other: 0,
  hidden: 0,
  unresolvedLinks: 0,
  unsafeLinks: 0,
  formFields: 0,
};

function makeResult(scannedPages = 2): AnnotationIndexResult {
  return {
    annotations: [
      {
        id: '1:link',
        page: 1,
        subtype: 'Link',
        kind: 'link',
        rect: null,
        title: null,
        contents: null,
        modificationDate: null,
        color: null,
        opacity: null,
        hidden: false,
        link: { url: 'https://example.com/', unsafeUrl: null, internalPage: null, newWindow: false },
        form: null,
      },
    ],
    summary: { ...EMPTY_SUMMARY, annotations: 1, pagesWithAnnotations: 1, links: 1 },
    linkIssues: [],
    formIssues: [],
    formFields: [],
    scannedPages,
    truncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HookProps {
  doc: PDFDocumentProxy | null;
  documentKey: string | null;
  pageCount: number;
  enabled: boolean;
}

const props = (overrides: Partial<HookProps> = {}): HookProps => ({
  doc: docA,
  documentKey: 'doc-a',
  pageCount: 2,
  enabled: true,
  ...overrides,
});

describe('useAnnotationIndex', () => {
  afterEach(cleanup);

  beforeEach(() => {
    buildMock.mockReset();
    useAnnotationIndexStore.getState().reset();
  });

  it('starts one run, publishes progress and stores the result', async () => {
    const pending = deferred<AnnotationIndexResult | null>();
    let report: ((done: number, total: number) => void) | null = null;
    buildMock.mockImplementation(async (_doc, _pages, options) => {
      report = options?.onProgress ?? null;
      report?.(0, 3);
      return pending.promise;
    });

    const { rerender } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props({ pageCount: 3 }) },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));

    const store = useAnnotationIndexStore.getState();
    expect(store.documentKey).toBe('doc-a');
    expect(store.status).toBe('indexing');
    expect(store.progress).toEqual({ done: 0, total: 3 });
    expect(buildMock).toHaveBeenCalledWith(docA, 3, expect.anything());

    act(() => report?.(2, 3));
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 2, total: 3 });

    const result = makeResult(3);
    await act(async () => {
      pending.resolve(result);
    });

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));
    expect(useAnnotationIndexStore.getState().result).toBe(result);

    // A re-render for the same document and attempt must not read it again.
    rerender(props({ pageCount: 3 }));
    await Promise.resolve();
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('does not start until the document mode is opened', async () => {
    buildMock.mockResolvedValue(makeResult());

    const { rerender } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props({ enabled: false }) },
    );

    await Promise.resolve();
    expect(buildMock).not.toHaveBeenCalled();
    expect(useAnnotationIndexStore.getState().status).toBe('idle');

    rerender(props({ enabled: true }));

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('records a failure and rebuilds from scratch on retry', async () => {
    buildMock
      .mockRejectedValueOnce(new Error('Annotation index failed on page 2: boom'))
      .mockResolvedValueOnce(makeResult());

    const { result } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('error'));
    expect(useAnnotationIndexStore.getState().error).toBe(
      'Annotation index failed on page 2: boom',
    );
    expect(useAnnotationIndexStore.getState().result).toBeNull();

    act(() => result.current.retry());

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(buildMock).toHaveBeenLastCalledWith(docA, 2, expect.anything());
    expect(useAnnotationIndexStore.getState().error).toBeNull();
  });

  it('falls back to a readable message for a non-Error rejection', async () => {
    buildMock.mockRejectedValueOnce('plain failure');

    renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('error'));
    expect(useAnnotationIndexStore.getState().error).toBe('plain failure');
  });

  it('keeps indexing when the mode is switched back to the current page', async () => {
    const pending = deferred<AnnotationIndexResult | null>();
    const cancelled: boolean[] = [];
    buildMock.mockImplementation(async (_doc, _pages, options) => {
      cancelled.push(options?.isCancelled?.() ?? false);
      return pending.promise;
    });

    const { rerender } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    const isCancelled = buildMock.mock.calls[0][2]?.isCancelled;

    rerender(props({ enabled: false }));

    // Switching to `Current page` is not a cancellation: the run is still alive
    // and its result is still wanted.
    expect(isCancelled?.()).toBe(false);
    expect(useAnnotationIndexStore.getState().status).toBe('indexing');
    expect(buildMock).toHaveBeenCalledTimes(1);

    const result = makeResult();
    await act(async () => {
      pending.resolve(result);
    });

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));
    expect(useAnnotationIndexStore.getState().result).toBe(result);

    // Reopening the mode reuses the stored result instead of a second read.
    rerender(props({ enabled: true }));
    await Promise.resolve();
    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual([false]);
  });

  it('cancels the previous document and never publishes its result', async () => {
    const slow = deferred<AnnotationIndexResult | null>();
    const fast = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementationOnce(async () => slow.promise);
    buildMock.mockImplementationOnce(async () => fast.promise);

    const { rerender } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    const staleRunCancelled = buildMock.mock.calls[0][2]?.isCancelled;

    rerender(props({ doc: docB, documentKey: 'doc-b' }));

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(2));
    expect(staleRunCancelled?.()).toBe(true);
    expect(useAnnotationIndexStore.getState().documentKey).toBe('doc-b');

    const resultB = makeResult();
    await act(async () => {
      fast.resolve(resultB);
    });
    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));

    // The old document finishes last; its result must not replace doc-b's.
    await act(async () => {
      slow.resolve(makeResult(9));
    });

    const state = useAnnotationIndexStore.getState();
    expect(state.documentKey).toBe('doc-b');
    expect(state.result).toBe(resultB);
    expect(state.status).toBe('ready');
  });

  it('drops a result that arrives after the panel is gone', async () => {
    const pending = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementation(async () => pending.promise);

    const { unmount } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      pending.resolve(makeResult());
    });

    // Nothing wrote to the store after the unmount: the run was abandoned.
    const state = useAnnotationIndexStore.getState();
    expect(state.status).toBe('indexing');
    expect(state.result).toBeNull();
  });

  it('ignores a run the service reports as cancelled', async () => {
    buildMock.mockResolvedValue(null);

    renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props() },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    // `null` is not a result: the run that cancelled it owns the store.
    expect(useAnnotationIndexStore.getState().result).toBeNull();
    expect(useAnnotationIndexStore.getState().status).toBe('indexing');
  });

  it('does not index without a document, a key or a page count', async () => {
    const { rerender } = renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props({ doc: null }) },
    );
    await Promise.resolve();

    rerender(props({ documentKey: null }));
    await Promise.resolve();

    rerender(props({ pageCount: 0 }));
    await Promise.resolve();

    expect(buildMock).not.toHaveBeenCalled();
    expect(useAnnotationIndexStore.getState().status).toBe('idle');
  });

  it('indexes pdfDoc.numPages even when metadata reports fewer pages', async () => {
    const fivePages = { numPages: 5 } as unknown as PDFDocumentProxy;
    const pending = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementation(async () => pending.promise);

    renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      // The sidecar/metadata total is stale: it must not truncate the index.
      { initialProps: props({ doc: fivePages, pageCount: 3 }) },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    expect(buildMock).toHaveBeenCalledWith(fivePages, 5, expect.anything());
    // The stored total is the document total, not the metadata one.
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 0, total: 5 });

    await act(async () => {
      pending.resolve(makeResult(5));
    });

    await waitFor(() => expect(useAnnotationIndexStore.getState().status).toBe('ready'));
    // Trailing pages were read, not silently dropped.
    expect(useAnnotationIndexStore.getState().result?.scannedPages).toBe(5);
    expect(useAnnotationIndexStore.getState().progress).toEqual({ done: 5, total: 5 });
  });

  it('falls back to the metadata page count when numPages is unusable', async () => {
    for (const numPages of [undefined, Number.NaN, 0, -3]) {
      buildMock.mockReset();
      useAnnotationIndexStore.getState().reset();

      const doc = { numPages } as unknown as PDFDocumentProxy;
      const pending = deferred<AnnotationIndexResult | null>();
      buildMock.mockImplementation(async () => pending.promise);

      const { unmount } = renderHook(
        (current: HookProps) =>
          useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
        { initialProps: props({ doc, pageCount: 4 }) },
      );

      await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
      expect(buildMock).toHaveBeenCalledWith(doc, 4, expect.anything());
      expect(useAnnotationIndexStore.getState().progress?.total).toBe(4);

      unmount();
    }
  });

  it('floors a fractional numPages before reading', async () => {
    const fractional = { numPages: 5.9 } as unknown as PDFDocumentProxy;
    buildMock.mockResolvedValue(makeResult(5));

    renderHook(
      (current: HookProps) =>
        useAnnotationIndex(current.doc, current.documentKey, current.pageCount, current.enabled),
      { initialProps: props({ doc: fractional, pageCount: 2 }) },
    );

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    expect(buildMock).toHaveBeenCalledWith(fractional, 5, expect.anything());
  });
});

describe('annotationIndexPageTotal', () => {
  it('prefers the document page count over the metadata total', () => {
    expect(
      annotationIndexPageTotal({ numPages: 5 } as unknown as PDFDocumentProxy, 3),
    ).toBe(5);
    expect(
      annotationIndexPageTotal({ numPages: 5 } as unknown as PDFDocumentProxy, 0),
    ).toBe(5);
  });

  it('falls back to the metadata total when the document cannot report its pages', () => {
    expect(annotationIndexPageTotal(null, 7)).toBe(7);
    expect(annotationIndexPageTotal({ numPages: Number.NaN } as unknown as PDFDocumentProxy, 7)).toBe(7);
    expect(annotationIndexPageTotal({ numPages: 0 } as unknown as PDFDocumentProxy, 7)).toBe(7);
    expect(
      annotationIndexPageTotal({ numPages: Number.POSITIVE_INFINITY } as unknown as PDFDocumentProxy, 7),
    ).toBe(7);
  });

  it('floors both totals and reports zero when neither is usable', () => {
    expect(annotationIndexPageTotal({ numPages: 5.7 } as unknown as PDFDocumentProxy, 3)).toBe(5);
    expect(annotationIndexPageTotal(null, 3.9)).toBe(3);
    expect(annotationIndexPageTotal(null, 0)).toBe(0);
    expect(annotationIndexPageTotal(null, Number.NaN)).toBe(0);
    expect(annotationIndexPageTotal({} as unknown as PDFDocumentProxy, -1)).toBe(0);
  });
});

describe('annotationDocumentKey', () => {
  it('prefers the file path and falls back to the source URL', () => {
    expect(annotationDocumentKey('/docs/a.pdf', null)).toBe('/docs/a.pdf');
    expect(annotationDocumentKey('/doc/7', 'https://example.com/7')).toBe('/doc/7');
    expect(annotationDocumentKey(null, 'https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
    expect(annotationDocumentKey('  ', 'https://example.com/a.pdf')).toBe(
      'https://example.com/a.pdf',
    );
  });

  it('returns null when the document has no identity', () => {
    expect(annotationDocumentKey(null, null)).toBeNull();
    expect(annotationDocumentKey('', '   ')).toBeNull();
  });
});
