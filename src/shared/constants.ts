export const SIDECAR_SCRIPT = 'sidecar/main.py';

/**
 * Request payload for the SAVE_FILE IPC channel. Defined here (not in
 * src/renderer/types) so the composite node tsconfig project
 * (main/preload) can import it without pulling renderer files in.
 */
export interface SaveFileRequest {
  defaultPath: string;
  content: string;
  filterName: string;
  extensions: string[];
}

/**
 * Timeout for the `analyze_fonts` request.
 *
 * Font analysis walks every page and every font in the document, so a large
 * PDF legitimately takes far longer than the generic request timeout. It is
 * kept here (not in src/main) so the value is available to both sides of the
 * IPC boundary without pulling main-process code into other tsconfig projects.
 */
export const ANALYZE_FONTS_TIMEOUT_MS = 120_000;

/**
 * Renderer-side budget for `analyzeFonts`.
 *
 * Deliberately LARGER than the main-process budget: the renderer's timer starts
 * one IPC hop earlier, so with an equal budget it would always fire first and
 * turn a legitimately slow analysis into a restart-triggering
 * "Sidecar timeout", hiding the main process' clear
 * `Request "analyze_fonts" timed out after 120s` error. The extra headroom
 * means main's timeout surfaces first and no restart is attempted; the
 * renderer timer is only a backstop for a main process that never answers.
 */
export const ANALYZE_FONTS_RENDERER_TIMEOUT_MS = ANALYZE_FONTS_TIMEOUT_MS + 5_000;

/**
 * Timeout for the `open` request (pdfplumber open + font-resource scan).
 *
 * Opening is not a cheap handshake: the sidecar opens the document with
 * pdfplumber and walks its font resources to build the metadata the UI shows,
 * so a large or damaged PDF legitimately takes far longer than the generic 30s
 * request budget. Every `open` request in the main process and the web backend
 * passes this budget explicitly; all other methods keep the default.
 */
export const OPEN_PDF_TIMEOUT_MS = 120_000;

/**
 * Renderer-side budget for `openPdf`.
 *
 * Deliberately LARGER than the main-process budget for the same reason as
 * `ANALYZE_FONTS_RENDERER_TIMEOUT_MS`: the renderer's timer starts one IPC hop
 * earlier, so with an equal budget it would always fire first and turn a
 * legitimately slow open into a restart-triggering
 * "Sidecar timeout: openPdf exceeded ...ms", hiding main's clear
 * `Request "open" timed out after 120s` error. The extra headroom means main's
 * timeout surfaces first and no restart is attempted; the renderer timer is
 * only a backstop for a main process that never answers.
 */
export const OPEN_PDF_RENDERER_TIMEOUT_MS = OPEN_PDF_TIMEOUT_MS + 5_000;

/**
 * Budget for downloading a remote PDF in the main process.
 *
 * A URL download is bounded separately from the IPC round trip: the download
 * itself gets 60s, while the renderer allows OPEN_PDF_URL_TIMEOUT_MS for the
 * whole request (download + sidecar open). Kept in src/shared for the same
 * reason as ANALYZE_FONTS_TIMEOUT_MS.
 */
export const PDF_URL_TIMEOUT_MS = 60_000;

/**
 * Timeout the renderer allows for the `openPdfUrl` IPC request.
 *
 * Main performs the download (PDF_URL_TIMEOUT_MS) and then the sidecar open
 * (OPEN_PDF_TIMEOUT_MS) sequentially, so the renderer must outlast both plus the
 * same 5s headroom as the other dedicated renderer budgets. With only an open
 * budget's worth of time, a slow download followed by a slow open would make the
 * renderer lose the race and restart the sidecar.
 */
export const OPEN_PDF_URL_TIMEOUT_MS = PDF_URL_TIMEOUT_MS + OPEN_PDF_TIMEOUT_MS + 5_000;

/**
 * Timeout for the `diff_documents` request.
 *
 * A diff extracts BOTH documents page by page, so it is the most expensive
 * operation the sidecar performs and gets its own, generous budget: 300s is
 * well above `analyze_fonts` (120s) so a large pair of documents does not look
 * like a hang. It is per-request (see `SidecarManager.send`), so diffing can
 * never extend or shorten the budget of an extract/analyze call.
 */
export const DIFF_TIMEOUT_MS = 300_000;

/**
 * Renderer-side budget for `diffPdfs`.
 *
 * Larger than the main-process budget for the same reason as
 * `ANALYZE_FONTS_RENDERER_TIMEOUT_MS`: main must time out first so its clear
 * `Request "diff_documents" timed out after 300s` error surfaces instead of a
 * renderer-side "Sidecar timeout" that triggers a restart.
 */
export const DIFF_RENDERER_TIMEOUT_MS = DIFF_TIMEOUT_MS + 5_000;

/**
 * Timeout for one `audit_document` / `audit_pages` request.
 *
 * A document audit inspects metadata, fonts and every page in batches, so it is
 * as expensive as font analysis and gets the same generous budget. The budget is
 * per request: the renderer runs one document pass plus one call per 10-page
 * batch, and each of those calls is bounded separately.
 */
export const AUDIT_TIMEOUT_MS = 120_000;

/**
 * Renderer-side budget for `auditDocument` / `auditPages`.
 *
 * Larger than the main-process budget for the same reason as
 * `ANALYZE_FONTS_RENDERER_TIMEOUT_MS`: main must time out first so its clear
 * `Request "audit_pages" timed out after 120s` error surfaces instead of a
 * renderer-side "Sidecar timeout" that triggers a restart.
 */
export const AUDIT_RENDERER_TIMEOUT_MS = AUDIT_TIMEOUT_MS + 5_000;

/**
 * Timeout for one `raw_document` / `raw_object` / `raw_page_content` request.
 *
 * The raw reads are lazy and bounded (one object, one page's content streams,
 * and never a full binary stream), but they still open the document and decode
 * content streams in the sidecar, so they get the same budget as font analysis
 * and the audit instead of the 30s default. The budget is per request: the raw
 * workspace issues one call at a time and each of them is bounded separately.
 */
export const RAW_TIMEOUT_MS = 120_000;

/**
 * Renderer-side budget for `rawDocument` / `rawObject` / `rawPageContent`.
 *
 * Larger than the main-process budget for the same reason as
 * `ANALYZE_FONTS_RENDERER_TIMEOUT_MS`: main must time out first so its clear
 * `Request "raw_object" timed out after 120s` error surfaces instead of a
 * renderer-side "Sidecar timeout" that triggers a restart.
 */
export const RAW_RENDERER_TIMEOUT_MS = RAW_TIMEOUT_MS + 5_000;

/**
 * Timeout for one `extract_page` request.
 *
 * Extraction is normally sub-0.1s, but a single complex page (many tables,
 * nested objects, thousands of words/rects) is extracted in one shot, so a
 * legitimately slow page must not be reported as a failed page load after the
 * generic 30s budget. The value matches the other expensive reads and stays
 * per-request: it never extends the budget of a metadata/image call.
 */
export const EXTRACT_PAGE_TIMEOUT_MS = 120_000;

/**
 * Renderer-side budget for `extractPage`.
 *
 * Larger than the main-process budget for the same reason as
 * `ANALYZE_FONTS_RENDERER_TIMEOUT_MS`: main must time out first so its clear
 * `Request "extract_page" timed out after 120s` error surfaces instead of a
 * renderer-side "Sidecar timeout" that would restart the sidecar and hide the
 * real cause of a failed page load.
 */
export const EXTRACT_PAGE_RENDERER_TIMEOUT_MS = EXTRACT_PAGE_TIMEOUT_MS + 5_000;

export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  OPEN_PDF_URL: 'pdf:open-url',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
  RESTART_SIDECAR: 'pdf:restart-sidecar',
  ANALYZE_FONTS: 'pdf:analyze-fonts',
  AUDIT_DOCUMENT: 'pdf:audit-document',
  AUDIT_PAGES: 'pdf:audit-pages',
  DIFF_PDFS: 'pdf:diff',
  PICK_DIFF_PDF: 'pdf:pick-diff',
  /**
   * Raw PDF reading (see src/renderer/types/raw-pdf.ts).
   *
   * Read-only: these channels inspect the trailer roots, one indirect object and
   * one page's decoded content streams of the document the sidecar already has
   * open. They never send `open`, so opening the Raw workspace cannot change the
   * Inspect document, the Diff inputs or an audit.
   */
  RAW_DOCUMENT: 'pdf:raw-document',
  RAW_OBJECT: 'pdf:raw-object',
  RAW_PAGE_CONTENT: 'pdf:raw-page-content',
  SAVE_FILE: 'file:save',
  /**
   * Ask the shell to open one external link. Not a `pdf:` channel: it never
   * touches the sidecar or the open document, and it is the only place a URL
   * from a PDF reaches the operating system.
   */
  OPEN_EXTERNAL: 'app:open-external',
} as const;
