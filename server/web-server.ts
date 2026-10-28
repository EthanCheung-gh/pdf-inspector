/**
 * Self-contained HTTP backend for the browser build of PDF Inspector.
 *
 * The Electron main process owns dialogs, app lifecycle and IPC; this server
 * offers the same document/sidecar capabilities over plain HTTP so the React
 * renderer can run in a normal browser:
 *
 *   - manages the Python JSON-RPC sidecar (spawn, timeouts, restart, cleanup);
 *   - keeps one "current document" (uploaded, downloaded or local) and streams
 *     it back with Range support for pdf.js;
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
import { ANALYZE_FONTS_TIMEOUT_MS, SIDECAR_SCRIPT } from '../src/shared/constants';

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

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';

const START_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const PDF_HEADER_WINDOW_BYTES = 1024;
const PDF_MAGIC = '%PDF-';

/** Methods a browser client may invoke through POST /api/rpc. */
const RPC_ALLOWLIST = new Set([
  'extract_page',
  'extract_metadata',
  'analyze_fonts',
  'get_image_data',
]);

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

async function removeTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[web] Failed to delete temporary file ${filePath}:`, error);
    }
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
 * Turn a user/header-supplied file name into a safe display name and disk
 * basename. Parent directories, control characters and exotic characters can
 * never survive, and the result always ends in `.pdf`.
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
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .replace(/^\.+/, '');

  const withoutExtension = cleaned.toLowerCase().endsWith('.pdf')
    ? cleaned.slice(0, -'.pdf'.length)
    : cleaned;
  const stem = withoutExtension.replace(/^\.+/, '').slice(0, 100);
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
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC client for sidecar/main.py.
 *
 * Lifecycle notes:
 * - one child process at a time; `start()` coalesces concurrent callers;
 * - stdout is line-buffered; the first `{"ready":true}` line resolves start;
 * - `stdin` writes are serialized, but responses may arrive out of order;
 * - every request has its own timeout (30s default, 120s for analyze_fonts);
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${formatTimeout(timeoutMs)}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
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
   */
  private restoreDocument(): Promise<void> {
    const filePath = this.documentPath;
    if (!filePath || !this.isRunning()) return Promise.resolve();
    if (this.restorePromise) return this.restorePromise;

    const attempt = (async (): Promise<void> => {
      try {
        await this.writeRequest('open', { path: filePath }, DEFAULT_REQUEST_TIMEOUT_MS);
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
// Current-document registry
// ---------------------------------------------------------------------------

export interface OpenDocument {
  id: string;
  filePath: string;
  name: string;
  isTemp: boolean;
}

export interface OpenedDocument {
  metadata: unknown;
  doc: OpenDocument;
}

/**
 * Tracks the single document visible to the browser. The sidecar closes the
 * previous document before opening the next one, so a failed open is healed by
 * re-opening the previous file; only temp files owned by this server are
 * deleted when they are replaced.
 */
export class DocumentRegistry {
  private current: OpenDocument | null = null;

  constructor(private readonly sidecar: SidecarManager) {}

  getCurrent(): OpenDocument | null {
    return this.current;
  }

  findById(id: string): OpenDocument | null {
    return this.current !== null && this.current.id === id ? this.current : null;
  }

  urlFor(doc: OpenDocument): string {
    return `/doc/${doc.id}/${encodeURIComponent(doc.name)}`;
  }

  async open(filePath: string, name: string, isTemp: boolean): Promise<OpenedDocument> {
    const previous = this.current;

    let metadata: unknown;
    try {
      metadata = await this.sidecar.send('open', { path: filePath });
    } catch (error) {
      // The sidecar dropped the old document before failing the new one. Put
      // the previous document back so the browser's current view stays valid,
      // then propagate the original error unchanged.
      if (previous) {
        try {
          await this.sidecar.send('open', { path: previous.filePath });
          this.sidecar.setDocumentPath(previous.filePath);
        } catch (restoreError) {
          console.error(
            '[web] Failed to re-open previous document:',
            toErrorMessage(restoreError),
          );
          this.sidecar.setDocumentPath(null);
        }
      }
      throw error;
    }

    const doc: OpenDocument = { id: randomUUID(), filePath, name, isTemp };
    this.current = doc;
    this.sidecar.setDocumentPath(filePath);

    if (previous && previous.isTemp && previous.filePath !== filePath) {
      await removeTempFile(previous.filePath);
    }

    return { metadata, doc };
  }

  /** Delete the current temp document when the server shuts down. */
  async cleanup(): Promise<void> {
    const doc = this.current;
    this.current = null;
    this.sidecar.setDocumentPath(null);
    if (doc?.isTemp) await removeTempFile(doc.filePath);
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
  sidecar: SidecarManager;
  registry: DocumentRegistry;
}

async function handleOpenUpload(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const declaredLength = parseContentLength(req.headers['content-length']);
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_BYTES) {
    req.resume(); // Drain so the client sees the response instead of a reset.
    sendError(res, 400, 'The PDF is larger than the 100 MiB upload limit');
    return;
  }

  const name = sanitizeFileName(headerString(req.headers['x-filename']));

  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(UPLOAD_DIR, `${randomUUID()}-${name}`);
  uploadedTempFiles.add(filePath);

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
    uploadedTempFiles.delete(filePath);
    sendError(
      res,
      400,
      tooLarge
        ? 'The PDF is larger than the 100 MiB upload limit'
        : `Failed to read the upload: ${toErrorMessage(error)}`,
    );
    return;
  }

  if (!(await hasPdfMagic(filePath))) {
    await removeTempFile(filePath);
    uploadedTempFiles.delete(filePath);
    sendError(res, 400, 'The uploaded file is not a PDF');
    return;
  }

  let opened: OpenedDocument;
  try {
    opened = await context.registry.open(filePath, name, true);
  } catch (error) {
    await removeTempFile(filePath);
    uploadedTempFiles.delete(filePath);
    throw error;
  }

  // The registry now owns the file and deletes it when it is replaced/at exit.
  uploadedTempFiles.delete(filePath);
  sendJson(res, 200, {
    canceled: false,
    path: context.registry.urlFor(opened.doc),
    metadata: opened.metadata,
    name,
  });
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

  let downloadedPath: string;
  try {
    downloadedPath = await downloadPdfToFile(url, { directory: DOWNLOAD_DIR });
  } catch (error) {
    throw new HttpError(500, toErrorMessage(error));
  }

  let opened: OpenedDocument;
  try {
    opened = await context.registry.open(downloadedPath, nameFromUrl(url), true);
  } catch (error) {
    // The fresh download is garbage if the sidecar rejected it (the previous
    // document was already restored by the registry).
    await deleteDownloadedFile(downloadedPath);
    throw error;
  }

  sendJson(res, 200, {
    canceled: false,
    path: context.registry.urlFor(opened.doc),
    metadata: opened.metadata,
    name: opened.doc.name,
    sourceUrl: url.href,
  });
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

  const timeoutMs =
    method === 'analyze_fonts' ? ANALYZE_FONTS_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;

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
  sidecar: SidecarManager;
  registry: DocumentRegistry;
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
  sidecar: SidecarManager;
  registry: DocumentRegistry;
} {
  const sidecar = new SidecarManager(ROOT);
  const registry = new DocumentRegistry(sidecar);
  const context: ApiContext = { sidecar, registry };

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, context).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.statusCode, error.message);
        return;
      }

      console.error(`[web] ${req.method ?? 'GET'} ${req.url ?? '/'} failed:`, error);
      sendError(res, 500, toErrorMessage(error));
    });
  });

  return { server, sidecar, registry };
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
  handle: Pick<WebServerHandle, 'server' | 'sidecar' | 'registry'>,
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

  const { server, sidecar, registry } = createWebServer();

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
    port,
    host,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await sidecar.stop();
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
