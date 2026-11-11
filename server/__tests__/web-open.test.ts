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
import { stat } from 'node:fs/promises';
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

function openUpload(body: string = PDF_BYTES, fileName: string = 'large.pdf'): Promise<Response> {
  return fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(fileName),
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
  it('opens the uploaded PDF with the 120s open budget and returns its id', async () => {
    expect(OPEN_PDF_TIMEOUT_MS).toBe(120_000);

    const response = await openUpload();

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      path: string;
      documentId: string;
    };
    expect(payload.documentId).toBeTruthy();
    expect(payload.path).toBe(`/doc/${payload.documentId}/large.pdf`);
    expect(registry.getActiveId()).toBe(payload.documentId);
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
    expect(registry.list()).toHaveLength(1);

    // The rejected upload is garbage and must not survive as an orphan temp
    // file: the handler deletes its own copy when the registry refuses it.
    const rejectedPath = (send.mock.calls[0][1] as { path: string }).path;
    await expect(stat(rejectedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('POST /api/open multi-document semantics', () => {
  it('adds a document without replacing the previously opened one', async () => {
    const firstResponse = await openUpload(PDF_BYTES, 'first.pdf');
    const first = (await firstResponse.json()) as { path: string; documentId: string };
    const secondResponse = await openUpload(PDF_BYTES, 'second.pdf');
    const second = (await secondResponse.json()) as { path: string; documentId: string };

    expect(first.documentId).not.toBe(second.documentId);
    expect(registry.list()).toHaveLength(2);
    expect(registry.getActiveId()).toBe(second.documentId);

    // The first document stays addressable even though the second is active.
    expect((await fetch(`${baseUrl}${first.path}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}${second.path}`)).status).toBe(200);

    const listed = (await (await fetch(`${baseUrl}/api/documents`)).json()) as {
      activeDocumentId: string;
      documents: Array<{ id: string; active: boolean }>;
    };
    expect(listed.activeDocumentId).toBe(second.documentId);
    expect(listed.documents.map((doc) => doc.id)).toEqual([
      second.documentId,
      first.documentId,
    ]);
  });
});

describe('POST /api/open display name', () => {
  it('preserves a Unicode upload name in the response and the registry', async () => {
    const response = await openUpload(PDF_BYTES, '测试 报告.pdf');

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { name: string; path: string };
    expect(payload.name).toBe('测试 报告.pdf');
    expect(payload.name).not.toContain('_');

    const current = registry.getCurrent();
    expect(current?.name).toBe('测试 报告.pdf');
    expect(payload.path).toBe(`/doc/${current?.id}/${encodeURIComponent('测试 报告.pdf')}`);
  });

  it('still strips paths and Windows-invalid characters from the name', async () => {
    const response = await openUpload(PDF_BYTES, '../../etc/passwd*?.pdf');

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { name: string };
    // Last segment only, invalid characters replaced, still a .pdf name.
    expect(payload.name).toBe('passwd__.pdf');
    expect(payload.name).not.toContain('/');
    expect(payload.name).not.toContain('..');
  });

  it('strips invisible bidi control characters from the name', async () => {
    const response = await openUpload(PDF_BYTES, 're\u202Eport\u2066.pdf\u2069');

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { name: string };
    expect(payload.name).toBe('report.pdf');
    expect(payload.name).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });

  it('truncates long names without splitting a surrogate pair', async () => {
    // 99 BMP chars + an emoji: 101 UTF-16 units, exactly 100 code points, so a
    // UTF-16 slice at 100 would keep only the high surrogate.
    const response = await openUpload(PDF_BYTES, `${'a'.repeat(99)}😀.pdf`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { name: string };
    expect(payload.name).toBe(`${'a'.repeat(99)}😀.pdf`);
    expect(() => encodeURIComponent(payload.name)).not.toThrow();
    expect(registry.getCurrent()?.name).toBe(payload.name);

    // Over the limit the emoji is dropped whole instead of being cut in half.
    const longResponse = await openUpload(PDF_BYTES, `${'a'.repeat(100)}😀.pdf`);
    const longPayload = (await longResponse.json()) as { name: string };
    expect(longPayload.name).toBe(`${'a'.repeat(100)}.pdf`);
    expect(() => encodeURIComponent(longPayload.name)).not.toThrow();
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

describe('RPC without an active document', () => {
  it('answers 409 before calling the sidecar', async () => {
    const response = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'extract_metadata' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'No active document' });
    expect(send).not.toHaveBeenCalled();
  });

  it('recovers once a document is opened', async () => {
    expect((await openUpload()).status).toBe(200);

    const response = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'extract_metadata' }),
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith('extract_metadata', {}, 30_000);
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
