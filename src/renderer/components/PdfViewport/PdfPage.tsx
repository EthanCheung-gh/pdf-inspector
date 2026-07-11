import React, { useRef, useEffect } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { OverlayCanvas } from './OverlayCanvas';
import { InspectorHighlight } from './InspectorHighlight';
import { TextLayer } from './TextLayer';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import styles from './PdfPage.module.css';

interface PdfPageProps {
  pageNum: number;
  isVisible: boolean;
  zoom: number;
  pdfDoc: PDFDocumentProxy | null;
  renderPage: (pageNum: number, canvas: HTMLCanvasElement, scale: number) => Promise<void>;
}

export const PdfPage: React.FC<PdfPageProps> = ({ pageNum, isVisible, zoom, pdfDoc, renderPage }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metadata = usePdfStore((s) => s.metadata);

  // Render current page
  useEffect(() => {
    if (isVisible && canvasRef.current) {
      renderPage(pageNum, canvasRef.current, zoom);
    }
  }, [isVisible, pageNum, zoom, renderPage]);

  if (!isVisible) return null;

  const pageWidth = metadata?.page_w ? metadata.page_w * zoom : 612 * zoom;
  const pageHeight = metadata?.page_h ? metadata.page_h * zoom : 792 * zoom;

  return (
    <div className={styles.pageContainer} style={{ width: pageWidth, height: pageHeight }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <TextLayer pageNum={pageNum} pdfDoc={pdfDoc} scale={zoom} width={pageWidth} height={pageHeight} />
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={metadata?.page_w || 612}
        pdfHeight={metadata?.page_h || 792}
      />
      <InspectorHighlight pageNum={pageNum} />
    </div>
  );
};
