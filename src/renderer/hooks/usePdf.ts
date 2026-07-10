import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = './assets/pdf.worker.min.mjs';

interface UsePdfReturn {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  loading: boolean;
  error: string | null;
  renderPage: (pageNum: number, canvas: HTMLCanvasElement, scale: number) => Promise<void>;
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
    };
  }, []);

  const loadPdf = useCallback(async (url: string) => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    setError(null);
    try {
      if (pdfRef.current) {
        pdfRef.current.destroy();
      }
      const doc = await pdfjsLib.getDocument(url).promise;
      if (loadId !== loadIdRef.current) {
        doc.destroy();
        return;
      }
      pdfRef.current = doc;
      setPdfDoc(doc);
    } catch (err) {
      if (loadId !== loadIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load PDF');
    } finally {
      if (loadId === loadIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const renderPage = useCallback(async (pageNum: number, canvas: HTMLCanvasElement, scale: number) => {
    if (!pdfRef.current) return;
    try {
      const page = await pdfRef.current.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (err) {
      console.error('Page render error:', err);
    }
  }, []);

  return { pdfDoc, loading, error, renderPage, loadPdf };
}
