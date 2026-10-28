import React from 'react';
import { usePdfStore } from '../../store/pdf-store';

interface InspectorHighlightProps {
  pageNum: number;
}

export const InspectorHighlight: React.FC<InspectorHighlightProps> = ({ pageNum }) => {
  const hoveredObject = usePdfStore((state) => state.hoveredObject);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const metadata = usePdfStore((state) => state.metadata);
  const pageData = usePdfStore((state) => state.pageData);
  const zoom = usePdfStore((state) => state.zoom);

  const object = hoveredObject || selectedObject;
  if (!object || object.page !== pageNum) return null;

  const isHovered = object === hoveredObject;
  // Object coordinates are in the current page's PDF space, so the highlight
  // must flip the y axis with that page's height (not page 1's).
  const pdfHeight = pageData?.height ?? metadata?.page_h ?? 792;

  return (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        left: object.x0 * zoom,
        top: (pdfHeight - object.y1) * zoom,
        width: (object.x1 - object.x0) * zoom,
        height: (object.y1 - object.y0) * zoom,
        border: `2px solid ${isHovered ? '#FFEB3B' : '#FFD700'}`,
        boxSizing: 'border-box',
      }}
    />
  );
};
