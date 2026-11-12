// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuditReport, type AuditFinding } from '../shared/audit-types';
import { useI18nStore } from './i18n/store';
import { useAuditStore } from './store/audit-store';
import { useDiffStore } from './store/diff-store';
import { usePdfStore } from './store/pdf-store';
import { useRawStore } from './store/raw-store';
import { useSessionRestoreStore } from './store/session-restore-store';
import { useSessionStore } from './store/session-store';
import type { SessionTabRecord } from './store/session-store';
import { useSessionUiStore } from './store/session-ui-store';
import { useThemeStore } from './store/theme-store';
import { useWorkspaceStore } from './store/workspace-store';
import { listCommands } from './services/command-registry';
import type { PdfMetadata, PdfWord } from './types/pdf-objects';
import type { RawDocument } from './types/raw-pdf';
import { makeSampleResult } from './services/__tests__/diff-fixtures';

vi.mock('./services/ipc-client', () => ({
  ipc: {
    getSidecarStatus: vi.fn(async () => ({ running: true })),
    openPdf: vi.fn(),
    openPdfUrl: vi.fn(),
    extractPage: vi.fn(),
    saveFile: vi.fn(),
    pickDiffPdf: vi.fn(),
    diffPdfs: vi.fn(),
    auditDocument: vi.fn(),
    auditPages: vi.fn(),
    rawDocument: vi.fn(),
    rawObject: vi.fn(),
    rawPageContent: vi.fn(),
  },
}));

/**
 * Spy on the restore entry points while keeping the real module for everything
 * else (`openRecentDocument` is used by the recent-documents dialog mounted by
 * `App`). This lets the shell tests assert *how* the startup hook and the
 * "Restore last session" command call the engine: startup must not force, the
 * explicit command must.
 */
const { restoreSessionMock, resetSessionRestoreGuardMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn(async (_options: { navigate: unknown; force?: boolean }) => false),
  resetSessionRestoreGuardMock: vi.fn(),
}));

vi.mock('./services/session-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/session-restore')>();
  return {
    ...actual,
    restoreSession: restoreSessionMock,
    resetSessionRestoreGuard: resetSessionRestoreGuardMock,
  };
});

// The shell test only cares about which workspace is mounted, so the heavy
// panes (and their PDF.js / CSS module graphs) are replaced by markers.
vi.mock('./components/LeftPanel/LeftPanel', () => ({
  LeftPanel: () => React.createElement('div', { 'data-testid': 'left-panel' }),
}));
vi.mock('./components/InspectorPanel/InspectorPanel', () => ({
  InspectorPanel: () => React.createElement('div', { 'data-testid': 'inspector-panel' }),
}));
vi.mock('./components/PdfViewport/PdfViewport', () => ({
  PdfViewport: () => React.createElement('div', { 'data-testid': 'pdf-viewport' }),
}));
vi.mock('./components/Workspace/PanelSplitter', () => ({ PanelSplitter: () => null }));
vi.mock('./components/Workspace/PanelRail', () => ({ PanelRail: () => null }));
vi.mock('./components/Diff/DiffWorkspace', () => ({
  DiffWorkspace: () => React.createElement('div', { 'data-testid': 'diff-workspace' }),
}));
vi.mock('./components/Diff/DiffSetupDialog', () => ({
  DiffSetupDialog: () => React.createElement('div', { 'data-testid': 'diff-setup-dialog' }),
}));
vi.mock('./components/Audit/AuditWorkspace', () => ({
  AuditWorkspace: () => React.createElement('div', { 'data-testid': 'audit-workspace' }),
}));
vi.mock('./components/Raw/RawWorkspace', () => ({
  RawWorkspace: () => React.createElement('div', { 'data-testid': 'raw-workspace' }),
}));

import App from './App';

const metadata: PdfMetadata = {
  pages: 5,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

beforeEach(() => {
  useDiffStore.getState().reset();
  useAuditStore.getState().reset();
  useRawStore.getState().reset();
  useThemeStore.setState({ theme: 'dark', resolvedTheme: 'dark' });
  // The default language stays English so the existing English assertions hold.
  useI18nStore.setState({ locale: 'en' });
  useWorkspaceStore.setState({
    leftCollapsed: false,
    rightCollapsed: false,
    focusMode: false,
  });
  usePdfStore.setState({
    filePath: '/docs/inspecting.pdf',
    sourceUrl: null,
    metadata,
    pageCount: 5,
    currentPage: 3,
    zoom: 1.5,
    pageData: null,
    allObjects: [],
    isLoading: false,
    error: null,
  });
});

afterEach(cleanup);

describe('App workspace mode', () => {
  it('shows the Inspect panes while no diff is active', () => {
    render(React.createElement(App));

    const inspect = screen.getByTestId('inspect-area');
    expect(inspect.hidden).toBe(false);
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(screen.getByTestId('inspector-panel')).toBeTruthy();
    expect(screen.queryByTestId('diff-workspace')).toBeNull();
    // The toolbar and status bar are part of the shell in both modes.
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByLabelText('Application status')).toBeTruthy();
  });

  it('applies the active theme to the document root', () => {
    useThemeStore.setState({ theme: 'islands' });
    render(React.createElement(App));

    expect(document.documentElement.dataset.theme).toBe('islands');
    expect(document.documentElement.dataset.themeMode).toBe('islands');

    act(() => {
      useThemeStore.getState().setTheme('light');
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');
  });

  it('registers shell commands and opens the palette with Ctrl+K', () => {
    render(React.createElement(App));

    const commands = listCommands();
    const appCommandIds = commands
      .map((command) => command.id)
      .filter((id) => id.startsWith('view.') || id === 'navigate.open-search');
    expect(appCommandIds).toEqual(
      expect.arrayContaining([
        'view.toggle-theme',
        'view.theme.dark',
        'view.theme.islands',
        'view.theme.light',
        'view.theme.system',
        'view.toggle-focus',
        'view.toggle-left-panel',
        'view.toggle-right-panel',
        'view.clear-selection',
        'navigate.open-search',
      ]),
    );

    const lightCommand = commands.find((command) => command.id === 'view.theme.light');
    expect(lightCommand?.title).toBe('Theme: Light');
    act(() => {
      lightCommand?.run();
    });
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });

  it('registers language commands that switch the locale', () => {
    render(React.createElement(App));

    const commands = listCommands();
    const english = commands.find((command) => command.id === 'language.en');
    const chinese = commands.find((command) => command.id === 'language.zh-CN');
    expect(english?.title).toBe('Language: English');
    expect(chinese?.title).toBe('Language: 简体中文');
    // English remains the default even though the commands exist.
    expect(useI18nStore.getState().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    act(() => {
      chinese?.run();
    });
    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');

    act(() => {
      english?.run();
    });
    expect(useI18nStore.getState().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('re-registers shell and toolbar command titles in the active language', () => {
    render(React.createElement(App));

    const findCommand = (id: string) => listCommands().find((command) => command.id === id);
    expect(findCommand('view.theme.light')?.title).toBe('Theme: Light');
    expect(findCommand('view.toggle-theme')?.title).toBe('Cycle theme');
    expect(findCommand('file.open')?.title).toBe('Open PDF…');

    act(() => {
      useI18nStore.setState({ locale: 'zh-CN' });
    });

    expect(findCommand('view.theme.light')?.title).toBe('主题：浅色');
    expect(findCommand('view.toggle-theme')?.title).toBe('循环切换主题');
    expect(findCommand('navigate.open-search')?.title).toBe('搜索文档…');
    expect(findCommand('language.en')?.title).toBe('语言：English');
    expect(findCommand('file.open')?.title).toBe('打开 PDF…');
    expect(findCommand('analyze.audit')?.title).toBe('审计文档…');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(findCommand('view.theme.light')?.title).toBe('Theme: Light');
    expect(findCommand('file.open')?.title).toBe('Open PDF…');
  });

  it('replaces the Inspect panes with the Diff workspace and keeps the shell usable', () => {
    render(React.createElement(App));

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
    expect(screen.getByTestId('diff-workspace')).toBeTruthy();
    expect(screen.getByLabelText('Application status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    // The Diff entry stays available and reports the active mode.
    expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true');
    // Inspect-only controls would act on the hidden document, so they are gone.
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();

    // The pane components stay mounted (hidden) so their local state survives.
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
  });

  it('restores the exact Inspect state when leaving Diff', () => {
    render(React.createElement(App));
    const pageDataBefore = usePdfStore.getState().pageData;

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });
    act(() => {
      useDiffStore.getState().exitWorkspace();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    expect(screen.queryByTestId('diff-workspace')).toBeNull();

    const pdf = usePdfStore.getState();
    expect(pdf.filePath).toBe('/docs/inspecting.pdf');
    expect(pdf.currentPage).toBe(3);
    expect(pdf.zoom).toBe(1.5);
    expect(pdf.pageData).toBe(pageDataBefore);
    // The comparison itself is kept so it can be reopened.
    expect(useDiffStore.getState().result).not.toBeNull();
    expect(useDiffStore.getState().active).toBe(false);
  });

  it('opens the diff setup dialog from the toolbar', () => {
    render(React.createElement(App));

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(useDiffStore.getState().setupOpen).toBe(true);
  });

  it('describes the comparison in the status bar while Diff is open', () => {
    render(React.createElement(App));

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    const status = screen.getByLabelText('Application status');
    expect(status.textContent).toContain('Diff page 1/3');
    expect(status.textContent).toContain('4 changes');
  });

  it('leaves Inspect state alone when its shortcuts are pressed while Diff is open', () => {
    const selectedWord: PdfWord = {
      type: 'word',
      page: 2,
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 32,
      text: 'Hello',
      fontname: 'Helvetica',
      size: 11,
    };
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });

    render(React.createElement(App));

    // Sanity check: in Inspect mode the same shortcuts do mutate the document
    // state, so the assertions below prove the Diff guard, not a dead listener.
    fireEvent.keyDown(window, { key: 't' });
    expect(usePdfStore.getState().textSelectionMode).toBe(true);
    fireEvent.keyDown(window, { key: 't' });
    expect(usePdfStore.getState().textSelectionMode).toBe(false);

    act(() => {
      useDiffStore.getState().enterWorkspace();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true });

    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBe(selectedWord);
    expect(pdf.filterCriteria).toEqual({ types: ['word'] });
    expect(pdf.textSelectionMode).toBe(false);
    expect(pdf.regionMode).toBe(false);
    // Ctrl+F must not open the Inspect search over the diff workspace either.
    expect(pdf.searchOpen).toBe(false);
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
  });
});

describe('App search results escape ordering', () => {
  const selectedWord: PdfWord = {
    type: 'word',
    page: 2,
    x0: 10,
    y0: 20,
    x1: 30,
    y1: 32,
    text: 'Hello',
    fontname: 'Helvetica',
    size: 11,
  };

  it('closes the search results panel before clearing the document selection', () => {
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      searchOpen: true,
      searchQuery: 'hello',
      searchMatches: [{ page: 2, begin: 0, length: 5, preview: 'Hello world' }],
      currentMatchIndex: 0,
      searchResultsOpen: true,
      searchError: null,
      searchTruncated: false,
    });

    render(React.createElement(App));
    expect(screen.getByRole('dialog', { name: 'Search results' })).toBeTruthy();

    // Focus can sit outside the input (a toolbar control), so the app-level
    // handler has to honour the popover order too.
    fireEvent.keyDown(window, { key: 'Escape' });

    let pdf = usePdfStore.getState();
    expect(pdf.searchResultsOpen).toBe(false);
    expect(pdf.selectedObject).toBe(selectedWord);
    expect(pdf.filterCriteria).toEqual({ types: ['word'] });
    expect(screen.queryByRole('dialog', { name: 'Search results' })).toBeNull();

    // With the popover gone, Escape behaves as before.
    fireEvent.keyDown(window, { key: 'Escape' });

    pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBeNull();
    expect(pdf.filterCriteria).toEqual({});
  });
});

describe('App audit mode', () => {
  const auditFinding = (severity: AuditFinding['severity'], page: number | null): AuditFinding => ({
    category: 'pages',
    severity,
    page,
    title: `${severity} on page ${page ?? 'document'}`,
    detail: 'detail',
    evidence: null,
    recommendation: null,
  });

  const enterAudit = (): void => {
    useAuditStore.setState({
      active: true,
      filePath: '/docs/inspecting.pdf',
      fileName: 'inspecting.pdf',
      report: buildAuditReport(
        {
          pages: 5,
          version: '1.7',
          encrypted: false,
          title: null,
          author: null,
          producer: null,
          language: null,
          tagged: false,
        },
        [auditFinding('error', 1), auditFinding('warning', 2), auditFinding('info', null)],
        { name: 'pdf-inspector', version: '0.2.0' },
      ),
      loading: false,
      progress: null,
      error: null,
    });
  };

  it('replaces the Inspect panes with the Audit workspace and keeps the shell usable', () => {
    render(React.createElement(App));

    act(() => {
      enterAudit();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
    expect(screen.getByTestId('audit-workspace')).toBeTruthy();
    expect(screen.queryByTestId('diff-workspace')).toBeNull();

    // The Audit entry reports the active mode; the Diff entry stays available.
    expect(screen.getByRole('button', { name: 'Audit' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: 'Diff' }) as HTMLButtonElement).disabled).toBe(false);
    // Inspect-only controls would act on the hidden document, so they are gone.
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();

    // The pane components stay mounted (hidden) so their local state survives.
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();

    expect(screen.getByLabelText('Application status').textContent).toContain(
      'Audit: 1 error · 1 warning · 1 info',
    );
  });

  it('restores the exact Inspect state when leaving Audit', () => {
    render(React.createElement(App));
    const pageDataBefore = usePdfStore.getState().pageData;

    act(() => {
      enterAudit();
    });
    act(() => {
      useAuditStore.getState().close();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    expect(screen.queryByTestId('audit-workspace')).toBeNull();

    const pdf = usePdfStore.getState();
    expect(pdf.filePath).toBe('/docs/inspecting.pdf');
    expect(pdf.currentPage).toBe(3);
    expect(pdf.zoom).toBe(1.5);
    expect(pdf.pageData).toBe(pageDataBefore);
    // The report survives so the same document can be reopened without a run.
    expect(useAuditStore.getState().report).not.toBeNull();
    expect(useAuditStore.getState().active).toBe(false);
  });

  it('leaves Audit when a comparison takes over the workspace', () => {
    render(React.createElement(App));

    act(() => {
      enterAudit();
    });
    expect(screen.getByTestId('audit-workspace')).toBeTruthy();

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    // Only one workspace is ever mounted: Diff wins, Audit is left.
    expect(useAuditStore.getState().active).toBe(false);
    expect(screen.getByTestId('diff-workspace')).toBeTruthy();
    expect(screen.queryByTestId('audit-workspace')).toBeNull();
    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
  });

  it('drops a stale audit when the open document changes elsewhere', () => {
    render(React.createElement(App));

    act(() => {
      enterAudit();
    });
    expect(screen.getByTestId('audit-workspace')).toBeTruthy();
    expect(useAuditStore.getState().report).not.toBeNull();

    // Any path that swaps the Inspect document (not just the toolbar's Open)
    // must not leave a report that belongs to the previous file.
    act(() => {
      usePdfStore.setState({ filePath: '/docs/other.pdf' });
    });

    const audit = useAuditStore.getState();
    expect(audit.active).toBe(false);
    expect(audit.report).toBeNull();
    expect(audit.fileName).toBeNull();
    expect(audit.filePath).toBeNull();

    // No stale workspace, no stale status line, no stale export target.
    expect(screen.queryByTestId('audit-workspace')).toBeNull();
    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    const status = screen.getByLabelText('Application status').textContent ?? '';
    expect(status).not.toContain('Audit:');
    expect(status).toContain('Page 3/5');
  });

  it('leaves Inspect state alone when its shortcuts are pressed while Audit is open', () => {
    const selectedWord: PdfWord = {
      type: 'word',
      page: 2,
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 32,
      text: 'Hello',
      fontname: 'Helvetica',
      size: 11,
    };
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });

    render(React.createElement(App));

    act(() => {
      enterAudit();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true });

    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBe(selectedWord);
    expect(pdf.filterCriteria).toEqual({ types: ['word'] });
    expect(pdf.textSelectionMode).toBe(false);
    expect(pdf.regionMode).toBe(false);
    expect(pdf.searchOpen).toBe(false);
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
  });
});

describe('App raw mode', () => {
  const rawDocumentFixture: RawDocument = {
    pages: 5,
    version: '1.7',
    encrypted: false,
    roots: [
      {
        label: 'Catalog',
        ref: { objectNumber: 1, generation: 0 },
        value: null,
      },
    ],
  };

  const enterRaw = (): void => {
    useRawStore.setState({
      active: true,
      filePath: '/docs/inspecting.pdf',
      fileName: 'inspecting.pdf',
      document: rawDocumentFixture,
      selected: { objectNumber: 1, generation: 0 },
      object: { ref: { objectNumber: 1, generation: 0 }, summary: 'dict', value: { kind: 'null' } },
      loading: false,
      error: null,
    });
  };

  it('replaces the Inspect panes with the Raw workspace and keeps the shell usable', () => {
    render(React.createElement(App));

    act(() => {
      enterRaw();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
    expect(screen.getByTestId('raw-workspace')).toBeTruthy();
    expect(screen.queryByTestId('diff-workspace')).toBeNull();
    expect(screen.queryByTestId('audit-workspace')).toBeNull();
    // The Raw entry reports the active mode; the other entries stay visible.
    expect(screen.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
    // Inspect-only controls would act on the hidden document, so they are gone.
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();

    // The pane components stay mounted (hidden) so their local state survives.
    expect(screen.getByTestId('pdf-viewport')).toBeTruthy();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(screen.getByLabelText('Application status').textContent).toContain('Raw: object 1 0 R');
  });

  it('restores the exact Inspect state when leaving Raw', () => {
    render(React.createElement(App));
    const pageDataBefore = usePdfStore.getState().pageData;

    act(() => {
      enterRaw();
    });
    act(() => {
      useRawStore.getState().close();
    });

    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    expect(screen.queryByTestId('raw-workspace')).toBeNull();

    const pdf = usePdfStore.getState();
    expect(pdf.filePath).toBe('/docs/inspecting.pdf');
    expect(pdf.currentPage).toBe(3);
    expect(pdf.zoom).toBe(1.5);
    expect(pdf.pageData).toBe(pageDataBefore);
    // The loaded object graph survives so Raw can be reopened without a read.
    expect(useRawStore.getState().document).not.toBeNull();
    expect(useRawStore.getState().active).toBe(false);
  });

  it('leaves Audit when Raw takes over the workspace', () => {
    render(React.createElement(App));

    act(() => {
      useAuditStore.setState({
        active: true,
        filePath: '/docs/inspecting.pdf',
        fileName: 'inspecting.pdf',
        report: null,
        loading: false,
        progress: null,
        error: null,
      });
    });
    expect(screen.getByTestId('audit-workspace')).toBeTruthy();

    act(() => {
      enterRaw();
    });

    expect(useAuditStore.getState().active).toBe(false);
    expect(screen.getByTestId('raw-workspace')).toBeTruthy();
    expect(screen.queryByTestId('audit-workspace')).toBeNull();
    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
  });

  it('leaves Raw when a comparison takes over the workspace', () => {
    render(React.createElement(App));

    act(() => {
      enterRaw();
    });
    expect(screen.getByTestId('raw-workspace')).toBeTruthy();

    act(() => {
      useDiffStore.getState().applyResult(makeSampleResult());
      useDiffStore.getState().enterWorkspace();
    });

    // Only one workspace is ever mounted: Diff wins, Raw is left.
    expect(useRawStore.getState().active).toBe(false);
    expect(screen.getByTestId('diff-workspace')).toBeTruthy();
    expect(screen.queryByTestId('raw-workspace')).toBeNull();
    expect(screen.getByTestId('inspect-area').hidden).toBe(true);
  });

  it('drops a stale raw view when the open document changes elsewhere', () => {
    render(React.createElement(App));

    act(() => {
      enterRaw();
    });
    expect(screen.getByTestId('raw-workspace')).toBeTruthy();

    act(() => {
      usePdfStore.setState({ filePath: '/docs/other.pdf' });
    });

    const raw = useRawStore.getState();
    expect(raw.active).toBe(false);
    expect(raw.document).toBeNull();
    expect(raw.fileName).toBeNull();

    expect(screen.queryByTestId('raw-workspace')).toBeNull();
    expect(screen.getByTestId('inspect-area').hidden).toBe(false);
    const status = screen.getByLabelText('Application status').textContent ?? '';
    expect(status).not.toContain('Raw:');
    expect(status).toContain('Page 3/5');
  });

  it('leaves Inspect state alone when its shortcuts are pressed while Raw is open', () => {
    const selectedWord: PdfWord = {
      type: 'word',
      page: 2,
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 32,
      text: 'Hello',
      fontname: 'Helvetica',
      size: 11,
    };
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });

    render(React.createElement(App));

    act(() => {
      enterRaw();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 't' });
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true });

    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBe(selectedWord);
    expect(pdf.filterCriteria).toEqual({ types: ['word'] });
    expect(pdf.textSelectionMode).toBe(false);
    expect(pdf.regionMode).toBe(false);
    expect(pdf.searchOpen).toBe(false);
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
  });
});

describe('App recent documents and session commands', () => {
  const sessionTab: SessionTabRecord = {
    kind: 'local',
    path: '/docs/previous.pdf',
    sourceUrl: null,
    documentId: null,
    name: 'previous.pdf',
    snapshot: {
      currentPage: 2,
      zoom: 1,
      overlayVisibility: {},
      leftTab: 'objects',
      inspectorTab: 'inspect',
      searchQuery: '',
    },
    lastActiveAt: 1,
  };

  const command = (id: string) => listCommands().find((entry) => entry.id === id);

  beforeEach(() => {
    useSessionStore.getState().reset();
    useSessionUiStore.getState().reset();
    useSessionRestoreStore.getState().reset();
    restoreSessionMock.mockClear();
    resetSessionRestoreGuardMock.mockClear();
  });

  afterEach(() => {
    useSessionStore.getState().reset();
    useSessionUiStore.getState().reset();
    useSessionRestoreStore.getState().reset();
  });

  it('registers the File entries for recent documents and the last session', () => {
    render(React.createElement(App));

    expect(command('file.recent-documents')?.title).toBe('Recent documents…');
    expect(command('file.restore-last-session')?.title).toBe('Restore last session');
    expect(command('file.clear-recent-documents')?.title).toBe('Clear recent documents');
    expect(command('file.recent-documents')?.group).toBe('File');
  });

  it('opens the shared recent-documents dialog from the command palette entry', () => {
    render(React.createElement(App));
    expect(screen.queryByRole('dialog', { name: 'Recent documents' })).toBeNull();

    act(() => {
      command('file.recent-documents')?.run();
    });

    expect(useSessionUiStore.getState().recentDialogOpen).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Recent documents' })).toBeTruthy();
  });

  it('enables restore only into an empty canvas with a saved session', () => {
    useSessionStore.setState({ tabs: [sessionTab], activeIndex: 0, restoreLastSession: true });
    render(React.createElement(App));

    // A document is open (the shell default in this file): never restore over it.
    expect(command('file.restore-last-session')?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ filePath: null });
      useSessionStore.setState({ restoreLastSession: false });
    });

    expect(command('file.restore-last-session')?.isEnabled?.()).toBe(true);

    act(() => {
      useSessionStore.setState({ tabs: [] });
    });
    expect(command('file.restore-last-session')?.isEnabled?.()).toBe(false);
  });

  it('forces a restore only for the explicit command, never for startup', () => {
    useSessionStore.setState({ tabs: [sessionTab], activeIndex: 0, restoreLastSession: false });
    usePdfStore.setState({ filePath: null });

    render(React.createElement(App));

    // The startup hook asks the engine to restore, but never forces it: the
    // automatic-restore preference decides whether anything happens.
    expect(restoreSessionMock).toHaveBeenCalledTimes(1);
    expect(restoreSessionMock.mock.calls[0][0]).not.toHaveProperty('force');

    act(() => {
      command('file.restore-last-session')?.run();
    });

    // The manual request resets the once-per-page-load guard and forces the
    // restore, so it also works while automatic restore is turned off.
    expect(resetSessionRestoreGuardMock).toHaveBeenCalledTimes(1);
    expect(restoreSessionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it('clears the recent list from the command and disables itself afterwards', () => {    useSessionStore.setState({
      recent: [
        {
          id: 'local-1',
          kind: 'local',
          name: 'note.pdf',
          path: '/docs/note.pdf',
          sourceUrl: null,
          documentId: null,
          openedAt: 1_700_000_000_000,
        },
      ],
    });
    render(React.createElement(App));

    const clear = command('file.clear-recent-documents');
    expect(clear?.isEnabled?.()).toBe(true);

    act(() => {
      clear?.run();
    });

    expect(useSessionStore.getState().recent).toEqual([]);
    expect(clear?.isEnabled?.()).toBe(false);
  });

  it('re-registers the new command titles in the active language', () => {
    render(React.createElement(App));

    act(() => {
      useI18nStore.setState({ locale: 'zh-CN' });
    });

    expect(command('file.recent-documents')?.title).toBe('最近文档…');
    expect(command('file.restore-last-session')?.title).toBe('恢复上次会话');
    expect(command('file.clear-recent-documents')?.title).toBe('清空最近文档');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });
  });
});
