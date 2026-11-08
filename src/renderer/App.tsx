import { useEffect } from 'react';
import { AuditWorkspace } from './components/Audit/AuditWorkspace';
import { DiffSetupDialog } from './components/Diff/DiffSetupDialog';
import { DiffWorkspace } from './components/Diff/DiffWorkspace';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { LeftPanel } from './components/LeftPanel/LeftPanel';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { RawWorkspace } from './components/Raw/RawWorkspace';
import { StatusBar } from './components/StatusBar/StatusBar';
import { Toolbar } from './components/Toolbar/Toolbar';
import { PanelRail } from './components/Workspace/PanelRail';
import { PanelSplitter } from './components/Workspace/PanelSplitter';
import { ipc } from './services/ipc-client';
import { useAuditStore } from './store/audit-store';
import { useDiffStore } from './store/diff-store';
import { usePdfStore } from './store/pdf-store';
import { useRawStore } from './store/raw-store';
import {
  LEFT_PANEL_LIMITS,
  RIGHT_PANEL_LIMITS,
  useWorkspaceStore,
} from './store/workspace-store';
import styles from './App.module.css';

const SIDECAR_STATUS_POLL_INTERVAL_MS = 5_000;

const App = (): JSX.Element => {
  const setSidecarRunning = usePdfStore((state) => state.setSidecarRunning);
  const clearSelection = usePdfStore((state) => state.clearSelection);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const setTextSelectionMode = usePdfStore((state) => state.setTextSelectionMode);
  const regionMode = usePdfStore((state) => state.regionMode);
  const setRegionMode = usePdfStore((state) => state.setRegionMode);
  const diffActive = useDiffStore((state) => state.active);
  const auditActive = useAuditStore((state) => state.active);
  const auditFilePath = useAuditStore((state) => state.filePath);
  const rawActive = useRawStore((state) => state.active);
  const rawFilePath = useRawStore((state) => state.filePath);
  const documentPath = usePdfStore((state) => state.filePath);

  const leftWidth = useWorkspaceStore((state) => state.leftWidth);
  const rightWidth = useWorkspaceStore((state) => state.rightWidth);
  const leftCollapsed = useWorkspaceStore((state) => state.leftCollapsed);
  const rightCollapsed = useWorkspaceStore((state) => state.rightCollapsed);
  const focusMode = useWorkspaceStore((state) => state.focusMode);
  const setLeftWidth = useWorkspaceStore((state) => state.setLeftWidth);
  const setRightWidth = useWorkspaceStore((state) => state.setRightWidth);
  const setLeftCollapsed = useWorkspaceStore((state) => state.setLeftCollapsed);
  const setRightCollapsed = useWorkspaceStore((state) => state.setRightCollapsed);
  const setFocusMode = useWorkspaceStore((state) => state.setFocusMode);
  const toggleFocusMode = useWorkspaceStore((state) => state.toggleFocusMode);

  // Panes stay mounted while hidden so local tab/analysis state (notably the
  // Fonts analysis) survives collapsing and focus mode.
  const leftPaneVisible = !leftCollapsed && !focusMode;
  const rightPaneVisible = !rightCollapsed && !focusMode;

  // Diff and Audit are mutually exclusive: each one replaces the Inspect panes,
  // so two at once would fight over the same area. Diff wins because a completed
  // comparison is what the user just asked for; Audit is simply left.
  useEffect(() => {
    if (diffActive && useAuditStore.getState().active) useAuditStore.getState().close();
    if (diffActive && useRawStore.getState().active) useRawStore.getState().close();
  }, [diffActive]);

  // Raw is the third workspace that replaces the Inspect panes, so the same
  // exclusion applies in both directions. The toolbar closes the others before
  // opening Raw; this guard makes it unconditional (drag/drop, a future entry
  // point), so only one workspace is ever mounted.
  useEffect(() => {
    if (!rawActive) return;
    if (useDiffStore.getState().active) useDiffStore.getState().exitWorkspace();
    if (useAuditStore.getState().active) useAuditStore.getState().close();
  }, [rawActive]);

  // An audit only ever describes one document. The open paths reset the audit
  // themselves, but this guard makes that unconditional: whatever changes the
  // Inspect document (toolbar, drag/drop, a future entry point), an audit that
  // belongs to another file is dropped instead of lingering with a stale report.
  // It watches both sides, so an audit opened for a file that is not the open
  // document is dropped just as well.
  useEffect(() => {
    if (auditFilePath === null || auditFilePath === documentPath) return;
    useAuditStore.getState().reset();
  }, [auditFilePath, documentPath]);

  // The raw view is a read-only view of one open document. When the Inspect
  // document changes, the object graph on screen belongs to a file that is no
  // longer open, so it is dropped (which also returns to Inspect) instead of
  // showing objects of the previous file.
  useEffect(() => {
    if (rawFilePath === null || rawFilePath === documentPath) return;
    useRawStore.getState().reset();
  }, [rawFilePath, documentPath]);

  const workspaceActive = diffActive || auditActive || rawActive;

  useEffect(() => {
    const updateSidecarStatus = async (): Promise<void> => {
      try {
        const { running } = await ipc.getSidecarStatus();
        setSidecarRunning(running);
      } catch {
        setSidecarRunning(false);
      }
    };

    void updateSidecarStatus();
    const intervalId = window.setInterval(() => void updateSidecarStatus(), SIDECAR_STATUS_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [setSidecarRunning]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // The Diff, Audit and Raw workspaces own the keyboard while any of them
      // is open: their shortcuts (Escape, T, R, F, Ctrl+F) belong to the hidden
      // Inspect document, so acting on them would silently mutate state the user
      // cannot see.
      if (
        useDiffStore.getState().active ||
        useAuditStore.getState().active ||
        useRawStore.getState().active
      ) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        if (usePdfStore.getState().pageCount > 0) {
          usePdfStore.getState().setSearchOpen(true);
        }
        return;
      }
      // Ignore shortcuts typed into editable elements (e.g. the search input) and
      // form controls such as the Filter dropdowns.
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) {
        return;
      }
      if ((event.key === 'f' || event.key === 'F') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        toggleFocusMode();
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        usePdfStore.getState().clearSubset();
        usePdfStore.getState().setFilterCriteria({});
        return;
      }
      if ((event.key === 't' || event.key === 'T') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const next = !textSelectionMode;
        setTextSelectionMode(next);
        if (next) usePdfStore.getState().setRegionMode(false);
      }
      if ((event.key === 'r' || event.key === 'R') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const next = !regionMode;
        setRegionMode(next);
        if (next) setTextSelectionMode(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection, regionMode, setRegionMode, setTextSelectionMode, textSelectionMode, toggleFocusMode]);

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        {/*
         * The Inspect workspace stays mounted while Diff, Audit or Raw is open:
         * its local component state (font analysis, tab-local state) and the
         * document in `pdf-store` must be exactly as they were when the
         * workspace is left again.
         */}
        <div className={styles.inspectArea} hidden={workspaceActive} data-testid="inspect-area">
          <div
            id="workspace-left-pane"
            className={styles.pane}
            hidden={!leftPaneVisible}
            style={{ width: leftPaneVisible ? leftWidth : 0, flexBasis: leftPaneVisible ? leftWidth : 0 }}
          >
            <LeftPanel />
          </div>
          {leftPaneVisible && (
            <PanelSplitter
              side="left"
              width={leftWidth}
              min={LEFT_PANEL_LIMITS.min}
              max={LEFT_PANEL_LIMITS.max}
              onResize={setLeftWidth}
            />
          )}
          {leftCollapsed && !focusMode && (
            <PanelRail side="left" label="Objects" onShow={() => setLeftCollapsed(false)} />
          )}
          <div className={styles.canvas}>
            <PdfViewport />
            {focusMode && (
              <button
                className={styles.focusRestore}
                type="button"
                onClick={() => {
                  setFocusMode(false);
                  setLeftCollapsed(false);
                  setRightCollapsed(false);
                }}
                aria-label="Show panels"
                title="Show panels (F)"
              >
                Show panels
              </button>
            )}
          </div>
          {rightCollapsed && !focusMode && (
            <PanelRail side="right" label="Inspector" onShow={() => setRightCollapsed(false)} />
          )}
          {rightPaneVisible && (
            <PanelSplitter
              side="right"
              width={rightWidth}
              min={RIGHT_PANEL_LIMITS.min}
              max={RIGHT_PANEL_LIMITS.max}
              onResize={setRightWidth}
            />
          )}
          <div
            id="workspace-right-pane"
            className={styles.pane}
            hidden={!rightPaneVisible}
            style={{ width: rightPaneVisible ? rightWidth : 0, flexBasis: rightPaneVisible ? rightWidth : 0 }}
          >
            <InspectorPanel />
          </div>
        </div>

        {diffActive && <DiffWorkspace />}
        {!diffActive && rawActive && <RawWorkspace />}
        {!diffActive && !rawActive && auditActive && <AuditWorkspace />}
      </main>
      <StatusBar />
      {/* Mounted once at app level: the toolbar entry and the workspace's
          "Change files…" both open this same dialog through the diff store. */}
      <DiffSetupDialog />
    </div>
  );
};

export default App;
