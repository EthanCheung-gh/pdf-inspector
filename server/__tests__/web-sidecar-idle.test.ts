// @vitest-environment node
/**
 * The web backend's own `SidecarManager` (separate from the desktop one):
 * request budgets are INACTIVITY windows, so a diff that keeps reporting page
 * progress may run far longer than its budget, while silence still fails it.
 *
 * Spawning Python is impossible in a unit test, so `child_process.spawn` is
 * faked exactly like the desktop lifecycle suite does.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { SidecarManager } from '../web-server';

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
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
  });
  stdin = {
    writable: true,
    on: vi.fn(),
    write: vi.fn((raw: string, _encoding: string, callback: (error?: Error | null) => void) => {
      const request = JSON.parse(raw) as WrittenRequest;
      // The real sidecar answers `shutdown` so stop() does not block.
      if (request.method === 'shutdown') {
        queueMicrotask(() => this.emitResponse(request.id, {}));
      }
      callback(null);
      return true;
    }),
  };

  /** Emit the one-time ready line the manager waits for. */
  emitReady(): void {
    this.stdout.emit('data', Buffer.from('{"ready":true}\n'));
  }

  /** Emit a normal JSON-RPC response. */
  emitResponse(id: number, result: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, result })}\n`));
  }

  /** Emit a progress line (`{"id", "progress"}`) as a working request does. */
  emitProgress(id: number, progress: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, progress })}\n`));
  }

  requests(): WrittenRequest[] {
    return this.stdin.write.mock.calls.map((call) => JSON.parse(call[0] as string) as WrittenRequest);
  }
}

let spawned: FakeChildProcess[];

/** Let queued microtasks (spawn -> ready -> settle) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  spawned = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = new FakeChildProcess();
    spawned.push(proc);
    queueMicrotask(() => proc.emitReady());
    return proc;
  });
  // The manager logs lifecycle lines ("exited with signal …") on stop(); the
  // assertions never depend on them, so keep the suite output readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web SidecarManager inactivity budget', () => {
  it('keeps a diff pending while progress arrives and resolves on the response', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();

    try {
      await sidecar.start();
      const proc = spawned[0];

      const request = sidecar.send(
        'diff_documents',
        { old_path: '/tmp/a.pdf', new_path: '/tmp/b.pdf' },
        5_000,
      );
      let settled = false;
      void request.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      // stdin writes are queued, so let the write reach the (fake) child.
      await flushMicrotasks();

      const id = proc.requests().find((r) => r.method === 'diff_documents')?.id;
      expect(id).toBeTypeOf('number');

      // 4s of silence is inside the 5s window.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false);

      // A progress line restarts the window instead of settling the request.
      proc.emitProgress(id as number, { stage: 'pages', done: 0, total: 9 });
      await flushMicrotasks();

      // 8s total, 4s since the last progress report: still pending.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false);

      proc.emitProgress(id as number, { stage: 'pages', done: 1, total: 9 });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false);

      proc.emitResponse(id as number, { schemaVersion: 1 });
      await flushMicrotasks();

      await expect(request).resolves.toEqual({ schemaVersion: 1 });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    await sidecar.stop();
  });

  it('rejects a request that stays silent for the whole budget', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();

    try {
      await sidecar.start();

      const request = sidecar.send('diff_documents', {}, 5_000);
      const rejection = expect(request).rejects.toThrow(
        'Request "diff_documents" timed out after 5s without progress',
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    await sidecar.stop();
  });

  it('leaves ordinary responses on their own budget text', async () => {
    vi.useFakeTimers();
    const sidecar = new SidecarManager();

    try {
      await sidecar.start();

      const request = sidecar.send('extract_metadata');
      const rejection = expect(request).rejects.toThrow(
        'Request "extract_metadata" timed out after 30s without progress',
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    await sidecar.stop();
  });
});
