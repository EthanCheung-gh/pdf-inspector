import { describe, expect, it } from 'vitest';
import {
  AUDIT_CATEGORIES,
  AUDIT_SEVERITIES,
  buildAuditReport,
  summarizeAuditFindings,
  type AuditDocumentInfo,
  type AuditFinding,
  type AuditTool,
} from '../audit-types';

const DOCUMENT: AuditDocumentInfo = {
  pages: 3,
  version: '1.7',
  encrypted: false,
  title: 'Quarterly report',
  author: null,
  producer: 'pdf-inspector tests',
  language: 'en-US',
  tagged: true,
};

const TOOL: AuditTool = { name: 'pdf-inspector', version: '0.2.0' };

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    category: 'fonts',
    severity: 'info',
    page: null,
    title: 'Font metadata missing',
    detail: 'A font has no metadata.',
    evidence: null,
    recommendation: null,
    ...overrides,
  };
}

describe('audit contract constants', () => {
  it('keeps the documented severity and category order', () => {
    expect(AUDIT_SEVERITIES).toEqual(['error', 'warning', 'info']);
    expect(AUDIT_CATEGORIES).toEqual([
      'fonts',
      'pages',
      'images',
      'metadata',
      'structure',
      'security',
    ]);
  });
});

describe('summarizeAuditFindings', () => {
  it('returns zeros for an empty audit', () => {
    expect(summarizeAuditFindings([])).toEqual({
      total: 0,
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it('counts each severity and keeps the total equal to the finding count', () => {
    const summary = summarizeAuditFindings([
      makeFinding({ severity: 'error', title: 'Broken xref' }),
      makeFinding({ severity: 'warning', title: 'Font not embedded: Helvetica' }),
      makeFinding({ severity: 'warning', title: 'Low DPI image', page: 2 }),
      makeFinding({ severity: 'info', title: 'Missing title' }),
      makeFinding({ severity: 'info', title: 'Non-zero rotation', page: 1 }),
    ]);

    expect(summary).toEqual({ total: 5, errors: 1, warnings: 2, info: 2 });
  });
});

describe('buildAuditReport', () => {
  it('wraps the document pass in a schemaVersion 1 report', () => {
    const findings = [makeFinding({ severity: 'warning' })];
    const report = buildAuditReport(DOCUMENT, findings, TOOL);

    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toBe(TOOL);
    expect(report.document).toBe(DOCUMENT);
    expect(report.summary).toEqual({ total: 1, errors: 0, warnings: 1, info: 0 });
    expect(report.findings).toEqual(findings);
  });

  it('copies the findings so later array changes cannot alter the report', () => {
    const findings = [makeFinding()];
    const report = buildAuditReport(DOCUMENT, findings, TOOL);

    findings.push(makeFinding({ title: 'Late finding' }));

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].title).toBe('Font metadata missing');
    expect(report.summary.total).toBe(1);
  });

  it('preserves the order it is given (the store merges into contract order)', () => {
    const findings = [
      makeFinding({ category: 'security', title: 'Encrypted' }),
      makeFinding({ category: 'fonts', title: 'Font not embedded: Inter' }),
    ];

    expect(buildAuditReport(DOCUMENT, findings, TOOL).findings.map((f) => f.category)).toEqual([
      'security',
      'fonts',
    ]);
  });
});
