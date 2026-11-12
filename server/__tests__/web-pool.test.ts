// @vitest-environment node
/**
 * Two-lane routing for the browser backend.
 *
 * The HTTP endpoints are covered by the other web tests; these assertions pin
 * the pool contract: the background `SidecarManager` is created lazily, a
 * first background request opens the current document once, a running
 * background lane follows document switches, and a background failure never
 * fails page navigation. `/api/status` keeps reporting the interactive lane.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANALYZE_FONTS_TIMEOUT_MS,
  AUDIT_TIMEOUT_MS,
  DIFF_TIMEOUT_MS,
  EXTRACT_PAGE_TIMEOUT_MS,
  OPEN_PDF_TIMEOUT_MS,
  RAW_TIMEOUT_MS,
  SECURITY_TIMEOUT_MS,
} from '../../src/shared/constants';
import { BACKGROUND_METHODS, INTERACTIVE_METHODS, laneForMethod } from '../../src/main/sidecar-pool';
import { SidecarPool, type SidecarManager } from '../web-server';

/** The subset of the web `SidecarManager` the pool uses, with a fake process. */
class FakeLane {
  running = false;
  documentPath: string | null = null;

  send = vi.fn(
    async (method: string, _params?: Record<string, unknown>, _timeoutMs?: number): Promise<unknown> => {
      // A real manager starts on demand for `open` (and skips its restore).
      if (!this.running) await this.start();
      return {};
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

interface Harness {
  pool: SidecarPool;
  interactive: FakeLane;
  backgrounds: FakeLane[];
}

function createPool(): Harness {
  const interactive = new FakeLane();
  // The web server starts the interactive lane before it listens.
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

  return { pool, interactive, backgrounds };
}

/** Track a document, then force the background lane to start on it. */
async function startBackgroundLane(harness: Harness, filePath: string): Promise<FakeLane> {
  harness.pool.setDocumentPath(filePath);
  await harness.pool.send('analyze_fonts');
  return harness.backgrounds[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web sidecar lane routing', () => {
  it('uses the shared desktop route table', () => {
    for (const method of INTERACTIVE_METHODS) {
      expect(laneForMethod(method)).toBe('interactive');
    }
    for (const method of BACKGROUND_METHODS) {
      expect(laneForMethod(method)).toBe('background');
    }
    expect(laneForMethod('some_future_method')).toBe('interactive');
  });

  it('creates the background lane only for background methods', async () => {
    const { pool, backgrounds } = createPool();

    await pool.send('extract_page', { page: 1 }, EXTRACT_PAGE_TIMEOUT_MS);
    await pool.send('extract_metadata');
    expect(backgrounds).toHaveLength(0);

    await pool.send('audit_pages', { start_page: 1, end_page: 10 }, AUDIT_TIMEOUT_MS);
    expect(backgrounds).toHaveLength(1);
    expect(pool.isBackgroundStarted()).toBe(true);
  });

  it('routes security_document to the background lane', async () => {
    // The browser backend must route exactly like the desktop (one shared table).
    expect(laneForMethod('security_document')).toBe('background');

    const { pool, interactive, backgrounds } = createPool();
    await pool.send('security_document', {}, SECURITY_TIMEOUT_MS);

    expect(interactive.send).not.toHaveBeenCalled();
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0].send).toHaveBeenCalledWith(
      'security_document',
      {},
      SECURITY_TIMEOUT_MS,
    );
  });

  it('starts and opens the current document once on the first background request', async () => {
    const { pool, backgrounds } = createPool();
    pool.setDocumentPath('/tmp/a.pdf');

    await pool.send('analyze_fonts');

    const background = backgrounds[0];
    expect(background.documentPath).toBe('/tmp/a.pdf');
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['analyze_fonts', {}, undefined],
    ]);

    await pool.send('raw_document', {}, RAW_TIMEOUT_MS);
    expect(backgrounds).toHaveLength(1);
    // No second open, no second process.
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['analyze_fonts', {}, undefined],
      ['raw_document', {}, RAW_TIMEOUT_MS],
    ]);
  });
});

describe('web document synchronisation', () => {
  it('opens the switched path on a running background lane', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    background.send.mockClear();
    interactive.send.mockClear();

    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    expect(interactive.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/b.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS],
    ]);
    expect(background.documentPath).toBe('/tmp/b.pdf');
  });

  it('does not start the lazy lane for a document switch', async () => {
    const { pool, backgrounds } = createPool();

    pool.setDocumentPath('/tmp/a.pdf');
    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    expect(backgrounds).toHaveLength(0);
  });
});

describe('web background failure isolation', () => {
  it('keeps the interactive open successful when the background open fails', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    background.send.mockImplementation(async (method: string) => {
      if (method === 'open') throw new Error('background open failed');
      return {};
    });

    await expect(
      pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS),
    ).resolves.toEqual({});
    await pool.whenBackgroundIdle();

    expect(pool.isRunning()).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('surfaces the failure on the next background request', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    background.send.mockImplementation(async (method: string) => {
      if (method === 'open') throw new Error('background open failed');
      return {};
    });

    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    await expect(pool.send('diff_documents', {}, DIFF_TIMEOUT_MS)).rejects.toThrow(
      'background open failed',
    );
  });
});

describe('web restart, shutdown and health', () => {
  it('restarts both lanes', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');

    await pool.restart();

    expect(interactive.restart).toHaveBeenCalledTimes(1);
    expect(background.restart).toHaveBeenCalledTimes(1);
    expect(pool.isBackgroundRunning()).toBe(true);
  });

  it('restarts only the background lane on request', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');

    await pool.restartBackground();

    expect(background.restart).toHaveBeenCalledTimes(1);
    expect(interactive.restart).not.toHaveBeenCalled();
    // The restarted manager re-opens the tracked document itself.
    expect(background.documentPath).toBe('/tmp/a.pdf');
  });

  it('does not create the lane just to restart it', async () => {
    const { pool, interactive, backgrounds } = createPool();

    await expect(pool.restartBackground()).resolves.toBeUndefined();

    expect(backgrounds).toHaveLength(0);
    expect(interactive.restart).not.toHaveBeenCalled();
  });

  it('waits for a queued background sync before restarting', async () => {
    const interactive = new FakeLane();
    interactive.running = true;
    const background = new FakeLane();
    const pool = new SidecarPool({
      interactive: asManager(interactive),
      createBackground: () => asManager(background),
    });
    pool.setDocumentPath('/tmp/a.pdf');
    await pool.send('analyze_fonts');

    const order: string[] = [];
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    background.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'open' && params?.path === '/tmp/b.pdf') {
          order.push('sync:start');
          await openGate;
          order.push('sync:done');
        }
        return {};
      },
    );
    background.restart.mockImplementation(async () => {
      order.push('restart');
      background.running = true;
    });

    pool.setDocumentPath('/tmp/b.pdf');
    const restarting = pool.restartBackground();
    releaseOpen();
    await restarting;

    expect(order).toEqual(['sync:start', 'sync:done', 'restart']);
    expect(interactive.restart).not.toHaveBeenCalled();
  });

  it('surfaces a failed background restart without touching the interactive lane', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    background.restart.mockRejectedValueOnce(new Error('background restart failed'));

    await expect(pool.restartBackground()).rejects.toThrow('background restart failed');
    expect(interactive.restart).not.toHaveBeenCalled();
  });

  it('stops both lanes and reports interactive health only', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    expect(pool.isRunning()).toBe(true);

    await pool.stop();

    expect(interactive.stop).toHaveBeenCalledTimes(1);
    expect(background.stop).toHaveBeenCalledTimes(1);
    expect(pool.isRunning()).toBe(false);
    expect(pool.isBackgroundRunning()).toBe(false);
  });

  it('does not create a background lane just to stop the server', async () => {
    const { pool, backgrounds } = createPool();

    await pool.stop();

    expect(backgrounds).toHaveLength(0);
  });
});

describe('web per-method timeouts', () => {
  it('forwards each budget unchanged', async () => {
    const { pool, interactive, backgrounds } = createPool();
    pool.setDocumentPath('/tmp/a.pdf');

    await pool.send('extract_metadata');
    await pool.send('analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS);
    await pool.send('audit_document', {}, AUDIT_TIMEOUT_MS);
    await pool.send('raw_object', { object_number: 3 }, RAW_TIMEOUT_MS);

    expect(interactive.send).toHaveBeenCalledWith('extract_metadata', {}, undefined);

    const background = backgrounds[0];
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS],
      ['audit_document', {}, AUDIT_TIMEOUT_MS],
      ['raw_object', { object_number: 3 }, RAW_TIMEOUT_MS],
    ]);
  });
});
