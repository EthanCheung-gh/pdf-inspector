// @vitest-environment node
/**
 * DocumentRegistry: the bounded multi-document core of the browser backend.
 *
 * The sidecar still holds exactly one document, so these tests drive the
 * registry directly (no HTTP) with real temporary PDFs and a fake sidecar pool.
 * What is pinned here:
 * - two documents stay addressable and switching re-opens the target file;
 * - a failed open/activate restores the previous active document and leaves the
 *   registry untouched (and drops the active id when the restore fails too);
 * - closing/LRU/cleanup delete only the temporary files they own;
 * - the 8-document / 512 MiB bounds evict the least recently used INACTIVE doc;
 * - every mutation is serialized, so concurrent opens reach the sidecar in a
 *   deterministic order.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import {
  createWebServer,
  DocumentRegistry,
  DocumentRegistryError,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_TOTAL_BYTES,
  type DiffUploadStore,
  type OpenedDocument,
  type SidecarPool,
} from '../web-server';
import { OPEN_PDF_TIMEOUT_MS } from '../../src/shared/constants';

/**
 * A Windows-style locked file cannot be simulated portably, so `unlink` can be
 * made to fail a given number of times per path (the same approach as
 * src/main/__tests__/pdf-url.test.ts). This is the exact call `web-server.ts`
 * makes, so the registry's pending-deletion queue is exercised for real while
 * every other filesystem operation stays real too.
 */
const unlinkFaults = vi.hoisted(() => new Map<string, number>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (filePath: string) => {
      const remaining = unlinkFaults.get(filePath) ?? 0;
      if (remaining > 0) {
        unlinkFaults.set(filePath, remaining - 1);
        const error = new Error(
          `EPERM: operation not permitted, unlink '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.unlink(filePath);
    },
  };
});

const DEFAULT_SIZE = 64;

interface SidecarCall {
  method: string;
  /** Target file of an `open`; undefined for other methods. */
  target: string | null;
  timeoutMs: number | undefined;
}

/**
 * Structural stand-in for `SidecarPool`: only the two members the registry uses
 * are needed, and recording them keeps the assertions independent of the real
 * child-process machinery.
 */
interface FakeSidecar {
  calls: SidecarCall[];
  /** Path the sidecar currently has open, as tracked by `setDocumentPath`. */
  documentPath: string | null;
  /** Path -> number of upcoming `open`s that must fail. */
  failNextOpen: Map<string, number>;
  /** Delay per open, so an unserialized registry would interleave. */
  openDelayMs: number;
  /** Highest number of simultaneously in-flight opens (must stay 1). */
  maxConcurrentOpens: number;
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  setDocumentPath(filePath: string | null): void;
  /** Basenames of every `open` the registry sent, in order. */
  opens(): string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeSidecar(): FakeSidecar {
  let inFlight = 0;

  const fake: FakeSidecar = {
    calls: [],
    documentPath: null,
    failNextOpen: new Map(),
    openDelayMs: 0,
    maxConcurrentOpens: 0,

    async send(method, params = {}, timeoutMs) {
      const target = typeof params.path === 'string' ? params.path : null;
      fake.calls.push({ method, target, timeoutMs });

      if (method !== 'open') return {};

      inFlight += 1;
      fake.maxConcurrentOpens = Math.max(fake.maxConcurrentOpens, inFlight);
      try {
        if (fake.openDelayMs > 0) await delay(fake.openDelayMs);

        const remaining = target ? fake.failNextOpen.get(target) ?? 0 : 0;
        if (target && remaining > 0) {
          fake.failNextOpen.set(target, remaining - 1);
          throw new Error(`cannot open ${path.basename(target)}`);
        }

        // Mimic SidecarPool: a successful open becomes the tracked document.
        fake.documentPath = target;
        return { pageCount: 1, source: target ? path.basename(target) : null };
      } finally {
        inFlight -= 1;
      }
    },

    setDocumentPath(filePath) {
      fake.documentPath = filePath;
    },

    opens() {
      return fake.calls
        .filter((call) => call.method === 'open' && call.target !== null)
        .map((call) => path.basename(call.target as string));
    },
  };

  return fake;
}

let workDir: string;
let sidecar: FakeSidecar;
let registry: DocumentRegistry;

function createRegistry(options: { maxDocuments?: number; maxTotalBytes?: number } = {}): DocumentRegistry {
  registry = new DocumentRegistry(sidecar as unknown as SidecarPool, options);
  return registry;
}

/** Write a real PDF-ish temp file the registry can own as its `filePath`. */
async function createPdf(
  name: string,
  size: number = DEFAULT_SIZE,
): Promise<{ filePath: string; size: number }> {
  const filePath = path.join(workDir, name);
  const content = Buffer.alloc(size, 0x20);
  content.write('%PDF-1.7\n', 0, 'utf8');
  await writeFile(filePath, content);
  return { filePath, size: content.length };
}

/** Create the temp file and register it, like `POST /api/open` does. */
async function openPdf(
  name: string,
  options: {
    size?: number;
    isTemp?: boolean;
    sourceUrl?: string | null;
  } = {},
): Promise<OpenedDocument> {
  const file = await createPdf(name, options.size ?? DEFAULT_SIZE);
  return registry.open(
    file.filePath,
    name,
    options.isTemp ?? true,
    file.size,
    options.sourceUrl ?? null,
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'web-multidoc-'));
  sidecar = createFakeSidecar();
  unlinkFaults.clear();
});

afterEach(async () => {
  await registry?.cleanup();
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('defaults and addressing', () => {
  it('defaults to 8 documents and a 512 MiB budget', () => {
    expect(MAX_DOCUMENTS).toBe(8);
    expect(MAX_DOCUMENT_TOTAL_BYTES).toBe(512 * 1024 * 1024);
  });

  it('describes documents for the UI without exposing disk paths in the URL', async () => {
    createRegistry();
    const opened = await openPdf('报告 2024.pdf', { size: 128, sourceUrl: 'https://example.com/a.pdf' });

    expect(opened.doc).toMatchObject({
      filePath: path.join(workDir, '报告 2024.pdf'),
      name: '报告 2024.pdf',
      isTemp: true,
      size: 128,
      sourceUrl: 'https://example.com/a.pdf',
      metadata: { pageCount: 1, source: '报告 2024.pdf' },
    });
    expect(opened.doc.id).toBeTruthy();
    expect(opened.metadata).toEqual(opened.doc.metadata);

    expect(registry.urlFor(opened.doc)).toBe(
      `/doc/${opened.doc.id}/${encodeURIComponent('报告 2024.pdf')}`,
    );
    expect(registry.findById(opened.doc.id)).toBe(opened.doc);
    expect(registry.findById('missing')).toBeNull();
    expect(registry.findBySourceUrl('https://example.com/a.pdf')).toBe(opened.doc);
    expect(registry.findBySourceUrl('https://example.com/b.pdf')).toBeNull();
    expect(registry.getActiveId()).toBe(opened.doc.id);
    expect(registry.getActive()).toBe(opened.doc);

    // Uploads/local documents have no source URL.
    const upload = await openPdf('upload.pdf');
    expect(upload.doc.sourceUrl).toBeNull();
    expect(registry.findBySourceUrl('https://example.com/a.pdf')).toBe(opened.doc);
  });
});

describe('two documents', () => {
  it('keeps both addressable and switches the sidecar to the activated file', async () => {
    createRegistry();

    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');

    expect(await exists(first.doc.filePath)).toBe(true);
    expect(await exists(second.doc.filePath)).toBe(true);
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(registry.list().map((doc) => doc.name)).toEqual(['second.pdf', 'first.pdf']);
    // Every open uses the dedicated open budget, never the 30s default.
    expect(sidecar.calls.map((call) => call.timeoutMs)).toEqual([
      OPEN_PDF_TIMEOUT_MS,
      OPEN_PDF_TIMEOUT_MS,
    ]);

    const activated = await registry.activate(first.doc.id);

    expect(activated.doc.id).toBe(first.doc.id);
    expect(activated.metadata).toEqual({ pageCount: 1, source: 'first.pdf' });
    expect(registry.getActiveId()).toBe(first.doc.id);
    expect(sidecar.documentPath).toBe(first.doc.filePath);
    expect(sidecar.opens()).toEqual(['first.pdf', 'second.pdf', 'first.pdf']);

    // The switch neither moved nor deleted the non-active document.
    expect(registry.findById(second.doc.id)).not.toBeNull();
    expect(await exists(second.doc.filePath)).toBe(true);
    expect(await exists(first.doc.filePath)).toBe(true);

    // Re-activating the active document returns cached metadata, no sidecar call.
    const callsBefore = sidecar.calls.length;
    const again = await registry.activate(first.doc.id);
    expect(again.metadata).toEqual(activated.metadata);
    expect(sidecar.calls.length).toBe(callsBefore);
  });

  it('rejects an unknown id with a not_found error', async () => {
    createRegistry();
    await openPdf('only.pdf');

    await expect(registry.activate('missing')).rejects.toMatchObject({
      name: 'DocumentRegistryError',
      code: 'not_found',
    });
    await expect(registry.close('missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('URL de-duplication', () => {
  const SOURCE_URL = 'https://example.com/report.pdf';

  it('activates the registered document instead of adopting a second copy', async () => {
    createRegistry();
    const first = await openPdf('first.pdf', { sourceUrl: SOURCE_URL });
    const other = await openPdf('other.pdf');
    const duplicate = await createPdf('duplicate.pdf');
    sidecar.calls.length = 0;

    const result = await registry.openDeduped(
      duplicate.filePath,
      'report.pdf',
      true,
      duplicate.size,
      SOURCE_URL,
    );

    expect(result.deduped).toBe(true);
    // The existing document is the answer, and it is active again.
    expect(result.opened.doc.id).toBe(first.doc.id);
    expect(result.opened.metadata).toEqual({ pageCount: 1, source: 'first.pdf' });
    expect(registry.getActiveId()).toBe(first.doc.id);
    expect(sidecar.opens()).toEqual(['first.pdf']);
    // The duplicate was neither opened nor registered: the caller deletes it.
    expect(registry.list()).toHaveLength(2);
    expect(registry.findById(other.doc.id)).not.toBeNull();
    expect(registry.findById(first.doc.id)).toBe(first.doc);
    expect(await exists(duplicate.filePath)).toBe(true);
  });

  it('opens the file as a new document while the URL is unknown', async () => {
    createRegistry();
    const file = await createPdf('fresh.pdf');

    const result = await registry.openDeduped(
      file.filePath,
      'fresh.pdf',
      true,
      file.size,
      'https://example.com/fresh.pdf',
    );

    expect(result.deduped).toBe(false);
    expect(result.opened.doc.filePath).toBe(file.filePath);
    expect(registry.getActiveId()).toBe(result.opened.doc.id);
    expect(registry.findBySourceUrl('https://example.com/fresh.pdf')).toBe(result.opened.doc);
  });

  it('restores the previous active document when activating the existing one fails', async () => {
    createRegistry();
    const first = await openPdf('first.pdf', { sourceUrl: SOURCE_URL });
    const second = await openPdf('second.pdf');
    const duplicate = await createPdf('duplicate.pdf');
    sidecar.failNextOpen.set(first.doc.filePath, 1);

    await expect(
      registry.openDeduped(duplicate.filePath, 'report.pdf', true, duplicate.size, SOURCE_URL),
    ).rejects.toThrow('cannot open first.pdf');

    // Same recovery as a failing activate: the previous view stays active, no
    // document was added and the caller still owns its copy.
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(sidecar.documentPath).toBe(second.doc.filePath);
    expect(registry.list()).toHaveLength(2);
    expect(await exists(duplicate.filePath)).toBe(true);
  });
});

describe('failure recovery', () => {
  it('reopens the previous document and keeps the map when an open fails', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const secondPath = path.join(workDir, 'second.pdf');
    await writeFile(secondPath, '%PDF-1.7\n');
    sidecar.calls.length = 0;

    sidecar.failNextOpen.set(secondPath, 1);

    await expect(registry.open(secondPath, 'second.pdf', true, 9)).rejects.toThrow(
      'cannot open second.pdf',
    );

    // Failing open, then exactly one best-effort restore of the previous file.
    expect(sidecar.opens()).toEqual(['second.pdf', 'first.pdf']);
    expect(registry.getActiveId()).toBe(first.doc.id);
    expect(registry.list()).toHaveLength(1);
    expect(sidecar.documentPath).toBe(first.doc.filePath);
    // The rejected copy belongs to the caller: the registry must not unlink it.
    expect(await exists(secondPath)).toBe(true);
  });

  it('drops the active document when the previous one cannot be restored either', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const secondPath = path.join(workDir, 'second.pdf');
    await writeFile(secondPath, '%PDF-1.7\n');

    sidecar.failNextOpen.set(secondPath, 1);
    sidecar.failNextOpen.set(first.doc.filePath, 1);

    await expect(registry.open(secondPath, 'second.pdf', true, 9)).rejects.toThrow(
      'cannot open second.pdf',
    );

    // No document is open in the sidecar, so the registry must not claim one.
    expect(registry.getActive()).toBeNull();
    expect(registry.getActiveId()).toBeNull();
    expect(sidecar.documentPath).toBeNull();
    // The map is still untouched: the old document remains addressable.
    expect(registry.findById(first.doc.id)).not.toBeNull();
    expect(registry.list()).toHaveLength(1);
  });

  it('leaves an empty registry when the very first open fails', async () => {
    createRegistry();
    const onlyPath = path.join(workDir, 'broken.pdf');
    await writeFile(onlyPath, '%PDF-1.7\n');
    sidecar.failNextOpen.set(onlyPath, 1);

    await expect(registry.open(onlyPath, 'broken.pdf', true, 9)).rejects.toThrow(
      'cannot open broken.pdf',
    );

    expect(registry.list()).toEqual([]);
    expect(registry.getActive()).toBeNull();
    expect(sidecar.documentPath).toBeNull();
    expect(sidecar.opens()).toEqual(['broken.pdf']);
  });

  it('keeps the active document when an activation fails', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    sidecar.calls.length = 0;

    sidecar.failNextOpen.set(first.doc.filePath, 1);

    await expect(registry.activate(first.doc.id)).rejects.toThrow('cannot open first.pdf');

    expect(sidecar.opens()).toEqual(['first.pdf', 'second.pdf']);
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(sidecar.documentPath).toBe(second.doc.filePath);
    expect(registry.list()).toHaveLength(2);
    expect(await exists(first.doc.filePath)).toBe(true);
  });

  it('drops the active document when the activation restore fails too', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');

    sidecar.failNextOpen.set(first.doc.filePath, 1);
    sidecar.failNextOpen.set(second.doc.filePath, 1);

    await expect(registry.activate(first.doc.id)).rejects.toThrow('cannot open first.pdf');

    expect(registry.getActive()).toBeNull();
    expect(sidecar.documentPath).toBeNull();
    // Both entries survive: a dead sidecar is not a registry mutation.
    expect(registry.list()).toHaveLength(2);
  });
});

describe('closing documents', () => {
  it('closes an inactive document and deletes only its temporary file', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    sidecar.calls.length = 0;

    const result = await registry.close(first.doc.id);

    expect(result.closed.id).toBe(first.doc.id);
    expect(result.activeDocumentId).toBe(second.doc.id);
    expect(await exists(first.doc.filePath)).toBe(false);
    expect(await exists(second.doc.filePath)).toBe(true);
    expect(registry.findById(first.doc.id)).toBeNull();
    expect(registry.findById(second.doc.id)).not.toBeNull();
    // Closing an inactive document does not touch the sidecar at all.
    expect(sidecar.opens()).toEqual([]);
    expect(sidecar.documentPath).toBe(second.doc.filePath);
  });

  it('refuses to close the active document while a sibling is registered', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');

    const failure = await registry.close(second.doc.id).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DocumentRegistryError);
    expect((failure as DocumentRegistryError).code).toBe('conflict');
    // Nothing changed: the UI must activate a neighbour first.
    expect(registry.list()).toHaveLength(2);
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(await exists(second.doc.filePath)).toBe(true);
    expect(await exists(first.doc.filePath)).toBe(true);
  });

  it('closes the last active document and clears the sidecar document', async () => {
    createRegistry();
    const only = await openPdf('only.pdf');

    const result = await registry.close(only.doc.id);

    expect(result.activeDocumentId).toBeNull();
    expect(registry.getActive()).toBeNull();
    expect(registry.getActiveId()).toBeNull();
    expect(sidecar.documentPath).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(await exists(only.doc.filePath)).toBe(false);

    // A second close is a plain not-found, not a crash.
    await expect(registry.close(only.doc.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never deletes a document it does not own as a temporary file', async () => {
    createRegistry();
    const local = await openPdf('local.pdf', { isTemp: false });

    await registry.close(local.doc.id);

    expect(await exists(local.doc.filePath)).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});

describe('bounds and LRU eviction', () => {
  it('evicts the least recently activated inactive document past the count bound', async () => {
    createRegistry({ maxDocuments: 2 });
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    // Make the untouched second document the LRU candidate.
    await registry.activate(first.doc.id);
    const third = await openPdf('third.pdf');

    expect(registry.getActiveId()).toBe(third.doc.id);
    expect(registry.list().map((doc) => doc.name)).toEqual(['third.pdf', 'first.pdf']);
    expect(registry.findById(second.doc.id)).toBeNull();
    expect(await exists(second.doc.filePath)).toBe(false);
    expect(await exists(first.doc.filePath)).toBe(true);
    expect(await exists(third.doc.filePath)).toBe(true);
  });

  it('never evicts the active document', async () => {
    createRegistry({ maxDocuments: 1 });
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');

    expect(registry.list().map((doc) => doc.name)).toEqual(['second.pdf']);
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(registry.findById(first.doc.id)).toBeNull();
    expect(await exists(first.doc.filePath)).toBe(false);
    expect(await exists(second.doc.filePath)).toBe(true);
  });

  it('applies the default 8-document bound', async () => {
    createRegistry();
    const opened: OpenedDocument[] = [];
    for (let index = 0; index < MAX_DOCUMENTS + 1; index += 1) {
      opened.push(await openPdf(`doc-${index}.pdf`));
    }

    expect(registry.list()).toHaveLength(MAX_DOCUMENTS);
    expect(registry.findById(opened[0].doc.id)).toBeNull();
    expect(await exists(opened[0].doc.filePath)).toBe(false);
    expect(registry.getActiveId()).toBe(opened[MAX_DOCUMENTS].doc.id);
  });

  it('evicts inactive documents to stay within the total byte budget', async () => {
    createRegistry({ maxTotalBytes: 100 });
    const first = await openPdf('first.pdf', { size: 60 });
    const second = await openPdf('second.pdf', { size: 60 });

    expect(registry.list().map((doc) => doc.name)).toEqual(['second.pdf']);
    expect(registry.getActiveId()).toBe(second.doc.id);
    expect(await exists(first.doc.filePath)).toBe(false);
    expect(await exists(second.doc.filePath)).toBe(true);
  });

  it('rejects a document larger than the whole budget before calling the sidecar', async () => {
    createRegistry({ maxTotalBytes: 100 });
    const hugePath = path.join(workDir, 'huge.pdf');
    await writeFile(hugePath, Buffer.alloc(200, 0x20).fill('%PDF-1.7\n', 0, 9));

    const failure = await registry
      .open(hugePath, 'huge.pdf', true, 200)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DocumentRegistryError);
    expect((failure as DocumentRegistryError).code).toBe('too_large');
    expect((failure as Error).message).toContain('100 bytes');
    // Rejected before any sidecar interaction, and the copy stays for the caller.
    expect(sidecar.calls).toEqual([]);
    expect(sidecar.documentPath).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(await exists(hugePath)).toBe(true);
  });
});

describe('cleanup', () => {
  it('deletes every temporary document, clears the map and is idempotent', async () => {
    createRegistry();
    const first = await openPdf('first.pdf');
    const second = await openPdf('second.pdf');
    const local = await openPdf('local.pdf', { isTemp: false });

    await registry.cleanup();

    expect(registry.list()).toEqual([]);
    expect(registry.getActive()).toBeNull();
    expect(registry.getActiveId()).toBeNull();
    expect(registry.findById(first.doc.id)).toBeNull();
    expect(sidecar.documentPath).toBeNull();
    expect(await exists(first.doc.filePath)).toBe(false);
    expect(await exists(second.doc.filePath)).toBe(false);
    expect(await exists(local.doc.filePath)).toBe(true);

    await registry.cleanup();
    expect(registry.list()).toEqual([]);
  });
});

describe('pending deletions', () => {
  it('queues the last active document when unlink fails and deletes it after the next open', async () => {
    createRegistry();
    const held = await createPdf('held.pdf');
    const opened = await registry.open(held.filePath, 'held.pdf', true, held.size);

    // Windows: the sidecar still holds the extractor of the active document, so
    // its temp file cannot be unlinked while it is being closed.
    unlinkFaults.set(held.filePath, 1);

    const closed = await registry.close(opened.doc.id);

    // The close itself succeeds: only the unlink is deferred.
    expect(closed.activeDocumentId).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(await exists(held.filePath)).toBe(true);
    // The path is queued, not forgotten.
    expect(registry.pendingDeletionPaths()).toEqual([held.filePath]);

    // The next successful open replaced the extractor that held the file, so the
    // queued deletion is retried (and succeeds) without extra bookkeeping.
    const next = await openPdf('next.pdf');
    expect(await exists(held.filePath)).toBe(false);
    expect(registry.pendingDeletionPaths()).toEqual([]);
    expect(await exists(next.doc.filePath)).toBe(true);
  });

  it('retries a queued file on cleanup even though the registry is empty', async () => {
    createRegistry();
    const held = await createPdf('held.pdf');
    const opened = await registry.open(held.filePath, 'held.pdf', true, held.size);

    unlinkFaults.set(held.filePath, 1);
    await registry.close(opened.doc.id);
    expect(registry.pendingDeletionPaths()).toEqual([held.filePath]);

    await registry.cleanup();

    expect(await exists(held.filePath)).toBe(false);
    expect(registry.pendingDeletionPaths()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('keeps a still-locked file queued instead of losing it', async () => {
    createRegistry();
    const held = await createPdf('held.pdf');
    const opened = await registry.open(held.filePath, 'held.pdf', true, held.size);

    // Both the close and the cleanup retry fail: the file stays tracked.
    unlinkFaults.set(held.filePath, 2);
    await registry.close(opened.doc.id);
    await registry.cleanup();

    expect(await exists(held.filePath)).toBe(true);
    expect(registry.pendingDeletionPaths()).toEqual([held.filePath]);

    // The afterEach cleanup retries once more (the fault is exhausted) and the
    // queue drains, which is what happens on the next shutdown for real.
    await registry.cleanup();
    expect(await exists(held.filePath)).toBe(false);
    expect(registry.pendingDeletionPaths()).toEqual([]);
  });
});

describe('serialization', () => {
  it('runs concurrent opens one at a time in call order', async () => {
    createRegistry();
    sidecar.openDelayMs = 5;

    const third = await createPdf('third.pdf');
    const fourth = await createPdf('fourth.pdf');

    const [openedThird, openedFourth] = await Promise.all([
      registry.open(third.filePath, 'third.pdf', true, third.size),
      registry.open(fourth.filePath, 'fourth.pdf', true, fourth.size),
    ]);

    // A slow open must not let the second one reach the sidecar first.
    expect(sidecar.maxConcurrentOpens).toBe(1);
    expect(sidecar.opens()).toEqual(['third.pdf', 'fourth.pdf']);
    // Both are registered and the last one wins the active slot.
    expect(registry.findById(openedThird.doc.id)).not.toBeNull();
    expect(registry.findById(openedFourth.doc.id)).not.toBeNull();
    expect(registry.getActiveId()).toBe(openedFourth.doc.id);
    expect(registry.list()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HTTP API integration
// ---------------------------------------------------------------------------

const HTTP_PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n';

interface HttpHarness {
  server: Server;
  registry: DocumentRegistry;
  diffUploads: DiffUploadStore;
  baseUrl: string;
  /** Full paths the registry asked the sidecar to open, in order. */
  openTargets: string[];
  /** Per-open delay, so an unserialized registry would interleave. */
  openDelayMs: number;
  maxConcurrentOpens: number;
  /** Basename -> number of upcoming opens that must fail. */
  failOpen: Map<string, number>;
  /** Spy on the pool's tracked document (the registry's activation target). */
  setDocumentPath: MockInstance;
}

interface OpenPayload {
  canceled: boolean;
  path: string;
  metadata: unknown;
  name: string;
  sourceUrl?: string;
  documentId: string;
}

interface DocumentListPayload {
  activeDocumentId: string | null;
  documents: Array<{
    id: string;
    name: string;
    size: number;
    sourceUrl: string | null;
    active: boolean;
  }>;
}

async function startHttpHarness(): Promise<HttpHarness> {
  const created = createWebServer();
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const address = created.server.address() as AddressInfo;

  const harness: HttpHarness = {
    server: created.server,
    registry: created.registry,
    diffUploads: created.diffUploads,
    baseUrl: `http://127.0.0.1:${address.port}`,
    openTargets: [],
    openDelayMs: 0,
    maxConcurrentOpens: 0,
    failOpen: new Map(),
    setDocumentPath: vi.spyOn(created.sidecar, 'setDocumentPath'),
  };

  let inFlight = 0;
  vi.spyOn(created.sidecar, 'send').mockImplementation(
    async (method: string, params: Record<string, unknown> = {}) => {
      const target = typeof params.path === 'string' ? params.path : null;
      if (method !== 'open' || !target) return {};

      harness.openTargets.push(target);
      inFlight += 1;
      harness.maxConcurrentOpens = Math.max(harness.maxConcurrentOpens, inFlight);
      try {
        if (harness.openDelayMs > 0) await delay(harness.openDelayMs);

        const basename = path.basename(target);
        // Uploads keep a UUID prefix; `-name.pdf` still identifies the pick.
        const failure = [...harness.failOpen].find(
          ([name, remaining]) =>
            remaining > 0 && (basename === name || basename.endsWith(`-${name}`)),
        );
        if (failure) {
          const [name, remaining] = failure;
          harness.failOpen.set(name, remaining - 1);
          throw new Error(`cannot open ${basename}`);
        }

        return { pageCount: 1, source: basename };
      } finally {
        inFlight -= 1;
      }
    },
  );

  return harness;
}

async function stopHttpHarness(harness: HttpHarness): Promise<void> {
  await harness.diffUploads.cleanup();
  await harness.registry.cleanup();
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
}

function uploadPdf(
  harness: HttpHarness,
  name: string,
  body: string = HTTP_PDF_BYTES,
): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent(name),
    },
    body,
  });
}

function activateDocument(harness: HttpHarness, id: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/documents/${id}/activate`, { method: 'POST' });
}

function deleteDocument(harness: HttpHarness, id: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/documents/${id}`, { method: 'DELETE' });
}

async function listDocuments(harness: HttpHarness): Promise<DocumentListPayload> {
  const response = await fetch(`${harness.baseUrl}/api/documents`);
  expect(response.status).toBe(200);
  return (await response.json()) as DocumentListPayload;
}

function postRpc(harness: HttpHarness, method: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
  });
}

async function openUpload(
  harness: HttpHarness,
  name: string,
): Promise<{ response: Response; payload: OpenPayload }> {
  const response = await uploadPdf(harness, name);
  expect(response.status).toBe(200);
  return { response, payload: (await response.json()) as OpenPayload };
}

function uploadSuffix(target: string): string {
  // Uploaded files are `<uuid>-<display name>.pdf`.
  return path.basename(target).replace(/^[0-9a-f-]{36}-/, '');
}

describe('HTTP multi-document API', () => {
  let http: HttpHarness;

  beforeEach(async () => {
    http = await startHttpHarness();
  });

  afterEach(async () => {
    await stopHttpHarness(http);
    vi.restoreAllMocks();
  });

  it('opens two uploads and keeps both /doc URLs readable', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');

    expect(first.payload.documentId).toBeTruthy();
    expect(second.payload.documentId).toBeTruthy();
    expect(first.payload.documentId).not.toBe(second.payload.documentId);
    expect(first.payload.path).toBe(
      `/doc/${first.payload.documentId}/${encodeURIComponent('first.pdf')}`,
    );
    expect(second.payload.path).toBe(
      `/doc/${second.payload.documentId}/${encodeURIComponent('second.pdf')}`,
    );
    expect(http.registry.getActiveId()).toBe(second.payload.documentId);
    expect(http.registry.list()).toHaveLength(2);

    const servedFirst = await fetch(`${http.baseUrl}${first.payload.path}`);
    expect(servedFirst.status).toBe(200);
    expect(await servedFirst.text()).toBe(HTTP_PDF_BYTES);

    const servedSecond = await fetch(`${http.baseUrl}${second.payload.path}`);
    expect(servedSecond.status).toBe(200);

    // The inactive document is still range-readable for pdf.js.
    const ranged = await fetch(`${http.baseUrl}${first.payload.path}`, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('%PDF-');
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-4/${HTTP_PDF_BYTES.length}`,
    );
  });

  it('activates a document and retargets the sidecar path and RPC', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');
    http.setDocumentPath.mockClear();

    const response = await activateDocument(http, first.payload.documentId);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as OpenPayload;
    expect(payload).toEqual({
      canceled: false,
      path: `/doc/${first.payload.documentId}/${encodeURIComponent('first.pdf')}`,
      metadata: { pageCount: 1, source: path.basename(http.openTargets[0]) },
      name: 'first.pdf',
      documentId: first.payload.documentId,
    });
    // Uploads carry no sourceUrl; downloaded documents do.
    expect(payload).not.toHaveProperty('sourceUrl');
    expect(http.registry.getActiveId()).toBe(first.payload.documentId);

    const activeDoc = http.registry.findById(first.payload.documentId);
    expect(activeDoc).not.toBeNull();
    expect(http.setDocumentPath).toHaveBeenLastCalledWith(activeDoc?.filePath);
    expect(http.registry.getActiveId()).not.toBe(second.payload.documentId);

    // RPC now targets the sidecar document the registry just re-opened.
    const rpc = await postRpc(http, 'extract_metadata');
    expect(rpc.status).toBe(200);
    expect(http.setDocumentPath).toHaveBeenLastCalledWith(activeDoc?.filePath);

    // Re-activating the active document is a cached read, not another open.
    const opensBefore = http.openTargets.length;
    const again = await activateDocument(http, first.payload.documentId);
    expect(again.status).toBe(200);
    expect(((await again.json()) as OpenPayload).metadata).toEqual(payload.metadata);
    expect(http.openTargets).toHaveLength(opensBefore);
  });

  it('lists documents with the active flag and no filesystem paths', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');

    const payload = await listDocuments(http);

    expect(payload.activeDocumentId).toBe(second.payload.documentId);
    expect(payload.documents).toEqual([
      {
        id: second.payload.documentId,
        name: 'second.pdf',
        size: HTTP_PDF_BYTES.length,
        sourceUrl: null,
        active: true,
      },
      {
        id: first.payload.documentId,
        name: 'first.pdf',
        size: HTTP_PDF_BYTES.length,
        sourceUrl: null,
        active: false,
      },
    ]);
    for (const doc of payload.documents) {
      expect(doc).not.toHaveProperty('filePath');
      expect(doc).not.toHaveProperty('path');
    }
    // No registry path leaks through any other field either.
    const firstDoc = http.registry.findById(first.payload.documentId);
    expect(JSON.stringify(payload)).not.toContain(firstDoc?.filePath ?? '\u0000');
  });

  it('reports an empty registry', async () => {
    await expect(listDocuments(http)).resolves.toEqual({
      activeDocumentId: null,
      documents: [],
    });
  });

  it('closes an inactive document and leaves the sibling readable', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');
    const firstPath = http.registry.findById(first.payload.documentId)?.filePath ?? '';

    const response = await deleteDocument(http, first.payload.documentId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      closed: true,
      activeDocumentId: second.payload.documentId,
    });
    expect(http.registry.findById(first.payload.documentId)).toBeNull();
    expect(await exists(firstPath)).toBe(false);

    const closedDoc = await fetch(`${http.baseUrl}${first.payload.path}`);
    expect(closedDoc.status).toBe(404);
    const sibling = await fetch(`${http.baseUrl}${second.payload.path}`);
    expect(sibling.status).toBe(200);
    expect((await listDocuments(http)).documents).toHaveLength(1);
  });

  it('refuses to close the active document while a sibling is registered', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');

    const response = await deleteDocument(http, second.payload.documentId);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'Activate another document',
    );
    // Nothing was deleted: the UI must activate a neighbour first.
    expect(http.registry.getActiveId()).toBe(second.payload.documentId);
    expect(http.registry.list()).toHaveLength(2);
    expect((await fetch(`${http.baseUrl}${first.payload.path}`)).status).toBe(200);
    expect((await fetch(`${http.baseUrl}${second.payload.path}`)).status).toBe(200);
  });

  it('closes the last active document and then RPC answers 409', async () => {
    const only = await openUpload(http, 'only.pdf');

    const response = await deleteDocument(http, only.payload.documentId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, activeDocumentId: null });
    expect(http.registry.getActiveId()).toBeNull();
    expect((await fetch(`${http.baseUrl}${only.payload.path}`)).status).toBe(404);

    const rpc = await postRpc(http, 'extract_metadata');
    expect(rpc.status).toBe(409);
    expect(await rpc.json()).toEqual({ error: 'No active document' });
  });

  it('closes the last active document even while its temp file is still locked', async () => {
    const only = await openUpload(http, 'only.pdf');
    const filePath = http.registry.findById(only.payload.documentId)?.filePath ?? '';
    // Windows: the sidecar still holds the extractor of the active document, so
    // the immediate unlink fails. That must not turn the close into a 500.
    unlinkFaults.set(filePath, 1);

    const response = await deleteDocument(http, only.payload.documentId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, activeDocumentId: null });
    expect(await exists(filePath)).toBe(true);
    expect(http.registry.pendingDeletionPaths()).toEqual([filePath]);

    // The next upload replaces the extractor; the queued copy is deleted then.
    await openUpload(http, 'next.pdf');
    expect(await exists(filePath)).toBe(false);
    expect(http.registry.pendingDeletionPaths()).toEqual([]);
  });

  it('returns 404 for unknown ids and 400 for a malformed id escape', async () => {
    expect((await deleteDocument(http, 'missing')).status).toBe(404);
    expect((await activateDocument(http, 'missing')).status).toBe(404);

    // Empty and extra path segments are not valid document routes.
    const empty = await fetch(`${http.baseUrl}/api/documents//activate`, {
      method: 'POST',
    });
    expect(empty.status).toBe(404);
    const extra = await fetch(`${http.baseUrl}/api/documents/a/activate/extra`, {
      method: 'POST',
    });
    expect(extra.status).toBe(404);

    // Malformed percent-encoding is a client error, not a missing document.
    const malformed = await fetch(`${http.baseUrl}/api/documents/%E0%A4%A/activate`, {
      method: 'POST',
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toBe(
      'Invalid document id',
    );
  });

  it('maps a registry too_large failure to 413 and deletes the rejected upload', async () => {
    const openSpy = vi
      .spyOn(http.registry, 'open')
      .mockRejectedValueOnce(
        new DocumentRegistryError(
          'too_large',
          'The PDF is larger than the 512 MiB document limit',
        ),
      );

    const response = await uploadPdf(http, 'huge.pdf');

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'The PDF is larger than the 512 MiB document limit',
    });
    // The handler still deletes the copy the registry refused to adopt.
    const rejectedPath = openSpy.mock.calls[0]?.[0] as string;
    expect(await exists(rejectedPath)).toBe(false);
    expect(http.registry.list()).toEqual([]);
  });

  it('keeps the previous active document when a new upload fails and deletes its copy', async () => {
    const first = await openUpload(http, 'good.pdf');
    http.failOpen.set('bad.pdf', 1);

    const failed = await uploadPdf(http, 'bad.pdf');

    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toContain(
      'cannot open',
    );
    // Failing open, then one restore of the previous document.
    expect(http.openTargets.map(uploadSuffix)).toEqual([
      'good.pdf',
      'bad.pdf',
      'good.pdf',
    ]);
    expect(await exists(http.openTargets[1])).toBe(false);
    expect(http.registry.getActiveId()).toBe(first.payload.documentId);
    expect(http.registry.list()).toHaveLength(1);
    expect((await fetch(`${http.baseUrl}${first.payload.path}`)).status).toBe(200);
  });

  it('keeps the previous active document when activation fails', async () => {
    const first = await openUpload(http, 'first.pdf');
    const second = await openUpload(http, 'second.pdf');
    http.failOpen.set('first.pdf', 1);

    const failed = await activateDocument(http, first.payload.documentId);

    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toContain(
      'cannot open',
    );
    // Activation failure, then a restore of the still-active second document.
    expect(http.openTargets.map(uploadSuffix)).toEqual([
      'first.pdf',
      'second.pdf',
      'first.pdf',
      'second.pdf',
    ]);
    expect(http.registry.getActiveId()).toBe(second.payload.documentId);
    expect(http.registry.list()).toHaveLength(2);
    expect((await fetch(`${http.baseUrl}${first.payload.path}`)).status).toBe(200);
    expect((await fetch(`${http.baseUrl}${second.payload.path}`)).status).toBe(200);
  });

  it('serializes concurrent opens and activations on the sidecar', async () => {
    http.openDelayMs = 10;

    const responses = await Promise.all([
      uploadPdf(http, 'alpha.pdf'),
      uploadPdf(http, 'beta.pdf'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const payloads = (await Promise.all(
      responses.map((response) => response.json()),
    )) as OpenPayload[];
    const ids = payloads.map((payload) => payload.documentId);
    expect(new Set(ids).size).toBe(2);
    expect(http.registry.list()).toHaveLength(2);
    expect(http.maxConcurrentOpens).toBe(1);

    const activations = await Promise.all(ids.map((id) => activateDocument(http, id)));
    expect(activations.map((response) => response.status)).toEqual([200, 200]);
    expect(http.maxConcurrentOpens).toBe(1);
    expect(ids).toContain(http.registry.getActiveId());
    expect(http.setDocumentPath).toHaveBeenLastCalledWith(
      http.registry.getActive()?.filePath,
    );
  });
});
