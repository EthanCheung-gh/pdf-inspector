import { PdfMetadata, PageData } from './pdf-objects';
import type { RawDocument, RawObject, RawPageContent, RawRef } from './raw-pdf';
import type { SaveFileRequest } from '../../shared/constants';
import type { OpenExternalResult } from '../../shared/external-url';
import type { AuditDocumentResult, AuditPagesResult } from '../../shared/audit-types';
import type {
  DiffOptionsInput,
  DiffResult,
  DiffSource,
  DiffSide,
  PickDiffPdfResult,
} from '../../shared/diff-types';

export type { SaveFileRequest };
export type { OpenExternalResult };
export type {
  RawContentOperator,
  RawContentStream,
  RawDocument,
  RawEntry,
  RawObject,
  RawPageContent,
  RawRef,
  RawRoot,
  RawValue,
} from './raw-pdf';
export type {
  AuditCategory,
  AuditDocumentInfo,
  AuditDocumentResult,
  AuditFinding,
  AuditPagesResult,
  AuditReport,
  AuditSeverity,
  AuditSummary,
  AuditTool,
} from '../../shared/audit-types';
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
  /**
   * Open an already known local path without showing a file dialog.
   *
   * Optional because only the desktop bridge can do it: the browser build has
   * no local paths, so it omits the method and the document tab bar stays
   * hidden (web multi-document is deferred). Callers must check for the method
   * before relying on tabs.
   */
  openPdfPath?(path: string): Promise<OpenPdfResult>;
  saveFile(req: SaveFileRequest): Promise<SaveFileResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  analyzeFonts(startPage?: number, endPage?: number): Promise<{ fonts: FontStat[] }>;
  /**
   * Run the document-level audit pass (metadata, fonts, page geometry, ...).
   *
   * The page-level checks are requested separately in 10-page batches through
   * `auditPages` so extraction and progress stay responsive; the renderer merges
   * both halves into one `AuditReport`.
   */
  auditDocument(): Promise<AuditDocumentResult>;
  /** Audit pages `startPage`..`endPage` (1-based, inclusive). */
  auditPages(startPage: number, endPage: number): Promise<AuditPagesResult>;
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
  /**
   * Read the document's trailer roots (Catalog, Info, Encrypt, ID, Pages).
   *
   * Read-only and document-scoped: like the audit calls, the raw readers inspect
   * the document the sidecar already has open and never send `open`, so the
   * Inspect page/zoom/selection (and the Diff/Audit inputs) stay untouched.
   */
  rawDocument(): Promise<RawDocument>;
  /**
   * Read exactly one indirect object.
   *
   * References inside the returned value are never resolved: the tree expands a
   * `ref` by calling this again, so no request can walk the object graph.
   */
  rawObject(ref: RawRef): Promise<RawObject>;
  /** Read the decoded content-stream operators of one 1-based page. */
  rawPageContent(page: number): Promise<RawPageContent>;
  getSidecarStatus(): Promise<{ running: boolean }>;
  restartSidecar(): Promise<{ success: boolean; running: boolean; error?: string }>;
  /**
   * Open one external link in the OS/browser.
   *
   * Deliberately never rejects on a policy violation: the URL is re-validated
   * on the other side of the bridge (main process / browser adapter) and an
   * unsafe or unopenable target comes back as `{ ok: false, error }` so the UI
   * can report it without treating it as a crash.
   */
  openExternal(url: string): Promise<OpenExternalResult>;
}
