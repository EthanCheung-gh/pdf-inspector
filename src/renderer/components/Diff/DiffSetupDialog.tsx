import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DiffResourceType, DiffSide } from '../../../shared/diff-types';
import { useT, type MessageKey } from '../../i18n';
import { ipc } from '../../services/ipc-client';
import { useElapsedSeconds } from '../../hooks/useElapsedSeconds';
import { selectCharacterLevelChanges, useDiffStore } from '../../store/diff-store';
import styles from './DiffSetupDialog.module.css';

/** The five content switches of the `Content` group, in display order. */
const CONTENT_OPTIONS: ReadonlyArray<{
  type: DiffResourceType;
  labelKey: MessageKey;
  /** The store option the checkbox reads; `true` means "skip this resource". */
  ignoreKey:
    | 'ignoreAnnotations'
    | 'ignoreLinks'
    | 'ignoreForms'
    | 'ignoreMetadata'
    | 'ignorePageLabels';
}> = [
  { type: 'annotation', labelKey: 'diff.setup.includeAnnotations', ignoreKey: 'ignoreAnnotations' },
  { type: 'link', labelKey: 'diff.setup.includeLinks', ignoreKey: 'ignoreLinks' },
  { type: 'form', labelKey: 'diff.setup.includeForms', ignoreKey: 'ignoreForms' },
  { type: 'metadata', labelKey: 'diff.setup.includeMetadata', ignoreKey: 'ignoreMetadata' },
  { type: 'page-label', labelKey: 'diff.setup.includePageLabels', ignoreKey: 'ignorePageLabels' },
];

/**
 * Old/new pickers plus the handful of engine options the UI exposes.
 *
 * The dialog is mounted once (in `App`) and driven by the diff store, so both
 * the toolbar entry and the workspace's "Change files" action open the same
 * instance without duplicating source state.
 */
export const DiffSetupDialog: React.FC = () => {
  const t = useT();
  const open = useDiffStore((s) => s.setupOpen);
  const oldName = useDiffStore((s) => s.oldName);
  const newName = useDiffStore((s) => s.newName);
  const options = useDiffStore((s) => s.options);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const setPositionTolerance = useDiffStore((s) => s.setPositionTolerance);
  const setOptions = useDiffStore((s) => s.setOptions);
  const setResourceIncluded = useDiffStore((s) => s.setResourceIncluded);
  const characterLevelChanges = useDiffStore(selectCharacterLevelChanges);
  const setCharacterLevelChanges = useDiffStore((s) => s.setCharacterLevelChanges);
  const closeSetup = useDiffStore((s) => s.closeSetup);

  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState<DiffSide | null>(null);
  // Informational only: a diff has no trustworthy percentage, but how long it
  // has been running is exact. Resets whenever loading turns off.
  const elapsedSeconds = useElapsedSeconds(loading);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const toleranceId = useId();
  const contentId = useId();

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
        setPickError(err instanceof Error ? err.message : t('diff.setup.pickFailed'));
      } finally {
        setPicking(null);
      }
    },
    [picking, t],
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
      useDiffStore
        .getState()
        .setError(err instanceof Error ? err.message : t('diff.setup.diffFailed'));
    }
  }, [t]);

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
          {t('diff.setup.title')}
        </h2>
        <p className={styles.hint}>{t('diff.setup.hint')}</p>

        <div className={styles.pickerRow}>
          <span className={styles.rowLabel}>{t('diff.setup.old')}</span>
          <span className={styles.fileName} title={oldName ?? undefined}>
            {oldName ?? t('diff.setup.noFileSelected')}
          </span>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handlePick('old')}
            disabled={loading || picking !== null}
            aria-label={t('diff.setup.chooseOld')}
          >
            {picking === 'old' ? t('diff.setup.choosing') : t('diff.setup.choose')}
          </button>
        </div>

        <div className={styles.pickerRow}>
          <span className={styles.rowLabel}>{t('diff.setup.new')}</span>
          <span className={styles.fileName} title={newName ?? undefined}>
            {newName ?? t('diff.setup.noFileSelected')}
          </span>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handlePick('new')}
            disabled={loading || picking !== null}
            aria-label={t('diff.setup.chooseNew')}
          >
            {picking === 'new' ? t('diff.setup.choosing') : t('diff.setup.choose')}
          </button>
        </div>

        <div className={styles.options}>
          <div className={styles.toleranceRow}>
            <label className={styles.rowLabel} htmlFor={toleranceId}>
              {t('diff.setup.positionTolerance')}
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
            {t('diff.setup.ignoreFonts')}
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.ignoreColors}
              disabled={loading}
              onChange={(event) => setOptions({ ignoreColors: event.target.checked })}
            />
            {t('diff.setup.ignoreColours')}
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.ignoreImages}
              disabled={loading}
              onChange={(event) => setOptions({ ignoreImages: event.target.checked })}
            />
            {t('diff.setup.ignoreImages')}
          </label>
          {/*
            Character-level diffs are off by default: word-level changes already
            report text edits, and comparing every glyph of a large text PDF can
            produce millions of changes (minutes of work, unreadable list).
          */}
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={characterLevelChanges}
              disabled={loading}
              onChange={(event) => setCharacterLevelChanges(event.target.checked)}
            />
            {t('diff.setup.characterLevel')}
          </label>
          <p className={styles.optionHint}>{t('diff.setup.characterLevelHint')}</p>
        </div>

        {/*
          Resources are on by default: their counts are small compared with
          character-level object changes, and a metadata edit is cheap to find.
          Every switch is read-only — nothing is opened, filled in or executed.
        */}
        <div className={styles.options} role="group" aria-labelledby={contentId}>
          <span id={contentId} className={styles.groupTitle}>
            {t('diff.setup.contentGroup')}
          </span>
          {CONTENT_OPTIONS.map((option) => (
            <label key={option.type} className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={options[option.ignoreKey] !== true}
                disabled={loading}
                onChange={(event) => setResourceIncluded(option.type, event.target.checked)}
              />
              {t(option.labelKey)}
            </label>
          ))}
          <p className={styles.optionHint}>{t('diff.setup.contentHint')}</p>
        </div>

        <div className={styles.errorArea} role="alert">
          {message}
        </div>

        {loading && (
          <div className={styles.progress} role="status" aria-live="polite">
            {t('diff.setup.comparing')}
            {' '}
            <span className={styles.elapsed} data-testid="diff-elapsed">
              {elapsedSeconds}s
            </span>
            {/*
              Reassurance, not a progress meter: the diff has no reliable
              percentage (page pairing is only known after the fingerprint
              pass), so the dialog states why a large pair takes a while
              instead of inventing a number.
            */}
            <span className={styles.progressHint}>{t('diff.setup.comparingHint')}</span>
          </div>
        )}

        <div className={styles.actions}>
          <button
            className={styles.button}
            type="button"
            onClick={closeSetup}
            disabled={loading}
          >
            {t('common.cancel')}
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            type="button"
            onClick={() => void handleCompare()}
            disabled={!canCompare}
          >
            {loading ? t('diff.setup.comparingButton') : t('diff.setup.compare')}
          </button>
        </div>
      </div>
    </div>
  );
};
