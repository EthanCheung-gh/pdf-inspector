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

function localStem(pdfPath: string | null): string {
  return (pdfPath?.split(/[\\/]/).pop() ?? 'document').replace(/\.pdf$/i, '');
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

  const stem = decoded.replace(/[\\/]/g, '_').replace(/\.pdf$/i, '').trim();
  return stem.length > 0 ? stem : null;
}

export function suggestFilename(
  pdfPath: string | null,
  scope: 'page' | 'document',
  page: number,
  ext: 'json' | 'csv',
  sourceUrl?: string | null,
): string {
  // URL documents are downloaded to a temp file with a hash in its name, so
  // prefer the name the user recognises from the URL they opened.
  const base = urlStem(sourceUrl) ?? localStem(pdfPath);
  return scope === 'page' ? `${base}-p${page}.${ext}` : `${base}-all.${ext}`;
}
