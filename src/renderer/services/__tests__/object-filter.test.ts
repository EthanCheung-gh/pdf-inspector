import { describe, expect, it } from 'vitest';
import { filterByRegion, filterByProperties } from '../object-filter';
import type { PdfObject } from '../../types/pdf-objects';

const obj = (over: Partial<PdfObject> = {}): PdfObject => ({
  type: 'rect', x0: 10, y0: 20, x1: 30, y1: 40, page: 1, fill: true, stroke: true, color: '#000000', width: 1,
  ...over,
} as PdfObject);

describe('filterByRegion', () => {
  it('keeps objects overlapping the region (intersect, edge contact counts)', () => {
    const objects = [obj({ x0: 0, y0: 0, x1: 10, y1: 10 }), obj({ x0: 50, y0: 50, x1: 60, y1: 60 })];
    expect(filterByRegion(objects, { x0: 10, y0: 10, x1: 40, y1: 40 }, 'intersect')).toEqual([objects[0]]);
  });

  it('keeps only objects fully inside the region (contain)', () => {
    const objects = [
      obj({ x0: 15, y0: 25, x1: 25, y1: 35 }), // inside
      obj({ x0: 0, y0: 0, x1: 50, y1: 50 }),   // overlaps but sticks out
    ];
    expect(filterByRegion(objects, { x0: 10, y0: 20, x1: 30, y1: 40 }, 'contain')).toEqual([objects[0]]);
  });

  it('excludes disjoint objects in both modes', () => {
    const far = obj({ x0: 100, y0: 100, x1: 110, y1: 110 });
    const region = { x0: 0, y0: 0, x1: 50, y1: 50 };
    expect(filterByRegion([far], region, 'intersect')).toEqual([]);
    expect(filterByRegion([far], region, 'contain')).toEqual([]);
  });
});

describe('filterByProperties', () => {
  it('combines criteria with AND', () => {
    const objects = [
      { ...obj({ type: 'char', text: 'A', fontname: 'Helvetica', size: 12 }), color: '#ff0000' } as PdfObject,
      { ...obj({ type: 'char', text: 'B', fontname: 'Helvetica', size: 10 }), color: '#ff0000' } as PdfObject,
      { ...obj({ type: 'char', text: 'C', fontname: 'Arial', size: 12 }), color: '#ff0000' } as PdfObject,
    ];
    const result = filterByProperties(objects, { fontname: 'Helvetica', sizeMin: 11, sizeMax: 13 });
    expect(result).toEqual([objects[0]]);
  });

  it('returns all objects for empty criteria and ignores unknown types in list', () => {
    const objects = [obj({ type: 'rect' }), obj({ type: 'line' })];
    expect(filterByProperties(objects, {})).toEqual(objects);
    expect(filterByProperties(objects, { types: [] })).toEqual(objects);
  });

  it('skips size/color/fontname conditions for objects lacking those fields', () => {
    const rect = obj({ type: 'rect' });
    const char = { ...obj({ type: 'char', text: 'A', fontname: 'Helvetica', size: 12 }), color: '#000000' } as PdfObject;
    expect(filterByProperties([rect, char], { sizeMin: 11, color: '#000000' })).toEqual([char]);
  });
});
