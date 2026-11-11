import { OPEN_PDF_TIMEOUT_MS } from '../shared/constants';
import type { SidecarManager } from './sidecar';

/**
 * Request routing for the two-lane sidecar.
 *
 * The interactive lane owns the calls a user is waiting on: opening a document,
 * extracting the current page's metadata and serving image data. The background
 * lane owns expensive, whole-document work (font analysis, audit, raw reads and
 * diff) so it cannot queue in front of a page extraction.
 *
 * The table below is the single source of truth for that split; the web backend
 * imports it so desktop and browser route identically.
 */
export type SidecarLane = 'interactive' | 'background';

export const INTERACTIVE_METHODS = [
  'open',
  'extract_page',
  'extract_metadata',
  'get_image_data',
  'shutdown',
] as const;

export const BACKGROUND_METHODS = [
  'analyze_fonts',
  'audit_document',
  'audit_pages',
  'raw_document',
  'raw_object',
  'raw_page_content',
  'diff_documents',
] as const;

const BACKGROUND_METHOD_SET: ReadonlySet<string> = new Set<string>(BACKGROUND_METHODS);

/**
 * Pick the lane for a sidecar method.
 *
 * Unknown methods stay on the interactive lane: it is the primary process and
 * the only one that is running at boot, so an unrecognized request behaves
 * exactly as it did before the pool existed.
 */
export function laneForMethod(method: string): SidecarLane {
  return BACKGROUND_METHOD_SET.has(method) ? 'background' : 'interactive';
}

/**
 * True when `error` is the sidecar manager's inactivity timeout for a
 * `diff_documents` request (see `SidecarManager.writeRequest`).
 *
 * Only that failure means a Python process may still be computing the
 * abandoned diff: the request stopped waiting but the child never stopped
 * working. Callers use this to restart the background lane and kill the
 * orphan; every other error leaves both lanes alone.
 */
export function isDiffTimeoutError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^Request "diff_documents" timed out\b/.test(message);
}

/**
 * The part of `SidecarManager` the IPC handlers rely on. Kept as an interface so
 * the handlers can be tested with a stub and so the pool is the only component
 * that has to know about lanes.
 */
export interface SidecarTransport {
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  restart(): Promise<void>;
  /**
   * Restart only the background lane.
   *
   * Used after a `diff_documents` timeout: the abandoned computation is still
   * running in the background process, so that process has to be replaced
   * before the next diff can start. Never touches the interactive lane.
   */
  restartBackground(): Promise<void>;
  isRunning(): boolean;
  setDocumentRestorer(restorer: (() => Promise<void>) | null): void;
}

export interface SidecarPoolOptions {
  /**
   * Build the background lane on the first background request. Injected so the
   * lazy lane is testable without spawning Python, and so `index.ts` keeps the
   * concrete `SidecarManager` dependency.
   */
  createBackground: () => SidecarManager;
}

/**
 * Two sidecar lanes behind one transport.
 *
 * - interactive: the existing `SidecarManager`, started by `index.ts` at boot.
 * - background: created lazily on the first background request, so a document
 *   that never uses Analyze/Audit/Raw/Diff keeps paying for one process only.
 *
 * Both lanes open the same document. `open` is authoritative on the interactive
 * lane; a *running* background lane is re-opened in the background and can never
 * fail the interactive open. A background request that arrives first starts the
 * lane, opens the current document once and then sends the request.
 *
 * `DocumentRestorer` wiring: the IPC handler's restorer stays on the interactive
 * manager (it owns the tracked `currentFilePath`). The background lane gets its
 * own restorer that re-opens `documentPath`, and every successful open records
 * `backgroundOpenedPath` so a crash-restart followed by a request does not open
 * the same file twice.
 */
export class SidecarPool implements SidecarTransport {
  private readonly interactive: SidecarManager;
  private readonly createBackground: () => SidecarManager;

  /** Lazily created background lane; `null` until a background method runs. */
  private background: SidecarManager | null = null;
  /** The document both lanes are expected to have open. */
  private documentPath: string | null = null;
  /** Last path the background lane confirmed open; reset when it restarts. */
  private backgroundOpenedPath: string | null = null;
  /** Serialized opens on the background lane; the tail never rejects. */
  private backgroundSync: Promise<void> = Promise.resolve();

  constructor(interactive: SidecarManager, options: SidecarPoolOptions) {
    this.interactive = interactive;
    this.createBackground = options.createBackground;
  }

  /** Interactive health. The background lane is reported separately. */
  isRunning(): boolean {
    return this.interactive.isRunning();
  }

  isBackgroundRunning(): boolean {
    return this.background !== null && this.background.isRunning();
  }

  /** True once the lazy background lane has been created (running or not). */
  isBackgroundStarted(): boolean {
    return this.background !== null;
  }

  /** Start the interactive lane. The background lane stays lazy. */
  start(): Promise<void> {
    return this.interactive.start();
  }

  /**
   * Register the document restorer used by every interactive-lane start.
   *
   * The background lane does not use this hook: its restorer lives in the pool
   * and always re-opens the pool's tracked `documentPath`, so a restorer call
   * cannot be routed back through `send('open')` and open the wrong lane.
   */
  setDocumentRestorer(restorer: (() => Promise<void>) | null): void {
    this.interactive.setDocumentRestorer(restorer);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === 'open') {
      return this.openDocument(params, timeoutMs);
    }
    if (laneForMethod(method) === 'background') {
      return this.sendBackground(method, params, timeoutMs);
    }
    return this.interactive.send(method, params, timeoutMs);
  }

  /**
   * Open on the interactive lane, then bring a *running* background lane to the
   * same document. The background open is queued and never awaited by the
   * caller, so a large background re-open cannot delay the interactive result;
   * a background failure is logged and only surfaces on the next background
   * request, which retries the open and reports its own error.
   */
  private async openDocument(
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const filePath = typeof params.path === 'string' ? params.path : null;
    const openTimeout = timeoutMs ?? OPEN_PDF_TIMEOUT_MS;

    const result = await this.interactive.send('open', params, openTimeout);

    if (filePath !== null) {
      this.documentPath = filePath;
      if (this.background?.isRunning()) {
        this.scheduleBackgroundSync();
      }
    }

    return result;
  }

  private async sendBackground(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const background = this.ensureBackground();
    // Starts and opens the current document on the first background request,
    // and coalesces with any document switch already queued.
    await this.enqueueBackgroundSync();
    return background.send(method, params, timeoutMs);
  }

  private ensureBackground(): SidecarManager {
    if (this.background) return this.background;

    const background = this.createBackground();
    background.setDocumentRestorer(async () => {
      const target = this.documentPath;
      if (!target) return;
      await background.send('open', { path: target }, OPEN_PDF_TIMEOUT_MS);
      this.backgroundOpenedPath = target;
    });
    this.background = background;
    return background;
  }

  /** Queue a document sync without making the open wait for it. */
  private scheduleBackgroundSync(): void {
    void this.enqueueBackgroundSync().catch((err) => {
      console.error('[sidecar-pool] Background document sync failed:', err);
    });
  }

  /**
   * Append a document sync to the background queue.
   *
   * Every sync re-reads `documentPath` when it runs, so a switch that is queued
   * while another open is still in flight cannot leave the lane on the older
   * document. The stored tail swallows failures (they are logged where the sync
   * was scheduled); the returned promise still rejects so a background *request*
   * can surface a failed start/open as its own error.
   */
  private enqueueBackgroundSync(): Promise<void> {
    const run = this.backgroundSync.then(() => this.syncBackgroundDocument());
    this.backgroundSync = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Await every queued background document open (diagnostics/tests). */
  whenBackgroundIdle(): Promise<void> {
    return this.backgroundSync;
  }

  private async syncBackgroundDocument(): Promise<void> {
    const background = this.background;
    if (!background) return;

    // Re-read the target every pass: a document switch can land while the lane
    // is still starting (or while an open is in flight). The loop is bounded
    // because each pass either confirms the current document or performs one
    // open; a pathological stream of switches settles on the latest one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = this.documentPath;

      if (target === null) {
        // No document yet: the first background request still starts the lane.
        if (!background.isRunning()) await background.start();
        return;
      }

      if (!background.isRunning()) {
        // start() runs the lane restorer, which opens `documentPath` once (and
        // records it). Loop to verify against the possibly newer document and
        // to retry an explicit open when the restorer failed.
        await background.start();
        continue;
      }

      if (this.backgroundOpenedPath === target) return;

      await background.send('open', { path: target }, OPEN_PDF_TIMEOUT_MS);
      this.backgroundOpenedPath = target;
      return;
    }
  }

  /**
   * Restart both lanes. The interactive lane's failure is propagated (the IPC
   * handler reports it); a background restart failure is logged and isolated,
   * because the background feature can self-heal on its next request.
   */
  async restart(): Promise<void> {
    await this.interactive.restart();

    const background = this.background;
    if (!background) return;

    // A sync queued by the interactive restorer must not race the restart.
    await this.backgroundSync;
    this.backgroundOpenedPath = null;

    try {
      await background.restart();
    } catch (err) {
      console.error('[sidecar-pool] Background lane restart failed:', err);
    }
  }

  /**
   * Restart the background lane only, after a diff timeout.
   *
   * The inactivity timeout rejects the request but cannot stop the Python
   * process still diffing the abandoned pair; replacing that process is what
   * actually frees the CPU/RAM and unblocks retries. Any queued background
   * document sync is awaited first (its stored tail never rejects), and the
   * restart is bounded by the lane's own stop and ready timeouts.
   *
   * Unlike `restart()`, the interactive lane is never touched. A failed restart
   * is logged and rethrown: the caller already has the original timeout to
   * report, but a rescue failure should still be visible.
   */
  async restartBackground(): Promise<void> {
    const background = this.background;
    // No lane was ever created, so there is no orphan computation to kill.
    if (!background) return;

    // A document sync queued by an interactive open must not race the restart.
    await this.backgroundSync.catch(() => undefined);
    this.backgroundOpenedPath = null;

    try {
      await background.restart();
      // restart() runs the lane restorer, which re-opens `documentPath` and
      // records it in `backgroundOpenedPath`. Leaving a failed open null makes
      // the next background request retry instead of trusting a stale path.
    } catch (err) {
      console.error('[sidecar-pool] Background lane restart failed:', err);
      throw err;
    }
  }

  /**
   * Stop both lanes. Never rejects: this runs on the quit path, where a failing
   * lane must not keep the app (or an orphaned Python process) alive.
   */
  async stop(timeoutMs?: number): Promise<void> {
    // Both stops are invoked synchronously (the managers flag themselves as
    // stopping before their first await), so a crash-restart timer or a queued
    // sync cannot spawn a process between this call and the quit path's answer.
    const background = this.background;
    const stops = [this.interactive.stop(timeoutMs)];
    if (background) {
      stops.push(background.stop(timeoutMs));
    }

    await Promise.all(
      stops.map((stop) =>
        stop.catch((err) => {
          console.error('[sidecar-pool] Failed to stop a sidecar lane:', err);
        }),
      ),
    );
  }
}
