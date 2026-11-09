import { describe, expect, it } from 'vitest';
import {
  SEARCH_INDEX_BATCH_SIZE,
  buildPageText,
  findMatches,
  mapMatchToDivOffsets,
  pageBatches,
} from '../pdf-search';

describe('pageBatches', () => {
  it('splits pages into inclusive 10-page batches with a short final batch', () => {
    expect(pageBatches(25)).toEqual([[1, 10], [11, 20], [21, 25]]);
  });

  it('defaults to the exported batch size', () => {
    const [first] = pageBatches(500);
    expect(first[1] - first[0] + 1).toBe(SEARCH_INDEX_BATCH_SIZE);
    expect(pageBatches(500)).toHaveLength(50);
  });

  it('covers every page exactly once', () => {
    const covered = pageBatches(1003).flatMap(([start, end]) =>
      Array.from({ length: end - start + 1 }, (_, index) => start + index),
    );
    expect(covered).toHaveLength(1003);
    expect(covered[0]).toBe(1);
    expect(covered[covered.length - 1]).toBe(1003);
  });

  it('returns a single batch when the document fits', () => {
    expect(pageBatches(7)).toEqual([[1, 7]]);
  });

  it('returns no batches for an empty or invalid page count', () => {
    expect(pageBatches(0)).toEqual([]);
    expect(pageBatches(-3)).toEqual([]);
    expect(pageBatches(Number.NaN)).toEqual([]);
  });
});

describe('buildPageText', () => {
  it('joins items with newline so items never merge', () => {
    expect(buildPageText(['Hello', 'World'])).toBe('Hello\nWorld');
  });

  it('returns empty string for no items', () => {
    expect(buildPageText([])).toBe('');
  });
});

describe('findMatches', () => {
  const pages = ['Hello World\nfoo bar', 'nothing here', 'say HELLO again hello'];

  it('finds case-insensitive matches across pages, ordered by page then offset', () => {
    expect(findMatches(pages, 'hello')).toEqual([
      { page: 1, begin: 0, length: 5 },
      { page: 3, begin: 4, length: 5 },
      { page: 3, begin: 16, length: 5 },
    ]);
  });

  it('finds matches spanning item boundaries', () => {
    expect(findMatches(['Hello\nWorld'], 'lo\nWo')).toEqual([{ page: 1, begin: 3, length: 5 }]);
  });

  it('returns empty array for empty or whitespace query', () => {
    expect(findMatches(pages, '')).toEqual([]);
    expect(findMatches(pages, '   ')).toEqual([]);
  });

  it('returns empty array when nothing matches', () => {
    expect(findMatches(pages, 'zzz')).toEqual([]);
  });

  it('matches Chinese text', () => {
    expect(findMatches(['结构树与书签'], '书签')).toEqual([{ page: 1, begin: 4, length: 2 }]);
  });
});

describe('mapMatchToDivOffsets', () => {
  // divTexts joined with '\n' == page text: 'Hello\nWorld'
  const divTexts = ['Hello', 'World'];

  it('maps a whole-div match', () => {
    expect(mapMatchToDivOffsets({ begin: 0, length: 5 }, divTexts)).toEqual([
      { divIndex: 0, start: 0, end: 5 },
    ]);
  });

  it('maps a partial-div match', () => {
    expect(mapMatchToDivOffsets({ begin: 1, length: 3 }, divTexts)).toEqual([
      { divIndex: 0, start: 1, end: 4 },
    ]);
  });

  it('maps a match spanning two divs', () => {
    expect(mapMatchToDivOffsets({ begin: 3, length: 5 }, divTexts)).toEqual([
      { divIndex: 0, start: 3, end: 5 },
      { divIndex: 1, start: 0, end: 2 },
    ]);
  });
});
