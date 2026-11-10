import React, { useCallback, useRef, useState } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { ipc } from '../../services/ipc-client';
import {
  supportsDocumentTabs,
  useDocumentTabsStore,
} from '../../store/document-tabs-store';
import type { DocumentViewSnapshot } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import styles from './DocumentTabs.module.css';

/**
 * Restore a tab's snapshot onto the freshly opened document.
 *
 * Deliberately only view state: the document itself comes from `setFile`, and
 * analysis results (fonts/audit/raw) are not snapshotted, so they stay reset.
 */
export function restoreViewSnapshot(snapshot: DocumentViewSnapshot): void {
  const pdf = usePdfStore.getState();
  pdf.setZoom(snapshot.zoom);
  pdf.setOverlayVisibility(snapshot.overlayVisibility);
  if (snapshot.searchQuery) pdf.setSearchQuery(snapshot.searchQuery);

  const workspace = useWorkspaceStore.getState();
  workspace.setLeftTab(snapshot.leftTab);
  workspace.setInspectorTab(snapshot.inspectorTab);
}

/** Clamp a snapshot page into the re-opened document's range. */
export function clampSnapshotPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || pageCount <= 0) return 1;
  return Math.max(1, Math.min(Math.trunc(page), pageCount));
}

/**
 * Desktop document tab bar.
 *
 * Renders nothing when the build cannot open a known path (the web build omits
 * `openPdfPath`), so the web app keeps its single-document behavior. Switching
 * re-opens the document without a dialog — a URL tab re-downloads, because main
 * deletes the previous download when another document replaces it — and then
 * restores the tab's page/zoom/panel snapshot.
 */
export const DocumentTabs: React.FC = () => {
  const tabs = useDocumentTabsStore((state) => state.tabs);
  const activeTabId = useDocumentTabsStore((state) => state.activeTabId);
  const { navigate } = usePageNavigation();

  // Only the newest switch may update the document: a double click or a close
  // during a slow open must not be clobbered by the slower request.
  const requestIdRef = useRef(0);
  const [switchingTabId, setSwitchingTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openTab = useCallback(
    async (tabId: string): Promise<void> => {
      const tab = useDocumentTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;

      const requestId = ++requestIdRef.current;
      setError(null);
      setSwitchingTabId(tabId);

      try {
        const result = tab.sourceUrl
          ? await ipc.openPdfUrl(tab.sourceUrl)
          : await ipc.openPdfPath(tab.path);
        if (requestId !== requestIdRef.current) return;

        if (result.canceled) {
          setError(`Could not open ${tab.name}`);
          return;
        }

        usePdfStore
          .getState()
          .setFile(result.path, result.metadata, result.sourceUrl ?? null, result.name ?? null);
        // A URL tab's downloaded copy is owned by the document that replaced it,
        // so reactivation produces a new temp path and fresh metadata.
        useDocumentTabsStore.getState().updateTab(tabId, {
          path: result.path,
          metadata: result.metadata,
          ...(result.sourceUrl ? { sourceUrl: result.sourceUrl } : {}),
        });
        useDocumentTabsStore.getState().activate(tabId);

        restoreViewSnapshot(tab.snapshot);
        // Guarded navigation: `navigate` ignores pages outside the new document.
        await navigate(clampSnapshotPage(tab.snapshot.currentPage, result.metadata.pages));
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        console.error('Failed to switch document tab:', err);
        setError(err instanceof Error ? err.message : `Failed to open ${tab.name}`);
      } finally {
        if (requestId === requestIdRef.current) setSwitchingTabId(null);
      }
    },
    [navigate],
  );

  const selectTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (switchingTabId !== null) return;
      const store = useDocumentTabsStore.getState();
      if (store.activeTabId === tabId) return;
      // Capture where the user left the outgoing document before replacing it.
      store.saveActiveSnapshot();
      await openTab(tabId);
    },
    [openTab, switchingTabId],
  );

  const closeTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (switchingTabId !== null) return;
      const store = useDocumentTabsStore.getState();
      const wasActive = store.activeTabId === tabId;
      const result = store.removeTab(tabId);
      if (!result) return;

      setError(null);
      if (result.nextActiveId === null) {
        // Last tab: return to the empty state and stop tracking a document.
        usePdfStore.getState().resetDocument();
        return;
      }
      // Closing an inactive tab leaves the open document alone; closing the
      // active one activates its neighbour (whose snapshot is already intact).
      if (wasActive) await openTab(result.nextActiveId);
    },
    [openTab, switchingTabId],
  );

  if (!supportsDocumentTabs() || tabs.length === 0) return null;

  const busy = switchingTabId !== null;

  return (
    <div className={styles.bar} data-testid="document-tabs">
      <div className={styles.tabs} role="tablist" aria-label="Open documents">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              data-document-tab={tab.id}
            >
              <button
                className={styles.label}
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.sourceUrl ?? tab.path}
                onClick={() => void selectTab(tab.id)}
                disabled={busy}
              >
                {tab.name}
              </button>
              <button
                className={styles.close}
                type="button"
                aria-label={`Close ${tab.name}`}
                title={`Close ${tab.name}`}
                onClick={() => void closeTab(tab.id)}
                disabled={busy}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      {switchingTabId !== null && (
        <span className={styles.status} role="status">
          Opening…
        </span>
      )}
      {error !== null && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
