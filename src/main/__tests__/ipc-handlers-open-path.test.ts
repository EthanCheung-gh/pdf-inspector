import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  tempPath: '/tmp/pdf-inspector-open-path-test',
  downloadPdfToFile: vi.fn(),
  deleteDownloadedFile: vi.fn(async (_filePath: string) => {}),
}));

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
  app: {
    getPath: (name: string) => (name === 'temp' ? harness.tempPath : `/tmp/${name}`),
  },
}));

vi.mock('../pdf-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf-url')>();
  return {
    ...actual,
    downloadPdfToFile: harness.downloadPdfToFile,
    deleteDownloadedFile: harness.deleteDownloadedFile,
  };
});

import { IPC_CHANNELS, OPEN_PDF_TIMEOUT_MS } from '../../shared/constants';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

let sidecar: SidecarStub;
let restorer: (() => Promise<void>) | null;

const TEMP_PDF_DIR = path.join(harness.tempPath, 'pdf-inspector');
const DOWNLOAD = path.join(TEMP_PDF_DIR, 'remote-aaaaaaaa.pdf');

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(...args);
}

/** Register handlers against a fresh module instance (fresh tracked state). */
async function registerFresh(): Promise<void> {
  vi.resetModules();
  harness.handlers.clear();

  sidecar = {
    send: vi.fn(async () => ({ pages: 4 })),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn((fn: (() => Promise<void>) | null) => {
      restorer = fn;
    }),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
}

function openPath(filePath: unknown): Promise<unknown> {
  return invoke(IPC_CHANNELS.OPEN_PDF_PATH, {}, filePath);
}

function openUrl(rawUrl: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.OPEN_PDF_URL, {}, rawUrl);
}

beforeEach(async () => {
  restorer = null;
  harness.showOpenDialog.mockReset();
  harness.downloadPdfToFile.mockReset();
  harness.deleteDownloadedFile.mockReset();
  harness.deleteDownloadedFile.mockResolvedValue(undefined);
  await registerFresh();
});

describe('OPEN_PDF_PATH', () => {
  it('opens the known path without a dialog and returns the metadata', async () => {
    const metadata = { pages: 4 };
    sidecar.send.mockResolvedValue(metadata);

    const result = await openPath('/docs/second.pdf');

    expect(harness.showOpenDialog).not.toHaveBeenCalled();
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/docs/second.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(result).toEqual({
      canceled: false,
      path: '/docs/second.pdf',
      metadata,
      name: 'second.pdf',
    });
  });

  it('tracks the path as the current document for a sidecar restart', async () => {
    await openPath('/docs/second.pdf');
    sidecar.send.mockClear();

    await restorer!();

    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/docs/second.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('rejects a missing or empty path without touching the sidecar', async () => {
    await expect(openPath(undefined)).rejects.toThrow(
      'openPdfPath requires the path of the PDF to open',
    );
    await expect(openPath('   ')).rejects.toThrow(
      'openPdfPath requires the path of the PDF to open',
    );
    await expect(openPath(42)).rejects.toThrow(
      'openPdfPath requires the path of the PDF to open',
    );

    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('deletes the previous download when a known local path replaces a URL document', async () => {
    harness.downloadPdfToFile.mockResolvedValue(DOWNLOAD);
    await openUrl('https://example.com/report.pdf');
    harness.deleteDownloadedFile.mockClear();

    await openPath('/docs/local.pdf');

    // The tab bar re-opens documents, so the replaced temp copy is garbage.
    expect(harness.deleteDownloadedFile).toHaveBeenCalledTimes(1);
    expect(harness.deleteDownloadedFile).toHaveBeenCalledWith(DOWNLOAD);
  });

  it('propagates a failed open and keeps the previous document tracked', async () => {
    await openPath('/docs/first.pdf');
    sidecar.send.mockClear();
    sidecar.send.mockRejectedValueOnce(new Error('cannot open /docs/second.pdf'));

    await expect(openPath('/docs/second.pdf')).rejects.toThrow(
      'cannot open /docs/second.pdf',
    );

    // The failed open, then exactly one best-effort restore of the old document.
    expect(sidecar.send.mock.calls).toEqual([
      ['open', { path: '/docs/second.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['open', { path: '/docs/first.pdf' }, OPEN_PDF_TIMEOUT_MS],
    ]);

    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/docs/first.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });
});
