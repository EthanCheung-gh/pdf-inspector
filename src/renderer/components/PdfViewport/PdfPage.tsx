import React, { useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { usePdfStore } from '../../store/pdf-store';
import { OverlayCanvas } from './OverlayCanvas';
import { InspectorHighlight } from './InspectorHighlight';
import { TextLayer } from './TextLayer';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import styles from './PdfPage.module.css';

interface PdfPageProps {
  pageNum: number;
  zoom: number;
  pdfDoc: PDFDocumentProxy | null;
}

export const PdfPage: React.FC<PdfPageProps> = ({ pageNum, zoom, pdfDoc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const metadata = usePdfStore((s) => s.metadata);
  const pageData = usePdfStore((s) => s.pageData);

  // Render at device resolution and cancel work that becomes stale.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc) return;

    let cancelled = false;

    const render = async () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      try {
        const dpr = window.devicePixelRatio || 1;
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        const context = canvas.getContext('2d');
        if (!context) return;

        const task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Rendering cancelled') {
          return;
        }
        console.error('Page render error:', error);
      }
    };

    void render();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pageNum, zoom, pdfDoc]);

  if (!pdfDoc) return null;

  // Each page has its own PDF-space size: `pageData` describes the page being
  // rendered, so it wins over the document-wide metadata (which reflects page 1
  // and is wrong for mixed-size PDFs). Metadata/Letter fallbacks only apply
  // while the current page's extraction is still in flight.
  const pdfWidth = pageData?.width ?? metadata?.page_w ?? 612;
  const pdfHeight = pageData?.height ?? metadata?.page_h ?? 792;

  const pageWidth = pdfWidth * zoom;
  const pageHeight = pdfHeight * zoom;

  return (
    <div className={styles.pageContainer} style={{ width: pageWidth, height: pageHeight }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <TextLayer pageNum={pageNum} pdfDoc={pdfDoc} zoom={zoom} />
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={pdfWidth}
        pdfHeight={pdfHeight}
      />
      <InspectorHighlight pageNum={pageNum} />
    </div>
  );
};
