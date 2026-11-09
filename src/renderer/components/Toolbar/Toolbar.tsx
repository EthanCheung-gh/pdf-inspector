import React, { useCallback, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { OVERLAY_LAYER_TOTAL, overlayVisibleCount } from '../../services/overlay-style';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useAuditStore } from '../../store/audit-store';
import { useDiffStore } from '../../store/diff-store';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { SearchBox } from './SearchBox';
import { ExportDialog } from './ExportDialog';
import { OpenUrlDialog } from './OpenUrlDialog';
import type { OpenedFromUrl } from './OpenUrlDialog';
import styles from './Toolbar.module.css';

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
  const leftCollapsed = useWorkspaceStore((state) => state.leftCollapsed);
  const rightCollapsed = useWorkspaceStore((state) => state.rightCollapsed);
  const focusMode = useWorkspaceStore((state) => state.focusMode);
  const leftTab = useWorkspaceStore((state) => state.leftTab);
  const setLeftTab = useWorkspaceStore((state) => state.setLeftTab);
  const setLeftCollapsed = useWorkspaceStore((state) => state.setLeftCollapsed);
  const setRightCollapsed = useWorkspaceStore((state) => state.setRightCollapsed);
  const setFocusMode = useWorkspaceStore((state) => state.setFocusMode);
  const toggleFocusMode = useWorkspaceStore((state) => state.toggleFocusMode);
  const diffActive = useDiffStore((state) => state.active);
  const diffOldName = useDiffStore((state) => state.oldName);
  const diffNewName = useDiffStore((state) => state.newName);
  const openDiffSetup = useDiffStore((state) => state.openSetup);
  const auditActive = useAuditStore((state) => state.active);
  const rawActive = useRawStore((state) => state.active);
  const searchOpen = usePdfStore((state) => state.searchOpen);
  const { navigate } = usePageNavigation();

  // A pane is visible only when it is expanded *and* focus mode is off. The
  // toolbar buttons model that visible state directly instead of blindly
  // flipping `collapsed`, so clicking a pane while hidden by focus mode brings
  // it back and leaves focus mode.
  const leftVisible = !leftCollapsed && !focusMode;
  const rightVisible = !rightCollapsed && !focusMode;
  const layersActive = leftTab === 'layers' && leftVisible;

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


      // An audit describes one document. Swapping the document must drop the
      // old report, filters and selection instead of leaving them attached to a
      // file that is no longer open.
      useAuditStore.getState().reset();
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

      // Same as `handleOpen`: a URL document is a different document, so the
      // previous audit cannot survive it.
      useAuditStore.getState().reset();
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

  const handleLayers = useCallback(() => {
    setLeftTab('layers');
    setLeftCollapsed(false);
    setFocusMode(false);
  }, [setFocusMode, setLeftCollapsed, setLeftTab]);

  const handleLeftPanelToggle = useCallback(() => {
    if (leftVisible) {
      setLeftCollapsed(true);
      return;
    }
    setLeftCollapsed(false);
    setFocusMode(false);
  }, [leftVisible, setFocusMode, setLeftCollapsed]);

  const handleRightPanelToggle = useCallback(() => {
    if (rightVisible) {
      setRightCollapsed(true);
      return;
    }
    setRightCollapsed(false);
    setFocusMode(false);
  }, [rightVisible, setFocusMode, setRightCollapsed]);

  const visibleLayerCount = overlayVisibleCount(overlayVisibility);

  // The name the user sees for the open document: a URL as-is, a local file as
  // its basename. Audit reuses it as the workspace/file name, so the header and
  // the exported JSON never expose an absolute path.
  const documentName = sourceUrl ?? (filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null);
  const diffTitle = `${diffOldName ?? '—'} → ${diffNewName ?? '—'}`;
  // Diff, Audit and Raw each replace the Inspect panes; while one of them is
  // open the Inspect-only controls would act on a document the user cannot see.
  const workspaceActive = diffActive || auditActive || rawActive;
  const displayTitle = diffActive ? diffTitle : sourceUrl ?? filePath ?? undefined;
  const filename = diffActive ? diffTitle : documentName ?? 'No file open';
  // The open search box is the widest optional control group. The toolbar
  // advertises it (`.searchOpen`) so CSS can give search the room it needs at
  // narrow widths instead of letting the right-hand controls get clipped. It is
  // deliberately false while Diff/Audit/Raw own the header: those workspaces
  // hide the search box, so the filename must keep its space there.
  const searchActive = searchOpen && !workspaceActive;

  const handleAudit = useCallback(() => {
    if (!filePath) return;
    // The three workspaces are mutually exclusive: leaving the other two here
    // keeps them from all claiming the area the Inspect panes give up.
    if (useDiffStore.getState().active) useDiffStore.getState().exitWorkspace();
    if (useRawStore.getState().active) useRawStore.getState().close();
    useAuditStore.getState().open(filePath, documentName ?? filePath);
  }, [documentName, filePath]);

  const handleRaw = useCallback(() => {
    if (!filePath) return;
    // Same mutual exclusion as Audit: Diff/Audit own the panes right now, so
    // close them first and then open the raw view of the same document.
    if (useDiffStore.getState().active) useDiffStore.getState().exitWorkspace();
    if (useAuditStore.getState().active) useAuditStore.getState().close();
    useRawStore.getState().open(filePath, documentName ?? filePath);
  }, [documentName, filePath]);

  return (
    <header className={`${styles.toolbar} ${searchActive ? styles.searchOpen : ''}`}>
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
      <button
        className={`${styles.button} ${diffActive ? styles.active : ''}`}
        type="button"
        onClick={openDiffSetup}
        aria-pressed={diffActive}
        title={
          diffActive
            ? 'Diff is open: choose other files to compare'
            : 'Compare two PDFs without changing the open document'
        }
      >
        Diff
      </button>
      <button
        className={`${styles.button} ${auditActive ? styles.active : ''}`}
        type="button"
        onClick={handleAudit}
        disabled={!filePath || diffActive}
        aria-pressed={auditActive}
        title={
          diffActive
            ? 'Close Diff before auditing the open document'
            : filePath
              ? 'Audit the open document for fonts, pages, images, metadata, structure and security'
              : 'Open a PDF to audit it'
        }
      >
        Audit
      </button>
      <button
        className={`${styles.button} ${rawActive ? styles.active : ''}`}
        type="button"
        onClick={handleRaw}
        disabled={!filePath || diffActive || auditActive}
        aria-pressed={rawActive}
        title={
          diffActive || auditActive
            ? 'Close the comparison/audit before reading raw objects'
            : filePath
              ? 'Browse the raw object graph and content streams of the open document'
              : 'Open a PDF to inspect its raw objects'
        }
      >
        Raw
      </button>

      {/* Everything below drives the Inspect document; while Diff, Audit or Raw
          owns the workspace those controls would act on a hidden document, so
          only the document-independent entries above stay available. "Back to
          Inspect" lives in each workspace header next to its own controls. */}
      {!workspaceActive && (
        <>
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

          <span className={styles.separator} />

          <div className={styles.group} role="group" aria-label="Workspace layout">
            <button
              className={`${styles.button} ${focusMode ? styles.active : ''}`}
              type="button"
              onClick={toggleFocusMode}
              aria-pressed={focusMode}
              title="Toggle focus mode (F)"
            >
              Focus
            </button>
            <button
              className={`${styles.button} ${layersActive ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleLayers}
              title="Open the Layers panel"
            >
              Layers {visibleLayerCount}/{OVERLAY_LAYER_TOTAL}
            </button>
            <button
              className={`${styles.button} ${leftVisible ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleLeftPanelToggle}
              aria-pressed={leftVisible}
              aria-label="Left panel"
              title={leftVisible ? 'Hide left panel' : 'Show left panel'}
            >
              Left
            </button>
            <button
              className={`${styles.button} ${rightVisible ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleRightPanelToggle}
              aria-pressed={rightVisible}
              aria-label="Right panel"
              title={rightVisible ? 'Hide right panel' : 'Show right panel'}
            >
              Right
            </button>
          </div>
        </>
      )}

      <div className={styles.spacer} />
      {!workspaceActive && <ExportDialog />}
      {!workspaceActive && <SearchBox />}
      <span className={styles.filename} title={displayTitle}>{filename}</span>

      <OpenUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        onOpened={handleUrlOpened}
      />
    </header>
  );
};
