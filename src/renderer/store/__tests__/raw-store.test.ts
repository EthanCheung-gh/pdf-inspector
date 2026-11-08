import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RawDocument,
  RawObject,
  RawPageContent,
  RawRef,
  RawRoot,
} from '../../types/raw-pdf';

const rawIpc = vi.hoisted(() => ({
  rawDocument: vi.fn(),
  rawObject: vi.fn(),
  rawPageContent: vi.fn(),
}));

// The store reaches the sidecar only through the `ipc` wrappers; mocking the
// module keeps these tests about guards/caching/selection, not transport.
vi.mock('../../services/ipc-client', () => ({ ipc: rawIpc }));

import { useRawStore } from '../raw-store';

const CATALOG_REF: RawRef = { objectNumber: 1, generation: 0 };
const INFO_REF: RawRef = { objectNumber: 2, generation: 0 };
const PAGES_REF: RawRef = { objectNumber: 3, generation: 0 };

function root(label: string, ref: RawRef | null): RawRoot {
  return { label, ref, value: null };
}

function makeDocument(overrides: Partial<RawDocument> = {}): RawDocument {
  return {
    pages: 3,
    version: '1.7',
    encrypted: false,
    roots: [root('Root', CATALOG_REF), root('Info', INFO_REF), root('Pages', PAGES_REF)],
    ...overrides,
  };
}

function makeObject(ref: RawRef, summary = 'dict (2 entries)'): RawObject {
  return { ref, value: { kind: 'dict', entries: [], truncated: false }, summary };
}

function makeContent(page: number, operatorCount = 2): RawPageContent {
  return {
    page,
    streams: [
      {
        ref: { objectNumber: 10 + page, generation: 0 },
        length: 128,
        filters: [],
        operators: Array.from({ length: operatorCount }, (_value, index) => ({
          index,
          offset: index * 8,
          operator: index === 0 ? 'BT' : 'Tj',
          operands: [],
        })),
        truncated: false,
        error: null,
      },
    ],
    truncated: false,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const store = () => useRawStore.getState();

/** Drain the microtasks of a request the store never awaits. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (!store().loading) return await flushMicrotasks();
    await Promise.resolve();
  }
  throw new Error('raw store request did not settle');
}

beforeEach(() => {
  vi.resetAllMocks();
  // `reset` also clears the module-level caches, so tests never share them.
  store().reset();

  rawIpc.rawDocument.mockResolvedValue(makeDocument());
  rawIpc.rawObject.mockImplementation(async (ref: RawRef) => makeObject(ref));
  rawIpc.rawPageContent.mockImplementation(async (page: number) => makeContent(page));
});

describe('raw store open', () => {
  it('loads the trailer roots and selects the first root with a reference', async () => {
    store().open('/docs/report.pdf', 'report.pdf');

    expect(store().active).toBe(true);
    expect(store().filePath).toBe('/docs/report.pdf');
    expect(store().fileName).toBe('report.pdf');
    expect(store().loading).toBe(true);

    await settle();

    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1);
    expect(store().document?.roots.map((entry) => entry.label)).toEqual([
      'Root',
      'Info',
      'Pages',
    ]);
    expect(store().selected).toEqual(CATALOG_REF);
    // The catalog object is loaded exactly once, for the selected root.
    expect(rawIpc.rawObject.mock.calls).toEqual([[CATALOG_REF]]);
    expect(store().object?.ref).toEqual(CATALOG_REF);
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
    expect(store().tab).toBe('object');
  });

  it('skips roots without a reference when choosing what to select', async () => {
    const inlineRoot: RawRoot = { label: 'ID', ref: null, value: { kind: 'string', value: 'abc', truncated: false } };
    rawIpc.rawDocument.mockResolvedValue(
      makeDocument({ roots: [inlineRoot, root('Root', CATALOG_REF)] }),
    );

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(store().selected).toEqual(CATALOG_REF);
    expect(rawIpc.rawObject.mock.calls).toEqual([[CATALOG_REF]]);
  });

  it('loads nothing when no root is a reference but still shows the document', async () => {
    rawIpc.rawDocument.mockResolvedValue(
      makeDocument({ roots: [{ label: 'ID', ref: null, value: null }] }),
    );

    store().open('/docs/odd.pdf', 'odd.pdf');
    await settle();

    expect(store().document).not.toBeNull();
    expect(store().selected).toBeNull();
    expect(store().object).toBeNull();
    expect(rawIpc.rawObject).not.toHaveBeenCalled();
    expect(store().loading).toBe(false);
  });

  it('does not reload the document when the same file is reopened', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    const document = store().document;
    expect(document).not.toBeNull();

    store().open('/docs/report.pdf', 'report.pdf');
    await flushMicrotasks();

    expect(store().active).toBe(true);
    expect(store().document).toBe(document);
    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1);
    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
  });

  it('does not start a second document request while one is in flight', async () => {
    const pending = deferred<RawDocument>();
    rawIpc.rawDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf', 'report.pdf');
    store().open('/docs/report.pdf', 'report.pdf');

    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1);

    pending.resolve(makeDocument());
    await settle();

    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1);
    expect(store().object).not.toBeNull();
  });
});

describe('raw store selection and cache', () => {
  beforeEach(async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    vi.clearAllMocks();
  });

  it('publishes the selection immediately and loads only that object', async () => {
    const pending = deferred<RawObject>();
    rawIpc.rawObject.mockImplementationOnce(() => pending.promise);

    store().select(INFO_REF);

    expect(store().selected).toEqual(INFO_REF);
    // The previous selection's object must not be shown under the new ref.
    expect(store().object).toBeNull();
    expect(store().loading).toBe(true);

    pending.resolve(makeObject(INFO_REF, 'dict (1 entry)'));
    await settle();

    expect(rawIpc.rawObject.mock.calls).toEqual([[INFO_REF]]);
    expect(store().object?.summary).toBe('dict (1 entry)');
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
  });

  it('caches objects by objectNumber:generation for the current file', async () => {
    store().select(INFO_REF);
    await settle();
    const infoObject = store().object;

    vi.clearAllMocks();

    // Re-selecting an already loaded ref must not hit the sidecar again, and
    // must resolve to the instance that was cached.
    store().select(INFO_REF);
    await flushMicrotasks();

    expect(rawIpc.rawObject).not.toHaveBeenCalled();
    expect(store().object).toBe(infoObject);
    expect(store().loading).toBe(false);

    // The generation is part of the key: same object number, other generation.
    store().select({ objectNumber: 2, generation: 1 });
    await settle();

    expect(rawIpc.rawObject.mock.calls).toEqual([[{ objectNumber: 2, generation: 1 }]]);
  });

  it('ignores a response for a selection the user already replaced', async () => {
    const slow = deferred<RawObject>();
    rawIpc.rawObject
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(makeObject(PAGES_REF, 'pages dict'));

    store().select(INFO_REF);
    store().select(PAGES_REF);
    await settle();

    expect(store().selected).toEqual(PAGES_REF);
    expect(store().object?.summary).toBe('pages dict');

    // The abandoned selection answers late: it must not replace the object the
    // user is looking at, nor leave the store stuck in a loading state.
    slow.resolve(makeObject(INFO_REF, 'late info'));
    await flushMicrotasks();

    expect(store().selected).toEqual(PAGES_REF);
    expect(store().object?.summary).toBe('pages dict');
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
  });

  it('ignores a response that arrives after close', async () => {
    const pending = deferred<RawObject>();
    rawIpc.rawObject.mockImplementationOnce(() => pending.promise);

    store().select(INFO_REF);
    store().close();

    expect(store().active).toBe(false);
    expect(store().loading).toBe(false);

    pending.resolve(makeObject(INFO_REF, 'late info'));
    await flushMicrotasks();

    expect(store().active).toBe(false);
    expect(store().object).toBeNull();
    expect(store().loading).toBe(false);
  });

  it('does nothing without an open document', async () => {
    store().reset();
    store().select(CATALOG_REF);
    store().loadContent(1);
    store().reloadContent(1);

    expect(rawIpc.rawObject).not.toHaveBeenCalled();
    expect(rawIpc.rawPageContent).not.toHaveBeenCalled();
  });
});

describe('raw store content', () => {
  beforeEach(async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    vi.clearAllMocks();
  });

  it('loads one page and records which page the content belongs to', async () => {
    store().loadContent(2);

    expect(store().contentPage).toBe(2);
    expect(store().content).toBeNull();
    expect(store().loading).toBe(true);

    await settle();

    expect(rawIpc.rawPageContent.mock.calls).toEqual([[2]]);
    expect(store().content?.page).toBe(2);
    expect(store().contentPage).toBe(2);
    expect(store().loading).toBe(false);
  });

  it('caches content by page for the current file', async () => {
    store().loadContent(2);
    await settle();

    const content = store().content;
    vi.clearAllMocks();

    store().loadContent(2);
    await flushMicrotasks();

    expect(rawIpc.rawPageContent).not.toHaveBeenCalled();
    expect(store().content).toBe(content);

    store().loadContent(3);
    await settle();
    expect(rawIpc.rawPageContent.mock.calls).toEqual([[3]]);

    // Back to the cached page: still no second request.
    store().loadContent(2);
    await flushMicrotasks();
    expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(1);
    expect(store().content).toBe(content);
    expect(store().contentPage).toBe(2);
  });

  it('reloads one page past its cache without touching the other cached pages', async () => {
    store().loadContent(2);
    await settle();
    store().loadContent(3);
    await settle();
    const pageThree = store().content;
    vi.clearAllMocks();

    // An ordinary navigation is still answered from the cache.
    store().loadContent(2);
    await flushMicrotasks();
    expect(rawIpc.rawPageContent).not.toHaveBeenCalled();

    store().reloadContent(2);
    await settle();

    expect(rawIpc.rawPageContent.mock.calls).toEqual([[2]]);
    expect(store().content?.page).toBe(2);
    expect(store().contentPage).toBe(2);

    // Only page 2 was dropped: page 3 still needs no request.
    store().loadContent(3);
    await flushMicrotasks();
    expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(1);
    expect(store().content).toBe(pageThree);
  });

  it('drops the cached page when a reload fails', async () => {
    store().loadContent(2);
    await settle();
    const stale = store().content;

    rawIpc.rawPageContent.mockRejectedValueOnce(new Error('sidecar timed out'));
    store().reloadContent(2);
    await settle();

    expect(store().error).toContain('sidecar timed out');
    expect(store().content).toBeNull();

    // The stale page must not come back on the next ordinary load.
    rawIpc.rawPageContent.mockImplementation(async (page: number) => makeContent(page));
    store().loadContent(2);
    await settle();

    expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(3);
    expect(store().content).not.toBe(stale);
    expect(store().content?.page).toBe(2);
    expect(store().error).toBeNull();
  });

  it('never shows the previous page operators while another page loads', async () => {
    store().loadContent(1);
    await settle();
    expect(store().content?.page).toBe(1);

    const pending = deferred<RawPageContent>();
    rawIpc.rawPageContent.mockImplementationOnce(() => pending.promise);
    store().loadContent(2);

    expect(store().contentPage).toBe(2);
    expect(store().content).toBeNull();

    pending.resolve(makeContent(2));
    await settle();

    expect(store().content?.page).toBe(2);
  });

  it('ignores a response for a page the user already left', async () => {
    const slow = deferred<RawPageContent>();
    rawIpc.rawPageContent
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(makeContent(2));

    store().loadContent(1);
    store().loadContent(2);
    await settle();

    expect(store().contentPage).toBe(2);
    expect(store().content?.page).toBe(2);

    slow.resolve(makeContent(1));
    await flushMicrotasks();

    expect(store().contentPage).toBe(2);
    expect(store().content?.page).toBe(2);
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
  });

  it('switches the detail tab', () => {
    store().setTab('content');
    expect(store().tab).toBe('content');
    store().setTab('object');
    expect(store().tab).toBe('object');
  });
});

describe('raw store file lifecycle', () => {
  it('resets the whole view and the caches when the file changes', async () => {
    store().open('/docs/old.pdf', 'old.pdf');
    await settle();
    store().select(INFO_REF);
    await settle();
    store().loadContent(1);
    await settle();
    store().setTab('content');

    rawIpc.rawDocument.mockResolvedValue(
      makeDocument({ pages: 1, roots: [root('Root', { objectNumber: 9, generation: 0 })] }),
    );

    store().open('/docs/new.pdf', 'new.pdf');

    expect(store().filePath).toBe('/docs/new.pdf');
    expect(store().fileName).toBe('new.pdf');
    expect(store().document).toBeNull();
    expect(store().selected).toBeNull();
    expect(store().object).toBeNull();
    expect(store().content).toBeNull();
    expect(store().contentPage).toBeNull();
    expect(store().tab).toBe('object');
    expect(store().error).toBeNull();
    expect(store().loading).toBe(true);

    await settle();

    expect(store().selected).toEqual({ objectNumber: 9, generation: 0 });
    expect(store().document?.pages).toBe(1);

    // The old file's caches are gone: selecting its ref must ask again.
    vi.clearAllMocks();
    store().select(INFO_REF);
    await settle();
    expect(rawIpc.rawObject.mock.calls).toEqual([[INFO_REF]]);
  });

  it('drops a late document response for the previous file', async () => {
    const slow = deferred<RawDocument>();
    rawIpc.rawDocument
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(makeDocument({ pages: 7 }));

    store().open('/docs/slow.pdf', 'slow.pdf');
    store().open('/docs/fast.pdf', 'fast.pdf');
    await settle();

    expect(store().document?.pages).toBe(7);
    expect(store().filePath).toBe('/docs/fast.pdf');

    slow.resolve(makeDocument({ pages: 99 }));
    await flushMicrotasks();

    expect(store().filePath).toBe('/docs/fast.pdf');
    expect(store().document?.pages).toBe(7);
    expect(store().error).toBeNull();
  });

  it('keeps the document and caches across close and reopen of the same file', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    store().select(INFO_REF);
    await settle();

    const document = store().document;
    const object = store().object;

    store().close();
    expect(store().active).toBe(false);
    expect(store().document).toBe(document);
    expect(store().object).toBe(object);

    vi.clearAllMocks();
    store().open('/docs/report.pdf', 'report.pdf');
    await flushMicrotasks();

    expect(store().active).toBe(true);
    expect(store().document).toBe(document);
    expect(rawIpc.rawDocument).not.toHaveBeenCalled();

    // The cached object of the same file is still available without a request.
    store().select(INFO_REF);
    await flushMicrotasks();
    expect(rawIpc.rawObject).not.toHaveBeenCalled();
    expect(store().object).toBe(object);
  });

  it('reset clears every field and the caches', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    store().loadContent(1);
    await settle();

    store().reset();

    expect(store()).toMatchObject({
      active: false,
      filePath: null,
      fileName: null,
      document: null,
      selected: null,
      object: null,
      content: null,
      contentPage: null,
      tab: 'object',
      loading: false,
      error: null,
    });

    // Nothing survived: the same file is read again from the sidecar.
    vi.clearAllMocks();
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1);
  });
});

describe('raw store errors', () => {
  it('reports a document failure and stays active', async () => {
    rawIpc.rawDocument.mockRejectedValue(
      new Error('Request "raw_document" timed out after 120s'),
    );

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(store().error).toBe('Request "raw_document" timed out after 120s');
    expect(store().document).toBeNull();
    expect(store().active).toBe(true);
    expect(store().loading).toBe(false);
    expect(rawIpc.rawObject).not.toHaveBeenCalled();
  });

  it('retries the document load when the same file is reopened after a failure', async () => {
    rawIpc.rawDocument.mockRejectedValueOnce(new Error('No PDF open'));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    expect(store().error).toBe('No PDF open');

    store().close();
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(rawIpc.rawDocument).toHaveBeenCalledTimes(2);
    expect(store().error).toBeNull();
    expect(store().document).not.toBeNull();
  });

  it('reports an invalid object without clearing the selection', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    rawIpc.rawObject.mockRejectedValueOnce(new Error('Invalid object number: 9999'));

    store().select({ objectNumber: 9999, generation: 0 });
    await settle();

    expect(store().error).toBe('Invalid object number: 9999');
    expect(store().selected).toEqual({ objectNumber: 9999, generation: 0 });
    expect(store().object).toBeNull();
    expect(store().loading).toBe(false);

    // A failed object is not cached: selecting it again retries.
    vi.clearAllMocks();
    rawIpc.rawObject.mockResolvedValueOnce(makeObject({ objectNumber: 9999, generation: 0 }));
    store().select({ objectNumber: 9999, generation: 0 });
    await settle();
    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
    expect(store().error).toBeNull();
  });

  it('reports an invalid page and keeps the requested page visible', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    rawIpc.rawPageContent.mockRejectedValueOnce(new Error('Invalid page: 9 (1..3)'));

    store().loadContent(9);
    await settle();

    expect(store().error).toBe('Invalid page: 9 (1..3)');
    expect(store().contentPage).toBe(9);
    expect(store().content).toBeNull();
    expect(store().loading).toBe(false);
  });

  it('does not let a stale failure overwrite a newer success', async () => {
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    const slow = deferred<RawObject>();
    rawIpc.rawObject
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(makeObject(PAGES_REF, 'pages dict'));

    store().select(INFO_REF);
    store().select(PAGES_REF);
    await settle();

    slow.reject(new Error('Request "raw_object" timed out after 120s'));
    await flushMicrotasks();

    expect(store().error).toBeNull();
    expect(store().object?.summary).toBe('pages dict');
    expect(store().loading).toBe(false);
  });
});
