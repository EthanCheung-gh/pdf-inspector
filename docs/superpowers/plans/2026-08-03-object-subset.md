# Object Subset (Region Selection + Filter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add region-selection extraction (drag a rectangle to collect intersecting/contained objects) and an object filter (type / font / size / color criteria) to PDF Inspector, unified under a single object-subset model with highlight, list, and JSON/CSV export, per `docs/superpowers/specs/2026-08-03-object-subset-design.md`.

**Architecture:** Renderer-only. Pure predicate functions (`filterByRegion`, `filterByProperties`) produce an `ObjectSubset` stored in the zustand store; the overlay canvas draws an orange border for subset members and a live blue rectangle while dragging; the Inspector panel renders a Results section (list, intersect/contain toggle, export, clear) plus filter controls. Export reuses the existing `saveFile` IPC and `export-data.ts` serializers. The Python sidecar is untouched.

**Tech Stack:** TypeScript 5.5+, React 18 + Zustand 5, Vitest 2, CSS Modules, Electron 28.

**Note (deviation from spec §4.7):** the subset export calls `window.pdfInspector.saveFile` directly — do NOT wrap it in `callWithTimeout` (the native save dialog can stay open longer than 30s and would wrongly trigger the sidecar-restart path). Same rule as the existing ExportMenu.

---

## Global Constraints

- Renderer-only; the Python sidecar must not be modified.
- Subset applies to the **current page only** (`store.allObjects`).
- `ObjectSubset.source` is a single value: a new region selection **overrides** an active filter subset and vice versa (last action wins).
- Subset is cleared on `setPage` and `setFile`.
- Empty filter criteria → subset is `null` (filter inactive).
- Region drag smaller than 4px (in screen px) → ignored, subset unchanged.
- Export cancel is silent; write failure surfaces via `store.setError` (existing banner).
- All export/serialization code must keep RFC 4180 escaping (existing `csvEscape`).

---

## File Structure — New Files

| File | Purpose |
|------|---------|
| `src/renderer/services/object-filter.ts` | `BBox`, `FilterCriteria`, `ObjectSubset` types + `intersects`/`contains`/`filterByRegion`/`filterByProperties` |
| `src/renderer/services/__tests__/object-filter.test.ts` | Unit tests for the predicates |
| `src/renderer/hooks/useRegionSelect.ts` | Drag state machine + exported pure helpers `screenToPdf`/`computeRegionBBox` |
| `src/renderer/hooks/__tests__/useRegionSelect.test.ts` | Unit tests for the pure helpers |

## File Structure — Modified Files

| File | Changes |
|------|---------|
| `src/renderer/store/pdf-store.ts` | `regionMode`, `filterCriteria`, `subset` + actions; `setPage`/`setFile` clear `subset` |
| `src/renderer/store/__tests__/pdf-store.test.ts` | subset lifecycle tests |
| `src/renderer/hooks/useOverlay.ts` | `drawOverlays` gains optional `subset`/`regionRect` params |
| `src/renderer/components/PdfViewport/OverlayCanvas.tsx` | mount drag handlers, pass subset + live rect, skip hover while dragging |
| `src/renderer/components/Toolbar/Toolbar.tsx` | "Region" toggle button next to "Select Text" |
| `src/renderer/App.tsx` | `R` keyboard shortcut (mirrors `T`) |
| `src/renderer/components/InspectorPanel/InspectorPanel.tsx` | Results section + filter controls + export |
| `src/renderer/services/export-data.ts` | `objectsToJson` / `objectsToCsv` |
| `src/renderer/services/__tests__/export-data.test.ts` | subset serialization tests |

---

### Task 1: `object-filter.ts` pure predicate functions with tests

**Files:**
- Create: `src/renderer/services/object-filter.ts`
- Test: `src/renderer/services/__tests__/object-filter.test.ts`

**Interfaces:**
- Produces:
  - `interface BBox { x0: number; y0: number; x1: number; y1: number }`
  - `interface FilterCriteria { types?: PdfObjectType[]; fontname?: string; sizeMin?: number; sizeMax?: number; color?: string }`
  - `interface ObjectSubset { source: 'region' | 'filter'; mode: 'intersect' | 'contain'; objects: PdfObject[]; bbox?: BBox }`
  - `intersects(a: BBox, b: BBox): boolean` — edge contact counts as overlap
  - `contains(outer: BBox, inner: BBox): boolean` — inclusive bounds
  - `filterByRegion(objects: PdfObject[], bbox: BBox, mode: 'intersect' | 'contain'): PdfObject[]`
  - `filterByProperties(objects: PdfObject[], criteria: FilterCriteria): PdfObject[]`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/services/__tests__/object-filter.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { filterByRegion, filterByProperties } from '../object-filter';
import type { PdfObject } from '../../types/pdf-objects';

const obj = (over: Partial<PdfObject> = {}): PdfObject => ({
  type: 'rect', x0: 10, y0: 20, x1: 30, y1: 40, page: 1, fill: true, stroke: true, color: '#000000', width: 1,
  ...over,
});

describe('filterByRegion', () => {
  it('keeps objects overlapping the region (intersect, edge contact counts)', () => {
    const objects = [obj({ x0: 0, y0: 0, x1: 10, y1: 10 }), obj({ x0: 50, y0: 50, x1: 60, y1: 60 })];
    expect(filterByRegion(objects, { x0: 10, y0: 10, x1: 40, y1: 40 }, 'intersect')).toEqual([objects[0]]);
  });

  it('keeps only objects fully inside the region (contain)', () => {
    const objects = [
      obj({ x0: 15, y0: 25, x1: 25, y1: 35 }), // inside
      obj({ x0: 0, y0: 0, x1: 50, y1: 50 }),   // overlaps but sticks out
    ];
    expect(filterByRegion(objects, { x0: 10, y0: 20, x1: 30, y1: 40 }, 'contain')).toEqual([objects[0]]);
  });

  it('excludes disjoint objects in both modes', () => {
    const far = obj({ x0: 100, y0: 100, x1: 110, y1: 110 });
    const region = { x0: 0, y0: 0, x1: 50, y1: 50 };
    expect(filterByRegion([far], region, 'intersect')).toEqual([]);
    expect(filterByRegion([far], region, 'contain')).toEqual([]);
  });
});

describe('filterByProperties', () => {
  it('combines criteria with AND', () => {
    const objects = [
      { ...obj({ type: 'char', text: 'A', fontname: 'Helvetica', size: 12 }), color: '#ff0000' } as PdfObject,
      { ...obj({ type: 'char', text: 'B', fontname: 'Helvetica', size: 10 }), color: '#ff0000' } as PdfObject,
      { ...obj({ type: 'char', text: 'C', fontname: 'Arial', size: 12 }), color: '#ff0000' } as PdfObject,
    ];
    const result = filterByProperties(objects, { fontname: 'Helvetica', sizeMin: 11, sizeMax: 13 });
    expect(result).toEqual([objects[0]]);
  });

  it('returns all objects for empty criteria and ignores unknown types in list', () => {
    const objects = [obj({ type: 'rect' }), obj({ type: 'line' })];
    expect(filterByProperties(objects, {})).toEqual(objects);
    expect(filterByProperties(objects, { types: [] })).toEqual(objects);
  });

  it('skips size/color/fontname conditions for objects lacking those fields', () => {
    const rect = obj({ type: 'rect' });
    const char = { ...obj({ type: 'char', text: 'A', fontname: 'Helvetica', size: 12 }), color: '#000000' } as PdfObject;
    expect(filterByProperties([rect, char], { sizeMin: 11, color: '#000000' })).toEqual([char]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/services/__tests__/object-filter.test.ts`
Expected: FAIL — `Cannot find module '../object-filter'`

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/services/object-filter.ts`:

```typescript
import type { PdfObject, PdfObjectType } from '../types/pdf-objects';

export interface BBox { x0: number; y0: number; x1: number; y1: number; }

export interface FilterCriteria {
  types?: PdfObjectType[];
  fontname?: string;
  sizeMin?: number;
  sizeMax?: number;
  color?: string;
}

export interface ObjectSubset {
  source: 'region' | 'filter';
  mode: 'intersect' | 'contain';
  objects: PdfObject[];
  bbox?: BBox;
}

export function intersects(a: BBox, b: BBox): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function contains(outer: BBox, inner: BBox): boolean {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
}

export function filterByRegion(objects: PdfObject[], bbox: BBox, mode: 'intersect' | 'contain'): PdfObject[] {
  return objects.filter((o) => (mode === 'intersect' ? intersects(o, bbox) : contains(bbox, o)));
}

export function filterByProperties(objects: PdfObject[], criteria: FilterCriteria): PdfObject[] {
  const { types, fontname, sizeMin, sizeMax, color } = criteria;
  return objects.filter((o) => {
    if (types && types.length > 0 && !types.includes(o.type)) return false;
    if (fontname && (!('fontname' in o) || o.fontname !== fontname)) return false;
    if (sizeMin !== undefined && (!('size' in o) || o.size < sizeMin)) return false;
    if (sizeMax !== undefined && (!('size' in o) || o.size > sizeMax)) return false;
    if (color && (!('color' in o) || o.color !== color)) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/services/__tests__/object-filter.test.ts`
Expected: PASS (3 + 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/object-filter.ts src/renderer/services/__tests__/object-filter.test.ts
git commit -m "feat: add object subset predicate functions with tests"
```

---

### Task 2: store extensions for subset / region mode / filter criteria

**Files:**
- Modify: `src/renderer/store/pdf-store.ts`
- Test: `src/renderer/store/__tests__/pdf-store.test.ts`

**Interfaces:**
- Consumes: `ObjectSubset`, `FilterCriteria`, `filterByProperties` from Task 1.
- Produces:
  - `regionMode: boolean` + `setRegionMode(on: boolean): void`
  - `filterCriteria: FilterCriteria` + `setFilterCriteria(criteria: FilterCriteria): void`
  - `subset: ObjectSubset | null` + `setSubset(subset: ObjectSubset | null): void` + `clearSubset(): void`
  - `setPage` and `setFile` now also reset `subset: null` and keep `regionMode`/`filterCriteria` reset to defaults.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/store/__tests__/pdf-store.test.ts`:

```typescript
import { usePdfStore } from '../pdf-store';
import type { PdfObject } from '../../types/pdf-objects';

const char = (font: string, size: number): PdfObject => ({
  type: 'char', x0: 0, y0: 0, x1: 10, y1: 10, page: 1, text: 'A', fontname: font, size, color: '#000000',
});

describe('subset state', () => {
  beforeEach(() => {
    const store = usePdfStore.getState();
    store.setPageData({
      width: 100, height: 100,
      chars: [char('Helvetica', 12), char('Arial', 8)],
      words: [], rects: [], lines: [], curves: [], images: [], tables: [],
    });
  });

  it('setFilterCriteria recomputes the subset from allObjects', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    const subset = usePdfStore.getState().subset;
    expect(subset?.source).toBe('filter');
    expect(subset?.objects).toHaveLength(1);
  });

  it('empty criteria clears the subset to null', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setFilterCriteria({});
    expect(usePdfStore.getState().subset).toBeNull();
  });

  it('setPage and setFile clear the subset', () => {
    const store = usePdfStore.getState();
    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setPage(2);
    expect(usePdfStore.getState().subset).toBeNull();

    store.setFilterCriteria({ fontname: 'Helvetica' });
    store.setFile('/x.pdf', { pages: 1, version: '1.7', encrypted: false, page_w: 100, page_h: 100, title: '', author: '', producer: '', fonts: [] });
    expect(usePdfStore.getState().subset).toBeNull();
  });

  it('setRegionMode(false) clears the subset', () => {
    const store = usePdfStore.getState();
    store.setSubset({ source: 'region', mode: 'intersect', objects: [], bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    store.setRegionMode(false);
    expect(usePdfStore.getState().subset).toBeNull();
    expect(usePdfStore.getState().regionMode).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: FAIL — `setFilterCriteria is not a function`

- [ ] **Step 3: Implement the store extensions**

In `src/renderer/store/pdf-store.ts`:
- Import: `import { ObjectSubset, FilterCriteria, filterByProperties } from '../services/object-filter';`
- Add to `PdfState`:
  - `regionMode: boolean; filterCriteria: FilterCriteria; subset: ObjectSubset | null;`
  - `setRegionMode(on: boolean): void; setFilterCriteria(criteria: FilterCriteria): void; setSubset(subset: ObjectSubset | null): void; clearSubset(): void;`
- Initial values: `regionMode: false, filterCriteria: {}, subset: null` (also add `subset: null` to the `setFile` reset object).
- In `setPage`, add `subset: null` to the reset object.
- Actions:

```typescript
setRegionMode: (on) =>
  set((state) => ({
    regionMode: on,
    ...(on ? {} : { subset: null }),
  })),

setFilterCriteria: (criteria) =>
  set((state) => {
    const hasCriteria =
      Boolean(criteria.types?.length) ||
      Boolean(criteria.fontname) ||
      criteria.sizeMin !== undefined ||
      criteria.sizeMax !== undefined ||
      Boolean(criteria.color);
    const subset = hasCriteria
      ? { source: 'filter' as const, mode: 'intersect' as const, objects: filterByProperties(state.allObjects, criteria) }
      : null;
    return { filterCriteria: criteria, subset };
  }),

setSubset: (subset) => set({ subset }),
clearSubset: () => set({ subset: null }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/store/__tests__/pdf-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/pdf-store.ts src/renderer/store/__tests__/pdf-store.test.ts
git commit -m "feat: add object subset state to pdf store"
```

---

### Task 3: `objectsToJson` / `objectsToCsv` subset serialization

**Files:**
- Modify: `src/renderer/services/export-data.ts`
- Test: `src/renderer/services/__tests__/export-data.test.ts`

**Interfaces:**
- Consumes: `PdfObject`, `PdfMetadata`; existing `csvEscape`, `csvRow`, `BBOX`.
- Produces:
  - `objectsToJson(objects: PdfObject[], metadata: PdfMetadata | null, page: number): string` — pretty JSON `{ metadata, exportedAt, page, objectCount, objects }`.
  - `objectsToCsv(objects: PdfObject[], page: number): string` — same `# <type>` section layout as `pagesToCsv`, rows prefixed with the shared `page` column (already present on each object).

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/services/__tests__/export-data.test.ts`:

```typescript
import { objectsToJson, objectsToCsv } from '../export-data';
import type { PdfObject } from '../../types/pdf-objects';

const objects: PdfObject[] = [
  { type: 'char', x0: 0, y0: 1, x1: 2, y1: 3, page: 2, text: 'hi, "there"', fontname: 'Helvetica', size: 12, color: '#000000' },
  { type: 'rect', x0: 4, y0: 5, x1: 6, y1: 7, page: 2, fill: true, stroke: false, color: '#ff0000', width: 1 },
];

describe('objectsToJson', () => {
  it('emits metadata, page, objectCount and objects', () => {
    const parsed = JSON.parse(objectsToJson(objects, null, 2));
    expect(parsed.page).toBe(2);
    expect(parsed.objectCount).toBe(2);
    expect(parsed.objects[0].text).toBe('hi, "there"');
  });
});

describe('objectsToCsv', () => {
  it('uses the same section headers as pagesToCsv with page-prefixed rows', () => {
    const csv = objectsToCsv(objects, 2);
    expect(csv).toContain('# chars');
    expect(csv).toContain('# rects');
    expect(csv).toContain('2,0,1,2,3,hi, "there"');
    expect(csv).not.toContain('# tables');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/services/__tests__/export-data.test.ts`
Expected: FAIL — `objectsToJson is not a function`

- [ ] **Step 3: Implement the serializers**

In `src/renderer/services/export-data.ts`, add (reusing the existing `csvEscape`, `csvRow`, `BBOX`, `PdfObject` type import — add `PdfObject` to the existing type import):

```typescript
export function objectsToJson(objects: PdfObject[], metadata: PdfMetadata | null, page: number): string {
  return JSON.stringify({ metadata, exportedAt: new Date().toISOString(), page, objectCount: objects.length, objects }, null, 2);
}

export function objectsToCsv(objects: PdfObject[], page: number): string {
  const out: string[] = [];

  out.push('# chars');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size', 'color']));
  for (const c of objects.filter((o): o is Extract<PdfObject, { type: 'char' }> => o.type === 'char')) {
    out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, c.text, c.fontname, c.size, c.color]));
  }

  out.push('# words');
  out.push(csvRow([...BBOX, 'text', 'fontname', 'size']));
  for (const w of objects.filter((o): o is Extract<PdfObject, { type: 'word' }> => o.type === 'word')) {
    out.push(csvRow([w.page, w.x0, w.y0, w.x1, w.y1, w.text, w.fontname, w.size]));
  }

  out.push('# rects');
  out.push(csvRow([...BBOX, 'fill', 'stroke', 'color', 'width']));
  for (const r of objects.filter((o): o is Extract<PdfObject, { type: 'rect' }> => o.type === 'rect')) {
    out.push(csvRow([r.page, r.x0, r.y0, r.x1, r.y1, r.fill, r.stroke, r.color, r.width]));
  }

  out.push('# lines');
  out.push(csvRow([...BBOX, 'stroke', 'color', 'width']));
  for (const l of objects.filter((o): o is Extract<PdfObject, { type: 'line' }> => o.type === 'line')) {
    out.push(csvRow([l.page, l.x0, l.y0, l.x1, l.y1, l.stroke, l.color, l.width]));
  }

  out.push('# curves');
  out.push(csvRow([...BBOX, 'points', 'stroke']));
  for (const c of objects.filter((o): o is Extract<PdfObject, { type: 'curve' }> => o.type === 'curve')) {
    out.push(csvRow([c.page, c.x0, c.y0, c.x1, c.y1, JSON.stringify(c.points), c.stroke]));
  }

  out.push('# images');
  out.push(csvRow([...BBOX, 'width', 'height', 'stream_id', 'format']));
  for (const img of objects.filter((o): o is Extract<PdfObject, { type: 'image' }> => o.type === 'image')) {
    out.push(csvRow([img.page, img.x0, img.y0, img.x1, img.y1, img.width, img.height, img.stream_id, img.format]));
  }

  out.push('# tables');
  out.push(csvRow(['page', 'table_index', 'row', 'col', 'text']));
  objects.filter((o): o is Extract<PdfObject, { type: 'table' }> => o.type === 'table').forEach((t, tableIndex) => {
    t.cells.forEach((row, rowIndex) => {
      row.forEach((text, colIndex) => {
        out.push(csvRow([t.page, tableIndex, rowIndex, colIndex, text]));
      });
    });
  });

  return `\ufeff${out.join('\n')}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/services/__tests__/export-data.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/export-data.ts src/renderer/services/__tests__/export-data.test.ts
git commit -m "feat: add object subset JSON/CSV serialization"
```

---

### Task 4: `useRegionSelect` drag interaction + overlay rendering

**Files:**
- Create: `src/renderer/hooks/useRegionSelect.ts`
- Test: `src/renderer/hooks/__tests__/useRegionSelect.test.ts`
- Modify: `src/renderer/hooks/useOverlay.ts`, `src/renderer/components/PdfViewport/OverlayCanvas.tsx`

**Interfaces:**
- Consumes: `BBox`, `ObjectSubset`, `filterByRegion` (Task 1); `regionMode`, `subset`, `setSubset`, `allObjects` from store (Task 2).
- Produces:
  - Pure: `screenToPdf(screenX: number, screenY: number, pageWidth: number, pageHeight: number, pdfWidth: number, pdfHeight: number): { x: number; y: number }`
  - Pure: `computeRegionBBox(start: { x: number; y: number }, end: { x: number; y: number }): BBox`
  - Hook: `useRegionSelect(pageWidth, pageHeight, pdfWidth, pdfHeight)` → `{ handlers: { onMouseDown, onMouseMove, onMouseUp }, liveRect: BBox | null, dragging: boolean }`
  - `useOverlay().drawOverlays` gains trailing params `(ctx, objects, visibleTypes, pageWidth, pageHeight, pdfWidth, pdfHeight, subset?: ObjectSubset | null, regionRect?: BBox | null)`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/hooks/__tests__/useRegionSelect.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { screenToPdf, computeRegionBBox } from '../useRegionSelect';

describe('screenToPdf', () => {
  it('flips the y axis and scales to PDF coordinates', () => {
    expect(screenToPdf(50, 50, 100, 100, 200, 300)).toEqual({ x: 100, y: 150 });
  });
});

describe('computeRegionBBox', () => {
  it('normalizes drag start/end into min/max bounds', () => {
    expect(computeRegionBBox({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/hooks/__tests__/useRegionSelect.test.ts`
Expected: FAIL — `Cannot find module '../useRegionSelect'`

- [ ] **Step 3: Implement `useRegionSelect.ts`**

```typescript
import { useCallback, useRef, useState } from 'react';
import { usePdfStore } from '../store/pdf-store';
import { filterByRegion, type BBox } from '../services/object-filter';

export function screenToPdf(
  screenX: number, screenY: number, pageWidth: number, pageHeight: number, pdfWidth: number, pdfHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / pageWidth) * pdfWidth,
    y: pdfHeight - (screenY / pageHeight) * pdfHeight,
  };
}

export function computeRegionBBox(start: { x: number; y: number }, end: { x: number; y: number }): BBox {
  return {
    x0: Math.min(start.x, end.x), y0: Math.min(start.y, end.y),
    x1: Math.max(start.x, end.x), y1: Math.max(start.y, end.y),
  };
}

export const useRegionSelect = (
  pageWidth: number, pageHeight: number, pdfWidth: number, pdfHeight: number,
) => {
  const regionMode = usePdfStore((s) => s.regionMode);
  const allObjects = usePdfStore((s) => s.allObjects);
  const setSubset = usePdfStore((s) => s.setSubset);
  const [dragging, setDragging] = useState(false);
  const [liveRect, setLiveRect] = useState<BBox | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!regionMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    startRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
  }, [regionMode]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const start = startRef.current;
    if (!regionMode || !start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const startPdf = screenToPdf(start.x, start.y, pageWidth, pageHeight, pdfWidth, pdfHeight);
    const curPdf = screenToPdf(cur.x, cur.y, pageWidth, pageHeight, pdfWidth, pdfHeight);
    setLiveRect(computeRegionBBox(startPdf, curPdf));
  }, [pageWidth, pageHeight, pdfWidth, pdfHeight, regionMode]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const start = startRef.current;
    startRef.current = null;
    setDragging(false);
    setLiveRect(null);
    if (!regionMode || !start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // min drag (4px), treat as click
    const bbox = computeRegionBBox(
      screenToPdf(start.x, start.y, pageWidth, pageHeight, pdfWidth, pdfHeight),
      screenToPdf(end.x, end.y, pageWidth, pageHeight, pdfWidth, pdfHeight),
    );
    const mode = usePdfStore.getState().subset?.source === 'region' ? usePdfStore.getState().subset!.mode : 'intersect';
    setSubset({ source: 'region', mode, objects: filterByRegion(allObjects, bbox, mode), bbox });
  }, [allObjects, pageWidth, pageHeight, pdfWidth, pdfHeight, regionMode, setSubset]);
```

- [ ] **Step 4: Run the test to verify pure helpers pass**

Run: `npx vitest run src/renderer/hooks/__tests__/useRegionSelect.test.ts`
Expected: PASS (pure helpers `screenToPdf`/`computeRegionBBox`; the hook's event handlers are exercised in Task 6's manual checklist)

- [ ] **Step 5: Extend `useOverlay.ts` to draw the subset border + region rectangle**

Add optional trailing params to `drawOverlays` and draw after the per-type loop:

```typescript
// signature becomes:
// drawOverlays(ctx, objects, visibleTypes, pageWidth, pageHeight, pdfWidth, pdfHeight, subset?, regionRect?)
// inside the callback, after the objects.forEach(...) loop:

if (regionRect) {
  const x = regionRect.x0 * scaleX;
  const y = pageHeight - regionRect.y1 * scaleY;
  const w = (regionRect.x1 - regionRect.x0) * scaleX;
  const h = (regionRect.y1 - regionRect.y0) * scaleY;
  ctx.fillStyle = 'rgba(80, 160, 255, 0.15)';
  ctx.strokeStyle = 'rgba(80, 160, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
}

if (subset) {
  const memberSet = new Set(subset.objects);
  ctx.strokeStyle = 'rgba(255, 140, 0, 1)';
  ctx.lineWidth = 2;
  objects.forEach((object) => {
    if (!memberSet.has(object)) return;
    if (object.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(object.x0 * scaleX, pageHeight - object.y0 * scaleY);
      ctx.lineTo(object.x1 * scaleX, pageHeight - object.y1 * scaleY);
      ctx.stroke();
      return;
    }
    const x = object.x0 * scaleX;
    const y = pageHeight - object.y1 * scaleY;
    ctx.strokeRect(x, y, (object.x1 - object.x0) * scaleX, (object.y1 - object.y0) * scaleY);
  });
}
```

(Keep the existing `objects.forEach` loop unchanged; the new code runs after it so the orange border stays on top.)

- [ ] **Step 6: Wire the drag handlers into `OverlayCanvas.tsx`**

Changes:
- Read from store: `subset`, `regionMode` (add to the existing store selectors).
- Call the hook: `const { handlers, liveRect, dragging } = useRegionSelect(pageWidth, pageHeight, pdfWidth, pdfHeight);`
- Pass to `drawOverlays(context, allObjects, overlayVisibility, pageWidth, pageHeight, pdfWidth, pdfHeight, subset, liveRect)`.
- Add `liveRect` and `subset` to the `useEffect` dependency array.
- In `getHoveredObject` callers, skip hover while dragging: `onMouseMove={(e) => { if (dragging) return; setHoveredObject(getHoveredObject(e)); }}`.
- Attach handlers: `onMouseDown={handlers.onMouseDown}`, `onMouseMove` (combine hover + region drag: call `handlers.onMouseMove(e)` then the hover guard above), `onMouseUp={handlers.onMouseUp}`, `onMouseLeave={() => { if (!dragging) setHoveredObject(null); }}`.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all previous + new tests)

- [ ] **Step 8: Commit**

```bash
git add src/renderer/hooks/useRegionSelect.ts src/renderer/hooks/__tests__/useRegionSelect.test.ts src/renderer/hooks/useOverlay.ts src/renderer/components/PdfViewport/OverlayCanvas.tsx
git commit -m "feat: add region drag selection with overlay highlight"
```

---

### Task 5: Toolbar Region toggle + `R` shortcut

**Files:**
- Modify: `src/renderer/components/Toolbar/Toolbar.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `regionMode`, `setRegionMode` from store (Task 2).

- [ ] **Step 1: Add the toggle button**

In `Toolbar.tsx`, inside the text-selection `group` (after the "Select Text" button):

```tsx
<button
  className={`${styles.button} ${regionMode ? styles.active : ''}`}
  type="button"
  onClick={() => setRegionMode(!regionMode)}
  aria-pressed={regionMode}
  title="Toggle region selection mode (R)"
>
  Region
</button>
```

Add the store selectors: `const regionMode = usePdfStore((state) => state.regionMode);` and `const setRegionMode = usePdfStore((state) => state.setRegionMode);`. When turning Region on, also turn text selection off (mutually exclusive toggles, per spec §4.3): in the click handler, `if (!regionMode) setTextSelectionMode(false);`.

- [ ] **Step 2: Add the `R` shortcut in `App.tsx`**

In `App.tsx`'s existing `handleKeyDown`, after the `T` handler block:

```typescript
if (event.key === 'r' || event.key === 'R') {
  const next = !usePdfStore.getState().regionMode;
  usePdfStore.getState().setRegionMode(next);
  if (next) usePdfStore.getState().setTextSelectionMode(false);
}
```

Add `regionMode`/`setRegionMode` to the effect's dependency array (read via `usePdfStore.getState()` — no new state subscription needed, but add `setRegionMode` via the store selector to satisfy lint deps).

- [ ] **Step 3: Verify build + manual check**

Run: `npm run build` — Expected: type-checks and builds clean.
Manual: open a PDF, press `R` → Region button highlights; press `T` → Region turns off and Select Text turns on.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Toolbar/Toolbar.tsx src/renderer/App.tsx
git commit -m "feat: add region selection toolbar toggle and R shortcut"
```

---

### Task 6: InspectorPanel Results section + filter controls + export

**Files:**
- Modify: `src/renderer/components/InspectorPanel/InspectorPanel.tsx`
- Modify: `src/renderer/components/InspectorPanel/InspectorPanel.module.css`

**Interfaces:**
- Consumes: `subset`, `setSubset`, `setFilterCriteria`, `filterCriteria`, `regionMode` from store (Task 2); `filterByRegion`, `ObjectSubset`, `BBox`, `FilterCriteria` (Task 1); `objectsToJson`, `objectsToCsv`, `suggestFilename` (Task 3); `ipc.saveFile`; `pageData`, `currentPage`, `filePath`, `metadata`, `setError` from store.
- Produces: two new rendered blocks in the Inspector panel:
  1. **Results section** (rendered when `subset !== null`): header `N objects · source: region/filter` + Clear button; for `source === 'region'`, an intersect/contain toggle recomputing via `filterByRegion(subset.bbox)`; scrollable object list; Export JSON / Export CSV buttons.
  2. **Filter controls** (always visible, above Results): type checkboxes (the 7 `PdfObjectType`s), font name `<select>` (unique `fontname` values from `allObjects`), size min/max `<input type="number">`, color `<select>` (unique `color` values from `allObjects`), Clear button.

- [ ] **Step 1: Build the filter controls**

In `InspectorPanel.tsx`, derive the option lists once per render:

```typescript
const allObjects = usePdfStore((s) => s.allObjects);
const fontnames = Array.from(new Set(allObjects.flatMap((o) => ('fontname' in o ? [o.fontname] : [])))).sort();
const colorOptions = Array.from(new Set(allObjects.flatMap((o) => ('color' in o ? [String(o.color)] : [])))).sort();
```

Render a "Filter" section above the existing Object section with:
- 7 type checkboxes (`char`, `word`, `rect`, `line`, `curve`, `image`, `table`) bound to `filterCriteria.types` (toggle membership; empty list → `undefined`).
- `<select>` for fontname (`<option value="">Any font</option>` + the list).
- two `<input type="number">` for size min/max.
- `<select>` for color (`<option value="">Any color</option>` + `colorOptions`).
- "Clear filter" button → `setFilterCriteria({})`.
- Every change calls `setFilterCriteria({ ...filterCriteria, ...patch })`.

- [ ] **Step 2: Build the Results section**

Rendered below the filter section when `subset !== null`:

```tsx
{subset && (
  <section className={styles.section}>
    <h3 className={styles.sectionTitle}>
      Results ({subset.objects.length} · {subset.source})
      <button type="button" onClick={clearSubset}>Clear</button>
    </h3>
    {subset.source === 'region' && (
      <div className={styles.row}>
        <label>
          <input
            type="checkbox"
            checked={subset.mode === 'intersect'}
            onChange={() => setSubset({ ...subset, mode: 'intersect', objects: filterByRegion(allObjects, subset.bbox!, 'intersect') })}
          />
          Intersect
        </label>
        <label>
          <input
            type="checkbox"
            checked={subset.mode === 'contain'}
            onChange={() => setSubset({ ...subset, mode: 'contain', objects: filterByRegion(allObjects, subset.bbox!, 'contain') })}
          />
          Contain
        </label>
      </div>
    )}
    <div className={styles.resultList}>
      {subset.objects.length === 0 && <div>No objects in selection/filter.</div>}
      {subset.objects.map((object, index) => (
        <button
          key={index}
          type="button"
          className={styles.resultItem}
          onClick={() => setSelectedObject(object)}
        >
          [{object.type}] {'text' in object ? object.text : `${object.x0},${object.y0} → ${object.x1},${object.y1}`}
        </button>
      ))}
    </div>
    <div className={styles.row}>
      <button type="button" onClick={() => void handleExport('json')}>Export JSON</button>
      <button type="button" onClick={() => void handleExport('csv')}>Export CSV</button>
    </div>
  </section>
)}
```

Where:

```typescript
const handleExport = async (ext: 'json' | 'csv'): Promise<void> => {
  const state = usePdfStore.getState();
  if (!state.subset || !state.filePath) return;
  const content = ext === 'json'
    ? objectsToJson(state.subset.objects, state.metadata, state.currentPage)
    : objectsToCsv(state.subset.objects, state.currentPage);
  try {
    const result = await ipc.saveFile({
      defaultPath: suggestFilename(state.filePath, 'page', state.currentPage, ext),
      content,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (result && !result.canceled && 'error' in result && result.error) {
      usePdfStore.getState().setError(result.error);
    }
  } catch (error) {
    usePdfStore.getState().setError(error instanceof Error ? error.message : 'Export failed');
  }
};
```

Add CSS module rules for `.resultList` (max-height + scroll), `.resultItem` (full-width left-aligned button), and the filter rows in `InspectorPanel.module.css` (use the existing `.row`/`.section` styles where possible).

- [ ] **Step 3: Verify build + run all tests**

Run: `npm run build` and `npx vitest run`
Expected: clean build, all tests pass.

- [ ] **Step 4: Manual verification checklist**

- Open a PDF with text + images + a table.
- Press `R` (or click Region), drag a rectangle over part of the page → Results shows matched objects; orange borders appear on the canvas.
- Toggle Intersect/Contain → result count changes without re-dragging.
- Click a list item → object highlights gold and details appear below.
- Export JSON and CSV → files contain only the subset; open CSV in Excel (UTF-8 BOM preserved).
- Drag a tiny rectangle (< 4px) → nothing happens.
- Type a font in the filter → subset switches to filter source; Esc/clear filter → subset clears.
- Turn on Select Text while Region is active → Region turns off (and vice versa).
- Page turn / open new file → subset cleared.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/InspectorPanel/InspectorPanel.tsx src/renderer/components/InspectorPanel/InspectorPanel.module.css
git commit -m "feat: add object subset results section and filter controls to inspector"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1 subset model → Task 1+2; §4.2/4.3 region interaction → Task 4; §4.4 highlight → Task 4 Step 5; §4.5 store → Task 2; §4.6 results → Task 6; §4.7 export → Task 3+6; §4.8 toolbar → Task 5; §5 data flow → Tasks 4/6; §6 error handling (min-drag 4px, setPage/setFile clear, empty criteria null, silent cancel, error banner) → Tasks 2/4/6; §7 testing → every task.
- **Deviation noted:** `saveFile` invoked directly (no `callWithTimeout`), consistent with the existing ExportMenu and the search-and-export plan's header note.
- **Type consistency:** `ObjectSubset`/`FilterCriteria`/`BBox` defined once in Task 1 and reused everywhere; `setSubset`/`setFilterCriteria`/`setRegionMode` names consistent across Tasks 2/4/5/6; `screenToPdf`/`computeRegionBBox` exported pure helpers tested in Task 4.
