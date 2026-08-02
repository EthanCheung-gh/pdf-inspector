import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { SidecarManager } from './sidecar';
import { IPC_CHANNELS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';

/** Tracks the open PDF so a restarted sidecar can restore its document state. */
let currentFilePath: string | null = null;

export function registerIpcHandlers(sidecar: SidecarManager): void {
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
    const meta = await sidecar.send('open', { path: filePath });
    currentFilePath = filePath;
    return { canceled: false, path: filePath, metadata: meta };
  });

  ipcMain.handle(IPC_CHANNELS.RESTART_SIDECAR, async () => {
    try {
      await sidecar.restart();
      if (currentFilePath) {
        await sidecar.send('open', { path: currentFilePath });
      }
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
