// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OVERLAY_COLORS } from '../../services/overlay-style';
import type { ObjectSubset } from '../../services/object-filter';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfObject } from '../../types/pdf-objects';
import { useOverlay } from '../useOverlay';

interface DrawCall {
  op: string;
  args: number[];
  alpha: number;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

const REGION_STROKE = 'rgba(80, 160, 255, 0.9)';
const SUBSET_HIGHLIGHT = 'rgba(255, 140, 0, 1)';

/**
 * Minimal 2D context double. Every call snapshots the canvas state at the
 * moment it happens, which is what the opacity-isolation assertions need: the
 * overlay dims object boxes, and the region passes must not inherit that alpha.
 */
const createFakeContext = () => {
  const calls: DrawCall[] = [];
  const record =
    (op: string) =>
    (...args: number[]): void => {
      calls.push({
        op,
        args,
        alpha: ctx.globalAlpha,
        strokeStyle: ctx.strokeStyle,
        fillStyle: ctx.fillStyle,
        lineWidth: ctx.lineWidth,
      });
    };
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    calls,
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
  };
  return ctx;
};

const charObject = {
  type: 'char',
  x0: 10,
  y0: 20,
  x1: 30,
  y1: 40,
  page: 1,
  text: 'A',
  fontname: 'Helvetica',
  size: 12,
  color: '#000000',
} as unknown as PdfObject;

const lineObject = {
  type: 'line',
  x0: 0,
  y0: 0,
  x1: 100,
  y1: 100,
  page: 1,
  stroke: true,
  color: '#000000',
  width: 1,
} as unknown as PdfObject;

const curveObject = {
  type: 'curve',
  x0: 0,
  y0: 0,
  x1: 60,
  y1: 60,
  page: 1,
  stroke: true,
  points: [
    [0, 0],
    [10, 10],
    [20, 5],
  ],
} as unknown as PdfObject;

const allVisible = { char: true, word: true, rect: true, line: true, curve: true, image: true, table: true };

const draw = (
  ctx: ReturnType<typeof createFakeContext>,
  options: { subset?: ObjectSubset | null; regionRect?: { x0: number; y0: number; x1: number; y1: number } | null } = {},
) => {
  const { result } = renderHook(() => useOverlay());
  result.current.drawOverlays(
    ctx as unknown as CanvasRenderingContext2D,
    [charObject, lineObject, curveObject],
    allVisible,
    600,
    800,
    600,
    800,
    options.subset ?? null,
    options.regionRect ?? null,
  );
};

const withStyle = (calls: DrawCall[], style: string): DrawCall[] =>
  calls.filter((call) => call.strokeStyle === style);

describe('useOverlay', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ overlayOpacity: 0.35 });
  });

  afterEach(() => {
    useWorkspaceStore.setState({ overlayOpacity: 1 });
  });

  it('strokes object boxes at the configured opacity, then draws region passes at full alpha', () => {
    const ctx = createFakeContext();
    const subset: ObjectSubset = {
      source: 'region',
      mode: 'intersect',
      objects: [charObject, lineObject],
    };

    draw(ctx, { regionRect: { x0: 5, y0: 5, x1: 50, y1: 50 }, subset });

    // Object boxes (rect-ish char, line and curve) all carry the layer opacity.
    const boxStrokes = withStyle(ctx.calls, OVERLAY_COLORS.char).filter((call) => call.op === 'strokeRect');
    expect(boxStrokes).toHaveLength(1);
    expect(boxStrokes[0].alpha).toBeCloseTo(0.35);

    const lineStrokes = withStyle(ctx.calls, OVERLAY_COLORS.line).filter((call) => call.op === 'stroke');
    expect(lineStrokes).toHaveLength(1);
    expect(lineStrokes[0].alpha).toBeCloseTo(0.35);

    const curveStrokes = withStyle(ctx.calls, OVERLAY_COLORS.curve).filter((call) => call.op === 'stroke');
    expect(curveStrokes).toHaveLength(1);
    expect(curveStrokes[0].alpha).toBeCloseTo(0.35);
    expect(withStyle(ctx.calls, OVERLAY_COLORS.curve).filter((call) => call.op === 'moveTo' || call.op === 'lineTo')).toHaveLength(3);

    // Region rectangle fill + stroke are drawn at globalAlpha 1.
    const regionCalls = ctx.calls.filter(
      (call) => call.op === 'fillRect' || (call.op === 'strokeRect' && call.strokeStyle === REGION_STROKE),
    );
    expect(regionCalls).toHaveLength(2);
    expect(regionCalls.map((call) => call.op)).toEqual(['fillRect', 'strokeRect']);
    for (const call of regionCalls) expect(call.alpha).toBe(1);

    // Region-subset highlight (box + line member) also runs at globalAlpha 1.
    const highlightCalls = withStyle(ctx.calls, SUBSET_HIGHLIGHT);
    expect(highlightCalls.filter((call) => call.op === 'strokeRect')).toHaveLength(1);
    expect(highlightCalls.filter((call) => call.op === 'stroke')).toHaveLength(1);
    expect(highlightCalls.length).toBeGreaterThan(0);
    for (const call of highlightCalls) {
      expect(call.alpha).toBe(1);
      expect(call.lineWidth).toBe(2);
    }

    // Nothing leaks into the next canvas consumer.
    expect(ctx.globalAlpha).toBe(1);
  });

  it('clears the canvas before drawing and leaves the alpha untouched without a region', () => {
    const ctx = createFakeContext();

    draw(ctx);

    expect(ctx.calls[0].op).toBe('clearRect');
    expect(ctx.calls[0].args).toEqual([0, 0, 600, 800]);
    expect(ctx.calls[0].alpha).toBe(1);

    const boxStrokes = ctx.calls.filter((call) => call.op === 'strokeRect');
    expect(boxStrokes).toHaveLength(1);
    expect(boxStrokes[0].alpha).toBeCloseTo(0.35);

    expect(ctx.calls.some((call) => call.op === 'fillRect')).toBe(false);
    expect(withStyle(ctx.calls, SUBSET_HIGHLIGHT)).toHaveLength(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('tracks the configured opacity and skips hidden object types', () => {
    useWorkspaceStore.setState({ overlayOpacity: 0.15 });
    const ctx = createFakeContext();
    const { result } = renderHook(() => useOverlay());

    result.current.drawOverlays(
      ctx as unknown as CanvasRenderingContext2D,
      [charObject, lineObject],
      { ...allVisible, line: false },
      600,
      800,
      600,
      800,
    );

    const boxStrokes = withStyle(ctx.calls, OVERLAY_COLORS.char).filter((call) => call.op === 'strokeRect');
    expect(boxStrokes).toHaveLength(1);
    expect(boxStrokes[0].alpha).toBeCloseTo(0.15);
    expect(withStyle(ctx.calls, OVERLAY_COLORS.line)).toHaveLength(0);
  });
});
