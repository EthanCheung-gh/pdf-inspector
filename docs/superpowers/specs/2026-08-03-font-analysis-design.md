# PDF Inspector — Font Analysis Design

**Date:** 2026-08-03
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)

---

## 1. Overview

Add a **font analysis** feature to PDF Inspector: a sidecar-side aggregation of every font used in the whole document (pages, character count, size range, colors), shown in a new "Fonts" tab of the left panel. Clicking a font navigates to its first occurrence page and highlights all objects using that font, reusing the object-subset mechanism (orange overlay highlight + Inspector Results list) for a "analyze → locate → extract" loop.

The Python sidecar gains one new RPC method (`analyze_fonts`). The renderer gains one new IPC channel, one store field, and one new tab component.

## 2. Goals / Non-Goals

**Goals:**
- Whole-document font statistics: for each font name — pages used on (ascending), total character count, min/max size, distinct colors.
- Results sorted by character count descending.
- New "Fonts" tab in the left panel (alongside Structure / Bookmarks), loaded lazily on first activation and cached in the store.
- Clicking a font row navigates to its first occurrence page and applies `setFilterCriteria({ fontname })` so the overlay highlights that font's objects and the Inspector Results section lists them (reusing the object-subset pipeline from the region-selection/filter feature).
- Loading / error / retry / empty states.

**Non-Goals:**
- Font embedding / subsetting status detection (deferred to the health-check feature, which needs pdfminer-level font descriptor parsing).
- Per-page font drill-down UI beyond the pages list.
- Any change to `get_metadata`.
- OCR or font file extraction.

## 3. User Decisions (locked)

| Question | Decision |
|----------|----------|
| Data scope | Whole document, one-shot aggregation |
| UI location | Third tab "Fonts" in the left panel |
| Click behavior | Navigate to first occurrence page + highlight via object subset |
| Implementation | Sidecar aggregation (Option A) |

## 4. Architecture

### 4.1 Sidecar: `analyze_fonts` method

`sidecar/extractor.py` adds a method; `sidecar/main.py` adds a dispatch branch (same pattern as `extract_metadata`). `get_metadata` is unchanged.

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

- `pages` ascending; result sorted by `charCount` descending.
- Characters without a font name are skipped.

### 4.2 IPC pipeline (mirrors `extractMetadata`)

| Layer | Change |
|-------|--------|
| `src/shared/constants.ts` | `ANALYZE_FONTS = 'analyze-fonts'` |
| `src/renderer/types/ipc-protocol.ts` | `FontStat` type + `analyzeFonts(): Promise<{ fonts: FontStat[] }>` on `IpcApi` |
| `src/preload/index.ts` | bridge via `ipcRenderer.invoke` |
| `src/main/ipc-handlers.ts` | handler forwarding to the sidecar RPC |
| `src/renderer/services/ipc-client.ts` | `analyzeFonts` wrapper **through `callWithTimeout`** (30s + restart-retry, same path as `extractMetadata`) |

`FontStat`:

```ts
interface FontStat {
  fontname: string;
  pages: number[];      // ascending page numbers
  charCount: number;
  sizeMin: number;
  sizeMax: number;
  colors: string[];
}
```

### 4.3 Store

`src/renderer/store/pdf-store.ts` adds:

```ts
fontStats: FontStat[] | null;
setFontStats(stats: FontStat[] | null): void;
```

- `setFile` resets `fontStats` to `null`.
- Loading reuses `isLoading` / `setError`.

### 4.4 UI: `FontsTab`

- `src/renderer/components/LeftPanel/LeftPanel.tsx`: add a third tab "Fonts" (`'structure' | 'bookmarks' | 'fonts'`).
- New `src/renderer/components/LeftPanel/FontsTab.tsx` (+ `FontsTab.module.css`):
  - On first activation with a PDF open, calls `ipc.analyzeFonts()`; result cached in `store.fontStats`, so switching tabs does not re-request.
  - List rows: `[fontname] · N pages · M chars · size min–max` + up to 4 color swatches.
  - Row click → `usePageNavigation().navigate(font.pages[0])` + `setFilterCriteria({ fontname: font.fontname })` — reuses the object-subset pipeline: the overlay draws the orange border for that font's objects and the Inspector Results section lists them.
  - Loading spinner / error message with Retry button / empty state ("No text fonts detected in this document").
  - Only rendered/triggered when a file is open; disabled-looking state with hint otherwise.

### 4.5 Data flow

```
Fonts tab first activated (file open) → ipc.analyzeFonts() → store.fontStats (cached)
Row click → navigate(pages[0]) + setFilterCriteria({ fontname })
         → store recomputes subset → overlay orange highlight + Inspector Results list
```

## 5. Error Handling

- Sidecar failure or timeout → existing `setError` banner + a Retry button in FontsTab.
- No fonts in the document → empty state message.
- Large document exceeding the 30s timeout → `callWithTimeout` restart-retry path (same as `extractMetadata`); a second failure surfaces the error banner.

## 6. Testing

- **pytest**: the project has no Python tests yet — this spec creates the first, at `sidecar/__tests__/test_analyze_fonts.py` (new directory). Run with `python3 -m pytest sidecar/__tests__/` from the repo root (pdfplumber and pytest 9 are available). Cases: `analyze_fonts` aggregation — multi-page/multi-font, size range, color deduplication, ascending page numbers, descending char-count sort, empty document. Use a small fixture PDF generated inline (e.g. via a temporary file or a checked-in minimal PDF) — do not require network.
- **vitest**: store `fontStats` lifecycle (`setFile` resets); `ipc-client` `analyzeFonts` wrapper (existing ipc-client test pattern: mock `window.pdfInspector.analyzeFonts`).
- **Manual checklist**: open a multi-font PDF → Fonts tab loads → click a font → navigates + orange highlight + Inspector Results → switch tabs without re-request → open another document → Fonts tab reset.

## 7. File Structure

**New files**

| File | Purpose |
|------|---------|
| `src/renderer/components/LeftPanel/FontsTab.tsx` | Font stats list UI |
| `src/renderer/components/LeftPanel/FontsTab.module.css` | Styles |
| `sidecar/__tests__/test_analyze_fonts.py` | pytest for the new method (new `sidecar/__tests__/` directory — first Python tests in the repo) |

**Modified files**

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
