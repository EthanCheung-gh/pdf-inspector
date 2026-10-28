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
import type { SaveFileRequest } from '../shared/constants';

/** Grace period after the window regains focus before assuming "canceled". */
const CANCEL_FOCUS_GRACE_MS = 300;

/** Delay before revoking the download object URL (some engines abort early). */
const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

/** Wire shape of a successful `POST /api/open` or `POST /api/open-url` reply. */
interface ServerOpenDocumentResult {
  canceled?: boolean;
  path?: string;
  metadata?: PdfMetadata;
  name?: string;
  sourceUrl?: string;
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

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return (await response.json()) as T;
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
  if (result.sourceUrl) {
    mapped.sourceUrl = result.sourceUrl;
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

/** Pick a MIME type for a download from the requested extensions. */
function downloadMimeType(req: SaveFileRequest): string {
  const extension = (req.extensions[0] ?? '').toLowerCase();
  switch (extension) {
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'text/plain';
  }
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
  const blob = new Blob([req.content], { type: downloadMimeType(req) });
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

    extractPage: (page: number) => rpc<PageData>('extract_page', { page }),

    extractMetadata: () => rpc<PdfMetadata>('extract_metadata'),

    analyzeFonts: (startPage?: number, endPage?: number) => {
      const params: Record<string, number> = {};
      if (typeof startPage === 'number') params.start_page = startPage;
      if (typeof endPage === 'number') params.end_page = endPage;
      return rpc<{ fonts: FontStat[] }>('analyze_fonts', params);
    },

    getImageData: (streamId: string) =>
      rpc<{ base64?: string; format?: string; error?: string }>('get_image_data', {
        stream_id: streamId,
      }),

    getSidecarStatus: async () => {
      const response = await fetch('/api/status', { method: 'GET' });
      if (!response.ok) {
        throw await responseError(response);
      }
      return (await response.json()) as { running: boolean };
    },

    restartSidecar: () => postJson<RestartResult>('/api/restart', {}),

    saveFile: async (req: SaveFileRequest) => saveFile(req),
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
