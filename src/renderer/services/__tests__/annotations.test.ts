import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABELS,
  annotationKind,
  annotationKindLabel,
  annotationSearchText,
  annotationSubtypeLabel,
  filterAnnotations,
  formatAnnotationValue,
  isSafeExternalUrl,
  loadPageAnnotations,
  loadPageAnnotationsForIndex,
  normalizeAnnotation,
  resolveDestinationPage,
} from '../annotations';
import type { PdfAnnotation } from '../../types/annotations';

const ORIGIN = { x: 0, y: 0 };

/** Fake PDF.js object reference used inside explicit destinations. */
const ref = (num: number) => ({ num, gen: 0 });

interface FakeDocOptions {
  annotations?: (page: number) => unknown[];
  destinations?: Partial<Record<string, unknown[] | null>>;
  pageIndices?: Partial<Record<number, number>>;
  /** Per-page `page.view`; omitted pages expose no view at all. */
  views?: Partial<Record<number, unknown>>;
}

/**
 * Build a fake `PDFDocumentProxy` covering only what the loader uses. No real
 * PDF is parsed; every call is observable through the returned mocks.
 */
function createFakeDoc(options: FakeDocOptions = {}) {
  const loadAnnotations = options.annotations ?? (() => []);
  const destinations = options.destinations ?? {};
  const pageIndices = options.pageIndices ?? {};
  const views = options.views ?? {};

  const getPage = vi.fn(async (pageNumber: number) => ({
    view: views[pageNumber],
    getAnnotations: async () => loadAnnotations(pageNumber),
  }));
  const getDestination = vi.fn(async (name: string) =>
    Object.prototype.hasOwnProperty.call(destinations, name) ? destinations[name] : null,
  );
  const getPageIndex = vi.fn(async (refProxy: { num?: number }) => {
    const num = refProxy !== null && typeof refProxy.num === 'number' ? refProxy.num : -1;
    const index = pageIndices[num];
    if (index === undefined) throw new Error(`Unknown reference ${num}`);
    return index;
  });

  return {
    doc: { getPage, getDestination, getPageIndex } as unknown as PDFDocumentProxy,
    getPage,
    getDestination,
    getPageIndex,
  };
}

/** Minimal annotation for pure filter/format tests. */
function makeAnnotation(partial: Partial<PdfAnnotation>): PdfAnnotation {
  return {
    id: 'a',
    page: 1,
    subtype: 'Link',
    kind: 'link',
    rect: null,
    title: null,
    contents: null,
    modificationDate: null,
    color: null,
    opacity: null,
    hidden: false,
    link: null,
    form: null,
    ...partial,
  };
}

const linkRaw = {
  subtype: 'Link',
  id: 'lnk-1',
  rect: [10, 20, 110, 60],
  url: 'https://example.com/',
  unsafeUrl: 'https://example.com/',
  newWindow: true,
  titleObj: { str: 'Example' },
  contentsObj: { str: 'Go to example' },
  modificationDate: '2024-01-02T03:04:05Z',
  color: [1, 0, 0],
  opacity: 0.5,
  annotationFlags: 4,
  dest: [ref(2), { name: 'XYZ' }],
};

const choiceWidgetRaw = {
  subtype: 'Widget',
  id: 'w-1',
  rect: [20, 20, 120, 50],
  fieldName: 'tags',
  fieldType: 'Ch',
  fieldValue: ['A', 'B'],
  defaultFieldValue: ['A'],
  readOnly: false,
  required: true,
  checkBox: false,
  radioButton: false,
  pushButton: false,
  multiLine: false,
  combo: true,
  options: [
    { displayValue: 'Alpha', exportValue: 'a' },
    { exportValue: 'b' },
  ],
};

describe('annotationKind', () => {
  it('maps every supported subtype onto its display kind', () => {
    const cases: Array<[string, string]> = [
      ['Link', 'link'],
      ['link', 'link'],
      ['Widget', 'form'],
      ['Text', 'note'],
      ['FreeText', 'note'],
      ['Stamp', 'stamp'],
      ['Highlight', 'markup'],
      ['Underline', 'markup'],
      ['Squiggly', 'markup'],
      ['StrikeOut', 'markup'],
      ['Square', 'markup'],
      ['Circle', 'markup'],
      ['Line', 'markup'],
      ['PolyLine', 'markup'],
      ['Polygon', 'markup'],
      ['Ink', 'markup'],
      ['Caret', 'markup'],
      ['Redact', 'markup'],
      ['Popup', 'other'],
      ['FileAttachment', 'other'],
      ['', 'other'],
      ['   ', 'other'],
    ];

    for (const [subtype, kind] of cases) {
      expect(annotationKind(subtype)).toBe(kind);
    }
  });

  it('exposes kinds and labels for the view layer', () => {
    expect(ANNOTATION_KINDS).toEqual(['link', 'form', 'markup', 'note', 'stamp', 'other']);
    expect(ANNOTATION_KIND_LABELS).toMatchObject({
      link: 'Link',
      form: 'Form field',
      markup: 'Markup',
      note: 'Note',
      stamp: 'Stamp',
      other: 'Other',
    });
    expect(annotationKindLabel('form')).toBe('Form field');
  });

  it('spaces camel-cased subtypes for display', () => {
    expect(annotationSubtypeLabel('FreeText')).toBe('Free Text');
    expect(annotationSubtypeLabel('StrikeOut')).toBe('Strike Out');
    expect(annotationSubtypeLabel('PolyLine')).toBe('Poly Line');
    expect(annotationSubtypeLabel('Link')).toBe('Link');
    expect(annotationSubtypeLabel('')).toBe('Unknown');
    expect(annotationSubtypeLabel('  Highlight ')).toBe('Highlight');
  });
});

describe('filterAnnotations', () => {
  const annotations = [
    makeAnnotation({ id: 'l', subtype: 'Link', kind: 'link' }),
    makeAnnotation({ id: 'h', subtype: 'Highlight', kind: 'markup' }),
    makeAnnotation({ id: 'w', subtype: 'Widget', kind: 'form' }),
  ];

  it('returns a new array for the all/all case', () => {
    const filtered = filterAnnotations(annotations, 'all', 'all');
    expect(filtered).toHaveLength(3);
    expect(filtered).not.toBe(annotations);

    filtered.length = 0;
    expect(annotations).toHaveLength(3);
  });

  it('filters by kind', () => {
    expect(filterAnnotations(annotations, 'markup', 'all').map((a) => a.id)).toEqual(['h']);
    expect(filterAnnotations(annotations, 'note', 'all')).toEqual([]);
  });

  it('filters by subtype case-insensitively', () => {
    expect(filterAnnotations(annotations, 'all', 'highLIGHT').map((a) => a.id)).toEqual(['h']);
    expect(filterAnnotations(annotations, 'all', 'Widget')).toHaveLength(1);
    expect(filterAnnotations(annotations, 'all', 'stamp')).toEqual([]);
  });

  it('treats a blank subtype filter as all', () => {
    expect(filterAnnotations(annotations, 'all', '')).toHaveLength(3);
    expect(filterAnnotations(annotations, 'all', '   ')).toHaveLength(3);
  });

  it('combines kind and subtype filters', () => {
    expect(filterAnnotations(annotations, 'link', 'Highlight')).toEqual([]);
    expect(filterAnnotations(annotations, 'link', 'link')).toHaveLength(1);
  });
});

describe('isSafeExternalUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/path?q=1#top',
      'HTTPS://EXAMPLE.COM',
      '  http://example.com/padded  ',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(true);
    }
  });

  it('rejects non-http schemes and unsafe targets', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'mailto:user@example.com',
      'ftp://example.com/file.pdf',
      'tel:+123456',
      '/relative/path',
      'relative.html',
      '//example.com/path',
      'http://example.com/\u0000',
      '',
      '   ',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
    expect(isSafeExternalUrl(null)).toBe(false);
  });
});

describe('formatAnnotationValue', () => {
  it('formats single, multi and missing values', () => {
    expect(formatAnnotationValue(null)).toBe('');
    expect(formatAnnotationValue('Ada')).toBe('Ada');
    expect(formatAnnotationValue(['A', 'B'])).toBe('A, B');
    expect(formatAnnotationValue([])).toBe('');
  });
});

describe('normalizeAnnotation', () => {
  it('normalizes a link annotation', () => {
    const annotation = normalizeAnnotation(linkRaw, 1, ORIGIN, 2);

    expect(annotation).toMatchObject({
      id: '1:lnk-1',
      page: 1,
      subtype: 'Link',
      kind: 'link',
      rect: { x0: 10, y0: 20, x1: 110, y1: 60 },
      title: 'Example',
      contents: 'Go to example',
      modificationDate: '2024-01-02T03:04:05.000Z',
      color: '#ff0000',
      opacity: 0.5,
      hidden: false,
      form: null,
    });
    expect(annotation?.link).toEqual({
      url: 'https://example.com/',
      unsafeUrl: 'https://example.com/',
      internalPage: 2,
      newWindow: true,
    });
  });

  it('subtracts a non-zero MediaBox origin from the rect', () => {
    const annotation = normalizeAnnotation(
      { subtype: 'Highlight', id: 'h1', rect: [110, 220, 310, 420] },
      3,
      { x: 100, y: 200 },
      null,
    );

    expect(annotation?.rect).toEqual({ x0: 10, y0: 20, x1: 210, y1: 220 });
  });

  it('accepts typed-array rects', () => {
    const annotation = normalizeAnnotation(
      { subtype: 'Square', rect: new Float32Array([0, 0, 10, 10]) },
      1,
      ORIGIN,
      null,
    );

    expect(annotation?.rect).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
  });

  it('keeps annotations with unusable geometry but nulls the rect', () => {
    const invalidRects: unknown[] = [
      undefined,
      null,
      [0, 0, 10],
      [0, 0, 10, 10, 20],
      ['0', 0, 10, 10],
      [0, 0, Number.NaN, 10],
      [0, 0, Number.POSITIVE_INFINITY, 10],
      [10, 0, 5, 10],
      [0, 10, 10, 5],
      'rect',
      { x0: 0, y0: 0, x1: 10, y1: 10 },
    ];

    for (const rect of invalidRects) {
      const annotation = normalizeAnnotation(
        { subtype: 'Ink', id: 'ink', rect, contentsObj: { str: 'still listed' } },
        1,
        ORIGIN,
        null,
      );
      expect(annotation).not.toBeNull();
      expect(annotation?.rect).toBeNull();
      expect(annotation?.contents).toBe('still listed');
    }
  });

  it('prefers titleObj/contentsObj strings and falls back safely', () => {
    const fromObjects = normalizeAnnotation(
      {
        subtype: 'Text',
        titleObj: { str: '  Hello\u0000World\nNext  ' },
        contentsObj: { str: 'Line one\nLine two\u0007' },
      },
      1,
      ORIGIN,
      null,
    );
    expect(fromObjects?.title).toBe('Hello World Next');
    expect(fromObjects?.contents).toBe('Line one Line two');

    const fromFallback = normalizeAnnotation(
      { subtype: 'Text', title: 'Raw title', contents: 'Raw contents' },
      1,
      ORIGIN,
      null,
    );
    expect(fromFallback?.title).toBe('Raw title');
    expect(fromFallback?.contents).toBe('Raw contents');

    const unsafeValues = normalizeAnnotation(
      {
        subtype: 'Text',
        titleObj: { str: 42 },
        title: { toString: () => 'evil' },
        contentsObj: { str: null },
        contents: ['not', 'a', 'string'],
      },
      1,
      ORIGIN,
      null,
    );
    expect(unsafeValues?.title).toBeNull();
    expect(unsafeValues?.contents).toBeNull();
  });

  it('normalizes modification dates deterministically', () => {
    const dateOf = (value: unknown) =>
      normalizeAnnotation({ subtype: 'Text', modificationDate: value }, 1, ORIGIN, null)
        ?.modificationDate;

    expect(dateOf('D:20240101120000Z')).toBe('2024-01-01T12:00:00.000Z');
    expect(dateOf("D:20240101120000+02'00'")).toBe('2024-01-01T10:00:00.000Z');
    expect(dateOf("D:20240101120000-05'30'")).toBe('2024-01-01T17:30:00.000Z');
    expect(dateOf('D:20240101')).toBe('2024-01-01T00:00:00.000Z');
    expect(dateOf('2024-01-02T03:04:05Z')).toBe('2024-01-02T03:04:05.000Z');
    expect(dateOf('not-a-date')).toBe('not-a-date');
    expect(dateOf('   ')).toBeNull();
    expect(dateOf(1700000000000)).toBeNull();
  });

  it('flags hidden annotations from data.hidden or annotation flags', () => {
    const hiddenOf = (raw: Record<string, unknown>) =>
      normalizeAnnotation({ subtype: 'Text', ...raw }, 1, ORIGIN, null)?.hidden;

    expect(hiddenOf({ annotationFlags: 2 })).toBe(true);
    expect(hiddenOf({ annotationFlags: 32 })).toBe(true);
    expect(hiddenOf({ annotationFlags: 2 | 32 })).toBe(true);
    expect(hiddenOf({ annotationFlags: 4 })).toBe(false);
    expect(hiddenOf({ hidden: true })).toBe(true);
    expect(hiddenOf({ hidden: false, annotationFlags: 0 })).toBe(false);
    expect(hiddenOf({})).toBe(false);
  });

  it('converts 0–1 RGB arrays to hex', () => {
    const colorOf = (value: unknown) =>
      normalizeAnnotation({ subtype: 'Highlight', color: value }, 1, ORIGIN, null)?.color;

    expect(colorOf([1, 0, 0])).toBe('#ff0000');
    expect(colorOf([0, 0, 0])).toBe('#000000');
    expect(colorOf([1, 1, 1])).toBe('#ffffff');
    expect(colorOf([1, 0.5, 0])).toBe('#ff8000');
    expect(colorOf([0.2, 0.4, 0.6])).toBe('#336699');
    // Unit channels clamp to 0 before scaling.
    expect(colorOf([-0.5, 0, 0])).toBe('#000000');
  });

  it('treats typed arrays and >1 channels as 0–255 bytes', () => {
    const colorOf = (value: unknown) =>
      normalizeAnnotation({ subtype: 'Highlight', color: value }, 1, ORIGIN, null)?.color;

    // PDF.js 4.8.69 returns annotation `/C` as a 0–255 Uint8ClampedArray.
    expect(colorOf(new Uint8ClampedArray([51, 102, 153]))).toBe('#336699');
    expect(colorOf(new Uint8ClampedArray([255, 0, 0]))).toBe('#ff0000');
    expect(colorOf(new Uint8Array([0, 128, 255]))).toBe('#0080ff');
    // Ordinary arrays with a channel above 1 are byte-based too.
    expect(colorOf([51, 102, 153])).toBe('#336699');
    expect(colorOf([255, 0, 0])).toBe('#ff0000');
    // Byte channels clamp after normalization.
    expect(colorOf([300, -20, 128])).toBe('#ff0080');
  });

  it('rejects malformed colour values', () => {
    const colorOf = (value: unknown) =>
      normalizeAnnotation({ subtype: 'Highlight', color: value }, 1, ORIGIN, null)?.color;

    expect(colorOf([1, 0])).toBeNull();
    expect(colorOf([1, 0, 0, 0])).toBeNull();
    expect(colorOf(new Uint8ClampedArray(4))).toBeNull();
    expect(colorOf(['1', 0, 0])).toBeNull();
    expect(colorOf([Number.NaN, 0, 0])).toBeNull();
    expect(colorOf(null)).toBeNull();
  });

  it('keeps unsafe link URLs display-only', () => {
    const unsafe = normalizeAnnotation(
      {
        subtype: 'Link',
        id: 'bad',
        url: 'javascript:alert(1)',
        unsafeUrl: 'javascript:alert(1)',
      },
      1,
      ORIGIN,
      null,
    );

    expect(unsafe?.link).toEqual({
      url: null,
      unsafeUrl: 'javascript:alert(1)',
      internalPage: null,
      newWindow: false,
    });

    const mailto = normalizeAnnotation(
      { subtype: 'Link', url: 'mailto:user@example.com' },
      1,
      ORIGIN,
      null,
    );
    expect(mailto?.link?.url).toBeNull();
    expect(mailto?.link?.unsafeUrl).toBe('mailto:user@example.com');

    const safe = normalizeAnnotation(
      { subtype: 'Link', url: 'https://example.com/x', newWindow: 'true' },
      1,
      ORIGIN,
      4,
    );
    expect(safe?.link).toEqual({
      url: 'https://example.com/x',
      unsafeUrl: 'https://example.com/x',
      internalPage: 4,
      newWindow: false,
    });
  });

  it('drops invalid internal page numbers', () => {
    for (const page of [0, -1, Number.NaN, 1.5]) {
      const annotation = normalizeAnnotation(
        { subtype: 'Link', url: 'https://example.com/' },
        1,
        ORIGIN,
        page,
      );
      expect(annotation?.link?.internalPage).toBeNull();
    }
  });

  it('normalizes a text form field', () => {
    const annotation = normalizeAnnotation(
      {
        subtype: 'Widget',
        id: 'w1',
        rect: [10, 10, 110, 40],
        fieldName: 'customer.name',
        fieldType: 'Tx',
        fieldValue: 'Ada',
        defaultFieldValue: 'Anon',
        readOnly: true,
        required: true,
        multiLine: true,
        checkBox: false,
        radioButton: false,
        pushButton: false,
        combo: false,
      },
      2,
      ORIGIN,
      null,
    );

    expect(annotation?.kind).toBe('form');
    expect(annotation?.link).toBeNull();
    expect(annotation?.form).toEqual({
      fieldName: 'customer.name',
      fieldType: 'Tx',
      value: 'Ada',
      defaultValue: 'Anon',
      readOnly: true,
      required: true,
      checkBox: false,
      radioButton: false,
      pushButton: false,
      multiLine: true,
      combo: false,
      options: [],
    });
  });

  it('keeps arrays and maps options for choice fields', () => {
    const annotation = normalizeAnnotation(choiceWidgetRaw, 2, ORIGIN, null);

    expect(annotation?.form).toMatchObject({
      fieldType: 'Ch',
      value: ['A', 'B'],
      defaultValue: ['A'],
      combo: true,
    });
    expect(annotation?.form?.options).toEqual([
      { label: 'Alpha', value: 'a' },
      { label: 'b', value: 'b' },
    ]);
  });

  it('preserves button and signature flags', () => {
    const checkBox = normalizeAnnotation(
      { subtype: 'Widget', fieldType: 'Btn', checkBox: true, radioButton: false, pushButton: false },
      1,
      ORIGIN,
      null,
    );
    expect(checkBox?.form).toMatchObject({ checkBox: true, radioButton: false, pushButton: false });

    const radio = normalizeAnnotation(
      { subtype: 'Widget', fieldType: 'Btn', checkBox: false, radioButton: true, pushButton: false },
      1,
      ORIGIN,
      null,
    );
    expect(radio?.form).toMatchObject({ radioButton: true, checkBox: false });

    const push = normalizeAnnotation(
      { subtype: 'Widget', fieldType: 'Btn', checkBox: false, radioButton: false, pushButton: true },
      1,
      ORIGIN,
      null,
    );
    expect(push?.form).toMatchObject({ pushButton: true });

    const signature = normalizeAnnotation(
      { subtype: 'Widget', fieldType: 'Sig', fieldValue: null },
      1,
      ORIGIN,
      null,
    );
    expect(signature?.form).toMatchObject({ fieldType: 'Sig', value: null });

    const unknownType = normalizeAnnotation(
      { subtype: 'Widget', fieldType: 'Xyz' },
      1,
      ORIGIN,
      null,
    );
    expect(unknownType?.form?.fieldType).toBe('Xyz');
  });

  it('normalizes empty and non-string form values to null', () => {
    const emptyArray = normalizeAnnotation(
      { subtype: 'Widget', fieldValue: [], defaultFieldValue: ['ok', 7] },
      1,
      ORIGIN,
      null,
    );
    expect(emptyArray?.form?.value).toBeNull();
    expect(emptyArray?.form?.defaultValue).toEqual(['ok']);

    const numberValue = normalizeAnnotation(
      { subtype: 'Widget', fieldValue: 42, options: 'nope' },
      1,
      ORIGIN,
      null,
    );
    expect(numberValue?.form?.value).toBeNull();
    expect(numberValue?.form?.options).toEqual([]);
  });

  it('rejects raw values that are not annotation objects', () => {
    for (const raw of [null, undefined, 'Link', 42, [], [linkRaw]]) {
      expect(normalizeAnnotation(raw, 1, ORIGIN, null)).toBeNull();
    }
  });

  it('builds deterministic, page-scoped ids', () => {
    const withId = normalizeAnnotation({ subtype: 'Link', id: 'abc' }, 3, ORIGIN, null);
    expect(withId?.id).toBe('3:abc');

    const withoutIdRaw = { subtype: 'Highlight', rect: [0, 0, 10, 10] };
    const first = normalizeAnnotation(withoutIdRaw, 3, ORIGIN, null);
    const second = normalizeAnnotation(withoutIdRaw, 3, ORIGIN, null);
    expect(first?.id).toBe('3:highlight:0,0,10,10');
    expect(second?.id).toBe(first?.id);

    const noGeometry = normalizeAnnotation({ subtype: 'Text' }, 3, ORIGIN, null);
    expect(noGeometry?.id).toBe('3:text:no-rect');
  });
});

describe('annotationSearchText', () => {
  it('folds text, form values and link targets into a lowercase haystack', () => {
    const form = normalizeAnnotation(
      {
        subtype: 'Widget',
        fieldName: 'Amount',
        fieldType: 'Tx',
        fieldValue: '42.00',
        contentsObj: { str: 'Total Due' },
      },
      2,
      ORIGIN,
      null,
    ) as PdfAnnotation;
    const formText = annotationSearchText(form);
    expect(formText).toContain('amount');
    expect(formText).toContain('total due');
    expect(formText).toContain('42.00');
    expect(formText).toContain('form field');
    expect(formText).toContain('2');

    const link = makeAnnotation({
      page: 3,
      subtype: 'Link',
      kind: 'link',
      title: 'Chapter One',
      link: {
        url: 'https://example.com/ch1',
        unsafeUrl: 'https://example.com/ch1',
        internalPage: 4,
        newWindow: false,
      },
    });
    const linkText = annotationSearchText(link);
    expect(linkText).toContain('chapter one');
    expect(linkText).toContain('https://example.com/ch1');
    expect(linkText).toContain('page 4');
  });
});

describe('resolveDestinationPage', () => {
  it('resolves named destinations to a 1-based page', async () => {
    const fake = createFakeDoc({
      destinations: { chapter: [ref(5), { name: 'Fit' }] },
      pageIndices: { 5: 2 },
    });

    await expect(resolveDestinationPage(fake.doc, 'chapter')).resolves.toBe(3);
    expect(fake.getDestination).toHaveBeenCalledWith('chapter');
    expect(fake.getPageIndex).toHaveBeenCalledWith(ref(5));

    await expect(resolveDestinationPage(fake.doc, '  chapter  ')).resolves.toBe(3);
  });

  it('resolves explicit destination arrays', async () => {
    const fake = createFakeDoc({ pageIndices: { 9: 0 } });

    await expect(resolveDestinationPage(fake.doc, [ref(9), { name: 'XYZ' }])).resolves.toBe(1);
    expect(fake.getPageIndex).toHaveBeenCalledWith(ref(9));
  });

  it('returns null for missing, empty or malformed destinations', async () => {
    const fake = createFakeDoc({
      destinations: { empty: [], nullDest: null },
      pageIndices: { 5: 1 },
    });

    await expect(resolveDestinationPage(fake.doc, 'missing')).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, 'empty')).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, 'nullDest')).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, '')).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, null)).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, undefined)).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, [])).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, 42)).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, { name: 'chapter' })).resolves.toBeNull();
  });

  it('returns null when destination resolution throws', async () => {
    const throwingDoc = {
      getDestination: vi.fn(async () => {
        throw new Error('bad destination');
      }),
      getPageIndex: vi.fn(async () => 0),
    } as unknown as PDFDocumentProxy;

    await expect(resolveDestinationPage(throwingDoc, 'chapter')).resolves.toBeNull();
  });

  it('returns null for unknown references or invalid page indexes', async () => {
    const fake = createFakeDoc({ pageIndices: { 7: -1, 8: 1.5 } });

    await expect(resolveDestinationPage(fake.doc, [ref(99)])).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, [ref(7)])).resolves.toBeNull();
    await expect(resolveDestinationPage(fake.doc, [ref(8)])).resolves.toBeNull();
  });
});

describe('loadPageAnnotations', () => {
  it('loads and normalizes the current page without popups', async () => {
    const fake = createFakeDoc({
      annotations: () => [
        linkRaw,
        { subtype: 'Popup', id: 'pop', rect: [10, 20, 110, 60] },
        { subtype: 'Highlight', id: 'hl', rect: [0, 0, 10, 10], color: [1, 1, 0] },
      ],
      pageIndices: { 2: 1 },
    });

    const annotations = await loadPageAnnotations(fake.doc, 1, ORIGIN);

    expect(fake.getPage).toHaveBeenCalledWith(1);
    expect(annotations.map((annotation) => annotation.subtype)).toEqual(['Link', 'Highlight']);
    expect(annotations[0].link?.internalPage).toBe(2);
    expect(annotations[1].kind).toBe('markup');
    expect(annotations[1].color).toBe('#ffff00');
  });

  it('resolves named destinations through the document', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Link', id: 'l2', rect: [0, 0, 10, 10], dest: 'sec2' }],
      destinations: { sec2: [ref(9), { name: 'Fit' }] },
      pageIndices: { 9: 1 },
    });

    const annotations = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    expect(annotations[0].link?.internalPage).toBe(2);

    const unresolved = createFakeDoc({
      annotations: () => [{ subtype: 'Link', id: 'l3', rect: [0, 0, 10, 10], dest: 'missing' }],
    });
    const unresolvedList = await loadPageAnnotations(unresolved.doc, 1, ORIGIN);
    expect(unresolvedList[0].link?.internalPage).toBeNull();
  });

  it('keeps hidden annotations in the list with the hidden marker', async () => {
    const fake = createFakeDoc({
      annotations: () => [
        {
          subtype: 'Text',
          id: 'note',
          rect: [0, 0, 5, 5],
          annotationFlags: 2,
          contentsObj: { str: 'hidden note' },
        },
      ],
    });

    const annotations = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].hidden).toBe(true);
    expect(annotations[0].contents).toBe('hidden note');
  });

  it('caches per page and returns isolated copies', async () => {
    const fake = createFakeDoc({
      annotations: () => [linkRaw, choiceWidgetRaw],
    });

    const first = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    const second = await loadPageAnnotations(fake.doc, 1, ORIGIN);

    expect(fake.getPage).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].rect).not.toBe(first[0].rect);
    expect(second[0].link).not.toBe(first[0].link);
    expect(second[1].form).not.toBe(first[1].form);
    expect(second[1].form?.options).not.toBe(first[1].form?.options);

    first[0].rect!.x0 = 999;
    first[0].link!.url = 'https://mutated.example/';
    first[0].title = 'mutated';
    first[1].form!.options.push({ label: 'Injected', value: 'x' });
    (first[1].form!.value as string[]).push('C');
    first.length = 0;

    const third = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    expect(fake.getPage).toHaveBeenCalledTimes(1);
    expect(third).toHaveLength(2);
    expect(third[0].rect).toEqual({ x0: 10, y0: 20, x1: 110, y1: 60 });
    expect(third[0].link?.url).toBe('https://example.com/');
    expect(third[0].title).toBe('Example');
    expect(third[1].form?.options).toEqual([
      { label: 'Alpha', value: 'a' },
      { label: 'b', value: 'b' },
    ]);
    expect(third[1].form?.value).toEqual(['A', 'B']);
  });

  it('caches each page separately', async () => {
    const fake = createFakeDoc({
      annotations: (page) => [{ subtype: 'Text', id: `t${page}`, rect: [0, 0, 1, 1] }],
    });

    const pageOne = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    const pageTwo = await loadPageAnnotations(fake.doc, 2, ORIGIN);
    const pageOneAgain = await loadPageAnnotations(fake.doc, 1, ORIGIN);

    expect(fake.getPage).toHaveBeenCalledTimes(2);
    expect(pageOne[0].page).toBe(1);
    expect(pageTwo[0].page).toBe(2);
    expect(pageOneAgain[0].id).toBe(pageOne[0].id);
  });

  it('caches separately per MediaBox origin so rects never mix', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [110, 220, 310, 420] }],
    });

    const offsetOrigin = { x: 100, y: 200 };
    const atZero = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    const offset = await loadPageAnnotations(fake.doc, 1, offsetOrigin);
    const atZeroAgain = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    const offsetAgain = await loadPageAnnotations(fake.doc, 1, offsetOrigin);

    // One fetch per distinct origin, not per call.
    expect(fake.getPage).toHaveBeenCalledTimes(2);
    expect(atZero[0].rect).toEqual({ x0: 110, y0: 220, x1: 310, y1: 420 });
    expect(offset[0].rect).toEqual({ x0: 10, y0: 20, x1: 210, y1: 220 });
    expect(atZeroAgain[0].rect).toEqual(atZero[0].rect);
    expect(offsetAgain[0].rect).toEqual(offset[0].rect);
  });

  it('treats a non-finite origin component as zero in the cache key', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [10, 20, 30, 40] }],
    });

    const fromZero = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    const fromNaN = await loadPageAnnotations(fake.doc, 1, { x: Number.NaN, y: 0 });
    const fromInfinity = await loadPageAnnotations(fake.doc, 1, {
      x: 0,
      y: Number.POSITIVE_INFINITY,
    });

    // An unusable origin normalizes to {0,0}, so it reuses the zero entry.
    expect(fake.getPage).toHaveBeenCalledTimes(1);
    expect(fromNaN).toEqual(fromZero);
    expect(fromInfinity).toEqual(fromZero);
  });

  it('drops a rejected load from the cache so the next call retries', async () => {
    let attempts = 0;
    const getPage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('page load failed');
      return {
        getAnnotations: async () => [{ subtype: 'Text', id: 'note', rect: [0, 0, 1, 1] }],
      };
    });
    const doc = { getPage } as unknown as PDFDocumentProxy;

    await expect(loadPageAnnotations(doc, 1, ORIGIN)).rejects.toThrow('page load failed');

    const annotations = await loadPageAnnotations(doc, 1, ORIGIN);
    expect(annotations).toHaveLength(1);
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('makes duplicate annotation ids unique per page', async () => {
    const fake = createFakeDoc({
      annotations: () => [
        { subtype: 'Link', id: 'dup', rect: [0, 0, 1, 1], url: 'https://example.com/a' },
        { subtype: 'Link', id: 'dup', rect: [0, 0, 1, 1], url: 'https://example.com/b' },
      ],
    });

    const annotations = await loadPageAnnotations(fake.doc, 1, ORIGIN);
    expect(annotations.map((annotation) => annotation.id)).toEqual(['1:dup', '1:dup#2']);
  });

  it('returns no annotations for an invalid page number', async () => {
    const fake = createFakeDoc();

    await expect(loadPageAnnotations(fake.doc, 0, ORIGIN)).resolves.toEqual([]);
    await expect(loadPageAnnotations(fake.doc, Number.NaN, ORIGIN)).resolves.toEqual([]);
    expect(fake.getPage).not.toHaveBeenCalled();
  });
});

describe('loadPageAnnotationsForIndex', () => {
  it('normalizes against the page view origin', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [110, 220, 310, 420] }],
      views: { 1: [100, 200, 600, 900] },
    });

    const annotations = await loadPageAnnotationsForIndex(fake.doc, 1);

    expect(fake.getPage).toHaveBeenCalledWith(1);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].rect).toEqual({ x0: 10, y0: 20, x1: 210, y1: 220 });
  });

  it('shares its cache entry with loadPageAnnotations for the same origin', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [110, 220, 310, 420] }],
      views: { 1: [100, 200, 600, 900] },
    });

    const indexed = await loadPageAnnotationsForIndex(fake.doc, 1);
    const currentPage = await loadPageAnnotations(fake.doc, 1, { x: 100, y: 200 });

    // The index read primed the shared cache; the current-page reader reused it.
    expect(fake.getPage).toHaveBeenCalledTimes(1);
    expect(currentPage).toEqual(indexed);
    // Copies stay isolated, so neither reader can mutate the other's data.
    expect(currentPage).not.toBe(indexed);
    expect(currentPage[0]).not.toBe(indexed[0]);
  });

  it('keeps the index origin out of the current page cache', async () => {
    const fake = createFakeDoc({
      annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [110, 220, 310, 420] }],
      views: { 1: [100, 200, 600, 900] },
    });

    const indexed = await loadPageAnnotationsForIndex(fake.doc, 1);
    const currentPage = await loadPageAnnotations(fake.doc, 1, ORIGIN);

    expect(fake.getPage).toHaveBeenCalledTimes(2);
    expect(indexed[0].rect).toEqual({ x0: 10, y0: 20, x1: 210, y1: 220 });
    expect(currentPage[0].rect).toEqual({ x0: 110, y0: 220, x1: 310, y1: 420 });
  });

  it('falls back to a zero origin when page.view is missing or unusable', async () => {
    const views: unknown[] = [
      undefined,
      null,
      [],
      [10],
      ['10', 20, 30, 40],
      [Number.NaN, 20, 30, 40],
      [10, Number.POSITIVE_INFINITY, 30, 40],
      'view',
    ];

    for (const view of views) {
      const fake = createFakeDoc({
        annotations: () => [{ subtype: 'Highlight', id: 'hl', rect: [10, 20, 30, 40] }],
        views: { 1: view },
      });

      const annotations = await loadPageAnnotationsForIndex(fake.doc, 1);
      expect(annotations[0].rect).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    }
  });

  it('retries after a failed page load', async () => {
    let attempts = 0;
    const getPage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('page load failed');
      return {
        view: [0, 0, 100, 100],
        getAnnotations: async () => [{ subtype: 'Text', id: 'note', rect: [0, 0, 1, 1] }],
      };
    });
    const doc = { getPage } as unknown as PDFDocumentProxy;

    await expect(loadPageAnnotationsForIndex(doc, 2)).rejects.toThrow('page load failed');

    const annotations = await loadPageAnnotationsForIndex(doc, 2);
    expect(annotations).toHaveLength(1);
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('returns no annotations for an invalid page number', async () => {
    const fake = createFakeDoc();

    await expect(loadPageAnnotationsForIndex(fake.doc, 0)).resolves.toEqual([]);
    await expect(loadPageAnnotationsForIndex(fake.doc, Number.NaN)).resolves.toEqual([]);
    expect(fake.getPage).not.toHaveBeenCalled();
  });
});
