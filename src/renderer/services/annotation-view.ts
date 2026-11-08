/**
 * Drawing and hit-testing helpers for the read-only annotation overlay.
 *
 * Annotations never become `PdfObject`s: they have their own colors, their own
 * canvas and their own hit-test, and none of them reach the object layers or
 * the export path. Everything here is pure and free of React/DOM access, so a
 * recording 2D context is enough to unit test it.
 */
import type { AnnotationKind, PdfAnnotation } from '../types/annotations';
import type { PageBox } from '../types/pdf-objects';

/**
 * Base color per annotation kind. Markup and note boxes are the ones that cover
 * text, so their colors stay distinguishable at the low fill alpha used below.
 */
export const ANNOTATION_COLORS: Record<AnnotationKind, string> = {
  link: '#2196f3',
  form: '#9c27b0',
  markup: '#ffc107',
  note: '#ff9800',
  stamp: '#00bcd4',
  other: '#9e9e9e',
};

/** Gold outline for the selected annotation; matches the object selection gold. */
export const ANNOTATION_SELECTED_COLOR = '#ffd700';

/** Idle boxes: a faint fill plus a slightly stronger outline. */
export const ANNOTATION_FILL_ALPHA = 0.12;
export const ANNOTATION_STROKE_ALPHA = 0.55;
/** Hovered boxes are brighter so the pointer target is obvious. */
export const ANNOTATION_HOVER_FILL_ALPHA = 0.22;
export const ANNOTATION_HOVER_STROKE_ALPHA = 0.95;
export const ANNOTATION_SELECTED_FILL_ALPHA = 0.2;

/** Hard cap on drawn labels so a dense page never turns into a wall of text. */
export const ANNOTATION_LABEL_LIMIT = 20;
const LABEL_MAX_CHARS = 24;

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationDrawOptions {
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
  /** Clicked annotation, outlined in gold. */
  selected?: PdfAnnotation | null;
  /** Annotation under the pointer, drawn brighter. */
  hovered?: PdfAnnotation | null;
  /** Draw a short title/subtype label per box; off by default. */
  labels?: boolean;
  /** Label cap, defaults to `ANNOTATION_LABEL_LIMIT`. */
  maxLabels?: number;
}

/** `#rrggbb` to `rgba(r, g, b, alpha)`; unparsable input is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) return color;

  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Whether a normalized annotation rect can be drawn and clicked: finite,
 * ordered, non-degenerate and at least partially inside the page frame. An
 * annotation with unusable geometry keeps its list entry but no box.
 */
export function isUsableAnnotationRect(
  rect: PageBox | null,
  pdfWidth: number,
  pdfHeight: number,
): rect is PageBox {
  if (rect === null) return false;
  if (
    !Number.isFinite(rect.x0) ||
    !Number.isFinite(rect.y0) ||
    !Number.isFinite(rect.x1) ||
    !Number.isFinite(rect.y1)
  ) {
    return false;
  }
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return false;

  // A rect entirely outside the page occupies no visible or clickable pixel.
  if (rect.x1 <= 0 || rect.y1 <= 0) return false;
  if (pdfWidth > 0 && rect.x0 >= pdfWidth) return false;
  if (pdfHeight > 0 && rect.y0 >= pdfHeight) return false;
  return true;
}

/**
 * Map a MediaBox-relative annotation rect onto the page canvas, using the same
 * scale/flip convention as the object overlay: PDF y grows upwards, canvas y
 * grows downwards. Returns null for rects that must not be drawn.
 */
export function annotationScreenRect(
  rect: PageBox | null,
  pageWidth: number,
  pageHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): ScreenRect | null {
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight)) return null;
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(pdfWidth > 0) || !(pdfHeight > 0)) return null;
  if (!isUsableAnnotationRect(rect, pdfWidth, pdfHeight)) return null;

  const scaleX = pageWidth / pdfWidth;
  const scaleY = pageHeight / pdfHeight;
  return {
    x: rect.x0 * scaleX,
    y: pageHeight - rect.y1 * scaleY,
    width: (rect.x1 - rect.x0) * scaleX,
    height: (rect.y1 - rect.y0) * scaleY,
  };
}

/**
 * Topmost annotation under a canvas point, or null.
 *
 * The annotation overlay is drawn in list order, so the hit-test walks the list
 * backwards: the box drawn last wins, exactly like a stack of shapes. Hidden
 * annotations and rects without usable geometry are never clickable.
 */
export function hitTestAnnotations(
  annotations: readonly PdfAnnotation[],
  screenX: number,
  screenY: number,
  pdfWidth: number,
  pdfHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): PdfAnnotation | null {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;
  if (!(pdfWidth > 0) || !(pdfHeight > 0)) return null;

  const pdfX = (screenX / canvasWidth) * pdfWidth;
  const pdfY = pdfHeight - (screenY / canvasHeight) * pdfHeight;

  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (annotation.hidden) continue;

    const rect = annotation.rect;
    if (!isUsableAnnotationRect(rect, pdfWidth, pdfHeight)) continue;

    if (pdfX >= rect.x0 && pdfX <= rect.x1 && pdfY >= rect.y0 && pdfY <= rect.y1) {
      return annotation;
    }
  }

  return null;
}

/**
 * Draw every drawable annotation box of the current page and return how many
 * were drawn.
 *
 * Hidden annotations and rects without usable geometry are skipped; the
 * selected annotation gets a gold outline, the hovered one a brighter version
 * of its kind color. The canvas is cleared first so a page with no boxes never
 * keeps stale rectangles.
 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: readonly PdfAnnotation[],
  options: AnnotationDrawOptions,
): number {
  const { pageWidth, pageHeight, pdfWidth, pdfHeight, selected = null, hovered = null } = options;

  ctx.clearRect(0, 0, pageWidth, pageHeight);
  ctx.globalAlpha = 1;

  const labelLimit = options.labels ? options.maxLabels ?? ANNOTATION_LABEL_LIMIT : 0;
  let drawn = 0;

  for (const annotation of annotations) {
    if (annotation.hidden) continue;

    const rect = annotationScreenRect(annotation.rect, pageWidth, pageHeight, pdfWidth, pdfHeight);
    if (rect === null) continue;

    const color = ANNOTATION_COLORS[annotation.kind] ?? ANNOTATION_COLORS.other;
    const isSelected = isSameAnnotation(selected, annotation);
    const isHovered = isSameAnnotation(hovered, annotation);

    if (isSelected) {
      ctx.fillStyle = withAlpha(ANNOTATION_SELECTED_COLOR, ANNOTATION_SELECTED_FILL_ALPHA);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = ANNOTATION_SELECTED_COLOR;
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else if (isHovered) {
      ctx.fillStyle = withAlpha(color, ANNOTATION_HOVER_FILL_ALPHA);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = withAlpha(color, ANNOTATION_HOVER_STROKE_ALPHA);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      ctx.fillStyle = withAlpha(color, ANNOTATION_FILL_ALPHA);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = withAlpha(color, ANNOTATION_STROKE_ALPHA);
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }

    if (drawn < labelLimit) drawLabel(ctx, annotation, rect, color);
    drawn += 1;
  }

  // Leave the context in a neutral state for whatever draws next.
  ctx.globalAlpha = 1;
  return drawn;
}

function isSameAnnotation(target: PdfAnnotation | null, annotation: PdfAnnotation): boolean {
  if (target === null) return false;
  return target === annotation || target.id === annotation.id;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  annotation: PdfAnnotation,
  rect: ScreenRect,
  color: string,
): void {
  ctx.font = '10px sans-serif';
  ctx.fillStyle = withAlpha(color, ANNOTATION_HOVER_STROKE_ALPHA);
  ctx.fillText(annotationLabel(annotation), rect.x + 2, rect.y + 10);
}

function annotationLabel(annotation: PdfAnnotation): string {
  const text = (annotation.title ?? annotation.subtype).trim();
  if (text.length === 0) return annotation.subtype;
  return text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text;
}
