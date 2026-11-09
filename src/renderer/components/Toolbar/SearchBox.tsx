import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePdfSearch } from '../../hooks/usePdfSearch';
import { usePdfStore } from '../../store/pdf-store';
import styles from './SearchBox.module.css';

const DEBOUNCE_MS = 300;

export const SearchBox: React.FC = () => {
  const searchOpen = usePdfStore((s) => s.searchOpen);
  const setSearchOpen = usePdfStore((s) => s.setSearchOpen);
  const searchMatches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);
  const searchIndexProgress = usePdfStore((s) => s.searchIndexProgress);
  const pageCount = usePdfStore((s) => s.pageCount);
  const { setQuery, next, prev, clear } = usePdfSearch();

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
    clear();
    setSearchOpen(false);
  }, [clear, setSearchOpen]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) {
          prev();
        } else {
          next();
        }
      } else if (event.key === 'Escape') {
        handleClose();
      }
    },
    [next, prev, handleClose],
  );

  if (!searchOpen) {
    return (
      <button
        className={styles.button}
        type="button"
        onClick={() => setSearchOpen(true)}
        disabled={pageCount === 0}
        aria-label="Search"
        title="Search (Ctrl+F)"
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
    ? `Indexing ${searchIndexProgress.done}/${searchIndexProgress.total}…`
    : countLabel;

  return (
    <div className={styles.searchBox} role="search" aria-label="Document search">
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={draft}
        placeholder="Search…"
        aria-label="Search document"
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.count} role="status" aria-live="polite" aria-atomic="true">
        {statusLabel}
      </span>
      <button
        className={styles.button}
        type="button"
        onClick={prev}
        disabled={searchMatches.length === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={next}
        disabled={searchMatches.length === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={handleClose}
        aria-label="Close search"
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
};
