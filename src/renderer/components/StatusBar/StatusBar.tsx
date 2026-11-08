import { describeFilterCriteria } from '../../services/filter-summary';
import { countFilteredChanges } from '../../services/diff-view';
import { formatRawRef } from '../Raw/RawValueView';
import { useAuditStore } from '../../store/audit-store';
import { useCursorStore, type CursorPdfPoint } from '../../store/cursor-store';
import { useDiffStore } from '../../store/diff-store';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore, type RawTab } from '../../store/raw-store';
import type { PageData } from '../../types/pdf-objects';
import type { RawDocument, RawObject, RawPageContent, RawRef } from '../../types/raw-pdf';
import styles from './StatusBar.module.css';

const formatCoordinate = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/** Cursor position in PDF points; the status bar intentionally stays in pt. */
export const formatCursorPoint = (point: CursorPdfPoint): string =>
  `${formatCoordinate(point.x)}, ${formatCoordinate(point.y)} pt`;

/** Compact page summary: size plus the /Rotate value the Page tab reports. */
export const formatPageGeometry = (page: PageData): string =>
  `${formatCoordinate(page.width)} × ${formatCoordinate(page.height)} pt · rot ${page.rotation ?? 0}°`;

/**
 * `1 error` / `2 errors`: the bar reads as prose, so a count of one must not be
 * followed by a plural noun. Uncountable nouns pass their own plural form
 * (`plural(2, 'info', 'info')` -> `2 info`).
 */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** Right-hand end of the bar: flexible spacer plus the sidecar indicator. */
const StatusTail: React.FC<{ sidecarRunning: boolean }> = ({ sidecarRunning }) => (
  <>
    <span className={styles.spacer} />
    <span className={sidecarRunning ? styles.connected : styles.offline}>
      <span className={styles.indicator} aria-hidden="true" />
      Sidecar {sidecarRunning ? 'connected' : 'offline'}
    </span>
  </>
);

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
 */
export function formatRawStatus(snapshot: RawStatusSnapshot): string {
  const { document, tab, selected, object, content, contentPage, loading } = snapshot;

  if (!document) return loading ? 'Raw: loading document…' : 'Raw: no document';

  if (tab === 'content') {
    const page = contentPage ?? 1;
    const shown = content !== null && content.page === page ? content : null;
    if (!shown) {
      return `Raw: page ${page}/${document.pages}${loading ? ' · loading…' : ''}`;
    }
    const operators = shown.streams.reduce((total, stream) => total + stream.operators.length, 0);
    return `Raw: page ${shown.page}/${document.pages} · ${plural(operators, 'operator')}`;
  }

  if (!selected) return 'Raw: no object selected';
  const ref = formatRawRef(selected);
  return object
    ? `Raw: object ${ref} · ${object.summary}`
    : `Raw: object ${ref}${loading ? ' · loading…' : ''}`;
}

export const StatusBar = (): JSX.Element => {
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
  const filterSummary = describeFilterCriteria(filterCriteria);

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
      <footer className={styles.statusBar} aria-label="Application status">
        <span className={styles.documentStatus}>
          {diffLoading
            ? 'Diff: comparing documents…'
            : diffResult
              ? `Diff page ${diffPageIndex + 1}/${diffResult.pages.length} · ${diffChangeCount} changes`
              : 'Diff: no comparison yet'}
        </span>
        {diffResult && (
          <span className={styles.pageGeometry}>
            {diffResult.old.pages} vs {diffResult.new.pages} pages
          </span>
        )}
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  if (auditActive) {
    const auditSummary = auditReport?.summary;
    return (
      <footer className={styles.statusBar} aria-label="Application status">
        <span className={styles.documentStatus} data-testid="status-audit">
          {auditProgress
            ? `Audit: ${auditProgress.done}/${auditProgress.total} pages`
            : auditSummary
              ? `Audit: ${plural(auditSummary.errors, 'error')} · ${plural(auditSummary.warnings, 'warning')} · ${plural(auditSummary.info, 'info', 'info')}`
              : auditLoading
                ? 'Audit: running…'
                : 'Audit: no report yet'}
        </span>
        {auditError && (
          <span className={styles.error} role="alert">
            Audit failed: {auditError}
          </span>
        )}
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  if (rawActive) {
    return (
      <footer className={styles.statusBar} aria-label="Application status">
        <span className={styles.documentStatus} data-testid="status-raw">
          {formatRawStatus({
            document: rawDocument,
            tab: rawTab,
            selected: rawSelected,
            object: rawObject,
            content: rawContent,
            contentPage: rawContentPage,
            loading: rawLoading,
          })}
        </span>
        {rawError && (
          <span className={styles.error} role="alert">
            Raw failed: {rawError}
          </span>
        )}
        <StatusTail sidecarRunning={sidecarRunning} />
      </footer>
    );
  }

  return (
    <footer className={styles.statusBar} aria-label="Application status">
      <span className={styles.documentStatus}>
        {isLoading ? 'Loading…' : `Page ${currentPage}/${pageCount} · ${objectCount} objects`}
      </span>
      {pageData && (
        <span
          className={styles.pageGeometry}
          title={`Page size ${formatPageGeometry(pageData)}`}
        >
          {formatPageGeometry(pageData)}
        </span>
      )}
      {cursorPdfPoint && (
        <span
          className={styles.cursorPosition}
          role="group"
          aria-label={`Cursor ${formatCursorPoint(cursorPdfPoint)}`}
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
          aria-label={`Selected ${selectedObject.type} on page ${selectedObject.page}`}
        >
          <span className={styles.selectionType}>{selectedObject.type}</span>
          <span>page {selectedObject.page}</span>
        </span>
      )}
      {filterSummary.count > 0 && (
        <span
          className={styles.filterSummary}
          role="group"
          title={`Filter: ${filterSummary.label}`}
          aria-label={`Active filters: ${filterSummary.label}`}
        >
          <span className={styles.filterLabel}>Filter:</span>
          <span className={styles.filterText}>{filterSummary.label}</span>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => setFilterCriteria({})}
          >
            Clear
          </button>
        </span>
      )}
      {exportProgress && (
        <span className={styles.documentStatus}>
          Exporting {exportProgress.done}/{exportProgress.total}…
        </span>
      )}
      {/* The Fonts tab keeps analyzing while another tab is active, so the run
          has to stay visible here and not only inside that panel. */}
      {fontProgress && (
        <span className={styles.documentStatus} role="status" aria-live="polite">
          Analyzing fonts {fontProgress.done}/{fontProgress.total}…
        </span>
      )}
      {error && <span className={styles.error} role="alert">Error: {error}</span>}
      <StatusTail sidecarRunning={sidecarRunning} />
    </footer>
  );
};
