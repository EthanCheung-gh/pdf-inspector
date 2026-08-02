import { describe, expect, it } from 'vitest';
import { buildPageText, findMatches, mapMatchToDivOffsets } from '../pdf-search';

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
