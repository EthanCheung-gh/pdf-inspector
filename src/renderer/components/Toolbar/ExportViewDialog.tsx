import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import {
  EXPORT_OBJECT_TYPES,
  sanitizeViewFileName,
  suggestViewFilename,
  swapExportFormatExtension,
  type ViewExportFormat,
} from '../../services/export-data';
import {
  capturePage,
  capturePageSvg,
  type CaptureOverlays,
  type CaptureOptions,
} from '../../services/export-capture';
import { ipc } from '../../services/ipc-client';
import { useRegisterCommands } from '../../hooks/useRegisterCommands';
import type { CommandDefinition } from '../../services/command-registry';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import type { PageBox, PdfObjectType } from '../../types/pdf-objects';
import { ExportTypeSelector } from '../ExportTypeSelector';
import styles from './ExportViewDialog.module.css';

type ViewScope = 'page' | 'region';

const ALL_TYPES: PdfObjectType[] = [...EXPORT_OBJECT_TYPES];
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const SCALES = [1, 2, 3] as const;

type OverlayState = CaptureOverlays;

const DEFAULT_OVERLAYS: OverlayState = {
  objects: true,
  annotations: true,
  pageBoxes: false,
};

/**
 * Auto-generated image name for a scope/format, from the open document.
 *
 * Read straight from the store so the open handler and the scope/format
 * handlers always derive the default the same way.
 */
function generatedViewName(scope: ViewScope, format: ViewExportFormat): string {
  const store = usePdfStore.getState();
  return suggestViewFilename(
    store.filePath,
    store.currentPage,
    format,
    store.sourceUrl,
    store.documentName,
    scope === 'region',
  );
}

/**
 * Toolbar entry point for rendering the current page or selected region to a
 * PNG/SVG snapshot. The capture itself lives in `export-capture`; this dialog
 * only owns the options, filename and save flow.
 */
export const ExportViewDialog: React.FC = () => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ViewScope>('page');
  const [format, setFormat] = useState<ViewExportFormat>('png');
  const [scale, setScale] = useState<number>(1);
  const [overlays, setOverlays] = useState<OverlayState>(DEFAULT_OVERLAYS);
  const [types, setTypes] = useState<PdfObjectType[]>(ALL_TYPES);
  const [fileName, setFileName] = useState('');
  // The generated suggestion `fileName` currently mirrors. While they are
  // equal, scope/format changes may replace the whole value; once the user
  // edits it, only a recognised extension is swapped.
  const [autoFileName, setAutoFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const pageData = usePdfStore((s) => s.pageData);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const isLoading = usePdfStore((s) => s.isLoading);
  const subset = usePdfStore((s) => s.subset);
  const hasRegion = subset?.source === 'region' && Boolean(subset.bbox);

  const titleId = useId();
  const scopeName = useId();
  const formatName = useId();
  const scaleName = useId();
  const scopeLabelId = useId();
  const formatLabelId = useId();
  const scaleLabelId = useId();
  const overlayLabelId = useId();
  const fileNameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fresh dialog state every time it opens: page scope, PNG, 1x, objects and
  // annotations on, every object type, and the generated name.
  useEffect(() => {
    if (!open) return;
    const generated = generatedViewName('page', 'png');
    setScope('page');
    setFormat('png');
    setScale(1);
    setOverlays({ ...DEFAULT_OVERLAYS });
    setTypes([...EXPORT_OBJECT_TYPES]);
    setFileName(generated);
    setAutoFileName(generated);
    setError(null);
    setWarnings([]);
    setBusy(false);
    dialogRef.current?.focus();
  }, [open]);

  const handleScopeChange = useCallback(
    (nextScope: ViewScope) => {
      const generated = generatedViewName(nextScope, format);
      setScope(nextScope);
      setAutoFileName(generated);
      // An untouched name follows the new suggestion; a custom name is kept
      // (only the format affects its extension).
      setFileName((current) => (current === autoFileName ? generated : current));
    },
    [autoFileName, format],
  );

  const handleFormatChange = useCallback(
    (nextFormat: ViewExportFormat) => {
      const generated = generatedViewName(scope, nextFormat);
      setFormat(nextFormat);
      setAutoFileName(generated);
      setFileName((current) =>
        current === autoFileName ? generated : swapExportFormatExtension(current, nextFormat),
      );
    },
    [autoFileName, scope],
  );

  const handleOverlayChange = useCallback(
    (key: keyof CaptureOverlays, value: boolean) => {
      setOverlays((current) => ({ ...current, [key]: value }));
    },
    [],
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
    if (busy) return;

    const store = usePdfStore.getState();
    const pdfDoc = store.pdfDocRef;
    const currentPageData = store.pageData;
    if (!pdfDoc || !currentPageData) {
      setError(t('exportView.documentMissing'));
      return;
    }
    if (!store.filePath && !store.sourceUrl) {
      setError(t('exportView.noDocument'));
      return;
    }

    let region: PageBox | null = null;
    if (scope === 'region') {
      region =
        store.subset?.source === 'region' ? (store.subset.bbox ?? null) : null;
      if (!region) {
        setError(t('exportView.regionMissing'));
        return;
      }
    }

    const annotations = useAnnotationStore.getState().annotations;
    const options: CaptureOptions = {
      scale,
      region,
      overlays,
      objectTypes: types,
    };

    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const captured = await capturePage(
        pdfDoc,
        store.currentPage,
        currentPageData,
        annotations,
        options,
      );
      setWarnings(captured.warnings);

      let content: string;
      if (format === 'svg') {
        content = capturePageSvg(captured, currentPageData, annotations, options);
      } else {
        if (!captured.pngDataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
          throw new Error(t('exportView.invalidPng'));
        }
        // The save channel carries text; PNG bytes are sent as base64 so main
        // and the browser adapter can decode them back to binary.
        content = captured.pngDataUrl.slice(PNG_DATA_URL_PREFIX.length);
      }

      // The user's name is normalised (no directories, exactly one extension);
      // an unusable value falls back to the generated suggestion.
      const generated = suggestViewFilename(
        store.filePath,
        store.currentPage,
        format,
        store.sourceUrl,
        store.documentName,
        region !== null,
      );
      const defaultPath =
        sanitizeViewFileName(fileName, format) || sanitizeViewFileName(generated, format);

      const result = await ipc.saveFile({
        defaultPath,
        content,
        filterName: format.toUpperCase(),
        extensions: [format],
        encoding: format === 'png' ? 'base64' : 'utf8',
        mimeType: format === 'png' ? 'image/png' : 'image/svg+xml',
      });

      // A cancelled native/browser save keeps the dialog (and any capture
      // warnings) available so the user can retry or reconsider.
      if (result.canceled) return;
      if (result.error) {
        setError(t('exportView.failedDetail', { error: result.error }));
        return;
      }
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? t('exportView.failedDetail', { error: err.message })
          : t('exportView.failed'),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, fileName, format, overlays, scale, scope, t, types]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (busy) return;
      setOpen(false);
    },
    [busy],
  );

  const triggerDisabled = isLoading || busy || !pageData || !pdfDocRef;
  const exportDisabled = busy || (overlays.objects && types.length === 0);

  const commands = useMemo<CommandDefinition[]>(
    () => [
      {
        id: 'export.view',
        title: t('command.exportView'),
        group: 'Export',
        keywords: ['export', 'view', 'png', 'svg', 'image', 'capture', 'page', 'region'],
        isEnabled: () => {
          const store = usePdfStore.getState();
          return Boolean(store.pageData && store.pdfDocRef) && !store.isLoading && !busy;
        },
        run: () => setOpen(true),
      },
    ],
    [busy, t],
  );
  useRegisterCommands('export-view-dialog', commands);

  return (
    <div className={styles.container}>
      <button
        className={styles.button}
        type="button"
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The visible label is the compact `View…`; the full `Export view…`
        // stays the accessible name so the control is unambiguous in the
        // toolbar, the command palette and screen readers.
        aria-label={t('exportView.trigger')}
        title={t('exportView.triggerTitle')}
        onClick={() => setOpen(true)}
      >
        {t('exportView.triggerShort')}
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
              {t('exportView.title')}
            </h2>

            <div className={styles.row}>
              <span id={scopeLabelId} className={styles.rowLabel}>
                {t('exportView.scope')}
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
                  {t('exportView.scopePage')}
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={scopeName}
                    value="region"
                    checked={scope === 'region'}
                    disabled={busy || !hasRegion}
                    onChange={() => handleScopeChange('region')}
                  />
                  {t('exportView.scopeRegion')}
                </label>
                {!hasRegion && <span className={styles.hint}>{t('exportView.regionHint')}</span>}
              </div>
            </div>

            <div className={styles.row}>
              <span id={formatLabelId} className={styles.rowLabel}>
                {t('exportView.format')}
              </span>
              <div className={styles.radios} role="radiogroup" aria-labelledby={formatLabelId}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={formatName}
                    value="png"
                    checked={format === 'png'}
                    disabled={busy}
                    onChange={() => handleFormatChange('png')}
                  />
                  PNG
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name={formatName}
                    value="svg"
                    checked={format === 'svg'}
                    disabled={busy}
                    onChange={() => handleFormatChange('svg')}
                  />
                  SVG
                </label>
              </div>
            </div>

            <div className={styles.row}>
              <span id={scaleLabelId} className={styles.rowLabel}>
                {t('exportView.scale')}
              </span>
              <div className={styles.radios} role="radiogroup" aria-labelledby={scaleLabelId}>
                {SCALES.map((option) => (
                  <label key={option} className={styles.radioLabel}>
                    <input
                      type="radio"
                      name={scaleName}
                      value={option}
                      checked={scale === option}
                      disabled={busy}
                      onChange={() => setScale(option)}
                    />
                    {option}x
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.row}>
              <span id={overlayLabelId} className={styles.rowLabel}>
                {t('exportView.overlays')}
              </span>
              <div className={styles.checkboxes} role="group" aria-labelledby={overlayLabelId}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={overlays.objects}
                    disabled={busy}
                    onChange={(event) => handleOverlayChange('objects', event.target.checked)}
                  />
                  {t('exportView.overlayObjects')}
                </label>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={overlays.annotations}
                    disabled={busy}
                    onChange={(event) => handleOverlayChange('annotations', event.target.checked)}
                  />
                  {t('exportView.overlayAnnotations')}
                </label>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={overlays.pageBoxes}
                    disabled={busy}
                    onChange={(event) => handleOverlayChange('pageBoxes', event.target.checked)}
                  />
                  {t('exportView.overlayPageBoxes')}
                </label>
              </div>
            </div>

            <div className={styles.row}>
              <label htmlFor={fileNameId} className={styles.rowLabel}>
                {t('exportView.fileName')}
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
              <ExportTypeSelector
                selected={types}
                onChange={setTypes}
                disabled={busy || !overlays.objects}
              />
            </div>

            <div className={styles.errorArea} role="alert">
              {error}
            </div>

            {warnings.length > 0 && (
              <div className={styles.warningArea} role="status">
                <div className={styles.warningTitle}>{t('exportView.warnings')}</div>
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
                onClick={() => void handleExport()}
                disabled={exportDisabled}
              >
                {busy ? t('common.exporting') : t('exportView.export')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
