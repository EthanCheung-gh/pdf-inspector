// @vitest-environment jsdom
import type React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRegionBBox, screenToPdf, useRegionSelect } from '../useRegionSelect';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfRect } from '../../types/pdf-objects';

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

const rect = (x0: number, y0: number, x1: number, y1: number): PdfRect => ({
  type: 'rect',
  page: 1,
  x0,
  y0,
  x1,
  y1,
  fill: true,
  stroke: false,
  color: '#000000',
  width: 1,
});

// The drag below covers PDF x 10–90 and, because screen y is flipped, PDF
// y 110–190. `inside` sits fully in that region, `outside` does not.
const objects: PdfRect[] = [rect(20, 120, 80, 180), rect(150, 20, 190, 80)];

const PAGE_SIZE = 200;

/** A canvas whose client rect starts at the origin, so clientX/Y are page offsets. */
const createCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: PAGE_SIZE,
      bottom: PAGE_SIZE,
      width: PAGE_SIZE,
      height: PAGE_SIZE,
      toJSON: () => ({}),
    }) as DOMRect;
  return canvas;
};

const canvasEvent = (
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): React.MouseEvent<HTMLCanvasElement> =>
  ({ clientX, clientY, currentTarget: canvas }) as unknown as React.MouseEvent<HTMLCanvasElement>;

describe('useRegionSelect', () => {
  afterEach(cleanup);

  beforeEach(() => {
    usePdfStore.setState({
      regionMode: true,
      allObjects: objects,
      subset: null,
      hoveredObject: null,
      selectedObject: null,
    });
    useWorkspaceStore.setState({ inspectorTab: 'inspect', rightCollapsed: false });
  });

  it('opens the Results tab after a completed region drag', () => {
    const canvas = createCanvas();
    const { result } = renderHook(() =>
      useRegionSelect(PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE),
    );

    act(() => {
      result.current.handlers.onMouseDown(canvasEvent(canvas, 10, 10));
    });
    expect(result.current.dragging).toBe(true);

    act(() => {
      result.current.handlers.onMouseMove(canvasEvent(canvas, 90, 90));
    });
    expect(result.current.liveRect).not.toBeNull();

    // 80px on both axes: well past the 4px min-drag threshold.
    act(() => {
      result.current.handlers.onMouseUp(canvasEvent(canvas, 90, 90));
    });

    expect(result.current.wasDragRef.current).toBe(true);
    expect(result.current.dragging).toBe(false);
    expect(result.current.liveRect).toBeNull();

    const subset = usePdfStore.getState().subset;
    expect(subset?.source).toBe('region');
    expect(subset?.objects).toEqual([objects[0]]);
    expect(subset?.bbox).toEqual({ x0: 10, y0: 110, x1: 90, y1: 190 });

    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
  });

  it('leaves the current tab alone when the drag stays under the threshold', () => {
    useWorkspaceStore.setState({ inspectorTab: 'filter' });
    const canvas = createCanvas();
    const { result } = renderHook(() =>
      useRegionSelect(PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE),
    );

    act(() => {
      result.current.handlers.onMouseDown(canvasEvent(canvas, 50, 50));
    });
    act(() => {
      result.current.handlers.onMouseUp(canvasEvent(canvas, 53, 52));
    });

    // Still treated as a click, so the canvas click handler keeps its normal
    // selection behavior and no region subset is produced.
    expect(result.current.wasDragRef.current).toBe(false);
    expect(usePdfStore.getState().subset).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('filter');
  });

  it('ignores drags while region mode is off', () => {
    usePdfStore.setState({ regionMode: false });
    const canvas = createCanvas();
    const { result } = renderHook(() =>
      useRegionSelect(PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE),
    );

    act(() => {
      result.current.handlers.onMouseDown(canvasEvent(canvas, 10, 10));
      result.current.handlers.onMouseUp(canvasEvent(canvas, 90, 90));
    });

    expect(result.current.dragging).toBe(false);
    expect(usePdfStore.getState().subset).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
  });
});
