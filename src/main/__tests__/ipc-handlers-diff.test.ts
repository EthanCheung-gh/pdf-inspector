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
  app: {
    getPath: (name: string) => `/tmp/${name}`,
  },
}));

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import { DIFF_TIMEOUT_MS, IPC_CHANNELS, OPEN_PDF_TIMEOUT_MS } from '../../shared/constants';
import type { DiffResult } from '../../shared/diff-types';
import type { SidecarManager } from '../sidecar';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

const DIFF_RESULT = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  options: {
    positionTolerance: 1,
    textTolerance: 'normalized',
    ignoreTypes: [],
    ignoreFonts: false,
    ignoreColors: false,
    ignoreImages: false,
    ignoreRegions: [],
  },
  old: { pages: 1, sha256: 'a'.repeat(64) },
  new: { pages: 1, sha256: 'b'.repeat(64) },
  summary: {
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesChanged: 0,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 0,
  },
  pages: [],
} satisfies DiffResult;

let sidecar: SidecarStub;
let restorer: (() => Promise<void>) | null;

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(...args);
}

async function registerFresh(): Promise<void> {
  vi.resetModules();
  harness.handlers.clear();

  sidecar = {
    send: vi.fn(async () => DIFF_RESULT),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn((fn: (() => Promise<void>) | null) => {
      restorer = fn;
    }),
  };

  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarManager);
}

beforeEach(async () => {
  restorer = null;
  harness.showOpenDialog.mockReset();
  await registerFresh();
});

describe('DIFF_PDFS handler', () => {
  it('posts diff_documents with snake_case options and the diff budget', async () => {
    const result = await invoke(
      IPC_CHANNELS.DIFF_PDFS,
      {},
      '/docs/old.pdf',
      '/docs/new.pdf',
      {
        positionTolerance: 2.5,
        textTolerance: 'exact',
        ignoreTypes: ['image', 'table'],
        ignoreFonts: true,
      },
    );

    expect(result).toBe(DIFF_RESULT);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    expect(sidecar.send).toHaveBeenCalledWith(
      'diff_documents',
      {
        old_path: '/docs/old.pdf',
        new_path: '/docs/new.pdf',
        options: {
          position_tolerance: 2.5,
          text_tolerance: 'exact',
          ignore_types: ['image', 'table'],
          ignore_fonts: true,
        },
      },
      DIFF_TIMEOUT_MS,
    );
    expect(DIFF_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it('sends empty options when the caller provides none', async () => {
    await invoke(IPC_CHANNELS.DIFF_PDFS, {}, '/docs/old.pdf', '/docs/new.pdf');

    expect(sidecar.send).toHaveBeenCalledWith(
      'diff_documents',
      { old_path: '/docs/old.pdf', new_path: '/docs/new.pdf', options: {} },
      DIFF_TIMEOUT_MS,
    );
  });

  it('never opens a document, so the Inspect session is untouched', async () => {
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/docs/current.pdf'],
    });
    await invoke(IPC_CHANNELS.OPEN_PDF);
    sidecar.send.mockClear();

    await invoke(IPC_CHANNELS.DIFF_PDFS, {}, '/docs/old.pdf', '/docs/new.pdf');

    // Only the diff request: diffing must not replace the tracked document.
    expect(sidecar.send.mock.calls).toEqual([
      [
        'diff_documents',
        { old_path: '/docs/old.pdf', new_path: '/docs/new.pdf', options: {} },
        DIFF_TIMEOUT_MS,
      ],
    ]);

    // A later restart still restores the document the user was inspecting.
    sidecar.send.mockClear();
    await restorer!();
    expect(sidecar.send).toHaveBeenCalledWith(
      'open',
      { path: '/docs/current.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('rejects missing paths without calling the sidecar', async () => {
    await expect(
      invoke(IPC_CHANNELS.DIFF_PDFS, {}, '/docs/old.pdf', ''),
    ).rejects.toThrow('diffPdfs requires the new PDF file path');
    await expect(invoke(IPC_CHANNELS.DIFF_PDFS, {}, 42, '/docs/new.pdf')).rejects.toThrow(
      'diffPdfs requires the old PDF file path',
    );
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('rejects File objects instead of letting the IPC clone fail', async () => {
    const file = new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' });

    await expect(invoke(IPC_CHANNELS.DIFF_PDFS, {}, file, '/docs/new.pdf')).rejects.toThrow(
      'diffPdfs requires the old PDF file path',
    );
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('propagates sidecar diff errors unchanged', async () => {
    sidecar.send.mockRejectedValueOnce(new Error('Cannot read old PDF \'/docs/old.pdf\''));

    await expect(
      invoke(IPC_CHANNELS.DIFF_PDFS, {}, '/docs/old.pdf', '/docs/new.pdf'),
    ).rejects.toThrow("Cannot read old PDF '/docs/old.pdf'");
  });
});

describe('PICK_DIFF_PDF handler', () => {
  it('returns the chosen path and basename without opening it', async () => {
    harness.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/docs/versions/old report.pdf'],
    });

    const result = await invoke(IPC_CHANNELS.PICK_DIFF_PDF, {}, 'old');

    expect(result).toEqual({
      canceled: false,
      source: '/docs/versions/old report.pdf',
      name: 'old report.pdf',
    });
    expect(harness.showOpenDialog).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({
        title: 'Choose the older PDF to compare',
        properties: ['openFile'],
      }),
    );
    // Picking must never touch the sidecar's current document.
    expect(sidecar.send).not.toHaveBeenCalled();
    expect(restorer).not.toBeNull();
  });

  it('labels the new side and reports a cancelled dialog', async () => {
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(invoke(IPC_CHANNELS.PICK_DIFF_PDF, {}, 'new')).resolves.toEqual({
      canceled: true,
    });
    expect(harness.showOpenDialog).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ title: 'Choose the newer PDF to compare' }),
    );
    expect(sidecar.send).not.toHaveBeenCalled();
  });
});
