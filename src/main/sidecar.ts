import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { resolvePythonCommand } from '../shared/python-resolver';
import * as path from 'path';
import * as fs from 'fs';

export interface SidecarCommandOptions {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
}

/**
 * Decide what to spawn for the sidecar.
 * Packaged: the PyInstaller-frozen binary shipped under resourcesPath/sidecar/.
 * Development: the resolved Python command + sidecar/main.py (prefers the
 * repo layout, falls back to the resources layout — caller validates).
 */
export function resolveSidecarCommand(opts: SidecarCommandOptions): {
  command: string;
  args: string[];
} {
  if (opts.isPackaged) {
    if (opts.platform !== 'win32' && opts.platform !== 'linux' && opts.platform !== 'darwin') {
      console.warn(`[sidecar] Unknown platform "${opts.platform}"; using non-Windows binary name`);
    }
    const binary = opts.platform === 'win32' ? 'pdf-inspector-sidecar.exe' : 'pdf-inspector-sidecar';
    return { command: path.join(opts.resourcesPath, 'sidecar', binary), args: [] };
  }

  const devScript = path.join(__dirname, '../../sidecar/main.py');
  const bundledScript = path.join(opts.resourcesPath, 'sidecar/main.py');
  const scriptPath = fs.existsSync(devScript)
    ? devScript
    : fs.existsSync(bundledScript)
      ? bundledScript
      : devScript; // caller validates existence and reports the error
  const { command, args } = resolvePythonCommand();
  return { command, args: [...args, scriptPath] };
}

export interface SidecarRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface SidecarResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** Default timeout for a JSON-RPC request (30s). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the graceful quit path.
 *
 * `app.quit()` is deferred until `stop()` resolves, so an unresponsive sidecar
 * (one that stopped reading stdin but is still alive) must not be able to hold
 * the app open for the duration of a request timeout plus a start timeout.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 3_000;

/** Render a timeout the way the request error message expects it. */
function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

export class SidecarManager {
  private process: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  private autoRestartEnabled = true;
  /** True while a delayed restart is scheduled; prevents concurrent restart attempts. */
  private restarting = false;
  /** Delay before auto-restart to avoid CPU spin on rapid crash cycles. */
  private static readonly RESTART_DELAY_MS = 500;
  /** In-flight start attempt so concurrent start() calls share one spawn. */
  private startPromise: Promise<void> | null = null;
  /**
   * The child process of an in-flight start, tracked from `spawn()` until it
   * settles. `process` is null until the ready signal, so `stop()` needs this
   * to be able to cancel a start that is still in its spawn window.
   */
  private pendingProcess: ChildProcess | null = null;
  /** Hook that re-opens the current document on a freshly started sidecar. */
  private documentRestorer: (() => Promise<void>) | null = null;
  /** True while the restorer runs; prevents re-entrant restoration. */
  private restoringDocument = false;
  /**
   * True after an intentional stop(). Blocks `send()` from self-healing so a
   * request arriving during quit cannot resurrect the process being shut down.
   */
  private intentionallyStopped = false;
  /**
   * True from the moment `stop()` begins and kept set afterwards, so a
   * `restart()` racing with — or following — a stop cannot spawn a new sidecar.
   * An explicit `start()` lifts it again (see `start()`).
   */
  private stopping = false;
  /** The in-flight `stop()` call, if any; makes repeated stops idempotent. */
  private stopPromise: Promise<void> | null = null;

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  enableAutoRestart(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
  }

  /** Reject all in-flight requests with the given error. */
  private rejectPendingRequests(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  /**
   * Schedule a delayed restart. Uses a boolean guard (not a promise-reference
   * comparison) to prevent re-entry, and a bounded 500ms timeout to avoid
   * CPU-spin crash loops.
   */
  private restartAfterCrash(): void {
    if (!this.autoRestartEnabled || this.restarting || this.isRunning()) return;

    this.restarting = true;
    console.log('[sidecar] Auto-restarting in 500ms...');
    setTimeout(() => {
      // Double-check: stop() may have been called while the timeout was pending
      if (!this.autoRestartEnabled) {
        this.restarting = false;
        return;
      }
      this.start()
        .catch((err) => console.error('[sidecar] Restart failed:', err))
        .finally(() => {
          this.restarting = false;
        });
    }, SidecarManager.RESTART_DELAY_MS);
  }

  /**
   * Register a hook that restores the open document on a freshly started
   * sidecar (initial boot, crash restart and manual restart all funnel through
   * `start()`). Pass `null` to detach.
   *
   * The hook is optional: with no restorer registered, `start()` behaves
   * exactly as before. Errors thrown by the restorer are logged, never
   * propagated, so a failed restore cannot mark a start as failed.
   */
  setDocumentRestorer(restorer: (() => Promise<void>) | null): void {
    this.documentRestorer = restorer;
  }

  /**
   * Invoke the document restorer once, guarding against recursion (the
   * restorer itself calls `send()`, which can attempt a start) and against
   * running when there is nothing to restore into.
   */
  private async restoreDocument(): Promise<void> {
    const restorer = this.documentRestorer;
    if (!restorer || this.restoringDocument || !this.isRunning()) return;

    this.restoringDocument = true;
    try {
      await restorer();
    } catch (err) {
      console.error('[sidecar] Failed to restore open document:', err);
    } finally {
      this.restoringDocument = false;
    }
  }

  /**
   * Start the sidecar subprocess and restore the open document.
   *
   * Concurrent callers coalesce onto the same in-flight attempt, so a burst of
   * requests after a crash spawns exactly one process. The returned promise
   * resolves only once the sidecar is ready AND the restorer has finished, so
   * a request issued right after start never overtakes the `open` call.
   */
  start(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();

    // A stop() is tearing the process down right now; spawning here would race
    // the teardown and could leave an orphaned child behind after quit.
    if (this.stopPromise) return Promise.reject(new Error('Sidecar is stopping'));

    // An explicit start (boot or restart) lifts the post-stop() guards.
    this.intentionallyStopped = false;
    this.stopping = false;

    const inFlight = this.startPromise;
    if (inFlight) return inFlight;

    const attempt = this.spawnSidecar().then(() => this.restoreDocument());
    this.startPromise = attempt;

    // Clear the slot on settle without delaying the returned promise, so every
    // caller observes the same resolution order.
    const clear = () => {
      if (this.startPromise === attempt) {
        this.startPromise = null;
      }
    };
    attempt.then(clear, clear);

    return attempt;
  }

  /**
   * Spawn the Python sidecar subprocess.
   *
   * The returned promise resolves only after the sidecar emits its one-time
   * JSON ready signal (`{"ready":true}`) on stdout — NOT at process spawn.
   * A 10-second timeout rejects the promise if the ready signal never arrives.
   */
  private async spawnSidecar(): Promise<void> {
    // A prior process may have exited after writing a partial stdout line.
    // Do not let it corrupt the new process's ready signal.
    this.buffer = '';

    const isPackaged = app.isPackaged;
    const { command, args } = resolveSidecarCommand({
      isPackaged,
      resourcesPath: process.resourcesPath ?? '',
      platform: process.platform,
    });

    if (isPackaged) {
      if (!fs.existsSync(command)) {
        throw new Error(`Sidecar binary missing at ${command}. Reinstall the application.`);
      }
    } else {
      const scriptPath = args[args.length - 1];
      if (!fs.existsSync(scriptPath)) {
        throw new Error('Cannot find sidecar/main.py');
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let startSettled = false;

      // Track the process before the ready signal so stop() can cancel a start
      // that is still in its spawn window (this.process is null until ready).
      this.pendingProcess = proc;

      // Timeout: if ready signal not received within 10s, reject the start promise
      const readyTimeout = setTimeout(() => {
        if (startSettled) return;
        settleStart(new Error('Sidecar ready signal timeout after 10s'));
        proc.kill();
      }, 10000);

      /**
       * Settle the start promise exactly once.
       * Called either by the ready-signal check (success) or by `error`/`exit`
       * events (failure). Clears the ready timeout, releases the pending-process
       * slot and sets `this.process` on success.
       */
      const settleStart = (err?: Error) => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimeout);
        if (this.pendingProcess === proc) this.pendingProcess = null;
        if (err) {
          if (this.process === proc) this.process = null;
          reject(err);
        } else {
          this.process = proc;
          resolve();
        }
      };

      proc.on('error', (err) => {
        settleStart(new Error(`Failed to start sidecar: ${err.message}`));
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            // Ready signal check — before start settles, this is the only expected line
            if (parsed.ready === true) {
              settleStart();
              continue;
            }

            // Normal JSON-RPC response parsing (only triggers after start settles)
            const pending = this.pending.get(parsed.id);
            if (pending) {
              this.pending.delete(parsed.id);
              if (parsed.error) {
                pending.reject(new Error(parsed.error));
              } else {
                pending.resolve(parsed.result);
              }
            }
          } catch {
            // Malformed JSON line — ignore
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        console.error(`[sidecar] ${data.toString().trim()}`);
      });

      proc.on('exit', (code) => {
        clearTimeout(readyTimeout);
        console.log(`[sidecar] exited with code ${code}`);

        // If start hasn't settled yet, the process died before the ready signal
        if (!startSettled) {
          settleStart(new Error(`Sidecar exited with code ${code} before ready signal`));
        }

        this.rejectPendingRequests(new Error(`Sidecar exited with code ${code}`));
        if (this.pendingProcess === proc) {
          this.pendingProcess = null;
        }
        if (this.process === proc) {
          this.process = null;
        }

        // Auto-restart unless shutdown was intentional (stop() sets autoRestartEnabled = false)
        if (this.autoRestartEnabled && code !== 0) {
          this.restartAfterCrash();
        }
      });

    });
  }

  /**
   * Send a JSON-RPC request to the sidecar.
   *
   * If the process is not running (silent crash, already-exited process) the
   * manager makes one attempt to start it before writing, so the caller heals
   * without needing the renderer's timeout-driven retry. If that start fails,
   * the start error propagates to the caller.
   *
   * `timeoutMs` bounds this single request; methods that legitimately take
   * longer than the default (font analysis) pass a larger value. It is
   * per-call, so one channel cannot relax the timeout of another.
   */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.isRunning()) {
      if (this.intentionallyStopped) {
        // stop() is tearing the process down; never resurrect it here.
        throw new Error('Sidecar is not running');
      }

      if (this.restoringDocument) {
        // The process died while the open document was being restored. Starting
        // again here would await our own in-flight start() promise (deadlock);
        // the crash handler schedules a fresh, restoring start instead.
        throw new Error('Sidecar is not running');
      }

      await this.start();

      if (!this.isRunning()) {
        throw new Error('Sidecar is not running');
      }
    }

    return this.writeRequest(method, params, timeoutMs);
  }

  /**
   * Write a JSON-RPC request to the current process and await its response.
   * Deliberately does not start the sidecar: `stop()`/`restart()` must never
   * resurrect the process they are tearing down.
   *
   * The request timer is always cleared when the request settles — including
   * when `stop()` rejects it — so no timer outlives its request.
   */
  private writeRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    const request: SidecarRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${formatTimeout(timeoutMs)}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      try {
        this.process?.stdin?.write(JSON.stringify(request) + '\n');
      } catch (err) {
        // A broken pipe must reject this request instead of escaping the
        // executor and leaving a registered (and timed) pending entry behind.
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Await `promise` for at most `timeoutMs`, swallowing its outcome.
   *
   * Returns true when the promise settled in time and false when the timeout
   * won. Both the promise and the timer are always observed, so a rejection
   * arriving later (e.g. the killed start's "exited before ready signal") is
   * handled here instead of surfacing as an unhandled rejection, and the timer
   * is cleared on the settled path so it never outlives the wait.
   */
  private static async settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    const settled = promise.then(
      () => true,
      () => true,
    );

    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Kill every process reference the manager still holds and forget it.
   *
   * References are dropped before `kill()` so a synchronously delivered `exit`
   * event (or one arriving after `stop()` resolved) only ever sees identity
   * checks that no longer match — no double rejection, no resurrected state.
   */
  private terminateProcesses(): void {
    const processes = [this.pendingProcess, this.process];
    this.pendingProcess = null;
    this.process = null;

    for (const proc of processes) {
      if (!proc || proc.killed) continue;
      try {
        proc.kill();
      } catch (err) {
        console.error('[sidecar] Failed to kill sidecar process:', err);
      }
    }
  }

  /**
   * Bounded graceful shutdown: `app.quit()` waits on this, so every await is
   * capped by a single budget of `timeoutMs`.
   */
  private async performStop(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const remaining = (): number => Math.max(0, deadline - Date.now());

    try {
      // Cancel a start that is still in its spawn/ready window: `this.process`
      // is null until the ready signal, so an isRunning() check alone would
      // leave the freshly spawned process alive after quit.
      const pendingProcess = this.pendingProcess;
      if (pendingProcess && !pendingProcess.killed) {
        try {
          pendingProcess.kill();
        } catch {
          // Already gone; the bounded wait below still settles the start.
        }
      }

      const startingPromise = this.startPromise;
      if (startingPromise) {
        // The killed start rejects ("exited before ready signal") or never
        // settles at all if the child ignores the signal — bound both.
        const settled = await SidecarManager.settledWithin(startingPromise, remaining());
        if (!settled && this.startPromise === startingPromise) {
          // Drop the dead attempt so an explicit start() after this stop does
          // not await a promise that can never settle.
          this.startPromise = null;
        }
      }

      const proc = this.process;
      if (proc && !proc.killed) {
        // Graceful shutdown shares the same budget: an unresponsive sidecar
        // (alive but no longer reading stdin) cannot hold the app open.
        await SidecarManager.settledWithin(
          this.writeRequest('shutdown', {}, remaining()),
          remaining(),
        );
      }
    } finally {
      // Forcible teardown, whether the graceful path succeeded, failed or timed
      // out: the app is quitting, so nothing may keep running.
      this.terminateProcesses();
      this.rejectPendingRequests(new Error('Sidecar stopped'));
    }
  }

  /**
   * Stop the sidecar. Never rejects and never hangs: both the in-flight start
   * and the graceful `shutdown` response are bounded by `timeoutMs`, after
   * which the child is killed unconditionally.
   */
  async stop(timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    // These flags are written synchronously (before any await) so a
    // crash-restart timer scheduled earlier cannot spawn a new process, and a
    // restart() interleaving with this stop cannot spawn one either.
    this.autoRestartEnabled = false;
    this.intentionallyStopped = true;
    this.stopping = true;

    const inFlight = this.stopPromise;
    if (inFlight) {
      await inFlight;
      return;
    }

    const operation = this.performStop(timeoutMs).catch((err: unknown) => {
      // `performStop()` tears down in a `finally`; this is belt and braces so a
      // throwing kill/teardown can never make the quit path reject.
      console.error('[sidecar] Shutdown failed, killing sidecar:', err);
      this.terminateProcesses();
      this.rejectPendingRequests(new Error('Sidecar stopped'));
    });
    this.stopPromise = operation;

    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) {
        this.stopPromise = null;
      }
    }
  }

  /**
   * Restart the sidecar subprocess and wait for its ready signal.
   * Pending requests are rejected so callers do not wait on the old process.
   * The registered document restorer runs once, inside `start()`.
   *
   * A restart that races with `stop()` (or follows it) is refused: the quit
   * path must not resurrect the sidecar it is tearing down.
   */
  async restart(): Promise<void> {
    if (this.stopping) {
      throw new Error('Sidecar is stopping');
    }

    this.autoRestartEnabled = false;
    this.restarting = true;

    try {
      // Let an in-flight start settle first: otherwise start() below would hand
      // back the very attempt we are about to kill, and the restart would
      // resolve with no running process.
      if (this.startPromise) {
        await this.startPromise.catch(() => undefined);
      }

      if (this.isRunning()) {
        try {
          await this.writeRequest('shutdown', {});
        } catch {
          // The process may already be unhealthy; force it to stop below.
        }
        this.process?.kill();
        this.process = null;
      }

      this.rejectPendingRequests(new Error('Sidecar is restarting'));

      // stop() may have begun while the old process was shutting down; spawning
      // now would resurrect the sidecar the quit path is tearing down.
      if (this.stopping) {
        throw new Error('Sidecar is stopping');
      }

      this.autoRestartEnabled = true;
      await this.start();
    } finally {
      this.restarting = false;
    }
  }
}
