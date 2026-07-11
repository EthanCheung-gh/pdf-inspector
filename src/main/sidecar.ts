import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SIDECAR_SCRIPT } from '../shared/constants';

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
  private restartPromise: Promise<void> | null = null;

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  enableAutoRestart(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
  }

  private rejectPendingRequests(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private restartAfterCrash(): void {
    if (!this.autoRestartEnabled || this.restartPromise || this.isRunning()) return;

    console.log('[sidecar] Auto-restarting...');
    const restart = this.start();
    this.restartPromise = restart;
    restart
      .catch((err) => console.error('[sidecar] Restart failed:', err))
      .finally(() => {
        if (this.restartPromise === restart) {
          this.restartPromise = null;
        }
      });
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

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
      const proc = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let startSettled = false;

      proc.on('error', (err) => {
        if (this.process === proc) {
          this.process = null;
        }
        if (!startSettled) {
          startSettled = true;
          reject(new Error(`Failed to start sidecar: ${err.message}`));
        }
      });

      proc.once('spawn', () => {
        this.process = proc;
        startSettled = true;
        resolve();
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response: SidecarResponse = JSON.parse(line);
            const pending = this.pending.get(response.id);
            if (pending) {
              this.pending.delete(response.id);
              if (response.error) {
                pending.reject(new Error(response.error));
              } else {
                pending.resolve(response.result);
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
        console.log(`[sidecar] exited with code ${code}`);
        this.rejectPendingRequests(new Error(`Sidecar exited with code ${code}`));
        if (this.process === proc) {
          this.process = null;
        }

        // Auto-restart unless shutdown was intentional
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
