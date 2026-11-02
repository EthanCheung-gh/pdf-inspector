import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';
import type { DiffOptionsInput, DiffSide, DiffSource } from '../shared/diff-types';

contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  openPdfUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF_URL, url),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  analyzeFonts: (startPage?: number, endPage?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANALYZE_FONTS, startPage, endPage),
  diffPdfs: (oldSource: DiffSource, newSource: DiffSource, options?: DiffOptionsInput) => {
    // Electron's structured clone cannot carry a `File`, and the rejection the
    // clone would throw is opaque. Reject with an actionable message instead;
    // the renderer must resolve picked files to paths before calling this.
    if (typeof oldSource !== 'string' || typeof newSource !== 'string') {
      return Promise.reject(
        new Error('diffPdfs in the desktop app takes two file paths, not File objects'),
      );
    }
    return ipcRenderer.invoke(IPC_CHANNELS.DIFF_PDFS, oldSource, newSource, options);
  },
  // Pure file picker: the main process only shows a dialog and returns a path,
  // so the Inspect document (and the sidecar session) is never touched.
  pickDiffPdf: (side: DiffSide) => ipcRenderer.invoke(IPC_CHANNELS.PICK_DIFF_PDF, side),
  getImageData: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_DATA, streamId),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
  restartSidecar: () => ipcRenderer.invoke(IPC_CHANNELS.RESTART_SIDECAR),
  saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE, req),
});
