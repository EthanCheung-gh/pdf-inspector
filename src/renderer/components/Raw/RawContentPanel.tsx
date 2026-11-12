import React, { useCallback, useEffect, useState } from 'react';
import { translatePlural, useI18nStore, useT } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import type { RawContentOperator, RawContentStream, RawRef } from '../../types/raw-pdf';
import { formatRawRef, RawValueView } from './RawValueView';
import styles from './RawWorkspace.module.css';

/** Keep a page number inside `1..pages`; a document without pages keeps page 1. */
export function clampRawPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 1;
  const rounded = Math.round(page);
  if (pages <= 0) return 1;
  return Math.min(Math.max(1, rounded), pages);
}

/** Every operator of a page content, for the status bar and the panel header. */
export function countContentOperators(streams: RawContentStream[]): number {
  return streams.reduce((total, stream) => total + stream.operators.length, 0);
}

const StreamSection: React.FC<{
  stream: RawContentStream;
  index: number;
  onSelectRef: (ref: RawRef) => void;
}> = ({ stream, index, onSelectRef }) => {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const name = stream.ref ? formatRawRef(stream.ref) : `${index + 1}`;

  return (
    <section className={styles.stream} aria-label={t('raw.content.streamAria', { name })}>
      <header className={styles.streamHeader}>
        <span className={styles.streamTitle}>{t('raw.content.streamTitle', { name })}</span>
        <span className={styles.streamMeta}>
          {stream.length === null ? t('raw.lengthUnknown') : `${stream.length} B`}
        </span>
        <span className={styles.streamMeta}>
          {stream.filters.length > 0 ? stream.filters.join(', ') : t('raw.noFilter')}
        </span>
        <span className={styles.streamMeta}>
          {translatePlural(locale, 'raw.count.operator', stream.operators.length)}
        </span>
      </header>

      {stream.error !== null && (
        <p className={styles.errorBlock} role="alert">
          {t('raw.content.decodeFailed', { error: stream.error })}
        </p>
      )}

      {stream.truncated && (
        <p className={styles.notice} data-testid="raw-content-truncated">
          {t('raw.content.streamTruncated')}
        </p>
      )}

      {stream.operators.length === 0 ? (
        <p className={styles.empty}>{t('raw.content.noOperators')}</p>
      ) : (
        // A plain table: operators are read, never executed, and the operand
        // column is the same read-only value renderer as the object panel.
        <table className={styles.operatorTable}>
          <caption className={styles.visuallyHidden}>
            {t('raw.content.tableCaption', { name })}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.indexCell}>#</th>
              <th scope="col" className={styles.offsetCell}>
                {t('raw.content.columnOffset')}
              </th>
              <th scope="col" className={styles.operatorCell}>
                {t('raw.content.columnOperator')}
              </th>
              <th scope="col">{t('raw.content.columnOperands')}</th>
            </tr>
          </thead>
          <tbody>
            {stream.operators.map((operator: RawContentOperator) => (
              <tr key={operator.index}>
                <td className={styles.indexCell}>{operator.index}</td>
                <td className={styles.offsetCell}>{operator.offset}</td>
                <td className={styles.operatorCell}>
                  <code>{operator.operator}</code>
                </td>
                <td>
                  {operator.operands.length === 0 ? (
                    <span className={styles.streamMeta}>—</span>
                  ) : (
                    operator.operands.map((operand, operandIndex) => (
                      <RawValueView
                        key={operandIndex}
                        value={operand}
                        onSelectRef={onSelectRef}
                      />
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

/**
 * Decoded content streams of one page.
 *
 * The panel owns only the page selector; the page content itself lives in
 * `raw-store` (cached per page and guarded against stale responses), so
 * switching back to a page never re-asks the sidecar. The default page is the
 * page the Inspect viewport is on, which is what the developer is looking at
 * before entering Raw.
 */
export const RawContentPanel: React.FC = () => {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const document = useRawStore((state) => state.document);
  const content = useRawStore((state) => state.content);
  const contentPage = useRawStore((state) => state.contentPage);
  const loading = useRawStore((state) => state.loading);
  const error = useRawStore((state) => state.error);
  const currentPdfPage = usePdfStore((state) => state.currentPage);

  const pages = document?.pages ?? 0;
  const [page, setPage] = useState<number>(() =>
    clampRawPage(contentPage ?? currentPdfPage, document?.pages ?? 0),
  );

  // Load exactly once per page: a cached page (or a request already in flight
  // for this page) is left to the store. A document without pages has nothing
  // to read, so it never asks the sidecar.
  useEffect(() => {
    if (pages === 0) return;
    const state = useRawStore.getState();
    if (state.content !== null && state.content.page === page) return;
    if (state.contentPage === page && state.loading) return;
    state.loadContent(page);
  }, [page, pages]);

  const handleSelectRef = useCallback((ref: RawRef): void => {
    const store = useRawStore.getState();
    store.select(ref);
    // The referenced object lives on the Object tab, so show it there.
    store.setTab('object');
  }, []);

  /**
   * The explicit "read this page again" action. It must bypass the per-page
   * cache: `loadContent` would answer a cached page without a request, which
   * made Reload/Retry inert the moment a page had been read once.
   */
  const handleReload = useCallback((): void => {
    useRawStore.getState().reloadContent(page);
  }, [page]);

  if (!document || pages === 0) {
    return (
      <section
        className={styles.panel}
        aria-label={t('raw.content.aria')}
        data-testid="raw-content-panel"
      >
        <p className={styles.empty} data-testid="raw-content-empty">
          {t('raw.content.noPages')}
        </p>
      </section>
    );
  }

  const shown = content !== null && content.page === page ? content : null;
  const operatorCount = shown ? countContentOperators(shown.streams) : 0;

  return (
    <section
      className={styles.panel}
      aria-label={t('raw.content.aria')}
      data-testid="raw-content-panel"
    >
      <header className={styles.panelHeader}>
        <label className={styles.pagePicker}>
          {t('raw.content.page')}
          <select
            className={styles.select}
            aria-label={t('raw.content.pageAria')}
            value={page}
            onChange={(event) => setPage(clampRawPage(Number(event.target.value), pages))}
          >
            {Array.from({ length: pages }, (_value, index) => (
              <option key={index + 1} value={index + 1}>
                {index + 1}
              </option>
            ))}
          </select>
          <span className={styles.streamMeta}>{t('raw.content.ofPages', { count: pages })}</span>
        </label>

        <span className={styles.panelSummary} data-testid="raw-content-summary">
          {shown
            ? t('raw.content.summary', {
                page: shown.page,
                count: pages,
                streams: translatePlural(locale, 'raw.count.stream', shown.streams.length),
                operators: translatePlural(locale, 'raw.count.operator', operatorCount),
              })
            : t('raw.content.summaryLoading', { page, count: pages })}
        </span>

        <span className={styles.spacer} />

        <button className={styles.button} type="button" onClick={handleReload} disabled={loading}>
          {t('raw.content.reloadPage')}
        </button>
      </header>

      <div className={styles.panelBody}>
        {error && !shown && (
          <div className={styles.errorBlock} role="alert">
            <span className={styles.errorText}>
              {t('raw.content.readFailed', { page, error })}
            </span>
            <button className={styles.button} type="button" onClick={handleReload}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {!shown && !error && (
          <p className={styles.loading} role="status" aria-live="polite">
            {t('raw.content.reading', { page })}
          </p>
        )}

        {shown && shown.streams.length === 0 && (
          <p className={styles.empty} data-testid="raw-content-empty">
            {t('raw.content.emptyPage', { page: shown.page })}
          </p>
        )}

        {shown && shown.truncated && (
          <p className={styles.notice} data-testid="raw-content-page-truncated">
            {t('raw.content.pageTruncated')}
          </p>
        )}

        {shown?.streams.map((stream, index) => (
          <StreamSection
            key={stream.ref ? formatRawRef(stream.ref) : `stream-${index}`}
            stream={stream}
            index={index}
            onSelectRef={handleSelectRef}
          />
        ))}
      </div>
    </section>
  );
};
