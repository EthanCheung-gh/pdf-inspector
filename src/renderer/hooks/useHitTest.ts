import { useCallback } from 'react';
import { PdfObject } from '../types/pdf-objects';

const HIT_TEST_PRIORITY: PdfObject['type'][] = [
  'char',
  'word',
  'rect',
  'line',
  'curve',
  'image',
  'table',
];

export const useHitTest = () => {
  const hitTest = useCallback((
    objects: PdfObject[],
    screenX: number,
    screenY: number,
    pdfWidth: number,
    pdfHeight: number,
    canvasWidth: number,
    canvasHeight: number,
  ): PdfObject | null => {
    if (!canvasWidth || !canvasHeight) return null;

    const pdfX = (screenX / canvasWidth) * pdfWidth;
    const pdfY = pdfHeight - (screenY / canvasHeight) * pdfHeight;

    for (const type of HIT_TEST_PRIORITY) {
      const match = objects.find(
        (object) =>
          object.type === type &&
          pdfX >= object.x0 &&
          pdfX <= object.x1 &&
          pdfY >= object.y0 &&
          pdfY <= object.y1,
      );

      if (match) return match;
    }

    return null;
  }, []);

  return { hitTest };
};
