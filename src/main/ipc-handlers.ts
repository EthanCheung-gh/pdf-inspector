import { ipcMain, dialog, BrowserWindow } from 'electron';
import { SidecarManager } from './sidecar';
import { IPC_CHANNELS } from '../shared/constants';

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
    return { canceled: false, path: filePath, metadata: meta };
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
}
