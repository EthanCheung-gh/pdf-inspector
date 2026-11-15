/**
 * Page markers: per-page audit and annotation aggregates for the page overview.
 *
 * The overview draws one badge per thumbnail. This module turns the current
 * document's `AuditReport` and whole-document `AnnotationIndexResult` into a
 * single page map and document-level totals, so the UI never walks findings or
 * the annotation list again. It is pure (no React, no Zustand, no DOM) and never
 * starts an analysis: the caller decides whether the report/index it passes in
 * belongs to the file on screen.
 *
 * Degradation rules, because a report or an index can be stale or partly
 * malformed and the overview must still render:
 *
 * - a finding counts only when its severity is `error`, `warning` or `info`;
 *   an unknown severity is skipped entirely;
 * - a finding counts on a page only when `page` is an integer inside
 *   `1..pageCount`; `page: null` (or a missing page) is document-level and is
 *   counted in `documentFindings` even when `pageCount` is 0 or unusable;
 * - annotations whose page is outside `1..pageCount` are not page content we
 *   can show, so they are dropped entirely; link/form issues whose page is
 *   outside the document still count in the document totals, because the issue
 *   itself is real even when its page cannot be marked;
 * - a form issue spanning several pages counts once in `annotationIssues` and
 *   once on every page it names (duplicate pages count once);
 * - an `external` link issue is information, not a problem;
 * - a non-finite or negative `pageCount` is treated as 0.
 *
 * Every scan is a single pass over one input array; the only extra work is the
 * sort of the touched page numbers, so a 1000-page document stays cheap.
 */
import type { AuditReport } from '../../shared/audit-types';
import type { AnnotationIndexResult } from './annotation-index';

export interface PageFindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface PageMarker {
  page: number;
  findings: PageFindingCounts;
  annotations: number;
  annotationIssues: number;
}

export interface PageMarkers {
  /** Page number -> marker; only pages with at least one count or annotation. */
  pages: ReadonlyMap<number, PageMarker>;
  /** Audit findings with `page: null`. */
  documentFindings: PageFindingCounts;
  /** Total audit findings across pages + document. */
  findings: PageFindingCounts;
  /** Annotations across all pages, and link/form issues. */
  annotations: number;
  annotationIssues: number;
  /** Pages with any audit problem (error/warning/info) or annotation issue. */
  problemPages: readonly number[];
  /** Pages with any annotation. */
  annotatedPages: readonly number[];
}

export interface PageMarkerInput {
  pageCount: number;
  auditReport: AuditReport | null;
  annotationResult: AnnotationIndexResult | null;
}

interface PageAccumulator {
  findings: PageFindingCounts;
  annotations: number;
  annotationIssues: number;
}

const emptyFindingCounts = (): PageFindingCounts => ({ error: 0, warning: 0, info: 0, total: 0 });

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** A usable page count; anything else means "no page is addressable". */
function normalizePageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function isPageNumber(value: unknown, pageCount: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= pageCount;
}

/** Add one finding for a known severity; unknown severities are ignored. */
function addFinding(counts: PageFindingCounts, severity: unknown): void {
  switch (severity) {
    case 'error':
      counts.error += 1;
      break;
    case 'warning':
      counts.warning += 1;
      break;
    case 'info':
      counts.info += 1;
      break;
    default:
      return;
  }
  counts.total += 1;
}

/**
 * Aggregate the audit report and annotation index of one document into page
 * markers. The inputs are only read, never mutated.
 */
export function buildPageMarkers(input: PageMarkerInput): PageMarkers {
  const pageCount = normalizePageCount(input?.pageCount);
  const accumulators = new Map<number, PageAccumulator>();

  const accumulatorFor = (page: number): PageAccumulator => {
    const existing = accumulators.get(page);
    if (existing !== undefined) return existing;
    const created: PageAccumulator = {
      findings: emptyFindingCounts(),
      annotations: 0,
      annotationIssues: 0,
    };
    accumulators.set(page, created);
    return created;
  };

  // Audit findings: page findings accumulate per page, document-level findings
  // (no page) stay separate so they never land on page 1.
  const documentFindings = emptyFindingCounts();
  for (const value of asArray(input?.auditReport?.findings)) {
    const finding = asRecord(value);
    if (finding === null) continue;

    const page = finding.page;
    let target: PageFindingCounts;
    if (page === null || page === undefined) {
      target = documentFindings;
    } else if (isPageNumber(page, pageCount)) {
      target = accumulatorFor(page).findings;
    } else {
      // Out-of-range or non-integer page: the marker would point at a page the
      // document does not have, so the finding is dropped instead.
      continue;
    }

    addFinding(target, finding.severity);
  }

  // Annotations: every indexed annotation counts on its page, hidden included.
  let annotations = 0;
  for (const value of asArray(input?.annotationResult?.annotations)) {
    const annotation = asRecord(value);
    if (annotation === null) continue;
    const page = annotation.page;
    if (!isPageNumber(page, pageCount)) continue;
    accumulatorFor(page).annotations += 1;
    annotations += 1;
  }

  // Link issues: only unresolved/unsafe links are problems; an external link is
  // information, so it is not counted here.
  let annotationIssues = 0;
  for (const value of asArray(input?.annotationResult?.linkIssues)) {
    const issue = asRecord(value);
    if (issue === null) continue;
    if (issue.kind !== 'unresolved' && issue.kind !== 'unsafe') continue;
    annotationIssues += 1;
    const page = issue.page;
    if (isPageNumber(page, pageCount)) accumulatorFor(page).annotationIssues += 1;
  }

  // Form issues: one issue counts once in the total and once per page it names.
  for (const value of asArray(input?.annotationResult?.formIssues)) {
    const issue = asRecord(value);
    if (issue === null) continue;
    annotationIssues += 1;

    const seen = new Set<number>();
    for (const page of asArray(issue.pages)) {
      if (!isPageNumber(page, pageCount) || seen.has(page)) continue;
      seen.add(page);
      accumulatorFor(page).annotationIssues += 1;
    }
  }

  const pages = new Map<number, PageMarker>();
  const findings = emptyFindingCounts();
  const problemPages: number[] = [];
  const annotatedPages: number[] = [];

  // Ascending page order, so `pages.keys()` is sorted and both page lists are
  // already in document order.
  const pageNumbers = Array.from(accumulators.keys()).sort((left, right) => left - right);
  for (const page of pageNumbers) {
    const accumulator = accumulators.get(page);
    if (accumulator === undefined) continue;

    const pageFindings = accumulator.findings;
    findings.error += pageFindings.error;
    findings.warning += pageFindings.warning;
    findings.info += pageFindings.info;
    findings.total += pageFindings.total;

    const { annotations: pageAnnotations, annotationIssues: pageIssues } = accumulator;
    if (pageFindings.total === 0 && pageAnnotations === 0 && pageIssues === 0) continue;

    pages.set(page, {
      page,
      findings: pageFindings,
      annotations: pageAnnotations,
      annotationIssues: pageIssues,
    });
    if (pageFindings.total > 0 || pageIssues > 0) problemPages.push(page);
    if (pageAnnotations > 0) annotatedPages.push(page);
  }

  findings.error += documentFindings.error;
  findings.warning += documentFindings.warning;
  findings.info += documentFindings.info;
  findings.total += documentFindings.total;

  return {
    pages,
    documentFindings,
    findings,
    annotations,
    annotationIssues,
    problemPages,
    annotatedPages,
  };
}
