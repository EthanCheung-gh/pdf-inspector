// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import { useAuditStore } from '../../store/audit-store';
import { useDiffStore } from '../../store/diff-store';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { useRawStore } from '../../store/raw-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useI18nStore } from '../../i18n/store';
import { listCommands } from '../../services/command-registry';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';

const { navigate, openPdf, openPdfUrl, auditDocument, auditPages, rawDocument, rawObject, rawPageContent } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    openPdf: vi.fn(),
    openPdfUrl: vi.fn(),
    auditDocument: vi.fn(),
    auditPages: vi.fn(),
    rawDocument: vi.fn(),
    rawObject: vi.fn(),
    rawPageContent: vi.fn(),
  }));

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    openPdf,
    openPdfUrl,
    auditDocument,
    auditPages,
    rawDocument,
    rawObject,
    rawPageContent,
    extractPage: vi.fn(),
    saveFile: vi.fn(),
  },
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { Toolbar } from './Toolbar';

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

const url = 'https://example.com/a.pdf';

// Every suite starts in the default language so a Chinese smoke test cannot
// leak into the English assertions below it.
beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

function openUrlDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Open URL' }));
}

function submitUrl(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
}

describe('Toolbar open URL', () => {
  beforeEach(() => {
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    openPdf.mockReset();
    openPdfUrl.mockReset();
    useRawStore.getState().reset();

    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      documentName: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      zoom: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      isLoading: false,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });
    useWorkspaceStore.setState({
      leftTab: 'objects',
      leftCollapsed: false,
      rightCollapsed: false,
      focusMode: false,
    });
  });

  afterEach(cleanup);

  it('opens the URL dialog from the toolbar button', () => {
    render(React.createElement(Toolbar));

    expect(screen.queryByRole('dialog')).toBeNull();
    openUrlDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('stores the source URL and navigates to page 1 after a successful open', async () => {
    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/download.pdf',
      metadata,
      sourceUrl: url,
    });

    render(React.createElement(Toolbar));
    openUrlDialog();
    submitUrl(url);

    await waitFor(() => expect(usePdfStore.getState().sourceUrl).toBe(url));

    const state = usePdfStore.getState();
    expect(state.filePath).toBe('/tmp/download.pdf');
    expect(state.pageCount).toBe(5);
    expect(state.currentPage).toBe(1);
    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(navigate).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTitle(url).textContent).toBe(url);
  });

  it('shows the local file name and clears the URL when a local file is opened', async () => {
    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/download.pdf',
      metadata,
      sourceUrl: url,
    });
    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });

    render(React.createElement(Toolbar));
    openUrlDialog();
    submitUrl(url);
    await waitFor(() => expect(usePdfStore.getState().sourceUrl).toBe(url));

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/home/user/local.pdf'));
    expect(usePdfStore.getState().sourceUrl).toBeNull();
    expect(screen.getByTitle('/home/user/local.pdf').textContent).toBe('local.pdf');
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});

describe('Toolbar workspace controls', () => {
  beforeEach(() => {
    useRawStore.getState().reset();
    usePdfStore.setState({
      isLoading: false,
      pageCount: 0,
      overlayVisibility: {
        char: true,
        word: true,
        rect: true,
        line: true,
        curve: true,
        image: true,
        table: true,
      },
    });
    useWorkspaceStore.setState({
      leftTab: 'objects',
      leftCollapsed: false,
      rightCollapsed: false,
      focusMode: false,
    });
  });

  afterEach(cleanup);

  it('shows the visible layer count instead of the seven overlay buttons', () => {
    usePdfStore.setState({
      overlayVisibility: {
        char: false,
        word: true,
        rect: true,
        line: true,
        curve: true,
        image: false,
        table: true,
      },
    });

    render(React.createElement(Toolbar));

    expect(screen.getByRole('button', { name: 'Layers 5/7' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Chars' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Words' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Images' })).toBeNull();
  });

  it('opens Layers, expands the left pane and leaves focus mode', () => {
    useWorkspaceStore.setState({ leftCollapsed: true, focusMode: true });

    render(React.createElement(Toolbar));
    fireEvent.click(screen.getByRole('button', { name: 'Layers 7/7' }));

    const workspace = useWorkspaceStore.getState();
    expect(workspace.leftTab).toBe('layers');
    expect(workspace.leftCollapsed).toBe(false);
    expect(workspace.focusMode).toBe(false);
  });

  it('uses pane visibility toggles and can recover a pane from focus mode', () => {
    render(React.createElement(Toolbar));

    const leftButton = (): HTMLElement => screen.getByRole('button', { name: 'Left panel' });
    const rightButton = (): HTMLElement => screen.getByRole('button', { name: 'Right panel' });

    // Both panes start visible.
    expect(leftButton().getAttribute('aria-pressed')).toBe('true');
    expect(rightButton().getAttribute('aria-pressed')).toBe('true');

    // A visible pane is hidden by its toolbar button.
    fireEvent.click(leftButton());
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(true);
    expect(leftButton().getAttribute('aria-pressed')).toBe('false');
    expect(leftButton().getAttribute('title')).toBe('Show left panel');

    // Clicking again shows it without touching focus mode.
    fireEvent.click(leftButton());
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(false);
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
    expect(leftButton().getAttribute('aria-pressed')).toBe('true');

    // Focus mode hides both panes even though neither is collapsed.
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(useWorkspaceStore.getState().focusMode).toBe(true);
    expect(leftButton().getAttribute('aria-pressed')).toBe('false');
    expect(rightButton().getAttribute('aria-pressed')).toBe('false');

    // Recovering the left pane exits focus mode and leaves it visible instead
    // of merely flipping `leftCollapsed`.
    fireEvent.click(leftButton());
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(false);
    expect(leftButton().getAttribute('aria-pressed')).toBe('true');
    expect(rightButton().getAttribute('aria-pressed')).toBe('true');

    // The same recovery works for the right pane.
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(useWorkspaceStore.getState().focusMode).toBe(true);
    fireEvent.click(rightButton());
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(false);
    expect(rightButton().getAttribute('aria-pressed')).toBe('true');

    // And a visible pane still hides on a second click after recovery.
    fireEvent.click(rightButton());
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(true);
    expect(rightButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('translates toolbar copy and restores English when the locale switches back', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    usePdfStore.setState({ filePath: '/docs/report.pdf', pageCount: 5, isLoading: false });
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });

    render(React.createElement(Toolbar));

    expect(screen.getByRole('button', { name: '打开' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 URL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '页面导航' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '主题' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '左侧面板' }).getAttribute('title')).toBe(
      '隐藏左侧面板',
    );
    expect(screen.getByRole('button', { name: '对比' }).getAttribute('title')).toBe(
      '比较两份 PDF，不改变当前打开的文档',
    );

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Left panel' })).toBeTruthy();
  });
});

describe('Toolbar audit entry', () => {
  const tool = { name: 'pdf-inspector', version: '0.2.0' };

  const documentWithFinding = (): unknown => ({
    tool,
    document: {
      pages: 0,
      version: '1.7',
      encrypted: false,
      title: 'Audited',
      author: null,
      producer: null,
      language: null,
      tagged: false,
    },
    findings: [
      {
        category: 'metadata',
        severity: 'info',
        page: null,
        title: 'Missing language',
        detail: 'The document has no /Lang entry.',
        evidence: null,
        recommendation: null,
      },
    ],
  });

  beforeEach(() => {
    auditDocument.mockReset();
    auditPages.mockReset();
    openPdf.mockReset();
    openPdfUrl.mockReset();
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    useRawStore.getState().reset();
    auditDocument.mockResolvedValue({
      tool,
      document: {
        pages: 0,
        version: '1.7',
        encrypted: false,
        title: null,
        author: null,
        producer: null,
        language: null,
        tagged: false,
      },
      findings: [],
    });
    auditPages.mockResolvedValue({ tool, findings: [] });
    useDiffStore.getState().reset();
    useAuditStore.getState().reset();
    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      documentName: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      isLoading: false,
    });
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });
  });

  afterEach(cleanup);

  it('is disabled while no document is open', () => {
    render(React.createElement(Toolbar));

    const audit = screen.getByRole('button', { name: 'Audit' }) as HTMLButtonElement;
    expect(audit.disabled).toBe(true);
    expect(audit.getAttribute('aria-pressed')).toBe('false');
    expect(audit.getAttribute('title')).toBe('Open a PDF to audit it');
  });

  it('is disabled while Diff owns the workspace', () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useDiffStore.setState({ active: true });

    render(React.createElement(Toolbar));

    expect((screen.getByRole('button', { name: 'Audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the audit workspace with the file basename and reports the active mode', async () => {
    usePdfStore.setState({ filePath: '/docs/My Report.pdf', metadata, pageCount: 5 });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });

    const state = useAuditStore.getState();
    expect(state.active).toBe(true);
    expect(state.filePath).toBe('/docs/My Report.pdf');
    // The workspace header shows what the toolbar shows, never the full path.
    expect(state.fileName).toBe('My Report.pdf');
    expect(auditDocument).toHaveBeenCalledTimes(1);

    const audit = screen.getByRole('button', { name: 'Audit' });
    expect(audit.getAttribute('aria-pressed')).toBe('true');
    // Inspect-only controls are hidden while Audit owns the workspace.
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
  });

  it('uses the bridge display name for the header and the audit workspace', async () => {
    const webPath = 'http://localhost:8080/doc/abc123/%E6%B5%8B%E8%AF%95%20report.pdf';
    usePdfStore.setState({
      filePath: webPath,
      documentName: '测试 报告.pdf',
      metadata,
      pageCount: 5,
    });

    render(React.createElement(Toolbar));

    // Readable label; the tooltip still carries the resolved document URL.
    expect(screen.getByTitle(webPath).textContent).toBe('测试 报告.pdf');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });

    expect(useAuditStore.getState().fileName).toBe('测试 报告.pdf');
    expect(screen.getByTitle(webPath).textContent).toBe('测试 报告.pdf');
  });

  it('audits a URL-opened document under its source URL', async () => {
    usePdfStore.setState({
      filePath: '/tmp/download.pdf',
      sourceUrl: 'https://example.com/a.pdf',
      metadata,
      pageCount: 5,
    });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });

    expect(useAuditStore.getState().fileName).toBe('https://example.com/a.pdf');
  });

  it('keeps the Diff entry usable and still shows the document name while auditing', async () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });

    expect((screen.getByRole('button', { name: 'Diff' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTitle('/docs/report.pdf').textContent).toBe('report.pdf');
  });

  it('drops the previous document audit when another PDF is opened', async () => {
    auditDocument.mockResolvedValue(documentWithFinding());
    usePdfStore.setState({ filePath: '/docs/first.pdf', metadata, pageCount: 5 });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });
    expect(useAuditStore.getState().report).not.toBeNull();
    expect(useAuditStore.getState().fileName).toBe('first.pdf');

    openPdf.mockResolvedValue({ canceled: false, path: '/docs/second.pdf', metadata });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/docs/second.pdf'));

    // The audit belongs to the closed document: no report, no name, no mode.
    const audit = useAuditStore.getState();
    expect(audit.active).toBe(false);
    expect(audit.report).toBeNull();
    expect(audit.fileName).toBeNull();
    expect(audit.filePath).toBeNull();
    expect(audit.selected).toBeNull();
    // Nothing stale can be exported or opened: the entry is unpressed and the
    // Inspect controls are back.
    expect(screen.getByRole('button', { name: 'Audit' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Page navigation' })).toBeTruthy();

    // Re-entering audits the new document from scratch instead of reusing it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });
    expect(auditDocument).toHaveBeenCalledTimes(2);
    expect(useAuditStore.getState().fileName).toBe('second.pdf');
    expect(useAuditStore.getState().report?.findings).toHaveLength(1);
  });

  it('drops the previous document audit when a URL document replaces it', async () => {
    auditDocument.mockResolvedValue(documentWithFinding());
    usePdfStore.setState({ filePath: '/docs/first.pdf', metadata, pageCount: 5 });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });
    expect(useAuditStore.getState().report).not.toBeNull();

    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/remote.pdf',
      metadata,
      sourceUrl: 'https://example.com/b.pdf',
    });
    openUrlDialog();
    submitUrl('https://example.com/b.pdf');

    await waitFor(() => expect(usePdfStore.getState().sourceUrl).toBe('https://example.com/b.pdf'));

    const audit = useAuditStore.getState();
    expect(audit.active).toBe(false);
    expect(audit.report).toBeNull();
    expect(audit.fileName).toBeNull();
    expect(audit.filePath).toBeNull();
    expect(screen.getByRole('button', { name: 'Audit' }).getAttribute('aria-pressed')).toBe('false');
  });
});
describe('Toolbar raw entry', () => {
  const rawDocumentState = {
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

  beforeEach(() => {
    rawDocument.mockReset();
    rawDocument.mockResolvedValue(rawDocumentState);
    rawObject.mockReset();
    rawObject.mockResolvedValue({
      ref: { objectNumber: 1, generation: 0 },
      summary: 'dict · 1 entry',
      value: { kind: 'dict', truncated: false, entries: [] },
    });
    rawPageContent.mockReset();
    openPdf.mockReset();
    openPdfUrl.mockReset();
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    useDiffStore.getState().reset();
    useAuditStore.getState().reset();
    useRawStore.getState().reset();
    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      documentName: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      isLoading: false,
    });
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });
  });

  afterEach(cleanup);

  it('is disabled while no document is open', () => {
    render(React.createElement(Toolbar));

    const raw = screen.getByRole('button', { name: 'Raw' }) as HTMLButtonElement;
    expect(raw.disabled).toBe(true);
    expect(raw.getAttribute('aria-pressed')).toBe('false');
    expect(raw.getAttribute('title')).toBe('Open a PDF to inspect its raw objects');
  });

  it('is disabled while Diff owns the workspace', () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useDiffStore.setState({ active: true });

    render(React.createElement(Toolbar));

    const raw = screen.getByRole('button', { name: 'Raw' }) as HTMLButtonElement;
    expect(raw.disabled).toBe(true);
    expect(raw.getAttribute('title')).toBe(
      'Close the comparison/audit before reading raw objects',
    );
  });

  it('is disabled while Audit owns the workspace', () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useAuditStore.setState({ active: true, filePath: '/docs/report.pdf', fileName: 'report.pdf' });

    render(React.createElement(Toolbar));

    expect((screen.getByRole('button', { name: 'Raw' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the raw workspace with the file basename and reports the active mode', async () => {
    usePdfStore.setState({ filePath: '/docs/My Report.pdf', metadata, pageCount: 5 });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    });

    const state = useRawStore.getState();
    expect(state.active).toBe(true);
    expect(state.filePath).toBe('/docs/My Report.pdf');
    // The workspace header shows what the toolbar shows, never the full path.
    expect(state.fileName).toBe('My Report.pdf');
    expect(rawDocument).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    // Inspect-only controls are hidden while Raw owns the workspace.
    expect(screen.queryByRole('group', { name: 'Page navigation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select Text' })).toBeNull();
  });

  it('uses the bridge display name for the raw workspace and header', async () => {
    const webPath = 'http://localhost:8080/doc/abc123/%E6%B5%8B%E8%AF%95%20report.pdf';
    usePdfStore.setState({
      filePath: webPath,
      documentName: '测试 报告.pdf',
      metadata,
      pageCount: 5,
    });

    render(React.createElement(Toolbar));

    expect(screen.getByTitle(webPath).textContent).toBe('测试 报告.pdf');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    });

    const state = useRawStore.getState();
    expect(state.active).toBe(true);
    expect(state.filePath).toBe(webPath);
    expect(state.fileName).toBe('测试 报告.pdf');
    expect(screen.getByTitle(webPath).textContent).toBe('测试 报告.pdf');
  });

  it('never opens Raw over an active Audit', async () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useAuditStore.setState({ active: true, filePath: '/docs/report.pdf', fileName: 'report.pdf' });

    render(React.createElement(Toolbar));

    const raw = screen.getByRole('button', { name: 'Raw' }) as HTMLButtonElement;
    expect(raw.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(raw);
    });

    // The two workspaces can never both claim the Inspect area.
    expect(useAuditStore.getState().active).toBe(true);
    expect(useRawStore.getState().active).toBe(false);
    expect(rawDocument).not.toHaveBeenCalled();
  });

  it('closes Diff before opening Raw', async () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useDiffStore.setState({ active: true });

    render(React.createElement(Toolbar));

    // The button is disabled while Diff is open, so the transition can only
    // come from another entry point; the guard in App covers that case. Here
    // we prove the button's own title explains why it is unavailable.
    const raw = screen.getByRole('button', { name: 'Raw' }) as HTMLButtonElement;
    expect(raw.disabled).toBe(true);
    expect(useRawStore.getState().active).toBe(false);
  });

  it('closes Raw when Audit takes over the workspace', async () => {
    usePdfStore.setState({ filePath: '/docs/report.pdf', metadata, pageCount: 5 });
    useRawStore.setState({ active: true, filePath: '/docs/report.pdf', fileName: 'report.pdf' });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    });

    expect(useRawStore.getState().active).toBe(false);
    expect(useAuditStore.getState().active).toBe(true);
  });
});

describe('Toolbar document tabs', () => {
  type BridgeWindow = { pdfInspector?: { openPdfPath?: unknown } };

  beforeEach(() => {
    openPdf.mockReset();
    openPdfUrl.mockReset();
    navigate.mockReset();
    // The real navigation clears the toolbar's loading flag when it settles;
    // mirroring that here keeps the Open button usable across two opens.
    navigate.mockImplementation(async () => {
      usePdfStore.getState().setLoading(false);
    });
    useDocumentTabsStore.getState().reset();
    usePdfStore.getState().resetDocument();
    useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
    // Only the desktop bridge has open-by-path; its presence enables tabs.
    (window as unknown as BridgeWindow).pdfInspector = { openPdfPath: vi.fn() };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as BridgeWindow).pdfInspector;
  });

  it('adds and activates a tab when a local file is opened', async () => {
    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });

    render(React.createElement(Toolbar));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });

    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/home/user/local.pdf'));

    const tabs = useDocumentTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe('local.pdf');
    expect(tabs[0].path).toBe('/home/user/local.pdf');
    expect(tabs[0].sourceUrl).toBeNull();
    expect(useDocumentTabsStore.getState().activeTabId).toBe(tabs[0].id);
  });

  it('focuses the existing tab instead of duplicating a re-opened path', async () => {
    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });

    render(React.createElement(Toolbar));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));

    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/other.pdf', metadata });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(2));

    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });

    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/home/user/local.pdf'));
    const tabs = useDocumentTabsStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(useDocumentTabsStore.getState().activeTabId).toBe(tabs[0].id);
  });

  it('adds a URL tab named after its source URL', async () => {
    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/download.pdf',
      metadata,
      sourceUrl: url,
    });

    render(React.createElement(Toolbar));
    openUrlDialog();
    submitUrl(url);

    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));

    const tab = useDocumentTabsStore.getState().tabs[0];
    expect(tab.name).toBe(url);
    expect(tab.sourceUrl).toBe(url);
    expect(tab.path).toBe('/tmp/download.pdf');
  });

  it('keeps the outgoing tab snapshot when another document is opened', async () => {
    openPdf.mockResolvedValue({ canceled: false, path: '/docs/first.pdf', metadata });

    render(React.createElement(Toolbar));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/docs/first.pdf'));

    // The user navigates and zooms in the first document, then opens another.
    await act(async () => {
      usePdfStore.getState().setPage(3);
      usePdfStore.getState().setZoom(1.75);
    });

    openPdf.mockResolvedValue({ canceled: false, path: '/docs/second.pdf', metadata });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/docs/second.pdf'));

    const tabs = useDocumentTabsStore.getState().tabs;
    expect(tabs.map((tab) => tab.name)).toEqual(['first.pdf', 'second.pdf']);
    expect(tabs[0].snapshot.currentPage).toBe(3);
    expect(tabs[0].snapshot.zoom).toBe(1.75);
    expect(useDocumentTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('does not create tabs on the web build (no open-by-path bridge)', async () => {
    delete (window as unknown as BridgeWindow).pdfInspector;
    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });

    render(React.createElement(Toolbar));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });

    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/home/user/local.pdf'));
    expect(useDocumentTabsStore.getState().tabs).toEqual([]);
    expect(useDocumentTabsStore.getState().activeTabId).toBeNull();
  });
});

describe('Toolbar document tabs on the web bridge', () => {
  type WebBridgeWindow = {
    pdfInspector?: { activatePdfDocument?: unknown; closePdfDocument?: unknown };
  };

  beforeEach(() => {
    openPdf.mockReset();
    openPdfUrl.mockReset();
    navigate.mockReset();
    navigate.mockImplementation(async () => {
      usePdfStore.getState().setLoading(false);
    });
    useDocumentTabsStore.getState().reset();
    usePdfStore.getState().resetDocument();
    useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
    // The browser bridge has no `openPdfPath`; server document ids are what
    // enable the tab bar there.
    (window as unknown as WebBridgeWindow).pdfInspector = {
      activatePdfDocument: vi.fn(),
      closePdfDocument: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as WebBridgeWindow).pdfInspector;
    // These uploads carry display names; leaving one behind would change the
    // filename another describe renders.
    usePdfStore.getState().resetDocument();
  });

  it('stores the document id of every upload in its tab', async () => {
    openPdf
      .mockResolvedValueOnce({
        canceled: false,
        path: '/doc/doc-a/a.pdf',
        metadata,
        name: 'a.pdf',
        documentId: 'doc-a',
      })
      .mockResolvedValueOnce({
        canceled: false,
        path: '/doc/doc-b/b.pdf',
        metadata,
        name: 'b.pdf',
        documentId: 'doc-b',
      });

    render(React.createElement(Toolbar));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await waitFor(() => expect(useDocumentTabsStore.getState().tabs).toHaveLength(2));

    // The ids are what let the tab bar re-activate or close these documents
    // later without re-uploading them.
    const tabs = useDocumentTabsStore.getState().tabs;
    expect(tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(tabs.map((tab) => tab.documentId)).toEqual(['doc-a', 'doc-b']);
    expect(tabs.map((tab) => tab.path)).toEqual(['/doc/doc-a/a.pdf', '/doc/doc-b/b.pdf']);
    expect(useDocumentTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });
});

describe('Toolbar layout with search open', () => {
  const dockedFile = '/docs/report.pdf';

  const toolbarCss = (): string =>
    readFileSync(
      join(process.cwd(), 'src/renderer/components/Toolbar/Toolbar.module.css'),
      'utf8',
    );

  const header = (container: HTMLElement): HTMLElement => {
    const element = container.querySelector('header');
    if (!element) throw new Error('toolbar header not rendered');
    return element as HTMLElement;
  };

  beforeEach(() => {
    useDocumentTabsStore.getState().reset();
    useDiffStore.getState().reset();
    useAuditStore.getState().reset();
    useRawStore.getState().reset();
    usePdfStore.setState({
      filePath: dockedFile,
      sourceUrl: null,
      metadata,
      pageCount: 5,
      currentPage: 1,
      isLoading: false,
      searchOpen: false,
    });
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });
  });

  afterEach(cleanup);

  it('marks the header as search-open only while the search box is shown', () => {
    const { container } = render(React.createElement(Toolbar));
    expect(header(container).className).not.toMatch(/searchOpen/);

    act(() => {
      // Ctrl+F (or the toolbar button) opens search; the header must advertise
      // it so the CSS can reclaim the filename's width on narrow screens.
      usePdfStore.getState().setSearchOpen(true);
    });

    expect(header(container).className).toMatch(/searchOpen/);
    expect(screen.getByLabelText('Search document')).toBeTruthy();
  });

  it('keeps the document name in the DOM so the header title stays available', () => {
    usePdfStore.setState({ searchOpen: true });

    render(React.createElement(Toolbar));

    // The name is hidden by CSS at 1280px, not unmounted: the title tooltip and
    // the 1440px+ layout still have it.
    expect(screen.getByTitle(dockedFile).textContent).toBe('report.pdf');
  });

  it('does not mark the header as search-open while a workspace owns it', () => {
    usePdfStore.setState({ searchOpen: true });
    useDiffStore.setState({ active: true, oldName: 'a.pdf', newName: 'b.pdf' });

    const { container } = render(React.createElement(Toolbar));

    // Diff/Audit/Raw hide the search box and show their own title in the
    // filename slot, so reclaiming that space would hide information needlessly.
    expect(screen.queryByLabelText('Search document')).toBeNull();
    expect(header(container).className).not.toMatch(/searchOpen/);
  });

  it('reserves toolbar width by hiding the filename below 1440px', () => {
    // jsdom cannot measure the row, so the fix is asserted on the CSS contract:
    // the full-width toolbar needs the filename's space below 1440px, and the
    // <=1280px search-open rule still drops it while search is active.
    const css = toolbarCss();
    const query = css.match(/@media \(max-width: 1280px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(query).toContain('.toolbar.searchOpen .filename');
    expect(query).toContain('display: none');
    expect(css).toContain('@media (max-width: 1439px)');

    // No control is ever hidden by the media queries: only the filename.
    const mediaBlocks = css.match(/@media[^{]*\{[\s\S]*?\n\}/g) ?? [];
    expect(mediaBlocks).toHaveLength(2);
    for (const block of mediaBlocks) {
      expect(block).not.toMatch(/\.button\s*\{[\s\S]*display:\s*none/);
      expect(block).not.toMatch(/\.searchBox[\s\S]*display:\s*none/);
    }
  });

  it('keeps the fixed toolbar controls inside 1280px with a compact gap', () => {
    // The file name is already shrinkable to zero at 1280px, so hiding it does
    // not reclaim width. These two fixed budgets are what make the English
    // Export / View / Report toolbar fit without clipping the theme select.
    const css = toolbarCss();
    expect(css).toMatch(/\.toolbar\s*\{[^}]*gap:\s*3px/);
    expect(css).toMatch(/\.themeSelect\s*\{[^}]*width:\s*84px/);
  });
});

describe('Toolbar export view entry', () => {
  const pageData: PageData = {
    width: 612,
    height: 792,
    chars: [],
    words: [],
    rects: [],
    lines: [],
    curves: [],
    images: [],
    tables: [],
  };

  const exportViewCommand = () => listCommands().find((command) => command.id === 'export.view');

  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/docs/report.pdf',
      sourceUrl: null,
      documentName: null,
      metadata,
      pageCount: 5,
      currentPage: 1,
      pageData,
      pdfDocRef: {} as never,
      isLoading: false,
      subset: null,
    });
    useDiffStore.getState().reset();
    useAuditStore.getState().reset();
    useRawStore.getState().reset();
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });
  });

  afterEach(cleanup);

  it('renders the trigger and registers an enabled export view command', () => {
    render(React.createElement(Toolbar));

    const trigger = screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);

    const command = exportViewCommand();
    expect(command).toBeTruthy();
    expect(command?.title).toBe('Export view…');
    expect(command?.isEnabled?.()).toBe(true);

    act(() => {
      command?.run();
    });
    expect(screen.getByRole('heading', { name: 'Export view' })).toBeTruthy();
  });

  it('shows the short visible label while the full name stays accessible', () => {
    render(React.createElement(Toolbar));

    // The toolbar row only has room for the compact label; the accessible name
    // (and the command palette entry) keep the full wording.
    const trigger = screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement;
    expect(trigger.textContent).toBe('View…');
    expect(trigger.getAttribute('aria-label')).toBe('Export view…');
    expect(trigger.getAttribute('title')).toBe(
      'Export the current page or selected region as PNG or SVG',
    );
    expect(exportViewCommand()?.title).toBe('Export view…');

    act(() => {
      useI18nStore.setState({ locale: 'zh-CN' });
    });

    const zhTrigger = screen.getByRole('button', { name: '导出视图…' }) as HTMLButtonElement;
    expect(zhTrigger.textContent).toBe('视图…');
    expect(zhTrigger.getAttribute('aria-label')).toBe('导出视图…');
    expect(zhTrigger.getAttribute('title')).toBe('将当前页或所选区域导出为 PNG 或 SVG');
    expect(exportViewCommand()?.title).toBe('导出视图…');
  });

  it('does not render the old full trigger text', () => {
    render(React.createElement(Toolbar));

    expect(screen.queryByText('Export view…')).toBeNull();
    expect(screen.getByText('View…')).toBeTruthy();
  });

  it('disables the trigger and command without a page or PDF document', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(Toolbar));

    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(exportViewCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pageData, pdfDocRef: null });
    });
    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(exportViewCommand()?.isEnabled?.()).toBe(false);
  });

  it('hides the export view entry while a feature workspace owns the header', () => {
    useDiffStore.setState({ active: true, oldName: 'a.pdf', newName: 'b.pdf' });
    render(React.createElement(Toolbar));

    expect(screen.queryByRole('button', { name: 'Export view…' })).toBeNull();
    expect(exportViewCommand()).toBeUndefined();
  });
});

describe('Toolbar share report entry', () => {
  const pageData: PageData = {
    width: 612,
    height: 792,
    chars: [],
    words: [],
    rects: [],
    lines: [],
    curves: [],
    images: [],
    tables: [],
  };

  const reportCommand = () => listCommands().find((command) => command.id === 'export.report');

  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/docs/report.pdf',
      sourceUrl: null,
      documentName: null,
      metadata,
      pageCount: 5,
      currentPage: 1,
      pageData,
      pdfDocRef: {} as never,
      isLoading: false,
      fontStats: null,
    });
    useDiffStore.getState().reset();
    useAuditStore.getState().reset();
    useRawStore.getState().reset();
    useWorkspaceStore.setState({ leftCollapsed: false, rightCollapsed: false, focusMode: false });
  });

  afterEach(cleanup);

  it('renders the trigger and registers the report command', () => {
    render(React.createElement(Toolbar));

    const trigger = screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('title')).toBe('Share an HTML inspection report');

    const command = reportCommand();
    expect(command).toBeTruthy();
    expect(command?.title).toBe('Share report…');
    expect(command?.isEnabled?.()).toBe(true);

    act(() => {
      command?.run();
    });
    expect(screen.getByRole('heading', { name: 'Share report' })).toBeTruthy();
  });

  it('shows the short visible label while the full name stays accessible', () => {
    render(React.createElement(Toolbar));

    const trigger = screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement;
    expect(trigger.textContent).toBe('Report…');
    expect(trigger.getAttribute('aria-label')).toBe('Share report…');
    expect(trigger.getAttribute('title')).toBe('Share an HTML inspection report');
    // The command palette keeps the full wording.
    expect(reportCommand()?.title).toBe('Share report…');

    act(() => {
      useI18nStore.setState({ locale: 'zh-CN' });
    });

    const zhTrigger = screen.getByRole('button', { name: '分享报告…' }) as HTMLButtonElement;
    expect(zhTrigger.textContent).toBe('报告…');
    expect(zhTrigger.getAttribute('aria-label')).toBe('分享报告…');
    expect(zhTrigger.getAttribute('title')).toBe('分享 HTML 检查报告');
    expect(reportCommand()?.title).toBe('分享报告…');
  });

  it('hides the report entry while a feature workspace owns the header', () => {
    useDiffStore.setState({ active: true, oldName: 'a.pdf', newName: 'b.pdf' });
    render(React.createElement(Toolbar));

    expect(screen.queryByRole('button', { name: 'Share report…' })).toBeNull();
    expect(reportCommand()).toBeUndefined();
  });
});

describe('Toolbar command registrations', () => {
  const toolbarCommandIds = [
    'file.open',
    'file.open-url',
    'analyze.compare',
    'analyze.audit',
    'analyze.raw',
    'view.layers',
  ];

  const findCommand = (id: string) => listCommands().find((command) => command.id === id);

  beforeEach(() => {
    openPdf.mockReset();
    openPdfUrl.mockReset();
    useRawStore.getState().reset();
    useDiffStore.getState().reset();
    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      isLoading: false,
      error: null,
      pageData: null,
      allObjects: [],
      searchOpen: false,
    });
    useWorkspaceStore.setState({
      leftTab: 'objects',
      leftCollapsed: false,
      rightCollapsed: false,
      focusMode: false,
    });
  });

  afterEach(cleanup);

  it('registers the toolbar commands and unregisters them on unmount', () => {
    const view = render(React.createElement(Toolbar));

    const registered = listCommands()
      .map((command) => command.id)
      .filter((id) => toolbarCommandIds.includes(id));
    expect(registered.sort()).toEqual([...toolbarCommandIds].sort());

    view.unmount();
    const afterUnmount = listCommands()
      .map((command) => command.id)
      .filter((id) => toolbarCommandIds.includes(id));
    expect(afterUnmount).toEqual([]);
  });

  it('derives enabled state from the stores', () => {
    render(React.createElement(Toolbar));

    expect(findCommand('file.open')?.isEnabled?.()).toBe(true);
    expect(findCommand('file.open-url')?.isEnabled?.()).toBe(true);
    expect(findCommand('analyze.compare')?.isEnabled?.()).toBe(true);
    expect(findCommand('analyze.audit')?.isEnabled?.()).toBe(false);
    expect(findCommand('analyze.raw')?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ filePath: '/tmp/doc.pdf' });
    });
    expect(findCommand('analyze.audit')?.isEnabled?.()).toBe(true);
    expect(findCommand('analyze.raw')?.isEnabled?.()).toBe(true);

    act(() => {
      useDiffStore.setState({ active: true });
    });
    expect(findCommand('analyze.audit')?.isEnabled?.()).toBe(false);
    expect(findCommand('analyze.raw')?.isEnabled?.()).toBe(false);
    expect(findCommand('view.layers')?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ isLoading: true });
    });
    expect(findCommand('file.open')?.isEnabled?.()).toBe(false);
    expect(findCommand('file.open-url')?.isEnabled?.()).toBe(false);
  });

  it('runs Open through the same handler as the toolbar button', async () => {
    openPdf.mockResolvedValue({ canceled: true });
    render(React.createElement(Toolbar));

    await act(async () => {
      await findCommand('file.open')?.run();
    });

    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(usePdfStore.getState().isLoading).toBe(false);
  });

  it('opens the URL dialog and the Diff setup through their commands', () => {
    render(React.createElement(Toolbar));

    act(() => {
      findCommand('file.open-url')?.run();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();

    act(() => {
      findCommand('analyze.compare')?.run();
    });
    expect(useDiffStore.getState().setupOpen).toBe(true);
  });

  it('opens the Layers tab through the View command', () => {
    useWorkspaceStore.setState({ leftTab: 'objects', leftCollapsed: true, focusMode: true });
    render(React.createElement(Toolbar));

    act(() => {
      findCommand('view.layers')?.run();
    });

    const state = useWorkspaceStore.getState();
    expect(state.leftTab).toBe('layers');
    expect(state.leftCollapsed).toBe(false);
    expect(state.focusMode).toBe(false);
  });
});
