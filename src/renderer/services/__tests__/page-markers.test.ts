import { describe, expect, it } from 'vitest';
import type { AuditFinding, AuditReport, AuditSeverity } from '../../../shared/audit-types';
import type {
  AnnotationFormIssue,
  AnnotationIndexResult,
  AnnotationLinkIssue,
} from '../annotation-index';
import type { PdfAnnotation } from '../../types/annotations';
import { buildPageMarkers, type PageMarker, type PageMarkers } from '../page-markers';

const finding = (
  page: number | null,
  severity: AuditSeverity = 'warning',
  overrides: Partial<AuditFinding> = {},
): AuditFinding => ({
  category: 'pages',
  severity,
  page,
  title: 'Finding',
  detail: 'Detail',
  evidence: null,
  recommendation: null,
  ...overrides,
});

function report(findings: AuditFinding[]): AuditReport {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const entry of findings) {
    if (entry.severity === 'error') errors += 1;
    else if (entry.severity === 'warning') warnings += 1;
    else info += 1;
  }

  return {
    schemaVersion: 1,
    tool: { name: 'pdf-inspector', version: '0.4.0' },
    document: {
      pages: 3,
      version: '1.7',
      encrypted: false,
      title: null,
      author: null,
      producer: null,
      language: null,
      tagged: false,
    },
    summary: { total: findings.length, errors, warnings, info },
    findings,
  };
}

const annotation = (
  page: number,
  id: string,
  overrides: Partial<PdfAnnotation> = {},
): PdfAnnotation => ({
  id,
  page,
  subtype: 'Highlight',
  kind: 'markup',
  rect: null,
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
  ...overrides,
});

const indexResult = (partial: Partial<AnnotationIndexResult> = {}): AnnotationIndexResult => ({
  annotations: [],
  summary: {
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
  },
  linkIssues: [],
  formIssues: [],
  formFields: [],
  scannedPages: 0,
  truncated: false,
  ...partial,
});

const linkIssue = (
  page: number,
  kind: AnnotationLinkIssue['kind'],
  annotationId = 'link-1',
): AnnotationLinkIssue => ({
  annotationId,
  page,
  subtype: 'Link',
  kind,
  target: null,
  message: 'link issue',
});

const formIssue = (
  pages: number[],
  overrides: Partial<AnnotationFormIssue> = {},
): AnnotationFormIssue => ({
  annotationId: null,
  fieldName: 'field',
  pages,
  fieldTypes: ['Tx'],
  widgetCount: pages.length,
  kind: 'duplicate-name',
  message: 'form issue',
  ...overrides,
});

const marker = (markers: PageMarkers, page: number): PageMarker => {
  const entry = markers.pages.get(page);
  expect(entry).toBeDefined();
  return entry as PageMarker;
};

const counts = (error: number, warning: number, info: number) => ({
  error,
  warning,
  info,
  total: error + warning + info,
});

describe('buildPageMarkers', () => {
  it('returns zeroes and an empty map for no report, no index and no pages', () => {
    const empty = buildPageMarkers({ pageCount: 0, auditReport: null, annotationResult: null });

    expect(empty.pages.size).toBe(0);
    expect(empty.findings).toEqual(counts(0, 0, 0));
    expect(empty.documentFindings).toEqual(counts(0, 0, 0));
    expect(empty.annotations).toBe(0);
    expect(empty.annotationIssues).toBe(0);
    expect(empty.problemPages).toEqual([]);
    expect(empty.annotatedPages).toEqual([]);

    const noData = buildPageMarkers({ pageCount: 12, auditReport: null, annotationResult: null });
    expect(noData.pages.size).toBe(0);
    expect(noData.findings.total).toBe(0);
    expect(noData.problemPages).toEqual([]);
  });

  it('ignores page findings beyond the page count but keeps document-level ones', () => {
    const zero = buildPageMarkers({
      pageCount: 0,
      auditReport: report([finding(1, 'error'), finding(null, 'warning')]),
      annotationResult: indexResult({ annotations: [annotation(1, 'a1')] }),
    });

    expect(zero.pages.size).toBe(0);
    expect(zero.findings).toEqual(counts(0, 1, 0));
    expect(zero.documentFindings).toEqual(counts(0, 1, 0));
    expect(zero.annotations).toBe(0);
    expect(zero.annotatedPages).toEqual([]);
  });

  it('treats a non-finite or negative page count as no addressable page', () => {
    for (const pageCount of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      const markers = buildPageMarkers({
        pageCount,
        auditReport: report([finding(1, 'error'), finding(null, 'info')]),
        annotationResult: indexResult({
          annotations: [annotation(1, 'a1')],
          linkIssues: [linkIssue(1, 'unsafe')],
        }),
      });

      expect(markers.pages.size).toBe(0);
      expect(markers.findings).toEqual(counts(0, 0, 1));
      expect(markers.annotations).toBe(0);
      // An unsafe link still counts as one document-level issue.
      expect(markers.annotationIssues).toBe(1);
      expect(markers.problemPages).toEqual([]);
    }
  });

  it('separates page findings from document-level findings', () => {
    const markers = buildPageMarkers({
      pageCount: 4,
      auditReport: report([
        finding(1, 'error'),
        finding(2, 'warning'),
        finding(null, 'info', { title: 'Missing language' }),
        finding(null, 'warning', { title: 'Untagged' }),
      ]),
      annotationResult: null,
    });

    expect(marker(markers, 1).findings).toEqual(counts(1, 0, 0));
    expect(marker(markers, 2).findings).toEqual(counts(0, 1, 0));
    // The document-level findings never land on page 1.
    expect(markers.documentFindings).toEqual(counts(0, 1, 1));
    expect(markers.findings).toEqual(counts(1, 2, 1));
    expect([...markers.pages.keys()]).toEqual([1, 2]);
    expect(markers.problemPages).toEqual([1, 2]);
    expect(markers.annotatedPages).toEqual([]);
  });

  it('accumulates several findings and severities on the same page', () => {
    const markers = buildPageMarkers({
      pageCount: 3,
      auditReport: report([
        finding(2, 'error'),
        finding(2, 'error'),
        finding(2, 'warning'),
        finding(2, 'info'),
        finding(3, 'info'),
      ]),
      annotationResult: null,
    });

    expect(marker(markers, 2).findings).toEqual(counts(2, 1, 1));
    expect(marker(markers, 3).findings).toEqual(counts(0, 0, 1));
    expect(markers.findings).toEqual(counts(2, 1, 2));
    expect(markers.pages.has(1)).toBe(false);
  });

  it('ignores out-of-range, non-integer pages and unknown severities', () => {
    const markers = buildPageMarkers({
      pageCount: 2,
      auditReport: report([
        finding(0, 'error'),
        finding(-1, 'error'),
        finding(3, 'error'),
        finding(1.5, 'error'),
        finding(Number.NaN, 'error'),
        finding(2, 'fatal' as AuditSeverity),
        finding(2, 'warning', { title: 'kept' }),
      ]),
      annotationResult: null,
    });

    expect([...markers.pages.keys()]).toEqual([2]);
    expect(marker(markers, 2).findings).toEqual(counts(0, 1, 0));
    expect(markers.findings).toEqual(counts(0, 1, 0));
    expect(markers.documentFindings).toEqual(counts(0, 0, 0));
  });

  it('counts annotations per page, including hidden ones', () => {
    const markers = buildPageMarkers({
      pageCount: 5,
      auditReport: null,
      annotationResult: indexResult({
        annotations: [
          annotation(1, 'a1'),
          annotation(1, 'a2', { hidden: true }),
          annotation(1, 'a3'),
          annotation(4, 'a4', { hidden: true, kind: 'note', subtype: 'Text' }),
        ],
        scannedPages: 5,
      }),
    });

    expect(marker(markers, 1).annotations).toBe(3);
    expect(marker(markers, 4).annotations).toBe(1);
    expect(markers.annotations).toBe(4);
    expect(markers.annotatedPages).toEqual([1, 4]);
    expect(markers.problemPages).toEqual([]);
    expect(markers.findings.total).toBe(0);
    // Hidden annotations are page content, not issues.
    expect(markers.annotationIssues).toBe(0);
  });

  it('counts unresolved and unsafe link issues but not external ones', () => {
    const markers = buildPageMarkers({
      pageCount: 3,
      auditReport: null,
      annotationResult: indexResult({
        annotations: [annotation(1, 'a1')],
        linkIssues: [
          linkIssue(1, 'unresolved', 'l1'),
          linkIssue(2, 'unsafe', 'l2'),
          linkIssue(2, 'external', 'l3'),
          linkIssue(3, 'external', 'l4'),
        ],
      }),
    });

    expect(markers.annotationIssues).toBe(2);
    expect(marker(markers, 1).annotationIssues).toBe(1);
    expect(marker(markers, 2).annotationIssues).toBe(1);
    // An external link is information, so page 3 gets no marker at all.
    expect(markers.pages.has(3)).toBe(false);
    expect(markers.problemPages).toEqual([1, 2]);
    expect(markers.annotatedPages).toEqual([1]);
  });

  it('marks every page of a form issue but counts the issue once', () => {
    const markers = buildPageMarkers({
      pageCount: 4,
      auditReport: null,
      annotationResult: indexResult({
        annotations: [annotation(2, 'w1'), annotation(3, 'w2')],
        formIssues: [
          formIssue([2, 3], { widgetCount: 2 }),
          formIssue([3, 3], { fieldName: 'duplicate-pages', widgetCount: 2 }),
          formIssue([], { fieldName: 'nameless', kind: 'unnamed', annotationId: 'w9' }),
          formIssue([9, 0], { fieldName: 'stale', kind: 'conflicting-type' }),
        ],
      }),
    });

    expect(markers.annotationIssues).toBe(4);
    expect(marker(markers, 2).annotationIssues).toBe(1);
    expect(marker(markers, 3).annotationIssues).toBe(2);
    expect(markers.problemPages).toEqual([2, 3]);
    // Issues with no addressable page still count in the document total.
    expect(markers.pages.has(9)).toBe(false);
    expect(markers.pages.has(0)).toBe(false);
  });

  it('lists issue-only pages in the map and problems but not annotation-only pages', () => {
    const markers = buildPageMarkers({
      pageCount: 5,
      auditReport: report([finding(4, 'info')]),
      annotationResult: indexResult({
        annotations: [annotation(1, 'a1'), annotation(5, 'a2')],
        linkIssues: [linkIssue(5, 'unsafe')],
      }),
    });

    expect([...markers.pages.keys()]).toEqual([1, 4, 5]);
    expect(marker(markers, 1)).toEqual({
      page: 1,
      findings: counts(0, 0, 0),
      annotations: 1,
      annotationIssues: 0,
    });
    expect(marker(markers, 5)).toEqual({
      page: 5,
      findings: counts(0, 0, 0),
      annotations: 1,
      annotationIssues: 1,
    });
    expect(markers.problemPages).toEqual([4, 5]);
    expect(markers.annotatedPages).toEqual([1, 5]);
    expect(markers.findings).toEqual(counts(0, 0, 1));
    expect(markers.annotations).toBe(2);
    expect(markers.annotationIssues).toBe(1);
  });

  it('returns pages, problem pages and annotated pages in ascending order', () => {
    const markers = buildPageMarkers({
      pageCount: 6,
      auditReport: report([finding(5, 'warning'), finding(2, 'error')]),
      annotationResult: indexResult({
        annotations: [annotation(4, 'a1'), annotation(1, 'a2')],
        formIssues: [formIssue([6, 3])],
      }),
    });

    expect([...markers.pages.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(markers.problemPages).toEqual([2, 3, 5, 6]);
    expect(markers.annotatedPages).toEqual([1, 4]);
  });

  it('builds markers for 1000 pages in one pass', () => {
    const findings: AuditFinding[] = [];
    const annotations: PdfAnnotation[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      findings.push(finding(page, 'warning', { title: `page-${page}` }));
      annotations.push(annotation(page, `a${page}`));
    }

    const startedAt = Date.now();
    const markers = buildPageMarkers({
      pageCount: 1000,
      auditReport: report(findings),
      annotationResult: indexResult({ annotations, scannedPages: 1000 }),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(markers.pages.size).toBe(1000);
    expect(markers.findings).toEqual(counts(0, 1000, 0));
    expect(markers.annotations).toBe(1000);
    expect(markers.annotatedPages).toHaveLength(1000);
    expect(markers.problemPages[0]).toBe(1);
    expect(markers.problemPages[999]).toBe(1000);
    expect(marker(markers, 999).findings).toEqual(counts(0, 1, 0));
    // A single linear pass over ~2000 entries; the bound only catches an
    // accidental nested scan (or a per-page lookup of the whole report).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('does not mutate its inputs and is deterministic for the same input', () => {
    const input = {
      pageCount: 3,
      auditReport: report([finding(1, 'error'), finding(null, 'info'), finding(9, 'warning')]),
      annotationResult: indexResult({
        annotations: [annotation(1, 'a1'), annotation(2, 'a2', { hidden: true })],
        linkIssues: [linkIssue(1, 'unresolved')],
        formIssues: [formIssue([2, 3])],
      }),
    };
    const before = JSON.parse(JSON.stringify(input)) as typeof input;

    const first = buildPageMarkers(input);
    const second = buildPageMarkers(input);

    expect(input).toEqual(before);
    expect(input.auditReport.findings).toHaveLength(3);
    expect(input.annotationResult.annotations).toHaveLength(2);
    expect(input.annotationResult.formIssues[0].pages).toEqual([2, 3]);
    expect(second).toEqual(first);
    expect(second.pages).toEqual(first.pages);
  });

  it('degrades on malformed payloads instead of throwing', () => {
    const malformedReport = {
      ...report([]),
      findings: [
        null,
        42,
        'x',
        { severity: 'error', page: 1 },
        { severity: 'bogus', page: 1 },
        { severity: 'error', page: '1' },
        { severity: 'error', page: 1.5 },
        { severity: 'info' },
      ],
    } as unknown as AuditReport;

    const malformedIndex = {
      annotations: [null, { page: 1 }, { page: 2, hidden: true }, { page: 0 }, { page: 'x' }],
      linkIssues: [null, {}, { kind: 'external', page: 1 }, { kind: 'unsafe', page: 1 }, { kind: 'unresolved', page: 9 }],
      formIssues: [null, {}, { pages: 'nope' }],
    } as unknown as AnnotationIndexResult;

    const markers = buildPageMarkers({
      pageCount: 2,
      auditReport: malformedReport,
      annotationResult: malformedIndex,
    });

    expect(marker(markers, 1).findings).toEqual(counts(1, 0, 0));
    expect(marker(markers, 1).annotations).toBe(1);
    expect(marker(markers, 1).annotationIssues).toBe(1);
    expect(marker(markers, 2).annotations).toBe(1);
    expect(markers.documentFindings).toEqual(counts(0, 0, 1));
    // unsafe + unresolved + two form issues without usable pages.
    expect(markers.annotationIssues).toBe(4);
    expect(markers.findings).toEqual(counts(1, 0, 1));
    expect([...markers.pages.keys()]).toEqual([1, 2]);
  });
});
