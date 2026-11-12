// @vitest-environment node
/**
 * Browser RPC wiring for tagged-PDF accessibility.
 *
 * The Python structure parser and its findings are covered by the sidecar test
 * suite; these tests only assert that the HTTP backend allows
 * `accessibility_document` through, routes it to the background lane, gives it
 * the dedicated accessibility budget and returns the `AccessibilityReport`
 * verbatim.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  createWebServer,
  SidecarPool,
  type DiffUploadStore,
  type DocumentRegistry,
  type SidecarManager,
} from '../web-server';
import { ACCESSIBILITY_TIMEOUT_MS, OPEN_PDF_TIMEOUT_MS } from '../../src/shared/constants';
import { BACKGROUND_METHODS, laneForMethod } from '../../src/main/sidecar-pool';
import type { AccessibilityReport } from '../../src/shared/accessibility-types';

const ACCESSIBILITY_REPORT: AccessibilityReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 2,
    version: '1.6',
    encrypted: false,
    tagged: true,
    hasStructTreeRoot: true,
    hasParentTree: false,
    language: 'en-US',
    title: 'Tagged report',
    roleMap: { Chapter: 'Sect' },
    truncated: true,
    skipped: 2,
  },
  structure: [
    {
      id: '0',
      kind: 'element',
      role: 'Document',
      rawRole: 'Document',
      title: null,
      alt: null,
      actualText: null,
      lang: 'en-US',
      page: null,
      mcid: null,
      objectNumber: null,
      attributes: { Scope: null },
      truncated: true,
      children: [],
    },
  ],
  findings: [
    {
      category: 'structure',
      severity: 'warning',
      page: null,
      title: 'Structure tree has no ParentTree',
      detail: 'The document is tagged but the structure tree has no ParentTree.',
      evidence: 'hasStructTreeRoot=true hasParentTree=false',
      recommendation: 'Re-export the document with a complete structure tree.',
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

  send = vi.spyOn(sidecar, 'send').mockResolvedValue(ACCESSIBILITY_REPORT);

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
  await registry.open('/tmp/pdf-inspector-accessibility-active.pdf', 'active.pdf', false, 1);
  send.mockClear();
});

afterEach(async () => {
  await stopTestServer();
  vi.restoreAllMocks();
});

describe('POST /api/rpc accessibility allowlist', () => {
  it('forwards accessibility_document with the accessibility timeout and returns the report', async () => {
    const response = await postRpc({ method: 'accessibility_document' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ACCESSIBILITY_REPORT);
    expect(send).toHaveBeenCalledWith(
      'accessibility_document',
      {},
      ACCESSIBILITY_TIMEOUT_MS,
    );
    expect(ACCESSIBILITY_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('keeps the existing 409 when no document is active', async () => {
    await registry.close(registry.getActiveId() ?? '');

    const response = await postRpc({ method: 'accessibility_document' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'No active document',
    );
  });
});

/** The subset of the web `SidecarManager` the pool uses, with a fake process. */
class FakeLane {
  running = false;
  documentPath: string | null = null;

  send = vi.fn(
    async (method: string, _params?: Record<string, unknown>, _timeoutMs?: number) => {
      // A real manager starts on demand for `open`.
      if (!this.running) await this.start();
      return { method };
    },
  );
  start = vi.fn(async (): Promise<void> => {
    this.running = true;
  });
  restart = vi.fn(async (): Promise<void> => {
    this.running = true;
  });
  stop = vi.fn(async (): Promise<void> => {
    this.running = false;
  });
  isRunning = vi.fn((): boolean => this.running);
  setDocumentPath = vi.fn((filePath: string | null): void => {
    this.documentPath = filePath;
  });
}

const asManager = (lane: FakeLane): SidecarManager => lane as unknown as SidecarManager;

describe('web accessibility routing', () => {
  it('shares the desktop background route for accessibility_document', () => {
    expect(BACKGROUND_METHODS).toContain('accessibility_document');
    expect(laneForMethod('accessibility_document')).toBe('background');
  });

  it('sends the structure parse to the background lane only', async () => {
    const interactive = new FakeLane();
    interactive.running = true;
    const backgrounds: FakeLane[] = [];
    const pool = new SidecarPool({
      interactive: asManager(interactive),
      createBackground: () => {
        const lane = new FakeLane();
        backgrounds.push(lane);
        return asManager(lane);
      },
    });

    pool.setDocumentPath('/tmp/a.pdf');
    await pool.send('accessibility_document', {}, ACCESSIBILITY_TIMEOUT_MS);

    expect(interactive.send).not.toHaveBeenCalled();
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0].send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['accessibility_document', {}, ACCESSIBILITY_TIMEOUT_MS],
    ]);
  });
});
