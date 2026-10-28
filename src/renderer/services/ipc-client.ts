import { IpcApi, SaveFileRequest } from '../types/ipc-protocol';
import {
  ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
  OPEN_PDF_URL_TIMEOUT_MS,
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
 * 60s window would let a 120s method restart the sidecar forever (every retry
 * would look like a fresh start). Scaling the window with the budget keeps the
 * cap meaningful: extraction keeps its original 60s (30s * 2), font analysis
 * gets 240s.
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
  openPdf: () => callWithTimeout(() => window.pdfInspector.openPdf(), 'openPdf'),
  // A URL open downloads the whole document in the main process before the
  // sidecar parses it, so it needs a budget beyond the 30s default.
  openPdfUrl: (url: string) =>
    callWithTimeout(() => window.pdfInspector.openPdfUrl(url), 'openPdfUrl', OPEN_PDF_URL_TIMEOUT_MS),
  extractPage: (page: number) => callWithTimeout(() => window.pdfInspector.extractPage(page), 'extractPage'),
  extractMetadata: () => callWithTimeout(() => window.pdfInspector.extractMetadata(), 'extractMetadata'),
  // Must be LARGER than the main-process budget so main's own timeout (and its
  // clear error) surfaces first: an equal budget would make the renderer lose
  // the race one IPC hop early and restart the sidecar instead.
  analyzeFonts: () =>
    callWithTimeout(
      () => window.pdfInspector.analyzeFonts(),
      'analyzeFonts',
      ANALYZE_FONTS_RENDERER_TIMEOUT_MS,
    ),
  getImageData: (streamId: string) => callWithTimeout(() => window.pdfInspector.getImageData(streamId), 'getImageData'),
  getSidecarStatus: () => callWithTimeout(() => window.pdfInspector.getSidecarStatus(), 'getSidecarStatus'),
  restartSidecar: () => window.pdfInspector.restartSidecar(),
  saveFile: (req: SaveFileRequest) => window.pdfInspector.saveFile(req),
};
