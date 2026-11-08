import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAW_RENDERER_TIMEOUT_MS, RAW_TIMEOUT_MS } from '../../../shared/constants';
import type {
  RawDocument,
  RawObject,
  RawPageContent,
  RawRef,
} from '../../types/raw-pdf';

const mockRestartSidecar = vi.fn();
const mockRawDocument = vi.fn();
const mockRawObject = vi.fn();
const mockRawPageContent = vi.fn();

// `ipc-client` reads the preload bridge lazily, so only the methods a test calls
// need to exist on the global window.
globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    rawDocument: mockRawDocument,
    rawObject: mockRawObject,
    rawPageContent: mockRawPageContent,
  },
} as unknown as Window & typeof globalThis;

const CATALOG_REF: RawRef = { objectNumber: 1, generation: 0 };

const DOCUMENT: RawDocument = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  roots: [{ label: 'Root', ref: CATALOG_REF, value: null }],
};

const OBJECT: RawObject = {
  ref: CATALOG_REF,
  value: { kind: 'dict', entries: [], truncated: false },
  summary: 'dict (0 entries)',
};

const CONTENT: RawPageContent = { page: 1, streams: [], truncated: false };

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client raw wrappers', () => {
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

  it('resolves rawDocument without restarting the sidecar', async () => {
    mockRawDocument.mockResolvedValue(DOCUMENT);

    await expect(ipc.rawDocument()).resolves.toBe(DOCUMENT);
    expect(mockRawDocument).toHaveBeenCalledTimes(1);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('forwards the raw object ref verbatim', async () => {
    mockRawObject.mockResolvedValue(OBJECT);

    await expect(ipc.rawObject({ objectNumber: 15, generation: 2 })).resolves.toBe(OBJECT);
    expect(mockRawObject.mock.calls).toEqual([[{ objectNumber: 15, generation: 2 }]]);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('forwards the content page verbatim', async () => {
    mockRawPageContent.mockResolvedValue(CONTENT);

    await expect(ipc.rawPageContent(3)).resolves.toBe(CONTENT);
    expect(mockRawPageContent.mock.calls).toEqual([[3]]);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('keeps waiting past the 30s default budget', async () => {
    mockRawDocument.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.rawDocument();
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

  it('restarts and retries the same ref after the renderer budget', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockRawObject
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(OBJECT);

    const promise = ipc.rawObject(CATALOG_REF);
    await vi.advanceTimersByTimeAsync(RAW_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toBe(OBJECT);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    // The retry must ask for the same object, not for a widened request.
    expect(mockRawObject.mock.calls).toEqual([[CATALOG_REF], [CATALOG_REF]]);
  });

  it('surfaces the main-process raw timeout without restarting', async () => {
    mockRawPageContent.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Request "raw_page_content" timed out after 120s')),
            RAW_TIMEOUT_MS,
          );
        }),
    );

    const promise = ipc.rawPageContent(1);
    const rejection = expect(promise).rejects.toThrow(
      'Request "raw_page_content" timed out after 120s',
    );

    // Main's 120s budget fires before the renderer's 125s backstop.
    await vi.advanceTimersByTimeAsync(RAW_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockRawPageContent).toHaveBeenCalledTimes(1);
  });

  it('never restarts the sidecar for an invalid reference or page', async () => {
    // Range validation belongs to the sidecar: its RawError is a plain error and
    // a bad click must not cost the user a restart.
    mockRawObject.mockRejectedValue(new Error('Invalid object number: 9999'));
    mockRawPageContent.mockRejectedValue(new Error('Invalid page: 9 (1..2)'));

    await expect(ipc.rawObject({ objectNumber: 9999, generation: 0 })).rejects.toThrow(
      'Invalid object number: 9999',
    );
    await expect(ipc.rawPageContent(9)).rejects.toThrow('Invalid page: 9 (1..2)');

    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });
});

describe('raw timeout budgets', () => {
  it('lets the main process lose the raw race, never the renderer', () => {
    expect(RAW_TIMEOUT_MS).toBe(120_000);
    expect(RAW_RENDERER_TIMEOUT_MS).toBe(125_000);
    expect(RAW_RENDERER_TIMEOUT_MS).toBeGreaterThan(RAW_TIMEOUT_MS);
  });
});
