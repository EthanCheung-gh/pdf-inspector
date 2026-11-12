/**
 * Pure pixel comparison for the Diff visual view.
 *
 * Deliberately DOM-free: the pane renders each PDF page into an offscreen
 * canvas and hands the resulting RGBA buffers here, so the threshold, ratio and
 * mask logic can be unit tested in Node without PDF.js or a canvas. Nothing in
 * this module depends on timing, device pixel ratio or randomness: the same two
 * buffers always produce the same numbers on every platform.
 *
 * Coordinates here are bitmap pixels (y grows downwards), not PDF points. The
 * PDF-point helpers (`fitBitmapSize`, `pageDrawRect`, `regionDrawRect`) only
 * decide how large the shared bitmap is, where a page is painted inside it and
 * where an ignore region lands on that page.
 */
import type { DiffBBox, DiffPageSize } from '../../shared/diff-types';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { translate, type TranslateFn } from '../i18n/translate';

/** English label for non-React callers; components pass their `useT()`. */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

/** Per-channel delta (0-255) above which a pixel counts as changed. */
export const DEFAULT_PIXEL_THRESHOLD = 24;

/** Hard cap on either bitmap dimension; larger pages are compared downscaled. */
export const MAX_PIXEL_BITMAP_DIMENSION = 1600;

/** Default alpha of the old page in the blend view. */
export const DEFAULT_VISUAL_OPACITY = 0.55;

/** How the visual pane composes the two pages. */
export type VisualDiffStyle = 'blend' | 'heatmap' | 'boxes';

export const VISUAL_DIFF_STYLES: readonly VisualDiffStyle[] = ['blend', 'heatmap', 'boxes'];

/**
 * Structural stand-in for `ImageData`.
 *
 * `ImageData` exists only in browsers with canvas support, and jsdom does not
 * implement it, so every function here accepts any compatible RGBA buffer. A
 * real `ImageData` satisfies this interface as-is.
 */
export interface PixelImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PixelBitmapSize {
  width: number;
  height: number;
}

/** Where a page is painted inside the shared bitmap, in bitmap pixels. */
export interface PixelDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelDiffOptions {
  /** Per-channel delta that still counts as equal. Default 24. */
  threshold?: number;
  /** Largest bitmap dimension to sample. Default `MAX_PIXEL_BITMAP_DIMENSION`. */
  maxDimension?: number;
  /**
   * Ignore-region hook: return true to skip a bitmap pixel.
   *
   * The pane builds this from the drawn `DiffIgnoreRegion`s and the page draw
   * rects; masked pixels are excluded from the total and reported separately.
   */
  isIgnored?: (x: number, y: number) => boolean;
}

export interface PixelDiffResult {
  /** Sampled bitmap size (the input size). */
  width: number;
  height: number;
  changedPixels: number;
  ignoredPixels: number;
  /** Pixels actually compared: changed + unchanged, excluding ignored ones. */
  totalPixels: number;
  /** `changedPixels / totalPixels`, rounded to 6 decimals; 0 when empty. */
  ratio: number;
  /** Threshold actually applied (clamped to 0..255). */
  threshold: number;
  /** Sampling stride; greater than 1 when the input exceeded `maxDimension`. */
  step: number;
  /** RGBA overlay at the input resolution: heat for changed, slate for ignored. */
  mask: Uint8ClampedArray;
}

export interface PixelDiffStats {
  changedPixels: number;
  totalPixels: number;
  ratio: number;
}

const validDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const validSize = (size: DiffPageSize | null | undefined): size is DiffPageSize =>
  Boolean(size) && validDimension(size!.width) && validDimension(size!.height);

const clampMaxDimension = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return MAX_PIXEL_BITMAP_DIMENSION;
  }
  return Math.floor(value);
};

const clampThreshold = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PIXEL_THRESHOLD;
  return Math.min(255, Math.max(0, Math.round(value)));
};

/** Clamp the blend opacity into 0..1, falling back to the default. */
export function clampVisualOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VISUAL_OPACITY;
  return Math.min(1, Math.max(0, value));
}

/**
 * Shared bitmap size for a page pair.
 *
 * Both pages are compared in one bitmap, so the bitmap must be big enough for
 * the larger page on each axis and is then scaled down uniformly to respect
 * `maxDimension`. Returns `null` when no usable page size was supplied (the
 * pane then shows its empty state instead of a 0x0 canvas).
 */
export function fitBitmapSize(
  sizes: readonly (DiffPageSize | null | undefined)[],
  options: { maxDimension?: number } = {},
): PixelBitmapSize | null {
  const usable = sizes.filter(validSize);
  if (usable.length === 0) return null;

  const width = Math.max(...usable.map((size) => size.width));
  const height = Math.max(...usable.map((size) => size.height));
  const cap = clampMaxDimension(options.maxDimension);
  const scale = Math.min(1, cap / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Uniformly fit one page inside the shared bitmap and centre it ("contain").
 *
 * A page whose aspect ratio differs from the bitmap's gets letterboxed instead
 * of stretched: stretching would move every object and exaggerate the pixel
 * delta, which is exactly what the visual diff must not do.
 */
export function pageDrawRect(
  size: DiffPageSize | null | undefined,
  bitmap: PixelBitmapSize,
): PixelDrawRect | null {
  if (!validSize(size)) return null;
  if (!validDimension(bitmap.width) || !validDimension(bitmap.height)) return null;

  const scale = Math.min(bitmap.width / size.width, bitmap.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;

  return {
    x: (bitmap.width - width) / 2,
    y: (bitmap.height - height) / 2,
    width,
    height,
  };
}

/**
 * Project one MediaBox-relative region box onto the shared bitmap.
 *
 * `drawRect` is where the owning page is painted (see `pageDrawRect`), so the
 * same region maps onto the old and the new page even when one of them is
 * letterboxed. Returns `null` for unusable geometry, and a zero-area rectangle
 * stays zero-area: an accidental click must not mask a whole strip.
 */
export function regionDrawRect(
  bbox: DiffBBox,
  pageSize: DiffPageSize | null | undefined,
  drawRect: PixelDrawRect | null,
): PixelDrawRect | null {
  if (!bbox || !validSize(pageSize) || !drawRect) return null;
  const values = [bbox.x0, bbox.y0, bbox.x1, bbox.y1];
  if (!values.every((value) => Number.isFinite(value))) return null;

  const scaleX = drawRect.width / pageSize.width;
  const scaleY = drawRect.height / pageSize.height;
  const x0 = drawRect.x + Math.min(bbox.x0, bbox.x1) * scaleX;
  const x1 = drawRect.x + Math.max(bbox.x0, bbox.x1) * scaleX;
  // PDF y grows upwards, the bitmap grows downwards.
  const yTop = drawRect.y + (pageSize.height - Math.max(bbox.y0, bbox.y1)) * scaleY;
  const yBottom = drawRect.y + (pageSize.height - Math.min(bbox.y0, bbox.y1)) * scaleY;

  return { x: x0, y: yTop, width: x1 - x0, height: yBottom - yTop };
}

/** True when the bitmap point is inside the rectangle (top-left inclusive). */
export function drawRectContains(rect: PixelDrawRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Deterministic heat colour: yellow for a small delta, red for the maximum. */const heatColour = (delta: number): readonly [number, number, number, number] => {
  const intensity = Math.min(1, Math.max(0, delta / 255));
  return [
    255,
    Math.round(200 * (1 - intensity)),
    Math.round(90 * (1 - intensity)),
    Math.round(70 + 170 * intensity),
  ];
};

/** Mask colour for a pixel covered by an ignore region. */
const IGNORED_RGBA: readonly [number, number, number, number] = [120, 140, 170, 48];

/**
 * Fill the `step`-sized block a sampled pixel represents, so a downsampled
 * comparison still paints the whole area it stands for.
 */
const paintBlock = (
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  step: number,
  rgba: readonly [number, number, number, number],
): void => {
  const xEnd = Math.min(width, x + step);
  const yEnd = Math.min(height, y + step);

  for (let py = y; py < yEnd; py += 1) {
    let index = (py * width + x) * 4;
    for (let px = x; px < xEnd; px += 1) {
      mask[index] = rgba[0];
      mask[index + 1] = rgba[1];
      mask[index + 2] = rgba[2];
      mask[index + 3] = rgba[3];
      index += 4;
    }
  }
};

/**
 * Compare two equally sized RGBA buffers pixel by pixel.
 *
 * A pixel is changed when the largest per-channel difference (R, G, B) is
 * strictly greater than `threshold`; alpha is ignored because both pages are
 * painted on an opaque white background. Pixels accepted by `isIgnored` are
 * excluded from `totalPixels` and reported separately, so an ignore region
 * shrinks the denominator instead of hiding a change in a fixed total.
 *
 * Throws when the buffers cannot be compared (different dimensions or a
 * truncated buffer): a silent partial comparison would report a misleading
 * ratio. Callers that render both sides themselves always share one bitmap.
 */
export function computePixelDiff(
  oldImage: PixelImageData,
  newImage: PixelImageData,
  options: PixelDiffOptions = {},
): PixelDiffResult {
  const width = Math.trunc(newImage.width);
  const height = Math.trunc(newImage.height);
  if (width !== Math.trunc(oldImage.width) || height !== Math.trunc(oldImage.height)) {
    throw new Error('Pixel diff requires two images of the same size');
  }
  if (!validDimension(width) || !validDimension(height)) {
    throw new Error('Pixel diff requires a non-empty image');
  }

  const expected = width * height * 4;
  if (oldImage.data.length < expected || newImage.data.length < expected) {
    throw new Error('Pixel diff requires RGBA buffers matching the image size');
  }

  const threshold = clampThreshold(options.threshold);
  const step = Math.max(
    1,
    Math.ceil(Math.max(width, height) / clampMaxDimension(options.maxDimension)),
  );
  const isIgnored = options.isIgnored;
  const oldData = oldImage.data;
  const newData = newImage.data;
  const mask = new Uint8ClampedArray(expected);

  let changedPixels = 0;
  let ignoredPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (isIgnored && isIgnored(x, y)) {
        ignoredPixels += 1;
        paintBlock(mask, width, height, x, y, step, IGNORED_RGBA);
        continue;
      }

      totalPixels += 1;
      const index = (y * width + x) * 4;
      const delta = Math.max(
        Math.abs(oldData[index] - newData[index]),
        Math.abs(oldData[index + 1] - newData[index + 1]),
        Math.abs(oldData[index + 2] - newData[index + 2]),
      );
      if (delta > threshold) {
        changedPixels += 1;
        paintBlock(mask, width, height, x, y, step, heatColour(delta));
      }
    }
  }

  const ratio = totalPixels > 0 ? Math.round((changedPixels / totalPixels) * 1e6) / 1e6 : 0;

  return {
    width,
    height,
    changedPixels,
    ignoredPixels,
    totalPixels,
    ratio,
    threshold,
    step,
    mask,
  };
}

/** The numbers the workspace displays; the mask stays with the pane. */
export function pixelDiffStats(result: PixelDiffResult): PixelDiffStats {
  return {
    changedPixels: result.changedPixels,
    totalPixels: result.totalPixels,
    ratio: result.ratio,
  };
}

/** Group digits without depending on the host's locale data. */
const groupDigits = (value: number): string =>
  String(Math.trunc(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `0.02567` -> `2.57%`; tiny non-zero ratios read as `<0.01%`. */
export function formatPixelPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  if (ratio >= 1) return '100%';

  const percent = ratio * 100;
  if (percent < 0.01) return '<0.01%';
  return `${percent.toFixed(2)}%`;
}

/** One-line pixel summary: `1,234 / 484,704 px changed (0.25%)`. */
export function formatPixelDiffStats(
  stats: PixelDiffStats,
  t: TranslateFn = defaultTranslate,
): string {
  return t('diff.visual.pixelStats', {
    changed: groupDigits(stats.changedPixels),
    total: groupDigits(stats.totalPixels),
    percent: formatPixelPercent(stats.ratio),
  });
}
