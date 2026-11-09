// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

const { navigate, openPdfPath, openPdfUrl } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPdfPath: vi.fn(),
  openPdfUrl: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfPath, openPdfUrl },
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { DocumentTabs, clampSnapshotPage, restoreViewSnapshot } from './DocumentTabs';

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
): OpenedDocument => ({
  canceled: false,
  path,
  metadata: meta,
  ...(sourceUrl ? { sourceUrl } : {}),
});

const tabStore = () => useDocumentTabsStore.getState();
const pdfStore = () => usePdfStore.getState();

/** Desktop bridge: the presence of `openPdfPath` is what enables the tab bar. */
function installDesktopBridge(): void {
  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = { openPdfPath };
}

function installWebBridge(): void {
  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfUrl,
  };
}

function findTab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

beforeEach(() => {
  installDesktopBridge();
  navigate.mockReset();
  navigate.mockResolvedValue(undefined);
  openPdfPath.mockReset();
  openPdfUrl.mockReset();

  tabStore().reset();
  pdfStore().resetDocument();
  useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
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

  it('renders nothing on the web build, which has no open-by-path bridge', () => {
    installWebBridge();
    tabStore().addTab(opened('/docs/a.pdf'));

    const { container } = render(React.createElement(DocumentTabs));

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
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
  });
});

describe('helpers', () => {
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
    expect(state.overlayVisibility.char).toBe(false);
    expect(useWorkspaceStore.getState().leftTab).toBe('layers');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
    expect(state.searchQuery).toBe('');
  });
});
