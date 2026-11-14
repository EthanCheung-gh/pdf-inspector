/**
 * Cached page thumbnails for the page overview (work package T1).
 *
 * The loader renders PDF.js pages into an off-screen canvas and keeps the
 * resulting JPEG data URLs in a per-document LRU. It is intentionally free of
 * React/Zustand imports so a component, a hook and a Node/jsdom test can all
 * drive it; the canvas work lives in the default render function, which is only
 * reached when a document is actually loaded.
 *
 * Scheduling rules:
 * - at most `concurrency` renders run at once (default 2, so thumbnail work
 *   never competes with the visible page render);
 * - a pending `document + pageNumber` request is shared, so duplicate loads
 *   coalesce into one render;
 * - a successful render fills the document's LRU (default 60 entries) and a
 *   failed render drops its pending entry so the next load retries;
 * - documents are WeakMap keys, and `clear(document)` detaches a document's
 *   cache and pending map, so a result that lands after the switch is
 *   discarded instead of being reused by the next document.
 */

export interface ThumbnailDocument {
  getPage(pageNumber: number): Promise<ThumbnailPage>;
}

export interface ThumbnailPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
  cleanup?(): void;
}

export type ThumbnailRender = (
  document: ThumbnailDocument,
  pageNumber: number,
) => Promise<string>;

/** Target thumbnail box in CSS pixels; pages are contained inside it. */
const THUMBNAIL_WIDTH = 160;
const THUMBNAIL_HEIGHT = 220;
const THUMBNAIL_QUALITY = 0.82;
const MAX_DEVICE_PIXEL_RATIO = 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_CACHE_SIZE = 60;

interface DocumentState {
  /** Insertion order is the LRU order: oldest first, newest last. */
  cache: Map<number, string>;
  pending: Map<number, Promise<string>>;
}

/** PDF.js 4.x render options; `transform` keeps the bitmap crisp on HiDPI. */
interface PageRenderParameters {
  canvasContext: CanvasRenderingContext2D;
  viewport: { width: number; height: number };
  transform?: number[];
}

interface QueueSlot {
  run: () => void;
}

export class ThumbnailLoader {
  private readonly renderPage: ThumbnailRender;
  private readonly concurrency: number;
  private readonly cacheSize: number;
  private states = new WeakMap<ThumbnailDocument, DocumentState>();
  private active = 0;
  private readonly queue: QueueSlot[] = [];

  constructor(
    render: ThumbnailRender = renderPageThumbnail,
    concurrency: number = DEFAULT_CONCURRENCY,
    cacheSize: number = DEFAULT_CACHE_SIZE,
  ) {
    this.renderPage = render;
    this.concurrency = normalizeLimit(concurrency, DEFAULT_CONCURRENCY);
    this.cacheSize = normalizeLimit(cacheSize, DEFAULT_CACHE_SIZE);
  }

  /**
   * Resolve a JPEG data URL for `pageNumber` (1-based).
   *
   * Cached pages resolve immediately without touching the queue. Invalid page
   * numbers reject before any render is scheduled.
   */
  load(document: ThumbnailDocument, pageNumber: number): Promise<string> {
    if (!isPageNumber(pageNumber)) {
      return Promise.reject(
        new RangeError(`Page number must be a positive integer; received ${String(pageNumber)}.`),
      );
    }

    const state = this.stateFor(document);
    const cached = readCache(state, pageNumber);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = state.pending.get(pageNumber);
    if (pending) return pending;

    const promise = this.schedule(() => this.renderPage(document, pageNumber)).then(
      (dataUrl) => {
        state.pending.delete(pageNumber);
        // A `clear(document)`/`clear()` during the render detaches the state;
        // do not resurrect a cache entry for a document that has moved on.
        if (this.states.get(document) === state) {
          writeCache(state, pageNumber, dataUrl, this.cacheSize);
        }
        return dataUrl;
      },
      (error: unknown) => {
        state.pending.delete(pageNumber);
        throw error;
      },
    );
    state.pending.set(pageNumber, promise);
    return promise;
  }

  /**
   * Drop cached thumbnails. `clear(document)` detaches one document (its
   * in-flight results are discarded); `clear()` resets every document, which
   * is mainly useful for tests.
   */
  clear(document?: ThumbnailDocument): void {
    if (document === undefined) {
      this.states = new WeakMap<ThumbnailDocument, DocumentState>();
      return;
    }
    this.states.delete(document);
  }

  private stateFor(document: ThumbnailDocument): DocumentState {
    let state = this.states.get(document);
    if (!state) {
      state = { cache: new Map<number, string>(), pending: new Map<number, Promise<string>>() };
      this.states.set(document, state);
    }
    return state;
  }

  /** Run `task` once a concurrency slot is free, preserving call order. */
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active += 1;
        let result: Promise<T>;
        try {
          result = Promise.resolve(task());
        } catch (error) {
          result = Promise.reject(error);
        }
        result.then(resolve, reject).then(() => {
          this.active -= 1;
          this.drain();
        });
      };

      if (this.active < this.concurrency) {
        run();
      } else {
        this.queue.push({ run });
      }
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const slot = this.queue.shift();
      if (slot) slot.run();
    }
  }
}

/** Shared thumbnail loader used by the page overview. */
export const pageThumbnails = new ThumbnailLoader();

/**
 * Default renderer: fit the page into a 160x220 CSS px box with `contain`,
 * scale the bitmap by `devicePixelRatio` (capped at 2) and encode JPEG at 0.82.
 */
async function renderPageThumbnail(
  document: ThumbnailDocument,
  pageNumber: number,
): Promise<string> {
  let page: ThumbnailPage;
  try {
    page = await document.getPage(pageNumber);
  } catch (error) {
    throw new Error(`Could not load page ${pageNumber} for its thumbnail: ${describeError(error)}`);
  }

  // Release the page on every exit path once it has been fetched; cleanup must
  // never turn a finished render into an error.
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    if (!(baseViewport.width > 0) || !(baseViewport.height > 0)) {
      throw new Error(`Page ${pageNumber} has no drawable area for a thumbnail.`);
    }
    const scale = Math.min(
      THUMBNAIL_WIDTH / baseViewport.width,
      THUMBNAIL_HEIGHT / baseViewport.height,
    );
    const viewport = page.getViewport({ scale });

    const doc = (globalThis as { document?: Document }).document;
    if (!doc) {
      throw new Error('Thumbnails need a DOM document to create the render canvas.');
    }

    const canvas = doc.createElement('canvas');
    const dpr = resolveDevicePixelRatio();
    canvas.width = Math.max(1, Math.round(viewport.width * dpr));
    canvas.height = Math.max(1, Math.round(viewport.height * dpr));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error(`Could not create a 2D canvas context for the page ${pageNumber} thumbnail.`);
    }

    try {
      await (page.render as (params: PageRenderParameters) => { promise: Promise<void> })({
        canvasContext: context,
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
      }).promise;
    } catch (error) {
      throw new Error(
        `Could not render page ${pageNumber} for its thumbnail: ${describeError(error)}`,
      );
    }

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY);
    } catch (error) {
      throw new Error(`Could not encode page ${pageNumber} as a thumbnail: ${describeError(error)}`);
    }
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
      throw new Error(`The page ${pageNumber} thumbnail did not produce image data.`);
    }
    return dataUrl;
  } finally {
    cleanupQuietly(page);
  }
}

/**
 * Release the PDF.js page after a render. Cleanup is best-effort: a page that
 * was already destroyed must not turn a successful thumbnail into an error.
 */
function cleanupQuietly(page: ThumbnailPage): void {
  try {
    page.cleanup?.();
  } catch {
    // Ignore: the bitmap is already on the canvas (or the render error stands).
  }
}

function resolveDevicePixelRatio(): number {
  const raw = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, raw));
}

function isPageNumber(value: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function normalizeLimit(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Read and refresh a cache entry; returns undefined on a miss. */
function readCache(state: DocumentState, pageNumber: number): string | undefined {
  const { cache } = state;
  if (!cache.has(pageNumber)) return undefined;
  const dataUrl = cache.get(pageNumber) as string;
  cache.delete(pageNumber);
  cache.set(pageNumber, dataUrl);
  return dataUrl;
}

/** Store a fresh entry and evict the least recently used ones. */
function writeCache(
  state: DocumentState,
  pageNumber: number,
  dataUrl: string,
  cacheSize: number,
): void {
  const { cache } = state;
  cache.delete(pageNumber);
  cache.set(pageNumber, dataUrl);
  while (cache.size > cacheSize) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
