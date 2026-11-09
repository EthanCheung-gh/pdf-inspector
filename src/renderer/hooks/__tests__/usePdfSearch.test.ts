// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate: vi.fn(async () => {}) }),
}));

import { usePdfSearch } from '../usePdfSearch';
import { usePdfStore } from '../../store/pdf-store';

type Progress = { done: number; total: number } | null;

interface FakePage {
  getTextContent: () => Promise<{ items: unknown[] }>;
}

interface ControlledDoc {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
}

const pageContent = (texts: string[]): FakePage => ({
  getTextContent: async () => ({ items: texts.map((str) => ({ str })) }),
});

/** A document whose pages all resolve immediately. */
function instantDoc(pageTexts: string[][]): ControlledDoc {
  return {
    numPages: pageTexts.length,
    getPage: vi.fn(async (page: number) => pageContent(pageTexts[page - 1])),
  };
}

/**
 * A document where each `getPage` waits for an explicit release, so a test can
 * observe (and cancel) a build while it is midway through the page list.
 */
function gatedDoc(pageTexts: string[][]) {
  const gates: Array<() => void> = [];
  const doc: ControlledDoc = {
    numPages: pageTexts.length,
    getPage: vi.fn(
      (page: number) =>
        new Promise<FakePage>((resolve) => {
          gates.push(() => resolve(pageContent(pageTexts[page - 1])));
        }),
    ),
  };

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    doc,
    pending: () => gates.length,
    /** Release the next `count` page loads (fewer if the build stopped). */
    async release(count: number) {
      for (let i = 0; i < count; i += 1) {
        const gate = gates.shift();
        if (!gate) return;
        gate();
        await flush();
      }
    },
    async releaseAll() {
      while (gates.length > 0) {
        const gate = gates.shift();
        if (!gate) return;
        gate();
        await flush();
      }
    },
  };
}

const metadata = {
  pages: 25,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

/** Collect every distinct progress value the store publishes. */
function recordProgress(): { seen: Progress[]; stop: () => void } {
  const seen: Progress[] = [];
  let last = usePdfStore.getState().searchIndexProgress;
  const unsubscribe = usePdfStore.subscribe((state) => {
    const progress = state.searchIndexProgress;
    const same =
      last === progress ||
      (last !== null &&
        progress !== null &&
        last.done === progress.done &&
        last.total === progress.total);
    if (!same) {
      seen.push(progress);
      last = progress;
    }
  });
  return { seen, stop: unsubscribe };
}

describe('usePdfSearch index batching', () => {
  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/tmp/large.pdf',
      metadata,
      pageCount: 25,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      pdfDocRef: null,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: true,
      searchIndexProgress: null,
    });
  });

  it('builds the text index in 10-page batches and reports progress', async () => {
    const pages = Array.from({ length: 25 }, (_, index) => [`page ${index + 1} alpha`]);
    const doc = instantDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never });

    const { result } = renderHook(() => usePdfSearch());
    const { seen, stop } = recordProgress();

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    stop();

    expect(doc.getPage).toHaveBeenCalledTimes(25);
    // 0/25 at the start, then one update per finished batch, then completion.
    expect(seen).toEqual([
      { done: 0, total: 25 },
      { done: 10, total: 25 },
      { done: 20, total: 25 },
      { done: 25, total: 25 },
      null,
    ]);
    expect(usePdfStore.getState().searchIndexProgress).toBeNull();
    expect(usePdfStore.getState().searchMatches).toHaveLength(25);
    // "page 1 alpha": the query starts after "page 1 ".
    expect(usePdfStore.getState().searchMatches[0]).toEqual({ page: 1, begin: 7, length: 5 });
  });

  it('reuses the cached index for later queries on the same document', async () => {
    const pages = Array.from({ length: 25 }, (_, index) => [`page ${index + 1} alpha`]);
    const doc = instantDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never });

    const { result } = renderHook(() => usePdfSearch());

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(doc.getPage).toHaveBeenCalledTimes(25);

    const { seen, stop } = recordProgress();
    await act(async () => {
      await result.current.setQuery('page 25 alpha');
    });
    stop();

    // No second index pass and no progress row for a cached index.
    expect(doc.getPage).toHaveBeenCalledTimes(25);
    expect(seen).toEqual([]);
    expect(usePdfStore.getState().searchMatches).toEqual([{ page: 25, begin: 0, length: 13 }]);
  });

  it('closing the search cancels a running build instead of finishing it', async () => {
    const pages = Array.from({ length: 20 }, (_, index) => [`page ${index + 1} alpha`]);
    const { doc, release, releaseAll } = gatedDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 20 });

    const { result } = renderHook(() => usePdfSearch());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.setQuery('alpha');
    });

    await release(3);
    expect(usePdfStore.getState().searchIndexProgress).toEqual({ done: 0, total: 20 });

    act(() => {
      result.current.clear();
    });

    // The progress row disappears with the search box...
    expect(usePdfStore.getState().searchIndexProgress).toBeNull();
    expect(usePdfStore.getState().searchQuery).toBe('');
    expect(usePdfStore.getState().searchOpen).toBe(false);

    const { seen, stop } = recordProgress();
    await releaseAll();
    await act(async () => {
      await pending;
    });
    stop();

    // ...and the build stops early: no matches, no late progress update.
    expect(doc.getPage.mock.calls.length).toBeLessThan(20);
    expect(seen).toEqual([]);
    expect(usePdfStore.getState().searchMatches).toEqual([]);
    expect(usePdfStore.getState().searchIndexProgress).toBeNull();
  });

  it('drops a stale build when the document changes', async () => {
    const pages = Array.from({ length: 15 }, (_, index) => [`page ${index + 1} alpha`]);
    const { doc, release, releaseAll } = gatedDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 15 });

    const { result } = renderHook(() => usePdfSearch());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.setQuery('alpha');
    });
    await release(2);

    act(() => {
      // A new document resets pdfDocRef (and with it the index + progress).
      usePdfStore.getState().setFile('/tmp/other.pdf', { ...metadata, pages: 4 });
    });
    expect(usePdfStore.getState().searchIndexProgress).toBeNull();

    const { seen, stop } = recordProgress();
    await releaseAll();
    await act(async () => {
      await pending;
    });
    stop();

    expect(doc.getPage.mock.calls.length).toBeLessThan(15);
    expect(seen).toEqual([]);
    expect(usePdfStore.getState().searchMatches).toEqual([]);
    expect(usePdfStore.getState().searchIndexProgress).toBeNull();
  });

  it('drops the cached index after a document change', async () => {
    const pages = Array.from({ length: 12 }, (_, index) => [`page ${index + 1} alpha`]);
    const doc = instantDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 12 });

    const { result } = renderHook(() => usePdfSearch());
    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(doc.getPage).toHaveBeenCalledTimes(12);

    act(() => {
      usePdfStore.getState().setFile('/tmp/other.pdf', { ...metadata, pages: 12 });
    });
    // The reopened document arrives in a later render, exactly like
    // PdfViewport handing the freshly loaded PDF.js document to the store.
    act(() => {
      usePdfStore.setState({ pdfDocRef: doc as never });
    });

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(doc.getPage).toHaveBeenCalledTimes(24);
  });

  it('ignores results for a query the user already replaced', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => [`page ${index + 1} alpha beta`]);
    const { doc, release, releaseAll } = gatedDoc(pages);
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 6 });

    const { result } = renderHook(() => usePdfSearch());

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.setQuery('alpha');
    });
    await release(1);
    act(() => {
      second = result.current.setQuery('beta');
    });

    await releaseAll();
    await act(async () => {
      await Promise.all([first, second]);
    });

    const state = usePdfStore.getState();
    expect(state.searchQuery).toBe('beta');
    expect(state.searchMatches).toHaveLength(6);
    // "beta" starts 13 characters into "page N alpha beta" on page 1.
    expect(state.searchMatches[0]).toEqual({ page: 1, begin: 13, length: 4 });
  });

  it('keeps indexing when a single page cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc: ControlledDoc = {
      numPages: 3,
      getPage: vi.fn(async (page: number) => {
        if (page === 2) throw new Error('page 2 exploded');
        return pageContent([`page ${page} alpha`]);
      }),
    };
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 3 });

    try {
      const { result } = renderHook(() => usePdfSearch());
      await act(async () => {
        await result.current.setQuery('alpha');
      });

      expect(usePdfStore.getState().searchMatches.map((match) => match.page)).toEqual([1, 3]);
      expect(usePdfStore.getState().searchIndexProgress).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does nothing without a loaded document', async () => {
    usePdfStore.setState({ pdfDocRef: null });
    const { result } = renderHook(() => usePdfSearch());

    await act(async () => {
      await result.current.setQuery('alpha');
    });

    expect(usePdfStore.getState().searchIndexProgress).toBeNull();
    expect(usePdfStore.getState().searchMatches).toEqual([]);
  });
});
