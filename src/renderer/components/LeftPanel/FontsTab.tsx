import React, { useEffect, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import type { FontStat } from '../../types/ipc-protocol';
import styles from './FontsTab.module.css';

export const FontsTab: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const fontStats = usePdfStore((s) => s.fontStats);
  const isLoading = usePdfStore((s) => s.isLoading);
  const setFontStats = usePdfStore((s) => s.setFontStats);
  const setError = usePdfStore((s) => s.setError);
  const setFilterCriteria = usePdfStore((s) => s.setFilterCriteria);
  const { navigate } = usePageNavigation();
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath || fontStats !== null || localError !== null) return;
    if (isLoading) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await ipc.analyzeFonts();
        if (!cancelled) setFontStats(result.fonts);
      } catch (error) {
        if (!cancelled) {
          setLocalError(error instanceof Error ? error.message : 'Failed to analyze fonts');
          setError('Failed to analyze fonts. Please try again.');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [filePath, fontStats, isLoading, localError, setError, setFontStats]);

  const handleRetry = (): void => {
    setLocalError(null);
    setError(null);
  };

  const handleClick = (font: FontStat): void => {
    if (font.pages.length === 0) return;
    void navigate(font.pages[0]);
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
  if (isLoading && fontStats === null) {
    return <div className={styles.stateBox}>Analyzing fonts…</div>;
  }
  if (fontStats === null) {
    return <div className={styles.stateBox} />;
  }
  if (fontStats.length === 0) {
    return <div className={styles.stateBox}>No text fonts detected in this document.</div>;
  }

  return (
    <ul className={styles.list}>
      {fontStats.map((font) => (
        <li key={font.fontname}>
          <button type="button" className={styles.row} onClick={() => handleClick(font)}>
            <span className={styles.name}>{font.fontname}</span>
            <span className={styles.meta}>
              {font.pages.length} page{font.pages.length === 1 ? '' : 's'} · {font.charCount} chars · {font.sizeMin}–{font.sizeMax}pt
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
