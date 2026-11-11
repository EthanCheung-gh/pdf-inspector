import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  ANNOTATION_INDEX_BATCH_SIZE,
  buildAnnotationIndex,
  type AnnotationIndexResult,
} from '../annotation-index';

const DEFAULT_VIEW = [0, 0, 600, 800];

/** Fake PDF.js object reference used inside explicit destinations. */
const ref = (num: number) => ({ num, gen: 0 });

interface PageSpec {
  /** `page.view`; defaults to DEFAULT_VIEW. */
  view?: number[];
  annotations?: unknown[];
  /** Makes `getPage` reject for this page. */
  fail?: boolean;
}

interface FakeIndexOptions {
  pages: Record<number, PageSpec>;
  destinations?: Partial<Record<string, unknown[] | null>>;
  pageIndices?: Partial<Record<number, number>>;
}

/**
 * Fake `PDFDocumentProxy` for the index: only the members the loader and the
 * destination resolver use, with every `getPage` call recorded in order.
 */
function createFakeDocument(options: FakeIndexOptions) {
  const calls: number[] = [];
  const destinations = options.destinations ?? {};
  const pageIndices = options.pageIndices ?? {};

  const getPage = vi.fn(async (pageNumber: number) => {
    calls.push(pageNumber);
    const spec = options.pages[pageNumber];
    if (spec === undefined) throw new Error(`no page ${pageNumber}`);
    if (spec.fail === true) throw new Error(`page ${pageNumber} could not be read`);
    return {
      view: spec.view ?? DEFAULT_VIEW,
      getAnnotations: async () => spec.annotations ?? [],
    };
  });

  const getDestination = vi.fn(async (name: string) =>
    Object.prototype.hasOwnProperty.call(destinations, name) ? destinations[name] : null,
  );
  const getPageIndex = vi.fn(async (refProxy: { num?: number }) => {
    const num = typeof refProxy?.num === 'number' ? refProxy.num : -1;
    const index = pageIndices[num];
    if (index === undefined) throw new Error(`unknown reference ${num}`);
    return index;
  });

  return {
    doc: { getPage, getDestination, getPageIndex } as unknown as PDFDocumentProxy,
    getPage,
    calls,
  };
}

/** Three pages covering every kind the summary counts. */
const mixedPages: Record<number, PageSpec> = {
  1: {
    annotations: [
      { subtype: 'Link', id: 'ext', rect: [10, 10, 110, 40], url: 'https://example.com/a' },
      {
        subtype: 'Widget',
        id: 'name',
        rect: [10, 50, 210, 80],
        fieldName: 'full_name',
        fieldType: 'Tx',
        fieldValue: 'Ada',
        required: true,
      },
    ],
  },
  2: {
    annotations: [
      { subtype: 'Highlight', id: 'hl', rect: [0, 0, 10, 10], color: [1, 1, 0] },
      {
        subtype: 'Widget',
        id: 'agree',
        rect: [10, 10, 40, 40],
        fieldName: 'agree',
        fieldType: 'Btn',
        checkBox: true,
        fieldValue: 'Yes',
      },
    ],
  },
  3: {
    annotations: [{ subtype: 'Text', id: 'note', rect: [0, 0, 5, 5], contents: 'Review' }],
  },
};

const ZERO_SUMMARY = {
  annotations: 0,
  pagesWithAnnotations: 0,
  links: 0,
  forms: 0,
  markup: 0,
  notes: 0,
  stamps: 0,
  other: 0,
  hidden: 0,
  unresolvedLinks: 0,
  unsafeLinks: 0,
  formFields: 0,
};

/** Narrow a nullable result so the assertions stay readable. */
function expectResult(result: AnnotationIndexResult | null): AnnotationIndexResult {
  expect(result).not.toBeNull();
  return result as AnnotationIndexResult;
}

describe('buildAnnotationIndex', () => {
  it('indexes every page in document order and summarizes it once', async () => {
    const fake = createFakeDocument({ pages: mixedPages });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 3));

    expect(fake.calls).toEqual([1, 2, 3]);
    expect(result.annotations.map((annotation) => annotation.id)).toEqual([
      '1:ext',
      '1:name',
      '2:hl',
      '2:agree',
      '3:note',
    ]);
    expect(result.annotations.map((annotation) => annotation.page)).toEqual([1, 1, 2, 2, 3]);
    expect(result.scannedPages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.summary).toEqual({
      annotations: 5,
      pagesWithAnnotations: 3,
      links: 1,
      forms: 2,
      markup: 1,
      notes: 1,
      stamps: 0,
      other: 0,
      hidden: 0,
      unresolvedLinks: 0,
      unsafeLinks: 0,
      formFields: 2,
    });
    expect(result.linkIssues).toHaveLength(1);
    expect(result.linkIssues[0]).toMatchObject({
      annotationId: '1:ext',
      page: 1,
      subtype: 'Link',
      kind: 'external',
      target: 'https://example.com/a',
    });
    expect(result.formIssues).toEqual([]);
    expect(result.formFields).toEqual([
      {
        name: 'full_name',
        fieldType: 'Tx',
        pages: [1],
        widgetCount: 1,
        required: true,
        readOnly: false,
        values: ['Ada'],
      },
      {
        name: 'agree',
        fieldType: 'Btn',
        pages: [2],
        widgetCount: 1,
        required: false,
        readOnly: false,
        values: ['Yes'],
      },
    ]);
  });

  it('reports progress from zero to the page total', async () => {
    const fake = createFakeDocument({ pages: mixedPages });
    const progress: Array<[number, number]> = [];

    await buildAnnotationIndex(fake.doc, 3, {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('reads pages sequentially in batches and yields between batches', async () => {
    const pages: Record<number, PageSpec> = {};
    for (let page = 1; page <= 5; page += 1) {
      pages[page] = { annotations: [{ subtype: 'Text', id: `n${page}`, rect: [0, 0, 1, 1] }] };
    }
    const fake = createFakeDocument({ pages });

    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout);

    let result: AnnotationIndexResult | null = null;
    try {
      result = await buildAnnotationIndex(fake.doc, 5, { batchSize: 2 });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(fake.calls).toEqual([1, 2, 3, 4, 5]);
    expect(expectResult(result).annotations.map((annotation) => annotation.page)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // 2 pages per batch over 5 pages: two batch boundaries, no trailing yield.
    expect(delays.filter((delay) => delay === 0)).toHaveLength(2);
  });

  it('falls back to the default batch size for invalid options', async () => {
    const pages: Record<number, PageSpec> = {};
    for (let page = 1; page <= 3; page += 1) pages[page] = {};

    const fake = createFakeDocument({ pages });
    const result = expectResult(await buildAnnotationIndex(fake.doc, 3, { batchSize: 0 }));

    expect(ANNOTATION_INDEX_BATCH_SIZE).toBe(10);
    expect(result.scannedPages).toBe(3);
    expect(fake.calls).toEqual([1, 2, 3]);
  });

  it('returns null and stops early when cancelled mid-index', async () => {
    const pages: Record<number, PageSpec> = {};
    for (let page = 1; page <= 5; page += 1) pages[page] = {};
    const fake = createFakeDocument({ pages });

    let cancelled = false;
    const progress: number[] = [];
    const result = await buildAnnotationIndex(fake.doc, 5, {
      batchSize: 2,
      isCancelled: () => cancelled,
      onProgress: (done) => {
        progress.push(done);
        if (done === 2) cancelled = true;
      },
    });

    expect(result).toBeNull();
    expect(fake.calls).toEqual([1, 2]);
    expect(progress).toEqual([0, 1, 2]);
  });

  it('does not read any page when cancelled before starting', async () => {
    const fake = createFakeDocument({ pages: mixedPages });

    const result = await buildAnnotationIndex(fake.doc, 3, { isCancelled: () => true });

    expect(result).toBeNull();
    expect(fake.getPage).not.toHaveBeenCalled();
  });

  it('throws with the failing page number and stops the index', async () => {
    const fake = createFakeDocument({
      pages: {
        1: { annotations: [{ subtype: 'Text', id: 'n1', rect: [0, 0, 1, 1] }] },
        2: { fail: true },
        3: {},
      },
    });

    await expect(buildAnnotationIndex(fake.doc, 3)).rejects.toThrow(/page 2/);
    expect(fake.calls).toEqual([1, 2]);
  });

  it('returns an empty result for an empty or invalid page count', async () => {
    for (const pageCount of [0, Number.NaN, -4]) {
      const fake = createFakeDocument({ pages: {} });
      const progress: Array<[number, number]> = [];

      const result = await buildAnnotationIndex(fake.doc, pageCount, {
        onProgress: (done, total) => progress.push([done, total]),
      });

      expect(result).toEqual({
        annotations: [],
        summary: ZERO_SUMMARY,
        linkIssues: [],
        formIssues: [],
        formFields: [],
        scannedPages: 0,
        truncated: false,
      });
      expect(fake.getPage).not.toHaveBeenCalled();
      expect(progress).toEqual([[0, 0]]);
    }
  });

  it('clamps a fractional page count down to whole pages', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {},
        2: {},
        3: { annotations: [{ subtype: 'Text', id: 'late', rect: [0, 0, 1, 1] }] },
      },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 2.9));

    expect(fake.calls).toEqual([1, 2]);
    expect(result.scannedPages).toBe(2);
    expect(result.annotations).toEqual([]);
  });

  it('uses the page view origin so indexed rects follow the MediaBox', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          view: [100, 200, 700, 1000],
          annotations: [{ subtype: 'Highlight', id: 'hl', rect: [110, 220, 310, 420] }],
        },
      },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 1));

    expect(result.annotations[0].rect).toEqual({ x0: 10, y0: 20, x1: 210, y1: 220 });
  });
});

describe('buildAnnotationIndex link health', () => {
  it('classifies external, unsafe, unresolved and internal links', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          annotations: [
            { subtype: 'Link', id: 'ext', rect: [0, 0, 10, 10], url: 'https://example.com/x' },
            { subtype: 'Link', id: 'js', rect: [0, 0, 10, 10], url: 'javascript:alert(1)' },
            { subtype: 'Link', id: 'none', rect: [0, 0, 10, 10] },
            { subtype: 'Link', id: 'rel', rect: [0, 0, 10, 10], url: '../chapter2.html' },
            { subtype: 'Link', id: 'int', rect: [0, 0, 10, 10], dest: [ref(7), { name: 'Fit' }] },
          ],
        },
      },
      pageIndices: { 7: 2 },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 1));

    expect(result.linkIssues.map((issue) => [issue.annotationId, issue.kind, issue.target])).toEqual(
      [
        ['1:ext', 'external', 'https://example.com/x'],
        ['1:js', 'unsafe', 'javascript:alert(1)'],
        ['1:none', 'unresolved', null],
        ['1:rel', 'unresolved', '../chapter2.html'],
      ],
    );
    expect(result.summary.links).toBe(5);
    expect(result.summary.unresolvedLinks).toBe(2);
    expect(result.summary.unsafeLinks).toBe(1);
    expect(result.annotations[4].link?.internalPage).toBe(3);
  });

  it('treats a resolved internal destination as no issue at all', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          annotations: [
            { subtype: 'Link', id: 'int', rect: [0, 0, 10, 10], dest: [ref(4), { name: 'Fit' }] },
          ],
        },
      },
      pageIndices: { 4: 0 },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 1));

    expect(result.linkIssues).toEqual([]);
    expect(result.summary.unresolvedLinks).toBe(0);
    expect(result.summary.links).toBe(1);
  });
});

describe('buildAnnotationIndex form health', () => {
  it('groups fields by name and reports unnamed, duplicate and conflicting fields', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          annotations: [
            { subtype: 'Widget', id: 'anon', rect: [0, 0, 10, 10], fieldType: 'Tx' },
            {
              subtype: 'Widget',
              id: 'agree-1',
              rect: [0, 0, 10, 10],
              fieldName: 'agree',
              fieldType: 'Btn',
              required: true,
              fieldValue: 'Yes',
            },
            {
              subtype: 'Widget',
              id: 'amount-tx',
              rect: [0, 0, 10, 10],
              fieldName: 'amount',
              fieldType: 'Tx',
              fieldValue: '10',
            },
          ],
        },
        2: {
          annotations: [
            {
              subtype: 'Widget',
              id: 'agree-2',
              rect: [0, 0, 10, 10],
              fieldName: 'agree',
              fieldType: 'Btn',
              readOnly: true,
              fieldValue: ['Yes', 'No'],
            },
            {
              subtype: 'Widget',
              id: 'amount-ch',
              rect: [0, 0, 10, 10],
              fieldName: 'amount',
              fieldType: 'Ch',
              fieldValue: '20',
            },
          ],
        },
      },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 2));

    // Unnamed widgets are reported but never become a form field.
    expect(result.formFields.map((field) => field.name)).toEqual(['agree', 'amount']);
    expect(result.formFields).toEqual([
      {
        name: 'agree',
        fieldType: 'Btn',
        pages: [1, 2],
        widgetCount: 2,
        required: true,
        readOnly: true,
        values: ['Yes', 'No'],
      },
      {
        name: 'amount',
        fieldType: 'Tx',
        pages: [1, 2],
        widgetCount: 2,
        required: false,
        readOnly: false,
        values: ['10', '20'],
      },
    ]);
    expect(result.summary.forms).toBe(5);
    expect(result.summary.formFields).toBe(2);

    const byKind = (kind: string) => result.formIssues.filter((issue) => issue.kind === kind);
    expect(byKind('unnamed')).toEqual([
      {
        annotationId: '1:anon',
        fieldName: null,
        pages: [1],
        fieldTypes: ['Tx'],
        widgetCount: 1,
        kind: 'unnamed',
        message: expect.any(String),
      },
    ]);
    // Same name on several pages is information, not an error.
    expect(byKind('duplicate-name')).toEqual([
      {
        annotationId: null,
        fieldName: 'agree',
        pages: [1, 2],
        fieldTypes: ['Btn'],
        widgetCount: 2,
        kind: 'duplicate-name',
        message: expect.any(String),
      },
      {
        annotationId: null,
        fieldName: 'amount',
        pages: [1, 2],
        fieldTypes: ['Ch', 'Tx'],
        widgetCount: 2,
        kind: 'duplicate-name',
        message: expect.any(String),
      },
    ]);
    expect(byKind('conflicting-type')).toEqual([
      {
        annotationId: null,
        fieldName: 'amount',
        pages: [1, 2],
        fieldTypes: ['Ch', 'Tx'],
        widgetCount: 2,
        kind: 'conflicting-type',
        message: expect.any(String),
      },
    ]);
  });

  it('reports one unnamed issue per widget, so two on one page stay distinct', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          annotations: [
            // Both are nameless widgets on the same page: kind, field name and
            // page list are identical, only the widget itself tells them apart.
            { subtype: 'Widget', id: 'anon-a', rect: [0, 0, 10, 10], fieldType: 'Tx' },
            { subtype: 'Widget', id: 'anon-b', rect: [20, 20, 30, 30] },
          ],
        },
      },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 1));

    const unnamed = result.formIssues.filter((issue) => issue.kind === 'unnamed');
    expect(unnamed.map((issue) => issue.annotationId)).toEqual(['1:anon-a', '1:anon-b']);
    expect(unnamed.map((issue) => issue.pages)).toEqual([[1], [1]]);
    expect(unnamed.map((issue) => issue.fieldName)).toEqual([null, null]);
    // Both are reported: two widgets, two issues, no grouping.
    expect(result.formIssues).toHaveLength(2);
    expect(result.summary.forms).toBe(2);
    expect(result.summary.formFields).toBe(0);
    // A nameless widget never becomes a form field.
    expect(result.formFields).toEqual([]);
  });

  it('keeps a field that lives on one page free of duplicate-name issues', async () => {
    const fake = createFakeDocument({
      pages: {
        1: {
          annotations: [
            {
              subtype: 'Widget',
              id: 'w1',
              rect: [0, 0, 10, 10],
              fieldName: 'notes',
              fieldType: 'Tx',
            },
          ],
        },
      },
    });

    const result = expectResult(await buildAnnotationIndex(fake.doc, 1));

    expect(result.formIssues).toEqual([]);
    expect(result.formFields).toHaveLength(1);
    expect(result.summary.formFields).toBe(1);
  });
});
