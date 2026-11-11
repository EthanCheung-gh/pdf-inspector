// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore, type TableCellRef } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type {
  AnnotationFormIssue,
  AnnotationIndexResult,
  AnnotationIndexSummary,
  AnnotationLinkIssue,
} from '../../services/annotation-index';
import type { PdfAnnotation } from '../../types/annotations';
import type { SaveFileRequest } from '../../types/ipc-protocol';
import type { PageData, PdfRect } from '../../types/pdf-objects';

const { navigate, buildAnnotationIndex, saveFile } = vi.hoisted(() => ({
  navigate: vi.fn(),
  buildAnnotationIndex: vi.fn(),
  saveFile: vi.fn<
    (request: SaveFileRequest) => Promise<{ canceled: boolean; filePath?: string; error?: string }>
  >(),
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

vi.mock('../../services/annotation-index', () => ({ buildAnnotationIndex }));

// The export dialog saves through the bridge; the tab only opens it.
vi.mock('../../services/ipc-client', () => ({ ipc: { saveFile } }));

import {
  AnnotationsTab,
  annotationRowPreview,
  annotationSummary,
  documentAnnotationSummary,
  documentIssueCount,
  externalLinkCount,
  issuePagesLabel,
} from './AnnotationsTab';

const buildMock = vi.mocked(buildAnnotationIndex);

const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };

/** A page with usable MediaBox geometry, as the sidecar reports it. */
const pageData: PageData = {
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
};

/** Same page extracted by an older sidecar: no page boxes at all. */
const pageDataWithoutBoxes: PageData = { ...pageData, boxes: undefined };

const selectedRect: PdfRect = {
  type: 'rect',
  page: 1,
  x0: 0,
  y0: 0,
  x1: 10,
  y1: 10,
  fill: true,
  stroke: false,
  color: '#000000',
  width: 1,
};

const base = {
  page: 1,
  rect,
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
} as const;

const externalLink: PdfAnnotation = {
  ...base,
  id: '1:link-a',
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com/a',
    unsafeUrl: 'https://example.com/a',
    internalPage: null,
    newWindow: false,
  },
};

const internalLink: PdfAnnotation = {
  ...base,
  id: '1:link-b',
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: null, internalPage: 3, newWindow: false },
};

const widget: PdfAnnotation = {
  ...base,
  id: '1:widget-c',
  subtype: 'Widget',
  kind: 'form',
  form: {
    fieldName: 'name',
    fieldType: 'Tx',
    value: 'John',
    defaultValue: null,
    readOnly: false,
    required: false,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    multiLine: false,
    combo: false,
    options: [],
  },
};

const highlight: PdfAnnotation = {
  ...base,
  id: '1:highlight-d',
  subtype: 'Highlight',
  kind: 'markup',
  contents: 'Important passage',
  hidden: true,
};

const allAnnotations = [externalLink, internalLink, widget, highlight];

/** Fake PDF.js document: the index only ever needs a real page count here. */
const pdfDoc = { numPages: 3 } as unknown as PDFDocumentProxy;

/** An annotation on page 2, only known to the document index. */
const pageTwoLink: PdfAnnotation = {
  ...base,
  page: 2,
  id: '2:link-e',
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com/b',
    unsafeUrl: 'https://example.com/b',
    internalPage: null,
    newWindow: false,
  },
};

/** An annotation on page 3 carrying searchable text. */
const pageThreeNote: PdfAnnotation = {
  ...base,
  page: 3,
  id: '3:note-f',
  subtype: 'Text',
  kind: 'note',
  contents: 'Please review the invoice',
};

const EMPTY_SUMMARY: AnnotationIndexSummary = {
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

/** A finished index with one link and one note on different pages. */
const documentResult: AnnotationIndexResult = {
  annotations: [pageTwoLink, pageThreeNote],
  summary: {
    ...EMPTY_SUMMARY,
    annotations: 2,
    pagesWithAnnotations: 2,
    links: 1,
    notes: 1,
  },
  linkIssues: [],
  formIssues: [],
  formFields: [],
  scannedPages: 3,
  truncated: false,
};

const resultWith = (annotations: PdfAnnotation[]): AnnotationIndexResult => ({
  ...documentResult,
  annotations,
  summary: {
    ...EMPTY_SUMMARY,
    annotations: annotations.length,
    pagesWithAnnotations: new Set(annotations.map((annotation) => annotation.page)).size,
  },
  scannedPages: 3,
});

const emptyDocumentResult: AnnotationIndexResult = {
  ...documentResult,
  annotations: [],
  summary: EMPTY_SUMMARY,
};

/** A widget on `page`; the rest of the form fields are irrelevant to the list. */
const widgetOn = (
  id: string,
  page: number,
  fieldName: string | null,
  fieldType: string,
): PdfAnnotation => ({
  ...base,
  page,
  id,
  subtype: 'Widget',
  kind: 'form',
  form: {
    fieldName,
    fieldType,
    value: null,
    defaultValue: null,
    readOnly: false,
    required: false,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    multiLine: false,
    combo: false,
    options: [],
  },
});

/** A link on `page` with an openable http(s) target: information, not a problem. */
const externalPageOneLink: PdfAnnotation = {
  ...base,
  id: '1:link-ext',
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com/ext',
    unsafeUrl: 'https://example.com/ext',
    internalPage: null,
    newWindow: false,
  },
};

/** A link whose destination neither resolved to a page nor to a safe URL. */
const unresolvedPageFiveLink: PdfAnnotation = {
  ...base,
  page: 5,
  id: '5:link-unresolved',
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: null, internalPage: null, newWindow: false },
};

/** A link that only carries a refused, non-http(s) target. */
const unsafePageThreeLink: PdfAnnotation = {
  ...base,
  page: 3,
  id: '3:link-unsafe',
  subtype: 'Link',
  kind: 'link',
  link: { url: null, unsafeUrl: 'javascript:alert(1)', internalPage: null, newWindow: false },
};

const externalIssue: AnnotationLinkIssue = {
  annotationId: '1:link-ext',
  page: 1,
  subtype: 'Link',
  kind: 'external',
  target: 'https://example.com/ext',
  message: 'External link to https://example.com/ext',
};

const unresolvedIssue: AnnotationLinkIssue = {
  annotationId: '5:link-unresolved',
  page: 5,
  subtype: 'Link',
  kind: 'unresolved',
  target: null,
  message: 'Link has no external URL and no resolved page',
};

const unsafeIssue: AnnotationLinkIssue = {
  annotationId: '3:link-unsafe',
  page: 3,
  subtype: 'Link',
  kind: 'unsafe',
  target: 'javascript:alert(1)',
  message: 'Link uses an unsafe target scheme: javascript:alert(1)',
};

const unnamedIssue: AnnotationFormIssue = {
  annotationId: '6:widget-unnamed',
  fieldName: null,
  pages: [6],
  fieldTypes: ['Tx'],
  widgetCount: 1,
  kind: 'unnamed',
  message: 'Form widget has no field name',
};

/** Same field name on two pages: reported as information, never as an error. */
const duplicateNameIssue: AnnotationFormIssue = {
  annotationId: null,
  fieldName: 'amount',
  pages: [2, 4],
  fieldTypes: ['Ch', 'Tx'],
  widgetCount: 2,
  kind: 'duplicate-name',
  message: 'Field "amount" appears on 2 pages',
};

const conflictingTypeIssue: AnnotationFormIssue = {
  annotationId: null,
  fieldName: 'amount',
  pages: [2, 4],
  fieldTypes: ['Ch', 'Tx'],
  widgetCount: 2,
  kind: 'conflicting-type',
  message: 'Field "amount" uses conflicting types (Ch, Tx)',
};

/** Widgets backing the form issues above: `amount` is a text and a choice field. */
const amountWidgets: PdfAnnotation[] = [
  widgetOn('2:widget-amount-tx', 2, 'amount', 'Tx'),
  widgetOn('4:widget-amount-ch', 4, 'amount', 'Ch'),
];

/** Unnamed widget on page 6 so its `Go to page` label stays unique. */
const unnamedWidget: PdfAnnotation = widgetOn('6:widget-unnamed', 6, null, 'Tx');

/** A document with two link problems, three form issues and one external link. */
const healthResult: AnnotationIndexResult = {
  annotations: [
    externalPageOneLink,
    unresolvedPageFiveLink,
    unsafePageThreeLink,
    ...amountWidgets,
    unnamedWidget,
  ],
  summary: {
    ...EMPTY_SUMMARY,
    annotations: 6,
    pagesWithAnnotations: 5,
    links: 3,
    forms: 3,
    formFields: 1,
    unresolvedLinks: 1,
    unsafeLinks: 1,
  },
  linkIssues: [externalIssue, unresolvedIssue, unsafeIssue],
  formIssues: [unnamedIssue, duplicateNameIssue, conflictingTypeIssue],
  formFields: [],
  scannedPages: 6,
  truncated: false,
};

/** The same index narrowed to a single problem, for one-issue click tests. */
const resultWithIssues = (
  annotations: PdfAnnotation[],
  linkIssues: AnnotationLinkIssue[],
  formIssues: AnnotationFormIssue[],
): AnnotationIndexResult => ({
  ...documentResult,
  annotations,
  summary: {
    ...EMPTY_SUMMARY,
    annotations: annotations.length,
    pagesWithAnnotations: new Set(annotations.map((annotation) => annotation.page)).size,
    links: annotations.filter((annotation) => annotation.kind === 'link').length,
    forms: annotations.filter((annotation) => annotation.kind === 'form').length,
    unresolvedLinks: linkIssues.filter((issue) => issue.kind === 'unresolved').length,
    unsafeLinks: linkIssues.filter((issue) => issue.kind === 'unsafe').length,
  },
  linkIssues,
  formIssues,
  formFields: [],
});

/** Deferred promise for tests that need a run to be in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const reset = (): void => {
  navigate.mockReset();
  buildMock.mockReset();
  useAnnotationStore.getState().clear();
  useAnnotationStore.setState({
    kindFilter: 'all',
    subtypeFilter: 'all',
    showBoxes: true,
    reloadKey: 0,
  });
  useAnnotationIndexStore.getState().reset();
  usePdfStore.setState({
    filePath: '/docs/doc.pdf',
    sourceUrl: null,
    documentName: null,
    pageCount: 3,
    pdfDocRef: pdfDoc,
    currentPage: 1,
    pageData,
    isLoading: false,
    error: null,
    selectedObject: null,
    hoveredObject: null,
    selectedTableCell: null,
    hoveredTableCell: null,
  });
  useWorkspaceStore.setState({ inspectorTab: 'inspect' });
};

const currentList = (): HTMLElement =>
  screen.getByRole('list', { name: 'Annotations on page 1' });

const documentList = (): HTMLElement =>
  screen.getByRole('list', { name: 'Document annotations' });

const switchToDocument = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Whole document' }));
};

describe('AnnotationsTab', () => {
  afterEach(cleanup);

  beforeEach(() => {
    reset();
    useAnnotationStore.getState().setPageData(1, allAnnotations);
  });

  it('summarises the current page and lists every annotation', () => {
    render(React.createElement(AnnotationsTab));

    expect(screen.getByRole('status').textContent).toBe(
      '4 annotations · 2 links · 1 form field',
    );
    expect(within(currentList()).getAllByRole('button')).toHaveLength(4);
    // Kind badge and subtype label are both visible in each row.
    expect(within(currentList()).getAllByText('Link')).toHaveLength(4);
    expect(within(currentList()).getAllByText('Form field')).toHaveLength(1);
    expect(within(currentList()).getAllByText('Widget')).toHaveLength(1);
    expect(within(currentList()).getAllByText('Markup')).toHaveLength(1);
    expect(within(currentList()).getAllByText('Highlight')).toHaveLength(1);
    expect(within(currentList()).getAllByText('p.1')).toHaveLength(4);
    expect(within(currentList()).getByText('https://example.com/a')).toBeTruthy();
    expect(within(currentList()).getByText('Go to page 3')).toBeTruthy();
    expect(within(currentList()).getByText('name = John')).toBeTruthy();
    expect(within(currentList()).getByText('Important passage')).toBeTruthy();
  });

  it('marks hidden annotations without dropping them from the list', () => {
    render(React.createElement(AnnotationsTab));

    const hiddenMarker = within(currentList()).getByText('Hidden');
    expect(hiddenMarker.getAttribute('title')).toBe('Hidden annotation');
    expect(within(currentList()).getAllByRole('button')).toHaveLength(4);
  });

  it('filters by kind and reports the filtered count', () => {
    render(React.createElement(AnnotationsTab));

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'form' },
    });

    expect(useAnnotationStore.getState().kindFilter).toBe('form');
    expect(screen.getByRole('status').textContent).toBe(
      '1 of 4 annotations · 0 links · 1 form field',
    );
    expect(within(currentList()).getAllByRole('button')).toHaveLength(1);
    expect(within(currentList()).getByText('name = John')).toBeTruthy();
  });

  it('filters by the raw subtypes found on the page', () => {
    render(React.createElement(AnnotationsTab));

    const subtypeSelect = screen.getByRole('combobox', { name: 'Subtype' });
    expect(
      within(subtypeSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All subtypes', 'Highlight', 'Link', 'Widget']);

    fireEvent.change(subtypeSelect, { target: { value: 'Link' } });

    expect(useAnnotationStore.getState().subtypeFilter).toBe('Link');
    expect(within(currentList()).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe(
      '2 of 4 annotations · 2 links · 0 form fields',
    );

    // The empty filter result is a message, not a broken list.
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'stamp' },
    });
    expect(screen.getByText('No annotations match the current filters.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps an active subtype filter visible when the page has no such subtype', () => {
    // Filters survive a page change, so the select must still show the value
    // the list is being filtered by instead of rendering an empty choice.
    useAnnotationStore.getState().setSubtypeFilter('Stamp');
    render(React.createElement(AnnotationsTab));

    const subtypeSelect = screen.getByRole('combobox', { name: 'Subtype' });
    expect((subtypeSelect as HTMLSelectElement).value).toBe('Stamp');
    expect(within(subtypeSelect).getByRole('option', { name: 'Stamp' })).toBeTruthy();
    expect(screen.getByText('No annotations match the current filters.')).toBeTruthy();
  });

  it('selects a row, opens Inspect and marks the row as pressed', () => {
    render(React.createElement(AnnotationsTab));

    const row = screen.getByRole('button', { name: /Go to page 3/ });
    expect(row.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(row);

    expect(useAnnotationStore.getState().selected?.id).toBe('1:link-b');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
    expect(
      screen.getByRole('button', { name: /Go to page 3/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /https:\/\/example\.com\/a/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('clears the object selection, hover and table cell before opening Inspect', () => {
    const tableCell: TableCellRef = {
      page: 1,
      tableIndex: 0,
      row: 1,
      col: 2,
      bbox: { x0: 0, y0: 0, x1: 5, y1: 5 },
    };
    usePdfStore.setState({
      selectedObject: selectedRect,
      hoveredObject: selectedRect,
      selectedTableCell: tableCell,
      hoveredTableCell: tableCell,
    });
    render(React.createElement(AnnotationsTab));

    fireEvent.click(screen.getByRole('button', { name: /Go to page 3/ }));

    // Mirrors the canvas path: one selection at a time, so the object gold
    // highlight and the hover preview cannot outlive the annotation selection.
    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBeNull();
    expect(pdf.hoveredObject).toBeNull();
    expect(pdf.selectedTableCell).toBeNull();
    expect(pdf.hoveredTableCell).toBeNull();
    expect(useAnnotationStore.getState().selected?.id).toBe('1:link-b');
  });

  it('binds the Show boxes toggle to the annotation store', () => {
    render(React.createElement(AnnotationsTab));

    const toggle = screen.getByRole('checkbox', { name: 'Show boxes' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);

    expect(useAnnotationStore.getState().showBoxes).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: 'Show boxes' }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('shows a loading state while the annotations of a known page are pending', () => {
    useAnnotationStore.setState({ page: null, annotations: [], loading: true });
    render(React.createElement(AnnotationsTab));
    expect(screen.getByRole('status').textContent).toBe('Loading annotations…');

    // Geometry is known but the store has not caught up with the page yet.
    cleanup();
    useAnnotationStore.setState({ page: null, annotations: [], loading: false });
    render(React.createElement(AnnotationsTab));
    expect(screen.getByRole('status').textContent).toBe('Loading annotations…');
  });

  it('keeps loading while the page data is still being extracted', () => {
    usePdfStore.setState({ pageData: null, isLoading: true });
    useAnnotationStore.setState({ page: null, annotations: [], loading: false });
    render(React.createElement(AnnotationsTab));

    expect(screen.getByRole('status').textContent).toBe('Loading annotations…');
    expect(screen.queryByText('Page geometry unavailable; annotations need page data.')).toBeNull();
  });

  it('explains that annotations need page data instead of loading forever', () => {
    // Extraction finished without page data (e.g. an old sidecar or a failed
    // load that was already reported): there is nothing to retry here.
    usePdfStore.setState({ pageData: null, isLoading: false, error: null });
    useAnnotationStore.setState({ page: null, annotations: [], loading: false });
    render(React.createElement(AnnotationsTab));

    expect(
      screen.getByText('Page geometry unavailable; annotations need page data.'),
    ).toBeTruthy();
    expect(screen.queryByText('Loading annotations…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry page load' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('explains a page without MediaBox geometry', () => {
    usePdfStore.setState({ pageData: pageDataWithoutBoxes, isLoading: false, error: null });
    useAnnotationStore.setState({ page: null, annotations: [], loading: false });
    render(React.createElement(AnnotationsTab));

    expect(
      screen.getByText('Page geometry unavailable; annotations need page data.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry page load' })).toBeNull();
  });

  it('retries the page extraction when page data failed to load', () => {
    usePdfStore.setState({
      pageData: null,
      isLoading: false,
      error: 'Failed to load page data. Please try again.',
    });
    useAnnotationStore.setState({ page: null, annotations: [], loading: false });
    render(React.createElement(AnnotationsTab));

    expect(
      screen.getByText('Page geometry unavailable; annotations need page data.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry page load' }));

    // Recovery is a guarded re-extraction of the current page, not an
    // annotation-store reload that would stay blocked on the missing boxes.
    expect(navigate).toHaveBeenCalledWith(1);
    expect(useAnnotationStore.getState().reloadKey).toBe(0);
  });

  it('surfaces a load error and retries through the store', () => {
    useAnnotationStore.setState({ page: 1, annotations: [], error: 'annotations unavailable' });
    render(React.createElement(AnnotationsTab));

    expect(screen.getByRole('alert').textContent).toContain('annotations unavailable');
    const before = useAnnotationStore.getState().reloadKey;

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(useAnnotationStore.getState().reloadKey).toBe(before + 1);
  });

  it('reports an empty page', () => {
    useAnnotationStore.getState().setPageData(1, []);
    render(React.createElement(AnnotationsTab));

    expect(screen.getByRole('status').textContent).toBe('No annotations on page 1.');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('asks for a document instead of showing a stale list', () => {
    usePdfStore.setState({ filePath: null });
    render(React.createElement(AnnotationsTab));

    expect(screen.getByText('Open a PDF to inspect annotations.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('defaults to the current page and offers the document scope', () => {
    render(React.createElement(AnnotationsTab));

    const scope = screen.getByRole('group', { name: 'Annotation scope' });
    const pageButton = within(scope).getByRole('button', { name: 'Current page' });
    const documentButton = within(scope).getByRole('button', { name: 'Whole document' });

    expect(pageButton.getAttribute('aria-pressed')).toBe('true');
    expect(documentButton.getAttribute('aria-pressed')).toBe('false');
    // Opening the tab must not start a document index.
    expect(buildMock).not.toHaveBeenCalled();
    expect(currentList()).toBeTruthy();
  });
});

describe('AnnotationsTab whole document mode', () => {
  afterEach(cleanup);

  beforeEach(() => {
    reset();
    useAnnotationStore.getState().setPageData(1, allAnnotations);
  });

  it('indexes the document, reports progress and lists the result', async () => {
    let report: ((done: number, total: number) => void) | null = null;
    const pending = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementation(async (_doc, _pages, options) => {
      report = options?.onProgress ?? null;
      return pending.promise;
    });

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    expect(buildMock).toHaveBeenCalledWith(pdfDoc, 3, expect.anything());
    expect(screen.getByRole('status').textContent).toBe('Indexing annotations 0/3…');

    act(() => report?.(3, 3));
    expect(screen.getByRole('status').textContent).toBe('Indexing annotations 3/3…');

    await act(async () => {
      pending.resolve(documentResult);
    });

    expect(screen.getByRole('status').textContent).toBe(
      '2 annotations · 2 pages · 1 link · 0 form fields',
    );

    const list = documentList();
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(within(list).getByText('p.2')).toBeTruthy();
    expect(within(list).getByText('p.3')).toBeTruthy();
    expect(within(list).getByText('https://example.com/b')).toBeTruthy();
    expect(within(list).getByText('Please review the invoice')).toBeTruthy();

    // The box overlay is a current-page feature: document rows only navigate.
    expect(screen.queryByRole('checkbox', { name: 'Show boxes' })).toBeNull();
  });

  it('filters and searches the whole document', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'note' },
    });

    // Document filters live in the index store, not in the page store.
    expect(useAnnotationIndexStore.getState().kindFilter).toBe('note');
    expect(useAnnotationStore.getState().kindFilter).toBe('all');
    expect(within(documentList()).getAllByRole('button')).toHaveLength(1);
    expect(within(documentList()).getByText('Please review the invoice')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'all' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'INVOICE' },
    });

    expect(useAnnotationIndexStore.getState().query).toBe('INVOICE');
    expect(within(documentList()).getAllByRole('button')).toHaveLength(1);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'nothing matches this' },
    });

    expect(screen.getByText('No annotations match the current filters.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('filters the document by the raw subtypes it contains', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    const subtypeSelect = screen.getByRole('combobox', { name: 'Subtype' });
    expect(
      within(subtypeSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All subtypes', 'Link', 'Text']);

    fireEvent.change(subtypeSelect, { target: { value: 'Link' } });

    expect(useAnnotationIndexStore.getState().subtypeFilter).toBe('Link');
    expect(within(documentList()).getAllByRole('button')).toHaveLength(1);
  });

  it('jumps to the page of a row and asks for its annotation to be selected', async () => {
    const tableCell: TableCellRef = {
      page: 1,
      tableIndex: 0,
      row: 1,
      col: 2,
      bbox: { x0: 0, y0: 0, x1: 5, y1: 5 },
    };
    usePdfStore.setState({
      selectedObject: selectedRect,
      hoveredObject: selectedRect,
      selectedTableCell: tableCell,
      hoveredTableCell: tableCell,
    });
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /https:\/\/example\.com\/b/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(2));
    // The page's annotations are not loaded yet, so the id is remembered and
    // one reload pass is asked for to apply it.
    await waitFor(() =>
      expect(useAnnotationStore.getState().pendingSelectionId).toBe('2:link-e'),
    );
    expect(useAnnotationStore.getState().reloadKey).toBe(1);

    const pdf = usePdfStore.getState();
    expect(pdf.selectedObject).toBeNull();
    expect(pdf.hoveredObject).toBeNull();
    expect(pdf.selectedTableCell).toBeNull();
    expect(pdf.hoveredTableCell).toBeNull();
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');

    // The loader applies the request as soon as the page arrives.
    act(() => {
      useAnnotationStore.getState().setPageData(2, [pageTwoLink]);
    });
    expect(useAnnotationStore.getState().selected?.id).toBe('2:link-e');
    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
  });

  it('selects a document row that is already on the current page without navigating', async () => {
    buildMock.mockResolvedValue(resultWith([externalLink]));

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.click(within(documentList()).getByRole('button', { name: /https:\/\/example\.com\/a/ }));

    expect(navigate).not.toHaveBeenCalled();
    expect(useAnnotationStore.getState().selected?.id).toBe('1:link-a');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
  });

  it('surfaces an index error and rebuilds it on retry', async () => {
    buildMock
      .mockRejectedValueOnce(new Error('Annotation index failed on page 2: boom'))
      .mockResolvedValueOnce(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(documentList()).toBeTruthy());
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(useAnnotationIndexStore.getState().error).toBeNull();
  });

  it('keeps indexing when the user goes back to the current page', async () => {
    const pending = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementation(async () => pending.promise);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Current page' }));

    // The current page list is back, and the run was not cancelled: switching
    // scope is not the same gesture as closing the document.
    expect(currentList()).toBeTruthy();
    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(useAnnotationIndexStore.getState().status).toBe('indexing');

    await act(async () => {
      pending.resolve(documentResult);
    });

    switchToDocument();

    expect(documentList()).toBeTruthy();
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the document before it can index it', () => {
    usePdfStore.setState({ pageCount: 0, pdfDocRef: null });

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    expect(screen.getByRole('status').textContent).toBe('Waiting for the document to load…');
    expect(buildMock).not.toHaveBeenCalled();
  });

  it('reports a document without annotations', async () => {
    buildMock.mockResolvedValue(emptyDocumentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    await waitFor(() => expect(screen.getByText('No annotations in this document.')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toBe(
      '0 annotations · 0 pages · 0 links · 0 form fields',
    );
    expect(screen.queryByRole('searchbox', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('windows document rows instead of painting the whole index', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    const rows = within(documentList()).getAllByRole('button');
    const rowClass = rows[0].parentElement?.className ?? '';
    expect(rowClass).not.toBe('');
    expect(rows[1].parentElement?.className).toBe(rowClass);

    // The row class is where the CSS windowing is defined.
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/components/LeftPanel/AnnotationsTab.module.css'),
      'utf8',
    );
    const itemRule = css.match(/\.documentItem\s*\{[^}]*\}/)?.[0] ?? '';
    expect(itemRule).toContain('content-visibility: auto');
    expect(itemRule).toContain('contain-intrinsic-size');
  });
});

describe('AnnotationsTab document health check', () => {
  afterEach(cleanup);

  beforeEach(() => {
    reset();
    useAnnotationStore.getState().setPageData(1, allAnnotations);
  });

  it('opens the issues block and keeps external links in a collapsed one', async () => {
    buildMock.mockResolvedValue(healthResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

    const issues = screen.getByLabelText('Issues');
    expect(issues.tagName).toBe('DETAILS');
    expect((issues as HTMLDetailsElement).open).toBe(true);
    // Non-external only: 2 link problems + 3 form issues.
    expect(within(issues).getByText('5')).toBeTruthy();

    // One badge per issue kind.
    for (const badge of [
      'unresolved',
      'unsafe',
      'unnamed',
      'conflicting-type',
      'duplicate-name',
    ]) {
      expect(within(issues).getByText(badge)).toBeTruthy();
    }
    // External links are an inventory, not an issue.
    expect(within(issues).queryByText('external')).toBeNull();

    expect(within(issues).getByText('Link has no external URL and no resolved page')).toBeTruthy();
    expect(
      within(issues).getByText('Link uses an unsafe target scheme: javascript:alert(1)'),
    ).toBeTruthy();
    expect(within(issues).getByText('Form widget has no field name')).toBeTruthy();
    expect(within(issues).getByText('Field "amount" appears on 2 pages')).toBeTruthy();
    expect(within(issues).getByText('Field "amount" uses conflicting types (Ch, Tx)')).toBeTruthy();

    // A link issue shows its page, a form issue every page the field spans.
    expect(within(issues).getByText('p.5')).toBeTruthy();
    expect(within(issues).getByText('p.3')).toBeTruthy();
    expect(within(issues).getByText('p.6')).toBeTruthy();
    expect(within(issues).getAllByText('p.2, p.4')).toHaveLength(2);
    expect(within(issues).getByText('1 widget')).toBeTruthy();
    expect(within(issues).getAllByText('2 widgets')).toHaveLength(2);

    // Every issue is jumpable.
    expect(
      within(issues).getAllByRole('button', { name: /^Go to page \d+$/ }),
    ).toHaveLength(5);

    const external = screen.getByLabelText('External links');
    expect(external.tagName).toBe('DETAILS');
    expect((external as HTMLDetailsElement).open).toBe(false);
    expect(within(external).getByText('1')).toBeTruthy();
    expect(within(external).getByText('https://example.com/ext')).toBeTruthy();
    expect(within(external).getByRole('button', { name: 'Go to page 1' })).toBeTruthy();
    // Nothing is opened by listing it: the target stays a link row.
    expect(within(external).queryByRole('link')).toBeNull();
  });

  it('jumps to the page of a link issue and asks for its annotation to be selected', async () => {
    buildMock.mockResolvedValue(
      resultWithIssues([unresolvedPageFiveLink], [unresolvedIssue], []),
    );

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

    fireEvent.click(
      within(screen.getByLabelText('Issues')).getByRole('button', { name: 'Go to page 5' }),
    );

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(5));
    // Same path as a document row: the page loader applies the pending id.
    await waitFor(() =>
      expect(useAnnotationStore.getState().pendingSelectionId).toBe('5:link-unresolved'),
    );
    expect(useAnnotationStore.getState().reloadKey).toBe(1);
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');

    act(() => {
      useAnnotationStore.getState().setPageData(5, [unresolvedPageFiveLink]);
    });
    expect(useAnnotationStore.getState().selected?.id).toBe('5:link-unresolved');
    expect(useAnnotationStore.getState().pendingSelectionId).toBeNull();
  });

  it('keeps two unnamed widgets on one page as two distinct issue rows', async () => {
    // Identical kind, field name and page list: only the widget id differs, so
    // the row key has to include it.
    const namelessWidgets: PdfAnnotation[] = [
      widgetOn('1:widget-anon-a', 1, null, 'Tx'),
      widgetOn('1:widget-anon-b', 1, null, 'Btn'),
    ];
    const namelessIssues: AnnotationFormIssue[] = namelessWidgets.map((annotation) => {
      const fieldType = annotation.form?.fieldType ?? null;
      return {
        annotationId: annotation.id,
        fieldName: null,
        pages: [1],
        fieldTypes: fieldType === null ? [] : [fieldType],
        widgetCount: 1,
        kind: 'unnamed',
        message: 'Form widget has no field name',
      };
    });
    buildMock.mockResolvedValue(resultWithIssues(namelessWidgets, [], namelessIssues));

    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });

    try {
      render(React.createElement(AnnotationsTab));
      switchToDocument();
      await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

      const issues = screen.getByLabelText('Issues');
      // Two widgets, two issues: the count stays one per widget.
      expect(within(issues).getByText('2')).toBeTruthy();
      expect(within(issues).getAllByText('unnamed')).toHaveLength(2);
      expect(within(issues).getAllByText('Form widget has no field name')).toHaveLength(2);
      expect(within(issues).getAllByText('1 widget')).toHaveLength(2);
      expect(within(issues).getAllByText('p.1')).toHaveLength(2);
      expect(within(issues).getAllByRole('button', { name: 'Go to page 1' })).toHaveLength(2);
      expect(within(issues).getAllByRole('listitem')).toHaveLength(2);

      // React reports colliding keys through console.error; a correct key set
      // leaves the render free of that warning.
      expect(errors.filter((message) => /same key|keys? .*unique/i.test(message))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('jumps to the first page of a form issue without selecting an annotation', async () => {
    buildMock.mockResolvedValue(resultWithIssues(amountWidgets, [], [conflictingTypeIssue]));

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

    fireEvent.click(
      within(screen.getByLabelText('Issues')).getByRole('button', { name: 'Go to page 2' }),
    );

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(2));
    expect(navigate).toHaveBeenCalledTimes(1);

    // A field grouping has no single widget to select, so the jump only moves.
    const store = useAnnotationStore.getState();
    expect(store.selected).toBeNull();
    expect(store.pendingSelectionId).toBeNull();
    expect(store.reloadKey).toBe(0);
  });

  it('reports a document without link or form issues', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

    const issues = screen.getByLabelText('Issues');
    expect((issues as HTMLDetailsElement).open).toBe(true);
    expect(within(issues).getByText('0')).toBeTruthy();
    expect(within(issues).getByText('No link or form issues found.')).toBeTruthy();
    expect(within(issues).queryAllByRole('button')).toHaveLength(0);

    // Zero external links means no external list at all.
    expect(screen.queryByLabelText('External links')).toBeNull();
  });

  it('leaves an empty document without health sections', async () => {
    buildMock.mockResolvedValue(emptyDocumentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    await waitFor(() => expect(screen.getByText('No annotations in this document.')).toBeTruthy());
    expect(screen.queryByLabelText('Issues')).toBeNull();
    expect(screen.queryByLabelText('External links')).toBeNull();
  });

  it('only shows the health sections in the whole-document list', async () => {
    buildMock.mockResolvedValue(healthResult);

    render(React.createElement(AnnotationsTab));
    expect(screen.queryByLabelText('Issues')).toBeNull();
    expect(currentList()).toBeTruthy();

    switchToDocument();
    await waitFor(() => expect(screen.getByLabelText('Issues')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Current page' }));

    // The current-page list never claims document-wide health.
    expect(screen.queryByLabelText('Issues')).toBeNull();
    expect(screen.queryByLabelText('External links')).toBeNull();
    expect(currentList()).toBeTruthy();
  });

  it('styles the health blocks to stay inside the narrow panel', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/components/LeftPanel/AnnotationsTab.module.css'),
      'utf8',
    );
    const rule = (selector: string): string =>
      css.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';

    expect(rule('issues')).toContain('min-width: 0');
    expect(rule('issueHeader')).toContain('flex-wrap: wrap');
    expect(rule('issueMessage')).toContain('overflow-wrap: anywhere');
    expect(rule('issueTarget')).toContain('overflow-wrap: anywhere');
    expect(rule('issueList')).toContain('overflow-y: auto');
    expect(rule('issueWarning')).toContain('var(--pi-warning)');
    expect(rule('issueInfo')).toContain('var(--pi-info-strong)');
    // Badges are the small pill from the row header.
    expect(rule('badge')).toContain('font-size: 9px');
    expect(rule('issueCount')).toContain('font-size: 9px');
  });
});

describe('AnnotationsTab annotation export', () => {
  afterEach(cleanup);

  beforeEach(() => {
    reset();
    useAnnotationStore.getState().setPageData(1, allAnnotations);
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });
  });

  it('only offers the export button in whole-document mode', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();

    switchToDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Current page' }));

    // The current page list has no document payload to export.
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(currentList()).toBeTruthy();
  });

  it('hides the export button until the index is ready', async () => {
    const pending = deferred<AnnotationIndexResult | null>();
    buildMock.mockImplementation(async () => pending.promise);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));

    // Nothing to serialize while the document is still being read.
    expect(screen.getByRole('status').textContent).toBe('Indexing annotations 0/3…');
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();

    await act(async () => {
      pending.resolve(documentResult);
    });

    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('shows no export button for a failed index', async () => {
    buildMock.mockRejectedValue(new Error('Annotation index failed on page 2: boom'));

    render(React.createElement(AnnotationsTab));
    switchToDocument();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('exports the indexed document as JSON from the dialog', async () => {
    usePdfStore.setState({
      documentName: '报告.pdf',
      sourceUrl: 'https://example.com/报告.pdf',
    });
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The display name wins over the local path the tab also knows.
    expect((within(dialog).getByLabelText('File name') as HTMLInputElement).value).toBe(
      '报告-annotations.json',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];
    expect(request.defaultPath).toBe('报告-annotations.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);

    const parsed = JSON.parse(request.content);
    expect(parsed.document).toEqual({
      name: '报告.pdf',
      sourceUrl: 'https://example.com/报告.pdf',
      pages: 3,
    });
    expect(parsed.summary).toEqual(documentResult.summary);
    expect(parsed.pages.map((group: { page: number }) => group.page)).toEqual([2, 3]);
    // The local path stays out of the payload.
    expect(request.content).not.toContain('/docs/doc.pdf');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('exports the indexed document as CSV from the dialog', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = screen.getByRole('dialog');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'CSV' }));
    expect((within(dialog).getByLabelText('File name') as HTMLInputElement).value).toBe(
      'doc-annotations.csv',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];
    expect(request.defaultPath).toBe('doc-annotations.csv');
    expect(request.filterName).toBe('CSV');
    expect(request.extensions).toEqual(['csv']);
    expect(request.content.startsWith('\uFEFF# annotations\n')).toBe(true);
    expect(request.content).toContain('2,Link,link,"0,0,10,10",false,,,https://example.com/b,,,,');
  });

  it('closes the export dialog on cancel without saving', async () => {
    buildMock.mockResolvedValue(documentResult);

    render(React.createElement(AnnotationsTab));
    switchToDocument();
    await waitFor(() => expect(documentList()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saveFile).not.toHaveBeenCalled();
    expect(documentList()).toBeTruthy();
  });

  it('styles the export row to stay inside the narrow panel', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/components/LeftPanel/AnnotationsTab.module.css'),
      'utf8',
    );
    const rule = (selector: string): string =>
      css.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';

    expect(rule('exportRow')).toContain('flex: 0 0 auto');
    expect(rule('exportRow')).toContain('justify-content: flex-end');
    expect(rule('exportButton')).toContain('font-size: 10px');
  });
});

describe('annotation tab helpers', () => {
  it('prefers the link target, then the form field, then the annotation text', () => {
    expect(annotationRowPreview(externalLink)).toBe('https://example.com/a');
    expect(annotationRowPreview({ ...externalLink, link: null, title: 'Title', contents: 'Body' })).toBe(
      'Title — Body',
    );
    expect(
      annotationRowPreview({
        ...externalLink,
        link: { url: null, unsafeUrl: 'javascript:alert(1)', internalPage: null, newWindow: false },
      }),
    ).toBe('javascript:alert(1)');
    expect(annotationRowPreview(widget)).toBe('name = John');
    expect(
      annotationRowPreview({
        ...externalLink,
        kind: 'other',
        subtype: 'FileAttachment',
        link: null,
        contents: 'attachment.pdf',
      }),
    ).toBe('attachment.pdf');
  });

  it('counts links and form fields inside the summary', () => {
    expect(annotationSummary(allAnnotations, allAnnotations, false)).toBe(
      '4 annotations · 2 links · 1 form field',
    );
    expect(annotationSummary(allAnnotations, [widget], true)).toBe(
      '1 of 4 annotations · 0 links · 1 form field',
    );
    expect(annotationSummary([externalLink], [externalLink], false)).toBe(
      '1 annotation · 1 link · 0 form fields',
    );
  });

  it('summarises the whole document from the index counts', () => {
    expect(documentAnnotationSummary(documentResult.summary)).toBe(
      '2 annotations · 2 pages · 1 link · 0 form fields',
    );
    expect(documentAnnotationSummary(EMPTY_SUMMARY)).toBe(
      '0 annotations · 0 pages · 0 links · 0 form fields',
    );
    expect(
      documentAnnotationSummary({
        ...EMPTY_SUMMARY,
        annotations: 1,
        pagesWithAnnotations: 1,
        formFields: 1,
      }),
    ).toBe('1 annotation · 1 page · 0 links · 1 form field');
  });

  it('counts every non-external issue and labels the pages they span', () => {
    // Two link problems + three form issues; the external link is not an issue.
    expect(documentIssueCount(healthResult.linkIssues, healthResult.formIssues)).toBe(5);
    expect(externalLinkCount(healthResult.linkIssues)).toBe(1);
    expect(documentIssueCount([externalIssue], [])).toBe(0);
    expect(externalLinkCount([])).toBe(0);

    expect(issuePagesLabel([2, 4])).toBe('p.2, p.4');
    expect(issuePagesLabel([3])).toBe('p.3');
    expect(issuePagesLabel([])).toBe('');
  });
});
