/**
 * Off-screen page capture for PNG/SVG export (work package K1).
 *
 * The service renders PDF.js into a detached canvas at an export-only scale,
 * then reuses the same overlay geometry as the live viewport so an exported
 * snapshot matches what the user sees. Object and annotation boxes use the
 * unrotated bottom-left mapping (the same limitation as the live overlays);
 * page boxes go through the rotation-aware PDF.js viewport mapping.
 *
 * Everything below is DOM-free except for the default canvas factory, so a
 * recording 2D context and a fake PDF page are enough to unit test it.
 */
import type { PageViewport } from 'pdfjs-dist';
import {
  PAGE_BOX_STYLES,
  pageBoxToViewportRect,
  type PagePointMapper,
} from '../components/PdfViewport/PageGeometryOverlay';
import { PAGE_BOX_KEYS } from '../store/workspace-store';
import type { PdfAnnotation } from '../types/annotations';
import type {
  PageBox,
  PageBoxes,
  PageData,
  PdfObject,
  PdfObjectType,
} from '../types/pdf-objects';
import {
  ANNOTATION_COLORS,
  ANNOTATION_FILL_ALPHA,
  ANNOTATION_STROKE_ALPHA,
  drawAnnotations,
  isUsableAnnotationRect,
  withAlpha,
} from './annotation-view';
import { OVERLAY_COLORS, OVERLAY_LAYERS } from './overlay-style';
import { createMediaViewport } from './page-viewport';

/** Hard pixel limits for an exported capture. */
export const CAPTURE_MAX_SIDE = 8192;
export const CAPTURE_MAX_PIXELS = 32_000_000;
export const CAPTURE_MIN_SCALE = 1;
export const CAPTURE_MAX_SCALE = 3;

export const EMPTY_REGION_WARNING = 'Region is empty; exported the full page.';
export const ROTATED_OBJECTS_WARNING = 'Object boxes are unavailable on rotated pages.';
export const ROTATED_ANNOTATIONS_WARNING = 'Annotation boxes are unavailable on rotated pages.';

export interface CaptureOverlays {
  objects: boolean;
  annotations: boolean;
  pageBoxes: boolean;
}

export interface CaptureOptions {
  /** Requested multiplier; clamped to 1..3 and reduced further by the pixel caps. */
  scale: number;
  /** MediaBox-relative PDF points; null exports the full page. */
  region: PageBox | null;
  overlays: CaptureOverlays;
  /** Object types to draw; undefined draws every type. */
  objectTypes?: readonly PdfObjectType[];
  /** Object-box alpha, default 1, clamped 0..1. */
  overlayOpacity?: number;
}

/**
 * Rendered geometry that lets `capturePageSvg` align vector overlays with the
 * PNG. It is attached by `capturePage`; a hand-built `CapturedImage` may omit
 * it and falls back to an uncropped, unrotated frame.
 */
export interface CaptureFrame {
  /** Full rendered canvas size in pixels, before cropping. */
  canvasWidth: number;
  canvasHeight: number;
  /** Crop origin inside the full canvas, in pixels. */
  offsetX: number;
  offsetY: number;
  /** MediaBox-relative page size in PDF points used by object/annotation geometry. */
  pdfWidth: number;
  pdfHeight: number;
  /** Normalized page rotation of the rendered viewport. */
  rotation: number;
  /** Captured 1-based page number; null when the frame was not produced here. */
  pageNumber: number | null;
  /** Rendered viewport at the applied scale, for rotation-aware page boxes. */
  viewport: PagePointMapper;
}

export interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
  pngDataUrl: string;
  /** Actual scale after pixel-cap clamping. */
  appliedScale: number;
  /** True when the requested region was cropped. */
  cropped: boolean;
  /** User-visible limitations, e.g. rotated page skipped object boxes. */
  warnings: string[];
  /**
   * Internal overlay frame; callers only need it when they rebuild the image
   * themselves. `capturePageSvg` uses it to keep vectors aligned after a crop.
   */
  frame?: CaptureFrame;
}

export interface CaptureViewport {
  width: number;
  height: number;
  scale: number;
  rotation?: number;
  convertToViewportPoint: (x: number, y: number) => number[];
}

export interface CaptureRenderTask {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface CapturePageLike {
  getViewport(params: { scale: number }): CaptureViewport;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }): CaptureRenderTask;
}

export interface CaptureDocumentLike {
  getPage(pageNumber: number): Promise<CapturePageLike>;
}

/** Minimal canvas surface used by the capture; tests can supply a fake. */
export interface CaptureCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

export type CaptureCanvasFactory = () => CaptureCanvasLike;

export interface ResolvedCaptureSize {
  /** Scale actually used after clamping; rounded down so caps hold. */
  scale: number;
  width: number;
  height: number;
}

export interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

const createDomCanvas = (): CaptureCanvasLike => {
  if (typeof document === 'undefined') {
    throw new Error('Canvas capture requires a DOM document.');
  }
  return document.createElement('canvas');
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Normalize a page rotation into 0/90/180/270. */
export function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/**
 * Clamp the requested export scale to 1..3 and shrink it until the canvas fits
 * the side and total-pixel caps. Flooring the scale (and the pixel dimensions)
 * keeps the result on the safe side of both caps.
 *
 * A page that already exceeds the caps at 1x is rejected instead of silently
 * exporting a truncated image.
 */
export function resolveCaptureScale(
  requestedScale: number,
  baseWidth: number,
  baseHeight: number,
): ResolvedCaptureSize {
  if (
    !Number.isFinite(baseWidth) ||
    !Number.isFinite(baseHeight) ||
    baseWidth <= 0 ||
    baseHeight <= 0
  ) {
    throw new Error('Page size is unavailable; this page cannot be exported.');
  }

  if (
    baseWidth > CAPTURE_MAX_SIDE ||
    baseHeight > CAPTURE_MAX_SIDE ||
    baseWidth * baseHeight > CAPTURE_MAX_PIXELS
  ) {
    throw new Error(
      `Page is too large to export at 1x: ${Math.ceil(baseWidth)}×${Math.ceil(baseHeight)} px ` +
        `exceeds the ${CAPTURE_MAX_SIDE} px side / ${CAPTURE_MAX_PIXELS} px total limit.`,
    );
  }

  const requested = Number.isFinite(requestedScale) ? requestedScale : CAPTURE_MIN_SCALE;
  const clamped = Math.min(CAPTURE_MAX_SCALE, Math.max(CAPTURE_MIN_SCALE, requested));
  const limit = Math.min(
    CAPTURE_MAX_SIDE / baseWidth,
    CAPTURE_MAX_SIDE / baseHeight,
    Math.sqrt(CAPTURE_MAX_PIXELS / (baseWidth * baseHeight)),
  );
  const scale = Math.max(CAPTURE_MIN_SCALE, Math.min(clamped, limit));
  const rounded = Math.max(CAPTURE_MIN_SCALE, Math.floor(scale * 1000) / 1000);

  return {
    scale: rounded,
    width: Math.max(1, Math.floor(baseWidth * rounded)),
    height: Math.max(1, Math.floor(baseHeight * rounded)),
  };
}

/**
 * Map a MediaBox-relative region onto the rendered canvas and clamp it to the
 * canvas bounds. Returns null for degenerate, non-finite or off-canvas regions
 * so the caller can fall back to the full page.
 */
export function resolveRegionCrop(
  region: PageBox | null,
  viewport: PagePointMapper,
  origin: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number,
): CaptureCrop | null {
  if (region === null) return null;
  if (
    !Number.isFinite(region.x0) ||
    !Number.isFinite(region.y0) ||
    !Number.isFinite(region.x1) ||
    !Number.isFinite(region.y1)
  ) {
    return null;
  }
  if (region.x1 <= region.x0 || region.y1 <= region.y0) return null;
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;

  // Region coordinates are relative to the MediaBox origin while the viewport
  // expects absolute PDF points.
  const absoluteCorners: Array<[number, number]> = [
    [region.x0 + origin.x, region.y0 + origin.y],
    [region.x1 + origin.x, region.y0 + origin.y],
    [region.x0 + origin.x, region.y1 + origin.y],
    [region.x1 + origin.x, region.y1 + origin.y],
  ];
  const corners: Array<[number, number]> = [];
  for (const [x, y] of absoluteCorners) {
    const [viewportX, viewportY] = viewport.convertToViewportPoint(x, y);
    if (!Number.isFinite(viewportX) || !Number.isFinite(viewportY)) return null;
    corners.push([viewportX, viewportY]);
  }

  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(canvasWidth, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(canvasHeight, Math.ceil(Math.max(...ys)));

  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return null;

  return { x: left, y: top, width, height };
}

/**
 * Draw the selected object types with the same colors, opacity and bottom-left
 * mapping as `useOverlay`. Lines and curves become paths; every other type is a
 * box. Returns the number of objects drawn.
 */
export function drawCaptureObjects(
  ctx: CanvasRenderingContext2D,
  pageData: PageData,
  objectTypes: readonly PdfObjectType[] | undefined,
  opacity: number,
  pageWidth: number,
  pageHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): number {
  if (!(pdfWidth > 0) || !(pdfHeight > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return 0;

  const allowed = objectTypes === undefined ? null : new Set(objectTypes);
  const scaleX = pageWidth / pdfWidth;
  const scaleY = pageHeight / pdfHeight;

  ctx.globalAlpha = clampOpacity(opacity);
  let drawn = 0;

  for (const layer of OVERLAY_LAYERS) {
    if (allowed && !allowed.has(layer.type)) continue;

    const objects: readonly PdfObject[] = pageData[layer.countKey];
    for (const object of objects) {
      ctx.strokeStyle = OVERLAY_COLORS[object.type];
      ctx.fillStyle = OVERLAY_COLORS[object.type];
      ctx.lineWidth = 1;
      ctx.beginPath();

      if (object.type === 'line') {
        ctx.moveTo(object.x0 * scaleX, pageHeight - object.y0 * scaleY);
        ctx.lineTo(object.x1 * scaleX, pageHeight - object.y1 * scaleY);
        ctx.stroke();
        drawn += 1;
        continue;
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
        drawn += 1;
        continue;
      }

      ctx.strokeRect(
        object.x0 * scaleX,
        pageHeight - object.y1 * scaleY,
        (object.x1 - object.x0) * scaleX,
        (object.y1 - object.y0) * scaleY,
      );
      drawn += 1;
    }
  }

  ctx.globalAlpha = 1;
  return drawn;
}

/** Annotations that belong on the exported page and have drawable geometry. */
export function selectCaptureAnnotations(
  annotations: readonly PdfAnnotation[],
  pageNumber: number | null,
  pdfWidth: number,
  pdfHeight: number,
): PdfAnnotation[] {
  return annotations.filter(
    (annotation) =>
      (pageNumber === null || annotation.page === pageNumber) &&
      !annotation.hidden &&
      isUsableAnnotationRect(annotation.rect, pdfWidth, pdfHeight),
  );
}

/**
 * Draw every defined page box with the Page-tab styles. Unlike
 * `drawPageBoxes`, this never clears the canvas: the exported page is already
 * underneath. Works for rotated pages because it maps through the viewport.
 */
export function drawCapturePageBoxes(
  ctx: CanvasRenderingContext2D,
  viewport: PagePointMapper,
  boxes: PageBoxes | null | undefined,
): number {
  if (!boxes) return 0;

  let drawn = 0;
  for (const key of PAGE_BOX_KEYS) {
    const box = boxes[key];
    if (!box) continue;

    const style = PAGE_BOX_STYLES[key];
    const rect = pageBoxToViewportRect(viewport, box);

    ctx.strokeStyle = style.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.95;
    ctx.setLineDash(style.dash);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    drawn += 1;
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  return drawn;
}

/**
 * Render one page into a detached canvas, add the requested overlays, crop to
 * the region and encode the result as PNG.
 *
 * The optional canvas factory is a test seam: production callers use the DOM.
 */
export async function capturePage(
  pdfDoc: CaptureDocumentLike,
  pageNumber: number,
  pageData: PageData,
  annotations: readonly PdfAnnotation[],
  options: CaptureOptions,
  createCanvas: CaptureCanvasFactory = createDomCanvas,
): Promise<CapturedImage> {
  let page: CapturePageLike;
  try {
    page = await pdfDoc.getPage(pageNumber);
  } catch (error) {
    throw new Error(`Could not load page ${pageNumber} for export: ${describeError(error)}`);
  }

  const baseViewport = page.getViewport({ scale: CAPTURE_MIN_SCALE });
  const media = pageData.boxes?.media ?? null;
  const origin = media ? { x: media.x0, y: media.y0 } : { x: 0, y: 0 };
  const baseFrame = media ? toMediaViewport(baseViewport, media) : baseViewport;

  const { scale, width, height } = resolveCaptureScale(
    options.scale,
    baseFrame.width,
    baseFrame.height,
  );

  // Rebuild the viewport at the capped scale so rendered pixels, region mapping
  // and page-box mapping all share one frame.
  const scaledViewport = page.getViewport({ scale });
  const viewport = media ? toMediaViewport(scaledViewport, media) : scaledViewport;
  const rotation = normalizeRotation(viewport.rotation ?? pageData.rotation ?? 0);

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = getCanvasContext(
    canvas,
    'Could not create a 2D canvas context for the page export.',
  );

  try {
    await page.render({ canvasContext: context, viewport }).promise;
  } catch (error) {
    throw new Error(`Could not render page ${pageNumber} for export: ${describeError(error)}`);
  }

  const warnings: string[] = [];
  const pdfWidth = media ? media.x1 - media.x0 : pageData.width;
  const pdfHeight = media ? media.y1 - media.y0 : pageData.height;

  if (options.overlays.objects) {
    if (rotation === 0) {
      drawCaptureObjects(
        context,
        pageData,
        options.objectTypes,
        options.overlayOpacity ?? 1,
        width,
        height,
        pdfWidth,
        pdfHeight,
      );
    } else {
      warnings.push(ROTATED_OBJECTS_WARNING);
    }
  }

  if (options.overlays.annotations) {
    if (rotation === 0) {
      drawCaptureAnnotations(
        context,
        createCanvas,
        selectCaptureAnnotations(annotations, pageNumber, pdfWidth, pdfHeight),
        width,
        height,
        pdfWidth,
        pdfHeight,
      );
    } else {
      warnings.push(ROTATED_ANNOTATIONS_WARNING);
    }
  }

  if (options.overlays.pageBoxes) {
    drawCapturePageBoxes(context, viewport, pageData.boxes ?? null);
  }

  const crop = options.region
    ? resolveRegionCrop(options.region, viewport, origin, width, height)
    : null;
  if (options.region && crop === null) warnings.push(EMPTY_REGION_WARNING);

  let output = canvas;
  let outputWidth = width;
  let outputHeight = height;
  let cropped = false;
  let offsetX = 0;
  let offsetY = 0;

  if (crop !== null) {
    const croppedCanvas = createCanvas();
    croppedCanvas.width = crop.width;
    croppedCanvas.height = crop.height;
    const croppedContext = getCanvasContext(
      croppedCanvas,
      'Could not create a 2D canvas context for the cropped export.',
    );
    croppedContext.drawImage(
      canvas as unknown as CanvasImageSource,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    output = croppedCanvas;
    outputWidth = crop.width;
    outputHeight = crop.height;
    cropped = true;
    offsetX = crop.x;
    offsetY = crop.y;
  }

  const pngDataUrl = readPngDataUrl(output);

  return {
    blob: pngDataUrlToBlob(pngDataUrl),
    width: outputWidth,
    height: outputHeight,
    pngDataUrl,
    appliedScale: scale,
    cropped,
    warnings,
    frame: {
      canvasWidth: width,
      canvasHeight: height,
      offsetX,
      offsetY,
      pdfWidth,
      pdfHeight,
      rotation,
      pageNumber,
      viewport,
    },
  };
}

/**
 * Build a self-contained SVG: the PNG as a raster base plus vector overlays.
 * The document has no scripts, no external references and no event handlers;
 * annotation titles and box labels are escaped text nodes.
 */
export function capturePageSvg(
  captured: CapturedImage,
  pageData: PageData,
  annotations: readonly PdfAnnotation[],
  options: CaptureOptions,
): string {
  if (
    typeof captured.pngDataUrl !== 'string' ||
    !captured.pngDataUrl.startsWith('data:image/png')
  ) {
    throw new Error('A PNG data URL is required to build the SVG export.');
  }

  const width = positiveDimension(captured.width);
  const height = positiveDimension(captured.height);
  const frame = captured.frame ?? fallbackFrame(captured, pageData);
  const rotation = normalizeRotation(frame.rotation);

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  lines.push('  <title>PDF page capture</title>');

  if (captured.warnings.length > 0) {
    lines.push(`  <desc>${escapeXmlText(captured.warnings.join(' '))}</desc>`);
  }

  lines.push(
    `  <image href="${escapeXmlAttribute(captured.pngDataUrl)}" x="0" y="0" width="${width}" height="${height}"/>`,
  );

  if (options.overlays.objects && rotation === 0) {
    const elements = svgObjectElements(frame, pageData, options);
    if (elements.length > 0) {
      lines.push('  <g data-layer="objects">', ...elements, '  </g>');
    }
  }

  if (options.overlays.annotations && rotation === 0) {
    const elements = svgAnnotationElements(
      frame,
      selectCaptureAnnotations(
        annotations,
        frame.pageNumber,
        frame.pdfWidth,
        frame.pdfHeight,
      ),
    );
    if (elements.length > 0) {
      lines.push('  <g data-layer="annotations">', ...elements, '  </g>');
    }
  }

  if (options.overlays.pageBoxes) {
    const elements = svgPageBoxElements(frame, pageData.boxes ?? null);
    if (elements.length > 0) {
      lines.push('  <g data-layer="page-boxes">', ...elements, '  </g>');
    }
  }

  lines.push('</svg>');
  return lines.join('\n');
}

/** Decode the base64 payload of a data URL into bytes without extra deps. */
export function decodeBase64(input: string): Uint8Array {
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(Math.max(0, Math.floor((input.length * 3) / 4) - padding));
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 61) break; // '='
    const value = code < BASE64_VALUES.length ? BASE64_VALUES[code] : 0;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex] = (buffer >> bits) & 0xff;
      byteIndex += 1;
    }
  }

  return bytes.subarray(0, byteIndex);
}

/** Escape text for XML element content. */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text for an XML attribute value. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const BASE64_VALUES = (() => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table = new Uint8Array(128);
  for (let index = 0; index < alphabet.length; index += 1) {
    table[alphabet.charCodeAt(index)] = index;
  }
  return table;
})();

const clampOpacity = (opacity: number | undefined): number => {
  if (opacity === undefined || !Number.isFinite(opacity)) return 1;
  return Math.min(1, Math.max(0, opacity));
};

const positiveDimension = (value: number): number =>
  Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;

const formatNumber = (value: number): string =>
  Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';

/** `createMediaViewport` is typed for PDF.js viewports; the capture only needs the shape. */
const toMediaViewport = (viewport: CaptureViewport, media: PageBox): CaptureViewport =>
  createMediaViewport(viewport as unknown as PageViewport, media) as unknown as CaptureViewport;

function getCanvasContext(
  canvas: CaptureCanvasLike,
  message: string,
): CanvasRenderingContext2D {
  if (typeof canvas.getContext !== 'function') throw new Error(message);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(message);
  return context;
}

/**
 * Annotations are drawn on a scratch canvas because `drawAnnotations` clears
 * its target; compositing keeps the rendered page underneath intact.
 */
function drawCaptureAnnotations(
  context: CanvasRenderingContext2D,
  createCanvas: CaptureCanvasFactory,
  annotations: readonly PdfAnnotation[],
  width: number,
  height: number,
  pdfWidth: number,
  pdfHeight: number,
): void {
  if (annotations.length === 0) return;

  const scratch = createCanvas();
  scratch.width = width;
  scratch.height = height;
  const scratchContext = getCanvasContext(
    scratch,
    'Could not create a 2D canvas context for the annotation overlay.',
  );

  drawAnnotations(scratchContext, annotations, {
    pageWidth: width,
    pageHeight: height,
    pdfWidth,
    pdfHeight,
  });

  context.drawImage(scratch as unknown as CanvasImageSource, 0, 0);
}

function readPngDataUrl(canvas: CaptureCanvasLike): string {
  if (typeof canvas.toDataURL !== 'function') {
    throw new Error('This canvas cannot encode images (toDataURL is unavailable).');
  }

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    throw new Error(`Could not encode the exported page as PNG: ${describeError(error)}`);
  }

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
    throw new Error('The canvas did not return PNG data; the page could not be exported.');
  }
  return dataUrl;
}

function pngDataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('The exported PNG data URL is malformed.');

  const header = dataUrl.slice(0, comma);
  if (!header.includes(';base64')) {
    throw new Error('The exported PNG data URL is not base64-encoded.');
  }

  // `slice()` yields an ArrayBuffer-backed view, which is what `BlobPart` needs.
  return new Blob([decodeBase64(dataUrl.slice(comma + 1)).slice()], { type: 'image/png' });
}

function frameScales(frame: CaptureFrame): { scaleX: number; scaleY: number } {
  return {
    scaleX: frame.pdfWidth > 0 ? frame.canvasWidth / frame.pdfWidth : 0,
    scaleY: frame.pdfHeight > 0 ? frame.canvasHeight / frame.pdfHeight : 0,
  };
}

function svgObjectElements(
  frame: CaptureFrame,
  pageData: PageData,
  options: CaptureOptions,
): string[] {
  const { scaleX, scaleY } = frameScales(frame);
  if (scaleX <= 0 || scaleY <= 0) return [];

  const allowed = options.objectTypes === undefined ? null : new Set(options.objectTypes);
  const opacity = clampOpacity(options.overlayOpacity);
  const elements: string[] = [];

  for (const layer of OVERLAY_LAYERS) {
    if (allowed && !allowed.has(layer.type)) continue;
    const color = OVERLAY_COLORS[layer.type];
    const objects: readonly PdfObject[] = pageData[layer.countKey];

    for (const object of objects) {
      const stroke = `fill="none" stroke="${escapeXmlAttribute(color)}" stroke-width="1"`;
      const alpha = opacity < 1 ? ` opacity="${formatNumber(opacity)}"` : '';

      if (object.type === 'line') {
        elements.push(
          `<line x1="${formatNumber(object.x0 * scaleX - frame.offsetX)}" ` +
            `y1="${formatNumber(frame.canvasHeight - object.y0 * scaleY - frame.offsetY)}" ` +
            `x2="${formatNumber(object.x1 * scaleX - frame.offsetX)}" ` +
            `y2="${formatNumber(frame.canvasHeight - object.y1 * scaleY - frame.offsetY)}" ` +
            `${stroke}${alpha}><title>${escapeXmlText(object.type)}</title></line>`,
        );
        continue;
      }

      if (object.type === 'curve') {
        const points = object.points
          .map(
            ([x, y]) =>
              `${formatNumber(x * scaleX - frame.offsetX)},` +
              `${formatNumber(frame.canvasHeight - y * scaleY - frame.offsetY)}`,
          )
          .join(' ');
        elements.push(
          `<polyline points="${points}" ${stroke}${alpha}>` +
            `<title>${escapeXmlText(object.type)}</title></polyline>`,
        );
        continue;
      }

      elements.push(
        `<rect x="${formatNumber(object.x0 * scaleX - frame.offsetX)}" ` +
          `y="${formatNumber(frame.canvasHeight - object.y1 * scaleY - frame.offsetY)}" ` +
          `width="${formatNumber((object.x1 - object.x0) * scaleX)}" ` +
          `height="${formatNumber((object.y1 - object.y0) * scaleY)}" ` +
          `${stroke}${alpha}><title>${escapeXmlText(object.type)}</title></rect>`,
      );
    }
  }

  return elements;
}

function svgAnnotationElements(
  frame: CaptureFrame,
  annotations: readonly PdfAnnotation[],
): string[] {
  const elements: string[] = [];

  for (const annotation of annotations) {
    const rect = annotationScreenRectForFrame(frame, annotation.rect);
    if (rect === null) continue;

    const color = ANNOTATION_COLORS[annotation.kind] ?? ANNOTATION_COLORS.other;
    const label = annotation.title ?? annotation.subtype;

    elements.push(
      `<rect x="${formatNumber(rect.x)}" y="${formatNumber(rect.y)}" ` +
        `width="${formatNumber(rect.width)}" height="${formatNumber(rect.height)}" ` +
        `fill="${escapeXmlAttribute(withAlpha(color, ANNOTATION_FILL_ALPHA))}" ` +
        `stroke="${escapeXmlAttribute(withAlpha(color, ANNOTATION_STROKE_ALPHA))}" ` +
        `stroke-width="1"><title>${escapeXmlText(label)}</title></rect>`,
    );
  }

  return elements;
}

function annotationScreenRectForFrame(
  frame: CaptureFrame,
  rect: PageBox | null,
): CaptureCrop | null {
  if (rect === null) return null;
  if (frame.pdfWidth <= 0 || frame.pdfHeight <= 0) return null;
  if (!isUsableAnnotationRect(rect, frame.pdfWidth, frame.pdfHeight)) return null;

  const scaleX = frame.canvasWidth / frame.pdfWidth;
  const scaleY = frame.canvasHeight / frame.pdfHeight;
  return {
    x: rect.x0 * scaleX - frame.offsetX,
    y: frame.canvasHeight - rect.y1 * scaleY - frame.offsetY,
    width: (rect.x1 - rect.x0) * scaleX,
    height: (rect.y1 - rect.y0) * scaleY,
  };
}

function svgPageBoxElements(
  frame: CaptureFrame,
  boxes: PageBoxes | null,
): string[] {
  if (!boxes) return [];

  const elements: string[] = [];
  for (const key of PAGE_BOX_KEYS) {
    const box = boxes[key];
    if (!box) continue;

    const style = PAGE_BOX_STYLES[key];
    const rect = pageBoxToViewportRect(frame.viewport, box);

    elements.push(
      `<rect x="${formatNumber(rect.x - frame.offsetX)}" ` +
        `y="${formatNumber(rect.y - frame.offsetY)}" ` +
        `width="${formatNumber(rect.width)}" height="${formatNumber(rect.height)}" ` +
        `fill="none" stroke="${escapeXmlAttribute(style.color)}" stroke-width="1" ` +
        `stroke-dasharray="${style.dash.join(' ')}" opacity="0.95">` +
        `<title>${escapeXmlText(style.label)}</title></rect>`,
    );
  }

  return elements;
}

/**
 * Geometry for a hand-built `CapturedImage` (no `frame`): assume the image is
 * an uncropped, unrotated render and map overlays onto its own pixels. The page
 * number is unknown, so every usable annotation is kept.
 */
function fallbackFrame(captured: CapturedImage, pageData: PageData): CaptureFrame {
  const media = pageData.boxes?.media ?? null;
  const pdfWidth = media ? media.x1 - media.x0 : pageData.width;
  const pdfHeight = media ? media.y1 - media.y0 : pageData.height;
  const canvasWidth = positiveDimension(captured.width);
  const canvasHeight = positiveDimension(captured.height);
  const scaleX = pdfWidth > 0 ? canvasWidth / pdfWidth : 1;
  const scaleY = pdfHeight > 0 ? canvasHeight / pdfHeight : 1;

  return {
    canvasWidth,
    canvasHeight,
    offsetX: 0,
    offsetY: 0,
    pdfWidth,
    pdfHeight,
    rotation: 0,
    pageNumber: null,
    viewport: {
      width: canvasWidth,
      height: canvasHeight,
      convertToViewportPoint: (x, y) => [x * scaleX, canvasHeight - y * scaleY],
    },
  };
}
