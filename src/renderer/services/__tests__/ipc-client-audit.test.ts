import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_RENDERER_TIMEOUT_MS,
  AUDIT_TIMEOUT_MS,
} from '../../../shared/constants';
import type {
  AuditDocumentResult,
  AuditPagesResult,
} from '../../../shared/audit-types';

const mockRestartSidecar = vi.fn();
const mockAuditDocument = vi.fn();
const mockAuditPages = vi.fn();

// `ipc-client` reads the preload bridge lazily, so only the methods a test calls
// need to exist on the global window.
globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    auditDocument: mockAuditDocument,
    auditPages: mockAuditPages,
  },
} as unknown as Window & typeof globalThis;

const DOCUMENT_RESULT: AuditDocumentResult = {
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 3,
    version: '1.7',
    encrypted: false,
    title: 'Report',
    author: null,
    producer: null,
    language: 'en',
    tagged: true,
  },
  findings: [],
};

const PAGES_RESULT: AuditPagesResult = {
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  findings: [],
};

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client audit wrappers', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    // A fresh module instance per test: the restart budget is module state.
    vi.resetModules();
    ({ ipc } = await import('../ipc-client'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves auditDocument without restarting the sidecar', async () => {
    mockAuditDocument.mockResolvedValue(DOCUMENT_RESULT);

    await expect(ipc.auditDocument()).resolves.toBe(DOCUMENT_RESULT);
    expect(mockAuditDocument).toHaveBeenCalledTimes(1);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('forwards the auditPages range verbatim', async () => {
    mockAuditPages.mockResolvedValue(PAGES_RESULT);

    await expect(ipc.auditPages(2, 11)).resolves.toBe(PAGES_RESULT);
    expect(mockAuditPages).toHaveBeenCalledWith(2, 11);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('keeps waiting past the 30s default budget', async () => {
    mockAuditDocument.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.auditDocument();
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(settled).toBe(false);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('restarts and retries a page batch with the same range after the renderer budget', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockAuditPages
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(PAGES_RESULT);

    const promise = ipc.auditPages(2, 5);
    await vi.advanceTimersByTimeAsync(AUDIT_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toBe(PAGES_RESULT);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    // The retry must not silently widen the batch back to the whole document.
    expect(mockAuditPages.mock.calls).toEqual([
      [2, 5],
      [2, 5],
    ]);
  });

  it('surfaces the main-process audit timeout without restarting', async () => {
    mockAuditDocument.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Request "audit_document" timed out after 120s')),
            AUDIT_TIMEOUT_MS,
          );
        }),
    );

    const promise = ipc.auditDocument();
    const rejection = expect(promise).rejects.toThrow(
      'Request "audit_document" timed out after 120s',
    );

    // Main's 120s budget fires before the renderer's 125s backstop.
    await vi.advanceTimersByTimeAsync(AUDIT_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockAuditDocument).toHaveBeenCalledTimes(1);
  });
});

describe('audit timeout budgets', () => {
  it('lets the main process lose the audit race, never the renderer', () => {
    expect(AUDIT_RENDERER_TIMEOUT_MS).toBeGreaterThan(AUDIT_TIMEOUT_MS);
  });
});
