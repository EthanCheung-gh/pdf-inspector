// @vitest-environment node
/**
 * Browser RPC wiring for the raw PDF readers.
 *
 * The serialization itself is covered by the sidecar suite; these tests only
 * assert that the HTTP backend allows the three raw methods through, forwards
 * their params verbatim and gives them the raw budget instead of the 30s
 * default.
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
import { AUDIT_TIMEOUT_MS, RAW_TIMEOUT_MS } from '../../src/shared/constants';

/**
 * Sidecar answers, declared as plain objects: the raw contract lives in the
 * renderer (src/renderer/types/raw-pdf.ts) and the backend must stay free of
 * renderer imports - it only forwards whatever the sidecar returns.
 */
const CATALOG_REF = { objectNumber: 1, generation: 0 };

const DOCUMENT = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  roots: [{ label: 'Root', ref: CATALOG_REF, value: null }],
};

const OBJECT = {
  ref: { objectNumber: 15, generation: 0 },
  value: {
    kind: 'stream',
    dict: { kind: 'dict', entries: [], truncated: false },
    length: 512,
    filters: ['FlateDecode'],
    preview: null,
    truncated: false,
  },
  summary: 'stream (FlateDecode, 512 bytes)',
};

const CONTENT = {
  page: 2,
  streams: [
    {
      ref: { objectNumber: 16, generation: 0 },
      length: 64,
      filters: [],
      operators: [{ index: 0, offset: 0, operator: 'BT', operands: [] }],
      truncated: false,
      error: null,
    },
  ],
  truncated: false,
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

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(DOCUMENT);

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
  await registry.open('/tmp/pdf-inspector-raw-active.pdf', 'active.pdf', false, 1);
  send.mockClear();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/rpc raw allowlist', () => {
  it('forwards raw_document with the raw timeout', async () => {
    const response = await postRpc({ method: 'raw_document' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOCUMENT);
    expect(send.mock.calls).toEqual([['raw_document', {}, RAW_TIMEOUT_MS]]);
    expect(RAW_TIMEOUT_MS).toBe(120_000);
  });

  it('forwards raw_object params verbatim with the raw timeout', async () => {
    send.mockResolvedValueOnce(OBJECT);

    const response = await postRpc({
      method: 'raw_object',
      params: { object_number: 15, generation: 0 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OBJECT);
    expect(send.mock.calls).toEqual([
      ['raw_object', { object_number: 15, generation: 0 }, RAW_TIMEOUT_MS],
    ]);
  });

  it('forwards raw_page_content params verbatim with the raw timeout', async () => {
    send.mockResolvedValueOnce(CONTENT);

    const response = await postRpc({ method: 'raw_page_content', params: { page: 2 } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CONTENT);
    expect(send.mock.calls).toEqual([['raw_page_content', { page: 2 }, RAW_TIMEOUT_MS]]);
  });

  it('surfaces a sidecar range error instead of a partial payload', async () => {
    // The generic handler logs unexpected failures; silence it for this case.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    send.mockRejectedValueOnce(new Error('Invalid page: 9 (1..2)'));

    const response = await postRpc({ method: 'raw_page_content', params: { page: 9 } });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Invalid page: 9 (1..2)',
    );
    consoleError.mockRestore();
  });

  it('still rejects raw-like methods outside the allowlist', async () => {
    for (const method of ['raw_delete', 'raw_stream_bytes', 'open', 'shutdown']) {
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
    expect(send.mock.calls).toEqual([['extract_metadata', {}, 30_000]]);
    // Guard against every method silently inheriting a long budget.
    expect(send).not.toHaveBeenCalledWith('extract_metadata', {}, RAW_TIMEOUT_MS);
    expect(AUDIT_TIMEOUT_MS).toBe(RAW_TIMEOUT_MS);
  });
});
