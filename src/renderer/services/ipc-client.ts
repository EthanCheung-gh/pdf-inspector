import { IpcApi, SaveFileRequest } from '../types/ipc-protocol';
import type { RawRef } from '../types/raw-pdf';
import type { DiffOptionsInput, DiffSide, DiffSource } from '../../shared/diff-types';
import type { OpenExternalResult } from '../../shared/external-url';
import {
  ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
  AUDIT_RENDERER_TIMEOUT_MS,
  EXTRACT_PAGE_RENDERER_TIMEOUT_MS,
  OPEN_PDF_RENDERER_TIMEOUT_MS,
  OPEN_PDF_URL_TIMEOUT_MS,
  RAW_RENDERER_TIMEOUT_MS,
  SECURITY_RENDERER_TIMEOUT_MS,
} from '../../shared/constants';

declare global {
  interface Window {
    pdfInspector: IpcApi;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

let restartTimestamps: number[] = [];

/**
 * Window in which `MAX_RESTARTS` restarts are allowed.
 *
 * A method with a longer request budget also retries further apart, so a fixed
 * 60s window would let a long-budget method restart the sidecar forever (every
 * retry would look like a fresh start). Scaling the window with the budget keeps
 * the cap meaningful: a cheap 30s method keeps the original 60s (30s * 2), page
 * extraction gets 250s (125s * 2) and font analysis 250s as well.
 */
function restartWindowMs(timeoutMs: number): number {
  return Math.max(RESTART_WINDOW_MS, timeoutMs * 2);
}

function withinRestartBudget(timeoutMs: number): boolean {
  const now = Date.now();
  const windowMs = restartWindowMs(timeoutMs);
  restartTimestamps = restartTimestamps.filter((timestamp) => now - timestamp < windowMs);
  return restartTimestamps.length < MAX_RESTARTS;
}

function withTimeout<T>(fn: () => Promise<T>, method: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Sidecar timeout: ${method} exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    void fn().then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function callWithTimeout<T>(
  fn: () => Promise<T>,
  method: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  try {
    return await withTimeout(fn, method, timeoutMs);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('Sidecar timeout:'))) {
      throw error;
    }

    if (!withinRestartBudget(timeoutMs)) {
      throw new Error('Sidecar repeatedly crashes. Please restart the application.');
    }

    restartTimestamps.push(Date.now());
    let restartResult: Awaited<ReturnType<IpcApi['restartSidecar']>>;
    try {
      restartResult = await window.pdfInspector.restartSidecar();
    } catch (restartError) {
      const message = restartError instanceof Error ? restartError.message : 'Unknown error';
      throw new Error(`Sidecar restart failed: ${message}`);
    }

    if (!restartResult.success) {
      throw new Error(`Sidecar restart failed: ${restartResult.error ?? 'Unknown error'}`);
    }

    return withTimeout(fn, method, timeoutMs);
  }
}

export const ipc = {
  // Opening a document makes the sidecar parse it (pdfplumber open plus the
  // font-resource metadata scan), which a large or corrupt PDF can stretch far
  // past 30s. The renderer therefore waits longer than main's open budget so
  // main's clear `Request "open" timed out after 120s` surfaces first: an equal
  // budget would make the renderer lose the race one IPC hop early and restart
  // the sidecar instead of reporting the real error.
  openPdf: () =>
    callWithTimeout(
      () => window.pdfInspector.openPdf(),
      'openPdf',
      OPEN_PDF_RENDERER_TIMEOUT_MS,
    ),
  // A URL open downloads the whole document in the main process before the
  // sidecar parses it, so it needs a budget beyond the 30s default — and beyond
  // the download plus open budgets main actually spends.
  openPdfUrl: (url: string) =>
    callWithTimeout(() => window.pdfInspector.openPdfUrl(url), 'openPdfUrl', OPEN_PDF_URL_TIMEOUT_MS),
  // Document tabs re-open a path the user already chose, so there is no dialog
  // and the budget is a normal open budget. The bridge method is optional: only
  // the desktop preload implements it, so the browser build (where tabs switch by
  // server document id instead) gets a clear rejection rather than an opaque
  // `undefined is not a function` if a caller ever tries anyway.
  openPdfPath: (path: string) => {
    const openPdfPath = window.pdfInspector?.openPdfPath;
    if (typeof openPdfPath !== 'function') {
      return Promise.reject(
        new Error('Opening a local path is not available in this build'),
      );
    }
    return callWithTimeout(
      () => openPdfPath(path),
      'openPdfPath',
      OPEN_PDF_RENDERER_TIMEOUT_MS,
    );
  },
  // Web counterpart of `openPdfPath`: the browser activates a document the
  // server already holds, by registry id. It is the same cost as an open — the
  // sidecar must open and parse that document's file — so it gets the open
  // budget, not the 30s default. `callWithTimeout` restarts a wedged sidecar and
  // retries the captured id, so a switch is never half-applied by a timeout.
  //
  // Optional bridge method: only the web adapter implements it, so the desktop
  // build (and any caller that ignores `supportsDocumentTabs()`) gets a clear
  // rejection instead of `undefined is not a function`.
  activatePdfDocument: (id: string) => {
    const activatePdfDocument = window.pdfInspector?.activatePdfDocument;
    if (typeof activatePdfDocument !== 'function') {
      return Promise.reject(
        new Error('Activating a server document is not available in this build'),
      );
    }
    return callWithTimeout(
      () => activatePdfDocument(id),
      'activatePdfDocument',
      OPEN_PDF_RENDERER_TIMEOUT_MS,
    );
  },
  // Closing only drops a registry entry and deletes that document's temp copy,
  // so the default 30s budget is already generous. The bridge method is optional
  // (web only); a rejection means the document is still open and the caller must
  // keep its tab.
  closePdfDocument: (id: string) => {
    const closePdfDocument = window.pdfInspector?.closePdfDocument;
    if (typeof closePdfDocument !== 'function') {
      return Promise.reject(
        new Error('Closing a server document is not available in this build'),
      );
    }
    return callWithTimeout(() => closePdfDocument(id), 'closePdfDocument');
  },
  // One page is extracted per navigation and normally returns in well under
  // 0.1s, but a single complex page (many tables and objects) is extracted in
  // one shot, so it gets its own budget instead of the 30s default. The renderer
  // waits longer than main so main's clear `Request "extract_page" timed out
  // after 120s` surfaces first; an equal budget would make the renderer lose the
  // race one IPC hop early and restart the sidecar instead of reporting why the
  // page failed.
  extractPage: (page: number) =>
    callWithTimeout(
      () => window.pdfInspector.extractPage(page),
      'extractPage',
      EXTRACT_PAGE_RENDERER_TIMEOUT_MS,
    ),
  extractMetadata: () => callWithTimeout(() => window.pdfInspector.extractMetadata(), 'extractMetadata'),
  // Must be LARGER than the main-process budget so main's own timeout (and its
  // clear error) surfaces first: an equal budget would make the renderer lose
  // the race one IPC hop early and restart the sidecar instead.
  //
  // The optional 1-based, inclusive page range is forwarded verbatim; a retry
  // after a restart re-sends the same range because the arguments are captured
  // in the retried closure.
  analyzeFonts: (startPage?: number, endPage?: number) =>
    callWithTimeout(
      () => window.pdfInspector.analyzeFonts(startPage, endPage),
      'analyzeFonts',
      ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
    ),
  getImageData: (streamId: string) => callWithTimeout(() => window.pdfInspector.getImageData(streamId), 'getImageData'),
  // Raw reads decode one object or one page's content streams in the sidecar, so
  // they get the same dedicated budget as font analysis: the renderer must stay
  // patient longer than main so main's clear timeout message wins the race.
  //
  // Only a timeout can restart the sidecar (see `callWithTimeout`); an invalid
  // object/page is rejected by the sidecar's range check and propagates as a
  // plain error, so a bad reference never costs the user a restart. A retry
  // re-sends the captured ref/page because the arguments are closed over.
  rawDocument: () =>
    callWithTimeout(
      () => window.pdfInspector.rawDocument(),
      'rawDocument',
      RAW_RENDERER_TIMEOUT_MS,
    ),
  rawObject: (ref: RawRef) =>
    callWithTimeout(
      () => window.pdfInspector.rawObject(ref),
      'rawObject',
      RAW_RENDERER_TIMEOUT_MS,
    ),
  rawPageContent: (page: number) =>
    callWithTimeout(
      () => window.pdfInspector.rawPageContent(page),
      'rawPageContent',
      RAW_RENDERER_TIMEOUT_MS,
    ),
  // Audit requests walk the document (metadata/fonts/page geometry, then 10-page
  // batches), so they get the same kind of dedicated budget as font analysis:
  // the renderer must stay patient longer than main so main's clear timeout
  // message wins the race. `auditPages` re-sends its captured range on a retry;
  // `auditDocument` takes no arguments.
  auditDocument: () =>
    callWithTimeout(
      () => window.pdfInspector.auditDocument(),
      'auditDocument',
      AUDIT_RENDERER_TIMEOUT_MS,
    ),
  auditPages: (startPage: number, endPage: number) =>
    callWithTimeout(
      () => window.pdfInspector.auditPages(startPage, endPage),
      'auditPages',
      AUDIT_RENDERER_TIMEOUT_MS,
    ),
  // The document security scan walks name trees and stream metadata, so it gets
  // the same kind of dedicated budget as the audit: the renderer must stay
  // patient longer than main so main's clear timeout message wins the race. A
  // timeout restarts and retries once, and the retry is safe because the scan is
  // read-only and takes no arguments.
  securityDocument: () =>
    callWithTimeout(
      () => window.pdfInspector.securityDocument(),
      'securityDocument',
      SECURITY_RENDERER_TIMEOUT_MS,
    ),
  // No renderer timer: a diff's budget is an INACTIVITY budget in the backend
  // (main process / web server), rearmed by every progress report the sidecar
  // emits, so a large pair may legitimately run for many minutes while pages
  // keep completing. A fixed renderer cap would fail exactly those runs and
  // restart a healthy sidecar, so the progress-aware backend owns the timeout
  // (like `saveFile`/`pickDiffPdf`, which also resolve outside `callWithTimeout`).
  diffPdfs: (oldSource: DiffSource, newSource: DiffSource, options?: DiffOptionsInput) =>
    window.pdfInspector.diffPdfs(oldSource, newSource, options),
  // No timeout: this resolves only after the user answers a native file dialog
  // (or dismisses the browser's file picker), which can take arbitrarily long.
  pickDiffPdf: (side: DiffSide) => window.pdfInspector.pickDiffPdf(side),
  getSidecarStatus: () => callWithTimeout(() => window.pdfInspector.getSidecarStatus(), 'getSidecarStatus'),
  restartSidecar: () => window.pdfInspector.restartSidecar(),
  saveFile: (req: SaveFileRequest) => window.pdfInspector.saveFile(req),
  // Opening a link is a pure shell/browser action: no sidecar request is sent,
  // so it must stay outside `callWithTimeout` — a slow or refused open would
  // otherwise be reported as a "Sidecar timeout" and restart the sidecar. The
  // bridge failure is folded into the typed result the UI already handles.
  openExternal: async (url: string): Promise<OpenExternalResult> => {
    try {
      return await window.pdfInspector.openExternal(url);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },
};
