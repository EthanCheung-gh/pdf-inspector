import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';

contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  getImageData: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_DATA, streamId),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
  restartSidecar: () => ipcRenderer.invoke(IPC_CHANNELS.RESTART_SIDECAR),
  saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE, req),
});
