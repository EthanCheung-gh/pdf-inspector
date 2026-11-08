import React, { useEffect, useRef } from 'react';
import { drawAnnotations } from '../../services/annotation-view';
import { useAnnotationStore } from '../../store/annotation-store';
import type { PdfAnnotation } from '../../types/annotations';

interface AnnotationOverlayProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
}

/** Stable empty list, so a page without annotations never re-runs the effect. */
const NO_ANNOTATIONS: readonly PdfAnnotation[] = [];

/**
 * Read-only annotation boxes, drawn on a canvas that never receives the pointer.
 *
 * The object overlay above stays the click target for objects and region drags;
 * annotation hit-testing and selection live in `OverlayCanvas`, which owns the
 * interactive canvas. This layer only paints what the annotation store says
 * belongs to the current page, so data left over from another page cannot be
 * drawn here.
 */
export const AnnotationOverlay: React.FC<AnnotationOverlayProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const page = useAnnotationStore((state) => state.page);
  const annotations = useAnnotationStore((state) => state.annotations);
  const selected = useAnnotationStore((state) => state.selected);
  const hovered = useAnnotationStore((state) => state.hovered);
  const showBoxes = useAnnotationStore((state) => state.showBoxes);

  const isCurrentPage = page === pageNum;
  const pageAnnotations = isCurrentPage ? annotations : NO_ANNOTATIONS;
  const selectedOnPage = isCurrentPage && selected !== null && selected.page === pageNum ? selected : null;
  const hoveredOnPage = isCurrentPage && hovered !== null && hovered.page === pageNum ? hovered : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(pageWidth * dpr));
    canvas.height = Math.max(1, Math.round(pageHeight * dpr));
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr);

    // `Show boxes` off must also erase what was drawn before the toggle.
    if (!showBoxes) {
      context.clearRect(0, 0, pageWidth, pageHeight);
      return;
    }

    drawAnnotations(context, pageAnnotations, {
      pageWidth,
      pageHeight,
      pdfWidth,
      pdfHeight,
      selected: selectedOnPage,
      hovered: hoveredOnPage,
    });
  }, [
    pageAnnotations,
    selectedOnPage,
    hoveredOnPage,
    showBoxes,
    pageWidth,
    pageHeight,
    pdfWidth,
    pdfHeight,
  ]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="annotation-overlay"
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        pointerEvents: 'none',
      }}
    />
  );
};
