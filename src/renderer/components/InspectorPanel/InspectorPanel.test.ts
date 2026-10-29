// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BBox } from '../../services/object-filter';
import { filterByRegion } from '../../services/object-filter';
import type { PdfChar, PdfObject, PdfRect, PdfWord } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';

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

describe('InspectorPanel region results', () => {
  afterEach(cleanup);

  beforeEach(() => {
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

    fireEvent.click(screen.getByRole('radio', { name: 'Contain' }));

    const subset = usePdfStore.getState().subset;
    expect(subset?.mode).toBe('contain');
    expect(subset?.objects).toEqual([objects[0]]);
    expect((screen.getByRole('radio', { name: 'Contain' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Intersect' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps the checked mode selected when its own radio is clicked again', () => {
    render(React.createElement(InspectorPanel));

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

    fireEvent.click(within(exportTypesGroup()).getByRole('button', { name: 'Clear' }));

    expect((screen.getByRole('button', { name: 'Export JSON' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Export CSV' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(exportTypesGroup()).getByText('0/7')).toBeTruthy();
  });

  it('exports only the selected types', async () => {
    render(React.createElement(InspectorPanel));

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
