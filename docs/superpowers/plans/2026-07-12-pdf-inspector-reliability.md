# PDF Inspector — Reliability & Navigation Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver six reliability/navigation improvements — Unicode path support, DPR-aware cancelable rendering, native PDF.js TextLayer with Inspect/Select Text mode, fit-width zoom default, request-guard standardization with single-page DOM, and Bookmarks tab — plus extraction timeout and sidecar restart recovery.

**Architecture:** Changes are in three layers: (1) shared/utils (pure string manipulation for path encoding), (2) main process (sidecar restart IPC, stored file path), and (3) renderer (store extensions, new hooks, rewritten PdfPage/OverlayCanvas/TextLayer, new LeftPanel/BookmarkTree components, Toolbar additions). No modifications to the Python sidecar.

**Tech Stack:** TypeScript 5.5+, React 18 + Zustand 5, PDF.js 4.8.69, Electron 28, Vitest 2, CSS Modules.

---

## File Structure — New Files

| File | Purpose |
|------|---------|
| `src/shared/path-utils.ts` | Cross-platform `pathToFileUrl(path)` utility |
| `src/shared/__tests__/path-utils.test.ts` | Unit tests for pathToFileUrl |
| `src/renderer/hooks/usePageNavigation.ts` | Shared request-guard navigation hook |
| `src/renderer/hooks/__tests__/usePageNavigation.test.ts` | Unit tests for usePageNavigation |
| `src/renderer/components/LeftPanel/LeftPanel.tsx` | Tabbed container for Structure + Bookmarks |
| `src/renderer/components/LeftPanel/BookmarkTree.tsx` | Recursive PDF outline tree component |
| `src/renderer/components/LeftPanel/LeftPanel.module.css` | Tab bar and panel styles |
| `src/renderer/components/LeftPanel/BookmarkTree.module.css` | Outline tree styles |
| `src/renderer/components/PdfViewport/TextLayer.module.css` | PDF.js native text layer positioning + selection styles |
| `src/renderer/services/__tests__/ipc-client.test.ts` | Unit tests for timeout/retry |
| `src/renderer/store/__tests__/pdf-store.test.ts` | Unit tests for store extensions |

## File Structure — Modified Files

| File | Changes |
|------|---------|
| `src/shared/constants.ts` | Add `RESTART_SIDECAR` channel |
| `src/renderer/types/ipc-protocol.ts` | Add `restartSidecar()` to `IpcApi` |
| `src/renderer/types/pdf-objects.ts` | Add `PdfOutlineItem` interface |
| `src/preload/index.ts` | Add `restartSidecar` bridge method |
| `src/main/ipc-handlers.ts` | Add `restartSidecar` handler; store current file path |
| `src/main/sidecar.ts` | Add `restart()` method to `SidecarManager` |
| `src/renderer/store/pdf-store.ts` | Add `outline`, `textSelectionMode`, `fitWidthZoom`, `initialFitWidthZoom` fields + actions |
| `src/renderer/hooks/usePdf.ts` | Add outline loading after document load; add fit-width zoom calculation; remove `renderPage` export |
| `src/renderer/services/ipc-client.ts` | Add client-side 30s timeout wrapper; add restart-triggering and retry logic |
| `src/renderer/components/PdfViewport/PdfViewport.tsx` | Single-page DOM rendering; use `pathToFileUrl` for loadPdf |
| `src/renderer/components/PdfViewport/PdfPage.tsx` | Remove `isVisible` prop; add `useRef<RenderTask>` for cancelable DPR-aware rendering; pass page instance to TextLayer; wire pointer-events for text selection mode |
| `src/renderer/components/PdfViewport/OverlayCanvas.tsx` | DPR-aware canvas sizing + `ctx.scale(dpr, dpr)`; `pointer-events: none` when `textSelectionMode` is true |
| `src/renderer/components/PdfViewport/TextLayer.tsx` | Rewrite to use PDF.js `TextLayer.render()`; read `textSelectionMode` from store for pointer-events |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Replace direct `extractPage` with `usePageNavigation` hook; add Fit Width button; add Select Text toggle button |
| `src/renderer/components/StructureTree/StructureTree.tsx` | Use shared `usePageNavigation` hook; remove inline `navigationRequestId`; remove `<aside>` wrapper (becomes pure tab content) |
| `src/renderer/App.tsx` | Replace `<StructureTree />` with `<LeftPanel />`; add keyboard shortcut `T` for text mode toggle |

---

### Task 1: Create `pathToFileUrl` utility with tests

**Files:**
- Create: `src/shared/path-utils.ts`
- Create: `src/shared/__tests__/path-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Write the test file `src/shared/__tests__/path-utils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { pathToFileUrl } from '../path-utils';

describe('pathToFileUrl', () => {
  it('handles ASCII Linux path', () => {
    expect(pathToFileUrl('/home/user/doc.pdf')).toBe('file:///home/user/doc.pdf');
  });

  it('handles Chinese characters in path', () => {
    expect(pathToFileUrl('/home/用户/doc.pdf')).toBe(
      'file:///home/%E7%94%A8%E6%88%B7/doc.pdf'
    );
  });

  it('handles Japanese characters in path', () => {
    expect(pathToFileUrl('/Users/ユーザ/doc.pdf')).toBe(
      'file:///Users/%E3%83%A6%E3%83%BC%E3%82%B6/doc.pdf'
    );
  });

  it('handles spaces in path', () => {
    expect(pathToFileUrl('/home/user/my doc.pdf')).toBe(
      'file:///home/user/my%20doc.pdf'
    );
  });

  it('encodes # character in path', () => {
    expect(pathToFileUrl('/home/user/#report.pdf')).toBe(
      'file:///home/user/%23report.pdf'
    );
  });

  it('encodes ? character in path', () => {
    expect(pathToFileUrl('/home/user/report?.pdf')).toBe(
      'file:///home/user/report%3F.pdf'
    );
  });

  it('handles Windows drive letter', () => {
    expect(pathToFileUrl('C:\\docs\\report.pdf')).toBe(
      'file:///C%3A/docs/report.pdf'
    );
  });

  it('handles Windows path with Chinese and special chars', () => {
    expect(pathToFileUrl('C:\\文档\\# report?.pdf')).toBe(
      'file:///C%3A/%E6%96%87%E6%A3%A3/%23%20report%3F.pdf'
    );
  });

  it('handles Windows path with backslashes', () => {
    expect(pathToFileUrl('D:\\data\\test\\file.pdf')).toBe(
      'file:///D%3A/data/test/file.pdf'
    );
  });

  it('handles empty path segments (root path)', () => {
    expect(pathToFileUrl('/')).toBe('file:///');
  });

  it('does not double-encode already-encoded percent sequences', () => {
    // %20 should remain %20, not become %2520
    const result = pathToFileUrl('/home/user/file%20name.pdf');
    // The % in the path should be encoded as %25, then encodeURIComponent would encode it
    // So the raw segment "file%20name.pdf" -> encodeURIComponent -> "file%2520name.pdf" 
    // But then we reconstruct... 
    // Actually the input is a literal filesystem path, so %20 here is literally
    // a percent sign followed by 20 in the filename. Let's verify the behavior.
    expect(result).toBe('file:///home/user/file%2520name.pdf');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/shared/__tests__/path-utils.test.ts`
Expected: FAIL — `pathToFileUrl` is not exported (module not found yet).

- [ ] **Step 3: Create the implementation**

Write `src/shared/path-utils.ts`:

```typescript
/**
 * Convert an OS-native absolute file path to a file:// URL.
 *
 * Handles:
 * - Backslash separators (Windows)
 * - Non-ASCII characters via encodeURIComponent on each segment
 * - Special URL characters (#, ?, %) in the path
 * - Windows drive letters (e.g., C:)
 */
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
      .replace(/%2F/g, '/')       // restore path separators
      .replace(/%3A(?=\/)/g, ':'), // restore colon before slash (drive letter)
  );
  const encodedPath = segments.join('/');

  return `file://${encodedPath}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/path-utils.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-utils.ts src/shared/__tests__/path-utils.test.ts
git commit -m "feat: add pathToFileUrl utility for Unicode-safe file:// URL conversion"
```

---

### Task 2: Add `RESTART_SIDECAR` IPC channel + update types + preload bridge

**Files:**
- Modify: `src/shared/constants.ts:1-8`
- Modify: `src/renderer/types/ipc-protocol.ts:1-17`
- Modify: `src/preload/index.ts:1-10`

- [ ] **Step 1: Add `RESTART_SIDECAR` to IPC_CHANNELS constants**

Edit `src/shared/constants.ts`. Change from:

```typescript
export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
} as const;
```

To:

```typescript
export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
  RESTART_SIDECAR: 'pdf:restart-sidecar',
} as const;
```

- [ ] **Step 2: Add `restartSidecar` to `IpcApi` interface**

Edit `src/renderer/types/ipc-protocol.ts`. Change from:

```typescript
export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
}
```

To:

```typescript
export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
  restartSidecar(): Promise<{ success: boolean; error?: string }>;
}
```

- [ ] **Step 3: Add `restartSidecar` to the preload bridge**

Edit `src/preload/index.ts`. Change from:

```typescript
contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  getImageData: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_DATA, streamId),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
});
```

To:

```typescript
contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  getImageData: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_DATA, streamId),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
  restartSidecar: () => ipcRenderer.invoke(IPC_CHANNELS.RESTART_SIDECAR),
});
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants.ts src/renderer/types/ipc-protocol.ts src/preload/index.ts
git commit -m "feat: add RESTART_SIDECAR IPC channel, type, and preload bridge"
```

---

### Task 3: Add `restart()` method to `SidecarManager` + IPC handler + file path storage

**Files:**
- Modify: `src/main/sidecar.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add `restart()` method to `SidecarManager`**

Edit `src/main/sidecar.ts`. Add the following method after the existing `stop()` method (before the closing class brace, after line 224):

```typescript
  /**
   * Restart the sidecar subprocess: kill the existing process, re-spawn,
   * and wait for the ready signal. Throws if restart fails.
   */
  async restart(): Promise<void> {
    this.autoRestartEnabled = false; // prevent auto-restart during manual restart
    const wasRunning = this.isRunning();
    if (wasRunning) {
      try {
        await this.send('shutdown');
      } catch {
        // Ignore shutdown errors
      }
      this.process?.kill();
      this.process = null;
    }
    this.rejectPendingRequests(new Error('Sidecar is restarting'));
    this.autoRestartEnabled = true;
    await this.start();
  }
```

- [ ] **Step 2: Add `restartSidecar` IPC handler + store current file path**

Edit `src/main/ipc-handlers.ts`. Change from:

```typescript
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { SidecarManager } from './sidecar';
import { IPC_CHANNELS } from '../shared/constants';

export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC_CHANNELS.OPEN_PDF, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const meta = await sidecar.send('open', { path: filePath });
    return { canceled: false, path: filePath, metadata: meta };
  });

  // ...rest of handlers
}
```

To:

```typescript
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { SidecarManager } from './sidecar';
import { IPC_CHANNELS } from '../shared/constants';

/** Tracks the currently open PDF path so the sidecar can re-open it after restart. */
let currentFilePath: string | null = null;

export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC_CHANNELS.OPEN_PDF, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const meta = await sidecar.send('open', { path: filePath });
    currentFilePath = filePath;
    return { canceled: false, path: filePath, metadata: meta };
  });

  ipcMain.handle(IPC_CHANNELS.RESTART_SIDECAR, async () => {
    try {
      await sidecar.restart();
      // Re-open the current PDF after restart
      if (currentFilePath) {
        await sidecar.send('open', { path: currentFilePath });
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  // ...existing handlers for EXTRACT_PAGE, EXTRACT_METADATA, GET_IMAGE_DATA, SIDECAR_STATUS (unchanged)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/main/sidecar.ts src/main/ipc-handlers.ts
git commit -m "feat: add SidecarManager.restart() method and restartSidecar IPC handler with file path storage"
```

---

### Task 4: Extend zustand store with new state fields and actions

**Files:**
- Modify: `src/renderer/store/pdf-store.ts`
- Modify: `src/renderer/types/pdf-objects.ts` (add `PdfOutlineItem`)
- Create: `src/renderer/store/__tests__/pdf-store.test.ts`

- [ ] **Step 1: Add `PdfOutlineItem` type to pdf-objects.ts**

Edit `src/renderer/types/pdf-objects.ts`. Append before the closing of the file (after line 87):

```typescript
export interface PdfOutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}
```

- [ ] **Step 2: Extend the store with new fields**

Edit `src/renderer/store/pdf-store.ts`. Changes:

(2a) Import `PdfOutlineItem` and add the `PDFDocumentProxy` type import:

```typescript
import { PdfObject, PdfMetadata, PageData, PdfOutlineItem } from '../types/pdf-objects';
import type { PDFDocumentProxy } from 'pdfjs-dist';
```

(2b) Add these fields to the `PdfState` interface after existing fields:

```typescript
  // PDF.js document reference (shared for outline destination resolution)
  pdfDocRef: PDFDocumentProxy | null;

  // Outline / bookmarks
  outline: PdfOutlineItem[] | null;

  // Fit-width zoom
  fitWidthZoom: number | null;
  initialFitWidthZoom: boolean;

  // Text selection mode
  textSelectionMode: boolean;
```

(2c) Add these actions to the `PdfState` interface after existing actions:

```typescript
  setPdfDocRef: (doc: PDFDocumentProxy | null) => void;
  setOutline: (outline: PdfOutlineItem[] | null) => void;
  setFitWidthZoom: (zoom: number | null) => void;
  setTextSelectionMode: (mode: boolean) => void;
```

(2d) Add initial values for new fields after existing initial values (after line 45 `zoom: 1.0,`):

```typescript
  pdfDocRef: null,
  outline: null,
  fitWidthZoom: null,
  initialFitWidthZoom: false,
  textSelectionMode: false,
```

(2e) Add action implementations after existing actions (after `clearSelection` at line 111):

```typescript
  setPdfDocRef: (doc) => set({ pdfDocRef: doc }),

  setOutline: (outline) => set({ outline }),

  setFitWidthZoom: (zoom) => {
    if (zoom === null) {
      set({ fitWidthZoom: null });
      return;
    }
    const clamped = Math.max(0.25, Math.min(5, zoom));
    set({ fitWidthZoom: clamped, zoom: clamped });
  },

  setTextSelectionMode: (mode) => set({ textSelectionMode: mode }),
```

(2f) Update `setFile` to reset `initialFitWidthZoom` and `pdfDocRef`:

Change the `setFile` action (line 66) to also reset:
```typescript
  setFile: (path, meta) =>
    set({
      filePath: path,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
    }),
```

- [ ] **Step 3: Write and run store unit tests**

Create `src/renderer/store/__tests__/pdf-store.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { usePdfStore } from '../pdf-store';

describe('pdf-store', () => {
  beforeEach(() => {
    // Reset store to initial state
    usePdfStore.setState({
      filePath: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      zoom: 1.0,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      overlayVisibility: {
        char: true, word: true, rect: true, line: true, curve: true, image: true, table: true,
      },
      isLoading: false,
      sidecarRunning: false,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      initialFitWidthZoom: false,
      textSelectionMode: false,
    });
  });

  it('setPdfDocRef stores the document reference', () => {
    const { setPdfDocRef } = usePdfStore.getState();
    const fakeDoc = { fake: true } as any;
    setPdfDocRef(fakeDoc);
    expect(usePdfStore.getState().pdfDocRef).toBe(fakeDoc);
  });

  it('setFitWidthZoom clamps to minimum of 0.25', () => {
    const { setFitWidthZoom, zoom } = usePdfStore.getState();
    setFitWidthZoom(0.1);
    expect(usePdfStore.getState().zoom).toBe(0.25);
  });

  it('setFitWidthZoom clamps to maximum of 5', () => {
    const { setFitWidthZoom } = usePdfStore.getState();
    setFitWidthZoom(10);
    expect(usePdfStore.getState().zoom).toBe(5);
  });

  it('setFitWidthZoom sets zoom and fitWidthZoom in range', () => {
    const { setFitWidthZoom } = usePdfStore.getState();
    setFitWidthZoom(1.5);
    const state = usePdfStore.getState();
    expect(state.zoom).toBe(1.5);
    expect(state.fitWidthZoom).toBe(1.5);
  });

  it('setFitWidthZoom(null) resets fitWidthZoom without changing zoom', () => {
    const { setFitWidthZoom, setZoom } = usePdfStore.getState();
    setZoom(2);
    setFitWidthZoom(null);
    const state = usePdfStore.getState();
    expect(state.fitWidthZoom).toBeNull();
    expect(state.zoom).toBe(2);
  });

  it('setTextSelectionMode toggles the mode', () => {
    const { setTextSelectionMode } = usePdfStore.getState();
    expect(usePdfStore.getState().textSelectionMode).toBe(false);
    setTextSelectionMode(true);
    expect(usePdfStore.getState().textSelectionMode).toBe(true);
    setTextSelectionMode(false);
    expect(usePdfStore.getState().textSelectionMode).toBe(false);
  });

  it('setPage clears page data and selection', () => {
    usePdfStore.setState({
      currentPage: 1,
      pageData: {} as any,
      hoveredObject: {} as any,
      selectedObject: {} as any,
    });
    usePdfStore.getState().setPage(5);
    const state = usePdfStore.getState();
    expect(state.currentPage).toBe(5);
    expect(state.pageData).toBeNull();
    expect(state.hoveredObject).toBeNull();
    expect(state.selectedObject).toBeNull();
  });

  it('setOutline stores outline data', () => {
    const { setOutline } = usePdfStore.getState();
    const outline = [{ title: 'Chapter 1', bold: false, italic: false, dest: null, items: [] }];
    setOutline(outline);
    expect(usePdfStore.getState().outline).toEqual(outline);
  });
});
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/types/pdf-objects.ts src/renderer/store/pdf-store.ts src/renderer/store/__tests__/pdf-store.test.ts
git commit -m "feat: extend store with outline, textSelectionMode, fitWidthZoom fields and actions"
```

---

### Task 5: Create shared `usePageNavigation` hook with tests

**Files:**
- Create: `src/renderer/hooks/usePageNavigation.ts`
- Create: `src/renderer/hooks/__tests__/usePageNavigation.test.ts`

- [ ] **Step 1: Install testing-library for hook tests**

Run: `npm install --save-dev @testing-library/react @testing-library/jest-dom jsdom`

Add `jsdom` environment for hook test files by editing `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // jsdom environment needed for hook tests — set per-file with @vitest-environment pragma
  },
});
```

No change needed — the environment pragma `// @vitest-environment jsdom` at the top of individual test files handles this.

- [ ] **Step 2: Write the failing tests**

Create `src/renderer/hooks/__tests__/usePageNavigation.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePageNavigation } from '../usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';

// Mock ipc-client
vi.mock('../../services/ipc-client', () => ({
  ipc: {
    extractPage: vi.fn(),
  },
}));

import { ipc } from '../../services/ipc-client';

describe('usePageNavigation', () => {
  beforeEach(() => {
    // Reset store
    usePdfStore.setState({
      pageCount: 10,
      currentPage: 1,
      pageData: null,
      error: null,
      isLoading: false,
    });
    vi.clearAllMocks();
  });

  it('navigates to a page and sets pageData', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    vi.mocked(ipc.extractPage).mockResolvedValue(pageData);

    const { result } = renderHook(() => usePageNavigation());
    await act(async () => {
      await result.current.navigate(3);
    });

    expect(usePdfStore.getState().currentPage).toBe(3);
    expect(usePdfStore.getState().pageData).toEqual(pageData);
  });

  it('discards stale results when called concurrently (request guard)', async () => {
    const page2Data = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    const page5Data = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };

    vi.mocked(ipc.extractPage)
      .mockResolvedValueOnce(page2Data)
      .mockResolvedValueOnce(page5Data);

    const { result } = renderHook(() => usePageNavigation());

    // Initiate both navigations concurrently
    await act(async () => {
      await Promise.all([
        result.current.navigate(2),
        result.current.navigate(5),
      ]);
    });

    // Only the last navigation's data should be in the store
    expect(usePdfStore.getState().currentPage).toBe(5);
    expect(usePdfStore.getState().pageData).toEqual(page5Data);
  });

  it('handles out-of-range page number gracefully', async () => {
    const { result } = renderHook(() => usePageNavigation());
    await act(async () => {
      await result.current.navigate(0);
    });
    expect(ipc.extractPage).not.toHaveBeenCalled();
  });

  it('sets error when extraction fails', async () => {
    vi.mocked(ipc.extractPage).mockRejectedValue(new Error('Extraction failed'));

    const { result } = renderHook(() => usePageNavigation());
    await act(async () => {
      await result.current.navigate(3);
    });

    expect(usePdfStore.getState().error).toBe('Failed to load page data. Please try again.');
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `npx vitest run src/renderer/hooks/__tests__/usePageNavigation.test.ts`
Expected: FAIL — `usePageNavigation` not exported.

- [ ] **Step 4: Create the hook**

Create `src/renderer/hooks/usePageNavigation.ts`:

```typescript
import { useRef, useCallback } from 'react';
import { ipc } from '../services/ipc-client';
import { usePdfStore } from '../store/pdf-store';

export function usePageNavigation() {
  const requestIdRef = useRef(0);

  const navigate = useCallback(async (page: number): Promise<void> => {
    const { pageCount } = usePdfStore.getState();
    if (page < 1 || page > pageCount) return;

    const store = usePdfStore.getState();
    const requestId = ++requestIdRef.current;

    store.setError(null);
    store.setLoading(true);
    store.setPage(page);

    try {
      const data = await ipc.extractPage(page);
      if (requestId === requestIdRef.current) {
        store.setPageData(data);
      }
    } catch (error) {
      console.error('Failed to load page data:', error);
      if (requestId === requestIdRef.current) {
        store.setError('Failed to load page data. Please try again.');
      }
    } finally {
      if (requestId === requestIdRef.current) {
        store.setLoading(false);
      }
    }
  }, []);

  return { navigate };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/hooks/__tests__/usePageNavigation.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/hooks/usePageNavigation.ts src/renderer/hooks/__tests__/usePageNavigation.test.ts
git commit -m "feat: add usePageNavigation hook with request-guard pattern"
```

---

### Task 6: Update `usePdf.ts` with outline loading + fit-width zoom calculation + remove renderPage

**Files:**
- Modify: `src/renderer/hooks/usePdf.ts`

- [ ] **Step 1: Update `usePdf.ts`**

Edit `src/renderer/hooks/usePdf.ts`. Complete rewrite:

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { usePdfStore } from '../store/pdf-store';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface UsePdfReturn {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  loading: boolean;
  error: string | null;
  loadPdf: (url: string) => Promise<void>;
}

export function usePdf(): UsePdfReturn {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadIdRef = useRef(0);

  // Destroy PDF document on unmount
  useEffect(() => {
    return () => {
      if (pdfRef.current) {
        pdfRef.current.destroy();
        pdfRef.current = null;
      }
    };
  }, []);

  const loadPdf = useCallback(async (url: string) => {
    const loadId = ++loadIdRef.current;
    const store = usePdfStore.getState();
    setLoading(true);
    setError(null);
    store.setLoading(true);

    try {
      if (pdfRef.current) {
        pdfRef.current.destroy();
      }
      const doc = await pdfjsLib.getDocument(url).promise;
      if (loadId !== loadIdRef.current) {
        doc.destroy();
        return;
      }
      pdfRef.current = doc;
      setPdfDoc(doc);
      store.setPdfDocRef(doc);  // Store in zustand so LeftPanel/BookmarkTree can access it

      // Load outline (bookmarks) after document is ready
      try {
        const outline = await doc.getOutline();
        if (loadId === loadIdRef.current) {
          store.setOutline(outline as any);
        }
      } catch (outlineErr) {
        console.warn('Failed to load PDF outline:', outlineErr);
        if (loadId === loadIdRef.current) {
          store.setOutline(null);
        }
      }

      // Calculate fit-width zoom from first page
      try {
        const firstPage = await doc.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        const H_PADDING = 48; // 24px each side
        const containerWidth = store.fitWidthZoom
          ? (window.innerWidth - 220 - 300) // viewport area: total width minus left panel minus inspector
          : window.innerWidth - 220; // rough estimate

        const availableWidth = Math.max(containerWidth - H_PADDING, 200);
        const fitWidthZoom = availableWidth / viewport.width;
        const clamped = Math.max(0.25, Math.min(5, fitWidthZoom));

        if (loadId === loadIdRef.current) {
          store.setFitWidthZoom(clamped);
        }
      } catch (zoomErr) {
        console.warn('Failed to calculate fit-width zoom:', zoomErr);
      }
    } catch (err) {
      if (loadId !== loadIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load PDF';
      setError(message);
      store.setError(message);
    } finally {
      if (loadId === loadIdRef.current) {
        setLoading(false);
        store.setLoading(false);
      }
    }
  }, []);

  return { pdfDoc, loading, error, loadPdf };
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No errors related to `usePdf.ts`. (Some other pre-existing errors may appear — ignore those.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/usePdf.ts
git commit -m "feat: add outline loading and fit-width zoom calc to usePdf; remove renderPage export"
```

---

### Task 7: Update `ipc-client.ts` with timeout wrapper and restart-with-retry logic

**Files:**
- Modify: `src/renderer/services/ipc-client.ts`
- Create: `src/renderer/services/__tests__/ipc-client.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/services/__tests__/ipc-client.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock window.pdfInspector
const mockRestartSidecar = vi.fn();
const mockExtractPage = vi.fn();

globalThis.window = {
  pdfInspector: {
    restartSidecar: mockRestartSidecar,
    extractPage: mockExtractPage,
    openPdf: vi.fn(),
    extractMetadata: vi.fn(),
    getImageData: vi.fn(),
    getSidecarStatus: vi.fn(),
  },
} as any;

import { ipc } from '../ipc-client';

describe('ipc-client timeout and retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('extractPage resolves with data when sidecar responds in time', async () => {
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockExtractPage.mockResolvedValue(pageData);

    const promise = ipc.extractPage(3);
    const result = await promise;

    expect(result).toEqual(pageData);
    expect(mockExtractPage).toHaveBeenCalledWith(3);
  });

  it('extractPage rejects with timeout error when response exceeds 30s', async () => {
    // Mock to never resolve
    mockExtractPage.mockImplementation(() => new Promise(() => {}));

    const promise = ipc.extractPage(3);

    // Fast-forward 31s
    await vi.advanceTimersByTimeAsync(31000);

    await expect(promise).rejects.toThrow('Sidecar timeout: extractPage');
  });

  it('restart-and-retry: triggers restart and retries on timeout, single retry succeeds', async () => {
    mockRestartSidecar.mockResolvedValue({ success: true });

    // First call hangs, second succeeds
    let callCount = 0;
    const pageData = { width: 612, height: 792, chars: [], words: [], rects: [], lines: [], curves: [], images: [], tables: [] };
    mockExtractPage.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return new Promise(() => {}); // hangs
      return Promise.resolve(pageData);
    });

    const promise = ipc.extractPage(3);

    // Fast-forward past 30s timeout
    await vi.advanceTimersByTimeAsync(31000);

    // Should have called restartSidecar and retried
    expect(mockRestartSidecar).toHaveBeenCalled();

    const result = await promise;
    expect(result).toEqual(pageData);
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/renderer/services/__tests__/ipc-client.test.ts`
Expected: FAIL — current `ipc` object doesn't have timeout/retry.

- [ ] **Step 3: Implement the timeout + restart wrapper**

Edit `src/renderer/services/ipc-client.ts`. Rewrite:

```typescript
import { IpcApi } from '../types/ipc-protocol';

declare global {
  interface Window {
    pdfInspector: IpcApi;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

let restartTimestamps: number[] = [];

/**
 * Check whether we've exceeded the maximum restart rate within the time window.
 */
function withinRestartBudget(): boolean {
  const now = Date.now();
  // Prune timestamps outside the window
  restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
  return restartTimestamps.length < MAX_RESTARTS;
}

/**
 * Call a sidecar IPC method with a timeout. On timeout, attempt to restart the
 * sidecar (up to the rate limit) and retry once. If the retry also fails, the
 * error propagates to the caller.
 */
async function callWithTimeout<T>(
  fn: () => Promise<T>,
  method: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // First attempt
  try {
    return await withTimeout(fn, method, timeoutMs);
  } catch (err) {
    // Only handle timeout errors with restart flow
    if (!(err instanceof Error && err.message.startsWith('Sidecar timeout:'))) {
      throw err;
    }

    if (!withinRestartBudget()) {
      throw new Error(
        'Sidecar repeatedly crashes. Please restart the application.',
      );
    }

    // Trigger sidecar restart
    restartTimestamps.push(Date.now());
    try {
      const result = await window.pdfInspector.restartSidecar();
      if (!result.success) {
        throw new Error(`Sidecar restart failed: ${result.error || 'Unknown error'}`);
      }
    } catch (restartErr) {
      throw new Error(
        `Sidecar restart failed: ${restartErr instanceof Error ? restartErr.message : 'Unknown error'}`,
      );
    }

    // Retry once after restart
    return withTimeout(fn, method, timeoutMs);
  }
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  method: string,
  timeoutMs: number,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Sidecar timeout: ${method} exceeded ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]);
}

export const ipc = {
  openPdf: () => callWithTimeout(() => window.pdfInspector.openPdf(), 'openPdf'),
  extractPage: (page: number) =>
    callWithTimeout(() => window.pdfInspector.extractPage(page), 'extractPage'),
  extractMetadata: () =>
    callWithTimeout(() => window.pdfInspector.extractMetadata(), 'extractMetadata'),
  getImageData: (streamId: string) =>
    callWithTimeout(() => window.pdfInspector.getImageData(streamId), 'getImageData'),
  getSidecarStatus: () =>
    callWithTimeout(() => window.pdfInspector.getSidecarStatus(), 'getSidecarStatus'),
  restartSidecar: () =>
    callWithTimeout(() => window.pdfInspector.restartSidecar(), 'restartSidecar'),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/services/__tests__/ipc-client.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/ipc-client.ts src/renderer/services/__tests__/ipc-client.test.ts
git commit -m "feat: add client-side timeout, sidecar restart, and retry to ipc-client"
```

---

### Task 8: Rewrite PdfPage.tsx with cancelable DPR-aware rendering + text selection mode

**Files:**
- Modify: `src/renderer/components/PdfViewport/PdfPage.tsx`

- [ ] **Step 1: Rewrite PdfPage.tsx**

Edit `src/renderer/components/PdfViewport/PdfPage.tsx`. Complete rewrite:

```tsx
import React, { useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { usePdfStore } from '../../store/pdf-store';
import { OverlayCanvas } from './OverlayCanvas';
import { InspectorHighlight } from './InspectorHighlight';
import { TextLayer } from './TextLayer';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import styles from './PdfPage.module.css';

interface PdfPageProps {
  pageNum: number;
  zoom: number;
  pdfDoc: PDFDocumentProxy | null;
}

export const PdfPage: React.FC<PdfPageProps> = ({ pageNum, zoom, pdfDoc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const metadata = usePdfStore((s) => s.metadata);
  const textSelectionMode = usePdfStore((s) => s.textSelectionMode);

  // Cancelable DPR-aware page rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc) return;

    let cancelled = false;

    const render = async () => {
      // Cancel any in-flight render
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      try {
        const dpr = window.devicePixelRatio || 1;
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        const ctx = canvas.getContext('2d')!;
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
      } catch (err) {
        // Ignore cancellation errors — they're expected during rapid navigation
        if (err instanceof Error && err.message === 'Rendering cancelled') {
          return;
        }
        console.error('Page render error:', err);
      }
    };

    void render();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pageNum, zoom, pdfDoc]);

  if (!pdfDoc) return null;

  const pageWidth = metadata?.page_w ? metadata.page_w * zoom : 612 * zoom;
  const pageHeight = metadata?.page_h ? metadata.page_h * zoom : 792 * zoom;

  return (
    <div className={styles.pageContainer} style={{ width: pageWidth, height: pageHeight }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <TextLayer pageNum={pageNum} pdfDoc={pdfDoc} zoom={zoom} />
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={metadata?.page_w || 612}
        pdfHeight={metadata?.page_h || 792}
      />
      <InspectorHighlight pageNum={pageNum} />
    </div>
  );
};
```

Note: The `TextLayer` props changed — `scale`/`width`/`height` replaced with `zoom` (the TextLayer receives `pdfDoc` and computes its own dimensions from the PDF page viewport).

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/PdfViewport/PdfPage.tsx
git commit -m "feat: rewrite PdfPage with cancelable RenderTask, DPR-aware canvas, text selection mode wiring"
```

---

### Task 9: Rewrite OverlayCanvas.tsx with DPR scaling + text selection pointer-events

**Files:**
- Modify: `src/renderer/components/PdfViewport/OverlayCanvas.tsx`

- [ ] **Step 1: Rewrite OverlayCanvas.tsx**

Edit `src/renderer/components/PdfViewport/OverlayCanvas.tsx`. Complete rewrite:

```tsx
import React, { useEffect, useRef } from 'react';
import { useHitTest } from '../../hooks/useHitTest';
import { useOverlay } from '../../hooks/useOverlay';
import { usePdfStore } from '../../store/pdf-store';

interface OverlayCanvasProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const allObjects = usePdfStore((state) => state.allObjects);
  const pageData = usePdfStore((state) => state.pageData);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const setHoveredObject = usePdfStore((state) => state.setHoveredObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const { drawOverlays } = useOverlay();
  const { hitTest } = useHitTest();

  // DPR-aware canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = pageWidth * dpr;
    canvas.height = pageHeight * dpr;
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const context = canvas.getContext('2d');
    if (context) {
      context.scale(dpr, dpr);
      drawOverlays(context, allObjects, overlayVisibility, pageWidth, pageHeight, pdfWidth, pdfHeight);
    }
  }, [allObjects, drawOverlays, overlayVisibility, pageData, pageWidth, pageHeight, pdfWidth, pdfHeight]);

  const getHoveredObject = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(
      allObjects,
      event.clientX - rect.left,
      event.clientY - rect.top,
      pdfWidth,
      pdfHeight,
      rect.width,
      rect.height,
    );
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseMove={(event) => setHoveredObject(getHoveredObject(event))}
      onClick={() => setSelectedObject(usePdfStore.getState().hoveredObject)}
      onMouseLeave={() => setHoveredObject(null)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: pageWidth,
        height: pageHeight,
        cursor: textSelectionMode ? 'auto' : 'crosshair',
        pointerEvents: textSelectionMode ? 'none' : 'auto',
      }}
      aria-label={`PDF page ${pageNum} object overlay`}
    />
  );
};
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/PdfViewport/OverlayCanvas.tsx
git commit -m "feat: DPR-aware scaling in OverlayCanvas; respect textSelectionMode for pointer-events"
```

---

### Task 10: Rewrite TextLayer.tsx with native PDF.js TextLayer — always-rendered container, no return-null deadlock + PdfPage prop migration

**Files:**
- Create: `src/renderer/components/PdfViewport/TextLayer.module.css`
- Rewrite: `src/renderer/components/PdfViewport/TextLayer.tsx`
- Modify: `src/renderer/components/PdfViewport/PdfPage.tsx`

> **Contract change:** The `TextLayer` component now receives `zoom` instead of `scale`/`width`/`height`. It receives `pdfDoc` and computes its own dimensions from the PDF.js page viewport. PdfPage.tsx must be updated to match the new interface.

> **Deadlock fix:** The TextLayer container `<div>` is **always rendered** — never conditionally. Before dimensions are known, it renders at 0×0 (inheriting the page container's layout). The effect then sets `container.style.width` / `container.style.height` after resolving the viewport. This avoids the deadlock where `return null` on first render prevents the container ref from existing, which prevents the effect from running, which prevents dimensions from ever being set.

- [ ] **Step 1: Verify/update PdfPage.tsx TextLayer invocation**

Open `src/renderer/components/PdfViewport/PdfPage.tsx` and inspect the `<TextLayer>` invocation. Task 8 should have already changed it to the new prop pattern. Verify the line reads:

```tsx
<TextLayer pageNum={pageNum} pdfDoc={pdfDoc} zoom={zoom} />
```

If the file was reverted or Task 8 was skipped, and the line still uses the old `scale`/`width`/`height` props:

```tsx
<TextLayer pageNum={pageNum} pdfDoc={pdfDoc} scale={zoom} width={pageWidth} height={pageHeight} />
```

then apply this edit to update it. The TextLayer contract changed — it now receives `zoom` instead of `scale`/`width`/`height`, and computes its own dimensions from the PDF.js page viewport.

⚠️ Note: `pageWidth` and `pageHeight` variables are still used for the parent container `<div>` and for `<OverlayCanvas>` — do NOT remove them. Only the `<TextLayer>` props change.

- [ ] **Step 2: Create the CSS module for TextLayer**

Create `src/renderer/components/PdfViewport/TextLayer.module.css`:

```css
.textLayer {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  opacity: 1;
  line-height: 1;
  /* pointer-events and user-select set dynamically by mode via inline style */
}

.textLayer :global(::selection) {
  background: rgba(0, 0, 255, 0.3);
}
```

- [ ] **Step 3: Rewrite TextLayer.tsx — always render container, never return null**

Edit `src/renderer/components/PdfViewport/TextLayer.tsx`. Complete rewrite:

```tsx
import React, { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TextLayer as PdfjsTextLayer } from 'pdfjs-dist/display/text_layer';
import { usePdfStore } from '../../store/pdf-store';
import styles from './TextLayer.module.css';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy | null;
  zoom: number;
}

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, zoom }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textSelectionMode = usePdfStore((s) => s.textSelectionMode);

  // Load text content and render using PDF.js native TextLayer.
  // The container <div> is ALWAYS rendered (no early return null),
  // so containerRef.current is always available when this effect runs.
  // Dimensions are applied directly to the DOM element after viewport resolution.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDoc) return;

    let cancelled = false;

    const renderText = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom });

        // Set container dimensions from viewport (container is always rendered)
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        // Clear previous text layer content from the container
        container.innerHTML = '';

        // Render using PDF.js native TextLayer
        PdfjsTextLayer.render({
          textContent,
          container,
          viewport,
        });
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to load text for page ${pageNum}:`, error);
        }
      }
    };

    void renderText();

    return () => {
      cancelled = true;
      // Clean up: clear children and reset dimensions so next mount starts fresh
      if (container) {
        container.innerHTML = '';
        container.style.width = '';
        container.style.height = '';
      }
    };
  }, [pageNum, pdfDoc, zoom]);

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

Key design decisions:
- **No `dimensions` state** — avoids the `return null` deadlock entirely. The container div is always rendered; its width/height are set via `container.style` in the effect.
- **Cleanup resets styles** — `container.style.width = ''` and `container.style.height = ''` so the next mount doesn't inherit stale dimensions.
- **`textSelectionMode` preserved** — pointer-events/user-select/aria-hidden all toggle based on store, same as before.
- **Native PDF.js `TextLayer.render()`** — delegates text positioning/selection rendering to PDF.js instead of manual `PositionedTextItem` mapping.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced. (Some pre-existing errors may appear — ignore those.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/PdfViewport/TextLayer.tsx src/renderer/components/PdfViewport/TextLayer.module.css src/renderer/components/PdfViewport/PdfPage.tsx
git commit -m "feat: replace manual text spans with PDF.js native TextLayer renderer; fix return-null deadlock with always-rendered container; PdfPage passes zoom instead of scale/width/height"
```

---

### Task 11: Update PdfViewport.tsx — single-page DOM + pathToFileUrl

**Files:**
- Modify: `src/renderer/components/PdfViewport/PdfViewport.tsx`

- [ ] **Step 1: Rewrite PdfViewport.tsx**

Edit `src/renderer/components/PdfViewport/PdfViewport.tsx`. Complete rewrite:

```tsx
import React, { useEffect } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { usePdf } from '../../hooks/usePdf';
import { pathToFileUrl } from '../../shared/path-utils';
import { PdfPage } from './PdfPage';
import styles from './PdfViewport.module.css';

export const PdfViewport: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const currentPage = usePdfStore((s) => s.currentPage);
  const zoom = usePdfStore((s) => s.zoom);
  const { pdfDoc, loadPdf, loading, error } = usePdf();

  // Load PDF document once when filePath changes
  useEffect(() => {
    if (filePath) {
      loadPdf(pathToFileUrl(filePath));
    }
  }, [filePath, loadPdf]);

  if (!filePath) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>📄</div>
        <p>Open a PDF file to start inspecting</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <p>Loading PDF...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.errorText}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className={styles.viewport}>
      <div className={styles.pagesContainer}>
        {pdfDoc && (
          <PdfPage
            key={currentPage}
            pageNum={currentPage}
            zoom={zoom}
            pdfDoc={pdfDoc}
          />
        )}
      </div>
    </div>
  );
};
```

Key changes:
- Import `pathToFileUrl` and use it instead of `file://${filePath}`
- Single-page render: only `<PdfPage key={currentPage} pageNum={currentPage} .../>` instead of `Array.from({length: pageCount}, ...)`
- No more `renderPage` prop (PdfPage manages its own rendering)
- `key={currentPage}` forces React to unmount/remount PdfPage on page change, which also resets the renderTaskRef cleanly

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/PdfViewport/PdfViewport.tsx
git commit -m "feat: single-page DOM rendering in PdfViewport; use pathToFileUrl for Unicode-safe PDF loading"
```

---

### Task 12: Update Toolbar.tsx — usePageNavigation, Fit Width button, Select Text toggle

**Files:**
- Modify: `src/renderer/components/Toolbar/Toolbar.tsx`

- [ ] **Step 1: Rewrite Toolbar.tsx**

Edit `src/renderer/components/Toolbar/Toolbar.tsx`. Complete rewrite:

```tsx
import React, { useCallback } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import styles from './Toolbar.module.css';

const OVERLAYS = [
  ['Chars', 'char'],
  ['Words', 'word'],
  ['Lines', 'line'],
  ['Curves', 'curve'],
  ['Rects', 'rect'],
  ['Tables', 'table'],
  ['Images', 'image'],
] as const;

export const Toolbar: React.FC = () => {
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageCount = usePdfStore((state) => state.pageCount);
  const zoom = usePdfStore((state) => state.zoom);
  const fitWidthZoom = usePdfStore((state) => state.fitWidthZoom);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const isLoading = usePdfStore((state) => state.isLoading);
  const filePath = usePdfStore((state) => state.filePath);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const setFile = usePdfStore((state) => state.setFile);
  const setZoom = usePdfStore((state) => state.setZoom);
  const setPageData = usePdfStore((state) => state.setPageData);
  const setLoading = usePdfStore((state) => state.setLoading);
  const setError = usePdfStore((state) => state.setError);
  const setFitWidthZoom = usePdfStore((state) => state.setFitWidthZoom);
  const setTextSelectionMode = usePdfStore((state) => state.setTextSelectionMode);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);
  const { navigate } = usePageNavigation();

  const handleOpen = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await ipc.openPdf();
      if (result.canceled) return;

      setFile(result.path, result.metadata);
      const pageData = await ipc.extractPage(1);
      setPageData(pageData);
    } catch (error) {
      console.error('Failed to open PDF:', error);
      setError(error instanceof Error ? error.message : 'Failed to open PDF');
    } finally {
      setLoading(false);
    }
  }, [setError, setFile, setLoading, setPageData]);

  const handleFitWidth = useCallback(() => {
    if (fitWidthZoom !== null) {
      setFitWidthZoom(fitWidthZoom);
    }
  }, [fitWidthZoom, setFitWidthZoom]);

  const handleTextSelectionToggle = useCallback(() => {
    setTextSelectionMode(!textSelectionMode);
  }, [textSelectionMode, setTextSelectionMode]);

  const filename = filePath?.split(/[\\/]/).pop() ?? 'No file open';

  return (
    <header className={styles.toolbar}>
      <button className={styles.button} type="button" onClick={handleOpen} disabled={isLoading}>
        Open
      </button>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Page navigation">
        <button
          className={styles.button}
          type="button"
          onClick={() => navigate(currentPage - 1)}
          disabled={isLoading || currentPage <= 1}
        >
          Prev
        </button>
        <span className={styles.value}>{currentPage} / {pageCount}</span>
        <button
          className={styles.button}
          type="button"
          onClick={() => navigate(currentPage + 1)}
          disabled={isLoading || currentPage >= pageCount}
        >
          Next
        </button>
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Zoom controls">
        <button
          className={styles.button}
          type="button"
          onClick={() => setZoom(zoom - 0.25)}
          disabled={zoom <= 0.25}
        >
          −
        </button>
        <span className={styles.value}>{Math.round(zoom * 100)}%</span>
        <button
          className={styles.button}
          type="button"
          onClick={() => setZoom(zoom + 0.25)}
          disabled={zoom >= 5}
        >
          +
        </button>
        <button
          className={`${styles.button} ${fitWidthZoom !== null && Math.abs(zoom - fitWidthZoom) < 0.01 ? styles.active : ''}`}
          type="button"
          onClick={handleFitWidth}
          disabled={fitWidthZoom === null}
          title="Fit page width"
        >
          Fit W
        </button>
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Overlay visibility">
        {OVERLAYS.map(([label, type]) => (
          <button
            className={`${styles.button} ${overlayVisibility[type] ? styles.active : ''}`}
            type="button"
            key={type}
            onClick={() => toggleOverlay(type)}
            aria-pressed={overlayVisibility[type]}
          >
            {label}
          </button>
        ))}
      </div>

      <span className={styles.separator} />

      <div className={styles.group} role="group" aria-label="Text selection">
        <button
          className={`${styles.button} ${textSelectionMode ? styles.active : ''}`}
          type="button"
          onClick={handleTextSelectionToggle}
          aria-pressed={textSelectionMode}
          title="Toggle text selection mode (T)"
        >
          Select Text
        </button>
      </div>

      <div className={styles.spacer} />
      <span className={styles.filename} title={filePath ?? undefined}>{filename}</span>
    </header>
  );
};
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Toolbar/Toolbar.tsx
git commit -m "feat: usePageNavigation in Toolbar; add Fit Width button; add Select Text toggle"
```

---

### Task 13: Refactor StructureTree.tsx — use shared usePageNavigation hook, become tab content

**Files:**
- Modify: `src/renderer/components/StructureTree/StructureTree.tsx`

- [ ] **Step 1: Rewrite StructureTree.tsx**

Edit `src/renderer/components/StructureTree/StructureTree.tsx`. The key changes:
- Remove the `<aside>` wrapper (LeftPanel provides it)
- Use shared `usePageNavigation` hook instead of inline `navigationRequestId`
- Remove `useRef` for `navigationRequestId`
- Remove `setLoading`, `setError` store subscriptions (now handled by the hook)
- Keep all existing object rendering logic identical

```tsx
import React from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { PageData, PdfObject, PdfObjectType } from '../../types/pdf-objects';
import styles from './StructureTree.module.css';

type ObjectGroup = {
  label: string;
  icon: string;
  objects: PdfObject[];
};

const MAX_WORDS = 50;

const formatCoordinate = (value: number): string => Math.round(value).toString();

const truncate = (value: string, maxLength = 36): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const formatObjectLabel = (object: PdfObject): string => {
  if (object.type === 'word') return truncate(object.text);
  if (object.type === 'table') return `Table ${object.rows} × ${object.cols}`;
  if (object.type === 'image') return `Image ${object.width} × ${object.height}`;

  return `${object.type} (${formatCoordinate(object.x0)}, ${formatCoordinate(object.y0)})`;
};

const getVisibleObjects = (type: PdfObjectType, objects: PdfObject[]): PdfObject[] =>
  type === 'word' ? objects.slice(0, MAX_WORDS) : objects;

const objectId = (object: PdfObject): string =>
  `${object.type}-${object.page}-${object.x0}-${object.y0}-${object.x1}-${object.y1}`;

const objectsMatch = (first: PdfObject, second: PdfObject): boolean =>
  first.type === second.type
  && first.page === second.page
  && first.x0 === second.x0
  && first.y0 === second.y0
  && first.x1 === second.x1
  && first.y1 === second.y1;

const getPageObjects = (data: PageData): PdfObject[] => [
  ...data.chars,
  ...data.words,
  ...data.rects,
  ...data.lines,
  ...data.curves,
  ...data.images,
  ...data.tables,
];

export const StructureTree: React.FC = () => {
  const filePath = usePdfStore((state) => state.filePath);
  const metadata = usePdfStore((state) => state.metadata);
  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageData = usePdfStore((state) => state.pageData);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const { navigate } = usePageNavigation();

  if (!filePath || !metadata || pageCount === 0) {
    return (
      <div className={styles.emptyState}>Open a PDF to view its structure.</div>
    );
  }

  const groups: ObjectGroup[] = pageData
    ? [
      { label: 'Words', icon: 'W', objects: pageData.words },
      { label: 'Rects', icon: '▭', objects: pageData.rects },
      { label: 'Lines', icon: '╱', objects: pageData.lines },
      { label: 'Curves', icon: '⌒', objects: pageData.curves },
      { label: 'Images', icon: '▧', objects: pageData.images },
      { label: 'Tables', icon: '▦', objects: pageData.tables },
    ]
    : [];

  const handleObjectClick = async (object: PdfObject): Promise<void> => {
    if (object.page === currentPage) {
      setSelectedObject(object);
      return;
    }

    // Navigate to the object's page; after navigation, find and select the matching object
    const storeBefore = usePdfStore.getState();
    const dataBefore = storeBefore.pageData;

    await navigate(object.page);

    const storeAfter = usePdfStore.getState();
    const freshData = storeAfter.pageData;
    if (freshData && freshData !== dataBefore) {
      const freshObject = getPageObjects(freshData).find((candidate) => objectsMatch(candidate, object));
      if (freshObject) setSelectedObject(freshObject);
    }
  };

  return (
    <nav className={styles.tree} aria-label="PDF page structure">
      {Array.from({ length: pageCount }, (_, index) => {
        const pageNumber = index + 1;
        const isActive = pageNumber === currentPage;

        return (
          <div className={styles.page} key={pageNumber}>
            <button
              className={`${styles.pageButton} ${isActive ? styles.activePage : ''}`}
              type="button"
              onClick={() => void navigate(pageNumber)}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className={styles.pageIcon}>▸</span>
              Page {pageNumber}
            </button>

            {isActive && pageData && (
              <div className={styles.groups}>
                {groups.map((group) => {
                  const type = group.objects[0]?.type;
                  const visibleObjects = type ? getVisibleObjects(type, group.objects) : [];

                  return (
                    <section className={styles.group} key={group.label}>
                      <div className={styles.groupHeader}>
                        <span className={styles.groupIcon} aria-hidden="true">{group.icon}</span>
                        <span>{group.label}</span>
                        <span className={styles.count}>{group.objects.length}</span>
                      </div>
                      {visibleObjects.map((object) => {
                        const isSelected = selectedObject !== null && objectsMatch(selectedObject, object);
                        const label = formatObjectLabel(object);

                        return (
                          <button
                            className={`${styles.objectButton} ${isSelected ? styles.selectedObject : ''}`}
                            type="button"
                            key={objectId(object)}
                            onClick={() => void handleObjectClick(object)}
                            title={label}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
};
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/StructureTree/StructureTree.tsx
git commit -m "refactor: StructureTree uses shared usePageNavigation; remove <aside> wrapper for LeftPanel integration"
```

---

### Task 14: Create LeftPanel + BookmarkTree + CSS

**Files:**
- Create: `src/renderer/components/LeftPanel/LeftPanel.tsx`
- Create: `src/renderer/components/LeftPanel/BookmarkTree.tsx`
- Create: `src/renderer/components/LeftPanel/LeftPanel.module.css`
- Create: `src/renderer/components/LeftPanel/BookmarkTree.module.css`

- [ ] **Step 1: Create LeftPanel.module.css**

Create `src/renderer/components/LeftPanel/LeftPanel.module.css`:

```css
.panel {
  display: flex;
  flex: 0 0 220px;
  flex-direction: column;
  width: 220px;
  min-width: 180px;
  color: #cbd3dc;
  background: #1e2329;
  border-right: 1px solid #353b43;
  font-size: 12px;
  overflow: hidden;
}

.tabBar {
  display: flex;
  border-bottom: 1px solid #353b43;
}

.tabButton {
  flex: 1;
  padding: 10px 8px;
  border: 0;
  background: transparent;
  color: #8e99a6;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: center;
}

.tabButton:hover {
  background: #2d353f;
  color: #cbd3dc;
}

.tabButton.activeTab {
  color: #fff;
  background: #274e76;
}

.tabContent {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.emptyState {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 24px;
  color: #77818c;
  line-height: 1.5;
  text-align: center;
}
```

- [ ] **Step 2: Create BookmarkTree.module.css**

Create `src/renderer/components/LeftPanel/BookmarkTree.module.css`:

```css
.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 12px;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.itemButton {
  flex: 1;
  display: block;
  overflow: hidden;
  width: 100%;
  padding: 5px 12px;
  border: 0;
  color: #cbd3dc;
  background: transparent;
  font: inherit;
  font-size: 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.itemButton:hover {
  background: #2d353f;
}

.itemButton:focus-visible {
  outline: 2px solid #5b9cff;
  outline-offset: -2px;
}

.nestedList {
  padding-left: 16px;
}

.emptyState {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 24px;
  color: #77818c;
  line-height: 1.5;
  text-align: center;
}

.bold {
  font-weight: 700;
}

.italic {
  font-style: italic;
}
```

- [ ] **Step 3: Create BookmarkTree.tsx**

Create `src/renderer/components/LeftPanel/BookmarkTree.tsx`:

```tsx
import React, { useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfOutlineItem } from '../../types/pdf-objects';
import styles from './BookmarkTree.module.css';

interface BookmarkTreeProps {
  pdfDoc: PDFDocumentProxy | null;
}

const MAX_DEPTH = 5;
const MAX_ITEMS = 2000;

export const BookmarkTree: React.FC<BookmarkTreeProps> = ({ pdfDoc }) => {
  const outline = usePdfStore((s) => s.outline);
  const setPage = usePdfStore((s) => s.setPage);

  const handleBookmarkClick = useCallback(
    async (dest: string | unknown[] | null) => {
      if (!dest || !pdfDoc) return;

      try {
        let pageIndex: number;

        if (typeof dest === 'string') {
          // Named destination
          const destArray = await pdfDoc.getDestination(dest);
          if (!destArray || destArray.length === 0) return;
          // First element of the destination array is the page reference
          const pageRef = destArray[0] as any;
          pageIndex = await pdfDoc.getPageIndex(pageRef);
        } else if (Array.isArray(dest)) {
          // Explicit destination array — first element is the page ref
          const pageRef = dest[0] as any;
          pageIndex = await pdfDoc.getPageIndex(pageRef);
        } else {
          return;
        }

        setPage(pageIndex + 1); // PDF.js uses 0-based page indices
      } catch (err) {
        console.error('Failed to resolve bookmark destination:', err);
      }
    },
    [pdfDoc, setPage],
  );

  if (!outline || outline.length === 0) {
    return (
      <div className={styles.emptyState}>No bookmarks found in this document.</div>
    );
  }

  // Check for unusually large outlines
  const totalItems = countItems(outline);
  if (totalItems > MAX_ITEMS) {
    return (
      <div className={styles.emptyState}>
        This document has {totalItems} bookmarks. The outline is too large to display.
      </div>
    );
  }

  return (
    <nav className={styles.tree} aria-label="PDF bookmarks">
      {renderItems(outline, 0, handleBookmarkClick)}
    </nav>
  );
};

function countItems(items: PdfOutlineItem[]): number {
  let count = 0;
  for (const item of items) {
    count += 1 + countItems(item.items);
  }
  return count;
}

function renderItems(
  items: PdfOutlineItem[],
  depth: number,
  onClick: (dest: string | unknown[] | null) => void,
): React.ReactNode {
  if (depth >= MAX_DEPTH) return null;

  return items.map((item, index) => {
    const classNames = [styles.itemButton];
    if (item.bold) classNames.push(styles.bold);
    if (item.italic) classNames.push(styles.italic);

    const hasChildren = item.items && item.items.length > 0;

    return (
      <div key={`${index}-${item.title}`} className={styles.item}>
        <button
          className={classNames.join(' ')}
          type="button"
          onClick={() => onClick(item.dest)}
          title={item.title}
        >
          {item.title}
        </button>
        {hasChildren && (
          <div className={styles.nestedList}>
            {renderItems(item.items, depth + 1, onClick)}
          </div>
        )}
      </div>
    );
  });
}
```

- [ ] **Step 4: Create LeftPanel.tsx**

Create `src/renderer/components/LeftPanel/LeftPanel.tsx`:

```tsx
import React, { useState } from 'react';
import { StructureTree } from '../StructureTree/StructureTree';
import { BookmarkTree } from './BookmarkTree';
import { usePdfStore } from '../../store/pdf-store';
import styles from './LeftPanel.module.css';

type Tab = 'structure' | 'bookmarks';

export const LeftPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('structure');
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);

  return (
    <aside className={styles.panel} aria-label="Document navigation">
      <div className={styles.tabBar} role="tablist" aria-label="Document navigation tabs">
        <button
          className={`${styles.tabButton} ${activeTab === 'structure' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'structure'}
          onClick={() => setActiveTab('structure')}
        >
          Structure
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'bookmarks' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'bookmarks'}
          onClick={() => setActiveTab('bookmarks')}
        >
          Bookmarks
        </button>
      </div>
      <div className={styles.tabContent} role="tabpanel">
        {activeTab === 'structure' ? (
          <StructureTree />
        ) : (
          <BookmarkTree pdfDoc={pdfDocRef} />
        )}
      </div>
    </aside>
  );
};
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/LeftPanel/
git commit -m "feat: add LeftPanel with tabs, BookmarkTree with PDF.js outline navigation"
```

---

### Task 15: Update App.tsx — LeftPanel replacement + keyboard shortcut T

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Update App.tsx**

Edit `src/renderer/App.tsx`. Complete rewrite:

```tsx
import { useEffect } from 'react';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { StatusBar } from './components/StatusBar/StatusBar';
import { LeftPanel } from './components/LeftPanel/LeftPanel';
import { Toolbar } from './components/Toolbar/Toolbar';
import { ipc } from './services/ipc-client';
import { usePdfStore } from './store/pdf-store';
import styles from './App.module.css';

const SIDECAR_STATUS_POLL_INTERVAL_MS = 5_000;

const App = (): JSX.Element => {
  const setSidecarRunning = usePdfStore((state) => state.setSidecarRunning);
  const clearSelection = usePdfStore((state) => state.clearSelection);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const setTextSelectionMode = usePdfStore((state) => state.setTextSelectionMode);

  useEffect(() => {
    const updateSidecarStatus = async (): Promise<void> => {
      try {
        const { running } = await ipc.getSidecarStatus();
        setSidecarRunning(running);
      } catch {
        setSidecarRunning(false);
      }
    };

    void updateSidecarStatus();
    const intervalId = window.setInterval(() => void updateSidecarStatus(), SIDECAR_STATUS_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [setSidecarRunning]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (event.key === 't' || event.key === 'T') {
        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
          setTextSelectionMode(!textSelectionMode);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearSelection, textSelectionMode, setTextSelectionMode]);

  return (
    <div className={styles.app}>
      <Toolbar />
      <main className={styles.main}>
        <LeftPanel />
        <PdfViewport />
        <InspectorPanel />
      </main>
      <StatusBar />
    </div>
  );
};

export default App;
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -30`
Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: replace StructureTree with LeftPanel; add keyboard shortcut T for text mode toggle"
```

---

### Task 16: Manual integration verification

**No files changed.** This task verifies the full integrated behavior.

- [ ] **Step 1: Launch the application and open a PDF with a Chinese filename**

Run: `npm run start` (or appropriate dev command)
Expected: Application starts. Open dialog appears. Navigate to a PDF with Chinese characters in the path. After opening, the PDF renders correctly.

- [ ] **Step 2: Verify fit-width zoom default**

Expected: First page opens at fit-width zoom (not 100%), content fills the viewport width.

- [ ] **Step 3: Verify DPR-aware rendering (retina display)**

Expected: On a retina display, canvas text is crisp (not blurry). No blue-text artifacts at any zoom level.

- [ ] **Step 4: Verify Select Text mode**

Click the "Select Text" button in the toolbar.
Expected: Overlay canvas becomes non-interactive (crosshair cursor changes). Text layer becomes interactive. Text can be selected and copied.

Press `T` keyboard shortcut.
Expected: Mode toggles back to Inspect.

- [ ] **Step 5: Verify rapid page navigation**

Rapidly click Prev/Next buttons 10+ times.
Expected: Final page shows correct data. No stale page data visible. No render flicker.

- [ ] **Step 6: Verify single-page DOM**

Open browser DevTools → Elements tab. Verify only one `<canvas>` element inside `.pagesContainer`.

- [ ] **Step 7: Verify Bookmarks tab**

Click the "Bookmarks" tab in the left panel.
Expected: PDF outline/bookmarks are displayed (if the PDF has an outline). Clicking a bookmark navigates to the correct page.

- [ ] **Step 8: Verify overlay toggle works in Inspect mode**

Toggle overlay types in the toolbar.
Expected: Corresponding object bounding boxes appear/disappear on the overlay canvas.

- [ ] **Step 9: Verify Fit Width button**

Change zoom with +/- buttons, then click "Fit W".
Expected: Zoom resets to fit the viewport width.

- [ ] **Step 10: Commit any final fixes discovered during verification**

```bash
git add -A
git commit -m "fix: integration polish from manual verification"
```

---

## Summary — All Six Issues Coverage

| Issue | Spec § | Tasks | Verification |
|-------|--------|-------|-------------|
| Unicode path support | §4.1 | 1, 11 | Open PDF with Chinese/Japanese filename |
| DPR-aware cancelable rendering | §4.2 | 8, 9 | Crisp text on retina; no blue artifacts; rapid zoom changes work |
| Native PDF.js TextLayer + mode | §4.3 | 10, 12, 15 | Text selectable/copyable in Select Text mode; overlay works in Inspect mode |
| Fit-width zoom default | §4.4 | 6, 12 | First page opens at fit-width; Fit W button works |
| Request-guard standardization | §4.5 | 5, 11, 12, 13 | No stale page data during rapid navigation; Toolbar and StructureTree share hook |
| Bookmarks tab | §4.6 | 14, 15 | Outline displayed in Bookmarks tab; clicking navigates to page |
| Extraction timeout + restart | §4.7 | 2, 3, 7 | 30s timeout triggers restart; retry succeeds; max 3 restarts/min |

## Reviewer Low Findings Covered

The following edge cases and minor items from the spec review are addressed:

1. **Outline size limits** (§7 R5, spec §4.6): `BookmarkTree.tsx` caps rendering at `MAX_DEPTH = 5` and `MAX_ITEMS = 2000`, showing a warning for oversized outlines (Task 14).
2. **Keyboard shortcut `T`** (§4.3.2): `App.tsx` adds `T` key handler to toggle text selection mode (Task 15).
3. **Zoom bounds clamping** (§4.4, spec §8): `setFitWidthZoom` clamps to `[0.25, 5]` via the store action (Task 4).
4. **H_PADDING constant** (§4.4): Fit-width calculation uses 48px horizontal padding (Task 6).
5. **Sidecar restart rate limiting** (§4.7): `ipc-client.ts` limits to 3 restarts per 60 seconds, showing "Sidecar repeatedly crashes" message (Task 7).
6. **Retry-once after restart** (§4.7): The `callWithTimeout` wrapper retries exactly once after restart (Task 7).
7. **Error banner display** (§4.7): Errors from `usePageNavigation` set `store.error`, which `StatusBar` already displays (Task 5, no StatusBar changes needed).
8. **`setPage` clears page data** (§4.5, store): Already implemented in existing `setPage` action — confirmed in Task 4 audit.
