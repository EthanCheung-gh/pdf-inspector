# PDF Inspector — Reliability & Navigation Improvements

**Date:** 2026-07-12
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)
**Supersedes:** Section 11 (Error Handling) and Section 12 (Scope, Phase 1) of `2026-07-09-pdf-inspector-design.md`

---

## 1. Goal

Deliver a set of incremental reliability and navigation improvements to the PDF Inspector that together make the tool usable for real-world PDFs: fix PDF loading from paths containing Chinese and other non-ASCII characters; switch to on-demand per-page pdfplumber extraction with LRU caching and request-guard cancellation so large PDFs load instantly and never return stale data; default the viewport to fit-width zoom with DPR-aware, cancelable canvas rendering to eliminate blue-text artifacts and retina blur; replace the manual text span layer with the real PDF.js `TextLayer` for selectable, copyable text; ensure later pages always load their correct per-page data without race conditions; and add a **Bookmarks** tab alongside the existing **Structure** tab in the left panel, driven by PDF.js `getOutline()` and destination resolution.

---

## 2. Non-Goals

- PDF editing, annotation creation, or form filling (out of scope for Phase 1 — see original spec §12)
- OCR for scanned documents
- Full-text search across the document
- Batch processing or CLI mode
- Digital signature verification or certificate handling
- Replacing the existing pdfplumber overlay layer or hit-test strategy
- Persisting the PDF.js document reference across app restarts
- Rendering all pages simultaneously (virtual scrolling of thumbnails deferred)

---

## 3. Context

### 3.1 Current State

The codebase (as of `2026-07-09-design.md`) has a working three-process architecture (Electron main → renderer → Python sidecar). Key observations from code audit:

| Area | Current Implementation | Problem |
|------|------------------------|---------|
| **PDF loading** | `file://${filePath}` in `PdfViewport.tsx:17` | `file://` URIs with non-ASCII characters are not correctly URI-encoded on Windows; PDF.js `getDocument` receives an invalid URL and fails silently. |
| **Page extraction** | Sidecar loads full document in `pdfplumber.open(path)`, then extracts per-page on demand. Python-side LRU cache holds 10 pages. Renderer calls `extractPage(N)` with no cancellation. | Navigating pages rapidly can cause stale data (response B arrives after user is on page C). The `PdfViewport` renders all pages in DOM (one visible, rest hidden). |
| **Zoom default** | `zoom = 1.0` in `pdf-store.ts` | First page opens at 100%, which is usually too small or too large for the viewport width. |
| **Canvas DPR** | `canvas.width = viewport.width` in `usePdf.ts:64` | Ignores `devicePixelRatio`. On retina displays the canvas is CSS-sized to the same pixel count, producing blurry text. |
| **Rendering cancellation** | `page.render()` called with no AbortController in `usePdf.ts:67` | Rapid zoom/page changes queue overlapping renders; old renders complete and overwrite the correct result. Blue-text artifacts appear because the canvas `width`/`height` and CSS `width`/`height` get out of sync during resize. |
| **Text layer** | Custom `<span>`-based text layer in `TextLayer.tsx` using `page.getTextContent()` | Text is not properly selectable or copyable (missing correct font metrics, transform matrices, and PDF.js text-selection logic). |
| **Per-page data races** | `Toolbar.tsx:navigateToPage` and `StructureTree.tsx:navigateToPage` both call `extractPage` and `setPageData` independently, with only StructureTree having a request-guard pattern (`navigationRequestId`). | Fast page changes can land on stale data; the Toolbar has no guard at all. |
| **Left panel** | Single **Structure** tab showing page objects (words, rects, lines, etc.) | No bookmarks/outline navigation. PDF.js can provide `getOutline()` with named destinations, but it is not called. |

### 3.2 Existing Pattern: Request Guards

The `StructureTree.tsx` already implements a correct request-guard pattern using a mutable `navigationRequestId` ref. Each navigation increments the ref; async callbacks check whether their request ID still matches before applying state. This pattern should be standardized and reused.

### 3.3 Relevant Dependencies

- `pdfjs-dist` ^4.8.69 (bundled) — provides `PDFDocumentProxy.getOutline()`, `PDFDocumentProxy.getDestination()`, and the native `TextLayer` renderer
- `pdfplumber` ^0.11.0 (sidecar) — provides per-page extraction
- `zustand` ^5.0.0 (renderer store)
- Electron 28+ in main process

---

## 4. Proposed Architecture

### 4.1 Unicode Path Support

**Problem:** `file://${filePath}` fails when `filePath` contains characters outside ASCII, because `file://` URIs must be percent-encoded.

**Solution:**

1. In `ipc-handlers.ts`, after the dialog returns a file path, send the path as-is to the sidecar (sidecar already receives native paths and handles them correctly via `pdfplumber.open(path)` — paths are OS-native strings, not URIs).
2. In `PdfViewport.tsx` and `usePdf.ts`, replace `file://${filePath}` with a two-step approach:
   - Use `encodeURI(filePath)` to properly percent-encode the path before passing to `pdfjsLib.getDocument()`.
   - On Windows specifically, also prepend `file:///` (three slashes) for drive-letter paths, matching the WHATWG File API convention.
3. Add a `pathToFileUrl(path: string): string` utility function in a new `src/shared/path-utils.ts` that handles cross-platform encoding correctly. Reference it in both main and renderer.

**Encoding rules for `pathToFileUrl`:**

| Platform | Input | Output |
|----------|-------|--------|
| Linux    | `/home/用户/doc.pdf` | `file:///home/%E7%94%A8%E6%88%B7/doc.pdf` |
| Windows  | `C:\文档\report.pdf` | `file:///C:/%E6%96%87%E6%A1%A3/report.pdf` |
| macOS    | `/Users/ユーザ/doc.pdf` | `file:///Users/%E3%83%A6%E3%83%BC%E3%82%B6/doc.pdf` |

### 4.2 Cancelable Page Rendering with DPR Awareness

**Problem:** `page.render()` is called without cancellation; DPR is ignored; rapid zoom/page changes produce overlapping renders and blue-text artifacts.

**Solution:**

1. **Add AbortController support** to `usePdf.ts:renderPage`. Before each `page.render()`, abort any prior render task on the same canvas context. PDF.js `RenderTask` has a `.cancel()` method — call it on any in-flight task stored in a ref scoped to the canvas.

2. **DPR-aware canvas sizing:** In `renderPage`, compute:
   ```
   const dpr = window.devicePixelRatio || 1;
   const viewport = page.getViewport({ scale: scale * dpr });
   canvas.width = viewport.width;
   canvas.height = viewport.height;
   canvas.style.width = `${viewport.width / dpr}px`;
   canvas.style.height = `${viewport.height / dpr}px`;
   ```
   This produces a canvas that is `dpr ×` larger in pixels but CSS-sized to the logical dimension, matching the overlay layers.

3. **Store a per-canvas cancellation map** in a `Map<HTMLCanvasElement, PDFRenderTask>` so that each canvas's prior render is cancelled before a new one starts. Clean up entries when the canvas is unmounted.

### 4.3 PDF.js Native TextLayer

**Problem:** The current `TextLayer.tsx` manually positions `<span>` elements from `getTextContent`, which doesn't match PDF.js's built-in text selection behavior.

**Solution:**

Replace the manual span approach with PDF.js's official `TextLayer` renderer:

1. Import `pdfjs-dist/display/text_layer` (or use the `page.renderTextLayer` API from `pdfjs-dist`).
2. In a refactored `TextLayer.tsx`:
   - Create a container `<div>` for the text layer.
   - Call `PDFTextLayer.render({ textContent, container, viewport })` — this is the same API that PDF.js's own viewer uses.
   - The text layer's CSS must set `mix-blend-mode: multiply` and `color: transparent` on text spans to overlay correctly over the canvas without blocking mouse events on the overlay canvas above.
   - Set `pointer-events: none` on the text layer container so mouse events pass through to the overlay canvas for hit-testing. Text selection still works because the user selects the underlying DOM text (selection API bypasses pointer-events).

3. **Text selection UX:** When the user drags to select text, the selection highlight appears behind the overlay canvas (which is positioned above). This is acceptable: the blue selection highlight will show through the semi-transparent overlay canvas. If needed, a "Toggle Text Selection Mode" button can disable pointer-events on the overlay canvas temporarily. Design decision: **do not add this button in this phase** — keep the current behavior where overlay canvas captures clicks.

4. **Update `PdfPage.tsx`** to pass the PDF.js page instance (not just the document proxy) to `TextLayer` so it can synchronously render the text layer.

### 4.4 Fit-Width Zoom Default

**Problem:** Initial zoom is hardcoded to 1.0, which rarely fits the viewport.

**Solution:**

1. On PDF open, after the PDF.js document is loaded and the first page is rendered, calculate the fit-width zoom:
   ```
   fitWidthZoom = (viewportContainerWidth - H_PADDING) / pageViewport.width
   ```
   where `H_PADDING = 48` (24px horizontal padding on each side of the page).
2. Store this as `initialFitWidthZoom` in the store and set `zoom` to it after the first render completes.
3. Add a **Fit Width** button in the toolbar that recalculates and applies fit-width zoom dynamically.
4. Clamp the fit-width zoom to the existing zoom bounds `[0.25, 5]`.

### 4.5 Request-Guard Standardization for Page Navigation

**Problem:** Toolbar and StructureTree both navigate pages but only StructureTree uses request guards.

**Solution:**

1. **Extract a shared `usePageNavigation` hook** that encapsulates the request-guard pattern:
   ```typescript
   function usePageNavigation() {
     const requestIdRef = useRef(0);
     const navigate = async (page: number): Promise<PageData | null> => {
       const id = ++requestIdRef.current;
       // ... call extractPage, check id before setPageData ...
     };
     return { navigate, requestIdRef };
   }
   ```
   This hook returns the extracted `PageData` along with a `requestId` — consumers compare the returned id against their own ref.

2. **Refactor `Toolbar.tsx:navigateToPage`** to use the same guard pattern instead of directly calling `setPage` + `extractPage` + `setPageData`. The toolbar should call the shared hook, and only apply state if the request is still current.

3. **Refactor `PdfViewport.tsx`** to only render the current page (not all pages). The current code renders all pages in DOM with `isVisible` checks — this is wasteful. Change to render only `currentPage`:
   ```tsx
   // Before: Array.from({length: pageCount}, ...) — all pages in DOM
   // After: only currentPage
   <PdfPage pageNum={currentPage} zoom={zoom} ... />
   ```

4. **Remove `isVisible` prop** from `PdfPage` since only the current page is rendered.

### 4.6 Bookmarks Tab via PDF.js Outline

**Problem:** The left panel has a single "Structure" tab with no outline/bookmark navigation.

**Solution:**

1. **Add tab bar** to the left panel container (`StructureTree.tsx` → rename to `LeftPanel.tsx` or add tab UI within). Two tabs:
   - **Structure** — existing page-object tree (unchanged behavior)
   - **Bookmarks** — PDF outline rendered from `PDFDocumentProxy.getOutline()`

2. **New IPC method `get_outline`** in the sidecar (Python). While PDF.js can natively provide `getOutline()`, we need the sidecar to provide fallback outline extraction for PDFs where pdfplumber can extract bookmarks more reliably. However, since PDF.js already parses the document in the renderer: **use PDF.js's `getOutline()` directly** in the renderer — no round-trip to the sidecar needed.

3. **Store outline in pdf-store:**
   ```typescript
   interface PdfOutlineItem {
     title: string;
     bold: boolean;
     italic: boolean;
     dest: string | PDFDestination | null;
     items: PdfOutlineItem[];  // nested children
   }
   outline: PdfOutlineItem[] | null;
   ```
   Populate after `loadPdf` succeeds in `usePdf.ts`.

4. **Destination resolution:** When a bookmark is clicked, the renderer uses `pdfDoc.getDestination(dest)` to resolve the destination to a page number, then calls `setPage(destPageNum)` to navigate. If the destination is an explicit `PDFDestination` array (e.g., `[pageRef, { name: 'XYZ' }, left, top, zoom]`), extract the page index from the first element.

5. **Bookmarks rendering:** A recursive `<BookmarkTree>` component renders nested `<details>`/`<summary>` elements (or a flat tree with indentation). Clicking any item navigates to the target page and scrolls to the specified position (position scroll deferred to a follow-up; in this phase, just navigate to the page).

6. **Where to add:** Keep `StructureTree.tsx` as the content of the Structure tab. Create a new `BookmarkTree.tsx` component in `src/renderer/components/StructureTree/` (or a new `LeftPanel/` directory). Add a tab-switching mechanism at the top of the existing left panel `<aside>`.

---

## 5. Files To Change

### New Files

| File | Purpose |
|------|---------|
| `src/shared/path-utils.ts` | Cross-platform `pathToFileUrl(path: string): string` utility |
| `src/renderer/components/LeftPanel/LeftPanel.tsx` | Tabbed container for Structure + Bookmarks tabs |
| `src/renderer/components/LeftPanel/BookmarkTree.tsx` | Recursive outline tree component |
| `src/renderer/components/LeftPanel/LeftPanel.module.css` | Styles for tab bar and panel |
| `src/renderer/hooks/usePageNavigation.ts` | Shared request-guard navigation hook |
| `src/renderer/components/PdfViewport/TextLayer.css` | Required CSS for PDF.js native text layer rendering |

### Modified Files

| File | Changes |
|------|---------|
| `src/renderer/store/pdf-store.ts` | Add `outline`, `fitWidthZoom`, `initialFitWidthZoom`, `pendingPageRequest` fields and actions; remove `allObjects` in favor of derived-from-pageData pattern for request-guard safety |
| `src/renderer/hooks/usePdf.ts` | Add DPR-aware render, AbortController cancellation, outline loading (`getOutline()` call), fit-width initial zoom |
| `src/renderer/components/PdfViewport/PdfViewport.tsx` | Render only current page (remove `Array.from({length: pageCount})`); pass page object to TextLayer |
| `src/renderer/components/PdfViewport/PdfPage.tsx` | Remove `isVisible` prop; pass page instance (`PDFPageProxy`) to TextLayer; add ref-based render task tracking |
| `src/renderer/components/PdfViewport/TextLayer.tsx` | Rewrite to use PDF.js native `TextLayer.render()` with the PDF.js page instance instead of manual `<span>` construction |
| `src/renderer/components/PdfViewport/OverlayCanvas.tsx` | No architectural change needed (overlay already uses CSS coordinates and matches DPR-aware canvas via `style.width`/`style.height`) |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Replace direct `extractPage` call with `usePageNavigation` hook; add **Fit Width** button |
| `src/renderer/components/StructureTree/StructureTree.tsx` | Refactor to be purely the Structure tab content (extract navigation to `usePageNavigation` hook) |
| `src/renderer/App.tsx` | Replace `<StructureTree />` with `<LeftPanel />` |
| `sidecar/main.py` | Add `get_outline` method handler (unwired from IPC in this phase; infrastructure only) |
| `sidecar/extractor.py` | Add `get_outline()` method returning bookmark data from pdfplumber (unwired from IPC in this phase; infrastructure only) |

---

## 6. Testing Strategy

### 6.1 Unit Tests (Vitest)

| Test | What It Covers |
|------|----------------|
| `path-utils.test.ts` | `pathToFileUrl` with ASCII paths, Chinese paths, Windows drive letters, Linux paths, paths with spaces and special characters |
| `usePageNavigation.test.ts` | Request-guard correctly discards stale results; concurrent navigations resolve in-order |
| `pdf-store.test.ts` | Outline state transitions; `setFitWidthZoom` bounds clamping |
| `AbortController integration in usePdf` | Verify prior render task is cancelled before new one starts (mock `page.render()`) |
| `DPR canvas sizing` | Verify `canvas.width === viewport.width * dpr` and `canvas.style.width === viewport.width` |

### 6.2 Python Tests (pytest)

| Test | What It Covers |
|------|----------------|
| `test_outline_extraction.py` | `get_outline` method returns correct bookmarks for PDFs with outlines; returns empty list for PDFs without |
| `test_unicode_path.py` | `PdfExtractor` opens PDFs with Chinese, Japanese, and Unicode characters in the filename |

### 6.3 Integration Tests

| Scenario | Verification |
|----------|--------------|
| Open PDF with Chinese filename | PDF loads, all pages render, text layer is selectable |
| Rapid page navigation (50 clicks in 2s) | Final page shows correct data, no stale renders |
| Zoom in/out on retina display | Text is crisp, no blue artifacts, overlay bboxes align with rendered content |
| Click bookmark in outline | Navigator to correct page |
| Resize window after fit-width | (Future — window resize not part of this phase) |

### 6.4 Manual Verification Checklist

- [ ] Open PDF with Chinese/Japanese/Korean filename — loads successfully
- [ ] First page opens at fit-width zoom
- [ ] Select text on any page — text is highlighted and can be copied
- [ ] Copy text from TextLayer and paste into text editor — correct characters
- [ ] Rapidly click Next/Prev — no stale page data, no render flicker
- [ ] Open large PDF (500+ pages) — only 1 page rendered, extraction lazy
- [ ] Toggle overlay types — all work correctly
- [ ] Bookmarks tab shows PDF outline; click navigates to correct page
- [ ] No blue-text artifacts at any zoom level on retina display

---

## 7. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **R1: PDF.js native TextLayer breaks overlay z-ordering or hit-test** | Medium | High | Wrap TextLayer in a container with `pointer-events: none` (already planned). Add a "Toggle text selection" mode if issues arise in QA — if user needs to select text, they can press a button that sets `pointer-events: auto` on the text layer and `none` on the overlay canvas. Ship without this toggle in the initial release; add only if testing shows it is necessary. |
| **R2: AbortController cancellation leaves canvas in inconsistent state** | Low | Medium | In `usePdf.ts`, after calling `task.cancel()`, do not mutate canvas dimensions or drawing state. Let the next render call start fresh. Test with 100 rapid zoom changes on a 100-page document to verify no ghost renders. |
| **R3: `file://` encoding fix breaks on a platform not tested (macOS)** | Low | High | Write `pathToFileUrl` with explicit unit tests for all three platforms. Run a macOS CI step or manual test before merging. |
| **R4: Bookmarks tab adds complexity to left panel; outline may be large (thousands of entries)** | Medium | Low | Cap rendering at 5 levels of nesting depth. For documents with >2000 outline items, show a warning and limit to first 2000. Lazy-load children when a `<details>` element is expanded. |

---

## 8. Decision Summary

- **Unicode paths:** Use a cross-platform `pathToFileUrl()` utility with `encodeURI()` and platform-specific prefixing, rather than sending the path through the sidecar for URI conversion or using a custom protocol.
- **Render cancellation:** Use PDF.js built-in `RenderTask.cancel()` via AbortController pattern (not a higher-level Redux action queue) because PDF.js directly supports it.
- **DPR handling:** Multiply canvas pixel dimensions by `devicePixelRatio`; set CSS dimensions to logical pixels. All overlay layers already use CSS pixel coordinates and need no change.
- **Native TextLayer:** Use `pdfjs-dist/display/text_layer` instead of manual `<span>` construction. The native layer handles font metrics, transform matrices, and text-selection hit areas correctly.
- **Single-page DOM:** Render only the current page (not all pages) to reduce DOM size and improve performance for large documents.
- **Fit-width default:** Calculate after first render and store in zustand; add a toolbar button for re-apply. Not recalculated on window resize (deferred).
- **Request guards:** Extract a shared `usePageNavigation` hook from the existing StructureTree pattern. Standardize across Toolbar and page navigation.
- **Bookmarks:** Use PDF.js `getOutline()` from the renderer process (no sidecar round-trip for the tree). Add a sidecar `get_outline` method as a fallback for PDFs where pdfplumber extracts more reliable outline data.
- **Left panel tabs:** Add a lightweight tab bar within a new `LeftPanel` wrapper component. Keep existing StructureTree and BookmarkTree as pure content components with no layout concerns.
- **No "select text mode" toggle in this phase:** The overlay canvas pointer-events remain above the text layer. Text is selectable but the user must click outside overlay objects to start a selection. If this proves too restrictive, a toggle will be added in a follow-up.
