// @vitest-environment node
/**
 * Diff endpoints: token upload, token/option validation, temp-file cleanup and
 * the guarantee that diffing never touches the current document.
 *
 * The sidecar is stubbed: the Python diff itself is covered by
 * `sidecar/__tests__/test_diff*.py`, so these tests only exercise transport.
 */
import { mkdtemp, readdir, stat, writeFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  createWebServer,
  DiffUploadStore,
  type DiffUploadStoreOptions,
  type DocumentRegistry,
  type SidecarPool,
} from '../web-server';
import { DIFF_TIMEOUT_MS, OPEN_PDF_TIMEOUT_MS } from '../../src/shared/constants';
import type { DiffResult } from '../../src/shared/diff-types';

const PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n';

const DIFF_RESULT: DiffResult = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
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
    pagesChanged: 1,
    pagesReordered: 0,
    objectsAdded: 0,
    objectsRemoved: 0,
    objectsMoved: 0,
    objectsModified: 1,
  },
  pages: [],
};

let server: Server;
let sidecar: SidecarPool;
let registry: DocumentRegistry;
let diffUploads: DiffUploadStore;
let send: MockInstance;
let restartBackground: MockInstance;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  const created = createWebServer();
  server = created.server;
  sidecar = created.sidecar;
  registry = created.registry;
  diffUploads = created.diffUploads;

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(DIFF_RESULT);
  restartBackground = vi.spyOn(sidecar, 'restartBackground').mockResolvedValue(undefined);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer(): Promise<void> {
  await diffUploads.cleanup();
  await registry.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function uploadDiffFile(
  side: string | null,
  body: string = PDF_BYTES,
  name = 'document.pdf',
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'X-Filename': encodeURIComponent(name),
  };
  if (side !== null) headers['X-Diff-Side'] = side;
  return fetch(`${baseUrl}/api/diff/file`, {
    method: 'POST',
    headers,
    body,
  });
}

async function uploadSide(side: 'old' | 'new'): Promise<string> {
  const response = await uploadDiffFile(side);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { token?: unknown };
  expect(typeof payload.token).toBe('string');
  return payload.token as string;
}

async function postDiff(payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/diff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Files currently waiting in the diff temp directory. */
async function diffDirFiles(): Promise<string[]> {
  try {
    const entries = await readdir(diffUploads.directoryPath);
    return entries.map((entry) => path.join(diffUploads.directoryPath, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

beforeEach(async () => {
  await startTestServer();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/diff/file', () => {
  it('stores the PDF under a token without opening it or replacing the document', async () => {
    const response = await uploadDiffFile('old', PDF_BYTES, 'old version.pdf');

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      token: string;
      side: string;
      name: string;
      size: number;
    };
    expect(payload.token).toBeTruthy();
    expect(payload.side).toBe('old');
    expect(payload.name).toBe('old version.pdf');
    expect(payload.size).toBe(PDF_BYTES.length);

    const files = await diffDirFiles();
    expect(files).toHaveLength(1);
    expect(await stat(files[0])).toBeTruthy();

    // No sidecar call at all: the upload only writes a temp file.
    expect(send).not.toHaveBeenCalled();
    expect(registry.getCurrent()).toBeNull();
  });

  it('rejects a missing or unknown X-Diff-Side header', async () => {
    for (const side of [null, 'both']) {
      const response = await uploadDiffFile(side);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toContain('X-Diff-Side');
    }

    expect(await diffDirFiles()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a non-PDF body and removes the partial file', async () => {
    const response = await uploadDiffFile('new', 'plain text, not a PDF');

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe('The uploaded file is not a PDF');
    expect(await diffDirFiles()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sanitizes traversal attempts in the file name instead of using them as a path', async () => {
    const response = await uploadDiffFile('old', PDF_BYTES, '../../etc/passwd.pdf');

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { name: string };
    expect(payload.name).not.toContain('/');
    expect(payload.name).not.toContain('..');

    const files = await diffDirFiles();
    expect(files).toHaveLength(1);
    expect(path.dirname(files[0])).toBe(diffUploads.directoryPath);
  });
});

describe('POST /api/diff', () => {
  it('diffs the two uploads, converts options and deletes both files', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');
    const filesBefore = await diffDirFiles();
    expect(filesBefore).toHaveLength(2);

    const diffedPaths: { old: string; new: string } = { old: '', new: '' };
    send.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe('diff_documents');
      diffedPaths.old = String(params.old_path);
      diffedPaths.new = String(params.new_path);
      // Both files must still exist while the sidecar runs.
      await stat(diffedPaths.old);
      await stat(diffedPaths.new);
      return DIFF_RESULT;
    });

    const response = await postDiff({
      oldToken,
      newToken,
      options: {
        positionTolerance: 2,
        ignoreImages: true,
        textTolerance: 'exact',
        ignoreRegions: [{ oldPage: 1, newPage: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DIFF_RESULT);
    expect(send).toHaveBeenCalledWith(
      'diff_documents',
      {
        old_path: diffedPaths.old,
        new_path: diffedPaths.new,
        options: {
          position_tolerance: 2,
          text_tolerance: 'exact',
          ignore_images: true,
          // Drawn regions arrive camelCase and reach the sidecar snake_case.
          ignore_regions: [
            {
              old_page: 1,
              new_page: 1,
              bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
            },
          ],
        },
      },
      DIFF_TIMEOUT_MS,
    );

    // Temporary copies are gone and the current document is still untouched.
    await expect(stat(diffedPaths.old)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(diffedPaths.new)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await diffDirFiles()).toHaveLength(0);
    expect(registry.getCurrent()).toBeNull();
    expect(send).not.toHaveBeenCalledWith('open', expect.anything());
  });

  it('treats tokens as single use', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');

    expect((await postDiff({ oldToken, newToken })).status).toBe(200);

    const replay = await postDiff({ oldToken, newToken });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      'Unknown or expired "oldToken"',
    );
    expect(await diffDirFiles()).toHaveLength(0);
  });

  it('rejects unknown tokens and still deletes the token that was consumed', async () => {
    const oldToken = await uploadSide('old');

    const response = await postDiff({ oldToken, newToken: 'not-a-token' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Unknown or expired "newToken"',
    );
    // The consumed old upload must not be leaked by the failed request.
    expect(await diffDirFiles()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires a token for each side and a JSON object body', async () => {
    const missingOld = await postDiff({ newToken: 'x' });
    expect(missingOld.status).toBe(400);
    expect(((await missingOld.json()) as { error: string }).error).toBe('Missing "oldToken"');

    const missingNew = await postDiff({ oldToken: 'x' });
    expect(missingNew.status).toBe(400);
    expect(((await missingNew.json()) as { error: string }).error).toBe('Missing "newToken"');

    const badOptions = await postDiff({ oldToken: 'x', newToken: 'y', options: ['nope'] });
    expect(badOptions.status).toBe(400);
    expect(((await badOptions.json()) as { error: string }).error).toBe(
      '"options" must be an object',
    );
  });

  it('rejects tokens uploaded for the wrong side and cleans both up', async () => {
    const firstOld = await uploadSide('old');
    const secondOld = await uploadSide('old');

    const response = await postDiff({ oldToken: firstOld, newToken: secondOld });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      '"newToken" does not refer to a "new" upload',
    );
    expect(await diffDirFiles()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps a sidecar diff failure to a 400 and still deletes the uploads', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');
    send.mockRejectedValueOnce(new Error("Cannot open old PDF '/tmp/token.pdf'"));

    const response = await postDiff({ oldToken, newToken });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Cannot open old PDF '/tmp/token.pdf'",
    );
    expect(await diffDirFiles()).toHaveLength(0);
    // A parse/option error leaves both lanes alone: only a timeout can hide an
    // abandoned computation.
    expect(restartBackground).not.toHaveBeenCalled();
  });

  it('maps a sidecar timeout to 504 and restarts the background lane', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');
    send.mockRejectedValueOnce(
      new Error('Request "diff_documents" timed out after 300s without progress'),
    );

    const response = await postDiff({ oldToken, newToken });

    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Request "diff_documents" timed out after 300s without progress',
    );
    // The abandoned diff may still be running in the background process.
    expect(restartBackground).toHaveBeenCalledTimes(1);
    expect(await diffDirFiles()).toHaveLength(0);
  });

  it('still answers 504 when the background restart itself fails', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');
    send.mockRejectedValueOnce(
      new Error('Request "diff_documents" timed out after 300s without progress'),
    );
    restartBackground.mockRejectedValueOnce(new Error('Sidecar is stopping'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await postDiff({ oldToken, newToken });

    expect(response.status).toBe(504);
    expect(restartBackground).toHaveBeenCalledTimes(1);
  });

  it('does not restart the lane for a non-diff timeout', async () => {
    const oldToken = await uploadSide('old');
    const newToken = await uploadSide('new');
    send.mockRejectedValueOnce(
      new Error('Request "open" timed out after 120s without progress'),
    );

    const response = await postDiff({ oldToken, newToken });

    expect(response.status).toBe(504);
    expect(restartBackground).not.toHaveBeenCalled();
  });
});

describe('POST /api/open (shared upload path)', () => {
  async function openUpload(body: string): Promise<Response> {
    return fetch(`${baseUrl}/api/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent('doc.pdf'),
      },
      body,
    });
  }

  it('still opens a valid upload as the current document', async () => {
    const response = await openUpload(PDF_BYTES);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      canceled: boolean;
      path: string;
      name: string;
    };
    expect(payload.canceled).toBe(false);
    expect(payload.path).toMatch(/^\/doc\/[^/]+\/doc\.pdf$/);
    expect(registry.getCurrent()?.name).toBe('doc.pdf');
    expect(send).toHaveBeenCalledWith(
      'open',
      { path: expect.stringMatching(/doc\.pdf$/) },
      OPEN_PDF_TIMEOUT_MS,
    );
  });

  it('rejects a non-PDF without changing the current document', async () => {
    const response = await openUpload('definitely not a PDF');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'The uploaded file is not a PDF',
    );
    expect(registry.getCurrent()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('DiffUploadStore', () => {
  const created: string[] = [];

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'diff-store-'));
    created.push(dir);
    return dir;
  }

  async function addUpload(
    store: DiffUploadStore,
    directory: string,
    name = 'upload.pdf',
  ): Promise<{ token: string; filePath: string }> {
    const filePath = path.join(directory, name);
    await writeFile(filePath, PDF_BYTES);
    const upload = await store.add({
      filePath,
      side: 'old',
      name,
      size: PDF_BYTES.length,
    });
    return { token: upload.token, filePath: upload.filePath };
  }

  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('refuses files outside its directory', async () => {
    const directory = await tempDir();
    const outside = await tempDir();
    const store = new DiffUploadStore({ directory });

    await expect(
      store.add({
        filePath: path.join(outside, 'escape.pdf'),
        side: 'new',
        name: 'escape.pdf',
        size: 1,
      }),
    ).rejects.toThrow('diff temporary directory');
    expect(store.size).toBe(0);
  });

  it('returns each token once and forgets unknown tokens', async () => {
    const directory = await tempDir();
    const store = new DiffUploadStore({ directory });
    const { token } = await addUpload(store, directory);

    await expect(store.take(token)).resolves.toMatchObject({ side: 'old' });
    await expect(store.take(token)).resolves.toBeNull();
    await expect(store.take('nope')).resolves.toBeNull();
    await expect(store.take(undefined)).resolves.toBeNull();
  });

  it('expires tokens after the TTL and deletes their files', async () => {
    const directory = await tempDir();
    let now = 1_000;
    const options: DiffUploadStoreOptions = {
      directory,
      ttlMs: 5_000,
      now: () => now,
    };
    const store = new DiffUploadStore(options);
    const { token, filePath } = await addUpload(store, directory);

    now += 5_000;
    await expect(store.take(token)).resolves.toBeNull();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('evicts the oldest upload past the cap', async () => {
    const directory = await tempDir();
    const store = new DiffUploadStore({ directory, maxUploads: 2 });
    const first = await addUpload(store, directory, 'first.pdf');
    await addUpload(store, directory, 'second.pdf');
    await addUpload(store, directory, 'third.pdf');

    expect(store.size).toBe(2);
    await expect(stat(first.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('evicts uploads past the total byte cap', async () => {
    const directory = await tempDir();
    const store = new DiffUploadStore({
      directory,
      maxUploads: 10,
      maxBytes: PDF_BYTES.length * 2 - 1,
    });

    const first = await addUpload(store, directory, 'first.pdf');
    await addUpload(store, directory, 'second.pdf');

    expect(store.size).toBe(1);
    expect(store.totalBytes).toBe(PDF_BYTES.length);
    await expect(stat(first.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleanup unlinks every pending file', async () => {
    const directory = await tempDir();
    const store = new DiffUploadStore({ directory });
    const first = await addUpload(store, directory, 'first.pdf');
    const second = await addUpload(store, directory, 'second.pdf');

    await store.cleanup();

    expect(store.size).toBe(0);
    await expect(stat(first.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(second.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
