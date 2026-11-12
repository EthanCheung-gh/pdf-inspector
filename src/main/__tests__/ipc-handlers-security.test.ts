import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// The Electron binary download is optional in this environment, so the module
// is replaced by an IPC registry we can invoke directly.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: () => ({ id: 1 }),
    fromWebContents: () => ({ id: 1 }),
  },
  app: {
    getPath: (name: string) => `/tmp/${name}`,
  },
}));

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import { IPC_CHANNELS, SECURITY_TIMEOUT_MS } from '../../shared/constants';
import type { SecurityReport } from '../../shared/security-types';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  restartBackground: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const SECURITY_REPORT: SecurityReport = {
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
  javascript: [
    {
      name: null,
      location: 'OpenAction',
      page: null,
      source: 'app.alert("hi")',
      truncated: false,
    },
  ],
  actions: [
    {
      location: 'OpenAction',
      page: null,
      subtype: 'JavaScript',
      target: null,
      risky: true,
    },
  ],
  signatures: [],
  encryption: null,
  findings: [
    {
      category: 'security',
      severity: 'warning',
      page: null,
      title: 'Document contains JavaScript',
      detail: 'JavaScript sources are shown as bounded previews.',
      evidence: 'entries=1',
      recommendation: 'Review the JavaScript before distributing this document.',
    },
  ],
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
};

let sidecar: SidecarStub;

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(...args);
}

async function registerFresh(): Promise<void> {
  vi.resetModules();
  harness.handlers.clear();

  sidecar = {
    send: vi.fn(async () => SECURITY_REPORT),
    restart: vi.fn(async () => undefined),
    restartBackground: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn(),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
}

beforeEach(async () => {
  await registerFresh();
});

describe('SECURITY_DOCUMENT handler', () => {
  it('posts security_document with no params and the security budget', async () => {
    const result = await invoke(IPC_CHANNELS.SECURITY_DOCUMENT, {});

    expect(result).toBe(SECURITY_REPORT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    // No params: the scan always targets the document already open in the sidecar.
    expect(sidecar.send).toHaveBeenCalledWith('security_document', {}, SECURITY_TIMEOUT_MS);
    expect(SECURITY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('No PDF open'));

    await expect(invoke(IPC_CHANNELS.SECURITY_DOCUMENT, {})).rejects.toThrow('No PDF open');
  });

  it('never opens a document, so the current sidecar document is untouched', async () => {
    await invoke(IPC_CHANNELS.SECURITY_DOCUMENT, {});

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).not.toHaveBeenCalledWith('open', expect.anything());
  });
});
