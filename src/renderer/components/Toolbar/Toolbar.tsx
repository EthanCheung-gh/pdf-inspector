import React, { useCallback, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import { SearchBox } from './SearchBox';
import { ExportMenu } from './ExportMenu';
import { OpenUrlDialog } from './OpenUrlDialog';
import type { OpenedFromUrl } from './OpenUrlDialog';
import styles from './Toolbar.module.css';

const OVERLAYS = [
  ['Chars', 'char'],
  ['Words', 'word'],
  ['Lines', 'line'],
  ['Curves', 'curve'],
  ['Rects', 'rect'],
  ['Tables', 'table'],
  ['Images', 'image'],
] as const;

export const Toolbar: React.FC = () => {
  const openRequestIdRef = useRef(0);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageCount = usePdfStore((state) => state.pageCount);
  const zoom = usePdfStore((state) => state.zoom);
  const fitWidthZoom = usePdfStore((state) => state.fitWidthZoom);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const isLoading = usePdfStore((state) => state.isLoading);
  const filePath = usePdfStore((state) => state.filePath);
  const sourceUrl = usePdfStore((state) => state.sourceUrl);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const regionMode = usePdfStore((state) => state.regionMode);
  const setFile = usePdfStore((state) => state.setFile);
  const setZoom = usePdfStore((state) => state.setZoom);
  const setLoading = usePdfStore((state) => state.setLoading);
  const setError = usePdfStore((state) => state.setError);
  const setFitWidthZoom = usePdfStore((state) => state.setFitWidthZoom);
  const setTextSelectionMode = usePdfStore((state) => state.setTextSelectionMode);
  const setRegionMode = usePdfStore((state) => state.setRegionMode);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);
  const { navigate } = usePageNavigation();

  const handleOpen = useCallback(async () => {
    const openRequestId = ++openRequestIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const result = await ipc.openPdf();
      if (openRequestId !== openRequestIdRef.current) return;
      if (result.canceled) {
        setLoading(false);
        return;
      }

      setFile(result.path, result.metadata);
      await navigate(1);
    } catch (error) {
      if (openRequestId !== openRequestIdRef.current) return;
      console.error('Failed to open PDF:', error);
      setError(error instanceof Error ? error.message : 'Failed to open PDF');
      setLoading(false);
    }
  }, [navigate, setError, setFile, setLoading]);

  const handleUrlOpened = useCallback(
    async (result: OpenedFromUrl) => {
      // Invalidate any in-flight local `openPdf` dialog: the URL document is
      // the newest request and must not be clobbered when that one settles.
      openRequestIdRef.current += 1;
      setFile(result.path, result.metadata, result.sourceUrl ?? null);
      await navigate(1);
    },
    [navigate, setFile],
  );

  const handleFitWidth = useCallback(() => {
    if (fitWidthZoom !== null) {
      setFitWidthZoom(fitWidthZoom);
    }
  }, [fitWidthZoom, setFitWidthZoom]);

  const handleTextSelectionToggle = useCallback(() => {
    setTextSelectionMode(!textSelectionMode);
    if (!textSelectionMode) setRegionMode(false);
  }, [setRegionMode, setTextSelectionMode, textSelectionMode]);

  const handleRegionToggle = useCallback(() => {
    setRegionMode(!regionMode);
    if (!regionMode) setTextSelectionMode(false);
  }, [regionMode, setRegionMode, setTextSelectionMode]);

  const displayTitle = sourceUrl ?? filePath ?? undefined;
  const filename = sourceUrl ?? (filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : 'No file open');

  return (
    <header className={styles.toolbar}>
      <button className={styles.button} type="button" onClick={handleOpen} disabled={isLoading}>
        Open
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={() => setUrlDialogOpen(true)}
        disabled={isLoading}
        title="Open a PDF from an http(s) URL"
      >
        Open URL
      </button>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Page navigation">
        <button
          className={styles.button}
          type="button"
          onClick={() => void navigate(currentPage - 1)}
          disabled={isLoading || currentPage <= 1}
        >
          Prev
        </button>
        <span className={styles.value}>{currentPage} / {pageCount}</span>
        <button
          className={styles.button}
          type="button"
          onClick={() => void navigate(currentPage + 1)}
          disabled={isLoading || currentPage >= pageCount}
        >
          Next
        </button>
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Zoom controls">
        <button
          className={styles.button}
          type="button"
          onClick={() => setZoom(zoom - 0.25)}
          disabled={zoom <= 0.25}
        >
          −
        </button>
        <span className={styles.value}>{Math.round(zoom * 100)}%</span>
        <button
          className={styles.button}
          type="button"
          onClick={() => setZoom(zoom + 0.25)}
          disabled={zoom >= 5}
        >
          +
        </button>
        <button
          className={`${styles.button} ${fitWidthZoom !== null && Math.abs(zoom - fitWidthZoom) < 0.01 ? styles.active : ''}`}
          type="button"
          onClick={handleFitWidth}
          disabled={fitWidthZoom === null}
          title="Fit page width"
        >
          Fit W
        </button>
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Overlay visibility">
        {OVERLAYS.map(([label, type]) => (
          <button
            className={`${styles.button} ${overlayVisibility[type] ? styles.active : ''}`}
            type="button"
            key={type}
            onClick={() => toggleOverlay(type)}
            aria-pressed={overlayVisibility[type]}
          >
            {label}
          </button>
        ))}
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Text selection">
        <button
          className={`${styles.button} ${textSelectionMode ? styles.active : ''}`}
          type="button"
          onClick={handleTextSelectionToggle}
          aria-pressed={textSelectionMode}
          title="Toggle text selection mode (T)"
        >
          Select Text
        </button>
        <button
          className={`${styles.button} ${regionMode ? styles.active : ''}`}
          type="button"
          onClick={handleRegionToggle}
          aria-pressed={regionMode}
          title="Toggle region selection mode (R)"
        >
          Region
        </button>
      </div>

      <div className={styles.spacer} />
      <ExportMenu />
      <SearchBox />
      <span className={styles.filename} title={displayTitle}>{filename}</span>

      <OpenUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        onOpened={handleUrlOpened}
      />
    </header>
  );
};
