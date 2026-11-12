import { describe, expect, it } from 'vitest';
import { translate, type TranslateFn } from '../../i18n/translate';
import {
  clampVisualOpacity,
  computePixelDiff,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_VISUAL_OPACITY,
  drawRectContains,
  fitBitmapSize,
  formatPixelDiffStats,
  formatPixelPercent,
  MAX_PIXEL_BITMAP_DIMENSION,
  pageDrawRect,
  pixelDiffStats,
  regionDrawRect,
  VISUAL_DIFF_STYLES,
  type PixelImageData,
} from '../visual-diff';

type Rgba = readonly [number, number, number, number];

const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];

/** RGBA buffer with every pixel set to `rgba` (jsdom has no `ImageData`). */
function makeImage(width: number, height: number, rgba: Rgba = BLACK): PixelImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = rgba[0];
    data[index + 1] = rgba[1];
    data[index + 2] = rgba[2];
    data[index + 3] = rgba[3];
  }
  return { data, width, height };
}

function setPixel(image: PixelImageData, x: number, y: number, rgba: Rgba): void {
  const index = (y * image.width + x) * 4;
  image.data[index] = rgba[0];
  image.data[index + 1] = rgba[1];
  image.data[index + 2] = rgba[2];
  image.data[index + 3] = rgba[3];
}

const alphaAt = (mask: Uint8ClampedArray, width: number, x: number, y: number): number =>
  mask[(y * width + x) * 4 + 3];

describe('fitBitmapSize', () => {
  it('uses the largest page extent so both sides fit', () => {
    expect(fitBitmapSize([{ width: 612, height: 792 }, { width: 612, height: 792 }])).toEqual({
      width: 612,
      height: 792,
    });
    expect(fitBitmapSize([{ width: 400, height: 500 }, { width: 612, height: 792 }])).toEqual({
      width: 612,
      height: 792,
    });
  });

  it('supports a one-sided page', () => {
    expect(fitBitmapSize([{ width: 400, height: 500 }, null])).toEqual({ width: 400, height: 500 });
  });

  it('scales the longest side down to the cap', () => {
    expect(fitBitmapSize([{ width: 2000, height: 3000 }], { maxDimension: 1000 })).toEqual({
      width: 667,
      height: 1000,
    });
    expect(fitBitmapSize([{ width: 3000, height: 4000 }])).toEqual({
      width: 1200,
      height: MAX_PIXEL_BITMAP_DIMENSION,
    });
  });

  it('returns null without a usable page size', () => {
    expect(fitBitmapSize([])).toBeNull();
    expect(fitBitmapSize([null, undefined])).toBeNull();
    expect(
      fitBitmapSize([
        { width: 0, height: 10 },
        { width: Number.NaN, height: 10 },
      ]),
    ).toBeNull();
  });
});

describe('pageDrawRect', () => {
  it('fills the bitmap when the aspect ratios match', () => {
    expect(pageDrawRect({ width: 612, height: 792 }, { width: 612, height: 792 })).toEqual({
      x: 0,
      y: 0,
      width: 612,
      height: 792,
    });
  });

  it('letterboxes a square page inside a tall bitmap without stretching', () => {
    expect(pageDrawRect({ width: 1000, height: 1000 }, { width: 400, height: 800 })).toEqual({
      x: 0,
      y: 200,
      width: 400,
      height: 400,
    });
  });

  it('centres a tall page inside a wide bitmap', () => {
    expect(pageDrawRect({ width: 400, height: 800 }, { width: 800, height: 400 })).toEqual({
      x: 300,
      y: 0,
      width: 200,
      height: 400,
    });
  });

  it('rejects unusable geometry', () => {
    expect(pageDrawRect(null, { width: 400, height: 400 })).toBeNull();
    expect(pageDrawRect({ width: 0, height: 400 }, { width: 400, height: 400 })).toBeNull();
    expect(pageDrawRect({ width: 400, height: 400 }, { width: 0, height: 400 })).toBeNull();
  });
});

describe('regionDrawRect', () => {
  const page = { width: 612, height: 792 };
  const rect = pageDrawRect(page, { width: 612, height: 792 });

  it('flips the y axis and maps the region onto the page draw rect', () => {
    expect(
      regionDrawRect({ x0: 0, y0: 692, x1: 100, y1: 792 }, page, rect),
    ).toEqual({ x: 0, y: 0, width: 100, height: 100 });

    expect(
      regionDrawRect({ x0: 100, y0: 642, x1: 200, y1: 692 }, page, rect),
    ).toEqual({ x: 100, y: 100, width: 100, height: 50 });
  });

  it('follows a letterboxed page instead of the whole bitmap', () => {
    const letterboxed = pageDrawRect({ width: 400, height: 400 }, { width: 400, height: 800 });

    expect(
      regionDrawRect({ x0: 0, y0: 300, x1: 100, y1: 400 }, { width: 400, height: 400 }, letterboxed),
    ).toEqual({ x: 0, y: 200, width: 100, height: 100 });
  });

  it('orders a reversed box and rejects unusable input', () => {
    expect(
      regionDrawRect({ x0: 200, y0: 692, x1: 100, y1: 792 }, page, rect),
    ).toEqual({ x: 100, y: 0, width: 100, height: 100 });

    expect(regionDrawRect({ x0: 0, y0: 0, x1: Number.NaN, y1: 1 }, page, rect)).toBeNull();
    expect(regionDrawRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, null, rect)).toBeNull();
    expect(regionDrawRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, page, null)).toBeNull();
  });

  it('contains points top-left inclusive, bottom-right exclusive', () => {
    const area = { x: 10, y: 20, width: 30, height: 40 };

    expect(drawRectContains(area, 10, 20)).toBe(true);
    expect(drawRectContains(area, 39, 59)).toBe(true);
    expect(drawRectContains(area, 40, 30)).toBe(false);
    expect(drawRectContains(area, 20, 60)).toBe(false);
  });
});

describe('computePixelDiff', () => {
  it('reports no change for identical pages', () => {
    const result = computePixelDiff(makeImage(4, 4), makeImage(4, 4));

    expect(result.changedPixels).toBe(0);
    expect(result.totalPixels).toBe(16);
    expect(result.ratio).toBe(0);
    expect(result.threshold).toBe(DEFAULT_PIXEL_THRESHOLD);
    expect(result.step).toBe(1);
    // An unchanged page paints nothing.
    expect([...result.mask].every((value) => value === 0)).toBe(true);
  });

  it('counts a pixel changed only when the delta exceeds the threshold', () => {
    const atThreshold = makeImage(1, 1);
    setPixel(atThreshold, 0, 0, [DEFAULT_PIXEL_THRESHOLD, 0, 0, 255]);
    expect(computePixelDiff(makeImage(1, 1), atThreshold).changedPixels).toBe(0);

    const overThreshold = makeImage(1, 1);
    setPixel(overThreshold, 0, 0, [DEFAULT_PIXEL_THRESHOLD + 1, 0, 0, 255]);
    const result = computePixelDiff(makeImage(1, 1), overThreshold);
    expect(result.changedPixels).toBe(1);
    expect(result.ratio).toBe(1);
    expect(alphaAt(result.mask, 1, 0, 0)).toBeGreaterThan(0);
  });

  it('honours a custom threshold', () => {
    const image = makeImage(1, 1);
    setPixel(image, 0, 0, [40, 0, 0, 255]);

    expect(computePixelDiff(makeImage(1, 1), image, { threshold: 10 }).changedPixels).toBe(1);
    expect(computePixelDiff(makeImage(1, 1), image, { threshold: 200 }).changedPixels).toBe(0);
  });

  it('uses the largest per-channel delta and ignores alpha', () => {
    const blueOnly = makeImage(1, 1);
    setPixel(blueOnly, 0, 0, [0, 0, 200, 255]);
    expect(computePixelDiff(makeImage(1, 1), blueOnly).changedPixels).toBe(1);

    const alphaOnly = makeImage(1, 1);
    setPixel(alphaOnly, 0, 0, [0, 0, 0, 10]);
    expect(computePixelDiff(makeImage(1, 1), alphaOnly).changedPixels).toBe(0);
  });

  it('computes the ratio over the compared pixels', () => {
    const changed = makeImage(2, 2, WHITE);
    const result = computePixelDiff(makeImage(2, 2, BLACK), changed);

    expect(result.changedPixels).toBe(4);
    expect(result.totalPixels).toBe(4);
    expect(result.ratio).toBe(1);

    setPixel(changed, 0, 0, BLACK);
    const threeOfFour = computePixelDiff(makeImage(2, 2, BLACK), changed);
    expect(threeOfFour.changedPixels).toBe(3);
    expect(threeOfFour.ratio).toBe(0.75);
  });

  it('excludes ignored pixels from the ratio and marks them in the mask', () => {
    const result = computePixelDiff(makeImage(2, 2, BLACK), makeImage(2, 2, WHITE), {
      isIgnored: (x) => x === 0,
    });

    expect(result.ignoredPixels).toBe(2);
    expect(result.totalPixels).toBe(2);
    expect(result.changedPixels).toBe(2);
    expect(result.ratio).toBe(1);
    // Masked pixels get the muted ignore colour, not heat.
    expect(alphaAt(result.mask, 2, 0, 0)).toBe(48);
    expect(alphaAt(result.mask, 2, 0, 1)).toBe(48);
    expect(alphaAt(result.mask, 2, 1, 0)).toBeGreaterThan(48);
  });

  it('samples oversized images instead of growing the bitmap', () => {
    const result = computePixelDiff(makeImage(8, 8, BLACK), makeImage(8, 8, WHITE), {
      maxDimension: 2,
    });

    expect(result.step).toBe(4);
    expect(result.totalPixels).toBe(4);
    expect(result.changedPixels).toBe(4);
    expect(result.ratio).toBe(1);
    // A sampled pixel paints its whole block, so the mask covers the bitmap.
    expect(alphaAt(result.mask, 8, 7, 7)).toBeGreaterThan(0);
  });

  it('clamps a nonsensical threshold into 0..255', () => {
    const image = makeImage(1, 1, WHITE);
    expect(computePixelDiff(makeImage(1, 1, BLACK), image, { threshold: 1000 }).threshold).toBe(255);
    expect(computePixelDiff(makeImage(1, 1, BLACK), image, { threshold: 1000 }).changedPixels).toBe(
      0,
    );
    expect(computePixelDiff(makeImage(1, 1, BLACK), image, { threshold: -10 }).threshold).toBe(0);
    expect(
      computePixelDiff(makeImage(1, 1, BLACK), image, { threshold: Number.NaN }).threshold,
    ).toBe(DEFAULT_PIXEL_THRESHOLD);
  });

  it('is deterministic for the same inputs', () => {
    const first = computePixelDiff(makeImage(3, 3, BLACK), makeImage(3, 3, WHITE));
    const second = computePixelDiff(makeImage(3, 3, BLACK), makeImage(3, 3, WHITE));

    expect(first.changedPixels).toBe(second.changedPixels);
    expect([...first.mask]).toEqual([...second.mask]);
  });

  it('rejects images that cannot be compared', () => {
    expect(() => computePixelDiff(makeImage(2, 2), makeImage(3, 2))).toThrow(/same size/);
    expect(() => computePixelDiff(makeImage(0, 0), makeImage(0, 0))).toThrow(/non-empty/);

    const truncated = { data: new Uint8ClampedArray(4), width: 2, height: 2 };
    expect(() => computePixelDiff(makeImage(2, 2), truncated)).toThrow(/RGBA/);
  });
});

describe('pixel stats formatting', () => {
  it('projects the numbers the workspace shows', () => {
    const result = computePixelDiff(makeImage(2, 2, BLACK), makeImage(2, 2, WHITE));

    expect(pixelDiffStats(result)).toEqual({
      changedPixels: 4,
      totalPixels: 4,
      ratio: 1,
    });
  });

  it('formats small and empty ratios', () => {
    expect(formatPixelPercent(0)).toBe('0%');
    expect(formatPixelPercent(Number.NaN)).toBe('0%');
    expect(formatPixelPercent(0.00001)).toBe('<0.01%');
    expect(formatPixelPercent(0.02567)).toBe('2.57%');
    expect(formatPixelPercent(0.5)).toBe('50.00%');
    expect(formatPixelPercent(1)).toBe('100%');
  });

  it('formats a readable one-line summary', () => {
    expect(
      formatPixelDiffStats({ changedPixels: 1234, totalPixels: 484704, ratio: 0.002545 }),
    ).toBe('1,234 / 484,704 px changed (0.25%)');
    expect(formatPixelDiffStats({ changedPixels: 0, totalPixels: 0, ratio: 0 })).toBe(
      '0 / 0 px changed (0%)',
    );
  });

  it('formats the summary through a supplied translator', () => {
    const tZh: TranslateFn = (key, params) => translate('zh-CN', key, params);
    expect(
      formatPixelDiffStats({ changedPixels: 1234, totalPixels: 484704, ratio: 0.002545 }, tZh),
    ).toBe('1,234 / 484,704 px 像素变更（0.25%）');
  });

  it('clamps the blend opacity and exposes the defaults', () => {
    expect(clampVisualOpacity(0.3)).toBe(0.3);
    expect(clampVisualOpacity(-1)).toBe(0);
    expect(clampVisualOpacity(4)).toBe(1);
    expect(clampVisualOpacity(Number.NaN)).toBe(DEFAULT_VISUAL_OPACITY);

    expect(DEFAULT_VISUAL_OPACITY).toBe(0.55);
    expect(DEFAULT_PIXEL_THRESHOLD).toBe(24);
    expect(VISUAL_DIFF_STYLES).toEqual(['blend', 'heatmap', 'boxes']);
  });
});
