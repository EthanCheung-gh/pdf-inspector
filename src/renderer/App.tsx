import { useEffect, useMemo } from 'react';
import { AuditWorkspace } from './components/Audit/AuditWorkspace';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
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
import { DocumentTabs } from './components/Workspace/DocumentTabs';
import { RecentDocumentsDialog } from './components/Workspace/RecentDocumentsDialog';
import { usePageNavigation } from './hooks/usePageNavigation';
import { useRegisterCommands } from './hooks/useRegisterCommands';
import { useSessionRestore } from './hooks/useSessionRestore';
import { ipc } from './services/ipc-client';
import { resetSessionRestoreGuard, restoreSession } from './services/session-restore';
import type { CommandDefinition } from './services/command-registry';
import { LOCALES, applyLocale, useI18nStore, useT } from './i18n';
import { themeLabelKey } from './components/Toolbar/ThemePicker';
import { useAuditStore } from './store/audit-store';
import { useDiffStore } from './store/diff-store';
import { usePdfStore } from './store/pdf-store';
import { useRawStore } from './store/raw-store';
import { useSessionStore } from './store/session-store';
import { useSessionUiStore } from './store/session-ui-store';
import { applyTheme, useThemeStore } from './store/theme-store';
import { THEMES } from './theme/themes';
import {
  LEFT_PANEL_LIMITS,
  RIGHT_PANEL_LIMITS,
  useWorkspaceStore,
} from './store/workspace-store';
import styles from './App.module.css';

const SIDECAR_STATUS_POLL_INTERVAL_MS = 5_000;

const App = (): JSX.Element => {
  // Startup restore runs in an effect, so the empty shell paints first. It only
  // fires when no document is open and only once per page load (see the hook).
  useSessionRestore();
  const t = useT();
  // Same navigation the tab bar and the restore hook use, needed by the
  // "Restore last session" command.
  const { navigate } = usePageNavigation();
  const openRecentDialog = useSessionUiStore((state) => state.openRecentDialog);
  const theme = useThemeStore((state) => state.theme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const locale = useI18nStore((state) => state.locale);
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

  // Shell-level commands. They read the stores through `getState` so enabled
  // state is evaluated when the palette renders/opens, not frozen here. The
  // list is rebuilt when the translator changes so every title follows the
  // active locale (`useRegisterCommands` re-registers on array identity).
  const appCommands = useMemo<CommandDefinition[]>(() => {
    // One palette command per registered theme. Built from the registry so a
    // new theme shows up without touching this file's command wiring; the run
    // callback reads the store lazily like every other command.
    const themeCommands: CommandDefinition[] = THEMES.map((definition) => ({
      id: `view.theme.${definition.id}`,
      title: t('theme.current', { theme: t(themeLabelKey(definition.id)) }),
      group: 'View',
      keywords: ['theme', 'appearance', 'color', definition.id],
      run: () => useThemeStore.getState().setTheme(definition.id),
    }));

    // One palette command per locale. Titles use the language's autonym so both
    // entries stay recognisable in either locale.
    const languageCommands: CommandDefinition[] = LOCALES.map((target) => ({
      id: `language.${target}`,
      title: t(target === 'en' ? 'language.command.en' : 'language.command.zh-CN'),
      group: 'View',
      keywords: [
        'language',
        'locale',
        target === 'en' ? 'english' : 'chinese',
        target === 'en' ? 'en' : '简体中文',
      ],
      run: () => useI18nStore.getState().setLocale(target),
    }));

    return [
      // Recent/session entry points live in the shell: they are about documents
      // in general, not about the file the toolbar happens to have open. The
      // dialog is mounted once here, so the empty state and these commands share
      // one instance (see `session-ui-store`).
      {
        id: 'file.recent-documents',
        title: t('command.recentDocuments'),
        group: 'File',
        keywords: ['recent', 'history', 'files', 'reopen'],
        run: () => openRecentDialog(),
      },
      {
        id: 'file.restore-last-session',
        title: t('command.restoreLastSession'),
        group: 'File',
        keywords: ['restore', 'session', 'last', 'tabs'],
        // Only meaningful into an empty canvas: restoring over an open document
        // is exactly what the engine refuses to do.
        isEnabled: () =>
          usePdfStore.getState().filePath === null &&
          useSessionStore.getState().tabs.length > 0,
        run: () => {
          // A startup attempt already consumed the once-per-page-load guard (even
          // when it refused to run), so an explicit request starts a new run.
          resetSessionRestoreGuard();
          // Explicit requests restore even when automatic restore is turned off.
          void restoreSession({ navigate, force: true });
        },
      },
      {
        id: 'file.clear-recent-documents',
        title: t('command.clearRecentDocuments'),
        group: 'File',
        keywords: ['clear', 'recent', 'history', 'forget'],
        isEnabled: () => useSessionStore.getState().recent.length > 0,
        run: () => useSessionStore.getState().clearRecent(),
      },
      {
        id: 'view.toggle-theme',
        title: t('command.cycleTheme'),
        group: 'View',
        keywords: ['theme', 'cycle', 'appearance', 'dark', 'islands', 'light', 'system'],
        run: () => useThemeStore.getState().toggleTheme(),
      },
      ...themeCommands,
      ...languageCommands,
      {
        id: 'view.toggle-focus',
        title: t('command.toggleFocus'),
        group: 'View',
        keywords: ['focus', 'panels', 'zen'],
        run: () => useWorkspaceStore.getState().toggleFocusMode(),
      },
      {
        id: 'view.toggle-left-panel',
        title: t('command.toggleLeftPanel'),
        group: 'View',
        keywords: ['left', 'objects', 'panel', 'collapse'],
        run: () => {
          const store = useWorkspaceStore.getState();
          const visible = !store.leftCollapsed && !store.focusMode;
          if (visible) {
            store.setLeftCollapsed(true);
            return;
          }
          store.setLeftCollapsed(false);
          store.setFocusMode(false);
        },
      },
      {
        id: 'view.toggle-right-panel',
        title: t('command.toggleRightPanel'),
        group: 'View',
        keywords: ['right', 'inspector', 'panel', 'collapse'],
        run: () => {
          const store = useWorkspaceStore.getState();
          const visible = !store.rightCollapsed && !store.focusMode;
          if (visible) {
            store.setRightCollapsed(true);
            return;
          }
          store.setRightCollapsed(false);
          store.setFocusMode(false);
        },
      },
      {
        id: 'navigate.open-search',
        title: t('command.searchDocument'),
        group: 'Navigate',
        keywords: ['find', 'search', 'text'],
        shortcut: 'Ctrl+F',
        isEnabled: () => usePdfStore.getState().pageCount > 0,
        run: () => usePdfStore.getState().setSearchOpen(true),
      },
      {
        id: 'view.clear-selection',
        title: t('command.clearSelection'),
        group: 'View',
        keywords: ['clear', 'selection', 'deselect', 'escape'],
        run: () => usePdfStore.getState().clearSelection(),
      },
    ];
  }, [navigate, openRecentDialog, t]);
  useRegisterCommands('app', appCommands);

  // The store also applies the theme on `setTheme`; this effect covers the
  // first mount (including tests and embeds that skip the entry point) and
  // keeps both the resolved palette and the selected mode in sync with any
  // state written directly.
  useEffect(() => {
    applyTheme(resolvedTheme, theme);
  }, [resolvedTheme, theme]);

  // The store applies the locale on `setLocale`; this effect covers the first
  // mount (tests/embeds that skip the entry point) and keeps `<html lang>` in
  // sync with any state written directly. It does not read storage, so it can
  // never override a locale a caller just set.
  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

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
      // The search results popover is the topmost layer: Escape closes it first
      // and leaves the document selection alone. The panel and the search input
      // handle their own Escape, but focus can also be on a toolbar control.
      if (
        event.key === 'Escape' &&
        usePdfStore.getState().searchOpen &&
        usePdfStore.getState().searchResultsOpen
      ) {
        usePdfStore.getState().setSearchResultsOpen(false);
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
      {/*
       * Document tabs belong to the Inspect document only: while Diff, Audit
       * or Raw owns the workspace they are hidden rather than acting on a
       * document the user cannot see. The bar renders nothing when the bridge
       * cannot switch documents (no tab bridge) or before the first document
       * opens; Web tabs use the server document id instead of a local path.
       */}
      {!workspaceActive && <DocumentTabs />}
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
            <PanelRail
              side="left"
              label={t('panel.objects')}
              onShow={() => setLeftCollapsed(false)}
            />
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
                aria-label={t('common.showPanels')}
                title={t('common.showPanelsShortcut')}
              >
                {t('common.showPanels')}
              </button>
            )}
          </div>
          {rightCollapsed && !focusMode && (
            <PanelRail
              side="right"
              label={t('panel.inspector')}
              onShow={() => setRightCollapsed(false)}
            />
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
      <CommandPalette />
      {/* One shared instance: the empty state and the File commands both open it
          through `session-ui-store`. */}
      <RecentDocumentsDialog />
      {/* Mounted once at app level: the toolbar entry and the workspace's
          "Change files…" both open this same dialog through the diff store. */}
      <DiffSetupDialog />
    </div>
  );
};

export default App;
