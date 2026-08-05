import { PdfMetadata, PageData } from './pdf-objects';
import type { SaveFileRequest } from '../../shared/constants';

export type { SaveFileRequest };

export interface FontStat {
  fontname: string;
  pages: number[];
  charCount: number;
  sizeMin: number;
  sizeMax: number;
  colors: string[];
}

export type OpenPdfResult = {
  canceled: true;
} | {
  canceled: false;
  path: string;
  metadata: PdfMetadata;
};

export type SaveFileResult =
  | { canceled: true }
  | { canceled: false; filePath?: string; error?: string };

export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  saveFile(req: SaveFileRequest): Promise<SaveFileResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  analyzeFonts(): Promise<{ fonts: FontStat[] }>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
  restartSidecar(): Promise<{ success: boolean; running: boolean; error?: string }>;
}
