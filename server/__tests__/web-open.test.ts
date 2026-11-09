// @vitest-environment node
/**
 * Request budgets for opening a document in the browser backend.
 *
 * `open` runs pdfplumber's parse plus the sidecar's font-resource scan, so a
 * large or corrupt PDF legitimately exceeds the generic 30s budget. These tests
 * pin OPEN_PDF_TIMEOUT_MS on every `open` the backend sends — the initial open,
 * the previous-document restore after a failed open and the restore after a
 * restart — and pin the per-method RPC budgets: page extraction gets its own
 * 120s while an ordinary read such as `extract_metadata` keeps the 30s default.
 *
 * The sidecar is stubbed: the Python open itself is covered by the sidecar test
 * suite, so only transport and budgets are asserted here.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  createWebServer,
  SidecarManager,
  SidecarPool,
  type DiffUploadStore,
  type DocumentRegistry,
} from '../web-server';
import { EXTRACT_PAGE_TIMEOUT_MS, OPEN_PDF_TIMEOUT_MS } from '../../src/shared/constants';

const PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n';

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

  send = vi.spyOn(sidecar, 'send').mockResolvedValue({ pageCount: 1 });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer(): Promise<void> {
  await diffUploads.cleanup();
  await registry.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function openUpload(body: string = PDF_BYTES): Promise<Response> {
  return fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('large.pdf'),
    },
    body,
  });
}

beforeEach(async () => {
  await startTestServer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopTestServer();
});

describe('POST /api/open budget', () => {
  it('opens the uploaded PDF with the 120s open budget', async () => {
    expect(OPEN_PDF_TIMEOUT_MS).toBe(120_000);

    const response = await openUpload();

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'open',
      { path: expect.stringMatching(/large\.pdf$/) },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('reopens the previous document with the same budget when the new open fails', async () => {
    expect((await openUpload()).status).toBe(200);
    send.mockClear();

    send.mockRejectedValueOnce(new Error('cannot open the uploaded PDF'));
    const failed = await openUpload();

    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toBe(
      'cannot open the uploaded PDF',
    );
    // Failing open, then exactly one best-effort restore of the previous
    // document: both are full opens and both get the open budget.
    expect(send.mock.calls).toEqual([
      [
        'open',
        { path: expect.stringMatching(/large\.pdf$/) },
        OPEN_PDF_TIMEOUT_MS,
      ],
      [
        'open',
        { path: expect.stringMatching(/large\.pdf$/) },
        OPEN_PDF_TIMEOUT_MS,
      ],
    ]);
    expect(registry.getCurrent()).not.toBeNull();
  });
});

describe('other methods keep the default budget', () => {
  it('gives extract_page the 120s page budget and extract_metadata the 30s default', async () => {
    expect((await openUpload()).status).toBe(200);
    send.mockClear();

    const pageResponse = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'extract_page', params: { page: 1 } }),
    });
    const metadataResponse = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'extract_metadata' }),
    });

    expect(pageResponse.status).toBe(200);
    expect(metadataResponse.status).toBe(200);
    // One complex page (many tables/objects) is extracted in one shot, so it
    // gets its own budget; the cheap metadata read keeps the 30s default.
    expect(send.mock.calls).toEqual([
      ['extract_page', { page: 1 }, EXTRACT_PAGE_TIMEOUT_MS],
      ['extract_metadata', {}, 30_000],
    ]);
  });

  it('pins the page budget at 120s, above the generic 30s default', () => {
    // A normal page extracts in <0.1s; the budget exists only so one complex
    // page does not surface as a failed page load after 30s.
    expect(EXTRACT_PAGE_TIMEOUT_MS).toBe(120_000);
    expect(EXTRACT_PAGE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

describe('post-restart restore', () => {
  it('gives the restored document the open budget', async () => {
    const manager = new SidecarManager(process.cwd());
    manager.setDocumentPath('/tmp/large.pdf');
    // Pretend the freshly spawned sidecar is ready: the restore only needs the
    // running state and the tracked path, so no child process is spawned here.
    (manager as unknown as { child: unknown }).child = { killed: false, exitCode: null };
    const writeRequest = vi
      .spyOn(manager as unknown as { writeRequest: (...args: unknown[]) => Promise<unknown> }, 'writeRequest')
      .mockResolvedValue({ pageCount: 1 });

    await (manager as unknown as { restoreDocument: () => Promise<void> }).restoreDocument();

    expect(writeRequest).toHaveBeenCalledTimes(1);
    expect(writeRequest).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/large.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });
});
