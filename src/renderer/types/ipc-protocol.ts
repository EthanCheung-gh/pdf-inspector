import { PdfMetadata, PageData } from './pdf-objects';
import type { RawDocument, RawObject, RawPageContent, RawRef } from './raw-pdf';
import type { SaveFileRequest } from '../../shared/constants';
import type { OpenExternalResult } from '../../shared/external-url';
import type { AuditDocumentResult, AuditPagesResult } from '../../shared/audit-types';
import type { SecurityReport } from '../../shared/security-types';
import type { AccessibilityReport } from '../../shared/accessibility-types';
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
  SecurityAction,
  SecurityAttachment,
  SecurityDocumentInfo,
  SecurityEncryption,
  SecurityJavaScript,
  SecurityPermissions,
  SecurityReport,
  SecuritySignature,
} from '../../shared/security-types';
export type {
  AccessibilityDocumentInfo,
  AccessibilityReport,
  StructureNode,
  StructureNodeKind,
} from '../../shared/accessibility-types';
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
   * Display name of the document (the upload name on the web, the file basename
   * on the desktop). Used for labels and as an export-filename fallback when
   * `path` is a temp/encoded location.
   */
  name?: string;
  /**
   * Set when the document was opened from a URL. `path` then points at the
   * downloaded temp copy, so the UI shows this instead of the temp file name.
   */
  sourceUrl?: string;
  /**
   * Identifier of the document inside the web server's document registry.
   *
   * Only the browser bridge sets it: the web server keeps a bounded set of open
   * documents and addresses them by id, so a tab can later activate or close
   * that exact document. Desktop results leave it unset — there the document is
   * identified by `path` alone (see `IpcApi.openPdfPath`).
   */
  documentId?: string;
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
   * no local paths, so it omits this method. It is one of the two optional
   * bridges that enable the document tab bar (`activatePdfDocument` is the
   * web counterpart); callers must check for one of them before relying on
   * tabs.
   */
  openPdfPath?(path: string): Promise<OpenPdfResult>;
  /**
   * Activate a document the web server already holds, by registry id.
   *
   * This is the web counterpart of `openPdfPath`, and the two are alternatives,
   * not aliases: `openPdfPath` opens a *local path* the desktop process can read,
   * while this activates a *server-side document id* whose temporary copy lives
   * in the server's registry and is only readable through `/doc/<id>/<name>`.
   * The browser therefore cannot use `openPdfPath` (it never learns a real
   * filesystem path), and the desktop has no document ids to activate.
   *
   * Both are optional and either one enables the document tab bar. A result
   * carries `documentId` and the document's own (URL-resolved) `path`, so a
   * switching tab can refresh both without re-uploading or re-downloading.
   *
   * The server may have forgotten the id (LRU eviction, or a restart): the web
   * bridge then rejects with `PdfDocumentNotFoundError`
   * (`src/shared/document-errors.ts`) instead of a generic error, so a tab that
   * still knows its source URL can re-open that URL and heal itself.
   */
  activatePdfDocument?(id: string): Promise<OpenPdfResult>;
  /**
   * Close a server-side document and let the server delete its temporary copy.
   *
   * Optional for the same reason as `activatePdfDocument`: only the web bridge
   * has a registry to close from. Desktop tabs hold local paths and removing a
   * tab must never delete the user's file.
   *
   * `closed: true` means the document is gone (its `/doc/<id>` URL is 404 now).
   * A rejected promise means it is still open — for example it is the active
   * document and has neighbours, which the server refuses to close — so callers
   * must keep the tab and show the error instead of dropping it.
   *
   * `notFound: true` (with `closed: false`) is the third outcome: the server
   * does not know the id any more, so there is nothing left to delete. Callers
   * should drop the tab as if it had been closed — the document is unreachable
   * either way — without reporting an error to the user.
   */
  closePdfDocument?(id: string): Promise<{ closed: boolean; notFound?: boolean }>;
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
   * Read the document's security resources (attachments, JavaScript, actions,
   * signatures, encryption, permissions).
   *
   * Read-only and document-scoped like `auditDocument`: it inspects the document
   * the sidecar already has open and never executes a script, opens an
   * attachment or verifies a signature. Independent of the audit so a failed
   * resource scan cannot affect an existing audit report.
   */
  securityDocument(): Promise<SecurityReport>;
  /**
   * Read the document's tagged structure tree and accessibility findings.
   *
   * Read-only and document-scoped like `securityDocument`: it inspects the
   * document the sidecar already has open, never edits a tag, executes a content
   * stream or resolves an external resource, and its findings are heuristics
   * rather than a PDF/UA compliance verdict. Independent of the audit so a failed
   * structure parse cannot affect an existing audit report.
   */
  accessibilityDocument(): Promise<AccessibilityReport>;
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
