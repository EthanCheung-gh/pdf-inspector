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
| **Rendering cancellation** | `page.render()` called with no cancellation mechanism in `usePdf.ts:67` | Rapid zoom/page changes queue overlapping renders; old renders complete and overwrite the correct result. Blue-text artifacts appear because the canvas `width`/`height` and CSS `width`/`height` get out of sync during resize. |
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
2. Add a `pathToFileUrl(path: string): string` utility function in a new `src/shared/path-utils.ts` that handles cross-platform encoding correctly. The function must:
   - Convert OS-native path separators (`\` on Windows) to `/`.
   - Percent-encode all characters that have special meaning in URLs: `#` → `%23`, `?` → `%3F`, `%` → `%25` (if not already a valid percent-encoding), spaces → `%20`, and all non-ASCII characters.
   - Prepend the correct scheme prefix: `file:///` on all platforms (three slashes) followed by the absolute path. On Windows, the drive letter (e.g., `C:`) becomes part of the path after the triple slash (e.g., `file:///C:/path/to/doc.pdf`).
   - Use `encodeURIComponent` on each path segment individually rather than `encodeURI` on the whole path, to catch `#` and `?` which `encodeURI` leaves untouched.
3. Reference the utility in `PdfViewport.tsx` for the `loadPdf()` call, replacing the current `file://${filePath}` inline construction.

**Implementation of `pathToFileUrl`:**

```typescript
// src/shared/path-utils.ts
export function pathToFileUrl(path: string): string {
  // Normalize backslashes to forward slashes (Windows)
  let normalized = path.replace(/\\/g, '/');

  // Ensure leading slash for absolute paths
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // Split into segments and encode each individually to catch #, ?, %, etc.
  const segments = normalized.split('/').map((seg) =>
    encodeURIComponent(seg)
      .replace(/%2F/g, '/')     // restore path separators
      .replace(/%3A(?=\/)/g, ':') // restore colon before slash (drive letter)
  );
  const encodedPath = segments.join('/');

  return `file://${encodedPath}`;
}
```

**Encoding examples for `pathToFileUrl`:**

| Platform | Input | Output |
|----------|-------|--------|
| Linux    | `/home/用户/doc.pdf` | `file:///home/%E7%94%A8%E6%88%B7/doc.pdf` |
| Windows  | `C:\文档\report.pdf` | `file:///C%3A/%E6%96%87%E6%A1%A3/report.pdf` |
| Windows  | `C:\docs\# report?.pdf` | `file:///C%3A/docs/%23%20report%3F.pdf` |
| macOS    | `/Users/ユーザ/doc.pdf` | `file:///Users/%E3%83%A6%E3%83%BC%E3%82%B6/doc.pdf` |

Note: The Windows drive letter `C:` is encoded as `C%3A` because the colon is not a valid URI character in the path segment. PDF.js handles this correctly via its internal URL parsing.

### 4.2 Cancelable Page Rendering with DPR Awareness

**Problem:** `page.render()` is called without cancellation; DPR is ignored; rapid zoom/page changes produce overlapping renders and blue-text artifacts. The overlay canvas also ignores DPR, causing misalignment on retina displays.

**Solution:**

1. **Add `RenderTask.cancel()` support** to `usePdf.ts:renderPage`. Store the current render task in a `useRef<{ task: pdfjsLib.RenderTask } | null>()` inside `PdfPage.tsx` (the single-page renderer). Before each `page.render()`, call `task.cancel()` on any in-flight task. Since only one page is rendered at a time (see §4.5), a single ref suffices — no `Map<HTMLCanvasElement, ...>` needed.

   ```typescript
   // In PdfPage.tsx
   const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
   
   useEffect(() => {
     // Cancel prior render before starting new one
     renderTaskRef.current?.cancel();
     const task = page.render({ canvasContext: ctx, viewport });
     renderTaskRef.current = task;
     await task.promise;
     renderTaskRef.current = null;
     
     return () => { task.cancel(); };
   }, [pageNum, zoom]);
   ```

2. **DPR-aware canvas sizing for PDF.js canvas:** In `renderPage`, compute:
   ```
   const dpr = window.devicePixelRatio || 1;
   const viewport = page.getViewport({ scale: scale * dpr });
   canvas.width = viewport.width;
   canvas.height = viewport.height;
   canvas.style.width = `${viewport.width / dpr}px`;
   canvas.style.height = `${viewport.height / dpr}px`;
   ```
   This produces a canvas that is `dpr ×` larger in pixels but CSS-sized to the logical dimension.

3. **DPR-aware sizing for OverlayCanvas:** Apply the same DPR scaling in `OverlayCanvas.tsx`. Currently it sets `canvas.width = pageWidth` and `canvas.height = pageHeight` where those values are logical pixels (`pdfWidth * zoom`). Change to:
   ```typescript
   const dpr = window.devicePixelRatio || 1;
   canvas.width = pageWidth * dpr;
   canvas.height = pageHeight * dpr;
   canvas.style.width = `${pageWidth}px`;
   canvas.style.height = `${pageHeight}px`;
   const ctx = canvas.getContext('2d')!;
   ctx.scale(dpr, dpr);
   ```
   The `ctx.scale(dpr, dpr)` call ensures all drawing operations remain in logical-pixel coordinates while the backing store is at full resolution. This eliminates the need to change any existing draw-overlay logic.

### 4.3 PDF.js Native TextLayer with Mode Switching

**Problem:** The current `TextLayer.tsx` manually positions `<span>` elements from `getTextContent`, which doesn't match PDF.js's built-in text selection behavior. Additionally, the overlay canvas captures all pointer events, making it impossible to select text without a mode switch.

**Solution:**

Replace the manual span approach with PDF.js's official `TextLayer` renderer and introduce a two-mode interaction model (Inspect Mode / Select Text Mode) controlled by a toolbar toggle.

#### 4.3.1 Native TextLayer Rendering

1. Import `pdfjs-dist/display/text_layer` (or use the `page.renderTextLayer` API from `pdfjs-dist`).
2. In a refactored `TextLayer.tsx`:
   - Create a container `<div>` for the text layer at the same position and dimensions as the PDF.js canvas.
   - Call `PDFTextLayer.render({ textContent, container, viewport })` — the same API PDF.js's own viewer uses.
   - The text layer's CSS sets `color: transparent` on text spans so the rendered PDF content (visible on the canvas below) shows through, while the text remains in the DOM for selection and copying.

#### 4.3.2 Two-Mode Interaction Design

The toolbar gains a **Select Text** toggle button that switches between two modes:

| Mode | Overlay Canvas `pointer-events` | Text Layer `pointer-events` | Behavior |
|------|-------------------------------|-----------------------------|----------|
| **Inspect** (default) | `auto` | `none` | Mouse events hit-test against PDF objects. Text layer is present but non-interactive. Hit-testing and overlay highlighting work as before. |
| **Select Text** | `none` | `auto` | Overlay canvas passes events through. Text layer accepts clicks and drags for native text selection. Selection highlight is visible through the transparent overlay canvas. Object hover/click is temporarily disabled. |

**Store state:**

```typescript
// In pdf-store.ts
textSelectionMode: boolean;  // default: false
setTextSelectionMode: (mode: boolean) => void;
```

**Component wiring:**

- `OverlayCanvas.tsx` reads `textSelectionMode` from store; when `true`, the canvas element gets `pointer-events: none` via inline style or a CSS class.
- `TextLayer.tsx` reads `textSelectionMode` from store; when `true`, the container gets `pointer-events: auto`; when `false`, gets `pointer-events: none`.
- `Toolbar.tsx` adds a "Select Text" button that toggles `textSelectionMode`. Visual state: when active, the button appears pressed/active (same pattern as overlay toggle buttons). A brief tooltip "Click to toggle text selection mode" helps discoverability.

**Edge cases:**

- When in Select Text mode, the InspectorHighlight and OverlayCanvas are visually inert but remain rendered. The user sees the raw PDF page without overlay bounding boxes. This is intentional — the mode is for text copying, not inspection.
- Switching back to Inspect mode immediately re-enables overlay interactivity. No state is lost.
- Keyboard shortcut `T` toggles the mode as an accessibility fallback.

#### 4.3.3 Text Layer CSS and Positioning

The text layer container is positioned absolutely within `PdfPage.tsx`, layered between the PDF.js canvas (bottom) and the overlay canvas (top):

```css
/* TextLayer.module.css */
.textLayer {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  opacity: 1;
  /* pointer-events set dynamically by mode */
}
.textLayer :global(::selection) {
  background: rgba(0, 0, 255, 0.3); /* visible through overlay canvas */
}
```

#### 4.3.4 Update PdfPage.tsx

Pass the PDF.js page instance (`PDFPageProxy`) to `TextLayer` so it can call `page.getTextContent()` synchronously within the text layer render lifecycle, rather than fetching text content independently.

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
     const navigate = async (page: number): Promise<void> => {
       const id = ++requestIdRef.current;
       const data = await ipc.extractPage(page);
       if (id === requestIdRef.current) {
         usePdfStore.getState().setPageData(data);
       }
     };
     return { navigate };
   }
   ```
   The hook captures the request ID at call time and checks it after the async operation completes. Only the most recent request's result is applied. The hook reads the store directly via `getState()` to avoid stale closures — consumers do not need to subscribe to store state inside the hook.

2. **Refactor `Toolbar.tsx:navigateToPage`** to use `usePageNavigation` instead of directly calling `setPage` + `extractPage` + `setPageData` without a guard.

3. **Refactor `StructureTree.tsx`** to use the shared hook, replacing its current inline `navigationRequestId` pattern. The inline pattern is correct but duplicating it is error-prone.

4. **Refactor `PdfViewport.tsx`** to only render the current page (not all pages). The current code renders all pages in DOM with `isVisible` checks — this is wasteful. Change to render only `currentPage`:
   ```tsx
   // Before: Array.from({length: pageCount}, ...) — all pages in DOM
   // After: only currentPage
   {pdfDoc && <PdfPage pageNum={currentPage} zoom={zoom} pdfDoc={pdfDoc} />}
   ```

5. **Remove `isVisible` prop** from `PdfPage` since only the current page is rendered. The `PdfPage` component becomes simpler — it always renders itself and no longer needs the conditional return.

### 4.6 Bookmarks Tab via PDF.js Outline

**Problem:** The left panel has a single "Structure" tab with no outline/bookmark navigation.

**Solution:**

1. **Add tab bar** to the left panel container (`StructureTree.tsx` → rename to `LeftPanel.tsx` or add tab UI within). Two tabs:
   - **Structure** — existing page-object tree (unchanged behavior)
   - **Bookmarks** — PDF outline rendered from `PDFDocumentProxy.getOutline()`

2. **Use PDF.js `getOutline()` directly** in the renderer process — no round-trip to the sidecar needed. PDF.js parses the document in the renderer and `getOutline()` is available synchronously after document load. The sidecar does not provide outline data.

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
   Populate after `loadPdf` succeeds in `usePdf.ts` via `pdfDoc.getOutline()`.

4. **Destination resolution:** When a bookmark is clicked, the renderer uses `pdfDoc.getDestination(dest)` to resolve the destination to a page number, then calls `setPage(destPageNum)` to navigate. If the destination is an explicit `PDFDestination` array (e.g., `[pageRef, { name: 'XYZ' }, left, top, zoom]`), extract the page index from the first element.

5. **Bookmarks rendering:** A recursive `<BookmarkTree>` component renders nested `<details>`/`<summary>` elements (or a flat tree with indentation). Clicking any item navigates to the target page (position scroll deferred to a follow-up).

6. **Where to add:** Create a new `BookmarkTree.tsx` component in a new `src/renderer/components/LeftPanel/` directory. Keep `StructureTree.tsx` as the content of the Structure tab. Add a tab-switching mechanism at the top of the existing left panel `<aside>`.

### 4.7 Extraction Timeout and Sidecar Restart Recovery

**Problem:** Sidecar extraction calls (e.g., `extractPage(N)`) can hang indefinitely if the PDF page is corrupted, the sidecar crashes, or pdfplumber deadlocks on a malformed object. Currently there is no timeout, so the UI shows a permanent loading state.

**Solution:**

1. **Client-side timeout in `ipc-client.ts`:** Wrap each JSON-RPC call with a configurable timeout (default: 30 seconds). If the sidecar does not respond within the timeout, the promise rejects with a `TimeoutError`.
   ```typescript
   // In ipc-client.ts
   async function call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
     return new Promise((resolve, reject) => {
       const timer = setTimeout(() => {
         reject(new Error(`Sidecar timeout: ${method} exceeded ${timeoutMs}ms`));
       }, timeoutMs);
       // ... send request, on response clearTimeout(timer) and resolve ...
     });
   }
   ```

2. **Timeout propagation:** The `extractPage`, `open`, and all other IPC methods propagate the timeout error. The UI (`Toolbar`, `StructureTree`) handles it via the existing `setError()` store action, showing a dismissible error banner: "Page extraction timed out. The sidecar may have crashed."

3. **Automatic sidecar restart:** In `ipc-client.ts` (or a dedicated `sidecar-health.ts`), detect a timeout or connection error and trigger a sidecar restart flow:
   - Call `window.electronAPI.restartSidecar()` (new IPC handler in main process).
   - After restart completes, retry the failed request once. If it fails again, surface the error to the user.
   - Track restart count per session; if restarts exceed 3 within 60 seconds, show "Sidecar repeatedly crashes. Please restart the application." and stop auto-restarting.

4. **Main-process changes (`ipc-handlers.ts`/`sidecar.ts`):** Add a `restartSidecar` IPC handler that:
   - Kills the existing Python subprocess.
   - Re-spawns it (same logic as initial startup).
   - Re-opens the currently-loaded PDF (path is stored in the main process).
   - Returns success/failure to the renderer.

5. **Extraction retry strategy:** The `usePageNavigation` hook's `navigate` function catches timeout errors. On timeout:
   - Increment a retry counter for the specific page.
   - If retries < 2, wait 1 second and retry (after sidecar restart).
   - After 2 failures on the same page, surface the error and do not retry further.

---

## 5. Files To Change

### New Files

| File | Purpose |
|------|---------|
| `src/shared/path-utils.ts` | Cross-platform `pathToFileUrl(path: string): string` utility |
| `src/renderer/components/LeftPanel/LeftPanel.tsx` | Tabbed container for Structure + Bookmarks tabs |
| `src/renderer/components/LeftPanel/BookmarkTree.tsx` | Recursive outline tree component |
| `src/renderer/components/LeftPanel/LeftPanel.module.css` | Styles for tab bar and panel |
| `src/renderer/components/PdfViewport/TextLayer.module.css` | Required CSS for PDF.js native text layer rendering (positioning, selection styling, pointer-events) |
| `src/renderer/hooks/usePageNavigation.ts` | Shared request-guard navigation hook |

### Modified Files

| File | Changes |
|------|---------|
| `src/renderer/store/pdf-store.ts` | Add `outline`, `fitWidthZoom`, `initialFitWidthZoom`, `textSelectionMode` fields and actions. No `pendingPageRequest` — request guarding is handled entirely by the `usePageNavigation` hook via refs. |
| `src/renderer/hooks/usePdf.ts` | Add DPR-aware render, `RenderTask.cancel()` support, outline loading (`getOutline()` call), fit-width initial zoom |
| `src/renderer/services/ipc-client.ts` | Add client-side 30s timeout wrapper around all JSON-RPC calls; add restart-and-retry logic for timeout errors |
| `src/renderer/components/PdfViewport/PdfViewport.tsx` | Render only current page (`{pdfDoc && <PdfPage pageNum={currentPage} .../>}` instead of `Array.from({length: pageCount})`) |
| `src/renderer/components/PdfViewport/PdfPage.tsx` | Remove `isVisible` prop; pass page instance (`PDFPageProxy`) to TextLayer; add `useRef<RenderTask>` for cancelable rendering; wire mode-dependent `pointer-events` on overlay canvas container |
| `src/renderer/components/PdfViewport/TextLayer.tsx` | Rewrite to use PDF.js native `TextLayer.render()` with the PDF.js page instance instead of manual `<span>` construction; read `textSelectionMode` from store to toggle `pointer-events` |
| `src/renderer/components/PdfViewport/OverlayCanvas.tsx` | Add DPR-aware canvas sizing (`canvas.width = pageWidth * dpr`, `canvas.height = pageHeight * dpr`, `ctx.scale(dpr, dpr)`); set `pointer-events: none` when `textSelectionMode` is `true` |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Replace direct `extractPage` call with `usePageNavigation` hook; add **Fit Width** button; add **Select Text** toggle button |
| `src/renderer/components/StructureTree/StructureTree.tsx` | Refactor to be purely the Structure tab content; replace inline request-guard with shared `usePageNavigation` hook |
| `src/renderer/App.tsx` | Replace `<StructureTree />` with `<LeftPanel />` |
| `src/main/ipc-handlers.ts` | Add `restartSidecar` IPC handler for sidecar crash recovery |
| `src/main/sidecar.ts` | Export a `restartSidecar()` function that kills existing subprocess and re-spawns it |

---

## 6. Testing Strategy

### 6.1 Unit Tests (Vitest)

| Test | What It Covers |
|------|----------------|
| `path-utils.test.ts` | `pathToFileUrl` with ASCII paths, Chinese paths, Windows drive letters, paths with `#` and `?` characters, Linux paths, paths with spaces |
| `usePageNavigation.test.ts` | Request-guard correctly discards stale results when called concurrently; `navigate` calls `setPageData` only for the most recent request |
| `pdf-store.test.ts` | `setFitWidthZoom` bounds clamping to `[0.25, 5]`; `textSelectionMode` toggle; `setPage` clears page data |
| `ipc-client.test.ts` | Timeout wrapper rejects after configured duration; restart-and-retry invokes restart handler on timeout |

### 6.2 Python Tests (pytest)

| Test | What It Covers |
|------|----------------|
| `test_unicode_path.py` | `PdfExtractor.open()` opens PDFs with Chinese, Japanese, and Unicode characters in the file path (note: the path is an OS-native string, not a URI — this test verifies pdfplumber can handle the path) |

The Python test suite is intentionally minimal because reliability changes (timeout, restart, DPR, text layer) are implemented in the TypeScript renderer and main process. The sidecar API surface is unchanged.

### 6.3 Integration Tests (Manual)

The following scenarios will be verified manually during review — automated integration tests are deferred because they require a real Electron environment, a running sidecar, and fixture PDF files:

| Scenario | Verification |
|----------|--------------|
| Open PDF with Chinese filename | PDF loads, all pages render, text layer is selectable |
| Toggle Select Text mode | Overlay canvas pointer-events are suppressed; text is selectable and copyable |
| Rapid page navigation | Final page shows correct data, no stale renders |
| Zoom on retina display | Text is crisp, overlay bboxes align with rendered content; no blue artifacts at any zoom level |
| Sidecar timeout | Artificially slow page shows error banner; sidecar restarts; retry succeeds |
| Click bookmark in outline | Navigates to correct page |

### 6.4 Manual Verification Checklist

- [ ] Open PDF with Chinese/Japanese/Korean filename — loads successfully
- [ ] First page opens at fit-width zoom
- [ ] **Select Text mode:** Toggle on → text is selectable and can be copied; Toggle off → overlay hit-testing works
- [ ] Copy text from TextLayer and paste into text editor — correct characters
- [ ] Rapidly click Next/Prev — no stale page data, no render flicker
- [ ] Open large PDF (500+ pages) — only 1 page rendered, extraction lazy
- [ ] Toggle overlay types — all work correctly
- [ ] Bookmarks tab shows PDF outline; click navigates to correct page
- [ ] No blue-text artifacts at any zoom level on retina display
- [ ] Sidecar crash: kill Python process → error shown → auto-restart → navigation works again
- [ ] Extract timeout: load a PDF with a corrupted page → timeout error shown → retry works

---

## 7. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **R1: Inspect ↔ Select Text mode transition causes visual glitch** | Low | Medium | Both canvas layers remain rendered during mode switch — only `pointer-events` changes. The overlay canvas becomes non-interactive but is still visible. Test mode transitions on documents with dense overlapping objects. |
| **R2: `RenderTask.cancel()` leaves canvas in inconsistent state** | Low | Medium | In `PdfPage.tsx`, after calling `task.cancel()`, do not mutate canvas dimensions or drawing state. Let the next render call start fresh (it clears and re-draws). Test with 100 rapid zoom changes on a 100-page document to verify no ghost renders. |
| **R3: `pathToFileUrl` encoding breaks on untested platform (macOS)** | Low | High | Write explicit unit tests for all three platforms covering ASCII, Unicode, `#`, `?`, and spaces. Run one manual macOS test before merging. The utility is pure string manipulation — no Electron dependency — so tests run in any Node.js environment. |
| **R4: Sidecar timeout/restart causes data loss during active navigation** | Medium | Medium | The `usePageNavigation` hook retries once after restart. If the user navigated away during the timeout, the stale response is discarded by the request-guard. The error banner informs the user without blocking further navigation. |
| **R5: Bookmarks outline contains thousands of entries** | Medium | Low | Cap rendering at 5 levels depth and 2000 items total. Lazy-load children when a `<details>` element is expanded. Show a warning banner for unusually large outlines. |

---

## 8. Decision Summary

- **File URL conversion:** Use a `pathToFileUrl()` utility that splits paths into segments and encodes each with `encodeURIComponent`, then re-joins. This correctly handles non-ASCII characters, `#`, `?`, `%`, spaces, and Windows backslashes in a single pass.
- **Render cancellation:** Use PDF.js built-in `RenderTask.cancel()` stored in a single `useRef<RenderTask | null>` in `PdfPage.tsx`. No `Map<HTMLCanvasElement, ...>` needed because only one page is rendered at a time.
- **DPR handling:** Apply `devicePixelRatio` scaling to both the PDF.js canvas and the OverlayCanvas. The overlay canvas uses `ctx.scale(dpr, dpr)` to keep drawing logic in logical-pixel coordinates.
- **Native TextLayer:** Use `pdfjs-dist/display/text_layer` instead of manual `<span>` construction. The native layer handles font metrics, transform matrices, and text-selection hit areas correctly.
- **Inspect / Select Text modes:** Ship the toggle in this phase. Two-mode design (Inspect default, Select Text toggle) with `pointer-events` switching on both overlay canvas and text layer. Keyboard shortcut `T`.
- **Single-page DOM:** Render only the current page (not all pages) to reduce DOM size and improve performance for large documents.
- **Fit-width default:** Calculate after first render and store in zustand; add a toolbar button for re-apply. Not recalculated on window resize (deferred).
- **Request guards:** Extract a shared `usePageNavigation` hook from the existing StructureTree pattern. Standardize across Toolbar and page navigation. Request-id comparison uses refs, not store state — no `pendingPageRequest` field.
- **Bookmarks:** Use PDF.js `getOutline()` from the renderer process exclusively. No sidecar outline method — the sidecar is not involved in outline extraction.
- **Left panel tabs:** Add a lightweight tab bar within a new `LeftPanel` wrapper component. Keep existing StructureTree and BookmarkTree as pure content components.
- **Extraction timeout:** Add a 30s timeout wrapper in `ipc-client.ts` for all JSON-RPC calls. On timeout, trigger sidecar restart via a new `restartSidecar` IPC handler. Maximum 2 retries per page, capped at 3 restarts per 60 seconds.
- **Sidecar files unchanged:** No modifications to `sidecar/main.py` or `sidecar/extractor.py`. All reliability changes are in the renderer and main process.
