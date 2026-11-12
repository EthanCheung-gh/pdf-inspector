// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

const { openPdf, openPdfUrl, openPdfPath, activatePdfDocument, navigate } = vi.hoisted(() => ({
  openPdf: vi.fn(),
  openPdfUrl: vi.fn(),
  openPdfPath: vi.fn(),
  activatePdfDocument: vi.fn(),
  navigate: vi.fn(async () => {}),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdf, openPdfUrl, openPdfPath, activatePdfDocument },
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

// The welcome view is rendered inside `PdfViewport`, whose PDF.js side is not
// what this test is about: only the empty/open switch matters there.
vi.mock('../../hooks/usePdf', () => ({
  usePdf: () => ({ pdfDoc: null, loadPdf: vi.fn(), loading: false, error: null }),
}));
vi.mock('../PdfViewport/PdfPage', () => ({ PdfPage: () => null }));

import { WelcomeView, WELCOME_RECENT_LIMIT } from './WelcomeView';
import { PdfViewport } from '../PdfViewport/PdfViewport';
import { resetSessionRestoreGuard } from '../../services/session-restore';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { useI18nStore } from '../../i18n/store';
import { usePdfStore } from '../../store/pdf-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import {
  configureSessionStorage,
  createMemorySessionStorage,
  useSessionStore,
} from '../../store/session-store';
import type { RecentDocument, SessionStorage, SessionTabRecord } from '../../store/session-store';
import { useSessionUiStore } from '../../store/session-ui-store';
import { useWorkspaceStore } from '../../store/workspace-store';

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

type OpenedDocument = Extract<OpenPdfResult, { canceled: false }>;

const opened = (
  path: string,
  meta: PdfMetadata = metadata,
  sourceUrl?: string,
  documentId?: string,
): OpenedDocument => ({
  canceled: false,
  path,
  metadata: meta,
  ...(sourceUrl ? { sourceUrl } : {}),
  ...(documentId ? { documentId } : {}),
});

const recent = (index: number, overrides: Partial<RecentDocument> = {}): RecentDocument => ({
  id: `local-${index}`,
  kind: 'local',
  name: `doc-${index}.pdf`,
  path: `/docs/doc-${index}.pdf`,
  sourceUrl: null,
  documentId: null,
  openedAt: 1_700_000_000_000 - index * 1_000,
  ...overrides,
});

const sessionTab = (path: string): SessionTabRecord => ({
  kind: 'local',
  path,
  sourceUrl: null,
  documentId: null,
  name: path.split('/').pop() ?? path,
  snapshot: {
    currentPage: 2,
    zoom: 1.5,
    overlayVisibility: {},
    leftTab: 'objects',
    inspectorTab: 'inspect',
    searchQuery: '',
  },
  lastActiveAt: 1,
});

let storage: SessionStorage;

beforeEach(() => {
  storage = createMemorySessionStorage();
  configureSessionStorage(storage);
  useSessionStore.getState().reset();
  useSessionStore.setState({ restoreLastSession: true });
  useDocumentTabsStore.getState().reset();
  usePdfStore.getState().resetDocument();
  useSessionRestoreStore.getState().reset();
  useSessionUiStore.getState().reset();
  useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
  useI18nStore.setState({ locale: 'en' });
  resetSessionRestoreGuard();

  openPdf.mockReset();
  openPdfUrl.mockReset();
  openPdfPath.mockReset();
  activatePdfDocument.mockReset();
  navigate.mockClear();

  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfPath,
    activatePdfDocument,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
  useSessionUiStore.getState().reset();
  configureSessionStorage(null);
  vi.restoreAllMocks();
});

describe('WelcomeView', () => {
  it('offers every entry point and keeps restore off without a saved session', () => {
    render(React.createElement(WelcomeView));

    expect(screen.getByTestId('welcome-view')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open URL…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recent documents…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore last session' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(openPdfPath).not.toHaveBeenCalled();
    // Privacy boundary is stated once, on the empty state itself.
    expect(screen.getByText(/stay on this device/i)).toBeTruthy();
  });

  it('opens a local PDF, adds the tab, records it and goes to page 1', async () => {
    openPdf.mockResolvedValue(opened('/docs/a.pdf'));

    render(React.createElement(WelcomeView));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open PDF…' }));
    });

    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(usePdfStore.getState().filePath).toBe('/docs/a.pdf');
    expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    expect(navigate).toHaveBeenCalledWith(1);
    expect(useSessionStore.getState().recent[0]).toMatchObject({
      kind: 'local',
      path: '/docs/a.pdf',
      name: 'a.pdf',
    });
  });

  it('reuses the URL dialog and opens the URL document like the toolbar does', async () => {
    const url = 'https://example.com/a.pdf';
    openPdfUrl.mockResolvedValue(opened('/tmp/a.pdf', metadata, url));

    render(React.createElement(WelcomeView));
    fireEvent.click(screen.getByRole('button', { name: 'Open URL…' }));

    const dialog = screen.getByRole('dialog', { name: 'Open URL' });
    fireEvent.change(within(dialog).getByLabelText('PDF URL'), { target: { value: url } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    });

    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(usePdfStore.getState().sourceUrl).toBe(url);
    expect(useDocumentTabsStore.getState().tabs).toHaveLength(1);
    expect(useSessionStore.getState().recent[0]).toMatchObject({
      kind: 'url',
      sourceUrl: url,
    });
    expect(navigate).toHaveBeenCalledWith(1);
  });

  it('opens the shared recent-documents dialog', () => {
    render(React.createElement(WelcomeView));

    fireEvent.click(screen.getByRole('button', { name: 'Recent documents…' }));

    expect(useSessionUiStore.getState().recentDialogOpen).toBe(true);
  });

  it('lists the newest recent documents, capped, and opens one on click', async () => {
    useSessionStore.setState({
      recent: Array.from({ length: WELCOME_RECENT_LIMIT + 2 }, (_, index) => recent(index)),
    });
    openPdfPath.mockResolvedValue(opened('/docs/doc-0.pdf'));

    render(React.createElement(WelcomeView));

    const section = screen.getByRole('region', { name: 'Recent' });
    const entries = within(section).getAllByRole('button');
    expect(entries).toHaveLength(WELCOME_RECENT_LIMIT);
    expect(entries[0].getAttribute('title')).toBe('/docs/doc-0.pdf');
    expect(within(entries[0]).getByText('doc-0.pdf')).toBeTruthy();

    await act(async () => {
      fireEvent.click(entries[0]);
    });

    expect(openPdfPath).toHaveBeenCalledWith('/docs/doc-0.pdf');
    expect(usePdfStore.getState().filePath).toBe('/docs/doc-0.pdf');
    expect(navigate).toHaveBeenCalledWith(1);
  });

  it('shows a row-level failure when a recent document cannot be opened', async () => {
    useSessionStore.setState({ recent: [recent(0)] });
    openPdfPath.mockRejectedValue(new Error('ENOENT: no such file'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(WelcomeView));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('region', { name: 'Recent' })).getAllByRole('button')[0]);
    });
    consoleError.mockRestore();

    expect(screen.getByRole('alert').textContent).toContain('Could not open doc-0.pdf');
    expect(usePdfStore.getState().filePath).toBeNull();
  });

  it('restores the last session after resetting the once-per-load guard', async () => {
    useSessionStore.setState({ tabs: [sessionTab('/docs/a.pdf')], activeIndex: 0 });
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    render(React.createElement(WelcomeView));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore last session' }));
    });

    await waitFor(() => {
      expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    });
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(usePdfStore.getState().filePath).toBe('/docs/a.pdf');
    expect(useSessionRestoreStore.getState().restoring).toBe(false);
  });

  it('restores the last session even when automatic restore is off', async () => {
    useSessionStore.setState({
      tabs: [sessionTab('/docs/a.pdf')],
      activeIndex: 0,
      restoreLastSession: false,
    });
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    render(React.createElement(WelcomeView));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore last session' }));
    });

    await waitFor(() => {
      expect(useDocumentTabsStore.getState().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    });
    // The explicit request bypasses the preference without changing it.
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(useSessionStore.getState().restoreLastSession).toBe(false);
  });
});

describe('PdfViewport empty state', () => {
  it('renders the welcome view only while no document is open', () => {
    render(React.createElement(PdfViewport));
    expect(screen.getByTestId('welcome-view')).toBeTruthy();

    act(() => {
      usePdfStore.getState().setFile('/docs/a.pdf', metadata);
    });

    expect(screen.queryByTestId('welcome-view')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open PDF…' })).toBeNull();
  });
});
