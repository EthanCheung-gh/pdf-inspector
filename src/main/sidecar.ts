import { spawn, ChildProcess } from 'child_process';
import { resolvePythonCommand } from '../shared/python-resolver';
import * as path from 'path';
import * as fs from 'fs';

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
   * Start the Python sidecar subprocess.
   *
   * The returned promise resolves only after the sidecar emits its one-time
   * JSON ready signal (`{"ready":true}`) on stdout — NOT at process spawn.
   * A 10-second timeout rejects the promise if the ready signal never arrives.
   */
  async start(): Promise<void> {
    if (this.isRunning()) return;

    // A prior process may have exited after writing a partial stdout line.
    // Do not let it corrupt the new process's ready signal.
    this.buffer = '';

    // Resolve sidecar script path
    let scriptPath: string;
    if (fs.existsSync(path.join(__dirname, '../../sidecar/main.py'))) {
      scriptPath = path.join(__dirname, '../../sidecar/main.py');
    } else if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'sidecar/main.py'))) {
      scriptPath = path.join(process.resourcesPath, 'sidecar/main.py');
    } else {
      throw new Error('Cannot find sidecar/main.py');
    }

    return new Promise((resolve, reject) => {
      const { command, args } = resolvePythonCommand();
      const proc = spawn(command, [...args, scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let startSettled = false;

      // Timeout: if ready signal not received within 10s, reject the start promise
      const readyTimeout = setTimeout(() => {
        if (!startSettled) {
          startSettled = true;
          proc.kill();
          reject(new Error('Sidecar ready signal timeout after 10s'));
        }
      }, 10000);

      /**
       * Settle the start promise exactly once.
       * Called either by the ready-signal check (success) or by `error`/`exit`
       * events (failure). Clears the ready timeout and sets `this.process`.
       */
      const settleStart = (err?: Error) => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimeout);
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

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isRunning()) {
      throw new Error('Sidecar is not running');
    }

    const id = this.nextId++;
    const request: SidecarRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after 30s`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.process?.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  async stop(): Promise<void> {
    this.autoRestartEnabled = false;
    if (!this.isRunning()) return;
    try {
      await this.send('shutdown');
    } catch {
      // Ignore errors during shutdown
    }
    this.process?.kill();
    this.process = null;
  }
}
