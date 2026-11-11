import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_OPTIONS,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_PATTERN_LENGTH,
  SEARCH_INDEX_BATCH_SIZE,
  buildPageText,
  findMatches,
  findMatchesDetailed,
  mapMatchToDivOffsets,
  pageBatches,
  type SearchOptions,
} from '../pdf-search';

const options = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
  ...DEFAULT_SEARCH_OPTIONS,
  ...overrides,
});

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

describe('findMatchesDetailed', () => {
  const offsets = (result: { matches: Array<{ page: number; begin: number; length: number }> }) =>
    result.matches.map(({ page, begin, length }) => ({ page, begin, length }));

  describe('empty and default behaviour', () => {
    it('returns an empty, error-free result for an empty or whitespace query', () => {
      const pages = ['hello world'];
      expect(findMatchesDetailed(pages, '')).toEqual({
        matches: [],
        truncated: false,
        total: 0,
        error: null,
      });
      expect(findMatchesDetailed(pages, '   \n ')).toEqual({
        matches: [],
        truncated: false,
        total: 0,
        error: null,
      });
    });

    it('defaults to case-insensitive literal matching', () => {
      const result = findMatchesDetailed(['Hello hello HELLO'], 'hello');
      expect(offsets(result)).toEqual([
        { page: 1, begin: 0, length: 5 },
        { page: 1, begin: 6, length: 5 },
        { page: 1, begin: 12, length: 5 },
      ]);
      expect(result.error).toBeNull();
      expect(result.truncated).toBe(false);
      expect(result.total).toBe(3);
    });

    it('reports page order and within-page offset order', () => {
      const result = findMatchesDetailed(['aa aa', 'nothing', 'aaa aa'], 'aa');
      expect(offsets(result)).toEqual([
        { page: 1, begin: 0, length: 2 },
        { page: 1, begin: 3, length: 2 },
        { page: 3, begin: 0, length: 2 },
        { page: 3, begin: 4, length: 2 },
      ]);
    });

    it('never matches across a page boundary', () => {
      // "end" + "start" would match if pages were joined.
      const pages = ['the end', 'start here'];
      expect(findMatchesDetailed(pages, 'endstart').matches).toEqual([]);
      expect(findMatches(['the end', 'start here'], 'endstart')).toEqual([]);
    });

    it('matches a literal newline inside one page', () => {
      expect(offsets(findMatchesDetailed(['Hello\nWorld'], 'lo\nWo'))).toEqual([
        { page: 1, begin: 3, length: 5 },
      ]);
    });

    it('treats regex metacharacters literally in literal mode', () => {
      const pages = ['cost is $5.00 (approx) a+b'];
      expect(offsets(findMatchesDetailed(pages, '$5.00'))).toEqual([
        { page: 1, begin: 8, length: 5 },
      ]);
      expect(offsets(findMatchesDetailed(pages, '(approx)'))).toEqual([
        { page: 1, begin: 14, length: 8 },
      ]);
      expect(offsets(findMatchesDetailed(pages, 'a+b'))).toEqual([
        { page: 1, begin: 23, length: 3 },
      ]);
      // '.' is a literal dot, not "any character".
      expect(findMatchesDetailed(pages, '5x00').matches).toEqual([]);
    });

    it('collapses whitespace-heavy page text without a failing offset', () => {
      const pages = ['alpha\n\n beta   beta'];
      expect(offsets(findMatchesDetailed(pages, 'beta'))).toEqual([
        { page: 1, begin: 8, length: 4 },
        { page: 1, begin: 15, length: 4 },
      ]);
    });
  });

  describe('caseSensitive', () => {
    it('only reports exact-case hits when enabled', () => {
      const pages = ['Hello hello HELLO'];
      expect(offsets(findMatchesDetailed(pages, 'hello', options({ caseSensitive: true })))).toEqual([
        { page: 1, begin: 6, length: 5 },
      ]);
      expect(
        offsets(findMatchesDetailed(pages, 'Hello', options({ caseSensitive: true }))),
      ).toEqual([{ page: 1, begin: 0, length: 5 }]);
    });

    it('applies to regex mode too', () => {
      const pages = ['Hello HELLO'];
      expect(
        offsets(findMatchesDetailed(pages, 'hello', options({ regex: true, caseSensitive: true }))),
      ).toEqual([]);
      expect(
        offsets(
          findMatchesDetailed(pages, 'hello', options({ regex: true, caseSensitive: false })),
        ),
      ).toEqual([
        { page: 1, begin: 0, length: 5 },
        { page: 1, begin: 6, length: 5 },
      ]);
    });
  });

  describe('wholeWord', () => {
    it('requires non-word characters around Latin hits', () => {
      const pages = ['cover over coverage over'];
      expect(offsets(findMatchesDetailed(pages, 'over', options({ wholeWord: true })))).toEqual([
        { page: 1, begin: 6, length: 4 },
        { page: 1, begin: 20, length: 4 },
      ]);
    });

    it('treats underscores as word characters', () => {
      expect(
        findMatchesDetailed(['foo_bar foo'], 'foo', options({ wholeWord: true })).matches,
      ).toHaveLength(1);
    });

    it('matches standalone Chinese words only', () => {
      // 书签 inside 书签单 is part of a longer word, so only the standalone hits count.
      const pages = ['书签：目录 书签单 书签'];
      expect(offsets(findMatchesDetailed(pages, '书签', options({ wholeWord: true })))).toEqual([
        { page: 1, begin: 0, length: 2 },
        { page: 1, begin: 10, length: 2 },
      ]);
      // ...while the default literal mode finds all three.
      expect(findMatchesDetailed(pages, '书签').matches).toHaveLength(3);
    });

    it('combines with case insensitivity and regex mode', () => {
      const pages = ['Cat cat catalog cat.'];
      expect(
        offsets(findMatchesDetailed(pages, 'cat', options({ wholeWord: true }))),
      ).toEqual([
        { page: 1, begin: 0, length: 3 },
        { page: 1, begin: 4, length: 3 },
        { page: 1, begin: 16, length: 3 },
      ]);
      // A whole-word regex needs real boundaries; `c1` is one word, so only the
      // standalone numbers count.
      expect(
        offsets(findMatchesDetailed(['c1 22 c333'], '\\d+', options({ regex: true, wholeWord: true }))),
      ).toEqual([{ page: 1, begin: 3, length: 2 }]);
    });
  });

  describe('regex mode', () => {
    it('uses the user pattern as written', () => {
      const result = findMatchesDetailed(['a1 b22 c333'], '\\d+', options({ regex: true }));
      expect(offsets(result)).toEqual([
        { page: 1, begin: 1, length: 1 },
        { page: 1, begin: 4, length: 2 },
        { page: 1, begin: 8, length: 3 },
      ]);
      expect(result.error).toBeNull();
    });

    it('supports character classes and alternation across pages', () => {
      expect(
        offsets(findMatchesDetailed(['cat', 'dog'], 'cat|dog', options({ regex: true }))),
      ).toEqual([
        { page: 1, begin: 0, length: 3 },
        { page: 2, begin: 0, length: 3 },
      ]);
    });

    it('reports an invalid pattern as an error instead of throwing', () => {
      const result = findMatchesDetailed(['anything'], '(', options({ regex: true }));
      expect(result.matches).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.error).toMatch(/^Invalid regular expression: \(/);
    });

    it('reports unbalanced brackets and quantifiers as errors', () => {
      for (const pattern of ['[a-', '*bad', 'a{2,1}']) {
        const result = findMatchesDetailed(['aaa'], pattern, options({ regex: true }));
        expect(result.error).toMatch(/^Invalid regular expression/);
        expect(result.matches).toEqual([]);
      }
    });

    it('skips zero-length matches and still terminates', () => {
      // `(?:)` matches at every position with zero width: nothing to highlight.
      expect(findMatchesDetailed(['abc'], '(?:)', options({ regex: true })).matches).toEqual([]);
      // `a*` can match the empty string; only the real hit is reported.
      expect(offsets(findMatchesDetailed(['ba'], 'a*', options({ regex: true })))).toEqual([
        { page: 1, begin: 1, length: 1 },
      ]);
      // Word boundaries are zero-width too, so a page walk reports nothing.
      expect(findMatchesDetailed(['x\ny'], '\\b', options({ regex: true }))).toEqual({
        matches: [],
        truncated: false,
        total: 0,
        error: null,
      });
    });

    it('keeps code point alignment while skipping zero-length matches', () => {
      // Astral characters are two code units each: the skip must not stall in
      // the middle of a surrogate pair, and must not loop either.
      const result = findMatchesDetailed(['😀😀a'], '😀*', options({ regex: true }));
      expect(offsets(result)).toEqual([{ page: 1, begin: 0, length: 4 }]);
      expect(result.error).toBeNull();
      expect(findMatchesDetailed(['😀😀a'], 'x*', options({ regex: true })).matches).toEqual([]);
    });
  });

  describe('limits', () => {
    it('rejects an over-long pattern before searching', () => {
      const pages = ['needle'];
      const result = findMatchesDetailed(pages, 'a'.repeat(MAX_SEARCH_PATTERN_LENGTH + 1));
      expect(result.matches).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.error).toContain(String(MAX_SEARCH_PATTERN_LENGTH));
    });

    it('accepts a pattern exactly at the limit', () => {
      const result = findMatchesDetailed(['needle'], 'a'.repeat(MAX_SEARCH_PATTERN_LENGTH));
      expect(result.error).toBeNull();
      expect(result.matches).toEqual([]);
    });

    it('applies the limit to regex patterns too', () => {
      const result = findMatchesDetailed(
        ['abc'],
        'a'.repeat(MAX_SEARCH_PATTERN_LENGTH + 5),
        options({ regex: true }),
      );
      expect(result.error).not.toBeNull();
      expect(result.matches).toEqual([]);
    });

    it('caps the hit list and reports truncation', () => {
      const pages = ['a'.repeat(MAX_SEARCH_MATCHES + 25)];
      const result = findMatchesDetailed(pages, 'a');
      expect(result.matches).toHaveLength(MAX_SEARCH_MATCHES);
      expect(result.total).toBe(MAX_SEARCH_MATCHES);
      expect(result.truncated).toBe(true);
      expect(result.error).toBeNull();
    });

    it('caps across pages, keeping page order', () => {
      const pages = Array.from({ length: 3 }, () => 'a'.repeat(2000));
      const result = findMatchesDetailed(pages, 'a');
      expect(result.matches).toHaveLength(MAX_SEARCH_MATCHES);
      expect(result.truncated).toBe(true);
      expect(result.matches[0].page).toBe(1);
      expect(result.matches[result.matches.length - 1].page).toBe(3);
    });

    it('does not report truncation for a small result', () => {
      const result = findMatchesDetailed(['a a a'], 'a');
      expect(result.matches).toHaveLength(3);
      expect(result.truncated).toBe(false);
    });
  });

  describe('preview', () => {
    it('shows about 36 characters of context on each side', () => {
      const text = `${'a'.repeat(50)}needle${'b'.repeat(50)}`;
      const [match] = findMatchesDetailed([text], 'needle').matches;
      expect(match.preview).toBe(`…${'a'.repeat(36)}needle${'b'.repeat(36)}…`);
    });

    it('omits ellipses when the whole page fits', () => {
      const [match] = findMatchesDetailed(['alpha beta needle gamma'], 'needle').matches;
      expect(match.preview).toBe('alpha beta needle gamma');
    });

    it('collapses newlines and runs of whitespace', () => {
      const [match] = findMatchesDetailed(['alpha\n\nbeta   needle\n\ngamma'], 'needle').matches;
      expect(match.preview).toBe('alpha beta needle gamma');
    });

    it('keeps the hit inside the preview for a regex match', () => {
      const text = `${'x'.repeat(60)}abc123${'y'.repeat(60)}`;
      const [match] = findMatchesDetailed([text], 'abc\\d+', options({ regex: true })).matches;
      expect(match.preview).toContain('abc123');
      expect(match.preview?.startsWith('…')).toBe(true);
      expect(match.preview?.endsWith('…')).toBe(true);
    });

    it('is not part of the backward-compatible findMatches result', () => {
      const [match] = findMatches(['hello world'], 'world');
      expect(match).toEqual({ page: 1, begin: 6, length: 5 });
      expect('preview' in match).toBe(false);
      expect(Object.keys(match)).toEqual(['page', 'begin', 'length']);
    });
  });
});

describe('findMatches (compatibility wrapper)', () => {
  const pages = ['Hello World\nfoo bar', 'nothing here', 'say HELLO again hello'];

  it('still returns bare offsets', () => {
    expect(findMatches(pages, 'hello')).toEqual([
      { page: 1, begin: 0, length: 5 },
      { page: 3, begin: 4, length: 5 },
      { page: 3, begin: 16, length: 5 },
    ]);
  });

  it('forwards options and drops the preview of the detailed result', () => {
    expect(findMatches(['Hello hello'], 'hello', { ...DEFAULT_SEARCH_OPTIONS, caseSensitive: true })).toEqual([
      { page: 1, begin: 6, length: 5 },
    ]);
    expect(findMatches(['cover over'], 'over', { ...DEFAULT_SEARCH_OPTIONS, wholeWord: true })).toEqual([
      { page: 1, begin: 6, length: 4 },
    ]);
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
