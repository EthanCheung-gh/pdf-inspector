// @vitest-environment node
/**
 * URL opening semantics of the browser backend.
 *
 * A downloaded PDF is a document like any other: it gets a registry id, stays
 * addressable at `/doc/:id/:name` and is reused when the same URL is opened
 * again. The network is stubbed at the `pdf-url` boundary, so these tests pin:
 * - a repeated `sourceUrl` activates the existing document instead of
 *   downloading it a second time (no duplicate entry);
 * - opening a URL while another document is active switches back to it without
 *   another download;
 * - a download failure or a sidecar rejection keeps the previous active
 *   document and deletes the fresh copy.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

// Stub only the network boundary: URL parsing, magic checks and file deletion
// keep their real implementations so the handler's cleanup is exercised.
vi.mock('../../src/main/pdf-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pdf-url')>();
  return {
    ...actual,
    downloadPdfToFile: vi.fn(),
  };
});

import {
  createWebServer,
  type DiffUploadStore,
  type DocumentRegistry,
} from '../web-server';
import { downloadPdfToFile } from '../../src/main/pdf-url';

const PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n';

const SOURCE_A = 'https://example.com/files/first.pdf';
const SOURCE_B = 'https://example.com/files/second.pdf';

interface OpenPayload {
  canceled: boolean;
  path: string;
  metadata: unknown;
  name: string;
  sourceUrl?: string;
  documentId: string;
}

let server: Server;
let registry: DocumentRegistry;
let diffUploads: DiffUploadStore;
let baseUrl: string;
let workDir: string;
/** Paths the mocked downloader handed out, in call order. */
let downloaded: string[];
let downloadCount: number;
/** Full paths the registry asked the sidecar to open, in order. */
let openTargets: string[];
let failOpen: Map<string, number>;
let setDocumentPath: MockInstance;
/** Extra delay per sidecar `open`, so a check-then-act window becomes real. */
let openDelayMs: number;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function downloadMock() {
  return vi.mocked(downloadPdfToFile);
}

function openUrl(url: string): Promise<Response> {
  return fetch(`${baseUrl}/api/open-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

async function postOpenUrl(url: string): Promise<{ response: Response; payload: OpenPayload }> {
  const response = await openUrl(url);
  return { response, payload: (await response.json()) as OpenPayload };
}

/** Stand-in for the real downloader: a fresh file per call, like the caller. */
async function mockDownloadFile(): Promise<string> {
  const filePath = path.join(workDir, `download-${downloadCount++}.pdf`);
  await writeFile(filePath, PDF_BYTES);
  downloaded.push(filePath);
  return filePath;
}

function uploadPdf(name: string): Promise<Response> {
  return fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(name),
    },
    body: PDF_BYTES,
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'web-url-'));
  downloaded = [];
  downloadCount = 0;
  openTargets = [];
  failOpen = new Map();
  openDelayMs = 0;

  const download = downloadMock();
  download.mockReset();
  // Each download reserves a fresh local file, like reserveTempPdfFile does.
  // A dedicated temp dir keeps the real shared download directory untouched.
  download.mockImplementation(() => mockDownloadFile());

  const created = createWebServer();
  server = created.server;
  registry = created.registry;
  diffUploads = created.diffUploads;

  let inFlight = 0;
  vi.spyOn(created.sidecar, 'send').mockImplementation(
    async (method: string, params: Record<string, unknown> = {}) => {
      const target = typeof params.path === 'string' ? params.path : null;
      if (method !== 'open' || !target) return {};

      openTargets.push(target);
      inFlight += 1;
      try {
        // Small delay so a non-serialized caller would visibly overlap; a test
        // can stretch it to open a check-then-act window in the handler.
        if (openDelayMs > 0) await delay(openDelayMs);
        await delay(5);

        const basename = path.basename(target);
        const remaining = failOpen.get(basename) ?? 0;
        if (remaining > 0) {
          failOpen.set(basename, remaining - 1);
          throw new Error(`cannot open ${basename}`);
        }

        return { pageCount: 1, source: basename };
      } finally {
        inFlight -= 1;
      }
    },
  );
  setDocumentPath = vi.spyOn(created.sidecar, 'setDocumentPath');

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await diffUploads?.cleanup();
  await registry?.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  for (const file of downloaded) await rm(file, { force: true });
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /api/open-url', () => {
  it('returns a document id and reuses it for the same source URL', async () => {
    const first = await postOpenUrl(SOURCE_A);

    expect(first.response.status).toBe(200);
    expect(first.payload).toMatchObject({
      canceled: false,
      path: `/doc/${first.payload.documentId}/${encodeURIComponent('first.pdf')}`,
      name: 'first.pdf',
      sourceUrl: SOURCE_A,
    });
    expect(first.payload.documentId).toBeTruthy();
    expect(registry.findBySourceUrl(SOURCE_A)?.id).toBe(first.payload.documentId);
    expect(registry.findById(first.payload.documentId)).toMatchObject({
      sourceUrl: SOURCE_A,
      size: PDF_BYTES.length,
      isTemp: true,
    });

    // The downloader saw the parsed URL and the backend's download directory.
    expect(downloadMock()).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = downloadMock().mock.calls[0];
    expect(calledUrl.href).toBe(SOURCE_A);
    expect(calledOptions.directory).toMatch(/downloads$/);

    const again = await postOpenUrl(SOURCE_A);

    expect(again.response.status).toBe(200);
    expect(again.payload.documentId).toBe(first.payload.documentId);
    expect(again.payload.path).toBe(first.payload.path);
    expect(again.payload.metadata).toEqual(first.payload.metadata);
    // The pre-download lookup found the document, so no second download and no
    // duplicate entry for the same source.
    expect(downloadMock()).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.getActiveId()).toBe(first.payload.documentId);
  });

  it('registers exactly one document when the same URL is opened concurrently', async () => {
    // Two requests pass the pre-download lookup together, download together,
    // and — with a slow first open — also pass any post-download lookup before
    // the winner is registered. Only a dedupe inside the registry's serialized
    // mutation can keep this at one document.
    openDelayMs = 25;
    downloadMock().mockImplementation(async () => {
      await delay(10);
      return mockDownloadFile();
    });

    const responses = await Promise.all([openUrl(SOURCE_A), openUrl(SOURCE_A)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const payloads = (await Promise.all(
      responses.map((response) => response.json()),
    )) as OpenPayload[];

    expect(downloadMock()).toHaveBeenCalledTimes(2);
    expect(downloaded).toHaveLength(2);

    // Both responses describe the SAME document: the loser was deduped onto the
    // winner instead of creating a second tab for one URL.
    expect(payloads[0].documentId).toBe(payloads[1].documentId);
    expect(payloads[0].path).toBe(payloads[1].path);
    expect(payloads[0].sourceUrl).toBe(SOURCE_A);
    expect(registry.list()).toHaveLength(1);
    const registered = registry.findBySourceUrl(SOURCE_A);
    expect(registered?.id).toBe(payloads[0].documentId);

    // Only the winner's file was registered; the losing download is deleted.
    expect(downloaded).toContain(registered?.filePath);
    const orphanCopies = downloaded.filter((file) => file !== registered?.filePath);
    expect(orphanCopies).toHaveLength(1);
    expect(await fileExists(orphanCopies[0])).toBe(false);
    expect(await fileExists(registered?.filePath ?? '')).toBe(true);

    // The deduped request activated the (already active) winner: one open only.
    expect(openTargets).toEqual([registered?.filePath]);
  });

  it('activates an existing URL document without downloading it again', async () => {
    const urlDocument = await postOpenUrl(SOURCE_A);
    const upload = await uploadPdf('other.pdf');
    expect(upload.status).toBe(200);
    const uploadPayload = (await upload.json()) as OpenPayload;
    expect(registry.getActiveId()).toBe(uploadPayload.documentId);

    setDocumentPath.mockClear();
    const again = await postOpenUrl(SOURCE_A);

    expect(again.response.status).toBe(200);
    expect(again.payload.documentId).toBe(urlDocument.payload.documentId);
    expect(downloadMock()).toHaveBeenCalledTimes(1);
    expect(registry.getActiveId()).toBe(urlDocument.payload.documentId);
    expect(registry.list()).toHaveLength(2);
    expect(setDocumentPath).toHaveBeenLastCalledWith(
      registry.findById(urlDocument.payload.documentId)?.filePath,
    );
  });

  it('maps a download failure to 500 and keeps the previous document', async () => {
    const first = await postOpenUrl(SOURCE_A);
    downloadMock().mockRejectedValueOnce(new Error('Download failed with HTTP 404'));

    const failed = await postOpenUrl(SOURCE_B);

    expect(failed.response.status).toBe(500);
    expect(failed.payload).toEqual({ error: 'Download failed with HTTP 404' });
    expect(registry.getActiveId()).toBe(first.payload.documentId);
    expect(registry.list()).toHaveLength(1);
  });

  it('deletes the fresh download when the sidecar rejects it', async () => {
    const first = await postOpenUrl(SOURCE_A);
    failOpen.set('download-1.pdf', 1);

    const failed = await postOpenUrl(SOURCE_B);

    expect(failed.response.status).toBe(500);
    expect(failed.payload).toEqual({ error: 'cannot open download-1.pdf' });
    // The rejected copy is deleted; the previous document was restored.
    expect(downloaded).toHaveLength(2);
    expect(await fileExists(downloaded[1])).toBe(false);
    expect(openTargets.map((target) => path.basename(target))).toEqual([
      'download-0.pdf',
      'download-1.pdf',
      'download-0.pdf',
    ]);
    expect(registry.getActiveId()).toBe(first.payload.documentId);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a non-http URL before any download', async () => {
    const response = await openUrl('file:///etc/passwd');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Only http(s) URLs are supported' });
    expect(downloadMock()).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });
});
