// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { OVERLAY_COLORS } from '../../services/overlay-style';
import type { PageData, PdfTable } from '../../types/pdf-objects';
import {
  OverlayCanvas,
  TABLE_CELL_GRID_COLOR,
  TABLE_CELL_HOVER_COLOR,
  TABLE_CELL_SELECT_COLOR,
  drawTableCells,
} from './OverlayCanvas';

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
    calls,
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    scale: record('scale'),
  };
  return ctx as typeof ctx & CanvasRenderingContext2D;
};

const BOX = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

const table = (extra: Partial<PdfTable> = {}): PdfTable => ({
  type: 'table',
  page: 1,
  x0: 100,
  y0: 100,
  x1: 300,
  y1: 200,
  rows: 2,
  cols: 2,
  cells: [
    ['a', 'b'],
    ['c', 'd'],
  ],
  ...extra,
});

const cellBoxes = [
  [BOX(100, 150, 200, 200), BOX(200, 150, 300, 200)],
  [BOX(100, 100, 200, 150), BOX(200, 100, 300, 150)],
];

const pageData = (tables: PdfTable[]): PageData => ({
  width: 400,
  height: 400,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables,
});

const ofStyle = (calls: DrawCall[], style: string): DrawCall[] =>
  calls.filter((call) => call.strokeStyle === style && call.op === 'strokeRect');

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('drawTableCells', () => {
  const geometry = { pageWidth: 400, pageHeight: 400, pdfWidth: 400, pdfHeight: 400 };

  it('strokes one subtle grid rectangle per real cell and skips covered positions', () => {
    const ctx = createFakeContext();

    const drawn = drawTableCells(
      ctx,
      table({ cellBoxes: [[cellBoxes[0][0], null], [cellBoxes[1][0], cellBoxes[1][1]]] }),
      geometry,
    );

    expect(drawn).toBe(3);
    expect(ofStyle(ctx.calls, TABLE_CELL_GRID_COLOR)).toHaveLength(3);
    // Nothing is highlighted before a cell is hovered/selected.
    expect(ofStyle(ctx.calls, TABLE_CELL_SELECT_COLOR)).toHaveLength(0);
    expect(ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR)).toHaveLength(0);

    // Coverage: the merged-away slot produced no rectangle at all.
    const rects = ofStyle(ctx.calls, TABLE_CELL_GRID_COLOR).map((call) => call.args);
    expect(rects).toEqual([
      [100, 200, 100, 50],
      [100, 250, 100, 50],
      [200, 250, 100, 50],
    ]);
  });

  it('flips the bottom-left PDF y axis for the drawn rectangles', () => {
    const ctx = createFakeContext();

    drawTableCells(ctx, table({ cellBoxes: [[BOX(0, 0, 400, 100), null], [null, null]] }), geometry);

    // y0/y1 = 0..100 in PDF space is the bottom band: top = 400 - 100 = 300.
    expect(ofStyle(ctx.calls, TABLE_CELL_GRID_COLOR)[0].args).toEqual([0, 300, 400, 100]);
  });

  it('highlights the selected and hovered cell with distinct colors', () => {
    const ctx = createFakeContext();

    drawTableCells(ctx, table({ cellBoxes }), {
      ...geometry,
      selected: { row: 0, col: 0 },
      hovered: { row: 1, col: 1 },
    });

    const selected = ofStyle(ctx.calls, TABLE_CELL_SELECT_COLOR);
    expect(selected).toHaveLength(1);
    expect(selected[0].args).toEqual([100, 200, 100, 50]);

    const hovered = ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR);
    expect(hovered).toHaveLength(1);
    expect(hovered[0].args).toEqual([200, 250, 100, 50]);

    // Both highlight passes also fill their cell.
    expect(ctx.calls.filter((call) => call.op === 'fillRect')).toHaveLength(2);
  });

  it('draws only the hovered highlight when hovering the selected cell', () => {
    const ctx = createFakeContext();

    drawTableCells(ctx, table({ cellBoxes }), {
      ...geometry,
      selected: { row: 0, col: 1 },
      hovered: { row: 0, col: 1 },
    });

    expect(ofStyle(ctx.calls, TABLE_CELL_SELECT_COLOR)).toHaveLength(0);
    expect(ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR)).toHaveLength(1);
  });

  it('clears the canvas and draws nothing for tables without cell boxes', () => {
    const ctx = createFakeContext();

    expect(drawTableCells(ctx, table(), geometry)).toBe(0);
    expect(ctx.calls[0].op).toBe('clearRect');
    expect(ctx.calls.filter((call) => call.op === 'strokeRect')).toHaveLength(0);
  });
});

describe('OverlayCanvas table cell grid', () => {
  let contexts: Map<HTMLCanvasElement, ReturnType<typeof createFakeContext>>;
  let getContextCalls = 0;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  const gridContext = (): ReturnType<typeof createFakeContext> => {
    const grid = screen.getByTestId('table-cell-grid') as HTMLCanvasElement;
    const ctx = contexts.get(grid);
    if (!ctx) throw new Error('grid canvas has no context');
    return ctx;
  };

  beforeEach(() => {
    contexts = new Map();
    getContextCalls = 0;
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    // jsdom has no 2D backend: hand every canvas its own recording context.
    const fakeGetContext = function (this: HTMLCanvasElement): CanvasRenderingContext2D {
      getContextCalls += 1;
      let ctx = contexts.get(this);
      if (!ctx) {
        ctx = createFakeContext();
        contexts.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    };
    HTMLCanvasElement.prototype.getContext =
      fakeGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;

    useWorkspaceStore.setState({ overlayOpacity: 1 });
    usePdfStore.setState({
      pageData: null,
      allObjects: [],
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
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    usePdfStore.setState({ hoveredTableCell: null, selectedTableCell: null });
  });

  const renderCanvas = (): void => {
    render(
      React.createElement(OverlayCanvas, {
        pageNum: 1,
        pageWidth: 400,
        pageHeight: 400,
        pdfWidth: 400,
        pdfHeight: 400,
      }),
    );
  };

  it('draws no cell grid when no table is selected or hovered', () => {
    const otherTable = table({ x0: 350, y0: 350, x1: 390, y1: 390, cellBoxes: [[BOX(350, 350, 390, 390)]] });
    usePdfStore.setState({
      pageData: pageData([otherTable]),
      allObjects: [otherTable],
    });

    renderCanvas();

    // The table exists on the page but is not the active object.
    expect(gridContext().calls.filter((call) => call.op === 'strokeRect')).toHaveLength(0);
    expect(gridContext().calls.some((call) => call.op === 'clearRect')).toBe(true);
    // The object overlay still draws everything it used to.
    expect(getContextCalls).toBeGreaterThan(0);
  });

  it('draws the grid of the selected table only', () => {
    const target = table({ cellBoxes });
    const other = table({ x0: 350, y0: 350, x1: 390, y1: 390, cellBoxes: [[BOX(350, 350, 390, 390)]] });
    usePdfStore.setState({
      pageData: pageData([target, other]),
      allObjects: [target, other],
      selectedObject: target,
    });

    renderCanvas();

    // 4 cells of the selected table, none of the other page table.
    expect(ofStyle(gridContext().calls, TABLE_CELL_GRID_COLOR)).toHaveLength(4);
  });

  it('draws the grid of the hovered table while nothing is selected', () => {
    const target = table({ cellBoxes });
    usePdfStore.setState({
      pageData: pageData([target]),
      allObjects: [target],
      hoveredObject: target,
    });

    renderCanvas();

    expect(ofStyle(gridContext().calls, TABLE_CELL_GRID_COLOR)).toHaveLength(4);
  });

  it('highlights the hovered and selected cells of the active table', () => {
    const target = table({ cellBoxes });
    usePdfStore.setState({
      pageData: pageData([target]),
      allObjects: [target],
      selectedObject: target,
      selectedTableCell: { page: 1, tableIndex: 0, row: 0, col: 0, bbox: cellBoxes[0][0] },
      hoveredTableCell: { page: 1, tableIndex: 0, row: 1, col: 1, bbox: cellBoxes[1][1] },
    });

    renderCanvas();

    const ctx = gridContext();
    expect(ofStyle(ctx.calls, TABLE_CELL_SELECT_COLOR)).toHaveLength(1);
    expect(ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR)).toHaveLength(1);
    // Cell coordinates land in the bottom-left band of the page.
    expect(ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR)[0].args).toEqual([200, 250, 100, 50]);
  });

  it('ignores cell state that belongs to another page or table', () => {
    const target = table({ cellBoxes });
    const other = table({ x0: 350, y0: 350, x1: 390, y1: 390, cellBoxes: [[BOX(350, 350, 390, 390)]] });
    usePdfStore.setState({
      pageData: pageData([target, other]),
      allObjects: [target, other],
      selectedObject: target,
      selectedTableCell: { page: 2, tableIndex: 0, row: 0, col: 0, bbox: cellBoxes[0][0] },
      hoveredTableCell: { page: 1, tableIndex: 1, row: 0, col: 0, bbox: cellBoxes[1][1] },
    });

    renderCanvas();

    const ctx = gridContext();
    expect(ofStyle(ctx.calls, TABLE_CELL_SELECT_COLOR)).toHaveLength(0);
    expect(ofStyle(ctx.calls, TABLE_CELL_HOVER_COLOR)).toHaveLength(0);
  });

  it('keeps the object overlay clickable on top of the grid canvas', () => {
    const target = table({ cellBoxes });
    usePdfStore.setState({ pageData: pageData([target]), allObjects: [target], selectedObject: target });

    renderCanvas();

    const overlay = screen.getByLabelText('PDF page 1 object overlay') as HTMLCanvasElement;
    const grid = screen.getByTestId('table-cell-grid') as HTMLCanvasElement;

    expect((grid as HTMLElement).style.pointerEvents).toBe('none');
    expect((overlay as HTMLElement).style.pointerEvents).toBe('auto');
    // Object boxes are drawn by the overlay canvas, not by the grid canvas.
    expect(ofStyle(contexts.get(overlay)!.calls, OVERLAY_COLORS.table)).toHaveLength(1);
    expect(ofStyle(contexts.get(grid)!.calls, OVERLAY_COLORS.table)).toHaveLength(0);
  });

  it('translates the object overlay label and switches back to English', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    renderCanvas();

    expect(screen.getByLabelText('PDF 第 1 页对象叠加层')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByLabelText('PDF page 1 object overlay')).toBeTruthy();
  });
});
