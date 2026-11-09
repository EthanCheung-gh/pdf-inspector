import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureViewSnapshot,
  documentTabName,
  findExistingTab,
  useDocumentTabsStore,
} from '../document-tabs-store';
import type { DocumentTabSource } from '../document-tabs-store';
import { usePdfStore } from '../pdf-store';
import { useWorkspaceStore } from '../workspace-store';
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
    // The tab keeps the path it was created with; a switch refreshes it.
    expect(tabStore().tabs[0].path).toBe('/tmp/first.pdf');
  });

  it('keeps tabs with different source URLs apart', () => {
    tabStore().addTab(source('/tmp/a.pdf', 'https://example.com/a.pdf'));
    tabStore().addTab(source('/tmp/b.pdf', 'https://example.com/b.pdf'));

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

describe('documentTabName', () => {
  it('returns the last segment for POSIX and Windows paths', () => {
    expect(documentTabName('/docs/report.pdf')).toBe('report.pdf');
    expect(documentTabName('C:\\docs\\report.pdf')).toBe('report.pdf');
  });
});
