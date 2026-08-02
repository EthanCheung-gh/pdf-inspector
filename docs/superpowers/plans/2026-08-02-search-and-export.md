# Text Search & Data Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-text search (toolbar inline SearchBox, prev/next cross-page navigation, TextLayer highlight) and extraction data export (current page / whole document × JSON / CSV via a new `saveFile` IPC) per `docs/superpowers/specs/2026-08-02-search-and-export-design.md`.

**Architecture:** Renderer-only for search (PDF.js `getTextContent` index + zustand store + TextLayer highlight). Export is renderer-orchestrated: pure serialization functions, existing `extractPage` IPC for whole-document loops, plus one new `saveFile` IPC (constants → types → preload → main handler → client wrapper). The Python sidecar is untouched.

**Tech Stack:** TypeScript 5.5+, React 18 + Zustand 5, PDF.js 4.8.69, Electron 28, Vitest 2, CSS Modules.

**Note (deviation from spec §6.3):** the `saveFile` client wrapper must NOT go through `callWithTimeout` — the save dialog can stay open longer than 30s, and a timeout would wrongly trigger the sidecar-restart path. It calls `window.pdfInspector.saveFile` directly (like `restartSidecar` does).

---

## File Structure — New Files

| File | Purpose |
|------|---------|
| `src/renderer/services/pdf-search.ts` | Pure search/match-mapping functions + `SearchMatch` type |
| `src/renderer/services/__tests__/pdf-search.test.ts` | Unit tests for pdf-search |
| `src/renderer/hooks/usePdfSearch.ts` | Index lifecycle + match navigation hook |
| `src/renderer/components/Toolbar/SearchBox.tsx` | Inline search UI |
| `src/renderer/components/Toolbar/SearchBox.module.css` | SearchBox styles |
| `src/renderer/services/export-data.ts` | Pure JSON/CSV serialization + filename suggestion |
| `src/renderer/services/__tests__/export-data.test.ts` | Unit tests for export-data |
| `src/renderer/components/Toolbar/ExportMenu.tsx` | Export dropdown UI |
| `src/renderer/components/Toolbar/ExportMenu.module.css` | ExportMenu styles |

## File Structure — Modified Files

| File | Changes |
|------|---------|
| `src/renderer/store/pdf-store.ts` | search fields + `exportProgress` + actions; `setFile` resets them |
| `src/renderer/store/__tests__/pdf-store.test.ts` | tests for the new fields/actions |
| `src/renderer/components/Toolbar/Toolbar.tsx` | mount `<SearchBox />` and `<ExportMenu />` before the spacer |
| `src/renderer/App.tsx` | `Ctrl+F` / `Cmd+F` keydown opens search |
| `src/renderer/components/PdfViewport/TextLayer.tsx` | apply/clear search highlights after render and on match-state change |
| `src/renderer/components/PdfViewport/TextLayer.module.css` | `.searchMatch` / `.searchMatchCurrent` styles |
| `src/renderer/components/StatusBar/StatusBar.tsx` | export progress line |
| `src/shared/constants.ts` | `SAVE_FILE` channel |
| `src/renderer/types/ipc-protocol.ts` | `SaveFileRequest`/`SaveFileResult` types + `saveFile` in `IpcApi` |
| `src/preload/index.ts` | `saveFile` bridge |
| `src/main/ipc-handlers.ts` | `saveFile` handler (save dialog + UTF-8 write) |
| `src/renderer/services/ipc-client.ts` | `saveFile` wrapper (NO timeout wrapper — see header note) |

---

### Task 1: `pdf-search.ts` pure functions with tests

**Files:**
- Create: `src/renderer/services/pdf-search.ts`
- Test: `src/renderer/services/__tests__/pdf-search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/services/__tests__/pdf-search.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/services/__tests__/pdf-search.test.ts`
Expected: FAIL — cannot find module `../pdf-search`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/services/pdf-search.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/services/__tests__/pdf-search.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/pdf-search.ts src/renderer/services/__tests__/pdf-search.test.ts
git commit -m "feat: add pure pdf search functions with tests"
```

---

### Task 2: Extend zustand store with search + export state

**Files:**
- Modify: `src/renderer/store/pdf-store.ts`
- Test: `src/renderer/store/__tests__/pdf-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/store/__tests__/pdf-store.test.ts` (keep existing tests untouched; the file already imports `usePdfStore` — check its import block and reuse the same reset pattern the existing tests use):

```typescript
describe('search state', () => {
  it('defaults to empty search state', () => {
    const s = usePdfStore.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchMatches).toEqual([]);
    expect(s.currentMatchIndex).toBe(-1);
    expect(s.searchOpen).toBe(false);
  });

  it('setSearchQuery / setSearchMatches / setCurrentMatchIndex update fields', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('hello');
    s.setSearchMatches([{ page: 2, begin: 3, length: 5 }]);
    s.setCurrentMatchIndex(0);
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('hello');
    expect(after.searchMatches).toEqual([{ page: 2, begin: 3, length: 5 }]);
    expect(after.currentMatchIndex).toBe(0);
  });

  it('clearSearch resets all search fields', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('x');
    s.setSearchMatches([{ page: 1, begin: 0, length: 1 }]);
    s.setCurrentMatchIndex(0);
    s.setSearchOpen(true);
    s.clearSearch();
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('');
    expect(after.searchMatches).toEqual([]);
    expect(after.currentMatchIndex).toBe(-1);
    expect(after.searchOpen).toBe(false);
  });

  it('setFile resets search and export state', () => {
    const s = usePdfStore.getState();
    s.setSearchQuery('leftover');
    s.setSearchMatches([{ page: 1, begin: 0, length: 1 }]);
    s.setExportProgress({ done: 1, total: 5 });
    s.setFile('/tmp/a.pdf', {
      pages: 3, version: '1.7', encrypted: false, page_w: 612, page_h: 792,
      title: '', author: '', producer: '', fonts: [],
    });
    const after = usePdfStore.getState();
    expect(after.searchQuery).toBe('');
    expect(after.searchMatches).toEqual([]);
    expect(after.currentMatchIndex).toBe(-1);
    expect(after.exportProgress).toBeNull();
  });
});

describe('export progress', () => {
  it('setExportProgress sets and clears', () => {
    const s = usePdfStore.getState();
    s.setExportProgress({ done: 2, total: 10 });
    expect(usePdfStore.getState().exportProgress).toEqual({ done: 2, total: 10 });
    s.setExportProgress(null);
    expect(usePdfStore.getState().exportProgress).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: FAIL — `setSearchQuery is not a function` / fields undefined.

- [ ] **Step 3: Implement store changes**

In `src/renderer/store/pdf-store.ts`:

1. Add the import at the top:

```typescript
import type { SearchMatch } from '../services/pdf-search';
```

2. Add to the `PdfState` interface, after the `textSelectionMode: boolean;` line:

```typescript
  // Text search
  searchQuery: string;
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  searchOpen: boolean;

  // Export progress
  exportProgress: { done: number; total: number } | null;
```

3. Add to the actions section of the interface, after `setTextSelectionMode`:

```typescript
  setSearchQuery: (query: string) => void;
  setSearchMatches: (matches: SearchMatch[]) => void;
  setCurrentMatchIndex: (index: number) => void;
  setSearchOpen: (open: boolean) => void;
  clearSearch: () => void;
  setExportProgress: (progress: { done: number; total: number } | null) => void;
```

4. Add initial values after `textSelectionMode: false,`:

```typescript
  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  searchOpen: false,
  exportProgress: null,
```

5. Extend `setFile` — add these fields to its `set({...})` object:

```typescript
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchOpen: false,
      exportProgress: null,
```

6. Add the new actions after `setTextSelectionMode: (mode) => set({ textSelectionMode: mode }),`:

```typescript
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMatches: (matches) => set({ searchMatches: matches }),
  setCurrentMatchIndex: (index) => set({ currentMatchIndex: index }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  clearSearch: () =>
    set({ searchQuery: '', searchMatches: [], currentMatchIndex: -1, searchOpen: false }),
  setExportProgress: (progress) => set({ exportProgress: progress }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: PASS (all old + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/pdf-store.ts src/renderer/store/__tests__/pdf-store.test.ts
git commit -m "feat: add search and export progress state to pdf store"
```

---

### Task 3: `usePdfSearch` hook

**Files:**
- Create: `src/renderer/hooks/usePdfSearch.ts`

This hook is glue between the store, PDF.js, and `usePageNavigation`; it is covered indirectly by the pure-function tests (Task 1) and the manual verification (Task 10), so no dedicated unit test file.

- [ ] **Step 1: Create the hook**

Create `src/renderer/hooks/usePdfSearch.ts`:

```typescript
import { useCallback, useEffect, useRef } from 'react';
import { buildPageText, findMatches } from '../services/pdf-search';
import { usePdfStore } from '../store/pdf-store';
import { usePageNavigation } from './usePageNavigation';

export interface UsePdfSearchReturn {
  setQuery: (query: string) => Promise<void>;
  next: () => void;
  prev: () => void;
  clear: () => void;
}

export function usePdfSearch(): UsePdfSearchReturn {
  const pageTextsRef = useRef<string[] | null>(null);
  const buildIdRef = useRef(0);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);
  const { navigate } = usePageNavigation();

  // Invalidate the index whenever a different document is loaded.
  useEffect(() => {
    pageTextsRef.current = null;
    buildIdRef.current += 1;
  }, [pdfDocRef]);

  const ensureIndex = useCallback(async (): Promise<string[] | null> => {
    if (pageTextsRef.current) return pageTextsRef.current;
    const doc = usePdfStore.getState().pdfDocRef;
    if (!doc) return null;

    const buildId = ++buildIdRef.current;
    const texts: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        if (buildId !== buildIdRef.current) return null; // stale build
        texts.push(buildPageText(content.items.map((item) => item.str)));
      } catch (err) {
        console.warn(`Search index: skipped page ${p}:`, err);
        texts.push('');
      }
    }
    if (buildId !== buildIdRef.current) return null;
    pageTextsRef.current = texts;
    return texts;
  }, []);

  const setQuery = useCallback(
    async (query: string) => {
      const store = usePdfStore.getState();
      store.setSearchQuery(query);
      if (query.trim().length === 0) {
        store.setSearchMatches([]);
        store.setCurrentMatchIndex(-1);
        return;
      }
      const texts = await ensureIndex();
      if (!texts) return;
      // The user kept typing while the index was building; drop stale results.
      if (usePdfStore.getState().searchQuery !== query) return;
      const matches = findMatches(texts, query);
      store.setSearchMatches(matches);
      store.setCurrentMatchIndex(matches.length > 0 ? 0 : -1);
    },
    [ensureIndex],
  );

  const goTo = useCallback(
    (index: number) => {
      const store = usePdfStore.getState();
      const { searchMatches } = store;
      if (searchMatches.length === 0) return;
      const wrapped = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
      store.setCurrentMatchIndex(wrapped);
      const match = searchMatches[wrapped];
      if (match.page !== store.currentPage) {
        void navigate(match.page);
      }
    },
    [navigate],
  );

  const next = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex + 1);
  }, [goTo]);

  const prev = useCallback(() => {
    goTo(usePdfStore.getState().currentMatchIndex - 1);
  }, [goTo]);

  const clear = useCallback(() => {
    usePdfStore.getState().clearSearch();
  }, []);

  return { setQuery, next, prev, clear };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/usePdfSearch.ts
git commit -m "feat: add usePdfSearch hook with lazy cancelable index"
```

---

### Task 4: `SearchBox` component

**Files:**
- Create: `src/renderer/components/Toolbar/SearchBox.tsx`
- Create: `src/renderer/components/Toolbar/SearchBox.module.css`

- [ ] **Step 1: Create the component**

Create `src/renderer/components/Toolbar/SearchBox.tsx`:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePdfSearch } from '../../hooks/usePdfSearch';
import { usePdfStore } from '../../store/pdf-store';
import styles from './SearchBox.module.css';

const DEBOUNCE_MS = 300;

export const SearchBox: React.FC = () => {
  const searchOpen = usePdfStore((s) => s.searchOpen);
  const setSearchOpen = usePdfStore((s) => s.setSearchOpen);
  const searchMatches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);
  const pageCount = usePdfStore((s) => s.pageCount);
  const { setQuery, next, prev, clear } = usePdfSearch();

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => () => window.clearTimeout(debounceRef.current), []);

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => void setQuery(value), DEBOUNCE_MS);
    },
    [setQuery],
  );

  const handleClose = useCallback(() => {
    window.clearTimeout(debounceRef.current);
    setDraft('');
    clear();
    setSearchOpen(false);
  }, [clear, setSearchOpen]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (event.shiftKey) {
          prev();
        } else {
          next();
        }
      } else if (event.key === 'Escape') {
        handleClose();
      }
    },
    [next, prev, handleClose],
  );

  if (!searchOpen) {
    return (
      <button
        className={styles.button}
        type="button"
        onClick={() => setSearchOpen(true)}
        disabled={pageCount === 0}
        title="Search (Ctrl+F)"
      >
        🔍
      </button>
    );
  }

  const countLabel =
    searchMatches.length === 0 ? '0/0' : `${currentMatchIndex + 1}/${searchMatches.length}`;

  return (
    <div className={styles.searchBox} role="search">
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={draft}
        placeholder="Search…"
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.count}>{countLabel}</span>
      <button
        className={styles.button}
        type="button"
        onClick={prev}
        disabled={searchMatches.length === 0}
        title="Previous match (Shift+Enter)"
      >
        ↑
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={next}
        disabled={searchMatches.length === 0}
        title="Next match (Enter)"
      >
        ↓
      </button>
      <button className={styles.button} type="button" onClick={handleClose} title="Close (Esc)">
        ✕
      </button>
    </div>
  );
};
```

- [ ] **Step 2: Create the CSS module**

Create `src/renderer/components/Toolbar/SearchBox.module.css` (reuses the toolbar's visual language — check `Toolbar.module.css` for existing colors and adjust if they differ):

```css
.searchBox {
  display: flex;
  align-items: center;
  gap: 4px;
}

.input {
  width: 160px;
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
}

.input:focus {
  outline: none;
  border-color: #4a90d9;
}

.count {
  min-width: 36px;
  text-align: center;
  font-size: 12px;
  color: #666;
  font-variant-numeric: tabular-nums;
}

.button {
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}

.button:hover:not(:disabled) {
  background: #f0f0f0;
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Toolbar/SearchBox.tsx src/renderer/components/Toolbar/SearchBox.module.css
git commit -m "feat: add SearchBox component"
```

---

### Task 5: Wire SearchBox into Toolbar + `Ctrl+F` in App

**Files:**
- Modify: `src/renderer/components/Toolbar/Toolbar.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Mount SearchBox in the Toolbar**

In `src/renderer/components/Toolbar/Toolbar.tsx`:

1. Add the import:

```typescript
import { SearchBox } from './SearchBox';
```

2. Replace the tail of the header — change:

```tsx
      <div className={styles.spacer} />
      <span className={styles.filename} title={filePath ?? undefined}>{filename}</span>
```

to:

```tsx
      <div className={styles.spacer} />
      <SearchBox />
      <span className={styles.filename} title={filePath ?? undefined}>{filename}</span>
```

- [ ] **Step 2: Add `Ctrl+F` / `Cmd+F` handler in App.tsx**

In `src/renderer/App.tsx`, inside the existing `handleKeyDown` (the effect that already handles `Escape` and `T`), add this branch **before** the `Escape` branch:

```typescript
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        if (usePdfStore.getState().pageCount > 0) {
          usePdfStore.getState().setSearchOpen(true);
        }
        return;
      }
```

No dependency-array change is needed (`usePdfStore.getState()` is a stable import).

- [ ] **Step 3: Verify build**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors; all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Toolbar/Toolbar.tsx src/renderer/App.tsx
git commit -m "feat: mount SearchBox in toolbar, Ctrl+F opens search"
```

---

### Task 6: TextLayer search highlight

**Files:**
- Modify: `src/renderer/components/PdfViewport/TextLayer.tsx`
- Modify: `src/renderer/components/PdfViewport/TextLayer.module.css`

- [ ] **Step 1: Add highlight helpers and rewire the component**

Replace the **entire contents** of `src/renderer/components/PdfViewport/TextLayer.tsx` with:

```tsx
import React, { useEffect, useRef } from 'react';
import { TextLayer as PdfjsTextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { mapMatchToDivOffsets, type SearchMatch } from '../../services/pdf-search';
import { usePdfStore } from '../../store/pdf-store';
import styles from './TextLayer.module.css';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy | null;
  zoom: number;
}

interface HighlightRange {
  start: number;
  end: number;
  className: string;
}

/**
 * Wrap matched character ranges in highlight spans. Matches are
 * non-overlapping (see findMatches), so sorted ranges never intersect.
 */
function applyHighlights(
  container: HTMLElement,
  matches: SearchMatch[],
  currentIndex: number,
  pageNum: number,
): void {
  const pageMatches = matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.page === pageNum);
  if (pageMatches.length === 0) return;

  const divs = Array.from(container.children) as HTMLElement[];
  const divTexts = divs.map((d) => d.textContent ?? '');

  const perDiv = new Map<number, HighlightRange[]>();
  for (const { match, index } of pageMatches) {
    const className = index === currentIndex ? 'searchMatchCurrent' : 'searchMatch';
    for (const range of mapMatchToDivOffsets(match, divTexts)) {
      const list = perDiv.get(range.divIndex) ?? [];
      list.push({ start: range.start, end: range.end, className });
      perDiv.set(range.divIndex, list);
    }
  }

  for (const [divIndex, ranges] of perDiv) {
    const div = divs[divIndex];
    const text = divTexts[divIndex];
    ranges.sort((a, b) => a.start - b.start);

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        frag.append(document.createTextNode(text.slice(cursor, range.start)));
      }
      const span = document.createElement('span');
      span.className = range.className;
      span.textContent = text.slice(range.start, range.end);
      frag.append(span);
      cursor = range.end;
    }
    if (cursor < text.length) {
      frag.append(document.createTextNode(text.slice(cursor)));
    }
    div.textContent = '';
    div.append(frag);
  }
}

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, zoom }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textSelectionMode = usePdfStore((s) => s.textSelectionMode);
  const searchMatches = usePdfStore((s) => s.searchMatches);
  const currentMatchIndex = usePdfStore((s) => s.currentMatchIndex);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    let cancelled = false;
    let textLayer: PdfjsTextLayer | null = null;

    const renderText = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom });
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        container.innerHTML = '';
        textLayer = new PdfjsTextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        await textLayer.render();
        if (cancelled) return;

        const s = usePdfStore.getState();
        if (!s.textSelectionMode) {
          applyHighlights(container, s.searchMatches, s.currentMatchIndex, pageNum);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to load text for page ${pageNum}:`, error);
        }
      }
    };

    void renderText();

    return () => {
      cancelled = true;
      textLayer?.cancel();
      container.innerHTML = '';
      container.style.width = '';
      container.style.height = '';
    };
  }, [pageNum, pdfDoc, zoom]);

  // Re-apply highlights when the match set or active match changes
  // without re-rendering the text layer (innerHTML is rebuilt from
  // the still-intact text: highlights wrap text nodes, so re-running
  // on an already-highlighted layer is avoided by re-render above;
  // here we only act when the container has un-highlighted text or
  // the active class must move).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc || textSelectionMode) return;
    // Skip if a (re)render is about to rebuild the container anyway —
    // applying twice is harmless because applyHighlights only reads
    // textContent, which is unchanged by highlight spans.
    applyHighlights(container, searchMatches, currentMatchIndex, pageNum);
  }, [searchMatches, currentMatchIndex, pageNum, pdfDoc, textSelectionMode, zoom]);

  return (
    <div
      ref={containerRef}
      className={styles.textLayer}
      style={{
        pointerEvents: textSelectionMode ? 'auto' : 'none',
        userSelect: textSelectionMode ? 'text' : 'none',
      }}
      aria-hidden={!textSelectionMode}
    />
  );
};
```

Note for the implementer: `applyHighlights` reads only `textContent` and rewrites the div's children from scratch each time it touches a div, but it does NOT remove highlight spans from divs that are no longer matched. That is fine because every state change that removes matches (new query, clear, page change, zoom change) goes through the render effect which resets `innerHTML`. The second effect only ADDS/moves highlights. If you observe stale highlights during manual verification (Task 10), call this out instead of patching silently.

- [ ] **Step 2: Add highlight styles**

Append to `src/renderer/components/PdfViewport/TextLayer.module.css`:

```css
.textLayer :global(.searchMatch) {
  background: rgba(255, 235, 59, 0.4);
  border-radius: 2px;
}

.textLayer :global(.searchMatchCurrent) {
  background: rgba(255, 152, 0, 0.6);
  border-radius: 2px;
}
```

(`:global` is required — the spans are created imperatively, so CSS Modules cannot rewrite their class names.)

- [ ] **Step 3: Verify build**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/PdfViewport/TextLayer.tsx src/renderer/components/PdfViewport/TextLayer.module.css
git commit -m "feat: highlight search matches in text layer"
```

---

### Task 7: `export-data.ts` pure functions with tests

**Files:**
- Create: `src/renderer/services/export-data.ts`
- Test: `src/renderer/services/__tests__/export-data.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/services/__tests__/export-data.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';
import { pagesToCsv, pagesToJson, suggestFilename } from '../export-data';

const metadata: PdfMetadata = {
  pages: 1, version: '1.7', encrypted: false, page_w: 612, page_h: 792,
  title: 'Demo', author: 'A', producer: 'P', fonts: ['F1'],
};

function makePage(): PageData {
  return {
    width: 612,
    height: 792,
    chars: [{
      type: 'char', x0: 1, y0: 2, x1: 3, y1: 4, page: 1,
      text: 'a,"b\nc', fontname: 'F1', size: 12, color: '#000000',
    }],
    words: [{
      type: 'word', x0: 1, y0: 2, x1: 9, y1: 4, page: 1,
      text: 'hello', fontname: 'F1', size: 12,
    }],
    rects: [{
      type: 'rect', x0: 0, y0: 0, x1: 10, y1: 10, page: 1,
      fill: true, stroke: false, color: '#ff0000', width: 1,
    }],
    lines: [{
      type: 'line', x0: 0, y0: 0, x1: 10, y1: 0, page: 1,
      stroke: true, color: '#00ff00', width: 0.5,
    }],
    curves: [{
      type: 'curve', x0: 0, y0: 0, x1: 5, y1: 5, page: 1,
      points: [[0, 0], [5, 5]], stroke: true,
    }],
    images: [{
      type: 'image', x0: 0, y0: 0, x1: 20, y1: 20, page: 1,
      width: 20, height: 20, stream_id: 'p1_img_0', format: 'png',
    }],
    tables: [{
      type: 'table', x0: 0, y0: 0, x1: 50, y1: 50, page: 1,
      rows: 2, cols: 2, cells: [['h1', 'h2'], ['v1', 'v2']],
    }],
  };
}

describe('pagesToJson', () => {
  it('produces parseable JSON with metadata, pageCount and pages', () => {
    const parsed = JSON.parse(pagesToJson([makePage()], metadata));
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].chars[0].text).toBe('a,"b\nc');
    expect(typeof parsed.exportedAt).toBe('string');
  });
});

describe('pagesToCsv', () => {
  const csv = pagesToCsv([makePage()]);

  it('contains one section per object type in order', () => {
    const sections = ['# chars', '# words', '# rects', '# lines', '# curves', '# images', '# tables'];
    let last = -1;
    for (const section of sections) {
      const at = csv.indexOf(section);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('escapes comma, quote and newline per RFC 4180', () => {
    // a,"b\nc  →  "a,""b
    expect(csv).toContain('"a,""b\nc"');
  });

  it('writes chars header and row with page prefix', () => {
    expect(csv).toContain('page,x0,y0,x1,y1,text,fontname,size,color');
    expect(csv).toContain('1,1,2,3,4,"a,""b');
  });

  it('flattens table cells as page,table_index,row,col,text', () => {
    expect(csv).toContain('page,table_index,row,col,text');
    expect(csv).toContain('1,0,0,0,h1');
    expect(csv).toContain('1,0,1,1,v2');
  });

  it('serializes curve points as JSON', () => {
    expect(csv).toContain('"[[0,0],[5,5]]"');
  });
});

describe('suggestFilename', () => {
  it('builds page-scoped and document-scoped names', () => {
    expect(suggestFilename('/docs/report.pdf', 'page', 3, 'json')).toBe('report-p3.json');
    expect(suggestFilename('C:\\docs\\report.pdf', 'document', 1, 'csv')).toBe('report-all.csv');
  });

  it('handles missing path and non-pdf extension', () => {
    expect(suggestFilename(null, 'page', 1, 'json')).toBe('document-p1.json');
    expect(suggestFilename('/a/b.txt', 'document', 1, 'csv')).toBe('b.txt-all.csv');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/services/__tests__/export-data.test.ts`
Expected: FAIL — cannot find module `../export-data`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/services/export-data.ts`:

```typescript
import type { PageData, PdfMetadata } from '../types/pdf-objects';

export function pagesToJson(pages: PageData[], metadata: PdfMetadata | null): string {
  return JSON.stringify(
    {
      metadata,
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages,
    },
    null,
    2,
  );
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: (string | number | boolean)[]): string {
  return values.map((v) => csvEscape(String(v))).join(',');
}

const BBOX = ['page', 'x0', 'y0', 'x1', 'y1'] as const;

/** Single CSV file, one `# <type>` section per object type. */
export function pagesToCsv(pages: PageData[]): string {
  const out: string[] = [];

  out.push('# chars');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size', 'color']));
  for (const page of pages) {
    for (const c of page.chars) {
      out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, c.text, c.fontname, c.size, c.color]));
    }
  }

  out.push('# words');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size']));
  for (const page of pages) {
    for (const w of page.words) {
      out.push(csvRow([w.page, w.x0, w.y0, w.x1, w.y1, w.text, w.fontname, w.size]));
    }
  }

  out.push('# rects');
  out.push(csvRow([...BBOX, 'fill', 'stroke', 'color', 'width']));
  for (const page of pages) {
    for (const r of page.rects) {
      out.push(csvRow([r.page, r.x0, r.y0, r.x1, r.y1, r.fill, r.stroke, r.color, r.width]));
    }
  }

  out.push('# lines');
  out.push(csvRow([...BBOX, 'stroke', 'color', 'width']));
  for (const page of pages) {
    for (const l of page.lines) {
      out.push(csvRow([l.page, l.x0, l.y0, l.x1, l.y1, l.stroke, l.color, l.width]));
    }
  }

  out.push('# curves');
  out.push(csvRow([...BBOX, 'points', 'stroke']));
  for (const page of pages) {
    for (const c of page.curves) {
      out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, JSON.stringify(c.points), c.stroke]));
    }
  }

  out.push('# images');
  out.push(csvRow([...BBOX, 'width', 'height', 'stream_id', 'format']));
  for (const page of pages) {
    for (const img of page.images) {
      out.push(
        csvRow([img.page, img.x0, img.y0, img.x1, img.y1, img.width, img.height, img.stream_id, img.format]),
      );
    }
  }

  out.push('# tables');
  out.push(csvRow(['page', 'table_index', 'row', 'col', 'text']));
  for (const page of pages) {
    page.tables.forEach((t, tableIndex) => {
      t.cells.forEach((row, rowIndex) => {
        row.forEach((text, colIndex) => {
          out.push(csvRow([t.page, tableIndex, rowIndex, colIndex, text]));
        });
      });
    });
  }

  return `${out.join('\n')}\n`;
}

export function suggestFilename(
  pdfPath: string | null,
  scope: 'page' | 'document',
  page: number,
  ext: 'json' | 'csv',
): string {
  const base = (pdfPath?.split(/[\\/]/).pop() ?? 'document').replace(/\.pdf$/i, '');
  return scope === 'page' ? `${base}-p${page}.${ext}` : `${base}-all.${ext}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/services/__tests__/export-data.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/export-data.ts src/renderer/services/__tests__/export-data.test.ts
git commit -m "feat: add pure export serialization functions with tests"
```

---

### Task 8: `saveFile` IPC — channel, types, preload, main handler, client wrapper

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/renderer/types/ipc-protocol.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/renderer/services/ipc-client.ts`

- [ ] **Step 1: Add the channel constant**

In `src/shared/constants.ts`, add to `IPC_CHANNELS`:

```typescript
  SAVE_FILE: 'file:save',
```

- [ ] **Step 2: Add types and `IpcApi` method**

In `src/renderer/types/ipc-protocol.ts`, add after `OpenPdfResult`:

```typescript
export interface SaveFileRequest {
  defaultPath: string;
  content: string;
  filterName: string;
  extensions: string[];
}

export type SaveFileResult =
  | { canceled: true }
  | { canceled: false; filePath?: string; error?: string };
```

and add to the `IpcApi` interface:

```typescript
  saveFile(req: SaveFileRequest): Promise<SaveFileResult>;
```

- [ ] **Step 3: Add the preload bridge**

In `src/preload/index.ts`, add the type import and bridge method:

```typescript
import type { SaveFileRequest } from '../renderer/types/ipc-protocol';
```

```typescript
  saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE, req),
```

- [ ] **Step 4: Add the main-process handler**

In `src/main/ipc-handlers.ts`:

1. Add imports at the top:

```typescript
import { writeFile } from 'node:fs/promises';
import type { SaveFileRequest } from '../renderer/types/ipc-protocol';
```

2. Register the handler inside `registerIpcHandlers`, after the `SIDECAR_STATUS` handler:

```typescript
  ipcMain.handle(IPC_CHANNELS.SAVE_FILE, async (_event, req: SaveFileRequest) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const result = await dialog.showSaveDialog(win, {
      title: 'Export data',
      defaultPath: req.defaultPath,
      filters: [{ name: req.filterName, extensions: req.extensions }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    try {
      await writeFile(result.filePath, req.content, 'utf8');
      return { canceled: false, filePath: result.filePath };
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });
```

- [ ] **Step 5: Add the renderer client wrapper**

In `src/renderer/services/ipc-client.ts`, add the type import and wrapper. **No `callWithTimeout`** — the save dialog may stay open arbitrarily long, and a timeout would wrongly trigger sidecar restart:

```typescript
import { IpcApi, SaveFileRequest } from '../types/ipc-protocol';
```

```typescript
  saveFile: (req: SaveFileRequest) => window.pdfInspector.saveFile(req),
```

(Replace the existing `import { IpcApi } from '../types/ipc-protocol';` line with the combined import above.)

- [ ] **Step 6: Verify build**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/renderer/types/ipc-protocol.ts src/preload/index.ts src/main/ipc-handlers.ts src/renderer/services/ipc-client.ts
git commit -m "feat: add saveFile IPC for native save dialog and file write"
```

---

### Task 9: `ExportMenu` component + StatusBar progress + Toolbar mount

**Files:**
- Create: `src/renderer/components/Toolbar/ExportMenu.tsx`
- Create: `src/renderer/components/Toolbar/ExportMenu.module.css`
- Modify: `src/renderer/components/StatusBar/StatusBar.tsx`
- Modify: `src/renderer/components/Toolbar/Toolbar.tsx`

- [ ] **Step 1: Create the ExportMenu component**

Create `src/renderer/components/Toolbar/ExportMenu.tsx`:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { pagesToCsv, pagesToJson, suggestFilename } from '../../services/export-data';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
import type { PageData } from '../../types/pdf-objects';
import styles from './ExportMenu.module.css';

type Scope = 'page' | 'document';
type Format = 'json' | 'csv';

export const ExportMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageData = usePdfStore((s) => s.pageData);
  const isLoading = usePdfStore((s) => s.isLoading);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const handleExport = useCallback(async (scope: Scope, format: Format) => {
    setOpen(false);
    const store = usePdfStore.getState();
    if (!store.filePath) return;

    setBusy(true);
    store.setError(null);
    try {
      let pages: PageData[];
      if (scope === 'page') {
        if (!store.pageData) throw new Error('Page data not loaded yet');
        pages = [store.pageData];
      } else {
        store.setExportProgress({ done: 0, total: store.pageCount });
        pages = [];
        for (let p = 1; p <= store.pageCount; p += 1) {
          const data = await ipc.extractPage(p);
          pages.push(data);
          store.setExportProgress({ done: p, total: store.pageCount });
        }
      }

      const content = format === 'json' ? pagesToJson(pages, store.metadata) : pagesToCsv(pages);
      const result = await ipc.saveFile({
        defaultPath: suggestFilename(store.filePath, scope, store.currentPage, format),
        content,
        filterName: format === 'json' ? 'JSON' : 'CSV',
        extensions: [format],
      });
      if (!result.canceled && result.error) {
        store.setError(`Export failed: ${result.error}`);
      }
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      usePdfStore.getState().setExportProgress(null);
      setBusy(false);
    }
  }, []);

  const disabled = isLoading || busy || !pageData;

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        className={styles.button}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button type="button" role="menuitem" onClick={() => void handleExport('page', 'json')}>
            Current page → JSON
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('page', 'csv')}>
            Current page → CSV
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('document', 'json')}>
            Whole document → JSON
          </button>
          <button type="button" role="menuitem" onClick={() => void handleExport('document', 'csv')}>
            Whole document → CSV
          </button>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Create the CSS module**

Create `src/renderer/components/Toolbar/ExportMenu.module.css`:

```css
.container {
  position: relative;
  display: inline-block;
}

.button {
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.button:hover:not(:disabled) {
  background: #f0f0f0;
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  min-width: 190px;
  padding: 4px;
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.menu button {
  padding: 6px 10px;
  border: none;
  background: none;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
}

.menu button:hover {
  background: #f0f0f0;
}
```

- [ ] **Step 3: Show export progress in StatusBar**

In `src/renderer/components/StatusBar/StatusBar.tsx`:

1. Add the selector next to the others:

```typescript
  const exportProgress = usePdfStore((state) => state.exportProgress);
```

2. Add this line right after the `documentStatus` span:

```tsx
      {exportProgress && (
        <span className={styles.documentStatus}>
          Exporting {exportProgress.done}/{exportProgress.total}…
        </span>
      )}
```

- [ ] **Step 4: Mount ExportMenu in the Toolbar**

In `src/renderer/components/Toolbar/Toolbar.tsx`:

1. Add the import:

```typescript
import { ExportMenu } from './ExportMenu';
```

2. Change the tail to place ExportMenu next to SearchBox:

```tsx
      <div className={styles.spacer} />
      <ExportMenu />
      <SearchBox />
      <span className={styles.filename} title={filePath ?? undefined}>{filename}</span>
```

- [ ] **Step 5: Verify build**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Toolbar/ExportMenu.tsx src/renderer/components/Toolbar/ExportMenu.module.css src/renderer/components/StatusBar/StatusBar.tsx src/renderer/components/Toolbar/Toolbar.tsx
git commit -m "feat: add export menu with progress in status bar"
```

---

### Task 10: Manual integration verification

**Files:** none (verification only; fix-forward into a final commit if issues are found)

Run the app with `npm run dev` (renderer) / `npm start` (Electron) and open a PDF that has both text and tables.

- [ ] **Step 1: Verify search open/close**

Press `Ctrl+F`. Expected: search input expands in the toolbar and is focused. Press `Esc`. Expected: input collapses, highlights disappear, count resets.

- [ ] **Step 2: Verify search matching and count**

Type a word that appears on multiple pages. Expected: after ~300ms the count shows `1/N`; the current page's matches are highlighted yellow and the active one orange.

- [ ] **Step 3: Verify cross-page navigation**

Press Enter / click ↓ repeatedly until the match index wraps. Expected: page turns automatically to each match's page, count advances `2/N`, `3/N`, …, wraps to `1/N`. Shift+Enter / ↑ goes backwards.

- [ ] **Step 4: Verify Chinese search**

Search a Chinese keyword. Expected: matches found and highlighted correctly.

- [ ] **Step 5: Verify highlight vs Select Text mode**

With highlights visible, press `T`. Expected: text becomes selectable (highlights not reapplied in this mode). Press `T` again. Expected: highlights return.

- [ ] **Step 6: Verify search state resets on new document**

Open a different PDF. Expected: search box collapses/resets, no stale highlights.

- [ ] **Step 7: Verify current-page export**

Export → Current page → JSON. Save, then open the file. Expected: valid JSON with `metadata`, `pageCount: 1`, and the page's objects. Repeat with CSV: sections `# chars` … `# tables` present, opens cleanly in a spreadsheet app.

- [ ] **Step 8: Verify whole-document export**

Export → Whole document → CSV on a multi-page PDF. Expected: StatusBar shows `Exporting k/N…` while running; save dialog appears after extraction; rows from later pages carry their page numbers.

- [ ] **Step 9: Verify save-dialog cancel**

Start any export, then cancel the save dialog. Expected: silent return — no error banner, no file written, Export button re-enabled.

- [ ] **Step 10: Commit any final fixes discovered during verification**

```bash
git add -A
git commit -m "fix: integration polish from search/export manual verification"
```

---

## Spec Coverage Summary

| Spec § | Requirement | Task(s) |
|--------|-------------|---------|
| §5.1 | `pdf-search.ts` pure functions (`buildPageText`, `findMatches`, `mapMatchToDivOffsets`, `SearchMatch`) | 1 |
| §5.4 | store search fields + actions, `setFile` reset | 2 |
| §5.2 | `usePdfSearch` lazy cancelable index + prev/next via request-guard | 3 |
| §5.3 | `SearchBox` inline UI, debounce, count, Enter/Shift+Enter, Esc | 4, 5 |
| §5.3 | `Ctrl+F`/`Cmd+F` global shortcut | 5 |
| §5.5 | TextLayer highlight, yellow/orange classes, disabled in Select Text mode | 6 |
| §6.1 | `export-data.ts` (`pagesToJson`, `pagesToCsv` with per-type sections + flattened tables, `suggestFilename`) | 7 |
| §6.3 | `SAVE_FILE` channel + types + preload + main handler + client (no timeout wrapper — header note) | 8 |
| §6.2 | `ExportMenu` four combinations, outside-click close, disabled while busy | 9 |
| §6.4 | `exportProgress` in store + StatusBar line | 2, 9 |
| §8 | Error handling: skipped pages warn, banner on export failure, silent cancel, progress cleared in `finally` | 3, 9, 10 |
| §9 | Unit tests (pdf-search, export-data, store) + manual verification | 1, 2, 7, 10 |

