/**
 * Whole-document annotation index.
 *
 * The Annots tab can only read one page at a time through `usePageAnnotations`;
 * this service walks the whole document in small batches, normalizes every page
 * with the cached page loader and derives the summary, link and form health
 * information once. It is read-only and never performs network requests: link
 * targets are classified, never fetched.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfAnnotation } from '../types/annotations';
import { loadPageAnnotationsForIndex } from './annotations';

/**
 * Pages per index batch. Small enough that the renderer can repaint — and
 * honour a cancel request — between batches on a 1000-page document.
 */
export const ANNOTATION_INDEX_BATCH_SIZE = 10;

/**
 * One row of the document index. It is the normalized annotation itself; the
 * index never introduces a second field model for the same data.
 */
export type AnnotationIndexEntry = PdfAnnotation;

/** A link annotation that needs attention (or is listed as information). */
export interface AnnotationLinkIssue {
  annotationId: string;
  page: number;
  subtype: string;
  kind: 'unresolved' | 'unsafe' | 'external';
  /** Display target: `url`/`unsafeUrl`, or null when the link has no target. */
  target: string | null;
  message: string;
}

/** A form-field grouping problem or cross-page notice. */
export interface AnnotationFormIssue {
  /**
   * Widget id for an `unnamed` issue — one issue per widget, so two nameless
   * widgets are two addressable rows. Null for a grouped field issue, which
   * describes a field name rather than a single widget.
   */
  annotationId: string | null;
  /** Null for unnamed widgets. */
  fieldName: string | null;
  pages: number[];
  fieldTypes: string[];
  widgetCount: number;
  kind: 'unnamed' | 'conflicting-type' | 'duplicate-name';
  message: string;
}

/** One unique, named form field merged across all of its widgets. */
export interface AnnotationFormField {
  name: string;
  /** First field type seen for the name; null when PDF.js reported none. */
  fieldType: string | null;
  /** Ascending unique 1-based pages carrying the field. */
  pages: number[];
  widgetCount: number;
  required: boolean;
  readOnly: boolean;
  /** Unique non-empty values collected from every widget, in encounter order. */
  values: string[];
}

/** Document-wide counts; computed once while the index is built. */
export interface AnnotationIndexSummary {
  annotations: number;
  pagesWithAnnotations: number;
  links: number;
  /** Form widgets (raw form annotations), not unique field names. */
  forms: number;
  markup: number;
  notes: number;
  stamps: number;
  other: number;
  hidden: number;
  unresolvedLinks: number;
  unsafeLinks: number;
  /** Unique named form fields. */
  formFields: number;
}

export interface AnnotationIndexResult {
  annotations: AnnotationIndexEntry[];
  summary: AnnotationIndexSummary;
  linkIssues: AnnotationLinkIssue[];
  formIssues: AnnotationFormIssue[];
  /** Unique named form fields, in first-encounter order. */
  formFields: AnnotationFormField[];
  /** Pages actually read; equals the document total on success. */
  scannedPages: number;
  /** Reserved for a future paged index; this build always reads every page. */
  truncated: false;
}

export interface BuildAnnotationIndexOptions {
  batchSize?: number;
  /** Called with (0, total) up front and after every scanned page. */
  onProgress?: (done: number, total: number) => void;
  /** Polled before each page and each batch; a cancelled run returns null. */
  isCancelled?: () => boolean;
}

/** Absolute URL scheme prefix, e.g. `javascript:` or `https:`. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Build the document-wide annotation index.
 *
 * Pages are read sequentially in batches of `batchSize` (default 10) with an
 * event-loop yield between batches, so a large document keeps the UI
 * responsive. Returns `null` when the caller cancels; a cancelled or failed run
 * never publishes partial data. An unreadable page aborts the whole index with
 * an error naming the page — the caller owns retry/error display.
 */
export async function buildAnnotationIndex(
  pdfDoc: PDFDocumentProxy,
  pageCount: number,
  options: BuildAnnotationIndexOptions = {},
): Promise<AnnotationIndexResult | null> {
  const total = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0;
  const batchSize = normalizeBatchSize(options.batchSize);
  const { onProgress, isCancelled } = options;

  onProgress?.(0, total);
  if (total === 0) return emptyResult();
  if (isCancelled?.()) return null;

  const annotations: AnnotationIndexEntry[] = [];
  let scannedPages = 0;

  for (let start = 1; start <= total; start += batchSize) {
    if (isCancelled?.()) return null;

    const end = Math.min(start + batchSize - 1, total);
    for (let page = start; page <= end; page += 1) {
      if (isCancelled?.()) return null;

      const pageAnnotations = await loadIndexedPage(pdfDoc, page);
      for (const annotation of pageAnnotations) annotations.push(annotation);

      scannedPages = page;
      onProgress?.(page, total);
    }

    // Yield between batches only: the last batch needs no extra turn before the
    // (synchronous) summary pass runs.
    if (end < total) await yieldToEventLoop();
  }

  // Pages are read in order, so this only guards against a page loader that
  // ever returns out-of-order rows; the sort stays stable within a page.
  annotations.sort((left, right) => left.page - right.page);

  const { linkIssues, formIssues, formFields } = inspectAnnotations(annotations);

  return {
    annotations,
    summary: summarize(annotations, linkIssues, formFields),
    linkIssues,
    formIssues,
    formFields,
    scannedPages,
    truncated: false,
  };
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined || !Number.isFinite(batchSize) || batchSize <= 0) {
    return ANNOTATION_INDEX_BATCH_SIZE;
  }
  return Math.max(1, Math.floor(batchSize));
}

async function loadIndexedPage(
  pdfDoc: PDFDocumentProxy,
  page: number,
): Promise<PdfAnnotation[]> {
  try {
    return await loadPageAnnotationsForIndex(pdfDoc, page);
  } catch (error) {
    throw new Error(
      `Annotation index failed on page ${page}: ${describeError(error)}`,
      { cause: error },
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A macrotask turn, so the renderer can repaint between batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function emptyResult(): AnnotationIndexResult {
  return {
    annotations: [],
    summary: emptySummary(),
    linkIssues: [],
    formIssues: [],
    formFields: [],
    scannedPages: 0,
    truncated: false,
  };
}

function emptySummary(): AnnotationIndexSummary {
  return {
    annotations: 0,
    pagesWithAnnotations: 0,
    links: 0,
    forms: 0,
    markup: 0,
    notes: 0,
    stamps: 0,
    other: 0,
    hidden: 0,
    unresolvedLinks: 0,
    unsafeLinks: 0,
    formFields: 0,
  };
}

function summarize(
  annotations: readonly AnnotationIndexEntry[],
  linkIssues: readonly AnnotationLinkIssue[],
  formFields: readonly AnnotationFormField[],
): AnnotationIndexSummary {
  const summary = emptySummary();
  const pages = new Set<number>();

  for (const annotation of annotations) {
    summary.annotations += 1;
    pages.add(annotation.page);
    if (annotation.hidden) summary.hidden += 1;

    switch (annotation.kind) {
      case 'link':
        summary.links += 1;
        break;
      case 'form':
        summary.forms += 1;
        break;
      case 'markup':
        summary.markup += 1;
        break;
      case 'note':
        summary.notes += 1;
        break;
      case 'stamp':
        summary.stamps += 1;
        break;
      default:
        summary.other += 1;
    }
  }

  summary.pagesWithAnnotations = pages.size;
  summary.unresolvedLinks = linkIssues.filter((issue) => issue.kind === 'unresolved').length;
  summary.unsafeLinks = linkIssues.filter((issue) => issue.kind === 'unsafe').length;
  summary.formFields = formFields.length;

  return summary;
}

interface InspectionResult {
  linkIssues: AnnotationLinkIssue[];
  formIssues: AnnotationFormIssue[];
  formFields: AnnotationFormField[];
}

function inspectAnnotations(annotations: readonly AnnotationIndexEntry[]): InspectionResult {
  const linkIssues: AnnotationLinkIssue[] = [];
  const formIssues: AnnotationFormIssue[] = [];
  const fields = new Map<string, FieldAccumulator>();

  for (const annotation of annotations) {
    if (annotation.link !== null) {
      const issue = inspectLink(annotation);
      if (issue !== null) linkIssues.push(issue);
      continue;
    }

    const form = annotation.form;
    if (form === null) continue;

    if (form.fieldName === null) {
      formIssues.push({
        annotationId: annotation.id,
        fieldName: null,
        pages: [annotation.page],
        fieldTypes: form.fieldType === null ? [] : [form.fieldType],
        widgetCount: 1,
        kind: 'unnamed',
        message: 'Form widget has no field name',
      });
      continue;
    }

    accumulateField(fields, form.fieldName, annotation, form);
  }

  const formFields = Array.from(fields.values()).map(toFormField);
  for (const field of formFields) {
    const fieldTypes = fieldTypesOf(fields.get(field.name));

    // A name spread over several pages is normal in PDF forms, so it is
    // reported as information only.
    if (field.pages.length > 1) {
      formIssues.push({
        annotationId: null,
        fieldName: field.name,
        pages: field.pages,
        fieldTypes,
        widgetCount: field.widgetCount,
        kind: 'duplicate-name',
        message: `Field "${field.name}" appears on ${field.pages.length} pages`,
      });
    }

    if (fieldTypes.length > 1) {
      formIssues.push({
        annotationId: null,
        fieldName: field.name,
        pages: field.pages,
        fieldTypes,
        widgetCount: field.widgetCount,
        kind: 'conflicting-type',
        message: `Field "${field.name}" uses conflicting types (${fieldTypes.join(', ')})`,
      });
    }
  }

  return { linkIssues, formIssues, formFields };
}

/**
 * Classify one link annotation.
 *
 * A sanitized http(s) URL is an informational `external` entry, a non-http(s)
 * raw target is `unsafe`, a resolved internal destination is fine, and anything
 * else is `unresolved`. No target is ever opened or requested here.
 */
function inspectLink(annotation: AnnotationIndexEntry): AnnotationLinkIssue | null {
  const link = annotation.link;
  if (link === null) return null;

  const base = {
    annotationId: annotation.id,
    page: annotation.page,
    subtype: annotation.subtype,
  };

  if (link.url !== null) {
    return {
      ...base,
      kind: 'external',
      target: link.url,
      message: `External link to ${link.url}`,
    };
  }

  if (link.unsafeUrl !== null && hasNonHttpScheme(link.unsafeUrl)) {
    return {
      ...base,
      kind: 'unsafe',
      target: link.unsafeUrl,
      message: `Link uses an unsafe target scheme: ${link.unsafeUrl}`,
    };
  }

  // A resolved in-document destination is the expected target for a link with
  // no external URL.
  if (link.internalPage !== null) return null;

  return {
    ...base,
    kind: 'unresolved',
    target: link.unsafeUrl,
    message: 'Link has no external URL and no resolved page',
  };
}

function hasNonHttpScheme(value: string): boolean {
  const match = URL_SCHEME.exec(value.trim());
  if (match === null) return false;
  const scheme = match[0].slice(0, -1).toLowerCase();
  return scheme !== 'http' && scheme !== 'https';
}

interface FieldAccumulator {
  name: string;
  fieldType: string | null;
  fieldTypes: string[];
  pages: number[];
  widgetCount: number;
  required: boolean;
  readOnly: boolean;
  values: string[];
}

function accumulateField(
  fields: Map<string, FieldAccumulator>,
  name: string,
  annotation: AnnotationIndexEntry,
  form: NonNullable<AnnotationIndexEntry['form']>,
): void {
  let field = fields.get(name);
  if (field === undefined) {
    field = {
      name,
      fieldType: form.fieldType,
      fieldTypes: [],
      pages: [],
      widgetCount: 0,
      required: false,
      readOnly: false,
      values: [],
    };
    fields.set(name, field);
  }

  field.widgetCount += 1;
  if (form.fieldType !== null) {
    if (field.fieldType === null) field.fieldType = form.fieldType;
    if (!field.fieldTypes.includes(form.fieldType)) field.fieldTypes.push(form.fieldType);
  }
  if (!field.pages.includes(annotation.page)) field.pages.push(annotation.page);
  if (form.required) field.required = true;
  if (form.readOnly) field.readOnly = true;

  for (const value of formValues(form.value)) {
    if (!field.values.includes(value)) field.values.push(value);
  }
}

function toFormField(field: FieldAccumulator): AnnotationFormField {
  return {
    name: field.name,
    fieldType: field.fieldType,
    pages: [...field.pages].sort((left, right) => left - right),
    widgetCount: field.widgetCount,
    required: field.required,
    readOnly: field.readOnly,
    values: [...field.values],
  };
}

function fieldTypesOf(field: FieldAccumulator | undefined): string[] {
  return field === undefined ? [] : [...field.fieldTypes].sort();
}

function formValues(value: string | string[] | null): string[] {
  if (value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry) => entry.length > 0);
}
