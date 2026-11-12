import type {
  PageData,
  PdfChar,
  PdfCurve,
  PdfImage,
  PdfLine,
  PdfMetadata,
  PdfObject,
  PdfObjectType,
  PdfRect,
  PdfTable,
  PdfWord,
} from '../types/pdf-objects';

/** All exportable object types in canonical section order. */
export const EXPORT_OBJECT_TYPES: PdfObjectType[] = [
  'char',
  'word',
  'rect',
  'line',
  'curve',
  'image',
  'table',
];

/**
 * Canonical, de-duplicated selection. `undefined` means every type; an explicit
 * empty list stays empty (it means "no object data", not "all"). Unknown type
 * strings are ignored instead of being rejected.
 */
function resolveTypes(types?: readonly PdfObjectType[]): PdfObjectType[] {
  if (types === undefined) return [...EXPORT_OBJECT_TYPES];
  const requested = new Set<string>(types);
  return EXPORT_OBJECT_TYPES.filter((type) => requested.has(type));
}

function isSelected(selected: readonly PdfObjectType[], type: PdfObjectType): boolean {
  return selected.includes(type);
}

function filterObjects(objects: PdfObject[], selected: readonly PdfObjectType[]): PdfObject[] {
  return objects.filter((o) => isSelected(selected, o.type));
}

export function pagesToJson(
  pages: PageData[],
  metadata: PdfMetadata | null,
  types?: readonly PdfObjectType[],
): string {
  const objectTypes = resolveTypes(types);
  return JSON.stringify(
    {
      metadata,
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      objectTypes,
      pages: pages.map((page) => ({
        ...page,
        chars: isSelected(objectTypes, 'char') ? page.chars : [],
        words: isSelected(objectTypes, 'word') ? page.words : [],
        rects: isSelected(objectTypes, 'rect') ? page.rects : [],
        lines: isSelected(objectTypes, 'line') ? page.lines : [],
        curves: isSelected(objectTypes, 'curve') ? page.curves : [],
        images: isSelected(objectTypes, 'image') ? page.images : [],
        tables: isSelected(objectTypes, 'table') ? page.tables : [],
      })),
    },
    null,
    2,
  );
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: readonly (string | number | boolean)[]): string {
  return values.map((v) => csvEscape(String(v))).join(',');
}

const BOM = '\uFEFF';

const BBOX = ['page', 'x0', 'y0', 'x1', 'y1'] as const;

interface CsvSection {
  title: string;
  header: readonly string[];
}

/** Per-type CSV section metadata, keyed by canonical object type. */
const CSV_SECTIONS: Record<PdfObjectType, CsvSection> = {
  char: { title: '# chars', header: [...BBOX, 'text', 'fontname', 'size', 'color'] },
  word: { title: '# words', header: [...BBOX, 'text', 'fontname', 'size'] },
  rect: { title: '# rects', header: [...BBOX, 'fill', 'stroke', 'color', 'width'] },
  line: { title: '# lines', header: [...BBOX, 'stroke', 'color', 'width'] },
  curve: { title: '# curves', header: [...BBOX, 'points', 'stroke'] },
  image: { title: '# images', header: [...BBOX, 'width', 'height', 'stream_id', 'format'] },
  table: { title: '# tables', header: ['page', 'table_index', 'row', 'col', 'text'] },
};

type CsvValues = (string | number | boolean)[];

function charCsvRow(c: PdfChar): CsvValues {
  return [c.page, c.x0, c.y0, c.x1, c.y1, c.text, c.fontname, c.size, c.color];
}

function wordCsvRow(w: PdfWord): CsvValues {
  return [w.page, w.x0, w.y0, w.x1, w.y1, w.text, w.fontname, w.size];
}

function rectCsvRow(r: PdfRect): CsvValues {
  return [r.page, r.x0, r.y0, r.x1, r.y1, r.fill, r.stroke, r.color, r.width];
}

function lineCsvRow(l: PdfLine): CsvValues {
  return [l.page, l.x0, l.y0, l.x1, l.y1, l.stroke, l.color, l.width];
}

function curveCsvRow(c: PdfCurve): CsvValues {
  return [c.page, c.x0, c.y0, c.x1, c.y1, JSON.stringify(c.points), c.stroke];
}

function imageCsvRow(img: PdfImage): CsvValues {
  return [img.page, img.x0, img.y0, img.x1, img.y1, img.width, img.height, img.stream_id, img.format];
}

/** One row per cell, keeping the table's position inside the current section. */
function tableCsvRows(table: PdfTable, tableIndex: number): CsvValues[] {
  const rows: CsvValues[] = [];
  table.cells.forEach((row, rowIndex) => {
    row.forEach((text, colIndex) => {
      rows.push([table.page, tableIndex, rowIndex, colIndex, text]);
    });
  });
  return rows;
}

function objectsOfType<T extends PdfObjectType>(objects: PdfObject[], type: T): Extract<PdfObject, { type: T }>[] {
  return objects.filter((o) => o.type === type) as Extract<PdfObject, { type: T }>[];
}

/** Row builders over full pages; table indexes restart per page. */
const PAGE_CSV_ROWS: Record<PdfObjectType, (pages: PageData[]) => CsvValues[]> = {
  char: (pages) => pages.flatMap((p) => p.chars.map(charCsvRow)),
  word: (pages) => pages.flatMap((p) => p.words.map(wordCsvRow)),
  rect: (pages) => pages.flatMap((p) => p.rects.map(rectCsvRow)),
  line: (pages) => pages.flatMap((p) => p.lines.map(lineCsvRow)),
  curve: (pages) => pages.flatMap((p) => p.curves.map(curveCsvRow)),
  image: (pages) => pages.flatMap((p) => p.images.map(imageCsvRow)),
  table: (pages) => pages.flatMap((p) => p.tables.flatMap((t, tableIndex) => tableCsvRows(t, tableIndex))),
};

/** Row builders over a flat object list; table indexes follow the filtered order. */
const OBJECT_CSV_ROWS: Record<PdfObjectType, (objects: PdfObject[]) => CsvValues[]> = {
  char: (objects) => objectsOfType(objects, 'char').map(charCsvRow),
  word: (objects) => objectsOfType(objects, 'word').map(wordCsvRow),
  rect: (objects) => objectsOfType(objects, 'rect').map(rectCsvRow),
  line: (objects) => objectsOfType(objects, 'line').map(lineCsvRow),
  curve: (objects) => objectsOfType(objects, 'curve').map(curveCsvRow),
  image: (objects) => objectsOfType(objects, 'image').map(imageCsvRow),
  table: (objects) => objectsOfType(objects, 'table').flatMap((t, tableIndex) => tableCsvRows(t, tableIndex)),
};

/**
 * Single CSV document, one `# <type>` section per selected type in canonical
 * order. BOM-prefixed so Excel decodes UTF-8 correctly; an empty selection
 * produces just the BOM.
 */
function serializeCsvSections(
  selected: readonly PdfObjectType[],
  rowsFor: (type: PdfObjectType) => CsvValues[],
): string {
  if (selected.length === 0) return BOM;

  const out: string[] = [];
  for (const type of selected) {
    out.push(CSV_SECTIONS[type].title);
    out.push(csvRow(CSV_SECTIONS[type].header));
    for (const row of rowsFor(type)) out.push(csvRow(row));
  }

  return `${BOM}${out.join('\n')}\n`;
}

export function pagesToCsv(pages: PageData[], types?: readonly PdfObjectType[]): string {
  const selected = resolveTypes(types);
  return serializeCsvSections(selected, (type) => PAGE_CSV_ROWS[type](pages));
}

export function objectsToJson(
  objects: PdfObject[],
  metadata: PdfMetadata | null,
  page: number,
  types?: readonly PdfObjectType[],
): string {
  const objectTypes = resolveTypes(types);
  const selectedObjects = filterObjects(objects, objectTypes);
  return JSON.stringify(
    {
      metadata,
      exportedAt: new Date().toISOString(),
      page,
      objectCount: selectedObjects.length,
      objectTypes,
      objects: selectedObjects,
    },
    null,
    2,
  );
}

export function objectsToCsv(
  objects: PdfObject[],
  page: number,
  types?: readonly PdfObjectType[],
): string {
  const selected = resolveTypes(types);
  return serializeCsvSections(selected, (type) => OBJECT_CSV_ROWS[type](objects));
}

/**
 * Percent-decoding that never throws and is bounded.
 *
 * Document paths can reach the renderer already encoded (the web backend serves
 * `/doc/<uuid>/%E6%B5%8B%E8%AF%95.pdf`), sometimes double-encoded, and a
 * malformed sequence must never break an export. At most two passes are
 * attempted; anything still encoded afterwards is left as-is.
 */
function safeDecode(value: string): string {
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(current)) break;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

/** Characters that cannot appear in a file name on Windows (and controls). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Bidirectional overrides/isolates. They are invisible in a file manager but
 * reorder how the rest of the name is displayed, so a name can look like a
 * different file than it is.
 */
const BIDI_CONTROL_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;

/** A stem made only of separators/placeholders carries no user information. */
const PLACEHOLDER_STEM = /^[_.\-\s]*$/;

/**
 * Whether a stem can name an exported file.
 *
 * Rejects empty values and legacy placeholders such as `_____` (what the old
 * web sanitizer produced for Chinese uploads) so they never become a filename.
 */
function isUsableStem(stem: string): boolean {
  return stem.length > 0 && !PLACEHOLDER_STEM.test(stem);
}

/**
 * Turn a raw name into a safe stem: no invisible bidi controls, no directories,
 * no invalid characters. Unicode letters are kept.
 */
function sanitizeStem(raw: string): string {
  return raw
    .replace(BIDI_CONTROL_CHARS, '')
    .replace(/[\\/]/g, '_')
    .replace(INVALID_FILENAME_CHARS, '_')
    .trim();
}

/** Drop a `.pdf` suffix (case-insensitive) from an already decoded name. */
function stripPdfExtension(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/**
 * Portable filename stem from a document name, URL or path.
 *
 * Used by the audit/diff exporters, which are handed whatever the store knows:
 * a display name, an absolute path or a source URL. Percent escapes are
 * decoded, directories/query/hash are dropped, `.pdf` is stripped, invalid and
 * bidi-control characters are removed and an unusable placeholder yields `''`
 * so the caller can apply its own fallback. Unicode is preserved.
 */
export function exportStemFromName(raw: string | null | undefined): string {
  if (!raw) return '';

  const trimmed = raw.trim();
  if (!trimmed) return '';

  let candidate = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      // A URL can only name a file through its pathname (no query/hash).
      candidate = new URL(trimmed).pathname;
    } catch {
      // Not a parseable URL: treat it as a plain path below.
    }
  }

  // A trailing separator means the value names a directory, not a file.
  if (/[\\/]$/.test(candidate)) return '';

  const segment = candidate.split(/[\\/]/).pop() ?? '';
  const stem = sanitizeStem(stripPdfExtension(safeDecode(segment)));
  return isUsableStem(stem) ? stem : '';
}

function localStem(pdfPath: string | null): string {
  const segment = pdfPath?.split(/[\\/]/).pop() ?? '';
  const stem = sanitizeStem(stripPdfExtension(safeDecode(segment)));
  return isUsableStem(stem) ? stem : 'document';
}

/**
 * Filename stem derived from a source URL's last path segment. Query and hash
 * are not part of `pathname`, so they never end up in the name. Returns null
 * when the URL is unusable (unparseable, no file segment, broken escaping) so
 * callers can fall back to the local path.
 */
function urlStem(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;

  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    return null;
  }

  const segment = pathname.split('/').filter(Boolean).pop();
  // A trailing slash means the last segment is a directory, not a file name.
  if (!segment || pathname.endsWith('/')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }

  const stem = sanitizeStem(stripPdfExtension(decoded));
  return isUsableStem(stem) ? stem : null;
}

/**
 * Stem from the display name the opening bridge reported, or null.
 *
 * Deliberately not percent-decoded: the bridge (web server, desktop main) has
 * already decoded its upload/path name, so a literal `%20` in a real file name
 * must stay literal instead of turning into a space.
 */
function documentNameStem(documentName: string | null | undefined): string | null {
  if (!documentName) return null;
  const stem = sanitizeStem(stripPdfExtension(documentName));
  return isUsableStem(stem) ? stem : null;
}

/**
 * Build the suggested export filename.
 *
 * Precedence: the source URL (what the user typed/pasted), then the display
 * name reported by the bridge (the original upload name on the web, the file
 * basename on the desktop), then the local path's last segment. Both the URL
 * and the local path are decoded, so `%E6%B5%8B...`/`%20` never leak into a
 * download name.
 */
export function suggestFilename(
  pdfPath: string | null,
  scope: 'page' | 'document',
  page: number,
  ext: 'json' | 'csv',
  sourceUrl?: string | null,
  documentName?: string | null,
): string {
  const base = exportBaseStem(pdfPath, sourceUrl, documentName);
  return scope === 'page' ? `${base}-p${page}.${ext}` : `${base}-all.${ext}`;
}

/**
 * Filename stem shared by every export flavour.
 *
 * URL documents are downloaded to a temp file with a hash in its name, so the
 * source URL wins, then the display name the opening bridge reported, then the
 * local path's last segment.
 */
function exportBaseStem(
  pdfPath: string | null,
  sourceUrl?: string | null,
  documentName?: string | null,
): string {
  return urlStem(sourceUrl) ?? documentNameStem(documentName) ?? localStem(pdfPath);
}

/** Image formats the view exporter writes. */
export type ViewExportFormat = 'png' | 'svg';

/**
 * Suggested filename for a page/region image export.
 *
 * Uses the same stem precedence as `suggestFilename` (source URL, display name,
 * local path) and marks a cropped capture with `-region`. The default is the
 * current page, e.g. `report-p3.png` or `report-p3-region.svg`.
 */
export function suggestViewFilename(
  pdfPath: string | null,
  page: number,
  ext: ViewExportFormat,
  sourceUrl?: string | null,
  documentName?: string | null,
  region = false,
): string {
  const base = exportBaseStem(pdfPath, sourceUrl, documentName);
  return `${base}-p${page}${region ? '-region' : ''}.${ext}`;
}

/**
 * Suggested filename for the self-contained HTML inspection report.
 *
 * Uses the same stem precedence as the other exporters: `report-report.html`
 * for `/docs/report.pdf`, `测试 报告-report.html` for a Unicode display name.
 */
export function suggestReportFilename(
  pdfPath: string | null,
  sourceUrl?: string | null,
  documentName?: string | null,
): string {
  return `${exportBaseStem(pdfPath, sourceUrl, documentName)}-report.html`;
}

/** Export extensions the dialog recognises when the format radio changes. */
const EXPORT_NAME_EXTENSION = /\.(json|csv|png|svg)$/i;

/** Extension of a PDF or a previous export, replaced when appending the new one. */
const REPLACEABLE_EXTENSION = /\.(json|csv|png|svg|pdf)$/i;

/**
 * Extensions a report name replaces. The report is its own export flavour, so
 * its `.html` suffix must not stack on a previous report name.
 */
const REPORT_REPLACEABLE_EXTENSION = /\.(json|csv|png|svg|html|pdf)$/i;

/**
 * Validate/normalise a filename typed into an export dialog.
 *
 * Trims, drops directory components, replaces invalid/control characters with
 * `_`, strips leading/trailing dots and spaces and guarantees exactly one
 * trailing `.<ext>` (an existing export/PDF extension is replaced). Unicode is
 * preserved. Returns `''` when nothing usable remains (`___`, `...`, `/`), so
 * the caller can fall back to the generated suggestion.
 */
function normalizeExportFileName(
  name: string,
  ext: string,
  replaceable: RegExp = REPLACEABLE_EXTENSION,
): string {
  if (typeof name !== 'string') return '';

  const trimmed = name.trim();
  // A trailing separator means a directory was typed, not a file name.
  if (/[\\/]$/.test(trimmed)) return '';

  const base = trimmed.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(BIDI_CONTROL_CHARS, '')
    .replace(INVALID_FILENAME_CHARS, '_')
    .trim()
    .replace(/[.\s]+$/, '');

  const stem = stripExtension(cleaned, replaceable)
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!isUsableStem(stem)) return '';
  return `${stem}.${ext}`;
}

/** Normalise a JSON/CSV export name; see `normalizeExportFileName`. */
export function sanitizeExportFileName(name: string, ext: 'json' | 'csv'): string {
  return normalizeExportFileName(name, ext);
}

/** Normalise a PNG/SVG export name; see `normalizeExportFileName`. */
export function sanitizeViewFileName(name: string, ext: ViewExportFormat): string {
  return normalizeExportFileName(name, ext);
}

/** Normalise an HTML inspection-report name; see `normalizeExportFileName`. */
export function sanitizeReportFileName(name: string): string {
  return normalizeExportFileName(name, 'html', REPORT_REPLACEABLE_EXTENSION);
}

/** Strip a recognised trailing extension, if the name has one. */
function stripExtension(name: string, pattern: RegExp = REPLACEABLE_EXTENSION): string {
  return pattern.test(name) ? name.replace(pattern, '') : name;
}

/**
 * Swap the extension of a user-edited draft name when the format changes.
 *
 * Only a recognised export suffix is rewritten; a draft without an extension
 * (or with an unrelated one) is left alone and normalised on export.
 */
export function swapExportFormatExtension(
  name: string,
  ext: 'json' | 'csv' | ViewExportFormat,
): string {
  return EXPORT_NAME_EXTENSION.test(name) ? name.replace(EXPORT_NAME_EXTENSION, `.${ext}`) : name;
}
