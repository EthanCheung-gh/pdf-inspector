import { useCallback, useEffect, useRef } from 'react';
import { buildPageText, findMatches } from '../services/pdf-search';
import { usePdfStore } from '../store/pdf-store';
import { usePageNavigation } from './usePageNavigation';

export interface UsePdfSearchReturn {
  setQuery: (query: string) => Promise<void>;
  next: () => void;
  prev: () => void;
  clear: () => void;
}

export function usePdfSearch(): UsePdfSearchReturn {
  const pageTextsRef = useRef<string[] | null>(null);
  const buildIdRef = useRef(0);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const { navigate } = usePageNavigation();

  // Invalidate the index whenever a different document is loaded.
  useEffect(() => {
    pageTextsRef.current = null;
    buildIdRef.current += 1;
  }, [pdfDocRef]);

  const ensureIndex = useCallback(async (): Promise<string[] | null> => {
    if (pageTextsRef.current) return pageTextsRef.current;
    const doc = usePdfStore.getState().pdfDocRef;
    if (!doc) return null;

    const buildId = ++buildIdRef.current;
    const texts: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        if (buildId !== buildIdRef.current) return null; // stale build
        texts.push(buildPageText(content.items.map((item) => ('str' in item ? item.str : ''))));
      } catch (err) {
        console.warn(`Search index: skipped page ${p}:`, err);
        texts.push('');
      }
    }
    if (buildId !== buildIdRef.current) return null;
    pageTextsRef.current = texts;
    return texts;
  }, []);

  const setQuery = useCallback(
    async (query: string) => {
      const store = usePdfStore.getState();
      store.setSearchQuery(query);
      if (query.trim().length === 0) {
        store.setSearchMatches([]);
        store.setCurrentMatchIndex(-1);
        return;
      }
      const texts = await ensureIndex();
      if (!texts) return;
      // The user kept typing while the index was building; drop stale results.
      if (usePdfStore.getState().searchQuery !== query) return;
      const matches = findMatches(texts, query);
      store.setSearchMatches(matches);
      store.setCurrentMatchIndex(matches.length > 0 ? 0 : -1);
    },
    [ensureIndex],
  );

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

  const next = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex + 1);
  }, [goTo]);

  const prev = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex - 1);
  }, [goTo]);

  const clear = useCallback(() => {
    usePdfStore.getState().clearSearch();
  }, []);

  return { setQuery, next, prev, clear };
}
