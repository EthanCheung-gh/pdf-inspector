// @vitest-environment node
/**
 * Browser RPC wiring for the HTML report renders.
 *
 * The Python/HTML rendering itself is covered elsewhere; these tests only assert
 * that the HTTP backend allows both render methods through, forwards their params
 * verbatim and gives them the dedicated render budget instead of the 30s default.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  createWebServer,
  type DiffUploadStore,
  type DocumentRegistry,
  type SidecarPool,
} from '../web-server';
import { AUDIT_TIMEOUT_MS, REPORT_RENDER_TIMEOUT_MS } from '../../src/shared/constants';
import type {
  AuditBaselineComparison,
  AuditFinding,
  AuditReport,
} from '../../src/shared/audit-types';
import type { DiffResult } from '../../src/shared/diff-types';

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

let server: Server;
let sidecar: SidecarPool;
let registry: DocumentRegistry;
let diffUploads: DiffUploadStore;
let send: MockInstance;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  const created = createWebServer();
  server = created.server;
  sidecar = created.sidecar;
  registry = created.registry;
  diffUploads = created.diffUploads;

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(HTML_RESULT);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer(): Promise<void> {
  await diffUploads.cleanup();
  await registry.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function postRpc(payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(async () => {
  await startTestServer();
  // /api/rpc requires an active document. Register a non-temp entry without
  // touching disk (the sidecar is stubbed and non-temp documents are never
  // unlinked), then clear the open call so budget assertions stay exact.
  await registry.open('/tmp/pdf-inspector-render-active.pdf', 'active.pdf', false, 1);
  send.mockClear();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/rpc report render allowlist', () => {
  it('forwards render_audit_report_html with the render timeout', async () => {
    const response = await postRpc({
      method: 'render_audit_report_html',
      params: { report: REPORT },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(HTML_RESULT);
    expect(send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report: REPORT },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('forwards the baseline comparison verbatim', async () => {
    const response = await postRpc({
      method: 'render_audit_report_html',
      params: { report: REPORT, baseline: BASELINE },
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report: REPORT, baseline: BASELINE },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('forwards render_diff_report_html with the render timeout', async () => {
    const response = await postRpc({
      method: 'render_diff_report_html',
      params: { result: DIFF_RESULT },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(HTML_RESULT);
    expect(send).toHaveBeenCalledWith(
      'render_diff_report_html',
      { result: DIFF_RESULT },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('gives rendering its own budget instead of the default or the audit one', async () => {
    await postRpc({ method: 'render_diff_report_html', params: { result: DIFF_RESULT } });

    expect(REPORT_RENDER_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(REPORT_RENDER_TIMEOUT_MS).toBeLessThan(AUDIT_TIMEOUT_MS);
    expect(send).not.toHaveBeenCalledWith(
      'render_diff_report_html',
      { result: DIFF_RESULT },
      30_000,
    );
  });

  it('still rejects methods outside the allowlist', async () => {
    for (const method of ['render_report_pdf', 'open', 'shutdown']) {
      const response = await postRpc({ method });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        'Method not allowed',
      );
    }

    expect(send).not.toHaveBeenCalled();
  });

  it('never re-reads the open document and never replaces it', async () => {
    await postRpc({ method: 'render_audit_report_html', params: { report: REPORT } });
    await postRpc({ method: 'render_diff_report_html', params: { result: DIFF_RESULT } });

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'render_audit_report_html',
      'render_diff_report_html',
    ]);
    expect(registry.getActive()).not.toBeNull();
  });
});

describe('POST /api/rpc report render without an active document', () => {
  it('keeps the shared "no active document" guard for renders', async () => {
    // The renders do not read the document, but the guard is the only "is a
    // sidecar live for this session" check, so it deliberately stays in place:
    // the UI only offers a render next to an open audit/diff.
    const activeId = registry.getActiveId();
    if (activeId === null) throw new Error('test setup: no active document');
    await registry.close(activeId);

    const response = await postRpc({
      method: 'render_audit_report_html',
      params: { report: REPORT },
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('No active document');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('POST /api/rpc report render body size', () => {
  /** A report whose single finding's detail is `bytes` bytes long. */
  function oversizedReport(bytes: number): AuditReport {
    return {
      ...REPORT,
      findings: [{ ...FINDING, detail: 'x'.repeat(bytes) }],
    };
  }

  it('accepts a report body larger than the ordinary JSON cap', async () => {
    // A report the browser already holds can legitimately exceed the 1 MiB cap
    // that every other JSON route keeps; the render methods get their own bound.
    const report = oversizedReport(1_500_000);

    const response = await postRpc({
      method: 'render_audit_report_html',
      params: { report },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(HTML_RESULT);
    expect(send).toHaveBeenCalledWith(
      'render_audit_report_html',
      { report },
      REPORT_RENDER_TIMEOUT_MS,
    );
  });

  it('rejects a report render body beyond the render cap', async () => {
    const report = oversizedReport(33 * 1024 * 1024);

    const response = await postRpc({
      method: 'render_audit_report_html',
      params: { report },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Request body is too large',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the 1 MiB cap for every other RPC method', async () => {
    // Widening the buffer for report renders must not widen the ordinary methods.
    const response = await postRpc({
      method: 'extract_metadata',
      params: { padding: 'x'.repeat(1_500_000) },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Request body is too large',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the 1 MiB cap on the other JSON routes', async () => {
    const response = await fetch(`${baseUrl}/api/open-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://example.com/${'x'.repeat(1_500_000)}.pdf` }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Request body is too large',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
