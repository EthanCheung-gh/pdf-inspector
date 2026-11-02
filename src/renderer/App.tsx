import { useEffect } from 'react';
import { DiffSetupDialog } from './components/Diff/DiffSetupDialog';
import { DiffWorkspace } from './components/Diff/DiffWorkspace';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { LeftPanel } from './components/LeftPanel/LeftPanel';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { StatusBar } from './components/StatusBar/StatusBar';
import { Toolbar } from './components/Toolbar/Toolbar';
import { PanelRail } from './components/Workspace/PanelRail';
import { PanelSplitter } from './components/Workspace/PanelSplitter';
import { ipc } from './services/ipc-client';
import { useDiffStore } from './store/diff-store';
import { usePdfStore } from './store/pdf-store';
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
      // The Diff workspace owns the keyboard while it is open: its shortcuts
      // (Escape, T, R, F, Ctrl+F) belong to the hidden Inspect document, so
      // acting on them would silently mutate state the user cannot see.
      if (useDiffStore.getState().active) return;

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
         * The Inspect workspace stays mounted while Diff is open: its local
         * component state (font analysis, tab-local state) and the document in
         * `pdf-store` must be exactly as they were when Diff is left again.
         */}
        <div className={styles.inspectArea} hidden={diffActive} data-testid="inspect-area">
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
      </main>
      <StatusBar />
      {/* Mounted once at app level: the toolbar entry and the workspace's
          "Change files…" both open this same dialog through the diff store. */}
      <DiffSetupDialog />
    </div>
  );
};

export default App;
