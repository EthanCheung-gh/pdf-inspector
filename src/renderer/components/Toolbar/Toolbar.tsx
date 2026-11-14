import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { ipc } from '../../services/ipc-client';
import { OVERLAY_LAYER_TOTAL, overlayVisibleCount } from '../../services/overlay-style';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useRegisterCommands } from '../../hooks/useRegisterCommands';
import type { CommandDefinition } from '../../services/command-registry';
import { useAuditStore } from '../../store/audit-store';
import { useDiffStore } from '../../store/diff-store';
import { supportsDocumentTabs, useDocumentTabsStore } from '../../store/document-tabs-store';
import { usePageOverviewStore } from '../../store/page-overview-store';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { SearchBox } from './SearchBox';
import { ExportDialog } from './ExportDialog';
import { ExportViewDialog } from './ExportViewDialog';
import { ShareReportButton } from './ShareReportButton';
import { OpenUrlDialog } from './OpenUrlDialog';
import { LanguagePicker } from './LanguagePicker';
import { ThemePicker } from './ThemePicker';
import type { OpenedFromUrl } from './OpenUrlDialog';
import styles from './Toolbar.module.css';

export const Toolbar: React.FC = () => {
  const t = useT();
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
  const storedDocumentName = usePdfStore((state) => state.documentName);
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

      // Document tabs (desktop only): the outgoing document keeps its page,
      // zoom and panel state, and the file that is about to open becomes the
      // active tab. Snapshot before `setFile`, which resets the view.
      const trackTabs = supportsDocumentTabs();
      if (trackTabs) useDocumentTabsStore.getState().saveActiveSnapshot();

      // An audit describes one document. Swapping the document must drop the
      // old report, filters and selection instead of leaving them attached to a
      // file that is no longer open.
      useAuditStore.getState().reset();
      setFile(result.path, result.metadata, undefined, result.name ?? null);
      // After `setFile`, so a new tab's snapshot is the fresh document's view.
      // Opening an already open path focuses that tab instead of duplicating it.
      if (trackTabs) useDocumentTabsStore.getState().addTab(result);
      await navigate(1);
    } catch (error) {
      if (openRequestId !== openRequestIdRef.current) return;
      console.error('Failed to open PDF:', error);
      setError(error instanceof Error ? error.message : t('toolbar.openFailed'));
      setLoading(false);
    }
  }, [navigate, setError, setFile, setLoading, t]);

  const handleUrlOpened = useCallback(
    async (result: OpenedFromUrl) => {
      // Invalidate any in-flight local `openPdf` dialog: the URL document is
      // the newest request and must not be clobbered when that one settles.
      openRequestIdRef.current += 1;

      const trackTabs = supportsDocumentTabs();
      if (trackTabs) useDocumentTabsStore.getState().saveActiveSnapshot();

      // Same as `handleOpen`: a URL document is a different document, so the
      // previous audit cannot survive it.
      useAuditStore.getState().reset();
      setFile(result.path, result.metadata, result.sourceUrl ?? null, result.name ?? null);
      // A URL tab is keyed by its source URL, so re-opening the same URL focuses
      // the existing tab even though every open downloads a new temp copy.
      if (trackTabs) useDocumentTabsStore.getState().addTab(result);
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

  // The name the user sees for the open document. The opening bridge's display
  // name wins (web upload name, desktop basename; Unicode preserved), then the
  // source URL, then the local basename. Audit and Raw reuse it as their
  // workspace/file name, so the header, both workspaces and their exported JSON
  // never expose an absolute or percent-encoded path.
  const localDocumentName = filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null;
  const documentName = storedDocumentName ?? sourceUrl ?? localDocumentName;
  const diffTitle = `${diffOldName ?? '—'} → ${diffNewName ?? '—'}`;
  // Diff, Audit and Raw each replace the Inspect panes; while one of them is
  // open the Inspect-only controls would act on a document the user cannot see.
  const workspaceActive = diffActive || auditActive || rawActive;
  // The tooltip keeps the full source URL or path; only the label is shortened.
  const displayTitle = diffActive
    ? diffTitle
    : sourceUrl ?? filePath ?? storedDocumentName ?? undefined;
  const filename = diffActive ? diffTitle : documentName ?? t('common.noFileOpen');
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

  // Toolbar commands reuse the exact handlers behind the buttons, so the
  // palette and the toolbar can never disagree about an action or its
  // enablement. Enabled state is evaluated lazily from the stores.
  const commands = useMemo<CommandDefinition[]>(
    () => [
      {
        id: 'file.open',
        title: t('command.openPdf'),
        group: 'File',
        keywords: ['open', 'file', 'pdf', 'local'],
        isEnabled: () => !usePdfStore.getState().isLoading,
        run: () => {
          void handleOpen();
        },
      },
      {
        id: 'file.open-url',
        title: t('command.openUrl'),
        group: 'File',
        keywords: ['open', 'url', 'http', 'remote'],
        isEnabled: () => !usePdfStore.getState().isLoading,
        run: () => setUrlDialogOpen(true),
      },
      {
        id: 'analyze.compare',
        title: t('command.compare'),
        group: 'Analyze',
        keywords: ['diff', 'compare', 'old', 'new'],
        isEnabled: () => true,
        run: () => openDiffSetup(),
      },
      {
        id: 'analyze.audit',
        title: t('command.audit'),
        group: 'Analyze',
        keywords: ['audit', 'inspect', 'check', 'fonts', 'security'],
        isEnabled: () => {
          const pdf = usePdfStore.getState();
          return Boolean(pdf.filePath) && !useDiffStore.getState().active;
        },
        run: () => handleAudit(),
      },
      {
        id: 'analyze.raw',
        title: t('command.raw'),
        group: 'Analyze',
        keywords: ['raw', 'objects', 'stream', 'content', 'debug'],
        isEnabled: () => {
          const pdf = usePdfStore.getState();
          return (
            Boolean(pdf.filePath) &&
            !useDiffStore.getState().active &&
            !useAuditStore.getState().active
          );
        },
        run: () => handleRaw(),
      },
      {
        id: 'view.layers',
        title: t('command.showLayers'),
        group: 'View',
        keywords: ['layers', 'overlay', 'objects', 'visibility'],
        isEnabled: () =>
          !useDiffStore.getState().active &&
          !useAuditStore.getState().active &&
          !useRawStore.getState().active,
        run: () => handleLayers(),
      },
    ],
    [handleAudit, handleLayers, handleOpen, handleRaw, openDiffSetup, t],
  );
  useRegisterCommands('toolbar', commands);

  return (
    <header className={`${styles.toolbar} ${searchActive ? styles.searchOpen : ''}`}>
      <button className={styles.button} type="button" onClick={handleOpen} disabled={isLoading}>
        {t('toolbar.open')}
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={() => setUrlDialogOpen(true)}
        disabled={isLoading}
        title={t('toolbar.openUrlTitle')}
      >
        {t('toolbar.openUrl')}
      </button>
      <button
        className={`${styles.button} ${diffActive ? styles.active : ''}`}
        type="button"
        onClick={openDiffSetup}
        aria-pressed={diffActive}
        title={diffActive ? t('toolbar.diffTitleOpen') : t('toolbar.diffTitleClosed')}
      >
        {t('toolbar.diff')}
      </button>
      <button
        className={`${styles.button} ${auditActive ? styles.active : ''}`}
        type="button"
        onClick={handleAudit}
        disabled={!filePath || diffActive}
        aria-pressed={auditActive}
        title={
          diffActive
            ? t('toolbar.auditTitleDiff')
            : filePath
              ? t('toolbar.auditTitleReady')
              : t('toolbar.auditTitleNoDocument')
        }
      >
        {t('toolbar.audit')}
      </button>
      <button
        className={`${styles.button} ${rawActive ? styles.active : ''}`}
        type="button"
        onClick={handleRaw}
        disabled={!filePath || diffActive || auditActive}
        aria-pressed={rawActive}
        title={
          diffActive || auditActive
            ? t('toolbar.rawTitleBlocked')
            : filePath
              ? t('toolbar.rawTitleReady')
              : t('toolbar.rawTitleNoDocument')
        }
      >
        {t('toolbar.raw')}
      </button>

      {/* Everything below drives the Inspect document; while Diff, Audit or Raw
          owns the workspace those controls would act on a hidden document, so
          only the document-independent entries above stay available. "Back to
          Inspect" lives in each workspace header next to its own controls. */}
      {!workspaceActive && (
        <>
          <span className={styles.separator} />

          <div className={styles.group} role="group" aria-label={t('toolbar.pageNavigation')}>
            <button
              className={styles.button}
              type="button"
              onClick={() => void navigate(currentPage - 1)}
              disabled={isLoading || currentPage <= 1}
            >
              {t('toolbar.prev')}
            </button>
            {/* The page counter doubles as the page overview entry: the button
                keeps the `1 / 4` text so the row looks unchanged and stays
                narrow at 1280px. Only the missing document disables it, never
                `isLoading`: a card click in the dialog starts a page extraction
                (which sets `isLoading`) and then closes the dialog, so a
                loading-disabled opener would be unfocusable exactly when the
                dialog restores focus to it. `P` and the palette command also
                work while a page loads. */}
            <button
              className={styles.pageIndicator}
              type="button"
              onClick={() => usePageOverviewStore.getState().openOverview()}
              disabled={pageCount < 1}
              title={t('toolbar.pageOverviewTitle')}
              // The visible count must stay part of the accessible name
              // (Label in Name); the hint only says what the click does.
              aria-label={`${currentPage} / ${pageCount} — ${t('toolbar.pageOverviewTitle')}`}
            >
              {currentPage} / {pageCount}
            </button>
            <button
              className={styles.button}
              type="button"
              onClick={() => void navigate(currentPage + 1)}
              disabled={isLoading || currentPage >= pageCount}
            >
              {t('toolbar.next')}
            </button>
          </div>

          <span className={styles.separator} />

          <div className={styles.group} role="group" aria-label={t('toolbar.zoomControls')}>
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
              title={t('toolbar.fitWidthTitle')}
            >
              {t('toolbar.fitWidth')}
            </button>
          </div>

          <span className={styles.separator} />

          <div className={styles.group} role="group" aria-label={t('toolbar.textSelection')}>
            <button
              className={`${styles.button} ${textSelectionMode ? styles.active : ''}`}
              type="button"
              onClick={handleTextSelectionToggle}
              aria-pressed={textSelectionMode}
              title={t('toolbar.selectTextTitle')}
            >
              {t('toolbar.selectText')}
            </button>
            <button
              className={`${styles.button} ${regionMode ? styles.active : ''}`}
              type="button"
              onClick={handleRegionToggle}
              aria-pressed={regionMode}
              title={t('toolbar.regionTitle')}
            >
              {t('toolbar.region')}
            </button>
          </div>

          <span className={styles.separator} />

          <div className={styles.group} role="group" aria-label={t('toolbar.workspaceLayout')}>
            <button
              className={`${styles.button} ${focusMode ? styles.active : ''}`}
              type="button"
              onClick={toggleFocusMode}
              aria-pressed={focusMode}
              title={t('toolbar.focusTitle')}
            >
              {t('toolbar.focus')}
            </button>
            <button
              className={`${styles.button} ${layersActive ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleLayers}
              title={t('toolbar.layersTitle')}
            >
              {t('toolbar.layers', { visible: visibleLayerCount, total: OVERLAY_LAYER_TOTAL })}
            </button>
            <button
              className={`${styles.button} ${leftVisible ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleLeftPanelToggle}
              aria-pressed={leftVisible}
              aria-label={t('toolbar.leftAria')}
              title={leftVisible ? t('toolbar.leftHide') : t('toolbar.leftShow')}
            >
              {t('toolbar.left')}
            </button>
            <button
              className={`${styles.button} ${rightVisible ? styles.paneVisible : ''}`}
              type="button"
              onClick={handleRightPanelToggle}
              aria-pressed={rightVisible}
              aria-label={t('toolbar.rightAria')}
              title={rightVisible ? t('toolbar.rightHide') : t('toolbar.rightShow')}
            >
              {t('toolbar.right')}
            </button>
          </div>
        </>
      )}

      <div className={styles.spacer} />
      {!workspaceActive && <ExportDialog />}
      {!workspaceActive && <ExportViewDialog />}
      {!workspaceActive && <ShareReportButton />}
      {!workspaceActive && <SearchBox />}
      <LanguagePicker />
      <ThemePicker />
      <span className={styles.filename} title={displayTitle}>{filename}</span>

      <OpenUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        onOpened={handleUrlOpened}
      />
    </header>
  );
};
