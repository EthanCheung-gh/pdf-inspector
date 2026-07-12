import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { usePdfStore } from '../store/pdf-store';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface UsePdfReturn {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  loading: boolean;
  error: string | null;
  loadPdf: (url: string) => Promise<void>;
}

export function usePdf(): UsePdfReturn {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadIdRef = useRef(0);

  // Destroy PDF document on unmount
  useEffect(() => {
    return () => {
      if (pdfRef.current) {
        pdfRef.current.destroy();
        pdfRef.current = null;
      }
      usePdfStore.getState().setPdfDocRef(null);
    };
  }, []);

  const loadPdf = useCallback(async (url: string) => {
    const loadId = ++loadIdRef.current;
    const store = usePdfStore.getState();
    setLoading(true);
    setError(null);
    store.setLoading(true);

    try {
      if (pdfRef.current) {
        pdfRef.current.destroy();
        pdfRef.current = null;
        store.setPdfDocRef(null);
      }
      const doc = await pdfjsLib.getDocument(url).promise;
      if (loadId !== loadIdRef.current) {
        doc.destroy();
        return;
      }
      pdfRef.current = doc;
      setPdfDoc(doc);
      store.setPdfDocRef(doc);

      // Load outline (bookmarks) after document is ready
      try {
        const outline = await doc.getOutline();
        if (loadId === loadIdRef.current) {
          store.setOutline(outline as any);
        }
      } catch (outlineErr) {
        console.warn('Failed to load PDF outline:', outlineErr);
        if (loadId === loadIdRef.current) {
          store.setOutline(null);
        }
      }

      // Calculate fit-width zoom from first page
      try {
        const firstPage = await doc.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        const H_PADDING = 48; // 24px each side
        const containerWidth = store.fitWidthZoom
          ? (window.innerWidth - 220 - 300) // viewport area: total width minus left panel minus inspector
          : window.innerWidth - 220; // rough estimate

        const availableWidth = Math.max(containerWidth - H_PADDING, 200);
        const fitWidthZoom = availableWidth / viewport.width;
        const clamped = Math.max(0.25, Math.min(5, fitWidthZoom));

        if (loadId === loadIdRef.current) {
          store.setFitWidthZoom(clamped);
        }
      } catch (zoomErr) {
        console.warn('Failed to calculate fit-width zoom:', zoomErr);
      }
    } catch (err) {
      if (loadId !== loadIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load PDF';
      setError(message);
      store.setError(message);
    } finally {
      if (loadId === loadIdRef.current) {
        setLoading(false);
        store.setLoading(false);
      }
    }
  }, []);

  return { pdfDoc, loading, error, loadPdf };
}
