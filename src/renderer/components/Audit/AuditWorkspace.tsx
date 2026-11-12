import React, { useCallback, useMemo, useState } from 'react';
import {
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
} from '../../../shared/audit-types';
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

export function isAuditFilterActive(filter: AuditFilter): boolean {
  return filter.severity !== 'all' || filter.category !== 'all';
}

/** Findings matching both filter axes; `all` means "do not filter on this axis". */
export function filterAuditFindings(
  findings: AuditFinding[],
  filter: AuditFilter,
): AuditFinding[] {
  if (!isAuditFilterActive(filter)) return findings;
  return findings.filter(
    (finding) =>
      (filter.severity === 'all' || finding.severity === filter.severity) &&
      (filter.category === 'all' || finding.category === filter.category),
  );
}

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
 */
export const AuditWorkspace: React.FC = () => {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
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

  const { navigate } = usePageNavigation();

  // An export failure is a local, dismissible concern: the audit store models
  // the run, not the save dialog, and its error would wrongly look like a
  // failed audit.
  const [exportError, setExportError] = useState<string | null>(null);

  const findingCount = report?.findings.length ?? 0;
  const filtered = useMemo(
    () => filterAuditFindings(report?.findings ?? [], filter),
    [report, filter],
  );
  const filterActive = isAuditFilterActive(filter);

  const handleExportJson = useCallback(async () => {
    const state = useAuditStore.getState();
    if (!state.report) return;

    setExportError(null);
    try {
      const response = await ipc.saveFile({
        defaultPath: suggestAuditJsonFilename(state.fileName),
        content: JSON.stringify(state.report, null, 2),
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
  }, [t]);

  const handleOpenPage = useCallback(() => {
    const state = useAuditStore.getState();
    if (!state.selected || state.selected.page === null) return;
    const page = state.selected.page;
    // Audit owns the workspace, so leave it before Inspect navigates: the
    // hidden document must not scroll while the user still sees the audit.
    state.close();
    void navigate(page);
  }, [navigate]);

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
            onClick={() => void runAudit()}
            disabled={loading}
            title={report ? t('audit.reRunTitle') : t('audit.runTitle')}
          >
            {loading ? t('audit.running') : report ? t('audit.reRun') : t('audit.run')}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handleExportJson()}
            disabled={!report}
            title={t('audit.exportTitle')}
          >
            {t('common.exportJson')}
          </button>
        </div>
      </header>

      {exportError && (
        <p className={styles.error} role="alert">
          {exportError}
        </p>
      )}

      <div className={styles.body}>
        <aside className={styles.summaryPane} aria-label={t('audit.summaryPaneLabel')}>
          {report ? (
            <Summary report={report} />
          ) : (
            <p className={styles.hint}>
              {loading ? t('audit.reading') : t('audit.noAudit')}
            </p>
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
              onClick={() => setFilter({ severity: 'all', category: 'all' })}
              disabled={!filterActive}
            >
              {t('common.reset')}
            </button>
          </div>
        </aside>

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
            <p className={styles.listCount} data-testid="audit-filtered-count">
              {filterActive
                ? t('audit.filteredCount', { filtered: filtered.length, total: findingCount })
                : translatePlural(locale, 'audit.count', findingCount)}
            </p>
          )}

          {report && findingCount > 0 && filtered.length === 0 && !loading && (
            <p className={styles.emptyState} role="status">
              {t('audit.noFilterMatch')}
            </p>
          )}

          <ul className={styles.findingList} data-testid="audit-finding-list">
            {filtered.map((finding, index) => {
              const isSelected = selected === finding;
              return (
                <li key={`${finding.category}:${finding.page ?? 'document'}:${finding.title}:${index}`}>
                  <button
                    className={`${styles.findingItem} ${isSelected ? styles.findingItemSelected : ''}`}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${finding.severity} ${finding.category} ${auditPageLabel(finding.page, t)}: ${finding.title}`}
                    onClick={() => selectFinding(finding)}
                  >
                    <span className={styles.severityBadge} data-severity={finding.severity}>
                      {finding.severity}
                    </span>
                    <span className={styles.findingCategory}>{finding.category}</span>
                    <span className={styles.findingPage}>{auditPageLabel(finding.page, t)}</span>
                    <span className={styles.findingTitle} title={finding.title}>
                      {finding.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <aside className={styles.details} aria-label={t('audit.detailsLabel')}>
          {selected ? (
            <FindingDetail finding={selected} onOpenPage={handleOpenPage} />
          ) : (
            <p className={styles.hint}>{t('audit.detail.selectFinding')}</p>
          )}
        </aside>
      </div>
    </section>
  );
};
