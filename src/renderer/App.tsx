import { useEffect } from 'react';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { LeftPanel } from './components/LeftPanel/LeftPanel';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { StatusBar } from './components/StatusBar/StatusBar';
import { Toolbar } from './components/Toolbar/Toolbar';
import { ipc } from './services/ipc-client';
import { usePdfStore } from './store/pdf-store';
import styles from './App.module.css';

const SIDECAR_STATUS_POLL_INTERVAL_MS = 5_000;

const App = (): JSX.Element => {
  const setSidecarRunning = usePdfStore((state) => state.setSidecarRunning);
  const clearSelection = usePdfStore((state) => state.clearSelection);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const setTextSelectionMode = usePdfStore((state) => state.setTextSelectionMode);
  const regionMode = usePdfStore((state) => state.regionMode);
  const setRegionMode = usePdfStore((state) => state.setRegionMode);

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
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        if (usePdfStore.getState().pageCount > 0) {
          usePdfStore.getState().setSearchOpen(true);
        }
        return;
      }
      // Ignore shortcuts typed into editable elements (e.g. the search input).
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea'))) {
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if ((event.key === 't' || event.key === 'T') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setTextSelectionMode(!textSelectionMode);
      }
      if ((event.key === 'r' || event.key === 'R') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const next = !regionMode;
        setRegionMode(next);
        if (next) setTextSelectionMode(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection, regionMode, setRegionMode, setTextSelectionMode, textSelectionMode]);

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        <LeftPanel />
        <PdfViewport />
        <InspectorPanel />
      </main>
      <StatusBar />
    </div>
  );
};

export default App;
