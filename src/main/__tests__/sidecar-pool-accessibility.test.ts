import { describe, expect, it, vi } from 'vitest';

import { ACCESSIBILITY_TIMEOUT_MS, OPEN_PDF_TIMEOUT_MS } from '../../shared/constants';
import type { SidecarManager } from '../sidecar';
import { BACKGROUND_METHODS, SidecarPool, laneForMethod } from '../sidecar-pool';

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
  stop = vi.fn(async (): Promise<void> => {
    this.running = false;
  });
  isRunning = vi.fn((): boolean => this.running);
  setDocumentRestorer = vi.fn((restorer: (() => Promise<void>) | null): void => {
    this.restorer = restorer;
  });
}

const asManager = (lane: FakeLane): SidecarManager => lane as unknown as SidecarManager;

describe('desktop accessibility routing', () => {
  it('lists accessibility_document as a background method', () => {
    expect(BACKGROUND_METHODS).toContain('accessibility_document');
    expect(laneForMethod('accessibility_document')).toBe('background');
  });

  it('creates the background lane, not the interactive one, for the structure parse', async () => {
    const interactive = new FakeLane();
    interactive.running = true;
    const backgrounds: FakeLane[] = [];

    const pool = new SidecarPool(asManager(interactive), {
      createBackground: () => {
        const lane = new FakeLane();
        backgrounds.push(lane);
        return asManager(lane);
      },
    });

    await pool.send('open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS);
    interactive.send.mockClear();

    await pool.send('accessibility_document', {}, ACCESSIBILITY_TIMEOUT_MS);

    expect(backgrounds).toHaveLength(1);
    expect(interactive.send).not.toHaveBeenCalled();
    expect(backgrounds[0].send.mock.calls).toEqual([
      ['open', { path: '/tmp/a.pdf' }, OPEN_PDF_TIMEOUT_MS],
      ['accessibility_document', {}, ACCESSIBILITY_TIMEOUT_MS],
    ]);
  });

  it('does not queue the parse in front of page navigation', async () => {
    const interactive = new FakeLane();
    interactive.running = true;
    const background = new FakeLane();
    background.running = true;

    const pool = new SidecarPool(asManager(interactive), {
      createBackground: () => asManager(background),
    });

    await pool.send('extract_page', { page: 3 }, 120_000);
    await pool.send('accessibility_document', {}, ACCESSIBILITY_TIMEOUT_MS);

    expect(interactive.send).toHaveBeenCalledWith('extract_page', { page: 3 }, 120_000);
    expect(background.send).toHaveBeenCalledWith(
      'accessibility_document',
      {},
      ACCESSIBILITY_TIMEOUT_MS,
    );
  });
});
