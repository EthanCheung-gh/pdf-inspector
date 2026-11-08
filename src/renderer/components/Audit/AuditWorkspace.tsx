import React, { useCallback, useMemo, useState } from 'react';
import {
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
} from '../../../shared/audit-types';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { ipc } from '../../services/ipc-client';
import { useAuditStore, type AuditFilter } from '../../store/audit-store';
import styles from './AuditWorkspace.module.css';

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** `Page 7` for a page finding, `Document` for a document-level one. */
export function auditPageLabel(page: number | null): string {
  return page === null ? 'Document' : `Page ${page}`;
}

/**
 * `report.pdf` -> `report.audit.json`.
 *
 * Mirrors `suggestDiffJsonFilename`: strip any directory and the `.pdf`
 * extension, then replace everything that is not portable in a file name so the
 * suggested name is valid on both platforms.
 */
export function suggestAuditJsonFilename(fileName: string | null): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const withoutExtension = base.replace(/\.pdf$/i, '');
  const safe = withoutExtension.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'document'}.audit.json`;
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
  const { summary, document } = report;
  const counts: Array<[string, number, AuditSeverity]> = [
    ['Errors', summary.errors, 'error'],
    ['Warnings', summary.warnings, 'warning'],
    ['Info', summary.info, 'info'],
    ['Total', summary.total, 'info'],
  ];

  return (
    <>
      <dl className={styles.summaryGrid} aria-label="Audit findings summary" data-testid="audit-summary">
        {counts.map(([label, value, severity]) => (
          <div key={label} className={styles.summaryItem}>
            <dt className={styles.summaryLabel}>{label}</dt>
            <dd className={styles.summaryValue} data-severity={severity}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <dl
        className={styles.documentGrid}
        aria-label="Audit document information"
        data-testid="audit-document-info"
      >
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>Pages</dt>
          <dd className={styles.summaryValue}>{document.pages}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>Version</dt>
          <dd className={styles.summaryValue}>{document.version || '—'}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>Encrypted</dt>
          <dd className={styles.summaryValue}>{document.encrypted ? 'Yes' : 'No'}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>Tagged</dt>
          <dd className={styles.summaryValue}>{document.tagged ? 'Yes' : 'No'}</dd>
        </div>
        <div className={styles.documentItem}>
          <dt className={styles.summaryLabel}>Language</dt>
          <dd className={styles.summaryValue}>{document.language ?? '—'}</dd>
        </div>
      </dl>
    </>
  );
};

const FindingDetail: React.FC<{ finding: AuditFinding; onOpenPage: () => void }> = ({
  finding,
  onOpenPage,
}) => (
  <div className={styles.detailBody} data-testid="audit-finding-detail">
    <h3 className={styles.detailTitle}>{finding.title}</h3>

    <dl className={styles.detailList}>
      <div className={styles.detailRow}>
        <dt>Category</dt>
        <dd>{capitalize(finding.category)}</dd>
      </div>
      <div className={styles.detailRow}>
        <dt>Severity</dt>
        <dd>
          <span className={styles.severityBadge} data-severity={finding.severity}>
            {finding.severity}
          </span>
        </dd>
      </div>
      <div className={styles.detailRow}>
        <dt>Page</dt>
        <dd>{auditPageLabel(finding.page)}</dd>
      </div>
    </dl>

    <p className={styles.detailText}>{finding.detail}</p>

    {finding.evidence !== null && finding.evidence !== '' && (
      <section className={styles.block}>
        <h4 className={styles.blockTitle}>Evidence</h4>
        <pre className={styles.pre}>{finding.evidence}</pre>
      </section>
    )}

    {finding.recommendation !== null && finding.recommendation !== '' && (
      <section className={styles.block}>
        <h4 className={styles.blockTitle}>Recommendation</h4>
        <p className={styles.detailText}>{finding.recommendation}</p>
      </section>
    )}

    {finding.page !== null && (
      <button
        className={styles.button}
        type="button"
        onClick={onOpenPage}
        title="Leave Audit and show this page in Inspect"
      >
        Open page
      </button>
    )}
  </div>
);

/**
 * The Audit workspace: document summary + filters, the findings list and the
 * detail of the selected finding.
 *
 * All state lives in `audit-store`; the component only reads it, so entering
 * and leaving Audit never touches the Inspect document. The run itself starts
 * in `open()` — this view only reports loading, progress and errors.
 */
export const AuditWorkspace: React.FC = () => {
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
      if (response.error) setExportError(`Export failed: ${response.error}`);
    } catch (err) {
      setExportError(err instanceof Error ? `Export failed: ${err.message}` : 'Export failed');
    }
  }, []);

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
      ? `Auditing pages ${progress.done}/${progress.total}…`
      : 'Auditing document…';

  return (
    <section className={styles.workspace} aria-label="PDF audit workspace" data-testid="audit-workspace">
      <header className={styles.toolbar}>
        <button className={styles.button} type="button" onClick={close}>
          Back to Inspect
        </button>
        <span className={styles.separator} />
        <span className={styles.title}>Audit</span>
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
            title={report ? 'Audit the document again' : 'Audit the open document'}
          >
            {loading ? 'Auditing…' : report ? 'Re-run' : 'Run'}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handleExportJson()}
            disabled={!report}
            title="Save the full AuditReport as JSON"
          >
            Export JSON
          </button>
        </div>
      </header>

      {exportError && (
        <p className={styles.error} role="alert">
          {exportError}
        </p>
      )}

      <div className={styles.body}>
        <aside className={styles.summaryPane} aria-label="Audit summary">
          {report ? (
            <Summary report={report} />
          ) : (
            <p className={styles.hint}>
              {loading ? 'Reading the document…' : 'No audit yet.'}
            </p>
          )}

          <div className={styles.filters}>
            <label className={styles.filterLabel}>
              Severity
              <select
                className={styles.select}
                aria-label="Filter by severity"
                value={filter.severity}
                onChange={(event) =>
                  setFilter({ severity: event.target.value as AuditFilter['severity'] })
                }
              >
                <option value="all">All severities</option>
                {AUDIT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {capitalize(severity)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterLabel}>
              Category
              <select
                className={styles.select}
                aria-label="Filter by category"
                value={filter.category}
                onChange={(event) =>
                  setFilter({ category: event.target.value as AuditFilter['category'] })
                }
              >
                <option value="all">All categories</option>
                {AUDIT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {capitalize(category)}
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
              Reset
            </button>
          </div>
        </aside>

        <div className={styles.center}>
          {error && (
            <p className={styles.error} role="alert">
              Audit failed: {error}
            </p>
          )}

          {loading && (
            <p className={styles.progress} role="status" aria-live="polite">
              {progressText}
            </p>
          )}

          {!report && !loading && !error && (
            <p className={styles.emptyState} data-testid="audit-empty">
              No audit yet. Enter this workspace from the toolbar to check the open document.
            </p>
          )}

          {report && findingCount === 0 && !loading && (
            <p className={styles.emptyState} role="status">
              No findings — the document passed every check.
            </p>
          )}

          {report && findingCount > 0 && (
            <p className={styles.listCount} data-testid="audit-filtered-count">
              {filterActive
                ? `${filtered.length} of ${findingCount} findings`
                : `${findingCount} finding${findingCount === 1 ? '' : 's'}`}
            </p>
          )}

          {report && findingCount > 0 && filtered.length === 0 && !loading && (
            <p className={styles.emptyState} role="status">
              No findings match this filter.
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
                    aria-label={`${finding.severity} ${finding.category} ${auditPageLabel(finding.page)}: ${finding.title}`}
                    onClick={() => selectFinding(finding)}
                  >
                    <span className={styles.severityBadge} data-severity={finding.severity}>
                      {finding.severity}
                    </span>
                    <span className={styles.findingCategory}>{finding.category}</span>
                    <span className={styles.findingPage}>{auditPageLabel(finding.page)}</span>
                    <span className={styles.findingTitle} title={finding.title}>
                      {finding.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <aside className={styles.details} aria-label="Finding details">
          {selected ? (
            <FindingDetail finding={selected} onOpenPage={handleOpenPage} />
          ) : (
            <p className={styles.hint}>Select a finding to see its detail, evidence and fix.</p>
          )}
        </aside>
      </div>
    </section>
  );
};
