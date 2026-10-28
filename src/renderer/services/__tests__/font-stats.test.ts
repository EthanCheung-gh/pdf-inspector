import { describe, expect, it, vi } from 'vitest';
import type { FontStat } from '../../types/ipc-protocol';
import {
  FONT_ANALYSIS_BATCH_SIZE,
  analyzeFontsInBatches,
  formatFontSize,
  mergeFontStats,
} from '../font-stats';
import type { FontBatchProgress } from '../font-stats';

const stat = (overrides: Partial<FontStat> & { fontname: string }): FontStat => ({
  pages: [1],
  charCount: 1,
  sizeMin: 10,
  sizeMax: 10,
  colors: ['#000000'],
  ...overrides,
});

describe('mergeFontStats', () => {
  it('returns a copy of the base when the batch is empty', () => {
    const base = [stat({ fontname: 'Helvetica', pages: [1, 2], charCount: 5 })];
    const merged = mergeFontStats(base, []);
    expect(merged).toEqual(base);
    expect(merged[0]).not.toBe(base[0]);
    expect(merged[0].pages).not.toBe(base[0].pages);
  });

  it('sums char counts, unions pages ascending and widens the size range', () => {
    const base = [stat({ fontname: 'Helvetica', pages: [5, 1], charCount: 10, sizeMin: 9, sizeMax: 12 })];
    const batch = [stat({ fontname: 'Helvetica', pages: [2, 5, 11], charCount: 7, sizeMin: 8, sizeMax: 18 })];

    const merged = mergeFontStats(base, batch);

    expect(merged).toHaveLength(1);
    expect(merged[0].charCount).toBe(17);
    expect(merged[0].pages).toEqual([1, 2, 5, 11]);
    expect(merged[0].sizeMin).toBe(8);
    expect(merged[0].sizeMax).toBe(18);
  });

  it('unions colors in first-seen order (base first, then batch)', () => {
    const base = [stat({ fontname: 'Helvetica', colors: ['#000000', '#ff0000'] })];
    const batch = [stat({ fontname: 'Helvetica', colors: ['#ff0000', '#00ff00', '#0000ff'] })];

    expect(mergeFontStats(base, batch)[0].colors).toEqual(['#000000', '#ff0000', '#00ff00', '#0000ff']);
  });

  it('adds fonts that are only in the batch and keeps non-matching sizes untouched', () => {
    const base = [stat({ fontname: 'Helvetica', charCount: 3 })];
    const batch = [stat({ fontname: 'Times-Roman', pages: [3], charCount: 20, sizeMin: 4, sizeMax: 6 })];

    const merged = mergeFontStats(base, batch);

    expect(merged.map((entry) => entry.fontname)).toEqual(['Times-Roman', 'Helvetica']);
    expect(merged[1]).toEqual(base[0]);
  });

  it('sorts by char count descending and keeps first-seen order on ties', () => {
    const base = [stat({ fontname: 'First', charCount: 5 }), stat({ fontname: 'Second', charCount: 50 })];
    const batch = [stat({ fontname: 'Third', charCount: 5 }), stat({ fontname: 'Fourth', charCount: 1 })];

    expect(mergeFontStats(base, batch).map((entry) => entry.fontname)).toEqual([
      'Second',
      'First',
      'Third',
      'Fourth',
    ]);
  });

  it('does not mutate its inputs', () => {
    const base = [stat({ fontname: 'Helvetica', pages: [1], charCount: 10, colors: ['#000000'] })];
    const batch = [stat({ fontname: 'Helvetica', pages: [2], charCount: 5, colors: ['#ff0000'] })];
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    const batchSnapshot = JSON.parse(JSON.stringify(batch));

    const merged = mergeFontStats(base, batch);
    merged[0].pages.push(99);
    merged[0].colors.push('#123456');

    expect(base).toEqual(baseSnapshot);
    expect(batch).toEqual(batchSnapshot);
  });
});

describe('analyzeFontsInBatches', () => {
  it('defaults to 10-page batches', () => {
    expect(FONT_ANALYSIS_BATCH_SIZE).toBe(10);
  });

  it('walks a 25-page document in 10-page batches and reports progress', async () => {
    const calls: Array<[number, number]> = [];
    const progress: FontBatchProgress[] = [];
    const fetchBatch = vi.fn(async (startPage: number, endPage: number) => {
      calls.push([startPage, endPage]);
      return [stat({ fontname: 'Helvetica', pages: [startPage], charCount: endPage - startPage + 1 })];
    });

    const result = await analyzeFontsInBatches({
      totalPages: 25,
      fetchBatch,
      onProgress: (value) => progress.push(value),
    });

    expect(calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(progress).toEqual([
      { done: 0, total: 25 },
      { done: 10, total: 25 },
      { done: 20, total: 25 },
      { done: 25, total: 25 },
    ]);
    expect(result).toEqual([
      stat({ fontname: 'Helvetica', pages: [1, 11, 21], charCount: 25 }),
    ]);
  });

  it('honours a custom batch size', async () => {
    const calls: Array<[number, number]> = [];
    const fetchBatch = async (startPage: number, endPage: number): Promise<FontStat[]> => {
      calls.push([startPage, endPage]);
      return [];
    };

    await analyzeFontsInBatches({ totalPages: 7, batchSize: 3, fetchBatch });

    expect(calls).toEqual([
      [1, 3],
      [4, 6],
      [7, 7],
    ]);
  });

  it('returns an empty list and reports 0/0 for an empty document', async () => {
    const fetchBatch = vi.fn(async () => [stat({ fontname: 'Helvetica' })]);
    const progress: FontBatchProgress[] = [];

    const result = await analyzeFontsInBatches({
      totalPages: 0,
      fetchBatch,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toEqual([]);
    expect(progress).toEqual([{ done: 0, total: 0 }]);
    expect(fetchBatch).not.toHaveBeenCalled();
  });

  it('stops after the batch in flight when cancelled and returns null', async () => {
    let cancelled = false;
    const fetchBatch = vi.fn(async (startPage: number) => {
      cancelled = true;
      return [stat({ fontname: 'Helvetica', pages: [startPage] })];
    });

    const result = await analyzeFontsInBatches({
      totalPages: 30,
      fetchBatch,
      isCancelled: () => cancelled,
    });

    expect(result).toBeNull();
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch at all when cancelled up front', async () => {
    const fetchBatch = vi.fn(async () => [stat({ fontname: 'Helvetica' })]);

    const result = await analyzeFontsInBatches({
      totalPages: 30,
      fetchBatch,
      isCancelled: () => true,
    });

    expect(result).toBeNull();
    expect(fetchBatch).not.toHaveBeenCalled();
  });

  it('propagates fetch errors', async () => {
    const fetchBatch = vi.fn(async () => {
      throw new Error('sidecar exploded');
    });

    await expect(analyzeFontsInBatches({ totalPages: 15, fetchBatch })).rejects.toThrow(
      'sidecar exploded',
    );
  });

  it('matches a single full-document batch for the same data', async () => {
    const perPage: FontStat[][] = [
      [stat({ fontname: 'Helvetica', pages: [1], charCount: 4, sizeMin: 9, sizeMax: 11, colors: ['#000000'] })],
      [stat({ fontname: 'Helvetica', pages: [2], charCount: 6, sizeMin: 8, sizeMax: 14, colors: ['#ff0000'] })],
      [stat({ fontname: 'Times-Roman', pages: [3], charCount: 2, colors: ['#00ff00', '#000000'] })],
      [stat({ fontname: 'Helvetica', pages: [4], charCount: 1, sizeMin: 12, sizeMax: 12 })],
    ];
    const pageRange = (startPage: number, endPage: number): FontStat[] =>
      perPage.slice(startPage - 1, endPage).flat();

    const batched = await analyzeFontsInBatches({
      totalPages: 4,
      batchSize: 2,
      fetchBatch: async (startPage, endPage) => pageRange(startPage, endPage),
    });
    const single = await analyzeFontsInBatches({
      totalPages: 4,
      batchSize: 4,
      fetchBatch: async (startPage, endPage) => pageRange(startPage, endPage),
    });

    expect(batched).toEqual(single);
    expect(batched).toEqual([
      stat({ fontname: 'Helvetica', pages: [1, 2, 4], charCount: 11, sizeMin: 8, sizeMax: 14, colors: ['#000000', '#ff0000'] }),
      stat({ fontname: 'Times-Roman', pages: [3], charCount: 2, sizeMin: 10, sizeMax: 10, colors: ['#00ff00', '#000000'] }),
    ]);
  });
});

describe('formatFontSize', () => {
  it('hides float noise from pdfplumber sizes', () => {
    expect(formatFontSize(12.000000000000002)).toBe('12');
    expect(formatFontSize(10.999999999999998)).toBe('11');
  });

  it('keeps at most two decimals', () => {
    expect(formatFontSize(12.5)).toBe('12.5');
    expect(formatFontSize(12.345)).toBe('12.35');
    expect(formatFontSize(9.999)).toBe('10');
  });

  it('handles non-finite values without printing NaN', () => {
    expect(formatFontSize(Number.NaN)).toBe('0');
    expect(formatFontSize(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
