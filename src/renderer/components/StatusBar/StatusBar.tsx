import { usePdfStore } from '../../store/pdf-store';
import styles from './StatusBar.module.css';

export const StatusBar = (): JSX.Element => {
  const isLoading = usePdfStore((state) => state.isLoading);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageCount = usePdfStore((state) => state.pageCount);
  const objectCount = usePdfStore((state) => state.allObjects.length);
  const sidecarRunning = usePdfStore((state) => state.sidecarRunning);
  const exportProgress = usePdfStore((state) => state.exportProgress);
  const fontProgress = usePdfStore((state) => state.fontProgress);
  const error = usePdfStore((state) => state.error);

  return (
    <footer className={styles.statusBar} aria-label="Application status">
      <span className={styles.documentStatus}>
        {isLoading ? 'Loading…' : `Page ${currentPage}/${pageCount} · ${objectCount} objects`}
      </span>
      {exportProgress && (
        <span className={styles.documentStatus}>
          Exporting {exportProgress.done}/{exportProgress.total}…
        </span>
      )}
      {/* The Fonts tab keeps analyzing while another tab is active, so the run
          has to stay visible here and not only inside that panel. */}
      {fontProgress && (
        <span className={styles.documentStatus} role="status" aria-live="polite">
          Analyzing fonts {fontProgress.done}/{fontProgress.total}…
        </span>
      )}
      {error && <span className={styles.error} role="alert">Error: {error}</span>}
      <span className={styles.spacer} />
      <span className={sidecarRunning ? styles.connected : styles.offline}>
        <span className={styles.indicator} aria-hidden="true" />
        Sidecar {sidecarRunning ? 'connected' : 'offline'}
      </span>
    </footer>
  );
};
