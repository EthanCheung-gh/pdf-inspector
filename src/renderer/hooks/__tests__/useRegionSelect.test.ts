import { describe, expect, it } from 'vitest';
import { screenToPdf, computeRegionBBox } from '../useRegionSelect';

describe('screenToPdf', () => {
  it('flips the y axis and scales to PDF coordinates', () => {
    expect(screenToPdf(50, 50, 100, 100, 200, 300)).toEqual({ x: 100, y: 150 });
  });
});

describe('computeRegionBBox', () => {
  it('normalizes drag start/end into min/max bounds', () => {
    expect(computeRegionBBox({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
  });
});
