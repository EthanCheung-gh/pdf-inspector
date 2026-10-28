import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SidecarManager } from './sidecar';
import { deleteDownloadedFile, downloadPdfToFile, parsePdfUrl } from './pdf-url';
import { IPC_CHANNELS, ANALYZE_FONTS_TIMEOUT_MS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';

/** Tracks the open PDF so a restarted sidecar can restore its document state. */
let currentFilePath: string | null = null;
/**
 * Downloaded copy of a remote PDF, when the open document came from a URL.
 * Kept separate from `currentFilePath` because only this file may be deleted
 * once another document replaces it — a local file belongs to the user.
 */
let currentTempFile: string | null = null;

/**
 * Open `filePath` in the sidecar, restoring the previously open document when
 * the sidecar rejects it.
 *
 * The sidecar closes the previous document before opening the new one, so a
 * failed open leaves it with no document while main still tracks the old file
 * (and the renderer still shows it). Best-effort re-open the previous document
 * to keep main and the sidecar in sync, then propagate the original error
 * unchanged.
 */
async function openInSidecar(sidecar: SidecarManager, filePath: string): Promise<unknown> {
  const previousFilePath = currentFilePath;

  try {
    return await sidecar.send('open', { path: filePath });
  } catch (err) {
    if (previousFilePath && previousFilePath !== filePath) {
      try {
        await sidecar.send('open', { path: previousFilePath });
      } catch (restoreErr) {
        console.error('[main] Failed to re-open previous document:', restoreErr);
      }
    }
    throw err;
  }
}

/**
 * Record a successfully opened document and delete the downloaded temp file it
 * replaces.
 *
 * Only called after `open` succeeded, so the file the sidecar currently has
 * open is never removed; the previous download is the only one dropped, and
 * only when it is not the file just opened.
 */
async function trackOpenDocument(filePath: string, tempFile: string | null): Promise<void> {
  const previousTempFile = currentTempFile;
  currentFilePath = filePath;
  currentTempFile = tempFile;

  if (previousTempFile && previousTempFile !== filePath) {
    await deleteDownloadedFile(previousTempFile);
  }
}

export function registerIpcHandlers(sidecar: SidecarManager): void {
  // Restore the tracked document on every successful sidecar start — the
  // initial boot, a crash-triggered auto-restart and a manual restart all pass
  // through SidecarManager.start(), which calls this hook exactly once and
  // swallows/logs failures. Without it a crash-restart would leave the sidecar
  // with no open PDF and every extract/analyze call would fail.
  sidecar.setDocumentRestorer(async () => {
    const filePath = currentFilePath;
    if (!filePath) return;
    await sidecar.send('open', { path: filePath });
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PDF, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const meta = await openInSidecar(sidecar, filePath);
    // The user opened a local file, so a previously downloaded copy is no
    // longer the open document and can be removed.
    await trackOpenDocument(filePath, null);

    return { canceled: false, path: filePath, metadata: meta };
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PDF_URL, async (_event, rawUrl: string) => {
    // Parse first: a non-http(s) URL must never reach the network layer.
    const url = parsePdfUrl(rawUrl);

    // Download into a per-app temp directory. `downloadPdfToFile` applies its
    // own PDF_URL_TIMEOUT_MS / MAX_PDF_BYTES defaults; the renderer allows the
    // larger OPEN_PDF_URL_TIMEOUT_MS for download plus sidecar open.
    const directory = path.join(app.getPath('temp'), 'pdf-inspector');
    const downloadedPath = await downloadPdfToFile(url, { directory });

    let meta: unknown;
    try {
      meta = await openInSidecar(sidecar, downloadedPath);
    } catch (err) {
      // `openInSidecar` already restored the previous document, so the fresh
      // download is garbage: delete it before propagating the original error.
      await deleteDownloadedFile(downloadedPath);
      throw err;
    }

    await trackOpenDocument(downloadedPath, downloadedPath);

    return {
      canceled: false,
      path: downloadedPath,
      metadata: meta,
      sourceUrl: url.href,
    };
  });

  ipcMain.handle(IPC_CHANNELS.RESTART_SIDECAR, async () => {
    try {
      // `restart()` sends `open` for the current document through the
      // document-restorer hook, so it is not repeated here.
      await sidecar.restart();
      return { success: true, running: sidecar.isRunning() };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, running: sidecar.isRunning(), error };
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXTRACT_PAGE, async (_event, page: number) => {
    return sidecar.send('extract_page', { page });
  });

  ipcMain.handle(IPC_CHANNELS.EXTRACT_METADATA, async () => {
    return sidecar.send('extract_metadata');
  });

  ipcMain.handle(IPC_CHANNELS.ANALYZE_FONTS, async () => {
    // Font analysis walks every page and every font, so a large PDF legitimately
    // exceeds the default request timeout. Only this channel gets the longer
    // budget; the others keep the 30s default.
    return sidecar.send('analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS);
  });

  ipcMain.handle(IPC_CHANNELS.GET_IMAGE_DATA, async (_event, streamId: string) => {
    return sidecar.send('get_image_data', { stream_id: streamId });
  });

  ipcMain.handle(IPC_CHANNELS.SIDECAR_STATUS, async () => {
    return { running: sidecar.isRunning() };
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_FILE, async (event, req: SaveFileRequest) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('No active window');

    const result = await dialog.showSaveDialog(win, {
      title: 'Export data',
      defaultPath: req.defaultPath,
      filters: [{ name: req.filterName, extensions: req.extensions }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    try {
      await writeFile(result.filePath, req.content, 'utf8');
      return { canceled: false, filePath: result.filePath };
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });
}
