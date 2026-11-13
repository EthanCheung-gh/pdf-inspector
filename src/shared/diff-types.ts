/**
 * Diff data contract shared by the desktop main process, the preload bridge,
 * the browser adapter, the web server and the renderer.
 *
 * It lives in src/shared (not src/renderer/types) so the composite node
 * tsconfig project can import it without pulling renderer files in — the same
 * reason `SaveFileRequest` lives in src/shared/constants.ts.
 *
 * Two naming rules apply:
 * - Every field is camelCase here. The sidecar RPC is snake_case, so requests
 *   go through `diffOptionsToRpc()`; results are already camelCase (the Python
 *   engine serialises its own contract) and are returned verbatim.
 * - `DiffResult` mirrors `sidecar/diff.py` exactly (`schemaVersion` 1, `tool`,
 *   `options`, `old`, `new`, `summary`, `pages`). Keep the two in sync.
 */

/** Object types the engine can diff, in the order it reports them. */
export const DIFF_OBJECT_TYPES = [
  'word',
  'char',
  'rect',
  'line',
  'curve',
  'image',
  'table',
] as const;

export type DiffObjectType = (typeof DIFF_OBJECT_TYPES)[number];

/**
 * Document resource types, reported after every object type.
 *
 * `annotation`/`link`/`form` changes live in `DiffPage.changes` next to object
 * changes (the engine gives them the same shape); `metadata`/`page-label`
 * changes are document-level and only appear in `DiffResult.documentChanges`.
 */
export const DIFF_RESOURCE_TYPES = [
  'annotation',
  'link',
  'form',
  'metadata',
  'page-label',
] as const;

export type DiffResourceType = (typeof DIFF_RESOURCE_TYPES)[number];

/** Page-level resource types: the ones a page change list can carry. */
export const DIFF_PAGE_RESOURCE_TYPES = ['annotation', 'link', 'form'] as const;

export type DiffPageResourceType = (typeof DIFF_PAGE_RESOURCE_TYPES)[number];

/** Everything `DiffChange.type` can be: object types plus resource types. */
export type DiffChangeType = DiffObjectType | DiffResourceType;

export type DiffChangeKind = 'added' | 'removed' | 'moved' | 'modified';

export type DiffPageStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export const DIFF_TEXT_TOLERANCES = ['exact', 'normalized', 'case-insensitive'] as const;

export type DiffTextTolerance = (typeof DIFF_TEXT_TOLERANCES)[number];

/**
 * Options as they appear in a request and are echoed in `DiffResult.options`.
 *
 * `failOn` is deliberately NOT here: it is a CLI/report decision (`sidecar/cli.py`),
 * not an input to the diff engine, so it never reaches the RPC.
 */
export interface DiffOptions {
  /** Position tolerance in PDF points. Default 1.0. */
  positionTolerance: number;
  /** Text comparison mode. Default `normalized`. */
  textTolerance: DiffTextTolerance;
  /**
   * Object types to skip entirely (default is `[]` in the engine/CLI).
   *
   * The renderer's default is `['char']`: word-level changes already cover
   * text edits, and character-level diffs are opt-in there because a large text
   * PDF can produce hundreds of thousands of glyph changes.
   */
  ignoreTypes: DiffObjectType[];
  ignoreFonts: boolean;
  ignoreColors: boolean;
  ignoreImages: boolean;
  /**
   * Page-scoped rectangles that mask changes, in MediaBox-relative PDF points.
   * Default `[]`. Read-only masks: the engine and the visual heatmap skip
   * intersecting changes, the PDFs themselves are never modified.
   */
  ignoreRegions: DiffIgnoreRegion[];
  /**
   * Skip the matching page-level resource comparison (default `false`).
   *
   * Annotations, links and form widgets are compared by default because their
   * counts are usually small — unlike character-level object diffs. The CLI
   * exposes the same switches as `--ignore-annotations`/`--ignore-links`/…
   */
  ignoreAnnotations?: boolean;
  ignoreLinks?: boolean;
  ignoreForms?: boolean;
  /** Skip the document metadata comparison (default `false`). */
  ignoreMetadata?: boolean;
  /** Skip the page label (`/PageLabels`) comparison (default `false`). */
  ignorePageLabels?: boolean;
}

/** Request-side options: every field is optional and defaults in the engine. */
export type DiffOptionsInput = Partial<DiffOptions>;

/** MediaBox-relative PDF points, matching the extractor's box contract. */
export interface DiffBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * One drawn ignore region.
 *
 * A region belongs to a page pair: `oldPage`/`newPage` are 1-based page numbers
 * (or `null` when that side does not exist) and `bbox` is in MediaBox-relative
 * PDF points, exactly like `DiffChange.oldBBox`. A change is masked when its
 * box on a side intersects a region naming that side's page.
 */
export interface DiffIgnoreRegion {
  /** 1-based page number on the old side, or null when not on that side. */
  oldPage: number | null;
  /** 1-based page number on the new side, or null when not on that side. */
  newPage: number | null;
  bbox: DiffBBox;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A 1-based page number, `null`, or `undefined` when the value is unusable. */
const normalizePage = (value: number | null): number | null | undefined => {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < 1) return undefined;
  return Math.trunc(value);
};

/**
 * Order a box and reject non-finite coordinates.
 *
 * A rectangle dragged from any corner arrives in either direction, so the UI
 * swaps the corners instead of rejecting the region; the engine does the same
 * validation but reports reversed boxes as an error (it never draws them).
 */
export function normalizeIgnoreBBox(bbox: DiffBBox): DiffBBox | null {
  if (!bbox) return null;
  const values = [bbox.x0, bbox.y0, bbox.x1, bbox.y1];
  if (!values.every(isFiniteNumber)) return null;
  return {
    x0: Math.min(bbox.x0, bbox.x1),
    y0: Math.min(bbox.y0, bbox.y1),
    x1: Math.max(bbox.x0, bbox.x1),
    y1: Math.max(bbox.y0, bbox.y1),
  };
}

/**
 * Validate and clamp one region before it enters the store.
 *
 * Returns `null` for a region that cannot mask anything: a non-finite box, a
 * page number that is not a positive integer, or a region naming no page.
 */
export function normalizeIgnoreRegion(region: DiffIgnoreRegion): DiffIgnoreRegion | null {
  if (!region) return null;
  const oldPage = normalizePage(region.oldPage);
  const newPage = normalizePage(region.newPage);
  if (oldPage === undefined || newPage === undefined) return null;
  if (oldPage === null && newPage === null) return null;
  const bbox = normalizeIgnoreBBox(region.bbox);
  if (!bbox) return null;
  return { oldPage, newPage, bbox };
}

/**
 * True when two MediaBox-relative boxes overlap; touching edges count.
 *
 * The engine applies the same rule, so a change that a drawn region touches only
 * at its edge disappears from both the result and the visual heatmap.
 */
export function ignoreBBoxIntersects(left: DiffBBox, right: DiffBBox): boolean {
  if (!left || !right) return false;
  return (
    left.x0 <= right.x1 &&
    right.x0 <= left.x1 &&
    left.y0 <= right.y1 &&
    right.y0 <= left.y1
  );
}

/** True when `change` is masked by one of `regions`. */
export function isChangeIgnoredByRegions(
  change: Pick<DiffChange, 'oldPage' | 'newPage' | 'oldBBox' | 'newBBox'>,
  regions: readonly DiffIgnoreRegion[],
): boolean {
  if (regions.length === 0) return false;
  return regions.some((region) => {
    if (
      region.oldPage !== null &&
      change.oldPage === region.oldPage &&
      change.oldBBox &&
      ignoreBBoxIntersects(change.oldBBox, region.bbox)
    ) {
      return true;
    }
    return Boolean(
      region.newPage !== null &&
        change.newPage === region.newPage &&
        change.newBBox &&
        ignoreBBoxIntersects(change.newBBox, region.bbox),
    );
  });
}

export interface DiffChange {
  kind: DiffChangeKind;
  type: DiffChangeType;
  /** 1-based page number, or `null` when the object exists only on the new side. */
  oldPage: number | null;
  newPage: number | null;
  oldBBox: DiffBBox | null;
  newBBox: DiffBBox | null;
  textOld: string | null;
  textNew: string | null;
  /**
   * font/size/color/hash/cell changes; `cellChanges` for tables.
   *
   * Resource changes add `resource` (the kind), `identity` (the engine's stable
   * pairing key) and one `{ old, new }` pair per differing field (`contents`,
   * `uri`, `value`, `color`, `rect`, …).
   */
  details: Record<string, unknown>;
}

/**
 * A document-level change: metadata field or page label.
 *
 * These never enter `DiffPage.changes`, so a metadata-only edit leaves every
 * page `unchanged`; they carry no bbox and are therefore unaffected by ignore
 * regions.
 */
export interface DiffDocumentChange {
  kind: DiffChangeKind;
  /** `metadata` for the info dictionary/`/Lang`, `page-label` for `/PageLabels`. */
  type: 'metadata' | 'page-label';
  /** 1-based page number for a page label; always `null` for metadata. */
  page: number | null;
  /** Metadata field name (`title`, `author`, …) or `page-label`. */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** Label style/prefix/start differences; empty for metadata. */
  details: Record<string, unknown>;
}

export interface DiffPageSize {
  width: number;
  height: number;
}

/**
 * Fingerprint similarity for a paired page.
 *
 * `score` is the engine's deterministic 0..1 page-fingerprint similarity
 * (1 when the fingerprints are equal, lower as size/rotation/text/object
 * counts/table cells diverge, rounded to 3 decimals). `reordered` is true when
 * the pair sits at a different ordinal (`oldIndex !== newIndex`) — a page moved
 * to another position, not merely an object moving inside the page.
 */
export interface DiffPageMatch {
  /** 0..1 similarity of the page fingerprints, rounded to 3 decimals. */
  score: number;
  /** True when `oldIndex !== newIndex` in the aligned result. */
  reordered: boolean;
}

export interface DiffPage {
  oldIndex: number | null;
  newIndex: number | null;
  status: DiffPageStatus;
  oldSize: DiffPageSize | null;
  newSize: DiffPageSize | null;
  /** Match metadata for paired pages; `null` for added/removed pages. */
  match: DiffPageMatch | null;
  changes: DiffChange[];
}

export interface DiffDocumentInfo {
  pages: number;
  sha256: string;
}

export interface DiffSummary {
  pagesAdded: number;
  pagesRemoved: number;
  pagesChanged: number;
  /** Paired pages whose old and new page numbers differ. */
  pagesReordered: number;
  objectsAdded: number;
  objectsRemoved: number;
  objectsMoved: number;
  objectsModified: number;
  /**
   * True when the engine hit its `MAX_DIFF_CHANGES` safety cap (or a resource
   * collector cap, see `resourcesTruncated`) and the result is incomplete. The
   * counts above then describe the changes that were kept, and
   * `DiffResult.truncated` carries the same flag.
   */
  changesTruncated: boolean;
  /**
   * Resource counters (annotations, links, form widgets).
   *
   * The object counters above never include resource changes, and the shared
   * change cap covers both. All resource fields are additive and optional: the
   * engine only emits them when the run compared resources and found something,
   * so an object-only result keeps its historical shape. Treat a missing
   * counter as `0`.
   */
  resourcesAdded?: number;
  resourcesRemoved?: number;
  resourcesModified?: number;
  /** Page-level resources reported as moved (paired by `/NM` identity). */
  resourcesMoved?: number;
  /** Length of `DiffResult.documentChanges`. */
  documentChanges?: number;
  /**
   * True when a compared resource block was capped or could not be read.
   *
   * The collector bounds annotations (500/page, 5000/document), forms (2000),
   * metadata and page labels. Hitting a cap makes the resource comparison
   * incomplete: the engine then also sets `truncated`/`changesTruncated`, and
   * this flag says the resource side specifically is the incomplete part.
   * Absent means "not truncated".
   */
  resourcesTruncated?: boolean;
}

/**
 * Top-level diff payload.
 *
 * `schemaVersion` stays `1`: page match metadata (`DiffPage.match`,
 * `DiffSummary.pagesReordered`), the change cap (`DiffResult.truncated`,
 * `DiffSummary.changesTruncated`) and the document resources
 * (`DiffResult.documentChanges`, the `DiffSummary` resource counters) are
 * additive, so consumers that ignore the new fields keep working unchanged.
 */
export interface DiffResult {
  schemaVersion: 1;
  tool: { name: 'pdf-inspector'; version: string };
  options: DiffOptions;
  old: DiffDocumentInfo;
  new: DiffDocumentInfo;
  summary: DiffSummary;
  /**
   * Mirrors `summary.changesTruncated`; true when the change lists (or a
   * compared resource block) were capped or incomplete.
   */
  truncated: boolean;
  /**
   * Metadata and page label changes.
   *
   * Optional and only present when something changed: page-level resources
   * (annotations/links/forms) live in `pages[].changes`, so a page label is
   * never reported twice. Treat a missing field as an empty list.
   */
  documentChanges?: DiffDocumentChange[];
  pages: DiffPage[];
}

/**
 * Where a diff input comes from.
 *
 * Desktop passes absolute file paths (strings) — a `File` cannot cross the
 * Electron IPC boundary. The browser has no local paths, so it passes the
 * `File` objects the user picked; the web adapter uploads them and the backend
 * diffs temporary copies. Callers must not mix the two in one environment.
 */
export type DiffSource = string | File;

/** Which side of a diff an uploaded browser file belongs to. */
export type DiffSide = 'old' | 'new';

/**
 * Result of choosing one side of a diff without opening it.
 *
 * Desktop picks an absolute path through a native dialog; the browser picks a
 * `File`. Both carry a display name so the setup dialog never has to parse a
 * path or a `File` to label the row. Picking never touches the open document.
 */
export type PickDiffPdfResult =
  | { canceled: true }
  | { canceled: false; source: DiffSource; name: string };

/** Narrow a `DiffSource` to a browser `File` (safe in non-DOM environments). */
export function isFileSource(source: DiffSource): source is File {
  return typeof File !== 'undefined' && source instanceof File;
}

/** Wire shape of one ignore region inside the `diff_documents` RPC options. */
export interface DiffRpcIgnoreRegion {
  old_page: number | null;
  new_page: number | null;
  bbox: DiffBBox;
}

/** Wire shape of the `options` field of the `diff_documents` RPC. */
export interface DiffRpcOptions {
  position_tolerance?: number;
  text_tolerance?: DiffTextTolerance;
  ignore_types?: DiffObjectType[];
  ignore_fonts?: boolean;
  ignore_colors?: boolean;
  ignore_images?: boolean;
  ignore_regions?: DiffRpcIgnoreRegion[];
  ignore_annotations?: boolean;
  ignore_links?: boolean;
  ignore_forms?: boolean;
  ignore_metadata?: boolean;
  ignore_page_labels?: boolean;
}

/**
 * Convert camelCase request options to the sidecar's snake_case RPC options.
 *
 * Only values that were actually provided are forwarded, so the engine keeps
 * its documented defaults. Unknown properties are dropped rather than sent:
 * the sidecar rejects unknown snake_case keys, and a stray UI-only field must
 * not fail an otherwise valid diff.
 */
export function diffOptionsToRpc(options?: DiffOptionsInput | null): DiffRpcOptions {
  const rpc: DiffRpcOptions = {};
  if (!options) return rpc;

  if (options.positionTolerance !== undefined) {
    rpc.position_tolerance = options.positionTolerance;
  }
  if (options.textTolerance !== undefined) {
    rpc.text_tolerance = options.textTolerance;
  }
  if (options.ignoreTypes !== undefined) {
    rpc.ignore_types = [...options.ignoreTypes];
  }
  if (options.ignoreFonts !== undefined) {
    rpc.ignore_fonts = options.ignoreFonts;
  }
  if (options.ignoreColors !== undefined) {
    rpc.ignore_colors = options.ignoreColors;
  }
  if (options.ignoreImages !== undefined) {
    rpc.ignore_images = options.ignoreImages;
  }
  if (options.ignoreRegions !== undefined) {
    // Deep copy: the store owns the region list, and a later edit must not
    // change a request that was already sent.
    rpc.ignore_regions = options.ignoreRegions.map((region) => ({
      old_page: region.oldPage,
      new_page: region.newPage,
      bbox: { ...region.bbox },
    }));
  }
  if (options.ignoreAnnotations !== undefined) {
    rpc.ignore_annotations = options.ignoreAnnotations;
  }
  if (options.ignoreLinks !== undefined) {
    rpc.ignore_links = options.ignoreLinks;
  }
  if (options.ignoreForms !== undefined) {
    rpc.ignore_forms = options.ignoreForms;
  }
  if (options.ignoreMetadata !== undefined) {
    rpc.ignore_metadata = options.ignoreMetadata;
  }
  if (options.ignorePageLabels !== undefined) {
    rpc.ignore_page_labels = options.ignorePageLabels;
  }
  return rpc;
}
