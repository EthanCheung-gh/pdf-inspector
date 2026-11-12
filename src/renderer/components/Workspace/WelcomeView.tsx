import React, { useCallback, useState } from 'react';
import { useT } from '../../i18n';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { ipc } from '../../services/ipc-client';
import { openRecentDocument, resetSessionRestoreGuard, restoreSession } from '../../services/session-restore';
import {
  captureViewSnapshot,
  documentTabName,
  supportsDocumentTabs,
  useDocumentTabsStore,
} from '../../store/document-tabs-store';
import type { DocumentTab } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import { useSessionStore } from '../../store/session-store';
import type { RecentDocument } from '../../store/session-store';
import { useSessionUiStore } from '../../store/session-ui-store';
import type { OpenPdfResult } from '../../types/ipc-protocol';
import { OpenUrlDialog } from '../Toolbar/OpenUrlDialog';
import type { OpenedFromUrl } from '../Toolbar/OpenUrlDialog';
import styles from './WelcomeView.module.css';

/** How many recent documents the empty state offers as quick entries. */
export const WELCOME_RECENT_LIMIT = 5;

type OpenedDocument = Extract<OpenPdfResult, { canceled: false }>;

/**
 * Empty state shown by `PdfViewport` when no document is open (work package Q3).
 *
 * This is the only place a first document can come from that was previously
 * missing on screen: the toolbar's Open buttons were already there, but the
 * canvas itself only said "open a file". The view therefore offers the three
 * entry points the plan asks for (local file, URL, recent list) plus the
 * optional restore of the last session, and a short privacy note.
 *
 * All document-opening paths funnel through `applyOpened`, which mirrors the
 * toolbar: snapshot the outgoing tab, `setFile`, add the tab (when the build can
 * switch documents) and record the recent entry, then navigate to page 1. The
 * tab bar records the active tab itself too, but an idempotent upsert here keeps
 * the recent list correct even in a build without tabs.
 *
 * The view never renders while a document is open — `PdfViewport` decides that.
 */
export const WelcomeView: React.FC = () => {
  const t = useT();
  const { navigate } = usePageNavigation();
  const recent = useSessionStore((state) => state.recent);
  const sessionTabs = useSessionStore((state) => state.tabs);
  const restoring = useSessionRestoreStore((state) => state.restoring);
  const openRecentDialog = useSessionUiStore((state) => state.openRecentDialog);

  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [openingRecentId, setOpeningRecentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = openingFile || restoring || openingRecentId !== null;

  const applyOpened = useCallback(
    async (result: OpenedDocument): Promise<void> => {
      const trackTabs = supportsDocumentTabs();
      // The outgoing document (if any) keeps its page, zoom and panel state.
      if (trackTabs) useDocumentTabsStore.getState().saveActiveSnapshot();

      usePdfStore
        .getState()
        .setFile(result.path, result.metadata, result.sourceUrl ?? null, result.name ?? null);

      let tab: DocumentTab;
      if (trackTabs) {
        tab = useDocumentTabsStore.getState().addTab(result);
      } else {
        const sourceUrl = result.sourceUrl ?? null;
        tab = {
          id: `welcome-${result.path}`,
          path: result.path,
          sourceUrl,
          documentId: result.documentId ?? null,
          name: result.name ?? documentTabName(result.path),
          metadata: result.metadata,
          snapshot: captureViewSnapshot(),
        };
      }
      useSessionStore.getState().recordOpen(tab);
      await navigate(1);
    },
    [navigate],
  );

  const handleOpenPdf = useCallback(async (): Promise<void> => {
    if (busy) return;
    setError(null);
    setOpeningFile(true);
    try {
      const result = await ipc.openPdf();
      if (result.canceled) return;
      await applyOpened(result);
    } catch (err) {
      console.error('Failed to open PDF:', err);
      setError(t('welcome.openFailed'));
    } finally {
      setOpeningFile(false);
    }
  }, [applyOpened, busy, t]);

  const handleUrlOpened = useCallback(
    async (result: OpenedFromUrl): Promise<void> => {
      try {
        await applyOpened(result);
      } catch (err) {
        console.error('Failed to apply the URL document:', err);
        setError(t('welcome.openFailed'));
      }
    },
    [applyOpened, t],
  );

  const handleOpenRecent = useCallback(
    async (record: RecentDocument): Promise<void> => {
      if (busy) return;
      setError(null);
      setOpeningRecentId(record.id);
      try {
        await openRecentDocument(record, { navigate });
      } catch (err) {
        console.error('Failed to open recent document:', record.name, err);
        setError(t('welcome.openRecentFailed', { name: record.name }));
      } finally {
        setOpeningRecentId(null);
      }
    },
    [busy, navigate, t],
  );

  const handleRestore = useCallback(async (): Promise<void> => {
    if (busy) return;
    setError(null);
    // The startup restore already consumed the once-per-page-load guard even
    // when it refused to run; a user asking explicitly must start a new run.
    resetSessionRestoreGuard();
    // `force` is what makes the button work while automatic restore is off: the
    // preference only governs the unattended startup attempt.
    await restoreSession({ navigate, force: true });
  }, [busy, navigate]);

  const recentQuickEntries = recent.slice(0, WELCOME_RECENT_LIMIT);
  const canRestore = sessionTabs.length > 0;

  return (
    <div className={styles.welcome} data-testid="welcome-view">
      <div className={styles.inner}>
        <div className={styles.header}>
          <div className={styles.icon} aria-hidden="true">
            📄
          </div>
          <h2 className={styles.title}>{t('welcome.title')}</h2>
          <p className={styles.subtitle}>{t('viewer.empty')}</p>
        </div>

        <div className={styles.actions}>
          <button
            className={`${styles.button} ${styles.primary}`}
            type="button"
            onClick={() => void handleOpenPdf()}
            disabled={busy}
          >
            {openingFile ? t('common.opening') : t('welcome.openPdf')}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => setUrlDialogOpen(true)}
            disabled={busy}
          >
            {t('welcome.openUrl')}
          </button>
          <button className={styles.button} type="button" onClick={openRecentDialog}>
            {t('welcome.recent')}
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void handleRestore()}
            disabled={!canRestore || busy}
            title={t('recent.restoreHint')}
          >
            {restoring ? t('welcome.restoring') : t('welcome.restoreLastSession')}
          </button>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {recentQuickEntries.length > 0 && (
          <section className={styles.recentSection} aria-label={t('welcome.recentHeading')}>
            <h3 className={styles.recentHeading}>{t('welcome.recentHeading')}</h3>
            <ul className={styles.recentList}>
              {recentQuickEntries.map((entry) => {
                const location = entry.sourceUrl ?? entry.path ?? entry.name;
                const opening = openingRecentId === entry.id;
                return (
                  <li key={entry.id}>
                    <button
                      className={styles.recentItem}
                      type="button"
                      title={location}
                      onClick={() => void handleOpenRecent(entry)}
                      disabled={busy}
                    >
                      {/* Names, paths and URLs are user data: never translated. */}
                      <span className={styles.recentName}>{entry.name}</span>
                      <span className={styles.recentLocation}>{location}</span>
                      {opening && <span className={styles.recentOpening}>{t('common.opening')}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <p className={styles.privacy}>{t('welcome.privacy')}</p>
      </div>

      <OpenUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        onOpened={handleUrlOpened}
      />
    </div>
  );
};
