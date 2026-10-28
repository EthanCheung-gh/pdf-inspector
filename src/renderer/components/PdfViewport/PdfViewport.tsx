import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfStore } from '../../store/pdf-store';
import { usePdf } from '../../hooks/usePdf';
import { computeFitWidthZoom } from '../../services/page-geometry';
import { pathToFileUrl } from '../../../shared/path-utils';
import { PdfPage } from './PdfPage';
import styles from './PdfViewport.module.css';

/** Zoom difference below which the user is still considered to be in fit mode. */
const FIT_MODE_TOLERANCE = 0.01;

export const PdfViewport: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const currentPage = usePdfStore((s) => s.currentPage);
  const zoom = usePdfStore((s) => s.zoom);
  const metadata = usePdfStore((s) => s.metadata);
  const setFitWidthZoom = usePdfStore((s) => s.setFitWidthZoom);
  const { pdfDoc, loadPdf, loading, error } = usePdf();

  // Measured width of the scroll container. Starts at 0 ("not measured yet")
  // so no zoom is derived from guessed window widths.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const fittedDocRef = useRef<PDFDocumentProxy | null>(null);
  const lastFitZoomRef = useRef<number | null>(null);

  // Load PDF document once when filePath changes. Remote http(s) URLs are
  // passed to PDF.js as-is; local paths are converted to file:// URLs.
  useEffect(() => {
    if (filePath) {
      const url = /^https?:\/\//i.test(filePath) ? filePath : pathToFileUrl(filePath);
      loadPdf(url);
    }
  }, [filePath, loadPdf]);

  // Track the real width of the scroll container (including window resizes and
  // scrollbar appearance). A width of 0 means "not measured yet" — never
  // substitute window.innerWidth, which includes the side panels.
  useEffect(() => {
    if (!scrollEl) {
      setContainerWidth(0);
      return;
    }

    const measure = (): void => {
      const width = scrollEl.clientWidth;
      setContainerWidth(Number.isFinite(width) && width > 0 ? width : 0);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollEl]);

  // A new page/document starts at its top-left. Without this the scroll
  // position from the previous page survives and the next page opens clipped.
  useEffect(() => {
    if (!scrollEl) return;
    scrollEl.scrollTop = 0;
    scrollEl.scrollLeft = 0;
  }, [currentPage, filePath, scrollEl]);

  // Apply fit-to-width once per loaded document, using the measured container.
  useEffect(() => {
    if (!pdfDoc || !metadata || containerWidth <= 0) return;
    if (fittedDocRef.current === pdfDoc) return;

    fittedDocRef.current = pdfDoc;
    const fit = computeFitWidthZoom(metadata.page_w, containerWidth);
    lastFitZoomRef.current = fit;
    setFitWidthZoom(fit);
  }, [pdfDoc, metadata, containerWidth, setFitWidthZoom]);

  // Re-fit on container resizes, but only while the user has not manually
  // zoomed away from the last fit zoom.
  useEffect(() => {
    if (!metadata || containerWidth <= 0) return;

    const previousFit = lastFitZoomRef.current;
    if (previousFit === null) return;
    if (Math.abs(zoom - previousFit) > FIT_MODE_TOLERANCE) return;

    const fit = computeFitWidthZoom(metadata.page_w, containerWidth);
    lastFitZoomRef.current = fit;
    if (Math.abs(fit - zoom) > FIT_MODE_TOLERANCE) {
      setFitWidthZoom(fit);
    }
  }, [containerWidth, metadata, zoom, setFitWidthZoom]);

  if (!filePath) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>📄</div>
        <p>Open a PDF file to start inspecting</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <p>Loading PDF...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.errorText}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className={styles.viewport} ref={setScrollEl}>
      <div className={styles.pagesContainer}>
        {pdfDoc && (
          <PdfPage
            key={currentPage}
            pageNum={currentPage}
            zoom={zoom}
            pdfDoc={pdfDoc}
          />
        )}
      </div>
    </div>
  );
};
