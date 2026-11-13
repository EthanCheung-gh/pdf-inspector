/**
 * Baseline comparison for the Audit workspace.
 *
 * A pure port of `sidecar/baseline.py` (S1) to TypeScript: the `Findings` view
 * compares the current `AuditReport` with a baseline JSON the user picked, using
 * the stable `fingerprint` the engine already wrote into every finding.
 *
 * Deliberately fingerprint-free: nothing here hashes anything. A report without
 * a 32-character lowercase hex fingerprint is rejected (`AuditBaselineError`)
 * instead of being hashed a second time in another language, because two
 * implementations would eventually drift and silently compare the wrong
 * findings. The fix is always "regenerate the baseline with the current CLI".
 *
 * Kept free of React/Zustand and of `File`/DOM APIs so both the renderer and a
 * Node test can use it. The store owns reading the file and the UI owns the
 * wording; this module only owns the comparison rules:
 *
 * 1. current and baseline findings on the same page pair as `existing`;
 * 2. the remaining same-fingerprint findings pair in page order as `moved`;
 * 3. unmatched current findings are `new`, unmatched baseline findings `fixed`;
 * 4. a paired finding whose severity rank rose (`info` < `warning` < `error`)
 *    becomes `escalated`, overriding `existing`/`moved`;
 * 5. `waived` is reserved for accepted waivers (S2); this module reports it as
 *    `0` so the summary keeps the shape consumers rely on.
 *
 * Findings are matched as a multiset, so two identical findings on the same page
 * pair one-to-one instead of collapsing into a single match.
 */
import {
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  type AuditBaselineComparison,
  type AuditBaselineCounts,
  type AuditBaselineFinding,
  type AuditBaselineStatus,
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type AuditSeverity,
  type AuditTool,
} from './audit-types';

/** Lowercase hex, exactly what `sidecar/audit.py` writes (32 chars). */
export const AUDIT_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

/** Status order of `AuditBaselineCounts` / `audit.baseline.count.*`. */
export const AUDIT_BASELINE_STATUSES: readonly AuditBaselineStatus[] = [
  'new',
  'existing',
  'moved',
  'escalated',
  'fixed',
  'waived',
];

/**
 * Severity ranks: only a strict increase is an escalation. An unknown severity
 * ranks as `info`, so a malformed report cannot manufacture an escalation.
 */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  error: 2,
  warning: 1,
  info: 0,
};

/** Why a baseline file or report was rejected. */
export type AuditBaselineErrorCode =
  /** The file could not be read at all. */
  | 'read'
  /** The text is not valid JSON. */
  | 'json'
  /** The JSON is not an `AuditReport`-shaped object. */
  | 'schema'
  /** A baseline finding has no usable `fingerprint`. */
  | 'fingerprint'
  /**
   * The *current* report has findings without a fingerprint.
   *
   * A separate code because the fix is the opposite one: the loaded baseline is
   * fine, the audit itself must be re-run with the current engine.
   */
  | 'current-fingerprint';

/**
 * A baseline input that cannot be compared.
 *
 * Carries a machine-readable `code` so the store can show a localized message,
 * plus the technical detail / finding position for diagnosis. Subclasses
 * `Error` so a plain `catch` still reports it like any other failure.
 */
export class AuditBaselineError extends Error {
  readonly code: AuditBaselineErrorCode;

  /** Technical detail (JSON parser text, which field failed, …) or `null`. */
  readonly detail: string | null;

  /** 1-based position of the offending finding, or `null`. */
  readonly findingIndex: number | null;

  constructor(
    code: AuditBaselineErrorCode,
    message: string,
    options: { detail?: string | null; findingIndex?: number | null } = {},
  ) {
    super(message);
    this.name = 'AuditBaselineError';
    this.code = code;
    this.detail = options.detail ?? null;
    this.findingIndex = options.findingIndex ?? null;
  }
}

/** True for exactly the fingerprints the engine produces. */
export function isAuditFingerprint(value: unknown): value is string {
  return typeof value === 'string' && AUDIT_FINGERPRINT_PATTERN.test(value);
}

/**
 * Parse and validate a baseline file's text.
 *
 * The file must be an `AuditReport` (`sidecar/audit.py --format json`), not the
 * `BaselineComparison` that `--baseline-output` writes: the two share
 * `schemaVersion` and `findings`, so the shape of each finding is checked.
 * Throws `AuditBaselineError` on anything else.
 */
export function parseAuditBaselineReport(text: string): AuditReport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AuditBaselineError(
      'json',
      `baseline is not valid JSON: ${describeError(error)}`,
      { detail: describeError(error) },
    );
  }

  return validateAuditBaselineReport(data);
}

/**
 * Validate an already-parsed baseline value (see `parseAuditBaselineReport`).
 *
 * Only the fields the comparison and the row display need are checked; the
 * document/tool blocks are carried through untouched.
 */
export function validateAuditBaselineReport(data: unknown): AuditReport {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AuditBaselineError(
      'schema',
      'baseline must be an AuditReport JSON object with schemaVersion 1 and a findings array',
      { detail: 'not a JSON object' },
    );
  }

  const record = data as Record<string, unknown>;

  if (record.schemaVersion !== 1) {
    throw new AuditBaselineError(
      'schema',
      `baseline must have schemaVersion 1, got ${JSON.stringify(record.schemaVersion)}`,
      { detail: `schemaVersion ${JSON.stringify(record.schemaVersion)}` },
    );
  }

  // `BaselineComparison` has the same `schemaVersion`, `tool`, `summary` and
  // `findings` as a report, so `current`/`baseline` are the only reliable
  // difference at the top level (`summary` is shared, so it is not checked).
  if ('current' in record || 'baseline' in record) {
    throw comparisonArtifactError('baseline file');
  }

  const findings = record.findings;
  if (!Array.isArray(findings)) {
    throw new AuditBaselineError(
      'schema',
      'baseline must contain a findings array',
      { detail: 'findings is not an array' },
    );
  }

  findings.forEach((finding, index) => {
    if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
      throw new AuditBaselineError(
        'schema',
        `baseline finding ${index + 1} must be a JSON object`,
        { detail: `finding ${index + 1} is not an object` },
      );
    }

    const entry = finding as Record<string, unknown>;

    // A `BaselineComparison.findings[]` entry wraps the real findings and adds
    // a status; accepting it would produce counts for the wrong objects.
    if ('status' in entry || 'current' in entry || 'baseline' in entry) {
      throw comparisonArtifactError(`baseline finding ${index + 1}`);
    }

    assertFindingShape(entry, index + 1);

    if (!isAuditFingerprint(entry.fingerprint)) {
      throw new AuditBaselineError(
        'fingerprint',
        `baseline finding ${index + 1} has no 32-character fingerprint; ` +
          'regenerate the baseline with the current CLI',
        { findingIndex: index + 1 },
      );
    }
  });

  return data as AuditReport;
}

/** The "you passed the wrong artefact" message, shared by both checks. */
function comparisonArtifactError(where: string): AuditBaselineError {
  return new AuditBaselineError(
    'schema',
    `${where} is a BaselineComparison, not an AuditReport; ` +
      'load the report produced by `pdf-inspector audit --format json`',
    { detail: 'BaselineComparison instead of AuditReport' },
  );
}

/** Every finding must look like `AuditFinding`, not like a comparison entry. */
function assertFindingShape(entry: Record<string, unknown>, position: number): void {
  const reject = (detail: string): never => {
    throw new AuditBaselineError(
      'schema',
      `baseline finding ${position} is not an AuditFinding: ${detail}`,
      { detail: `finding ${position}: ${detail}` },
    );
  };

  if (!AUDIT_CATEGORIES.includes(entry.category as AuditCategory)) {
    reject(`category ${JSON.stringify(entry.category)} is not an audit category`);
  }
  if (!AUDIT_SEVERITIES.includes(entry.severity as AuditSeverity)) {
    reject(`severity ${JSON.stringify(entry.severity)} is not an audit severity`);
  }
  if (typeof entry.title !== 'string') reject('title is not a string');
  if (typeof entry.detail !== 'string') reject('detail is not a string');

  const page = entry.page;
  if (page !== null && !(typeof page === 'number' && Number.isInteger(page) && page > 0)) {
    reject(`page ${JSON.stringify(page)} is neither null nor a positive integer`);
  }

  for (const optional of ['evidence', 'recommendation'] as const) {
    const value = entry[optional];
    if (value !== null && typeof value !== 'string') {
      reject(`${optional} is neither null nor a string`);
    }
  }
}

/**
 * Compare `current` against `baseline` and return the S1 `BaselineComparison`.
 *
 * The result is the same artefact `sidecar/baseline.py --baseline-output`
 * writes: current findings in report order first (each with its status), then
 * the `fixed` baseline findings in baseline order. `auditBaselineStatuses()`
 * projects the current-order statuses out of it.
 */
export function compareAuditReports(
  current: AuditReport,
  baseline: AuditReport,
): AuditBaselineComparison {
  const currentFindings = current.findings ?? [];
  const baselineFindings = baseline.findings ?? [];
  assertFingerprints(currentFindings, 'current');
  assertFingerprints(baselineFindings, 'baseline');

  const statuses: AuditBaselineStatus[] = new Array(currentFindings.length);
  /** baseline index matched to each current index, or null. */
  const paired: Array<number | null> = new Array(currentFindings.length).fill(null);
  const matchedBaseline = new Set<number>();

  const currentByFingerprint = groupByFingerprint(currentFindings);
  const baselineByFingerprint = groupByFingerprint(baselineFindings);

  for (const [fingerprint, currentIndices] of currentByFingerprint) {
    const baselineIndices = baselineByFingerprint.get(fingerprint);
    if (!baselineIndices) {
      for (const index of currentIndices) statuses[index] = 'new';
      continue;
    }

    // 1. Same fingerprint + same page pairs first (multiset: duplicates kept).
    const baselineByPage = new Map<string, number[]>();
    for (const index of baselineIndices) {
      const key = pageKey(baselineFindings[index]);
      const list = baselineByPage.get(key);
      if (list) list.push(index);
      else baselineByPage.set(key, [index]);
    }

    const remainingCurrent: number[] = [];
    for (const index of currentIndices) {
      const candidates = baselineByPage.get(pageKey(currentFindings[index]));
      if (candidates && candidates.length > 0) {
        const baselineIndex = candidates.shift() as number;
        statuses[index] = 'existing';
        paired[index] = baselineIndex;
        matchedBaseline.add(baselineIndex);
      } else {
        remainingCurrent.push(index);
      }
    }

    // 2. Remaining same-fingerprint findings pair in page order: moved.
    const remainingBaseline = baselineIndices.filter((index) => !matchedBaseline.has(index));
    remainingCurrent.sort(
      (left, right) => pageRank(currentFindings[left]) - pageRank(currentFindings[right]),
    );
    remainingBaseline.sort(
      (left, right) => pageRank(baselineFindings[left]) - pageRank(baselineFindings[right]),
    );
    const pairCount = Math.min(remainingCurrent.length, remainingBaseline.length);
    for (let position = 0; position < pairCount; position += 1) {
      const index = remainingCurrent[position];
      const baselineIndex = remainingBaseline[position];
      statuses[index] = 'moved';
      paired[index] = baselineIndex;
      matchedBaseline.add(baselineIndex);
    }

    // 3. Unmatched current findings are new.
    for (const index of remainingCurrent.slice(pairCount)) statuses[index] = 'new';
  }

  // 4. A severity increase overrides existing/moved; a decrease keeps the pair.
  for (let index = 0; index < currentFindings.length; index += 1) {
    const baselineIndex = paired[index];
    if (baselineIndex === null) continue;
    if (
      severityRank(currentFindings[index]) > severityRank(baselineFindings[baselineIndex])
    ) {
      statuses[index] = 'escalated';
    }
  }

  const findings: AuditBaselineFinding[] = currentFindings.map((finding, index) => {
    const baselineIndex = paired[index];
    return {
      status: statuses[index],
      fingerprint: finding.fingerprint as string,
      current: finding,
      baseline: baselineIndex === null ? null : baselineFindings[baselineIndex],
    };
  });

  // 5. Unmatched baseline findings are fixed, in baseline order.
  for (let index = 0; index < baselineFindings.length; index += 1) {
    if (matchedBaseline.has(index)) continue;
    findings.push({
      status: 'fixed',
      fingerprint: baselineFindings[index].fingerprint as string,
      current: null,
      baseline: baselineFindings[index],
    });
  }

  return {
    schemaVersion: 1,
    tool: toolBlock(current),
    current: { pages: pageCount(current), findings: currentFindings.length },
    baseline: { pages: pageCount(baseline), findings: baselineFindings.length },
    summary: countStatuses(findings),
    findings,
  };
}

/**
 * Statuses in `current.findings` order.
 *
 * The comparison lists every current finding first, so this is a projection —
 * `statuses[index]` always belongs to `report.findings[index]`.
 */
export function auditBaselineStatuses(
  comparison: AuditBaselineComparison,
): AuditBaselineStatus[] {
  return comparison.findings
    .filter((entry) => entry.status !== 'fixed')
    .map((entry) => entry.status);
}

/** `fixed` baseline findings in baseline order (there is no current row for them). */
export function auditBaselineFixedFindings(
  comparison: AuditBaselineComparison,
): AuditFinding[] {
  return comparison.findings
    .filter((entry) => entry.status === 'fixed' && entry.baseline !== null)
    .map((entry) => entry.baseline as AuditFinding);
}

/** True for the statuses `New only` keeps: `new` and `escalated`. */
export function isAuditBaselineNew(status: AuditBaselineStatus): boolean {
  return status === 'new' || status === 'escalated';
}

// --- helpers ----------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject a report the comparison cannot match, instead of hashing in TS. */
function assertFingerprints(findings: AuditFinding[], side: 'current' | 'baseline'): void {
  findings.forEach((finding, index) => {
    if (!isAuditFingerprint(finding.fingerprint)) {
      throw new AuditBaselineError(
        side === 'current' ? 'current-fingerprint' : 'fingerprint',
        `${side} finding ${index + 1} has no 32-character fingerprint`,
        { findingIndex: index + 1 },
      );
    }
  });
}

function groupByFingerprint(findings: AuditFinding[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    const fingerprint = finding.fingerprint as string;
    const group = groups.get(fingerprint);
    if (group) group.push(index);
    else groups.set(fingerprint, [index]);
  });
  return groups;
}

/** Pairing key: `document` for a document-level finding, `page:N` otherwise. */
function pageKey(finding: AuditFinding): string {
  const page = finding.page;
  return typeof page === 'number' && Number.isInteger(page) ? `page:${page}` : 'document';
}

/** Document-level findings sort first, then pages ascending. */
function pageRank(finding: AuditFinding): number {
  const page = finding.page;
  return typeof page === 'number' && Number.isInteger(page) ? page : 0;
}

function severityRank(finding: AuditFinding): number {
  return SEVERITY_RANK[finding.severity] ?? SEVERITY_RANK.info;
}

function countStatuses(findings: AuditBaselineFinding[]): AuditBaselineCounts {
  const counts: AuditBaselineCounts = {
    new: 0,
    existing: 0,
    moved: 0,
    escalated: 0,
    fixed: 0,
    // Reserved for accepted waivers (S2); S1/S4 always report 0.
    waived: 0,
  };
  for (const entry of findings) counts[entry.status] += 1;
  return counts;
}

function pageCount(report: AuditReport): number {
  const pages = report.document?.pages;
  if (typeof pages !== 'number' || !Number.isFinite(pages)) return 0;
  return Math.max(Math.trunc(pages), 0);
}

function toolBlock(report: AuditReport): AuditTool {
  const tool = report.tool;
  if (tool && typeof tool.name === 'string' && typeof tool.version === 'string') return tool;
  return { name: 'pdf-inspector', version: '' };
}
