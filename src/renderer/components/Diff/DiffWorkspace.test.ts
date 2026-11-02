// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffBoxSpec } from '../../services/diff-view';
import { useDiffStore } from '../../store/diff-store';
import {
  makeChange,
  makeIdenticalResult,
  makePage,
  makeResult,
  makeSampleResult,
} from '../../services/__tests__/diff-fixtures';

interface PaneProps {
  side: string;
  label: string;
  source: unknown;
  pageNumber: number | null;
  pageSize: { width: number; height: number } | null;
  boxes: DiffBoxSpec[];
  zoom: number;
  missingMessage: string;
}

const { paneProps, saveFile } = vi.hoisted(() => ({
  paneProps: [] as unknown[],
  saveFile: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: { saveFile } }));

// The real pane loads PDF.js into a canvas; the workspace test only needs to
// see which pages/boxes it is handed.
vi.mock('./DiffPdfPane', () => ({
  DiffPdfPane: (props: PaneProps) => {
    paneProps.push(props);
    return React.createElement('div', { 'data-testid': `pane-${props.side}` });
  },
}));

import { DiffWorkspace } from './DiffWorkspace';

const store = () => useDiffStore.getState();

/**
 * Props of the most recent render, one entry per pane.
 *
 * Renders happen synchronously inside `fireEvent`, and an effect may re-render
 * once more, so take everything recorded since the last call and keep the last
 * props per side.
 */
function takePanes(): PaneProps[] {
  const recorded = paneProps.splice(0, paneProps.length) as PaneProps[];
  const latest = new Map<string, PaneProps>();
  for (const props of recorded) {
    latest.delete(props.side);
    latest.set(props.side, props);
  }
  return [...latest.values()];
}

function renderWorkspace(): void {
  render(React.createElement(DiffWorkspace));
}

beforeEach(() => {
  store().reset();
  paneProps.length = 0;
  saveFile.mockReset();
  saveFile.mockResolvedValue({ canceled: false });
});

afterEach(cleanup);

describe('DiffWorkspace summary and change list', () => {
  it('shows the summary counts and grouped change list', () => {
    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();

    const summary = screen.getByTestId('diff-summary');
    expect(within(summary).getByText('Pages').nextSibling?.textContent).toBe('2 → 2');
    expect(within(summary).getByText('Objects removed').nextSibling?.textContent).toBe('2');

    const list = screen.getByTestId('diff-page-list');
    expect(within(list).getByRole('button', { name: /^Page 1/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /^Old page 2/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /^New page 2/ })).toBeTruthy();
    expect(screen.getByTestId('diff-names').textContent).toBe('old.pdf → new.pdf');
    expect(screen.getByText('4 changes')).toBeTruthy();
  });

  it('selects a change, syncs the panes and fills the detail pane', () => {
    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeSampleResult());
      store().setPageIndex(2);
    });

    renderWorkspace();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /modified word: Hello world/ }));
    });

    // Selecting a change follows it to its own page.
    expect(store().pageIndex).toBe(0);
    expect(store().selection).toEqual({ pageIndex: 0, changeIndex: 0 });

    const details = screen.getByTestId('diff-change-details');
    expect(within(details).getByText('Hello')).toBeTruthy();
    expect(within(details).getByText('Hello world')).toBeTruthy();
    expect(within(details).getByText('10, 700 → 60, 712 pt')).toBeTruthy();

    const panes = takePanes();
    expect(panes.map((pane) => pane.pageNumber)).toEqual([1, 1]);
    const selected = panes[0].boxes.filter((box) => box.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].kind).toBe('modified');
    // The old pane draws old boxes (modified + removed), the new pane only the
    // changed side that exists there.
    expect(panes[0].boxes).toHaveLength(2);
    expect(panes[1].boxes).toHaveLength(1);
  });

  it('filters by kind and clears the filter again', () => {
    act(() => {
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    const list = (): HTMLElement => screen.getByTestId('diff-page-list');

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'added' } });
    });

    expect(store().filter.kind).toBe('added');
    expect(within(list()).queryByRole('button', { name: /modified word:/ })).toBeNull();
    expect(within(list()).getByRole('button', { name: /added word:/ })).toBeTruthy();

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'all' } });
      fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'table' } });
    });

    expect(screen.getByText('No changes match this filter.')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    });
    expect(store().filter).toEqual({ kind: 'all', type: 'all' });
    expect(within(list()).getByRole('button', { name: /modified word:/ })).toBeTruthy();
  });

  it('renders a usable zero-change state', () => {
    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeIdenticalResult());
    });

    renderWorkspace();

    expect(screen.getByText(/No differences found/)).toBeTruthy();
    expect(screen.getByText(/both documents render the same pages/)).toBeTruthy();
    // The panes still work: page 1 exists on both sides.
    const panes = takePanes();
    expect(panes.map((pane) => pane.pageNumber)).toEqual([1, 1]);
  });

  it('keeps a long change list scrollable instead of truncating it', () => {
    const changes = Array.from({ length: 60 }, (_, index) =>
      makeChange({ textOld: `old ${index}`, textNew: `new ${index}` }),
    );
    act(() => {
      store().applyResult(makeResult([makePage({ changes })]));
    });

    renderWorkspace();

    expect(screen.getByText('60 changes')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /modified word: new \d+/ })).toHaveLength(60);
  });
});

describe('DiffWorkspace page navigation', () => {
  it('traverses result pages, showing one-sided pages with a null side', () => {
    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    expect(screen.getByText('1 / 3')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    });
    expect(store().pageIndex).toBe(1);
    expect(screen.getByText('2 / 3')).toBeTruthy();
    let panes = takePanes();
    // A removed page has no new side at all.
    expect(panes[0].pageNumber).toBe(2);
    expect(panes[1].pageNumber).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    });
    panes = takePanes();
    expect(panes[0].pageNumber).toBeNull();
    expect(panes[1].pageNumber).toBe(2);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    });
    expect(store().pageIndex).toBe(1);
  });

  it('switches to a labelled overlay pane with boxes from both sides', () => {
    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    // Drop the initial side-by-side render so the next read only sees the
    // overlay pane.
    expect(takePanes()).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));
    });

    expect(store().viewMode).toBe('overlay');
    const panes = takePanes();
    expect(panes).toHaveLength(1);
    expect(panes[0].side).toBe('overlay');
    // A paired page is owned by the old document.
    expect(panes[0].source).toBe('/docs/old.pdf');
    expect(panes[0].pageNumber).toBe(1);
    expect(panes[0].pageSize).toEqual({ width: 612, height: 792 });
    expect(panes[0].boxes.map((box) => box.side)).toEqual(['old', 'old', 'new']);
    expect(screen.getByText(/Overlay: the page’s owning document/)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    });
    expect(store().viewMode).toBe('side-by-side');
    expect(takePanes()).toHaveLength(2);
  });

  it('overlays a one-sided page on the document that owns it', () => {
    const result = makeResult([
      makePage(),
      makePage({
        oldIndex: null,
        newIndex: 2,
        status: 'added',
        oldSize: null,
        newSize: { width: 400, height: 500 },
        changes: [
          makeChange({
            kind: 'added',
            oldPage: null,
            newPage: 2,
            oldBBox: null,
            textOld: null,
          }),
        ],
      }),
      makePage({
        oldIndex: 3,
        newIndex: null,
        status: 'removed',
        newSize: null,
        oldSize: { width: 300, height: 320 },
        changes: [
          makeChange({
            kind: 'removed',
            oldPage: 3,
            newPage: null,
            newBBox: null,
            textNew: null,
          }),
        ],
      }),
    ]);

    act(() => {
      store().setSource('old', '/docs/old.pdf', 'old.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(result);
      store().setViewMode('overlay');
      // An added page: there is no old page number to load.
      store().setPageIndex(1);
    });

    renderWorkspace();

    let panes = takePanes();
    expect(panes).toHaveLength(1);
    expect(panes[0].pageNumber).toBe(2);
    // The old document must never be loaded at the new page's number.
    expect(panes[0].source).toBe('/docs/new.pdf');
    expect(panes[0].pageSize).toEqual({ width: 400, height: 500 });
    expect(panes[0].boxes.map((box) => box.side)).toEqual(['new']);

    act(() => {
      // The symmetric case: a removed page belongs to the old document.
      store().setPageIndex(2);
    });

    panes = takePanes();
    expect(panes[0].pageNumber).toBe(3);
    expect(panes[0].source).toBe('/docs/old.pdf');
    expect(panes[0].pageSize).toEqual({ width: 300, height: 320 });
    expect(panes[0].boxes.map((box) => box.side)).toEqual(['old']);
  });

  it('zooms both panes together', () => {
    act(() => {
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    });

    expect(store().zoom).toBe(1.25);
    expect(takePanes().every((pane) => pane.zoom === 1.25)).toBe(true);
  });
});

describe('DiffWorkspace actions', () => {
  it('exports the full result as JSON while the Inspect workspace keeps running', async () => {
    act(() => {
      store().setSource('old', '/docs/old pdf', 'old pdf.pdf');
      store().setSource('new', '/docs/new.pdf', 'new.pdf');
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });

    expect(saveFile).toHaveBeenCalledTimes(1);
    const request = saveFile.mock.calls[0][0] as {
      defaultPath: string;
      content: string;
      filterName: string;
      extensions: string[];
    };
    expect(request.defaultPath).toBe('old_pdf-vs-new-diff.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);
    const parsed = JSON.parse(request.content) as { schemaVersion: number; pages: unknown[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.pages).toHaveLength(3);
  });

  it('reports an export failure in the workspace', async () => {
    act(() => {
      store().applyResult(makeSampleResult());
    });
    saveFile.mockResolvedValueOnce({ canceled: false, error: 'disk full' });

    renderWorkspace();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });

    expect(store().error).toBe('Export failed: disk full');
    expect(screen.getByRole('alert').textContent).toContain('disk full');
  });

  it('returns to Inspect and reopens the setup dialog', () => {
    act(() => {
      store().enterWorkspace();
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to Inspect' }));
    });
    expect(store().active).toBe(false);
    // The result is kept so the same comparison can be reopened.
    expect(store().result).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change files…' }));
    });
    expect(store().setupOpen).toBe(true);
  });

  it('shows a load error and an empty comparison state', () => {
    act(() => {
      store().setError('Cannot read old PDF');
    });

    renderWorkspace();

    expect(screen.getByRole('alert').textContent).toContain('Diff failed: Cannot read old PDF');
    expect(screen.queryByTestId('diff-page-list')?.textContent).not.toContain('modified');
  });

  it('hints at the CLI for the HTML report', () => {
    act(() => {
      store().applyResult(makeSampleResult());
    });

    renderWorkspace();

    expect(screen.getByText(/--format html/)).toBeTruthy();
  });
});
