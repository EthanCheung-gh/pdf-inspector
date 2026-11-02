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
  /** Object types to skip entirely. Default `[]`. */
  ignoreTypes: DiffObjectType[];
  ignoreFonts: boolean;
  ignoreColors: boolean;
  ignoreImages: boolean;
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

export interface DiffChange {
  kind: DiffChangeKind;
  type: DiffObjectType;
  /** 1-based page number, or `null` when the object exists only on the new side. */
  oldPage: number | null;
  newPage: number | null;
  oldBBox: DiffBBox | null;
  newBBox: DiffBBox | null;
  textOld: string | null;
  textNew: string | null;
  /** font/size/color/hash/cell changes; `cellChanges` for tables. */
  details: Record<string, unknown>;
}

export interface DiffPageSize {
  width: number;
  height: number;
}

export interface DiffPage {
  oldIndex: number | null;
  newIndex: number | null;
  status: DiffPageStatus;
  oldSize: DiffPageSize | null;
  newSize: DiffPageSize | null;
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
  objectsAdded: number;
  objectsRemoved: number;
  objectsMoved: number;
  objectsModified: number;
}

export interface DiffResult {
  schemaVersion: 1;
  tool: { name: 'pdf-inspector'; version: string };
  options: DiffOptions;
  old: DiffDocumentInfo;
  new: DiffDocumentInfo;
  summary: DiffSummary;
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

/** Wire shape of the `options` field of the `diff_documents` RPC. */
export interface DiffRpcOptions {
  position_tolerance?: number;
  text_tolerance?: DiffTextTolerance;
  ignore_types?: DiffObjectType[];
  ignore_fonts?: boolean;
  ignore_colors?: boolean;
  ignore_images?: boolean;
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
  return rpc;
}
