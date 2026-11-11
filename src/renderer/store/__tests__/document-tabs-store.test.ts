// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureViewSnapshot,
  documentTabName,
  findExistingTab,
  supportsDocumentTabs,
  useDocumentTabsStore,
} from '../document-tabs-store';
import type { DocumentTabSource } from '../document-tabs-store';
import { usePdfStore } from '../pdf-store';
import { useWorkspaceStore } from '../workspace-store';
import type { IpcApi } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

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

const source = (path: string, sourceUrl?: string): DocumentTabSource => ({
  path,
  metadata,
  ...(sourceUrl ? { sourceUrl } : {}),
});

/** A web document: the bridge reports a registry id next to its `/doc/<id>` path. */
const webSource = (documentId: string, path: string): DocumentTabSource => ({
  path,
  metadata,
  documentId,
});

type BridgeWindow = { pdfInspector?: Partial<IpcApi> };

function installBridge(bridge: Partial<IpcApi>): void {
  (window as unknown as BridgeWindow).pdfInspector = bridge;
}

const tabStore = () => useDocumentTabsStore.getState();

beforeEach(() => {
  tabStore().reset();
  usePdfStore.getState().resetDocument();
  useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
});

describe('addTab', () => {
  it('adds a local file tab named by its basename and activates it', () => {
    const tab = tabStore().addTab(source('/docs/report.pdf'));

    expect(tab.path).toBe('/docs/report.pdf');
    expect(tab.sourceUrl).toBeNull();
    expect(tab.name).toBe('report.pdf');
    expect(tab.metadata).toBe(metadata);
    expect(tab.snapshot.currentPage).toBe(1);
    expect(tab.snapshot.zoom).toBe(1);
    expect(tabStore().tabs).toHaveLength(1);
    expect(tabStore().activeTabId).toBe(tab.id);
  });

  it('names a URL tab after its source URL', () => {
    const tab = tabStore().addTab(source('/tmp/download.pdf', 'https://example.com/a.pdf'));

    expect(tab.sourceUrl).toBe('https://example.com/a.pdf');
    expect(tab.name).toBe('https://example.com/a.pdf');
  });

  it('accepts an explicit name', () => {
    expect(tabStore().addTab(source('/docs/a.pdf'), 'A (annotated)').name).toBe('A (annotated)');
  });

  it('uses the bridge display name (Unicode preserved) as the label', () => {
    const tab = tabStore().addTab({
      path: '/tmp/_____-1a2b.pdf',
      metadata,
      name: '测试 报告.pdf',
    });

    expect(tab.name).toBe('测试 报告.pdf');
    // An explicit name still wins over the source's display name.
    expect(tabStore().addTab({ path: '/docs/b.pdf', metadata, name: 'b.pdf' }, 'B').name).toBe('B');
  });

  it('dedupes a local file by path and focuses the existing tab', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    const second = tabStore().addTab(source('/docs/b.pdf'));
    expect(tabStore().activeTabId).toBe(second.id);

    const again = tabStore().addTab(source('/docs/a.pdf'));

    expect(again.id).toBe(first.id);
    expect(tabStore().tabs).toHaveLength(2);
    expect(tabStore().activeTabId).toBe(first.id);
  });

  it('dedupes a URL tab by source URL even though every open has a new temp path', () => {
    const url = 'https://example.com/report.pdf';
    const first = tabStore().addTab(source('/tmp/first.pdf', url));
    const second = tabStore().addTab(source('/tmp/second.pdf', url));

    expect(second.id).toBe(first.id);
    expect(tabStore().tabs).toHaveLength(1);
    // The tab adopts the fresh temp copy the re-open downloaded.
    expect(tabStore().tabs[0].path).toBe('/tmp/second.pdf');
  });

  it('keeps tabs with different source URLs apart', () => {
    tabStore().addTab(source('/tmp/a.pdf', 'https://example.com/a.pdf'));
    tabStore().addTab(source('/tmp/b.pdf', 'https://example.com/b.pdf'));

    expect(tabStore().tabs).toHaveLength(2);
  });

  it('keeps the server document id of a web document', () => {
    const tab = tabStore().addTab(webSource('doc-1', '/doc/doc-1/report.pdf'));

    expect(tab.documentId).toBe('doc-1');
    expect(tabStore().tabs[0].documentId).toBe('doc-1');
  });

  it('stores a null document id for a desktop or legacy document', () => {
    expect(tabStore().addTab(source('/docs/a.pdf')).documentId).toBeNull();
    expect(
      tabStore().addTab({ path: '/docs/b.pdf', metadata, documentId: null }).documentId,
    ).toBeNull();
  });

  it('dedupes a web document by id even when its path changed', () => {
    // A web activation re-resolves `/doc/<id>`; the id is what identifies the
    // document, so a different path must not create a second tab.
    const first = tabStore().addTab(webSource('doc-1', '/doc/doc-1/first.pdf'));
    const second = tabStore().addTab(webSource('doc-1', '/doc/doc-1/second.pdf'));

    expect(second.id).toBe(first.id);
    expect(tabStore().tabs).toHaveLength(1);
    // The tab follows the path the newest activation resolved.
    expect(tabStore().tabs[0].path).toBe('/doc/doc-1/second.pdf');
    expect(tabStore().activeTabId).toBe(first.id);
  });

  it('keeps the existing snapshot and id when the same URL is re-opened', () => {
    // A URL re-open registers a *new* server document id (the old one may have
    // been LRU-evicted) and downloads a new copy, so the tab must follow both.
    const url = 'https://example.com/report.pdf';
    const first = tabStore().addTab(source('/tmp/first.pdf', url));
    usePdfStore.setState({ currentPage: 3, zoom: 1.5 });
    tabStore().saveActiveSnapshot();
    const metadata2 = { ...metadata, pages: 9 };

    const refreshed = tabStore().addTab({
      path: '/doc/doc-c/report.pdf',
      metadata: metadata2,
      sourceUrl: url,
      documentId: 'doc-c',
      name: 'report.pdf',
    });

    expect(refreshed.id).toBe(first.id);
    expect(tabStore().tabs).toHaveLength(1);
    // Authoritative fields come from the open that just happened...
    expect(refreshed.path).toBe('/doc/doc-c/report.pdf');
    expect(refreshed.documentId).toBe('doc-c');
    expect(refreshed.metadata).toBe(metadata2);
    expect(refreshed.sourceUrl).toBe(url);
    // ...the label stays the URL it was named after...
    expect(refreshed.name).toBe(url);
    // ...and the view state the user left is untouched.
    expect(refreshed.snapshot.currentPage).toBe(3);
    expect(refreshed.snapshot.zoom).toBe(1.5);
    expect(tabStore().activeTabId).toBe(first.id);
  });

  it('refreshes a directly opened desktop path without losing its snapshot', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    usePdfStore.setState({ currentPage: 2 });
    tabStore().saveActiveSnapshot();
    const metadata2 = { ...metadata, pages: 12 };

    const again = tabStore().addTab({ path: '/docs/a.pdf', metadata: metadata2 });

    expect(again.id).toBe(first.id);
    expect(again.path).toBe('/docs/a.pdf');
    expect(again.metadata).toBe(metadata2);
    expect(again.documentId).toBeNull();
    expect(again.name).toBe('a.pdf');
    expect(again.snapshot.currentPage).toBe(2);
    expect(tabStore().tabs).toHaveLength(1);
  });

  it('keeps web documents with different ids apart', () => {
    tabStore().addTab(webSource('doc-1', '/doc/doc-1/a.pdf'));
    tabStore().addTab(webSource('doc-2', '/doc/doc-2/b.pdf'));

    expect(tabStore().tabs).toHaveLength(2);
  });
});

describe('findExistingTab', () => {
  it('matches a URL tab by source URL and a local tab by path', () => {
    const urlTab = tabStore().addTab(source('/tmp/a.pdf', 'https://example.com/a.pdf'));
    const localTab = tabStore().addTab(source('/docs/b.pdf'));
    const tabs = tabStore().tabs;

    expect(findExistingTab(tabs, source('/tmp/other.pdf', 'https://example.com/a.pdf'))?.id).toBe(
      urlTab.id,
    );
    expect(findExistingTab(tabs, source('/docs/b.pdf'))?.id).toBe(localTab.id);
    expect(findExistingTab(tabs, source('/docs/c.pdf'))).toBeUndefined();
  });

  it('prefers the document id over a shared source URL and over the path', () => {
    const byId = tabStore().addTab({
      path: '/doc/one/a.pdf',
      metadata,
      documentId: 'one',
      sourceUrl: 'https://example.com/a.pdf',
    });
    const byUrl = tabStore().addTab({
      path: '/doc/two/b.pdf',
      metadata,
      documentId: 'two',
      sourceUrl: 'https://example.com/b.pdf',
    });

    // Same id, but the URL and path of the other tab: the id still wins.
    expect(
      findExistingTab(tabStore().tabs, {
        path: '/doc/two/b.pdf',
        metadata,
        documentId: 'one',
        sourceUrl: 'https://example.com/b.pdf',
      })?.id,
    ).toBe(byId.id);
    // Without an id the URL decides, even though the path matches another tab.
    expect(
      findExistingTab(tabStore().tabs, {
        path: '/doc/one/a.pdf',
        metadata,
        sourceUrl: 'https://example.com/b.pdf',
      })?.id,
    ).toBe(byUrl.id);
  });

  it('never matches a tab without an id by id, so the path fallback still applies', () => {
    const desktop = tabStore().addTab(source('/docs/c.pdf'));

    // A desktop tab has no document id; a web open of a different document that
    // happens to use the same path falls through to the path match.
    expect(
      findExistingTab(tabStore().tabs, {
        path: '/docs/c.pdf',
        metadata,
        documentId: 'three',
      })?.id,
    ).toBe(desktop.id);
    expect(
      findExistingTab(tabStore().tabs, { path: '/doc/three/c.pdf', metadata, documentId: 'three' }),
    ).toBeUndefined();
  });
});

describe('saveActiveSnapshot', () => {
  it('captures page, zoom, overlays, panel tabs and the search query', () => {
    tabStore().addTab(source('/docs/a.pdf'));

    usePdfStore.setState({
      currentPage: 3,
      zoom: 1.75,
      overlayVisibility: { char: false, word: true },
      searchQuery: 'needle',
    });
    useWorkspaceStore.setState({ leftTab: 'fonts', inspectorTab: 'page' });

    tabStore().saveActiveSnapshot();

    expect(tabStore().tabs[0].snapshot).toEqual({
      currentPage: 3,
      zoom: 1.75,
      overlayVisibility: { char: false, word: true },
      leftTab: 'fonts',
      inspectorTab: 'page',
      searchQuery: 'needle',
    });
  });

  it('only snapshots the active tab', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    usePdfStore.setState({ currentPage: 2 });
    tabStore().saveActiveSnapshot();
    tabStore().addTab(source('/docs/b.pdf'));

    usePdfStore.setState({ currentPage: 4 });
    tabStore().saveActiveSnapshot();

    const tabs = tabStore().tabs;
    expect(tabs.find((tab) => tab.id === first.id)?.snapshot.currentPage).toBe(2);
    expect(tabs.find((tab) => tab.id !== first.id)?.snapshot.currentPage).toBe(4);
  });

  it('is a no-op without an active tab', () => {
    expect(() => tabStore().saveActiveSnapshot()).not.toThrow();
    expect(tabStore().tabs).toEqual([]);
  });

  it('copies the overlay map instead of sharing it with the live store', () => {
    tabStore().addTab(source('/docs/a.pdf'));
    tabStore().saveActiveSnapshot();

    usePdfStore.getState().toggleOverlay('word');

    expect(tabStore().tabs[0].snapshot.overlayVisibility.word).toBe(true);
    expect(usePdfStore.getState().overlayVisibility.word).toBe(false);
  });
});

describe('captureViewSnapshot', () => {
  it('reads the current pdf and workspace view state', () => {
    usePdfStore.setState({ currentPage: 7, zoom: 2 });
    useWorkspaceStore.setState({ leftTab: 'layers', inspectorTab: 'filter' });

    expect(captureViewSnapshot()).toEqual({
      currentPage: 7,
      zoom: 2,
      overlayVisibility: usePdfStore.getState().overlayVisibility,
      leftTab: 'layers',
      inspectorTab: 'filter',
      searchQuery: '',
    });
  });
});

describe('activate / updateTab', () => {
  it('activates only a known tab', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    const second = tabStore().addTab(source('/docs/b.pdf'));

    tabStore().activate(first.id);
    expect(tabStore().activeTabId).toBe(first.id);

    tabStore().activate('missing');
    expect(tabStore().activeTabId).toBe(first.id);
    expect(tabStore().tabs).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
  });

  it('patches the re-opened path, metadata and source URL without touching the id', () => {
    const tab = tabStore().addTab(source('/tmp/first.pdf', 'https://example.com/a.pdf'));
    const metadata2 = { ...metadata, pages: 9 };

    tabStore().updateTab(tab.id, { path: '/tmp/second.pdf', metadata: metadata2 });

    const updated = tabStore().tabs[0];
    expect(updated.id).toBe(tab.id);
    expect(updated.path).toBe('/tmp/second.pdf');
    expect(updated.metadata).toBe(metadata2);
    expect(updated.sourceUrl).toBe('https://example.com/a.pdf');
  });
});

describe('removeTab', () => {
  it('closing an inactive tab keeps the active document', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    const second = tabStore().addTab(source('/docs/b.pdf'));

    const result = tabStore().removeTab(first.id);

    expect(result?.removed.id).toBe(first.id);
    expect(result?.nextActiveId).toBe(second.id);
    expect(tabStore().activeTabId).toBe(second.id);
    expect(tabStore().tabs).toHaveLength(1);
  });

  it('closing the active tab activates the next neighbour', () => {
    tabStore().addTab(source('/docs/a.pdf'));
    const second = tabStore().addTab(source('/docs/b.pdf'));
    const third = tabStore().addTab(source('/docs/c.pdf'));

    const result = tabStore().removeTab(second.id);

    expect(result?.nextActiveId).toBe(third.id);
    expect(tabStore().activeTabId).toBe(third.id);
  });

  it('closing the active last tab falls back to the previous one', () => {
    const first = tabStore().addTab(source('/docs/a.pdf'));
    const last = tabStore().addTab(source('/docs/b.pdf'));

    const result = tabStore().removeTab(last.id);

    expect(result?.nextActiveId).toBe(first.id);
    expect(tabStore().activeTabId).toBe(first.id);
  });

  it('closing the last remaining tab leaves no active tab', () => {
    const only = tabStore().addTab(source('/docs/a.pdf'));

    const result = tabStore().removeTab(only.id);

    expect(result?.nextActiveId).toBeNull();
    expect(tabStore().activeTabId).toBeNull();
    expect(tabStore().tabs).toEqual([]);
  });

  it('returns null for an unknown tab', () => {
    tabStore().addTab(source('/docs/a.pdf'));

    expect(tabStore().removeTab('missing')).toBeNull();
    expect(tabStore().tabs).toHaveLength(1);
  });
});

describe('reset', () => {
  it('drops every tab and the active id', () => {
    tabStore().addTab(source('/docs/a.pdf'));
    tabStore().addTab(source('/docs/b.pdf'));

    tabStore().reset();

    expect(tabStore().tabs).toEqual([]);
    expect(tabStore().activeTabId).toBeNull();
  });
});

describe('supportsDocumentTabs', () => {
  afterEach(() => {
    delete (window as unknown as BridgeWindow).pdfInspector;
  });

  it('is true for the desktop bridge, which opens a known local path', () => {
    installBridge({ openPdfPath: vi.fn() });

    expect(supportsDocumentTabs()).toBe(true);
  });

  it('is true for the web bridge, which activates a server document id', () => {
    installBridge({ activatePdfDocument: vi.fn() });

    expect(supportsDocumentTabs()).toBe(true);
  });

  it('is false when the bridge can switch to neither a path nor an id', () => {
    installBridge({ openPdfUrl: vi.fn() });
    expect(supportsDocumentTabs()).toBe(false);

    delete (window as unknown as BridgeWindow).pdfInspector;
    expect(supportsDocumentTabs()).toBe(false);
  });
});

describe('documentTabName', () => {
  it('returns the last segment for POSIX and Windows paths', () => {
    expect(documentTabName('/docs/report.pdf')).toBe('report.pdf');
    expect(documentTabName('C:\\docs\\report.pdf')).toBe('report.pdf');
  });
});
