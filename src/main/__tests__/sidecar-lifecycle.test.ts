import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The Electron binary download is optional in this environment; only
// `app.isPackaged` is read by the manager. `true` exercises the packaged
// branch, whose binary path is provided by the temp resources dir below.
vi.mock('electron', () => ({ app: { isPackaged: true } }));

// Spawning a real process is impossible in a unit test: fake the child process.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { ANALYZE_FONTS_TIMEOUT_MS } from '../../shared/constants';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  SidecarManager,
} from '../sidecar';

/** Mirrors the manager's internal crash-restart delay (500ms). */
const CRASH_RESTART_DELAY_MS = 500;

/**
 * Timeout budget used by the bounded-stop tests. Small enough to keep the suite
 * fast, large enough that a loaded machine still measures a real wait.
 */
const STOP_TIMEOUT_MS = 50;

interface WrittenRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** Minimal stand-in for a `ChildProcess` with piped stdio. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    // A real ChildProcess emits 'exit' asynchronously after kill().
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
  });
  stdin = {
    write: vi.fn((raw: string) => {
      const request = JSON.parse(raw) as WrittenRequest;
      // The real sidecar answers `shutdown` so stop()/restart() do not block.
      if (request.method === 'shutdown') {
        queueMicrotask(() => this.emitResponse(request.id, {}));
      }
      return true;
    }),
  };

  /** Emit the one-time ready line the manager waits for. */
  emitReady(): void {
    this.stdout.emit('data', Buffer.from('{"ready":true}\n'));
  }

  /** Emit a JSON line as the sidecar would for a response. */
  emitResponse(id: number, result: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, result })}\n`));
  }

  requests(): WrittenRequest[] {
    return this.stdin.write.mock.calls.map((call) => JSON.parse(call[0] as string) as WrittenRequest);
  }
}

let resourcesDir: string;
let spawned: FakeChildProcess[];

/** Let queued microtasks (spawn -> ready -> settle -> restore) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Turn a fake into a sidecar that stopped reading stdin while still running:
 * `shutdown` is never answered and `kill()` only flips the flag, so no `exit`
 * event ever arrives. This is the case that used to hang the quit path.
 */
function makeUnresponsive(proc: FakeChildProcess): FakeChildProcess {
  proc.stdin.write.mockImplementation(() => true);
  proc.kill.mockImplementation(() => {
    proc.killed = true;
  });
  return proc;
}

beforeAll(() => {
  resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-inspector-sidecar-'));
  fs.mkdirSync(path.join(resourcesDir, 'sidecar'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'sidecar', 'pdf-inspector-sidecar'), '');
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesDir,
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  fs.rmSync(resourcesDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawned = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    spawned.push(proc);
    // Ready arrives after the manager has attached its listeners.
    queueMicrotask(() => proc.emitReady());
    return proc;
  });
});

describe('SidecarManager document restorer', () => {
  it('runs the restorer exactly once after a successful start', async () => {
    const sidecar = new SidecarManager();
    const restorer = vi.fn(async () => {});
    sidecar.setDocumentRestorer(restorer);

    await sidecar.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(restorer).toHaveBeenCalledTimes(1);
  });

  it('is unset-safe: start works with no restorer registered', async () => {
    const sidecar = new SidecarManager();

    await expect(sidecar.start()).resolves.toBeUndefined();
    expect(sidecar.isRunning()).toBe(true);
  });

  it('swallows and logs restorer errors instead of failing the start', async () => {
    const sidecar = new SidecarManager();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sidecar.setDocumentRestorer(async () => {
      throw new Error('restore boom');
    });

    try {
      await expect(sidecar.start()).resolves.toBeUndefined();
      expect(sidecar.isRunning()).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not run the restorer when start() is a no-op (already running)', async () => {
    const sidecar = new SidecarManager();
    const restorer = vi.fn(async () => {});
    sidecar.setDocumentRestorer(restorer);

    await sidecar.start();
    await sidecar.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(restorer).toHaveBeenCalledTimes(1);
  });

  it('runs the restorer again after a crash-triggered auto-restart', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();
    const restorer = vi.fn(async () => {});
    sidecar.setDocumentRestorer(restorer);

    try {
      await sidecar.start();
      expect(restorer).toHaveBeenCalledTimes(1);

      spawned[0].emit('exit', 1);
      expect(sidecar.isRunning()).toBe(false);

      await vi.advanceTimersByTimeAsync(CRASH_RESTART_DELAY_MS + 100);
      await flushMicrotasks();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(restorer).toHaveBeenCalledTimes(2);
      expect(sidecar.isRunning()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the restorer once on a manual restart (and not twice)', async () => {
    const sidecar = new SidecarManager();
    const restorer = vi.fn(async () => {});
    sidecar.setDocumentRestorer(restorer);

    await sidecar.start();
    expect(restorer).toHaveBeenCalledTimes(1);

    await sidecar.restart();
    await flushMicrotasks();

    expect(restorer).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe('SidecarManager start coalescing', () => {
  it('spawns once for concurrent start() calls', async () => {
    const sidecar = new SidecarManager();
    const restorer = vi.fn(async () => {});
    sidecar.setDocumentRestorer(restorer);

    await Promise.all([sidecar.start(), sidecar.start(), sidecar.start()]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(restorer).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh attempt after a failed attempt settles', async () => {
    const sidecar = new SidecarManager();
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      queueMicrotask(() => proc.emit('error', new Error('ENOENT')));
      return proc;
    });

    await expect(sidecar.start()).rejects.toThrow('Failed to start sidecar: ENOENT');
    expect(sidecar.isRunning()).toBe(false);

    await sidecar.start();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sidecar.isRunning()).toBe(true);
  });
});

describe('SidecarManager.stop during an in-flight start', () => {
  it('kills the spawning process, settles the start and leaves nothing running', async () => {
    const sidecar = new SidecarManager();
    // This process never emits the ready signal, so it stays in the spawn
    // window where `this.process` is still null.
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      return proc;
    });

    const starting = sidecar.start();
    const spawning = spawned[0];
    expect(sidecar.isRunning()).toBe(false);

    const stopping = sidecar.stop();

    // The killed start must not resolve into a running sidecar.
    await expect(starting).rejects.toThrow(/before ready signal/);
    await stopping;

    expect(spawning.kill).toHaveBeenCalledTimes(1);
    expect(spawning.killed).toBe(true);
    expect(sidecar.isRunning()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1); // no orphan spawn

    // The pending-process slot was released, so an explicit start still works.
    await sidecar.start();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sidecar.isRunning()).toBe(true);
  });
});

describe('SidecarManager.send self-healing', () => {
  it('starts the sidecar when the process is already down, then writes', async () => {
    const sidecar = new SidecarManager();
    // Keep the crash-restart timer out of this test's way.
    sidecar.enableAutoRestart(false);

    await sidecar.start();
    spawned[0].emit('exit', 1);
    expect(sidecar.isRunning()).toBe(false);

    const pending = sidecar.send('extract_page', { page: 3 });
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const revived = spawned[1];
    const [request] = revived.requests();
    expect(request.method).toBe('extract_page');
    expect(request.params).toEqual({ page: 3 });

    revived.emitResponse(request.id, { pages: 1 });
    await expect(pending).resolves.toEqual({ pages: 1 });
  });

  it('coalesces concurrent sends after a crash onto a single start', async () => {
    const sidecar = new SidecarManager();
    sidecar.enableAutoRestart(false);

    await sidecar.start();
    spawned[0].emit('exit', 1);

    const first = sidecar.send('extract_metadata');
    const second = sidecar.send('analyze_fonts');
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const revived = spawned[1];
    const requests = revived.requests();
    expect(requests).toHaveLength(2);
    const byMethod = new Map(requests.map((request) => [request.method, request]));
    revived.emitResponse(byMethod.get('extract_metadata')!.id, { a: 1 });
    revived.emitResponse(byMethod.get('analyze_fonts')!.id, { b: 2 });

    await expect(first).resolves.toEqual({ a: 1 });
    await expect(second).resolves.toEqual({ b: 2 });
  });

  it('throws the start error when the restart attempt fails', async () => {
    const sidecar = new SidecarManager();
    sidecar.enableAutoRestart(false);

    await sidecar.start();
    spawned[0].emit('exit', 1);

    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      queueMicrotask(() => proc.emit('error', new Error('spawn failed')));
      return proc;
    });

    await expect(sidecar.send('extract_page', { page: 1 })).rejects.toThrow(
      'Failed to start sidecar: spawn failed',
    );
  });

  it('does not resurrect the sidecar from stop()', async () => {
    const sidecar = new SidecarManager();

    await sidecar.start();
    await sidecar.stop();

    expect(sidecar.isRunning()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // stop() must talk to the live process instead of starting a new one.
    expect(spawned[0].requests().map((r) => r.method)).toEqual(['shutdown']);
  });

  it('refuses to self-heal after an intentional stop()', async () => {
    const sidecar = new SidecarManager();

    await sidecar.start();
    await sidecar.stop();

    await expect(sidecar.send('extract_page', { page: 1 })).rejects.toThrow(
      'Sidecar is not running',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('SidecarManager.stop bounded shutdown', () => {
  it('exports a 3s default budget for the quit path', () => {
    expect(DEFAULT_STOP_TIMEOUT_MS).toBe(3000);
  });

  it('bounds stop() when the sidecar never answers shutdown', async () => {
    const sidecar = new SidecarManager();
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      queueMicrotask(() => proc.emitReady());
      return makeUnresponsive(proc);
    });

    await sidecar.start();
    expect(sidecar.isRunning()).toBe(true);

    // A request the sidecar will never answer: it must not survive the stop.
    const inFlight = sidecar.send('extract_page', { page: 2 });
    const rejection = expect(inFlight).rejects.toThrow('Sidecar stopped');

    const startedAt = Date.now();
    await expect(sidecar.stop(STOP_TIMEOUT_MS)).resolves.toBeUndefined();
    const elapsed = Date.now() - startedAt;

    // It waited for the injected budget instead of the 30s request timeout...
    expect(elapsed).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS - 10);
    // ...and did not hang, which is what froze app.quit().
    expect(elapsed).toBeLessThan(2000);

    expect(spawned[0].kill).toHaveBeenCalled();
    expect(sidecar.isRunning()).toBe(false);
    await rejection;
  });

  it('keeps a late exit event after stop() harmless', async () => {
    const sidecar = new SidecarManager();
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      queueMicrotask(() => proc.emitReady());
      return makeUnresponsive(proc);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await sidecar.start();
      await sidecar.stop(STOP_TIMEOUT_MS);
      expect(sidecar.isRunning()).toBe(false);

      // The child finally dies *after* stop() resolved: no double rejection, no
      // resurrected process, no crash-restart (auto-restart is disabled).
      spawned[0].emit('exit', 1);
      await flushMicrotasks();

      expect(sidecar.isRunning()).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await expect(sidecar.send('extract_page', { page: 1 })).rejects.toThrow(
        'Sidecar is not running',
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('bounds stop() when a pending start never becomes ready', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();

    try {
      spawnMock.mockImplementationOnce(() => {
        const proc = new FakeChildProcess();
        spawned.push(proc);
        // Never emits the ready signal and ignores kill(), so the start promise
        // would stay pending forever without the bounded wait.
        return makeUnresponsive(proc);
      });

      const starting = sidecar.start();
      // It may settle later (or never); the rejection must not escape as an
      // unhandled rejection.
      starting.catch(() => undefined);
      expect(sidecar.isRunning()).toBe(false);

      const stopping = sidecar.stop(STOP_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 10);
      await expect(stopping).resolves.toBeUndefined();

      expect(spawned[0].kill).toHaveBeenCalled();
      expect(sidecar.isRunning()).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1); // no orphan spawn

      // The dead attempt was released, so an explicit start() still spawns
      // instead of awaiting a promise that can never settle.
      await expect(sidecar.start()).resolves.toBeUndefined();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(sidecar.isRunning()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still shuts down gracefully and kills the child when it answers', async () => {
    const sidecar = new SidecarManager();
    await sidecar.start();

    await sidecar.stop(STOP_TIMEOUT_MS);

    expect(spawned[0].requests().map((r) => r.method)).toEqual(['shutdown']);
    expect(spawned[0].kill).toHaveBeenCalledTimes(1);
    expect(sidecar.isRunning()).toBe(false);
  });

  it('is idempotent: a second stop() shares the first one', async () => {
    const sidecar = new SidecarManager();
    await sidecar.start();
    makeUnresponsive(spawned[0]);

    const first = sidecar.stop(STOP_TIMEOUT_MS);
    const second = sidecar.stop(STOP_TIMEOUT_MS);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(sidecar.isRunning()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('SidecarManager per-request timeouts', () => {
  it('gives analyze_fonts 120s while other methods keep the 30s default', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();
    sidecar.enableAutoRestart(false);

    try {
      await sidecar.start();

      const fonts = sidecar.send('analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS);
      const page = sidecar.send('extract_page', { page: 1 });

      let fontsSettled = false;
      let pageSettled = false;
      void fonts.then(
        () => { fontsSettled = true; },
        () => { fontsSettled = true; },
      );
      void page.then(
        () => { pageSettled = true; },
        () => { pageSettled = true; },
      );

      const fontsRejection = expect(fonts).rejects.toThrow(
        'Request "analyze_fonts" timed out after 120s',
      );
      const pageRejection = expect(page).rejects.toThrow(
        'Request "extract_page" timed out after 30s',
      );

      // At the default budget only the ordinary request has failed.
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
      await pageRejection;
      expect(pageSettled).toBe(true);
      expect(fontsSettled).toBe(false);

      // Font analysis keeps waiting until its own (longer) budget runs out.
      await vi.advanceTimersByTimeAsync(ANALYZE_FONTS_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS);
      await fontsRejection;
      expect(fontsSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours an explicit per-request timeout', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();
    sidecar.enableAutoRestart(false);

    try {
      await sidecar.start();

      const request = sidecar.send('extract_page', { page: 1 }, 5_000);
      const rejection = expect(request).rejects.toThrow(
        'Request "extract_page" timed out after 5s',
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SidecarManager restart after stop', () => {
  it('does not spawn when restart() follows stop()', async () => {
    const sidecar = new SidecarManager();

    await sidecar.start();
    await sidecar.stop();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await expect(sidecar.restart()).rejects.toThrow('Sidecar is stopping');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(sidecar.isRunning()).toBe(false);
  });

  it('rejects a restart() that races an in-flight stop()', async () => {
    const sidecar = new SidecarManager();
    spawnMock.mockImplementationOnce(() => {
      const proc = new FakeChildProcess();
      spawned.push(proc);
      queueMicrotask(() => proc.emitReady());
      return makeUnresponsive(proc);
    });

    await sidecar.start();

    const stopping = sidecar.stop(STOP_TIMEOUT_MS);
    // stop() wrote its guards synchronously, so the interleaving restart is
    // refused before it can spawn anything.
    await expect(sidecar.restart()).rejects.toThrow('Sidecar is stopping');
    await stopping;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(sidecar.isRunning()).toBe(false);
  });

  it('does not spawn when stop() starts while restart() is shutting down', async () => {
    const sidecar = new SidecarManager();
    await sidecar.start();

    const proc = spawned[0];
    // Answer `shutdown` slowly, so the stop() below lands while the restart is
    // still waiting for the old process to go away.
    proc.stdin.write.mockImplementation((raw: string) => {
      const request = JSON.parse(raw) as WrittenRequest;
      if (request.method === 'shutdown') {
        setTimeout(() => proc.emitResponse(request.id, {}), 20);
      }
      return true;
    });

    const restarting = sidecar.restart();
    const stopping = sidecar.stop(STOP_TIMEOUT_MS);

    await expect(restarting).rejects.toThrow('Sidecar is stopping');
    await expect(stopping).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(sidecar.isRunning()).toBe(false);
  });

  it('does not spawn when a pending start settles after stop() resolved', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();

    try {
      spawnMock.mockImplementationOnce(() => {
        const proc = new FakeChildProcess();
        spawned.push(proc);
        // Never ready and never exits: only the 10s ready timeout settles it.
        return makeUnresponsive(proc);
      });

      const starting = sidecar.start();
      starting.catch(() => undefined);

      // The restart waits for the in-flight start, which outlives the stop.
      const restartRejection = expect(sidecar.restart()).rejects.toThrow(
        'Sidecar is stopping',
      );

      const stopping = sidecar.stop(STOP_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 10);
      await expect(stopping).resolves.toBeUndefined();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // The abandoned start settles long after stop() resolved; the restart
      // waiting on it must not resurrect the sidecar.
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
      await restartRejection;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(sidecar.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
