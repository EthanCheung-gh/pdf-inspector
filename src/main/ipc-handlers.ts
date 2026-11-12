import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { deleteDownloadedFile, downloadPdfToFile, parsePdfUrl } from './pdf-url';
import { isDiffTimeoutError, type SidecarTransport } from './sidecar-pool';
import { IPC_CHANNELS, ANALYZE_FONTS_TIMEOUT_MS, AUDIT_TIMEOUT_MS, DIFF_TIMEOUT_MS, EXTRACT_PAGE_TIMEOUT_MS, OPEN_PDF_TIMEOUT_MS, RAW_TIMEOUT_MS, SECURITY_TIMEOUT_MS } from '../shared/constants';
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
 *
 * Both requests use OPEN_PDF_TIMEOUT_MS: opening parses the document (and scans
 * its font resources), which a large PDF can stretch past the 30s default, and a
 * restore is exactly as expensive as the open it follows.
 */
async function openInSidecar(sidecar: SidecarTransport, filePath: string): Promise<unknown> {
  const previousFilePath = currentFilePath;

  try {
    return await sidecar.send('open', { path: filePath }, OPEN_PDF_TIMEOUT_MS);
  } catch (err) {
    if (previousFilePath && previousFilePath !== filePath) {
      try {
        await sidecar.send('open', { path: previousFilePath }, OPEN_PDF_TIMEOUT_MS);
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

/**
 * Translate the renderer's `RawRef` argument into the RPC's snake_case params.
 *
 * Range validation belongs to the sidecar, which is the only side that knows
 * the document's object count; main only guarantees that the request carries a
 * usable object number so a malformed argument cannot reach the sidecar as
 * `{object_number: undefined}`. `generation` is forwarded only when supplied
 * (generation `0` is a real generation, so the check is on the type).
 */
function rawObjectParams(ref: unknown): { object_number: number; generation?: number } {
  const candidate = (ref ?? {}) as { objectNumber?: unknown; generation?: number };
  if (typeof candidate.objectNumber !== 'number' || !Number.isFinite(candidate.objectNumber)) {
    throw new Error('rawObject requires the objectNumber of a raw PDF reference');
  }

  const params: { object_number: number; generation?: number } = {
    object_number: candidate.objectNumber,
  };
  if (typeof candidate.generation === 'number' && Number.isFinite(candidate.generation)) {
    params.generation = candidate.generation;
  }
  return params;
}

export function registerIpcHandlers(sidecar: SidecarTransport): void {
  // Restore the tracked document on every successful sidecar start — the
  // initial boot, a crash-triggered auto-restart and a manual restart all pass
  // through SidecarManager.start(), which calls this hook exactly once and
  // swallows/logs failures. Without it a crash-restart would leave the sidecar
  // with no open PDF and every extract/analyze call would fail.
  //
  // The restore is a full `open` (parse + font-resource scan), so it gets the
  // same budget as a user-visible open instead of the 30s default: with the
  // default, re-opening a large PDF after a crash would time out and leave the
  // sidecar empty even though the open itself was healthy.
  sidecar.setDocumentRestorer(async () => {
    const filePath = currentFilePath;
    if (!filePath) return;
    await sidecar.send('open', { path: filePath }, OPEN_PDF_TIMEOUT_MS);
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

    return { canceled: false, path: filePath, metadata: meta, name: path.basename(filePath) };
  });

  // Document tabs: switch to a document the renderer already has a path for.
  //
  // No dialog is shown — the caller is the tab bar re-opening a document the
  // user opened earlier in this session. Tracking the file makes it the current
  // document (so a sidecar restart restores it) and deletes the downloaded temp
  // copy of the document it replaces; a URL tab re-downloads on activation
  // because its temp file is owned by the document that replaced it.
  ipcMain.handle(IPC_CHANNELS.OPEN_PDF_PATH, async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new Error('openPdfPath requires the path of the PDF to open');
    }

    const filePath = rawPath;
    const meta = await openInSidecar(sidecar, filePath);
    await trackOpenDocument(filePath, null);

    return { canceled: false, path: filePath, metadata: meta, name: path.basename(filePath) };
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PDF_URL, async (_event, rawUrl: string) => {
    // Parse first: a non-http(s) URL must never reach the network layer.
    const url = parsePdfUrl(rawUrl);

    // Download into a per-app temp directory. `downloadPdfToFile` applies its
    // own PDF_URL_TIMEOUT_MS / MAX_PDF_BYTES defaults; the sidecar open that
    // follows uses OPEN_PDF_TIMEOUT_MS (through `openInSidecar`) and the
    // renderer allows OPEN_PDF_URL_TIMEOUT_MS for both steps together.
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

  // One page is extracted per navigation and normally takes well under 0.1s,
  // but a single complex page (many tables and objects) is extracted in one
  // shot and can legitimately exceed the generic 30s budget. The longer budget
  // is per request, so it cannot extend a metadata or image call.
  ipcMain.handle(IPC_CHANNELS.EXTRACT_PAGE, async (_event, page: number) => {
    return sidecar.send('extract_page', { page }, EXTRACT_PAGE_TIMEOUT_MS);
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

  // Document security resources (attachments, JavaScript, actions, signatures,
  // encryption). Read-only and document-scoped like the audit and raw channels:
  // no handler sends `open`, so the Inspect document and the Diff/Audit inputs
  // stay untouched. The scan walks document-level name trees and stream
  // metadata, so it gets the dedicated security budget instead of the 30s
  // default; a failure here only affects the Resources view, never the audit.
  ipcMain.handle(IPC_CHANNELS.SECURITY_DOCUMENT, async () => {
    return sidecar.send('security_document', {}, SECURITY_TIMEOUT_MS);
  });

  // Raw PDF reads. Like the audit channels these inspect the document the
  // sidecar already has open: no handler sends `open`, so the Inspect document,
  // its caches and the Diff/Audit inputs stay exactly as they are. Each raw
  // request is bounded by its own budget instead of the 30s default, because it
  // may decode content streams for a page.
  ipcMain.handle(IPC_CHANNELS.RAW_DOCUMENT, async () => {
    return sidecar.send('raw_document', {}, RAW_TIMEOUT_MS);
  });

  ipcMain.handle(IPC_CHANNELS.RAW_OBJECT, async (_event, ref: unknown) => {
    return sidecar.send('raw_object', rawObjectParams(ref), RAW_TIMEOUT_MS);
  });

  ipcMain.handle(IPC_CHANNELS.RAW_PAGE_CONTENT, async (_event, page: number) => {
    // The sidecar validates that the page is 1-based and inside the document;
    // main only translates the argument to the RPC's `page` param.
    return sidecar.send('raw_page_content', { page }, RAW_TIMEOUT_MS);
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

      try {
        return await sidecar.send(
          'diff_documents',
          {
            old_path: oldPath,
            new_path: newPath,
            options: diffOptionsToRpc(options),
          },
          DIFF_TIMEOUT_MS,
        );
      } catch (error) {
        // A diff timeout means the sidecar stopped reporting progress, not that
        // it stopped working: the abandoned computation may still be running in
        // the background lane. Restart that lane (never the interactive one) so
        // the orphan process is killed and a retry starts clean. Best effort —
        // the renderer still gets the original timeout message.
        if (isDiffTimeoutError(error)) {
          await sidecar.restartBackground().catch((restartError) => {
            console.error(
              '[ipc] Background lane restart after diff timeout failed:',
              restartError,
            );
          });
        }
        throw error;
      }
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
      // Image exports arrive as base64 so the text IPC channel can carry binary
      // bytes; decode before writing or the PNG would be saved as base64 text.
      if (req.encoding === 'base64') {
        await writeFile(result.filePath, Buffer.from(req.content, 'base64'));
      } else {
        await writeFile(result.filePath, req.content, 'utf8');
      }
      return { canceled: false, filePath: result.filePath };
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });
}
