import React, { useEffect, useRef } from 'react';
import { useHitTest } from '../../hooks/useHitTest';
import { useOverlay } from '../../hooks/useOverlay';
import { usePdfStore } from '../../store/pdf-store';

interface OverlayCanvasProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
  zoom: number;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
  // The parent includes zoom in pageWidth and pageHeight.
  zoom: _zoom,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const allObjects = usePdfStore((state) => state.allObjects);
  const pageData = usePdfStore((state) => state.pageData);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const setHoveredObject = usePdfStore((state) => state.setHoveredObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const { drawOverlays } = useOverlay();
  const { hitTest } = useHitTest();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = pageWidth;
    canvas.height = pageHeight;
    const context = canvas.getContext('2d');
    if (context) {
      drawOverlays(context, allObjects, overlayVisibility, pageWidth, pageHeight, pdfWidth, pdfHeight);
    }
  }, [allObjects, drawOverlays, overlayVisibility, pageData, pageWidth, pageHeight, pdfWidth, pdfHeight]);

  const getHoveredObject = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(
      allObjects,
      event.clientX - rect.left,
      event.clientY - rect.top,
      pdfWidth,
      pdfHeight,
      rect.width,
      rect.height,
    );
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseMove={(event) => setHoveredObject(getHoveredObject(event))}
      onClick={() => setSelectedObject(usePdfStore.getState().hoveredObject)}
      onMouseLeave={() => setHoveredObject(null)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        cursor: 'crosshair',
      }}
      aria-label={`PDF page ${pageNum} object overlay`}
    />
  );
};
