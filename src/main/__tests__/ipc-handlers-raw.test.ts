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

import { IPC_CHANNELS, RAW_RENDERER_TIMEOUT_MS, RAW_TIMEOUT_MS } from '../../shared/constants';
import type { SidecarManager } from '../sidecar';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const CATALOG_REF = { objectNumber: 1, generation: 0 };

/**
 * The payloads are the sidecar's verbatim answers. They are declared as plain
 * objects on purpose: the raw contract lives in the renderer
 * (src/renderer/types/raw-pdf.ts) and this composite project must not pull
 * renderer files in, so main is tested as a pure forwarder.
 */
const DOCUMENT = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  roots: [{ label: 'Root', ref: CATALOG_REF, value: null }],
};

const OBJECT = {
  ref: { objectNumber: 15, generation: 0 },
  value: { kind: 'dict', entries: [], truncated: false },
  summary: 'dict (0 entries)',
};

const CONTENT = { page: 2, streams: [], truncated: false };

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
    send: vi.fn(async () => DOCUMENT),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn(),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarManager);
}

beforeEach(async () => {
  await registerFresh();
});

describe('raw IPC channels', () => {
  it('uses dedicated channel names', () => {
    expect(IPC_CHANNELS.RAW_DOCUMENT).toBe('pdf:raw-document');
    expect(IPC_CHANNELS.RAW_OBJECT).toBe('pdf:raw-object');
    expect(IPC_CHANNELS.RAW_PAGE_CONTENT).toBe('pdf:raw-page-content');
  });

  it('registers a handler for each raw channel', () => {
    expect([...harness.handlers.keys()]).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.RAW_DOCUMENT,
        IPC_CHANNELS.RAW_OBJECT,
        IPC_CHANNELS.RAW_PAGE_CONTENT,
      ]),
    );
  });
});

describe('RAW_DOCUMENT handler', () => {
  it('posts raw_document with no params and the raw budget', async () => {
    const result = await invoke(IPC_CHANNELS.RAW_DOCUMENT, {});

    expect(result).toBe(DOCUMENT);
    expect(sidecar.send.mock.calls).toEqual([['raw_document', {}, RAW_TIMEOUT_MS]]);
    expect(RAW_TIMEOUT_MS).toBe(120_000);
  });

  it('propagates sidecar errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('No PDF open'));

    await expect(invoke(IPC_CHANNELS.RAW_DOCUMENT, {})).rejects.toThrow('No PDF open');
  });
});

describe('RAW_OBJECT handler', () => {
  it('maps the renderer ref to snake_case and uses the raw budget', async () => {
    sidecar.send.mockResolvedValueOnce(OBJECT);

    const result = await invoke(IPC_CHANNELS.RAW_OBJECT, {}, { objectNumber: 15, generation: 0 });

    expect(result).toBe(OBJECT);
    // Generation 0 is a real generation: it must not be dropped as falsy.
    expect(sidecar.send.mock.calls).toEqual([
      ['raw_object', { object_number: 15, generation: 0 }, RAW_TIMEOUT_MS],
    ]);
  });

  it('omits an absent generation instead of sending undefined', async () => {
    await invoke(IPC_CHANNELS.RAW_OBJECT, {}, { objectNumber: 7 });

    expect(sidecar.send.mock.calls).toEqual([
      ['raw_object', { object_number: 7 }, RAW_TIMEOUT_MS],
    ]);
  });

  it('rejects an argument without an object number before reaching the sidecar', async () => {
    await expect(invoke(IPC_CHANNELS.RAW_OBJECT, {}, undefined)).rejects.toThrow(
      'rawObject requires the objectNumber',
    );
    await expect(invoke(IPC_CHANNELS.RAW_OBJECT, {}, { objectNumber: '15' })).rejects.toThrow(
      'rawObject requires the objectNumber',
    );

    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('propagates range errors from the sidecar unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('Invalid object number: 9999'));

    await expect(
      invoke(IPC_CHANNELS.RAW_OBJECT, {}, { objectNumber: 9999, generation: 0 }),
    ).rejects.toThrow('Invalid object number: 9999');
  });
});

describe('RAW_PAGE_CONTENT handler', () => {
  it('forwards the page and uses the raw budget', async () => {
    sidecar.send.mockResolvedValueOnce(CONTENT);

    const result = await invoke(IPC_CHANNELS.RAW_PAGE_CONTENT, {}, 2);

    expect(result).toBe(CONTENT);
    expect(sidecar.send.mock.calls).toEqual([
      ['raw_page_content', { page: 2 }, RAW_TIMEOUT_MS],
    ]);
  });

  it('propagates page range errors from the sidecar unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('Invalid page: 9 (1..2)'));

    await expect(invoke(IPC_CHANNELS.RAW_PAGE_CONTENT, {}, 9)).rejects.toThrow(
      'Invalid page: 9 (1..2)',
    );
  });
});

describe('raw handlers and the Inspect session', () => {
  it('never opens a document, so the current sidecar document is untouched', async () => {
    await invoke(IPC_CHANNELS.RAW_DOCUMENT, {});
    await invoke(IPC_CHANNELS.RAW_OBJECT, {}, { objectNumber: 1, generation: 0 });
    await invoke(IPC_CHANNELS.RAW_PAGE_CONTENT, {}, 1);

    expect(sidecar.send.mock.calls).toEqual([
      ['raw_document', {}, RAW_TIMEOUT_MS],
      ['raw_object', { object_number: 1, generation: 0 }, RAW_TIMEOUT_MS],
      ['raw_page_content', { page: 1 }, RAW_TIMEOUT_MS],
    ]);
    expect(sidecar.send).not.toHaveBeenCalledWith('open', expect.anything());
  });
});

describe('raw timeout budgets', () => {
  it('lets the main process lose the raw race, never the renderer', () => {
    expect(RAW_RENDERER_TIMEOUT_MS).toBe(125_000);
    expect(RAW_RENDERER_TIMEOUT_MS).toBeGreaterThan(RAW_TIMEOUT_MS);
  });
});
