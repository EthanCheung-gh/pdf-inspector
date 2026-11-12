import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SECURITY_RENDERER_TIMEOUT_MS,
  SECURITY_TIMEOUT_MS,
} from '../../../shared/constants';
import type { SecurityReport } from '../../../shared/security-types';

const mockRestartSidecar = vi.fn();
const mockSecurityDocument = vi.fn();

// `ipc-client` reads the preload bridge lazily, so only the methods a test calls
// need to exist on the global window.
globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    securityDocument: mockSecurityDocument,
  },
} as unknown as Window & typeof globalThis;

const SECURITY_REPORT: SecurityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 1,
    version: '1.7',
    encrypted: true,
    xfa: false,
    hasMetadata: true,
    outputIntents: 1,
  },
  attachments: [],
  javascript: [],
  actions: [],
  signatures: [],
  encryption: {
    filter: 'Standard',
    version: 2,
    revision: 3,
    keyLength: 128,
    permissions: {
      raw: -3904,
      print: true,
      modify: false,
      copy: true,
      annotate: true,
      fillForms: true,
      accessibility: true,
      assemble: false,
      highQualityPrint: true,
    },
  },
  findings: [],
  summary: { total: 0, errors: 0, warnings: 0, info: 1 },
};

type IpcClient = typeof import('../ipc-client')['ipc'];

let ipc: IpcClient;

describe('ipc-client security wrapper', () => {
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

  it('resolves securityDocument without restarting the sidecar', async () => {
    mockSecurityDocument.mockResolvedValue(SECURITY_REPORT);

    await expect(ipc.securityDocument()).resolves.toBe(SECURITY_REPORT);
    expect(mockSecurityDocument).toHaveBeenCalledTimes(1);
    expect(mockRestartSidecar).not.toHaveBeenCalled();
  });

  it('keeps waiting past the 30s default budget', async () => {
    mockSecurityDocument.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const promise = ipc.securityDocument();
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
    mockSecurityDocument
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(SECURITY_REPORT);

    const promise = ipc.securityDocument();
    await vi.advanceTimersByTimeAsync(SECURITY_RENDERER_TIMEOUT_MS);
    await vi.runAllTicks();

    await expect(promise).resolves.toBe(SECURITY_REPORT);
    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
    expect(mockSecurityDocument).toHaveBeenCalledTimes(2);
  });

  it('surfaces the main-process security timeout without restarting', async () => {
    mockSecurityDocument.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Request "security_document" timed out after 120s')),
            SECURITY_TIMEOUT_MS,
          );
        }),
    );

    const promise = ipc.securityDocument();
    const rejection = expect(promise).rejects.toThrow(
      'Request "security_document" timed out after 120s',
    );

    // Main's 120s budget fires before the renderer's 125s backstop.
    await vi.advanceTimersByTimeAsync(SECURITY_TIMEOUT_MS);
    await rejection;

    expect(mockRestartSidecar).not.toHaveBeenCalled();
    expect(mockSecurityDocument).toHaveBeenCalledTimes(1);
  });
});

describe('security timeout budgets', () => {
  it('lets the main process lose the security race, never the renderer', () => {
    expect(SECURITY_RENDERER_TIMEOUT_MS).toBeGreaterThan(SECURITY_TIMEOUT_MS);
    expect(SECURITY_RENDERER_TIMEOUT_MS).toBe(125_000);
  });
});
