import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditReport,
  type AuditDocumentInfo,
  type AuditDocumentResult,
  type AuditFinding,
  type AuditPagesResult,
  type AuditReport,
} from '../../../shared/audit-types';

const auditIpc = vi.hoisted(() => ({
  auditDocument: vi.fn(),
  auditPages: vi.fn(),
}));

// The store reaches the sidecar only through the `ipc` wrappers; mocking the
// module keeps these tests about merge/progress/supersession, not transport.
vi.mock('../../services/ipc-client', () => ({ ipc: auditIpc }));

import { useAuditStore, AUDIT_PAGE_BATCH_SIZE, type AuditProgress } from '../audit-store';

const TOOL = { name: 'pdf-inspector', version: '0.2.0' };

function makeDocument(
  pages: number,
  overrides: Partial<AuditDocumentInfo> = {},
): AuditDocumentInfo {
  return {
    pages,
    version: '1.7',
    encrypted: false,
    title: 'Report',
    author: null,
    producer: 'pdf-inspector tests',
    language: 'en-US',
    tagged: true,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    category: 'fonts',
    severity: 'info',
    page: null,
    title: 'Missing metadata',
    detail: 'The document is missing metadata.',
    evidence: null,
    recommendation: null,
    ...overrides,
  };
}

function documentResult(
  pages: number,
  findings: AuditFinding[] = [],
  document: Partial<AuditDocumentInfo> = {},
): AuditDocumentResult {
  return { tool: TOOL, document: makeDocument(pages, document), findings };
}

function pagesResult(findings: AuditFinding[]): AuditPagesResult {
  return { tool: TOOL, findings };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const store = () => useAuditStore.getState();

/** A valid 32-character lowercase hex fingerprint, distinct per `seed`. */
function fingerprint(seed: number | string): string {
  const hex = typeof seed === 'number' ? seed.toString(16) : seed;
  return hex.padStart(32, '0').slice(-32).toLowerCase();
}

/** A baseline `AuditReport` file the user could have saved from an earlier run. */
function baselineReport(findings: AuditFinding[], pages = 2): AuditReport {
  return buildAuditReport(makeDocument(pages), findings, TOOL);
}

function baselineFile(report: AuditReport, name = 'baseline.json'): File {
  return new File([JSON.stringify(report)], name, { type: 'application/json' });
}

/** Run one audit that reports exactly `findings`, so the store has a report. */
async function auditFindings(findings: AuditFinding[], pages = 2): Promise<void> {
  auditIpc.auditDocument.mockResolvedValue(documentResult(pages, findings));
  auditIpc.auditPages.mockResolvedValue(pagesResult([]));
  store().open('/docs/report.pdf', 'report.pdf');
  await settle();
}

/** Drain the microtasks of an `open()`-started run (the store never awaits it). */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (!store().loading) return;
    await Promise.resolve();
  }
  throw new Error('audit run did not settle');
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function sameProgress(
  left: AuditProgress | null,
  right: AuditProgress | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.done === right.done && left.total === right.total;
}

function dedupeProgress(values: (AuditProgress | null)[]): (AuditProgress | null)[] {
  return values.filter(
    (value, index) => index === 0 || !sameProgress(value, values[index - 1]),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  auditIpc.auditDocument.mockResolvedValue(documentResult(0));
  auditIpc.auditPages.mockResolvedValue(pagesResult([]));
});

describe('audit store run', () => {
  it('runs the document pass then 10-page batches and merges in contract order', async () => {
    const documentFindings = [
      makeFinding({ category: 'fonts', severity: 'warning', title: 'Font not embedded: Inter' }),
      makeFinding({ category: 'metadata', severity: 'info', title: 'Missing language' }),
      makeFinding({ category: 'security', severity: 'warning', title: 'Document is encrypted' }),
    ];

    auditIpc.auditDocument.mockResolvedValue(documentResult(25, documentFindings));
    // The engine reports each batch in category/page order; concatenating the
    // batches would interleave pages and images, so the store must re-sort the
    // merged list into the contract's category/page/title order.
    auditIpc.auditPages.mockImplementation(async (start: number, end: number) => {
      const findings: AuditFinding[] = [];
      for (let page = start; page <= end; page += 1) {
        findings.push(
          makeFinding({
            category: 'pages',
            severity: 'info',
            page,
            title: `Page ${page} page finding`,
          }),
        );
      }
      for (let page = start; page <= end; page += 1) {
        findings.push(
          makeFinding({
            category: 'images',
            severity: 'warning',
            page,
            title: `Page ${page} image finding`,
          }),
        );
      }
      return pagesResult(findings);
    });

    store().open('/docs/report.pdf', 'report.pdf');
    expect(store().active).toBe(true);
    expect(store().loading).toBe(true);

    await settle();

    expect(auditIpc.auditPages.mock.calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(AUDIT_PAGE_BATCH_SIZE).toBe(10);

    const report = store().report;
    expect(report).not.toBeNull();
    expect(report!.schemaVersion).toBe(1);
    expect(report!.document.pages).toBe(25);
    expect(report!.findings).toHaveLength(3 + 25 + 25);

    const categories = report!.findings.map((finding) => finding.category);
    expect(categories.slice(0, 1)).toEqual(['fonts']);
    expect(categories.slice(1, 26)).toEqual(Array.from({ length: 25 }, () => 'pages'));
    expect(categories.slice(26, 51)).toEqual(Array.from({ length: 25 }, () => 'images'));
    expect(categories.slice(51)).toEqual(['metadata', 'security']);

    // Findings inside one category stay ordered by page ascending.
    expect(
      report!.findings.filter((finding) => finding.category === 'pages').map((f) => f.page),
    ).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));

    expect(report!.summary).toEqual({
      total: 53,
      errors: 0,
      warnings: 27,
      info: 26,
    });
    expect(store().loading).toBe(false);
    expect(store().progress).toBeNull();
    expect(store().error).toBeNull();
  });

  it('reports progress as each page batch finishes', async () => {
    auditIpc.auditDocument.mockResolvedValue(documentResult(25));
    auditIpc.auditPages.mockResolvedValue(pagesResult([]));

    const progress: (AuditProgress | null)[] = [];
    const unsubscribe = useAuditStore.subscribe((state) => {
      progress.push(state.progress);
    });

    try {
      store().open('/docs/report.pdf', 'report.pdf');
      await settle();
    } finally {
      unsubscribe();
    }

    expect(dedupeProgress(progress)).toEqual([
      null,
      { done: 0, total: 25 },
      { done: 10, total: 25 },
      { done: 20, total: 25 },
      { done: 25, total: 25 },
      null,
    ]);
  });

  it('does not request a page batch for a zero-page document', async () => {
    await store().runAudit();

    // No file yet: the run is a no-op.
    expect(auditIpc.auditDocument).not.toHaveBeenCalled();

    store().open('/docs/empty.pdf', 'empty.pdf');
    await settle();

    expect(auditIpc.auditPages).not.toHaveBeenCalled();
    expect(store().report?.document.pages).toBe(0);
    expect(store().loading).toBe(false);
  });
});

describe('audit store file lifecycle', () => {
  it('resets the report and selection when the file changes', async () => {
    const oldFinding = makeFinding({ title: 'Old document finding' });
    auditIpc.auditDocument.mockResolvedValueOnce(
      documentResult(0, [oldFinding], { title: 'Old report' }),
    );

    store().open('/docs/old.pdf', 'old.pdf');
    await settle();
    store().selectFinding(store().report!.findings[0]);
    expect(store().selected).not.toBeNull();

    const newFinding = makeFinding({ title: 'New document finding' });
    auditIpc.auditDocument.mockResolvedValueOnce(
      documentResult(0, [newFinding], { title: 'New report' }),
    );

    store().open('/docs/new.pdf', 'new.pdf');

    // The old result is gone before the new run finishes.
    expect(store().filePath).toBe('/docs/new.pdf');
    expect(store().fileName).toBe('new.pdf');
    expect(store().report).toBeNull();
    expect(store().selected).toBeNull();
    expect(store().loading).toBe(true);

    await settle();

    expect(store().report?.document.title).toBe('New report');
    expect(store().report?.findings.map((finding) => finding.title)).toEqual([
      'New document finding',
    ]);
  });

  it('keeps the report on close and does not re-run it when the same file is reopened', async () => {
    auditIpc.auditDocument.mockResolvedValue(documentResult(2));
    auditIpc.auditPages.mockResolvedValue(pagesResult([makeFinding({ page: 1 })]));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    const report = store().report;
    expect(report).not.toBeNull();
    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(1);

    store().close();
    expect(store().active).toBe(false);
    expect(store().report).toBe(report);

    store().open('/docs/report.pdf', 'report.pdf');
    await flushMicrotasks();

    expect(store().active).toBe(true);
    expect(store().report).toBe(report);
    // A completed report is reused; reopening must not audit the file again.
    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(1);
  });

  it('retries after an error when the same file is reopened', async () => {
    auditIpc.auditDocument.mockRejectedValueOnce(new Error('Sidecar is not running'));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    expect(store().error).toBe('Sidecar is not running');

    store().close();
    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(2);
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();
  });

  it('does not start a second run when reopen happens while one is in flight', async () => {
    const pending = deferred<AuditDocumentResult>();
    auditIpc.auditDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf', 'report.pdf');
    store().open('/docs/report.pdf', 'report.pdf');

    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(1);

    pending.resolve(documentResult(0));
    await settle();

    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(1);
    expect(store().report).not.toBeNull();
  });

  it('reset clears every field', async () => {
    auditIpc.auditDocument.mockResolvedValue(documentResult(1, [makeFinding()]));
    auditIpc.auditPages.mockResolvedValue(pagesResult([]));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    store().selectFinding(store().report!.findings[0]);
    store().setFilter({ severity: 'warning', category: 'fonts' });

    store().reset();

    expect(store()).toMatchObject({
      active: false,
      filePath: null,
      fileName: null,
      report: null,
      loading: false,
      progress: null,
      error: null,
      selected: null,
      filter: { severity: 'all', category: 'all' },
      baseline: null,
      comparison: null,
      baselineError: null,
      baselineOnly: false,
    });
  });
});

describe('audit store superseded runs', () => {
  it('ignores a run superseded by opening another file', async () => {
    const pending = deferred<AuditDocumentResult>();
    auditIpc.auditDocument
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(documentResult(0, [], { title: 'Second report' }));

    store().open('/docs/slow.pdf', 'slow.pdf');
    store().open('/docs/fast.pdf', 'fast.pdf');
    await settle();

    expect(store().report?.document.title).toBe('Second report');

    // The first run now answers; it must not overwrite the newer result or
    // request page batches for a document the user already left.
    pending.resolve(documentResult(4, [makeFinding({ title: 'Stale finding' })]));
    await flushMicrotasks();

    expect(store().filePath).toBe('/docs/fast.pdf');
    expect(store().report?.document.title).toBe('Second report');
    expect(store().report?.findings).toEqual([]);
    expect(auditIpc.auditPages).not.toHaveBeenCalled();
    expect(store().loading).toBe(false);
  });

  it('ignores a run superseded by close', async () => {
    const pending = deferred<AuditDocumentResult>();
    auditIpc.auditDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf', 'report.pdf');
    store().close();

    pending.resolve(documentResult(2, [makeFinding()]));
    await flushMicrotasks();

    expect(store().active).toBe(false);
    expect(store().report).toBeNull();
    expect(store().progress).toBeNull();
    expect(store().loading).toBe(false);
    expect(auditIpc.auditPages).not.toHaveBeenCalled();
  });

  it('ignores a run superseded by reset', async () => {
    const pending = deferred<AuditDocumentResult>();
    auditIpc.auditDocument.mockImplementationOnce(() => pending.promise);

    store().open('/docs/report.pdf', 'report.pdf');
    store().reset();

    pending.resolve(documentResult(2, [makeFinding()]));
    await flushMicrotasks();

    expect(store().report).toBeNull();
    expect(store().loading).toBe(false);
  });
});

describe('audit store errors', () => {
  it('sets the error and stops loading when the document pass fails', async () => {
    auditIpc.auditDocument.mockRejectedValue(new Error('Sidecar timeout: auditDocument exceeded 125000ms'));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(store().error).toBe('Sidecar timeout: auditDocument exceeded 125000ms');
    expect(store().report).toBeNull();
    expect(store().progress).toBeNull();
    expect(store().loading).toBe(false);
    expect(store().active).toBe(true);
  });

  it('sets the error when a page batch fails and publishes no partial report', async () => {
    auditIpc.auditDocument.mockResolvedValue(documentResult(15, [makeFinding()]));
    auditIpc.auditPages
      .mockResolvedValueOnce(pagesResult([makeFinding({ page: 1 })]))
      .mockRejectedValueOnce(new Error('Request "audit_pages" timed out after 120s'));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();

    expect(store().error).toBe('Request "audit_pages" timed out after 120s');
    expect(store().report).toBeNull();
    expect(store().progress).toBeNull();
    expect(store().loading).toBe(false);
  });
});

describe('audit store selection and filter', () => {
  it('patches severity and category independently', () => {
    store().setFilter({ severity: 'error' });
    expect(store().filter).toEqual({ severity: 'error', category: 'all' });

    store().setFilter({ category: 'images' });
    expect(store().filter).toEqual({ severity: 'error', category: 'images' });

    store().setFilter({ severity: 'all', category: 'all' });
    expect(store().filter).toEqual({ severity: 'all', category: 'all' });
  });

  it('keeps a selected finding across a re-run that still reports it', async () => {
    const finding = makeFinding({ category: 'images', page: 2, title: 'Low DPI image' });
    auditIpc.auditDocument.mockResolvedValue(documentResult(0, [finding]));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    store().selectFinding(store().report!.findings[0]);

    auditIpc.auditDocument.mockResolvedValue(documentResult(0, [{ ...finding }]));
    await store().runAudit();

    expect(store().selected).toEqual(finding);
  });

  it('drops the selection when a new result no longer contains it', async () => {
    const finding = makeFinding({ category: 'images', page: 2, title: 'Low DPI image' });
    auditIpc.auditDocument.mockResolvedValue(documentResult(0, [finding]));

    store().open('/docs/report.pdf', 'report.pdf');
    await settle();
    store().selectFinding(store().report!.findings[0]);

    auditIpc.auditDocument.mockResolvedValue(
      documentResult(0, [makeFinding({ category: 'security', title: 'Document is encrypted' })]),
    );
    await store().runAudit();

    expect(store().selected).toBeNull();
  });

  it('selects and clears a finding directly', () => {
    const finding = makeFinding();
    store().selectFinding(finding);
    expect(store().selected).toBe(finding);

    store().selectFinding(null);
    expect(store().selected).toBeNull();
  });
});

describe('audit store baseline', () => {
  const existing = makeFinding({
    category: 'fonts',
    severity: 'warning',
    page: null,
    title: 'Font not embedded: Inter',
    fingerprint: fingerprint(1),
  });
  const other = makeFinding({
    category: 'images',
    severity: 'warning',
    page: 2,
    title: 'Low DPI image',
    fingerprint: fingerprint(2),
  });

  it('loads a valid baseline and compares it with the current report', async () => {
    await auditFindings([existing, other]);

    await store().loadBaselineFile(baselineFile(baselineReport([existing]), 'previous audit.json'));

    expect(store().baseline?.fileName).toBe('previous audit.json');
    expect(store().baseline?.report.findings).toHaveLength(1);
    expect(store().comparison?.summary).toEqual({
      new: 1,
      existing: 1,
      moved: 0,
      escalated: 0,
      fixed: 0,
      waived: 0,
    });
    expect(store().baselineError).toBeNull();
    expect(store().baselineOnly).toBe(false);
  });

  it('keeps the previous baseline when the JSON is broken', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing]), 'good.json'));
    const baseline = store().baseline;
    const comparison = store().comparison;

    await store().loadBaselineFile(
      new File(['{ "schemaVersion": 1, '], 'broken.json', { type: 'application/json' }),
    );

    expect(store().baselineError).toContain('not valid JSON');
    expect(store().baseline).toBe(baseline);
    expect(store().comparison).toBe(comparison);
    // A baseline failure is never the audit-run failure.
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();
  });

  it('rejects a wrong schema version and keeps the loaded baseline', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing]), 'good.json'));
    const baseline = store().baseline;

    await store().loadBaselineFile(
      new File([JSON.stringify({ schemaVersion: 2, findings: [] })], 'v2.json'),
    );

    expect(store().baselineError).toContain('"schemaVersion": 1');
    expect(store().baseline).toBe(baseline);
  });

  it('rejects a legacy baseline without fingerprints and says how to regenerate it', async () => {
    await auditFindings([existing]);

    await store().loadBaselineFile(
      baselineFile(
        baselineReport([{ ...existing, fingerprint: undefined }]),
        'legacy.json',
      ),
    );

    expect(store().baselineError).toContain('Regenerate the baseline with the current CLI');
    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
  });

  it('rejects a fingerprint that is not 32 lowercase hex characters', async () => {
    await auditFindings([existing]);

    await store().loadBaselineFile(
      baselineFile(baselineReport([{ ...existing, fingerprint: 'NOT-A-FINGERPRINT' }])),
    );

    expect(store().baselineError).not.toBeNull();
    expect(store().baseline).toBeNull();
  });

  it('recomputes the comparison after a re-run and keeps the baseline', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing, other])));
    expect(store().comparison?.summary).toEqual({
      new: 0,
      existing: 1,
      moved: 0,
      escalated: 0,
      fixed: 1,
      waived: 0,
    });

    // The re-run reports the fixed baseline finding and adds a third one.
    auditIpc.auditDocument.mockResolvedValue(
      documentResult(2, [
        existing,
        other,
        makeFinding({ category: 'pages', severity: 'info', title: 'Page 2 is blank', fingerprint: fingerprint(3) }),
      ]),
    );
    await store().runAudit();

    expect(store().baseline).not.toBeNull();
    expect(store().comparison?.summary).toEqual({
      new: 1,
      existing: 2,
      moved: 0,
      escalated: 0,
      fixed: 0,
      waived: 0,
    });
  });

  it('keeps the baseline and clears the comparison when the report is gone', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));

    // Opening another document drops the report; the baseline belongs to the
    // previous document, so both the baseline and its comparison go.
    auditIpc.auditDocument.mockResolvedValue(documentResult(0));
    store().open('/docs/other.pdf', 'other.pdf');

    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    await settle();
    expect(store().fileName).toBe('other.pdf');
  });

  it('clears the baseline on a document switch but keeps it on a same-file reopen', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));
    store().setBaselineOnly(true);

    store().close();
    store().open('/docs/report.pdf', 'report.pdf');
    expect(store().baseline).not.toBeNull();
    expect(store().comparison).not.toBeNull();
    // `close` keeps state like the report does, `New only` included.
    expect(store().baselineOnly).toBe(true);

    auditIpc.auditDocument.mockResolvedValue(documentResult(0));
    store().open('/docs/other.pdf', 'other.pdf');
    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    expect(store().baselineError).toBeNull();
    expect(store().baselineOnly).toBe(false);
    await settle();
  });

  it('clears the baseline state on reset', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));
    store().setBaselineOnly(true);

    store().reset();

    expect(store()).toMatchObject({
      baseline: null,
      comparison: null,
      baselineError: null,
      baselineOnly: false,
    });
  });

  it('clears the baseline, the toggle and a pending error', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));
    store().setBaselineOnly(true);
    await store().loadBaselineFile(new File(['nope'], 'bad.json'));
    expect(store().baselineError).not.toBeNull();

    store().clearBaselineError();
    expect(store().baselineError).toBeNull();
    // Dismissing the error keeps the baseline that was already loaded.
    expect(store().baseline).not.toBeNull();

    store().clearBaseline();
    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    expect(store().baselineOnly).toBe(false);
  });

  it('keeps the baseline but explains the comparison when the report has no fingerprints', async () => {
    await auditFindings([existing]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));
    expect(store().comparison).not.toBeNull();

    // A report from an engine that predates fingerprints cannot be compared;
    // the store must not throw, must keep the baseline, and must say why the
    // counts are gone instead of dropping them silently.
    auditIpc.auditDocument.mockResolvedValue(
      documentResult(2, [{ ...existing, fingerprint: undefined }]),
    );
    await store().runAudit();

    expect(store().baseline).not.toBeNull();
    expect(store().comparison).toBeNull();
    expect(store().baselineError).toBe(
      'The current audit report has no fingerprints. Re-run the audit with the current engine.',
    );
    // Still a baseline concern, never an audit-run failure.
    expect(store().error).toBeNull();

    // The message is dismissible and the baseline stays usable.
    store().clearBaselineError();
    expect(store().baselineError).toBeNull();
    expect(store().baseline).not.toBeNull();
  });

  it('explains a fingerprint-less current report when the baseline is loaded', async () => {
    // The very first load: the baseline file is valid, the report is not
    // comparable, so the file is kept and the reason is reported.
    await auditFindings([{ ...existing, fingerprint: undefined }]);

    await store().loadBaselineFile(baselineFile(baselineReport([existing])));

    expect(store().baseline?.fileName).toBe('baseline.json');
    expect(store().comparison).toBeNull();
    expect(store().baselineError).toContain('The current audit report has no fingerprints');
    expect(store().baselineError).not.toContain('Regenerate the baseline');
    expect(store().error).toBeNull();
  });

  it('clears a fingerprint error once a re-run produces fingerprints again', async () => {
    await auditFindings([{ ...existing, fingerprint: undefined }]);
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));
    expect(store().baselineError).not.toBeNull();

    auditIpc.auditDocument.mockResolvedValue(documentResult(2, [existing]));
    await store().runAudit();

    expect(store().baselineError).toBeNull();
    expect(store().comparison?.summary.existing).toBe(1);
  });

  it('ignores a baseline chosen while no report exists', async () => {
    await store().loadBaselineFile(baselineFile(baselineReport([existing])));

    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    expect(store().baselineError).toBeNull();
  });
});
