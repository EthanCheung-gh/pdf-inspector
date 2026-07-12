import React, { useEffect, useRef } from 'react';
import { TextLayer as PdfjsTextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfStore } from '../../store/pdf-store';
import styles from './TextLayer.module.css';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy | null;
  zoom: number;
}

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, zoom }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textSelectionMode = usePdfStore((s) => s.textSelectionMode);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    let cancelled = false;
    let textLayer: PdfjsTextLayer | null = null;

    const renderText = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom });
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        container.innerHTML = '';
        textLayer = new PdfjsTextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        await textLayer.render();
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to load text for page ${pageNum}:`, error);
        }
      }
    };

    void renderText();

    return () => {
      cancelled = true;
      textLayer?.cancel();
      container.innerHTML = '';
      container.style.width = '';
      container.style.height = '';
    };
  }, [pageNum, pdfDoc, zoom]);

  return (
    <div
      ref={containerRef}
      className={styles.textLayer}
      style={{
        pointerEvents: textSelectionMode ? 'auto' : 'none',
        userSelect: textSelectionMode ? 'text' : 'none',
      }}
      aria-hidden={!textSelectionMode}
    />
  );
};
