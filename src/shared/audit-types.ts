/**
 * Document-audit data contract shared by the main process, the preload bridge,
 * the web server, the browser adapter and the renderer.
 *
 * It lives in src/shared (not src/renderer/types) so the composite node
 * tsconfig project can import it without pulling renderer files in — the same
 * reason `SaveFileRequest` lives in src/shared/constants.ts and the diff
 * contract lives in src/shared/diff-types.ts.
 *
 * The engine (`sidecar/audit.py`) serialises this contract directly: field
 * names are camelCase on both sides, findings are deterministic and carry no
 * timestamps or absolute paths, and `schemaVersion` is bumped only when the
 * report shape changes.
 */

export type AuditSeverity = 'error' | 'warning' | 'info';

export type AuditCategory =
  | 'fonts'
  | 'pages'
  | 'images'
  | 'metadata'
  | 'structure'
  | 'security';

export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['error', 'warning', 'info'];

/**
 * Category order used when merging document-level and page-batch findings.
 * The engine reports findings in this order, so the merged report does too.
 */
export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'fonts',
  'pages',
  'images',
  'metadata',
  'structure',
  'security',
];

export interface AuditFinding {
  category: AuditCategory;
  severity: AuditSeverity;
  /** 1-based page number, or `null` for a document-level finding. */
  page: number | null;
  title: string;
  detail: string;
  /** Concrete measured values (sizes, DPI, font names), or `null`. */
  evidence: string | null;
  /** Suggested fix, or `null` when the finding is diagnostic only. */
  recommendation: string | null;
  /**
   * Stable identity of the finding: 32 lowercase hex characters.
   *
   * Computed by the engine from `category`, `title`, `detail` and `evidence`
   * only, so moving a finding to another page, changing its severity or
   * rewording its recommendation does not change it. Reports produced before
   * fingerprints existed omit the field; the CLI fills it in for a baseline.
   */
  fingerprint?: string;
}

export interface AuditDocumentInfo {
  pages: number;
  version: string;
  encrypted: boolean;
  title: string | null;
  author: string | null;
  producer: string | null;
  language: string | null;
  tagged: boolean;
}

export interface AuditSummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
}

export interface AuditTool {
  name: string;
  version: string;
}

export interface AuditDocumentResult {
  tool: AuditTool;
  document: AuditDocumentInfo;
  findings: AuditFinding[];
}

export interface AuditPagesResult {
  tool: AuditTool;
  findings: AuditFinding[];
}

export interface AuditReport {
  schemaVersion: 1;
  tool: AuditTool;
  document: AuditDocumentInfo;
  summary: AuditSummary;
  findings: AuditFinding[];
}

/**
 * How one current finding relates to a baseline report.
 *
 * `moved` means the same fingerprint appeared on a different page, `escalated`
 * means a paired finding's severity rank rose (`info` < `warning` < `error`),
 * and `fixed` only appears on a baseline finding that is no longer current.
 * `waived` is reserved for an accepted waiver; S1 reports it as `0`.
 */
export type AuditBaselineStatus =
  | 'new'
  | 'existing'
  | 'moved'
  | 'escalated'
  | 'fixed'
  | 'waived';

/**
 * One accepted waiver that suppressed a finding (see `sidecar/waivers.py`).
 *
 * `page` is omitted when the waiver applies to the fingerprint on any page;
 * `expires` is the last day the waiver is valid (`YYYY-MM-DD`, inclusive).
 */
export interface AuditBaselineWaiver {
  fingerprint: string;
  page?: number | null;
  reason: string;
  expires: string;
}

/** Waiver bookkeeping of one comparison: applied, expired and unused entries. */
export interface AuditBaselineWaiverCounts {
  applied: number;
  expired: number;
  unused: number;
}

/** Per-status counts of a `BaselineComparison`, in contract order. */
export interface AuditBaselineCounts {
  new: number;
  existing: number;
  moved: number;
  escalated: number;
  fixed: number;
  waived: number;
}

/** Page and finding totals for one side of a comparison. */
export interface AuditBaselineSideSummary {
  pages: number;
  findings: number;
}

/**
 * One compared finding: the current finding (or `null` for `fixed`) plus the
 * matched baseline finding (or `null` for `new`). Both carry the full
 * `AuditFinding` so a consumer never has to re-read either report.
 */
export interface AuditBaselineFinding {
  status: AuditBaselineStatus;
  fingerprint: string;
  current: AuditFinding | null;
  baseline: AuditFinding | null;
  /**
   * The waiver that accepted this finding, when one applied. Only `waived`
   * entries carry it; older producers omit the field.
   */
  waiver?: AuditBaselineWaiver | null;
}

/**
 * The `--baseline-output` payload (see `sidecar/baseline.py`).
 *
 * Deterministic: current findings appear in report order, then fixed baseline
 * findings in baseline order; no timestamps or absolute paths are included.
 */
export interface AuditBaselineComparison {
  schemaVersion: 1;
  tool: AuditTool;
  current: AuditBaselineSideSummary;
  baseline: AuditBaselineSideSummary;
  summary: AuditBaselineCounts;
  findings: AuditBaselineFinding[];
  /** Waiver bookkeeping; only producers that loaded a waiver file set it. */
  waivers?: AuditBaselineWaiverCounts;
}

/**
 * Count findings by severity.
 *
 * `total` is the number of findings, so a report can always show a consistent
 * "errors / warnings / info / total" line without re-walking the list.
 */
export function summarizeAuditFindings(findings: AuditFinding[]): AuditSummary {
  const summary: AuditSummary = {
    total: findings.length,
    errors: 0,
    warnings: 0,
    info: 0,
  };

  for (const finding of findings) {
    switch (finding.severity) {
      case 'error':
        summary.errors += 1;
        break;
      case 'warning':
        summary.warnings += 1;
        break;
      case 'info':
        summary.info += 1;
        break;
    }
  }

  return summary;
}

/**
 * Assemble the exported/displayed report from the document pass plus the merged
 * page findings.
 *
 * The findings array is copied, so later `push`/`splice` on the caller's array
 * cannot change a report after the fact (the summary is computed from the same
 * copy). Ordering is the caller's responsibility: `useAuditStore` merges
 * document and page-batch findings into the contract's category/page/title
 * order before calling this.
 */
export function buildAuditReport(
  document: AuditDocumentInfo,
  findings: AuditFinding[],
  tool: AuditTool,
): AuditReport {
  const orderedFindings = [...findings];
  return {
    schemaVersion: 1,
    tool,
    document,
    summary: summarizeAuditFindings(orderedFindings),
    findings: orderedFindings,
  };
}
