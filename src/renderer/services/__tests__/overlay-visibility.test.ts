import { describe, expect, it } from 'vitest';
import { effectiveOverlayVisibility, overlayObjects } from '../overlay-visibility';
import type { ObjectSubset } from '../object-filter';
import type { PdfObject } from '../../types/pdf-objects';

const obj = (over: Partial<PdfObject> = {}): PdfObject => ({
  type: 'rect', x0: 10, y0: 20, x1: 30, y1: 40, page: 1, fill: true, stroke: true, color: '#000000', width: 1,
  ...over,
} as PdfObject);

const ALL_VISIBLE: Record<string, boolean> = {
  char: true,
  word: true,
  rect: true,
  line: true,
  curve: true,
  image: true,
  table: true,
};

describe('effectiveOverlayVisibility', () => {
  it('returns an equivalent of the toolbar visibility when no types are selected', () => {
    const base = { ...ALL_VISIBLE };
    const expected = { ...ALL_VISIBLE };

    const fromUndefined = effectiveOverlayVisibility(base);
    const fromEmpty = effectiveOverlayVisibility(base, []);

    expect(fromUndefined).toEqual(expected);
    expect(fromEmpty).toEqual(expected);
    expect(fromUndefined).not.toBe(base);
    expect(fromEmpty).not.toBe(base);
  });

  it('keeps only the selected type and disables the others', () => {
    const result = effectiveOverlayVisibility(ALL_VISIBLE, ['word']);

    expect(result.word).toBe(true);
    expect(result.char).toBe(false);
    expect(result.rect).toBe(false);
    expect(result.line).toBe(false);
    expect(result.curve).toBe(false);
    expect(result.image).toBe(false);
    expect(result.table).toBe(false);
  });

  it('keeps several selected types visible', () => {
    const result = effectiveOverlayVisibility(ALL_VISIBLE, ['word', 'line']);

    expect(result.word).toBe(true);
    expect(result.line).toBe(true);
    expect(result.char).toBe(false);
    expect(result.rect).toBe(false);
  });

  it('stays off when the toolbar disabled the selected type', () => {
    const base = { ...ALL_VISIBLE, word: false };
    const result = effectiveOverlayVisibility(base, ['word']);

    expect(result.word).toBe(false);
  });

  it('drops a selected type the toolbar does not know about', () => {
    const base = { ...ALL_VISIBLE, word: false };
    const result = effectiveOverlayVisibility(base, ['word', 'char']);

    expect(result.word).toBe(false);
    expect(result.char).toBe(true);
  });

  it('does not mutate the toolbar visibility input', () => {
    const base = Object.freeze({ ...ALL_VISIBLE, word: true });
    const snapshot = { ...base };

    effectiveOverlayVisibility(base, ['word']);
    effectiveOverlayVisibility(base);

    expect(base).toEqual(snapshot);
  });
});

describe('overlayObjects', () => {
  const chars = [obj({ type: 'char' }), obj({ type: 'char', x0: 0, y0: 0, x1: 5, y1: 5 })];
  const words = [obj({ type: 'word' } as Partial<PdfObject>)];
  const allObjects = [...chars, ...words];

  const filterSubset = (objects: PdfObject[]): ObjectSubset => ({
    source: 'filter',
    mode: 'intersect',
    objects,
  });

  it('draws only the filter subset objects', () => {
    expect(overlayObjects(allObjects, filterSubset(words))).toEqual(words);
    expect(overlayObjects(allObjects, filterSubset(words))).not.toEqual(allObjects);
  });

  it('draws every object when there is no subset', () => {
    expect(overlayObjects(allObjects, null)).toEqual(allObjects);
  });

  it('keeps the full page context for a region subset', () => {
    const regionSubset: ObjectSubset = {
      source: 'region',
      mode: 'intersect',
      objects: words,
      bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
    };

    expect(overlayObjects(allObjects, regionSubset)).toEqual(allObjects);
  });

  it('returns an empty list when the filter matched nothing', () => {
    expect(overlayObjects(allObjects, filterSubset([]))).toEqual([]);
  });

  it('does not mutate the object lists', () => {
    const all = Object.freeze([...allObjects]) as PdfObject[];
    const subsetObjects = Object.freeze([...words]) as PdfObject[];
    const allSnapshot = [...all];
    const subsetSnapshot = [...subsetObjects];

    overlayObjects(all, filterSubset(subsetObjects));
    overlayObjects(all, null);

    expect(all).toEqual(allSnapshot);
    expect(subsetObjects).toEqual(subsetSnapshot);
  });
});
