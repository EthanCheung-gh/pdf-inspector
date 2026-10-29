import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { EXPORT_OBJECT_TYPES, pagesToCsv, pagesToJson, suggestFilename } from '../../services/export-data';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
import type { PageData, PdfObjectType } from '../../types/pdf-objects';
import { ExportTypeSelector } from '../ExportTypeSelector';
import styles from './ExportDialog.module.css';

type Scope = 'page' | 'document';
type Format = 'json' | 'csv';

const ALL_TYPES: PdfObjectType[] = [...EXPORT_OBJECT_TYPES];

/**
 * Toolbar export entry point: a trigger button plus the modal that replaces the
 * old four-item dropdown. The modal owns scope, format and the object-type
 * selection so a single export can be trimmed to the types the user cares about.
 */
export const ExportDialog: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('page');
  const [format, setFormat] = useState<Format>('json');
  const [types, setTypes] = useState<PdfObjectType[]>(ALL_TYPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageData = usePdfStore((s) => s.pageData);
  const isLoading = usePdfStore((s) => s.isLoading);
  const exportProgress = usePdfStore((s) => s.exportProgress);

  const titleId = useId();
  const scopeName = useId();
  const formatName = useId();
  const scopeLabelId = useId();
  const formatLabelId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fresh dialog state every time it opens: all types, page scope, JSON.
  useEffect(() => {
    if (!open) return;
    setScope('page');
    setFormat('json');
    setTypes([...EXPORT_OBJECT_TYPES]);
    setError(null);
    setBusy(false);
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler (window, bubble phase)
    // never also clears the selection/subset. Closing is blocked while an
    // export is running: there is no cancellation, so the run must finish.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (busy) return;
      setOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, open]);

  const handleExport = useCallback(async () => {
    if (busy || types.length === 0) return;
    const store = usePdfStore.getState();
    if (!store.filePath) {
      setError('No document is open.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let pages: PageData[];
      if (scope === 'page') {
        if (!store.pageData) throw new Error('Page data not loaded yet');
        pages = [store.pageData];
      } else {
        store.setExportProgress({ done: 0, total: store.pageCount });
        pages = [];
        for (let p = 1; p <= store.pageCount; p += 1) {
          const data = await ipc.extractPage(p);
          pages.push(data);
          usePdfStore.getState().setExportProgress({ done: p, total: store.pageCount });
        }
      }

      const content =
        format === 'json' ? pagesToJson(pages, store.metadata, types) : pagesToCsv(pages, types);
      const result = await ipc.saveFile({
        defaultPath: suggestFilename(store.filePath, scope, store.currentPage, format, store.sourceUrl),
        content,
        filterName: format.toUpperCase(),
        extensions: [format],
      });

      if (result.canceled) {
        setOpen(false);
        return;
      }
      if (result.error) {
        setError(`Export failed: ${result.error}`);
        return;
      }
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      usePdfStore.getState().setExportProgress(null);
      setBusy(false);
    }
  }, [busy, format, scope, types]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (busy) return;
      setOpen(false);
    },
    [busy],
  );

  const triggerDisabled = isLoading || busy || !pageData;
  const exportDisabled = busy || types.length === 0;

  return (
    <div className={styles.container}>
      <button
        className={styles.button}
        type="button"
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Export
      </button>

      {open && (
        <div className={styles.backdrop} onClick={handleBackdropClick}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            ref={dialogRef}
          >
            <h2 id={titleId} className={styles.title}>
              Export
            </h2>

            <div className={styles.row}>
              <span id={scopeLabelId} className={styles.rowLabel}>
                Scope
              </span>
              <div className={styles.radios} role="radiogroup" aria-labelledby={scopeLabelId}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={scopeName}
                    value="page"
                    checked={scope === 'page'}
                    disabled={busy}
                    onChange={() => setScope('page')}
                  />
                  Current page
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={scopeName}
                    value="document"
                    checked={scope === 'document'}
                    disabled={busy}
                    onChange={() => setScope('document')}
                  />
                  Whole document
                </label>
              </div>
            </div>

            <div className={styles.row}>
              <span id={formatLabelId} className={styles.rowLabel}>
                Format
              </span>
              <div className={styles.radios} role="radiogroup" aria-labelledby={formatLabelId}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={formatName}
                    value="json"
                    checked={format === 'json'}
                    disabled={busy}
                    onChange={() => setFormat('json')}
                  />
                  JSON
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={formatName}
                    value="csv"
                    checked={format === 'csv'}
                    disabled={busy}
                    onChange={() => setFormat('csv')}
                  />
                  CSV
                </label>
              </div>
            </div>

            <div className={styles.selectorRow}>
              <ExportTypeSelector selected={types} onChange={setTypes} disabled={busy} />
            </div>

            <div className={styles.errorArea} role="alert">
              {error}
            </div>

            {exportProgress && (
              <div className={styles.progress} role="status">
                Extracting page {exportProgress.done} of {exportProgress.total}…
              </div>
            )}

            <div className={styles.actions}>
              <button
                className={styles.button}
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className={`${styles.button} ${styles.primary}`}
                type="button"
                onClick={() => void handleExport()}
                disabled={exportDisabled}
              >
                {busy ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
