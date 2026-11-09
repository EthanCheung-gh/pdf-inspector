// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffIgnoreRegion, DiffPageSize } from '../../../shared/diff-types';
import type { DiffBoxSpec } from '../../services/diff-view';

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
    // PDF.js swaps the viewBox dimensions for a quarter turn, exactly like the
    // real PageViewport: this is what makes a double swap visible in a test.
    const quarterTurn = rotation === 90 || rotation === 270;
    this.scale = params.scale;
    this.rotation = params.rotation ?? 0;
    this.width = quarterTurn ? rawHeight : rawWidth;
    this.height = quarterTurn ? rawWidth : rawHeight;
  }
}

const { getDocument, destroyDoc, renderPage, context2d } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroyDoc: vi.fn(),
  renderPage: vi.fn(),
  context2d: {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setTransform: vi.fn(),
    setLineDash: vi.fn(),
    scale: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  },
}));

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }));

import { DiffPdfPane, dragBBoxToPdf } from './DiffPdfPane';

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

interface StubPageOptions {
  /** PDF.js `/Rotate` value; the fake viewport applies it like the real one. */
  rotate?: number;
  /** Raw (unrotated) MediaBox/CropBox frame. */
  view?: number[];
}

function stubDocument({ rotate = 0, view = [0, 0, 612, 792] }: StubPageOptions = {}): void {
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      getPage: async () => ({
        view,
        rotate,
        getViewport: ({ scale }: { scale: number }) =>
          new FakeViewport({ viewBox: view, scale, rotation: rotate }),
        render: renderPage,
      }),
      destroy: destroyDoc,
    }),
  });
  renderPage.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
}

function renderPane(overrides: Partial<React.ComponentProps<typeof DiffPdfPane>> = {}): void {
  render(
    React.createElement(DiffPdfPane, {
      side: 'old',
      label: 'Old',
      source: '/docs/old.pdf',
      pageNumber: 1,
      pageSize: PAGE_SIZE,
      boxes: BOXES,
      zoom: 1,
      emptyMessage: 'Choose an old PDF to compare.',
      missingMessage: 'This page does not exist in the old document.',
      ...overrides,
    }),
  );
}

beforeEach(() => {
  getDocument.mockReset();
  destroyDoc.mockReset();
  renderPage.mockReset();
  context2d.strokeRect.mockReset();
  context2d.fillRect.mockReset();
  // jsdom has no canvas implementation; the pane only needs a 2D context to
  // hand to its drawing code.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => context2d,
  });
  stubDocument();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext;
});

describe('DiffPdfPane', () => {
  it('asks for a side before any document is chosen', () => {
    renderPane({ source: null, pageNumber: null, pageSize: null, boxes: [] });

    expect(screen.getByText('Choose an old PDF to compare.')).toBeTruthy();
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('shows a placeholder for a page that only exists on the other side', async () => {
    renderPane({ pageNumber: null, pageSize: null, boxes: [] });

    await waitFor(() =>
      expect(screen.getByText('This page does not exist in the old document.')).toBeTruthy(),
    );
    expect(screen.getByText('No page')).toBeTruthy();
    expect(screen.queryByTestId('diff-pane-page-old')).toBeNull();
  });

  it('renders the requested page from a desktop path', async () => {
    renderPane();

    await waitFor(() => expect(screen.getByTestId('diff-pane-page-old')).toBeTruthy());
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    expect(getDocument).toHaveBeenCalledWith('file:///docs/old.pdf');
    // The canvas is laid out at the shared zoom in CSS pixels.
    expect(screen.getByText('Page 1 · 612 × 792 pt')).toBeTruthy();

    // The box is projected onto the page (y flipped) and stroked.
    await waitFor(() => expect(context2d.strokeRect).toHaveBeenCalled());
    expect(context2d.strokeRect).toHaveBeenCalledWith(10, 792 - 712, 50, 12);
  });

  it('bumps the render scale with the shared zoom', async () => {
    renderPane({ zoom: 2 });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    const { viewport } = renderPage.mock.calls[0][0] as { viewport: FakeViewport };
    // Device pixel ratio is 1 in jsdom, so the render viewport is zoom * 1.
    expect(viewport.width).toBe(612 * 2);
    expect(viewport.height).toBe(792 * 2);
  });

  it('reports a document that fails to open', async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('Invalid PDF structure')) });

    renderPane();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Invalid PDF structure'),
    );
    expect(screen.queryByTestId('diff-pane-page-old')).toBeNull();
  });

  it('keeps a /Rotate 90 page in its displayed orientation instead of transposing it', async () => {
    // The sidecar reports the rotation-aware page size (a quarter turn makes it
    // landscape 792x612), while the raw MediaBox is still portrait 612x792 and
    // PDF.js applies the rotation itself. Passing the swapped size as the
    // viewBox would transpose the page a second time.
    stubDocument({ rotate: 90, view: [0, 0, 612, 792] });
    renderPane({ pageSize: { width: 792, height: 612 } });

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    const { viewport } = renderPage.mock.calls[0][0] as { viewport: FakeViewport };
    expect(viewport.width).toBe(792);
    expect(viewport.height).toBe(612);

    const page = screen.getByTestId('diff-pane-page-old');
    expect(page.style.width).toBe('792px');
    expect(page.style.height).toBe('612px');

    // Boxes stay hidden on rotated pages, with the notice explaining why.
    expect(screen.getByText('Rotated page: diff boxes unavailable')).toBeTruthy();
    expect(context2d.strokeRect).not.toHaveBeenCalled();
  });

  it('leaves a /Rotate 180 page unswapped', async () => {
    stubDocument({ rotate: 180, view: [0, 0, 612, 792] });
    renderPane();

    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    const { viewport } = renderPage.mock.calls[0][0] as { viewport: FakeViewport };
    expect(viewport.width).toBe(612);
    expect(viewport.height).toBe(792);
    expect(screen.getByText('Rotated page: diff boxes unavailable')).toBeTruthy();
  });

  it('creates an object URL for a browser File and revokes it on unmount', async () => {
    const createObjectURL = vi.fn(() => 'blob:diff-old');
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

    const file = new File(['%PDF-1.7'], 'old.pdf', { type: 'application/pdf' });
    const { unmount } = render(
      React.createElement(DiffPdfPane, {
        side: 'old',
        label: 'Old',
        source: file,
        pageNumber: 1,
        pageSize: PAGE_SIZE,
        boxes: BOXES,
        zoom: 1,
        emptyMessage: 'Choose an old PDF to compare.',
        missingMessage: 'This page does not exist in the old document.',
      }),
    );

    await waitFor(() => expect(getDocument).toHaveBeenCalledWith('blob:diff-old'));
    expect(createObjectURL).toHaveBeenCalledWith(file);

    unmount();

    expect(destroyDoc).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:diff-old');
  });

  it('labels the pane for assistive technology', () => {
    renderPane({ side: 'overlay', label: 'Overlay' });

    expect(screen.getByRole('region', { name: 'Overlay pane' })).toBeTruthy();
  });
});

describe('dragBBoxToPdf', () => {
  const PAGE: DiffPageSize = { width: 612, height: 792 };

  it('flips the y axis and keeps the box ordered', () => {
    expect(
      dragBBoxToPdf({ x: 100, y: 100 }, { x: 200, y: 150 }, PAGE, { width: 612, height: 792 }),
    ).toEqual({ x0: 100, y0: 642, x1: 200, y1: 692 });

    // Dragging up-left must produce the same box.
    expect(
      dragBBoxToPdf({ x: 200, y: 150 }, { x: 100, y: 100 }, PAGE, { width: 612, height: 792 }),
    ).toEqual({ x0: 100, y0: 642, x1: 200, y1: 692 });
  });

  it('scales with the rendered page size', () => {
    expect(
      dragBBoxToPdf({ x: 50, y: 100 }, { x: 100, y: 200 }, PAGE, { width: 306, height: 396 }),
    ).toEqual({ x0: 100, y0: 392, x1: 200, y1: 592 });
  });

  it('rejects click-sized drags and unusable geometry', () => {
    expect(dragBBoxToPdf({ x: 10, y: 10 }, { x: 11, y: 40 }, PAGE, { width: 612, height: 792 })).toBeNull();
    expect(dragBBoxToPdf({ x: 10, y: 10 }, { x: 40, y: 11 }, PAGE, { width: 612, height: 792 })).toBeNull();
    expect(
      dragBBoxToPdf({ x: 10, y: 10 }, { x: 40, y: 40 }, { width: 0, height: 792 }, { width: 612, height: 792 }),
    ).toBeNull();
    expect(
      dragBBoxToPdf({ x: 10, y: 10 }, { x: 40, y: 40 }, PAGE, { width: 612, height: 0 }),
    ).toBeNull();
  });
});

describe('DiffPdfPane ignore regions', () => {
  const REGION: DiffIgnoreRegion = {
    oldPage: 1,
    newPage: 1,
    bbox: { x0: 100, y0: 642, x1: 200, y1: 692 },
  };

  /** The overlay canvas of a pane, once its page is measured and drawable. */
  const drawableOverlay = async (side: 'old' | 'new' = 'old'): Promise<HTMLElement> => {
    await waitFor(() =>
      expect(
        screen.getByTestId(`diff-pane-overlay-${side}`).getAttribute('data-drawable'),
      ).toBe('true'),
    );
    return screen.getByTestId(`diff-pane-overlay-${side}`);
  };

  it('converts a drag into a PDF box for both sides of a paired page', async () => {
    const onRegionComplete = vi.fn();
    renderPane({
      regionMode: true,
      regions: [],
      pagePair: { oldPage: 1, newPage: 1 },
      onRegionComplete,
    });

    const canvas = await drawableOverlay();
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 150 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 150 });

    expect(onRegionComplete).toHaveBeenCalledTimes(1);
    expect(onRegionComplete).toHaveBeenCalledWith({
      oldPage: 1,
      newPage: 1,
      bbox: { x0: 100, y0: 642, x1: 200, y1: 692 },
    });
  });

  it('uses only the available side of a one-sided page', async () => {
    const onRegionComplete = vi.fn();
    render(
      React.createElement(DiffPdfPane, {
        side: 'new',
        label: 'New',
        source: '/docs/new.pdf',
        pageNumber: 2,
        pageSize: PAGE_SIZE,
        boxes: [],
        zoom: 1,
        emptyMessage: 'Choose a new PDF to compare.',
        missingMessage: 'This page does not exist in the new document.',
        regionMode: true,
        pagePair: { oldPage: null, newPage: 2 },
        onRegionComplete,
      }),
    );

    const canvas = await drawableOverlay('new');
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 60 });

    expect(onRegionComplete).toHaveBeenCalledWith({
      oldPage: null,
      newPage: 2,
      bbox: { x0: 10, y0: 732, x1: 60, y1: 782 },
    });
  });

  it('ignores the drag while region mode is off', async () => {
    const onRegionComplete = vi.fn();
    renderPane({ onRegionComplete });

    await waitFor(() => expect(screen.getByTestId('diff-pane-overlay-old')).toBeTruthy());
    const canvas = screen.getByTestId('diff-pane-overlay-old');
    expect(canvas.getAttribute('data-drawable')).toBe('false');
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 150 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 150 });

    expect(onRegionComplete).not.toHaveBeenCalled();
  });

  it('drops a click-sized drag instead of adding a zero-area region', async () => {
    const onRegionComplete = vi.fn();
    renderPane({ regionMode: true, onRegionComplete });

    const canvas = await drawableOverlay();
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(canvas, { clientX: 101, clientY: 101 });

    expect(onRegionComplete).not.toHaveBeenCalled();
  });

  it('cancels the drag on Escape', async () => {
    const onRegionComplete = vi.fn();
    renderPane({ regionMode: true, onRegionComplete });

    const canvas = await drawableOverlay();
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 150 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 150 });

    expect(onRegionComplete).not.toHaveBeenCalled();
  });

  it('draws existing regions on this page as dashed outlines', async () => {
    renderPane({
      regions: [
        REGION,
        // Another page and another side: neither belongs on this pane.
        { oldPage: 2, newPage: 2, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { oldPage: null, newPage: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
      ],
    });

    await waitFor(() => expect(context2d.strokeRect).toHaveBeenCalled());
    // Every distinct rectangle the pane stroked: the diff box from BOXES and the
    // one region that belongs to this page. The other two regions are dropped.
    const stroked = new Set(
      context2d.strokeRect.mock.calls.map((args) => (args as number[]).join(',')),
    );
    expect(stroked).toEqual(new Set(['10,80,50,12', '100,100,100,50']));
    expect(context2d.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(context2d.setLineDash).toHaveBeenCalledWith([]);
  });

  it('disables drawing on a rotated page', async () => {
    stubDocument({ rotate: 90, view: [0, 0, 612, 792] });
    const onRegionComplete = vi.fn();
    renderPane({
      regionMode: true,
      pageSize: { width: 792, height: 612 },
      onRegionComplete,
    });

    await waitFor(() => expect(screen.getByText('Rotated page: regions unavailable')).toBeTruthy());
    const canvas = screen.getByTestId('diff-pane-overlay-old');
    expect(canvas.getAttribute('data-drawable')).toBe('false');
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 150 });

    expect(onRegionComplete).not.toHaveBeenCalled();
  });
});
