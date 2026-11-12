import { describeFilterCriteria } from '../../services/filter-summary';
import { countFilteredChanges } from '../../services/diff-view';
import { formatRawRef } from '../Raw/RawValueView';
import { DEFAULT_LOCALE } from '../../i18n/locales';
import {
  translate,
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import { useAuditStore } from '../../store/audit-store';
import { useCursorStore, type CursorPdfPoint } from '../../store/cursor-store';
import { useDiffStore } from '../../store/diff-store';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore, type RawTab } from '../../store/raw-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import type { PageData } from '../../types/pdf-objects';
import type { RawDocument, RawObject, RawPageContent, RawRef } from '../../types/raw-pdf';
import styles from './StatusBar.module.css';

/**
 * English translator for helpers called directly by unit tests and other plain
 * callers. The bar passes its own `useT()` translator.
 */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

const formatCoordinate = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/** Cursor position in PDF points; the status bar intentionally stays in pt. */
export const formatCursorPoint = (point: CursorPdfPoint): string =>
  `${formatCoordinate(point.x)}, ${formatCoordinate(point.y)} pt`;

/** Compact page summary: size plus the /Rotate value the Page tab reports. */
export const formatPageGeometry = (
  page: PageData,
  t: TranslateFn = defaultTranslate,
): string =>
  t('status.pageGeometry', {
    width: formatCoordinate(page.width),
    height: formatCoordinate(page.height),
    rotation: page.rotation ?? 0,
  });

/**
 * `1 error` / `2 errors`: the bar reads as prose, so a count of one must not be
 * followed by a plural noun. Uncountable nouns pass their own plural form
 * (`plural(2, 'info', 'info')` -> `2 info`).
 */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * One/other form of a count through a `TranslateFn`.
 *
 * `translatePlural` needs the locale, which a translator does not carry; both
 * catalogs define the `one` and `other` suffix, and the shipped locales only
 * use those two categories, so the comparison is exact here.
 */
const countKey = (count: number, one: MessageKey, other: MessageKey): MessageKey =>
  count === 1 ? one : other;

/** Right-hand end of the bar: flexible spacer plus the sidecar indicator. */
const StatusTail: React.FC<{ sidecarRunning: boolean }> = ({ sidecarRunning }) => {
  const t = useT();
  return (
    <>
      <span className={styles.spacer} />
      <span className={sidecarRunning ? styles.connected : styles.offline}>
        <span className={styles.indicator} aria-hidden="true" />
        {t(sidecarRunning ? 'status.sidecarConnected' : 'status.sidecarOffline')}
      </span>
    </>
  );
};

/**
 * Startup session restore progress and outcome (Q3).
 *
 * The restore runs unattended after the shell paints, so the only place it can
 * report is the status bar: a live `Restoring n/m documents…` line while it
 * works, then a dismissible warning when some saved documents were skipped. The
 * failure copy deliberately carries a count only — the store keeps names and
 * kinds but no paths, and the notice must never leak a location either.
 *
 * A fatal run error (a broken plan, not a per-document skip) reuses the same
 * dismissible shape with the danger styling already used for other errors.
 */
const SessionRestoreNotice: React.FC = () => {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const restoring = useSessionRestoreStore((state) => state.restoring);
  const done = useSessionRestoreStore((state) => state.done);
  const total = useSessionRestoreStore((state) => state.total);
  const failed = useSessionRestoreStore((state) => state.failed);
  const error = useSessionRestoreStore((state) => state.error);
  const dismiss = useSessionRestoreStore((state) => state.dismiss);

  if (restoring) {
    return (
      <span className={styles.documentStatus} role="status" aria-live="polite">
        {t('status.sessionRestore.progress', { done, total })}
      </span>
    );
  }

  if (!error && failed.length === 0) return null;

  const message = error
    ? t('status.sessionRestore.error', { error })
    : translatePlural(locale, 'status.sessionRestore.failed', failed.length);

  return (
    <span
      className={`${styles.notice} ${error ? styles.noticeError : styles.noticeWarning}`}
      role="alert"
    >
      <span className={styles.noticeText}>{message}</span>
      <button className={styles.noticeDismiss} type="button" onClick={dismiss}>
        {t('common.dismiss')}
      </button>
    </span>
  );
};

/** The parts of `raw-store` the raw status line describes. */
export interface RawStatusSnapshot {
  document: RawDocument | null;
  tab: RawTab;
  selected: RawRef | null;
  object: RawObject | null;
  content: RawPageContent | null;
  contentPage: number | null;
  loading: boolean;
}

/**
 * One line for the Raw workspace: the selected object, or the page and its
 * operator count. The Inspect selection, filters and cursor are deliberately
 * absent — they describe a document the user cannot see while Raw is open.
 *
 * The bar passes its translator; the English default keeps the helper callable
 * from plain tests and future non-React callers. Values from the sidecar (the
 * object summary) stay exactly as reported.
 */
export function formatRawStatus(
  snapshot: RawStatusSnapshot,
  t: TranslateFn = defaultTranslate,
): string {
  const { document, tab, selected, object, content, contentPage, loading } = snapshot;

  if (!document) return t(loading ? 'status.raw.loading' : 'status.raw.noDocument');

  if (tab === 'content') {
    const page = contentPage ?? 1;
    const shown = content !== null && content.page === page ? content : null;
    if (!shown) {
      return t(loading ? 'status.raw.pageLoading' : 'status.raw.page', {
        page,
        count: document.pages,
      });
    }
    const operators = shown.streams.reduce((total, stream) => total + stream.operators.length, 0);
    return t('status.raw.pageOperators', {
      page: shown.page,
      count: document.pages,
      operators: t(countKey(operators, 'status.raw.operatorCount.one', 'status.raw.operatorCount.other'), {
        count: operators,
      }),
    });
  }

  if (!selected) return t('status.raw.noObject');
  const ref = formatRawRef(selected);
  if (object) return t('status.raw.object', { ref, summary: object.summary });
  return loading ? t('status.raw.objectLoading', { ref }) : t('status.raw.objectRef', { ref });
}

export const StatusBar = (): JSX.Element => {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const isLoading = usePdfStore((state) => state.isLoading);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageCount = usePdfStore((state) => state.pageCount);
  const objectCount = usePdfStore((state) => state.allObjects.length);
  const sidecarRunning = usePdfStore((state) => state.sidecarRunning);
  const exportProgress = usePdfStore((state) => state.exportProgress);
  const fontProgress = usePdfStore((state) => state.fontProgress);
  const error = usePdfStore((state) => state.error);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const setFilterCriteria = usePdfStore((state) => state.setFilterCriteria);
  const pageData = usePdfStore((state) => state.pageData);
  const cursorPdfPoint = useCursorStore((state) => state.cursorPdfPoint);
  const filterSummary = describeFilterCriteria(filterCriteria, t);

  // In Diff mode the status bar describes the comparison instead of the
  // Inspect document, which stays open but is not what the user is looking at.
  const diffActive = useDiffStore((state) => state.active);
  const diffResult = useDiffStore((state) => state.result);
  const diffPageIndex = useDiffStore((state) => state.pageIndex);
  const diffFilter = useDiffStore((state) => state.filter);
  const diffLoading = useDiffStore((state) => state.loading);
  const diffChangeCount = diffResult ? countFilteredChanges(diffResult.pages, diffFilter) : 0;

  // Audit replaces the Inspect panes the same way Diff does, so the bar reports
  // the audit run instead of the document the user cannot see.
  const auditActive = useAuditStore((state) => state.active);
  const auditLoading = useAuditStore((state) => state.loading);
  const auditProgress = useAuditStore((state) => state.progress);
  const auditReport = useAuditStore((state) => state.report);
  const auditError = useAuditStore((state) => state.error);

  // Raw is the third workspace that replaces the Inspect panes; its line
  // reports the object tree or the page content instead of the document.
  const rawActive = useRawStore((state) => state.active);
  const rawDocument = useRawStore((state) => state.document);
  const rawTab = useRawStore((state) => state.tab);
  const rawSelected = useRawStore((state) => state.selected);
  const rawObject = useRawStore((state) => state.object);
  const rawContent = useRawStore((state) => state.content);
  const rawContentPage = useRawStore((state) => state.contentPage);
  const rawLoading = useRawStore((state) => state.loading);
  const rawError = useRawStore((state) => state.error);

  if (diffActive) {
    return (
      <footer className={styles.statusBar} aria-label={t('status.application')}>
        <span className={styles.documentStatus}>
          {diffLoading
            ? t('status.diff.comparing')
            : diffResult
              ? t('status.diff.page', {
                  page: diffPageIndex + 1,
                  count: diffResult.pages.length,
                  changes: translatePlural(locale, 'status.diff.changeCount', diffChangeCount),
                })
              : t('status.diff.noComparison')}
        </span>
        {diffResult && (
          <span className={styles.pageGeometry}>
            {t('status.diff.pages', { old: diffResult.old.pages, new: diffResult.new.pages })}
          </span>
        )}
        <SessionRestoreNotice />
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  if (auditActive) {
    const auditSummary = auditReport?.summary;
    return (
      <footer className={styles.statusBar} aria-label={t('status.application')}>
        <span className={styles.documentStatus} data-testid="status-audit">
          {auditProgress
            ? t('status.audit.progress', {
                done: auditProgress.done,
                total: auditProgress.total,
              })
            : auditSummary
              ? t('status.audit.summary', {
                  errors: translatePlural(locale, 'status.audit.errorCount', auditSummary.errors),
                  warnings: translatePlural(
                    locale,
                    'status.audit.warningCount',
                    auditSummary.warnings,
                  ),
                  info: translatePlural(locale, 'status.audit.infoCount', auditSummary.info),
                })
              : auditLoading
                ? t('status.audit.running')
                : t('status.audit.noReport')}
        </span>
        {auditError && (
          <span className={styles.error} role="alert">
            {t('status.audit.failed', { error: auditError })}
          </span>
        )}
        <SessionRestoreNotice />
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  if (rawActive) {
    return (
      <footer className={styles.statusBar} aria-label={t('status.application')}>
        <span className={styles.documentStatus} data-testid="status-raw">
          {formatRawStatus(
            {
              document: rawDocument,
              tab: rawTab,
              selected: rawSelected,
              object: rawObject,
              content: rawContent,
              contentPage: rawContentPage,
              loading: rawLoading,
            },
            t,
          )}
        </span>
        {rawError && (
          <span className={styles.error} role="alert">
            {t('status.raw.failed', { error: rawError })}
          </span>
        )}
        <SessionRestoreNotice />
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  return (
    <footer className={styles.statusBar} aria-label={t('status.application')}>
      <span className={styles.documentStatus}>
        {isLoading
          ? t('common.loading')
          : t('status.document', {
              page: currentPage,
              count: pageCount,
              objects: translatePlural(locale, 'status.objectCount', objectCount),
            })}
      </span>
      {pageData && (
        <span
          className={styles.pageGeometry}
          title={t('status.pageSize', { geometry: formatPageGeometry(pageData, t) })}
        >
          {formatPageGeometry(pageData, t)}
        </span>
      )}
      {cursorPdfPoint && (
        <span
          className={styles.cursorPosition}
          role="group"
          aria-label={t('status.cursor', { cursor: formatCursorPoint(cursorPdfPoint) })}
        >
          {formatCursorPoint(cursorPdfPoint)}
        </span>
      )}
      {/* No selection means no placeholder: the bar only grows when there is
          something to report. `aria-label` on a plain span is unreliable across
          ATs, so the summary is an explicit named group instead. */}
      {selectedObject && (
        <span
          className={styles.selectionSummary}
          role="group"
          aria-label={t('status.selected', {
            type: selectedObject.type,
            page: selectedObject.page,
          })}
        >
          <span className={styles.selectionType}>{selectedObject.type}</span>
          <span>{t('status.pageShort', { page: selectedObject.page })}</span>
        </span>
      )}
      {filterSummary.count > 0 && (
        <span
          className={styles.filterSummary}
          role="group"
          title={t('status.filterTooltip', { summary: filterSummary.label })}
          aria-label={t('status.activeFilters', { summary: filterSummary.label })}
        >
          <span className={styles.filterLabel}>{t('status.filter')}</span>
          <span className={styles.filterText}>{filterSummary.label}</span>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => setFilterCriteria({})}
          >
            {t('status.clearFilter')}
          </button>
        </span>
      )}
      {exportProgress && (
        <span className={styles.documentStatus}>
          {t('status.exportProgress', {
            done: exportProgress.done,
            total: exportProgress.total,
          })}
        </span>
      )}
      {/* The Fonts tab keeps analyzing while another tab is active, so the run
          has to stay visible here and not only inside that panel. */}
      {fontProgress && (
        <span className={styles.documentStatus} role="status" aria-live="polite">
          {t('status.fontProgress', { done: fontProgress.done, total: fontProgress.total })}
        </span>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {t('common.errorDetail', { error })}
        </span>
      )}
      <SessionRestoreNotice />
      <StatusTail sidecarRunning={sidecarRunning} />
    </footer>
  );
};
