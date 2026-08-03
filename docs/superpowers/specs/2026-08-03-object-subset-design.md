# PDF Inspector — Object Subset: Region Selection & Filter Design

**Date:** 2026-08-03
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)

---

## 1. Overview

Add two related features to PDF Inspector:

- **C1. Region selection extraction**: drag a rectangle over the page, collect all pdfplumber objects inside/intersecting the selection, view them in a list and export as JSON/CSV.
- **C4. Object filter**: filter the current page's objects by type / font name / font size range / color, highlight matches, view them in a list and export.

Both features are unified under a single **object subset** model: a predicate (region bbox or property criteria) produces a subset of the current page's objects, which is then highlighted on the overlay canvas, listed in the Inspector panel, and exportable through the existing export pipeline.

Both features are **renderer-only**. The Python sidecar is unchanged; export reuses the existing `saveFile` IPC.

## 2. Goals / Non-Goals

**Goals:**
- Region selection: toggleable "Region" mode in the toolbar; drag on the viewport to draw a selection rectangle; matched objects are highlighted, listed, and exportable.
- Region matching mode: switchable between **intersect** (any overlap) and **contain** (fully inside), recomputed without re-dragging.
- Filter: property criteria (type, font name, font size range, color) combined with **AND**; applied to the current page only.
- Subset results shown in an in-panel "Results" section of the Inspector panel: count, scrollable object list, per-item click → select object, JSON/CSV export, clear.
- Subset members rendered with a distinct orange border on the overlay canvas; hover/selected visuals unchanged.

**Non-Goals:**
- Whole-document filtering or region selection across pages (current page only).
- Saving/restoring subsets across sessions.
- Regex filter patterns, substring matching on text content.
- Any sidecar change.
- PDF modification.

## 3. User Decisions (locked)

| Question | Decision |
|----------|----------|
| Scope | C1 + C4 packaged into one spec, unified subset model |
| Deliverable | View (list + highlight) AND export (JSON/CSV) — full loop |
| Region matching | Intersect / contain, switchable |
| Filter scope | Current page only |
| Results location | Inline section in the Inspector panel |
| Region entry | Toolbar mode button (parallel to Select Text) |
| Implementation | Unified subset model (Option A) |

## 4. Architecture

### 4.1 Object Subset Model

The store gains a single subset state:

```ts
subset: { source: 'region' | 'filter'; mode: 'intersect' | 'contain'; objects: PdfObject[]; bbox?: BBox } | null;
```

- `objects` is the subset of `store.pageData`'s `allObjects` matched by the active predicate.
- `bbox` is present only for `source: 'region'` — the stored selection rectangle in PDF coordinates, kept so the intersect/contain toggle can recompute without re-dragging.
- `source` is a single value: a new region selection **overrides** an active filter subset and vice versa (the two are mutually exclusive, last action wins).
- C1 and C4 differ only in how the predicate is generated:
  - **Region predicate** — `filterByRegion(objects, bbox, mode)`: `mode === 'intersect'` keeps objects whose bbox overlaps the region (shared area > 0, treating edge contact as overlap); `mode === 'contain'` keeps objects fully inside (object bbox within region bounds, inclusive).
  - **Property predicate** — `filterByProperties(objects, criteria)`: criteria `{ types?: PdfObjectType[]; fontname?: string; sizeMin?: number; sizeMax?: number; color?: string }`, all present conditions combined with AND. Empty criteria matches everything. Font size range only applies to objects with a `size` field (`char`/`word`); color only to objects with a `color` field; types not listed in `types` are excluded.

### 4.2 New file: `src/renderer/services/object-filter.ts`

Pure functions, no React dependencies:

- `filterByRegion(objects: PdfObject[], bbox: BBox, mode: 'intersect' | 'contain'): PdfObject[]`
- `filterByProperties(objects: PdfObject[], criteria: FilterCriteria): PdfObject[]`

Shared helpers: `intersects(a, b)`, `contains(a, b)` on `{x0,y0,x1,y1}`.

### 4.3 New file: `src/renderer/hooks/useRegionSelect.ts`

- Manages the drag interaction on the viewport: `mousedown` records start (screen → PDF coords via the existing transform), `mousemove` updates the live rectangle, `mouseup` computes `filterByRegion(allObjects, bbox, mode)` and writes `store.subset`.
- Active only while the "Region" mode toggle is on (store flag, see §4.5). Inactive in text-selection mode; text selection mode and region mode are mutually exclusive toggles.
- Live rectangle coordinates are exposed for the overlay canvas to draw.
- Esc or re-clicking the toggle clears the subset and the rectangle.

### 4.4 Renderer: highlight

- `OverlayCanvas`: while `subset` is non-null, subset members are stroked with a distinct **orange** border (drawn after the normal per-type bboxes so it stays on top); hover/selected gold/yellow visuals keep priority over the subset border.
- Region-mode live rectangle is drawn as a semi-transparent blue fill + border on the same canvas.

### 4.5 Store extensions (`pdf-store.ts`)

New fields:

```ts
regionMode: boolean;               // toolbar toggle (C1)
filterCriteria: FilterCriteria;    // live criteria (C4)
subset: Subset | null;
```

New actions:

```ts
setRegionMode(on: boolean);              // also clears subset when turning off
setFilterCriteria(c: FilterCriteria);    // recomputes subset via filterByProperties
setSubset(subset: Subset | null);
clearSubset();                           // sets subset to null
```

- `setPage` and `setFile` clear `subset` (page data changed → old subset invalid), mirroring search cleanup.
- Changing filter criteria recomputes the subset from `allObjects`; when criteria is empty the subset is `null` (no active filter).

### 4.6 Inspector panel: Results section

Inline section shown when `subset` is non-null:

- Header: `N objects · source: region/filter` + Clear button.
- For region source: an **intersect / contain** toggle that recomputes the subset via `filterByRegion` with the stored region bbox — no re-drag needed (bbox kept in the subset state).
- Scrollable list: one row per object, `[type] summary` (text objects show their text, others show `x0,y0→x1,y1`); click → `setSelectedObject(obj)` (locks highlight + fills the detail sections below).
- Export buttons: JSON / CSV.
- Empty result → "No objects in selection/filter" empty state.

### 4.7 Export

`src/renderer/services/export-data.ts` gains:

- `objectsToJson(objects: PdfObject[], metadata: PdfMetadata, page: number): string` — `{ metadata, exportedAt, page, objectCount, objects }`.
- `objectsToCsv(objects: PdfObject[], page: number): string` — same per-type section format as `pagesToCsv` (`# chars`, `# words`, … with the shared `page` column prefixed), built by extracting the existing per-page serialization into a reusable internal helper so the two entry points share one implementation.
- Filenames via existing `suggestFilename(path, 'page', page, ext)`.
- Written through existing `saveFile` IPC; cancel is silent, write failure surfaces via the existing error banner.

### 4.8 Toolbar

- New "Region" toggle button (grouped with Select Text). `R` keyboard shortcut mirrors the `T` shortcut for text selection.

## 5. Data Flow

**Region selection:**
`Toolbar Region on` → drag on viewport → `mousemove` updates live rectangle → `mouseup` → `filterByRegion(allObjects, bbox, mode)` → `store.subset` → OverlayCanvas orange border + Inspector Results list. Intersect/contain toggle → recompute from stored bbox. Clear/Esc → `subset = null`.

**Filter:**
`criteria change` (type checkboxes, font dropdown, size min/max, color) → `setFilterCriteria` → `filterByProperties(allObjects, criteria)` → `store.subset` → same highlight + list.

**Export:**
Results section button → `objectsToJson`/`objectsToCsv` → `ipc.saveFile` → native dialog + write.

## 6. Error Handling

- No matches → empty state text in Results; subset remains valid (empty objects).
- Page navigation / new file → subset cleared automatically.
- Export cancel → silent (existing behavior); write failure → error banner (existing).
- Region drag smaller than a minimum size (e.g. < 4px) → ignored, no subset change.
- Filter with empty criteria → subset null (filter inactive).

## 7. Testing

- `object-filter.test.ts`: `filterByRegion` intersect/contain boundary cases (touching edges, fully inside, disjoint, zero-area); `filterByProperties` AND combination, empty criteria = all, size/color conditions skipped for object types lacking those fields.
- `pdf-store.test.ts`: subset set/clear, cleared on `setPage`/`setFile`, region toggle clears subset.
- `export-data.test.ts`: `objectsToJson` shape (metadata + page + objects); `objectsToCsv` section headers reuse; RFC 4180 escaping still applies.
- Manual checklist: drag region on a page with text+images+tables; toggle intersect/contain; click list item → highlight + details; export both formats; filter by font then by color; Esc clears; page turn clears; region + text selection mutual exclusion.

## 8. File Structure

**New files**

| File | Purpose |
|------|---------|
| `src/renderer/services/object-filter.ts` | Pure predicate functions (region + properties) |
| `src/renderer/hooks/useRegionSelect.ts` | Drag interaction + region bbox state |
| `src/renderer/services/__tests__/object-filter.test.ts` | Predicate unit tests |

**Modified files**

| File | Changes |
|------|---------|
| `src/renderer/store/pdf-store.ts` | `regionMode`, `filterCriteria`, `subset` + actions; cleanup on setPage/setFile |
| `src/renderer/components/Toolbar/Toolbar.tsx` | Region toggle button, `R` shortcut (in App.tsx) |
| `src/renderer/components/PdfViewport/OverlayCanvas.tsx` | Subset orange border; live region rectangle |
| `src/renderer/components/InspectorPanel/InspectorPanel.tsx` | Results section (list, toggle, export, clear) + filter controls |
| `src/renderer/services/export-data.ts` | `objectsToJson`/`objectsToCsv`, shared per-page serializer |
| `src/renderer/store/__tests__/pdf-store.test.ts` | Subset lifecycle tests |
| `src/renderer/services/__tests__/export-data.test.ts` | Subset serialization tests |
| `src/renderer/App.tsx` | `R` keyboard shortcut |
