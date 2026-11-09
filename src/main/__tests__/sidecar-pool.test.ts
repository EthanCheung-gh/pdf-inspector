import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANALYZE_FONTS_TIMEOUT_MS,
  AUDIT_TIMEOUT_MS,
  DIFF_TIMEOUT_MS,
  EXTRACT_PAGE_TIMEOUT_MS,
  OPEN_PDF_TIMEOUT_MS,
  RAW_TIMEOUT_MS,
} from '../../shared/constants';
import type { SidecarManager } from '../sidecar';
import {
  BACKGROUND_METHODS,
  INTERACTIVE_METHODS,
  SidecarPool,
  laneForMethod,
} from '../sidecar-pool';

/** Mirrors the real manager's lifecycle closely enough to test the pool. */
class FakeLane {
  running = false;
  restorer: (() => Promise<void>) | null = null;

  send = vi.fn(
    async (
      _method: string,
      _params?: Record<string, unknown>,
      _timeoutMs?: number,
    ): Promise<unknown> => ({}),
  );
  start = vi.fn(async (): Promise<void> => {
    this.running = true;
    await this.restorer?.();
  });
  restart = vi.fn(async (): Promise<void> => {
    this.running = true;
  });
  stop = vi.fn(async (..._args: unknown[]): Promise<void> => {
    this.running = false;
  });
  isRunning = vi.fn((): boolean => this.running);
  setDocumentRestorer = vi.fn((restorer: (() => Promise<void>) | null): void => {
    this.restorer = restorer;
  });
  enableAutoRestart = vi.fn();
}

const asManager = (lane: FakeLane): SidecarManager => lane as unknown as SidecarManager;

interface Harness {
  pool: SidecarPool;
  interactive: FakeLane;
  backgrounds: FakeLane[];
}

function createPool(options: { backgroundRunning?: boolean } = {}): Harness {
  const interactive = new FakeLane();
  // The interactive lane is started at boot by index.ts.
  interactive.running = true;
  const backgrounds: FakeLane[] = [];

  const pool = new SidecarPool(asManager(interactive), {
    createBackground: () => {
      const lane = new FakeLane();
      lane.running = options.backgroundRunning ?? false;
      backgrounds.push(lane);
      return asManager(lane);
    },
  });

  return { pool, interactive, backgrounds };
}

/** Open a document, then force the background lane to start on it. */
async function startBackgroundLane(harness: Harness, filePath: string): Promise<FakeLane> {
  await harness.pool.send('open', { path: filePath }, OPEN_PDF_TIMEOUT_MS);
  await harness.pool.send('analyze_fonts');
  return harness.backgrounds[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sidecar lane routing', () => {
  it('routes every documented method to its lane', () => {
    for (const method of INTERACTIVE_METHODS) {
      expect(laneForMethod(method)).toBe('interactive');
    }
    for (const method of BACKGROUND_METHODS) {
      expect(laneForMethod(method)).toBe('background');
    }
    // An unknown method keeps the pre-pool behaviour: the primary process.
    expect(laneForMethod('some_future_method')).toBe('interactive');
  });

  it('sends every interactive method to the interactive lane only', async () => {
    for (const method of INTERACTIVE_METHODS) {
      const { pool, interactive, backgrounds } = createPool();
      await pool.send(method, {});
      expect(backgrounds).toHaveLength(0);
      if (method === 'open') {
        // `open` is interactive and always carries the open budget.
        expect(interactive.send).toHaveBeenCalledWith('open', {}, OPEN_PDF_TIMEOUT_MS);
      } else {
        expect(interactive.send).toHaveBeenCalledWith(method, {}, undefined);
      }
    }
  });

  it('sends every background method to the background lane only', async () => {
    for (const method of BACKGROUND_METHODS) {
      const { pool, interactive, backgrounds } = createPool({ backgroundRunning: true });
      await pool.send(method, {});

      expect(interactive.send).not.toHaveBeenCalled();
      expect(backgrounds).toHaveLength(1);
      expect(backgrounds[0].send).toHaveBeenCalledWith(method, {}, undefined);
    }
  });
});

describe('lazy background lane', () => {
  it('is not created or started by interactive methods', async () => {
    const { pool, backgrounds } = createPool();

    await pool.send('extract_page', { page: 1 }, EXTRACT_PAGE_TIMEOUT_MS);
    await pool.send('extract_metadata');
    await pool.send('get_image_data', { stream_id: 'Im1' });

    expect(backgrounds).toHaveLength(0);
    expect(pool.isBackgroundStarted()).toBe(false);
  });

  it('starts on the first background method and reuses the lane afterwards', async () => {
    const { pool, interactive, backgrounds } = createPool();

    await pool.send('analyze_fonts');
    expect(backgrounds).toHaveLength(1);
    const background = backgrounds[0];
    expect(background.start).toHaveBeenCalledTimes(1);
    expect(interactive.send).not.toHaveBeenCalled();

    await pool.send('audit_document');
    await pool.send('raw_document');

    // One process, no extra start, one request per background call.
    expect(backgrounds).toHaveLength(1);
    expect(background.start).toHaveBeenCalledTimes(1);
    expect(background.send.mock.calls).toEqual([
      ['analyze_fonts', {}, undefined],
      ['audit_document', {}, undefined],
      ['raw_document', {}, undefined],
    ]);
  });

  it('opens the current document exactly once on the first background request', async () => {
    const { pool, backgrounds } = createPool();

    await pool.send('open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.send('analyze_fonts');

    const background = backgrounds[0];
    expect(background.start).toHaveBeenCalledTimes(1);
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['analyze_fonts', {}, undefined],
    ]);
  });
});

describe('document synchronisation', () => {
  it('opens the new path on a running background lane without starting it', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    background.send.mockClear();
    background.start.mockClear();
    interactive.send.mockClear();

    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    expect(interactive.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/b.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(background.send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/b.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(background.start).not.toHaveBeenCalled();
  });

  it('does not touch the background lane when it has never been started', async () => {
    const { pool, backgrounds } = createPool();

    await pool.send('open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    expect(backgrounds).toHaveLength(0);
  });

  it('keeps the background lane open once per path across repeated opens', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    background.send.mockClear();

    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS],
    ]);
  });

  it('catches up to a switch that lands during the background document open', async () => {
    const interactive = new FakeLane();
    interactive.running = true;
    const background = new FakeLane();

    // Hold the restorer's open of /tmp/a.pdf so the switch interleaves with it.
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    background.send.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === 'open' && params?.path === '/tmp/a.pdf') {
          await openGate;
        }
        return {};
      },
    );

    const pool = new SidecarPool(asManager(interactive), {
      createBackground: () => asManager(background),
    });

    await pool.send('open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS);
    const pending = pool.send('analyze_fonts');

    // The lane is now starting on /tmp/a.pdf; switch while its open is held.
    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    releaseOpen();
    await pending;
    await pool.whenBackgroundIdle();

    // The restorer opened the document it started with, then the queued sync
    // caught the lane up to the current document before the request ran.
    expect(background.send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['analyze_fonts', {}, undefined],
    ]);
  });
});

describe('background failure isolation', () => {
  it('never fails the interactive open when the background open fails', async () => {
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
    expect(interactive.send).toHaveBeenLastCalledWith(
      'open',
      { path: '/tmp/b.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reports the background failure on the next background request and retries the open', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    background.send.mockImplementation(async (method: string) => {
      if (method === 'open') throw new Error('background open failed');
      return {};
    });

    await pool.send('open', { path: '/tmp/b.pdf' }, OPEN_PDF_TIMEOUT_MS);
    await pool.whenBackgroundIdle();

    // The failed switch left the lane on /tmp/a.pdf; the next background
    // request retries /tmp/b.pdf and surfaces the sidecar error itself.
    await expect(pool.send('audit_document')).rejects.toThrow('background open failed');
  });
});

describe('restart and shutdown', () => {
  it('restarts both lanes', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');

    await pool.restart();

    expect(interactive.restart).toHaveBeenCalledTimes(1);
    expect(background.restart).toHaveBeenCalledTimes(1);
  });

  it('stops both lanes so quit cannot leave an orphaned background process', async () => {
    const { pool, interactive, backgrounds } = createPool();
    const background = await startBackgroundLane({ pool, interactive, backgrounds }, '/tmp/a.pdf');

    await pool.stop();

    expect(interactive.stop).toHaveBeenCalledTimes(1);
    expect(background.stop).toHaveBeenCalledTimes(1);
    expect(pool.isRunning()).toBe(false);
    expect(pool.isBackgroundRunning()).toBe(false);
  });

  it('does not create a background lane just to stop it', async () => {
    const { pool, interactive, backgrounds } = createPool();

    await pool.stop();

    expect(interactive.stop).toHaveBeenCalledTimes(1);
    expect(backgrounds).toHaveLength(0);
  });
});

describe('per-method timeouts', () => {
  it('forwards the interactive budgets unchanged', async () => {
    const { pool, interactive } = createPool();

    await pool.send('extract_page', { page: 2 }, EXTRACT_PAGE_TIMEOUT_MS);
    await pool.send('extract_metadata');
    await pool.send('get_image_data', { stream_id: 'Im1' }, undefined);

    expect(interactive.send.mock.calls).toEqual([
      ['extract_page', { page: 2 }, EXTRACT_PAGE_TIMEOUT_MS],
      // No explicit budget: the manager's own default applies.
      ['extract_metadata', {}, undefined],
      ['get_image_data', { stream_id: 'Im1' }, undefined],
    ]);
  });

  it('forwards the background budgets unchanged', async () => {
    const { pool, backgrounds } = createPool({ backgroundRunning: true });

    await pool.send('analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS);
    await pool.send('audit_pages', { start_page: 1, end_page: 10 }, AUDIT_TIMEOUT_MS);
    await pool.send('raw_object', { object_number: 3 }, RAW_TIMEOUT_MS);
    await pool.send('diff_documents', { old_path: 'a', new_path: 'b' }, DIFF_TIMEOUT_MS);

    const background = backgrounds[0];
    expect(background.send.mock.calls).toEqual([
      ['analyze_fonts', {}, ANALYZE_FONTS_TIMEOUT_MS],
      ['audit_pages', { start_page: 1, end_page: 10 }, AUDIT_TIMEOUT_MS],
      ['raw_object', { object_number: 3 }, RAW_TIMEOUT_MS],
      ['diff_documents', { old_path: 'a', new_path: 'b' }, DIFF_TIMEOUT_MS],
    ]);
  });

  it('gives an open without an explicit budget the open timeout on both lanes', async () => {
    const { pool, interactive, backgrounds } = createPool({ backgroundRunning: true });
    await pool.send('analyze_fonts');

    await pool.send('open', { path: '/tmp/a.pdf' });
    await pool.whenBackgroundIdle();

    expect(interactive.send).toHaveBeenLastCalledWith(
      'open',
      { path: '/tmp/a.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
    expect(backgrounds[0].send).toHaveBeenCalledWith(
      'open',
      { path: '/tmp/a.pdf' },
      OPEN_PDF_TIMEOUT_MS,
    );
  });
});
