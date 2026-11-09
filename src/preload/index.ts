import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { SaveFileRequest } from '../shared/constants';
import type { DiffOptionsInput, DiffSide, DiffSource } from '../shared/diff-types';

/**
 * Structural mirror of the renderer's `RawRef` (src/renderer/types/raw-pdf.ts).
 *
 * Declared here rather than imported so the composite node tsconfig project
 * (main/preload) never pulls renderer files in; the fields are the whole
 * contract of the `pdf:raw-object` request argument.
 */
interface RawObjectRef {
  objectNumber: number;
  generation: number;
}

contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  openPdfUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF_URL, url),
  // Document tabs switch documents by path: no dialog is shown, the path is one
  // the user already opened in this session.
  openPdfPath: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF_PATH, filePath),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  analyzeFonts: (startPage?: number, endPage?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANALYZE_FONTS, startPage, endPage),
  auditDocument: () => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_DOCUMENT),
  auditPages: (startPage: number, endPage: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_PAGES, startPage, endPage),
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
  // Raw reads are read-only: they forward to the sidecar without opening,
  // closing or replacing the current document.
  rawDocument: () => ipcRenderer.invoke(IPC_CHANNELS.RAW_DOCUMENT),
  rawObject: (ref: RawObjectRef) => ipcRenderer.invoke(IPC_CHANNELS.RAW_OBJECT, ref),
  rawPageContent: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.RAW_PAGE_CONTENT, page),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
  restartSidecar: () => ipcRenderer.invoke(IPC_CHANNELS.RESTART_SIDECAR),
  saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE, req),
  // The main process re-validates the URL before calling `shell.openExternal`;
  // nothing else about the document or the sidecar is involved.
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
});
