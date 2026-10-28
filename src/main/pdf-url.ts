/**
 * Remote PDF support for the main process: validate a URL, download it to a
 * temp file and make sure it really is a PDF.
 *
 * The sidecar (pdfplumber) only opens local paths, so a remote document is
 * downloaded once and then treated exactly like a local file by every other
 * channel. Deliberately free of Electron imports so it can be unit tested
 * under plain Node.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PDF_URL_TIMEOUT_MS } from '../shared/constants';

/** Hard cap on a downloaded PDF (100 MiB). */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** Every PDF file starts with these bytes. */
const PDF_MAGIC = '%PDF-';

/**
 * PDF readers tolerate junk (a BOM, a mail/HTTP preamble) before the header, so
 * the marker is only required somewhere in the first 1024 bytes — ISO 32000-1
 * §7.5.2.
 */
const PDF_HEADER_WINDOW_BYTES = 1024;

/** Characters kept from the URL-derived file stem (before the hash suffix). */
const MAX_STEM_LENGTH = 60;

/** Length of the sha256 (hex) suffix that disambiguates equal file names. */
const HASH_LENGTH = 8;

/**
 * How many `-1`, `-2`, … name variants are tried before a download gives up on
 * finding a free path. Bounded because the suffix loop runs on the UI's path.
 */
const MAX_FILE_ATTEMPTS = 100;

/**
 * Every file this module created and that still exists on disk. Main uses it to
 * clean up on quit, and to delete the previous download when another document
 * replaces it.
 */
const trackedFiles = new Set<string>();

/**
 * Parse and validate a user-supplied URL.
 *
 * Only absolute `http:`/`https:` URLs are accepted: the other schemes a user
 * could type (`file:`, `data:`, `ftp:`) would let the renderer make the main
 * process read local files or speak non-HTTP protocols, so they are rejected
 * with a message that is safe to show in the UI.
 */
export function parsePdfUrl(raw: string): URL {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw new Error('Enter a valid http(s) URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }

  return parsed;
}

/**
 * Build the preferred download destination for `url` inside `directory`.
 *
 * The basename is derived from the URL pathname through an allowlist (not a
 * denylist), so `/`, `\`, `..` and control characters can never escape the
 * directory. A short hash of the full URL is appended before the extension so
 * two different URLs with the same file name map to different paths, and the
 * readable stem survives for exports.
 *
 * The result is deterministic, so it is only a *candidate*: `downloadPdfToFile`
 * reserves a unique variant of it (see `reserveTempPdfFile`) and never rewrites
 * an existing file.
 */
export function buildTempPdfPath(directory: string, url: URL): string {
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, HASH_LENGTH);

  const lastSegment = url.pathname.split('/').pop() ?? '';
  let stem: string;
  try {
    stem = decodeURIComponent(lastSegment);
  } catch {
    // Malformed percent-encoding: the raw segment is still URL-safe text.
    stem = lastSegment;
  }

  stem = stem
    // Allowlist: anything that is not a plain file-name character is dropped.
    .replace(/[^A-Za-z0-9._-]/g, '')
    // No hidden files, and `..` alone can never become a directory reference.
    .replace(/^\.+/, '');

  if (stem.toLowerCase().endsWith('.pdf')) {
    stem = stem.slice(0, -'.pdf'.length);
  }
  if (stem.length > MAX_STEM_LENGTH) {
    stem = stem.slice(0, MAX_STEM_LENGTH);
  }
  if (!stem) {
    stem = 'document';
  }

  return path.join(directory, `${stem}-${hash}.pdf`);
}

export interface DownloadPdfOptions {
  /** Directory the temp file is written to (created if missing). */
  directory: string;
  /** Whole-download budget; defaults to PDF_URL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Byte cap; defaults to MAX_PDF_BYTES. */
  maxBytes?: number;
}

/** Render a timeout the way the error message expects it. */
function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

/**
 * `fetch()` aborts surface as a DOMException whose `name` is `TimeoutError` for
 * `AbortSignal.timeout()` (and `AbortError` for a manual abort). Checked by
 * name so it works regardless of whether DOMException subclasses Error.
 */
function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Reject a file that does not look like a PDF: the `%PDF-` marker must appear
 * within the first 1024 bytes, which still accepts a BOM or a short preamble
 * but rejects HTML/JSON error pages.
 */
async function assertPdfMagic(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const window = Buffer.alloc(PDF_HEADER_WINDOW_BYTES);
    const { bytesRead } = await handle.read(window, 0, window.length, 0);
    const header = window.subarray(0, bytesRead);
    if (header.indexOf(PDF_MAGIC) === -1) {
      throw new Error('The downloaded file is not a PDF');
    }
  } finally {
    await handle.close();
  }
}

/** `/dir/report-1a2b3c4d.pdf` + 3 -> `/dir/report-1a2b3c4d-3.pdf`. */
function withSuffix(filePath: string, index: number): string {
  const { dir, name, ext } = path.parse(filePath);
  return path.join(dir, `${name}-${index}${ext}`);
}

/**
 * Create the file for this download and return its path plus an open handle.
 *
 * `wx` (O_CREAT | O_EXCL) makes "is this name free?" and "create it" one atomic
 * step, so two concurrent downloads of the same URL can never pick the same
 * path. If the preferred name is taken — a previous download of the same URL,
 * possibly still open in the sidecar — `-1`, `-2`, … are tried instead, which
 * keeps the readable stem and the URL hash for exports.
 */
async function reserveTempPdfFile(
  directory: string,
  url: URL,
): Promise<{ filePath: string; handle: FileHandle }> {
  const basePath = buildTempPdfPath(directory, url);

  for (let attempt = 0; attempt < MAX_FILE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? basePath : withSuffix(basePath, attempt);
    try {
      // 0600: a downloaded document is private to this user.
      const handle = await open(candidate, 'wx', 0o600);
      return { filePath: candidate, handle };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Could not find a free temporary file name in ${directory}`);
}

/**
 * Download `url` into `options.directory` and return the local path.
 *
 * Redirects are followed (shorteners and CDNs are common), the declared
 * `content-length` is checked before reading, and a running byte counter caps
 * the stream itself — a server that lies about (or omits) its length cannot
 * make the app fill the disk. The body is streamed straight to the file, so a
 * large PDF is never buffered in memory as a whole.
 *
 * Each call writes to a freshly reserved path, so an existing download is never
 * overwritten (the sidecar may still have it open, and a half-written file must
 * never be read). On any failure only this call's own partial file is removed.
 */
export async function downloadPdfToFile(
  url: URL,
  options: DownloadPdfOptions,
): Promise<string> {
  const { directory } = options;
  const timeoutMs = options.timeoutMs ?? PDF_URL_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;

  // 0700: only this user may browse the downloaded documents.
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // Set only once THIS attempt reserved a file. A failed attempt must not
  // delete a file an earlier successful download created: the sidecar may
  // still have it open.
  let filePath: string | null = null;

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      throw new Error(`Download failed with HTTP ${response.status}${statusText}`);
    }

    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (declaredLength !== null && declaredLength > maxBytes) {
      throw new Error(
        `The PDF is larger than the ${maxBytes} byte limit (${declaredLength} bytes)`,
      );
    }

    const body = response.body;
    if (!body) {
      throw new Error('Download failed: the server returned an empty response');
    }

    // Reserve the destination only once the response is known to be usable, so
    // a rejected request never leaves an empty file behind.
    const reserved = await reserveTempPdfFile(directory, url);
    filePath = reserved.filePath;
    trackedFiles.add(filePath);

    let received = 0;
    const sizeGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(new Error(`The PDF is larger than the ${maxBytes} byte limit`));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        // Web ReadableStream -> Node stream; `fetch` bodies are not typed by
        // the Node stream helpers, hence the cast.
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        sizeGuard,
        // The stream owns the descriptor and closes it when it finishes or
        // errors, so `pipeline` only resolves once the file is closed and
        // complete — which also lets the magic check (and Windows deletes)
        // open it again.
        reserved.handle.createWriteStream(),
      );
    } catch (err) {
      // Make sure the descriptor is released even if the stream never started.
      await reserved.handle.close().catch(() => {});
      throw err;
    }

    await assertPdfMagic(filePath);

    return filePath;
  } catch (error) {
    if (filePath) {
      await deleteDownloadedFile(filePath);
    }

    if (isAbortError(error)) {
      throw new Error(`Download timed out after ${formatTimeout(timeoutMs)}`);
    }

    throw toError(error);
  }
}

/**
 * Delete `filePath`, best effort.
 *
 * Never throws. The path stays tracked until it is really gone: on Windows a
 * file that another process still has open (a just-destroyed write stream, or
 * the sidecar) cannot be unlinked, and dropping it from the tracked set would
 * both leak the file and hide it from the quit-time cleanup that could still
 * remove it. Only a successful unlink — or a path that no longer exists — stops
 * tracking it.
 */
export async function deleteDownloadedFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await unlink(filePath);
      trackedFiles.delete(filePath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        trackedFiles.delete(filePath);
        return;
      }

      if (attempt === 2) {
        // Still locked: keep it tracked so cleanupDownloadedFiles() retries.
        console.error(`[pdf-url] Failed to delete ${filePath}:`, err);
        return;
      }

      await delay(25);
    }
  }
}

/** Delete every file this module still tracks. Never throws. */
export async function cleanupDownloadedFiles(): Promise<void> {
  const files = [...trackedFiles];
  trackedFiles.clear();

  await Promise.all(files.map((file) => deleteDownloadedFile(file)));
}

/** Forget all tracked files without touching the disk. Tests only. */
export function resetDownloadedFilesForTests(): void {
  trackedFiles.clear();
}
