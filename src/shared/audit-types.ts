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
