/**
 * Self-contained HTTP backend for the browser build of PDF Inspector.
 *
 * The Electron main process owns dialogs, app lifecycle and IPC; this server
 * offers the same document/sidecar capabilities over plain HTTP so the React
 * renderer can run in a normal browser:
 *
 *   - manages the Python JSON-RPC sidecar (spawn, timeouts, restart, cleanup);
 *   - keeps a bounded registry of open documents (uploaded, downloaded or
 *     local), of which exactly one is active in the sidecar, and streams any
 *     registered document back with Range support for pdf.js;
 *   - proxies the whitelisted sidecar methods;
 *   - serves the built renderer from dist-web and demo PDFs from web-samples.
 *
 * It deliberately reuses src/main/pdf-url.ts (Electron-free) for URL handling,
 * and has no Electron imports or npm dependencies beyond Node builtins.
 *
 * Run the bundled entry directly:
 *   node_modules/.bin/esbuild server/web-server.ts --bundle \
 *     --platform=node --format=esm --outfile=/tmp/web-server.mjs
 *   PORT=8080 node /tmp/web-server.mjs
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, open as openFile, stat, unlink } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import {
  cleanupDownloadedFiles,
  deleteDownloadedFile,
  downloadPdfToFile,
  parsePdfUrl,
} from '../src/main/pdf-url';
import {
  ACCESSIBILITY_TIMEOUT_MS,
  ANALYZE_FONTS_TIMEOUT_MS,
  AUDIT_TIMEOUT_MS,
  DIFF_TIMEOUT_MS,
  EXTRACT_PAGE_TIMEOUT_MS,
  OPEN_PDF_TIMEOUT_MS,
  RAW_TIMEOUT_MS,
  SECURITY_TIMEOUT_MS,
  SIDECAR_SCRIPT,
} from '../src/shared/constants';
import { diffOptionsToRpc } from '../src/shared/diff-types';
import type { DiffSide } from '../src/shared/diff-types';
import { isDiffTimeoutError, laneForMethod } from '../src/main/sidecar-pool';

// ---------------------------------------------------------------------------
// Layout / constants
// ---------------------------------------------------------------------------

/** Repository root. The bundled entry is documented to run from here. */
const ROOT = process.cwd();

const WEB_DIST_DIR = path.join(ROOT, 'dist-web');
const SAMPLE_DIR = path.join(ROOT, 'web-samples');

const WEB_TMP_ROOT = path.join(os.tmpdir(), 'pdf-inspector-web');
const UPLOAD_DIR = path.join(WEB_TMP_ROOT, 'uploads');
const DOWNLOAD_DIR = path.join(WEB_TMP_ROOT, 'downloads');
const DIFF_DIR = path.join(WEB_TMP_ROOT, 'diff');

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';

const START_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const PDF_HEADER_WINDOW_BYTES = 1024;
const PDF_MAGIC = '%PDF-';

/**
 * Diff uploads waiting for `POST /api/diff`: a browser has to upload both PDFs
 * before the sidecar can compare them. Bounds keep abandoned uploads (a user
 * who picks the old file and cancels) from filling the temp directory.
 */
const MAX_DIFF_UPLOADS = 16;
const MAX_DIFF_TOTAL_BYTES = 512 * 1024 * 1024;
const DIFF_UPLOAD_TTL_MS = 10 * 60_000;

/** Methods a browser client may invoke through POST /api/rpc. */
const RPC_ALLOWLIST = new Set([
  'extract_page',
  'extract_metadata',
  'analyze_fonts',
  'audit_document',
  'audit_pages',
  // Document security resources (read-only): attachments, JavaScript, actions,
  // signatures and encryption of the document already open here. Separate from
  // the audit, so a failed scan cannot affect an audit report.
  'security_document',
  // Tagged-PDF structure tree and accessibility findings (read-only): the
  // structure tree, RoleMap and ParentTree of the document already open here.
  // Separate from the audit, so a failed parse cannot affect an audit report.
  'accessibility_document',
  'get_image_data',
  // Raw PDF reading (read-only): the trailer roots, one indirect object and one
  // page's decoded content streams of the document already open here.
  'raw_document',
  'raw_object',
  'raw_page_content',
]);

/**
 * Per-method request budgets.
 *
 * Methods that walk or decode large parts of the document get a dedicated
 * budget; every other allowlisted method keeps the 30s default. Kept as a table
 * (not a growing ternary) so a new expensive method cannot silently inherit the
 * default and so the parity with the desktop handlers stays readable.
 *
 * `extract_page` is here for the same reason it has a budget in the desktop
 * handlers: one request extracts a whole page (tables included), which a single
 * complex page can stretch past 30s even though a normal page takes <0.1s.
 */
const RPC_TIMEOUTS: Record<string, number> = {
  extract_page: EXTRACT_PAGE_TIMEOUT_MS,
  analyze_fonts: ANALYZE_FONTS_TIMEOUT_MS,
  audit_document: AUDIT_TIMEOUT_MS,
  audit_pages: AUDIT_TIMEOUT_MS,
  security_document: SECURITY_TIMEOUT_MS,
  accessibility_document: ACCESSIBILITY_TIMEOUT_MS,
  raw_document: RAW_TIMEOUT_MS,
  raw_object: RAW_TIMEOUT_MS,
  raw_page_content: RAW_TIMEOUT_MS,
};

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** Uploaded files that have not been adopted by the document registry yet. */
const uploadedTempFiles = new Set<string>();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseContentLength(value: string | string[] | undefined): number | null {
  const raw = headerString(value);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

/** Human-readable byte size for limits in error messages (512 MiB, 1.5 MiB, ...). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mib = bytes / (1024 * 1024);
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

/** Resolve the Python used to launch sidecar/main.py. */
function resolvePythonCommand(): string {
  const override = process.env.PDF_INSPECTOR_PYTHON?.trim();
  if (override) return override;

  const candidates: string[] = [path.join(ROOT, '.venv', 'bin', 'python')];
  if (process.platform === 'win32') {
    candidates.push(path.join(ROOT, '.venv', 'Scripts', 'python.exe'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

/**
 * Delete a temporary file, best effort; `false` means it is still on disk.
 *
 * Windows cannot unlink a file another process has open, which is exactly what
 * the sidecar does with the document it currently extracted. Callers that own a
 * file the sidecar may still hold must keep it (see `DocumentRegistry`'s
 * pending deletions) instead of treating the failure as "already gone".
 */
async function removeTempFile(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    console.error(`[web] Failed to delete temporary file ${filePath}:`, error);
    return false;
  }
}

async function cleanupUploadedTempFiles(): Promise<void> {
  const files = [...uploadedTempFiles];
  uploadedTempFiles.clear();
  await Promise.all(files.map((file) => removeTempFile(file)));
}

/** A PDF reader accepts a BOM/preamble, so look in the first 1024 bytes. */
async function hasPdfMagic(filePath: string): Promise<boolean> {
  const handle = await openFile(filePath, 'r');
  try {
    const window = Buffer.alloc(PDF_HEADER_WINDOW_BYTES);
    const { bytesRead } = await handle.read(window, 0, window.length, 0);
    return window.subarray(0, bytesRead).includes(PDF_MAGIC);
  } finally {
    await handle.close();
  }
}

/**
 * Turn a user/header-supplied file name into a safe display name and basename.
 *
 * Unicode is preserved on purpose: a Chinese upload must keep its name in the
 * UI and in exported file names instead of becoming `_____.pdf`. Only path
 * separators and characters that are invalid on Windows (or control codes) are
 * replaced, so parent directories can never survive, and the result always ends
 * in `.pdf`.
 */
function sanitizeFileName(raw: unknown): string {
  const input = typeof raw === 'string' && raw.trim() ? raw : 'document.pdf';

  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Malformed percent-encoding: sanitize the raw text instead.
  }

  const base = decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    // Bidi overrides/isolates are invisible but reorder how the rest of the
    // name renders, so they are removed instead of replaced.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .trim()
    .replace(/^\.+/, '');

  const withoutExtension = cleaned.toLowerCase().endsWith('.pdf')
    ? cleaned.slice(0, -'.pdf'.length)
    : cleaned;
  // Truncate by code point, not UTF-16 unit: slicing in the middle of an emoji
  // would leave a lone surrogate, which cannot be URI-encoded or displayed.
  const stem = Array.from(withoutExtension.replace(/^\.+/, '')).slice(0, 100).join('');
  return `${stem || 'document'}.pdf`;
}

/** Derive a display name from the URL's last path segment. */
function nameFromUrl(url: URL): string {
  const lastSegment = url.pathname.split('/').pop() ?? '';
  return sanitizeFileName(lastSegment || 'document.pdf');
}

// ---------------------------------------------------------------------------
// Sidecar manager
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Current inactivity timer; replaced (not just restarted) on progress. */
  timer?: ReturnType<typeof setTimeout>;
  /**
   * Rearm this request's inactivity timer. Called for every progress line the
   * sidecar emits for the request, so a long diff of two large PDFs stays
   * pending while pages keep completing instead of hitting a total cap.
   */
  touch: () => void;
}

/**
 * JSON-RPC client for sidecar/main.py.
 *
 * Lifecycle notes:
 * - one child process at a time; `start()` coalesces concurrent callers;
 * - stdout is line-buffered; the first `{"ready":true}` line resolves start;
 * - `stdin` writes are serialized, but responses may arrive out of order;
 * - every request has an INACTIVITY budget (30s default; 120s for `open`,
 *   `extract_page`, analyze_fonts, both audit methods, `security_document`,
 *   `accessibility_document` and the raw readers; the diff endpoint passes
 *   300s). A progress line from the sidecar rearms the timer, so a long diff is
 *   bounded by silence rather than total time;
 * - an exit rejects all pending requests and clears the running state;
 * - `send()` lazily starts the sidecar once, unless stop() was requested;
 * - `restart()` shuts the old process down, spawns a new one and re-opens the
 *   tracked document.
 */
export class SidecarManager {
  private child: ChildProcess | null = null;
  private startingChild: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private writeQueue: Promise<void> = Promise.resolve();
  private documentPath: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private stopped = false;
  private stopping = false;

  constructor(private readonly rootDir: string = ROOT) {}

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  /** Remember the document a restarted/auto-started sidecar must re-open. */
  setDocumentPath(filePath: string | null): void {
    this.documentPath = filePath;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Start the sidecar unless it is already running. Coalesces concurrent calls. */
  start(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();
    if (this.stopping) return Promise.reject(new Error('Sidecar is stopping'));

    this.stopped = false;

    if (this.startPromise) return this.startPromise;

    const attempt = this.spawnSidecar();
    this.startPromise = attempt;

    const clear = (): void => {
      if (this.startPromise === attempt) this.startPromise = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private spawnSidecar(): Promise<void> {
    this.buffer = '';

    return new Promise<void>((resolve, reject) => {
      const command = resolvePythonCommand();
      let child: ChildProcess;
      try {
        child = spawn(command, [SIDECAR_SCRIPT], {
          cwd: this.rootDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
      } catch (error) {
        reject(new Error(`Failed to start sidecar (${command}): ${toErrorMessage(error)}`));
        return;
      }

      this.startingChild = child;
      // Decode across chunk boundaries: a multi-byte UTF-8 character (PDF text
      // is arbitrary Unicode) may be split between two stdout chunks.
      const decoder = new StringDecoder('utf8');

      let settled = false;
      const readyTimeout = setTimeout(() => {
        settle(new Error('Sidecar ready signal timed out after 15s'));
        if (!child.killed) child.kill();
      }, START_TIMEOUT_MS);

      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimeout);
        if (this.startingChild === child) this.startingChild = null;

        if (error) {
          if (this.child === child) this.child = null;
          reject(error);
          return;
        }

        this.child = child;
        resolve();
      };

      child.once('error', (error) => {
        settle(new Error(`Failed to start sidecar (${command}): ${error.message}`));
      });

      // A stdin stream error is reported to the writer callback; this listener
      // only prevents an unhandled 'error' event from crashing the server.
      child.stdin?.on('error', (error) => {
        console.error('[sidecar] stdin error:', error.message);
      });

      child.stdout?.on('data', (data: Buffer) => {
        this.buffer += decoder.write(data);
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let message: unknown;
          try {
            message = JSON.parse(trimmed);
          } catch {
            console.error(`[sidecar] Ignoring malformed stdout line: ${trimmed.slice(0, 200)}`);
            continue;
          }

          if (!isRecord(message)) continue;

          if (message.ready === true) {
            settle();
            continue;
          }

          const id = typeof message.id === 'number' ? message.id : null;
          if (id === null) continue;

          // Progress line: the request is still working, so its idle budget
          // starts over. It is not a response — the pending entry stays.
          if (message.progress !== undefined) {
            this.pending.get(id)?.touch();
            continue;
          }

          const pending = this.pending.get(id);
          if (!pending) continue; // Timed out or a request from a previous process.
          this.pending.delete(id);
          clearTimeout(pending.timer);

          if (typeof message.error === 'string') {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.result);
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8').trimEnd();
        if (text) console.error(`[sidecar] ${text}`);
      });

      child.once('exit', (code, signal) => {
        const wasCurrent = this.child === child;
        if (this.startingChild === child) this.startingChild = null;
        if (wasCurrent) this.child = null;

        const reason =
          signal !== null && signal !== undefined
            ? `Sidecar exited with signal ${signal}`
            : `Sidecar exited with code ${code ?? 'null'}`;

        if (!settled) {
          settle(new Error(`Sidecar exited before ready (${reason})`));
        }

        console.log(`[sidecar] ${reason}`);
        if (wasCurrent) this.rejectPendingRequests(new Error(reason));
      });
    });
  }

  /**
   * Serialize writes to the child's stdin. Only the write itself is queued;
   * requests may be in flight concurrently, so a long analyze_fonts call does
   * not block extract_page.
   */
  private writeLine(line: string): Promise<void> {
    const run = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const stdin = this.child?.stdin;
          if (!stdin || !stdin.writable || !this.isRunning()) {
            reject(new Error('Sidecar is not running'));
            return;
          }

          // A child that stopped reading stdin must not wedge the write queue.
          const guard = setTimeout(() => {
            reject(new Error('Timed out writing request to sidecar'));
          }, 5_000);

          stdin.write(line, 'utf8', (error) => {
            clearTimeout(guard);
            if (error) reject(error);
            else resolve();
          });
        }),
    );

    // Keep the chain healthy after a failed write.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.isRunning()) throw new Error('Sidecar is not running');

    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      // The budget is an inactivity window: every progress line for this id
      // rearms it (see the stdout handler), so a diff that keeps completing
      // pages is never cut off by total elapsed time.
      const expire = (): void => {
        this.pending.delete(id);
        reject(
          new Error(
            `Request "${method}" timed out after ${formatTimeout(timeoutMs)} without progress`,
          ),
        );
      };

      const entry: PendingRequest = {
        resolve,
        reject,
        touch: () => {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(expire, timeoutMs);
        },
      };
      entry.touch();
      this.pending.set(id, entry);
    });

    try {
      await this.writeLine(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    return response;
  }

  /**
   * Re-open the tracked document after a fresh spawn. Shared by concurrent
   * callers; failures are logged because a request that triggered the start
   * should still see the original operation's result.
   *
   * The restore is a full `open` (parse plus the sidecar's font-resource scan),
   * so it gets OPEN_PDF_TIMEOUT_MS rather than the 30s default: a large document
   * would otherwise look like a hung sidecar right after every restart.
   */
  private restoreDocument(): Promise<void> {
    const filePath = this.documentPath;
    if (!filePath || !this.isRunning()) return Promise.resolve();
    if (this.restorePromise) return this.restorePromise;

    const attempt = (async (): Promise<void> => {
      try {
        await this.writeRequest('open', { path: filePath }, OPEN_PDF_TIMEOUT_MS);
      } catch (error) {
        console.error('[sidecar] Failed to re-open current document:', toErrorMessage(error));
      }
    })();

    this.restorePromise = attempt;
    const clear = (): void => {
      if (this.restorePromise === attempt) this.restorePromise = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  /**
   * Send a request. If the sidecar is not running it is started once and the
   * current document is restored (unless the caller is opening a document,
   * which supersedes the restore).
   */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.isRunning()) {
      if (this.stopped || this.stopping) throw new Error('Sidecar is not running');

      await this.start();

      if (method !== 'open') await this.restoreDocument();
    }

    return this.writeRequest(method, params, timeoutMs);
  }

  /**
   * Stop the old process, spawn a new one and re-open the tracked document.
   * Pending requests on the old process are rejected. Concurrent calls share
   * one restart; a second one while it is running would otherwise kill the
   * process the first one is waiting for.
   */
  restart(): Promise<void> {
    if (this.stopping || this.stopPromise) {
      return Promise.reject(new Error('Sidecar is stopping'));
    }
    if (this.restartPromise) return this.restartPromise;

    const attempt = this.performRestart();
    this.restartPromise = attempt;

    const clear = (): void => {
      if (this.restartPromise === attempt) this.restartPromise = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private async performRestart(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    if (this.isRunning()) {
      try {
        await this.writeRequest('shutdown', {}, SHUTDOWN_TIMEOUT_MS);
      } catch {
        // The process may already be unresponsive; it is killed below.
      }
    }

    await this.killChild(new Error('Sidecar is restarting'));

    this.stopped = false;
    await this.start();
    await this.restoreDocument();
  }

  private async killChild(reason: Error): Promise<void> {
    const child = this.child;
    const starting = this.startingChild;
    this.child = null;
    this.startingChild = null;

    for (const proc of [starting, child]) {
      if (!proc || proc.killed) continue;
      try {
        proc.kill();
      } catch (error) {
        console.error('[sidecar] Failed to kill sidecar process:', error);
      }
    }

    this.rejectPendingRequests(reason);
  }

  /**
   * Graceful shutdown: ask the sidecar to exit, then kill it unconditionally.
   * Idempotent and never rejects. Kept separate from restart so the shutdown
   * signal cannot be undone by a racing request.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping = true;

    if (this.stopPromise) return this.stopPromise;

    const operation = (async (): Promise<void> => {
      // Cancel a spawn that is still waiting for its ready line: the reference
      // only lives in startingChild until start() resolves.
      const starting = this.startingChild;
      if (starting && !starting.killed) {
        try {
          starting.kill();
        } catch {
          // Already gone; awaiting the start promise below still settles it.
        }
      }

      if (this.startPromise) {
        await this.startPromise.catch(() => undefined);
      }

      if (this.isRunning()) {
        try {
          await this.writeRequest('shutdown', {}, SHUTDOWN_TIMEOUT_MS);
        } catch {
          // Best effort; kill below.
        }
      }

      await this.killChild(new Error('Sidecar stopped'));
    })();

    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = null;
      this.stopping = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Two-lane sidecar pool
// ---------------------------------------------------------------------------

export interface SidecarPoolOptions {
  /** Interactive lane. Defaults to a manager rooted at the repo. */
  interactive?: SidecarManager;
  /** Builds the lazy background lane on its first request. */
  createBackground?: () => SidecarManager;
}

/**
 * The browser backend's two-lane pool.
 *
 * Mirrors `src/main/sidecar-pool.ts`: the interactive lane owns page
 * navigation/opening, the background lane owns fonts/audit/security/
 * accessibility/raw/diff and is created lazily. Route selection comes from the
 * shared `laneForMethod`, so the desktop and web backends cannot drift.
 *
 * Difference from desktop: the web `SidecarManager` restores the tracked
 * document itself (`setDocumentPath` + `restoreDocument`), so the pool only has
 * to forward the path to both lanes. A background open is explicit (`send`
 * skips the restore for `open`), which is why a first background request starts
 * the lane and opens the current document exactly once.
 *
 * `/api/status` and `/api/restart` read `isRunning()` — the interactive lane —
 * so the observable HTTP contract is unchanged.
 */
export class SidecarPool {
  private readonly interactive: SidecarManager;
  private readonly createBackground: () => SidecarManager;

  private background: SidecarManager | null = null;
  private documentPath: string | null = null;
  private backgroundOpenedPath: string | null = null;
  /** Serialized background opens; the tail never rejects. */
  private backgroundSync: Promise<void> = Promise.resolve();

  constructor(options: SidecarPoolOptions = {}) {
    this.interactive = options.interactive ?? new SidecarManager(ROOT);
    this.createBackground = options.createBackground ?? (() => new SidecarManager(ROOT));
  }

  /** Interactive health, as reported by `/api/status`. */
  isRunning(): boolean {
    return this.interactive.isRunning();
  }

  isBackgroundRunning(): boolean {
    return this.background !== null && this.background.isRunning();
  }

  /** True once the lazy background lane has been created (running or not). */
  isBackgroundStarted(): boolean {
    return this.background !== null;
  }

  start(): Promise<void> {
    return this.interactive.start();
  }

  /**
   * Track the current document on both lanes. The web manager re-opens this
   * path after a spawn/restart, so a restarted lane keeps the document without
   * another explicit open from the pool.
   */
  setDocumentPath(filePath: string | null): void {
    const changed = this.documentPath !== filePath;
    this.documentPath = filePath;
    this.interactive.setDocumentPath(filePath);
    this.background?.setDocumentPath(filePath);

    if (filePath === null) {
      this.backgroundOpenedPath = null;
      return;
    }

    if (changed && this.background?.isRunning()) {
      this.scheduleBackgroundSync();
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === 'open') {
      return this.openDocument(params, timeoutMs);
    }
    if (laneForMethod(method) === 'background') {
      return this.sendBackground(method, params, timeoutMs);
    }
    return this.interactive.send(method, params, timeoutMs);
  }

  /**
   * Open on the interactive lane, then queue the same open on a *running*
   * background lane. Background failures stay isolated: they are logged and
   * retried by the next background request, never returned to the open caller.
   */
  private async openDocument(
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const filePath = typeof params.path === 'string' ? params.path : null;
    const openTimeout = timeoutMs ?? OPEN_PDF_TIMEOUT_MS;

    const result = await this.interactive.send('open', params, openTimeout);

    if (filePath !== null) {
      this.documentPath = filePath;
      // Keep the managers' restore path in sync even when the caller does not
      // go through DocumentRegistry::setDocumentPath afterwards.
      this.interactive.setDocumentPath(filePath);
      this.background?.setDocumentPath(filePath);

      if (this.background?.isRunning()) {
        this.scheduleBackgroundSync();
      }
    }

    return result;
  }

  private async sendBackground(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const background = this.ensureBackground();
    await this.enqueueBackgroundSync();
    return background.send(method, params, timeoutMs);
  }

  private ensureBackground(): SidecarManager {
    if (this.background) return this.background;

    const background = this.createBackground();
    background.setDocumentPath(this.documentPath);
    this.background = background;
    return background;
  }

  private scheduleBackgroundSync(): void {
    void this.enqueueBackgroundSync().catch((error) => {
      console.error('[web] Background document sync failed:', toErrorMessage(error));
    });
  }

  private enqueueBackgroundSync(): Promise<void> {
    const run = this.backgroundSync.then(() => this.syncBackgroundDocument());
    this.backgroundSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Await every queued background document open (diagnostics/tests). */
  whenBackgroundIdle(): Promise<void> {
    return this.backgroundSync;
  }

  private async syncBackgroundDocument(): Promise<void> {
    const background = this.background;
    if (!background) return;

    // Re-read the target every pass: a switch can land while the lane is being
    // started or while an open is in flight. Bounded because every pass either
    // confirms the current document or performs one open.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = this.documentPath;

      if (!background.isRunning()) {
        if (!target) {
          await background.start();
          return;
        }
        // An explicit `open` on a stopped lane starts it and skips the
        // manager's own restore, so the document is opened exactly once.
        await background.send('open', { path: target }, OPEN_PDF_TIMEOUT_MS);
        this.backgroundOpenedPath = target;
        continue;
      }

      if (!target || this.backgroundOpenedPath === target) return;

      await background.send('open', { path: target }, OPEN_PDF_TIMEOUT_MS);
      this.backgroundOpenedPath = target;
      return;
    }
  }

  /**
   * Restart both lanes. An interactive failure propagates (`/api/restart`
   * reports it); a background failure is logged so the interactive lane keeps
   * its previous behaviour.
   */
  async restart(): Promise<void> {
    await this.interactive.restart();

    const background = this.background;
    if (!background) return;

    await this.backgroundSync;
    this.backgroundOpenedPath = null;

    try {
      await background.restart();
      // performRestart() re-opens the tracked document on success.
      if (this.documentPath) this.backgroundOpenedPath = this.documentPath;
    } catch (error) {
      console.error('[web] Background sidecar restart failed:', toErrorMessage(error));
    }
  }

  /**
   * Restart the background lane only, after a diff timeout.
   *
   * The 300s budget is an inactivity window: when it expires the request is
   * rejected but the Python process may still be diffing the abandoned pair.
   * Replacing the background process frees that CPU/RAM and unblocks a retry;
   * the interactive lane is never touched. Bounded by the manager's own
   * shutdown (3s) and ready (15s) timeouts.
   */
  async restartBackground(): Promise<void> {
    const background = this.background;
    // No lane was ever created, so there is no orphan computation to kill.
    if (!background) return;

    // A document sync queued by an open must not race the restart; the stored
    // tail swallows failures, so waiting cannot reject.
    await this.backgroundSync.catch(() => undefined);
    this.backgroundOpenedPath = null;

    try {
      await background.restart();
      // The web manager re-opens the tracked document itself, so a successful
      // restart leaves the lane on `documentPath`.
      if (this.documentPath) this.backgroundOpenedPath = this.documentPath;
    } catch (error) {
      console.error('[web] Background sidecar restart failed:', toErrorMessage(error));
      throw error;
    }
  }

  /** Stop both lanes. Never rejects: this runs on the shutdown path. */
  async stop(): Promise<void> {
    // Invoke both synchronously so the managers mark themselves as stopping
    // before their first await (no spawn can slip in after the quit path).
    const background = this.background;
    const stops = [this.interactive.stop()];
    if (background) stops.push(background.stop());

    await Promise.allSettled(stops);
  }
}

// ---------------------------------------------------------------------------
// Document registry (bounded multi-document)
// ---------------------------------------------------------------------------

/** At most this many documents may be registered at once. */
export const MAX_DOCUMENTS = 8;
/** Total bytes of registered documents; the least recent inactive one goes first. */
export const MAX_DOCUMENT_TOTAL_BYTES = 512 * 1024 * 1024;

export interface OpenDocument {
  id: string;
  filePath: string;
  name: string;
  isTemp: boolean;
  size: number;
  /** Original URL for a downloaded document; `null` for uploads/local files. */
  sourceUrl: string | null;
  /** Sidecar `open` result, reused when the document is re-activated. */
  metadata: unknown;
  /**
   * Recency of the last activation. A monotonic counter (not wall clock), so
   * LRU eviction cannot be skewed by clock jumps and stays deterministic in
   * tests; only relative order matters.
   */
  lastActiveAt: number;
}

export interface OpenedDocument {
  metadata: unknown;
  doc: OpenDocument;
}

/** Result of `DocumentRegistry.openDeduped`. */
export interface DedupedOpenResult {
  /** The document that became (or already was) active. */
  opened: OpenedDocument;
  /**
   * True when the incoming `filePath` was NOT adopted: another registered
   * document already carried the same `sourceUrl`. The caller still owns that
   * file and has to delete it; `opened.doc.filePath` is the existing copy.
   */
  deduped: boolean;
}

export interface DocumentRegistryOptions {
  /** Bounds for tests; production uses MAX_DOCUMENTS / MAX_DOCUMENT_TOTAL_BYTES. */
  maxDocuments?: number;
  maxTotalBytes?: number;
}

export type DocumentRegistryErrorCode = 'not_found' | 'conflict' | 'too_large';

/**
 * Typed registry failure. The registry is transport-agnostic on purpose: HTTP
 * handlers map `code` to a status (404/409/413) instead of the registry
 * importing HTTP types.
 */
export class DocumentRegistryError extends Error {
  constructor(
    readonly code: DocumentRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentRegistryError';
  }
}

/**
 * Keeps the open documents the browser can address by id.
 *
 * The sidecar still holds exactly ONE document: `activeDocumentId` is the one
 * currently opened there, and switching = one serialized `sidecar.open` of the
 * target file. Everything else is file + metadata ownership.
 *
 * Invariants:
 * - every mutation runs through `enqueue`, so two opens/activates can never
 *   race the sidecar into an inconsistent state (`/api/rpc` only reads);
 * - the map is only touched after a successful sidecar open, so a failed
 *   operation leaves the previous active document addressable;
 * - a temp file is deleted only by the operation that owns it (close, LRU
 *   eviction, cleanup) — never by a sibling's open;
 * - a temp file whose unlink fails while the sidecar still holds it is queued
 *   in `pendingDeletions` and retried after the next successful open/activate
 *   (and again on cleanup), so Windows cannot leak it silently;
 * - the active document is never evicted; the registry evicts the least
 *   recently activated inactive document instead.
 */
export class DocumentRegistry {
  private readonly documents = new Map<string, OpenDocument>();
  private activeDocumentId: string | null = null;
  private recency = 0;
  private readonly maxDocuments: number;
  private readonly maxTotalBytes: number;
  /** Serializes every mutation; the tail never rejects. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Temp files this registry owns but could not unlink yet. Only the file's
   * extractor in the sidecar keeps them alive on Windows; once the next
   * open/activate replaces that extractor the retry succeeds.
   */
  private readonly pendingDeletions = new Set<string>();

  constructor(
    private readonly sidecar: SidecarPool,
    options: DocumentRegistryOptions = {},
  ) {
    this.maxDocuments = Math.max(1, options.maxDocuments ?? MAX_DOCUMENTS);
    this.maxTotalBytes = Math.max(1, options.maxTotalBytes ?? MAX_DOCUMENT_TOTAL_BYTES);
  }

  getActiveId(): string | null {
    return this.activeDocumentId;
  }

  getActive(): OpenDocument | null {
    const id = this.activeDocumentId;
    if (id === null) return null;
    return this.documents.get(id) ?? null;
  }

  /** @deprecated Use `getActive()`; kept while single-document callers migrate. */
  getCurrent(): OpenDocument | null {
    return this.getActive();
  }

  /** Registered documents, most recently activated first. Treat as read-only. */
  list(): OpenDocument[] {
    return [...this.documents.values()].sort(
      (left, right) => right.lastActiveAt - left.lastActiveAt,
    );
  }

  findById(id: string): OpenDocument | null {
    return this.documents.get(id) ?? null;
  }

  findBySourceUrl(url: string): OpenDocument | null {
    for (const doc of this.documents.values()) {
      if (doc.sourceUrl === url) return doc;
    }
    return null;
  }

  urlFor(doc: OpenDocument): string {
    return `/doc/${doc.id}/${encodeURIComponent(doc.name)}`;
  }

  /**
   * Open and activate a document, registering it on success.
   *
   * The caller owns `filePath` until this resolves: a rejected open leaves the
   * file untouched (the caller deletes its own garbage copy) and leaves the
   * registry exactly as it was, with the previous active document re-opened in
   * the sidecar when possible.
   */
  open(
    filePath: string,
    name: string,
    isTemp: boolean,
    size: number,
    sourceUrl: string | null = null,
  ): Promise<OpenedDocument> {
    return this.enqueue(() => this.performOpen(filePath, name, isTemp, size, sourceUrl));
  }

  /**
   * Open a document, de-duplicating by `sourceUrl` INSIDE the mutation queue.
   *
   * A URL handler cannot decide this before downloading: two requests for the
   * same URL both find an empty registry, both download, and both would then
   * register a document. The authoritative check therefore runs here, where it
   * is serialized with every other mutation, so at most one document per
   * `sourceUrl` can ever be registered.
   *
   * When a registered document already carries `sourceUrl`, `filePath` is
   * neither opened nor registered: the existing document is activated instead
   * (same semantics and failure recovery as `activate`) and `deduped` is true.
   * The caller keeps ownership of `filePath` and must delete it in both the
   * deduped and the rejected case.
   */
  openDeduped(
    filePath: string,
    name: string,
    isTemp: boolean,
    size: number,
    sourceUrl: string | null,
  ): Promise<DedupedOpenResult> {
    return this.enqueue(async () => {
      if (sourceUrl !== null) {
        const existing = this.findBySourceUrl(sourceUrl);
        if (existing) {
          return { opened: await this.performActivate(existing.id), deduped: true };
        }
      }

      return {
        opened: await this.performOpen(filePath, name, isTemp, size, sourceUrl),
        deduped: false,
      };
    });
  }

  /**
   * Make an already registered document the active one.
   *
   * Re-activating the active document returns its cached metadata and does not
   * touch the sidecar; switching opens the target file with the open budget.
   */
  activate(id: string): Promise<OpenedDocument> {
    return this.enqueue(() => this.performActivate(id));
  }

  /**
   * Close a document and delete its temporary copy.
   *
   * The active document can only be closed when it is the last one: the browser
   * must activate a neighbour first, which is what the `conflict` error is for.
   */
  close(id: string): Promise<{ closed: OpenDocument; activeDocumentId: string | null }> {
    return this.enqueue(() => this.performClose(id));
  }

  /**
   * Temp files whose unlink failed and that wait for a retry. Exposed for tests
   * and diagnostics: an empty set after the sidecar released its extractor means
   * every document this registry owned is gone from disk.
   */
  pendingDeletionPaths(): string[] {
    return [...this.pendingDeletions];
  }

  /** Delete every temporary document and clear the registry (server shutdown). */
  cleanup(): Promise<void> {
    return this.enqueue(async () => {
      const docs = [...this.documents.values()];
      this.documents.clear();
      this.activeDocumentId = null;
      this.sidecar.setDocumentPath(null);

      // Registered temp copies PLUS everything an earlier unlink could not
      // remove (a file the sidecar still held). Best effort: one undeletable
      // file must not keep the others alive, and a failure stays queued for the
      // next cleanup/shutdown attempt instead of being forgotten.
      const files = new Set<string>(this.pendingDeletions);
      for (const doc of docs) {
        if (doc.isTemp) files.add(doc.filePath);
      }
      await Promise.all([...files].map((file) => this.removeQueued(file)));
    });
  }

  // --- unlocked helpers (never take the queue themselves) -------------------

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(() => operation());
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private touch(doc: OpenDocument): void {
    this.recency += 1;
    doc.lastActiveAt = this.recency;
  }

  /**
   * Delete a temporary file this registry owns; queue it for a later retry when
   * the unlink fails (on Windows the sidecar may still hold the extractor).
   */
  private async removeQueued(filePath: string): Promise<void> {
    if (await removeTempFile(filePath)) {
      this.pendingDeletions.delete(filePath);
      return;
    }
    this.pendingDeletions.add(filePath);
  }

  /**
   * Retry every queued deletion. Called after a successful open/activate,
   * which released the extractor that kept the previous file alive.
   */
  private async retryPendingDeletions(): Promise<void> {
    if (this.pendingDeletions.size === 0) return;
    await Promise.all([...this.pendingDeletions].map((file) => this.removeQueued(file)));
  }

  /** `open` parses the document and scans its fonts, so it gets its own budget. */
  private sendOpen(filePath: string): Promise<unknown> {
    return this.sidecar.send('open', { path: filePath }, OPEN_PDF_TIMEOUT_MS);
  }

  /**
   * Best-effort restore of the document that was active before a failed
   * open/activate. A restore failure means the sidecar holds no document at
   * all, so the registry must stop claiming one is active (`/api/rpc` can then
   * answer "no active document" instead of forwarding to a stale path).
   * The map itself is untouched either way.
   */
  private async restoreActive(previous: OpenDocument | null): Promise<void> {
    if (!previous) {
      this.sidecar.setDocumentPath(null);
      return;
    }

    try {
      await this.sendOpen(previous.filePath);
      this.sidecar.setDocumentPath(previous.filePath);
    } catch (restoreError) {
      console.error('[web] Failed to re-open previous document:', toErrorMessage(restoreError));
      this.sidecar.setDocumentPath(null);
      if (this.activeDocumentId === previous.id) this.activeDocumentId = null;
    }
  }

  private async performOpen(
    filePath: string,
    name: string,
    isTemp: boolean,
    size: number,
    sourceUrl: string | null,
  ): Promise<OpenedDocument> {
    // Reject before touching the sidecar: the caller deletes its own copy and
    // the current view never flickers.
    if (size > this.maxTotalBytes) {
      throw new DocumentRegistryError(
        'too_large',
        `The PDF is larger than the ${formatBytes(this.maxTotalBytes)} document limit`,
      );
    }

    const previous = this.getActive();

    let metadata: unknown;
    try {
      metadata = await this.sendOpen(filePath);
    } catch (error) {
      await this.restoreActive(previous);
      throw error;
    }

    const doc: OpenDocument = {
      id: randomUUID(),
      filePath,
      name,
      isTemp,
      size,
      sourceUrl,
      metadata,
      lastActiveAt: 0,
    };
    this.documents.set(doc.id, doc);
    this.activeDocumentId = doc.id;
    this.touch(doc);
    this.sidecar.setDocumentPath(filePath);

    await this.evictOverflow();
    // The open above replaced the sidecar's extractor, so files queued by an
    // earlier failed unlink are deletable now.
    await this.retryPendingDeletions();

    return { metadata, doc };
  }

  private async performActivate(id: string): Promise<OpenedDocument> {
    const target = this.documents.get(id);
    if (!target) {
      throw new DocumentRegistryError('not_found', 'Document not found');
    }

    if (this.activeDocumentId === id) {
      this.touch(target);
      return { metadata: target.metadata, doc: target };
    }

    const previous = this.getActive();

    let metadata: unknown;
    try {
      metadata = await this.sendOpen(target.filePath);
    } catch (error) {
      await this.restoreActive(previous);
      throw error;
    }

    target.metadata = metadata;
    this.touch(target);
    this.activeDocumentId = id;
    this.sidecar.setDocumentPath(target.filePath);

    await this.evictOverflow();
    await this.retryPendingDeletions();

    return { metadata, doc: target };
  }

  private async performClose(
    id: string,
  ): Promise<{ closed: OpenDocument; activeDocumentId: string | null }> {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new DocumentRegistryError('not_found', 'Document not found');
    }

    const isActive = this.activeDocumentId === id;
    if (isActive && this.documents.size > 1) {
      throw new DocumentRegistryError(
        'conflict',
        'Activate another document before closing the active one',
      );
    }

    this.documents.delete(id);
    if (isActive) {
      // Closing the last document is allowed; the API layer turns the missing
      // active document into a 409 for `/api/rpc`.
      this.activeDocumentId = null;
      this.sidecar.setDocumentPath(null);
    }

    if (doc.isTemp) {
      // The last active document is still open in the sidecar's extractor, so
      // unlink can fail on Windows. Queue it instead of losing the path; the
      // next successful open/activate (or cleanup) retries.
      await this.removeQueued(doc.filePath);
    }

    return { closed: doc, activeDocumentId: this.activeDocumentId };
  }

  private totalBytes(): number {
    let total = 0;
    for (const doc of this.documents.values()) total += doc.size;
    return total;
  }

  /**
   * Evict least-recently-active INACTIVE documents until both bounds hold.
   * A bounded loop: every pass removes one entry, and the active document is
   * never a candidate, so the loop cannot spin when only the active doc is
   * oversized.
   */
  private async evictOverflow(): Promise<void> {
    while (
      this.documents.size > this.maxDocuments ||
      this.totalBytes() > this.maxTotalBytes
    ) {
      const victim = this.leastRecentlyActiveInactive();
      if (!victim) break;

      this.documents.delete(victim.id);
      console.log(
        `[web] Evicted document "${victim.name}" (${victim.id}) to stay within the open-document limits`,
      );
      if (victim.isTemp) await this.removeQueued(victim.filePath);
    }
  }

  private leastRecentlyActiveInactive(): OpenDocument | null {
    let victim: OpenDocument | null = null;
    for (const doc of this.documents.values()) {
      if (doc.id === this.activeDocumentId) continue;
      if (!victim || doc.lastActiveAt < victim.lastActiveAt) victim = doc;
    }
    return victim;
  }
}

// ---------------------------------------------------------------------------
// Diff upload tokens
// ---------------------------------------------------------------------------

export interface DiffUpload {
  /** Opaque single-use token handed to the browser. */
  token: string;
  filePath: string;
  side: DiffSide;
  name: string;
  size: number;
  createdAt: number;
}

export interface DiffUploadStoreOptions {
  directory?: string;
  maxUploads?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Short-lived storage for the two temporary PDFs of a browser diff.
 *
 * Deliberately separate from `DocumentRegistry`: uploading a diff side must
 * neither become nor replace the active document, and that document is exactly
 * what the Inspect view depends on. Tokens are single-use,
 * expire after `DIFF_UPLOAD_TTL_MS`, are capped in number AND total bytes
 * (oldest evicted) and every removal unlinks the temporary file.
 */
export class DiffUploadStore {
  private readonly uploads = new Map<string, DiffUpload>();
  private readonly directory: string;
  private readonly maxUploads: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DiffUploadStoreOptions = {}) {
    this.directory = path.resolve(options.directory ?? DIFF_DIR);
    this.maxUploads = Math.max(1, options.maxUploads ?? MAX_DIFF_UPLOADS);
    this.maxBytes = Math.max(1, options.maxBytes ?? MAX_DIFF_TOTAL_BYTES);
    this.ttlMs = Math.max(0, options.ttlMs ?? DIFF_UPLOAD_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.uploads.size;
  }

  /** Bytes held by all pending uploads. */
  get totalBytes(): number {
    let total = 0;
    for (const upload of this.uploads.values()) total += upload.size;
    return total;
  }

  /** Directory the temporary diff PDFs are written to (tests/ops). */
  get directoryPath(): string {
    return this.directory;
  }

  /**
   * Register a fully written upload and mint its token.
   *
   * `filePath` must already live directly inside the store's directory: the
   * endpoint builds it from a random UUID (never from a client name), and this
   * check makes a traversal bug impossible to turn into a token.
   */
  async add(upload: Omit<DiffUpload, 'token' | 'createdAt'>): Promise<DiffUpload> {
    const filePath = path.resolve(upload.filePath);
    if (path.dirname(filePath) !== this.directory) {
      throw new Error('Diff upload must live in the diff temporary directory');
    }

    await this.pruneExpired();
    while (
      this.uploads.size > 0 &&
      (this.uploads.size >= this.maxUploads || this.totalBytes + upload.size > this.maxBytes)
    ) {
      const oldest = [...this.uploads.values()].sort(
        (left, right) => left.createdAt - right.createdAt,
      )[0];
      if (!oldest) break;
      console.warn(`[web] Evicting abandoned diff upload ${oldest.token}`);
      await this.drop(oldest.token);
    }

    const entry: DiffUpload = {
      ...upload,
      filePath,
      token: randomUUID(),
      createdAt: this.now(),
    };
    this.uploads.set(entry.token, entry);
    return entry;
  }

  /**
   * Consume a token. Returns `null` for unknown/expired tokens; an expired
   * token's file is deleted on the way out.
   */
  async take(token: unknown): Promise<DiffUpload | null> {
    if (typeof token !== 'string' || !token) return null;

    const upload = this.uploads.get(token);
    if (!upload) return null;

    this.uploads.delete(token);
    if (!this.isLive(upload)) {
      await removeTempFile(upload.filePath);
      return null;
    }
    return upload;
  }

  /** Delete the given uploads (and their files); safe to call twice. */
  async release(...uploads: DiffUpload[]): Promise<void> {
    for (const upload of uploads) {
      this.uploads.delete(upload.token);
      await removeTempFile(upload.filePath);
    }
  }

  /** Drop every pending upload and its file (server shutdown/close). */
  async cleanup(): Promise<void> {
    const uploads = [...this.uploads.values()];
    this.uploads.clear();
    await Promise.all(uploads.map((upload) => removeTempFile(upload.filePath)));
  }

  private isLive(upload: DiffUpload): boolean {
    if (this.now() - upload.createdAt >= this.ttlMs) return false;
    return path.dirname(path.resolve(upload.filePath)) === this.directory;
  }

  private async pruneExpired(): Promise<void> {
    const expired = [...this.uploads.values()].filter((upload) => !this.isLive(upload));
    for (const upload of expired) {
      await this.drop(upload.token);
    }
  }

  private async drop(token: string): Promise<void> {
    const upload = this.uploads.get(token);
    if (!upload) return;
    this.uploads.delete(token);
    await removeTempFile(upload.filePath);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;

  const payload = Buffer.from(JSON.stringify(body ?? null), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

function sendText(res: ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;

  const payload = Buffer.from(message, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new HttpError(400, 'Request body is too large');
    }
    chunks.push(buffer);
  }

  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * Stream a raw PDF request body into `filePath`, enforcing the shared 100 MiB
 * cap on both the declared length and the bytes actually received.
 *
 * Throws `HttpError(400)` after deleting the partial file, so both `/api/open`
 * and the diff upload endpoint share one upload contract. The caller owns the
 * file from here on (magic check, registry/token adoption or deletion).
 */
async function receivePdfUpload(req: IncomingMessage, filePath: string): Promise<number> {
  const declaredLength = parseContentLength(req.headers['content-length']);
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_BYTES) {
    req.resume(); // Drain so the client sees the response instead of a reset.
    throw new HttpError(400, 'The PDF is larger than the 100 MiB upload limit');
  }

  let received = 0;
  let tooLarge = false;

  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        callback(new Error('The PDF is larger than the 100 MiB upload limit'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, sizeGuard, createWriteStream(filePath, { mode: 0o600 }));
  } catch (error) {
    await removeTempFile(filePath);
    throw new HttpError(
      400,
      tooLarge
        ? 'The PDF is larger than the 100 MiB upload limit'
        : `Failed to read the upload: ${toErrorMessage(error)}`,
    );
  }

  return received;
}

function streamFile(
  res: ServerResponse,
  filePath: string,
  options?: { start: number; end: number },
): void {
  const stream = createReadStream(filePath, options);
  stream.on('error', (error) => {
    console.error(`[web] Failed to stream ${filePath}:`, error);
    res.destroy();
  });
  res.on('close', () => {
    stream.destroy();
  });
  stream.pipe(res);
}

type ParsedRange = { start: number; end: number } | null | 'invalid';

/** Parse a single `bytes=` range. Multiple ranges fall back to a 200. */
function parseByteRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return 'invalid';
  if (size <= 0) return 'invalid';

  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw ?? '', 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number.parseInt(startRaw, 10);
  let end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'invalid';
  if (start >= size) return 'invalid';
  end = Math.min(end, size - 1);

  return { start, end };
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.endsWith('.html')) return 'no-cache';
  if (relativePath.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

// ---------------------------------------------------------------------------
// PDF serving (document + samples)
// ---------------------------------------------------------------------------

async function servePdfWithRanges(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
): Promise<void> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const range = parseByteRange(headerString(req.headers.range), size);

  if (range === 'invalid') {
    res.writeHead(416, {
      ...baseHeaders,
      'Content-Range': `bytes */${size}`,
      'Content-Length': '0',
    });
    res.end();
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(length),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    streamFile(res, filePath, range);
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  streamFile(res, filePath);
}

async function serveDocument(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  registry: DocumentRegistry,
): Promise<void> {
  const parts = pathname.split('/').filter(Boolean);
  // /doc/:id/:name - the name is cosmetic; the file always comes from the
  // registry, so a crafted name cannot influence the path on disk.
  const id = parts.length >= 2 && parts[0] === 'doc' ? parts[1] : '';
  const doc = id ? registry.findById(id) : null;
  if (!doc) {
    sendError(res, 404, 'Document not found');
    return;
  }

  let info;
  try {
    info = await stat(doc.filePath);
  } catch {
    sendError(res, 404, 'Document not found');
    return;
  }

  if (!info.isFile()) {
    sendError(res, 404, 'Document not found');
    return;
  }

  await servePdfWithRanges(req, res, doc.filePath, info.size);
}

async function serveSample(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const raw = pathname.slice('/samples/'.length);

  let file: string;
  try {
    file = decodeURIComponent(raw);
  } catch {
    sendError(res, 404, 'Sample not found');
    return;
  }

  if (
    !file ||
    file.includes('/') ||
    file.includes('\\') ||
    file === '.' ||
    file === '..' ||
    !file.toLowerCase().endsWith('.pdf')
  ) {
    sendError(res, 404, 'Sample not found');
    return;
  }

  const resolved = path.resolve(SAMPLE_DIR, file);
  if (path.dirname(resolved) !== SAMPLE_DIR) {
    sendError(res, 404, 'Sample not found');
    return;
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    sendError(res, 404, 'Sample not found');
    return;
  }

  if (!info.isFile()) {
    sendError(res, 404, 'Sample not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': String(info.size),
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  streamFile(res, resolved);
}

// ---------------------------------------------------------------------------
// Static web app
// ---------------------------------------------------------------------------

async function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  relativePath: string,
): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendError(res, 404, 'Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(info.size),
    'Cache-Control': cacheControlFor(relativePath),
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  streamFile(res, filePath);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!existsSync(WEB_DIST_DIR)) {
    sendText(
      res,
      404,
      'The web app has not been built yet. Build dist-web (see the web build script) and reload.',
    );
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, 'Invalid path');
    return;
  }

  if (decoded === '/' || decoded === '') decoded = '/index.html';

  const relativePath = decoded.replace(/^\/+/, '');
  if (relativePath.split('/').includes('..')) {
    sendError(res, 404, 'Not found');
    return;
  }

  const resolved = path.resolve(WEB_DIST_DIR, relativePath);
  if (resolved !== WEB_DIST_DIR && !resolved.startsWith(WEB_DIST_DIR + path.sep)) {
    sendError(res, 404, 'Not found');
    return;
  }

  const info = await stat(resolved).catch(() => null);
  if (info?.isFile()) {
    await serveStaticFile(req, res, resolved, relativePath);
    return;
  }

  // SPA fallback: extensionless GET/HEAD paths get index.html. Missing assets
  // still 404 so a broken build is not masked by an HTML response.
  if (!/\.[A-Za-z0-9]+$/.test(relativePath)) {
    const indexPath = path.join(WEB_DIST_DIR, 'index.html');
    if (existsSync(indexPath)) {
      await serveStaticFile(req, res, indexPath, 'index.html');
      return;
    }
  }

  sendError(res, 404, 'Not found');
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

interface ApiContext {
  sidecar: SidecarPool;
  registry: DocumentRegistry;
  diffUploads: DiffUploadStore;
}

/** `POST /api/open`, `/api/open-url` and activate share this response shape. */
interface OpenResponse {
  canceled: false;
  /** Registry URL (`/doc/:id/:name`), never a filesystem path. */
  path: string;
  metadata: unknown;
  name: string;
  /** Present for downloaded documents only. */
  sourceUrl?: string;
  documentId: string;
}

/** One entry of `GET /api/documents`; deliberately path-free. */
interface DocumentSummary {
  id: string;
  name: string;
  size: number;
  sourceUrl: string | null;
  active: boolean;
}

/**
 * Map a typed registry failure onto its HTTP status.
 *
 * Kept here (not on the error class) so the registry stays transport-agnostic.
 * Any other error keeps the generic 500 path in `createWebServer`.
 */
function statusForRegistryError(code: DocumentRegistryErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'too_large':
      return 413;
  }
}

function openResponse(registry: DocumentRegistry, opened: OpenedDocument): OpenResponse {
  const doc = opened.doc;
  const response: OpenResponse = {
    canceled: false,
    path: registry.urlFor(doc),
    metadata: opened.metadata,
    name: doc.name,
    documentId: doc.id,
  };
  if (doc.sourceUrl !== null) response.sourceUrl = doc.sourceUrl;
  return response;
}

function documentSummary(doc: OpenDocument, activeDocumentId: string | null): DocumentSummary {
  return {
    id: doc.id,
    name: doc.name,
    size: doc.size,
    sourceUrl: doc.sourceUrl,
    active: doc.id === activeDocumentId,
  };
}

type DocumentPath =
  | { action: 'activate'; id: string }
  | { action: 'close'; id: string };

/**
 * Parse `/api/documents/:id` and `/api/documents/:id/activate`.
 *
 * `null` means "not a documents route shape" (the caller answers 404). A
 * malformed percent-escape in the id is a 400 instead: the id is user-visible
 * in the address bar, and decoding must not silently turn a typo into 404.
 * Empty segments (`//`), trailing slashes and extra segments are rejected.
 */
function parseDocumentPath(pathname: string): DocumentPath | null {
  const prefix = '/api/documents/';
  if (!pathname.startsWith(prefix)) return null;

  const segments = pathname.slice(prefix.length).split('/');
  if (segments.length > 2) return null;
  if (segments.some((segment) => segment === '')) return null;

  let id: string;
  try {
    id = decodeURIComponent(segments[0]);
  } catch {
    throw new HttpError(400, 'Invalid document id');
  }
  if (!id) return null;

  if (segments.length === 1) return { action: 'close', id };
  if (segments[1] === 'activate') return { action: 'activate', id };
  return null;
}

async function handleOpenUpload(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const name = sanitizeFileName(headerString(req.headers['x-filename']));

  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(UPLOAD_DIR, `${randomUUID()}-${name}`);

  // Registered before the bytes arrive so a shutdown mid-upload still unlinks
  // the partial file; ownership passes to the document registry below.
  uploadedTempFiles.add(filePath);
  let size: number;
  try {
    size = await receivePdfUpload(req, filePath);
    if (!(await hasPdfMagic(filePath))) {
      throw new HttpError(400, 'The uploaded file is not a PDF');
    }
  } catch (error) {
    uploadedTempFiles.delete(filePath);
    await removeTempFile(filePath);
    throw error;
  }

  let opened: OpenedDocument;
  try {
    opened = await context.registry.open(filePath, name, true, size);
  } catch (error) {
    uploadedTempFiles.delete(filePath);
    await removeTempFile(filePath);
    throw error;
  }

  // The registry now owns the file and deletes it when this document is closed,
  // evicted or on shutdown. Earlier documents stay registered: opening a PDF is
  // additive in the browser build.
  uploadedTempFiles.delete(filePath);
  sendJson(res, 200, openResponse(context.registry, opened));
}

/**
 * `POST /api/diff/file` — store one side of a browser diff.
 *
 * The bytes become a token-owned temporary file; nothing is opened in the
 * sidecar and the current document is untouched. The browser then posts both
 * tokens to `/api/diff`.
 */
async function handleDiffUpload(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const rawSide = headerString(req.headers['x-diff-side'])?.trim().toLowerCase();
  if (rawSide !== 'old' && rawSide !== 'new') {
    // Drain the body: the client must see the 400 instead of a reset.
    req.resume();
    throw new HttpError(400, 'Missing or invalid X-Diff-Side header (expected "old" or "new")');
  }
  const side: DiffSide = rawSide;

  // The disk name is a UUID: the client-supplied name is display-only and can
  // never influence the path (`sanitizeFileName` also strips separators).
  const name = sanitizeFileName(headerString(req.headers['x-filename']));

  await mkdir(DIFF_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(DIFF_DIR, `${randomUUID()}.pdf`);

  // Tracked by the generic upload set until the token store owns it, so a
  // shutdown during the upload still unlinks a partial file.
  uploadedTempFiles.add(filePath);

  let upload: DiffUpload;
  try {
    const size = await receivePdfUpload(req, filePath);
    if (!(await hasPdfMagic(filePath))) {
      throw new HttpError(400, 'The uploaded file is not a PDF');
    }
    upload = await context.diffUploads.add({ filePath, side, name, size });
    uploadedTempFiles.delete(filePath);
  } catch (error) {
    uploadedTempFiles.delete(filePath);
    await removeTempFile(filePath);
    throw error;
  }

  sendJson(res, 200, { token: upload.token, side, name, size: upload.size });
}

/**
 * `POST /api/diff` — diff the two token-owned uploads.
 *
 * Both tokens are consumed (single use) and both temporary files are deleted
 * in a `finally`, so a failed diff cannot leak them either. The sidecar runs
 * `diff_documents` on its own extractors, which never changes the open
 * document; the response is the `DiffResult` verbatim.
 */
async function handleDiff(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');

  const { oldToken, newToken, options } = body;
  if (typeof oldToken !== 'string' || !oldToken) {
    throw new HttpError(400, 'Missing "oldToken"');
  }
  if (typeof newToken !== 'string' || !newToken) {
    throw new HttpError(400, 'Missing "newToken"');
  }
  if (options !== undefined && !isRecord(options)) {
    throw new HttpError(400, '"options" must be an object');
  }

  const uploads: DiffUpload[] = [];
  try {
    // Consume both tokens even when one is unknown/expired: a replay must not
    // leave the other side's temporary file behind.
    const oldUpload = await context.diffUploads.take(oldToken);
    if (oldUpload) uploads.push(oldUpload);
    const newUpload = await context.diffUploads.take(newToken);
    if (newUpload) uploads.push(newUpload);

    if (!oldUpload) throw new HttpError(400, 'Unknown or expired "oldToken"');
    if (oldUpload.side !== 'old') {
      throw new HttpError(400, '"oldToken" does not refer to an "old" upload');
    }
    if (!newUpload) throw new HttpError(400, 'Unknown or expired "newToken"');
    if (newUpload.side !== 'new') {
      throw new HttpError(400, '"newToken" does not refer to a "new" upload');
    }

    const result = await context.sidecar.send(
      'diff_documents',
      {
        old_path: oldUpload.filePath,
        new_path: newUpload.filePath,
        options: diffOptionsToRpc(options),
      },
      DIFF_TIMEOUT_MS,
    );
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof HttpError) throw error;

    // Sidecar errors here mean the uploaded PDFs (or the options) could not be
    // diffed; a timeout means the server gave up on a very large pair.
    const message = toErrorMessage(error);
    if (isDiffTimeoutError(error)) {
      // The abandoned computation may still be running in the background lane,
      // so restart it (never the interactive lane) to kill the orphan before a
      // retry. Best effort: the 504 reports the original timeout message.
      await context.sidecar.restartBackground().catch((restartError) => {
        console.error(
          '[web] Background lane restart after diff timeout failed:',
          toErrorMessage(restartError),
        );
      });
    }
    // Every other timeout (an `open` budget, for example) maps to 504 too, but
    // no restart: only an abandoned diff leaves a computation behind.
    throw new HttpError(/timed out/i.test(message) ? 504 : 400, message);
  } finally {
    await context.diffUploads.release(...uploads);
  }
}

async function handleOpenUrl(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');

  const rawUrl = body.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new HttpError(400, 'Missing "url"');
  }

  let url: URL;
  try {
    url = parsePdfUrl(rawUrl);
  } catch (error) {
    throw new HttpError(400, toErrorMessage(error));
  }
  const sourceUrl = url.href;

  // Re-opening a URL the session already holds must not download it again or
  // add a duplicate document. Activating the existing entry is exactly what the
  // de-dupe rule in the renderer would ask for, and it needs no network.
  //
  // This is only the fast path: it cannot see a concurrent request that is
  // still downloading, so the authoritative check lives in `openDeduped`.
  const existing = context.registry.findBySourceUrl(sourceUrl);
  if (existing) {
    const opened = await context.registry.activate(existing.id);
    sendJson(res, 200, openResponse(context.registry, opened));
    return;
  }

  let downloadedPath: string;
  try {
    downloadedPath = await downloadPdfToFile(url, { directory: DOWNLOAD_DIR });
  } catch (error) {
    throw new HttpError(500, toErrorMessage(error));
  }

  let result: DedupedOpenResult;
  try {
    // The registry records the size so the total-byte bound is known without a
    // stat per document, and the URL so a repeat open-url can reuse this doc.
    const info = await stat(downloadedPath);
    // Serialized with every other mutation: if another request registered this
    // URL while this one downloaded, the existing document is activated and the
    // fresh copy is NOT adopted.
    result = await context.registry.openDeduped(
      downloadedPath,
      nameFromUrl(url),
      true,
      info.size,
      sourceUrl,
    );
  } catch (error) {
    // The fresh download is garbage if the sidecar rejected it (the previous
    // document was already restored by the registry), and equally when
    // activating the URL's existing document failed.
    await deleteDownloadedFile(downloadedPath);
    throw error;
  }

  if (result.deduped) {
    // Lost the race: another document already owns this URL, so this copy is
    // garbage and the winner's document is what the browser gets.
    await deleteDownloadedFile(downloadedPath);
  }

  sendJson(res, 200, openResponse(context.registry, result.opened));
}

/**
 * `GET /api/documents` — the registry's observable state.
 *
 * Paths are intentionally absent: the browser only needs ids for activate/close
 * and the `/doc/:id/:name` URLs it already received from the open responses.
 */
function handleListDocuments(res: ServerResponse, context: ApiContext): void {
  const activeDocumentId = context.registry.getActiveId();
  sendJson(res, 200, {
    activeDocumentId,
    documents: context.registry
      .list()
      .map((doc) => documentSummary(doc, activeDocumentId)),
  });
}

/** `POST /api/documents/:id/activate` — same payload as opening the document. */
async function handleActivateDocument(
  res: ServerResponse,
  context: ApiContext,
  id: string,
): Promise<void> {
  const opened = await context.registry.activate(id);
  sendJson(res, 200, openResponse(context.registry, opened));
}

/** `DELETE /api/documents/:id` — close one document (active only if last). */
async function handleCloseDocument(
  res: ServerResponse,
  context: ApiContext,
  id: string,
): Promise<void> {
  const result = await context.registry.close(id);
  sendJson(res, 200, { closed: true, activeDocumentId: result.activeDocumentId });
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');

  const method = body.method;
  if (typeof method !== 'string' || !RPC_ALLOWLIST.has(method)) {
    throw new HttpError(400, `Method not allowed: ${typeof method === 'string' ? method : '(missing)'}`);
  }

  const params = body.params ?? {};
  if (!isRecord(params)) throw new HttpError(400, '"params" must be an object');

  // Page extraction, raw reads, font analysis, both audit passes, the document
  // security scan and the accessibility structure parse walk or decode large
  // parts of the document; every other allowlisted method keeps the default
  // budget.
  const timeoutMs = RPC_TIMEOUTS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // The sidecar holds one document. Once the last one is closed (or a restore
  // failed) there is nothing to query, so fail explicitly instead of letting a
  // stale sidecar answer for a document the browser no longer has.
  if (!context.registry.getActive()) {
    throw new HttpError(409, 'No active document');
  }

  const result = await context.sidecar.send(method, params, timeoutMs);
  sendJson(res, 200, result);
}

async function handleRestart(
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  try {
    await context.sidecar.restart();
    sendJson(res, 200, { success: true, running: context.sidecar.isRunning() });
  } catch (error) {
    sendJson(res, 200, {
      success: false,
      running: context.sidecar.isRunning(),
      error: toErrorMessage(error),
    });
  }
}

function methodNotAllowed(res: ServerResponse): void {
  sendError(res, 405, 'Method not allowed');
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const method = req.method ?? 'GET';

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    sendError(res, 400, 'Invalid request URL');
    return;
  }

  if (pathname === '/api/status') {
    if (method !== 'GET' && method !== 'HEAD') {
      methodNotAllowed(res);
      return;
    }
    sendJson(res, 200, { running: context.sidecar.isRunning() });
    return;
  }

  if (pathname === '/api/open') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleOpenUpload(req, res, context);
    return;
  }

  if (pathname === '/api/open-url') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleOpenUrl(req, res, context);
    return;
  }

  if (pathname === '/api/rpc') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleRpc(req, res, context);
    return;
  }

  if (pathname === '/api/restart') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleRestart(res, context);
    return;
  }

  if (pathname === '/api/diff/file') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleDiffUpload(req, res, context);
    return;
  }

  if (pathname === '/api/diff') {
    if (method !== 'POST') {
      methodNotAllowed(res);
      return;
    }
    await handleDiff(req, res, context);
    return;
  }

  if (pathname === '/api/documents') {
    if (method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    handleListDocuments(res, context);
    return;
  }

  if (pathname.startsWith('/api/documents/')) {
    const route = parseDocumentPath(pathname);
    if (!route) {
      sendError(res, 404, 'Not found');
      return;
    }

    if (route.action === 'activate') {
      if (method !== 'POST') {
        methodNotAllowed(res);
        return;
      }
      await handleActivateDocument(res, context, route.id);
      return;
    }

    if (method !== 'DELETE') {
      methodNotAllowed(res);
      return;
    }
    await handleCloseDocument(res, context, route.id);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendError(res, 404, 'Not found');
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    methodNotAllowed(res);
    return;
  }

  if (pathname === '/doc' || pathname.startsWith('/doc/')) {
    await serveDocument(req, res, pathname, context.registry);
    return;
  }

  if (pathname === '/samples' || pathname.startsWith('/samples/')) {
    await serveSample(req, res, pathname);
    return;
  }

  await serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export interface WebServerHandle {
  server: Server;
  sidecar: SidecarPool;
  registry: DocumentRegistry;
  diffUploads: DiffUploadStore;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
}

function resolvePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

/** Build the server and wire the sidecar/document registry (without listening). */
export function createWebServer(): {
  server: Server;
  sidecar: SidecarPool;
  registry: DocumentRegistry;
  diffUploads: DiffUploadStore;
} {
  const sidecar = new SidecarPool({
    interactive: new SidecarManager(ROOT),
    createBackground: () => new SidecarManager(ROOT),
  });
  const registry = new DocumentRegistry(sidecar);
  const diffUploads = new DiffUploadStore();
  const context: ApiContext = { sidecar, registry, diffUploads };

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, context).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.statusCode, error.message);
        return;
      }

      if (error instanceof DocumentRegistryError) {
        sendError(res, statusForRegistryError(error.code), error.message);
        return;
      }

      console.error(`[web] ${req.method ?? 'GET'} ${req.url ?? '/'} failed:`, error);
      sendError(res, 500, toErrorMessage(error));
    });
  });

  return { server, sidecar, registry, diffUploads };
}

/** LAN IPv4 URLs for the startup log (best effort). */
function lanUrls(port: number): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const info of entries ?? []) {
      const family = String(info.family);
      if ((family === 'IPv4' || family === '4') && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }

  return urls;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

let cleanupStarted = false;

async function shutdown(
  signal: string,
  handle: Pick<WebServerHandle, 'server' | 'sidecar' | 'registry' | 'diffUploads'>,
): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;

  console.log(`\nPDF Inspector web: received ${signal}, shutting down...`);

  try {
    // Stop the sidecar first so it releases its open file handles before any
    // temporary document is unlinked.
    await handle.sidecar.stop();
  } catch (error) {
    console.error('[web] Sidecar shutdown failed:', error);
  }

  await Promise.allSettled([
    handle.registry.cleanup(),
    handle.diffUploads.cleanup(),
    cleanupDownloadedFiles(),
    cleanupUploadedTempFiles(),
  ]);

  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
  });

  process.exit(0);
}

/**
 * Create the HTTP server, start the sidecar (best effort: the API stays usable
 * and /api/status reports the failure), then listen.
 */
export async function start(options: StartOptions = {}): Promise<WebServerHandle> {
  const port = options.port ?? resolvePort(process.env.PORT);
  const host = options.host ?? (process.env.HOST?.trim() || DEFAULT_HOST);

  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  await mkdir(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  await mkdir(DIFF_DIR, { recursive: true, mode: 0o700 });

  const { server, sidecar, registry, diffUploads } = createWebServer();

  try {
    await sidecar.start();
  } catch (error) {
    console.error(`[web] Failed to start the sidecar: ${toErrorMessage(error)}`);
  }

  try {
    await listen(server, port, host);
  } catch (error) {
    await sidecar.stop();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `Port ${port} is already in use. Stop the other process or set PORT to a free port.`,
      );
    }
    throw error;
  }

  console.log(`PDF Inspector web: http://localhost:${port}`);
  for (const url of lanUrls(port)) {
    console.log(`PDF Inspector web: ${url}`);
  }

  const handle: WebServerHandle = {
    server,
    sidecar,
    registry,
    diffUploads,
    port,
    host,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await sidecar.stop();
      // Pending diff uploads are temp files this server owns: never leak them.
      await diffUploads.cleanup();
    },
  };

  process.once('SIGINT', () => void shutdown('SIGINT', handle));
  process.once('SIGTERM', () => void shutdown('SIGTERM', handle));

  return handle;
}

/** True when this module is the script Node was asked to execute. */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    const modulePath = fileURLToPath(import.meta.url);
    try {
      return realpathSync(entry) === realpathSync(modulePath);
    } catch {
      return path.resolve(entry) === path.resolve(modulePath);
    }
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  start().catch((error: unknown) => {
    console.error(`PDF Inspector web: failed to start: ${toErrorMessage(error)}`);
    process.exit(1);
  });
}
