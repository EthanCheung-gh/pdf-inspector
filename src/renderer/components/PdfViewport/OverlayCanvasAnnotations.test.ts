// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageData, PdfTable } from '../../types/pdf-objects';
import { OverlayCanvas } from './OverlayCanvas';

interface DrawCall {
  op: string;
  args: number[];
}

/** Minimal 2D context double; the canvas behaviour under test is pointer logic. */
const createFakeContext = () => {
  const calls: DrawCall[] = [];
  const record =
    (op: string) =>
    (...args: number[]): void => {
      calls.push({ op, args });
    };
  return {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    calls,
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    scale: record('scale'),
  };
};

const PAGE = { width: 400, height: 400 };

/** Object covering the top-left quadrant: PDF x 0..200, y 200..400. */
const table: PdfTable = {
  type: 'table',
  page: 1,
  x0: 0,
  y0: 200,
  x1: 200,
  y1: 400,
  rows: 1,
  cols: 1,
  cells: [['cell']],
};

/** Annotation on top of that object: PDF x 100..200, y 300..350. */
const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: '1:link',
  page: 1,
  subtype: 'Link',
  kind: 'link',
  rect: { x0: 100, y0: 300, x1: 200, y1: 350 },
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

const pageData: PageData = {
  width: PAGE.width,
  height: PAGE.height,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [table],
};

/** Canvas points that map onto the annotation, the object, and empty page. */
const OVER_ANNOTATION = { clientX: 150, clientY: 75 };
const OVER_OBJECT_ONLY = { clientX: 50, clientY: 175 };
const OVER_NOTHING = { clientX: 350, clientY: 350 };

describe('OverlayCanvas annotation hit-testing', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    const fakeGetContext = function (): CanvasRenderingContext2D {
      return createFakeContext() as unknown as CanvasRenderingContext2D;
    };
    HTMLCanvasElement.prototype.getContext =
      fakeGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;

    usePdfStore.setState({
      pageData,
      allObjects: [table],
      overlayVisibility: { char: true, word: true, rect: true, line: true, curve: true, image: true, table: true },
      filterCriteria: {},
      subset: null,
      regionMode: false,
      textSelectionMode: false,
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
    });
    useWorkspaceStore.setState({ inspectorTab: 'page' });
    useAnnotationStore.getState().clear();
    useAnnotationStore.setState({ kindFilter: 'all', subtypeFilter: 'all', showBoxes: true });
    useAnnotationStore.getState().setPageData(1, [annotation()]);
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  const renderOverlay = (pageNum = 1): HTMLCanvasElement => {
    render(
      React.createElement(OverlayCanvas, {
        pageNum,
        pageWidth: PAGE.width,
        pageHeight: PAGE.height,
        pdfWidth: PAGE.width,
        pdfHeight: PAGE.height,
      }),
    );

    const canvas = screen.getByLabelText(`PDF page ${pageNum} object overlay`) as HTMLCanvasElement;
    // jsdom reports a zero-sized rect, which would disable every hit-test.
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: PAGE.width,
        bottom: PAGE.height,
        width: PAGE.width,
        height: PAGE.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return canvas;
  };

  it('gives the annotation priority over the object underneath it', () => {
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_ANNOTATION);

    expect(useAnnotationStore.getState().hovered?.id).toBe('1:link');
    // The object beneath the annotation must not become the hover target.
    expect(usePdfStore.getState().hoveredObject).toBeNull();
  });

  it('falls back to object hovering where no annotation is drawn', () => {
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_OBJECT_ONLY);

    expect(usePdfStore.getState().hoveredObject).toEqual(table);
    expect(useAnnotationStore.getState().hovered).toBeNull();
  });

  it('selects an annotation, clears the object selection and opens Inspect', () => {
    usePdfStore.setState({ selectedObject: table, hoveredObject: table });
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_ANNOTATION);
    fireEvent.click(canvas, OVER_ANNOTATION);

    expect(useAnnotationStore.getState().selected?.id).toBe('1:link');
    expect(usePdfStore.getState().selectedObject).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
  });

  it('clears the annotation selection when an object is clicked instead', () => {
    useAnnotationStore.getState().setSelected(annotation());
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_OBJECT_ONLY);
    fireEvent.click(canvas, OVER_OBJECT_ONLY);

    expect(usePdfStore.getState().selectedObject).toEqual(table);
    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
  });

  it('clears both selections on an empty click without switching tabs', () => {
    useAnnotationStore.getState().setSelected(annotation());
    usePdfStore.setState({ selectedObject: table });
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_NOTHING);
    fireEvent.click(canvas, OVER_NOTHING);

    expect(useAnnotationStore.getState().selected).toBeNull();
    expect(usePdfStore.getState().selectedObject).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('page');
  });

  it('does not hit-test annotations while Show boxes is off', () => {
    useAnnotationStore.getState().setShowBoxes(false);
    const canvas = renderOverlay();

    fireEvent.mouseMove(canvas, OVER_ANNOTATION);

    // The click falls through to the object under the (now invisible) box.
    expect(useAnnotationStore.getState().hovered).toBeNull();
    expect(usePdfStore.getState().hoveredObject).toEqual(table);
  });

  it('ignores annotations loaded for another page', () => {
    useAnnotationStore.getState().setPageData(2, [annotation({ id: '2:link', page: 2 })]);
    const canvas = renderOverlay(1);

    fireEvent.mouseMove(canvas, OVER_ANNOTATION);

    expect(useAnnotationStore.getState().hovered).toBeNull();
    expect(usePdfStore.getState().hoveredObject).toEqual(table);
  });

  it('clears the annotation hover on mouse leave', () => {
    const canvas = renderOverlay();
    fireEvent.mouseMove(canvas, OVER_ANNOTATION);
    expect(useAnnotationStore.getState().hovered).not.toBeNull();

    fireEvent.mouseLeave(canvas);

    expect(useAnnotationStore.getState().hovered).toBeNull();
    expect(usePdfStore.getState().hoveredObject).toBeNull();
  });
});
