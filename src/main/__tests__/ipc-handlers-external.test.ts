import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(),
}));

// The Electron binary download is optional in this environment, so the module
// is replaced by an IPC registry plus a stubbed shell we can inspect.
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
  shell: {
    openExternal: harness.openExternal,
  },
}));

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import { IPC_CHANNELS } from '../../shared/constants';
import { UNSAFE_EXTERNAL_URL_ERROR } from '../../shared/external-url';
import type { SidecarTransport } from '../sidecar-pool';

interface SidecarStub {
  send: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  setDocumentRestorer: ReturnType<typeof vi.fn>;
}

let sidecar: SidecarStub;

/** Invoke the registered handler the way Electron would: (event, ...args). */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: { id: 1 } }, ...args);
}

beforeEach(async () => {
  harness.handlers.clear();
  harness.openExternal.mockReset();
  harness.openExternal.mockResolvedValue(undefined);

  sidecar = {
    send: vi.fn(async () => ({ pages: 1 })),
    restart: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    setDocumentRestorer: vi.fn(),
  };

  vi.resetModules();
  const { registerIpcHandlers } = await import('../ipc-handlers');
  registerIpcHandlers(sidecar as unknown as SidecarTransport);
});

describe('OPEN_EXTERNAL handler', () => {
  it('opens a safe http(s) link with the OS shell', async () => {
    await expect(invoke(IPC_CHANNELS.OPEN_EXTERNAL, 'https://example.com/report')).resolves.toEqual({
      ok: true,
    });

    expect(harness.openExternal).toHaveBeenCalledTimes(1);
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/report');
  });

  it('opens exactly the trimmed URL it validated', async () => {
    await invoke(IPC_CHANNELS.OPEN_EXTERNAL, '   http://example.com/a?b=1   ');

    expect(harness.openExternal).toHaveBeenCalledWith('http://example.com/a?b=1');
  });

  it('rejects every unsafe target before calling the shell', async () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'mailto:user@example.com',
      'ftp://example.com/file.pdf',
      '/relative/path',
      'relative.html',
      '//example.com/path',
      'http://example.com/\u0000',
      '',
      '   ',
      null,
      undefined,
      42,
      { url: 'https://example.com' },
    ]) {
      const result = await invoke(IPC_CHANNELS.OPEN_EXTERNAL, url);

      expect(result).toEqual({ ok: false, error: UNSAFE_EXTERNAL_URL_ERROR });
    }

    // The bridge is the trust boundary: a renderer bug cannot reach the shell.
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('reports a shell failure instead of rejecting', async () => {
    harness.openExternal.mockRejectedValueOnce(new Error('no handler registered'));

    await expect(invoke(IPC_CHANNELS.OPEN_EXTERNAL, 'https://example.com')).resolves.toEqual({
      ok: false,
      error: 'no handler registered',
    });
  });

  it('falls back to a readable message for a non-Error shell failure', async () => {
    harness.openExternal.mockRejectedValueOnce('nope');

    await expect(invoke(IPC_CHANNELS.OPEN_EXTERNAL, 'https://example.com')).resolves.toEqual({
      ok: false,
      error: 'Unknown error',
    });
  });

  it('never touches the sidecar or the open document', async () => {
    await invoke(IPC_CHANNELS.OPEN_EXTERNAL, 'https://example.com');

    expect(sidecar.send).not.toHaveBeenCalled();
    expect(sidecar.restart).not.toHaveBeenCalled();
  });
});
