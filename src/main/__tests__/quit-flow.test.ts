import { beforeEach, describe, expect, it, vi } from 'vitest';

interface BeforeQuitEvent {
  preventDefault: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (event: BeforeQuitEvent) => void>(),
  quit: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isRunning: vi.fn(() => false),
}));

// `../index` wires real Electron app events at import time, so Electron and the
// sidecar are replaced by recorders. `whenReady()` never resolves, which keeps
// the startup path (window creation, IPC registration) out of this test.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    whenReady: () => new Promise(() => {}),
    on: (event: string, listener: (e: BeforeQuitEvent) => void) => {
      harness.listeners.set(event, listener);
    },
    quit: harness.quit,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

vi.mock('../sidecar', () => ({
  SidecarManager: class {
    start = harness.start;
    stop = harness.stop;
    isRunning = harness.isRunning;
    setDocumentRestorer = vi.fn();
  },
}));

vi.mock('../ipc-handlers', () => ({ registerIpcHandlers: vi.fn() }));

vi.mock('../../shared/python-resolver', () => ({
  getPythonCandidates: () => [],
  setSelectedPython: vi.fn(),
  resolvePythonCommand: () => ({ command: 'python3', args: [] }),
}));

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  // `../index` keeps `shutdownStarted` in module scope, so each test needs a
  // freshly imported module instance.
  vi.resetModules();
  harness.listeners.clear();
  harness.quit.mockReset();
  harness.start.mockReset().mockResolvedValue(undefined);
  harness.stop.mockReset().mockResolvedValue(undefined);
  harness.isRunning.mockReset().mockReturnValue(false);
});

describe('before-quit graceful shutdown', () => {
  it('stops the sidecar even when it is not running, then re-issues quit', async () => {
    harness.isRunning.mockReturnValue(false);
    await import('../index');

    const beforeQuit = harness.listeners.get('before-quit');
    expect(beforeQuit).toBeTypeOf('function');

    const event: BeforeQuitEvent = { preventDefault: vi.fn() };
    beforeQuit!(event);

    // First pass is cancelled so the async stop can complete.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // stop() also disables auto-restart, so it must run even when already down.
    expect(harness.stop).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    // Quit is only re-issued once the stop has settled.
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it('lets the re-issued quit pass through instead of deferring again', async () => {
    await import('../index');
    const beforeQuit = harness.listeners.get('before-quit')!;

    beforeQuit({ preventDefault: vi.fn() });
    await flushMicrotasks();
    expect(harness.quit).toHaveBeenCalledTimes(1);

    // The second pass must NOT be cancelled and must not stop/quit again.
    const secondPass: BeforeQuitEvent = { preventDefault: vi.fn() };
    beforeQuit(secondPass);

    expect(secondPass.preventDefault).not.toHaveBeenCalled();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it('re-issues quit even if stopping the sidecar fails', async () => {
    harness.stop.mockRejectedValueOnce(new Error('stop boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await import('../index');
      harness.listeners.get('before-quit')!({ preventDefault: vi.fn() });
      await flushMicrotasks();

      expect(harness.quit).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
