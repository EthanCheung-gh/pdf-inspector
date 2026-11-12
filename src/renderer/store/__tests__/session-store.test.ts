import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECENT_DOCUMENTS,
  MAX_SESSION_TABS,
  MAX_SESSION_STRING_LENGTH,
  RECENT_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  configureSessionStorage,
  createMemorySessionStorage,
  reloadSessionState,
  useSessionStore,
} from '../session-store';
import type { SessionStorage } from '../session-store';
import type { DocumentTab, DocumentViewSnapshot } from '../document-tabs-store';
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

const viewSnapshot = (overrides: Partial<DocumentViewSnapshot> = {}): DocumentViewSnapshot => ({
  currentPage: 1,
  zoom: 1,
  overlayVisibility: { char: true, word: false },
  leftTab: 'objects',
  inspectorTab: 'inspect',
  searchQuery: '',
  ...overrides,
});

let tabSequence = 0;

function makeTab(overrides: Partial<DocumentTab> = {}): DocumentTab {
  tabSequence += 1;
  return {
    id: `tab-${tabSequence}`,
    path: '/docs/report.pdf',
    sourceUrl: null,
    documentId: null,
    name: 'report.pdf',
    metadata,
    snapshot: viewSnapshot(),
    ...overrides,
  };
}

const store = () => useSessionStore.getState();

const readSessionJson = (storage: SessionStorage): unknown =>
  JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? 'null');

const readRecentJson = (storage: SessionStorage): unknown =>
  JSON.parse(storage.getItem(RECENT_STORAGE_KEY) ?? 'null');

let storage: SessionStorage;

beforeEach(() => {
  storage = createMemorySessionStorage();
  configureSessionStorage(storage);
  store().reset();
});

afterEach(() => {
  store().reset();
  configureSessionStorage(null);
  vi.useRealTimers();
});

describe('defaults', () => {
  it('starts empty, with automatic restore enabled', () => {
    expect(store()).toMatchObject({
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession: true,
      recent: [],
    });
  });

  it('reset returns to defaults and forgets persisted data', () => {
    const tab = makeTab();
    store().recordOpen(tab);
    store().saveTabs([tab], tab.id);

    store().reset();

    expect(store()).toMatchObject({
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession: true,
      recent: [],
    });
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });
});

describe('recordOpen', () => {
  it('adds a local document to the recent list and the recent key only', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));

    const [entry] = store().recent;
    expect(entry).toMatchObject({
      kind: 'local',
      name: 'a.pdf',
      path: '/docs/a.pdf',
      sourceUrl: null,
      documentId: null,
    });
    expect(entry.openedAt).toBeGreaterThan(0);
    // The id is an opaque hash, never the raw path.
    expect(entry.id).not.toContain('a.pdf');
    expect(entry.id).not.toContain('/docs');

    expect(readRecentJson(storage)).toEqual([entry]);
    // Recording an open does not write a session.
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('derives local/url/web/upload kinds from the tab locators', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));
    store().recordOpen(
      makeTab({
        path: '/tmp/a.pdf',
        sourceUrl: 'https://example.com/a.pdf',
        name: 'https://example.com/a.pdf',
      }),
    );
    store().recordOpen(makeTab({ path: '/doc/one/up.pdf', documentId: 'one', name: 'up.pdf' }));
    store().recordOpen(
      makeTab({
        path: '/doc/two/w.pdf',
        documentId: 'two',
        sourceUrl: 'https://example.com/w.pdf',
        name: 'https://example.com/w.pdf',
      }),
    );

    // Newest first: web, upload, url, local.
    expect(store().recent.map((entry) => entry.kind)).toEqual(['web', 'upload', 'url', 'local']);

    const byKind = new Map(store().recent.map((entry) => [entry.kind, entry]));
    // A URL document keeps its URL, not the temp download copy.
    expect(byKind.get('url')).toMatchObject({
      path: 'https://example.com/a.pdf',
      sourceUrl: 'https://example.com/a.pdf',
    });
    // Web/upload entries never keep a server-side display path.
    expect(byKind.get('web')).toMatchObject({
      path: null,
      sourceUrl: 'https://example.com/w.pdf',
      documentId: 'two',
    });
    expect(byKind.get('upload')).toMatchObject({
      path: null,
      sourceUrl: null,
      documentId: 'one',
      name: 'up.pdf',
    });
  });

  it('reopening the same local file moves it to the top without duplicating', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));
    const id = store().recent[0].id;
    store().recordOpen(makeTab({ path: '/docs/b.pdf', name: 'b.pdf' }));

    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a-renamed.pdf' }));

    expect(store().recent).toHaveLength(2);
    expect(store().recent[0].id).toBe(id);
    expect(store().recent[0].name).toBe('a-renamed.pdf');
    expect(store().recent.map((entry) => entry.path)).toEqual(['/docs/a.pdf', '/docs/b.pdf']);
  });

  it('dedupes a URL document by source URL across new download copies', () => {
    const url = 'https://example.com/report.pdf';
    store().recordOpen(makeTab({ path: '/tmp/first.pdf', sourceUrl: url, name: url }));
    const id = store().recent[0].id;

    store().recordOpen(makeTab({ path: '/tmp/second.pdf', sourceUrl: url, name: url }));

    expect(store().recent).toHaveLength(1);
    expect(store().recent[0].id).toBe(id);
    expect(store().recent[0].path).toBe(url);
  });

  it('dedupes a web document by source URL even when the server re-issues its id', () => {
    const url = 'https://example.com/report.pdf';
    store().recordOpen(
      makeTab({ path: '/doc/one/report.pdf', documentId: 'one', sourceUrl: url, name: url }),
    );
    const id = store().recent[0].id;

    store().recordOpen(
      makeTab({ path: '/doc/two/report.pdf', documentId: 'two', sourceUrl: url, name: url }),
    );

    expect(store().recent).toHaveLength(1);
    expect(store().recent[0].id).toBe(id);
    // The entry follows the registry id the newest open reported.
    expect(store().recent[0].documentId).toBe('two');
  });

  it('keeps uploads with different document ids apart', () => {
    store().recordOpen(makeTab({ path: '/doc/one/a.pdf', documentId: 'one', name: 'a.pdf' }));
    store().recordOpen(makeTab({ path: '/doc/two/b.pdf', documentId: 'two', name: 'b.pdf' }));

    expect(store().recent).toHaveLength(2);
    expect(new Set(store().recent.map((entry) => entry.id)).size).toBe(2);
  });

  it('keeps the same locator apart across kinds', () => {
    // The kind is part of the identity, so a local path that looks like a URL
    // does not collide with the URL document of the same string.
    store().recordOpen(makeTab({ path: 'https://example.com/a.pdf', name: 'a.pdf' }));
    store().recordOpen(
      makeTab({
        path: '/tmp/a.pdf',
        sourceUrl: 'https://example.com/a.pdf',
        name: 'https://example.com/a.pdf',
      }),
    );

    expect(store().recent).toHaveLength(2);
    expect(store().recent.map((entry) => entry.kind)).toEqual(['url', 'local']);
  });

  it('caps the list at 20 entries keeping the newest', () => {
    for (let index = 0; index < MAX_RECENT_DOCUMENTS + 5; index += 1) {
      store().recordOpen(makeTab({ path: `/docs/${index}.pdf`, name: `${index}.pdf` }));
    }

    expect(store().recent).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(store().recent[0].path).toBe('/docs/24.pdf');
    expect(store().recent.some((entry) => entry.path === '/docs/0.pdf')).toBe(false);
    expect(readRecentJson(storage)).toEqual(store().recent);
  });
});

describe('recordClose', () => {
  it('keeps the recent entry and never adds one', () => {
    const tab = makeTab({ path: '/docs/a.pdf', name: 'a.pdf' });
    store().recordOpen(tab);
    const recent = store().recent;

    store().recordClose(tab);
    store().recordClose(makeTab({ path: '/docs/never-opened.pdf' }));

    expect(store().recent).toEqual(recent);
    expect(store().recent).toHaveLength(1);
    expect(store().recent.some((entry) => entry.path === '/docs/never-opened.pdf')).toBe(false);
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('saveTabs', () => {
  it('maps tabs to session records, saves the active index and the timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    const local = makeTab({ path: '/docs/a.pdf', name: 'a.pdf' });
    const url = makeTab({
      path: '/tmp/a.pdf',
      sourceUrl: 'https://example.com/a.pdf',
      name: 'https://example.com/a.pdf',
    });
    store().saveTabs([local, url], url.id);

    const [localRecord, urlRecord] = store().tabs;
    expect(localRecord).toMatchObject({
      kind: 'local',
      path: '/docs/a.pdf',
      sourceUrl: null,
      documentId: null,
      name: 'a.pdf',
    });
    expect(urlRecord).toMatchObject({
      kind: 'url',
      path: 'https://example.com/a.pdf',
      sourceUrl: 'https://example.com/a.pdf',
      documentId: null,
    });
    expect(localRecord.snapshot).toEqual(local.snapshot);
    expect(urlRecord.lastActiveAt).toBe(1_700_000_000_000);
    expect(store().activeIndex).toBe(1);
    expect(store().savedAt).toBe(1_700_000_000_000);
    expect(readSessionJson(storage)).toEqual({
      tabs: store().tabs,
      activeIndex: 1,
      savedAt: 1_700_000_000_000,
      restoreLastSession: true,
    });
    // The session record never carries the recent list.
    expect(readSessionJson(storage)).not.toHaveProperty('recent');
  });

  it('records the web display path and the registry id', () => {
    const web = makeTab({
      path: '/doc/one/a.pdf',
      documentId: 'one',
      sourceUrl: 'https://example.com/a.pdf',
      name: 'a.pdf',
    });
    const upload = makeTab({ path: '/doc/two/b.pdf', documentId: 'two', name: 'b.pdf' });

    store().saveTabs([web, upload], web.id);

    expect(store().tabs[0]).toMatchObject({
      kind: 'web',
      path: '/doc/one/a.pdf',
      sourceUrl: 'https://example.com/a.pdf',
      documentId: 'one',
    });
    expect(store().tabs[1]).toMatchObject({
      kind: 'upload',
      path: '/doc/two/b.pdf',
      sourceUrl: null,
      documentId: 'two',
    });
  });

  it('keeps the last activation time of tabs that are not re-activated', () => {
    vi.useFakeTimers();
    const first = makeTab({ path: '/docs/a.pdf' });
    const second = makeTab({ path: '/docs/b.pdf' });

    vi.setSystemTime(1_000);
    store().saveTabs([first, second], first.id);
    const firstActiveAt = store().tabs[0].lastActiveAt;

    vi.setSystemTime(2_000);
    store().saveTabs([first, second], second.id);

    expect(store().tabs[0].lastActiveAt).toBe(firstActiveAt);
    expect(store().tabs[1].lastActiveAt).toBe(2_000);
  });

  it('caps the session at 20 tabs and clamps the active index', () => {
    const tabs = Array.from({ length: MAX_SESSION_TABS + 3 }, (_, index) =>
      makeTab({ path: `/docs/${index}.pdf`, name: `${index}.pdf` }),
    );

    store().saveTabs(tabs, tabs[tabs.length - 1].id);

    expect(store().tabs).toHaveLength(MAX_SESSION_TABS);
    expect(store().tabs[0].path).toBe('/docs/0.pdf');
    // The active tab was dropped by the cap: the index lands on the last kept one.
    expect(store().activeIndex).toBe(MAX_SESSION_TABS - 1);
  });

  it('falls back to the first tab when the active id is unknown', () => {
    const tabs = [makeTab({ path: '/docs/a.pdf' }), makeTab({ path: '/docs/b.pdf' })];

    store().saveTabs(tabs, 'missing');

    expect(store().activeIndex).toBe(0);
  });

  it('writes an empty session when every tab is closed', () => {
    const tab = makeTab();
    store().saveTabs([tab], tab.id);

    store().saveTabs([], null);

    expect(store().tabs).toEqual([]);
    expect(store().activeIndex).toBe(0);
    expect(store().savedAt).not.toBeNull();
    expect(readSessionJson(storage)).toMatchObject({
      tabs: [],
      activeIndex: 0,
      savedAt: store().savedAt,
    });

    // A reload must not resurrect the closed tabs.
    reloadSessionState();
    expect(store().tabs).toEqual([]);
    expect(store().activeIndex).toBe(0);
  });

  it('persists view state only, never document metadata or analysis results', () => {
    const tab = makeTab({
      path: '/docs/a.pdf',
      metadata: { ...metadata, title: 'CONFIDENTIAL-TITLE', pages: 1234 },
    });

    store().saveTabs([tab], tab.id);

    const raw = storage.getItem(SESSION_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('CONFIDENTIAL-TITLE');
    expect(raw).not.toContain('"fonts"');
    expect(raw).not.toContain('metadata');
    expect(raw).not.toContain('"pages"');

    const record = (readSessionJson(storage) as { tabs: Record<string, unknown>[] }).tabs[0];
    expect(Object.keys(record).sort()).toEqual([
      'documentId',
      'kind',
      'lastActiveAt',
      'name',
      'path',
      'snapshot',
      'sourceUrl',
    ]);
  });

  it('restores the saved snapshot after a reload', () => {
    const snapshot = viewSnapshot({
      currentPage: 7,
      zoom: 1.5,
      overlayVisibility: { char: false, word: true },
      leftTab: 'fonts',
      inspectorTab: 'page',
      searchQuery: 'needle',
    });
    const tab = makeTab({ snapshot });

    store().saveTabs([tab], tab.id);
    reloadSessionState();

    expect(store().tabs[0].snapshot).toEqual(snapshot);
  });
});

describe('clearSession', () => {
  it('clears the saved tabs but keeps the toggle and the recent list', () => {
    const tab = makeTab();
    store().recordOpen(tab);
    store().saveTabs([tab], tab.id);
    store().setRestoreLastSession(false);

    store().clearSession();

    expect(store()).toMatchObject({
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession: false,
    });
    expect(store().recent).toHaveLength(1);

    reloadSessionState();
    expect(store().tabs).toEqual([]);
    expect(store().restoreLastSession).toBe(false);
    expect(store().recent).toHaveLength(1);
  });
});

describe('setRestoreLastSession', () => {
  it('defaults to true and persists the toggle with the current session', () => {
    expect(store().restoreLastSession).toBe(true);
    const tab = makeTab();
    store().saveTabs([tab], tab.id);

    store().setRestoreLastSession(false);

    expect(store().restoreLastSession).toBe(false);
    expect(readSessionJson(storage)).toMatchObject({
      restoreLastSession: false,
      tabs: store().tabs,
    });

    reloadSessionState();
    expect(store().restoreLastSession).toBe(false);
    // Turning automatic restore off does not discard the saved tabs.
    expect(store().tabs).toHaveLength(1);
  });

  it('keeps the recent list when automatic restore is off', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));
    store().setRestoreLastSession(false);

    reloadSessionState();

    expect(store().restoreLastSession).toBe(false);
    expect(store().recent).toHaveLength(1);
  });
});

describe('removeRecent / clearRecent', () => {
  it('removes one entry by id and persists the rest', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));
    store().recordOpen(makeTab({ path: '/docs/b.pdf', name: 'b.pdf' }));
    const removed = store().recent[0];

    store().removeRecent(removed.id);

    expect(store().recent).toHaveLength(1);
    expect(store().recent[0].path).toBe('/docs/a.pdf');
    expect(readRecentJson(storage)).toEqual(store().recent);

    reloadSessionState();
    expect(store().recent).toHaveLength(1);
    expect(store().recent[0].id).not.toBe(removed.id);
  });

  it('ignores an unknown id', () => {
    store().recordOpen(makeTab({ path: '/docs/a.pdf', name: 'a.pdf' }));

    store().removeRecent('local-unknown');

    expect(store().recent).toHaveLength(1);
  });

  it('clears every entry but keeps the saved session', () => {
    const tab = makeTab();
    store().recordOpen(tab);
    store().saveTabs([tab], tab.id);

    store().clearRecent();

    expect(store().recent).toEqual([]);
    expect(store().tabs).toHaveLength(1);
    expect(readRecentJson(storage)).toEqual([]);

    reloadSessionState();
    expect(store().recent).toEqual([]);
    expect(store().tabs).toHaveLength(1);
  });
});

describe('corrupted persistence', () => {
  it('falls back to defaults for malformed JSON without throwing', () => {
    storage.setItem(SESSION_STORAGE_KEY, '{not json');
    storage.setItem(RECENT_STORAGE_KEY, '[]]');

    expect(() => reloadSessionState()).not.toThrow();

    expect(store()).toMatchObject({
      tabs: [],
      activeIndex: 0,
      savedAt: null,
      restoreLastSession: true,
      recent: [],
    });
  });

  it('drops records that cannot be restored and sanitizes the rest', () => {
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          {
            kind: 'local',
            path: '/docs/a.pdf',
            name: 'a.pdf',
            sourceUrl: null,
            documentId: null,
            lastActiveAt: 'nope',
            snapshot: { currentPage: 2, zoom: 1, leftTab: 'objects', inspectorTab: 'inspect' },
          },
          // No kind: cannot be classified or restored.
          { path: '/docs/b.pdf', name: 'b.pdf' },
          // A local tab without a path has no locator: dropped.
          { kind: 'local', name: 'c.pdf' },
        ],
        activeIndex: 99,
        savedAt: 'yesterday',
        restoreLastSession: 'yes',
      }),
    );

    reloadSessionState();

    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0]).toMatchObject({ path: '/docs/a.pdf', lastActiveAt: 0 });
    expect(store().activeIndex).toBe(0);
    expect(store().savedAt).toBeNull();
    expect(store().restoreLastSession).toBe(true);
  });

  it('sanitizes snapshot fields and truncates long strings', () => {
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          {
            kind: 'local',
            path: '/docs/a.pdf',
            name: 'x'.repeat(MAX_SESSION_STRING_LENGTH + 10),
            lastActiveAt: 1,
            snapshot: {
              currentPage: -4,
              zoom: 99,
              overlayVisibility: { char: true, word: 'yes', rect: false },
              leftTab: 'not-a-tab',
              inspectorTab: 'not-a-tab',
              searchQuery: 42,
            },
          },
        ],
        activeIndex: 0,
        savedAt: 1,
        restoreLastSession: true,
      }),
    );

    reloadSessionState();

    const [record] = store().tabs;
    expect(record.name).toHaveLength(MAX_SESSION_STRING_LENGTH);
    expect(record.snapshot).toEqual({
      currentPage: 1,
      zoom: 5,
      overlayVisibility: { char: true, rect: false },
      leftTab: 'objects',
      inspectorTab: 'inspect',
      searchQuery: '',
    });
  });

  it('re-derives recent ids and collapses hand-edited duplicates', () => {
    storage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([
        {
          id: '/docs/a.pdf',
          kind: 'local',
          name: 'a.pdf',
          path: '/docs/a.pdf',
          sourceUrl: null,
          documentId: null,
          openedAt: 10,
        },
        {
          id: 'forged',
          kind: 'local',
          name: 'a.pdf',
          path: '/docs/a.pdf',
          sourceUrl: null,
          documentId: null,
          openedAt: 20,
        },
        { kind: 'local', name: 'no-locator' },
      ]),
    );

    reloadSessionState();

    expect(store().recent).toHaveLength(1);
    expect(store().recent[0].openedAt).toBe(20);
    expect(store().recent[0].id).not.toBe('forged');
    expect(store().recent[0].id).not.toBe('/docs/a.pdf');
  });

  it('sorts persisted recent entries newest first and caps them', () => {
    const entries = Array.from({ length: MAX_RECENT_DOCUMENTS + 2 }, (_, index) => ({
      kind: 'local',
      name: `${index}.pdf`,
      path: `/docs/${index}.pdf`,
      sourceUrl: null,
      documentId: null,
      openedAt: 1000 + index,
    }));
    storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));

    reloadSessionState();

    expect(store().recent).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(store().recent[0].path).toBe(`/docs/${MAX_RECENT_DOCUMENTS + 1}.pdf`);
  });
});

describe('storage failures', () => {
  it('works in memory when the backend rejects reads and writes', () => {
    const failing: SessionStorage = {
      getItem: () => {
        throw new Error('access denied');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('access denied');
      },
    };
    configureSessionStorage(failing);

    expect(() => reloadSessionState()).not.toThrow();

    const tab = makeTab({ path: '/docs/a.pdf', name: 'a.pdf' });
    expect(() => store().saveTabs([tab], tab.id)).not.toThrow();
    expect(() => store().recordOpen(tab)).not.toThrow();
    expect(store().tabs).toHaveLength(1);
    expect(store().recent).toHaveLength(1);

    // The in-memory mirror keeps the session readable for the rest of the page.
    expect(() => reloadSessionState()).not.toThrow();
    expect(store().tabs).toHaveLength(1);
    expect(store().recent).toHaveLength(1);
  });

  it('falls back to memory once a write fails after a successful read', () => {
    let writesFail = false;
    const flaky: SessionStorage = {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        if (writesFail) throw new Error('quota exceeded');
        storage.setItem(key, value);
      },
      removeItem: (key) => storage.removeItem(key),
    };
    configureSessionStorage(flaky);

    const tab = makeTab({ path: '/docs/a.pdf', name: 'a.pdf' });
    store().saveTabs([tab], tab.id);
    writesFail = true;

    expect(() => store().saveTabs([tab, makeTab({ path: '/docs/b.pdf' })], null)).not.toThrow();
    expect(store().tabs).toHaveLength(2);
    // Nothing reached the backend, but the page keeps its session in memory.
    expect(
      (readSessionJson(storage) as { tabs: unknown[] }).tabs,
    ).toHaveLength(1);

    reloadSessionState();
    expect(store().tabs).toHaveLength(2);
  });

  it('keeps the store usable when stale data cannot be removed', () => {
    const readOnly: SessionStorage = {
      getItem: (key) => storage.getItem(key),
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('quota exceeded');
      },
    };
    configureSessionStorage(readOnly);

    expect(() => store().reset()).not.toThrow();
    expect(store().tabs).toEqual([]);
    expect(store().recent).toEqual([]);
  });
});
