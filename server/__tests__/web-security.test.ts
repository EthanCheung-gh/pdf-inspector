// @vitest-environment node
/**
 * Browser RPC wiring for document security resources.
 *
 * The Python inventory is covered by the sidecar test suite; these tests only
 * assert that the HTTP backend allows `security_document` through, gives it the
 * dedicated security budget and returns the `SecurityReport` verbatim.
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
import { SECURITY_TIMEOUT_MS } from '../../src/shared/constants';
import type { SecurityReport } from '../../src/shared/security-types';

const SECURITY_REPORT: SecurityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 3,
    version: '1.6',
    encrypted: false,
    xfa: false,
    hasMetadata: false,
    outputIntents: 0,
  },
  attachments: [
    {
      name: 'invoice.exe',
      description: 'Embedded payload',
      size: 2048,
      mimeType: 'application/octet-stream',
      modified: "D:20240101000000Z",
      sha256: null,
      risky: true,
    },
  ],
  javascript: [],
  actions: [],
  signatures: [],
  encryption: null,
  findings: [
    {
      category: 'security',
      severity: 'warning',
      page: null,
      title: 'Risky embedded file',
      detail: 'The document embeds a file with an executable extension.',
      evidence: 'name=invoice.exe',
      recommendation: 'Do not open embedded files from untrusted documents.',
    },
  ],
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
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

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(SECURITY_REPORT);

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
  await registry.open('/tmp/pdf-inspector-security-active.pdf', 'active.pdf', false, 1);
  send.mockClear();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/rpc security allowlist', () => {
  it('forwards security_document with the security timeout and returns the report', async () => {
    const response = await postRpc({ method: 'security_document' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SECURITY_REPORT);
    expect(send).toHaveBeenCalledWith('security_document', {}, SECURITY_TIMEOUT_MS);
    expect(SECURITY_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('keeps the existing 409 when no document is active', async () => {
    await registry.close(registry.getActiveId() ?? '');

    const response = await postRpc({ method: 'security_document' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'No active document',
    );
  });
});
