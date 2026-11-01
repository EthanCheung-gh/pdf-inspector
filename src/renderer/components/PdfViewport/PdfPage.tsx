import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useCursorStore } from '../../store/cursor-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { isRenderCancelled } from '../../services/pdf-render';
import type { PageBox } from '../../types/pdf-objects';
import { OverlayCanvas } from './OverlayCanvas';
import { PageGeometryOverlay } from './PageGeometryOverlay';
import { PageRuler } from './PageRuler';
import { InspectorHighlight } from './InspectorHighlight';
import { TextLayer } from './TextLayer';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import styles from './PdfPage.module.css';

interface PdfPageProps {
  pageNum: number;
  zoom: number;
  pdfDoc: PDFDocumentProxy | null;
}

interface PageViewportConstructorParams {
  viewBox: number[];
  scale: number;
  rotation: number;
  userUnit: number;
  offsetX?: number;
  offsetY?: number;
  dontFlip?: boolean;
}

type PageViewportConstructor = new (params: PageViewportConstructorParams) => PageViewport;

/**
 * PDF.js' viewport follows the CropBox (its `page.view`). Page boxes and rulers
 * must instead be anchored to the MediaBox, so rebuild the viewport with the
 * same scale/rotation/userUnit but the MediaBox as its viewBox.
 */
export const createMediaViewport = (
  viewport: PageViewport,
  media: PageBox,
): PageViewport => {
  const ViewportCtor = viewport.constructor as unknown as PageViewportConstructor;
  return new ViewportCtor({
    viewBox: [media.x0, media.y0, media.x1, media.y1],
    scale: viewport.scale,
    rotation: viewport.rotation,
    userUnit: viewport.userUnit || 1,
    offsetX: viewport.offsetX,
    offsetY: viewport.offsetY,
  });
};

export const PdfPage: React.FC<PdfPageProps> = ({ pageNum, zoom, pdfDoc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  // CSS-pixel viewport (scale = zoom, no device pixel ratio). Page geometry,
  // rulers and cursor conversion all share this one rotation-aware mapping.
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const metadata = usePdfStore((s) => s.metadata);
  const pageData = usePdfStore((s) => s.pageData);
  const showRulers = useWorkspaceStore((s) => s.showRulers);
  const setCursorPdfPoint = useCursorStore((s) => s.setCursorPdfPoint);

  const mediaBox = pageData?.boxes?.media;

  // The crop viewport is what PDF.js renders; the media viewport is the frame
  // that page boxes, rulers and the cursor origin are measured against.
  const mediaViewport = useMemo(() => {
    if (!viewport) return null;
    if (!mediaBox) return viewport;
    return createMediaViewport(viewport, mediaBox);
  }, [viewport, mediaBox]);

  // Render at device resolution and cancel work that becomes stale.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc) {
      setViewport(null);
      return;
    }

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

        // The overlay/ruler mapping must stay in CSS pixels; the canvas below
        // uses the same viewport scaled by the device pixel ratio.
        setViewport(page.getViewport({ scale: zoom }));

        const renderViewport = page.getViewport({ scale: zoom * dpr });
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;
        canvas.style.width = `${renderViewport.width / dpr}px`;
        canvas.style.height = `${renderViewport.height / dpr}px`;

        const context = canvas.getContext('2d');
        if (!context) return;

        const task = page.render({ canvasContext: context, viewport: renderViewport });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }
      } catch (error) {
        // Page/zoom changes cancel the in-flight render; that rejection is
        // expected control flow (the message includes the page number).
        if (isRenderCancelled(error)) return;
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

  // A cursor position belongs to one page/zoom; stale coordinates must not
  // linger in the status bar after navigating or zooming.
  useEffect(() => {
    setCursorPdfPoint(null);
    return () => setCursorPdfPoint(null);
  }, [pageNum, zoom, setCursorPdfPoint]);

  if (!pdfDoc) return null;

  // Each page has its own PDF-space size: `pageData` describes the page being
  // rendered, so it wins over the document-wide metadata (which reflects page 1
  // and is wrong for mixed-size PDFs). Metadata/Letter fallbacks only apply
  // while the current page's extraction is still in flight.
  const pdfWidth = pageData?.width ?? metadata?.page_w ?? 612;
  const pdfHeight = pageData?.height ?? metadata?.page_h ?? 792;

  const pageWidth = pdfWidth * zoom;
  const pageHeight = pdfHeight * zoom;

  // A rotated page is displayed sideways. Any nonzero /Rotate means the
  // existing object-overlay mapping (which assumes an unrotated page) cannot be
  // trusted, so hide it and explain why instead of drawing off-page boxes.
  const rotation = viewport?.rotation ?? pageData?.rotation ?? 0;
  const isRotated = rotation % 360 !== 0;
  const layoutWidth = mediaViewport?.width ?? pageWidth;
  const layoutHeight = mediaViewport?.height ?? pageHeight;

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!mediaViewport) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const [rawX, rawY] = mediaViewport.convertToPdfPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;

    // Object coordinates are relative to the MediaBox origin, while the
    // viewport returns absolute PDF points.
    setCursorPdfPoint({
      x: rawX - (mediaBox?.x0 ?? 0),
      y: rawY - (mediaBox?.y0 ?? 0),
    });
  };

  return (
    <div
      className={styles.pageFrame}
      data-testid="pdf-page-frame"
      style={{ width: layoutWidth, height: layoutHeight }}
    >
      <div
        className={styles.pageContainer}
        data-testid="pdf-page-container"
        style={{ width: layoutWidth, height: layoutHeight }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setCursorPdfPoint(null)}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
        <TextLayer pageNum={pageNum} pdfDoc={pdfDoc} zoom={zoom} />
        {/* Object overlays use the unrotated PDF page mapping, so they cannot be
            drawn on a rotated page; hiding them beats drawing off-page boxes. */}
        {!isRotated && (
          <OverlayCanvas
            pageNum={pageNum}
            pageWidth={pageWidth}
            pageHeight={pageHeight}
            pdfWidth={pdfWidth}
            pdfHeight={pdfHeight}
          />
        )}
        <PageGeometryOverlay
          pageNum={pageNum}
          viewport={mediaViewport}
          boxes={pageData?.boxes}
        />
        {!isRotated && <InspectorHighlight pageNum={pageNum} />}
        {isRotated && (
          <div className={styles.rotationNotice} role="status">
            Rotated page: object overlay unavailable
          </div>
        )}
      </div>
      {showRulers && (
        <PageRuler width={layoutWidth} height={layoutHeight} viewport={mediaViewport} />
      )}
    </div>
  );
};
