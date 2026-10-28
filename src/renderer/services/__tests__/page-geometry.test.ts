import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HORIZONTAL_PADDING,
  MAX_FIT_WIDTH_ZOOM,
  MIN_FIT_WIDTH_ZOOM,
  computeFitWidthZoom,
} from '../page-geometry';

describe('computeFitWidthZoom', () => {
  it('fits a Letter page into a typical container', () => {
    // (900 - 48) / 612
    expect(computeFitWidthZoom(612, 900)).toBeCloseTo(852 / 612, 10);
  });

  it('uses the container width given, not a window guess', () => {
    expect(computeFitWidthZoom(612, 660)).toBeCloseTo(1, 10);
    expect(computeFitWidthZoom(612, 1000)).toBeGreaterThan(computeFitWidthZoom(612, 800));
  });

  it('defaults to 48px of horizontal padding', () => {
    expect(DEFAULT_HORIZONTAL_PADDING).toBe(48);
    expect(computeFitWidthZoom(612, 660)).toBe(computeFitWidthZoom(612, 660, 48));
  });

  it('subtracts a custom padding (24px each side)', () => {
    expect(computeFitWidthZoom(600, 648, 48)).toBeCloseTo(1, 10);
    expect(computeFitWidthZoom(600, 648, 24)).toBeCloseTo(624 / 600, 10);
    expect(computeFitWidthZoom(600, 648, 0)).toBeCloseTo(648 / 600, 10);
  });

  it('treats negative or NaN padding as no padding', () => {
    expect(computeFitWidthZoom(600, 600, -100)).toBeCloseTo(1, 10);
    expect(computeFitWidthZoom(600, 600, Number.NaN)).toBeCloseTo(1, 10);
  });

  it('keeps the 200px minimum available width for a too-small container', () => {
    // Container smaller than the padding: available width floors at 200px.
    expect(computeFitWidthZoom(400, 10)).toBeCloseTo(200 / 400, 10);
    expect(computeFitWidthZoom(400, 0)).toBeCloseTo(200 / 400, 10);
    expect(computeFitWidthZoom(400, -50)).toBeCloseTo(200 / 400, 10);
  });

  it('clamps to the minimum zoom for very wide pages or tiny containers', () => {
    expect(computeFitWidthZoom(2000, 0)).toBe(MIN_FIT_WIDTH_ZOOM);
    expect(computeFitWidthZoom(5000, 900)).toBe(MIN_FIT_WIDTH_ZOOM);
    expect(MIN_FIT_WIDTH_ZOOM).toBe(0.25);
  });

  it('clamps to the maximum zoom for narrow pages or huge containers', () => {
    expect(computeFitWidthZoom(100, 5000)).toBe(MAX_FIT_WIDTH_ZOOM);
    expect(computeFitWidthZoom(612, 100000)).toBe(MAX_FIT_WIDTH_ZOOM);
    expect(MAX_FIT_WIDTH_ZOOM).toBe(5);
  });

  it('guards invalid page widths', () => {
    for (const bad of [0, -612, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(computeFitWidthZoom(bad, 900)).toBe(MIN_FIT_WIDTH_ZOOM);
    }
  });

  it('guards invalid container widths', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(computeFitWidthZoom(612, bad)).toBe(MIN_FIT_WIDTH_ZOOM);
    }
    // A zero width (not measured yet) still goes through the 200px floor.
    expect(computeFitWidthZoom(612, 0)).toBeCloseTo(200 / 612, 10);
  });

  it('never returns NaN or a value outside the supported range', () => {
    const widths = [0, 1, 100, 612, 842, 2000, Number.NaN];
    const containers = [0, 1, 200, 660, 1920, Number.NaN];
    for (const pageWidth of widths) {
      for (const container of containers) {
        const zoom = computeFitWidthZoom(pageWidth, container);
        expect(Number.isFinite(zoom)).toBe(true);
        expect(zoom).toBeGreaterThanOrEqual(MIN_FIT_WIDTH_ZOOM);
        expect(zoom).toBeLessThanOrEqual(MAX_FIT_WIDTH_ZOOM);
      }
    }
  });
});
