// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANNOTATION_COLORS,
  ANNOTATION_HOVER_STROKE_ALPHA,
  ANNOTATION_SELECTED_COLOR,
  ANNOTATION_STROKE_ALPHA,
  withAlpha,
} from '../../services/annotation-view';
import { useAnnotationStore } from '../../store/annotation-store';
import type { PdfAnnotation } from '../../types/annotations';
import { AnnotationOverlay } from './AnnotationOverlay';

interface DrawCall {
  op: string;
  args: number[];
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

/** Minimal 2D context double that snapshots the style per call. */
const createFakeContext = () => {
  const calls: DrawCall[] = [];
  const record =
    (op: string) =>
    (...args: number[]): void => {
      calls.push({
        op,
        args,
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
    font: '',
    calls,
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    scale: record('scale'),
  };
  return ctx;
};

const BOX = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'a1',
  page: 1,
  subtype: 'Link',
  kind: 'link',
  rect: BOX(100, 100, 200, 150),
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
  ...overrides,
});

const strokes = (calls: DrawCall[], style: string): DrawCall[] =>
  calls.filter((call) => call.op === 'strokeRect' && call.strokeStyle === style);

describe('AnnotationOverlay', () => {
  let contexts: Map<HTMLCanvasElement, ReturnType<typeof createFakeContext>>;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  const overlayContext = (): ReturnType<typeof createFakeContext> => {
    const canvas = screen.getByTestId('annotation-overlay') as HTMLCanvasElement;
    const ctx = contexts.get(canvas);
    if (!ctx) throw new Error('annotation overlay has no context');
    return ctx;
  };

  beforeEach(() => {
    contexts = new Map();
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    // jsdom has no 2D backend: hand every canvas its own recording context.
    const fakeGetContext = function (this: HTMLCanvasElement): CanvasRenderingContext2D {
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = createFakeContext();
        contexts.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    };
    HTMLCanvasElement.prototype.getContext =
      fakeGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;

    useAnnotationStore.getState().clear();
    useAnnotationStore.setState({ kindFilter: 'all', subtypeFilter: 'all', showBoxes: true });
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  const renderOverlay = (pageNum = 1): void => {
    render(
      React.createElement(AnnotationOverlay, {
        pageNum,
        pageWidth: 612,
        pageHeight: 792,
        pdfWidth: 612,
        pdfHeight: 792,
      }),
    );
  };

  it('is a transparent, non-interactive layer', () => {
    renderOverlay();

    const canvas = screen.getByTestId('annotation-overlay') as HTMLCanvasElement;
    expect(canvas.style.pointerEvents).toBe('none');
    expect(canvas.style.position).toBe('absolute');
    expect(canvas.style.width).toBe('612px');
    expect(canvas.style.height).toBe('792px');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a box per annotation kind in the kind color', () => {
    useAnnotationStore.getState().setPageData(1, [
      annotation({ id: 'link', kind: 'link', rect: BOX(10, 10, 110, 40) }),
      annotation({ id: 'form', kind: 'form', subtype: 'Widget', rect: BOX(10, 50, 110, 80) }),
      annotation({ id: 'markup', kind: 'markup', subtype: 'Highlight', rect: BOX(10, 90, 110, 120) }),
    ]);

    renderOverlay();

    const ctx = overlayContext();
    // Device pixel ratio scaling happens before the (CSS pixel) page clear.
    expect(ctx.calls[0].op).toBe('scale');
    expect(ctx.calls[1].op).toBe('clearRect');
    expect(ctx.calls[1].args).toEqual([0, 0, 612, 792]);
    expect(strokes(ctx.calls, withAlpha(ANNOTATION_COLORS.link, ANNOTATION_STROKE_ALPHA))).toHaveLength(1);
    expect(strokes(ctx.calls, withAlpha(ANNOTATION_COLORS.form, ANNOTATION_STROKE_ALPHA))).toHaveLength(1);
    expect(strokes(ctx.calls, withAlpha(ANNOTATION_COLORS.markup, ANNOTATION_STROKE_ALPHA))).toHaveLength(1);

    // Page mapping: x0=10, y1=40 on a 792pt page → top = 792 - 40.
    expect(strokes(ctx.calls, withAlpha(ANNOTATION_COLORS.link, ANNOTATION_STROKE_ALPHA))[0].args).toEqual([
      10, 752, 100, 30,
    ]);
  });

  it('skips hidden annotations and unusable rects', () => {
    useAnnotationStore.getState().setPageData(1, [
      annotation({ id: 'hidden', hidden: true }),
      annotation({ id: 'no-rect', rect: null }),
      annotation({ id: 'degenerate', rect: BOX(50, 50, 50, 80) }),
      annotation({ id: 'visible', rect: BOX(200, 200, 300, 240) }),
    ]);

    renderOverlay();

    expect(overlayContext().calls.filter((call) => call.op === 'strokeRect')).toHaveLength(1);
  });

  it('outlines the selected annotation in gold and brightens the hovered one', () => {
    const selected = annotation({ id: 'selected', rect: BOX(10, 10, 60, 40) });
    const hovered = annotation({ id: 'hovered', kind: 'markup', rect: BOX(100, 10, 200, 40) });
    useAnnotationStore.getState().setPageData(1, [selected, hovered]);
    useAnnotationStore.getState().setSelected(selected);
    useAnnotationStore.getState().setHovered(hovered);

    renderOverlay();

    const ctx = overlayContext();
    expect(strokes(ctx.calls, ANNOTATION_SELECTED_COLOR)).toHaveLength(1);
    expect(
      strokes(ctx.calls, withAlpha(ANNOTATION_COLORS.markup, ANNOTATION_HOVER_STROKE_ALPHA)),
    ).toHaveLength(1);
  });

  it('draws nothing for another page, other than clearing the canvas', () => {
    useAnnotationStore.getState().setPageData(1, [annotation({ id: 'stale' })]);

    renderOverlay(2);

    const calls = overlayContext().calls;
    expect(calls.filter((call) => call.op === 'strokeRect')).toHaveLength(0);
    expect(calls.some((call) => call.op === 'clearRect')).toBe(true);
  });

  it('draws nothing while Show boxes is off', () => {
    useAnnotationStore.getState().setPageData(1, [annotation()]);
    useAnnotationStore.getState().setShowBoxes(false);

    renderOverlay();

    const calls = overlayContext().calls;
    expect(calls.filter((call) => call.op === 'strokeRect')).toHaveLength(0);
    expect(calls.filter((call) => call.op === 'fillRect')).toHaveLength(0);
    expect(calls.some((call) => call.op === 'clearRect')).toBe(true);
  });

  it('clears the boxes when the page is emptied', () => {
    useAnnotationStore.getState().setPageData(1, [annotation()]);
    renderOverlay();
    expect(overlayContext().calls.filter((call) => call.op === 'strokeRect')).toHaveLength(1);

    // Navigating away drops the page data; the stale boxes must disappear.
    act(() => {
      useAnnotationStore.getState().clear();
    });

    const calls = overlayContext().calls;
    const clearIndex = calls.map((call) => call.op).lastIndexOf('clearRect');
    expect(calls.slice(clearIndex + 1).filter((call) => call.op === 'strokeRect')).toHaveLength(0);
  });
});
