/**
 * Browser implementation of the Electron preload bridge (`window.pdfInspector`).
 *
 * The React renderer was written against `IpcApi` and reaches the Python sidecar
 * through IPC. In a normal browser there is no preload script, so this module
 * implements the same contract over `fetch` against the Node HTTP backend
 * (`server/web-server.ts`), which serves the SPA from `dist-web/` and exposes
 * `/api/*` plus `/doc/*` endpoints.
 *
 * Design notes:
 * - No React import: this module must be safe to evaluate before `ReactDOM`
 *   renders (see `src/web/install.ts`).
 * - `installWebIpc()` is a no-op when `window.pdfInspector` already exists, so
 *   loading the same bundle under Electron keeps the real preload bridge.
 * - The renderer treats `filePath` values starting with `http(s)://` as remote
 *   documents (see `PdfViewport`), so document paths returned by the backend are
 *   resolved to absolute URLs against the current origin.
 */
import type {
  FontStat,
  IpcApi,
  OpenPdfResult,
  SaveFileResult,
} from '../renderer/types/ipc-protocol';
import type { PageData, PdfMetadata } from '../renderer/types/pdf-objects';
import type {
  RawDocument,
  RawObject,
  RawPageContent,
  RawRef,
} from '../renderer/types/raw-pdf';
import type { SaveFileRequest } from '../shared/constants';
import { PdfDocumentNotFoundError } from '../shared/document-errors';
import { UNSAFE_EXTERNAL_URL_ERROR, toSafeExternalUrl } from '../shared/external-url';
import type { OpenExternalResult } from '../shared/external-url';
import type { AuditDocumentResult, AuditPagesResult } from '../shared/audit-types';
import { isFileSource } from '../shared/diff-types';
import type {
  DiffOptionsInput,
  DiffResult,
  DiffSide,
  DiffSource,
} from '../shared/diff-types';

/** Grace period after the window regains focus before assuming "canceled". */
const CANCEL_FOCUS_GRACE_MS = 300;

/** Delay before revoking the download object URL (some engines abort early). */
const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

/** Wire shape of a successful `POST /api/open`, `/api/open-url` or activate reply. */
interface ServerOpenDocumentResult {
  canceled?: boolean;
  path?: string;
  metadata?: PdfMetadata;
  name?: string;
  sourceUrl?: string;
  /** Registry id of the opened/activated document (web multi-document). */
  documentId?: string;
}

interface RestartResult {
  success: boolean;
  running: boolean;
  error?: string;
}

/**
 * The global `Window.pdfInspector` declaration lives in the renderer
 * (`src/renderer/services/ipc-client.ts`). Reading it through a local optional
 * shape keeps this module independent of that file while still allowing the
 * "already installed by the preload script" check.
 */
function inspectorWindow(): { pdfInspector?: IpcApi } {
  return window as unknown as { pdfInspector?: IpcApi };
}

/** Last path segment, handling both POSIX and Windows separators. */
export function basename(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/** Resolve a backend document path (`/doc/<id>/<name>`) to an absolute URL. */
function toAbsoluteDocumentUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

/**
 * Turn a failed response into an `Error` with the most useful message available.
 *
 * The backend answers errors with `{ "error": "..." }`, but a proxy, a crash or
 * a wrong base path may produce plain text or an HTML error page. Never let
 * `response.json()` throw and hide the status code.
 */
async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`.trim();

  try {
    const raw = await response.text();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;
          const candidate = record.error ?? record.message;
          if (typeof candidate === 'string' && candidate.trim()) {
            message = candidate;
          } else if (candidate !== undefined && candidate !== null) {
            message = JSON.stringify(candidate);
          } else {
            message = raw;
          }
        } else if (typeof parsed === 'string' && parsed.trim()) {
          message = parsed;
        } else {
          message = raw;
        }
      } catch {
        // Not JSON: keep the raw body (often a proxy/HTML error page).
        message = raw;
      }
    }
  } catch {
    // Body unreadable: fall back to the status line.
  }

  return new Error(message);
}

/** Parse a successful reply body, or throw with the server's error message. */
async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await responseError(response);
  }

  return (await response.json()) as T;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return readJson<T>(response);
}

/** Registry endpoint of one server-side document, id URI-encoded. */
function documentApiPath(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}`;
}

/** Forward a sidecar request; the backend returns the sidecar result verbatim. */
async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const payload: { method: string; params?: Record<string, unknown> } = { method };
  if (params) payload.params = params;
  return postJson<T>('/api/rpc', payload);
}

/** Map the backend document descriptor to the renderer's `OpenPdfResult`. */
function mapOpenResult(result: ServerOpenDocumentResult): OpenPdfResult {
  if (!result || result.canceled) {
    return { canceled: true };
  }
  if (!result.path) {
    throw new Error('Server returned no document path');
  }

  const mapped: OpenPdfResult = {
    canceled: false,
    path: toAbsoluteDocumentUrl(result.path),
    metadata: result.metadata as PdfMetadata,
  };
  // The backend's display name is the user's original upload name (Unicode
  // preserved), while `path` ends in `%E6%B5%8B...`; keep it for labels and
  // export file names.
  if (result.name) {
    mapped.name = result.name;
  }
  if (result.sourceUrl) {
    mapped.sourceUrl = result.sourceUrl;
  }
  // The registry id is what lets a tab activate or close this exact document
  // later; a backend without multi-document support simply omits it.
  if (result.documentId) {
    mapped.documentId = result.documentId;
  }
  return mapped;
}

/**
 * Build the raw-body upload request for a picked file.
 *
 * Exported so the upload contract (raw PDF body + URI-encoded `X-Filename`) can
 * be verified without driving a native file dialog in tests.
 */
export function buildOpenPdfRequest(file: File): { url: string; init: RequestInit } {
  return {
    url: '/api/open',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent(file.name),
      },
      body: file,
    },
  };
}

/** Upload an already-selected file and normalise the backend reply. */
async function uploadPdf(file: File): Promise<OpenPdfResult> {
  const { url, init } = buildOpenPdfRequest(file);
  const response = await fetch(url, init);

  if (!response.ok) {
    throw await responseError(response);
  }

  return mapOpenResult((await response.json()) as ServerOpenDocumentResult);
}

/**
 * Build the raw-body diff upload request for one side of a diff.
 *
 * Unlike `/api/open` this does not replace the current document: the backend
 * stores the bytes under a short-lived token and `/api/diff` consumes it.
 * Exported so the header contract (`X-Diff-Side` + URI-encoded `X-Filename`)
 * can be verified without a real backend.
 */
export function buildDiffUploadRequest(
  file: File,
  side: DiffSide,
): { url: string; init: RequestInit } {
  return {
    url: '/api/diff/file',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent(file.name),
        'X-Diff-Side': side,
      },
      body: file,
    },
  };
}

/** Upload one side of a browser diff and return its short-lived token. */
async function uploadDiffFile(file: File, side: DiffSide): Promise<string> {
  const { url, init } = buildDiffUploadRequest(file, side);
  const response = await fetch(url, init);

  if (!response.ok) {
    throw await responseError(response);
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('Server returned no diff upload token');
  }
  return body.token;
}

/**
 * Diff two browser `File`s.
 *
 * The browser cannot hand local paths to the backend, so each file is uploaded
 * to `/api/diff/file` (token per side) and `/api/diff` runs the sidecar diff on
 * the two temporary copies. The backend deletes both copies when the diff
 * settles — success or failure — and never touches the current document.
 */
async function diffPdfs(
  oldSource: DiffSource,
  newSource: DiffSource,
  options?: DiffOptionsInput,
): Promise<DiffResult> {
  if (!isFileSource(oldSource) || !isFileSource(newSource)) {
    throw new Error(
      'The web build diffs two selected files; file paths are only supported in the desktop app',
    );
  }

  const oldToken = await uploadDiffFile(oldSource, 'old');
  const newToken = await uploadDiffFile(newSource, 'new');

  return postJson<DiffResult>('/api/diff', {
    oldToken,
    newToken,
    options: options ?? {},
  });
}

/**
 * Show a native file picker and resolve with the chosen PDF (or `null`).
 *
 * `cancel` is a recent (Chromium/Firefox) input event; older engines only
 * signal a dismissal by focusing the window again, so a focus fallback with a
 * short grace period guarantees the promise always settles. The grace period
 * also lets the `change` event win when focus arrives first.
 */
function pickPdfFile(): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.display = 'none';
    input.setAttribute('aria-hidden', 'true');

    let settled = false;
    let focusTimer: number | undefined;

    const cleanup = (): void => {
      input.removeEventListener('change', handleChange);
      input.removeEventListener('cancel', handleCancel);
      window.removeEventListener('focus', handleFocus);
      if (focusTimer !== undefined) {
        window.clearTimeout(focusTimer);
        focusTimer = undefined;
      }
      input.remove();
    };

    const settle = (file: File | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };

    function handleChange(): void {
      settle(input.files && input.files.length > 0 ? input.files[0] : null);
    }

    function handleCancel(): void {
      settle(null);
    }

    function handleFocus(): void {
      if (focusTimer !== undefined) return;
      focusTimer = window.setTimeout(() => {
        focusTimer = undefined;
        const files = input.files;
        settle(files && files.length > 0 ? files[0] : null);
      }, CANCEL_FOCUS_GRACE_MS);
    }

    input.addEventListener('change', handleChange);
    input.addEventListener('cancel', handleCancel);
    window.addEventListener('focus', handleFocus);

    document.body.appendChild(input);
    input.click();
  });
}

/** Pick a MIME type for a download from the request or the requested extensions. */
function downloadMimeType(req: SaveFileRequest): string {
  const explicit = req.mimeType?.trim();
  if (explicit) return explicit;

  const extension = (req.extensions[0] ?? '').toLowerCase();
  switch (extension) {
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'text/plain';
  }
}

/**
 * Decode base64 to bytes without Node globals.
 *
 * `atob` yields one character per byte, so the char codes are the binary
 * payload. It throws on malformed input, which surfaces as a failed save instead
 * of a corrupt file.
 */
function base64ToBytes(content: string) {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Save a text export by starting a browser download.
 *
 * A browser has no reliable "did the user cancel the save dialog" signal: the
 * download either starts or it silently does not. Report `canceled: false` and
 * the requested default path so the renderer does not show a spurious error.
 * The `download` attribute only carries the basename - the browser decides the
 * directory and may de-duplicate the name (`page-1 (1).json`).
 */
function saveFile(req: SaveFileRequest): SaveFileResult {
  const fileName = basename(req.defaultPath) || 'export.txt';
  // Binary exports carry a base64 string; decoding first keeps the downloaded
  // PNG/SVG from being the base64 text itself.
  const content = req.encoding === 'base64' ? base64ToBytes(req.content) : req.content;
  const blob = new Blob([content], { type: downloadMimeType(req) });
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Revoking synchronously can abort the download in some engines, so defer.
    if (typeof URL.revokeObjectURL === 'function') {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOKE_DELAY_MS);
    }
  }

  return { canceled: false, filePath: req.defaultPath };
}

/**
 * Open one external link in a new tab.
 *
 * Exported so the safety policy can be verified without a real `window.open`.
 * The URL is re-validated here: the browser adapter is a full bridge
 * implementation and must not trust its caller any more than the main process
 * does. Only the sanitized URL is ever passed on — never PDF.js `unsafeUrl` —
 * and `noopener,noreferrer` is always requested so the target page gets neither
 * a `window.opener` handle back into the app nor a `Referer`.
 *
 * A blocked popup is not reported as a failure: per the HTML spec `window.open`
 * returns `null` when `noopener` is requested whether or not a tab opened, so
 * that value carries no signal. Only a browser without `window.open` and a
 * thrown error are treated as failures.
 */
export function openExternalInBrowser(url: string): OpenExternalResult {
  const safeUrl = toSafeExternalUrl(url);
  if (safeUrl === null) {
    return { ok: false, error: UNSAFE_EXTERNAL_URL_ERROR };
  }

  if (typeof window.open !== 'function') {
    return { ok: false, error: 'Opening links is not available in this browser' };
  }

  try {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/** Create a `window.pdfInspector`-compatible object backed by the HTTP API. */
export function createWebIpc(): IpcApi {
  return {
    openPdf: async () => {
      const file = await pickPdfFile();
      if (!file) return { canceled: true };
      return uploadPdf(file);
    },

    openPdfUrl: async (url: string) => {
      const response = await postJson<ServerOpenDocumentResult>('/api/open-url', { url });
      return mapOpenResult(response);
    },

    // Web multi-document: the server keeps a bounded registry, so a tab can
    // re-activate a document it opened earlier (the reply carries the same
    // shape as an open, including the id and the resolved `/doc/<id>` path) and
    // close one it no longer shows. Activating never re-uploads or
    // re-downloads: the server already owns the bytes.
    activatePdfDocument: async (id: string) => {
      const response = await fetch(`${documentApiPath(id)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // A 404 is not a generic failure: the id was evicted or the server
      // restarted, and a tab that still knows its source URL can re-open it.
      // Any other status (409 while restoring, 500, ...) stays a plain error.
      if (response.status === 404) {
        throw new PdfDocumentNotFoundError((await responseError(response)).message);
      }
      return mapOpenResult(await readJson<ServerOpenDocumentResult>(response));
    },

    closePdfDocument: async (id: string) => {
      const response = await fetch(documentApiPath(id), { method: 'DELETE' });
      // The server has already forgotten the id, so there is nothing to delete
      // and nothing to report: the caller drops the tab as if it had closed.
      // A 404 here is NOT an error the user should see — the tab is stale.
      if (response.status === 404) {
        return { closed: false, notFound: true };
      }
      // A 409 (active document with siblings) or a 5xx throws instead, so the
      // caller keeps the tab and reports the server's message.
      const body = await readJson<{ closed?: unknown }>(response);
      return { closed: body.closed !== false };
    },

    // Deliberately no `openPdfPath`: a browser has no known local paths, so the
    // desktop-only path bridge stays absent. Web tabs switch through
    // `activatePdfDocument` (server document id) instead, which is why
    // `supportsDocumentTabs()` accepts either method.

    extractPage: (page: number) => rpc<PageData>('extract_page', { page }),

    extractMetadata: () => rpc<PdfMetadata>('extract_metadata'),

    analyzeFonts: (startPage?: number, endPage?: number) => {
      const params: Record<string, number> = {};
      if (typeof startPage === 'number') params.start_page = startPage;
      if (typeof endPage === 'number') params.end_page = endPage;
      return rpc<{ fonts: FontStat[] }>('analyze_fonts', params);
    },

    // The audit inspects the document the backend already has open; both calls
    // are plain allowlisted RPCs and never upload or replace that document.
    auditDocument: () => rpc<AuditDocumentResult>('audit_document'),

    auditPages: (startPage: number, endPage: number) =>
      rpc<AuditPagesResult>('audit_pages', { start_page: startPage, end_page: endPage }),

    diffPdfs,

    // The browser picks a `File`; the setup dialog labels the row with its name
    // and `diffPdfs` uploads it. Nothing is sent to the backend until the user
    // asks for a comparison.
    pickDiffPdf: async (_side: DiffSide) => {
      const file = await pickPdfFile();
      if (!file) return { canceled: true };
      return { canceled: false, source: file, name: file.name };
    },

    getImageData: (streamId: string) =>
      rpc<{ base64?: string; format?: string; error?: string }>('get_image_data', {
        stream_id: streamId,
      }),

    // Raw reads inspect the document the backend already has open; all three are
    // plain allowlisted RPCs and never upload or replace that document. The ref
    // is translated to the sidecar's snake_case keys here, exactly like the
    // desktop handler does, so both bridges send the same params.
    rawDocument: () => rpc<RawDocument>('raw_document'),

    rawObject: (ref: RawRef) =>
      rpc<RawObject>('raw_object', {
        object_number: ref.objectNumber,
        generation: ref.generation,
      }),

    rawPageContent: (page: number) => rpc<RawPageContent>('raw_page_content', { page }),

    getSidecarStatus: async () => {
      const response = await fetch('/api/status', { method: 'GET' });
      if (!response.ok) {
        throw await responseError(response);
      }
      return (await response.json()) as { running: boolean };
    },

    restartSidecar: () => postJson<RestartResult>('/api/restart', {}),

    saveFile: async (req: SaveFileRequest) => saveFile(req),

    // Never reaches the backend: opening a link is a pure browser action, and
    // the adapter validates the URL itself instead of trusting the annotation.
    openExternal: async (url: string) => openExternalInBrowser(url),
  };
}

/**
 * Install the browser bridge unless one is already present.
 *
 * Returns `true` when this call installed the adapter and `false` when an
 * existing bridge (e.g. the Electron preload script) was left untouched.
 */
export function installWebIpc(): boolean {
  const target = inspectorWindow();
  if (target.pdfInspector) {
    return false;
  }
  target.pdfInspector = createWebIpc();
  return true;
}
