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
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
} from '../../shared/audit-types';
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

export const useAuditStore = create<AuditState>((set, get) => ({
  ...createInitialState(),

  open: (filePath, fileName) => {
    const state = get();

    if (state.filePath !== filePath) {
      // A different document: drop the old report, filter and selection, and
      // invalidate a run that is still walking the previous file.
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

      set({
        report,
        loading: false,
        progress: null,
        error: null,
        // A new result may no longer contain the selected finding; match on the
        // contract fields so an identical finding from a fresh run is kept.
        selected: selected
          ? (ordered.find((finding) => sameFinding(finding, selected)) ?? null)
          : null,
      });
    } catch (error) {
      if (token !== currentRun) return;
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
}));
