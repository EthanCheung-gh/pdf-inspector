import { IpcApi } from '../types/ipc-protocol';

declare global {
  interface Window {
    pdfInspector: IpcApi;
  }
}

export const ipc = {
  openPdf: () => window.pdfInspector.openPdf(),
  extractPage: (page: number) => window.pdfInspector.extractPage(page),
  extractMetadata: () => window.pdfInspector.extractMetadata(),
  getImageData: (streamId: string) => window.pdfInspector.getImageData(streamId),
  getSidecarStatus: () => window.pdfInspector.getSidecarStatus(),
  restartSidecar: () => window.pdfInspector.restartSidecar(),
};
