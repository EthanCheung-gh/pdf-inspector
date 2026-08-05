# Font Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add whole-document font analysis to PDF Inspector — a sidecar `analyze_fonts` aggregation (pages, char count, size range, colors per font), a "Fonts" tab in the left panel, and click-to-highlight via the existing object-subset pipeline, per `docs/superpowers/specs/2026-08-03-font-analysis-design.md`.

**Architecture:** The Python sidecar gains one RPC method (`analyze_fonts`) that aggregates all pages' chars; the renderer gains one IPC channel (`ANALYZE_FONTS`) following the existing `extractMetadata` pattern, one store field (`fontStats`), and a new `FontsTab` component in the left panel. Row clicks reuse `setFilterCriteria({ fontname })` so the object-subset overlay highlights matching objects and the Inspector Results section lists them.

**Tech Stack:** TypeScript 5.5+, React 18 + Zustand 5, Electron 28, Vitest 2 (Node >=22.12 — jsdom requires require(esm)), Python 3 + pdfplumber + reportlab (test fixtures) + pytest.

---

## Global Constraints

- Sidecar RPC responses stay JSON-serializable; no new dependencies for the sidecar at runtime.
- `get_metadata` is NOT modified.
- Renderer-only rule applies to TS files: no changes under `sidecar/`, `src/main/`, or `src/preload/` in renderer tasks (IPC-rigging tasks DO touch `src/main`/`src/preload` — those are expected).
- `analyzeFonts` goes through `callWithTimeout` (30s + restart-retry) like `extractMetadata`.
- `fontStats` resets to `null` on `setFile`.
- Fonts tab requests are cached in the store; switching tabs does not re-request.
- Row click: `navigate(font.pages[0])` then `setFilterCriteria({ fontname: font.fontname })` (object-subset pipeline).

---

## File Structure — New Files

| File | Purpose |
|------|---------|
| `sidecar/__tests__/test_analyze_fonts.py` | pytest for `analyze_fonts` (first Python tests in the repo) |
| `src/renderer/components/LeftPanel/FontsTab.tsx` | Font stats list UI |
| `src/renderer/components/LeftPanel/FontsTab.module.css` | Styles |

## File Structure — Modified Files

| File | Changes |
|------|---------|
| `sidecar/extractor.py` | `analyze_fonts` method |
| `sidecar/main.py` | `analyze_fonts` dispatch branch |
| `src/shared/constants.ts` | `ANALYZE_FONTS` channel |
| `src/renderer/types/ipc-protocol.ts` | `FontStat` + `analyzeFonts` on `IpcApi` |
| `src/preload/index.ts` | `analyzeFonts` bridge |
| `src/main/ipc-handlers.ts` | `analyzeFonts` handler |
| `src/renderer/services/ipc-client.ts` | `analyzeFonts` wrapper |
| `src/renderer/store/pdf-store.ts` | `fontStats` + `setFontStats`; `setFile` resets |
| `src/renderer/components/LeftPanel/LeftPanel.tsx` | third "Fonts" tab |
| `src/renderer/store/__tests__/pdf-store.test.ts` | `fontStats` lifecycle tests |
| `src/renderer/services/__tests__/ipc-client.test.ts` | `analyzeFonts` wrapper test |

---

### Task 1: sidecar `analyze_fonts` + pytest

**Files:**
- Modify: `sidecar/extractor.py`
- Modify: `sidecar/main.py`
- Create: `sidecar/__tests__/test_analyze_fonts.py` (new `sidecar/__tests__/` directory)

**Interfaces:**
- Produces: sidecar RPC method `analyze_fonts` with no params, returning `{"fonts": [{"fontname": str, "pages": [int], "charCount": int, "sizeMin": float, "sizeMax": float, "colors": [str]}]}` sorted by `charCount` descending; `pages` ascending.

- [ ] **Step 1: Write the failing pytest**

Create `sidecar/__tests__/test_analyze_fonts.py`:

```python
import sys
from pathlib import Path

import pytest
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402


@pytest.fixture()
def multi_font_pdf(tmp_path):
    """Two pages: page 1 uses Helvetica at 10 and 14pt, page 2 uses Courier at 12pt."""
    path = tmp_path / "fonts.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 10)
    c.drawString(50, 700, "alpha")
    c.setFont("Helvetica", 14)
    c.drawString(50, 650, "beta")
    c.showPage()
    c.setFont("Courier", 12)
    c.drawString(50, 700, "gamma")
    c.save()
    return str(path)


@pytest.fixture()
def empty_pdf(tmp_path):
    path = tmp_path / "empty.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.showPage()
    c.save()
    return str(path)


def test_aggregates_pages_and_char_counts(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    fonts = {f["fontname"]: f for f in result["fonts"]}
    assert "Helvetica" in fonts
    assert fonts["Helvetica"]["pages"] == [1]
    assert fonts["Helvetica"]["charCount"] == 9  # "alpha"(5) + "beta"(4)
    assert fonts["Helvetica"]["sizeMin"] == 10
    assert fonts["Helvetica"]["sizeMax"] == 14
    assert "Courier" in fonts
    assert fonts["Courier"]["pages"] == [2]
    assert fonts["Courier"]["charCount"] == 5  # "gamma"


def test_sorted_by_char_count_descending(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    counts = [f["charCount"] for f in result["fonts"]]
    assert counts == sorted(counts, reverse=True)


def test_colors_deduplicated(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    helvetica = next(f for f in result["fonts"] if f["fontname"] == "Helvetica")
    assert helvetica["colors"] == sorted(set(helvetica["colors"]))


def test_empty_document_returns_empty_fonts(empty_pdf):
    result = PdfExtractor(empty_pdf).analyze_fonts()
    assert result["fonts"] == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest sidecar/__tests__/ -v`
Expected: FAIL — `AttributeError: 'PdfExtractor' object has no attribute 'analyze_fonts'`

- [ ] **Step 3: Implement `analyze_fonts` in `sidecar/extractor.py`**

Add the method from spec §4.1 (verbatim):

```python
def analyze_fonts(self) -> dict:
    fonts: dict[str, dict] = {}
    for page_num, page in enumerate(self._pdf.pages, start=1):
        for c in page.chars:
            name = c.get('fontname', '')
            if not name:
                continue
            entry = fonts.setdefault(name, {
                'fontname': name, 'pages': [], 'charCount': 0,
                'sizeMin': float(c.get('size', 0)), 'sizeMax': float(c.get('size', 0)),
                'colors': [],
            })
            entry['charCount'] += 1
            entry['sizeMin'] = min(entry['sizeMin'], float(c.get('size', 0)))
            entry['sizeMax'] = max(entry['sizeMax'], float(c.get('size', 0)))
            color = str(c.get('stroking_color', '#000000')) or '#000000'
            if color not in entry['colors']:
                entry['colors'].append(color)
            if page_num not in entry['pages']:
                entry['pages'].append(page_num)
    return {'fonts': sorted(fonts.values(), key=lambda f: f['charCount'], reverse=True)}
```

Add the dispatch branch in `sidecar/main.py`, mirroring `extract_metadata`:

```python
elif req.method == 'analyze_fonts':
    if extractor is None:
        resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
    else:
        resp = format_response(RpcResponse(id=req.id, result=extractor.analyze_fonts()))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 -m pytest sidecar/__tests__/ -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add sidecar/extractor.py sidecar/main.py sidecar/__tests__/test_analyze_fonts.py
git commit -m "feat: add analyze_fonts sidecar method with tests"
```

---

### Task 2: `ANALYZE_FONTS` IPC pipeline

**Files:**
- Modify: `src/shared/constants.ts`, `src/renderer/types/ipc-protocol.ts`, `src/preload/index.ts`, `src/main/ipc-handlers.ts`, `src/renderer/services/ipc-client.ts`
- Test: `src/renderer/services/__tests__/ipc-client.test.ts`

**Interfaces:**
- Consumes: existing `IPC_CHANNELS`, `IpcApi`, `ipc` patterns.
- Produces:
  - `IPC_CHANNELS.ANALYZE_FONTS: 'pdf:analyze-fonts'`
  - `interface FontStat { fontname: string; pages: number[]; charCount: number; sizeMin: number; sizeMax: number; colors: string[] }` (in `src/renderer/types/ipc-protocol.ts`)
  - `IpcApi.analyzeFonts(): Promise<{ fonts: FontStat[] }>`
  - `window.pdfInspector.analyzeFonts` bridge
  - `ipc.analyzeFonts` wrapper through `callWithTimeout`

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/services/__tests__/ipc-client.test.ts`:

```typescript
const mockAnalyzeFonts = vi.fn();
// add to the window.pdfInspector mock object:
//   analyzeFonts: mockAnalyzeFonts,

it('analyzeFonts resolves when the sidecar responds in time', async () => {
  const fonts = { fonts: [{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }] };
  mockAnalyzeFonts.mockResolvedValue(fonts);

  await expect(ipc.analyzeFonts()).resolves.toEqual(fonts);
  expect(mockAnalyzeFonts).toHaveBeenCalledWith();
  expect(mockRestartSidecar).not.toHaveBeenCalled();
});
```

(The implementer must add `analyzeFonts: mockAnalyzeFonts` to the `window.pdfInspector` object literal in that file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/services/__tests__/ipc-client.test.ts`
Expected: FAIL — `ipc.analyzeFonts is not a function`

- [ ] **Step 3: Wire the IPC channel**

- `src/shared/constants.ts` → add to `IPC_CHANNELS`: `ANALYZE_FONTS: 'pdf:analyze-fonts',`
- `src/renderer/types/ipc-protocol.ts` → add `FontStat` interface and `analyzeFonts(): Promise<{ fonts: FontStat[] }>` to `IpcApi` (import/export `FontStat` alongside the other types).
- `src/preload/index.ts` → `analyzeFonts: () => ipcRenderer.invoke(IPC_CHANNELS.ANALYZE_FONTS),`
- `src/main/ipc-handlers.ts` → `ipcMain.handle(IPC_CHANNELS.ANALYZE_FONTS, async () => sidecar.send('analyze_fonts'));`
- `src/renderer/services/ipc-client.ts` → add to the `ipc` object:
  ```typescript
  analyzeFonts: () => callWithTimeout(() => window.pdfInspector.analyzeFonts(), 'analyzeFonts'),
  ```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/services/__tests__/ipc-client.test.ts` and then `npx vitest run`
Expected: PASS; full suite green (Node >=22.12 in PATH).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts src/renderer/types/ipc-protocol.ts src/preload/index.ts src/main/ipc-handlers.ts src/renderer/services/ipc-client.ts src/renderer/services/__tests__/ipc-client.test.ts
git commit -m "feat: add analyze_fonts IPC pipeline"
```

---

### Task 3: store `fontStats`

**Files:**
- Modify: `src/renderer/store/pdf-store.ts`
- Test: `src/renderer/store/__tests__/pdf-store.test.ts`

**Interfaces:**
- Consumes: `FontStat` from `../types/ipc-protocol`.
- Produces: `fontStats: FontStat[] | null` + `setFontStats(stats: FontStat[] | null): void`; `setFile` resets `fontStats: null`.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/store/__tests__/pdf-store.test.ts`:

```typescript
describe('fontStats', () => {
  it('setFontStats stores the stats', () => {
    usePdfStore.getState().setFontStats([{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }]);
    expect(usePdfStore.getState().fontStats).toHaveLength(1);
  });

  it('setFile resets fontStats to null', () => {
    usePdfStore.getState().setFontStats([{ fontname: 'Helvetica', pages: [1], charCount: 9, sizeMin: 10, sizeMax: 14, colors: ['#000000'] }]);
    usePdfStore.getState().setFile('/x.pdf', { pages: 1, version: '1.7', encrypted: false, page_w: 100, page_h: 100, title: '', author: '', producer: '', fonts: [] });
    expect(usePdfStore.getState().fontStats).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: FAIL — `setFontStats is not a function`

- [ ] **Step 3: Implement**

In `src/renderer/store/pdf-store.ts`:
- Import `FontStat` type from `../types/ipc-protocol` (already imports `PdfMetadata`, `PageData` from types — extend that import or add a new `import type { FontStat } from '../types/ipc-protocol';`).
- Add to `PdfState`: `fontStats: FontStat[] | null;` and `setFontStats(stats: FontStat[] | null): void;`
- Initial value: `fontStats: null` (and `fontStats: null` in the `setFile` reset object).
- Action:
  ```typescript
  setFontStats: (stats) => set({ fontStats: stats }),
  ```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/pdf-store.ts src/renderer/store/__tests__/pdf-store.test.ts
git commit -m "feat: add fontStats state to pdf store"
```

---

### Task 4: `FontsTab` + LeftPanel third tab

**Files:**
- Create: `src/renderer/components/LeftPanel/FontsTab.tsx`, `src/renderer/components/LeftPanel/FontsTab.module.css`
- Modify: `src/renderer/components/LeftPanel/LeftPanel.tsx`

**Interfaces:**
- Consumes: `fontStats`, `setFontStats`, `filePath`, `isLoading`, `setError` from store; `ipc.analyzeFonts`; `usePageNavigation().navigate`; `setFilterCriteria` from store; `FontStat` type.
- Produces: `<FontsTab />` component; `LeftPanel` renders it when the `fonts` tab is active.

- [ ] **Step 1: Implement `FontsTab.tsx`**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { usePdfStore } from '../../store/pdf-store';
import type { FontStat } from '../../types/ipc-protocol';
import styles from './FontsTab.module.css';

export const FontsTab: React.FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const fontStats = usePdfStore((s) => s.fontStats);
  const isLoading = usePdfStore((s) => s.isLoading);
  const setFontStats = usePdfStore((s) => s.setFontStats);
  const setError = usePdfStore((s) => s.setError);
  const setFilterCriteria = usePdfStore((s) => s.setFilterCriteria);
  const { navigate } = usePageNavigation();
  const [localError, setLocalError] = useState<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!filePath || fontStats !== null || localError !== null || requestedRef.current) return;
    if (isLoading) return;
    requestedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const result = await ipc.analyzeFonts();
        if (!cancelled) setFontStats(result.fonts);
      } catch (error) {
        if (!cancelled) {
          setLocalError(error instanceof Error ? error.message : 'Failed to analyze fonts');
          setError('Failed to analyze fonts. Please try again.');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [filePath, fontStats, isLoading, localError, setError, setFontStats]);

  const handleRetry = (): void => {
    requestedRef.current = false;
    setLocalError(null);
    setError(null);
  };

  const handleClick = (font: FontStat): void => {
    if (font.pages.length === 0) return;
    void navigate(font.pages[0]);
    setFilterCriteria({ fontname: font.fontname });
  };

  if (!filePath) {
    return <div className={styles.hint}>Open a PDF to analyze fonts.</div>;
  }
  if (localError) {
    return (
      <div className={styles.stateBox}>
        <div>{localError}</div>
        <button type="button" className={styles.retry} onClick={handleRetry}>Retry</button>
      </div>
    );
  }
  if (isLoading && fontStats === null) {
    return <div className={styles.stateBox}>Analyzing fonts…</div>;
  }
  if (fontStats === null) {
    return <div className={styles.stateBox} />;
  }
  if (fontStats.length === 0) {
    return <div className={styles.stateBox}>No text fonts detected in this document.</div>;
  }

  return (
    <ul className={styles.list}>
      {fontStats.map((font) => (
        <li key={font.fontname}>
          <button type="button" className={styles.row} onClick={() => handleClick(font)}>
            <span className={styles.name}>{font.fontname}</span>
            <span className={styles.meta}>
              {font.pages.length} page{font.pages.length === 1 ? '' : 's'} · {font.charCount} chars · {font.sizeMin}–{font.sizeMax}pt
            </span>
            <span className={styles.swatches}>
              {font.colors.slice(0, 4).map((color) => (
                <span key={color} className={styles.swatch} style={{ backgroundColor: color }} title={color} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
};
```

Note: the effect's early-return when `isLoading` is true prevents double-requesting while a page navigation is in flight; `requestedRef` prevents re-request after a failed attempt is retried. Add `FontsTab.module.css` rules: `.hint`, `.stateBox`, `.retry`, `.list` (scrollable, max-height), `.row` (full-width left-aligned button), `.name`, `.meta`, `.swatches`, `.swatch` (inline-block, 12px square).

- [ ] **Step 2: Add the third tab to `LeftPanel.tsx`**

- Change the `Tab` type to `'structure' | 'bookmarks' | 'fonts'`.
- Add a third `tabButton` labeled "Fonts" (same pattern as the existing two).
- Render `<FontsTab />` in the tab content when `activeTab === 'fonts'`:
  ```tsx
  {activeTab === 'structure' ? <StructureTree /> : activeTab === 'bookmarks' ? <BookmarkTree pdfDoc={pdfDocRef} /> : <FontsTab />}
  ```
- Import `FontsTab`.

- [ ] **Step 3: Verify**

Run: `npx vitest run` (all tests pass) and `npx tsc --noEmit -p tsconfig.json` (clean).

- [ ] **Step 4: Manual verification checklist**

- Open a multi-font PDF → Fonts tab shows the font list (sorted by char count).
- Click a font row → navigates to its first occurrence page, orange highlight on that font's objects, Inspector Results section lists them.
- Switch away from and back to the Fonts tab → no re-request (no flicker).
- Open another PDF → Fonts tab resets and reloads on activation.
- Close/reopen flow: no fonts → empty state; sidecar down → error + Retry.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/LeftPanel/FontsTab.tsx src/renderer/components/LeftPanel/FontsTab.module.css src/renderer/components/LeftPanel/LeftPanel.tsx
git commit -m "feat: add Fonts tab to left panel"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1 sidecar → Task 1; §4.2 IPC → Task 2; §4.3 store → Task 3; §4.4 UI → Task 4; §4.5 data flow → Tasks 2/4; §5 error handling (banner + Retry, empty state, 30s timeout path) → Tasks 2/4; §6 testing (pytest aggregation cases, vitest store/ipc-client, manual checklist) → Tasks 1/2/3/4.
- **Type consistency:** `FontStat` defined once in Task 2 (`ipc-protocol.ts`), consumed by Tasks 3/4; `setFontStats`/`fontStats` names consistent; `analyzeFonts` naming consistent across constants/preload/main/ipc-client.
- **Fixture strategy:** pytest uses `reportlab` (available, v5.0.0) to generate multi-font and empty PDFs in `tmp_path` — no network, no binary fixtures.
- **Deviation from spec noted for implementers:** in Task 4, `isLoading` guard prevents re-request during page navigation; `requestedRef` gates retry — both are defensive details beyond the spec's literal text.
