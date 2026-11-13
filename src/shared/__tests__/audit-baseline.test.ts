import { describe, expect, it } from 'vitest';
import {
  AUDIT_BASELINE_STATUSES,
  AuditBaselineError,
  auditBaselineFixedFindings,
  auditBaselineStatuses,
  compareAuditReports,
  isAuditBaselineNew,
  isAuditFingerprint,
  parseAuditBaselineReport,
  validateAuditBaselineReport,
} from '../audit-baseline';
import {
  buildAuditReport,
  type AuditDocumentInfo,
  type AuditFinding,
  type AuditReport,
} from '../audit-types';

const TOOL = { name: 'pdf-inspector', version: '0.3.3' };

function makeDocument(pages = 3): AuditDocumentInfo {
  return {
    pages,
    version: '1.7',
    encrypted: false,
    title: 'Quarterly report',
    author: null,
    producer: 'pdf-inspector tests',
    language: 'en-US',
    tagged: true,
  };
}

/** A valid 32-character lowercase hex fingerprint, distinct per `seed`. */
function fingerprint(seed: number | string): string {
  const hex = typeof seed === 'number' ? seed.toString(16) : seed;
  return hex.padStart(32, '0').slice(-32).toLowerCase();
}

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    category: 'fonts',
    severity: 'warning',
    page: 1,
    title: 'Font not embedded: Inter',
    detail: 'Inter is referenced but not embedded.',
    evidence: 'Inter, Regular, 400',
    recommendation: 'Embed Inter.',
    fingerprint: fingerprint(1),
    ...overrides,
  };
}

function makeReport(findings: AuditFinding[], pages = 3): AuditReport {
  return buildAuditReport(makeDocument(pages), findings, TOOL);
}

function compare(current: AuditFinding[], baseline: AuditFinding[]) {
  return compareAuditReports(makeReport(current), makeReport(baseline));
}

function expectBaselineError(action: () => unknown, code: string): AuditBaselineError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditBaselineError);
    expect((error as AuditBaselineError).code).toBe(code);
    return error as AuditBaselineError;
  }
  throw new Error('expected an AuditBaselineError');
}

describe('audit baseline fingerprints', () => {
  it('accepts only 32 lowercase hex characters', () => {
    expect(isAuditFingerprint(fingerprint(1))).toBe(true);
    expect(isAuditFingerprint('0123456789abcdef0123456789abcdef')).toBe(true);

    expect(isAuditFingerprint('0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(isAuditFingerprint('0123456789abcdef0123456789abcde')).toBe(false);
    expect(isAuditFingerprint('0123456789abcdef0123456789abcdef0')).toBe(false);
    expect(isAuditFingerprint('')).toBe(false);
    expect(isAuditFingerprint(undefined)).toBe(false);
    expect(isAuditFingerprint(null)).toBe(false);
    expect(isAuditFingerprint(12345)).toBe(false);
  });

  it('keeps the contract status order', () => {
    expect(AUDIT_BASELINE_STATUSES).toEqual([
      'new',
      'existing',
      'moved',
      'escalated',
      'fixed',
      'waived',
    ]);
  });
});

describe('compareAuditReports', () => {
  it('reports an identical report as all existing', () => {
    const findings = [
      makeFinding({ fingerprint: fingerprint(1), page: 1 }),
      makeFinding({ fingerprint: fingerprint(2), page: 2, severity: 'error' }),
      makeFinding({ fingerprint: fingerprint(3), page: null, category: 'metadata' }),
    ];

    const comparison = compare(findings, findings.map((finding) => ({ ...finding })));

    expect(comparison.summary).toEqual({
      new: 0,
      existing: 3,
      moved: 0,
      escalated: 0,
      fixed: 0,
      waived: 0,
    });
    expect(auditBaselineStatuses(comparison)).toEqual(['existing', 'existing', 'existing']);
    expect(auditBaselineFixedFindings(comparison)).toEqual([]);
    expect(comparison.findings.map((entry) => entry.baseline !== null)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('reports two empty sides as all zeros', () => {
    const comparison = compare([], []);

    expect(comparison.summary).toEqual({
      new: 0,
      existing: 0,
      moved: 0,
      escalated: 0,
      fixed: 0,
      waived: 0,
    });
    expect(comparison.findings).toEqual([]);
    expect(comparison.current).toEqual({ pages: 3, findings: 0 });
    expect(comparison.baseline).toEqual({ pages: 3, findings: 0 });
  });

  it('reports a disjoint pair as new plus fixed, fixed in baseline order', () => {
    const current = [
      makeFinding({ fingerprint: fingerprint('aa'), title: 'Current A' }),
      makeFinding({ fingerprint: fingerprint('bb'), title: 'Current B' }),
    ];
    const baseline = [
      makeFinding({ fingerprint: fingerprint('11'), title: 'Baseline 1' }),
      makeFinding({ fingerprint: fingerprint('22'), title: 'Baseline 2' }),
    ];

    const comparison = compare(current, baseline);

    expect(comparison.summary.new).toBe(2);
    expect(comparison.summary.fixed).toBe(2);
    expect(comparison.summary.existing).toBe(0);
    expect(auditBaselineStatuses(comparison)).toEqual(['new', 'new']);
    // Fixed findings have no current row and keep baseline order.
    expect(auditBaselineFixedFindings(comparison).map((finding) => finding.title)).toEqual([
      'Baseline 1',
      'Baseline 2',
    ]);
    // Current findings come first, in report order, then the fixed ones.
    expect(comparison.findings.map((entry) => entry.status)).toEqual([
      'new',
      'new',
      'fixed',
      'fixed',
    ]);
    expect(comparison.findings[2].current).toBeNull();
  });

  it('reports a finding on another page as moved', () => {
    const current = [
      makeFinding({ fingerprint: fingerprint(7), page: 5, title: 'Low DPI image' }),
    ];
    const baseline = [
      makeFinding({ fingerprint: fingerprint(7), page: 2, title: 'Low DPI image' }),
    ];

    const comparison = compare(current, baseline);

    expect(comparison.summary).toEqual({
      new: 0,
      existing: 0,
      moved: 1,
      escalated: 0,
      fixed: 0,
      waived: 0,
    });
    expect(comparison.findings[0].status).toBe('moved');
    expect(comparison.findings[0].baseline?.page).toBe(2);
    expect(comparison.findings[0].current?.page).toBe(5);
  });

  it('pairs moved findings in page order when several share a fingerprint', () => {
    const current = [
      makeFinding({ fingerprint: fingerprint(9), page: 3 }),
      makeFinding({ fingerprint: fingerprint(9), page: 5 }),
    ];
    const baseline = [
      makeFinding({ fingerprint: fingerprint(9), page: 2 }),
      makeFinding({ fingerprint: fingerprint(9), page: 4 }),
    ];

    const comparison = compare(current, baseline);

    expect(comparison.summary.moved).toBe(2);
    expect(comparison.findings.map((entry) => entry.baseline?.page)).toEqual([2, 4]);
  });

  it('reports a severity increase as escalated and a decrease as existing', () => {
    const current = [
      makeFinding({ fingerprint: fingerprint(3), severity: 'warning', page: 1 }),
      makeFinding({ fingerprint: fingerprint(4), severity: 'info', page: 1 }),
      makeFinding({ fingerprint: fingerprint(5), severity: 'error', page: 1 }),
    ];
    const baseline = [
      makeFinding({ fingerprint: fingerprint(3), severity: 'info', page: 1 }),
      makeFinding({ fingerprint: fingerprint(4), severity: 'warning', page: 1 }),
      makeFinding({ fingerprint: fingerprint(5), severity: 'error', page: 1 }),
    ];

    const comparison = compare(current, baseline);

    expect(auditBaselineStatuses(comparison)).toEqual(['escalated', 'existing', 'existing']);
    expect(comparison.summary.escalated).toBe(1);
    expect(comparison.summary.existing).toBe(2);
  });

  it('escalates a moved finding instead of reporting it as moved', () => {
    const current = [makeFinding({ fingerprint: fingerprint(8), severity: 'error', page: 4 })];
    const baseline = [makeFinding({ fingerprint: fingerprint(8), severity: 'info', page: 2 })];

    const comparison = compare(current, baseline);

    expect(comparison.findings[0].status).toBe('escalated');
    expect(comparison.summary.moved).toBe(0);
    expect(comparison.summary.escalated).toBe(1);
    // The pair is still kept, so the page change stays visible in the artifact.
    expect(comparison.findings[0].baseline?.page).toBe(2);
  });

  it('pairs duplicate findings on the same page one-to-one', () => {
    const duplicate = () =>
      makeFinding({
        fingerprint: fingerprint(42),
        page: 2,
        title: 'Page 2 has no content',
        detail: 'Page 2 draws nothing.',
        evidence: null,
        recommendation: null,
        category: 'pages',
        severity: 'info',
      });

    const comparison = compare([duplicate(), duplicate(), duplicate()], [duplicate(), duplicate()]);

    expect(auditBaselineStatuses(comparison)).toEqual(['existing', 'existing', 'new']);
    expect(comparison.summary.existing).toBe(2);
    expect(comparison.summary.new).toBe(1);
    expect(comparison.summary.fixed).toBe(0);
  });

  it('pairs document-level findings (page null) with each other only', () => {
    const documentFinding = makeFinding({
      fingerprint: fingerprint(12),
      page: null,
      category: 'metadata',
      title: 'Missing language',
    });

    const samePage = compare([documentFinding], [{ ...documentFinding }]);
    expect(samePage.findings[0].status).toBe('existing');

    const otherPage = compare(
      [{ ...documentFinding, page: 4 }],
      [{ ...documentFinding, page: null }],
    );
    expect(otherPage.findings[0].status).toBe('moved');
  });

  it('counts the sides and keeps the current report tool block', () => {
    const comparison = compareAuditReports(
      makeReport([makeFinding({ fingerprint: fingerprint(1) })], 12),
      makeReport([makeFinding({ fingerprint: fingerprint(1) }), makeFinding({ fingerprint: fingerprint(2) })], 11),
    );

    expect(comparison.schemaVersion).toBe(1);
    expect(comparison.tool).toEqual(TOOL);
    expect(comparison.current).toEqual({ pages: 12, findings: 1 });
    expect(comparison.baseline).toEqual({ pages: 11, findings: 2 });
    expect(comparison.summary).toEqual({
      new: 0,
      existing: 1,
      moved: 0,
      escalated: 0,
      fixed: 1,
      waived: 0,
    });
  });

  it('never hashes a current finding without a fingerprint', () => {
    const baseline = [makeFinding({ fingerprint: fingerprint(1) })];
    // A distinct code: the loaded baseline is fine, the audit must be re-run.
    const error = expectBaselineError(
      () => compare([makeFinding({ fingerprint: undefined })], baseline),
      'current-fingerprint',
    );

    expect(error.findingIndex).toBe(1);
    expect(error.message).toContain('current finding 1');
  });

  it('rejects a baseline finding without a fingerprint instead of hashing it', () => {
    const error = expectBaselineError(
      () =>
        compare(
          [makeFinding({ fingerprint: fingerprint(1) })],
          [makeFinding({ fingerprint: undefined })],
        ),
      'fingerprint',
    );

    expect(error.findingIndex).toBe(1);
    expect(error.message).toContain('baseline finding 1');
  });
});

describe('baseline parsing and validation', () => {
  const validReport = makeReport([makeFinding({ fingerprint: fingerprint(1) })]);

  it('accepts a report produced by the current engine', () => {
    const parsed = parseAuditBaselineReport(JSON.stringify(validReport));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].fingerprint).toBe(fingerprint(1));
  });

  it('rejects invalid JSON with the parser detail', () => {
    const error = expectBaselineError(() => parseAuditBaselineReport('{ not json'), 'json');
    expect(error.detail).not.toBeNull();
  });

  it('rejects a non-object, a non-array and a wrong schema version', () => {
    expectBaselineError(() => validateAuditBaselineReport([]), 'schema');
    expectBaselineError(() => validateAuditBaselineReport('report'), 'schema');
    expectBaselineError(() => validateAuditBaselineReport(null), 'schema');
    expectBaselineError(() => validateAuditBaselineReport({ schemaVersion: 2, findings: [] }), 'schema');
    expectBaselineError(() => validateAuditBaselineReport({ schemaVersion: '1', findings: [] }), 'schema');
    expectBaselineError(() => validateAuditBaselineReport({ schemaVersion: 1 }), 'schema');
    expectBaselineError(
      () => validateAuditBaselineReport({ schemaVersion: 1, findings: 'none' }),
      'schema',
    );
    expectBaselineError(
      () => validateAuditBaselineReport({ schemaVersion: 1, findings: ['finding'] }),
      'schema',
    );
  });

  it('rejects a legacy report whose findings carry no fingerprint', () => {
    const legacy = {
      schemaVersion: 1,
      findings: [{ ...makeFinding(), fingerprint: undefined, title: 'Legacy finding' }],
    };

    const error = expectBaselineError(() => validateAuditBaselineReport(legacy), 'fingerprint');

    expect(error.findingIndex).toBe(1);
    expect(error.message).toContain('regenerate the baseline with the current CLI');
  });

  it('rejects a fingerprint that is not 32 lowercase hex characters', () => {
    const uppercase = {
      schemaVersion: 1,
      findings: [{ ...makeFinding(), fingerprint: fingerprint('abcdef').toUpperCase() }],
    };
    expectBaselineError(() => validateAuditBaselineReport(uppercase), 'fingerprint');
  });

  it('rejects the BaselineComparison artefact from --baseline-output', () => {
    const finding = makeFinding({ fingerprint: fingerprint(1) });
    const comparison = compareAuditReports(makeReport([finding]), makeReport([finding]));

    const fromParsed = expectBaselineError(
      () => validateAuditBaselineReport(comparison),
      'schema',
    );
    expect(fromParsed.message).toContain('BaselineComparison, not an AuditReport');

    const fromText = expectBaselineError(
      () => parseAuditBaselineReport(JSON.stringify(comparison)),
      'schema',
    );
    expect(fromText.message).toContain('BaselineComparison, not an AuditReport');
  });

  it('rejects comparison entries inside a findings array', () => {
    // Same `schemaVersion` and `findings`, but each entry wraps a finding and
    // carries a status: counting those would report on the wrapper objects.
    const wrapped = {
      schemaVersion: 1,
      findings: [
        {
          status: 'existing',
          fingerprint: fingerprint(1),
          current: makeFinding({ fingerprint: fingerprint(1) }),
          baseline: makeFinding({ fingerprint: fingerprint(1) }),
        },
      ],
    };

    const error = expectBaselineError(() => validateAuditBaselineReport(wrapped), 'schema');
    expect(error.message).toContain('BaselineComparison');
    expect(error.message).toContain('baseline finding 1');
  });

  it('requires every finding to be finding-shaped', () => {
    const withEntry = (patch: Record<string, unknown>) => ({
      schemaVersion: 1,
      findings: [{ ...makeFinding({ fingerprint: fingerprint(1) }), ...patch }],
    });

    const cases: Array<[string, Record<string, unknown>]> = [
      ['category', { category: 'not-a-category' }],
      ['severity', { severity: 'critical' }],
      ['title', { title: 42 }],
      ['detail', { detail: null }],
      ['page', { page: 0 }],
      ['page', { page: -2 }],
      ['page', { page: 1.5 }],
      ['page', { page: '2' }],
      ['evidence', { evidence: 42 }],
      ['recommendation', { recommendation: {} }],
    ];

    for (const [field, patch] of cases) {
      const error = expectBaselineError(
        () => validateAuditBaselineReport(withEntry(patch)),
        'schema',
      );
      expect(error.message, JSON.stringify(patch)).toContain('is not an AuditFinding');
      expect(error.detail, JSON.stringify(patch)).toContain(field);
    }
  });

  it('accepts document-level and page findings with nullable optionals', () => {
    const report = {
      schemaVersion: 1,
      findings: [
        makeFinding({ fingerprint: fingerprint(1), page: null, evidence: null, recommendation: null }),
        makeFinding({ fingerprint: fingerprint(2), page: 3 }),
      ],
    };

    expect(() => validateAuditBaselineReport(report)).not.toThrow();
  });
});

describe('baseline helpers', () => {
  it('keeps statuses aligned with the current finding indexes', () => {
    const comparison = compare(
      [
        makeFinding({ fingerprint: fingerprint(1), page: 1 }),
        makeFinding({ fingerprint: fingerprint(2), page: 2 }),
        makeFinding({ fingerprint: fingerprint(3), page: 3 }),
      ],
      [
        makeFinding({ fingerprint: fingerprint(2), page: 2 }),
        makeFinding({ fingerprint: fingerprint(3), page: 9 }),
      ],
    );

    expect(auditBaselineStatuses(comparison)).toEqual(['new', 'existing', 'moved']);
  });

  it('treats only new and escalated as new for the New only filter', () => {
    expect(isAuditBaselineNew('new')).toBe(true);
    expect(isAuditBaselineNew('escalated')).toBe(true);
    expect(isAuditBaselineNew('existing')).toBe(false);
    expect(isAuditBaselineNew('moved')).toBe(false);
    expect(isAuditBaselineNew('fixed')).toBe(false);
    expect(isAuditBaselineNew('waived')).toBe(false);
  });
});
