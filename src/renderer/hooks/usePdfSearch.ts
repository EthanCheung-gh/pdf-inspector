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
  const buildIdRef = useRef(0);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const { navigate } = usePageNavigation();

  // Invalidate the index whenever a different document is loaded.
  useEffect(() => {
    pageTextsRef.current = null;
    pageTextsPromiseRef.current = null;
    buildIdRef.current += 1;
  }, [pdfDocRef]);

  const ensureIndex = useCallback((): Promise<string[] | null> => {
    if (pageTextsRef.current) return Promise.resolve(pageTextsRef.current);
    // Coalesce concurrent callers onto a single in-flight build.
    if (pageTextsPromiseRef.current) return pageTextsPromiseRef.current;
    const doc = usePdfStore.getState().pdfDocRef;
    if (!doc) return Promise.resolve(null);

    const buildId = ++buildIdRef.current;
    const promise = (async (): Promise<string[] | null> => {
      const texts: string[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        try {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          if (buildId !== buildIdRef.current) return null; // stale build
          texts.push(buildPageText(textContentToStrings(content)));
        } catch (err) {
          console.warn(`Search index: skipped page ${p}:`, err);
          texts.push('');
        }
      }
      if (buildId !== buildIdRef.current) return null;
      pageTextsRef.current = texts;
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
      if (matches.length > 0) {
        // Jump straight to the first match so Enter/↓ continues from it
        // instead of skipping to match #2.
        goTo(0);
      } else {
        store.setCurrentMatchIndex(-1);
      }
    },
    [ensureIndex, goTo],
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
