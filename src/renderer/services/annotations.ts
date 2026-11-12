/**
 * Read-only annotation normalization for PDF.js annotations.
 *
 * `PDFPageProxy.getAnnotations()` is typed as `Array<any>`, so every field is
 * validated here before it reaches the UI. These helpers stay free of DOM and
 * React access so they can be unit tested directly.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { translate, type MessageKey, type TranslateFn } from '../i18n/translate';
import type {
  AnnotationForm,
  AnnotationKind,
  AnnotationLink,
  AnnotationOption,
  PdfAnnotation,
} from '../types/annotations';
import type { PageBox } from '../types/pdf-objects';
import { isSafeExternalUrl } from '../../shared/external-url';

/**
 * Re-exported so existing annotation consumers keep one import site.
 *
 * The implementation lives in `src/shared/external-url.ts` because the main
 * process and the browser adapter must apply the exact same policy before they
 * open a link.
 */
export { isSafeExternalUrl };

/** Every annotation kind, in the order used by filters and legends. */
export const ANNOTATION_KINDS: readonly AnnotationKind[] = [
  'link',
  'form',
  'markup',
  'note',
  'stamp',
  'other',
];

/** Short human labels for the kind filter and the detail view. */
export const ANNOTATION_KIND_LABELS: Record<AnnotationKind, string> = {
  link: 'Link',
  form: 'Form field',
  markup: 'Markup',
  note: 'Note',
  stamp: 'Stamp',
  other: 'Other',
};

/**
 * English translator for non-React callers (index search text, plain unit
 * tests). Components pass their `useT()` translator instead, so a locale switch
 * re-renders the labels without touching this module.
 */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

/** Message key per kind; the display label for a kind is localizable copy. */
const ANNOTATION_KIND_MESSAGE_KEYS: Record<AnnotationKind, MessageKey> = {
  link: 'annots.kind.link',
  form: 'annots.kind.form',
  markup: 'annots.kind.markup',
  note: 'annots.kind.note',
  stamp: 'annots.kind.stamp',
  other: 'annots.kind.other',
};

/** Subtypes rendered as a markup box (highlights, shapes, ink, redaction). */
const MARKUP_SUBTYPES = new Set([
  'highlight',
  'underline',
  'squiggly',
  'strikeout',
  'square',
  'circle',
  'line',
  'polyline',
  'polygon',
  'ink',
  'caret',
  'redact',
]);

/** ISO 32000-1 annotation flags (Table 165) that hide an annotation. */
const ANNOTATION_FLAG_HIDDEN = 1 << 1;
const ANNOTATION_FLAG_NOVIEW = 1 << 5;

/** C0 control characters and DEL; stripped from every display string. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** PDF date strings look like `D:YYYYMMDDHHmmSSOHH'mm'`. */
const PDF_DATE_PATTERN =
  /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+\-])?(\d{2})?'?(\d{2})?'?/;

type UnknownRecord = Record<string, unknown>;

/** Map a raw PDF.js subtype onto a display kind. */
export function annotationKind(subtype: string): AnnotationKind {
  const key = subtype.trim().toLowerCase();
  switch (key) {
    case 'link':
      return 'link';
    case 'widget':
      return 'form';
    case 'text':
    case 'freetext':
      return 'note';
    case 'stamp':
      return 'stamp';
    default:
      return MARKUP_SUBTYPES.has(key) ? 'markup' : 'other';
  }
}

/**
 * Display label of a kind. The label is UI copy, so components pass their
 * translator; the English default keeps `annotationSearchText` and plain unit
 * tests locale-independent.
 */
export function annotationKindLabel(
  kind: AnnotationKind,
  t: TranslateFn = defaultTranslate,
): string {
  return t(ANNOTATION_KIND_MESSAGE_KEYS[kind] ?? 'annots.kind.other');
}

/**
 * Display label for a raw subtype: `FreeText` becomes `Free Text`, unknown or
 * empty values fall back to `Unknown`.
 */
export function annotationSubtypeLabel(subtype: string): string {
  const cleaned = normalizeText(subtype);
  if (cleaned.length === 0) return 'Unknown';
  return cleaned.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Filter a loaded annotation list by kind and subtype. The subtype match is
 * case-insensitive; `'all'` (or a blank subtype) disables a filter. The
 * returned array is a new array of the same annotation objects.
 */
export function filterAnnotations(
  annotations: readonly PdfAnnotation[],
  kindFilter: 'all' | AnnotationKind,
  subtypeFilter: 'all' | string,
): PdfAnnotation[] {
  const subtypeNeedle =
    subtypeFilter === 'all' ? '' : subtypeFilter.trim().toLowerCase();

  return annotations.filter((annotation) => {
    if (kindFilter !== 'all' && annotation.kind !== kindFilter) return false;
    if (subtypeNeedle.length > 0) {
      return annotation.subtype.trim().toLowerCase() === subtypeNeedle;
    }
    return true;
  });
}

/** Display a form value: arrays are joined with `, `, null becomes empty. */
export function formatAnnotationValue(value: string | string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

/**
 * Build the lower-cased haystack used by the Annots tab search box. It folds
 * the subtype, kind, title/contents, form field details and link target into
 * one string.
 *
 * The kind label is added with the English default on purpose: the haystack is
 * built once per document index, so making it depend on the active locale would
 * change search results after a language switch.
 */
export function annotationSearchText(annotation: PdfAnnotation): string {
  const parts: string[] = [
    String(annotation.page),
    annotation.subtype,
    annotation.kind,
    annotationKindLabel(annotation.kind),
  ];

  if (annotation.title !== null) parts.push(annotation.title);
  if (annotation.contents !== null) parts.push(annotation.contents);

  if (annotation.link !== null) {
    if (annotation.link.url !== null) parts.push(annotation.link.url);
    if (annotation.link.unsafeUrl !== null) parts.push(annotation.link.unsafeUrl);
    if (annotation.link.internalPage !== null) {
      parts.push(`page ${annotation.link.internalPage}`);
    }
  }

  if (annotation.form !== null) {
    if (annotation.form.fieldName !== null) parts.push(annotation.form.fieldName);
    if (annotation.form.fieldType !== null) parts.push(annotation.form.fieldType);
    parts.push(formatAnnotationValue(annotation.form.value));
    parts.push(formatAnnotationValue(annotation.form.defaultValue));
    for (const option of annotation.form.options) {
      parts.push(option.label, option.value);
    }
  }

  return normalizeText(parts.filter((part) => part.length > 0).join(' ')).toLowerCase();
}

/**
 * Normalize one raw PDF.js annotation.
 *
 * Geometry is converted to MediaBox-relative, unrotated PDF points. Invalid
 * geometry (`rect: null`) keeps the annotation in the list so its text and form
 * data stay inspectable. Returns null only when the raw value is not an object.
 */
export function normalizeAnnotation(
  raw: unknown,
  page: number,
  mediaOrigin: { x: number; y: number },
  internalPage: number | null,
): PdfAnnotation | null {
  const data = asRecord(raw);
  if (data === null) return null;

  const subtype = readRawString(data.subtype) ?? 'Unknown';
  const kind = annotationKind(subtype);
  const rect = normalizeRect(data.rect, normalizeOrigin(mediaOrigin));
  const resolvedInternalPage = kind === 'link' ? normalizePageNumber(internalPage) : null;

  return {
    id: annotationId(data, page, subtype, rect),
    page,
    subtype,
    kind,
    rect,
    title: readAnnotationText(data.titleObj, data.title),
    contents: readAnnotationText(data.contentsObj, data.contents),
    modificationDate: normalizeModificationDate(data.modificationDate),
    color: normalizeColor(data.color),
    opacity: readOpacity(data.opacity),
    hidden: isHidden(data),
    link: kind === 'link' ? normalizeLink(data, resolvedInternalPage) : null,
    form: kind === 'form' ? normalizeForm(data) : null,
  };
}

/**
 * Resolve a PDF.js destination (named string or explicit array) to a 1-based
 * page number. Any failure — unknown name, bad reference, missing page — is
 * reported as null so callers can keep the target display-only.
 */
export async function resolveDestinationPage(
  pdfDoc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  if (dest === null || dest === undefined) return null;

  try {
    let pageIndex: number;
    if (typeof dest === 'string') {
      const name = dest.trim();
      if (name.length === 0) return null;
      const explicitDest = await pdfDoc.getDestination(name);
      if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null;
      pageIndex = await pdfDoc.getPageIndex(
        explicitDest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
    } else if (Array.isArray(dest)) {
      if (dest.length === 0) return null;
      pageIndex = await pdfDoc.getPageIndex(
        dest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
    } else {
      return null;
    }

    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    return pageIndex + 1;
  } catch {
    return null;
  }
}

/** One cache entry per document; the WeakMap key is collected with the doc. */
const pageAnnotationCache = new WeakMap<
  PDFDocumentProxy,
  Map<string, Promise<PdfAnnotation[]>>
>();

/**
 * Cache key for one page at one MediaBox origin.
 *
 * The normalized rect depends on the origin, so two readers of the same page
 * with different origins (the sidecar MediaBox for the current page, the
 * PDF.js `page.view` for the whole-document index) must never share an entry.
 */
function pageCacheKey(page: number, origin: { x: number; y: number }): string {
  return `${page}:${origin.x}:${origin.y}`;
}

/**
 * Load and normalize the annotations of one page.
 *
 * Popup annotations (whose text lives on the parent) are filtered out; hidden
 * annotations stay in the list with `hidden: true`. Results are cached per
 * document, page and normalized MediaBox origin, and every call returns fresh
 * copies so callers can never mutate the cached data. A rejected load is
 * dropped from the cache so the next call retries.
 */
export async function loadPageAnnotations(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  mediaOrigin: { x: number; y: number },
): Promise<PdfAnnotation[]> {
  const page = normalizePageIndex(pageNumber);
  if (page === null) return [];

  return loadPageWithCache(pdfDoc, page, normalizeOrigin(mediaOrigin));
}

/**
 * Index-time loader: read the page's own PDF.js view origin and normalize the
 * annotations against it.
 *
 * `page.view` is `[x0, y0, x1, y1]` and is the frame PDF.js reports annotation
 * rects in, so it is the only correct origin for a page the UI never activated.
 * The `PDFPageProxy` is used for this one call and never cached; only the
 * normalized `PdfAnnotation[]` is retained.
 */
export async function loadPageAnnotationsForIndex(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
): Promise<PdfAnnotation[]> {
  const page = normalizePageIndex(pageNumber);
  if (page === null) return [];

  const pdfPage = await pdfDoc.getPage(page);
  return loadPageWithCache(pdfDoc, page, pageViewOrigin(pdfPage), pdfPage);
}

/** An exact origin is part of the cache key, so it must be finite and stable. */
function pageViewOrigin(pdfPage: PDFPageProxy): { x: number; y: number } {
  const view = readArrayLike((pdfPage as { view?: unknown } | null)?.view);
  if (view === null || view.length < 2) return { x: 0, y: 0 };

  const [x0, y0] = view;
  if (!isFiniteNumber(x0) || !isFiniteNumber(y0)) return { x: 0, y: 0 };
  return { x: x0, y: y0 };
}

function normalizePageIndex(pageNumber: number): number | null {
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
  return Math.floor(pageNumber);
}

async function loadPageWithCache(
  pdfDoc: PDFDocumentProxy,
  page: number,
  origin: { x: number; y: number },
  providedPage?: PDFPageProxy,
): Promise<PdfAnnotation[]> {
  const cache = getPageCache(pdfDoc);
  const key = pageCacheKey(page, origin);
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = fetchPageAnnotations(pdfDoc, page, origin, providedPage);
    cache.set(key, pending);
    // Never cache a failed load: `pending` still rejects for the caller, but the
    // derived handler keeps the rejection observed and clears the entry.
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  }

  const annotations = await pending;
  return cloneAnnotations(annotations);
}

function getPageCache(pdfDoc: PDFDocumentProxy): Map<string, Promise<PdfAnnotation[]>> {
  let cache = pageAnnotationCache.get(pdfDoc);
  if (cache === undefined) {
    cache = new Map();
    pageAnnotationCache.set(pdfDoc, cache);
  }
  return cache;
}

async function fetchPageAnnotations(
  pdfDoc: PDFDocumentProxy,
  page: number,
  mediaOrigin: { x: number; y: number },
  providedPage?: PDFPageProxy,
): Promise<PdfAnnotation[]> {
  const pdfPage = providedPage ?? (await pdfDoc.getPage(page));
  const rawAnnotations = (await pdfPage.getAnnotations({ intent: 'display' })) as unknown[];
  const annotations: PdfAnnotation[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawAnnotations) {
    const data = asRecord(raw);
    if (data === null) continue;

    const subtype = readRawString(data.subtype) ?? 'Unknown';
    // Popup annotations duplicate the parent's text and are never listed.
    if (subtype.toLowerCase() === 'popup') continue;

    const internalPage =
      annotationKind(subtype) === 'link' && data.dest !== null && data.dest !== undefined
        ? await resolveDestinationPage(pdfDoc, data.dest)
        : null;

    const annotation = normalizeAnnotation(raw, page, mediaOrigin, internalPage);
    if (annotation === null) continue;

    annotation.id = uniqueId(annotation.id, seenIds);
    seenIds.add(annotation.id);
    annotations.push(annotation);
  }

  return annotations;
}

function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) return base;
  let suffix = 2;
  while (seen.has(`${base}#${suffix}`)) suffix += 1;
  return `${base}#${suffix}`;
}

function cloneAnnotations(annotations: readonly PdfAnnotation[]): PdfAnnotation[] {
  return annotations.map(cloneAnnotation);
}

function cloneAnnotation(annotation: PdfAnnotation): PdfAnnotation {
  return {
    ...annotation,
    rect: annotation.rect === null ? null : { ...annotation.rect },
    link: annotation.link === null ? null : { ...annotation.link },
    form:
      annotation.form === null
        ? null
        : {
            ...annotation.form,
            value: cloneFormValue(annotation.form.value),
            defaultValue: cloneFormValue(annotation.form.defaultValue),
            options: annotation.form.options.map((option) => ({ ...option })),
          },
  };
}

function cloneFormValue(value: string | string[] | null): string | string[] | null {
  return Array.isArray(value) ? [...value] : value;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

/** Strip control characters and collapse whitespace into single spaces. */
function normalizeText(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Read a display string, turning control characters into single spaces. */
function readDisplayString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = normalizeText(value);
  return cleaned.length > 0 ? cleaned : null;
}

/** Read a display string, dropping control characters and surrounding space. */
function readRawString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function readAnnotationText(value: unknown, fallback: unknown): string | null {
  const record = asRecord(value);
  const primary = record === null ? null : readDisplayString(record.str);
  return primary === null ? readDisplayString(fallback) : primary;
}

function readArrayLike(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOrigin(mediaOrigin: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Number.isFinite(mediaOrigin?.x) ? mediaOrigin.x : 0,
    y: Number.isFinite(mediaOrigin?.y) ? mediaOrigin.y : 0,
  };
}

function normalizeRect(
  value: unknown,
  origin: { x: number; y: number },
): PageBox | null {
  const values = readArrayLike(value);
  if (values === null || values.length !== 4) return null;

  const [x0, y0, x1, y1] = values;
  if (!isFiniteNumber(x0) || !isFiniteNumber(y0) || !isFiniteNumber(x1) || !isFiniteNumber(y1)) {
    return null;
  }
  if (x0 > x1 || y0 > y1) return null;

  return {
    x0: x0 - origin.x,
    y0: y0 - origin.y,
    x1: x1 - origin.x,
    y1: y1 - origin.y,
  };
}

function normalizePageNumber(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function annotationId(
  data: UnknownRecord,
  page: number,
  subtype: string,
  rect: PageBox | null,
): string {
  const rawId = readRawString(data.id) ?? readRawString(data.annotationId);
  if (rawId !== null) return `${page}:${rawId}`;

  const geometry =
    rect === null ? 'no-rect' : `${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
  return `${page}:${subtype.toLowerCase()}:${geometry}`;
}

function normalizeLink(data: UnknownRecord, internalPage: number | null): AnnotationLink {
  const unsafeUrl = readRawString(data.unsafeUrl) ?? readRawString(data.url);
  const url = readRawString(data.url);

  return {
    url: isSafeExternalUrl(url) ? url?.trim() ?? null : null,
    unsafeUrl,
    internalPage,
    newWindow: data.newWindow === true,
  };
}

function normalizeForm(data: UnknownRecord): AnnotationForm {
  return {
    fieldName: readRawString(data.fieldName),
    fieldType: readRawString(data.fieldType),
    value: readFormValue(data.fieldValue),
    defaultValue: readFormValue(data.defaultFieldValue),
    readOnly: data.readOnly === true,
    required: data.required === true,
    checkBox: data.checkBox === true,
    radioButton: data.radioButton === true,
    pushButton: data.pushButton === true,
    multiLine: data.multiLine === true,
    combo: data.combo === true,
    options: readOptions(data.options),
  };
}

function readFormValue(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : null;
}

function readOptions(value: unknown): AnnotationOption[] {
  if (!Array.isArray(value)) return [];

  const options: AnnotationOption[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;

    const label = readRawString(record.displayValue) ?? readRawString(record.exportValue);
    const exportValue = readRawString(record.exportValue) ?? label;
    if (label === null || exportValue === null) continue;

    options.push({ label, value: exportValue });
  }
  return options;
}

function readOpacity(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** Convert a PDF.js annotation colour into `#rrggbb`. */
function normalizeColor(value: unknown): string | null {
  const values = readArrayLike(value);
  if (values === null || values.length !== 3) return null;

  const [r, g, b] = values;
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) return null;

  // PDF.js serializes `/C` through `getRgbColor`, which returns a 0–255
  // Uint8ClampedArray (grey/CMYK are expanded to three channels). Plain arrays
  // keep 0–1 semantics unless a channel proves the array is byte-based.
  const isByteColor = ArrayBuffer.isView(value) || r > 1 || g > 1 || b > 1;
  const channel = (input: number): string => {
    const unit = isByteColor ? input / 255 : input;
    const clamped = Math.min(1, Math.max(0, unit));
    return Math.round(clamped * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function isHidden(data: UnknownRecord): boolean {
  if (data.hidden === true) return true;

  const flags = data.annotationFlags;
  if (!isFiniteNumber(flags)) return false;
  return (flags & ANNOTATION_FLAG_HIDDEN) !== 0 || (flags & ANNOTATION_FLAG_NOVIEW) !== 0;
}

/** ISO 8601 when the timestamp is parseable, otherwise the trimmed raw value. */
function normalizeModificationDate(value: unknown): string | null {
  const raw = readRawString(value);
  if (raw === null) return null;

  const iso = pdfDateToIso(raw) ?? parseIsoDate(raw);
  return iso ?? raw;
}

function parseIsoDate(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pdfDateToIso(value: string): string | null {
  const match = PDF_DATE_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = readDatePart(match[2], 1, 12, 1);
  const day = readDatePart(match[3], 1, 31, 1);
  const hour = readDatePart(match[4], 0, 23, 0);
  const minute = readDatePart(match[5], 0, 59, 0);
  const second = readDatePart(match[6], 0, 59, 0);

  const relation = match[7] ?? 'Z';
  const offsetHour = readDatePart(match[8], 0, 23, 0);
  const offsetMinute = readDatePart(match[9], 0, 59, 0);

  let utcHour = hour;
  let utcMinute = minute;
  if (relation === '+') {
    utcHour -= offsetHour;
    utcMinute -= offsetMinute;
  } else if (relation === '-') {
    utcHour += offsetHour;
    utcMinute += offsetMinute;
  }

  return new Date(Date.UTC(year, month - 1, day, utcHour, utcMinute, second)).toISOString();
}

function readDatePart(
  part: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (part === undefined) return fallback;
  const value = Number(part);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
