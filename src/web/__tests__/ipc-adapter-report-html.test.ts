// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcApi } from '../../renderer/types/ipc-protocol';
import type {
  AuditBaselineComparison,
  AuditFinding,
  AuditReport,
} from '../../shared/audit-types';
import type { DiffResult } from '../../shared/diff-types';
import { installWebIpc } from '../ipc-adapter';

type BrowserWindow = { pdfInspector?: IpcApi };

const TOOL = { name: 'pdf-inspector', version: '0.2.0' } as const;

const FINDING: AuditFinding = {
  category: 'metadata',
  severity: 'info',
  page: null,
  title: 'Missing language',
  detail: 'The catalog has no /Lang entry.',
  evidence: null,
  recommendation: 'Set the document language.',
  fingerprint: 'a'.repeat(32),
};

const REPORT: AuditReport = {
  schemaVersion: 1,
  tool: TOOL,
  document: {
    pages: 2,
    version: '1.7',
    encrypted: false,
    title: 'Report',
    author: null,
    producer: null,
    language: 'en-US',
    tagged: true,
  },
  summary: { total: 1, errors: 0, warnings: 0, info: 1 },
  findings: [FINDING],
};

const BASELINE: AuditBaselineComparison = {
  schemaVersion: 1,
  tool: TOOL,
  current: { pages: 2, findings: 1 },
  baseline: { pages: 2, findings: 1 },
  summary: { new: 0, existing: 1, moved: 0, escalated: 0, fixed: 0, waived: 0 },
  findings: [
    {
      status: 'existing',
      fingerprint: FINDING.fingerprint as string,
      current: FINDING,
      baseline: FINDING,
    },
  ],
};

const DIFF_RESULT = {
  schemaVersion: 1,
  tool: TOOL,
  options: {
    positionTolerance: 1,
    textTolerance: 'normalized',
    ignoreTypes: [],
    ignoreFonts: false,
    ignoreColors: false,
    ignoreImages: false,
    ignoreRegions: [],
  },
  old: { pages: 1, sha256: 'a'.repeat(64) },
  new: { pages: 1, sha256: 'b'.repeat(64) },
  summary: {
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesChanged: 0,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 0,
    changesTruncated: false,
  },
  truncated: false,
  pages: [],
} satisfies DiffResult;

const HTML_RESULT = { html: '<!doctype html><html></html>' };

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(body: string, status = 500): Response {
  return {
    ok: false,
    status,
    statusText: 'Internal Server Error',
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

function api(): IpcApi {
  const installed = (window as unknown as BrowserWindow).pdfInspector;
  if (!installed) throw new Error('window.pdfInspector was not installed');
  return installed;
}

/** Request body of the Nth fetch call, parsed from its JSON payload. */
function sentJson(callIndex = 0): unknown {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  delete (window as unknown as BrowserWindow).pdfInspector;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  installWebIpc();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as BrowserWindow).pdfInspector;
});

describe('web ipc adapter report rendering', () => {
  it('round-trips render_audit_report_html through a plain RPC', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTML_RESULT));

    await expect(api().renderAuditReportHtml(REPORT)).resolves.toEqual(HTML_RESULT);

    expect(fetchMock).toHaveBeenCalledWith('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'render_audit_report_html', params: { report: REPORT } }),
    });
  });

  it('sends the baseline when one is loaded', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTML_RESULT));

    await api().renderAuditReportHtml(REPORT, BASELINE);

    expect(sentJson()).toEqual({
      method: 'render_audit_report_html',
      params: { report: REPORT, baseline: BASELINE },
    });
  });

  it('forwards an explicit null baseline instead of dropping it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTML_RESULT));

    await api().renderAuditReportHtml(REPORT, null);

    expect(sentJson()).toEqual({
      method: 'render_audit_report_html',
      params: { report: REPORT, baseline: null },
    });
  });

  it('round-trips render_diff_report_html through a plain RPC', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HTML_RESULT));

    await expect(api().renderDiffReportHtml(DIFF_RESULT)).resolves.toEqual(HTML_RESULT);

    expect(sentJson()).toEqual({
      method: 'render_diff_report_html',
      params: { result: DIFF_RESULT },
    });
  });

  it('never uploads or reopens anything to render a report', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(HTML_RESULT))
      .mockResolvedValueOnce(jsonResponse(HTML_RESULT));

    await api().renderAuditReportHtml(REPORT, BASELINE);
    await api().renderDiffReportHtml(DIFF_RESULT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/rpc', '/api/rpc']);
  });

  it('propagates a server render error', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(JSON.stringify({ error: 'No active document' }), 409),
    );

    await expect(api().renderDiffReportHtml(DIFF_RESULT)).rejects.toThrow(
      'No active document',
    );
  });
});
