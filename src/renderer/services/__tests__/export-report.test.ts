import { describe, expect, it } from 'vitest';
import type { AuditFinding, AuditReport } from '../../../shared/audit-types';
import type { AnnotationIndexResult } from '../annotation-index';
import type { CapturedImage } from '../export-capture';
import {
  REPORT_MAX_BYTES,
  assertReportSize,
  buildInspectionReport,
  escapeHtml,
  reportCaptureScale,
  type InspectionReportInput,
} from '../export-report';
import type { PdfAnnotation } from '../../types/annotations';
import type { FontStat } from '../../types/ipc-protocol';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';

const metadata: PdfMetadata = {
  pages: 3,
  version: '1.7',
  encrypted: true,
  page_w: 612,
  page_h: 792,
  title: 'Demo title',
  author: 'Ada',
  producer: 'pdf-inspector',
  fonts: ['F1'],
};

const pageData: PageData = {
  width: 612,
  height: 792,
  rotation: 0,
  boxes: {
    media: { x0: 0, y0: 0, x1: 612, y1: 792 },
    crop: { x0: 10, y0: 10, x1: 600, y1: 780 },
    trim: null,
    bleed: null,
    art: null,
  },
  chars: [
    { type: 'char', x0: 1, y0: 2, x1: 3, y1: 4, page: 1, text: 'a', fontname: 'F1', size: 12, color: '#000000' },
    { type: 'char', x0: 4, y0: 2, x1: 6, y1: 4, page: 1, text: 'b', fontname: 'F1', size: 12, color: '#000000' },
  ],
  words: [
    { type: 'word', x0: 1, y0: 2, x1: 9, y1: 4, page: 1, text: 'ab', fontname: 'F1', size: 12 },
  ],
  rects: [{ type: 'rect', x0: 1, y0: 1, x1: 2, y1: 2, page: 1, fill: true, stroke: false, color: '#ff0000', width: 1 }],
  lines: [],
  curves: [],
  images: [
    { type: 'image', x0: 1, y0: 1, x1: 2, y1: 2, page: 1, width: 10, height: 10, stream_id: 's1', format: 'png' },
  ],
  tables: [],
};

const screenshot: CapturedImage = {
  blob: new Blob(['png'], { type: 'image/png' }),
  width: 1224,
  height: 1584,
  pngDataUrl: 'data:image/png;base64,QUJD',
  appliedScale: 2,
  cropped: false,
  warnings: [],
};

const annotations: PdfAnnotation[] = [
  {
    id: 'a1',
    page: 1,
    subtype: 'Highlight',
    kind: 'markup',
    rect: { x0: 10, y0: 20, x1: 30, y1: 40 },
    title: 'Note title',
    contents: 'Body',
    modificationDate: null,
    color: '#ffff00',
    opacity: 1,
    hidden: false,
    link: null,
    form: null,
  },
];

const fontStats: FontStat[] = [
  {
    fontname: 'F1',
    pages: [1, 2],
    charCount: 42,
    sizeMin: 10,
    sizeMax: 12,
    colors: ['#000000'],
  },
];

const annotationIndex: AnnotationIndexResult = {
  annotations,
  summary: {
    annotations: 5,
    pagesWithAnnotations: 2,
    links: 2,
    forms: 1,
    markup: 1,
    notes: 0,
    stamps: 0,
    other: 0,
    hidden: 1,
    unresolvedLinks: 1,
    unsafeLinks: 1,
    formFields: 3,
  },
  linkIssues: [
    {
      annotationId: 'a2',
      page: 2,
      subtype: 'Link',
      kind: 'unsafe',
      target: 'javascript:alert(1)',
      message: 'Link uses an unsafe target scheme',
    },
  ],
  formIssues: [
    {
      annotationId: null,
      fieldName: 'name',
      pages: [1, 2],
      fieldTypes: ['Tx'],
      widgetCount: 2,
      kind: 'duplicate-name',
      message: 'Field "name" appears on 2 pages',
    },
  ],
  formFields: [],
  scannedPages: 3,
  truncated: false,
};

const auditFinding: AuditFinding = {
  category: 'metadata',
  severity: 'warning',
  page: null,
  title: 'Missing language',
  detail: 'The document has no /Lang entry.',
  evidence: '<no evidence>',
  recommendation: 'Add /Lang to the catalog.',
};

const auditReport: AuditReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 3,
    version: '1.7',
    encrypted: true,
    title: 'Demo title',
    author: 'Ada',
    producer: 'pdf-inspector',
    language: null,
    tagged: false,
  },
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
  findings: [auditFinding],
};

function makeInput(overrides: Partial<InspectionReportInput> = {}): InspectionReportInput {
  return {
    documentName: '测试 Report',
    sourceUrl: 'https://example.com/docs/a.pdf',
    metadata,
    pageNumber: 1,
    pageData,
    screenshot,
    annotations,
    annotationIndex,
    auditReport,
    fontStats,
    generatedAt: new Date('2024-05-06T07:08:09.000Z'),
    ...overrides,
  };
}

describe('buildInspectionReport', () => {
  it('builds a complete self-contained document with the embedded screenshot', () => {
    const html = buildInspectionReport(makeInput());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Inspection report — 测试 Report</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('<img src="data:image/png;base64,QUJD" width="1224" height="1584"');
    expect(html).toContain('2024-05-06T07:08:09.000Z');
    expect(html).toContain('Source: https://example.com/docs/a.pdf');
  });

  it('never emits a script tag or an external resource reference', () => {
    const html = buildInspectionReport(makeInput());

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/(?:src|href)="javascript:/i);
  });

  it('escapes document, annotation, font and audit strings', () => {
    const html = buildInspectionReport(
      makeInput({
        documentName: '<script>alert("x")</script>',
        annotations: [
          {
            ...annotations[0],
            title: '<img src=x onerror="alert(1)">',
            contents: '</td></table>',
          },
        ],
        annotationIndex: {
          ...annotationIndex,
          linkIssues: [
            {
              ...annotationIndex.linkIssues[0],
              target: '<img src=x onerror="alert(1)">',
              message: '</td></table>',
            },
          ],
        },
        fontStats: [{ ...fontStats[0], fontname: '<b>bold</b>' }],
        auditReport: {
          ...auditReport,
          findings: [
            {
              ...auditFinding,
              title: '<script>boom()</script>',
              detail: '"><script>boom()</script>',
            },
          ],
        },
      }),
    );

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;/td&gt;&lt;/table&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders the summary cards, composition counts and page boxes', () => {
    const html = buildInspectionReport(makeInput());

    expect(html).toContain('<h2>Document summary</h2>');
    expect(html).toContain('612 × 792 pt');
    expect(html).toContain('1.7');
    expect(html).toContain('Encrypted');
    expect(html).toContain('Demo title');
    expect(html).toContain('Ada');
    expect(html).toContain('pdf-inspector');

    expect(html).toContain('<h2>Page composition</h2>');
    expect(html).toContain('Chars');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('MediaBox');
    expect(html).toContain('CropBox');
  });

  it('shows capture warnings and a warning for an oversized screenshot', () => {
    const withWarnings = buildInspectionReport(
      makeInput({ screenshot: { ...screenshot, warnings: ['Region is empty; exported the full page.'] } }),
    );
    expect(withWarnings).toContain('Region is empty; exported the full page.');

    const oversized = buildInspectionReport(
      makeInput({ screenshot: { ...screenshot, width: 3000, height: 2000 } }),
    );
    expect(oversized).toContain('recommended maximum side is 2400 px');
  });

  it('does not add an oversize warning for a normal screenshot', () => {
    const html = buildInspectionReport(makeInput());
    expect(html).not.toContain('recommended maximum side');
  });

  it('lists the font table or explains that analysis is unavailable', () => {
    const html = buildInspectionReport(makeInput());
    expect(html).toContain('<h2>Fonts</h2>');
    expect(html).toContain('<td>F1</td>');
    expect(html).toContain('42');
    expect(html).toContain('10–12 pt');

    expect(buildInspectionReport(makeInput({ fontStats: null }))).toContain(
      'Font analysis not available.',
    );
    expect(buildInspectionReport(makeInput({ fontStats: [] }))).toContain(
      'No fonts were reported for this document.',
    );
  });

  it('renders current-page and document annotation summaries with issue tables', () => {
    const html = buildInspectionReport(makeInput());

    expect(html).toContain('Current page: 1 annotation.');
    expect(html).toContain('Pages with annotations');
    expect(html).toContain('<h3>Link issues</h3>');
    expect(html).toContain('Unsafe links');
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('<h3>Form issues</h3>');
    expect(html).toContain('duplicate-name');
  });

  it('degrades when the annotation index has not been built', () => {
    const html = buildInspectionReport(makeInput({ annotationIndex: null }));
    expect(html).toContain('Document annotation index not available.');
  });

  it('renders audit summary and findings, or a clear not-run note', () => {
    const html = buildInspectionReport(makeInput());
    expect(html).toContain('<h2>Audit</h2>');
    expect(html).toContain('Total findings');
    expect(html).toContain('Missing language');
    expect(html).toContain('Add /Lang to the catalog.');

    expect(buildInspectionReport(makeInput({ auditReport: null }))).toContain('Audit not run.');
  });

  it('caps issue and finding tables with a truncation note', () => {
    const linkIssues = Array.from({ length: 101 }, (_, index) => ({
      ...annotationIndex.linkIssues[0],
      annotationId: `link-${index}`,
      page: index + 1,
    }));
    const formIssues = Array.from({ length: 101 }, (_, index) => ({
      ...annotationIndex.formIssues[0],
      fieldName: `field-${index}`,
    }));
    const findings = Array.from({ length: 201 }, (_, index) => ({
      ...auditFinding,
      title: `Finding ${index}`,
    }));

    const html = buildInspectionReport(
      makeInput({
        annotationIndex: { ...annotationIndex, linkIssues, formIssues },
        auditReport: { ...auditReport, summary: { total: 201, errors: 0, warnings: 201, info: 0 }, findings },
      }),
    );

    expect(html).toContain('Showing first 100 of 101 link issues.');
    expect(html).toContain('Showing first 100 of 101 form issues.');
    expect(html).toContain('Showing first 200 of 201 findings.');
    expect(html).toContain('Finding 199');
    expect(html).not.toContain('Finding 200');
  });

  it('renders only http(s) source URLs', () => {
    expect(buildInspectionReport(makeInput({ sourceUrl: 'https://example.com/a.pdf' }))).toContain(
      'Source: https://example.com/a.pdf',
    );
    expect(
      buildInspectionReport(makeInput({ sourceUrl: 'javascript:alert(1)' })),
    ).not.toContain('Source:');
    expect(buildInspectionReport(makeInput({ sourceUrl: null }))).not.toContain('Source:');
  });

  it('uses the caller locale and falls back to en for an invalid tag', () => {
    expect(buildInspectionReport(makeInput({ lang: 'zh-CN' }))).toContain(
      '<html lang="zh-CN">',
    );
    expect(buildInspectionReport(makeInput({ lang: 'not a tag' }))).toContain('<html lang="en">');
  });

  it('falls back to Untitled document and page 1 for missing/invalid values', () => {
    const html = buildInspectionReport(
      makeInput({ documentName: '   ', pageNumber: Number.NaN, metadata: null }),
    );

    expect(html).toContain('Untitled document');
    expect(html).toContain('Page 1');
    expect(html).toContain('Unknown');
  });

  it('rejects a screenshot that is not a base64 PNG data URL', () => {
    expect(() =>
      buildInspectionReport(makeInput({ screenshot: { ...screenshot, pngDataUrl: 'data:image/jpeg;base64,QUJD' } })),
    ).toThrow(/PNG data URL/);
  });

  it('includes the read-only disclaimer', () => {
    const html = buildInspectionReport(makeInput());
    expect(html).toContain('Read-only snapshot');
    expect(html).toContain('no scripts and no external resources');
    expect(html).toContain('not a PDF/A conformance or accessibility certification');
  });
});

describe('assertReportSize', () => {
  it('accepts a report at or below the cap', () => {
    expect(() => assertReportSize('x'.repeat(10), 10)).not.toThrow();
  });

  it('rejects a report above the cap with a readable message', () => {
    expect(() => assertReportSize('x'.repeat(11), 10)).toThrow(/Report is too large/);
    expect(() => assertReportSize('x'.repeat(11), 10)).toThrow(/reduce the screenshot size/);
  });

  it('defaults to the exported 20 MB cap', () => {
    expect(REPORT_MAX_BYTES).toBe(20_000_000);
  });
});

describe('reportCaptureScale', () => {
  it('uses 2x for a letter page and never goes above 2', () => {
    expect(reportCaptureScale({ width: 612, height: 792 })).toBe(2);
  });

  it('shrinks wide pages so the longest side fits the cap', () => {
    expect(reportCaptureScale({ width: 2000, height: 1000 })).toBe(1.2);
    expect(reportCaptureScale({ width: 2400, height: 1000 })).toBe(1);
  });

  it('clamps to 1 for pages that already exceed the cap at 1x', () => {
    expect(reportCaptureScale({ width: 3000, height: 4000 })).toBe(1);
  });

  it('accounts for rotation and the media box', () => {
    expect(reportCaptureScale({ width: 2000, height: 1000, rotation: 90 })).toBe(1.2);
    expect(
      reportCaptureScale({
        width: 100,
        height: 100,
        boxes: {
          media: { x0: 0, y0: 0, x1: 2000, y1: 1000 },
          crop: null,
          trim: null,
          bleed: null,
          art: null,
        },
      }),
    ).toBe(1.2);
  });

  it('falls back to 1 for invalid dimensions', () => {
    expect(reportCaptureScale({ width: 0, height: 792 })).toBe(1);
    expect(reportCaptureScale({ width: Number.NaN, height: 792 })).toBe(1);
  });
});

describe('escapeHtml', () => {
  it('escapes markup and both quote styles', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
