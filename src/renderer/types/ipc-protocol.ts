import { PdfMetadata, PageData } from './pdf-objects';

export type OpenPdfResult = {
  canceled: true;
} | {
  canceled: false;
  path: string;
  metadata: PdfMetadata;
};

export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
}
