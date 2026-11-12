import React, { useCallback, useEffect, useRef } from 'react';
import {
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import {
  MAX_SEARCH_MATCHES,
  type SearchMatch,
  type SearchOptions,
} from '../../services/pdf-search';
import { usePdfStore } from '../../store/pdf-store';
import styles from './SearchResultsPanel.module.css';

/** Shared with SearchBox so the Results button can point `aria-controls` at it. */
export const SEARCH_RESULTS_PANEL_ID = 'search-results-panel';

export interface SearchResultsPanelProps {
  /** Jump to a match. The panel wraps the index into range before calling. */
  onSelect: (index: number) => void;
  /** Hide the panel; the search box itself stays open. */
  onClose: () => void;
  /** Merge one option toggle and re-run the current query. */
  onSetOptions: (options: Partial<SearchOptions>) => void;
}

interface OptionToggle {
  key: keyof SearchOptions;
  /** The visible glyph is a search convention and stays the same in both locales. */
  glyph: string;
  nameKey: MessageKey;
  titleKey: MessageKey;
}

const OPTION_TOGGLES: readonly OptionToggle[] = [
  {
    key: 'caseSensitive',
    glyph: 'Aa',
    nameKey: 'search.matchCase',
    titleKey: 'search.matchCase',
  },
  { key: 'wholeWord', glyph: 'W', nameKey: 'search.wholeWord', titleKey: 'search.wholeWord' },
  { key: 'regex', glyph: '.*', nameKey: 'search.regex', titleKey: 'search.regex' },
];

/**
 * Hits produced before previews existed (or by another caller) still need a
 * readable row, so fall back to the offset inside the page text.
 */
function previewText(match: SearchMatch, t: TranslateFn): string {
  const preview = match.preview?.trim();
  return preview && preview.length > 0
    ? preview
    : t('search.matchAt', { offset: match.begin + 1 });
}

/**
 * Dropdown listing every search hit with its page and surrounding text.
 *
 * A hit is chosen with the mouse or ↑/↓; picking one navigates and closes the
 * list while the search box stays open. The panel reads the match list straight
 * from the store so a new query updates it without extra plumbing.
 */
export const SearchResultsPanel: React.FC<SearchResultsPanelProps> = ({
  onSelect,
  onClose,
  onSetOptions,
}) => {
  const matches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);
  const options = usePdfStore((s) => s.searchOptions);
  const truncated = usePdfStore((s) => s.searchTruncated);
  const error = usePdfStore((s) => s.searchError);
  const progress = usePdfStore((s) => s.searchIndexProgress);
  const locale = useI18nStore((s) => s.locale);
  const t = useT();
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the active hit visible while ↑/↓ or Enter move through the list. jsdom
  // has no layout engine (and no scrollIntoView), hence the optional call.
  useEffect(() => {
    if (currentMatchIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-match-index="${currentMatchIndex}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [currentMatchIndex, matches]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Consume the first Escape here so the app-level handler does not also
        // clear the document selection behind the closing panel.
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (matches.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // From "no current hit" ↓ starts at the first row and ↑ at the last.
      const from = currentMatchIndex < 0 ? (delta > 0 ? -1 : 0) : currentMatchIndex;
      const next = (((from + delta) % matches.length) + matches.length) % matches.length;
      onSelect(next);
    },
    [matches.length, currentMatchIndex, onClose, onSelect],
  );

  const toggleOption = useCallback(
    (key: keyof SearchOptions) => {
      onSetOptions({ [key]: !options[key] });
    },
    [onSetOptions, options],
  );

  return (
    <div
      id={SEARCH_RESULTS_PANEL_ID}
      className={styles.panel}
      role="dialog"
      aria-label={t('search.results')}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <span className={styles.title}>{t('search.resultsHeading')}</span>
        {OPTION_TOGGLES.map(({ key, glyph, nameKey, titleKey }) => (
          <button
            key={key}
            type="button"
            className={styles.toggle}
            aria-pressed={options[key]}
            aria-label={t(nameKey)}
            title={t(titleKey)}
            onClick={() => toggleOption(key)}
          >
            {glyph}
          </button>
        ))}
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={t('search.closeResults')}
          title={t('search.closeResultsTitle')}
        >
          ✕
        </button>
      </div>

      <div className={styles.body}>
        {error !== null ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <>
            {progress && (
              <p className={styles.status} role="status">
                {t('search.indexing', { done: progress.done, total: progress.total })}
              </p>
            )}
            {matches.length === 0
              ? !progress && <p className={styles.empty}>{t('search.noMatches')}</p>
              : (
                <ul className={styles.list} ref={listRef}>
                  {matches.map((match, index) => {
                    const active = index === currentMatchIndex;
                    return (
                      <li key={`${match.page}:${match.begin}:${index}`} className={styles.row}>
                        <button
                          type="button"
                          className={styles.entry}
                          data-match-index={index}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            onSelect(index);
                            onClose();
                          }}
                        >
                          <span className={styles.page}>
                            {t('search.pageShort', { page: match.page })}
                          </span>
                          <span className={styles.preview}>{previewText(match, t)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            {truncated && (
              <p className={styles.truncated}>
                {translatePlural(locale, 'search.truncated', MAX_SEARCH_MATCHES, {
                  limit: MAX_SEARCH_MATCHES.toLocaleString(locale),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
