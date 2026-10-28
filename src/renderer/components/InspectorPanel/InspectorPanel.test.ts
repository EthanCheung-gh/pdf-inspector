// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BBox } from '../../services/object-filter';
import { filterByRegion } from '../../services/object-filter';
import type { PdfRect } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';

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
