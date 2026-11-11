/**
 * JSON/CSV serialization of the whole-document annotation index.
 *
 * Both formats are pure functions over `AnnotationIndexResult`, so an export can
 * never trigger a second index pass and the dialog only has to pick a name. The
 * payload carries no disk paths: the document is identified by the display name
 * and the URL it was opened from, never by a local absolute path.
 */
import type { PdfAnnotation } from '../types/annotations';
import type { AnnotationIndexResult } from './annotation-index';
import { suggestFilename } from './export-data';

/** Export payload version; bumped when the JSON shape changes incompatibly. */
export const ANNOTATION_EXPORT_SCHEMA_VERSION = 1;

/**
 * Tool identity written into every JSON export.
 *
 * The version is a local constant on purpose: the renderer must not import
 * `package.json` (that would pull the whole manifest into the bundle).
 */
export const ANNOTATION_EXPORT_TOOL = {
  name: 'pdf-inspector',
  version: '0.2.0',
} as const;

/** Document identity of an export; deliberately path-free. */
export interface AnnotationExportDocument {
  /** Display name the opening bridge reported, or null. */
  name: string | null;
  /** URL the document was opened from, or null for a local file. */
  sourceUrl: string | null;
  /** Total pages of the document, including pages without annotations. */
  pages: number;
}

/** One page of the exported document; empty pages are omitted entirely. */
export interface AnnotationExportPage {
  page: number;
  annotations: PdfAnnotation[];
}

/** Link classification used by the CSV `status` column. */
export type AnnotationLinkStatus = 'external' | 'unsafe' | 'internal' | 'unresolved';

/** Absolute URL scheme prefix, e.g. `javascript:` or `https:`. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const BOM = '\uFEFF';

/** Exact CSV headers; the section order below is part of the export contract. */
export const ANNOTATION_CSV_HEADERS = {
  annotations: [
    'page',
    'subtype',
    'kind',
    'rect',
    'hidden',
    'title',
    'contents',
    'target',
    'field_name',
    'field_type',
    'value',
    'options',
  ],
  links: ['page', 'subtype', 'url', 'unsafe_url', 'internal_page', 'status'],
  formFields: ['name', 'field_type', 'pages', 'widget_count', 'required', 'read_only', 'values'],
} as const;

/**
 * Annotations grouped by page, ascending, with the annotations of a page in
 * their index order. Pages without annotations never appear, so the export does
 * not pad a 1000-page document with empty groups.
 */
export function groupAnnotationsByPage(
  annotations: readonly PdfAnnotation[],
): AnnotationExportPage[] {
  const byPage = new Map<number, PdfAnnotation[]>();
  for (const annotation of annotations) {
    const page = byPage.get(annotation.page);
    if (page === undefined) {
      byPage.set(annotation.page, [annotation]);
    } else {
      page.push(annotation);
    }
  }

  return Array.from(byPage.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([page, entries]) => ({ page, annotations: entries }));
}

/**
 * Classify a link annotation for the CSV `status` column.
 *
 * Mirrors the health check: a sanitized http(s) URL is `external`, a refused
 * non-http(s) target is `unsafe`, a resolved in-document destination is
 * `internal`, and anything else is `unresolved`. Nothing is fetched or opened.
 */
export function annotationLinkStatus(link: NonNullable<PdfAnnotation['link']>): AnnotationLinkStatus {
  if (link.url !== null) return 'external';

  if (link.unsafeUrl !== null && hasNonHttpScheme(link.unsafeUrl)) return 'unsafe';

  if (link.internalPage !== null) return 'internal';

  return 'unresolved';
}

function hasNonHttpScheme(value: string): boolean {
  const match = URL_SCHEME.exec(value.trim());
  if (match === null) return false;
  const scheme = match[0].slice(0, -1).toLowerCase();
  return scheme !== 'http' && scheme !== 'https';
}

/**
 * Whole-document JSON export.
 *
 * `pages` groups the annotations (ascending, empty pages omitted); the summary,
 * link/form issues and merged form fields come straight from the index so the
 * file matches what the Annots tab showed.
 */
export function annotationIndexToJson(
  result: AnnotationIndexResult,
  documentInfo: AnnotationExportDocument,
): string {
  return JSON.stringify(
    {
      schemaVersion: ANNOTATION_EXPORT_SCHEMA_VERSION,
      tool: { ...ANNOTATION_EXPORT_TOOL },
      exportedAt: new Date().toISOString(),
      document: {
        name: documentInfo.name,
        sourceUrl: documentInfo.sourceUrl,
        pages: documentInfo.pages,
      },
      summary: result.summary,
      pages: groupAnnotationsByPage(result.annotations),
      linkIssues: result.linkIssues,
      formIssues: result.formIssues,
      formFields: result.formFields,
    },
    null,
    2,
  );
}

/** RFC 4180 field escaping: quotes doubled, and `"`, `,`, newlines quoted. */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: readonly (string | number | boolean)[]): string {
  return values.map((value) => csvEscape(String(value))).join(',');
}

/** Arrays become one cell joined with `; `, keeping rects/options/values flat. */
function joinList(values: readonly string[]): string {
  return values.join('; ');
}

function formatRect(annotation: PdfAnnotation): string {
  const rect = annotation.rect;
  if (rect === null) return '';
  // One quoted field: the rectangle stays readable in a spreadsheet cell.
  return `${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
}

/** Display target of a link: the safe URL first, then the refused one. */
function linkTarget(annotation: PdfAnnotation): string {
  const link = annotation.link;
  if (link === null) return '';
  return link.url ?? link.unsafeUrl ?? '';
}

function formValueCell(annotation: PdfAnnotation): string {
  const value = annotation.form?.value;
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? joinList(value) : value;
}

function optionCell(annotation: PdfAnnotation): string {
  const options = annotation.form?.options ?? [];
  return joinList(options.map((option) => `${option.label}=${option.value}`));
}

function annotationCsvRow(annotation: PdfAnnotation): (string | number | boolean)[] {
  return [
    annotation.page,
    annotation.subtype,
    annotation.kind,
    formatRect(annotation),
    annotation.hidden,
    annotation.title ?? '',
    annotation.contents ?? '',
    linkTarget(annotation),
    annotation.form?.fieldName ?? '',
    annotation.form?.fieldType ?? '',
    formValueCell(annotation),
    optionCell(annotation),
  ];
}

/**
 * Whole-document CSV export: BOM plus three fixed sections.
 *
 * `# annotations` lists every annotation (link/form columns filled when they
 * apply), `# links` adds the derived status per link, and `# form_fields` lists
 * the merged unique fields. Sections are always present so a downstream reader
 * can rely on the headers even for an empty document.
 */
export function annotationIndexToCsv(result: AnnotationIndexResult): string {
  // Page order (ascending) is the same order the JSON export groups by.
  const annotations = groupAnnotationsByPage(result.annotations).flatMap(
    (group) => group.annotations,
  );

  const lines: string[] = [];

  lines.push('# annotations');
  lines.push(csvRow(ANNOTATION_CSV_HEADERS.annotations));
  for (const annotation of annotations) lines.push(csvRow(annotationCsvRow(annotation)));

  lines.push('# links');
  lines.push(csvRow(ANNOTATION_CSV_HEADERS.links));
  for (const annotation of annotations) {
    const link = annotation.link;
    if (link === null) continue;
    lines.push(
      csvRow([
        annotation.page,
        annotation.subtype,
        link.url ?? '',
        link.unsafeUrl ?? '',
        link.internalPage ?? '',
        annotationLinkStatus(link),
      ]),
    );
  }

  lines.push('# form_fields');
  lines.push(csvRow(ANNOTATION_CSV_HEADERS.formFields));
  for (const field of result.formFields) {
    lines.push(
      csvRow([
        field.name,
        field.fieldType ?? '',
        joinList(field.pages.map(String)),
        field.widgetCount,
        field.required,
        field.readOnly,
        joinList(field.values),
      ]),
    );
  }

  return `${BOM}${lines.join('\n')}\n`;
}

/**
 * Default export filename: the document suggestion with the `-all` scope suffix
 * replaced by `-annotations`, so an annotation export never overwrites the
 * object export of the same document.
 */
export function suggestAnnotationFilename(
  documentName: string | null,
  sourceUrl: string | null,
  filePath: string | null,
  ext: 'json' | 'csv',
): string {
  const fallback = `document-annotations.${ext}`;
  // `page` is unused for document scope; 1 keeps the shared helper's signature.
  const suggested = suggestFilename(filePath, 'document', 1, ext, sourceUrl, documentName);
  const suffix = `-all.${ext}`;

  if (!suggested.toLowerCase().endsWith(suffix)) return fallback;

  const stem = suggested.slice(0, suggested.length - suffix.length);
  return stem.length === 0 ? fallback : `${stem}-annotations.${ext}`;
}
