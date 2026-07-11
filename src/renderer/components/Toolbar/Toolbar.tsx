import React, { useCallback } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
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
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageCount = usePdfStore((state) => state.pageCount);
  const zoom = usePdfStore((state) => state.zoom);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const isLoading = usePdfStore((state) => state.isLoading);
  const filePath = usePdfStore((state) => state.filePath);
  const setFile = usePdfStore((state) => state.setFile);
  const setPage = usePdfStore((state) => state.setPage);
  const setZoom = usePdfStore((state) => state.setZoom);
  const setPageData = usePdfStore((state) => state.setPageData);
  const setLoading = usePdfStore((state) => state.setLoading);
  const setError = usePdfStore((state) => state.setError);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);

  const handleOpen = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await ipc.openPdf();
      if (result.canceled) return;

      setFile(result.path, result.metadata);
      const pageData = await ipc.extractPage(1);
      setPageData(pageData);
    } catch (error) {
      console.error('Failed to open PDF:', error);
      setError(error instanceof Error ? error.message : 'Failed to open PDF');
    } finally {
      setLoading(false);
    }
  }, [setError, setFile, setLoading, setPageData]);

  const navigateToPage = useCallback(async (page: number) => {
    if (page < 1 || page > pageCount) return;

    setError(null);
    setLoading(true);
    try {
      setPage(page);
      const pageData = await ipc.extractPage(page);
      setPageData(pageData);
    } catch (error) {
      console.error('Failed to navigate to page:', error);
      setError(error instanceof Error ? error.message : 'Failed to load page');
    } finally {
      setLoading(false);
    }
  }, [pageCount, setError, setLoading, setPage, setPageData]);

  const filename = filePath?.split(/[\\/]/).pop() ?? 'No file open';

  return (
    <header className={styles.toolbar}>
      <button className={styles.button} type="button" onClick={handleOpen} disabled={isLoading}>
        Open
      </button>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Page navigation">
        <button
          className={styles.button}
          type="button"
          onClick={() => navigateToPage(currentPage - 1)}
          disabled={isLoading || currentPage <= 1}
        >
          Prev
        </button>
        <span className={styles.value}>{currentPage} / {pageCount}</span>
        <button
          className={styles.button}
          type="button"
          onClick={() => navigateToPage(currentPage + 1)}
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

      <div className={styles.spacer} />
      <span className={styles.filename} title={filePath ?? undefined}>{filename}</span>
    </header>
  );
};
