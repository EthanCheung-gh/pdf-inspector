import React, { useEffect, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { analyzeFontsInBatches, formatFontSize } from '../../services/font-stats';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import type { FontStat } from '../../types/ipc-protocol';
import styles from './FontsTab.module.css';

type FontRequest = { filePath: string };

export const FontsTab: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const pageCount = usePdfStore((s) => s.pageCount);
  const fontStats = usePdfStore((s) => s.fontStats);
  const fontProgress = usePdfStore((s) => s.fontProgress);
  const setFontStats = usePdfStore((s) => s.setFontStats);
  const setFontProgress = usePdfStore((s) => s.setFontProgress);
  const setError = usePdfStore((s) => s.setError);
  const setFilterCriteria = usePdfStore((s) => s.setFilterCriteria);
  const { navigate } = usePageNavigation();
  const [localError, setLocalError] = useState<string | null>(null);
  // Identifies the request that is allowed to update state. Re-renders caused by
  // progress, fontStats or navigation (isLoading) changes must not start a
  // duplicate run or cancel a multi-batch one, but the in-flight request must
  // still be able to publish its result.
  const inFlightRef = useRef<FontRequest | null>(null);

  useEffect(() => {
    if (!filePath || fontStats !== null || localError !== null) return;
    // A request for the same document is already running.
    if (inFlightRef.current?.filePath === filePath) return;

    const request: FontRequest = { filePath };
    inFlightRef.current = request;
    const isCurrent = (): boolean => inFlightRef.current === request;

    void (async () => {
      try {
        // Batches are sequential so queued extract_page requests can run in
        // between them instead of waiting for the whole document.
        const result = await analyzeFontsInBatches({
          totalPages: usePdfStore.getState().pageCount,
          fetchBatch: async (startPage, endPage) => (await ipc.analyzeFonts(startPage, endPage)).fonts,
          onProgress: (progress) => {
            if (isCurrent()) setFontProgress(progress);
          },
          isCancelled: () => !isCurrent(),
        });
        // Ignore results that were superseded (e.g. another document was opened)
        // or cancelled: partial results must never be published.
        if (!isCurrent() || result === null) return;
        setFontStats(result);
        setError(null);
      } catch (error) {
        if (!isCurrent()) return;
        setLocalError(error instanceof Error ? error.message : 'Failed to analyze fonts');
        setError('Failed to analyze fonts. Please try again.');
      } finally {
        if (isCurrent()) {
          inFlightRef.current = null;
          setFontProgress(null);
        }
      }
    })();

    return () => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        setFontProgress(null);
      }
    };
  }, [filePath, fontStats, localError, setError, setFontStats, setFontProgress]);

  const handleRetry = (): void => {
    setLocalError(null);
    setError(null);
  };

  const handleClick = async (font: FontStat): Promise<void> => {
    if (font.pages.length === 0) return;
    // Wait for the page's objects to load before filtering, otherwise the
    // subset is computed from the previous page's allObjects.
    await navigate(font.pages[0]);
    setFilterCriteria({ fontname: font.fontname });
  };

  if (!filePath) {
    return <div className={styles.hint}>Open a PDF to analyze fonts.</div>;
  }
  if (localError) {
    return (
      <div className={styles.stateBox}>
        <div>{localError}</div>
        <button type="button" className={styles.retry} onClick={handleRetry}>Retry</button>
      </div>
    );
  }
  if (fontStats === null) {
    const done = fontProgress?.done ?? 0;
    const total = fontProgress?.total ?? pageCount;
    return (
      <div className={styles.stateBox}>
        <div>Analyzing fonts… {done}/{total} pages</div>
        <progress
          className={styles.progress}
          value={done}
          max={Math.max(total, 1)}
          aria-label="Font analysis progress"
        />
      </div>
    );
  }
  if (fontStats.length === 0) {
    return <div className={styles.stateBox}>No text fonts detected in this document.</div>;
  }

  return (
    <ul className={styles.list}>
      {fontStats.map((font) => (
        <li key={font.fontname}>
          <button type="button" className={styles.row} onClick={() => void handleClick(font)}>
            <span className={styles.name}>{font.fontname}</span>
            <span className={styles.meta}>
              {font.pages.length} page{font.pages.length === 1 ? '' : 's'} · {font.charCount} chars · {formatFontSize(font.sizeMin)}–{formatFontSize(font.sizeMax)}pt
            </span>
            <span className={styles.swatches}>
              {font.colors.slice(0, 4).map((color) => (
                <span key={color} className={styles.swatch} style={{ backgroundColor: color }} title={color} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
};
