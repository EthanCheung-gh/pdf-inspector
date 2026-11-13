/**
 * State of the Audit workspace.
 *
 * Deliberately separate from `pdf-store`, like `diff-store`:
 * - The Inspect document (file, page, zoom, selection) must survive entering
 *   and leaving Audit untouched, so nothing here writes to that store.
 * - Auditing the open document is a transient analysis; the report is not
 *   persisted.
 *
 * The run itself is owned here rather than by a component so it survives a
 * close/reopen: `open()` starts it without blocking the UI, and a run that is
 * superseded by `close`, `reset` or another `open` is dropped instead of
 * overwriting the newer state.
 */
import { create } from 'zustand';
import {
  AUDIT_CATEGORIES,
  buildAuditReport,
  type AuditBaselineComparison,
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
} from '../../shared/audit-types';
import {
  AuditBaselineError,
  compareAuditReports,
  parseAuditBaselineReport,
  type AuditBaselineErrorCode,
} from '../../shared/audit-baseline';
import { translate } from '../i18n/translate';
import { useI18nStore } from '../i18n/store';
import type { MessageKey } from '../i18n/messages';
import { ipc } from '../services/ipc-client';

/**
 * Pages per `audit_pages` request.
 *
 * Mirrors font analysis: small batches let a page extraction interleave and
 * make progress visible, while the document pass only runs once.
 */
export const AUDIT_PAGE_BATCH_SIZE = 10;

export type AuditSeverityFilter = 'all' | AuditSeverity;
export type AuditCategoryFilter = 'all' | AuditCategory;

export interface AuditFilter {
  severity: AuditSeverityFilter;
  category: AuditCategoryFilter;
}

export interface AuditProgress {
  done: number;
  total: number;
}

/**
 * The baseline the user loaded in `Findings`.
 *
 * Only the file name is kept for display; the report stays in memory and is
 * never uploaded, persisted or written into the exported JSON.
 */
export interface AuditBaselineFile {
  fileName: string;
  report: AuditReport;
}

export const DEFAULT_AUDIT_FILTER: AuditFilter = {
  severity: 'all',
  category: 'all',
};

export interface AuditState {
  /** True while the Audit workspace replaces the Inspect panes. */
  active: boolean;
  filePath: string | null;
  fileName: string | null;
  /** Completed report; kept when the workspace is closed and reopened. */
  report: AuditReport | null;
  loading: boolean;
  /** Pages completed out of the document's page count, or null when idle. */
  progress: AuditProgress | null;
  error: string | null;
  filter: AuditFilter;
  /** The finding currently shown in the detail pane, or null. */
  selected: AuditFinding | null;

  /**
   * Baseline loaded from a local JSON file, or null.
   *
   * Kept across a re-run (the whole point is comparing a fresh report with an
   * old one) and dropped when another document is opened or on `reset()`.
   */
  baseline: AuditBaselineFile | null;
  /** `report` compared with `baseline`; null when either side is missing. */
  comparison: AuditBaselineComparison | null;
  /** Last baseline load/comparison failure, already localized for display. */
  baselineError: string | null;
  /** True while the findings list only shows `new` + `escalated` rows. */
  baselineOnly: boolean;

  /**
   * Enter the workspace for `filePath` and start an audit.
   *
   * The run is deliberately not awaited: the UI only needs the workspace to
   * become active. A completed report for the same file is reused instead of
   * being re-run.
   */
  open: (filePath: string, fileName: string) => void;
  /** Run (or re-run) the audit for the current document. */
  runAudit: () => Promise<void>;
  /** Leave the workspace; the report stays available for a reopen. */
  close: () => void;
  /** Clear every field and drop any in-flight run. */
  reset: () => void;
  setFilter: (patch: Partial<AuditFilter>) => void;
  selectFinding: (finding: AuditFinding | null) => void;
  /**
   * Read and validate a baseline JSON file, then compare it with `report`.
   *
   * Never throws and never replaces a baseline that is already loaded when the
   * new file is unusable: the failure is reported through `baselineError`.
   */
  loadBaselineFile: (file: File) => Promise<void>;
  /** Forget the baseline, its comparison, `baselineOnly` and any error. */
  clearBaseline: () => void;
  /** Dismiss a load/comparison error while keeping the loaded baseline. */
  clearBaselineError: () => void;
  setBaselineOnly: (value: boolean) => void;
}

type AuditStateFields = Pick<
  AuditState,
  | 'active'
  | 'filePath'
  | 'fileName'
  | 'report'
  | 'loading'
  | 'progress'
  | 'error'
  | 'filter'
  | 'selected'
  | 'baseline'
  | 'comparison'
  | 'baselineError'
  | 'baselineOnly'
>;

function createInitialState(): AuditStateFields {
  return {
    active: false,
    filePath: null,
    fileName: null,
    report: null,
    loading: false,
    progress: null,
    error: null,
    filter: { ...DEFAULT_AUDIT_FILTER },
    selected: null,
    baseline: null,
    comparison: null,
    baselineError: null,
    baselineOnly: false,
  };
}

/**
 * Monotonic run token.
 *
 * Module state on purpose: it is not rendered, and keeping it out of the store
 * means a subscriber can never observe (or restore) a stale generation.
 */
let currentRun = 0;

/** Invalidate every in-flight run and return the token of the next one. */
function nextRun(): number {
  currentRun += 1;
  return currentRun;
}

/** Clamp the engine's page count to a usable batch-loop bound. */
function normalizePageCount(pages: number): number {
  return Number.isFinite(pages) && pages > 0 ? Math.trunc(pages) : 0;
}

function categoryRank(category: AuditCategory): number {
  const index = AUDIT_CATEGORIES.indexOf(category);
  return index === -1 ? AUDIT_CATEGORIES.length : index;
}

/**
 * Contract order: category (`AUDIT_CATEGORIES`), then page ascending, then
 * title. Document-level findings (page null) sort before page findings because
 * page numbers are 1-based; the sort is stable, so equal findings keep the
 * order the engine produced.
 */
function compareAuditFindings(left: AuditFinding, right: AuditFinding): number {
  const rank = categoryRank(left.category) - categoryRank(right.category);
  if (rank !== 0) return rank;

  const leftPage = left.page ?? 0;
  const rightPage = right.page ?? 0;
  if (leftPage !== rightPage) return leftPage - rightPage;

  if (left.title < right.title) return -1;
  if (left.title > right.title) return 1;
  return 0;
}

function orderAuditFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort(compareAuditFindings);
}

/**
 * Compare every contract field so a selection survives a re-run that produced
 * the same finding (fresh objects) but is dropped when the finding is gone.
 */
function sameFinding(left: AuditFinding, right: AuditFinding): boolean {
  return (
    left.category === right.category &&
    left.severity === right.severity &&
    left.page === right.page &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.evidence === right.evidence &&
    left.recommendation === right.recommendation
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BASELINE_ERROR_KEYS: Record<AuditBaselineErrorCode, MessageKey> = {
  read: 'audit.baseline.error.read',
  json: 'audit.baseline.error.json',
  schema: 'audit.baseline.error.schema',
  fingerprint: 'audit.baseline.error.fingerprint',
  'current-fingerprint': 'audit.baseline.error.currentFingerprint',
};

/**
 * Localized text for a baseline failure.
 *
 * `baselineError` is a plain string because the UI renders it verbatim inside a
 * `role="alert"`, so the catalog is consulted when the failure happens. A later
 * locale switch does not rewrite an error the user has already read.
 *
 * `fallbackCode` names the failure for anything that is not an
 * `AuditBaselineError`: reading the file for a load, comparing for a comparison.
 */
function baselineErrorMessage(
  error: unknown,
  fallbackCode: AuditBaselineErrorCode = 'read',
): string {
  const locale = useI18nStore.getState().locale;
  const code = error instanceof AuditBaselineError ? error.code : fallbackCode;
  return translate(locale, BASELINE_ERROR_KEYS[code], {
    detail: error instanceof AuditBaselineError ? (error.detail ?? '') : errorMessage(error),
    index: error instanceof AuditBaselineError ? (error.findingIndex ?? 0) : 0,
  });
}

/** Outcome of one comparison attempt: the comparison, or why it is missing. */
interface AuditComparisonResult {
  comparison: AuditBaselineComparison | null;
  /** Localized reason the comparison could not be built, or null. */
  error: string | null;
}

/**
 * Compare `report` with an already-validated baseline.
 *
 * A comparison failure must not fail the audit run — the report and the loaded
 * baseline both stay usable — but it must not be silent either: a current
 * report from an engine that predates fingerprints leaves the baseline loaded
 * with no counts, and the only useful message is "re-run the audit". The reason
 * is returned instead of thrown so `runAudit` and `loadBaselineFile` agree.
 */
function compareWithBaseline(report: AuditReport, baseline: AuditReport): AuditComparisonResult {
  try {
    return { comparison: compareAuditReports(report, baseline), error: null };
  } catch (error) {
    return {
      comparison: null,
      error: baselineErrorMessage(error, 'current-fingerprint'),
    };
  }
}

export const useAuditStore = create<AuditState>((set, get) => ({
  ...createInitialState(),

  open: (filePath, fileName) => {
    const state = get();

    if (state.filePath !== filePath) {
      // A different document: drop the old report, filter and selection, and
      // invalidate a run that is still walking the previous file. The baseline
      // belongs to the previous document, so it goes too.
      nextRun();
      set({
        active: true,
        filePath,
        fileName,
        report: null,
        selected: null,
        progress: null,
        error: null,
        loading: false,
        filter: { ...DEFAULT_AUDIT_FILTER },
        baseline: null,
        comparison: null,
        baselineError: null,
        baselineOnly: false,
      });
      void get().runAudit();
      return;
    }

    // Same document: keep a completed report (no duplicate work) and keep
    // waiting for a run that is already in flight.
    set({ active: true, fileName });
    if (!state.report && !state.loading) {
      void get().runAudit();
    }
  },

  runAudit: async () => {
    if (!get().filePath) return;

    const token = nextRun();
    set({ loading: true, error: null, progress: null });

    try {
      const documentResult = await ipc.auditDocument();
      // Superseded while the document pass was in flight (close/reset/open):
      // never publish a result for a run the user already left.
      if (token !== currentRun) return;

      const total = normalizePageCount(documentResult.document.pages);
      let findings: AuditFinding[] = [...documentResult.findings];
      set({ progress: { done: 0, total } });

      for (let start = 1; start <= total; start += AUDIT_PAGE_BATCH_SIZE) {
        const end = Math.min(start + AUDIT_PAGE_BATCH_SIZE - 1, total);
        const pageResult = await ipc.auditPages(start, end);
        if (token !== currentRun) return;

        findings = findings.concat(pageResult.findings);
        set({ progress: { done: end, total } });
      }

      if (token !== currentRun) return;

      const ordered = orderAuditFindings(findings);
      const report = buildAuditReport(documentResult.document, ordered, documentResult.tool);
      const selected = get().selected;
      // A loaded baseline survives the re-run: comparing the fresh report with
      // it is the reason it was loaded. Without a baseline there is nothing to
      // compare, and a load error stays until the user dismisses it.
      const baseline = get().baseline;
      const compared = baseline ? compareWithBaseline(report, baseline.report) : null;
      // A successful comparison clears a stale message; a failed one explains
      // itself. Only a run with no baseline leaves the message alone.
      const baselineError = compared ? compared.error : get().baselineError;

      set({
        report,
        loading: false,
        progress: null,
        error: null,
        comparison: compared ? compared.comparison : null,
        baselineError,
        // A new result may no longer contain the selected finding; match on the
        // contract fields so an identical finding from a fresh run is kept.
        selected: selected
          ? (ordered.find((finding) => sameFinding(finding, selected)) ?? null)
          : null,
      });
    } catch (error) {
      if (token !== currentRun) return;
      // The report (and therefore the comparison a previous run produced) is
      // left untouched: a failed re-run does not invalidate what is on screen.
      set({
        loading: false,
        progress: null,
        error: errorMessage(error),
      });
    }
  },

  close: () => {
    // The report stays for a same-file reopen; the run does not.
    nextRun();
    set({ active: false, loading: false, progress: null });
  },

  reset: () => {
    nextRun();
    set(createInitialState());
  },

  setFilter: (patch) =>
    set((state) => ({
      filter: {
        severity: patch.severity ?? state.filter.severity,
        category: patch.category ?? state.filter.category,
      },
    })),

  selectFinding: (finding) => set({ selected: finding }),

  loadBaselineFile: async (file) => {
    const current = get();
    // Nothing to compare with: the UI disables the button, this is the guard.
    if (!current.report) return;

    const filePath = current.filePath;
    let report: AuditReport;
    try {
      report = parseAuditBaselineReport(await file.text());
    } catch (error) {
      // Keep whatever was loaded before: a bad file never blanks a good
      // baseline, and the error is separate from the audit-run error.
      set({ baselineError: baselineErrorMessage(error) });
      return;
    }

    const afterRead = get();
    // The document changed while the file was being read; the baseline belonged
    // to the file the user has already left.
    if (afterRead.filePath !== filePath || !afterRead.report) return;

    // The file is valid, so the baseline is loaded even when the comparison
    // cannot be built: a current report without fingerprints reports why the
    // counts are missing instead of dropping them silently.
    const compared = compareWithBaseline(afterRead.report, report);

    set({
      baseline: { fileName: file.name || 'baseline.json', report },
      comparison: compared.comparison,
      baselineError: compared.error,
    });
  },

  clearBaseline: () =>
    set({ baseline: null, comparison: null, baselineError: null, baselineOnly: false }),

  clearBaselineError: () => set({ baselineError: null }),

  setBaselineOnly: (value) => set({ baselineOnly: value }),
}));
