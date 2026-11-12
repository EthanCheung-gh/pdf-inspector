import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { usePdfSearch } from '../../hooks/usePdfSearch';
import type { SearchOptions } from '../../services/pdf-search';
import { usePdfStore } from '../../store/pdf-store';
import { SEARCH_RESULTS_PANEL_ID, SearchResultsPanel } from './SearchResultsPanel';
import styles from './SearchBox.module.css';

const DEBOUNCE_MS = 300;

export const SearchBox: React.FC = () => {
  const t = useT();
  const searchOpen = usePdfStore((s) => s.searchOpen);
  const setSearchOpen = usePdfStore((s) => s.setSearchOpen);
  const searchMatches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);
  const searchIndexProgress = usePdfStore((s) => s.searchIndexProgress);
  const searchQuery = usePdfStore((s) => s.searchQuery);
  const searchResultsOpen = usePdfStore((s) => s.searchResultsOpen);
  const setSearchResultsOpen = usePdfStore((s) => s.setSearchResultsOpen);
  const pageCount = usePdfStore((s) => s.pageCount);
  const { setQuery, setOptions, next, prev, goToMatch, clear } = usePdfSearch();

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => () => window.clearTimeout(debounceRef.current), []);

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => void setQuery(value), DEBOUNCE_MS);
    },
    [setQuery],
  );

  const handleClose = useCallback(() => {
    window.clearTimeout(debounceRef.current);
    setDraft('');
    // Dropping the popover is part of closing: `clear()` also resets it through
    // the store, but the box must never leave a stray list behind on its own.
    setSearchResultsOpen(false);
    clear();
    setSearchOpen(false);
  }, [clear, setSearchOpen, setSearchResultsOpen]);

  const handleSetOptions = useCallback(
    (options: Partial<SearchOptions>) => {
      void setOptions(options);
    },
    [setOptions],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) {
          prev();
        } else {
          next();
        }
        return;
      }
      if (event.key === 'Escape') {
        // Escape peels one layer at a time: results first, then the search box.
        // Stopping here also keeps the app-level Escape from clearing the
        // document selection behind the layer that just closed.
        event.stopPropagation();
        if (searchResultsOpen) {
          setSearchResultsOpen(false);
          return;
        }
        handleClose();
      }
    },
    [next, prev, handleClose, searchResultsOpen, setSearchResultsOpen],
  );

  if (!searchOpen) {
    return (
      <button
        className={styles.button}
        type="button"
        onClick={() => setSearchOpen(true)}
        disabled={pageCount === 0}
        aria-label={t('search.open')}
        title={t('search.openTitle')}
      >
        🔍
      </button>
    );
  }

  const countLabel =
    searchMatches.length === 0 ? '0/0' : `${currentMatchIndex + 1}/${searchMatches.length}`;
  // While the batched text index is building, the count slot reports progress
  // instead of a misleading 0/0. It is the same single slot with a reserved
  // width, so the toolbar does not reflow when indexing finishes.
  const statusLabel = searchIndexProgress
    ? t('search.indexing', {
        done: searchIndexProgress.done,
        total: searchIndexProgress.total,
      })
    : countLabel;

  return (
    <div className={styles.searchBox} role="search" aria-label={t('search.region')}>
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={draft}
        placeholder={t('search.input')}
        aria-label={t('search.inputLabel')}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.count} role="status" aria-live="polite" aria-atomic="true">
        {statusLabel}
      </span>
      <button
        className={`${styles.button}${searchResultsOpen ? ` ${styles.buttonActive}` : ''}`}
        type="button"
        onClick={() => setSearchResultsOpen(!searchResultsOpen)}
        // Nothing to list until a query exists; matches drive the open state.
        disabled={searchQuery.trim().length === 0}
        aria-label={t('search.results')}
        aria-expanded={searchResultsOpen}
        aria-controls={searchResultsOpen ? SEARCH_RESULTS_PANEL_ID : undefined}
        title={t('search.resultsTitle')}
      >
        ≡
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={prev}
        disabled={searchMatches.length === 0}
        aria-label={t('search.prev')}
        title={t('search.prevTitle')}
      >
        ↑
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={next}
        disabled={searchMatches.length === 0}
        aria-label={t('search.next')}
        title={t('search.nextTitle')}
      >
        ↓
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={handleClose}
        aria-label={t('search.close')}
        title={t('search.closeTitle')}
      >
        ✕
      </button>
      {searchResultsOpen && (
        <SearchResultsPanel
          onSelect={goToMatch}
          onClose={() => setSearchResultsOpen(false)}
          onSetOptions={handleSetOptions}
        />
      )}
    </div>
  );
};
