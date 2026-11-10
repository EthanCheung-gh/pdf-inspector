/**
 * Pure helpers for the Diff workspace: filtering, page grouping, box
 * projection and detail formatting.
 *
 * Everything here is DOM-free so it can be unit tested without PDF.js or a
 * canvas, and so the components stay thin. Coordinate handling matches the
 * rest of the app: diff boxes are MediaBox-relative PDF points with y growing
 * upwards, and the canvas flips them against the rendered page height.
 */
import {
  DIFF_OBJECT_TYPES,
  type DiffBBox,
  type DiffChange,
  type DiffChangeKind,
  type DiffObjectType,
  type DiffPage,
  type DiffPageSize,
  type DiffSide,
} from '../../shared/diff-types';
import { MAX_FIT_WIDTH_ZOOM, MIN_FIT_WIDTH_ZOOM } from './page-geometry';
import { exportStemFromName } from './export-data';

export const DIFF_CHANGE_KINDS: readonly DiffChangeKind[] = [
  'added',
  'removed',
  'moved',
  'modified',
];

export const DIFF_OBJECT_TYPE_ORDER: readonly DiffObjectType[] = DIFF_OBJECT_TYPES;

/** `'all'` means "no restriction", which is the default for both dropdowns. */
export interface DiffFilter {
  kind: DiffChangeKind | 'all';
  type: DiffObjectType | 'all';
}

export const DEFAULT_DIFF_FILTER: DiffFilter = { kind: 'all', type: 'all' };

export const isDiffFilterActive = (filter: DiffFilter): boolean =>
  filter.kind !== 'all' || filter.type !== 'all';

export const matchesDiffFilter = (change: DiffChange, filter: DiffFilter): boolean =>
  (filter.kind === 'all' || change.kind === filter.kind) &&
  (filter.type === 'all' || change.type === filter.type);

/** Identifies one change without depending on object identity. */
export interface DiffChangeRef {
  pageIndex: number;
  changeIndex: number;
}

export interface DiffChangeEntry {
  change: DiffChange;
  changeIndex: number;
}

export interface DiffPageGroup {
  pageIndex: number;
  page: DiffPage;
  changes: DiffChangeEntry[];
}

/**
 * Group changes by page for the left-hand list.
 *
 * Pages with no matching change are omitted, except one-sided pages
 * (`added`/`removed`): those carry the only navigation to a page that does not
 * exist on the other side, so they stay listed while the filter is neutral.
 * With an explicit filter the user asked for specific changes, and empty
 * one-sided rows would just be noise.
 */
export function buildDiffPageGroups(pages: DiffPage[], filter: DiffFilter): DiffPageGroup[] {
  const filterActive = isDiffFilterActive(filter);

  return pages.reduce<DiffPageGroup[]>((groups, page, pageIndex) => {
    const changes = page.changes.reduce<DiffChangeEntry[]>((entries, change, changeIndex) => {
      if (matchesDiffFilter(change, filter)) entries.push({ change, changeIndex });
      return entries;
    }, []);

    const keepOneSided = !filterActive && (page.status === 'added' || page.status === 'removed');
    if (changes.length > 0 || keepOneSided) {
      groups.push({ pageIndex, page, changes });
    }
    return groups;
  }, []);
}

/** Count of changes matching the filter, across every page. */
export function countFilteredChanges(pages: DiffPage[], filter: DiffFilter): number {
  return pages.reduce(
    (total, page) => total + page.changes.filter((change) => matchesDiffFilter(change, filter)).length,
    0,
  );
}

/** The first page worth showing after a diff: the first one that changed. */
export function firstInterestingPageIndex(pages: DiffPage[]): number {
  const index = pages.findIndex((page) => page.status !== 'unchanged');
  return index >= 0 ? index : 0;
}

export function isDiffResultEmpty(pages: DiffPage[]): boolean {
  return pages.every((page) => page.status === 'unchanged' && page.changes.length === 0);
}

/**
 * Page-size/rotation changes are reported as a `rect` modification whose
 * `details.pageGeometry` marks it as page metadata, not a real rectangle: it
 * must never be drawn as an object box.
 */
export function isPageGeometryChange(change: DiffChange): boolean {
  return Boolean(change.details && change.details.pageGeometry);
}

/** Colour per side and kind. Old: removed red, moved orange, modified blue. */
export const DIFF_BOX_COLORS: Record<DiffSide, Record<DiffChangeKind, string>> = {
  old: {
    removed: '#ff5f5f',
    moved: '#ffa03c',
    modified: '#4b93e6',
    added: '#3ecf6a',
  },
  new: {
    added: '#3ecf6a',
    moved: '#ffa03c',
    modified: '#4b93e6',
    removed: '#ff5f5f',
  },
};

/** One box to draw on a pane, in the PDF point space of the page it belongs to. */
export interface DiffBoxSpec {
  key: string;
  kind: DiffChangeKind;
  side: DiffSide;
  bbox: DiffBBox;
  /** Page size the bbox is measured against (PDF points). */
  space: DiffPageSize;
  selected: boolean;
}

export interface DiffBoxRect {
  key: string;
  kind: DiffChangeKind;
  side: DiffSide;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  selected: boolean;
}

const validSize = (size: DiffPageSize | null | undefined): size is DiffPageSize =>
  Boolean(size) && Number.isFinite(size!.width) && Number.isFinite(size!.height)
    && size!.width > 0 && size!.height > 0;

const validBBox = (bbox: DiffBBox | null | undefined): bbox is DiffBBox =>
  Boolean(bbox) &&
  Number.isFinite(bbox!.x0) &&
  Number.isFinite(bbox!.y0) &&
  Number.isFinite(bbox!.x1) &&
  Number.isFinite(bbox!.y1);

/**
 * Collect the boxes a pane must draw for one page and one side.
 *
 * Page-geometry changes and changes without a bbox on that side are skipped.
 * The selected box is emitted last so it is painted on top of its neighbours.
 */
export function collectPageBoxes(
  page: DiffPage,
  side: DiffSide,
  selection: DiffChangeRef | null,
  pageIndex: number,
): DiffBoxSpec[] {
  const space = side === 'old' ? page.oldSize : page.newSize;
  if (!validSize(space)) return [];

  const selected: DiffBoxSpec[] = [];
  const others: DiffBoxSpec[] = [];

  page.changes.forEach((change, changeIndex) => {
    if (isPageGeometryChange(change)) return;
    const bbox = side === 'old' ? change.oldBBox : change.newBBox;
    if (!validBBox(bbox)) return;

    const spec: DiffBoxSpec = {
      key: `${pageIndex}:${changeIndex}:${side}`,
      kind: change.kind,
      side,
      bbox,
      space,
      selected: Boolean(
        selection && selection.pageIndex === pageIndex && selection.changeIndex === changeIndex,
      ),
    };
    (spec.selected ? selected : others).push(spec);
  });

  return [...others, ...selected];
}

/** Overlay mode: both sides' boxes on one page. */
export function collectOverlayBoxes(
  page: DiffPage,
  selection: DiffChangeRef | null,
  pageIndex: number,
): DiffBoxSpec[] {
  const oldBoxes = collectPageBoxes(page, 'old', selection, pageIndex);
  const newBoxes = collectPageBoxes(page, 'new', selection, pageIndex);
  // Keep the selected box of each side on top of that side's boxes.
  return [...oldBoxes, ...newBoxes];
}

/**
 * Map a MediaBox-relative PDF box onto the rendered page.
 *
 * Returns `null` for unusable geometry instead of NaN rectangles (a zero-size
 * page or a partially extracted object must not break the canvas).
 */
export function projectDiffBBox(
  bbox: DiffBBox,
  space: DiffPageSize,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!validBBox(bbox) || !validSize(space)) return null;
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight)) return null;
  if (pageWidth <= 0 || pageHeight <= 0) return null;

  const scaleX = pageWidth / space.width;
  const scaleY = pageHeight / space.height;

  return {
    x: bbox.x0 * scaleX,
    // PDF y grows upwards, the canvas grows downwards.
    y: pageHeight - bbox.y1 * scaleY,
    width: (bbox.x1 - bbox.x0) * scaleX,
    height: (bbox.y1 - bbox.y0) * scaleY,
  };
}

/** Project every box spec onto a canvas of `pageWidth` x `pageHeight` CSS px. */
export function diffBoxRects(
  boxes: DiffBoxSpec[],
  pageWidth: number,
  pageHeight: number,
): DiffBoxRect[] {
  return boxes.reduce<DiffBoxRect[]>((rects, box) => {
    const rect = projectDiffBBox(box.bbox, box.space, pageWidth, pageHeight);
    if (!rect) return rects;
    rects.push({
      key: box.key,
      kind: box.kind,
      side: box.side,
      color: DIFF_BOX_COLORS[box.side][box.kind],
      selected: box.selected,
      ...rect,
    });
    return rects;
  }, []);
}

/** Shared zoom so both panes stay in step; clamped like the Inspect viewport. */
export function clampDiffZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_FIT_WIDTH_ZOOM, Math.max(MIN_FIT_WIDTH_ZOOM, zoom));
}

/**
 * Zoom that makes the widest page of the visible pair fit its pane.
 *
 * `availableWidth` is one pane's width (side-by-side) or the whole center
 * column (overlay). Invalid measurements return the current-style default of
 * 100% instead of a NaN zoom.
 */
export function computeDiffFitZoom(
  availableWidth: number,
  pageWidths: readonly number[],
  horizontalPadding = 32,
): number {
  const usable = availableWidth - horizontalPadding;
  const widest = Math.max(...pageWidths.filter((width) => Number.isFinite(width) && width > 0), 0);
  if (!Number.isFinite(usable) || usable <= 0 || widest <= 0) return 1;
  return clampDiffZoom(usable / widest);
}

/** Page label for the list/navigation bar; unpaired pages read as one-sided. */
export function diffPageLabel(page: DiffPage): string {
  if (page.oldIndex !== null && page.newIndex !== null) {
    return page.oldIndex === page.newIndex
      ? `Page ${page.oldIndex}`
      : `Old ${page.oldIndex} → New ${page.newIndex}`;
  }
  if (page.newIndex !== null) return `New page ${page.newIndex}`;
  if (page.oldIndex !== null) return `Old page ${page.oldIndex}`;
  return 'Unpaired page';
}

export const DIFF_PAGE_STATUS_LABELS: Record<DiffPage['status'], string> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
  unchanged: 'unchanged',
};

/** One-line preview for a change row. */
export function diffChangePreview(change: DiffChange): string {
  const text = (change.textNew ?? change.textOld ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;

  if (isPageGeometryChange(change)) return 'Page size / rotation changed';

  const bbox = change.oldBBox ?? change.newBBox;
  if (bbox) {
    return `${bbox.x0.toFixed(0)}, ${bbox.y0.toFixed(0)} → ${bbox.x1.toFixed(0)}, ${bbox.y1.toFixed(0)}`;
  }
  return '(no text)';
}

export const formatDiffBBox = (bbox: DiffBBox | null): string => {
  if (!bbox) return '—';
  const round = (value: number): string => String(Math.round(value * 10) / 10);
  return `${round(bbox.x0)}, ${round(bbox.y0)} → ${round(bbox.x1)}, ${round(bbox.y1)} pt`;
};

export interface DiffDetailRow {
  label: string;
  oldValue: string;
  newValue: string;
}

const DETAIL_LABELS: Record<string, string> = {
  fontName: 'Font',
  fontSize: 'Size',
  color: 'Colour',
  stroke: 'Stroke',
  fill: 'Fill',
  strokeWidth: 'Stroke width',
  size: 'Size',
  points: 'Points',
  contentHash: 'Content hash',
  pixelSize: 'Pixels',
  rows: 'Rows',
  cols: 'Columns',
};

interface DetailPair {
  old?: unknown;
  new?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPair = (value: unknown): value is DetailPair =>
  isRecord(value) && ('old' in value || 'new' in value);

const formatValue = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (isRecord(value)) {
    const width = value.width;
    const height = value.height;
    if (typeof width === 'number' && typeof height === 'number') {
      return `${Math.round(width * 10) / 10} × ${Math.round(height * 10) / 10}`;
    }
    if (typeof value.x === 'number' && typeof value.y === 'number') {
      return `${value.x}, ${value.y}`;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(', ');
  return String(value);
};

/**
 * Flatten `change.details` into label/old/new rows.
 *
 * `cellChanges` and `pageGeometry` are handled by their own renderers, so they
 * are excluded here.
 */
export function describeDiffDetails(change: DiffChange): DiffDetailRow[] {
  const details = change.details ?? {};
  return Object.entries(details).reduce<DiffDetailRow[]>((rows, [key, value]) => {
    if (key === 'cellChanges' || key === 'pageGeometry') return rows;
    const label = DETAIL_LABELS[key] ?? key;
    if (isPair(value)) {
      rows.push({ label, oldValue: formatValue(value.old), newValue: formatValue(value.new) });
    } else {
      rows.push({ label, oldValue: formatValue(value), newValue: '—' });
    }
    return rows;
  }, []);
}

export interface TableCellChange {
  row: number;
  col: number;
  old: string;
  new: string;
}

const toCellText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/** Validated `details.cellChanges`, ignoring malformed entries. */
export function tableCellChanges(change: DiffChange): TableCellChange[] {
  const raw = change.details?.cellChanges;
  if (!Array.isArray(raw)) return [];

  return raw.reduce<TableCellChange[]>((cells, entry) => {
    if (!isRecord(entry)) return cells;
    const row = entry.row;
    const col = entry.col;
    if (typeof row !== 'number' || typeof col !== 'number') return cells;
    cells.push({ row, col, old: toCellText(entry.old), new: toCellText(entry.new) });
    return cells;
  }, []);
}

/** Human summary of a page size/rotation change, empty for other changes. */
export function pageGeometrySummary(change: DiffChange): string[] {
  const geometry = change.details?.pageGeometry;
  if (!isRecord(geometry)) return [];

  const lines: string[] = [];
  if (isPair(geometry.size)) {
    lines.push(`Page size ${formatValue(geometry.size.old)} → ${formatValue(geometry.size.new)} pt`);
  }
  if (isPair(geometry.rotation)) {
    lines.push(`Rotation ${formatValue(geometry.rotation.old)}° → ${formatValue(geometry.rotation.new)}°`);
  }
  return lines;
}

/**
 * `a.pdf` + `b.pdf` -> `a-vs-b-diff.json`.
 *
 * Each side goes through the shared `exportStemFromName` helper, so Unicode
 * names survive, percent-encoded names/paths/URLs are decoded and only
 * portability-invalid characters are replaced. A missing side keeps its
 * `old`/`new` fallback.
 */
export function suggestDiffJsonFilename(oldName: string | null, newName: string | null): string {
  const strip = (name: string | null, fallback: string): string =>
    exportStemFromName(name) || fallback;
  return `${strip(oldName, 'old')}-vs-${strip(newName, 'new')}-diff.json`;
}
