import React, { useEffect, useRef } from 'react';
import { useHitTest } from '../../hooks/useHitTest';
import { useOverlay } from '../../hooks/useOverlay';
import { useRegionSelect } from '../../hooks/useRegionSelect';
import { usePdfStore } from '../../store/pdf-store';
import { effectiveOverlayVisibility, overlayObjects } from '../../services/overlay-visibility';

interface OverlayCanvasProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const allObjects = usePdfStore((state) => state.allObjects);
  const pageData = usePdfStore((state) => state.pageData);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const subset = usePdfStore((state) => state.subset);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const regionMode = usePdfStore((state) => state.regionMode);
  const setHoveredObject = usePdfStore((state) => state.setHoveredObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const { drawOverlays } = useOverlay();
  const { hitTest } = useHitTest();
  const { handlers, liveRect, dragging, wasDragRef } = useRegionSelect(pageWidth, pageHeight, pdfWidth, pdfHeight);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = pageWidth * dpr;
    canvas.height = pageHeight * dpr;
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const context = canvas.getContext('2d');
    if (context) {
      context.scale(dpr, dpr);
      // A property filter draws only its matching objects. Region mode keeps the
      // full page context (all objects plus the drawn rectangle) unchanged, so the
      // subset is ignored for drawing there while still being passed for its
      // region outline.
      const objects = overlayObjects(allObjects, regionMode ? null : subset);
      // The toolbar toggles always apply; the Inspector type filter narrows them
      // only outside region mode, which keeps every toolbar-enabled type visible.
      const visibility = effectiveOverlayVisibility(
        overlayVisibility,
        regionMode ? undefined : filterCriteria.types,
      );
      drawOverlays(context, objects, visibility, pageWidth, pageHeight, pdfWidth, pdfHeight, subset, liveRect);
    }
  }, [allObjects, drawOverlays, overlayVisibility, filterCriteria, regionMode, pageData, pageWidth, pageHeight, pdfWidth, pdfHeight, subset, liveRect]);

  const getHoveredObject = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Only hit-test what is actually drawn, otherwise hovering an empty area
    // while a filter hides objects would still select an invisible one.
    return hitTest(
      overlayObjects(allObjects, regionMode ? null : subset),
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
      onMouseDown={handlers.onMouseDown}
      onMouseMove={(event) => {
        handlers.onMouseMove(event);
        if (dragging) return;
        setHoveredObject(getHoveredObject(event));
      }}
      onMouseUp={handlers.onMouseUp}
      onClick={() => {
        // Skip the click fired right after a region drag so it does not select a stale hovered object.
        if (wasDragRef.current) return;
        setSelectedObject(usePdfStore.getState().hoveredObject);
      }}
      onMouseLeave={() => { if (!dragging) setHoveredObject(null); }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        cursor: textSelectionMode ? 'auto' : 'crosshair',
        pointerEvents: textSelectionMode ? 'none' : 'auto',
      }}
      aria-label={`PDF page ${pageNum} object overlay`}
    />
  );
};
