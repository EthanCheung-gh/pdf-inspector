import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_COLORS,
  ANNOTATION_FILL_ALPHA,
  ANNOTATION_HOVER_STROKE_ALPHA,
  ANNOTATION_LABEL_LIMIT,
  ANNOTATION_SELECTED_COLOR,
  ANNOTATION_STROKE_ALPHA,
  annotationScreenRect,
  drawAnnotations,
  hitTestAnnotations,
  isUsableAnnotationRect,
  withAlpha,
} from '../annotation-view';
import { ANNOTATION_KINDS } from '../annotations';
import type { AnnotationKind, PdfAnnotation } from '../../types/annotations';
import type { PageBox } from '../../types/pdf-objects';

interface DrawCall {
  op: string;
  args: number[];
  strokeStyle: string;
  fillStyle: string;
  alpha: number;
  lineWidth: number;
  text?: string;
}

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
        alpha: ctx.globalAlpha,
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
    fillText: (text: string, x: number, y: number): void => {
      calls.push({
        op: 'fillText',
        args: [x, y],
        strokeStyle: ctx.strokeStyle,
        fillStyle: ctx.fillStyle,
        alpha: ctx.globalAlpha,
        lineWidth: ctx.lineWidth,
        text,
      });
    },
  };
  return ctx as typeof ctx & CanvasRenderingContext2D;
};

const BOX = (x0: number, y0: number, x1: number, y1: number): PageBox => ({ x0, y0, x1, y1 });

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

const geometry = { pageWidth: 612, pageHeight: 792, pdfWidth: 612, pdfHeight: 792 };

const strokeCalls = (calls: DrawCall[], style: string): DrawCall[] =>
  calls.filter((call) => call.op === 'strokeRect' && call.strokeStyle === style);

describe('withAlpha', () => {
  it('converts hex colors to rgba strings and leaves other formats alone', () => {
    expect(withAlpha('#2196f3', 0.5)).toBe('rgba(33, 150, 243, 0.5)');
    expect(withAlpha('#FFD700', 1)).toBe('rgba(255, 215, 0, 1)');
    expect(withAlpha('gold', 0.5)).toBe('gold');
    expect(withAlpha('', 0.5)).toBe('');
  });
});

describe('ANNOTATION_COLORS', () => {
  it('covers every annotation kind with distinct colors', () => {
    expect(Object.keys(ANNOTATION_COLORS).sort()).toEqual([...ANNOTATION_KINDS].sort());

    const values = Object.values(ANNOTATION_COLORS);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);

    // The plan's legend: link blue, form purple, markup yellow, note orange,
    // stamp cyan and everything else gray.
    expect(ANNOTATION_COLORS.link).toBe('#2196f3');
    expect(ANNOTATION_COLORS.form).toBe('#9c27b0');
    expect(ANNOTATION_COLORS.markup).toBe('#ffc107');
    expect(ANNOTATION_COLORS.note).toBe('#ff9800');
    expect(ANNOTATION_COLORS.stamp).toBe('#00bcd4');
    expect(ANNOTATION_COLORS.other).toBe('#9e9e9e');
  });
});

describe('isUsableAnnotationRect', () => {
  it('rejects missing, degenerate and off-page rects', () => {
    expect(isUsableAnnotationRect(null, 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(10, 10, 10, 40), 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(10, 10, 40, 10), 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(40, 40, 10, 10), 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(-50, 10, 0, 40), 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(612, 10, 700, 40), 612, 792)).toBe(false);
    expect(isUsableAnnotationRect(BOX(Number.NaN, 10, 40, 40), 612, 792)).toBe(false);
  });

  it('accepts a rect that is partially on the page', () => {
    expect(isUsableAnnotationRect(BOX(-10, -10, 40, 40), 612, 792)).toBe(true);
    expect(isUsableAnnotationRect(BOX(600, 780, 700, 800), 612, 792)).toBe(true);
  });
});

describe('annotationScreenRect', () => {
  it('scales and flips the bottom-left PDF mapping like the object overlay', () => {
    // x0=100, y0=100, x1=200, y1=150 on a page rendered at 2x.
    expect(annotationScreenRect(BOX(100, 100, 200, 150), 1224, 1584, 612, 792)).toEqual({
      x: 200,
      y: 1584 - 300,
      width: 200,
      height: 100,
    });
  });

  it('maps MediaBox-relative rects for a page whose MediaBox origin is non-zero', () => {
    // MediaBox 10,20 → 642,832: the loader already subtracted the origin, so an
    // annotation at absolute (60,70)-(160,120) arrives as (50,50)-(150,100).
    const mediaWidth = 632;
    const mediaHeight = 812;

    expect(annotationScreenRect(BOX(50, 50, 150, 100), mediaWidth, mediaHeight, mediaWidth, mediaHeight)).toEqual({
      x: 50,
      y: mediaHeight - 100,
      width: 100,
      height: 50,
    });
  });

  it('returns null for unusable rects and unusable page geometry', () => {
    expect(annotationScreenRect(null, 612, 792, 612, 792)).toBeNull();
    expect(annotationScreenRect(BOX(0, 0, 0, 10), 612, 792, 612, 792)).toBeNull();
    expect(annotationScreenRect(BOX(0, 0, 10, 10), 0, 792, 612, 792)).toBeNull();
    expect(annotationScreenRect(BOX(0, 0, 10, 10), 612, 792, 0, 792)).toBeNull();
  });
});

describe('hitTestAnnotations', () => {
  const canvas = { width: 612, height: 792 };

  it('converts the canvas point to PDF space before comparing', () => {
    const target = annotation();

    // Canvas (150, 792-125) is the middle of the rect in PDF space.
    const hit = hitTestAnnotations(
      [target],
      150,
      canvas.height - 125,
      geometry.pdfWidth,
      geometry.pdfHeight,
      canvas.width,
      canvas.height,
    );
    expect(hit).toBe(target);

    expect(
      hitTestAnnotations([target], 150, 10, 612, 792, canvas.width, canvas.height),
    ).toBeNull();
  });

  it('returns the topmost (last drawn) annotation', () => {
    const below = annotation({ id: 'below' });
    const above = annotation({ id: 'above', kind: 'form', subtype: 'Widget' });

    expect(hitTestAnnotations([below, above], 150, 792 - 125, 612, 792, 612, 792)).toBe(above);
    expect(hitTestAnnotations([above, below], 150, 792 - 125, 612, 792, 612, 792)).toBe(below);
  });

  it('skips hidden annotations and rects without usable geometry', () => {
    const hidden = annotation({ id: 'hidden', hidden: true });
    const noRect = annotation({ id: 'no-rect', rect: null });
    const degenerate = annotation({ id: 'degenerate', rect: BOX(100, 100, 100, 150) });

    expect(
      hitTestAnnotations([hidden, noRect, degenerate], 150, 792 - 125, 612, 792, 612, 792),
    ).toBeNull();
  });

  it('ignores a canvas or page without geometry', () => {
    const target = annotation();

    expect(hitTestAnnotations([target], 150, 700, 612, 792, 0, 792)).toBeNull();
    expect(hitTestAnnotations([target], 150, 700, 0, 792, 612, 792)).toBeNull();
    expect(hitTestAnnotations([target], Number.NaN, 700, 612, 792, 612, 792)).toBeNull();
    expect(hitTestAnnotations([], 150, 700, 612, 792, 612, 792)).toBeNull();
  });
});

describe('drawAnnotations', () => {
  it('clears the canvas and fills plus strokes one box per kind in its own color', () => {
    const ctx = createFakeContext();
    const kinds: AnnotationKind[] = ['link', 'form', 'markup', 'note', 'stamp', 'other'];
    const annotations = kinds.map((kind, index) =>
      annotation({
        id: kind,
        kind,
        rect: BOX(10, 10 + index * 30, 110, 30 + index * 30),
      }),
    );

    const drawn = drawAnnotations(ctx, annotations, geometry);

    expect(drawn).toBe(kinds.length);
    expect(ctx.calls[0].op).toBe('clearRect');
    expect(ctx.calls[0].args).toEqual([0, 0, 612, 792]);

    for (const kind of kinds) {
      const strokes = strokeCalls(ctx.calls, withAlpha(ANNOTATION_COLORS[kind], ANNOTATION_STROKE_ALPHA));
      expect(strokes).toHaveLength(1);
      expect(strokes[0].lineWidth).toBe(1);
    }

    const fills = ctx.calls.filter((call) => call.op === 'fillRect');
    expect(fills).toHaveLength(kinds.length);
    expect(fills[0].fillStyle).toBe(withAlpha(ANNOTATION_COLORS.link, ANNOTATION_FILL_ALPHA));
    // The first box spans y1=30 on a 792pt page: top = 792 - 30.
    expect(fills[0].args).toEqual([10, 762, 100, 20]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('skips hidden annotations and unusable rects', () => {
    const ctx = createFakeContext();

    const drawn = drawAnnotations(
      ctx,
      [
        annotation({ id: 'hidden', hidden: true }),
        annotation({ id: 'no-rect', rect: null }),
        annotation({ id: 'degenerate', rect: BOX(20, 20, 20, 60) }),
        annotation({ id: 'visible' }),
      ],
      geometry,
    );

    expect(drawn).toBe(1);
    expect(ctx.calls.filter((call) => call.op === 'strokeRect')).toHaveLength(1);
  });

  it('outlines the selected annotation in gold and brightens the hovered one', () => {
    const ctx = createFakeContext();
    const selected = annotation({ id: 'selected', rect: BOX(10, 10, 60, 40) });
    const hovered = annotation({
      id: 'hovered',
      kind: 'markup',
      rect: BOX(100, 10, 160, 40),
    });

    drawAnnotations(ctx, [selected, hovered, annotation({ id: 'idle', rect: BOX(200, 10, 260, 40) })], {
      ...geometry,
      selected,
      hovered,
    });

    const goldCalls = strokeCalls(ctx.calls, ANNOTATION_SELECTED_COLOR);
    expect(goldCalls).toHaveLength(1);
    expect(goldCalls[0].lineWidth).toBe(2);
    expect(goldCalls[0].args).toEqual([10, 792 - 40, 50, 30]);

    // The hovered box uses its kind color at the brighter alpha.
    expect(
      strokeCalls(ctx.calls, withAlpha(ANNOTATION_COLORS.markup, ANNOTATION_HOVER_STROKE_ALPHA)),
    ).toHaveLength(1);
    // An idle box of the same kind keeps the dim alpha.
    expect(
      strokeCalls(ctx.calls, withAlpha(ANNOTATION_COLORS.link, ANNOTATION_STROKE_ALPHA)),
    ).toHaveLength(1);
  });

  it('matches the selected annotation by id and prefers gold over hover', () => {
    const ctx = createFakeContext();
    const stored = annotation({ id: 'same' });
    const copy = { ...stored };

    drawAnnotations(ctx, [stored], { ...geometry, selected: copy, hovered: copy });

    expect(strokeCalls(ctx.calls, ANNOTATION_SELECTED_COLOR)).toHaveLength(1);
    expect(
      ctx.calls.filter(
        (call) =>
          call.op === 'strokeRect' &&
          call.strokeStyle === withAlpha(ANNOTATION_COLORS.link, ANNOTATION_HOVER_STROKE_ALPHA),
      ),
    ).toHaveLength(0);
  });

  it('draws no label by default and caps labels when enabled', () => {
    const annotations = Array.from({ length: ANNOTATION_LABEL_LIMIT + 5 }, (_value, index) =>
      annotation({
        id: `a${index}`,
        title: `Annotation number ${index}`,
        rect: BOX(10, 10 + index, 110, 30 + index),
      }),
    );

    const plain = createFakeContext();
    drawAnnotations(plain, annotations, geometry);
    expect(plain.calls.filter((call) => call.op === 'fillText')).toHaveLength(0);

    const labelled = createFakeContext();
    drawAnnotations(labelled, annotations, { ...geometry, labels: true });
    const labels = labelled.calls.filter((call) => call.op === 'fillText');
    expect(labels).toHaveLength(ANNOTATION_LABEL_LIMIT);
    // Labels are truncated so a long title cannot cover the page.
    expect((labels[0].text ?? '').length).toBeLessThanOrEqual(24);

    const capped = createFakeContext();
    drawAnnotations(capped, annotations, { ...geometry, labels: true, maxLabels: 2 });
    expect(capped.calls.filter((call) => call.op === 'fillText')).toHaveLength(2);
  });

  it('clears the canvas when nothing is drawable', () => {
    const ctx = createFakeContext();

    expect(drawAnnotations(ctx, [], geometry)).toBe(0);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('clearRect');
  });
});
