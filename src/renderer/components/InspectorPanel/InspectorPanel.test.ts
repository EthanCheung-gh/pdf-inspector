// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BBox } from '../../services/object-filter';
import { filterByRegion } from '../../services/object-filter';
import type { PdfChar, PdfObject, PdfRect, PdfWord } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';

const { saveFile, getImageData } = vi.hoisted(() => ({
  saveFile: vi.fn(),
  getImageData: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { saveFile, getImageData },
}));

import { InspectorPanel } from './InspectorPanel';

const bbox: BBox = { x0: 0, y0: 0, x1: 10, y1: 10 };

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

// `inside` is contained by the region, `overlap` only intersects it.
const objects: PdfRect[] = [rect(0, 0, 10, 10), rect(-5, -5, 5, 5)];

const openTab = (name: RegExp): void => {
  fireEvent.click(screen.getByRole('tab', { name }));
};

describe('InspectorPanel region results', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useWorkspaceStore.setState({ inspectorTab: 'inspect' });
    usePdfStore.setState({
      allObjects: objects,
      hoveredObject: null,
      selectedObject: null,
      filterCriteria: {},
      subset: {
        source: 'region',
        mode: 'intersect',
        bbox,
        objects: filterByRegion(objects, bbox, 'intersect'),
      },
    });
  });

  it('renders the region modes as one radio group with a single checked option', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    const intersect = screen.getByRole('radio', { name: 'Intersect' }) as HTMLInputElement;
    const contain = screen.getByRole('radio', { name: 'Contain' }) as HTMLInputElement;

    expect(intersect.getAttribute('name')).toBe('region-mode');
    expect(contain.getAttribute('name')).toBe('region-mode');
    expect(intersect.checked).toBe(true);
    expect(contain.checked).toBe(false);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('switches the region mode and recomputes the subset when the other radio is selected', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    fireEvent.click(screen.getByRole('radio', { name: 'Contain' }));

    const subset = usePdfStore.getState().subset;
    expect(subset?.mode).toBe('contain');
    expect(subset?.objects).toEqual([objects[0]]);
    expect((screen.getByRole('radio', { name: 'Contain' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Intersect' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps the checked mode selected when its own radio is clicked again', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    fireEvent.click(screen.getByRole('radio', { name: 'Intersect' }));

    expect(usePdfStore.getState().subset?.mode).toBe('intersect');
    expect(usePdfStore.getState().subset?.objects).toEqual(objects);
    expect((screen.getByRole('radio', { name: 'Intersect' }) as HTMLInputElement).checked).toBe(true);
  });
});

const exportBBox: BBox = { x0: 0, y0: 0, x1: 20, y1: 20 };

const exportChar: PdfChar = {
  type: 'char',
  page: 1,
  x0: 1,
  y0: 1,
  x1: 4,
  y1: 4,
  text: 'a',
  fontname: 'F1',
  size: 12,
  color: '#000000',
};

const exportWord: PdfWord = {
  type: 'word',
  page: 1,
  x0: 1,
  y0: 1,
  x1: 9,
  y1: 4,
  text: 'hello',
  fontname: 'F1',
  size: 12,
};

const exportObjects: PdfObject[] = [
  exportChar,
  exportWord,
  {
    type: 'rect',
    page: 1,
    x0: 0,
    y0: 0,
    x1: 10,
    y1: 10,
    fill: true,
    stroke: false,
    color: '#000000',
    width: 1,
  },
];

describe('InspectorPanel export types', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useWorkspaceStore.setState({ inspectorTab: 'inspect' });
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });

    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      sourceUrl: null,
      metadata: null,
      currentPage: 1,
      allObjects: exportObjects,
      hoveredObject: null,
      selectedObject: null,
      filterCriteria: {},
      subset: {
        source: 'region',
        mode: 'intersect',
        bbox: exportBBox,
        objects: exportObjects,
      },
      isLoading: false,
      error: null,
    });
  });

  function exportTypesGroup(): HTMLElement {
    return screen.getByRole('group', { name: 'Export types' });
  }

  it('shows a compact selector with every type selected above the export buttons', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    const group = exportTypesGroup();
    const checkboxes = within(group).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(7);
    checkboxes.forEach((box) => expect((box as HTMLInputElement).checked).toBe(true));
    expect(within(group).getByText('7/7')).toBeTruthy();

    // The picker sits above the export actions inside the Results section.
    const json = screen.getByRole('button', { name: 'Export JSON' });
    expect(group.compareDocumentPosition(json) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((json as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables both export buttons when no type is selected', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    fireEvent.click(within(exportTypesGroup()).getByRole('button', { name: 'Clear' }));

    expect((screen.getByRole('button', { name: 'Export JSON' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(exportTypesGroup()).getByText('0/7')).toBeTruthy();
  });

  it('exports only the selected types', async () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    const group = exportTypesGroup();
    fireEvent.click(within(group).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Words' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];
    const parsed = JSON.parse(request.content);

    expect(parsed.objectTypes).toEqual(['word']);
    expect(parsed.objectCount).toBe(1);
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0].type).toBe('word');
    expect(request.defaultPath).toBe('doc-p1.json');
    expect(request.filterName).toBe('JSON');
  });
});

describe('InspectorPanel tabs', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useWorkspaceStore.setState({ inspectorTab: 'inspect' });
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });
    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      sourceUrl: null,
      metadata: null,
      currentPage: 1,
      allObjects: exportObjects,
      hoveredObject: null,
      selectedObject: null,
      filterCriteria: {},
      subset: {
        source: 'region',
        mode: 'intersect',
        bbox: exportBBox,
        objects: exportObjects,
      },
      isLoading: false,
      error: null,
    });
  });

  it('opens on Inspect while keeping the other two panels mounted but hidden', () => {
    render(React.createElement(InspectorPanel));

    const inspect = screen.getByRole('tab', { name: 'Inspect' });
    expect(inspect.getAttribute('aria-selected')).toBe('true');
    expect(inspect.getAttribute('tabindex')).toBe('0');
    expect(
      screen.getByText('Hover over or select an object to inspect its properties.'),
    ).toBeTruthy();

    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels).toHaveLength(3);
    expect(panels.filter((panel) => !panel.hasAttribute('hidden'))).toHaveLength(1);
    expect(screen.getByRole('tabpanel', { name: 'Inspect' })).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: /^Filter/ })).toBeNull();
    expect(screen.queryByRole('tabpanel', { name: /^Results/ })).toBeNull();
  });

  it('switches tabs with arrow keys, Home and End, moving focus with the selection', () => {
    render(React.createElement(InspectorPanel));

    const inspect = screen.getByRole('tab', { name: 'Inspect' });
    inspect.focus();

    fireEvent.keyDown(inspect, { key: 'ArrowRight' });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('filter');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Filter/ }));
    expect(screen.getByRole('tab', { name: /^Filter/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');

    fireEvent.keyDown(inspect, { key: 'ArrowLeft' });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
    expect(screen.getByRole('tab', { name: /^Results/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByRole('tab', { name: /^Results/ }), { key: 'Home' });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');

    fireEvent.keyDown(inspect, { key: 'End' });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
  });

  it('shows the active condition count and the result count on the tabs', () => {
    usePdfStore.setState({
      filterCriteria: {
        fontname: 'F1',
        sizeMin: 12,
        sizeMax: 18,
        color: '#000000',
        types: ['word'],
      },
      subset: {
        source: 'filter',
        mode: 'intersect',
        objects: [exportWord],
      },
    });

    render(React.createElement(InspectorPanel));

    const filterTab = screen.getByRole('tab', { name: 'Filter (4)' });
    expect(filterTab.textContent).toContain('4');
    const resultsTab = screen.getByRole('tab', { name: 'Results (1)' });
    expect(resultsTab.textContent).toContain('1');
  });

  it('stays on Filter when a filter changes and updates the condition count', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Filter/);

    fireEvent.change(screen.getByRole('combobox', { name: 'Font' }), {
      target: { value: 'F1' },
    });

    expect(usePdfStore.getState().filterCriteria.fontname).toBe('F1');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('filter');
    expect(screen.getByRole('tab', { name: 'Filter (1)' })).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Filter (1)' })).toBeTruthy();
  });

  it('keeps the Results export type selection across tab switches', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);
    fireEvent.click(within(screen.getByRole('group', { name: 'Export types' })).getByRole('button', { name: 'Clear' }));
    expect(within(screen.getByRole('group', { name: 'Export types' })).getByText('0/7')).toBeTruthy();

    openTab(/^Inspect/);
    openTab(/^Filter/);
    openTab(/^Results/);

    expect(within(screen.getByRole('group', { name: 'Export types' })).getByText('0/7')).toBeTruthy();
  });

  it('switches to Inspect when an object is selected from the Results list', () => {
    render(React.createElement(InspectorPanel));
    openTab(/^Results/);

    const resultButton = screen.getByRole('button', { name: /^\[rect\]/ });
    fireEvent.click(resultButton);

    expect(usePdfStore.getState().selectedObject).toEqual(exportObjects[2]);
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
    expect(screen.getByRole('tab', { name: 'Inspect' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Inspect' })).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: /^Results/ })).toBeNull();
    // The Inspect panel now shows the selected object's page.
    expect(screen.getByText('Page')).toBeTruthy();
  });

  it('opens the Results panel when a region selection switches the workspace tab', () => {
    render(React.createElement(InspectorPanel));

    // useRegionSelect performs this transition after a region drag.
    act(() => {
      useWorkspaceStore.getState().setInspectorTab('results');
    });

    expect(screen.getByRole('tab', { name: /^Results/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: /^Results/ })).toBeTruthy();
    expect(screen.getByText(/Results \(3 · region\)/)).toBeTruthy();
  });

  it('collapses the right pane from a header button that stays outside the tablist', () => {
    useWorkspaceStore.setState({ rightCollapsed: false });
    render(React.createElement(InspectorPanel));

    const tablist = screen.getByRole('tablist', { name: 'Inspector tabs' });
    // Only the three tabs belong to the tablist; the collapse control is a sibling.
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    expect(within(tablist).queryByRole('button', { name: 'Hide right panel' })).toBeNull();

    const collapse = screen.getByRole('button', { name: 'Hide right panel' });
    expect(collapse.getAttribute('title')).toBe('Hide right panel');
    expect(tablist.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(collapse);
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(true);

    fireEvent.click(collapse);
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(false);
  });

  it('keeps all three tab labels rendered next to the header collapse button', () => {
    usePdfStore.setState({
      filterCriteria: { fontname: 'F1', types: ['word'] },
      subset: { source: 'filter', mode: 'intersect', objects: [exportWord] },
    });
    render(React.createElement(InspectorPanel));

    const tablist = screen.getByRole('tablist', { name: 'Inspector tabs' });
    const labels = within(tablist)
      .getAllByRole('tab')
      .map((tab) => tab.querySelector('span')?.textContent);
    expect(labels).toEqual(['Inspect', 'Filter', 'Results']);
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
  });
});
