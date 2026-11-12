import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PAGE_BOX_STYLES } from '../../components/PdfViewport/PageGeometryOverlay';
import type { PdfAnnotation } from '../../types/annotations';
import type {
  PageBox,
  PageBoxes,
  PageData,
  PdfChar,
  PdfCurve,
  PdfLine,
  PdfRect,
} from '../../types/pdf-objects';
import {
  ANNOTATION_COLORS,
  ANNOTATION_FILL_ALPHA,
  ANNOTATION_STROKE_ALPHA,
  withAlpha,
} from '../annotation-view';
import {
  CAPTURE_MAX_PIXELS,
  CAPTURE_MAX_SCALE,
  CAPTURE_MAX_SIDE,
  EMPTY_REGION_WARNING,
  ROTATED_ANNOTATIONS_WARNING,
  ROTATED_OBJECTS_WARNING,
  capturePage,
  capturePageSvg,
  decodeBase64,
  escapeXmlAttribute,
  escapeXmlText,
  normalizeRotation,
  resolveCaptureScale,
  resolveRegionCrop,
  selectCaptureAnnotations,
  type CaptureCanvasLike,
  type CaptureDocumentLike,
  type CaptureOptions,
  type CapturePageLike,
  type CaptureViewport,
  type CapturedImage,
} from '../export-capture';
import { OVERLAY_COLORS } from '../overlay-style';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

const BOX = (x0: number, y0: number, x1: number, y1: number): PageBox => ({ x0, y0, x1, y1 });

interface FakeViewportParams {
  viewBox: number[];
  scale: number;
  rotation: number;
  userUnit: number;
  offsetX?: number;
  offsetY?: number;
  dontFlip?: boolean;
}

/**
 * `PageViewport`-shaped test double using the same rotation matrices PDF.js
 * builds. `createMediaViewport` reads the constructor, scale and rotation back
 * off the base viewport, so the fake has to behave like the real class.
 */
class FakePageViewport implements CaptureViewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly rotation: number;
  readonly transform: number[];
  readonly viewBox: number[];

  constructor(params: FakeViewportParams) {
    const { viewBox } = params;
    const rotation = ((Math.round(params.rotation) % 360) + 360) % 360;
    const scale = params.scale * (params.userUnit || 1);
    const offsetX = params.offsetX ?? 0;
    const offsetY = params.offsetY ?? 0;
    const centerX = (viewBox[2] + viewBox[0]) / 2;
    const centerY = (viewBox[3] + viewBox[1]) / 2;

    let rotateA: number;
    let rotateB: number;
    let rotateC: number;
    let rotateD: number;
    switch (rotation) {
      case 90:
        rotateA = 0;
        rotateB = 1;
        rotateC = 1;
        rotateD = 0;
        break;
      case 180:
        rotateA = -1;
        rotateB = 0;
        rotateC = 0;
        rotateD = 1;
        break;
      case 270:
        rotateA = 0;
        rotateB = -1;
        rotateC = -1;
        rotateD = 0;
        break;
      default:
        rotateA = 1;
        rotateB = 0;
        rotateC = 0;
        rotateD = -1;
        break;
    }

    let offsetCanvasX: number;
    let offsetCanvasY: number;
    if (rotateA === 0) {
      offsetCanvasX = Math.abs(centerY - viewBox[1]) * scale + offsetX;
      offsetCanvasY = Math.abs(centerX - viewBox[0]) * scale + offsetY;
      this.width = Math.abs(viewBox[3] - viewBox[1]) * scale;
      this.height = Math.abs(viewBox[2] - viewBox[0]) * scale;
    } else {
      offsetCanvasX = Math.abs(centerX - viewBox[0]) * scale + offsetX;
      offsetCanvasY = Math.abs(centerY - viewBox[1]) * scale + offsetY;
      this.width = Math.abs(viewBox[2] - viewBox[0]) * scale;
      this.height = Math.abs(viewBox[3] - viewBox[1]) * scale;
    }

    this.scale = params.scale;
    this.rotation = rotation;
    this.viewBox = viewBox;
    this.transform = [
      rotateA * scale,
      rotateB * scale,
      rotateC * scale,
      rotateD * scale,
      offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
      offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
    ];
  }

  convertToViewportPoint(x: number, y: number): number[] {
    const [a, b, c, d, e, f] = this.transform;
    return [x * a + y * c + e, x * b + y * d + f];
  }
}

interface DrawCall {
  op: string;
  args: unknown[];
  alpha: number;
  lineWidth: number;
  strokeStyle: string;
  fillStyle: string;
  dash: number[];
}

const createFakeContext = () => {
  const calls: DrawCall[] = [];
  const snapshot = (op: string, args: unknown[]): DrawCall => ({
    op,
    args,
    alpha: ctx.globalAlpha,
    lineWidth: ctx.lineWidth,
    strokeStyle: String(ctx.strokeStyle),
    fillStyle: String(ctx.fillStyle),
    dash: [...ctx.dash],
  });

  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push(snapshot(op, args));
    };

  const ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    dash: [] as number[],
    calls,
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fillText: record('fillText'),
    setLineDash: (segments: number[]): void => {
      ctx.dash = [...segments];
      calls.push(snapshot('setLineDash', [segments]));
    },
    drawImage: (...args: unknown[]): void => {
      calls.push(snapshot('drawImage', args));
    },
  };

  return ctx;
};

type FakeContext = ReturnType<typeof createFakeContext>;

interface FakeCanvas extends CaptureCanvasLike {
  context: FakeContext;
  getContext: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
}

const createFakeCanvas = (dataUrl: () => string = () => PNG_DATA_URL): FakeCanvas => {
  const context = createFakeContext();
  const canvas = {
    width: 0,
    height: 0,
    context,
    getContext: vi.fn(() => context as unknown as CanvasRenderingContext2D),
    toDataURL: vi.fn((_type?: string) => dataUrl()),
  };
  return canvas as unknown as FakeCanvas;
};

const createCanvasFactory = () => {
  const canvases: FakeCanvas[] = [];
  return {
    canvases,
    createCanvas: (): CaptureCanvasLike => {
      const canvas = createFakeCanvas();
      canvases.push(canvas);
      return canvas;
    },
  };
};

const createPage = (
  options: { viewBox?: number[]; rotation?: number; renderFailure?: Error } = {},
) => {
  const viewBox = options.viewBox ?? [0, 0, PAGE_WIDTH, PAGE_HEIGHT];
  const rotation = options.rotation ?? 0;
  const render = vi.fn(() => ({
    promise: options.renderFailure
      ? Promise.reject(options.renderFailure)
      : Promise.resolve(),
  }));

  const page: CapturePageLike = {
    getViewport: ({ scale }) => new FakePageViewport({ viewBox, scale, rotation, userUnit: 1 }),
    render,
  };
  return { page, render };
};

const createDocument = (page: CapturePageLike): CaptureDocumentLike => ({
  getPage: async () => page,
});

const pageData = (overrides: Partial<PageData> = {}): PageData => ({
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
  ...overrides,
});

const NO_OVERLAYS = { objects: false, annotations: false, pageBoxes: false } as const;

const baseOptions = (overrides: Partial<CaptureOptions> = {}): CaptureOptions => ({
  scale: 1,
  region: null,
  overlays: { ...NO_OVERLAYS },
  ...overrides,
});

const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'a1',
  page: 1,
  subtype: 'Link',
  kind: 'link',
  rect: BOX(100, 100, 200, 150),
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
  ...overrides,
});

const charObject: PdfChar = {
  type: 'char',
  page: 1,
  x0: 10,
  y0: 20,
  x1: 30,
  y1: 40,
  text: 'A',
  fontname: 'Helvetica',
  size: 12,
  color: '#000000',
};

const rectObject: PdfRect = {
  type: 'rect',
  page: 1,
  x0: 40,
  y0: 50,
  x1: 80,
  y1: 90,
  fill: true,
  stroke: true,
  color: '#000000',
  width: 1,
};

const lineObject: PdfLine = {
  type: 'line',
  page: 1,
  x0: 0,
  y0: 0,
  x1: 100,
  y1: 100,
  stroke: true,
  color: '#000000',
  width: 1,
};

const curveObject: PdfCurve = {
  type: 'curve',
  page: 1,
  x0: 0,
  y0: 0,
  x1: 20,
  y1: 10,
  points: [
    [0, 0],
    [10, 10],
    [20, 5],
  ],
  stroke: true,
};

const boxes: PageBoxes = {
  media: BOX(0, 0, PAGE_WIDTH, PAGE_HEIGHT),
  crop: BOX(10, 20, 110, 120),
  trim: null,
  bleed: BOX(20, 30, 90, 100),
  art: null,
};

describe('capture API types', () => {
  it('accepts the concrete PDFDocumentProxy structurally', () => {
    // The real PDF.js document must stay assignable, so K2 does not need a cast.
    expectTypeOf<PDFDocumentProxy>().toMatchTypeOf<CaptureDocumentLike>();
  });
});

describe('normalizeRotation', () => {
  it('wraps rotations into 0/90/180/270', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});

describe('resolveCaptureScale', () => {
  it('clamps the requested multiplier to 1..3', () => {
    expect(resolveCaptureScale(2.5, PAGE_WIDTH, PAGE_HEIGHT)).toEqual({
      scale: 2.5,
      width: 1530,
      height: 1980,
    });
    expect(resolveCaptureScale(10, PAGE_WIDTH, PAGE_HEIGHT).scale).toBe(CAPTURE_MAX_SCALE);
    expect(resolveCaptureScale(0.2, PAGE_WIDTH, PAGE_HEIGHT).scale).toBe(1);
    expect(resolveCaptureScale(Number.NaN, PAGE_WIDTH, PAGE_HEIGHT).scale).toBe(1);
  });

  it('shrinks the scale to the maximum side', () => {
    const resolved = resolveCaptureScale(3, 5000, 1000);

    expect(resolved.scale).toBeLessThan(3);
    expect(resolved.width).toBeLessThanOrEqual(CAPTURE_MAX_SIDE);
    expect(resolved.height).toBeLessThanOrEqual(CAPTURE_MAX_SIDE);
    expect(resolved.width).toBeLessThan(CAPTURE_MAX_SIDE + 1);
  });

  it('shrinks the scale to the total pixel budget', () => {
    const resolved = resolveCaptureScale(3, 4000, 4000);

    expect(resolved.scale).toBeLessThan(1.5);
    expect(resolved.width * resolved.height).toBeLessThanOrEqual(CAPTURE_MAX_PIXELS);
    expect(resolved.width).toBeGreaterThan(5500);
  });

  it('rejects pages that already exceed the caps at 1x', () => {
    expect(() => resolveCaptureScale(1, 9000, 100)).toThrow(/too large to export at 1x/);
    expect(() => resolveCaptureScale(1, 6000, 6000)).toThrow(/too large to export at 1x/);
  });

  it('rejects pages without a usable size', () => {
    expect(() => resolveCaptureScale(1, 0, 792)).toThrow(/Page size is unavailable/);
    expect(() => resolveCaptureScale(1, Number.NaN, 792)).toThrow(/Page size is unavailable/);
  });
});

describe('capturePage rendering', () => {
  it('renders the full page at the requested scale and encodes a PNG', async () => {
    const { page, render } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    const image = await capturePage(
      createDocument(page),
      1,
      pageData(),
      [],
      baseOptions({ scale: 2 }),
      createCanvas,
    );

    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(1224);
    expect(canvases[0].height).toBe(1584);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        viewport: expect.objectContaining({ width: 1224, height: 1584 }),
      }),
    );

    expect(image.width).toBe(1224);
    expect(image.height).toBe(1584);
    expect(image.appliedScale).toBe(2);
    expect(image.cropped).toBe(false);
    expect(image.warnings).toEqual([]);
    expect(image.pngDataUrl).toBe(PNG_DATA_URL);
    expect(image.blob.type).toBe('image/png');
    expect(image.blob.size).toBe(8);
    // No overlays were requested, so nothing was painted over the page.
    expect(canvases[0].context.calls).toHaveLength(0);
  });

  it('caps the scale for an oversized page and reports the applied scale', async () => {
    const { page } = createPage({ viewBox: [0, 0, 5000, 5000] });
    const { canvases, createCanvas } = createCanvasFactory();

    const image = await capturePage(
      createDocument(page),
      1,
      pageData({ width: 5000, height: 5000 }),
      [],
      baseOptions({ scale: 3 }),
      createCanvas,
    );

    expect(image.appliedScale).toBeLessThan(3);
    expect(canvases[0].width).toBeLessThanOrEqual(CAPTURE_MAX_SIDE);
    expect(canvases[0].height).toBeLessThanOrEqual(CAPTURE_MAX_SIDE);
    expect(image.width * image.height).toBeLessThanOrEqual(CAPTURE_MAX_PIXELS);
  });

  it('wraps a page load failure in a readable error', async () => {
    const failingDocument: CaptureDocumentLike = {
      getPage: async () => {
        throw new Error('missing page');
      },
    };
    const { createCanvas } = createCanvasFactory();

    await expect(
      capturePage(failingDocument, 3, pageData(), [], baseOptions(), createCanvas),
    ).rejects.toThrow('Could not load page 3 for export: missing page');
  });

  it('wraps a render failure in a readable error', async () => {
    const { page } = createPage({ renderFailure: new Error('boom') });
    const { createCanvas } = createCanvasFactory();

    await expect(
      capturePage(createDocument(page), 2, pageData(), [], baseOptions(), createCanvas),
    ).rejects.toThrow('Could not render page 2 for export: boom');
  });
});

describe('capturePage region cropping', () => {
  it('crops the rendered canvas to the MediaBox-relative region', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    const image = await capturePage(
      createDocument(page),
      1,
      pageData(),
      [],
      baseOptions({ region: BOX(100, 200, 300, 400) }),
      createCanvas,
    );

    expect(canvases).toHaveLength(2);
    const cropCanvas = canvases[1];
    expect(cropCanvas.width).toBe(200);
    expect(cropCanvas.height).toBe(200);

    const drawCall = cropCanvas.context.calls.find((call) => call.op === 'drawImage');
    expect(drawCall).toBeDefined();
    // y is flipped: PDF y1=400 -> canvas y=392, PDF y0=200 -> 592.
    expect(drawCall?.args).toEqual([canvases[0], 100, 392, 200, 200, 0, 0, 200, 200]);

    expect(image.width).toBe(200);
    expect(image.height).toBe(200);
    expect(image.cropped).toBe(true);
    expect(image.warnings).toEqual([]);
    expect(cropCanvas.toDataURL).toHaveBeenCalledWith('image/png');
    expect(image.frame).toMatchObject({ offsetX: 100, offsetY: 392, canvasWidth: 612 });
  });

  it('draws overlays before cropping, so they stay at page coordinates', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject] }),
      [],
      baseOptions({
        region: BOX(100, 200, 300, 400),
        overlays: { objects: true, annotations: false, pageBoxes: false },
      }),
      createCanvas,
    );

    const boxStrokes = canvases[0].context.calls.filter(
      (call) => call.op === 'strokeRect' && call.strokeStyle === OVERLAY_COLORS.char,
    );
    expect(boxStrokes).toHaveLength(1);
    expect(boxStrokes[0].args).toEqual([10, 752, 20, 20]);
  });

  it.each<[string, PageBox]>([
    ['degenerate', BOX(100, 100, 100, 200)],
    ['inverted', BOX(300, 400, 200, 300)],
    ['non-finite', BOX(Number.NaN, 0, 100, 100)],
    ['off-canvas', BOX(2000, 0, 2100, 100)],
  ])('falls back to the full page for a %s region', async (_label, region) => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    const image = await capturePage(
      createDocument(page),
      1,
      pageData(),
      [],
      baseOptions({ region }),
      createCanvas,
    );

    expect(canvases).toHaveLength(1);
    expect(image.width).toBe(PAGE_WIDTH);
    expect(image.height).toBe(PAGE_HEIGHT);
    expect(image.cropped).toBe(false);
    expect(image.warnings).toContain(EMPTY_REGION_WARNING);
  });

  it('maps a region through the MediaBox origin', () => {
    const viewport = new FakePageViewport({
      viewBox: [10, 20, 622, 812],
      scale: 1,
      rotation: 0,
      userUnit: 1,
    });

    const crop = resolveRegionCrop(BOX(0, 0, 100, 100), viewport, { x: 10, y: 20 }, 612, 792);

    expect(crop).toEqual({ x: 0, y: 692, width: 100, height: 100 });
  });

  it('maps a region on a rotated page through the viewport', () => {
    const viewport = new FakePageViewport({
      viewBox: [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
      scale: 1,
      rotation: 90,
      userUnit: 1,
    });

    const crop = resolveRegionCrop(BOX(100, 200, 300, 400), viewport, { x: 0, y: 0 }, 792, 612);

    expect(crop).toEqual({ x: 200, y: 100, width: 200, height: 200 });
  });
});

describe('capturePage object overlays', () => {
  it('draws only the requested object types', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject], rects: [rectObject], lines: [lineObject], curves: [curveObject] }),
      [],
      baseOptions({
        overlays: { objects: true, annotations: false, pageBoxes: false },
        objectTypes: ['rect'],
      }),
      createCanvas,
    );

    const calls = canvases[0].context.calls;
    const strokes = calls.filter((call) => call.op === 'strokeRect');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].strokeStyle).toBe(OVERLAY_COLORS.rect);
    expect(calls.some((call) => call.strokeStyle === OVERLAY_COLORS.char)).toBe(false);
    expect(calls.some((call) => call.strokeStyle === OVERLAY_COLORS.line)).toBe(false);
    expect(calls.some((call) => call.strokeStyle === OVERLAY_COLORS.curve)).toBe(false);
  });

  it('draws every type by default with the bottom-left mapping and layer opacity', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject], rects: [rectObject], lines: [lineObject], curves: [curveObject] }),
      [],
      baseOptions({
        overlays: { objects: true, annotations: false, pageBoxes: false },
        overlayOpacity: 0.5,
      }),
      createCanvas,
    );

    const calls = canvases[0].context.calls;
    const boxStrokes = calls.filter((call) => call.op === 'strokeRect');
    expect(boxStrokes).toHaveLength(2);

    const charStroke = boxStrokes.find((call) => call.strokeStyle === OVERLAY_COLORS.char);
    expect(charStroke?.args).toEqual([10, 752, 20, 20]);
    expect(charStroke?.alpha).toBeCloseTo(0.5);
    expect(charStroke?.lineWidth).toBe(1);

    const rectStroke = boxStrokes.find((call) => call.strokeStyle === OVERLAY_COLORS.rect);
    expect(rectStroke?.args).toEqual([40, 702, 40, 40]);

    const lineMoves = calls.filter(
      (call) => call.op === 'moveTo' && call.strokeStyle === OVERLAY_COLORS.line,
    );
    expect(lineMoves.map((call) => call.args)).toEqual([[0, 792]]);

    const curvePoints = calls.filter(
      (call) =>
        (call.op === 'moveTo' || call.op === 'lineTo') &&
        call.strokeStyle === OVERLAY_COLORS.curve,
    );
    expect(curvePoints.map((call) => call.args)).toEqual([
      [0, 792],
      [10, 782],
      [20, 787],
    ]);

    const lineStrokes = calls.filter(
      (call) => call.op === 'stroke' && call.strokeStyle === OVERLAY_COLORS.line,
    );
    expect(lineStrokes).toHaveLength(1);
    expect(lineStrokes[0].alpha).toBeCloseTo(0.5);
    // The context is left neutral for the next drawing pass.
    expect(canvases[0].context.globalAlpha).toBe(1);
  });

  it('clamps the overlay opacity and supports an empty type list', async () => {
    const { page } = createPage();
    const first = createCanvasFactory();
    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject] }),
      [],
      baseOptions({
        overlays: { objects: true, annotations: false, pageBoxes: false },
        overlayOpacity: 5,
      }),
      first.createCanvas,
    );
    expect(
      first.canvases[0].context.calls.find((call) => call.op === 'strokeRect')?.alpha,
    ).toBe(1);

    const second = createCanvasFactory();
    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject] }),
      [],
      baseOptions({
        overlays: { objects: true, annotations: false, pageBoxes: false },
        overlayOpacity: -3,
      }),
      second.createCanvas,
    );
    expect(
      second.canvases[0].context.calls.find((call) => call.op === 'strokeRect')?.alpha,
    ).toBe(0);

    const third = createCanvasFactory();
    await capturePage(
      createDocument(page),
      1,
      pageData({ chars: [charObject] }),
      [],
      baseOptions({
        overlays: { objects: true, annotations: false, pageBoxes: false },
        objectTypes: [],
      }),
      third.createCanvas,
    );
    expect(third.canvases[0].context.calls).toHaveLength(0);
  });
});

describe('capturePage annotation overlays', () => {
  it('composites only visible, accessible annotations for the page', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();
    const annotations = [
      annotation({ id: 'visible' }),
      annotation({ id: 'other-page', page: 2 }),
      annotation({ id: 'hidden', hidden: true }),
      annotation({ id: 'no-rect', rect: null }),
      annotation({ id: 'degenerate', rect: BOX(10, 10, 10, 40) }),
    ];

    await capturePage(
      createDocument(page),
      1,
      pageData(),
      annotations,
      baseOptions({ overlays: { objects: false, annotations: true, pageBoxes: false } }),
      createCanvas,
    );

    expect(canvases).toHaveLength(2);
    const scratchCalls = canvases[1].context.calls;

    const strokes = scratchCalls.filter((call) => call.op === 'strokeRect');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].strokeStyle).toBe(
      withAlpha(ANNOTATION_COLORS.link, ANNOTATION_STROKE_ALPHA),
    );
    expect(strokes[0].lineWidth).toBe(1);
    expect(scratchCalls.filter((call) => call.op === 'fillRect')).toHaveLength(1);
    expect(
      scratchCalls.filter((call) => call.op === 'fillRect')[0].fillStyle,
    ).toBe(withAlpha(ANNOTATION_COLORS.link, ANNOTATION_FILL_ALPHA));
    // Labels stay off in an export.
    expect(scratchCalls.filter((call) => call.op === 'fillText')).toHaveLength(0);

    const baseCalls = canvases[0].context.calls;
    expect(baseCalls.filter((call) => call.op === 'drawImage')).toHaveLength(1);
    // The scratch overlay must not erase the rendered page.
    expect(baseCalls.some((call) => call.op === 'clearRect')).toBe(false);
  });

  it('selects annotations by page, visibility and usable geometry', () => {
    const selected = selectCaptureAnnotations(
      [
        annotation({ id: 'ok' }),
        annotation({ id: 'page-2', page: 2 }),
        annotation({ id: 'hidden', hidden: true }),
        annotation({ id: 'null', rect: null }),
      ],
      1,
      PAGE_WIDTH,
      PAGE_HEIGHT,
    );

    expect(selected.map((item) => item.id)).toEqual(['ok']);
    expect(
      selectCaptureAnnotations([annotation({ id: 'page-2', page: 2 })], null, 612, 792).map(
        (item) => item.id,
      ),
    ).toEqual(['page-2']);
  });
});

describe('capturePage page boxes', () => {
  it('draws every defined box with its style and dash pattern', async () => {
    const { page } = createPage();
    const { canvases, createCanvas } = createCanvasFactory();

    await capturePage(
      createDocument(page),
      1,
      pageData({ boxes }),
      [],
      baseOptions({ overlays: { objects: false, annotations: false, pageBoxes: true } }),
      createCanvas,
    );

    const calls = canvases[0].context.calls;
    const strokes = calls.filter((call) => call.op === 'strokeRect');
    expect(strokes.map((call) => call.strokeStyle)).toEqual([
      PAGE_BOX_STYLES.media.color,
      PAGE_BOX_STYLES.crop.color,
      PAGE_BOX_STYLES.bleed.color,
    ]);
    expect(strokes[0].args).toEqual([0, 0, PAGE_WIDTH, PAGE_HEIGHT]);
    expect(strokes[1].args).toEqual([10, PAGE_HEIGHT - 120, 100, 100]);
    for (const stroke of strokes) {
      expect(stroke.alpha).toBe(0.95);
      expect(stroke.lineWidth).toBe(1);
    }

    const dashes = calls
      .filter((call) => call.op === 'setLineDash')
      .map((call) => call.args[0]);
    expect(dashes.slice(0, 3)).toEqual([
      PAGE_BOX_STYLES.media.dash,
      PAGE_BOX_STYLES.crop.dash,
      PAGE_BOX_STYLES.bleed.dash,
    ]);
    // The final reset keeps the next drawing pass undashed.
    expect(dashes.at(-1)).toEqual([]);
  });
});

describe('capturePage rotated pages', () => {
  it('skips object and annotation boxes but still draws the page and page boxes', async () => {
    const { page } = createPage({ rotation: 90 });
    const { canvases, createCanvas } = createCanvasFactory();
    const annotations = [annotation({ id: 'a1' })];

    const image = await capturePage(
      createDocument(page),
      1,
      pageData({ boxes, chars: [charObject] }),
      annotations,
      baseOptions({
        overlays: { objects: true, annotations: true, pageBoxes: true },
      }),
      createCanvas,
    );

    expect(canvases).toHaveLength(1);
    expect(image.width).toBe(PAGE_HEIGHT);
    expect(image.height).toBe(PAGE_WIDTH);
    expect(image.warnings).toContain(ROTATED_OBJECTS_WARNING);
    expect(image.warnings).toContain(ROTATED_ANNOTATIONS_WARNING);

    const calls = canvases[0].context.calls;
    expect(calls.some((call) => call.strokeStyle === OVERLAY_COLORS.char)).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.strokeStyle === withAlpha(ANNOTATION_COLORS.link, ANNOTATION_STROKE_ALPHA),
      ),
    ).toBe(false);

    const boxStrokes = calls.filter((call) => call.op === 'strokeRect');
    expect(boxStrokes.map((call) => call.strokeStyle)).toEqual([
      PAGE_BOX_STYLES.media.color,
      PAGE_BOX_STYLES.crop.color,
      PAGE_BOX_STYLES.bleed.color,
    ]);
    // The MediaBox fills the rotated canvas.
    expect(boxStrokes[0].args).toEqual([0, 0, PAGE_HEIGHT, PAGE_WIDTH]);
  });
});

describe('capturePage failure paths', () => {
  const failingDocument = (): CaptureDocumentLike => createDocument(createPage().page);

  it('rejects when the canvas cannot provide a 2D context', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null,
      toDataURL: () => PNG_DATA_URL,
    } as unknown as CaptureCanvasLike;

    await expect(
      capturePage(failingDocument(), 1, pageData(), [], baseOptions(), () => canvas),
    ).rejects.toThrow(/2D canvas context/);
  });

  it('rejects when toDataURL is missing', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => createFakeContext() as unknown as CanvasRenderingContext2D,
    } as unknown as CaptureCanvasLike;

    await expect(
      capturePage(failingDocument(), 1, pageData(), [], baseOptions(), () => canvas),
    ).rejects.toThrow(/toDataURL is unavailable/);
  });

  it('rejects when toDataURL throws', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => createFakeContext() as unknown as CanvasRenderingContext2D,
      toDataURL: () => {
        throw new Error('tainted');
      },
    } as unknown as CaptureCanvasLike;

    await expect(
      capturePage(failingDocument(), 1, pageData(), [], baseOptions(), () => canvas),
    ).rejects.toThrow(/Could not encode the exported page as PNG: tainted/);
  });

  it('rejects when the canvas does not return PNG data', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => createFakeContext() as unknown as CanvasRenderingContext2D,
      toDataURL: () => 'data:text/plain;base64,AA==',
    } as unknown as CaptureCanvasLike;

    await expect(
      capturePage(failingDocument(), 1, pageData(), [], baseOptions(), () => canvas),
    ).rejects.toThrow(/did not return PNG data/);
  });
});

describe('capturePageSvg', () => {
  const svgOptions = (): CaptureOptions => ({
    scale: 1,
    region: null,
    overlays: { objects: true, annotations: true, pageBoxes: true },
  });

  const captureForSvg = async () => {
    const { page } = createPage();
    const { createCanvas } = createCanvasFactory();
    const annotations = [
      annotation({ id: 'a1', title: '<img src=x onerror=alert(1)>' }),
    ];
    const data = pageData({ chars: [charObject], curves: [curveObject], boxes });
    const image = await capturePage(
      createDocument(page),
      1,
      data,
      annotations,
      svgOptions(),
      createCanvas,
    );
    return { image, data, annotations };
  };

  it('builds a self-contained SVG with the PNG base and vector overlays', async () => {
    const { image, data, annotations } = await captureForSvg();

    const svg = capturePageSvg(image, data, annotations, svgOptions());

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">')).toBe(true);
    expect(svg).toContain('<image href="data:image/png;base64,');
    expect(svg).not.toContain('<script');
    expect(svg).toContain('data-layer="objects"');
    expect(svg).toContain('data-layer="annotations"');
    expect(svg).toContain('data-layer="page-boxes"');
    expect(svg).toContain('<polyline points="0,792 10,782 20,787"');
    expect(svg).toContain('<title>MediaBox</title>');
    expect(svg).toContain('<title>CropBox</title>');
    // Annotation titles are escaped text, never markup or handlers.
    expect(svg).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('x="100" y="642" width="100" height="50"');
  });

  it('keeps overlays aligned with a cropped image', async () => {
    const { page } = createPage();
    const { createCanvas } = createCanvasFactory();
    const data = pageData({
      chars: [{ ...charObject, x0: 110, y0: 210, x1: 130, y1: 230 }],
    });
    const options = baseOptions({
      region: BOX(100, 200, 300, 400),
      overlays: { objects: true, annotations: false, pageBoxes: false },
    });

    const image = await capturePage(createDocument(page), 1, data, [], options, createCanvas);
    const svg = capturePageSvg(image, data, [], options);

    expect(image.width).toBe(200);
    expect(svg).toContain('width="200" height="200"');
    // Full-page rect (110, 562)–(130, 582) shifted by the crop origin (100, 392).
    expect(svg).toContain('x="10" y="170" width="20" height="20"');
  });

  it('supports a hand-built captured image without a frame', () => {
    const synthetic: CapturedImage = {
      blob: new Blob([], { type: 'image/png' }),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      pngDataUrl: PNG_DATA_URL,
      appliedScale: 1,
      cropped: false,
      warnings: [],
    };
    const data = pageData({ chars: [charObject] });

    const svg = capturePageSvg(synthetic, data, [], {
      scale: 1,
      region: null,
      overlays: { objects: true, annotations: false, pageBoxes: false },
    });

    expect(svg).toContain('<image href="data:image/png;base64,');
    expect(svg).toContain('x="10" y="752" width="20" height="20"');
  });

  it('omits rotated object/annotation overlays and records the warnings', async () => {
    const { page } = createPage({ rotation: 90 });
    const { createCanvas } = createCanvasFactory();
    const data = pageData({ boxes, chars: [charObject] });
    const annotations = [annotation()];
    const options = svgOptions();

    const image = await capturePage(
      createDocument(page),
      1,
      data,
      annotations,
      options,
      createCanvas,
    );
    const svg = capturePageSvg(image, data, annotations, options);

    expect(svg).not.toContain('data-layer="objects"');
    expect(svg).not.toContain('data-layer="annotations"');
    expect(svg).toContain('data-layer="page-boxes"');
    expect(svg).toContain('<desc>');
    expect(svg).toContain(ROTATED_OBJECTS_WARNING);
  });

  it('rejects missing or non-PNG image data', () => {
    const synthetic: CapturedImage = {
      blob: new Blob([], { type: 'image/png' }),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      pngDataUrl: 'data:,x',
      appliedScale: 1,
      cropped: false,
      warnings: [],
    };

    expect(() =>
      capturePageSvg(synthetic, pageData(), [], baseOptions()),
    ).toThrow(/PNG data URL/);
  });
});

describe('encoding helpers', () => {
  it('decodes base64 PNG bytes', () => {
    expect(Array.from(decodeBase64('iVBORw0KGgo='))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('escapes XML text and attributes', () => {
    expect(escapeXmlText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    expect(escapeXmlAttribute('a"b\'c&<>')).toBe('a&quot;b&apos;c&amp;&lt;&gt;');
  });
});
