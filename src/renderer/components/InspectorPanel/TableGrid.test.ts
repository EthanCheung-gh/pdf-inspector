// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import { pagesToJson } from '../../services/export-data';
import type { PageData, PdfTable } from '../../types/pdf-objects';
import { TableGrid, resolveTableIndex } from './TableGrid';
import { InspectTab } from './InspectTab';

vi.mock('../../services/ipc-client', () => ({
  ipc: { getImageData: vi.fn(), saveFile: vi.fn() },
}));

const BOX = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

/** 2×2 table; `cellBoxes`/`cellSpans` are optional so the fallback is testable. */
const table = (extra: Partial<PdfTable> = {}): PdfTable => ({
  type: 'table',
  page: 1,
  x0: 10,
  y0: 20,
  x1: 110,
  y1: 120,
  rows: 2,
  cols: 2,
  cells: [
    ['a', 'b'],
    ['c', 'd'],
  ],
  ...extra,
});

const boxes = [
  [BOX(10, 100, 60, 120), BOX(60, 100, 110, 120)],
  [BOX(10, 80, 60, 100), BOX(60, 80, 110, 100)],
];

const pageData = (tables: PdfTable[]): PageData => ({
  width: 200,
  height: 300,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables,
});

/** Ordered aria-labels of the grid slots, which is what "no shift" asserts. */
const slotLabels = (group: HTMLElement): (string | null)[] =>
  Array.from(group.children).map((child) => child.getAttribute('aria-label'));

const renderGrid = (value: PdfTable): HTMLElement => {
  render(React.createElement(TableGrid, { table: value, tableIndex: 0 }));
  return screen.getByRole('group', { name: /cells/i });
};

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('TableGrid', () => {
  beforeEach(() => {
    usePdfStore.setState({
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
    });
  });

  afterEach(cleanup);

  it('falls back to a text-only grid when the table has no cellBoxes', () => {
    const group = renderGrid(table());

    expect(slotLabels(group)).toEqual([
      'Cell row 1 column 1: a',
      'Cell row 1 column 2: b',
      'Cell row 2 column 1: c',
      'Cell row 2 column 2: d',
    ]);
    // No geometry means no covered markers and no cell selection state.
    expect(screen.queryAllByRole('img')).toHaveLength(0);

    const first = screen.getByRole('button', { name: 'Cell row 1 column 1: a' });
    fireEvent.click(first);
    expect(usePdfStore.getState().selectedTableCell).toEqual({
      page: 1,
      tableIndex: 0,
      row: 0,
      col: 0,
      bbox: null,
    });
  });

  it('marks merged-away positions without shifting the text matrix', () => {
    const group = renderGrid(
      table({
        // Row 1 col 2 was merged away, so it carries no box.
        cellBoxes: [[boxes[0][0], null], [boxes[1][0], boxes[1][1]]],
        cellSpans: [[{ rowSpan: 1, colSpan: 2 }, null], [null, null]],
      }),
    );

    // Four slots, same order: 'b' is replaced by the covered marker in place.
    expect(slotLabels(group)).toEqual([
      'Cell row 1 column 1: a',
      'Covered cell row 1 column 2',
      'Cell row 2 column 1: c',
      'Cell row 2 column 2: d',
    ]);
    // Only the three real cells are interactive.
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('separates missing cellBoxes geometry from a covered position', () => {
    // Ragged geometry: row 1 column 2 has no box and no span covers it.
    const ragged = renderGrid(
      table({ cellBoxes: [[boxes[0][0], null], [boxes[1][0], boxes[1][1]]] }),
    );

    // The text keeps its slot and stays selectable instead of becoming a merge.
    expect(slotLabels(ragged)).toEqual([
      'Cell row 1 column 1: a',
      'Cell row 1 column 2: b',
      'Cell row 2 column 1: c',
      'Cell row 2 column 2: d',
    ]);
    expect(screen.queryAllByRole('img')).toHaveLength(0);

    const missing = screen.getByRole('button', { name: 'Cell row 1 column 2: b' });
    expect(missing.getAttribute('title')).toBe('Cell row 1 column 2 · No cell box');
    fireEvent.click(missing);
    expect(usePdfStore.getState().selectedTableCell).toEqual({
      page: 1,
      tableIndex: 0,
      row: 0,
      col: 1,
      bbox: null,
    });

    cleanup();

    // The same null box is a merge once a span anchor covers it.
    const merged = renderGrid(
      table({
        cellBoxes: [[boxes[0][0], null], [boxes[1][0], boxes[1][1]]],
        cellSpans: [[{ rowSpan: 1, colSpan: 2 }, null], [null, null]],
      }),
    );

    expect(slotLabels(merged)).toEqual([
      'Cell row 1 column 1: a',
      'Covered cell row 1 column 2',
      'Cell row 2 column 1: c',
      'Cell row 2 column 2: d',
    ]);
    expect(
      screen.getByRole('img', { name: 'Covered cell row 1 column 2' }).getAttribute('title'),
    ).toContain('Covered by a merged cell');
    expect(screen.queryByTitle(/No cell box/)).toBeNull();
  });

  it('shows the row span badge for a merged cell', () => {
    render(
      React.createElement(TableGrid, {
        table: table({
          cellBoxes: boxes,
          cellSpans: [[{ rowSpan: 2, colSpan: 1 }, null], [null, null]],
        }),
        tableIndex: 0,
      }),
    );

    expect(screen.getByText('2×1')).toBeTruthy();
  });

  it('records the hovered cell, including its bbox', () => {
    render(
      React.createElement(TableGrid, { table: table({ cellBoxes: boxes }), tableIndex: 0 }),
    );

    const target = screen.getByRole('button', { name: 'Cell row 2 column 2: d' });
    fireEvent.mouseOver(target);

    expect(usePdfStore.getState().hoveredTableCell).toEqual({
      page: 1,
      tableIndex: 0,
      row: 1,
      col: 1,
      bbox: BOX(60, 80, 110, 100),
    });

    fireEvent.mouseOut(target);
    expect(usePdfStore.getState().hoveredTableCell).toBeNull();
  });

  it('selects the cell and keeps the table itself selected on click', () => {
    const value = table({ cellBoxes: boxes });
    usePdfStore.setState({ pageData: pageData([value]) });

    render(React.createElement(TableGrid, { table: value, tableIndex: 0 }));

    const target = screen.getByRole('button', { name: 'Cell row 2 column 1: c' });
    fireEvent.click(target);

    const state = usePdfStore.getState();
    expect(state.selectedTableCell).toEqual({
      page: 1,
      tableIndex: 0,
      row: 1,
      col: 0,
      bbox: BOX(10, 80, 60, 100),
    });
    // Clicking a cell must not drop the table selection.
    expect(state.selectedObject).toBe(value);
    expect(target.getAttribute('aria-pressed')).toBe('true');
  });

  it('reports row, column, span, bbox and source text of the active cell', () => {
    render(
      React.createElement(TableGrid, {
        table: table({
          cellBoxes: boxes,
          cellSpans: [[{ rowSpan: 2, colSpan: 1 }, null], [null, null]],
        }),
        tableIndex: 0,
      }),
    );

    expect(screen.getByText(/Hover a cell/i)).toBeTruthy();
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Cell row 1 column 1: a' }));

    const details = screen.getByLabelText('Selected cell');
    expect(details.textContent).toContain('Row1');
    expect(details.textContent).toContain('Column1');
    expect(details.textContent).toContain('2 × 1');
    expect(details.textContent).toContain('Texta');
    expect(details.textContent).toContain('10, 100 → 60, 120');
    expect(details.textContent).toContain('50 × 20 pt');
  });

  it('resolves a table index by identity, then by bbox, else -1', () => {
    const other = table({ x0: 200, y0: 200, x1: 300, y1: 300 });
    const stored = table();
    const copy = { ...stored };
    expect(resolveTableIndex([other, stored], stored)).toBe(1);
    // A reconstructed object with the same geometry still finds its table.
    expect(resolveTableIndex([other, stored], copy)).toBe(1);
    expect(resolveTableIndex([stored], table({ x0: 500, y0: 500, x1: 600, y1: 600 }))).toBe(-1);
    expect(resolveTableIndex(undefined, stored)).toBe(-1);
  });

  it('keeps the optional cell fields in the JSON export', () => {
    const value = table({
      cellBoxes: boxes,
      cellSpans: [[{ rowSpan: 1, colSpan: 1 }, null], [null, null]],
    });

    const parsed = JSON.parse(pagesToJson([pageData([value])], null));

    expect(parsed.pages[0].tables[0].cells).toEqual(value.cells);
    expect(parsed.pages[0].tables[0].cellBoxes).toEqual(boxes);
    expect(parsed.pages[0].tables[0].cellSpans[0][0]).toEqual({ rowSpan: 1, colSpan: 1 });
  });
});

describe('InspectTab table section', () => {
  afterEach(cleanup);

  it('renders the cell grid of the current table and addresses it by its page index', () => {
    const first = table({ x0: 200, y0: 200, x1: 300, y1: 300, cells: [['z']], rows: 1, cols: 1 });
    const target = table({ cellBoxes: boxes });
    usePdfStore.setState({
      pageData: pageData([first, target]),
      allObjects: [first, target],
      hoveredObject: null,
      selectedObject: target,
      hoveredTableCell: null,
      selectedTableCell: null,
    });

    render(React.createElement(InspectTab));

    // The existing Rows/Columns summary stays above the grid.
    expect(screen.getByText('Rows')).toBeTruthy();
    expect(screen.getByText('Columns')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Table 2 cells' });
    expect(slotLabels(group)).toEqual([
      'Cell row 1 column 1: a',
      'Cell row 1 column 2: b',
      'Cell row 2 column 1: c',
      'Cell row 2 column 2: d',
    ]);

    fireEvent.mouseOver(screen.getByRole('button', { name: 'Cell row 1 column 2: b' }));
    // tableIndex points at the second table of the page, not the first one.
    expect(usePdfStore.getState().hoveredTableCell?.tableIndex).toBe(1);
  });
});

describe('TableGrid localization', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
    usePdfStore.setState({
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      hoveredTableCell: null,
      selectedTableCell: null,
    });
  });

  afterEach(cleanup);

  it('translates the grid label, cell names, details and hint', () => {
    render(
      React.createElement(TableGrid, {
        table: table({ cellBoxes: boxes }),
        tableIndex: 0,
      }),
    );

    expect(screen.getByRole('group', { name: '表格 1 单元格' })).toBeTruthy();
    expect(screen.getByText('悬停单元格可预览，点击可选中。')).toBeTruthy();

    fireEvent.mouseOver(screen.getByRole('button', { name: '单元格 第 1 行 第 1 列：a' }));

    const details = screen.getByLabelText('选中的单元格');
    expect(details.textContent).toContain('行1');
    expect(details.textContent).toContain('列1');
    expect(details.textContent).toContain('文本a');
    expect(details.textContent).toContain('外框');
  });

  it('translates merged and missing-geometry labels', () => {
    render(
      React.createElement(TableGrid, {
        table: table({
          cellBoxes: [[boxes[0][0], null], [boxes[1][0], boxes[1][1]]],
          cellSpans: [[{ rowSpan: 1, colSpan: 2 }, null], [null, null]],
        }),
        tableIndex: 0,
      }),
    );

    expect(screen.getByRole('img', { name: '合并覆盖单元格 第 1 行 第 2 列' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /单元格 第 1 行 第 2 列/ })).toBeNull();

    cleanup();

    render(
      React.createElement(TableGrid, {
        table: table({ cellBoxes: [[boxes[0][0], null], [boxes[1][0], boxes[1][1]]] }),
        tableIndex: 0,
      }),
    );

    const missing = screen.getByRole('button', { name: '单元格 第 1 行 第 2 列：b' });
    expect(missing.getAttribute('title')).toBe('单元格 第 1 行 第 2 列 · 无单元格边框');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('button', { name: 'Cell row 1 column 2: b' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Table 1 cells' })).toBeTruthy();
  });
});
