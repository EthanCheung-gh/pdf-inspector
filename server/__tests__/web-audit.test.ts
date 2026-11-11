// @vitest-environment node
/**
 * Browser RPC wiring for the document audit.
 *
 * The Python checks are covered by the sidecar test suite; these tests only
 * assert that the HTTP backend allows both audit methods through and gives them
 * the dedicated audit budget instead of the 30s default.
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
import { ANALYZE_FONTS_TIMEOUT_MS, AUDIT_TIMEOUT_MS } from '../../src/shared/constants';
import type {
  AuditDocumentResult,
  AuditPagesResult,
} from '../../src/shared/audit-types';

const TOOL = { name: 'pdf-inspector', version: '0.2.0' };

const DOCUMENT_RESULT: AuditDocumentResult = {
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
  findings: [],
};

const PAGES_RESULT: AuditPagesResult = {
  tool: TOOL,
  findings: [
    {
      category: 'pages',
      severity: 'info',
      page: 1,
      title: 'Page 1 has no content',
      detail: 'The page is empty.',
      evidence: null,
      recommendation: null,
    },
  ],
};

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

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(DOCUMENT_RESULT);

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
  // /api/rpc requires an active document now. Register a non-temp entry without
  // touching disk (the sidecar is stubbed and non-temp documents are never
  // unlinked), then clear the open call so budget assertions stay exact.
  await registry.open('/tmp/pdf-inspector-audit-active.pdf', 'active.pdf', false, 1);
  send.mockClear();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/rpc audit allowlist', () => {
  it('forwards audit_document with the audit timeout', async () => {
    const response = await postRpc({ method: 'audit_document' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOCUMENT_RESULT);
    expect(send).toHaveBeenCalledWith('audit_document', {}, AUDIT_TIMEOUT_MS);
  });

  it('forwards audit_pages params with the audit timeout', async () => {
    send.mockResolvedValueOnce(PAGES_RESULT);

    const response = await postRpc({
      method: 'audit_pages',
      params: { start_page: 11, end_page: 20 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PAGES_RESULT);
    expect(send).toHaveBeenCalledWith(
      'audit_pages',
      { start_page: 11, end_page: 20 },
      AUDIT_TIMEOUT_MS,
    );
  });

  it('still rejects methods outside the allowlist', async () => {
    for (const method of ['audit_delete', 'open', 'shutdown']) {
      const response = await postRpc({ method });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        'Method not allowed',
      );
    }

    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the default budget for ordinary RPC methods', async () => {
    send.mockResolvedValueOnce({});

    const response = await postRpc({ method: 'extract_metadata' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith('extract_metadata', {}, 30_000);
    // Guard against every method silently inheriting a long budget.
    expect(send).not.toHaveBeenCalledWith(
      'extract_metadata',
      {},
      AUDIT_TIMEOUT_MS,
    );
    expect(ANALYZE_FONTS_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
