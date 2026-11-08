import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SidecarManager } from './sidecar';
import { deleteDownloadedFile, downloadPdfToFile, parsePdfUrl } from './pdf-url';
import { IPC_CHANNELS, ANALYZE_FONTS_TIMEOUT_MS, AUDIT_TIMEOUT_MS, DIFF_TIMEOUT_MS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';
import { UNSAFE_EXTERNAL_URL_ERROR, toSafeExternalUrl } from '../shared/external-url';
import type { OpenExternalResult } from '../shared/external-url';
import { diffOptionsToRpc } from '../shared/diff-types';
import type { DiffOptionsInput } from '../shared/diff-types';

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

  ipcMain.handle(IPC_CHANNELS.ANALYZE_FONTS, async (_event, startPage?: number, endPage?: number) => {
    // Font analysis walks every page and every font, so a large PDF legitimately
    // exceeds the default request timeout. This channel, like the audit
    // channels below, gets a longer budget; the others keep the 30s default.
    //
    // The page range is optional and 1-based/inclusive. Omitting both arguments
    // sends `{}`, which the sidecar treats as the whole document — the pre-range
    // behavior stays the default.
    const params: { start_page?: number; end_page?: number } = {};
    if (startPage !== undefined) params.start_page = startPage;
    if (endPage !== undefined) params.end_page = endPage;

    return sidecar.send('analyze_fonts', params, ANALYZE_FONTS_TIMEOUT_MS);
  });

  // A document audit inspects metadata, fonts and page geometry, and the
  // renderer then asks for page batches of 10. Every audit request walks a lot
  // of the document, so both channels get the dedicated audit budget instead of
  // the 30s default. The audit never opens a document: it inspects the one the
  // Inspect workspace already opened.
  ipcMain.handle(IPC_CHANNELS.AUDIT_DOCUMENT, async () => {
    return sidecar.send('audit_document', {}, AUDIT_TIMEOUT_MS);
  });

  ipcMain.handle(IPC_CHANNELS.AUDIT_PAGES, async (_event, startPage: number, endPage: number) => {
    // The sidecar validates that the range is 1-based, inclusive and inside the
    // document; main only translates the arguments to the RPC's snake_case keys.
    return sidecar.send(
      'audit_pages',
      { start_page: startPage, end_page: endPage },
      AUDIT_TIMEOUT_MS,
    );
  });

  ipcMain.handle(IPC_CHANNELS.GET_IMAGE_DATA, async (_event, streamId: string) => {
    return sidecar.send('get_image_data', { stream_id: streamId });
  });

  ipcMain.handle(
    IPC_CHANNELS.DIFF_PDFS,
    async (
      _event,
      oldPath: unknown,
      newPath: unknown,
      options?: DiffOptionsInput,
    ) => {
      // Two PDFs are diffed on throwaway extractors inside the sidecar: this
      // handler deliberately never sends `open`, so the Inspect document, its
      // page cache and the sidecar's current session stay exactly as they are.
      if (typeof oldPath !== 'string' || !oldPath.trim()) {
        throw new Error('diffPdfs requires the old PDF file path');
      }
      if (typeof newPath !== 'string' || !newPath.trim()) {
        throw new Error('diffPdfs requires the new PDF file path');
      }

      return sidecar.send(
        'diff_documents',
        {
          old_path: oldPath,
          new_path: newPath,
          options: diffOptionsToRpc(options),
        },
        DIFF_TIMEOUT_MS,
      );
    },
  );

  // A diff input picker: show a dialog and hand back a path. Deliberately
  // separate from OPEN_PDF — it must not open the file in the sidecar, open a
  // separate window, or otherwise disturb the Inspect document.
  ipcMain.handle(IPC_CHANNELS.PICK_DIFF_PDF, async (_event, side: unknown) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const label = side === 'new' ? 'newer' : 'older';
    const result = await dialog.showOpenDialog(win, {
      title: `Choose the ${label} PDF to compare`,
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    // The basename is all the renderer needs for a readable row label; the path
    // stays in `source` because that is what `diffPdfs` consumes on desktop.
    return { canceled: false, source: filePath, name: path.basename(filePath) };
  });

  ipcMain.handle(IPC_CHANNELS.SIDECAR_STATUS, async () => {
    return { running: sidecar.isRunning() };
  });

  // Open one link from an annotation in the OS default browser.
  //
  // The renderer never passes PDF.js `unsafeUrl` here, but main re-validates
  // anyway: the bridge is the boundary where a compromised or buggy renderer
  // could otherwise hand an arbitrary scheme to the shell. A refused or failed
  // open is reported as `{ ok: false, error }` instead of a rejection so the UI
  // can show it inline; nothing here touches the sidecar.
  ipcMain.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    async (_event, rawUrl: unknown): Promise<OpenExternalResult> => {
      const url = toSafeExternalUrl(rawUrl);
      if (url === null) {
        return { ok: false, error: UNSAFE_EXTERNAL_URL_ERROR };
      }

      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    },
  );

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
