import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { ipc } from '../../services/ipc-client';
import {
  supportsDocumentTabs,
  useDocumentTabsStore,
} from '../../store/document-tabs-store';
import type { DocumentTab, DocumentViewSnapshot } from '../../store/document-tabs-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import { useSessionStore } from '../../store/session-store';
import type { OpenPdfResult } from '../../types/ipc-protocol';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { PdfDocumentNotFoundError } from '../../../shared/document-errors';
import styles from './DocumentTabs.module.css';

/**
 * Restore a tab's snapshot onto the freshly opened document.
 *
 * Deliberately only view state: the document itself comes from `setFile`, and
 * analysis results (fonts/audit/raw) are not snapshotted, so they stay reset.
 *
 * The fit-to-width pass in `PdfViewport` runs once per loaded document and would
 * otherwise overwrite the zoom just restored (a tab saved at 157% would snap
 * back to the fit ratio). Asking it to skip that pass keeps the saved zoom; a
 * normal first open never calls this, so it still fits.
 */
export function restoreViewSnapshot(snapshot: DocumentViewSnapshot): void {
  const pdf = usePdfStore.getState();
  pdf.setZoom(snapshot.zoom);
  // After `setZoom`, so the saved zoom is the one the fit pass must leave alone.
  pdf.skipNextInitialFit();
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
 * The tab that takes over when `tabId` is closed, without mutating anything.
 *
 * Mirrors `removeTab`'s choice exactly (the tab that slides into the closed slot,
 * else the previous one) so a web close can activate that neighbour *before*
 * asking the server to drop the old document — the server refuses to close an
 * active document that still has siblings. Returns null for the last tab.
 */
export function neighbourTabId(tabs: readonly DocumentTab[], tabId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return null;
  const remaining = tabs.filter((tab) => tab.id !== tabId);
  const neighbour = remaining[Math.min(index, remaining.length - 1)] ?? null;
  return neighbour ? neighbour.id : null;
}

/**
 * How a tab's document was re-opened, and whether the document identity changed.
 *
 * `renewed` marks a self-healed activation: the server had forgotten the tab's
 * document id, so the document was re-opened from its source URL and came back
 * under a new id (or under none, if the bridge no longer reports one).
 */
interface OpenedTabDocument {
  result: OpenPdfResult;
  renewed: boolean;
}

/**
 * Open (or re-activate) the document behind a tab.
 *
 * Identity order: a server document id survives a re-resolved `/doc/<id>` path,
 * so web tabs activate it; the desktop has no ids and re-opens by URL (fresh
 * download) or by local path.
 *
 * A web activation can fail with `PdfDocumentNotFoundError` when the server no
 * longer has that id (LRU eviction, or a restart while the page stayed open).
 * A tab that still knows its source URL is self-healed by re-opening that URL:
 * the server dedupes it against its own registry or downloads it again. Tabs
 * without a URL (uploads) have nothing to re-open from and keep the error.
 */
async function openDocumentForTab(tab: DocumentTab): Promise<OpenedTabDocument> {
  if (tab.documentId !== null && typeof ipc.activatePdfDocument === 'function') {
    try {
      return { result: await ipc.activatePdfDocument(tab.documentId), renewed: false };
    } catch (error) {
      if (!(error instanceof PdfDocumentNotFoundError) || !tab.sourceUrl) throw error;
      console.warn('Document id is stale, re-opening its source URL:', tab.sourceUrl, error);
      return { result: await ipc.openPdfUrl(tab.sourceUrl), renewed: true };
    }
  }

  if (tab.sourceUrl) return { result: await ipc.openPdfUrl(tab.sourceUrl), renewed: false };
  return { result: await ipc.openPdfPath(tab.path), renewed: false };
}

/**
 * Document tab bar.
 *
 * Switching never re-uploads or re-downloads on the web: a tab holding a server
 * `documentId` is re-activated in place (the server keeps its own copy), while a
 * desktop tab re-opens by URL (re-download) or by local path. Either way the
 * tab's page/zoom/panel snapshot is restored afterwards.
 *
 * Closing differs by build too: a web tab first activates its neighbour (when it
 * was the active one) and only then asks the server to delete that document's
 * temporary copy, so a failure keeps the tab instead of lying about it. A tab
 * whose document the server has already forgotten (LRU eviction, restart) is the
 * one exception: nothing is left to delete or to show, so it is removed anyway
 * instead of becoming permanently unclosable. Desktop tabs never call the close
 * bridge — their paths are the user's own files.
 */
export const DocumentTabs: React.FC = () => {
  const t = useT();
  const tabs = useDocumentTabsStore((state) => state.tabs);
  const activeTabId = useDocumentTabsStore((state) => state.activeTabId);
  const { navigate } = usePageNavigation();

  // Only the newest switch may update the document: a double click or a close
  // during a slow open must not be clobbered by the slower request.
  const requestIdRef = useRef(0);
  const [switchingTabId, setSwitchingTabId] = useState<string | null>(null);
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether this mount ever showed a tab. Startup mounts the bar with zero tabs
  // (and so does the restore, until its first document lands): writing that
  // empty set would erase the session the restore is about to read. An empty
  // session is only persisted once tabs actually existed and were all closed.
  const hasHadTabsRef = useRef(false);
  // The restore engine writes the session itself when it finishes, so the bar
  // must not race it with a save per intermediate tab.
  const restoringSession = useSessionRestoreStore((state) => state.restoring);

  // Session save trigger (Q2): the tab bar is the only component that knows the
  // tab set, so it owns persistence. Page/zoom changes are deliberately not in
  // this effect — they only reach storage through the explicit flushes below,
  // so scrolling a document never writes on every page turn.
  //
  // While a restore is running the engine is the single writer: it opens
  // documents one at a time and saves the surviving tabs once at the end, so a
  // save here would persist a half-restored session. `restoringSession` is a
  // dependency on purpose: when the run ends the effect re-runs and stores the
  // final tab set, which also covers a run that stopped early because the user
  // opened a document of their own.
  useEffect(() => {
    if (restoringSession) return;
    if (tabs.length > 0) hasHadTabsRef.current = true;
    else if (!hasHadTabsRef.current) return;
    useSessionStore.getState().saveTabs(tabs, activeTabId);
  }, [tabs, activeTabId, restoringSession]);

  // Recent files are populated from the tab that is active, which covers every
  // open path (toolbar, URL dialog, drag/drop, web upload, a restored session)
  // without each entry point having to remember to record it. `recordOpen` is an
  // idempotent upsert, and the identity key keeps it from firing for snapshot
  // changes alone.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeTabIdentity = activeTab
    ? `${activeTab.documentId ?? ''}|${activeTab.sourceUrl ?? ''}|${activeTab.path}`
    : '';
  useEffect(() => {
    if (!activeTabIdentity) return;
    const store = useDocumentTabsStore.getState();
    const tab = store.tabs.find((candidate) => candidate.id === store.activeTabId);
    if (tab) useSessionStore.getState().recordOpen(tab);
  }, [activeTabIdentity]);

  // Returns whether the tab actually became the open document, which is what a
  // close must know: a failed activation leaves the old tab (and the old
  // document) in place.
  const openTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = useDocumentTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return false;

      const requestId = ++requestIdRef.current;
      setError(null);
      setSwitchingTabId(tabId);

      try {
        const { result, renewed } = await openDocumentForTab(tab);
        if (requestId !== requestIdRef.current) return false;

        if (result.canceled) {
          setError(t('tabs.openFailed', { name: tab.name }));
          return false;
        }

        usePdfStore
          .getState()
          .setFile(result.path, result.metadata, result.sourceUrl ?? null, result.name ?? null);
        // An activation (or a URL re-download) can resolve a new path, fresh
        // metadata and — after a self-heal — a new document id, so the tab is
        // refreshed from the result instead of keeping the values it was
        // created with. A healed tab must not fall back to its dead id.
        useDocumentTabsStore.getState().updateTab(tabId, {
          path: result.path,
          metadata: result.metadata,
          documentId: result.documentId ?? (renewed ? null : tab.documentId),
          ...(result.sourceUrl ? { sourceUrl: result.sourceUrl } : {}),
        });
        useDocumentTabsStore.getState().activate(tabId);

        restoreViewSnapshot(tab.snapshot);
        // Guarded navigation: `navigate` ignores pages outside the new document.
        await navigate(clampSnapshotPage(tab.snapshot.currentPage, result.metadata.pages));
        return true;
      } catch (err) {
        if (requestId !== requestIdRef.current) return false;
        console.error('Failed to switch document tab:', err);
        setError(err instanceof Error ? err.message : t('tabs.openFailedFallback', { name: tab.name }));
        return false;
      } finally {
        if (requestId === requestIdRef.current) setSwitchingTabId(null);
      }
    },
    [navigate, t],
  );

  const busy = switchingTabId !== null || closingTabId !== null;

  const selectTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (switchingTabId !== null || closingTabId !== null) return;
      const store = useDocumentTabsStore.getState();
      if (store.activeTabId === tabId) return;
      // Capture where the user left the outgoing document before replacing it.
      store.saveActiveSnapshot();
      await openTab(tabId);
    },
    [closingTabId, openTab, switchingTabId],
  );

  const closeTab = useCallback(
    async (tabId: string): Promise<void> => {
      if (switchingTabId !== null || closingTabId !== null) return;
      const store = useDocumentTabsStore.getState();
      const tab = store.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const wasActive = store.activeTabId === tabId;

      // Desktop (or any build without the close bridge): the tab only tracks a
      // local document, so closing it removes the tab and nothing else. The
      // user's file must never be deleted from here.
      if (tab.documentId === null || typeof ipc.closePdfDocument !== 'function') {
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
        return;
      }

      const documentId = tab.documentId;
      setError(null);
      setClosingTabId(tabId);

      try {
        // Only used to pick the neighbour that must become active *before* the
        // server will drop the outgoing document. Its "no neighbour" case must
        // not be remembered: the tab set can change while the requests below
        // are in flight (the toolbar can open another document at any time).
        const neighbourIdBeforeClose = neighbourTabId(store.tabs, tabId);

        if (wasActive && neighbourIdBeforeClose !== null) {
          // The server refuses to close the active document while others remain,
          // so the neighbour has to become active first. The outgoing view is
          // snapshotted, exactly like a manual switch would do.
          store.saveActiveSnapshot();
          const switched = await openTab(neighbourIdBeforeClose);
          // `openTab` already reported why; the old tab and document are intact.
          if (!switched) return;
        }

        // Closing an inactive tab touches nothing else; closing the active one
        // has already switched the view to its neighbour above. A rejection
        // means the document is still open on the server (and still readable at
        // `/doc/<id>`), so the tab stays and the error is shown.
        //
        // `notFound` is the exception: the server has already forgotten this id
        // (LRU eviction or a restart), so there is nothing left to keep. The tab
        // is dropped like a successful close, without an error, which is also
        // what finally makes a dead tab closable again.
        const closed = await ipc.closePdfDocument(documentId);
        if (!closed.closed && closed.notFound !== true) {
          // A bridge that reports a refusal instead of rejecting it: the
          // document may still be open, so the tab must survive.
          throw new Error(t('tabs.closeFailed', { name: tab.name }));
        }

        // Both awaits above may have let another open land, so the tab set is
        // re-read here: the removal reports what is left *now*, and a viewer
        // showing a document opened meanwhile must not be reset. A null removal
        // means the tab is already gone and there is nothing to decide.
        const removal = useDocumentTabsStore.getState().removeTab(tabId);
        if (removal?.nextActiveId === null) {
          // Last web tab: the server holds no document any more, so the renderer
          // must not keep showing one. (Also true for a stale id: the document
          // is gone either way.)
          usePdfStore.getState().resetDocument();
        }
      } catch (err) {
        console.error('Failed to close document tab:', err);
        setError(err instanceof Error ? err.message : t('tabs.closeFailedFallback', { name: tab.name }));
      } finally {
        setClosingTabId(null);
      }
    },
    [closingTabId, openTab, switchingTabId, t],
  );

  // Snapshot and session flush on the way out. The debounce-less tab effect
  // above covers the tab set, but the page/zoom/panel state of the *active*
  // document only exists in the live stores until it is captured, so a refresh,
  // a window close or a tab going to the background must capture it first.
  useEffect(() => {
    const flushSession = (): void => {
      // Same single-writer rule as the save effect: while the restore engine
      // runs it owns the session, and a flush would persist a partial run.
      if (useSessionRestoreStore.getState().restoring) return;
      const store = useDocumentTabsStore.getState();
      if (store.tabs.length === 0 && !hasHadTabsRef.current) return;
      // Capture the live view before the tab set is serialized.
      store.saveActiveSnapshot();
      const current = useDocumentTabsStore.getState();
      useSessionStore.getState().saveTabs(current.tabs, current.activeTabId);
    };
    const handleVisibilityChange = (): void => {
      // Only leaving the page is a "save point"; coming back is not.
      if (document.visibilityState === 'hidden') flushSession();
    };

    window.addEventListener('beforeunload', flushSession);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flushSession);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  if (!supportsDocumentTabs() || tabs.length === 0) return null;

  return (
    <div className={styles.bar} data-testid="document-tabs">
      <div className={styles.tabs} role="tablist" aria-label={t('tabs.list')}>
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
                aria-label={t('tabs.close', { name: tab.name })}
                title={t('tabs.close', { name: tab.name })}
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
          {t('tabs.opening')}
        </span>
      )}
      {switchingTabId === null && closingTabId !== null && (
        <span className={styles.status} role="status">
          {t('tabs.closing')}
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
