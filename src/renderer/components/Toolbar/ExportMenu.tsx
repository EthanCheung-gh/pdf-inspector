import React, { useCallback, useEffect, useRef, useState } from 'react';
import { pagesToCsv, pagesToJson, suggestFilename } from '../../services/export-data';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
import type { PageData } from '../../types/pdf-objects';
import styles from './ExportMenu.module.css';

type Scope = 'page' | 'document';
type Format = 'json' | 'csv';

export const ExportMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageData = usePdfStore((s) => s.pageData);
  const isLoading = usePdfStore((s) => s.isLoading);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const handleExport = useCallback(async (scope: Scope, format: Format) => {
    setOpen(false);
    const store = usePdfStore.getState();
    if (!store.filePath) return;

    setBusy(true);
    store.setError(null);
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
          store.setExportProgress({ done: p, total: store.pageCount });
        }
      }

      const content = format === 'json' ? pagesToJson(pages, store.metadata) : pagesToCsv(pages);
      const result = await ipc.saveFile({
        defaultPath: suggestFilename(store.filePath, scope, store.currentPage, format, store.sourceUrl),
        content,
        filterName: format === 'json' ? 'JSON' : 'CSV',
        extensions: [format],
      });
      if (!result.canceled && result.error) {
        store.setError(`Export failed: ${result.error}`);
      }
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      usePdfStore.getState().setExportProgress(null);
      setBusy(false);
    }
  }, []);

  const disabled = isLoading || busy || !pageData;

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        className={styles.button}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button type="button" role="menuitem" onClick={() => void handleExport('page', 'json')}>
            Current page → JSON
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('page', 'csv')}>
            Current page → CSV
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('document', 'json')}>
            Whole document → JSON
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('document', 'csv')}>
            Whole document → CSV
          </button>
        </div>
      )}
    </div>
  );
};
