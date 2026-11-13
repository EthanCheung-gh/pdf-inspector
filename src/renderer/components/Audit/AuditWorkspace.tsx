import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  type AuditBaselineComparison,
  type AuditBaselineCounts,
  type AuditBaselineStatus,
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
} from '../../../shared/audit-types';
import { auditBaselineStatuses, isAuditBaselineNew } from '../../../shared/audit-baseline';
import {
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { ipc } from '../../services/ipc-client';
import { exportStemFromName } from '../../services/export-data';
import { useAuditStore, type AuditFilter } from '../../store/audit-store';
import { useAccessibilityStore } from '../../store/accessibility-store';
import { useSecurityStore } from '../../store/security-store';
import { SecurityResources } from './SecurityResources';
import { StructureView } from './StructureView';
import styles from './AuditWorkspace.module.css';

/** `Page 7` for a page finding, `Document` for a document-level one. */
export function auditPageLabel(
  page: number | null,
  t: TranslateFn,
): string {
  return page === null ? t('audit.page.document') : t('audit.page.page', { page });
}

const CATEGORY_KEYS: Record<AuditCategory, MessageKey> = {
  fonts: 'audit.category.fonts',
  pages: 'audit.category.pages',
  images: 'audit.category.images',
  metadata: 'audit.category.metadata',
  structure: 'audit.category.structure',
  security: 'audit.category.security',
};

/** Translated display name of an audit category (schema values stay lowercase). */
export const auditCategoryLabel = (category: AuditCategory, t: TranslateFn): string =>
  t(CATEGORY_KEYS[category]);

const SEVERITY_KEYS: Record<AuditSeverity, MessageKey> = {
  error: 'audit.severity.error',
  warning: 'audit.severity.warning',
  info: 'audit.severity.info',
};

/** Translated display name of a severity, as used by filter options. */
export const auditSeverityLabel = (severity: AuditSeverity, t: TranslateFn): string =>
  t(SEVERITY_KEYS[severity]);

/**
 * `report.pdf` -> `report.audit.json`, `测试 报告.pdf` -> `测试 报告.audit.json`.
 *
 * Mirrors `suggestDiffJsonFilename` through the shared `exportStemFromName`
 * helper, which decodes percent escapes, keeps Unicode and makes the stem
 * portable on both platforms. An unusable name falls back to `document`.
 */
export function suggestAuditJsonFilename(fileName: string | null): string {
  return `${exportStemFromName(fileName) || 'document'}.audit.json`;
}

/**
 * `report.pdf` -> `report.security.json` for the `SecurityReport` export.
 *
 * Same stem rules as `suggestAuditJsonFilename`: the two exports describe the
 * same document from different sides, so their names differ only in the label.
 */
export function suggestSecurityJsonFilename(fileName: string | null): string {
  return `${exportStemFromName(fileName) || 'document'}.security.json`;
}

/**
 * `report.pdf` -> `report.accessibility.json` for the `AccessibilityReport`
 * export.
 *
 * Same stem rules as the audit/security exports: the three exports describe the
 * same document from different sides, so their names differ only in the label.
 */
export function suggestAccessibilityJsonFilename(fileName: string | null): string {
  return `${exportStemFromName(fileName) || 'document'}.accessibility.json`;
}

/** The three views the Audit workspace switches between. */
export type AuditMode = 'findings' | 'structure' | 'resources';

export function isAuditFilterActive(filter: AuditFilter): boolean {
  return filter.severity !== 'all' || filter.category !== 'all';
}

/** Does one finding pass both filter axes? `all` means "do not filter". */
export function matchesAuditFilter(finding: AuditFinding, filter: AuditFilter): boolean {
  return (
    (filter.severity === 'all' || finding.severity === filter.severity) &&
    (filter.category === 'all' || finding.category === filter.category)
  );
}

/** Findings matching both filter axes; `all` means "do not filter on this axis". */
export function filterAuditFindings(
  findings: AuditFinding[],
  filter: AuditFilter,
): AuditFinding[] {
  if (!isAuditFilterActive(filter)) return findings;
  return findings.filter((finding) => matchesAuditFilter(finding, filter));
}

/** Separator between the count groups of the baseline line. */
export const BASELINE_COUNT_SEPARATOR = ' · ';

/**
 * `Baseline: 2 new · 5 existing · 1 moved · 3 fixed`.
 *
 * New, existing and fixed are always shown — they answer "is this document
 * getting better or worse?" — while `moved`/`escalated`/`waived` only appear
 * when non-zero, so a plain re-run stays a single short line.
 */
export function auditBaselineCountsText(
  counts: AuditBaselineCounts,
  t: TranslateFn,
): string {
  const parts = [
    t('audit.baseline.count.new', { count: counts.new }),
    t('audit.baseline.count.existing', { count: counts.existing }),
  ];
  if (counts.moved > 0) parts.push(t('audit.baseline.count.moved', { count: counts.moved }));
  if (counts.escalated > 0) {
    parts.push(t('audit.baseline.count.escalated', { count: counts.escalated }));
  }
  parts.push(t('audit.baseline.count.fixed', { count: counts.fixed }));
  if (counts.waived > 0) parts.push(t('audit.baseline.count.waived', { count: counts.waived }));
  // The label owns the colon so `en` and `zh-CN` can use their own punctuation.
  return t('audit.baseline.countsLine', { counts: parts.join(BASELINE_COUNT_SEPARATOR) });
}

/** The full `title` of the baseline line: every count, zeros included. */
export function auditBaselineCountsTitle(
  counts: AuditBaselineCounts,
  t: TranslateFn,
): string {
  return t('audit.baseline.title', {
    new: counts.new,
    existing: counts.existing,
    moved: counts.moved,
    escalated: counts.escalated,
    fixed: counts.fixed,
    waived: counts.waived,
  });
}

/** Statuses that get a row badge; `existing`/`fixed`/`waived` get none. */
const BASELINE_STATUS_KEYS: Partial<Record<AuditBaselineStatus, MessageKey>> = {
  new: 'audit.baseline.status.new',
  moved: 'audit.baseline.status.moved',
  escalated: 'audit.baseline.status.escalated',
};

const Summary: React.FC<{ report: AuditReport }> = ({ report }) => {
  const t = useT();
  const { summary, document } = report;
  const counts: Array<[MessageKey, number, AuditSeverity]> = [
    ['audit.summary.errors', summary.errors, 'error'],
    ['audit.summary.warnings', summary.warnings, 'warning'],
    ['audit.summary.info', summary.info, 'info'],
    ['audit.summary.total', summary.total, 'info'],
  ];

  return (
    <>
      <dl
        className={styles.summaryGrid}
        aria-label={t('audit.summaryLabel')}
        data-testid="audit-summary"
      >
        {counts.map(([labelKey, value, severity]) => (
          <div key={labelKey} className={styles.summaryItem}>
            <dt className={styles.summaryLabel}>{t(labelKey)}</dt>
            <dd className={styles.summaryValue} data-severity={severity}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <dl
        className={styles.documentGrid}
        aria-label={t('audit.documentInfoLabel')}
        data-testid="audit-document-info"
      >
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>{t('audit.document.pages')}</dt>
          <dd className={styles.summaryValue}>{document.pages}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>{t('audit.document.version')}</dt>
          <dd className={styles.summaryValue}>{document.version || '—'}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>{t('audit.document.encrypted')}</dt>
          <dd className={styles.summaryValue}>
            {document.encrypted ? t('audit.yes') : t('audit.no')}
          </dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>{t('audit.document.tagged')}</dt>
          <dd className={styles.summaryValue}>{document.tagged ? t('audit.yes') : t('audit.no')}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>{t('audit.document.language')}</dt>
          <dd className={styles.summaryValue}>{document.language ?? '—'}</dd>
        </div>
      </dl>
    </>
  );
};

/**
 * Baseline controls of the `Findings` summary pane: the counts line, the
 * `New only` toggle and a dismissible load error.
 *
 * `fixed` findings only appear as a count: there is no current row to select,
 * and a second "already fixed" list is out of scope. The full per-category
 * counts live in the line's `title`, so the visible line stays short.
 */
const BaselinePane: React.FC<{
  comparison: AuditBaselineComparison | null;
  error: string | null;
  newOnly: boolean;
  onNewOnlyChange: (value: boolean) => void;
  onDismissError: () => void;
}> = ({ comparison, error, newOnly, onNewOnlyChange, onDismissError }) => {
  const t = useT();
  const newCount = comparison
    ? comparison.summary.new + comparison.summary.escalated
    : 0;

  return (
    <div className={styles.baseline} data-testid="audit-baseline">
      {comparison && (
        <>
          <p
            className={styles.baselineCounts}
            data-testid="audit-baseline-summary"
            title={auditBaselineCountsTitle(comparison.summary, t)}
          >
            {auditBaselineCountsText(comparison.summary, t)}
          </p>
          <div className={styles.baselineToggle}>
            <input
              className={styles.baselineCheckbox}
              id="audit-baseline-new-only"
              type="checkbox"
              checked={newOnly}
              title={t('audit.baseline.newOnlyTitle')}
              onChange={(event) => onNewOnlyChange(event.target.checked)}
            />
            <label className={styles.baselineToggleLabel} htmlFor="audit-baseline-new-only">
              {t('audit.baseline.newOnly')}
            </label>
            {/* How many rows `New only` keeps, before the severity/category
             * filters narrow them further. */}
            <span className={styles.baselineToggleCount} data-testid="audit-baseline-count">
              ({newCount})
            </span>
          </div>
        </>
      )}

      {error && (
        <div className={styles.baselineError}>
          <p role="alert" data-testid="audit-baseline-error">
            {error}
          </p>
          <button className={styles.linkButton} type="button" onClick={onDismissError}>
            {t('common.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
};

const FindingDetail: React.FC<{ finding: AuditFinding; onOpenPage: () => void }> = ({
  finding,
  onOpenPage,
}) => {
  const t = useT();
  return (
    <div className={styles.detailBody} data-testid="audit-finding-detail">
      <h3 className={styles.detailTitle}>{finding.title}</h3>

      <dl className={styles.detailList}>
        <div className={styles.detailRow}>
          <dt>{t('audit.detail.category')}</dt>
          <dd>{auditCategoryLabel(finding.category, t)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.detail.severity')}</dt>
          <dd>
            {/* The badge shows the schema value so reports stay comparable. */}
            <span className={styles.severityBadge} data-severity={finding.severity}>
              {finding.severity}
            </span>
          </dd>
        </div>
        <div className={styles.detailRow}>
          <dt>{t('audit.detail.page')}</dt>
          <dd>{auditPageLabel(finding.page, t)}</dd>
        </div>
      </dl>

      <p className={styles.detailText}>{finding.detail}</p>

      {finding.evidence !== null && finding.evidence !== '' && (
        <section className={styles.block}>
          <h4 className={styles.blockTitle}>{t('audit.detail.evidence')}</h4>
          <pre className={styles.pre}>{finding.evidence}</pre>
        </section>
      )}

      {finding.recommendation !== null && finding.recommendation !== '' && (
        <section className={styles.block}>
          <h4 className={styles.blockTitle}>{t('audit.detail.recommendation')}</h4>
          <p className={styles.detailText}>{finding.recommendation}</p>
        </section>
      )}

      {finding.page !== null && (
        <button
          className={styles.button}
          type="button"
          onClick={onOpenPage}
          title={t('audit.detail.openPageTitle')}
        >
          {t('audit.detail.openPage')}
        </button>
      )}
    </div>
  );
};

/**
 * The Audit workspace: document summary + filters, the findings list and the
 * detail of the selected finding.
 *
 * All state lives in `audit-store`; the component only reads it, so entering
 * and leaving Audit never touches the Inspect document. The run itself starts
 * in `open()` — this view only reports loading, progress and errors.
 *
 * The header switches between three views of the same document: `Findings` (the
 * audit report), `Structure` (the tagged-PDF structure tree) and `Resources`
 * (the document security inventory). Only the mode is local component state;
 * the structure and security reports live in their own stores so they survive a
 * mode switch without repeating the work.
 */
export const AuditWorkspace: React.FC = () => {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const filePath = useAuditStore((s) => s.filePath);
  const fileName = useAuditStore((s) => s.fileName);
  const report = useAuditStore((s) => s.report);
  const loading = useAuditStore((s) => s.loading);
  const progress = useAuditStore((s) => s.progress);
  const error = useAuditStore((s) => s.error);
  const filter = useAuditStore((s) => s.filter);
  const selected = useAuditStore((s) => s.selected);
  const runAudit = useAuditStore((s) => s.runAudit);
  const close = useAuditStore((s) => s.close);
  const setFilter = useAuditStore((s) => s.setFilter);
  const selectFinding = useAuditStore((s) => s.selectFinding);

  const baseline = useAuditStore((s) => s.baseline);
  const comparison = useAuditStore((s) => s.comparison);
  const baselineError = useAuditStore((s) => s.baselineError);
  const baselineOnly = useAuditStore((s) => s.baselineOnly);
  const loadBaselineFile = useAuditStore((s) => s.loadBaselineFile);
  const clearBaseline = useAuditStore((s) => s.clearBaseline);
  const clearBaselineError = useAuditStore((s) => s.clearBaselineError);
  const setBaselineOnly = useAuditStore((s) => s.setBaselineOnly);

  const securityReport = useSecurityStore((s) => s.report);
  const securityLoading = useSecurityStore((s) => s.loading);
  const securityLoad = useSecurityStore((s) => s.load);

  const accessibilityReport = useAccessibilityStore((s) => s.report);
  const accessibilityLoading = useAccessibilityStore((s) => s.loading);
  const accessibilityLoad = useAccessibilityStore((s) => s.load);

  const { navigate } = usePageNavigation();

  const [mode, setMode] = useState<AuditMode>('findings');

  // An export failure is a local, dismissible concern: the audit store models
  // the run, not the save dialog, and its error would wrongly look like a
  // failed audit.
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * Point the lazily loaded views at the audited document.
   *
   * Entering Structure/Resources reads the document then; leaving a view drops
   * a report that belongs to another file (a file change while Findings was
   * shown) but keeps the cache, so toggling the mode is free.
   */
  useEffect(() => {
    const security = useSecurityStore.getState();
    if (mode === 'resources') {
      security.open(filePath);
    } else if (security.filePath !== null && security.filePath !== filePath) {
      security.reset();
    }

    const accessibility = useAccessibilityStore.getState();
    if (mode === 'structure') {
      accessibility.open(filePath);
    } else if (accessibility.filePath !== null && accessibility.filePath !== filePath) {
      accessibility.reset();
    }
  }, [mode, filePath]);

  const findingCount = report?.findings.length ?? 0;

  /**
   * Status per current finding, or null without a baseline.
   *
   * `auditBaselineStatuses` projects the comparison onto `report.findings`
   * order, so `statuses[index]` describes `report.findings[index]`.
   */
  const statuses = useMemo(
    () => (comparison ? auditBaselineStatuses(comparison) : null),
    [comparison],
  );

  /**
   * The rows the list shows: severity/category filters and `New only` are
   * combined here, so the count next to the list always describes what is
   * visible. `index` is the position in `report.findings`, which is how the
   * baseline status is looked up.
   *
   * `New only` without a comparison (a report that carries no fingerprints
   * cannot be compared) is a no-op rather than an empty list: the toggle is not
   * even rendered then, so the filter must not hide every row.
   */
  const newOnlyActive = baselineOnly && statuses !== null;

  const rows = useMemo(() => {
    const findings = report?.findings ?? [];
    return findings
      .map((finding, index) => ({ finding, index, status: statuses?.[index] ?? null }))
      .filter(
        ({ finding, status }) =>
          matchesAuditFilter(finding, filter) &&
          (!newOnlyActive || (status !== null && isAuditBaselineNew(status))),
      );
  }, [report, filter, statuses, newOnlyActive]);

  const filterActive = isAuditFilterActive(filter) || newOnlyActive;
  const filteredCount = rows.length;

  /** Clear every list filter, including `New only`. */
  const handleResetFilters = useCallback(() => {
    setFilter({ severity: 'all', category: 'all' });
    setBaselineOnly(false);
  }, [setFilter, setBaselineOnly]);

  const baselineInput = useRef<HTMLInputElement | null>(null);

  const handleChooseBaseline = useCallback(() => {
    baselineInput.current?.click();
  }, []);

  const handleBaselineChosen = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset before the async read: picking the same file again must still
      // fire `change`.
      event.target.value = '';
      if (file) void loadBaselineFile(file);
    },
    [loadBaselineFile],
  );

  const saveJson = useCallback(
    async (defaultPath: string, content: string) => {
      setExportError(null);
      try {
        const response = await ipc.saveFile({
          defaultPath,
          content,
          filterName: 'JSON',
          extensions: ['json'],
        });
        // A dismissed dialog is not an error; the user simply changed their mind.
        if (response.canceled) return;
        if (response.error) {
          setExportError(t('export.failedDetail', { error: response.error }));
        }
      } catch (err) {
        setExportError(
          err instanceof Error
            ? t('export.failedDetail', { error: err.message })
            : t('export.failed'),
        );
      }
    },
    [t],
  );

  const handleExportJson = useCallback(async () => {
    const state = useAuditStore.getState();
    if (!state.report) return;
    await saveJson(
      suggestAuditJsonFilename(state.fileName),
      JSON.stringify(state.report, null, 2),
    );
  }, [saveJson]);

  // The security export is independent of the audit run: its failures show as
  // a local alert and never touch the audit store's error.
  const handleExportSecurityJson = useCallback(async () => {
    const state = useSecurityStore.getState();
    if (!state.report) return;
    await saveJson(
      suggestSecurityJsonFilename(useAuditStore.getState().fileName),
      JSON.stringify(state.report, null, 2),
    );
  }, [saveJson]);

  // The structure export is independent of the audit run too: its failures show
  // as a local alert and never touch the audit store's error.
  const handleExportAccessibilityJson = useCallback(async () => {
    const state = useAccessibilityStore.getState();
    if (!state.report) return;
    await saveJson(
      suggestAccessibilityJsonFilename(useAuditStore.getState().fileName),
      JSON.stringify(state.report, null, 2),
    );
  }, [saveJson]);

  /**
   * Audit `Re-run` also drops the cached security scan and structure parse: a
   * re-run is the user asking for a fresh look at the file, so the next visit to
   * those views re-reads it instead of showing the old result.
   */
  const handleRunAudit = useCallback(() => {
    const security = useSecurityStore.getState();
    security.invalidate();
    if (mode === 'resources') {
      // The resources view is on screen, so read the file again right away
      // instead of waiting for a report that nothing would request.
      security.open(useAuditStore.getState().filePath);
    }

    const accessibility = useAccessibilityStore.getState();
    accessibility.invalidate();
    if (mode === 'structure') {
      accessibility.open(useAuditStore.getState().filePath);
    }

    void runAudit();
  }, [mode, runAudit]);

  const handleRefreshResources = useCallback(() => {
    void securityLoad(true);
  }, [securityLoad]);

  const handleRefreshStructure = useCallback(() => {
    void accessibilityLoad(true);
  }, [accessibilityLoad]);

  /**
   * Jump from a view back into the report list.
   *
   * The category filter is forced to the findings the button promised and the
   * severity filter is reset to `all`, because a severity left over from an
   * earlier session would hide some of those findings and make the jump look
   * broken.
   */
  const handleViewInFindings = useCallback(
    (category: AuditCategory) => {
      setMode('findings');
      setFilter({ category, severity: 'all' });
    },
    [setFilter],
  );

  const handleViewSecurityInFindings = useCallback(
    () => handleViewInFindings('security'),
    [handleViewInFindings],
  );

  const handleViewStructureInFindings = useCallback(
    () => handleViewInFindings('structure'),
    [handleViewInFindings],
  );

  const handleOpenPage = useCallback(() => {
    const state = useAuditStore.getState();
    if (!state.selected || state.selected.page === null) return;
    const page = state.selected.page;
    // Audit owns the workspace, so leave it before Inspect navigates: the
    // hidden document must not scroll while the user still sees the audit.
    state.close();
    void navigate(page);
  }, [navigate]);

  /** A structure element only knows its page: leave Audit and show that page. */
  const handleOpenStructurePage = useCallback(
    (page: number) => {
      useAuditStore.getState().close();
      void navigate(page);
    },
    [navigate],
  );

  const progressText =
    progress && progress.total > 0
      ? t('audit.progressPages', { done: progress.done, total: progress.total })
      : t('audit.progressDocument');

  return (
    <section
      className={styles.workspace}
      aria-label={t('audit.workspaceLabel')}
      data-testid="audit-workspace"
    >
      <header className={styles.toolbar}>
        <button className={styles.button} type="button" onClick={close}>
          {t('workspace.backToInspect')}
        </button>
        <span className={styles.separator} />
        <span className={styles.title}>{t('audit.title')}</span>

        {/* Segmented mode switch: native buttons, so Tab/Enter/Space and the
            usual pointer input both work; `aria-pressed` states the mode. */}
        <div className={styles.modeSwitch} role="group" aria-label={t('audit.mode.label')}>
          <button
            className={`${styles.button} ${mode === 'findings' ? styles.active : ''}`}
            type="button"
            aria-pressed={mode === 'findings'}
            onClick={() => setMode('findings')}
          >
            {t('audit.mode.findings')}
          </button>
          <button
            className={`${styles.button} ${mode === 'structure' ? styles.active : ''}`}
            type="button"
            aria-pressed={mode === 'structure'}
            onClick={() => setMode('structure')}
          >
            {t('audit.mode.structure')}
          </button>
          <button
            className={`${styles.button} ${mode === 'resources' ? styles.active : ''}`}
            type="button"
            aria-pressed={mode === 'resources'}
            onClick={() => setMode('resources')}
          >
            {t('audit.mode.resources')}
          </button>
        </div>

        <span
          className={styles.fileName}
          title={fileName ?? '—'}
          data-testid="audit-file-name"
        >
          {fileName ?? '—'}
        </span>

        <span className={styles.spacer} />

        <div className={styles.group}>
          <button
            className={styles.button}
            type="button"
            onClick={handleRunAudit}
            disabled={loading}
            title={report ? t('audit.reRunTitle') : t('audit.runTitle')}
          >
            {loading ? t('audit.running') : report ? t('audit.reRun') : t('audit.run')}
          </button>

          {mode === 'findings' && (
            <>
              <button
                className={styles.button}
                type="button"
                onClick={() => void handleExportJson()}
                disabled={!report}
                title={t('audit.exportTitle')}
              >
                {t('common.exportJson')}
              </button>

              {/* A native file input is the only way to pick a local file
                  without a new IPC channel; the visible button only forwards
                  the click, and the input keeps its accessible label. */}
              <button
                className={styles.button}
                type="button"
                onClick={handleChooseBaseline}
                disabled={!report}
                title={t('audit.baseline.loadTitle')}
              >
                {t('audit.baseline.load')}
              </button>
              <input
                ref={baselineInput}
                className={styles.fileInput}
                type="file"
                accept=".json,application/json"
                aria-label={t('audit.baseline.inputLabel')}
                data-testid="audit-baseline-input"
                onChange={handleBaselineChosen}
              />

              {baseline && (
                <>
                  <button
                    className={styles.button}
                    type="button"
                    onClick={clearBaseline}
                    title={t('audit.baseline.clearTitle')}
                  >
                    {t('audit.baseline.clear')}
                  </button>
                  <span
                    className={styles.baselineFileName}
                    title={`${t('audit.baseline.fileLabel')}: ${baseline.fileName}`}
                    data-testid="audit-baseline-file-name"
                  >
                    {baseline.fileName}
                  </span>
                </>
              )}
            </>
          )}

          {mode === 'structure' && (
            <>
              <button
                className={styles.button}
                type="button"
                onClick={handleRefreshStructure}
                disabled={accessibilityLoading || filePath === null}
                title={t('audit.structure.refreshTitle')}
              >
                {t('audit.structure.refresh')}
              </button>
              <button
                className={styles.button}
                type="button"
                onClick={() => void handleExportAccessibilityJson()}
                disabled={!accessibilityReport}
                title={t('audit.structure.exportTitle')}
              >
                {t('audit.structure.export')}
              </button>
            </>
          )}

          {mode === 'resources' && (
            <>
              <button
                className={styles.button}
                type="button"
                onClick={handleRefreshResources}
                disabled={securityLoading || filePath === null}
                title={t('audit.resources.refreshTitle')}
              >
                {t('audit.resources.refresh')}
              </button>
              <button
                className={styles.button}
                type="button"
                onClick={() => void handleExportSecurityJson()}
                disabled={!securityReport}
                title={t('audit.resources.exportTitle')}
              >
                {t('audit.resources.export')}
              </button>
            </>
          )}
        </div>
      </header>

      {exportError && (
        <div className={styles.errorBar}>
          <p className={styles.error} role="alert">
            {exportError}
          </p>
          <button
            className={styles.linkButton}
            type="button"
            onClick={() => setExportError(null)}
          >
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {/* `Findings` keeps the three-pane layout (summary | list | detail);
          `Structure` and `Resources` replace the whole body with their own
          view. The panes are unmounted rather than hidden so no stale finding
          list is reachable from the other modes. */}
      <div className={styles.body} data-mode={mode}>
        {mode === 'structure' && (
          <StructureView
            filePath={filePath}
            onViewInFindings={handleViewStructureInFindings}
            onOpenPage={handleOpenStructurePage}
          />
        )}

        {mode === 'resources' && (
          <SecurityResources filePath={filePath} onViewInFindings={handleViewSecurityInFindings} />
        )}

        {mode === 'findings' && (
          <aside className={styles.summaryPane} aria-label={t('audit.summaryPaneLabel')}>
            {report ? (
              <Summary report={report} />
            ) : (
              <p className={styles.hint}>
                {loading ? t('audit.reading') : t('audit.noAudit')}
              </p>
            )}

            {/* The pane is also rendered for an error alone: the first bad file
                a user picks must explain itself before any baseline exists. */}
            {(baseline !== null || baselineError !== null) && (
              <BaselinePane
                comparison={comparison}
                error={baselineError}
                newOnly={baselineOnly}
                onNewOnlyChange={setBaselineOnly}
                onDismissError={clearBaselineError}
              />
            )}

            <div className={styles.filters}>
              <label className={styles.filterLabel}>
                {t('audit.filter.severity')}
                <select
                  className={styles.select}
                  aria-label={t('audit.filter.severityTitle')}
                  value={filter.severity}
                  onChange={(event) =>
                    setFilter({ severity: event.target.value as AuditFilter['severity'] })
                  }
                >
                  <option value="all">{t('audit.filter.allSeverities')}</option>
                  {AUDIT_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {auditSeverityLabel(severity, t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.filterLabel}>
                {t('audit.filter.category')}
                <select
                  className={styles.select}
                  aria-label={t('audit.filter.categoryTitle')}
                  value={filter.category}
                  onChange={(event) =>
                    setFilter({ category: event.target.value as AuditFilter['category'] })
                  }
                >
                  <option value="all">{t('audit.filter.allCategories')}</option>
                  {AUDIT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {auditCategoryLabel(category, t)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={styles.linkButton}
                type="button"
                onClick={handleResetFilters}
                disabled={!filterActive}
              >
                {t('common.reset')}
              </button>
            </div>
          </aside>
        )}

        {mode === 'findings' && (
          <div className={styles.center}>
            {error && (
              <p className={styles.error} role="alert">
                {t('audit.failed', { error })}
              </p>
            )}

            {loading && (
              <p className={styles.progress} role="status" aria-live="polite">
                {progressText}
              </p>
            )}

            {!report && !loading && !error && (
              <p className={styles.emptyState} data-testid="audit-empty">
                {t('audit.emptyWorkspace')}
              </p>
            )}

            {report && findingCount === 0 && !loading && (
              <p className={styles.emptyState} role="status">
                {t('audit.noFindings')}
              </p>
            )}

            {report && findingCount > 0 && (
              <p
                className={styles.listCount}
                data-testid="audit-filtered-count"
                data-baseline-only={newOnlyActive || undefined}
              >
                {filterActive
                  ? t('audit.filteredCount', { filtered: filteredCount, total: findingCount })
                  : translatePlural(locale, 'audit.count', findingCount)}
              </p>
            )}

            {report && findingCount > 0 && filteredCount === 0 && !loading && (
              <p className={styles.emptyState} role="status">
                {t('audit.noFilterMatch')}
              </p>
            )}

            <ul className={styles.findingList} data-testid="audit-finding-list">
              {rows.map(({ finding, index, status }) => {
                const isSelected = selected === finding;
                const statusKey = status ? BASELINE_STATUS_KEYS[status] : undefined;
                const statusLabel = statusKey ? t(statusKey) : null;
                return (
                  <li
                    key={`${finding.category}:${finding.page ?? 'document'}:${finding.title}:${index}`}
                  >
                    <button
                      className={`${styles.findingItem} ${isSelected ? styles.findingItemSelected : ''}`}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`${finding.severity} ${finding.category} ${auditPageLabel(finding.page, t)}: ${finding.title}${statusLabel ? ` (${statusLabel})` : ''}`}
                      onClick={() => selectFinding(finding)}
                    >
                      <span className={styles.severityBadge} data-severity={finding.severity}>
                        {finding.severity}
                      </span>
                      <span className={styles.findingCategory}>{finding.category}</span>
                      <span className={styles.findingPage}>
                        {auditPageLabel(finding.page, t)}
                      </span>
                      <span className={styles.findingTitle} title={finding.title}>
                        {finding.title}
                      </span>
                      {/* Text badge, never colour alone: `existing` rows keep
                          no badge so the list stays calm after a plain re-run. */}
                      {status && statusLabel && (
                        <span
                          className={styles.baselineBadge}
                          data-status={status}
                          data-testid="audit-baseline-badge"
                        >
                          {statusLabel}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {mode === 'findings' && (
          <aside className={styles.details} aria-label={t('audit.detailsLabel')}>
            {selected ? (
              <FindingDetail finding={selected} onOpenPage={handleOpenPage} />
            ) : (
              <p className={styles.hint}>{t('audit.detail.selectFinding')}</p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
};
