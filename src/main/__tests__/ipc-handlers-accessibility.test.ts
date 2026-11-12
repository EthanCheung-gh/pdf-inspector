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

import { ACCESSIBILITY_TIMEOUT_MS, IPC_CHANNELS } from '../../shared/constants';
import type { AccessibilityReport } from '../../shared/accessibility-types';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  restartBackground: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const ACCESSIBILITY_REPORT: AccessibilityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 2,
    version: '1.7',
    encrypted: false,
    tagged: true,
    hasStructTreeRoot: true,
    hasParentTree: true,
    language: 'en-US',
    title: 'Tagged document',
    roleMap: { Chapter: 'Sect' },
    truncated: false,
    skipped: 0,
  },
  structure: [
    {
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
      truncated: false,
      children: [
        {
          id: '0/0',
          kind: 'mcid',
          role: 'MCID',
          rawRole: null,
          title: null,
          alt: null,
          actualText: null,
          lang: null,
          page: 1,
          mcid: 0,
          objectNumber: null,
          attributes: {},
          children: [],
          truncated: false,
        },
      ],
    },
  ],
  findings: [
    {
      category: 'structure',
      severity: 'warning',
      page: null,
      title: 'Structure tree has no ParentTree',
      detail: 'The document is tagged but the structure tree has no ParentTree.',
      evidence: 'hasStructTreeRoot=true hasParentTree=false',
      recommendation: 'Re-export the document with a complete structure tree.',
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
    send: vi.fn(async () => ACCESSIBILITY_REPORT),
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

describe('ACCESSIBILITY_DOCUMENT handler', () => {
  it('posts accessibility_document with no params and the accessibility budget', async () => {
    const result = await invoke(IPC_CHANNELS.ACCESSIBILITY_DOCUMENT, {});

    expect(result).toBe(ACCESSIBILITY_REPORT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    // No params: the parse always targets the document already open in the sidecar.
    expect(sidecar.send).toHaveBeenCalledWith(
      'accessibility_document',
      {},
      ACCESSIBILITY_TIMEOUT_MS,
    );
    expect(ACCESSIBILITY_TIMEOUT_MS).toBe(120_000);
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('No PDF open'));

    await expect(invoke(IPC_CHANNELS.ACCESSIBILITY_DOCUMENT, {})).rejects.toThrow('No PDF open');
  });

  it('never opens a document, so the current sidecar document is untouched', async () => {
    await invoke(IPC_CHANNELS.ACCESSIBILITY_DOCUMENT, {});

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).not.toHaveBeenCalledWith('open', expect.anything());
    expect(sidecar.restart).not.toHaveBeenCalled();
  });
});

describe('accessibility timeout budgets', () => {
  it('keeps the main-process budget dedicated instead of the 30s default', () => {
    expect(ACCESSIBILITY_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
