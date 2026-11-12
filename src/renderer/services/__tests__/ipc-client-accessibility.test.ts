import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESSIBILITY_RENDERER_TIMEOUT_MS,
  ACCESSIBILITY_TIMEOUT_MS,
} from '../../../shared/constants';
import type { AccessibilityReport } from '../../../shared/accessibility-types';

const mockRestartSidecar = vi.fn();
const mockAccessibilityDocument = vi.fn();

// `ipc-client` reads the preload bridge lazily, so only the methods a test calls
// need to exist on the global window.
globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    accessibilityDocument: mockAccessibilityDocument,
  },
} as unknown as Window & typeof globalThis;

const ACCESSIBILITY_REPORT: AccessibilityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 4,
    version: '1.7',
    encrypted: false,
    tagged: false,
    hasStructTreeRoot: false,
    hasParentTree: false,
    language: null,
    title: 'Untagged',
    roleMap: {},
    truncated: false,
    skipped: 0,
  },
  structure: [],
  findings: [
    {
      category: 'structure',
      severity: 'info',
      page: null,
      title: 'Document is not tagged',
      detail: 'No /StructTreeRoot or /MarkInfo /Marked true was found.',
      evidence: null,
      recommendation: 'Export the document from a tagged authoring workflow.',
    },
  ],
  summary: { total: 1, errors: 0, warnings: 0, info: 1 },
};

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client accessibility wrapper', () => {
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

  it('resolves accessibilityDocument without restarting the sidecar', async () => {
    mockAccessibilityDocument.mockResolvedValue(ACCESSIBILITY_REPORT);

    await expect(ipc.accessibilityDocument()).resolves.toBe(ACCESSIBILITY_REPORT);
    expect(mockAccessibilityDocument).toHaveBeenCalledTimes(1);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('keeps waiting past the 30s default budget', async () => {
    mockAccessibilityDocument.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.accessibilityDocument();
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

  it('restarts and retries once after the 125s renderer budget', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true, running: true });
    mockAccessibilityDocument
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(ACCESSIBILITY_REPORT);

    const promise = ipc.accessibilityDocument();
    await vi.advanceTimersByTimeAsync(ACCESSIBILITY_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toBe(ACCESSIBILITY_REPORT);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockAccessibilityDocument).toHaveBeenCalledTimes(2);
  });

  it('surfaces the main-process accessibility timeout without restarting', async () => {
    mockAccessibilityDocument.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Request "accessibility_document" timed out after 120s')),
            ACCESSIBILITY_TIMEOUT_MS,
          );
        }),
    );

    const promise = ipc.accessibilityDocument();
    const rejection = expect(promise).rejects.toThrow(
      'Request "accessibility_document" timed out after 120s',
    );

    // Main's 120s budget fires before the renderer's 125s backstop.
    await vi.advanceTimersByTimeAsync(ACCESSIBILITY_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockAccessibilityDocument).toHaveBeenCalledTimes(1);
  });

  it('propagates a sidecar parse error without restarting', async () => {
    mockAccessibilityDocument.mockRejectedValueOnce(new Error('No PDF open'));

    await expect(ipc.accessibilityDocument()).rejects.toThrow('No PDF open');
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });
});

describe('accessibility timeout budgets', () => {
  it('lets the main process lose the accessibility race, never the renderer', () => {
    expect(ACCESSIBILITY_TIMEOUT_MS).toBe(120_000);
    expect(ACCESSIBILITY_RENDERER_TIMEOUT_MS).toBeGreaterThan(ACCESSIBILITY_TIMEOUT_MS);
    expect(ACCESSIBILITY_RENDERER_TIMEOUT_MS).toBe(125_000);
  });
});
