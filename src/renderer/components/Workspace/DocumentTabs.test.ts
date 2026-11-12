// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { useI18nStore } from '../../i18n/store';
import { usePdfStore } from '../../store/pdf-store';
import {
  SESSION_STORAGE_KEY,
  configureSessionStorage,
  createMemorySessionStorage,
  useSessionStore,
} from '../../store/session-store';
import type { SessionStorage } from '../../store/session-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';
import { PdfDocumentNotFoundError } from '../../../shared/document-errors';

const { navigate, openPdfPath, openPdfUrl, activatePdfDocument, closePdfDocument } = vi.hoisted(
  () => ({
    navigate: vi.fn(),
    openPdfPath: vi.fn(),
    openPdfUrl: vi.fn(),
    activatePdfDocument: vi.fn(),
    closePdfDocument: vi.fn(),
  }),
);

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfPath, openPdfUrl, activatePdfDocument, closePdfDocument },
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import {
  DocumentTabs,
  clampSnapshotPage,
  neighbourTabId,
  restoreViewSnapshot,
} from './DocumentTabs';

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

const otherMetadata: PdfMetadata = { ...metadata, pages: 9, title: 'Second' };

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

const tabStore = () => useDocumentTabsStore.getState();
const pdfStore = () => usePdfStore.getState();

/** The session record these tests persisted through the save triggers. */
interface SavedSession {
  tabs: Array<{
    kind: string;
    path: string | null;
    sourceUrl: string | null;
    documentId: string | null;
    name: string;
    snapshot: { currentPage: number; zoom: number };
  }>;
  activeIndex: number;
  restoreLastSession: boolean;
}

let sessionStorage: SessionStorage;

const readSavedSession = (): SavedSession =>
  JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? 'null') as SavedSession;

/** jsdom exposes `visibilityState` as a prototype getter; override per test. */
function setVisibilityState(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

/** Desktop bridge: the presence of `openPdfPath` is what enables the tab bar. */
function installDesktopBridge(): void {
  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = { openPdfPath };
}

/**
 * Web bridge: no local paths, server document ids instead. Both the activate and
 * the close method are present, which is what enables the tab bar there.
 */
function installWebBridge(): void {
  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfUrl,
    activatePdfDocument,
    closePdfDocument,
  };
}

function findTab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

/** A web tab: a server document id plus the `/doc/<id>/<name>` path it resolved. */
function webSource(id: string, name: string, meta: PdfMetadata = metadata) {
  return { path: `/doc/${id}/${name}`, metadata: meta, documentId: id, name };
}

beforeEach(() => {
  installDesktopBridge();
  useI18nStore.setState({ locale: 'en' });
  navigate.mockReset();
  navigate.mockResolvedValue(undefined);
  openPdfPath.mockReset();
  openPdfUrl.mockReset();
  activatePdfDocument.mockReset();
  closePdfDocument.mockReset();
  closePdfDocument.mockResolvedValue({ closed: true });

  tabStore().reset();
  pdfStore().resetDocument();
  useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
  // Session persistence is exercised by the save-trigger tests below; give every
  // test its own store so a saved session cannot leak between them.
  sessionStorage = createMemorySessionStorage();
  configureSessionStorage(sessionStorage);
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
  configureSessionStorage(null);
});

describe('tab bar visibility', () => {
  it('renders one tab per open document with the active one selected', () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));

    render(React.createElement(DocumentTabs));

    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeTruthy();
    expect(findTab('a.pdf').getAttribute('aria-selected')).toBe('false');
    expect(findTab('b.pdf').getAttribute('aria-selected')).toBe('true');
  });

  it('renders nothing while no document is open', () => {
    const { container } = render(React.createElement(DocumentTabs));

    expect(container.firstChild).toBeNull();
  });

  it('renders web tabs, which switch documents by server id', () => {
    installWebBridge();
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    tabStore().addTab(webSource('doc-b', 'b.pdf'));

    render(React.createElement(DocumentTabs));

    // The browser bridge has no `openPdfPath`; `activatePdfDocument` is what
    // makes the tab bar available there.
    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeTruthy();
    expect(findTab('a.pdf').getAttribute('aria-selected')).toBe('false');
    expect(findTab('b.pdf').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('renders nothing on a bridge that cannot switch documents', () => {
    // Neither `openPdfPath` nor `activatePdfDocument`: nothing to switch with.
    (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {};
    tabStore().addTab(webSource('doc-a', 'a.pdf'));

    const { container } = render(React.createElement(DocumentTabs));

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('translates the tab bar and close labels', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    tabStore().addTab(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));

    expect(screen.getByRole('tablist', { name: '已打开的文档' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭 a.pdf' })).toBeTruthy();
  });
});

describe('switching documents', () => {
  it('re-opens a local tab by path and restores its snapshot', async () => {
    const first = tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));

    // The user left the first document on page 3, zoomed in, in the Fonts tab.
    tabStore().activate(first.id);
    pdfStore().setPage(3);
    pdfStore().setZoom(1.5);
    pdfStore().setOverlayVisibility({ word: false });
    useWorkspaceStore.setState({ leftTab: 'fonts', inspectorTab: 'page' });
    pdfStore().setSearchQuery('needle');
    tabStore().saveActiveSnapshot();

    // Now the second document is the open one.
    pdfStore().setFile('/docs/b.pdf', metadata);
    const secondTabId = tabStore().tabs[1].id;
    tabStore().activate(secondTabId);

    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/docs/a.pdf'));
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(openPdfUrl).not.toHaveBeenCalled();

    // Snapshot restored onto the re-opened document.
    expect(pdfStore().zoom).toBe(1.5);
    // The zoom is only safe because the fit-to-width pass is told to stand down;
    // without it PdfViewport would fit the re-opened document over this value.
    expect(pdfStore().skipInitialFit).toBe(true);
    expect(pdfStore().overlayVisibility.word).toBe(false);
    expect(useWorkspaceStore.getState().leftTab).toBe('fonts');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('page');
    expect(pdfStore().searchQuery).toBe('needle');
    // Navigation is guarded and lands on the snapshotted page.
    expect(navigate).toHaveBeenCalledWith(3);

    // The clicked tab became active.
    expect(tabStore().activeTabId).toBe(first.id);
    expect(findTab('a.pdf').getAttribute('aria-selected')).toBe('true');
  });

  it('saves the outgoing document snapshot before switching away', async () => {
    const first = tabStore().addTab(opened('/docs/a.pdf'));
    pdfStore().setFile('/docs/a.pdf', metadata);
    pdfStore().setPage(4);
    tabStore().saveActiveSnapshot();

    const second = tabStore().addTab(opened('/docs/b.pdf'));
    pdfStore().setFile('/docs/b.pdf', metadata);
    pdfStore().setPage(3);

    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/docs/a.pdf'));

    // The tab that was active before the click captured the page it was on...
    expect(tabStore().tabs.find((tab) => tab.id === second.id)?.snapshot.currentPage).toBe(3);
    // ...and the clicked tab restored the page it was left on.
    expect(tabStore().tabs.find((tab) => tab.id === first.id)?.snapshot.currentPage).toBe(4);
    expect(navigate).toHaveBeenCalledWith(4);
  });

  it('re-downloads a URL tab and stores the new temp path and metadata', async () => {
    const urlTab = tabStore().addTab(opened('/tmp/first.pdf', metadata, 'https://example.com/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));

    openPdfUrl.mockResolvedValue(
      opened('/tmp/second.pdf', otherMetadata, 'https://example.com/a.pdf'),
    );
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('https://example.com/a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/tmp/second.pdf'));
    expect(openPdfUrl).toHaveBeenCalledWith('https://example.com/a.pdf');
    expect(openPdfPath).not.toHaveBeenCalled();

    const tab = tabStore().tabs.find((candidate) => candidate.id === urlTab.id);
    expect(tab?.path).toBe('/tmp/second.pdf');
    expect(tab?.metadata).toBe(otherMetadata);
    expect(tab?.sourceUrl).toBe('https://example.com/a.pdf');
    expect(pdfStore().sourceUrl).toBe('https://example.com/a.pdf');
    expect(pdfStore().pageCount).toBe(9);
  });

  it('activates a web tab by document id and restores its snapshot', async () => {
    installWebBridge();
    const first = tabStore().addTab(webSource('doc-a', 'a.pdf'));
    const second = tabStore().addTab(webSource('doc-b', 'b.pdf'));

    // The user left the first document on page 3, zoomed in, in the Fonts tab.
    tabStore().activate(first.id);
    pdfStore().setFile('/doc/doc-a/a.pdf', metadata);
    pdfStore().setPage(3);
    pdfStore().setZoom(1.5);
    useWorkspaceStore.setState({ leftTab: 'fonts', inspectorTab: 'page' });
    tabStore().saveActiveSnapshot();

    // The server is currently showing the second document.
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    tabStore().activate(second.id);

    activatePdfDocument.mockResolvedValue(
      opened('/doc/doc-a/a.pdf', metadata, undefined, 'doc-a'),
    );
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/doc/doc-a/a.pdf'));

    expect(activatePdfDocument).toHaveBeenCalledWith('doc-a');
    // Switching inside the browser never re-uploads or re-downloads.
    expect(openPdfUrl).not.toHaveBeenCalled();
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(closePdfDocument).not.toHaveBeenCalled();

    // Snapshot restored onto the re-activated document.
    expect(pdfStore().zoom).toBe(1.5);
    expect(useWorkspaceStore.getState().leftTab).toBe('fonts');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('page');
    expect(navigate).toHaveBeenCalledWith(3);

    expect(tabStore().activeTabId).toBe(first.id);
    expect(findTab('a.pdf').getAttribute('aria-selected')).toBe('true');
    expect(findTab('b.pdf').getAttribute('aria-selected')).toBe('false');
  });

  it('refreshes a web tab from the activation result', async () => {
    installWebBridge();
    // The tab was created before the server resolved the document's own path.
    const stale = tabStore().addTab(
      { path: '/doc/doc-a/stale.pdf', metadata, documentId: 'doc-a' },
      'a.pdf',
    );
    tabStore().addTab(webSource('doc-b', 'b.pdf'));

    activatePdfDocument.mockResolvedValue(
      opened('/doc/doc-a/a.pdf', otherMetadata, undefined, 'doc-a'),
    );
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/doc/doc-a/a.pdf'));

    const tab = tabStore().tabs.find((candidate) => candidate.id === stale.id);
    expect(tab?.documentId).toBe('doc-a');
    expect(tab?.path).toBe('/doc/doc-a/a.pdf');
    expect(tab?.metadata).toBe(otherMetadata);
    expect(pdfStore().pageCount).toBe(9);
  });

  it('prefers the document id over the tab’s source URL', async () => {
    installWebBridge();
    // A URL document opened in the browser also has a registry id: activating it
    // must win, so the switch never re-downloads.
    const urlTab = tabStore().addTab(
      opened('/doc/doc-a/a.pdf', metadata, 'https://example.com/a.pdf', 'doc-a'),
    );
    tabStore().addTab(webSource('doc-b', 'b.pdf'));

    activatePdfDocument.mockResolvedValue(
      opened('/doc/doc-a/a.pdf', metadata, 'https://example.com/a.pdf', 'doc-a'),
    );
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('https://example.com/a.pdf'));
    });

    await waitFor(() => expect(activatePdfDocument).toHaveBeenCalledWith('doc-a'));
    expect(openPdfUrl).not.toHaveBeenCalled();
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(pdfStore().sourceUrl).toBe('https://example.com/a.pdf');
    expect(tabStore().activeTabId).toBe(urlTab.id);
  });

  it('re-opens the source URL when the tab’s document id is stale', async () => {
    installWebBridge();
    const url = 'https://example.com/a.pdf';
    // The tab was opened from a URL, so it has both a registry id and a URL the
    // server can download again; the user left it on page 3, zoomed in.
    const stale = tabStore().addTab(opened('/doc/gone/a.pdf', metadata, url, 'gone'));
    const other = tabStore().addTab(webSource('doc-b', 'b.pdf'));

    tabStore().activate(stale.id);
    pdfStore().setFile('/doc/gone/a.pdf', metadata);
    pdfStore().setPage(3);
    pdfStore().setZoom(1.5);
    tabStore().saveActiveSnapshot();
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    tabStore().activate(other.id);

    // The server forgot `gone` (LRU eviction or a restart) but still has the URL
    // to download, which hands the document back under a fresh id.
    activatePdfDocument.mockRejectedValue(new PdfDocumentNotFoundError('Document not found'));
    openPdfUrl.mockResolvedValue(opened('/doc/doc-c/a.pdf', otherMetadata, url, 'doc-c'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab(url));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/doc/doc-c/a.pdf'));
    consoleWarn.mockRestore();

    expect(activatePdfDocument).toHaveBeenCalledWith('gone');
    // The stale id falls back to the URL instead of giving up on the tab.
    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(openPdfPath).not.toHaveBeenCalled();

    const healed = tabStore().tabs.find((tab) => tab.id === stale.id);
    expect(healed?.documentId).toBe('doc-c');
    expect(healed?.path).toBe('/doc/doc-c/a.pdf');
    expect(healed?.metadata).toBe(otherMetadata);
    expect(healed?.sourceUrl).toBe(url);
    // A self-heal is a normal switch: no error and the snapshot is restored.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(pdfStore().zoom).toBe(1.5);
    expect(navigate).toHaveBeenCalledWith(3);
    expect(tabStore().activeTabId).toBe(stale.id);
  });

  it('keeps a stale upload tab and reports why it cannot be re-opened', async () => {
    installWebBridge();
    // An upload has no source URL, so a forgotten id leaves nothing to re-open.
    const stale = tabStore().addTab(webSource('gone', 'upload.pdf'));
    const active = tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);

    activatePdfDocument.mockRejectedValue(new PdfDocumentNotFoundError('Document not found'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('upload.pdf'));
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Document not found'));
    consoleError.mockRestore();

    expect(openPdfUrl).not.toHaveBeenCalled();
    expect(openPdfPath).not.toHaveBeenCalled();
    // The tab survives (it is still closable: a close of a forgotten id removes
    // it) and the open document is untouched.
    expect(tabStore().tabs).toHaveLength(2);
    expect(tabStore().tabs.find((tab) => tab.id === stale.id)?.documentId).toBe('gone');
    expect(tabStore().activeTabId).toBe(active.id);
    expect(pdfStore().filePath).toBe('/doc/doc-b/b.pdf');
  });

  it('shows a loading state while the switch is in flight', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));

    let resolveOpen: (result: OpenPdfResult) => void = () => {};
    openPdfPath.mockReturnValue(
      new Promise<OpenPdfResult>((resolve) => {
        resolveOpen = resolve;
      }),
    );

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    expect(screen.getByRole('status').textContent).toBe('Opening…');
    expect((findTab('b.pdf') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveOpen(opened('/docs/a.pdf'));
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('reports a failed switch and keeps the current document and tab', async () => {
    const first = tabStore().addTab(opened('/docs/a.pdf'));
    const second = tabStore().addTab(opened('/docs/b.pdf'));
    pdfStore().setFile('/docs/b.pdf', metadata);

    openPdfPath.mockRejectedValue(new Error('Request "open" timed out after 120s'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Request "open" timed out after 120s'),
    );
    consoleError.mockRestore();
    expect(first.id).not.toBe(second.id);
    // Nothing was replaced in the renderer and no tab is falsely active.
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
    expect(tabStore().activeTabId).toBe(second.id);
  });
});

describe('closing tabs', () => {
  it('closing the active tab opens its neighbour', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));
    pdfStore().setFile('/docs/b.pdf', metadata);

    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close b.pdf' }));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/docs/a.pdf'));
    expect(openPdfPath).toHaveBeenCalledWith('/docs/a.pdf');
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
  });

  it('closing an inactive tab leaves the open document alone', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));
    pdfStore().setFile('/docs/b.pdf', metadata);

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    expect(openPdfPath).not.toHaveBeenCalled();
    expect(openPdfUrl).not.toHaveBeenCalled();
    // A desktop tab only holds a local path: closing it must never delete the
    // user's file, so the web close bridge stays untouched.
    expect(closePdfDocument).not.toHaveBeenCalled();
    expect(activatePdfDocument).not.toHaveBeenCalled();
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']);
    expect(tabStore().activeTabId).toBe(tabStore().tabs[0].id);
  });

  it('closing the last tab returns to the empty state without another open', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    pdfStore().setFile('/docs/a.pdf', metadata);
    pdfStore().setPage(3);
    pdfStore().setSearchQuery('needle');

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    expect(openPdfPath).not.toHaveBeenCalled();
    expect(tabStore().tabs).toEqual([]);
    expect(tabStore().activeTabId).toBeNull();

    expect(pdfStore().filePath).toBeNull();
    expect(pdfStore().metadata).toBeNull();
    expect(pdfStore().pageCount).toBe(0);
    expect(pdfStore().currentPage).toBe(1);
    expect(pdfStore().searchQuery).toBe('');
    // The bar disappears with the last tab.
    expect(screen.queryByRole('tablist')).toBeNull();
    // Local documents are never deleted, not even when the last tab goes away.
    expect(closePdfDocument).not.toHaveBeenCalled();
  });
});

describe('closing web tabs', () => {
  beforeEach(() => {
    installWebBridge();
  });

  it('closes an inactive tab’s document before removing the tab', async () => {
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    const active = tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    await waitFor(() => expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']));

    // The server deletes only that document's temp copy...
    expect(closePdfDocument).toHaveBeenCalledTimes(1);
    expect(closePdfDocument).toHaveBeenCalledWith('doc-a');
    // ...and the active document stays open, so nothing is re-activated.
    expect(activatePdfDocument).not.toHaveBeenCalled();
    expect(pdfStore().filePath).toBe('/doc/doc-b/b.pdf');
    expect(tabStore().activeTabId).toBe(active.id);
  });

  it('keeps the tab and shows the error when the close fails', async () => {
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    const active = tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    closePdfDocument.mockRejectedValue(new Error('Document is active'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Document is active'));
    consoleError.mockRestore();

    // The document is still open on the server, so its tab must survive.
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(tabStore().activeTabId).toBe(active.id);
    expect(pdfStore().filePath).toBe('/doc/doc-b/b.pdf');
  });

  it('activates the neighbour of a closed active tab, then closes that document', async () => {
    const first = tabStore().addTab(webSource('doc-a', 'a.pdf'));
    const second = tabStore().addTab(webSource('doc-b', 'b.pdf'));

    // The neighbour was last seen on page 2; the document being closed is on 4.
    tabStore().activate(first.id);
    pdfStore().setFile('/doc/doc-a/a.pdf', metadata);
    pdfStore().setPage(2);
    tabStore().saveActiveSnapshot();
    tabStore().activate(second.id);
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    pdfStore().setPage(4);

    activatePdfDocument.mockResolvedValue(
      opened('/doc/doc-a/a.pdf', metadata, undefined, 'doc-a'),
    );
    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close b.pdf' }));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/doc/doc-a/a.pdf'));
    await waitFor(() => expect(closePdfDocument).toHaveBeenCalledWith('doc-b'));

    // The server refuses to close the active document while siblings remain, so
    // the neighbour is activated first and only then is the old id deleted.
    expect(activatePdfDocument).toHaveBeenCalledWith('doc-a');
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    expect(tabStore().activeTabId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    // The neighbour's own snapshot is what lands on screen (`navigate` is the
    // mocked page navigation, so it carries the restored page).
    expect(navigate).toHaveBeenCalledWith(2);
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the active tab and document when the neighbour cannot be activated', async () => {
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    const active = tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    activatePdfDocument.mockRejectedValue(new Error('Unknown document'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close b.pdf' }));
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Unknown document'));
    consoleError.mockRestore();

    // Nothing was closed: the tab and the open document are both intact.
    expect(closePdfDocument).not.toHaveBeenCalled();
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(tabStore().activeTabId).toBe(active.id);
    expect(pdfStore().filePath).toBe('/doc/doc-b/b.pdf');
  });

  it('closing the last web tab closes its document and resets the view', async () => {
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    pdfStore().setFile('/doc/doc-a/a.pdf', metadata);
    pdfStore().setPage(3);
    pdfStore().setSearchQuery('needle');

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    await waitFor(() => expect(tabStore().tabs).toEqual([]));

    // The registry entry goes away with its tab; nothing is left to activate.
    expect(closePdfDocument).toHaveBeenCalledWith('doc-a');
    expect(activatePdfDocument).not.toHaveBeenCalled();
    expect(tabStore().activeTabId).toBeNull();

    expect(pdfStore().filePath).toBeNull();
    expect(pdfStore().metadata).toBeNull();
    expect(pdfStore().pageCount).toBe(0);
    expect(pdfStore().currentPage).toBe(1);
    expect(pdfStore().searchQuery).toBe('');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('removes a tab whose document the server has already forgotten', async () => {
    // The id was LRU-evicted (or the server restarted), so DELETE answers 404:
    // the document is gone even though the close did not succeed, and keeping
    // the tab would leave it permanently unclosable.
    tabStore().addTab(webSource('gone', 'a.pdf'));
    const active = tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);
    closePdfDocument.mockResolvedValue({ closed: false, notFound: true });

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    await waitFor(() => expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']));

    // The dead document is not reported as an error: there is nothing to fix.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(closePdfDocument).toHaveBeenCalledWith('gone');
    // The active document is neither re-activated nor replaced.
    expect(activatePdfDocument).not.toHaveBeenCalled();
    expect(pdfStore().filePath).toBe('/doc/doc-b/b.pdf');
    expect(tabStore().activeTabId).toBe(active.id);
  });

  it('closing the last tab still empties the view when its id is stale', async () => {
    tabStore().addTab(webSource('gone', 'a.pdf'));
    pdfStore().setFile('/doc/gone/a.pdf', metadata);
    pdfStore().setPage(3);
    closePdfDocument.mockResolvedValue({ closed: false, notFound: true });

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    await waitFor(() => expect(tabStore().tabs).toEqual([]));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(closePdfDocument).toHaveBeenCalledWith('gone');
    expect(tabStore().activeTabId).toBeNull();
    // Nothing is left on the server, so the renderer stops showing a document.
    expect(pdfStore().filePath).toBeNull();
    expect(pdfStore().currentPage).toBe(1);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('keeps a document opened while the close of the last tab is in flight', async () => {
    // The close is asynchronous, so the toolbar can open another document before
    // it settles. The "there was only one tab" decision taken before that
    // request must not wipe the document the user opened meanwhile.
    tabStore().addTab(webSource('gone', 'a.pdf'));
    pdfStore().setFile('/doc/gone/a.pdf', metadata);
    pdfStore().setPage(3);

    let resolveClose: (result: { closed: boolean; notFound?: boolean }) => void = () => {};
    closePdfDocument.mockReturnValue(
      new Promise<{ closed: boolean; notFound?: boolean }>((resolve) => {
        resolveClose = resolve;
      }),
    );

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Closing…');

    // Simulate a Toolbar open landing during the pending delete: a new server
    // document becomes the open one and gets its own tab.
    await act(async () => {
      pdfStore().setFile('/doc/new-id/new.pdf', metadata, null, 'new.pdf');
      tabStore().addTab(webSource('new-id', 'new.pdf'));
    });

    await act(async () => {
      resolveClose({ closed: true });
    });

    await waitFor(() => expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['new.pdf']));

    // Only the closed document's tab is gone; the freshly opened document is
    // still the one on screen.
    expect(closePdfDocument).toHaveBeenCalledWith('gone');
    expect(activatePdfDocument).not.toHaveBeenCalled();
    expect(pdfStore().filePath).toBe('/doc/new-id/new.pdf');
    expect(pdfStore().documentName).toBe('new.pdf');
    expect(tabStore().activeTabId).toBe(tabStore().tabs[0].id);
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true');
  });

  it('shows a closing state and disables the tabs while the delete is in flight', async () => {
    tabStore().addTab(webSource('doc-a', 'a.pdf'));
    tabStore().addTab(webSource('doc-b', 'b.pdf'));
    pdfStore().setFile('/doc/doc-b/b.pdf', metadata);

    let resolveClose: (result: { closed: boolean }) => void = () => {};
    closePdfDocument.mockReturnValue(
      new Promise<{ closed: boolean }>((resolve) => {
        resolveClose = resolve;
      }),
    );

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    expect(screen.getByRole('status').textContent).toBe('Closing…');
    expect((findTab('b.pdf') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveClose({ closed: true });
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']);
  });
});

describe('session persistence', () => {
  it('saves the open tabs after the tab set changes', () => {
    tabStore().addTab(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));

    const saved = readSavedSession();
    expect(saved.tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    expect(saved.activeIndex).toBe(0);
    expect(saved.tabs[0]).toMatchObject({ kind: 'local', path: '/docs/a.pdf' });
    // The preference is persisted alongside, not reset by a save.
    expect(saved.restoreLastSession).toBe(true);
  });

  it('does not persist page/zoom changes that no trigger captured', () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    render(React.createElement(DocumentTabs));

    pdfStore().setPage(3);
    pdfStore().setZoom(2);

    // Page/zoom only reach storage through an explicit save point, never by
    // themselves, so a document is not written on every page turn.
    expect(readSavedSession().tabs[0].snapshot).toMatchObject({ currentPage: 1, zoom: 1 });
  });

  it('saves the new active index when the user switches tabs', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    tabStore().addTab(opened('/docs/b.pdf'));
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(findTab('a.pdf'));
    });

    await waitFor(() => expect(pdfStore().filePath).toBe('/docs/a.pdf'));
    const saved = readSavedSession();
    expect(saved.tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(saved.activeIndex).toBe(0);
  });

  it('records the active document as a recent file', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));
    expect(useSessionStore.getState().recent.map((entry) => entry.name)).toEqual(['a.pdf']);

    // Opening a second document (toolbar, URL dialog, drag/drop) activates its
    // tab, which is what makes it show up in the recent list.
    await act(async () => {
      tabStore().addTab(opened('/docs/b.pdf'));
    });

    expect(useSessionStore.getState().recent.map((entry) => entry.name)).toEqual([
      'b.pdf',
      'a.pdf',
    ]);
  });

  it('does not wipe the saved session when the bar mounts with no tabs', () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    useSessionStore.getState().saveTabs(tabStore().tabs, tabStore().activeTabId);
    tabStore().reset();

    // Startup renders the bar before the restore engine has opened anything;
    // writing that empty set would erase the session the restore reads.
    render(React.createElement(DocumentTabs));

    expect(readSavedSession().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
  });

  it('persists an empty session when the last tab is closed', async () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    pdfStore().setFile('/docs/a.pdf', metadata);

    render(React.createElement(DocumentTabs));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close a.pdf' }));
    });

    expect(tabStore().tabs).toEqual([]);
    // The next start must not restore a document the user closed.
    expect(readSavedSession()).toMatchObject({ tabs: [], activeIndex: 0 });
  });

  it('leaves session writes to the engine while a restore is running', () => {
    useSessionRestoreStore.getState().begin(2);
    tabStore().addTab(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));

    // The restore engine is the single writer: no half-restored session is
    // persisted while it is opening documents one by one.
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();

    // The unload flush follows the same rule.
    pdfStore().setPage(3);
    fireEvent(window, new Event('beforeunload'));
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('persists the final tab set once the restore finishes', async () => {
    useSessionRestoreStore.getState().begin(1);
    tabStore().addTab(opened('/docs/a.pdf'));

    render(React.createElement(DocumentTabs));
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();

    await act(async () => {
      useSessionRestoreStore.getState().finish();
    });

    // The end of the run re-runs the save effect with the surviving tab set,
    // covering a restore that stopped early (e.g. the user opened a document).
    expect(readSavedSession().tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
  });

  it('captures the live view before persisting on beforeunload', () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    pdfStore().setFile('/docs/a.pdf', metadata);

    render(React.createElement(DocumentTabs));

    pdfStore().setPage(4);
    pdfStore().setZoom(1.75);
    fireEvent(window, new Event('beforeunload'));

    expect(readSavedSession().tabs[0].snapshot).toMatchObject({ currentPage: 4, zoom: 1.75 });
  });

  it('saves on visibilitychange only when the page becomes hidden', () => {
    tabStore().addTab(opened('/docs/a.pdf'));
    pdfStore().setFile('/docs/a.pdf', metadata);

    render(React.createElement(DocumentTabs));

    pdfStore().setPage(3);
    setVisibilityState('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(readSavedSession().tabs[0].snapshot.currentPage).toBe(3);

    // Becoming visible again is not a save point: nothing was captured since.
    pdfStore().setPage(5);
    setVisibilityState('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(readSavedSession().tabs[0].snapshot.currentPage).toBe(3);
  });
});

describe('helpers', () => {
  it('picks the same neighbour removeTab would activate', () => {
    const first = tabStore().addTab(opened('/docs/a.pdf'));
    const second = tabStore().addTab(opened('/docs/b.pdf'));
    const third = tabStore().addTab(opened('/docs/c.pdf'));

    // Middle tab: the one sliding into its slot wins, matching `removeTab`.
    expect(neighbourTabId(tabStore().tabs, second.id)).toBe(third.id);
    // Last tab: there is nothing after it, so the previous one takes over.
    expect(neighbourTabId(tabStore().tabs, third.id)).toBe(second.id);
    // The only tab of a single-tab bar has no neighbour at all.
    expect(neighbourTabId([first], first.id)).toBeNull();
    // Unknown ids never guess.
    expect(neighbourTabId(tabStore().tabs, 'tab-missing')).toBeNull();
  });

  it('clamps a snapshot page into the re-opened document', () => {
    expect(clampSnapshotPage(3, 5)).toBe(3);
    expect(clampSnapshotPage(9, 5)).toBe(5);
    expect(clampSnapshotPage(0, 5)).toBe(1);
    expect(clampSnapshotPage(Number.NaN, 5)).toBe(1);
    expect(clampSnapshotPage(3, 0)).toBe(1);
  });

  it('restores zoom, overlays and panel tabs onto the current document', () => {
    restoreViewSnapshot({
      currentPage: 2,
      zoom: 1.25,
      overlayVisibility: { char: false },
      leftTab: 'layers',
      inspectorTab: 'results',
      searchQuery: '',
    });

    const state = pdfStore();
    expect(state.zoom).toBe(1.25);
    // The one-shot skip is what keeps PdfViewport from fitting this zoom away.
    expect(state.skipInitialFit).toBe(true);
    expect(state.overlayVisibility.char).toBe(false);
    expect(useWorkspaceStore.getState().leftTab).toBe('layers');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
    expect(state.searchQuery).toBe('');
  });
});
