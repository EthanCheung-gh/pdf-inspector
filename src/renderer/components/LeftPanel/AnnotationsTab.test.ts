// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore, type TableCellRef } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageData, PdfRect } from '../../types/pdf-objects';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { AnnotationsTab, annotationRowPreview, annotationSummary } from './AnnotationsTab';

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

const reset = (): void => {
  navigate.mockReset();
  useAnnotationStore.getState().clear();
  useAnnotationStore.setState({
    kindFilter: 'all',
    subtypeFilter: 'all',
    showBoxes: true,
    reloadKey: 0,
  });
  usePdfStore.setState({
    filePath: '/docs/doc.pdf',
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
});
