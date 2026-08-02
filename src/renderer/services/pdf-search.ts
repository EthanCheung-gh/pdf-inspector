export interface SearchMatch {
  /** 1-based page number. */
  page: number;
  /** Offset into the page's joined text (see buildPageText). */
  begin: number;
  /** Match length in characters. */
  length: number;
}

/** Join PDF.js text items into one searchable string per page. */
export function buildPageText(textItems: string[]): string {
  return textItems.join('\n');
}

/** Case-insensitive, non-overlapping search across all pages. */
export function findMatches(pageTexts: string[], query: string): SearchMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const matches: SearchMatch[] = [];
  pageTexts.forEach((text, index) => {
    const haystack = text.toLowerCase();
    let from = 0;
    while (from + q.length <= haystack.length) {
      const at = haystack.indexOf(q, from);
      if (at === -1) break;
      matches.push({ page: index + 1, begin: at, length: q.length });
      from = at + q.length;
    }
  });
  return matches;
}

export interface DivRange {
  divIndex: number;
  /** Start offset within the div's own text. */
  start: number;
  /** End offset (exclusive) within the div's own text. */
  end: number;
}

/**
 * Map a character range in joined page text onto rendered text divs.
 * `divTexts` must be the divs' textContents in DOM order — joined with '\n'
 * they reproduce the page text that `findMatches` searched.
 */
export function mapMatchToDivOffsets(
  match: { begin: number; length: number },
  divTexts: string[],
): DivRange[] {
  const ranges: DivRange[] = [];
  const matchEnd = match.begin + match.length;
  let offset = 0;

  divTexts.forEach((text, divIndex) => {
    const divStart = offset;
    const divEnd = offset + text.length;
    const start = Math.max(match.begin, divStart);
    const end = Math.min(matchEnd, divEnd);
    if (start < end) {
      ranges.push({ divIndex, start: start - divStart, end: end - divStart });
    }
    offset = divEnd + 1; // +1 for the '\n' separator from buildPageText
  });

  return ranges;
}
