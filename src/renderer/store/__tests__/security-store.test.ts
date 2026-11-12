import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityReport } from '../../../shared/security-types';

const securityIpc = vi.hoisted(() => ({ securityDocument: vi.fn() }));

// The store reaches the sidecar only through the `ipc` wrapper; mocking the
// module keeps these tests about caching/supersession, not transport.
vi.mock('../../services/ipc-client', () => ({ ipc: securityIpc }));

import { useSecurityStore } from '../security-store';

function makeReport(overrides: Partial<SecurityReport> = {}): SecurityReport {
  return {
    schemaVersion: 1,
    tool: { name: 'pdf-inspector', version: '0.2.0' },
    document: {
      pages: 2,
      version: '1.7',
      encrypted: false,
      xfa: false,
      hasMetadata: true,
      outputIntents: 0,
    },
    attachments: [],
    javascript: [],
    actions: [],
    signatures: [],
    encryption: null,
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

const store = () => useSecurityStore.getState();

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

/** Drain the microtasks of an `open()`-started read (the store never awaits it). */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (!store().loading) return;
    await Promise.resolve();
  }
  throw new Error('security read did not settle');
}

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  securityIpc.securityDocument.mockResolvedValue(makeReport());
});

describe('security store caching', () => {
  it('reads the document once and reuses the report for the same file', async () => {
    const report = makeReport({ document: { ...makeReport().document, pages: 7 } });
    securityIpc.securityDocument.mockResolvedValue(report);

    store().open('/docs/report.pdf');
    expect(store().filePath).toBe('/docs/report.pdf');
    expect(store().loading).toBe(true);

    await settle();

    expect(store().report).toBe(report);
    expect(store().loading).toBe(false);
    expect(store().error).toBeNull();
    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(1);

    // Re-entering Resources on the same document is free.
    store().open('/docs/report.pdf');
    await flushMicrotasks();
    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(1);
    expect(store().report).toBe(report);
  });

  it('does not start a second read while one is already in flight', async () => {
    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().open('/docs/report.pdf');

    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(1);

    pending.resolve(makeReport());
    await settle();

    expect(store().report).not.toBeNull();
  });

  it('clears the report when the file changes and reads the new one', async () => {
    securityIpc.securityDocument.mockResolvedValueOnce(makeReport({ document: { ...makeReport().document, pages: 3 } }));

    store().open('/docs/old.pdf');
    await settle();
    const oldReport = store().report;
    expect(oldReport).not.toBeNull();

    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/new.pdf');

    // The old document's resources are dropped before the new read finishes.
    expect(store().filePath).toBe('/docs/new.pdf');
    expect(store().report).toBeNull();
    expect(store().loading).toBe(true);

    pending.resolve(makeReport({ document: { ...makeReport().document, pages: 9 } }));
    await settle();

    expect(store().report?.document.pages).toBe(9);
    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(2);
  });

  it('drops everything when pointed at no document', async () => {
    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);

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

describe('security store reloads', () => {
  it('re-reads the document on an explicit refresh', async () => {
    store().open('/docs/report.pdf');
    await settle();
    expect(store().report).not.toBeNull();

    await store().load(true);

    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(store().report).not.toBeNull();
  });

  it('re-reads without requesting the sidecar when it was invalidated', async () => {
    store().open('/docs/report.pdf');
    await settle();

    store().invalidate();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
    expect(store().filePath).toBe('/docs/report.pdf');

    store().open('/docs/report.pdf');
    await settle();

    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(store().report).not.toBeNull();
  });

  it('ignores a read that an invalidate superseded', async () => {
    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().invalidate();

    pending.resolve(makeReport());
    await flushMicrotasks();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
  });

  it('ignores a read superseded by another file', async () => {
    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(makeReport({ document: { ...makeReport().document, pages: 4 } }));

    store().open('/docs/slow.pdf');
    store().open('/docs/fast.pdf');
    await settle();

    expect(store().report?.document.pages).toBe(4);

    // The first read now answers; it must not overwrite the newer result.
    pending.resolve(makeReport({ document: { ...makeReport().document, pages: 99 } }));
    await flushMicrotasks();

    expect(store().filePath).toBe('/docs/fast.pdf');
    expect(store().report?.document.pages).toBe(4);
    expect(store().loading).toBe(false);
  });

  it('does not request anything without a document', async () => {
    await store().load();
    await store().load(true);

    expect(securityIpc.securityDocument).not.toHaveBeenCalled();
    expect(store().report).toBeNull();
  });
});

describe('security store errors', () => {
  it('reports the failure and retries from the same document', async () => {
    securityIpc.securityDocument.mockRejectedValueOnce(new Error('Sidecar is not running'));

    store().open('/docs/report.pdf');
    await settle();

    expect(store().error).toBe('Sidecar is not running');
    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);

    // Re-entering Resources retries instead of keeping the failed state.
    store().open('/docs/report.pdf');
    await settle();

    expect(securityIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();
  });

  it('turns a non-Error rejection into a readable message', async () => {
    securityIpc.securityDocument.mockRejectedValueOnce('document is unreadable');

    store().open('/docs/report.pdf');
    await settle();

    expect(store().error).toBe('document is unreadable');
  });

  it('clears the error when the next read starts', async () => {
    securityIpc.securityDocument.mockRejectedValueOnce(new Error('timeout'));
    store().open('/docs/report.pdf');
    await settle();
    expect(store().error).toBe('timeout');

    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);
    const reload = store().load(true);

    expect(store().error).toBeNull();
    expect(store().loading).toBe(true);

    pending.resolve(makeReport());
    await reload;

    expect(store().report).not.toBeNull();
  });
});

describe('security store reset', () => {
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

  it('ignores a read that a reset superseded', async () => {
    const pending = deferred<SecurityReport>();
    securityIpc.securityDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf');
    store().reset();

    pending.resolve(makeReport());
    await flushMicrotasks();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
  });
});
