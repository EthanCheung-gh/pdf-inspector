export interface SearchMatch {
  /** 1-based page number. */
  page: number;
  /** Offset into the page's joined text (see buildPageText). */
  begin: number;
  /** Match length in characters. */
  length: number;
  /** Whitespace-normalized context around the hit, for the results panel. */
  preview?: string;
}

/** How the query is interpreted; a user preference, not document state. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/**
 * Hard cap on reported hits. A query like `e` can match tens of thousands of
 * times in a book; the UI only needs enough to be useful, and stopping early
 * keeps the main thread responsive.
 */
export const MAX_SEARCH_MATCHES = 5000;

/** Patterns longer than this are rejected before running: a cheap guard against catastrophic backtracking. */
export const MAX_SEARCH_PATTERN_LENGTH = 500;

/** Characters of context kept on each side of a hit in `preview`. */
const PREVIEW_CONTEXT_CHARS = 36;

export interface SearchResultSet {
  matches: SearchMatch[];
  /** True once `MAX_SEARCH_MATCHES` was reached; `total` is then a lower bound. */
  truncated: boolean;
  /** Matches collected (never more than `MAX_SEARCH_MATCHES`). */
  total: number;
  /** Human-readable reason the search could not run, or null. */
  error: string | null;
}

/** Join PDF.js text items into one searchable string per page. */
export function buildPageText(textItems: string[]): string {
  return textItems.join('\n');
}

/**
 * Pages per index batch. Small enough that the UI can repaint and honour a
 * cancel request between batches on a 1000-page document.
 */
export const SEARCH_INDEX_BATCH_SIZE = 10;

/**
 * Split `total` pages into inclusive 1-based batches, e.g. 25 pages with a
 * batch size of 10 yields [[1,10],[11,20],[21,25]]. The last batch is short
 * rather than padded, so progress never reports pages that do not exist.
 */
export function pageBatches(
  total: number,
  batchSize: number = SEARCH_INDEX_BATCH_SIZE,
): Array<[number, number]> {
  if (!Number.isFinite(total) || total < 1) return [];
  const size = Math.max(1, Math.floor(batchSize));
  const batches: Array<[number, number]> = [];
  for (let start = 1; start <= total; start += size) {
    batches.push([start, Math.min(start + size - 1, total)]);
  }
  return batches;
}

/** Escape `value` so it matches literally inside a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the RegExp source for a query. Whole-word uses Unicode letter/number
 * boundaries rather than `\b`: `over` refuses to match `cover`, and `书签` only
 * matches as a standalone Chinese word (`书签单` is a different word).
 */
function buildPatternSource(query: string, options: SearchOptions): string {
  const source = options.regex ? query : escapeRegExp(query);
  return options.wholeWord
    ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
    : source;
}

function buildFlags(options: SearchOptions): string {
  // `u` keeps `\p{…}` classes and code point offsets correct; `g` is what makes
  // `lastIndex` advance match by match within a page.
  return options.caseSensitive ? 'gu' : 'giu';
}

/** Step past one code point so a zero-length match cannot loop in `u` mode. */
function advanceIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return index + 2;
  }
  return index + 1;
}

/** Roughly `PREVIEW_CONTEXT_CHARS` of collapsed context on each side of a hit. */
function buildPreview(text: string, begin: number, end: number): string {
  const start = Math.max(0, begin - PREVIEW_CONTEXT_CHARS);
  const stop = Math.min(text.length, end + PREVIEW_CONTEXT_CHARS);
  const collapsed = text.slice(start, stop).replace(/\s+/gu, ' ').trim();
  const leading = start > 0 ? '…' : '';
  const trailing = stop < text.length ? '…' : '';
  return `${leading}${collapsed}${trailing}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EMPTY_RESULT: SearchResultSet = { matches: [], truncated: false, total: 0, error: null };

/**
 * Search every page with the given options and report truncation and pattern
 * errors alongside the hits.
 *
 * Matches never span pages: each page is scanned independently, so a hit is
 * always highlightable inside one page's text layer. Hits come back in page
 * order and, within a page, in offset order.
 */
export function findMatchesDetailed(
  pageTexts: string[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): SearchResultSet {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ...EMPTY_RESULT };

  // Literal searches keep the historical "type a padded phrase" behaviour by
  // dropping surrounding whitespace. A regex is taken verbatim: `\s`, ` $` and
  // friends make whitespace part of the expression the user wrote.
  const pattern = options.regex ? query : trimmed;
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    return {
      ...EMPTY_RESULT,
      error: `Search pattern is too long: ${pattern.length} characters (maximum ${MAX_SEARCH_PATTERN_LENGTH}).`,
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(buildPatternSource(pattern, options), buildFlags(options));
  } catch (err) {
    return {
      ...EMPTY_RESULT,
      error: `Invalid regular expression: ${pattern} (${describeError(err)})`,
    };
  }

  const matches: SearchMatch[] = [];
  let truncated = false;
  try {
    for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex += 1) {
      const text = pageTexts[pageIndex] ?? '';
      if (text.length === 0) continue;
      re.lastIndex = 0;
      let match = re.exec(text);
      while (match !== null) {
        if (match[0].length === 0) {
          // `(?:)`-style patterns match everywhere without consuming anything;
          // report nothing and walk to the next code point instead of looping.
          re.lastIndex = advanceIndex(text, re.lastIndex);
          match = re.exec(text);
          continue;
        }
        const begin = match.index;
        const end = begin + match[0].length;
        matches.push({
          page: pageIndex + 1,
          begin,
          length: match[0].length,
          preview: buildPreview(text, begin, end),
        });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
        match = re.exec(text);
      }
      if (truncated) break;
    }
  } catch (err) {
    // Whatever the engine threw, search must not take the renderer down.
    return { matches: [], truncated: false, total: 0, error: `Search failed: ${describeError(err)}` };
  }

  return { matches, truncated, total: matches.length, error: null };
}

/**
 * Backward-compatible helper: the hit list without previews, so callers that
 * only need offsets (and tests comparing exact objects) are unaffected.
 */
export function findMatches(
  pageTexts: string[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): SearchMatch[] {
  return findMatchesDetailed(pageTexts, query, options).matches.map(
    ({ page, begin, length }): SearchMatch => ({ page, begin, length }),
  );
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
