import { PdfMetadata, PageData } from './pdf-objects';
import type { SaveFileRequest } from '../../shared/constants';
import type {
  DiffOptionsInput,
  DiffResult,
  DiffSource,
  DiffSide,
  PickDiffPdfResult,
} from '../../shared/diff-types';

export type { SaveFileRequest };
export type {
  DiffChange,
  DiffChangeKind,
  DiffOptions,
  DiffOptionsInput,
  DiffObjectType,
  DiffPage,
  DiffPageStatus,
  DiffResult,
  DiffSide,
  DiffSource,
  DiffSummary,
  DiffTextTolerance,
  PickDiffPdfResult,
} from '../../shared/diff-types';

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
  /**
   * Set when the document was opened from a URL. `path` then points at the
   * downloaded temp copy, so the UI shows this instead of the temp file name.
   */
  sourceUrl?: string;
};

export type SaveFileResult =
  | { canceled: true }
  | { canceled: false; filePath?: string; error?: string };

export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  openPdfUrl(url: string): Promise<OpenPdfResult>;
  saveFile(req: SaveFileRequest): Promise<SaveFileResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  analyzeFonts(startPage?: number, endPage?: number): Promise<{ fonts: FontStat[] }>;
  /**
   * Diff two PDFs without touching the currently open document.
   *
   * Desktop callers pass absolute file paths; the browser adapter accepts the
   * `File` objects the user picked. A `File` must never be sent through
   * Electron IPC (it cannot be structured-cloned), so the desktop bridge
   * rejects it instead of letting the clone fail opaquely.
   */
  diffPdfs(
    oldSource: DiffSource,
    newSource: DiffSource,
    options?: DiffOptionsInput,
  ): Promise<DiffResult>;
  /**
   * Choose one side of a diff without opening it.
   *
   * Kept separate from `openPdf` on purpose: picking a diff input must never
   * replace the document the Inspect workspace is showing.
   */
  pickDiffPdf(side: DiffSide): Promise<PickDiffPdfResult>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
  restartSidecar(): Promise<{ success: boolean; running: boolean; error?: string }>;
}
