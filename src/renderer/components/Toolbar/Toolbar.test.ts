// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import { useAuditStore } from '../../store/audit-store';
import { useDiffStore } from '../../store/diff-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfMetadata } from '../../types/pdf-objects';

const { navigate, openPdf, openPdfUrl, auditDocument, auditPages } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPdf: vi.fn(),
  openPdfUrl: vi.fn(),
  auditDocument: vi.fn(),
  auditPages: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdf, openPdfUrl, auditDocument, auditPages, extractPage: vi.fn(), saveFile: vi.fn() },
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

    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
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
