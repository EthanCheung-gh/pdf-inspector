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
 * Budget for downloading a remote PDF in the main process.
 *
 * A URL download is bounded separately from the IPC round trip: the download
 * itself gets 60s, while the renderer allows OPEN_PDF_URL_TIMEOUT_MS for the
 * whole request (download + sidecar open). Kept in src/shared for the same
 * reason as ANALYZE_FONTS_TIMEOUT_MS.
 */
export const PDF_URL_TIMEOUT_MS = 60_000;

/** Timeout the renderer allows for the `openPdfUrl` IPC request. */
export const OPEN_PDF_URL_TIMEOUT_MS = 120_000;

export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  OPEN_PDF_URL: 'pdf:open-url',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
  RESTART_SIDECAR: 'pdf:restart-sidecar',
  ANALYZE_FONTS: 'pdf:analyze-fonts',
  SAVE_FILE: 'file:save',
} as const;
