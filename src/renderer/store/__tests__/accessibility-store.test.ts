import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccessibilityDocumentInfo,
  AccessibilityReport,
  StructureNode,
} from '../../../shared/accessibility-types';

const accessibilityIpc = vi.hoisted(() => ({ accessibilityDocument: vi.fn() }));

// The store reaches the sidecar only through the `ipc` wrapper; mocking the
// module keeps these tests about caching/supersession, not transport.
vi.mock('../../services/ipc-client', () => ({ ipc: accessibilityIpc }));

import { useAccessibilityStore } from '../accessibility-store';

const TOOL = { name: 'pdf-inspector', version: '0.2.0' };

function makeNode(overrides: Partial<StructureNode> = {}): StructureNode {
  return {
    id: '0',
    kind: 'element',
    role: 'Document',
    rawRole: 'Document',
    title: null,
    alt: null,
    actualText: null,
    lang: null,
    page: null,
    mcid: null,
    objectNumber: null,
    attributes: {},
    children: [],
    truncated: false,
    ...overrides,
  };
}

function makeDocumentInfo(
  overrides: Partial<AccessibilityDocumentInfo> = {},
): AccessibilityDocumentInfo {
  return {
    pages: 2,
    version: '1.7',
    encrypted: false,
    tagged: true,
    hasStructTreeRoot: true,
    hasParentTree: true,
    language: 'en-US',
    title: 'Report',
    roleMap: {},
    truncated: false,
    skipped: 0,
    ...overrides,
  };
}

function makeReport(overrides: Partial<AccessibilityReport> = {}): AccessibilityReport {
  return {
    schemaVersion: 1,
    tool: TOOL,
    document: makeDocumentInfo(),
    structure: [makeNode()],
    findings: [],
    summary: { total: 0, errors: 0, warnings: 0, info: 0 },
    ...overrides,
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

const store = () => useAccessibilityStore.getState();

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

/** Drain the microtasks of an `open()`-started parse (the store never awaits it). */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (!store().loading) return;
    await Promise.resolve();
  }
  throw new Error('accessibility parse did not settle');
}

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  accessibilityIpc.accessibilityDocument.mockResolvedValue(makeReport());
});

describe('accessibility store caching', () => {
  it('parses the document once and reuses the report for the same file', async () => {
    const report = makeReport({ document: makeDocumentInfo({ pages: 7 }) });
    accessibilityIpc.accessibilityDocument.mockResolvedValue(report);

    store().open('/docs/report.pdf');
    expect(store().filePath).toBe('/docs/report.pdf');
    expect(store().loading).toBe(true);

    await settle();

    expect(store().report).toBe(report);
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(1);

    // Re-entering Structure on the same document is free.
    store().open('/docs/report.pdf');
    await flushMicrotasks();
    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(1);
    expect(store().report).toBe(report);
  });

  it('does not start a second parse while one is already in flight', async () => {
    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().open('/docs/report.pdf');

    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(1);

    pending.resolve(makeReport());
    await settle();

    expect(store().report).not.toBeNull();
  });

  it('clears the report when the file changes and parses the new one', async () => {
    accessibilityIpc.accessibilityDocument.mockResolvedValueOnce(
      makeReport({ document: makeDocumentInfo({ pages: 3 }) }),
    );

    store().open('/docs/old.pdf');
    await settle();
    expect(store().report).not.toBeNull();

    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/new.pdf');

    // The old document's tree is dropped before the new parse finishes.
    expect(store().filePath).toBe('/docs/new.pdf');
    expect(store().report).toBeNull();
    expect(store().loading).toBe(true);

    pending.resolve(makeReport({ document: makeDocumentInfo({ pages: 9 }) }));
    await settle();

    expect(store().report?.document.pages).toBe(9);
    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
  });

  it('drops everything when pointed at no document', async () => {
    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().open(null);

    pending.resolve(makeReport());
    await flushMicrotasks();

    expect(store()).toMatchObject({
      filePath: null,
      report: null,
      loading: false,
      error: null,
    });
  });
});

describe('accessibility store reloads', () => {
  it('parses the document again on an explicit refresh', async () => {
    store().open('/docs/report.pdf');
    await settle();
    expect(store().report).not.toBeNull();

    await store().load(true);

    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(store().report).not.toBeNull();
  });

  it('ignores the cache but not the file when refreshed', async () => {
    accessibilityIpc.accessibilityDocument
      .mockResolvedValueOnce(makeReport({ document: makeDocumentInfo({ pages: 5 }) }))
      .mockResolvedValueOnce(makeReport({ document: makeDocumentInfo({ pages: 8 }) }));

    store().open('/docs/report.pdf');
    await settle();

    await store().load(true);

    // A refresh replaces the cached report instead of accumulating files.
    expect(store().filePath).toBe('/docs/report.pdf');
    expect(store().report?.document.pages).toBe(8);
  });

  it('re-parses without requesting the sidecar when it was invalidated', async () => {
    store().open('/docs/report.pdf');
    await settle();

    store().invalidate();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
    expect(store().filePath).toBe('/docs/report.pdf');

    store().open('/docs/report.pdf');
    await settle();

    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(store().report).not.toBeNull();
  });

  it('ignores a parse that an invalidate superseded', async () => {
    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().invalidate();

    pending.resolve(makeReport());
    await flushMicrotasks();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
  });

  it('ignores a stale parse superseded by another file', async () => {
    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(makeReport({ document: makeDocumentInfo({ pages: 4 }) }));

    store().open('/docs/slow.pdf');
    store().open('/docs/fast.pdf');
    await settle();

    expect(store().report?.document.pages).toBe(4);

    // The first parse now answers; it must not overwrite the newer result.
    pending.resolve(makeReport({ document: makeDocumentInfo({ pages: 99 }) }));
    await flushMicrotasks();

    expect(store().filePath).toBe('/docs/fast.pdf');
    expect(store().report?.document.pages).toBe(4);
    expect(store().loading).toBe(false);
  });

  it('does not request anything without a document', async () => {
    await store().load();
    await store().load(true);

    expect(accessibilityIpc.accessibilityDocument).not.toHaveBeenCalled();
    expect(store().report).toBeNull();
  });
});

describe('accessibility store errors', () => {
  it('reports the failure and retries from the same document', async () => {
    accessibilityIpc.accessibilityDocument.mockRejectedValueOnce(new Error('Sidecar is not running'));

    store().open('/docs/report.pdf');
    await settle();

    expect(store().error).toBe('Sidecar is not running');
    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);

    // Re-entering Structure retries instead of keeping the failed state.
    store().open('/docs/report.pdf');
    await settle();

    expect(accessibilityIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();
  });

  it('turns a non-Error rejection into a readable message', async () => {
    accessibilityIpc.accessibilityDocument.mockRejectedValueOnce('document is unreadable');

    store().open('/docs/report.pdf');
    await settle();

    expect(store().error).toBe('document is unreadable');
  });

  it('clears the error when the next parse starts', async () => {
    accessibilityIpc.accessibilityDocument.mockRejectedValueOnce(new Error('timeout'));
    store().open('/docs/report.pdf');
    await settle();
    expect(store().error).toBe('timeout');

    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);
    const reload = store().load(true);

    expect(store().error).toBeNull();
    expect(store().loading).toBe(true);

    pending.resolve(makeReport());
    await reload;

    expect(store().report).not.toBeNull();
  });

  it('keeps the previous report when a refresh fails', async () => {
    store().open('/docs/report.pdf');
    await settle();
    const report = store().report;

    accessibilityIpc.accessibilityDocument.mockRejectedValueOnce(new Error('sidecar died'));
    await store().load(true);

    // A failed refresh is an error on top of a usable report, not an empty view.
    expect(store().error).toBe('sidecar died');
    expect(store().report).toBe(report);
    expect(store().loading).toBe(false);
  });
});

describe('accessibility store reset', () => {
  it('clears every field', async () => {
    store().open('/docs/report.pdf');
    await settle();
    expect(store().report).not.toBeNull();

    store().reset();

    expect(store()).toMatchObject({
      filePath: null,
      report: null,
      loading: false,
      error: null,
    });
  });

  it('ignores a parse that a reset superseded', async () => {
    const pending = deferred<AccessibilityReport>();
    accessibilityIpc.accessibilityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().reset();

    pending.resolve(makeReport());
    await flushMicrotasks();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
  });
});
