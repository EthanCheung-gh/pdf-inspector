import React, { useEffect, useRef } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import {
  PAGE_BOX_KEYS,
  useWorkspaceStore,
  type PageBoxKey,
  type PageBoxVisibility,
} from '../../store/workspace-store';
import type { PageBox, PageBoxes } from '../../types/pdf-objects';

/**
 * Canvas overlay for the five PDF page boxes.
 *
 * PDF.js' `PageViewport` already contains the rotation and crop offset, so
 * converting both corners of a raw PDF rectangle through it keeps the outline
 * aligned for rotation 0/90/180/270 without any per-case math here.
 */

export interface PageBoxStyle {
  label: string;
  color: string;
  dash: number[];
}

/** One distinct colour/dash pattern per box, shared with the Page tab swatches. */
export const PAGE_BOX_STYLES: Record<PageBoxKey, PageBoxStyle> = {
  media: { label: 'MediaBox', color: '#8e99a6', dash: [6, 4] },
  crop: { label: 'CropBox', color: '#f2c14e', dash: [4, 3] },
  trim: { label: 'TrimBox', color: '#5fbf7f', dash: [2, 3] },
  bleed: { label: 'BleedBox', color: '#5aa9e6', dash: [8, 3, 2, 3] },
  art: { label: 'ArtBox', color: '#b98cf0', dash: [1, 3] },
};

/**
 * The subset of `PageViewport` this overlay needs. Keeping it structural lets
 * tests pass a fake mapper without constructing a PDF.js page.
 */
export interface PagePointMapper {
  width: number;
  height: number;
  convertToViewportPoint: (x: number, y: number) => number[];
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert one raw PDF box into a positive viewport-space rectangle. */
export const pageBoxToViewportRect = (
  viewport: PagePointMapper,
  box: PageBox,
): ViewportRect => {
  const [x0, y0] = viewport.convertToViewportPoint(box.x0, box.y0);
  const [x1, y1] = viewport.convertToViewportPoint(box.x1, box.y1);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
};

/** Minimal 2D-context surface used by `drawPageBoxes` (easy to fake in tests). */
export interface PageBoxCanvas {
  clearRect: (x: number, y: number, width: number, height: number) => void;
  strokeRect: (x: number, y: number, width: number, height: number) => void;
  setLineDash: (segments: number[]) => void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
}

/**
 * Draw every visible, defined box. Boxes are drawn in a fixed order so a
 * smaller TrimBox stays visible on top of the MediaBox outline.
 */
export const drawPageBoxes = (
  context: PageBoxCanvas,
  viewport: PagePointMapper,
  boxes: PageBoxes | null | undefined,
  visibility: PageBoxVisibility,
): void => {
  context.clearRect(0, 0, viewport.width, viewport.height);

  if (!boxes) return;

  for (const key of PAGE_BOX_KEYS) {
    const box = boxes[key];
    if (!visibility[key] || !box) continue;

    const style = PAGE_BOX_STYLES[key];
    const rect = pageBoxToViewportRect(viewport, box);

    context.strokeStyle = style.color;
    context.lineWidth = 1;
    context.globalAlpha = 0.95;
    context.setLineDash(style.dash);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  context.globalAlpha = 1;
  context.setLineDash([]);
};

interface PageGeometryOverlayProps {
  pageNum: number;
  viewport: PageViewport | null;
  boxes: PageBoxes | null | undefined;
}

export const PageGeometryOverlay: React.FC<PageGeometryOverlayProps> = ({
  pageNum,
  viewport,
  boxes,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageBoxVisibility = useWorkspaceStore((state) => state.pageBoxVisibility);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(viewport.width * dpr));
    canvas.height = Math.max(1, Math.round(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
    drawPageBoxes(context, viewport, boxes, pageBoxVisibility);
  }, [viewport, boxes, pageBoxVisibility]);

  if (!viewport) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-label={`PDF page ${pageNum} page boxes`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: viewport.width,
        height: viewport.height,
        pointerEvents: 'none',
      }}
    />
  );
};
