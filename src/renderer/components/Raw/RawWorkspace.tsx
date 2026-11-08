import React, { useCallback } from 'react';
import { useRawStore } from '../../store/raw-store';
import { RawContentPanel } from './RawContentPanel';
import { RawObjectPanel } from './RawObjectPanel';
import { RawTree } from './RawTree';
import styles from './RawWorkspace.module.css';

const TAB_PANEL_ID = 'raw-detail-panel';
const TAB_OBJECT_ID = 'raw-tab-object';
const TAB_CONTENT_ID = 'raw-tab-content';

/**
 * The Raw workspace: object tree on the left, object/content detail on the
 * right.
 *
 * All state lives in `raw-store`; the component only reads it. Entering and
 * leaving Raw therefore never touches the Inspect document (page, zoom,
 * selection, filters and export state stay exactly as they were).
 */
export const RawWorkspace: React.FC = () => {
  const filePath = useRawStore((state) => state.filePath);
  const fileName = useRawStore((state) => state.fileName);
  const document = useRawStore((state) => state.document);
  const tab = useRawStore((state) => state.tab);
  const loading = useRawStore((state) => state.loading);
  const error = useRawStore((state) => state.error);
  const setTab = useRawStore((state) => state.setTab);
  const close = useRawStore((state) => state.close);

  // A reload is a reset plus a fresh open of the same file: it drops the
  // document, both detail panes and both caches instead of leaving anything
  // from the previous read on screen.
  const handleReload = useCallback((): void => {
    const state = useRawStore.getState();
    if (!state.filePath) return;
    const path = state.filePath;
    const name = state.fileName ?? path;
    state.reset();
    useRawStore.getState().open(path, name);
  }, []);

  return (
    <section className={styles.workspace} aria-label="Raw PDF workspace" data-testid="raw-workspace">
      <header className={styles.toolbar}>
        <button className={styles.button} type="button" onClick={close}>
          Back to Inspect
        </button>
        <span className={styles.separator} />
        <span className={styles.title}>Raw</span>
        <span className={styles.fileName} title={fileName ?? '—'} data-testid="raw-file-name">
          {fileName ?? '—'}
        </span>

        <div className={styles.tabs} role="tablist" aria-label="Raw detail tabs">
          <button
            className={`${styles.tab} ${tab === 'object' ? styles.activeTab : ''}`}
            type="button"
            role="tab"
            id={TAB_OBJECT_ID}
            aria-selected={tab === 'object'}
            aria-controls={TAB_PANEL_ID}
            onClick={() => setTab('object')}
          >
            Object
          </button>
          <button
            className={`${styles.tab} ${tab === 'content' ? styles.activeTab : ''}`}
            type="button"
            role="tab"
            id={TAB_CONTENT_ID}
            aria-selected={tab === 'content'}
            aria-controls={TAB_PANEL_ID}
            onClick={() => setTab('content')}
          >
            Content stream
          </button>
        </div>

        <span className={styles.spacer} />

        <button
          className={styles.button}
          type="button"
          onClick={handleReload}
          disabled={!filePath}
          title="Read the document and its object graph again"
        >
          {loading && !document ? 'Reloading…' : 'Reload'}
        </button>
      </header>

      {!document && error && (
        <p className={styles.error} role="alert">
          Raw view failed: {error}
        </p>
      )}

      {!document ? (
        <div className={styles.status}>
          {loading ? (
            <p className={styles.loading} role="status" aria-live="polite">
              Loading the raw object graph…
            </p>
          ) : (
            <p className={styles.empty} data-testid="raw-workspace-empty">
              Open a PDF to read its raw objects and content streams.
            </p>
          )}
        </div>
      ) : (
        <div className={styles.body}>
          <aside className={styles.treePane} aria-label="Raw object tree">
            <RawTree />
          </aside>
          <div
            className={styles.detailPane}
            id={TAB_PANEL_ID}
            role="tabpanel"
            aria-labelledby={tab === 'object' ? TAB_OBJECT_ID : TAB_CONTENT_ID}
          >
            {tab === 'object' ? <RawObjectPanel /> : <RawContentPanel />}
          </div>
        </div>
      )}
    </section>
  );
};
