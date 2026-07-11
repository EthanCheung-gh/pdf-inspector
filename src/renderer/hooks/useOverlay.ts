import { useCallback } from 'react';
import { PdfObject } from '../types/pdf-objects';

const OVERLAY_COLORS: Record<PdfObject['type'], string> = {
  char: 'rgba(80, 200, 80, 0.5)',
  word: 'rgba(80, 120, 255, 0.5)',
  rect: 'rgba(200, 100, 200, 0.5)',
  line: 'rgba(255, 80, 80, 0.6)',
  curve: 'rgba(255, 160, 50, 0.6)',
  image: 'rgba(80, 220, 220, 0.5)',
  table: 'rgba(80, 160, 255, 0.5)',
};

export const useOverlay = () => {
  const drawOverlays = useCallback((
    ctx: CanvasRenderingContext2D,
    objects: PdfObject[],
    visibleTypes: Record<string, boolean>,
    pageWidth: number,
    pageHeight: number,
    pdfWidth: number,
    pdfHeight: number,
  ) => {
    ctx.clearRect(0, 0, pageWidth, pageHeight);

    const scaleX = pageWidth / pdfWidth;
    const scaleY = pageHeight / pdfHeight;

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
      ctx.font = '11px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(object.type, x + 2, y + 2);
    });
  }, []);

  return { drawOverlays };
};
