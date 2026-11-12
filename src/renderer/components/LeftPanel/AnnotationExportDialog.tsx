import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { AnnotationIndexResult } from '../../services/annotation-index';
import {
  annotationIndexToCsv,
  annotationIndexToJson,
  suggestAnnotationFilename,
} from '../../services/annotation-export';
import { sanitizeExportFileName, swapExportFormatExtension } from '../../services/export-data';
import { ipc } from '../../services/ipc-client';
import styles from './AnnotationExportDialog.module.css';

type Format = 'json' | 'csv';

export interface AnnotationExportDialogProps {
  /** Mounted by the tab only while open; the flag also resets the draft state. */
  open: boolean;
  /** The finished document index; the dialog never re-reads the PDF. */
  result: AnnotationIndexResult;
  documentName: string | null;
  sourceUrl: string | null;
  filePath: string | null;
  /** Total document pages, written into the JSON `document` block. */
  pageCount: number;
  onClose: () => void;
}

/**
 * Modal for exporting the whole-document annotation index as JSON or CSV.
 *
 * It is the annotation counterpart of the toolbar `ExportDialog`: the same
 * editable-name/format behaviour (auto name follows the format, an edited stem
 * keeps its extension swapped), but the payload is the index the tab already
 * holds, so no page is re-extracted and no PDF is modified.
 */
export const AnnotationExportDialog: React.FC<AnnotationExportDialogProps> = ({
  open,
  result,
  documentName,
  sourceUrl,
  filePath,
  pageCount,
  onClose,
}) => {
  const t = useT();
  const [format, setFormat] = useState<Format>('json');
  const [fileName, setFileName] = useState('');
  // The generated suggestion `fileName` currently mirrors. While they are
  // equal, a format change may replace the whole value; once the user edits it,
  // only a recognised extension is swapped.
  const [autoFileName, setAutoFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const formatName = useId();
  const formatLabelId = useId();
  const fileNameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  const generatedName = useCallback(
    (nextFormat: Format): string =>
      suggestAnnotationFilename(documentName, sourceUrl, filePath, nextFormat),
    [documentName, filePath, sourceUrl],
  );

  // Fresh draft whenever the dialog opens: JSON plus the suggested name.
  useEffect(() => {
    if (!open) return;
    const generated = generatedName('json');
    setFormat('json');
    setFileName(generated);
    setAutoFileName(generated);
    setError(null);
    setBusy(false);
    dialogRef.current?.focus();
  }, [generatedName, open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler (window, bubble phase) never
    // also clears the selection. Closing is blocked while saving: the request is
    // already in flight and there is no cancellation.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (busy) return;
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, onClose, open]);

  const handleFormatChange = useCallback(
    (nextFormat: Format) => {
      const generated = generatedName(nextFormat);
      setFormat(nextFormat);
      setAutoFileName(generated);
      setFileName((current) =>
        current === autoFileName ? generated : swapExportFormatExtension(current, nextFormat),
      );
    },
    [autoFileName, generatedName],
  );

  const handleExport = useCallback(async () => {
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const content =
        format === 'json'
          ? annotationIndexToJson(result, { name: documentName, sourceUrl, pages: pageCount })
          : annotationIndexToCsv(result);

      // The user's name is normalised (no directories, exactly one extension);
      // an unusable value falls back to the generated suggestion.
      const defaultPath =
        sanitizeExportFileName(fileName, format) ||
        sanitizeExportFileName(generatedName(format), format);

      const saved = await ipc.saveFile({
        defaultPath,
        content,
        filterName: format.toUpperCase(),
        extensions: [format],
      });

      // Cancelling the native dialog is not an error: just close.
      if (saved.canceled) {
        onClose();
        return;
      }
      if (saved.error) {
        setError(t('export.failedDetail', { error: saved.error }));
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('export.failed'));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    documentName,
    filePath,
    fileName,
    format,
    generatedName,
    onClose,
    pageCount,
    result,
    sourceUrl,
    t,
  ]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (busy) return;
      onClose();
    },
    [busy, onClose],
  );

  if (!open) return null;

  return (
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
          {t('annotationExport.title')}
        </h2>

        <div className={styles.row}>
          <span id={formatLabelId} className={styles.rowLabel}>
            {t('export.format')}
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
            {t('export.fileName')}
          </label>
          <input
            id={fileNameId}
            className={styles.fileNameInput}
            type="text"
            value={fileName}
            placeholder={`report-annotations.${format}`}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setFileName(event.target.value)}
          />
        </div>

        <div className={styles.errorArea} role="alert">
          {error}
        </div>

        <div className={styles.actions}>
          <button className={styles.button} type="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            type="button"
            onClick={() => void handleExport()}
            disabled={busy}
          >
            {busy ? t('common.exporting') : t('annotationExport.export')}
          </button>
        </div>
      </div>
    </div>
  );
};
