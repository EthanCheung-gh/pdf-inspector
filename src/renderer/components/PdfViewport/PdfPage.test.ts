// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageData, PageRotation, PdfWord } from '../../types/pdf-objects';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useCursorStore } from '../../store/cursor-store';
import { usePdfStore } from '../../store/pdf-store';
import { DEFAULT_WORKSPACE_LAYOUT, useWorkspaceStore } from '../../store/workspace-store';

const mocks = vi.hoisted(() => ({
  geometryProps: vi.fn(),
  rulerProps: vi.fn(),
}));

// PdfPage only needs the render-task *type* from pdfjs-dist; the real module
// would start a worker in jsdom.
vi.mock('pdfjs-dist', () => ({}));

vi.mock('./TextLayer', () => ({
  TextLayer: () => React.createElement('div', { 'data-testid': 'text-layer' }),
}));
vi.mock('./OverlayCanvas', () => ({
  OverlayCanvas: () => React.createElement('div', { 'data-testid': 'object-overlay' }),
}));
vi.mock('./InspectorHighlight', () => ({
  InspectorHighlight: () => React.createElement('div', { 'data-testid': 'inspector-highlight' }),
}));
vi.mock('./PageGeometryOverlay', () => ({
  PageGeometryOverlay: (props: unknown) => {
    mocks.geometryProps(props);
    return React.createElement('div', { 'data-testid': 'geometry-overlay' });
  },
}));
vi.mock('./PageRuler', () => ({
  PageRuler: (props: unknown) => {
    mocks.rulerProps(props);
    return React.createElement('div', { 'data-testid': 'page-ruler' });
  },
}));

import { PdfPage } from './PdfPage';

interface ViewportParams {
  viewBox: number[];
  scale: number;
  rotation?: number;
  userUnit?: number;
  offsetX?: number;
  offsetY?: number;
}

const applyTransform = (
  [x, y]: [number, number],
  [a, b, c, d, e, f]: number[],
): [number, number] => [a * x + c * y + e, b * x + d * y + f];

const applyInverseTransform = (
  [x, y]: [number, number],
  [a, b, c, d, e, f]: number[],
): [number, number] => {
  const determinant = a * d - b * c;
  const px = x - e;
  const py = y - f;
  return [(d * px - c * py) / determinant, (-b * px + a * py) / determinant];
};

/**
 * Minimal `PageViewport` clone (same transform math) so `createMediaViewport`
 * can invoke the runtime constructor and the cursor/geometry mappings are real.
 */
class FakePageViewport {
  viewBox: number[];
  scale: number;
  rotation: number;
  userUnit: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  transform: number[];

  constructor({
    viewBox,
    scale,
    rotation = 0,
    userUnit = 1,
    offsetX = 0,
    offsetY = 0,
  }: ViewportParams) {
    this.viewBox = viewBox;
    this.scale = scale;
    this.rotation = rotation;
    this.userUnit = userUnit;
    this.offsetX = offsetX;
    this.offsetY = offsetY;

    const effectiveScale = scale * userUnit;
    const centerX = (viewBox[2] + viewBox[0]) / 2;
    const centerY = (viewBox[3] + viewBox[1]) / 2;
    const normalized = ((rotation % 360) + 360) % 360;

    let a: number;
    let b: number;
    let c: number;
    let d: number;
    switch (normalized) {
      case 180:
        a = -1;
        b = 0;
        c = 0;
        d = 1;
        break;
      case 90:
        a = 0;
        b = 1;
        c = 1;
        d = 0;
        break;
      case 270:
        a = 0;
        b = -1;
        c = -1;
        d = 0;
        break;
      case 0:
        a = 1;
        b = 0;
        c = 0;
        d = -1;
        break;
      default:
        throw new Error(`Unsupported rotation ${rotation}`);
    }

    let offsetCanvasX: number;
    let offsetCanvasY: number;
    let width: number;
    let height: number;
    if (a === 0) {
      offsetCanvasX = Math.abs(centerY - viewBox[1]) * effectiveScale + offsetX;
      offsetCanvasY = Math.abs(centerX - viewBox[0]) * effectiveScale + offsetY;
      width = (viewBox[3] - viewBox[1]) * effectiveScale;
      height = (viewBox[2] - viewBox[0]) * effectiveScale;
    } else {
      offsetCanvasX = Math.abs(centerX - viewBox[0]) * effectiveScale + offsetX;
      offsetCanvasY = Math.abs(centerY - viewBox[1]) * effectiveScale + offsetY;
      width = (viewBox[2] - viewBox[0]) * effectiveScale;
      height = (viewBox[3] - viewBox[1]) * effectiveScale;
    }

    this.transform = [
      a * effectiveScale,
      b * effectiveScale,
      c * effectiveScale,
      d * effectiveScale,
      offsetCanvasX - a * effectiveScale * centerX - c * effectiveScale * centerY,
      offsetCanvasY - b * effectiveScale * centerX - d * effectiveScale * centerY,
    ];
    this.width = width;
    this.height = height;
  }

  convertToViewportPoint(x: number, y: number): [number, number] {
    return applyTransform([x, y], this.transform);
  }

  convertToPdfPoint(x: number, y: number): [number, number] {
    return applyInverseTransform([x, y], this.transform);
  }
}

const createFakePage = (cropBox: number[], rotation: PageRotation) => {
  const getViewport = vi.fn(({ scale }: { scale: number }) =>
    new FakePageViewport({ viewBox: cropBox, scale, rotation }),
  );
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  return { getViewport, render };
};

const makePageData = (overrides: Partial<PageData> = {}): PageData => ({
  width: 612,
  height: 792,
  rotation: 0,
  boxes: {
    media: { x0: 0, y0: 0, x1: 612, y1: 792 },
    crop: { x0: 0, y0: 0, x1: 612, y1: 792 },
    trim: null,
    bleed: null,
    art: null,
  },
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
  ...overrides,
});

const lastGeometryViewport = (): FakePageViewport => {
  const calls = mocks.geometryProps.mock.calls;
  const props = calls[calls.length - 1]?.[0] as { viewport: FakePageViewport | null } | undefined;
  if (!props?.viewport) throw new Error('geometry viewport is not ready');
  return props.viewport;
};

const waitForGeometryViewport = async (): Promise<void> => {
  await waitFor(() => {
    const calls = mocks.geometryProps.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[calls.length - 1]?.[0] as { viewport: unknown }).viewport).not.toBeNull();
  });
};

const renderPage = (
  pageData: PageData,
  options: {
    cropBox?: number[];
    rotation?: PageRotation;
    zoom?: number;
    showRulers?: boolean;
  } = {},
) => {
  const rotation = options.rotation ?? 0;
  const page = createFakePage(options.cropBox ?? [0, 0, 612, 792], rotation);
  const pdfDoc = { getPage: vi.fn(async () => page) };

  usePdfStore.setState({ pageData, metadata: null, currentPage: 1 });
  useWorkspaceStore.setState({
    ...DEFAULT_WORKSPACE_LAYOUT,
    showRulers: options.showRulers ?? false,
  });
  useCursorStore.setState({ cursorPdfPoint: null });

  render(
    React.createElement(PdfPage, {
      pageNum: 1,
      zoom: options.zoom ?? 1,
      pdfDoc: pdfDoc as unknown as PDFDocumentProxy,
    }),
  );

  return { page, pdfDoc };
};

describe('PdfPage page geometry', () => {
  beforeEach(() => {
    mocks.geometryProps.mockClear();
    mocks.rulerProps.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the unrotated page frame from the media viewport with object overlays visible', async () => {
    renderPage(makePageData());
    await waitForGeometryViewport();

    const frame = screen.getByTestId('pdf-page-frame');
    expect(frame.style.width).toBe('612px');
    expect(frame.style.height).toBe('792px');

    expect(screen.getByTestId('object-overlay')).toBeTruthy();
    expect(screen.getByTestId('inspector-highlight')).toBeTruthy();
    expect(screen.queryByText(/Rotated page/)).toBeNull();

    const viewport = lastGeometryViewport();
    expect(viewport.width).toBe(612);
    expect(viewport.height).toBe(792);
    expect(viewport.rotation).toBe(0);
  });

  it.each([
    { rotation: 90 as PageRotation, width: 792, height: 612 },
    { rotation: 180 as PageRotation, width: 612, height: 792 },
    { rotation: 270 as PageRotation, width: 792, height: 612 },
  ])(
    'hides object overlays and shows the notice for rotation $rotation',
    async ({ rotation, width, height }) => {
      renderPage(makePageData({ width, height, rotation }), {
        rotation,
        cropBox: [0, 0, 612, 792],
      });
      await waitForGeometryViewport();

      const frame = screen.getByTestId('pdf-page-frame');
      expect(frame.style.width).toBe(`${width}px`);
      expect(frame.style.height).toBe(`${height}px`);

      expect(screen.queryByTestId('object-overlay')).toBeNull();
      expect(screen.queryByTestId('inspector-highlight')).toBeNull();
      expect(screen.getByText('Rotated page: object overlay unavailable')).toBeTruthy();

      const viewport = lastGeometryViewport();
      expect(viewport.width).toBe(width);
      expect(viewport.height).toBe(height);
      expect(viewport.rotation).toBe(rotation);
    },
  );

  it('uses the MediaBox, not the CropBox, for boxes, rulers and the frame', async () => {
    const { page } = renderPage(
      makePageData({
        boxes: {
          media: { x0: 0, y0: 0, x1: 612, y1: 792 },
          crop: { x0: 10, y0: 10, x1: 602, y1: 782 },
          trim: null,
          bleed: null,
          art: null,
        },
      }),
      { cropBox: [10, 10, 602, 782], showRulers: true },
    );
    await waitForGeometryViewport();

    // PDF.js' own viewport is the smaller crop box (592 × 772)...
    const pdfjsViewport = page.getViewport.mock.results[0]?.value as FakePageViewport;
    expect(pdfjsViewport.width).toBe(592);
    expect(pdfjsViewport.height).toBe(772);

    // ...while the geometry viewport, rulers and frame use the 612 × 792 media box.
    const mediaViewport = lastGeometryViewport();
    expect(mediaViewport).not.toBe(pdfjsViewport);
    expect(mediaViewport.width).toBe(612);
    expect(mediaViewport.height).toBe(792);

    const frame = screen.getByTestId('pdf-page-frame');
    expect(frame.style.width).toBe('612px');
    expect(frame.style.height).toBe('792px');

    // The crop box is inset from the MediaBox/frame by 10pt on every side.
    expect(mediaViewport.convertToViewportPoint(10, 10)).toEqual([10, 782]);
    expect(mediaViewport.convertToViewportPoint(602, 782)).toEqual([602, 10]);

    expect(screen.getByTestId('page-ruler')).toBeTruthy();
    const rulerProps = mocks.rulerProps.mock.calls.at(-1)?.[0] as {
      width: number;
      height: number;
      viewport: FakePageViewport;
    };
    expect(rulerProps.width).toBe(612);
    expect(rulerProps.height).toBe(792);
    expect(rulerProps.viewport.width).toBe(612);
    expect(rulerProps.viewport.height).toBe(792);
  });

  it('converts mousemove to MediaBox-relative PDF points matching object coordinates', async () => {
    const media = { x0: 10, y0: 20, x1: 622, y1: 812 };
    const word: PdfWord = {
      type: 'word',
      page: 1,
      x0: 100,
      y0: 200,
      x1: 160,
      y1: 220,
      text: 'offset',
      fontname: 'Inter',
      size: 12,
    };

    renderPage(
      makePageData({
        boxes: {
          media,
          crop: media,
          trim: null,
          bleed: null,
          art: null,
        },
        words: [word],
      }),
      { cropBox: [media.x0, media.y0, media.x1, media.y1] },
    );
    await waitForGeometryViewport();

    const viewport = lastGeometryViewport();
    // Object coordinates are relative to the MediaBox origin.
    const [screenX, screenY] = viewport.convertToViewportPoint(
      media.x0 + word.x0,
      media.y0 + word.y0,
    );

    const container = screen.getByTestId('pdf-page-container');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 612,
      bottom: 792,
      width: 612,
      height: 792,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseMove(container, { clientX: screenX, clientY: screenY });

    expect(useCursorStore.getState().cursorPdfPoint).toEqual({ x: word.x0, y: word.y0 });

    fireEvent.mouseLeave(container);
    expect(useCursorStore.getState().cursorPdfPoint).toBeNull();
  });

  it('mounts the ruler with the media viewport dimensions when enabled', async () => {
    renderPage(makePageData(), { showRulers: true });
    await waitForGeometryViewport();

    expect(screen.getByTestId('page-ruler')).toBeTruthy();
    const rulerProps = mocks.rulerProps.mock.calls.at(-1)?.[0] as {
      width: number;
      height: number;
    };
    expect(rulerProps.width).toBe(612);
    expect(rulerProps.height).toBe(792);
  });
});
