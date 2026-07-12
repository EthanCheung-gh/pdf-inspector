import React, { useEffect } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { usePdf } from '../../hooks/usePdf';
import { pathToFileUrl } from '../../../shared/path-utils';
import { PdfPage } from './PdfPage';
import styles from './PdfViewport.module.css';

export const PdfViewport: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const currentPage = usePdfStore((s) => s.currentPage);
  const zoom = usePdfStore((s) => s.zoom);
  const pageCount = usePdfStore((s) => s.pageCount);
  const { pdfDoc, renderPage, loadPdf, loading, error } = usePdf();

  // Load PDF document once when filePath changes
  useEffect(() => {
    if (filePath) {
      loadPdf(pathToFileUrl(filePath));
    }
  }, [filePath, loadPdf]);

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
    <div className={styles.viewport}>
      <div className={styles.pagesContainer}>
        {Array.from({ length: pageCount }, (_, i) => (
          <PdfPage
            key={i + 1}
            pageNum={i + 1}
            isVisible={i + 1 === currentPage}
            zoom={zoom}
            pdfDoc={pdfDoc}
            renderPage={renderPage}
          />
        ))}
      </div>
    </div>
  );
};
