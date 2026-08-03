import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { usePdfStore } from '../store/pdf-store';
import { filterByRegion, type BBox } from '../services/object-filter';

export function screenToPdf(
  screenX: number, screenY: number, pageWidth: number, pageHeight: number, pdfWidth: number, pdfHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / pageWidth) * pdfWidth,
    y: pdfHeight - (screenY / pageHeight) * pdfHeight,
  };
}

export function computeRegionBBox(start: { x: number; y: number }, end: { x: number; y: number }): BBox {
  return {
    x0: Math.min(start.x, end.x), y0: Math.min(start.y, end.y),
    x1: Math.max(start.x, end.x), y1: Math.max(start.y, end.y),
  };
}

export const useRegionSelect = (
  pageWidth: number, pageHeight: number, pdfWidth: number, pdfHeight: number,
) => {
  const regionMode = usePdfStore((s) => s.regionMode);
  const allObjects = usePdfStore((s) => s.allObjects);
  const setSubset = usePdfStore((s) => s.setSubset);
  const [dragging, setDragging] = useState(false);
  const [liveRect, setLiveRect] = useState<BBox | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!regionMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    startRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  }, [regionMode]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const start = startRef.current;
    if (!regionMode || !start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const startPdf = screenToPdf(start.x, start.y, pageWidth, pageHeight, pdfWidth, pdfHeight);
    const curPdf = screenToPdf(cur.x, cur.y, pageWidth, pageHeight, pdfWidth, pdfHeight);
    setLiveRect(computeRegionBBox(startPdf, curPdf));
  }, [pageWidth, pageHeight, pdfWidth, pdfHeight, regionMode]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const start = startRef.current;
    startRef.current = null;
    setDragging(false);
    setLiveRect(null);
    if (!regionMode || !start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // min drag (4px), treat as click
    const bbox = computeRegionBBox(
      screenToPdf(start.x, start.y, pageWidth, pageHeight, pdfWidth, pdfHeight),
      screenToPdf(end.x, end.y, pageWidth, pageHeight, pdfWidth, pdfHeight),
    );
    const mode = usePdfStore.getState().subset?.source === 'region' ? usePdfStore.getState().subset!.mode : 'intersect';
    setSubset({ source: 'region', mode, objects: filterByRegion(allObjects, bbox, mode), bbox });
  }, [allObjects, pageWidth, pageHeight, pdfWidth, pdfHeight, regionMode, setSubset]);

  return { handlers: { onMouseDown, onMouseMove, onMouseUp }, liveRect, dragging };
};
