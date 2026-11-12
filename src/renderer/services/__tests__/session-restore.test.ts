// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfDocumentNotFoundError } from '../../../shared/document-errors';
import type { IpcApi, OpenPdfResult } from '../../types/ipc-protocol';
import type { PdfMetadata } from '../../types/pdf-objects';

const { openPdfPath, openPdfUrl, activatePdfDocument } = vi.hoisted(() => ({
  openPdfPath: vi.fn(),
  openPdfUrl: vi.fn(),
  activatePdfDocument: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfPath, openPdfUrl, activatePdfDocument },
}));

import {
  buildRestorePlan,
  hasSessionRestoreRun,
  resetSessionRestoreGuard,
  restoreAction,
  restoreSession,
} from '../session-restore';
import { useDocumentTabsStore } from '../../store/document-tabs-store';
import { usePdfStore } from '../../store/pdf-store';
import {
  MAX_SESSION_TABS,
  SESSION_STORAGE_KEY,
  configureSessionStorage,
  createMemorySessionStorage,
  useSessionStore,
} from '../../store/session-store';
import type {
  SessionStorage,
  SessionTabKind,
  SessionTabRecord,
} from '../../store/session-store';
import { useSessionRestoreStore } from '../../store/session-restore-store';
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

const snapshot = (overrides: Partial<SessionTabRecord['snapshot']> = {}) => ({
  currentPage: 1,
  zoom: 1,
  overlayVisibility: {},
  leftTab: 'objects' as const,
  inspectorTab: 'inspect' as const,
  searchQuery: '',
  ...overrides,
});

function record(overrides: Partial<SessionTabRecord> = {}): SessionTabRecord {
  return {
    kind: 'local',
    path: '/docs/a.pdf',
    sourceUrl: null,
    documentId: null,
    name: 'a.pdf',
    snapshot: snapshot(),
    lastActiveAt: 1,
    ...overrides,
  };
}

const localRecord = (path: string, overrides: Partial<SessionTabRecord> = {}) =>
  record({ path, name: path.split('/').pop() ?? path, ...overrides });

const urlRecord = (url: string, overrides: Partial<SessionTabRecord> = {}) =>
  record({
    kind: 'url',
    path: '/tmp/downloaded.pdf',
    sourceUrl: url,
    name: url,
    ...overrides,
  });

const webRecord = (id: string, name: string, url: string | null = null) =>
  record({
    kind: 'web',
    path: `/doc/${id}/${name}`,
    sourceUrl: url,
    documentId: id,
    name,
  });

const uploadRecord = (id: string, name: string) =>
  record({ kind: 'upload', path: `/doc/${id}/${name}`, documentId: id, name });

const kindRecord = (kind: SessionTabKind, overrides: Partial<SessionTabRecord> = {}) =>
  record({ kind, ...overrides });

function seedSession(tabs: SessionTabRecord[], activeIndex = 0): void {
  useSessionStore.setState({
    tabs,
    activeIndex,
    savedAt: Date.now(),
    restoreLastSession: true,
  });
}

const tabStore = () => useDocumentTabsStore.getState();
const pdfStore = () => usePdfStore.getState();
const progress = () => useSessionRestoreStore.getState();
const session = () => useSessionStore.getState();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Page navigation that mutates the store like the real hook does. */
const navigate = vi.fn(async (page: number) => {
  usePdfStore.getState().setPage(page);
});

let storage: SessionStorage;

beforeEach(() => {
  storage = createMemorySessionStorage();
  configureSessionStorage(storage);
  useSessionStore.getState().reset();
  useDocumentTabsStore.getState().reset();
  usePdfStore.getState().resetDocument();
  useSessionRestoreStore.getState().reset();
  useWorkspaceStore.setState({ leftTab: 'objects', inspectorTab: 'inspect' });
  resetSessionRestoreGuard();

  openPdfPath.mockReset();
  openPdfUrl.mockReset();
  activatePdfDocument.mockReset();
  navigate.mockClear();

  (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector = {
    openPdfPath,
    openPdfUrl,
    activatePdfDocument,
  };
});

afterEach(() => {
  delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;
  useSessionStore.getState().reset();
  useSessionRestoreStore.getState().reset();
  configureSessionStorage(null);
  vi.restoreAllMocks();
});

describe('restoreAction', () => {
  it('maps each kind to the bridge call that can re-open it', () => {
    expect(restoreAction(localRecord('/docs/a.pdf'))).toBe('path');
    expect(restoreAction(urlRecord('https://example.com/a.pdf'))).toBe('url');
    expect(restoreAction(webRecord('doc-a', 'a.pdf', 'https://example.com/a.pdf'))).toBe('activate');
    expect(restoreAction(uploadRecord('doc-a', 'a.pdf'))).toBe('activate');
  });

  it('falls back to the URL for a web record without a registry id', () => {
    expect(
      restoreAction(kindRecord('web', { path: null, sourceUrl: 'https://example.com/a.pdf' })),
    ).toBe('url');
  });

  it('refuses records whose kind has no usable locator', () => {
    expect(restoreAction(kindRecord('local', { path: null }))).toBeNull();
    expect(restoreAction(kindRecord('url', { path: null, sourceUrl: null }))).toBeNull();
    expect(restoreAction(kindRecord('web', { path: null, sourceUrl: null }))).toBeNull();
    expect(restoreAction(kindRecord('upload', { path: null, sourceUrl: null }))).toBeNull();
  });

  it('uses an url record’s path when its source URL is missing', () => {
    expect(
      restoreAction(kindRecord('url', { path: 'https://example.com/a.pdf', sourceUrl: null })),
    ).toBe('url');
  });
});

describe('buildRestorePlan', () => {
  it('keeps tab order and picks the opener per record', () => {
    const plan = buildRestorePlan({
      tabs: [
        localRecord('/docs/a.pdf'),
        urlRecord('https://example.com/b.pdf'),
        webRecord('doc-c', 'c.pdf', 'https://example.com/c.pdf'),
        uploadRecord('doc-d', 'd.pdf'),
      ],
      activeIndex: 2,
    });

    expect(plan.entries.map((entry) => entry.action)).toEqual(['path', 'url', 'activate', 'activate']);
    expect(plan.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(plan.skipped).toEqual([]);
    expect(plan.activeEntryIndex).toBe(2);
  });

  it('drops records without a locator and remembers them as skipped', () => {
    const brokenLocal = kindRecord('local', { path: null });
    const brokenUpload = kindRecord('upload', { path: null, documentId: null });
    const plan = buildRestorePlan({
      tabs: [brokenLocal, localRecord('/docs/b.pdf'), brokenUpload],
      activeIndex: 0,
    });

    expect(plan.entries.map((entry) => entry.index)).toEqual([1]);
    expect(plan.skipped).toEqual([brokenLocal, brokenUpload]);
    // The saved active tab was one of the dropped ones: no tab to re-activate.
    expect(plan.activeEntryIndex).toBe(-1);
  });

  it('re-points the saved active index at the surviving entry', () => {
    const plan = buildRestorePlan({
      tabs: [kindRecord('local', { path: null }), localRecord('/docs/b.pdf')],
      activeIndex: 1,
    });

    expect(plan.entries).toHaveLength(1);
    expect(plan.activeEntryIndex).toBe(0);
  });

  it('caps the plan at the session tab limit', () => {
    const tabs = Array.from({ length: MAX_SESSION_TABS + 5 }, (_, index) =>
      localRecord(`/docs/${index}.pdf`),
    );

    const plan = buildRestorePlan({ tabs, activeIndex: 0 });

    expect(MAX_SESSION_TABS).toBe(20);
    expect(plan.entries).toHaveLength(MAX_SESSION_TABS);
    expect(plan.entries[MAX_SESSION_TABS - 1].record.path).toBe(`/docs/${MAX_SESSION_TABS - 1}.pdf`);
  });
});

describe('restoreSession preconditions', () => {
  it('restores nothing when a document is already open', async () => {
    seedSession([localRecord('/docs/a.pdf')]);
    pdfStore().setFile('/docs/current.pdf', metadata);

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(tabStore().tabs).toEqual([]);
    expect(pdfStore().filePath).toBe('/docs/current.pdf');
  });

  it('restores nothing when automatic restore is turned off', async () => {
    seedSession([localRecord('/docs/a.pdf')]);
    useSessionStore.getState().setRestoreLastSession(false);

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    // The recent list (and the saved session) is kept; only the restore is skipped.
    expect(session().tabs).toHaveLength(1);
  });

  it('restores nothing when the build cannot switch documents', async () => {
    seedSession([localRecord('/docs/a.pdf')]);
    delete (window as unknown as { pdfInspector?: Partial<IpcApi> }).pdfInspector;

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
  });

  it('restores nothing for an empty session', async () => {
    seedSession([], 0);

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(progress().restoring).toBe(false);
  });

  it('refuses a session longer than the limit instead of opening it unbounded', async () => {
    seedSession(
      Array.from({ length: MAX_SESSION_TABS + 1 }, (_, index) => localRecord(`/docs/${index}.pdf`)),
    );

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
  });
});

describe('restoreSession', () => {
  it('restores local tabs in order and ends on the tab that was active', async () => {
    const first = localRecord('/docs/a.pdf', {
      snapshot: snapshot({ currentPage: 3, zoom: 1.5, leftTab: 'fonts', searchQuery: 'needle' }),
    });
    seedSession([first, localRecord('/docs/b.pdf')], 0);
    openPdfPath.mockImplementation(async (path: string) => opened(path));

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(true);
    // a, b, then a again because the saved active tab was the first one.
    expect(openPdfPath.mock.calls.map(([path]) => path)).toEqual([
      '/docs/a.pdf',
      '/docs/b.pdf',
      '/docs/a.pdf',
    ]);

    const tabs = tabStore().tabs;
    expect(tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(tabStore().activeTabId).toBe(tabs[0].id);
    expect(pdfStore().filePath).toBe('/docs/a.pdf');
    // The view snapshot (page/zoom/panel/search) is restored onto the tab.
    expect(tabs[0].snapshot).toMatchObject({
      currentPage: 3,
      zoom: 1.5,
      leftTab: 'fonts',
      searchQuery: 'needle',
    });
    expect(navigate).toHaveBeenCalledWith(3);
    // The snapshot zoom must survive PdfViewport's once-per-document fit pass.
    expect(usePdfStore.getState().skipInitialFit).toBe(true);
    expect(progress()).toMatchObject({ restoring: false, done: 2, total: 2, failed: [] });
  });

  it('leaves the last opened tab active when it is the saved one', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 1);
    openPdfPath.mockImplementation(async (path: string) => opened(path));

    await restoreSession({ navigate });

    expect(openPdfPath.mock.calls.map(([path]) => path)).toEqual(['/docs/a.pdf', '/docs/b.pdf']);
    expect(tabStore().activeTabId).toBe(tabStore().tabs[1].id);
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
  });

  it('re-downloads URL tabs from their source URL', async () => {
    const url = 'https://example.com/a.pdf';
    seedSession([urlRecord(url)]);
    openPdfUrl.mockResolvedValue(opened('/tmp/fresh.pdf', otherMetadata, url));

    await restoreSession({ navigate });

    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(openPdfPath).not.toHaveBeenCalled();
    const [tab] = tabStore().tabs;
    expect(tab.path).toBe('/tmp/fresh.pdf');
    expect(tab.sourceUrl).toBe(url);
    // The tab is refreshed from the result, not left at its saved locators.
    expect(tab.metadata).toBe(otherMetadata);
    expect(pdfStore().sourceUrl).toBe(url);
    expect(pdfStore().pageCount).toBe(otherMetadata.pages);
  });

  it('clamps a restored page into the re-opened document', async () => {
    seedSession([localRecord('/docs/a.pdf', { snapshot: snapshot({ currentPage: 99 }) })]);
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    await restoreSession({ navigate });

    expect(navigate).toHaveBeenCalledWith(metadata.pages);
    expect(pdfStore().currentPage).toBe(metadata.pages);
  });

  it('activates web tabs by document id and heals a stale id from its URL', async () => {
    const url = 'https://example.com/a.pdf';
    seedSession([webRecord('gone', 'a.pdf', url), webRecord('doc-b', 'b.pdf')], 1);
    activatePdfDocument.mockRejectedValueOnce(new PdfDocumentNotFoundError('Document not found'));
    openPdfUrl.mockResolvedValue(opened('/doc/doc-new/a.pdf', metadata, url, 'doc-new'));
    activatePdfDocument.mockResolvedValueOnce(opened('/doc/doc-b/b.pdf', metadata, undefined, 'doc-b'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await restoreSession({ navigate });
    consoleWarn.mockRestore();

    expect(activatePdfDocument.mock.calls.map(([id]) => id)).toEqual(['gone', 'doc-b']);
    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(openPdfPath).not.toHaveBeenCalled();
    const healed = tabStore().tabs.find((tab) => tab.name === 'a.pdf');
    expect(healed?.documentId).toBe('doc-new');
    expect(healed?.path).toBe('/doc/doc-new/a.pdf');
    expect(progress().failed).toEqual([]);
  });

  it('skips an upload whose id the server forgot and keeps restoring', async () => {
    seedSession([uploadRecord('gone', 'upload.pdf'), localRecord('/docs/b.pdf')], 1);
    activatePdfDocument.mockRejectedValue(new PdfDocumentNotFoundError('Document not found'));
    openPdfPath.mockResolvedValue(opened('/docs/b.pdf'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(restored).toBe(true);
    // An upload has no content or URL to re-create: no download is attempted.
    expect(openPdfUrl).not.toHaveBeenCalled();
    expect(openPdfPath).toHaveBeenCalledWith('/docs/b.pdf');
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']);
    expect(progress().failed).toEqual([{ name: 'upload.pdf', kind: 'upload' }]);
    expect(progress().done).toBe(2);
  });

  it('continues after a document fails and records it by name and kind', async () => {
    seedSession([localRecord('/docs/missing.pdf'), localRecord('/docs/b.pdf')], 1);
    openPdfPath
      .mockRejectedValueOnce(new Error('ENOENT: no such file'))
      .mockResolvedValueOnce(opened('/docs/b.pdf'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(restored).toBe(true);
    expect(progress().failed).toEqual([{ name: 'missing.pdf', kind: 'local' }]);
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']);
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
    expect(progress().restoring).toBe(false);
  });

  it('skips a canceled open instead of keeping an empty tab', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 1);
    openPdfPath
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce(opened('/docs/b.pdf'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['b.pdf']);
    expect(progress().failed).toEqual([{ name: 'a.pdf', kind: 'local' }]);
  });

  it('ends on the last successfully restored tab when the saved one failed', async () => {
    seedSession([localRecord('/docs/missing.pdf'), localRecord('/docs/b.pdf')], 0);
    openPdfPath
      .mockRejectedValueOnce(new Error('ENOENT: no such file'))
      .mockResolvedValueOnce(opened('/docs/b.pdf'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await restoreSession({ navigate });
    consoleError.mockRestore();

    // No dead tab to re-activate, so only the two planned opens happened.
    expect(openPdfPath).toHaveBeenCalledTimes(2);
    expect(tabStore().activeTabId).toBe(tabStore().tabs[0].id);
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
  });

  it('saves an empty session when every saved document is gone', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 0);
    openPdfPath.mockRejectedValue(new Error('ENOENT: no such file'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(restored).toBe(false);
    expect(progress().failed).toEqual([
      { name: 'a.pdf', kind: 'local' },
      { name: 'b.pdf', kind: 'local' },
    ]);
    // Dead tabs are evicted now instead of being retried on every start.
    expect(session().tabs).toEqual([]);
    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? 'null').tabs).toEqual([]);
  });

  it('keeps restoring after a failure that happened once the document was open', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 1);
    openPdfPath.mockResolvedValueOnce(opened('/docs/a.pdf'));
    openPdfPath.mockResolvedValueOnce(opened('/docs/b.pdf'));
    // The page extraction behind `navigate` failed for the first document only.
    navigate.mockRejectedValueOnce(new Error('Failed to load page data'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    // The already-open document must not look like a user takeover.
    expect(openPdfPath).toHaveBeenCalledTimes(2);
    expect(restored).toBe(true);
    expect(progress().failed).toEqual([{ name: 'a.pdf', kind: 'local' }]);
    expect(pdfStore().filePath).toBe('/docs/b.pdf');
  });

  it('does not report a restored tab as failed when only its final activation fails', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 0);
    openPdfPath
      .mockResolvedValueOnce(opened('/docs/a.pdf'))
      .mockResolvedValueOnce(opened('/docs/b.pdf'))
      .mockRejectedValueOnce(new Error('Document vanished'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(restored).toBe(true);
    // Both tabs are open; only bringing the first one back to the front failed,
    // so the document must not be counted as a failed restore.
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(progress().failed).toEqual([]);
    expect(progress().done).toBe(2);
  });

  it('saves the restored tabs so unusable entries are evicted', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/missing.pdf')], 0);
    openPdfPath
      .mockResolvedValueOnce(opened('/docs/a.pdf'))
      .mockRejectedValueOnce(new Error('ENOENT: no such file'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await restoreSession({ navigate });
    consoleError.mockRestore();

    expect(session().tabs.map((entry) => entry.name)).toEqual(['a.pdf']);
    const persisted = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? 'null');
    expect(persisted.tabs.map((entry: { name: string }) => entry.name)).toEqual(['a.pdf']);
    expect(persisted.activeIndex).toBe(0);
  });

  it('clears a session whose locators are all unusable', async () => {
    seedSession([kindRecord('local', { path: null }), kindRecord('upload', { documentId: null })]);

    const restored = await restoreSession({ navigate });

    expect(restored).toBe(false);
    expect(openPdfPath).not.toHaveBeenCalled();
    expect(session().tabs).toEqual([]);
    // Nothing was attempted, so no progress run was published.
    expect(progress()).toMatchObject({ restoring: false, total: 0, done: 0 });
  });

  it('publishes progress while restoring and settles it at the end', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 1);
    const firstOpen = deferred<OpenPdfResult>();
    openPdfPath
      .mockReturnValueOnce(firstOpen.promise)
      .mockResolvedValueOnce(opened('/docs/b.pdf'));

    const running = restoreSession({ navigate });

    expect(progress()).toMatchObject({ restoring: true, done: 0, total: 2, failed: [] });

    firstOpen.resolve(opened('/docs/a.pdf'));
    await running;

    expect(progress()).toMatchObject({ restoring: false, done: 2, total: 2, failed: [] });
  });

  it('runs at most once per page load', async () => {
    seedSession([localRecord('/docs/a.pdf')]);
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));

    // StrictMode-style double invocation: the second call starts before the
    // first has settled.
    const first = restoreSession({ navigate });
    const second = restoreSession({ navigate });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);
    expect(openPdfPath).toHaveBeenCalledTimes(1);
    expect(hasSessionRestoreRun()).toBe(true);
  });

  it('stops without overwriting a document the user opens mid-restore', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 0);
    const firstOpen = deferred<OpenPdfResult>();
    openPdfPath.mockReturnValue(firstOpen.promise);

    const running = restoreSession({ navigate });

    // While the first document is still opening, the user opens another one.
    pdfStore().setFile('/docs/user.pdf', metadata);
    tabStore().addTab({ path: '/docs/user.pdf', metadata, name: 'user.pdf' });

    firstOpen.resolve(opened('/docs/a.pdf'));
    const restored = await running;

    expect(restored).toBe(false);
    // The second planned document is never attempted...
    expect(openPdfPath).toHaveBeenCalledTimes(1);
    // ...and the user's document is untouched, with its own tab.
    expect(pdfStore().filePath).toBe('/docs/user.pdf');
    expect(tabStore().tabs.map((tab) => tab.name)).toEqual(['user.pdf']);
    expect(tabStore().activeTabId).toBe(tabStore().tabs[0].id);
    // The saved session is left alone: the user's tab bar will save it.
    expect(session().tabs.map((entry) => entry.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(progress().restoring).toBe(false);
  });

  it('honours an external cancellation request', async () => {
    seedSession([localRecord('/docs/a.pdf'), localRecord('/docs/b.pdf')], 1);
    openPdfPath.mockResolvedValue(opened('/docs/a.pdf'));
    let cancelled = false;
    openPdfPath.mockImplementationOnce(async (path: string) => {
      cancelled = true;
      return opened(path);
    });

    const restored = await restoreSession({ navigate, isCancelled: () => cancelled });

    expect(restored).toBe(false);
    expect(openPdfPath).toHaveBeenCalledTimes(1);
    expect(tabStore().tabs).toEqual([]);
    expect(progress().restoring).toBe(false);
  });

  it('restores nothing after a fatal error, reporting it instead of throwing', async () => {
    seedSession([localRecord('/docs/a.pdf')]);
    openPdfPath.mockRejectedValue(new Error('bridge exploded'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restored = await restoreSession({ navigate });
    consoleError.mockRestore();

    // A per-document failure is a skip, not a fatal error.
    expect(restored).toBe(false);
    expect(progress()).toMatchObject({ restoring: false, error: null });
    expect(progress().failed).toEqual([{ name: 'a.pdf', kind: 'local' }]);
  });
});
