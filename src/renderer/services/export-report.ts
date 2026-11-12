/**
 * Self-contained HTML inspection report (work package K3).
 *
 * The report is a read-only snapshot meant to be attached to an email or a bug
 * report: one document, inline CSS, the current page as a PNG data URL and no
 * scripts, no external fonts and no external images/links. Everything dynamic
 * is escaped, so a document title or annotation that contains `<script>` can
 * never become markup.
 *
 * The builder is pure and DOM-free, which keeps it testable in Node and keeps
 * the file-saving concerns in the dialog that calls it.
 */
import type { AuditFinding, AuditReport } from '../../shared/audit-types';
import type { AnnotationFormIssue, AnnotationIndexResult, AnnotationLinkIssue } from './annotation-index';
import type { CapturedImage } from './export-capture';
import type { PdfAnnotation } from '../types/annotations';
import type { FontStat } from '../types/ipc-protocol';
import type { PageData, PdfMetadata } from '../types/pdf-objects';

/** Recommended longest screenshot side inside a report, in pixels. */
export const REPORT_MAX_IMAGE_SIDE = 2400;
/** Approximate maximum report size; exceeding it is reported instead of saved. */
export const REPORT_MAX_BYTES = 20_000_000;
/** Link/form issues rendered per table before a truncation note is added. */
export const REPORT_MAX_ISSUES = 100;
/** Audit findings rendered before a truncation note is added. */
export const REPORT_MAX_FINDINGS = 200;
/** Highest capture scale the report asks for. */
export const REPORT_MAX_CAPTURE_SCALE = 2;
/** Lowest capture scale; a page larger than the side cap cannot shrink further. */
export const REPORT_MIN_CAPTURE_SCALE = 1;
/** Report language used when the caller does not supply one. */
export const REPORT_DEFAULT_LANG = 'en';

export interface InspectionReportInput {
  documentName: string | null;
  sourceUrl: string | null;
  metadata: PdfMetadata | null;
  pageNumber: number;
  pageData: PageData;
  screenshot: CapturedImage;
  annotations: readonly PdfAnnotation[];
  annotationIndex: AnnotationIndexResult | null;
  auditReport: AuditReport | null;
  fontStats: readonly FontStat[] | null;
  generatedAt?: Date;
  /** BCP 47 language tag for the document; defaults to `en`. */
  lang?: string;
}

type Cell = string | number | null | undefined;

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Escape a value for both element content and attribute values.
 *
 * Quotes are escaped even in text: the same helper is used for attributes, and
 * an escaped quote in text is indistinguishable to a reader.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Capture scale that keeps the rendered page at or below
 * `REPORT_MAX_IMAGE_SIDE` on its longest side.
 *
 * The result is clamped to 1..2 (higher factors only bloat the embedded PNG)
 * and floored to two decimals so the pixel result stays under the cap. A page
 * that is already larger than the cap at 1x returns 1; the builder then adds a
 * size warning to the report instead of refusing to produce it.
 */
export function reportCaptureScale(
  pageData: Pick<PageData, 'width' | 'height' | 'rotation' | 'boxes'>,
): number {
  const media = pageData.boxes?.media ?? null;
  const mediaWidth = media ? media.x1 - media.x0 : 0;
  const mediaHeight = media ? media.y1 - media.y0 : 0;
  const hasMedia =
    Number.isFinite(mediaWidth) &&
    Number.isFinite(mediaHeight) &&
    mediaWidth > 0 &&
    mediaHeight > 0;
  let width = hasMedia ? mediaWidth : pageData.width;
  let height = hasMedia ? mediaHeight : pageData.height;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return REPORT_MIN_CAPTURE_SCALE;
  }

  const rotation = normalizeRotation(pageData.rotation ?? 0);
  if (rotation === 90 || rotation === 270) {
    const swapped = width;
    width = height;
    height = swapped;
  }

  const limit = REPORT_MAX_IMAGE_SIDE / Math.max(width, height);
  if (!Number.isFinite(limit) || limit <= REPORT_MIN_CAPTURE_SCALE) {
    return REPORT_MIN_CAPTURE_SCALE;
  }

  const scale = Math.min(REPORT_MAX_CAPTURE_SCALE, limit);
  return Math.max(REPORT_MIN_CAPTURE_SCALE, Math.floor(scale * 100) / 100);
}

/**
 * Reject an oversized report with a readable message.
 *
 * `html.length` approximates the UTF-8 byte size (a non-ASCII character takes
 * two or more bytes), which is deliberate: the cap is a safety net, not an
 * exact file-size promise. Exported so the cap can be tested cheaply without
 * allocating a 20 MB string.
 */
export function assertReportSize(html: string, maxBytes: number = REPORT_MAX_BYTES): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  if (html.length <= maxBytes) return;

  throw new Error(
    `Report is too large (${formatBytes(html.length)} > ${formatBytes(maxBytes)}); ` +
      'reduce the screenshot size or omit optional analysis.',
  );
}

/**
 * Build the complete, self-contained HTML report.
 *
 * Throws when the screenshot is not a base64 PNG data URL or when the finished
 * document exceeds `REPORT_MAX_BYTES`; everything else missing merely degrades
 * to a note in the report.
 */
export function buildInspectionReport(input: InspectionReportInput): string {
  const lang = normalizeLang(input.lang);
  const generatedAt = input.generatedAt ?? new Date();
  const timestamp = formatTimestamp(generatedAt);
  const pageNumber = normalizePageNumber(input.pageNumber);
  const displayName = cleanText(input.documentName) ?? 'Untitled document';
  const pageData = input.pageData;
  const screenshot = input.screenshot;
  const pngDataUrl = requirePngDataUrl(screenshot.pngDataUrl);
  const imageWidth = positiveDimension(screenshot.width);
  const imageHeight = positiveDimension(screenshot.height);

  const lines: string[] = [];
  lines.push('<!doctype html>');
  lines.push(`<html lang="${escapeHtml(lang)}">`);
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push('<meta name="generator" content="PDF Inspector">');
  lines.push(
    '<meta http-equiv="Content-Security-Policy" ' +
      'content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">',
  );
  lines.push(`<title>Inspection report — ${escapeHtml(displayName)}</title>`);
  lines.push('<style>');
  lines.push(REPORT_STYLES);
  lines.push('</style>');
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<main>');

  lines.push('<header class="report-header">');
  lines.push(`<h1>${escapeHtml(displayName)}</h1>`);
  lines.push(
    `<p class="meta">Inspection report · generated ` +
      `<time datetime="${escapeHtml(timestamp.iso)}">${escapeHtml(timestamp.readable)}</time></p>`,
  );
  if (isHttpUrl(input.sourceUrl)) {
    lines.push(`<p class="meta">Source: ${escapeHtml(input.sourceUrl)}</p>`);
  }
  lines.push('</header>');

  lines.push(buildSummarySection(input, pageNumber, displayName));
  lines.push(buildSnapshotSection(screenshot, pngDataUrl, imageWidth, imageHeight, pageNumber));
  lines.push(buildCompositionSection(pageData));
  lines.push(buildFontsSection(input.fontStats));
  lines.push(buildAnnotationsSection(input.annotations, input.annotationIndex));
  lines.push(buildAuditSection(input.auditReport));

  lines.push(
    '<footer class="disclaimer">' +
      'Read-only snapshot: this report contains no scripts and no external resources. ' +
      'It is not a PDF/A conformance or accessibility certification.' +
      '</footer>',
  );

  lines.push('</main>');
  lines.push('</body>');
  lines.push('</html>');

  const html = lines.join('\n');
  assertReportSize(html);
  return html;
}

function buildSummarySection(
  input: InspectionReportInput,
  pageNumber: number,
  displayName: string,
): string {
  const metadata = input.metadata;
  const pageData = input.pageData;
  const pageCount = metadata && Number.isFinite(metadata.pages) ? metadata.pages : 'Unknown';
  const version = metadata && cleanText(metadata.version) ? metadata.version : 'Unknown';
  const encrypted = metadata === null ? 'Unknown' : metadata.encrypted ? 'Yes' : 'No';

  const body = cards([
    ['Document', displayName],
    ['Pages', pageCount],
    ['Current page', pageNumber],
    ['Page size', `${formatNumber(pageData.width)} × ${formatNumber(pageData.height)} pt`],
    ['Rotation', `${formatNumber(normalizeRotation(pageData.rotation ?? 0))}°`],
    ['PDF version', version],
    ['Encrypted', encrypted],
    ['Metadata title', cleanText(metadata?.title) ?? 'Not set'],
    ['Author', cleanText(metadata?.author) ?? 'Not set'],
    ['Producer', cleanText(metadata?.producer) ?? 'Not set'],
  ]);

  return section('Document summary', body);
}

function buildSnapshotSection(
  screenshot: CapturedImage,
  pngDataUrl: string,
  imageWidth: number,
  imageHeight: number,
  pageNumber: number,
): string {
  const appliedScale = Number.isFinite(screenshot.appliedScale)
    ? screenshot.appliedScale
    : REPORT_MIN_CAPTURE_SCALE;

  const body: string[] = [];
  body.push('<figure class="snapshot">');
  body.push(
    `<img src="${escapeHtml(pngDataUrl)}" width="${imageWidth}" height="${imageHeight}" ` +
      `alt="Page ${pageNumber} inspection snapshot">`,
  );
  body.push(
    `<figcaption>Page ${pageNumber} · ${imageWidth} × ${imageHeight} px · ` +
      `${escapeHtml(formatNumber(appliedScale))}× scale</figcaption>`,
  );
  body.push('</figure>');

  const warnings = [...screenshot.warnings];
  if (Math.max(imageWidth, imageHeight) > REPORT_MAX_IMAGE_SIDE) {
    warnings.push(
      `Screenshot is ${imageWidth} × ${imageHeight} px; the recommended maximum ` +
        `side is ${REPORT_MAX_IMAGE_SIDE} px.`,
    );
  }

  if (warnings.length > 0) {
    body.push('<div class="warnings">');
    body.push('<strong>Warnings</strong>');
    body.push('<ul>');
    for (const warning of warnings) body.push(`<li>${escapeHtml(warning)}</li>`);
    body.push('</ul>');
    body.push('</div>');
  }

  return section('Page snapshot', body.join('\n'));
}

function buildCompositionSection(pageData: PageData): string {
  const counts: Array<[string, number]> = [
    ['Chars', countOf(pageData.chars)],
    ['Words', countOf(pageData.words)],
    ['Rects', countOf(pageData.rects)],
    ['Lines', countOf(pageData.lines)],
    ['Curves', countOf(pageData.curves)],
    ['Images', countOf(pageData.images)],
    ['Tables', countOf(pageData.tables)],
  ];

  const objectTable = table(
    ['Object type', 'Count'],
    counts.map(([label, count]) => [label, count]),
    'No page composition data.',
  );

  const parts = [objectTable];
  const boxes = pageData.boxes;
  if (boxes) {
    const rows: Cell[][] = [];
    for (const key of ['media', 'crop', 'trim', 'bleed', 'art'] as const) {
      const box = boxes[key];
      if (!box) continue;
      rows.push([
        boxLabel(key),
        `${formatNumber(box.x0)}, ${formatNumber(box.y0)} → ` +
          `${formatNumber(box.x1)}, ${formatNumber(box.y1)}`,
        `${formatNumber(box.x1 - box.x0)} × ${formatNumber(box.y1 - box.y0)} pt`,
      ]);
    }

    parts.push('<h3>Page boxes</h3>');
    parts.push(table(['Box', 'Coordinates', 'Size'], rows, 'No page boxes reported.'));
  }

  return section('Page composition', parts.join('\n'));
}

function buildFontsSection(fontStats: readonly FontStat[] | null): string {
  if (fontStats === null) {
    return section('Fonts', '<p class="empty">Font analysis not available.</p>');
  }
  if (fontStats.length === 0) {
    return section('Fonts', '<p class="empty">No fonts were reported for this document.</p>');
  }

  const rows: Cell[][] = fontStats.map((stat) => [
    stat.fontname,
    stat.pages.length,
    formatPageList(stat.pages),
    stat.charCount,
    `${formatNumber(stat.sizeMin)}–${formatNumber(stat.sizeMax)} pt`,
    formatColorList(stat.colors),
  ]);

  return section(
    'Fonts',
    table(['Font', 'Pages', 'Page list', 'Chars', 'Size range', 'Colors'], rows),
  );
}

function buildAnnotationsSection(
  annotations: readonly PdfAnnotation[],
  annotationIndex: AnnotationIndexResult | null,
): string {
  const parts: string[] = [];
  parts.push(
    `<p class="meta">Current page: ${annotations.length} annotation` +
      `${annotations.length === 1 ? '' : 's'}.</p>`,
  );

  if (annotationIndex === null) {
    parts.push(
      '<p class="empty">Document annotation index not available. ' +
        'Build the annotation index in the Annots tab to include document-wide ' +
        'counts and issue tables.</p>',
    );
    return section('Annotations', parts.join('\n'));
  }

  const summary = annotationIndex.summary;
  parts.push(
    cards([
      ['Annotations', summary.annotations],
      ['Pages with annotations', summary.pagesWithAnnotations],
      ['Links', summary.links],
      ['Form widgets', summary.forms],
      ['Form fields', summary.formFields],
      ['Hidden', summary.hidden],
      ['Unresolved links', summary.unresolvedLinks],
      ['Unsafe links', summary.unsafeLinks],
      ['Markup', summary.markup],
      ['Notes', summary.notes],
      ['Stamps', summary.stamps],
      ['Other', summary.other],
      ['Scanned pages', annotationIndex.scannedPages],
    ]),
  );

  const linkIssues = annotationIndex.linkIssues.slice(0, REPORT_MAX_ISSUES);
  parts.push('<h3>Link issues</h3>');
  parts.push(
    table(
      ['Page', 'Kind', 'Subtype', 'Target', 'Message'],
      linkIssues.map((issue: AnnotationLinkIssue) => [
        issue.page,
        issue.kind,
        issue.subtype,
        issue.target,
        issue.message,
      ]),
      'No link issues.',
    ),
  );
  if (annotationIndex.linkIssues.length > linkIssues.length) {
    parts.push(
      truncationNote(linkIssues.length, annotationIndex.linkIssues.length, 'link issues'),
    );
  }

  const formIssues = annotationIndex.formIssues.slice(0, REPORT_MAX_ISSUES);
  parts.push('<h3>Form issues</h3>');
  parts.push(
    table(
      ['Pages', 'Kind', 'Field', 'Types', 'Widgets', 'Message'],
      formIssues.map((issue: AnnotationFormIssue) => [
        issue.pages.join(', '),
        issue.kind,
        issue.fieldName,
        issue.fieldTypes.join(', '),
        issue.widgetCount,
        issue.message,
      ]),
      'No form issues.',
    ),
  );
  if (annotationIndex.formIssues.length > formIssues.length) {
    parts.push(
      truncationNote(formIssues.length, annotationIndex.formIssues.length, 'form issues'),
    );
  }

  return section('Annotations', parts.join('\n'));
}

function buildAuditSection(auditReport: AuditReport | null): string {
  if (auditReport === null) {
    return section(
      'Audit',
      '<p class="empty">Audit not run. Open the Audit workspace to include findings.</p>',
    );
  }

  const parts: string[] = [];
  const summary = auditReport.summary;
  parts.push(
    cards([
      ['Errors', summary.errors],
      ['Warnings', summary.warnings],
      ['Info', summary.info],
      ['Total findings', summary.total],
      ['Audit tool', `${auditReport.tool.name} ${auditReport.tool.version}`],
    ]),
  );

  const findings = auditReport.findings.slice(0, REPORT_MAX_FINDINGS);
  parts.push(
    table(
      ['Severity', 'Category', 'Page', 'Title', 'Detail', 'Evidence', 'Recommendation'],
      findings.map((finding: AuditFinding) => [
        finding.severity,
        finding.category,
        finding.page === null ? 'Document' : finding.page,
        finding.title,
        finding.detail,
        finding.evidence,
        finding.recommendation,
      ]),
      'No findings.',
    ),
  );
  if (auditReport.findings.length > findings.length) {
    parts.push(truncationNote(findings.length, auditReport.findings.length, 'findings'));
  }

  return section('Audit', parts.join('\n'));
}

function section(title: string, body: string): string {
  return `<section>\n<h2>${escapeHtml(title)}</h2>\n${body}\n</section>`;
}

function cards(entries: readonly (readonly [string, Cell])[]): string {
  const items = entries.map(
    ([label, value]) =>
      `<div class="card"><span class="card-label">${escapeHtml(label)}</span>` +
      `<span class="card-value">${escapeHtml(cellText(value))}</span></div>`,
  );
  return `<div class="cards">\n${items.join('\n')}\n</div>`;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  emptyMessage?: string,
): string {
  if (rows.length === 0) {
    return emptyMessage === undefined ? '' : `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  }

  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cellText(cell))}</td>`).join('')}</tr>`,
    )
    .join('\n');

  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function truncationNote(shown: number, total: number, noun: string): string {
  return (
    `<p class="note">Showing first ${escapeHtml(String(shown))} of ` +
    `${escapeHtml(String(total))} ${escapeHtml(noun)}. The complete list is ` +
    'available in the PDF Inspector workspace.</p>'
  );
}

function cellText(value: Cell): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatNumber(value);
  return value;
}

function requirePngDataUrl(value: string): string {
  if (typeof value !== 'string' || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('A base64 PNG data URL is required to build the inspection report.');
  }
  return value;
}

function normalizeLang(lang: string | undefined): string {
  const value = lang?.trim();
  return value && LANG_PATTERN.test(value) ? value : REPORT_DEFAULT_LANG;
}

function normalizePageNumber(pageNumber: number): number {
  if (!Number.isFinite(pageNumber)) return 1;
  return Math.max(1, Math.trunc(pageNumber));
}

function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  return ((Math.round(rotation) % 360) + 360) % 360;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHttpUrl(value: string | null): value is string {
  if (value === null) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function positiveDimension(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.round(value);
}

function countOf(value: readonly unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

function formatPageList(pages: readonly number[]): string {
  const unique = [...new Set(pages.filter((page) => Number.isFinite(page)))].sort(
    (left, right) => left - right,
  );
  if (unique.length === 0) return '—';

  const limit = 20;
  const shown = unique.slice(0, limit).join(', ');
  return unique.length > limit ? `${shown}, +${unique.length - limit} more` : shown;
}

function formatColorList(colors: readonly string[]): string {
  if (colors.length === 0) return '—';

  const limit = 8;
  const shown = colors.slice(0, limit).join(', ');
  return colors.length > limit ? `${shown}, +${colors.length - limit} more` : shown;
}

function boxLabel(key: 'media' | 'crop' | 'trim' | 'bleed' | 'art'): string {
  switch (key) {
    case 'media':
      return 'MediaBox';
    case 'crop':
      return 'CropBox';
    case 'trim':
      return 'TrimBox';
    case 'bleed':
      return 'BleedBox';
    case 'art':
      return 'ArtBox';
  }
}

function formatTimestamp(date: Date): { iso: string; readable: string } {
  const time = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(time)) return { iso: '', readable: 'Unknown' };

  const iso = date.toISOString();
  let readable = iso;
  try {
    readable = date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    // Environments without an ICU locale fall back to the ISO timestamp.
  }
  return { iso, readable };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const REPORT_STYLES = `:root {
  color-scheme: light;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  padding: 32px 20px 48px;
  background: #eef1f5;
  color: #1c2430;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
main {
  max-width: 1080px;
  margin: 0 auto;
}
.report-header {
  margin-bottom: 20px;
  padding: 20px 24px;
  background: #ffffff;
  border: 1px solid #d5dbe3;
  border-radius: 10px;
}
h1 {
  margin: 0 0 6px;
  font-size: 24px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
h2 {
  margin: 0 0 12px;
  font-size: 16px;
}
h3 {
  margin: 16px 0 8px;
  font-size: 13px;
}
.meta {
  margin: 2px 0;
  color: #5b6675;
  font-size: 12px;
  overflow-wrap: anywhere;
}
section {
  margin-bottom: 20px;
  padding: 18px 20px;
  background: #ffffff;
  border: 1px solid #d5dbe3;
  border-radius: 10px;
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.card {
  flex: 1 1 180px;
  min-width: 140px;
  padding: 10px 12px;
  background: #f6f8fa;
  border: 1px solid #e1e6ec;
  border-radius: 8px;
}
.card-label {
  display: block;
  color: #5b6675;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.card-value {
  display: block;
  margin-top: 2px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  padding: 6px 8px;
  border-bottom: 1px solid #e1e6ec;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th {
  color: #5b6675;
  font-weight: 600;
  background: #f6f8fa;
}
tr:last-child td {
  border-bottom: none;
}
.snapshot {
  margin: 0;
}
.snapshot img {
  display: block;
  max-width: 100%;
  height: auto;
  background: #ffffff;
  border: 1px solid #d5dbe3;
  border-radius: 6px;
}
figcaption {
  margin-top: 8px;
  color: #5b6675;
  font-size: 12px;
}
.empty,
.note {
  margin: 8px 0 0;
  color: #5b6675;
  font-size: 12px;
}
.warnings {
  margin: 12px 0 0;
  padding: 10px 12px;
  background: #fff8e6;
  border: 1px solid #e8d391;
  border-radius: 8px;
  font-size: 12px;
}
.warnings ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.disclaimer {
  margin: 20px 0 0;
  color: #5b6675;
  font-size: 12px;
  text-align: center;
}
@media print {
  body {
    padding: 0;
    background: #ffffff;
  }
  section,
  .report-header {
    break-inside: avoid;
    border-color: #cccccc;
  }
}`;
