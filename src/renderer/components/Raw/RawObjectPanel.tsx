import React, { useCallback, useEffect, useState } from 'react';
import { useRawStore } from '../../store/raw-store';
import type { RawRef } from '../../types/raw-pdf';
import { formatRawRef, RawValueView } from './RawValueView';
import styles from './RawWorkspace.module.css';

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Detail of the selected object: its summary, the full value tree and a copy
 * of the raw JSON.
 *
 * The panel only reads `raw-store`; selecting a reference inside the value (or
 * clicking "Retry") goes through the store too, so the tree highlight and this
 * panel can never disagree about which object is shown.
 */
export const RawObjectPanel: React.FC = () => {
  const selected = useRawStore((state) => state.selected);
  const object = useRawStore((state) => state.object);
  const loading = useRawStore((state) => state.loading);
  const error = useRawStore((state) => state.error);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

  const selectedLabel = selected ? formatRawRef(selected) : null;

  // A status belongs to one object: "Copied" must not follow the user to the
  // next reference.
  useEffect(() => {
    setCopyStatus('idle');
  }, [selectedLabel]);

  const handleSelectRef = useCallback((ref: RawRef): void => {
    useRawStore.getState().select(ref);
  }, []);

  const handleRetry = useCallback((): void => {
    const store = useRawStore.getState();
    if (store.selected) store.select(store.selected);
  }, []);

  const handleCopy = useCallback(async (): Promise<void> => {
    const current = useRawStore.getState().object;
    if (!current) return;
    try {
      // The payload is plain JSON text; it is written to the clipboard and
      // never rendered as HTML.
      await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }, []);

  return (
    <section className={styles.panel} aria-label="Raw object" data-testid="raw-object-panel">
      <header className={styles.panelHeader}>
        <span className={styles.panelTitle}>
          {selectedLabel ? `Object ${selectedLabel}` : 'Object'}
        </span>
        {object && (
          <span className={styles.panelSummary} title={object.summary}>
            {object.summary}
          </span>
        )}
        <span className={styles.spacer} />
        <button
          className={styles.button}
          type="button"
          onClick={() => void handleCopy()}
          disabled={!object}
          title="Copy the selected object as JSON"
        >
          Copy JSON
        </button>
        {copyStatus !== 'idle' && (
          <span className={styles.copyStatus} role="status" aria-live="polite">
            {copyStatus === 'copied' ? 'Copied' : 'Copy failed'}
          </span>
        )}
      </header>

      <div className={styles.panelBody}>
        {!selected && (
          <p className={styles.empty} data-testid="raw-object-empty">
            Select a reference in the tree to read its object.
          </p>
        )}

        {selected && error && !object && (
          <div className={styles.errorBlock} role="alert">
            <span className={styles.errorText}>
              Failed to read {selectedLabel}: {error}
            </span>
            <button className={styles.button} type="button" onClick={handleRetry}>
              Retry
            </button>
          </div>
        )}

        {selected && !object && !error && (
          <p className={styles.loading} role="status" aria-live="polite">
            {loading ? `Reading ${selectedLabel}…` : `No object loaded for ${selectedLabel}.`}
          </p>
        )}

        {object && (
          <RawValueView value={object.value} onSelectRef={handleSelectRef} />
        )}
      </div>
    </section>
  );
};
