import { IpcApi, SaveFileRequest } from '../types/ipc-protocol';

declare global {
  interface Window {
    pdfInspector: IpcApi;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

let restartTimestamps: number[] = [];

function withinRestartBudget(): boolean {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS);
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

    if (!withinRestartBudget()) {
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
  extractPage: (page: number) => callWithTimeout(() => window.pdfInspector.extractPage(page), 'extractPage'),
  extractMetadata: () => callWithTimeout(() => window.pdfInspector.extractMetadata(), 'extractMetadata'),
  analyzeFonts: () => callWithTimeout(() => window.pdfInspector.analyzeFonts(), 'analyzeFonts'),
  getImageData: (streamId: string) => callWithTimeout(() => window.pdfInspector.getImageData(streamId), 'getImageData'),
  getSidecarStatus: () => callWithTimeout(() => window.pdfInspector.getSidecarStatus(), 'getSidecarStatus'),
  restartSidecar: () => window.pdfInspector.restartSidecar(),
  saveFile: (req: SaveFileRequest) => window.pdfInspector.saveFile(req),
};
