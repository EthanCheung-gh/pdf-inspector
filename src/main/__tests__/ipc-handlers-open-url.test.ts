import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  tempPath: '/tmp/pdf-inspector-open-url-test',
  downloadPdfToFile: vi.fn(),
  deleteDownloadedFile: vi.fn(async (_filePath: string) => {}),
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
  app: {
    getPath: (name: string) =>
      name === 'temp' ? harness.tempPath : `/tmp/${name}`,
  },
}));

// Only the network/disk side effects are stubbed: the real URL parsing and the
// real temp-path builder are part of the contract under test.
vi.mock('../pdf-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf-url')>();
  return {
    ...actual,
    downloadPdfToFile: harness.downloadPdfToFile,
    deleteDownloadedFile: harness.deleteDownloadedFile,
  };
});

import { IPC_CHANNELS } from '../../shared/constants';
import type { SidecarManager } from '../sidecar';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

let sidecar: SidecarStub;
let restorer: (() => Promise<void>) | null;

const TEMP_PDF_DIR = path.join(harness.tempPath, 'pdf-inspector');
const FIRST_DOWNLOAD = path.join(TEMP_PDF_DIR, 'first-aaaaaaaa.pdf');
const SECOND_DOWNLOAD = path.join(TEMP_PDF_DIR, 'second-bbbbbbbb.pdf');

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
    send: vi.fn(async () => ({ pages: 1 })),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn((fn: (() => Promise<void>) | null) => {
      restorer = fn;
    }),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarManager);
}

/** Open a local file through the dialog-driven OPEN_PDF handler. */
async function openLocalFile(filePath: string): Promise<void> {
  harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
  await invoke(IPC_CHANNELS.OPEN_PDF);
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

describe('OPEN_PDF_URL success', () => {
  it('downloads into the app temp directory, opens it and returns the source URL', async () => {
    const metadata = { pageCount: 3 };
    const url = 'https://example.com/docs/report.pdf?token=abc';
    harness.downloadPdfToFile.mockResolvedValue(FIRST_DOWNLOAD);
    sidecar.send.mockResolvedValue(metadata);

    const result = await openUrl(url);

    expect(harness.downloadPdfToFile).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = harness.downloadPdfToFile.mock.calls[0] as [
      URL,
      { directory: string },
    ];
    expect(calledUrl).toBeInstanceOf(URL);
    expect(calledUrl.href).toBe(url);
    expect(calledOptions).toEqual({ directory: TEMP_PDF_DIR });

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: FIRST_DOWNLOAD });

    expect(result).toEqual({
      canceled: false,
      path: FIRST_DOWNLOAD,
      metadata,
      sourceUrl: url,
    });
    // Nothing to delete: the first download is the open document.
    expect(harness.deleteDownloadedFile).not.toHaveBeenCalled();
  });

  it('tracks the downloaded file so a restarted sidecar re-opens it', async () => {
    harness.downloadPdfToFile.mockResolvedValue(FIRST_DOWNLOAD);

    await openUrl('https://example.com/report.pdf');
    sidecar.send.mockClear();

    await restorer!();

    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: FIRST_DOWNLOAD });
  });

  it('rejects a non-http(s) URL before downloading anything', async () => {
    await expect(openUrl('ftp://example.com/report.pdf')).rejects.toThrow(
      'Only http(s) URLs are supported',
    );
    await expect(openUrl('not a url')).rejects.toThrow('Enter a valid http(s) URL');

    expect(harness.downloadPdfToFile).not.toHaveBeenCalled();
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('propagates a download failure without touching the open document', async () => {
    harness.downloadPdfToFile.mockResolvedValueOnce(FIRST_DOWNLOAD);
    await openUrl('https://example.com/first.pdf');
    sidecar.send.mockClear();
    harness.deleteDownloadedFile.mockClear();

    harness.downloadPdfToFile.mockRejectedValueOnce(new Error('Download failed with HTTP 404'));

    await expect(openUrl('https://example.com/missing.pdf')).rejects.toThrow(
      'Download failed with HTTP 404',
    );

    expect(sidecar.send).not.toHaveBeenCalled();
    expect(harness.deleteDownloadedFile).not.toHaveBeenCalled();

    // The first document is still the tracked one.
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: FIRST_DOWNLOAD });
  });
});

describe('OPEN_PDF_URL failure handling', () => {
  it('deletes the new download, reopens the previous document and rethrows', async () => {
    await openLocalFile('/tmp/local.pdf');
    sidecar.send.mockClear();
    harness.deleteDownloadedFile.mockClear();

    harness.downloadPdfToFile.mockResolvedValue(FIRST_DOWNLOAD);
    sidecar.send.mockRejectedValueOnce(new Error('cannot open downloaded PDF'));

    await expect(openUrl('https://example.com/broken.pdf')).rejects.toThrow(
      'cannot open downloaded PDF',
    );

    // The sidecar never opened the download, so it is garbage.
    expect(harness.deleteDownloadedFile).toHaveBeenCalledTimes(1);
    expect(harness.deleteDownloadedFile).toHaveBeenCalledWith(FIRST_DOWNLOAD);

    // Failing open, then exactly one best-effort reopen of the previous file.
    expect(sidecar.send.mock.calls).toEqual([
      ['open', { path: FIRST_DOWNLOAD }],
      ['open', { path: '/tmp/local.pdf' }],
    ]);

    // The tracked document is unchanged, so a later restore opens the local file.
    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: '/tmp/local.pdf' });
  });

  it('deletes the new download and keeps the previous download when the open fails', async () => {
    harness.downloadPdfToFile.mockResolvedValueOnce(FIRST_DOWNLOAD);
    await openUrl('https://example.com/first.pdf');
    sidecar.send.mockClear();
    harness.deleteDownloadedFile.mockClear();

    harness.downloadPdfToFile.mockResolvedValueOnce(SECOND_DOWNLOAD);
    sidecar.send.mockRejectedValueOnce(new Error('cannot open second PDF'));

    await expect(openUrl('https://example.com/second.pdf')).rejects.toThrow(
      'cannot open second PDF',
    );

    // Only the failed download is removed; the open one is reopened and kept.
    expect(harness.deleteDownloadedFile).toHaveBeenCalledTimes(1);
    expect(harness.deleteDownloadedFile).toHaveBeenCalledWith(SECOND_DOWNLOAD);
    expect(harness.deleteDownloadedFile).not.toHaveBeenCalledWith(FIRST_DOWNLOAD);

    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: FIRST_DOWNLOAD });
  });
});

describe('temp file lifecycle', () => {
  it('deletes the previous download once a second URL opens successfully', async () => {
    harness.downloadPdfToFile
      .mockResolvedValueOnce(FIRST_DOWNLOAD)
      .mockResolvedValueOnce(SECOND_DOWNLOAD);

    await openUrl('https://example.com/first.pdf');
    harness.deleteDownloadedFile.mockClear();

    await openUrl('https://example.com/second.pdf');

    expect(harness.deleteDownloadedFile).toHaveBeenCalledTimes(1);
    expect(harness.deleteDownloadedFile).toHaveBeenCalledWith(FIRST_DOWNLOAD);

    // The new download is the tracked document, the old one is gone.
    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: SECOND_DOWNLOAD });
  });

  it('keeps a downloaded file when the same URL is reopened', async () => {
    harness.downloadPdfToFile.mockResolvedValue(FIRST_DOWNLOAD);

    await openUrl('https://example.com/report.pdf');
    harness.deleteDownloadedFile.mockClear();
    await openUrl('https://example.com/report.pdf');

    // Never delete the file the sidecar currently has open.
    expect(harness.deleteDownloadedFile).not.toHaveBeenCalled();
  });

  it('deletes the download when a local file replaces it', async () => {
    harness.downloadPdfToFile.mockResolvedValueOnce(FIRST_DOWNLOAD);
    await openUrl('https://example.com/report.pdf');
    harness.deleteDownloadedFile.mockClear();

    await openLocalFile('/tmp/local.pdf');

    expect(harness.deleteDownloadedFile).toHaveBeenCalledTimes(1);
    expect(harness.deleteDownloadedFile).toHaveBeenCalledWith(FIRST_DOWNLOAD);

    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: '/tmp/local.pdf' });
  });

  it('keeps the download when the open dialog is cancelled', async () => {
    harness.downloadPdfToFile.mockResolvedValueOnce(FIRST_DOWNLOAD);
    await openUrl('https://example.com/report.pdf');
    harness.deleteDownloadedFile.mockClear();

    harness.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(invoke(IPC_CHANNELS.OPEN_PDF)).resolves.toEqual({ canceled: true });

    expect(harness.deleteDownloadedFile).not.toHaveBeenCalled();

    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith('open', { path: FIRST_DOWNLOAD });
  });
});
