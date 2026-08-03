import type { PdfObject, PdfObjectType } from '../types/pdf-objects';

export interface BBox { x0: number; y0: number; x1: number; y1: number; }

export interface FilterCriteria {
  types?: PdfObjectType[];
  fontname?: string;
  sizeMin?: number;
  sizeMax?: number;
  color?: string;
}

export interface ObjectSubset {
  source: 'region' | 'filter';
  mode: 'intersect' | 'contain';
  objects: PdfObject[];
  bbox?: BBox;
}

export function intersects(a: BBox, b: BBox): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function contains(outer: BBox, inner: BBox): boolean {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
}

export function filterByRegion(objects: PdfObject[], bbox: BBox, mode: 'intersect' | 'contain'): PdfObject[] {
  return objects.filter((o) => (mode === 'intersect' ? intersects(o, bbox) : contains(bbox, o)));
}

export function filterByProperties(objects: PdfObject[], criteria: FilterCriteria): PdfObject[] {
  const { types, fontname, sizeMin, sizeMax, color } = criteria;
  return objects.filter((o) => {
    if (types && types.length > 0 && !types.includes(o.type)) return false;
    if (fontname && (!('fontname' in o) || o.fontname !== fontname)) return false;
    if (sizeMin !== undefined && (!('size' in o) || o.size < sizeMin)) return false;
    if (sizeMax !== undefined && (!('size' in o) || o.size > sizeMax)) return false;
    if (color && (!('color' in o) || o.color !== color)) return false;
    return true;
  });
}
