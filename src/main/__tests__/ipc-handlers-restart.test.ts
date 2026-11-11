import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
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
    showOpenDialog: harness.showOpenDialog,
    showSaveDialog: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: () => ({ id: 1 }),
    fromWebContents: () => ({ id: 1 }),
  },
  // OPEN_PDF_URL resolves its download directory through `app.getPath`; the
  // handlers module imports `app` even when these tests never call that channel.
  app: {
    getPath: (name: string) => `/tmp/${name}`,
  },
}));

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import {
  ANALYZE_FONTS_TIMEOUT_MS,
  EXTRACT_PAGE_TIMEOUT_MS,
  IPC_CHANNELS,
  OPEN_PDF_TIMEOUT_MS,
} from '../../shared/constants';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

let sidecar: SidecarStub;
let restorer: (() => Promise<void>) | null;

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(...args);
}

/** Register handlers against a fresh module instance (fresh `currentFilePath`). */
async function registerFresh(): Promise<void> {
  vi.resetModules();
  harness.handlers.clear();

  sidecar = {
    send: vi.fn(async () => ({ pages: 1 })),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn((fn: (() => Promise<void>) | null) => {
      restorer = fn;
    }),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
}

async function openDocument(filePath: string): Promise<void> {
  harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
  await invoke(IPC_CHANNELS.OPEN_PDF);
}

beforeEach(async () => {
  restorer = null;
  harness.showOpenDialog.mockReset();
  await registerFresh();
});

describe('registerIpcHandlers document restorer', () => {
  it('registers a restorer with the sidecar manager', () => {
    expect(sidecar.setDocumentRestorer).toHaveBeenCalledTimes(1);
    expect(restorer).toBeTypeOf('function');
  });

  it('does nothing when no document has been opened', async () => {
    await restorer!();
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('re-opens the tracked document', async () => {
    await openDocument('/tmp/example.pdf');
    sidecar.send.mockClear();

    await restorer!();

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/example.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });
});

describe('OPEN_PDF failure handling', () => {
  it('re-opens the previous document when the new open fails, then rethrows', async () => {
    await openDocument('/tmp/first.pdf');
    sidecar.send.mockClear();

    sidecar.send.mockRejectedValueOnce(new Error('cannot open /tmp/broken.pdf'));
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/broken.pdf'],
    });

    await expect(invoke(IPC_CHANNELS.OPEN_PDF)).rejects.toThrow(
      'cannot open /tmp/broken.pdf',
    );

    // First the failing open, then exactly one best-effort reopen of the file
    // that is still tracked (the sidecar closed it before the failed open).
    expect(sidecar.send.mock.calls).toEqual([
      ['open', { path: '/tmp/broken.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['open', { path: '/tmp/first.pdf' }, OPEN_PDF_TIMEOUT_MS],
    ]);

    // `currentFilePath` is unchanged, so a later restore still opens /tmp/first.pdf.
    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/first.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('does not attempt a reopen when no document was open yet', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('cannot open /tmp/broken.pdf'));
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/broken.pdf'],
    });

    await expect(invoke(IPC_CHANNELS.OPEN_PDF)).rejects.toThrow(
      'cannot open /tmp/broken.pdf',
    );

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/broken.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('still propagates the original error when the reopen also fails', async () => {
    await openDocument('/tmp/first.pdf');
    sidecar.send.mockClear();

    sidecar.send
      .mockRejectedValueOnce(new Error('cannot open /tmp/broken.pdf'))
      .mockRejectedValueOnce(new Error('reopen failed'));
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/broken.pdf'],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(invoke(IPC_CHANNELS.OPEN_PDF)).rejects.toThrow(
        'cannot open /tmp/broken.pdf',
      );
      expect(sidecar.send).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('RESTART_SIDECAR handler', () => {
  it('does not send `open` itself — the restorer owns exactly one reopen', async () => {
    await openDocument('/tmp/example.pdf');
    sidecar.send.mockClear();

    const result = await invoke(IPC_CHANNELS.RESTART_SIDECAR);

    expect(result).toEqual({ success: true, running: true });
    expect(sidecar.restart).toHaveBeenCalledTimes(1);
    // restart() -> start() -> restorer is the single source of `open`.
    expect(sidecar.send).not.toHaveBeenCalled();

    await restorer!();
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/example.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('reports failures instead of throwing', async () => {
    sidecar.restart.mockRejectedValueOnce(new Error('restart boom'));
    sidecar.isRunning.mockReturnValue(false);

    const result = await invoke(IPC_CHANNELS.RESTART_SIDECAR);

    expect(result).toEqual({ success: false, running: false, error: 'restart boom' });
  });
});

describe('ANALYZE_FONTS request timeout', () => {
  it('requests a 120s budget for font analysis', async () => {
    expect(ANALYZE_FONTS_TIMEOUT_MS).toBe(120_000);

    // Handlers receive `(event, ...args)`; the renderer sends no range here.
    await invoke(IPC_CHANNELS.ANALYZE_FONTS, {}, undefined, undefined);

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith('analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS);
  });

  it('forwards a page range as start_page/end_page with the same budget', async () => {
    await invoke(IPC_CHANNELS.ANALYZE_FONTS, {}, 1, 10);

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'analyze_fonts',
      { start_page: 1, end_page: 10 },
      ANALYZE_FONTS_TIMEOUT_MS,
    );
  });

  it('omits a bound that was not provided', async () => {
    await invoke(IPC_CHANNELS.ANALYZE_FONTS, {}, 3, undefined);

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'analyze_fonts',
      { start_page: 3 },
      ANALYZE_FONTS_TIMEOUT_MS,
    );
  });

  it('leaves the other channels on the 30s default', async () => {
    // Handlers receive `(event, ...args)`; the stub event is unused here.
    const event = {} as unknown;
    await invoke(IPC_CHANNELS.EXTRACT_METADATA);
    await invoke(IPC_CHANNELS.GET_IMAGE_DATA, event, 'Im1');

    // Exactly two arguments: no per-request timeout, so SidecarManager.send()
    // applies its 30s default.
    expect(sidecar.send.mock.calls).toEqual([
      ['extract_metadata'],
      ['get_image_data', { stream_id: 'Im1' }],
    ]);
  });
});

describe('EXTRACT_PAGE request timeout', () => {
  it('requests a 120s budget for page extraction', async () => {
    // Extraction is normally sub-0.1s, but one complex page (many tables and
    // objects) is extracted in one shot and must not look like a failed page.
    expect(EXTRACT_PAGE_TIMEOUT_MS).toBe(120_000);

    await invoke(IPC_CHANNELS.EXTRACT_PAGE, {}, 4);

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'extract_page',
      { page: 4 },
      EXTRACT_PAGE_TIMEOUT_MS,
    );
  });

  it('keeps extract_metadata on the 30s default while extraction gets 120s', async () => {
    const event = {} as unknown;
    await invoke(IPC_CHANNELS.EXTRACT_PAGE, event, 1);
    await invoke(IPC_CHANNELS.EXTRACT_METADATA);

    expect(sidecar.send.mock.calls).toEqual([
      ['extract_page', { page: 1 }, EXTRACT_PAGE_TIMEOUT_MS],
      // No explicit budget: the cheap metadata read keeps `send()`'s default.
      ['extract_metadata'],
    ]);
  });
});

describe('OPEN_PDF request timeout', () => {
  it('opens the chosen file with the 120s open budget', async () => {
    expect(OPEN_PDF_TIMEOUT_MS).toBe(120_000);

    await openDocument('/tmp/large.pdf');

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/large.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('keeps open on its own budget while extraction has its own', async () => {
    const event = {} as unknown;
    await openDocument('/tmp/large.pdf');
    await invoke(IPC_CHANNELS.EXTRACT_PAGE, event, 1);

    // Both channels carry an explicit budget, but they are independent: a page
    // extraction must not inherit (or extend) the 120s document-open budget.
    expect(sidecar.send.mock.calls).toEqual([
      ['open', { path: '/tmp/large.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['extract_page', { page: 1 }, EXTRACT_PAGE_TIMEOUT_MS],
    ]);
  });
});
