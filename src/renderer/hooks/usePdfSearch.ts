import { useCallback, useEffect, useRef } from 'react';
import {
  SEARCH_INDEX_BATCH_SIZE,
  buildPageText,
  findMatchesDetailed,
  pageBatches,
  type SearchOptions,
} from '../services/pdf-search';
import { usePdfStore } from '../store/pdf-store';
import { usePageNavigation } from './usePageNavigation';

export interface UsePdfSearchReturn {
  setQuery: (query: string) => Promise<void>;
  /** Merge option toggles, then re-run the current query against the cached index. */
  setOptions: (options: Partial<SearchOptions>) => Promise<void>;
  /** Re-run the current query/options, e.g. after the document finished loading. */
  refresh: () => Promise<void>;
  next: () => void;
  prev: () => void;
  /** Jump to the match at `index` (wrapped into range) and navigate to its page. */
  goToMatch: (index: number) => void;
  clear: () => void;
}

/**
 * Extract the searchable strings for one page, mirroring exactly what the
 * PDF.js TextLayer puts into its `textContentItemsStr` array: one entry per
 * item that has a `str` (marked-content items are skipped entirely, empty
 * strings are kept). Keeping this identical is what makes the highlight
 * offset mapping in TextLayer.tsx line up.
 */
function textContentToStrings(content: { items: unknown[] }): string[] {
  const strings: string[] = [];
  for (const item of content.items) {
    if (typeof item === 'object' && item !== null && 'str' in item) {
      strings.push((item as { str: string }).str);
    }
  }
  return strings;
}

export function usePdfSearch(): UsePdfSearchReturn {
  const pageTextsRef = useRef<string[] | null>(null);
  const pageTextsPromiseRef = useRef<Promise<string[] | null> | null>(null);
  // Bumped by every cancel/invalidate; an in-flight build compares its own id
  // against this after each page and between batches, so a document switch or a
  // closed search can never be overwritten by a build that outlived it.
  const buildIdRef = useRef(0);
  // Bumped by every search run (typing, option toggle, refresh). A run that
  // resolves after a newer one started must not publish its results.
  const searchRunRef = useRef(0);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const { navigate } = usePageNavigation();

  const cancelBuild = useCallback(() => {
    buildIdRef.current += 1;
    pageTextsPromiseRef.current = null;
    usePdfStore.getState().setSearchIndexProgress(null);
  }, []);

  // Invalidate the index whenever a different document is loaded.
  useEffect(() => {
    pageTextsRef.current = null;
    pageTextsPromiseRef.current = null;
    buildIdRef.current += 1;
    // A search queued for the previous document must not land on this one.
    searchRunRef.current += 1;
    usePdfStore.getState().setSearchIndexProgress(null);
  }, [pdfDocRef]);

  // The search box unmounts while Diff/Audit/Raw own the workspace. Without
  // this the index would keep reading pages in the background and leave an
  // `Indexing…` progress row behind for a search nobody can see.
  useEffect(
    () => () => {
      pageTextsPromiseRef.current = null;
      buildIdRef.current += 1;
      usePdfStore.getState().setSearchIndexProgress(null);
    },
    [],
  );

  const ensureIndex = useCallback((): Promise<string[] | null> => {
    if (pageTextsRef.current) return Promise.resolve(pageTextsRef.current);
    // Coalesce concurrent callers onto a single in-flight build.
    if (pageTextsPromiseRef.current) return pageTextsPromiseRef.current;
    const doc = usePdfStore.getState().pdfDocRef;
    if (!doc) return Promise.resolve(null);

    const buildId = ++buildIdRef.current;
    const total = doc.numPages;
    const isStale = (): boolean => buildId !== buildIdRef.current;
    usePdfStore.getState().setSearchIndexProgress({ done: 0, total });

    const promise = (async (): Promise<string[] | null> => {
      const texts: string[] = [];
      // Batched rather than page-at-a-time so a 1000-page document reports
      // progress, yields to the renderer between batches and can be cancelled
      // at a batch boundary instead of running to completion.
      for (const [start, end] of pageBatches(total, SEARCH_INDEX_BATCH_SIZE)) {
        for (let p = start; p <= end; p += 1) {
          try {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            if (isStale()) return null; // stale build
            texts.push(buildPageText(textContentToStrings(content)));
          } catch (err) {
            if (isStale()) return null;
            console.warn(`Search index: skipped page ${p}:`, err);
            texts.push('');
          }
        }
        if (isStale()) return null;
        usePdfStore.getState().setSearchIndexProgress({ done: end, total });
      }
      if (isStale()) return null;
      pageTextsRef.current = texts;
      usePdfStore.getState().setSearchIndexProgress(null);
      return texts;
    })();
    pageTextsPromiseRef.current = promise;
    return promise;
  }, []);

  const goTo = useCallback(
    (index: number) => {
      const store = usePdfStore.getState();
      const { searchMatches } = store;
      if (searchMatches.length === 0) return;
      const wrapped = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
      store.setCurrentMatchIndex(wrapped);
      const match = searchMatches[wrapped];
      if (match.page !== store.currentPage) {
        void navigate(match.page);
      }
    },
    [navigate],
  );

  /**
   * Run the current query against the cached index and publish matches, the
   * truncation flag and pattern errors. Every call takes a new generation so a
   * slower earlier run (e.g. one waiting on the index build) can never
   * overwrite the results of a newer query *or* a newer option toggle.
   */
  const runSearch = useCallback(
    async (query: string): Promise<void> => {
      const runId = ++searchRunRef.current;
      const store = usePdfStore.getState();
      if (query.trim().length === 0) {
        // No query means no reason to keep reading pages: cancel a running
        // build instead of leaving it to finish in the background.
        cancelBuild();
        store.setSearchMatches([]);
        store.setCurrentMatchIndex(-1);
        store.setSearchResultMeta(false, null);
        store.setSearchResultsOpen(false);
        return;
      }
      const texts = await ensureIndex();
      if (!texts) return;
      if (runId !== searchRunRef.current) return; // superseded while indexing
      const current = usePdfStore.getState();
      // The user kept typing (or closed the search) while the index was
      // building; drop stale results.
      if (current.searchQuery !== query) return;

      const result = findMatchesDetailed(texts, query, current.searchOptions);
      current.setSearchMatches(result.matches);
      current.setSearchResultMeta(result.truncated, result.error);
      if (result.error) {
        // An unusable pattern keeps the current page: show the inline error
        // instead of pretending there is a first hit to jump to.
        current.setCurrentMatchIndex(-1);
        current.setSearchResultsOpen(true);
        return;
      }
      if (result.matches.length > 0) {
        // Jump straight to the first match so Enter/↓ continues from it
        // instead of skipping to match #2.
        goTo(0);
        current.setSearchResultsOpen(true);
        return;
      }
      current.setCurrentMatchIndex(-1);
      // A panel the user opened stays open so it can say `No matches`.
    },
    [cancelBuild, ensureIndex, goTo],
  );

  const setQuery = useCallback(
    async (query: string) => {
      usePdfStore.getState().setSearchQuery(query);
      await runSearch(query);
    },
    [runSearch],
  );

  const setOptions = useCallback(
    async (options: Partial<SearchOptions>) => {
      usePdfStore.getState().setSearchOptions(options);
      // Re-running from the cached index is the whole point: toggling Aa/W/.*
      // must never rebuild the text index.
      await runSearch(usePdfStore.getState().searchQuery);
    },
    [runSearch],
  );

  const refresh = useCallback(async () => {
    await runSearch(usePdfStore.getState().searchQuery);
  }, [runSearch]);

  const next = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex + 1);
  }, [goTo]);

  const prev = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex - 1);
  }, [goTo]);

  const clear = useCallback(() => {
    // Cancel first so a running index build is abandoned, then reset the
    // search state (which also drops the progress row).
    searchRunRef.current += 1; // drop any run still waiting on the build
    cancelBuild();
    usePdfStore.getState().clearSearch();
  }, [cancelBuild]);

  return { setQuery, setOptions, refresh, next, prev, goToMatch: goTo, clear };
}
