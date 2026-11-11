import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  EXPORT_OBJECT_TYPES,
  pagesToCsv,
  pagesToJson,
  sanitizeExportFileName,
  suggestFilename,
  swapExportFormatExtension,
} from '../../services/export-data';
import { ipc } from '../../services/ipc-client';
import { useRegisterCommands } from '../../hooks/useRegisterCommands';
import type { CommandDefinition } from '../../services/command-registry';
import { usePdfStore } from '../../store/pdf-store';
import type { PageData, PdfObjectType } from '../../types/pdf-objects';
import { ExportTypeSelector } from '../ExportTypeSelector';
import styles from './ExportDialog.module.css';

type Scope = 'page' | 'document';
type Format = 'json' | 'csv';

const ALL_TYPES: PdfObjectType[] = [...EXPORT_OBJECT_TYPES];

/**
 * Auto-generated name for a scope/format, from the open document.
 *
 * Read straight from the store so the open handler and the scope/format
 * handlers always derive the default the same way.
 */
function generatedFileName(scope: Scope, format: Format): string {
  const store = usePdfStore.getState();
  return suggestFilename(
    store.filePath,
    scope,
    store.currentPage,
    format,
    store.sourceUrl,
    store.documentName,
  );
}

/**
 * Toolbar export entry point: a trigger button plus the modal that replaces the
 * old four-item dropdown. The modal owns scope, format, the editable file name
 * and the object-type selection so a single export can be trimmed to the types
 * the user cares about.
 */
export const ExportDialog: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('page');
  const [format, setFormat] = useState<Format>('json');
  const [types, setTypes] = useState<PdfObjectType[]>(ALL_TYPES);
  const [fileName, setFileName] = useState('');
  // The generated suggestion `fileName` currently mirrors. While they are
  // equal, scope/format changes may replace the whole value; once the user
  // edits it, only a recognised extension is swapped.
  const [autoFileName, setAutoFileName] = useState('');
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
  const fileNameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fresh dialog state every time it opens: all types, page scope, JSON and the
  // generated name for the open document.
  useEffect(() => {
    if (!open) return;
    const generated = generatedFileName('page', 'json');
    setScope('page');
    setFormat('json');
    setTypes([...EXPORT_OBJECT_TYPES]);
    setFileName(generated);
    setAutoFileName(generated);
    setError(null);
    setBusy(false);
    dialogRef.current?.focus();
  }, [open]);

  const handleScopeChange = useCallback(
    (nextScope: Scope) => {
      const generated = generatedFileName(nextScope, format);
      setScope(nextScope);
      setAutoFileName(generated);
      // An untouched name follows the new suggestion; a custom name is kept
      // (only the format affects its extension).
      setFileName((current) => (current === autoFileName ? generated : current));
    },
    [autoFileName, format],
  );

  const handleFormatChange = useCallback(
    (nextFormat: Format) => {
      const generated = generatedFileName(scope, nextFormat);
      setFormat(nextFormat);
      setAutoFileName(generated);
      setFileName((current) =>
        current === autoFileName ? generated : swapExportFormatExtension(current, nextFormat),
      );
    },
    [autoFileName, scope],
  );

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
      // The user's name is normalised (no directories, exactly one extension);
      // an unusable value falls back to the generated suggestion.
      const generated = generatedFileName(scope, format);
      const defaultPath =
        sanitizeExportFileName(fileName, format) || sanitizeExportFileName(generated, format);
      const result = await ipc.saveFile({
        defaultPath,
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
  }, [busy, fileName, format, scope, types]);

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

  const commands = useMemo<CommandDefinition[]>(
    () => [
      {
        id: 'export.objects',
        title: 'Export objects…',
        group: 'Export',
        keywords: ['export', 'save', 'json', 'csv', 'objects'],
        isEnabled: () => {
          const store = usePdfStore.getState();
          return Boolean(store.pageData) && !store.isLoading && !busy;
        },
        run: () => setOpen(true),
      },
    ],
    [busy],
  );
  useRegisterCommands('export-dialog', commands);

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
                    onChange={() => handleScopeChange('page')}
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
                    onChange={() => handleScopeChange('document')}
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
                    onChange={() => handleFormatChange('json')}
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
                    onChange={() => handleFormatChange('csv')}
                  />
                  CSV
                </label>
              </div>
            </div>

            <div className={styles.row}>
              <label htmlFor={fileNameId} className={styles.rowLabel}>
                File name
              </label>
              <input
                id={fileNameId}
                className={styles.fileNameInput}
                type="text"
                value={fileName}
                placeholder={`report-p1.${format}`}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setFileName(event.target.value)}
              />
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
