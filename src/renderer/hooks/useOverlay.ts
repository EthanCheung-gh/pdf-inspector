import { useCallback } from 'react';
import { PdfObject } from '../types/pdf-objects';
import type { BBox, ObjectSubset } from '../services/object-filter';
import { OVERLAY_COLORS } from '../services/overlay-style';
import { useWorkspaceStore } from '../store/workspace-store';

export const useOverlay = () => {
  const overlayOpacity = useWorkspaceStore((state) => state.overlayOpacity);

  const drawOverlays = useCallback((
    ctx: CanvasRenderingContext2D,
    objects: PdfObject[],
    visibleTypes: Record<string, boolean>,
    pageWidth: number,
    pageHeight: number,
    pdfWidth: number,
    pdfHeight: number,
    subset?: ObjectSubset | null,
    regionRect?: BBox | null,
  ) => {
    ctx.clearRect(0, 0, pageWidth, pageHeight);

    const scaleX = pageWidth / pdfWidth;
    const scaleY = pageHeight / pdfHeight;

    // The opacity control dims the object boxes only. Region rectangles and
    // selection highlights below reset the alpha back to 1 so they stay
    // legible regardless of the layer opacity.
    ctx.globalAlpha = overlayOpacity;

    objects.forEach((object) => {
      if (!visibleTypes[object.type]) return;

      ctx.strokeStyle = OVERLAY_COLORS[object.type];
      ctx.fillStyle = OVERLAY_COLORS[object.type];
      ctx.lineWidth = 1;
      ctx.beginPath();

      if (object.type === 'line') {
        ctx.moveTo(object.x0 * scaleX, pageHeight - object.y0 * scaleY);
        ctx.lineTo(object.x1 * scaleX, pageHeight - object.y1 * scaleY);
        ctx.stroke();
        return;
      }

      if (object.type === 'curve') {
        object.points.forEach((point, index) => {
          const [x, y] = point;
          if (index === 0) {
            ctx.moveTo(x * scaleX, pageHeight - y * scaleY);
          } else {
            ctx.lineTo(x * scaleX, pageHeight - y * scaleY);
          }
        });
        ctx.stroke();
        return;
      }

      const x = object.x0 * scaleX;
      const y = pageHeight - object.y1 * scaleY;
      const width = (object.x1 - object.x0) * scaleX;
      const height = (object.y1 - object.y0) * scaleY;
      ctx.strokeRect(x, y, width, height);
    });

    ctx.globalAlpha = 1;

    if (regionRect) {
      const x = regionRect.x0 * scaleX;
      const y = pageHeight - regionRect.y1 * scaleY;
      const w = (regionRect.x1 - regionRect.x0) * scaleX;
      const h = (regionRect.y1 - regionRect.y0) * scaleY;
      ctx.fillStyle = 'rgba(80, 160, 255, 0.15)';
      ctx.strokeStyle = 'rgba(80, 160, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    // Filter subsets already draw only the selected objects, so an extra pass
    // would just double their outlines. The orange highlight belongs to regions.
    if (subset && subset.source === 'region') {
      const memberSet = new Set(subset.objects);
      ctx.strokeStyle = 'rgba(255, 140, 0, 1)';
      ctx.lineWidth = 2;
      objects.forEach((object) => {
        if (!memberSet.has(object)) return;
        if (object.type === 'line') {
          ctx.beginPath();
          ctx.moveTo(object.x0 * scaleX, pageHeight - object.y0 * scaleY);
          ctx.lineTo(object.x1 * scaleX, pageHeight - object.y1 * scaleY);
          ctx.stroke();
          return;
        }
        const x = object.x0 * scaleX;
        const y = pageHeight - object.y1 * scaleY;
        ctx.strokeRect(x, y, (object.x1 - object.x0) * scaleX, (object.y1 - object.y0) * scaleY);
      });
    }
  }, [overlayOpacity]);

  return { drawOverlays };
};
