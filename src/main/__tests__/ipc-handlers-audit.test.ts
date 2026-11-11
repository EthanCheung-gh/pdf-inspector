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

import { AUDIT_TIMEOUT_MS, IPC_CHANNELS } from '../../shared/constants';
import type {
  AuditDocumentResult,
  AuditPagesResult,
} from '../../shared/audit-types';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const TOOL = { name: 'pdf-inspector', version: '0.2.0' };

const DOCUMENT_RESULT: AuditDocumentResult = {
  tool: TOOL,
  document: {
    pages: 2,
    version: '1.7',
    encrypted: false,
    title: 'Report',
    author: null,
    producer: null,
    language: 'en-US',
    tagged: true,
  },
  findings: [
    {
      category: 'metadata',
      severity: 'info',
      page: null,
      title: 'Missing language',
      detail: 'The catalog has no /Lang entry.',
      evidence: null,
      recommendation: 'Set the document language.',
    },
  ],
};

const PAGES_RESULT: AuditPagesResult = {
  tool: TOOL,
  findings: [
    {
      category: 'pages',
      severity: 'info',
      page: 1,
      title: 'Page 1 has no content',
      detail: 'The page is empty.',
      evidence: null,
      recommendation: null,
    },
  ],
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
    send: vi.fn(async () => DOCUMENT_RESULT),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn(),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
}

beforeEach(async () => {
  await registerFresh();
});

describe('AUDIT_DOCUMENT handler', () => {
  it('posts audit_document with no params and the audit budget', async () => {
    const result = await invoke(IPC_CHANNELS.AUDIT_DOCUMENT, {});

    expect(result).toBe(DOCUMENT_RESULT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    // The document pass takes no range: a page range here would be a silently
    // ignored argument, not a narrower audit.
    expect(sidecar.send).toHaveBeenCalledWith(
      'audit_document',
      {},
      AUDIT_TIMEOUT_MS,
    );
    expect(AUDIT_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('No PDF open'));

    await expect(invoke(IPC_CHANNELS.AUDIT_DOCUMENT, {})).rejects.toThrow('No PDF open');
  });
});

describe('AUDIT_PAGES handler', () => {
  it('maps startPage/endPage to snake_case and uses the audit budget', async () => {
    sidecar.send.mockResolvedValueOnce(PAGES_RESULT);

    const result = await invoke(IPC_CHANNELS.AUDIT_PAGES, {}, 11, 20);

    expect(result).toBe(PAGES_RESULT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'audit_pages',
      { start_page: 11, end_page: 20 },
      AUDIT_TIMEOUT_MS,
    );
  });

  it('forwards the first and last page unchanged', async () => {
    await invoke(IPC_CHANNELS.AUDIT_PAGES, {}, 1, 1);

    expect(sidecar.send).toHaveBeenCalledWith(
      'audit_pages',
      { start_page: 1, end_page: 1 },
      AUDIT_TIMEOUT_MS,
    );
  });

  it('propagates range errors from the sidecar unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('Invalid page range: 0..5'));

    await expect(invoke(IPC_CHANNELS.AUDIT_PAGES, {}, 0, 5)).rejects.toThrow(
      'Invalid page range: 0..5',
    );
  });
});

describe('audit handlers and the Inspect session', () => {
  it('never opens a document, so the current sidecar document is untouched', async () => {
    await invoke(IPC_CHANNELS.AUDIT_DOCUMENT, {});
    await invoke(IPC_CHANNELS.AUDIT_PAGES, {}, 1, 10);

    expect(sidecar.send.mock.calls).toEqual([
      ['audit_document', {}, AUDIT_TIMEOUT_MS],
      ['audit_pages', { start_page: 1, end_page: 10 }, AUDIT_TIMEOUT_MS],
    ]);
    expect(sidecar.send).not.toHaveBeenCalledWith('open', expect.anything());
  });
});
