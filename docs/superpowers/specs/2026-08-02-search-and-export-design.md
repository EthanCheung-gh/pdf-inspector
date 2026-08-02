# PDF Inspector — Text Search & Data Export Design

**Date:** 2026-08-02
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)

---

## 1. Overview

Add two features to PDF Inspector:

- **B. Full-text search**: an inline search box in the toolbar (right side), powered by PDF.js `getTextContent()` across all pages, with prev/next match navigation, cross-page auto-navigation, and in-page highlight via the existing TextLayer.
- **C. Extraction data export**: export pdfplumber-extracted objects (chars/words/rects/lines/curves/tables/images) for the current page or the whole document, as JSON or CSV, saved via a native save dialog.

Both features touch only the **renderer** and **main** layers. The Python sidecar is unchanged; export reuses the existing `extractPage` IPC (with its 30s timeout + restart-retry machinery).

## 2. Goals / Non-Goals

**Goals:**
- Search: case-insensitive full-text search across the whole document; matches spanning multiple text items are found; prev/next buttons navigate and auto-turn pages; current page's matches are highlighted in the text layer with the active match visually distinct; `Ctrl+F` focuses the search box.
- Export: user picks scope (current page / whole document) and format (JSON / CSV) from a toolbar menu; whole-document export shows progress and can be monitored in the StatusBar; files are written through a new `saveFile` IPC using the OS save dialog.

**Non-Goals:**
- Regex search, whole-word search, diacritics-insensitive search.
- Search result list panel (a left-panel "Search" tab was considered and rejected in favor of inline toolbar UI).
- Selective object-type export (all types are always exported).
- Zip/multi-file CSV output (single CSV file with per-type sections).
- Any PDF modification.

## 3. User Decisions (locked)

| Question | Decision |
|----------|----------|
| Search UI form | Inline search box on the right side of the toolbar |
| Search behavior | Whole-document search + prev/next navigation (auto page turn) |
| Export scope | Both current page and whole document (user chooses in menu) |
| Export format | JSON + CSV, all object types |

## 4. Architecture

### 4.1 Layers

| Layer | Changes |
|-------|---------|
| `src/shared` | Add `SAVE_FILE` IPC channel constant |
| `src/main` | Add `saveFile` IPC handler (save dialog + write file) |
| `src/preload` | Add `saveFile` bridge method |
| `src/renderer` | New search service + hook + SearchBox; new export service + ExportMenu; store extensions; TextLayer highlight; Toolbar integration |

### 4.2 Approach choices (from brainstorming)

- **Search: self-built search over `page.getTextContent()`** (not PDF.js `PDFFindController`, not sidecar char search). Rationale: no new dependency, fully controllable, pure functions unit-testable, fits the custom single-page renderer.
- **Export: renderer-orchestrated** (not sidecar-side, not hybrid). Rationale: serialization stays in TS as pure testable functions, sidecar untouched, existing timeout/restart applies.

## 5. Feature B — Text Search

### 5.1 New file: `src/renderer/services/pdf-search.ts`

Pure functions, no React/PDF.js proxy dependencies beyond plain inputs:

- `buildPageText(textItems: string[]): string` — join item strings with `\n` (item boundaries never merge words).
- `findMatches(pageTexts: string[], query: string): SearchMatch[]` — case-insensitive search via lowercased copy; returns all matches as `{ page: number; begin: number; length: number }` sorted by page then offset. `begin/length` index into that page's joined text. Empty/whitespace query returns `[]`.
- `mapMatchToDivOffsets(pageText: string, match: {begin,length}, divTexts: string[]): {divIndex, start, end}[]` — map a character range onto rendered text divs (div texts joined identically to page text) so the TextLayer can highlight whole/partial divs.

Types exported: `SearchMatch { page: number; begin: number; length: number }`.

### 5.2 New file: `src/renderer/hooks/usePdfSearch.ts`

- Holds a lazily built per-document index: `pageTexts: string[]` built by iterating `doc.getPage(i).getTextContent()` and running `buildPageText`.
- Index build is async and cancelable (increment `buildId`; stale builds discard results), and is invalidated when `pdfDocRef` in the store changes.
- API: `setQuery(q: string)`, `next()`, `prev()`, `clear()`; state lives in the store (§5.4).
- On `next()/prev()`: update `currentMatchIndex` (wrap-around), call `usePageNavigation().navigate(match.page)` when the match's page differs from `currentPage` — reusing the request-guard so rapid navigation stays consistent.

### 5.3 New file: `src/renderer/components/Toolbar/SearchBox.tsx` (+ `SearchBox.module.css`)

- Collapsed state: a magnifier button. Expanded: `<input>` + match count label (`3/24`, or `0/0` when query has no matches) + ↑/↓ buttons + ✕ close.
- `Ctrl+F` (and `Cmd+F`) anywhere in the app expands and focuses the input; `Esc` clears query and collapses.
- Typing debounces `setQuery` by 300 ms.
- Enter = next, Shift+Enter = prev (same as ↑/↓ buttons).

### 5.4 Store extension: `src/renderer/store/pdf-store.ts`

New fields:

```ts
searchQuery: string;
searchMatches: SearchMatch[];
currentMatchIndex: number; // -1 when no matches
```

New actions: `setSearchQuery(q)`, `setSearchMatches(matches)`, `setCurrentMatchIndex(i)`, `clearSearch()` (also called by `setFile` when a new document opens).

### 5.5 TextLayer highlight: `src/renderer/components/PdfViewport/TextLayer.tsx` (modified)

- After `TextLayer.render()` completes for the current page, read `searchMatches`/`currentMatchIndex` from the store, filter to the current page, map each match onto rendered divs via `mapMatchToDivOffsets`.
- Apply CSS classes: `searchMatch` (translucent yellow background) to all matched divs (or wrapped partial-div spans when a match covers part of a div), `searchMatchCurrent` (stronger orange) to the active one.
- Re-applied when matches, current index, page, or zoom change. Highlighting is disabled while `textSelectionMode` is active (selection keeps priority).

## 6. Feature C — Data Export

### 6.1 New file: `src/renderer/services/export-data.ts`

Pure functions:

- `pagesToJson(pages: PageData[], metadata: PdfMetadata): string` — pretty-printed JSON: `{ metadata, exportedAt, pageCount, pages: [...] }`.
- `pagesToCsv(pages: PageData[]): string` — single file, one section per object type: a `# chars` header line, then a header row (`page,x0,y0,x1,y1,text,fontname,size`) and data rows; then `# words`, `# rects`, `# lines`, `# curves`, `# images` sections likewise (each prefixed with `page` plus the object's bbox fields). The `# tables` section flattens each table's 2-D `cells` array into rows of `page,table_index,row,col,text`. CSV escaping per RFC 4180 (quote fields containing `,` `"` or newline; double internal quotes). Each row is prefixed with its 1-based page number.
- `suggestFilename(pdfPath: string, scope: 'page'|'document', page: number, ext: 'json'|'csv'): string` — e.g. `report-p3.json`, `report-all.csv`.

### 6.2 New file: `src/renderer/components/Toolbar/ExportMenu.tsx` (+ CSS module)

- Toolbar button "Export" opens a small dropdown with four actions:
  - Current page → JSON
  - Current page → CSV
  - Whole document → JSON
  - Whole document → CSV
- Current-page export reads `pageData` from the store directly.
- Whole-document export loops `ipc.extractPage(page)` for `1..pageCount` (no page cache exists — every page is fetched through the IPC), updates `exportProgress` in the store after each page, then serializes and saves.
- Menu closes on selection or outside click; disabled while `isLoading` or an export is running.

### 6.3 IPC: `saveFile`

- `src/shared/constants.ts`: add `SAVE_FILE = 'save-file'` channel.
- `src/renderer/types/ipc-protocol.ts`: add `saveFile(req: SaveFileRequest): Promise<SaveFileResult>` to `IpcApi` where `SaveFileRequest = { defaultPath: string; content: string; filters?: { name: string; extensions: string[] }[] }` and `SaveFileResult = { canceled: boolean; filePath?: string; error?: string }`.
- `src/preload/index.ts`: bridge via `ipcRenderer.invoke(SAVE_FILE, req)`.
- `src/main/ipc-handlers.ts`: handler shows `dialog.showSaveDialog`; on confirm writes UTF-8 content with `fs.writeFile`; returns `{canceled:true}` on cancel, `{canceled:false, filePath}` on success, `{canceled:false, error}` on write failure.
- `src/renderer/services/ipc-client.ts`: add `saveFile` to the `ipc` wrapper (through `callWithTimeout` like the others).

### 6.4 Store extension: export progress

```ts
exportProgress: { done: number; total: number } | null;
setExportProgress(p): void;
```

StatusBar already renders store-driven status; add one line displaying `Exporting 12/138…` while non-null (cleared on completion/failure).

## 7. Data Flow

**Search:**
`Ctrl+F`/click → SearchBox expands → debounced `setQuery` → `usePdfSearch` lazily builds/cancels index → `findMatches` → store → count label updates → Enter/↑/↓ changes `currentMatchIndex` → `navigate(match.page)` via request-guard → TextLayer re-renders highlights.

**Export:**
ExportMenu selection → current page: store `pageData`; whole document: loop `ipc.extractPage` (30s timeout + one restart-retry already built in) updating `exportProgress` → pure serialize → `ipc.saveFile` → main dialog + write → success shown in StatusBar (or silent on cancel; banner on error).

## 8. Error Handling

- Search: a page whose `getTextContent()` rejects is skipped with `console.warn`, search continues over remaining pages; no matches → count shows `0/0`, navigation buttons disabled; opening a new document calls `clearSearch()` and invalidates the index build.
- Export: per-page extraction failure aborts the export and surfaces the message through the existing error banner (`store.error`); `saveFile` cancel is silent; write failure returns `error` which is shown in the banner; Export button disabled while an export runs; `exportProgress` always cleared in a `finally`.

## 9. Testing

- `src/renderer/services/__tests__/pdf-search.test.ts`: buildPageText joining; case-insensitive matching; matches spanning item boundaries; multiple matches ordering; empty query; mapMatchToDivOffsets whole/partial div coverage.
- `src/renderer/services/__tests__/export-data.test.ts`: JSON shape (metadata + pages); CSV section headers and per-type columns; RFC 4180 escaping (comma, quote, newline in text); suggestFilename patterns.
- `src/renderer/store/__tests__/pdf-store.test.ts`: extend with search fields, clearSearch on setFile, exportProgress set/clear.
- Manual verification checklist: `Ctrl+F` focus; Chinese keyword search; cross-page prev/next; highlight vs Select Text mode; export all four combinations; open CSV in Excel and JSON in an editor to validate; cancel save dialog; whole-document export progress on a large PDF.

## 10. File Structure

**New files**

| File | Purpose |
|------|---------|
| `src/renderer/services/pdf-search.ts` | Pure search/match mapping functions |
| `src/renderer/services/export-data.ts` | Pure JSON/CSV serialization |
| `src/renderer/hooks/usePdfSearch.ts` | Index lifecycle + match navigation |
| `src/renderer/components/Toolbar/SearchBox.tsx` (+ `.module.css`) | Inline search UI |
| `src/renderer/components/Toolbar/ExportMenu.tsx` (+ `.module.css`) | Export dropdown |
| `src/renderer/services/__tests__/pdf-search.test.ts` | Search unit tests |
| `src/renderer/services/__tests__/export-data.test.ts` | Export unit tests |

**Modified files**

| File | Changes |
|------|---------|
| `src/shared/constants.ts` | `SAVE_FILE` channel |
| `src/renderer/types/ipc-protocol.ts` | `saveFile` in `IpcApi`, request/result types |
| `src/preload/index.ts` | `saveFile` bridge |
| `src/main/ipc-handlers.ts` | `saveFile` handler |
| `src/renderer/services/ipc-client.ts` | `saveFile` wrapper |
| `src/renderer/store/pdf-store.ts` | search fields + exportProgress + actions |
| `src/renderer/components/Toolbar/Toolbar.tsx` | mount SearchBox + ExportMenu |
| `src/renderer/components/PdfViewport/TextLayer.tsx` | search highlight |
| `src/renderer/components/StatusBar/StatusBar.tsx` | export progress line |
| `src/renderer/App.tsx` | `Ctrl+F` keyboard handler |
