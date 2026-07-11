import { useEffect } from 'react';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { StatusBar } from './components/StatusBar/StatusBar';
import { StructureTree } from './components/StructureTree/StructureTree';
import { Toolbar } from './components/Toolbar/Toolbar';
import { ipc } from './services/ipc-client';
import { usePdfStore } from './store/pdf-store';
import styles from './App.module.css';

const SIDECAR_STATUS_POLL_INTERVAL_MS = 5_000;

const App = (): JSX.Element => {
  const setSidecarRunning = usePdfStore((state) => state.setSidecarRunning);
  const clearSelection = usePdfStore((state) => state.clearSelection);

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
      if (event.key === 'Escape') clearSelection();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection]);

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        <StructureTree />
        <PdfViewport />
        <InspectorPanel />
      </main>
      <StatusBar />
    </div>
  );
};

export default App;
