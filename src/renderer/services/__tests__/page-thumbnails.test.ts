import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ThumbnailLoader,
  pageThumbnails,
  type ThumbnailDocument,
  type ThumbnailPage,
  type ThumbnailRender,
} from '../page-thumbnails';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const FIT_SCALE = 160 / 612;
const JPEG_DATA_URL = 'data:image/jpeg;base64,AAAA';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and the loader's slot-release handlers settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Documents only need identity here; the injected render never calls them. */
function createDocument(): ThumbnailDocument {
  return {} as ThumbnailDocument;
}

function createFakePage(width = PAGE_WIDTH, height = PAGE_HEIGHT) {
  const getViewport = vi.fn<ThumbnailPage['getViewport']>(({ scale }) => ({
    width: width * scale,
    height: height * scale,
  }));
  const render = vi.fn<ThumbnailPage['render']>(() => ({ promise: Promise.resolve() }));
  const cleanup = vi.fn<() => void>();
  const page: ThumbnailPage = { getViewport, render, cleanup };
  return { page, getViewport, render, cleanup };
}

/** Stub the DOM canvas used by the default renderer. */
function stubCanvas(getContextResult: unknown, dataUrl: string | (() => string) = JPEG_DATA_URL) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => getContextResult),
    toDataURL: vi.fn(() => (typeof dataUrl === 'function' ? dataUrl() : dataUrl)),
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal('document', { createElement });
  return { canvas, createElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThumbnailLoader', () => {
  it('exposes a shared loader instance', () => {
    expect(pageThumbnails).toBeInstanceOf(ThumbnailLoader);
  });

  it('never runs more than two renders at once and drains the queue in order', async () => {
    const pdfDocument = createDocument();
    const jobs: Array<{ page: number; request: Deferred<string> }> = [];
    let active = 0;
    let maxActive = 0;
    const render = vi.fn<ThumbnailRender>((_document, pageNumber) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const request = deferred<string>();
      jobs.push({ page: pageNumber, request });
      return request.promise.finally(() => {
        active -= 1;
      });
    });

    const loader = new ThumbnailLoader(render, 2);
    const first = loader.load(pdfDocument, 1);
    const second = loader.load(pdfDocument, 2);
    const third = loader.load(pdfDocument, 3);

    expect(render).toHaveBeenCalledTimes(2);
    expect(jobs.map((job) => job.page)).toEqual([1, 2]);

    jobs[0].request.resolve('thumb-1');
    await expect(first).resolves.toBe('thumb-1');
    await flush();

    expect(render).toHaveBeenCalledTimes(3);
    expect(jobs.map((job) => job.page)).toEqual([1, 2, 3]);
    expect(maxActive).toBe(2);

    jobs[1].request.resolve('thumb-2');
    jobs[2].request.resolve('thumb-3');
    await expect(second).resolves.toBe('thumb-2');
    await expect(third).resolves.toBe('thumb-3');
    await flush();

    expect(maxActive).toBe(2);
    expect(active).toBe(0);
  });

  it('coalesces concurrent loads of the same page into one render', async () => {
    const pdfDocument = createDocument();
    const request = deferred<string>();
    const render = vi.fn<ThumbnailRender>(() => request.promise);
    const loader = new ThumbnailLoader(render);

    const first = loader.load(pdfDocument, 7);
    const second = loader.load(pdfDocument, 7);

    expect(render).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    request.resolve('thumb-7');
    await expect(first).resolves.toBe('thumb-7');
    await expect(second).resolves.toBe('thumb-7');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('serves cached pages without rendering again', async () => {
    const pdfDocument = createDocument();
    const render = vi.fn<ThumbnailRender>(async () => 'thumb-1');
    const loader = new ThumbnailLoader(render);

    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-1');
    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-1');

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('keeps caches separate for different document objects', async () => {
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const render = vi.fn<ThumbnailRender>(async (document) =>
      document === firstDocument ? 'thumb-a' : 'thumb-b',
    );
    const loader = new ThumbnailLoader(render);

    await expect(loader.load(firstDocument, 1)).resolves.toBe('thumb-a');
    await expect(loader.load(secondDocument, 1)).resolves.toBe('thumb-b');
    await expect(loader.load(firstDocument, 1)).resolves.toBe('thumb-a');

    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls.map(([document]) => document)).toEqual([
      firstDocument,
      secondDocument,
    ]);
  });

  it('evicts the least recently used page and refreshes hits', async () => {
    const pdfDocument = createDocument();
    let renderCount = 0;
    const render = vi.fn<ThumbnailRender>(async (_document, pageNumber) => {
      renderCount += 1;
      return `thumb-${pageNumber}-${renderCount}`;
    });
    const loader = new ThumbnailLoader(render, 2, 2);
    const renderedPages = () => render.mock.calls.map(([, pageNumber]) => pageNumber);

    for (const pageNumber of [1, 2, 3]) {
      await loader.load(pdfDocument, pageNumber);
    }
    // Cache holds pages 2 and 3; page 1 was evicted.
    expect(renderedPages()).toEqual([1, 2, 3]);

    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-1-4');
    expect(renderedPages()).toEqual([1, 2, 3, 1]);

    // Page 3 was refreshed by the first load and is still cached.
    await expect(loader.load(pdfDocument, 3)).resolves.toBe('thumb-3-3');
    expect(renderedPages()).toEqual([1, 2, 3, 1]);

    // Page 2 is now the oldest entry and renders again.
    await expect(loader.load(pdfDocument, 2)).resolves.toBe('thumb-2-5');
    expect(renderedPages()).toEqual([1, 2, 3, 1, 2]);
  });

  it('rejects a failed render and retries on the next load', async () => {
    const pdfDocument = createDocument();
    const render = vi
      .fn<ThumbnailRender>()
      .mockRejectedValueOnce(new Error('render exploded'))
      .mockResolvedValueOnce('thumb-ok');
    const loader = new ThumbnailLoader(render);

    await expect(loader.load(pdfDocument, 1)).rejects.toThrow('render exploded');
    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-ok');
    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-ok');

    expect(render).toHaveBeenCalledTimes(2);
  });

  it('renders again after clear(document) and clear()', async () => {
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const render = vi.fn<ThumbnailRender>(async (_document, pageNumber) => `thumb-${pageNumber}`);
    const loader = new ThumbnailLoader(render);

    await loader.load(firstDocument, 1);
    await loader.load(secondDocument, 1);
    expect(render).toHaveBeenCalledTimes(2);

    loader.clear(firstDocument);
    await loader.load(firstDocument, 1);
    await loader.load(secondDocument, 1);
    expect(render).toHaveBeenCalledTimes(3);

    loader.clear();
    await loader.load(firstDocument, 1);
    await loader.load(secondDocument, 1);
    expect(render).toHaveBeenCalledTimes(5);
  });

  it('discards an in-flight result when the document is cleared', async () => {
    const pdfDocument = createDocument();
    const stale = deferred<string>();
    const render = vi
      .fn<ThumbnailRender>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce('thumb-fresh');
    const loader = new ThumbnailLoader(render);

    const pending = loader.load(pdfDocument, 1);
    loader.clear(pdfDocument);
    stale.resolve('thumb-stale');

    await expect(pending).resolves.toBe('thumb-stale');
    await expect(loader.load(pdfDocument, 1)).resolves.toBe('thumb-fresh');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid page numbers without rendering', async () => {
    const pdfDocument = createDocument();
    const render = vi.fn<ThumbnailRender>(async () => 'thumb');
    const loader = new ThumbnailLoader(render);

    for (const pageNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(loader.load(pdfDocument, pageNumber)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(loader.load(pdfDocument, 0)).rejects.toThrow(/positive integer/);

    expect(render).not.toHaveBeenCalled();
  });
});

describe('default thumbnail renderer', () => {
  it('contains the page in 160x220 CSS px and renders at a capped device pixel ratio', async () => {
    const { canvas, createElement } = stubCanvas({});
    vi.stubGlobal('devicePixelRatio', 3);
    const { page, getViewport, render, cleanup } = createFakePage();
    const pdfDocument: ThumbnailDocument = { getPage: vi.fn(async () => page) };
    const loader = new ThumbnailLoader();

    await expect(loader.load(pdfDocument, 3)).resolves.toBe(JPEG_DATA_URL);

    expect(pdfDocument.getPage).toHaveBeenCalledWith(3);
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(getViewport).toHaveBeenNthCalledWith(1, { scale: 1 });
    expect(getViewport).toHaveBeenNthCalledWith(2, { scale: FIT_SCALE });

    // 160 x 207.06 CSS px at dpr 2 (capped from 3).
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(414);

    expect(render).toHaveBeenCalledTimes(1);
    const params = render.mock.calls[0][0] as unknown as {
      canvasContext: unknown;
      viewport: { width: number; height: number };
      transform: number[];
    };
    expect(params.viewport.width).toBeCloseTo(160, 5);
    expect(params.viewport.height).toBeCloseTo(PAGE_HEIGHT * FIT_SCALE, 5);
    expect(params.transform).toEqual([2, 0, 0, 2, 0, 0]);

    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.82);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects with a readable error when the 2D context is unavailable', async () => {
    const { canvas } = stubCanvas(null);
    vi.stubGlobal('devicePixelRatio', 1);
    const { page, render, cleanup } = createFakePage();
    const loader = new ThumbnailLoader();

    await expect(
      loader.load({ getPage: vi.fn(async () => page) }, 1),
    ).rejects.toThrow(/2D canvas context/);

    expect(canvas.width).toBe(160);
    expect(render).not.toHaveBeenCalled();
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('wraps a render rejection and still cleans the page up', async () => {
    stubCanvas({});
    vi.stubGlobal('devicePixelRatio', 1);
    const { page, render, cleanup } = createFakePage();
    render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('canvas exploded')) }));
    const loader = new ThumbnailLoader();

    await expect(
      loader.load({ getPage: vi.fn(async () => page) }, 2),
    ).rejects.toThrow(/Could not render page 2 for its thumbnail: canvas exploded/);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects when the canvas returns no image data', async () => {
    stubCanvas({}, '');
    vi.stubGlobal('devicePixelRatio', 1);
    const { page } = createFakePage();
    const loader = new ThumbnailLoader();

    await expect(
      loader.load({ getPage: vi.fn(async () => page) }, 4),
    ).rejects.toThrow(/did not produce image data/);
  });

  it('rejects when encoding the canvas fails', async () => {
    stubCanvas(
      {},
      () => {
        throw new Error('tainted canvas');
      },
    );
    vi.stubGlobal('devicePixelRatio', 1);
    const { page } = createFakePage();
    const loader = new ThumbnailLoader();

    await expect(
      loader.load({ getPage: vi.fn(async () => page) }, 5),
    ).rejects.toThrow(/Could not encode page 5 as a thumbnail: tainted canvas/);
  });
});
