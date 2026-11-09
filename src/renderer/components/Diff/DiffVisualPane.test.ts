// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPageSize } from '../../../shared/diff-types';
import type { DiffBoxSpec } from '../../services/diff-view';
import type { PixelDiffStats } from '../../services/visual-diff';

interface ViewportParams {
  viewBox: number[];
  scale: number;
  rotation?: number;
}

/** Minimal stand-in for a PDF.js viewport (`createMediaViewport` clones it). */
class FakeViewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly rotation: number;
  readonly userUnit = 1;
  readonly offsetX = 0;
  readonly offsetY = 0;

  constructor(params: ViewportParams) {
    const [x0, y0, x1, y1] = params.viewBox;
    const rawWidth = (x1 - x0) * params.scale;
    const rawHeight = (y1 - y0) * params.scale;
    const rotation = (((params.rotation ?? 0) % 360) + 360) % 360;
    const quarterTurn = rotation === 90 || rotation === 270;
    this.scale = params.scale;
    this.rotation = params.rotation ?? 0;
    this.width = quarterTurn ? rawHeight : rawWidth;
    this.height = quarterTurn ? rawWidth : rawHeight;
  }
}

interface FakeContext {
  canvas: HTMLCanvasElement;
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  setTransform: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  createImageData: ReturnType<typeof vi.fn>;
}

const { getDocument, destroyDoc, renderPage } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroyDoc: vi.fn(),
  renderPage: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }));

import { DiffVisualPane } from './DiffVisualPane';

const PAGE_SIZE: DiffPageSize = { width: 612, height: 792 };

const BOXES: DiffBoxSpec[] = [
  {
    key: '0:0:old',
    kind: 'removed',
    side: 'old',
    bbox: { x0: 10, y0: 700, x1: 60, y1: 712 },
    space: PAGE_SIZE,
    selected: false,
  },
];

/** Canvas -> RGBA fill value used by the fake `getImageData`. */
const fills = new Map<HTMLCanvasElement, number>();
/** Every 2D context handed out, so a test can inspect the drawing calls. */
const contexts = new Map<HTMLCanvasElement, FakeContext>();
let renderCount = 0;

const contextFor = (canvas: HTMLCanvasElement): FakeContext => {
  const context = contexts.get(canvas);
  if (!context) throw new Error('no fake context for canvas');
  return context;
};

const callsOf = (name: 'strokeRect' | 'putImageData' | 'drawImage'): unknown[][] =>
  [...contexts.values()].flatMap((context) => context[name].mock.calls as unknown[][]);

function stubDocument(): void {
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      getPage: async (pageNumber: number) => ({
        pageNumber,
        view: [0, 0, 612, 792],
        rotate: 0,
        getViewport: ({ scale }: { scale: number }) =>
          new FakeViewport({ viewBox: [0, 0, 612, 792], scale, rotation: 0 }),
        render: renderPage,
      }),
      destroy: destroyDoc,
    }),
  });
}

type PaneProps = React.ComponentProps<typeof DiffVisualPane>;

function paneElement(overrides: Partial<PaneProps> = {}): React.ReactElement {
  return React.createElement(DiffVisualPane, {
    oldSource: '/docs/old.pdf',
    newSource: '/docs/new.pdf',
    oldPageNumber: 1,
    newPageNumber: 1,
    oldSize: PAGE_SIZE,
    newSize: PAGE_SIZE,
    boxes: BOXES,
    zoom: 1,
    opacity: 0.55,
    style: 'blend',
    ...overrides,
  });
}

function renderPane(overrides: Partial<PaneProps> = {}) {
  return render(paneElement(overrides));
}

const lastStats = (stats: ReturnType<typeof vi.fn>): PixelDiffStats | null =>
  stats.mock.calls[stats.mock.calls.length - 1][0] as PixelDiffStats | null;

beforeEach(() => {
  getDocument.mockReset();
  destroyDoc.mockReset();
  renderPage.mockReset();
  fills.clear();
  contexts.clear();
  renderCount = 0;

  // jsdom has no canvas implementation; the pane only needs a 2D context.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement): FakeContext {
      const existing = contexts.get(this);
      if (existing) return existing;

      const context: FakeContext = {
        canvas: this,
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        setTransform: vi.fn(),
        setLineDash: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        drawImage: vi.fn(),
        putImageData: vi.fn(),
        getImageData: vi.fn((x: number, y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(fills.get(this) ?? 0),
          width,
          height,
        })),
        createImageData: vi.fn((width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        })),
      };
      contexts.set(this, context);
      return context;
    },
  });

  stubDocument();
  // The pane renders the old side first, then the new one; tag each rendered
  // canvas with a different fill so the pixel diff sees a real change.
  renderPage.mockImplementation(({ canvasContext }: { canvasContext: FakeContext }) => {
    fills.set(canvasContext.canvas, renderCount === 0 ? 0 : 255);
    renderCount += 1;
    return { promise: Promise.resolve(), cancel: vi.fn() };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext;
});

describe('DiffVisualPane loading', () => {
  it('asks for two documents before rendering anything', () => {
    renderPane({ oldSource: null, newSource: null, oldPageNumber: null, newPageNumber: null });

    expect(screen.getByText('Choose two PDFs to compare.')).toBeTruthy();
    expect(getDocument).not.toHaveBeenCalled();
    expect(screen.queryByTestId('diff-visual-page')).toBeNull();
  });

  it('shows a loading state until both documents open', async () => {
    let openDocument: ((document: unknown) => void) | null = null;
    getDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        openDocument = resolve;
      }),
    });

    renderPane();

    expect(screen.getByText('Loading documents…')).toBeTruthy();

    await act(async () => {
      openDocument?.({
        getPage: async () => ({
          view: [0, 0, 612, 792],
          rotate: 0,
          getViewport: ({ scale }: { scale: number }) =>
            new FakeViewport({ viewBox: [0, 0, 612, 792], scale, rotation: 0 }),
          render: renderPage,
        }),
        destroy: destroyDoc,
      });
    });

    await waitFor(() => expect(screen.queryByText('Loading documents…')).toBeNull());
  });

  it('loads each side through its own document, using the diff path rules', async () => {
    const stats = vi.fn();
    renderPane({ onRenderStats: stats });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));

    expect(getDocument).toHaveBeenCalledWith('file:///docs/old.pdf');
    expect(getDocument).toHaveBeenCalledWith('file:///docs/new.pdf');
    // One render per side, at the shared fitted bitmap.
    expect(renderPage).toHaveBeenCalledTimes(2);
  });
});

describe('DiffVisualPane composition', () => {
  it('blends the old page over the new one and reports the pixel stats', async () => {
    const stats = vi.fn();
    renderPane({ onRenderStats: stats, opacity: 0.4 });

    await waitFor(() => expect(lastStats(stats)?.totalPixels).toBe(612 * 792));

    // Both page bitmaps are 612x792, filled with 0 and 255: every pixel differs.
    expect(lastStats(stats)).toEqual({
      changedPixels: 612 * 792,
      totalPixels: 612 * 792,
      ratio: 1,
    });

    const page = screen.getByTestId('diff-visual-page');
    expect(page.style.width).toBe('612px');
    expect(page.style.height).toBe('792px');

    const visible = page.querySelector('canvas');
    expect(visible?.width).toBe(612);
    expect(visible?.height).toBe(792);
    // Base page plus the blended old page.
    expect(contextFor(visible!).drawImage).toHaveBeenCalledTimes(2);
    expect(contextFor(visible!).globalAlpha).toBe(1);
  });

  it('paints a heatmap mask instead of blending', async () => {
    const stats = vi.fn();
    renderPane({ style: 'heatmap', onRenderStats: stats });

    await waitFor(() => expect(callsOf('putImageData')).toHaveLength(1));

    const visible = screen.getByTestId('diff-visual-page').querySelector('canvas');
    // Base page plus the mask overlay.
    expect(contextFor(visible!).drawImage).toHaveBeenCalledTimes(2);
    expect(lastStats(stats)?.ratio).toBe(1);
  });

  it('draws the object boxes in boxes style', async () => {
    renderPane({ style: 'boxes' });

    await waitFor(() => expect(callsOf('strokeRect')).toHaveLength(1));
    // The diff bbox is projected with the usual y flip.
    expect(callsOf('strokeRect')[0]).toEqual([10, 792 - 712, 50, 12]);
  });

  it('leaves the object boxes off in blend style', async () => {
    renderPane({ style: 'blend' });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    expect(callsOf('strokeRect')).toHaveLength(0);
  });

  it('scales the composite with the shared zoom without re-rendering the bitmap', async () => {
    const { rerender } = renderPane({ zoom: 2 });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    const page = screen.getByTestId('diff-visual-page');
    expect(page.style.width).toBe('1224px');
    expect(page.querySelector('canvas')?.width).toBe(612);

    rerender(paneElement({ zoom: 3 }));
    await waitFor(() => expect(screen.getByTestId('diff-visual-page').style.width).toBe('1836px'));
    // Zoom is a display scale, not a new comparison.
    expect(renderPage).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached page bitmaps when only the opacity changes', async () => {
    const { rerender } = renderPane({ opacity: 0.55 });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));

    rerender(paneElement({ opacity: 0.2 }));
    await waitFor(() => expect(screen.getByTestId('diff-visual-page')).toBeTruthy());
    expect(renderPage).toHaveBeenCalledTimes(2);
  });
});

describe('DiffVisualPane one-sided pages', () => {
  it('shows the new page alone with an explanatory notice', async () => {
    const stats = vi.fn();
    renderPane({
      oldSource: null,
      oldPageNumber: null,
      oldSize: null,
      onRenderStats: stats,
    });

    expect(
      screen.getByText('This page exists only in the new document — showing the new page.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('diff-visual-page')).toBeTruthy());
    // Only the new document is opened.
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith('file:///docs/new.pdf');
    // A single side has no pixel comparison.
    expect(lastStats(stats)).toBeNull();
    expect(callsOf('putImageData')).toHaveLength(0);
  });

  it('shows the old page alone for a removed page', async () => {
    const stats = vi.fn();
    renderPane({ newPageNumber: null, newSize: null, onRenderStats: stats });

    expect(
      screen.getByText('This page exists only in the old document — showing the old page.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('diff-visual-page')).toBeTruthy());
    // Only the old side is rendered, even though both documents were opened.
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    expect(lastStats(stats)).toBeNull();
  });

  it('explains a page that has no renderable side', async () => {
    renderPane({ oldPageNumber: null, newPageNumber: null });

    await waitFor(() => expect(screen.getByText('This page has no renderable side.')).toBeTruthy());
    expect(screen.queryByTestId('diff-visual-page')).toBeNull();
  });
});

describe('DiffVisualPane ignore regions', () => {
  // 612x792 page, bitmap at 1:1: the top-left 100x100 pixels of the page.
  const REGION = { oldPage: 1, newPage: 1, bbox: { x0: 0, y0: 692, x1: 100, y1: 792 } };

  it('masks the region in the heatmap and excludes it from the total', async () => {
    const stats = vi.fn();
    renderPane({ style: 'heatmap', ignoreRegions: [REGION], onRenderStats: stats });

    const maskedPixels = 100 * 100;
    await waitFor(() =>
      expect(lastStats(stats)?.totalPixels).toBe(612 * 792 - maskedPixels),
    );
    // Every remaining pixel still differs, so the ratio stays 100%.
    expect(lastStats(stats)).toEqual({
      changedPixels: 612 * 792 - maskedPixels,
      totalPixels: 612 * 792 - maskedPixels,
      ratio: 1,
    });
    // The heatmap mask is still painted once, now with the ignored block muted.
    expect(callsOf('putImageData')).toHaveLength(1);
  });

  it('masks when only one side of the pair names the page', async () => {
    const stats = vi.fn();
    renderPane({
      style: 'heatmap',
      ignoreRegions: [{ oldPage: 1, newPage: null, bbox: REGION.bbox }],
      onRenderStats: stats,
    });

    await waitFor(() => expect(lastStats(stats)?.totalPixels).toBe(612 * 792 - 10_000));
  });

  it('does not mask a region that belongs to another page', async () => {
    const stats = vi.fn();
    renderPane({
      ignoreRegions: [{ oldPage: 2, newPage: 2, bbox: REGION.bbox }],
      onRenderStats: stats,
    });

    await waitFor(() => expect(lastStats(stats)?.totalPixels).toBe(612 * 792));
  });

  it('draws dashed outlines for the active regions in every style', async () => {
    renderPane({ style: 'blend', ignoreRegions: [REGION] });

    await waitFor(() => expect(callsOf('strokeRect').length).toBeGreaterThan(0));
    // One distinct rectangle: the region's bitmap area.
    const strokes = new Set(callsOf('strokeRect').map((call) => call.join(',')));
    expect(strokes).toEqual(new Set(['0,0,100,100']));
    const dashes = [...contexts.values()].flatMap(
      (context) => context.setLineDash.mock.calls as unknown[][],
    );
    expect(dashes).toContainEqual([[6, 4]]);
  });

  it('recomputes the comparison when the regions change', async () => {
    const stats = vi.fn();
    const { rerender } = renderPane({ ignoreRegions: [], onRenderStats: stats });
    await waitFor(() => expect(lastStats(stats)?.totalPixels).toBe(612 * 792));

    rerender(paneElement({ ignoreRegions: [REGION], onRenderStats: stats }));

    await waitFor(() => expect(lastStats(stats)?.totalPixels).toBe(612 * 792 - 10_000));
  });
});

describe('DiffVisualPane errors and cleanup', () => {  it('reports a document that fails to open', async () => {
    getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('Invalid PDF structure')) });
    const stats = vi.fn();

    renderPane({ onRenderStats: stats });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Failed to load the old document: Invalid PDF structure',
      ),
    );
    expect(lastStats(stats)).toBeNull();
    expect(screen.queryByTestId('diff-visual-page')).toBeNull();
  });

  it('cancels an in-flight page render when the page changes', async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    renderPage.mockImplementation(() => {
      const cancel = vi.fn();
      cancels.push(cancel);
      // Never settles: the render stays in flight until it is cancelled.
      return { promise: new Promise<void>(() => {}), cancel };
    });

    const { rerender } = renderPane();
    await waitFor(() => expect(cancels).toHaveLength(1));

    rerender(paneElement({ oldPageNumber: 2, newPageNumber: 2 }));

    await waitFor(() => expect(cancels[0]).toHaveBeenCalled());
  });

  it('creates object URLs for browser files and releases them on unmount', async () => {
    const createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });

    const oldFile = new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' });
    const newFile = new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' });
    const { unmount } = renderPane({ oldSource: oldFile, newSource: newFile });

    await waitFor(() => expect(getDocument).toHaveBeenCalledWith('blob:old.pdf'));
    expect(getDocument).toHaveBeenCalledWith('blob:new.pdf');

    unmount();

    expect(destroyDoc).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:old.pdf');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:new.pdf');
  });

  it('labels the pane for assistive technology', () => {
    renderPane();

    expect(screen.getByRole('region', { name: 'Visual diff pane' })).toBeTruthy();
  });
});
