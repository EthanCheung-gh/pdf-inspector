import { describe, expect, it } from 'vitest';
import { translate, type TranslateFn } from '../../i18n';
import { describeFilterCriteria } from '../filter-summary';

const tZh: TranslateFn = (key, params) => translate('zh-CN', key, params);

describe('describeFilterCriteria', () => {
  it('reports an empty summary for no criteria', () => {
    expect(describeFilterCriteria({})).toEqual({ count: 0, parts: [], label: '' });
  });

  it('lists font, size, color and type tokens in a stable order', () => {
    const summary = describeFilterCriteria({
      fontname: 'Inter',
      sizeMin: 12,
      sizeMax: 18,
      color: '#000000',
      types: ['word', 'rect'],
    });

    expect(summary.count).toBe(4);
    expect(summary.label).toBe('Inter · 12–18pt · #000000 · 2 types');
  });

  it('counts a size range as one condition and formats open ranges', () => {
    expect(describeFilterCriteria({ sizeMin: 12 }).label).toBe('≥12pt');
    expect(describeFilterCriteria({ sizeMax: 18 }).label).toBe('≤18pt');
    expect(describeFilterCriteria({ sizeMin: 12, sizeMax: 18 }).count).toBe(1);
    expect(describeFilterCriteria({ sizeMin: 12, sizeMax: 12 }).label).toBe('12pt');
  });

  it('uses the singular type label for one selected type', () => {
    const summary = describeFilterCriteria({ types: ['image'] });
    expect(summary.count).toBe(1);
    expect(summary.label).toBe('1 type');
  });

  it('ignores an empty type list and non-finite sizes', () => {
    const summary = describeFilterCriteria({
      types: [],
      sizeMin: Number.NaN,
      sizeMax: Number.POSITIVE_INFINITY,
    });
    expect(summary).toEqual({ count: 0, parts: [], label: '' });
  });

  it('translates only the type-count token and keeps the summary semantics', () => {
    const plural = describeFilterCriteria(
      { fontname: 'Inter', sizeMin: 12, sizeMax: 18, color: '#000000', types: ['word', 'rect'] },
      tZh,
    );
    expect(plural.count).toBe(4);
    expect(plural.parts).toEqual(['Inter', '12–18pt', '#000000', '2 种类型']);
    expect(plural.label).toBe('Inter · 12–18pt · #000000 · 2 种类型');

    const singular = describeFilterCriteria({ types: ['image'] }, tZh);
    expect(singular.count).toBe(1);
    expect(singular.label).toBe('1 种类型');

    // The English default stays byte-identical for callers without a translator.
    expect(describeFilterCriteria({ types: ['image'] }).label).toBe('1 type');
  });
});
