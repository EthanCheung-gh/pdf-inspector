import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DiffSide } from '../../../shared/diff-types';
import { ipc } from '../../services/ipc-client';
import { useDiffStore } from '../../store/diff-store';
import styles from './DiffSetupDialog.module.css';

/**
 * Old/new pickers plus the handful of engine options the UI exposes.
 *
 * The dialog is mounted once (in `App`) and driven by the diff store, so both
 * the toolbar entry and the workspace's "Change files" action open the same
 * instance without duplicating source state.
 */
export const DiffSetupDialog: React.FC = () => {
  const open = useDiffStore((s) => s.setupOpen);
  const oldName = useDiffStore((s) => s.oldName);
  const newName = useDiffStore((s) => s.newName);
  const options = useDiffStore((s) => s.options);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const setPositionTolerance = useDiffStore((s) => s.setPositionTolerance);
  const setOptions = useDiffStore((s) => s.setOptions);
  const closeSetup = useDiffStore((s) => s.closeSetup);

  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState<DiffSide | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const toleranceId = useId();

  // Fresh transient state on each open; sources/options persist so reopening the
  // dialog to tweak a threshold does not force the user to pick files again.
  useEffect(() => {
    if (!open) return;
    setPickError(null);
    setPicking(null);
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler (window, bubble phase) never
    // also clears the Inspect selection while the dialog is open.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (loading) return;
      closeSetup();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [closeSetup, loading, open]);

  const handlePick = useCallback(
    async (side: DiffSide) => {
      if (picking) return;
      setPickError(null);
      setPicking(side);
      try {
        const picked = await ipc.pickDiffPdf(side);
        useDiffStore.getState().acceptPickedSource(side, picked);
      } catch (err) {
        setPickError(err instanceof Error ? err.message : 'Failed to choose a PDF');
      } finally {
        setPicking(null);
      }
    },
    [picking],
  );

  const handleCompare = useCallback(async () => {
    const state = useDiffStore.getState();
    if (state.loading || !state.oldSource || !state.newSource) return;

    state.setError(null);
    state.setLoading(true);
    try {
      const result = await ipc.diffPdfs(state.oldSource, state.newSource, state.options);
      // `applyResult` clears the loading flag and focuses the first changed page.
      useDiffStore.getState().applyResult(result);
      useDiffStore.getState().enterWorkspace();
    } catch (err) {
      useDiffStore.getState().setLoading(false);
      useDiffStore.getState().setError(err instanceof Error ? err.message : 'Diff failed');
    }
  }, []);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (loading) return;
      closeSetup();
    },
    [closeSetup, loading],
  );

  if (!open) return null;

  const canCompare = Boolean(oldName && newName) && !loading;
  const message = error ?? pickError;

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
          Compare PDFs
        </h2>
        <p className={styles.hint}>
          Diff runs on two throwaway documents: the PDF open in Inspect stays untouched.
        </p>

        <div className={styles.pickerRow}>
          <span className={styles.rowLabel}>Old</span>
          <span className={styles.fileName} title={oldName ?? undefined}>
            {oldName ?? 'No file selected'}
          </span>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handlePick('old')}
            disabled={loading || picking !== null}
            aria-label="Choose old PDF"
          >
            {picking === 'old' ? 'Choosing…' : 'Choose…'}
          </button>
        </div>

        <div className={styles.pickerRow}>
          <span className={styles.rowLabel}>New</span>
          <span className={styles.fileName} title={newName ?? undefined}>
            {newName ?? 'No file selected'}
          </span>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handlePick('new')}
            disabled={loading || picking !== null}
            aria-label="Choose new PDF"
          >
            {picking === 'new' ? 'Choosing…' : 'Choose…'}
          </button>
        </div>

        <div className={styles.options}>
          <div className={styles.toleranceRow}>
            <label className={styles.rowLabel} htmlFor={toleranceId}>
              Position tolerance
            </label>
            <input
              id={toleranceId}
              className={styles.numberInput}
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={options.positionTolerance}
              disabled={loading}
              onChange={(event) => setPositionTolerance(event.target.valueAsNumber)}
            />
            <span className={styles.unit}>pt</span>
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.ignoreFonts}
              disabled={loading}
              onChange={(event) => setOptions({ ignoreFonts: event.target.checked })}
            />
            Ignore fonts
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.ignoreColors}
              disabled={loading}
              onChange={(event) => setOptions({ ignoreColors: event.target.checked })}
            />
            Ignore colours
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.ignoreImages}
              disabled={loading}
              onChange={(event) => setOptions({ ignoreImages: event.target.checked })}
            />
            Ignore images
          </label>
        </div>

        <div className={styles.errorArea} role="alert">
          {message}
        </div>

        {loading && (
          <div className={styles.progress} role="status" aria-live="polite">
            Comparing documents…
            {/*
              Reassurance, not a progress meter: the diff has no reliable
              percentage (page pairing is only known after the fingerprint
              pass), so the dialog states why a large pair takes a while
              instead of inventing a number.
            */}
            <span className={styles.progressHint}>
              Large PDFs can take several minutes; the comparison continues while pages make
              progress.
            </span>
          </div>
        )}

        <div className={styles.actions}>
          <button
            className={styles.button}
            type="button"
            onClick={closeSetup}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            type="button"
            onClick={() => void handleCompare()}
            disabled={!canCompare}
          >
            {loading ? 'Comparing…' : 'Compare'}
          </button>
        </div>
      </div>
    </div>
  );
};
