// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PageBoxes, PageRotation } from '../../types/pdf-objects';
import {
  PAGE_BOX_STYLES,
  drawPageBoxes,
  pageBoxToViewportRect,
  type PageBoxCanvas,
  type PagePointMapper,
} from './PageGeometryOverlay';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * A `PageViewport`-shaped mapper using the same rotation matrices PDF.js
 * builds for a [0, 0, 612, 792] viewBox at scale 1.
 */
const createViewport = (rotation: PageRotation): PagePointMapper => {
  const convert = (x: number, y: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [y, x];
      case 180:
        return [PAGE_WIDTH - x, y];
      case 270:
        return [PAGE_HEIGHT - y, PAGE_WIDTH - x];
      case 0:
      default:
        return [x, PAGE_HEIGHT - y];
    }
  };

  const rotated = rotation === 90 || rotation === 270;
  return {
    width: rotated ? PAGE_HEIGHT : PAGE_WIDTH,
    height: rotated ? PAGE_WIDTH : PAGE_HEIGHT,
    convertToViewportPoint: (x, y) => convert(x, y),
  };
};

const createContext = () => {
  const calls: { type: 'clearRect' | 'strokeRect'; args: number[] }[] = [];
  const styles: string[] = [];
  const dashes: number[][] = [];

  const context = {
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 0,
    globalAlpha: 1,
    clearRect: (x: number, y: number, width: number, height: number) => {
      calls.push({ type: 'clearRect', args: [x, y, width, height] });
    },
    strokeRect: (x: number, y: number, width: number, height: number) => {
      calls.push({ type: 'strokeRect', args: [x, y, width, height] });
      styles.push(String(context.strokeStyle));
    },
    setLineDash: (segments: number[]) => {
      dashes.push(segments);
    },
  };

  return { context: context as PageBoxCanvas, calls, styles, dashes };
};

const boxes: PageBoxes = {
  media: { x0: 0, y0: 0, x1: PAGE_WIDTH, y1: PAGE_HEIGHT },
  crop: { x0: 10, y0: 20, x1: 110, y1: 120 },
  trim: null,
  bleed: { x0: 20, y0: 30, x1: 90, y1: 100 },
  art: null,
};

const visibility = {
  media: true,
  crop: true,
  trim: true,
  bleed: false,
  art: false,
};

describe('pageBoxToViewportRect', () => {
  it('flips the y axis for an unrotated page', () => {
    const rect = pageBoxToViewportRect(createViewport(0), boxes.crop!);
    expect(rect).toEqual({ x: 10, y: PAGE_HEIGHT - 120, width: 100, height: 100 });
  });

  it('maps a 90-degree rotation through the viewport matrix', () => {
    const rect = pageBoxToViewportRect(createViewport(90), boxes.crop!);
    expect(rect).toEqual({ x: 20, y: 10, width: 100, height: 100 });
  });

  it('maps a 180-degree rotation through the viewport matrix', () => {
    const rect = pageBoxToViewportRect(createViewport(180), boxes.crop!);
    expect(rect).toEqual({ x: PAGE_WIDTH - 110, y: 20, width: 100, height: 100 });
  });

  it('maps a 270-degree rotation through the viewport matrix', () => {
    const rect = pageBoxToViewportRect(createViewport(270), boxes.crop!);
    expect(rect).toEqual({
      x: PAGE_HEIGHT - 120,
      y: PAGE_WIDTH - 110,
      width: 100,
      height: 100,
    });
  });
});

describe('drawPageBoxes', () => {
  it('clears the viewport and draws only visible, defined boxes', () => {
    const { context, calls, styles, dashes } = createContext();
    const viewport = createViewport(0);

    drawPageBoxes(context, viewport, boxes, visibility);

    expect(calls[0]).toEqual({
      type: 'clearRect',
      args: [0, 0, viewport.width, viewport.height],
    });

    const drawn = calls.filter((call) => call.type === 'strokeRect');
    // media + crop; trim/art are null and bleed is unchecked.
    expect(drawn).toHaveLength(2);
    expect(drawn[0].args).toEqual([0, 0, PAGE_WIDTH, PAGE_HEIGHT]);
    expect(drawn[1].args).toEqual([10, PAGE_HEIGHT - 120, 100, 100]);
    expect(styles).toEqual([PAGE_BOX_STYLES.media.color, PAGE_BOX_STYLES.crop.color]);
    // The final `[]` resets the dash pattern for the next draw pass.
    expect(dashes.slice(0, 2)).toEqual([PAGE_BOX_STYLES.media.dash, PAGE_BOX_STYLES.crop.dash]);
  });

  it('draws nothing when every box is unchecked', () => {
    const { context, calls } = createContext();

    drawPageBoxes(context, createViewport(0), boxes, {
      media: false,
      crop: false,
      trim: false,
      bleed: false,
      art: false,
    });

    expect(calls.filter((call) => call.type === 'strokeRect')).toHaveLength(0);
  });

  it('handles missing page boxes without throwing', () => {
    const { context, calls } = createContext();

    drawPageBoxes(context, createViewport(0), null, visibility);

    expect(calls).toEqual([{ type: 'clearRect', args: [0, 0, PAGE_WIDTH, PAGE_HEIGHT] }]);
  });
});
