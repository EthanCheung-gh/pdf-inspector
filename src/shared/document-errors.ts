/**
 * Renderer-visible failures of the web document registry bridge.
 *
 * Kept in `src/shared` (not in the web adapter) so the renderer can recognise
 * the failure by type: the browser bridge is the only implementation that has a
 * server-side registry, and the tab bar has to react differently to "the server
 * does not know this id any more" than to a real failure.
 */

/**
 * The server no longer has the requested document id.
 *
 * Raised by `activatePdfDocument` on an HTTP 404: the id was dropped by LRU
 * eviction, by closing its tab in another window, or by a server restart. The
 * document itself may still exist elsewhere (a tab keeps its source URL), which
 * is what lets a caller self-heal instead of showing a dead tab forever.
 */
export class PdfDocumentNotFoundError extends Error {
  constructor(message = 'Document not found') {
    super(message);
    this.name = 'PdfDocumentNotFoundError';
  }
}
