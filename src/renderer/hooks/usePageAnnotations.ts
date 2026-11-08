/**
 * Load the annotations of the page currently on screen.
 *
 * PDF.js annotations are only requested once both the document and the page's
 * MediaBox are known: the MediaBox origin is what turns absolute PDF points
 * into the page-relative coordinates the overlay and the hit-test use. Every run
 * gets a request token, so a slow response for a page (or document) the user has
 * already left can never overwrite the current page's data or selection.
 */
import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPageAnnotations } from '../services/annotations';
import { useAnnotationStore } from '../store/annotation-store';
import type { PageBox } from '../types/pdf-objects';

const FALLBACK_ERROR = 'Failed to load annotations';

export function usePageAnnotations(
  pdfDoc: PDFDocumentProxy | null,
  pageNum: number,
  mediaBox: PageBox | null,
): void {
  const setPageData = useAnnotationStore((state) => state.setPageData);
  const setLoading = useAnnotationStore((state) => state.setLoading);
  const setError = useAnnotationStore((state) => state.setError);
  const setSelected = useAnnotationStore((state) => state.setSelected);
  const setHovered = useAnnotationStore((state) => state.setHovered);
  const clear = useAnnotationStore((state) => state.clear);
  // Bumped by the Annots tab's Retry button; a new value re-runs the load for
  // the same page/document without changing the page-scoped selection rules.
  const reloadKey = useAnnotationStore((state) => state.reloadKey);

  // Monotonic request token; only the newest run may write to the store.
  const requestRef = useRef(0);
  // Which page of which document the current store data belongs to.
  const contextRef = useRef<{ doc: PDFDocumentProxy | null; page: number }>({ doc: null, page: 0 });

  // The origin is read through primitives so a new `PageData` object with the
  // same MediaBox cannot re-trigger the load (and cannot loop).
  const originX = mediaBox?.x0 ?? null;
  const originY = mediaBox?.y0 ?? null;

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    const previous = contextRef.current;
    contextRef.current = { doc: pdfDoc, page: pageNum };
    if (previous.doc !== pdfDoc || previous.page !== pageNum) {
      // Selection and hover are page/document scoped: the previous page's
      // annotation must not stay actionable while the new page loads.
      setSelected(null);
      setHovered(null);
    }

    if (pdfDoc === null || originX === null || originY === null) {
      // No document, or no MediaBox yet. Drop the previous page's data instead
      // of showing annotations that do not belong to what is on screen.
      clear();
      return;
    }

    setLoading(true);
    setError(null);

    void loadPageAnnotations(pdfDoc, pageNum, { x: originX, y: originY })
      .then((annotations) => {
        if (requestRef.current !== requestId) return;
        setPageData(pageNum, annotations);
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        setError(describeError(error));
        setLoading(false);
      });

    // Bumped again on cleanup, so an in-flight response for this run is ignored
    // even when no new run follows (unmount, or a null document).
    return () => {
      if (requestRef.current === requestId) requestRef.current = requestId + 1;
    };
  }, [
    pdfDoc,
    pageNum,
    originX,
    originY,
    reloadKey,
    clear,
    setError,
    setHovered,
    setLoading,
    setPageData,
    setSelected,
  ]);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || FALLBACK_ERROR;
  const message = String(error ?? '').trim();
  return message.length > 0 ? message : FALLBACK_ERROR;
}
