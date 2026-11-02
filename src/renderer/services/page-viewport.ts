/**
 * MediaBox viewport construction shared by the Inspect page renderer and the
 * Diff panes.
 *
 * PDF.js builds its viewport from the CropBox (`page.view`), but page boxes,
 * diff boxes and rulers are MediaBox-relative. Rebuilding the viewport with the
 * MediaBox as its viewBox keeps one rotation-aware mapping between PDF points
 * and CSS pixels.
 */
import type { PageViewport } from 'pdfjs-dist';
import type { PageBox } from '../types/pdf-objects';

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

export const createMediaViewport = (viewport: PageViewport, media: PageBox): PageViewport => {
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
