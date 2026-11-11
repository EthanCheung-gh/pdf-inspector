/**
 * Build the whole-document annotation index in the background.
 *
 * The Annots tab keeps this hook mounted at all times (the panel is hidden, not
 * unmounted, when another tab is active), so the index survives switching back
 * to `Current page`: only the document itself cancels a run. Every run carries a
 * generation token, so a slow index for a closed document can never publish its
 * progress or its result.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildAnnotationIndex } from '../services/annotation-index';
import { useAnnotationIndexStore } from '../store/annotation-index-store';

const FALLBACK_ERROR = 'Failed to index document annotations';

export interface UseAnnotationIndexResult {
  /** Drop the failed run and build the whole index again from page 1. */
  retry: () => void;
}

/**
 * Identity of an indexed document.
 *
 * `filePath` is unique per open document — on the web it is `/doc/<id>`, which is
 * what keeps two tabs of the same file apart — and `sourceUrl` is only a
 * fallback for the flows that never set a path. A document without either is
 * never indexed: its results could not be attributed to anything.
 */
export function annotationDocumentKey(
  filePath: string | null,
  sourceUrl: string | null,
): string | null {
  const path = filePath?.trim() ?? '';
  if (path.length > 0) return path;

  const url = sourceUrl?.trim() ?? '';
  return url.length > 0 ? url : null;
}

/**
 * Page total the index is allowed to read.
 *
 * `pdfDoc.numPages` is authoritative — it is what PDF.js will actually hand out
 * — so a shorter `pageCount` (metadata/sidecar value) must never cut the index
 * short and silently drop trailing pages. `pageCount` is only a guarded
 * fallback for a document that does not expose a usable `numPages`; a total
 * below 1 means there is nothing to index.
 */
export function annotationIndexPageTotal(
  pdfDoc: PDFDocumentProxy | null,
  pageCount: number,
): number {
  const numPages = pdfDoc?.numPages;
  if (typeof numPages === 'number' && Number.isFinite(numPages) && numPages >= 1) {
    return Math.floor(numPages);
  }
  if (Number.isFinite(pageCount) && pageCount >= 1) return Math.floor(pageCount);
  return 0;
}

/**
 * Start (and own) the whole-document annotation index for `documentKey`.
 *
 * `enabled` only decides whether a run may *start*: switching back to the
 * current-page list never cancels an index that is already running and never
 * throws away its result. A different document, a different attempt (`retry`) or
 * an unmount is what invalidates a run.
 */
export function useAnnotationIndex(
  pdfDoc: PDFDocumentProxy | null,
  documentKey: string | null,
  pageCount: number,
  enabled: boolean,
): UseAnnotationIndexResult {
  // `retry` only bumps this counter: it is a new attempt for the same document,
  // not a document change, so it must not reset the query or the filters.
  const [attempt, setAttempt] = useState(0);
  // Bumped whenever the current run must be abandoned: the index service polls
  // it between pages, so a document switch stops reading instead of finishing a
  // document nobody is looking at.
  const generationRef = useRef(0);
  // The `<documentKey, attempt>` pair that already started a run, so a re-render
  // or a mode switch cannot start a second run for the same attempt.
  const startedRef = useRef<{ documentKey: string; attempt: number } | null>(null);

  // Reacts to the document only — never to `enabled`. It also drops the previous
  // document's result, query and filters, so a stale list can never be shown
  // for the file that replaced it.
  useEffect(() => {
    generationRef.current += 1;
    startedRef.current = null;

    const store = useAnnotationIndexStore.getState();
    if (store.documentKey !== null && store.documentKey !== documentKey) {
      store.reset();
    }

    return () => {
      generationRef.current += 1;
    };
  }, [pdfDoc, documentKey]);

  useEffect(() => {
    if (!enabled) return;
    if (pdfDoc === null || documentKey === null) return;

    // The document's own page count wins: `pageCount` is only a fallback, so a
    // stale metadata value can never truncate the index.
    const total = annotationIndexPageTotal(pdfDoc, pageCount);
    if (total < 1) return;

    const store = useAnnotationIndexStore.getState();
    // Same document, finished index: reuse it instead of re-reading the whole
    // document every time the user switches back to this list.
    if (store.documentKey === documentKey && store.status === 'ready') return;

    const started = startedRef.current;
    if (started !== null && started.documentKey === documentKey && started.attempt === attempt) {
      return;
    }

    const generation = generationRef.current;
    const isCancelled = (): boolean => generationRef.current !== generation;

    startedRef.current = { documentKey, attempt };
    store.start(documentKey, total);

    void buildAnnotationIndex(pdfDoc, total, {
      onProgress: (done, scanned) => {
        if (isCancelled()) return;
        useAnnotationIndexStore.getState().setProgress(done, scanned);
      },
      isCancelled,
    })
      .then((result) => {
        // `null` means the service stopped because it was cancelled; the run
        // that replaced it owns the store state.
        if (isCancelled() || result === null) return;
        useAnnotationIndexStore.getState().finish(documentKey, result);
      })
      .catch((error: unknown) => {
        if (isCancelled()) return;
        useAnnotationIndexStore.getState().fail(documentKey, describeError(error));
      });
  }, [pdfDoc, documentKey, pageCount, enabled, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { retry };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || FALLBACK_ERROR;
  const message = String(error ?? '').trim();
  return message.length > 0 ? message : FALLBACK_ERROR;
}
