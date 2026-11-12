import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useI18nStore } from '../../i18n/store';
import { annotationDocumentKey } from '../../hooks/useAnnotationIndex';
import { useRegisterCommands } from '../../hooks/useRegisterCommands';
import type { CommandDefinition } from '../../services/command-registry';
import { capturePage } from '../../services/export-capture';
import { sanitizeReportFileName, suggestReportFilename } from '../../services/export-data';
import { buildInspectionReport, reportCaptureScale } from '../../services/export-report';
import { ipc } from '../../services/ipc-client';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { useAnnotationStore } from '../../store/annotation-store';
import { useAuditStore } from '../../store/audit-store';
import { usePdfStore } from '../../store/pdf-store';
import styles from './ShareReportButton.module.css';

/**
 * Display name for the report header: the bridge's upload name first, then the
 * URL the user recognises, then the local basename.
 */
function documentDisplayName(
  filePath: string | null,
  sourceUrl: string | null,
  documentName: string | null,
): string | null {
  return documentName ?? sourceUrl ?? (filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null);
}

/** Auto-generated report name for the open document. */
function generatedReportName(): string {
  const store = usePdfStore.getState();
  return suggestReportFilename(store.filePath, store.sourceUrl, store.documentName);
}

/**
 * Toolbar entry for the self-contained HTML inspection report (K3).
 *
 * The dialog only owns confirmation, feedback and saving; the report itself is
 * built by the pure `export-report` service and the screenshot by the K1
 * capture service. Audit/annotation data is included only when it belongs to
 * the document that is currently open.
 */
export const ShareReportButton: React.FC = () => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const pageData = usePdfStore((s) => s.pageData);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const isLoading = usePdfStore((s) => s.isLoading);

  const titleId = useId();
  const descriptionId = useId();
  const fileNameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fresh feedback every time the dialog opens; the generated name always
  // reflects the document that is open at that moment.
  useEffect(() => {
    if (!open) return;
    setFileName(generatedReportName());
    setError(null);
    setWarnings([]);
    setBusy(false);
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler never also clears the
    // selection/subset. Closing is blocked while generating: the capture and
    // save are already in flight and cannot be cancelled.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (busy) return;
      setOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, open]);

  const handleGenerate = useCallback(async () => {
    if (busy) return;

    const store = usePdfStore.getState();
    const pdfDoc = store.pdfDocRef;
    const currentPageData = store.pageData;
    if (!pdfDoc || !currentPageData) {
      setError(t('shareReport.documentMissing'));
      return;
    }

    const page = store.currentPage;
    // The page store keeps the annotations of whatever page finished loading
    // last; a report must not attribute another page's annotations to this one.
    const annotationState = useAnnotationStore.getState();
    const annotations = annotationState.page === page ? annotationState.annotations : [];

    // The whole-document index is only reused when it belongs to this document.
    const documentKey = annotationDocumentKey(store.filePath, store.sourceUrl);
    const indexState = useAnnotationIndexStore.getState();
    const annotationIndex =
      documentKey !== null && indexState.documentKey === documentKey
        ? indexState.result
        : null;

    // An audit describes exactly one document; drop one for another file.
    const auditState = useAuditStore.getState();
    const auditReport =
      store.filePath !== null && auditState.filePath === store.filePath
        ? auditState.report
        : null;

    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const screenshot = await capturePage(pdfDoc, page, currentPageData, annotations, {
        scale: reportCaptureScale(currentPageData),
        region: null,
        overlays: { objects: true, annotations: true, pageBoxes: false },
        objectTypes: undefined,
      });
      setWarnings(screenshot.warnings);

      const html = buildInspectionReport({
        documentName: documentDisplayName(store.filePath, store.sourceUrl, store.documentName),
        sourceUrl: store.sourceUrl,
        metadata: store.metadata,
        pageNumber: page,
        pageData: currentPageData,
        screenshot,
        annotations,
        annotationIndex,
        auditReport,
        fontStats: store.fontStats,
        lang: useI18nStore.getState().locale,
      });

      // The user's name is normalised (no directories, exactly one `.html`);
      // an unusable value falls back to the generated suggestion.
      const generated = suggestReportFilename(
        store.filePath,
        store.sourceUrl,
        store.documentName,
      );
      const defaultPath =
        sanitizeReportFileName(fileName) || sanitizeReportFileName(generated) || generated;

      const result = await ipc.saveFile({
        defaultPath,
        content: html,
        filterName: 'HTML',
        extensions: ['html'],
        encoding: 'utf8',
        mimeType: 'text/html',
      });

      // A cancelled native/browser save keeps the dialog (and any capture
      // warnings) available so the user can retry or reconsider.
      if (result.canceled) return;
      if (result.error) {
        setError(t('shareReport.failedDetail', { error: result.error }));
        return;
      }
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? t('shareReport.failedDetail', { error: err.message })
          : t('shareReport.failed'),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, fileName, t]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (busy) return;
      setOpen(false);
    },
    [busy],
  );

  const triggerDisabled = isLoading || busy || !pageData || !pdfDocRef;

  const commands = useMemo<CommandDefinition[]>(
    () => [
      {
        id: 'export.report',
        title: t('command.exportReport'),
        group: 'Export',
        keywords: ['report', 'html', 'audit', 'annotations', 'share'],
        isEnabled: () => {
          const store = usePdfStore.getState();
          return Boolean(store.pageData && store.pdfDocRef) && !store.isLoading && !busy;
        },
        run: () => setOpen(true),
      },
    ],
    [busy, t],
  );
  useRegisterCommands('share-report-button', commands);

  return (
    <div className={styles.container}>
      <button
        className={styles.button}
        type="button"
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The visible label is the compact `Report…`; the full `Share report…`
        // stays the accessible name so the control is unambiguous in the
        // toolbar, the command palette and screen readers.
        aria-label={t('shareReport.trigger')}
        title={t('shareReport.triggerTitle')}
        onClick={() => setOpen(true)}
      >
        {t('shareReport.triggerShort')}
      </button>

      {open && (
        <div className={styles.backdrop} onClick={handleBackdropClick}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            ref={dialogRef}
          >
            <h2 id={titleId} className={styles.title}>
              {t('shareReport.title')}
            </h2>
            <p id={descriptionId} className={styles.description}>
              {t('shareReport.description')}
            </p>
            <p className={styles.note}>{t('shareReport.privacyNote')}</p>

            <div className={styles.fileNameRow}>
              <label htmlFor={fileNameId} className={styles.fileNameLabel}>
                {t('shareReport.fileName')}
              </label>
              <input
                id={fileNameId}
                className={styles.fileNameInput}
                type="text"
                value={fileName}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setFileName(event.target.value)}
              />
            </div>

            <div className={styles.errorArea} role="alert">
              {error}
            </div>

            {warnings.length > 0 && (
              <div className={styles.warningArea} role="status">
                <div className={styles.warningTitle}>{t('shareReport.warnings')}</div>
                <ul className={styles.warningList}>
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.actions}>
              <button
                className={styles.button}
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                {t('common.cancel')}
              </button>
              <button
                className={`${styles.button} ${styles.primary}`}
                type="button"
                onClick={() => void handleGenerate()}
                disabled={busy}
              >
                {busy ? t('shareReport.generating') : t('shareReport.generate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
