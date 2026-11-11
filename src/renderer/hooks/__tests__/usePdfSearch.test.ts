// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate: vi.fn(async () => {}) }),
}));

import { usePdfSearch } from '../usePdfSearch';
import { usePdfStore } from '../../store/pdf-store';
import { DEFAULT_SEARCH_OPTIONS, MAX_SEARCH_MATCHES } from '../../services/pdf-search';

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
    expect(usePdfStore.getState().searchMatches[0]).toEqual({
      page: 1,
      begin: 7,
      length: 5,
      preview: 'page 1 alpha',
    });
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
    expect(usePdfStore.getState().searchMatches).toEqual([
      { page: 25, begin: 0, length: 13, preview: 'page 25 alpha' },
    ]);
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
    expect(state.searchMatches[0]).toEqual({
      page: 1,
      begin: 13,
      length: 4,
      preview: 'page 1 alpha beta',
    });
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

describe('usePdfSearch options, results and navigation', () => {
  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/tmp/options.pdf',
      metadata,
      pageCount: 4,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      pdfDocRef: null,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: true,
      searchIndexProgress: null,
      searchOptions: { ...DEFAULT_SEARCH_OPTIONS },
      searchResultsOpen: false,
      searchTruncated: false,
      searchError: null,
    });
  });

  /** Matches of the given page texts, with the index build counted by `doc`. */
  function setupDoc(pageTexts: string[]) {
    const doc = instantDoc(pageTexts.map((text) => [text]));
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: pageTexts.length });
    const { result } = renderHook(() => usePdfSearch());
    return { doc, result };
  }

  it('re-runs the query on an option change without rebuilding the index', async () => {
    const { doc, result } = setupDoc(['Hello hello', 'nothing', 'HELLO hello']);

    await act(async () => {
      await result.current.setQuery('hello');
    });
    expect(usePdfStore.getState().searchMatches).toHaveLength(4);
    expect(doc.getPage).toHaveBeenCalledTimes(3);

    await act(async () => {
      await result.current.setOptions({ caseSensitive: true });
    });

    const state = usePdfStore.getState();
    expect(doc.getPage).toHaveBeenCalledTimes(3); // cached index reused
    expect(state.searchIndexProgress).toBeNull();
    expect(state.searchOptions.caseSensitive).toBe(true);
    expect(state.searchMatches.map(({ page, begin }) => ({ page, begin }))).toEqual([
      { page: 1, begin: 6 },
      { page: 3, begin: 6 },
    ]);
  });

  it('applies whole-word and regex option changes to the current query', async () => {
    const { result } = setupDoc(['cover over', 'a1 b22']);

    await act(async () => {
      await result.current.setQuery('over');
    });
    // Literal mode: "cover" contains "over" too.
    expect(usePdfStore.getState().searchMatches).toHaveLength(2);

    await act(async () => {
      await result.current.setOptions({ wholeWord: true });
    });
    expect(usePdfStore.getState().searchMatches).toHaveLength(1);

    await act(async () => {
      await result.current.setQuery('\\d+');
    });
    // Still literal: no page contains a literal backslash-digit sequence.
    expect(usePdfStore.getState().searchMatches).toEqual([]);

    await act(async () => {
      await result.current.setOptions({ regex: true, wholeWord: false });
    });
    const state = usePdfStore.getState();
    expect(state.searchError).toBeNull();
    expect(state.searchMatches.map(({ page, begin, length }) => ({ page, begin, length }))).toEqual([
      { page: 2, begin: 1, length: 1 },
      { page: 2, begin: 4, length: 2 },
    ]);
  });

  it('reports an invalid regex inline instead of throwing or navigating', async () => {
    const { result } = setupDoc(['anything here']);

    await act(async () => {
      await result.current.setOptions({ regex: true });
    });
    await act(async () => {
      await result.current.setQuery('(');
    });

    const state = usePdfStore.getState();
    expect(state.searchError).toMatch(/^Invalid regular expression/);
    expect(state.searchMatches).toEqual([]);
    expect(state.currentMatchIndex).toBe(-1);
    expect(state.searchResultsOpen).toBe(true);
    expect(state.searchTruncated).toBe(false);
  });

  it('clears the error when the next query compiles', async () => {
    const { result } = setupDoc(['anything here']);
    await act(async () => {
      await result.current.setOptions({ regex: true });
    });
    await act(async () => {
      await result.current.setQuery('(');
    });
    await act(async () => {
      await result.current.setQuery('any');
    });

    const state = usePdfStore.getState();
    expect(state.searchError).toBeNull();
    expect(state.searchMatches).toHaveLength(1);
  });

  it('auto-opens the results panel for a non-empty query with hits', async () => {
    const { result } = setupDoc(['alpha', 'beta']);

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(usePdfStore.getState().searchResultsOpen).toBe(true);

    await act(async () => {
      await result.current.setQuery('');
    });
    const state = usePdfStore.getState();
    expect(state.searchResultsOpen).toBe(false);
    expect(state.searchMatches).toEqual([]);
  });

  it('leaves a closed panel closed when nothing matches', async () => {
    const { result } = setupDoc(['alpha']);

    await act(async () => {
      await result.current.setQuery('zzz');
    });

    const state = usePdfStore.getState();
    expect(state.searchMatches).toEqual([]);
    expect(state.searchResultsOpen).toBe(false);
    expect(state.searchError).toBeNull();
  });

  it('goToMatch moves the current hit and wraps out-of-range indexes', async () => {
    const { result } = setupDoc(['alpha', 'alpha', 'alpha', 'alpha']);

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(usePdfStore.getState().currentMatchIndex).toBe(0);

    act(() => result.current.goToMatch(2));
    expect(usePdfStore.getState().currentMatchIndex).toBe(2);

    act(() => result.current.goToMatch(-1));
    expect(usePdfStore.getState().currentMatchIndex).toBe(3);

    act(() => result.current.goToMatch(9));
    expect(usePdfStore.getState().currentMatchIndex).toBe(1);
  });

  it('publishes truncation metadata for a capped result set', async () => {
    const { result } = setupDoc(['a'.repeat(MAX_SEARCH_MATCHES + 100)]);

    await act(async () => {
      await result.current.setQuery('a');
    });

    const state = usePdfStore.getState();
    expect(state.searchMatches).toHaveLength(MAX_SEARCH_MATCHES);
    expect(state.searchTruncated).toBe(true);
    expect(state.searchResultsOpen).toBe(true);
  });

  it('refresh re-runs the current query from the cached index', async () => {
    const { doc, result } = setupDoc(['alpha alpha']);

    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(usePdfStore.getState().searchMatches).toHaveLength(2);

    act(() => {
      usePdfStore.getState().setSearchMatches([]);
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(doc.getPage).toHaveBeenCalledTimes(1);
    expect(usePdfStore.getState().searchMatches).toHaveLength(2);
  });

  it('a stale run for the same query cannot overwrite newer options', async () => {
    const { doc, release, releaseAll } = gatedDoc([['Hello hello'], ['Hello hello']]);
    usePdfStore.setState({ pdfDocRef: doc as never, pageCount: 2 });
    const { result } = renderHook(() => usePdfSearch());

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.setQuery('hello');
    });
    await release(1);
    // Same query, different options: this run is the one that must win.
    act(() => {
      second = result.current.setOptions({ caseSensitive: true });
    });

    await releaseAll();
    await act(async () => {
      await Promise.all([first, second]);
    });

    const state = usePdfStore.getState();
    expect(state.searchOptions.caseSensitive).toBe(true);
    // One build only, and the case-sensitive result of the newer run.
    expect(doc.getPage).toHaveBeenCalledTimes(2);
    expect(state.searchMatches.map(({ page, begin }) => ({ page, begin }))).toEqual([
      { page: 1, begin: 6 },
      { page: 2, begin: 6 },
    ]);
  });

  it('keeps options across a document change but clears results', async () => {
    const { result } = setupDoc(['alpha alpha']);
    await act(async () => {
      await result.current.setOptions({ wholeWord: true, caseSensitive: true });
    });
    await act(async () => {
      await result.current.setQuery('alpha');
    });
    expect(usePdfStore.getState().searchMatches).toHaveLength(2);

    act(() => {
      usePdfStore.getState().setFile('/tmp/next.pdf', { ...metadata, pages: 2 });
    });

    const state = usePdfStore.getState();
    expect(state.searchOptions).toEqual({ caseSensitive: true, wholeWord: true, regex: false });
    expect(state.searchMatches).toEqual([]);
    expect(state.searchResultsOpen).toBe(false);
    expect(state.searchTruncated).toBe(false);
    expect(state.searchError).toBeNull();
  });
});
