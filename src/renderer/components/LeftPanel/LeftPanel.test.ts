// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PdfAnnotation } from '../../types/annotations';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { LeftPanel } from './LeftPanel';

const annotationBase = {
  page: 2,
  rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
} as const;

const linkAnnotation: PdfAnnotation = {
  ...annotationBase,
  id: '2:link',
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com',
    unsafeUrl: 'https://example.com',
    internalPage: null,
    newWindow: false,
  },
};

const widgetAnnotation: PdfAnnotation = {
  ...annotationBase,
  id: '2:widget',
  subtype: 'Widget',
  kind: 'form',
  form: {
    fieldName: 'field',
    fieldType: 'Tx',
    value: 'value',
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

beforeEach(() => {
  navigate.mockReset();
  useI18nStore.setState({ locale: 'en' });
  usePdfStore.setState({
    filePath: null,
    metadata: null,
    pageCount: 0,
    outline: null,
    pdfDocRef: null,
    pageData: null,
    fontStats: null,
    fontProgress: null,
    error: null,
    isLoading: false,
  });
  useWorkspaceStore.setState({ leftTab: 'objects', overlayOpacity: 1 });
  useAnnotationStore.getState().clear();
  useAnnotationStore.setState({
    kindFilter: 'all',
    subtypeFilter: 'all',
    showBoxes: true,
  });
});

afterEach(cleanup);

describe('LeftPanel', () => {

  it('switches between Objects and Outline tabs', () => {
    render(React.createElement(LeftPanel));

    expect(screen.getByRole('tab', { name: 'Objects' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));

    expect(screen.getByRole('tab', { name: 'Outline' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('No bookmarks found in this document.')).toBeTruthy();
  });

  it('resolves a named destination and delegates page loading to guarded navigation', async () => {
    const pdfDoc = {
      numPages: 10,
      getDestination: vi.fn().mockResolvedValue([{ num: 12, gen: 0 }]),
      getPageIndex: vi.fn().mockResolvedValue(2),
    };
    usePdfStore.setState({
      pageCount: 10,
      pdfDocRef: pdfDoc as any,
      outline: [{ title: 'Chapter 3', bold: false, italic: false, dest: 'chapter-three', items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chapter 3' }));

    await waitFor(() => expect(pdfDoc.getDestination).toHaveBeenCalledWith('chapter-three'));
    expect(pdfDoc.getPageIndex).toHaveBeenCalledWith({ num: 12, gen: 0 });
    expect(navigate).toHaveBeenCalledWith(3);
  });

  it('resolves an explicit destination and delegates page loading to guarded navigation', async () => {
    const pageRef = { num: 5, gen: 0 };
    const pdfDoc = {
      numPages: 10,
      getDestination: vi.fn(),
      getPageIndex: vi.fn().mockResolvedValue(4),
    };
    usePdfStore.setState({
      pageCount: 10,
      pdfDocRef: pdfDoc as any,
      outline: [{ title: 'Appendix', bold: false, italic: false, dest: [pageRef], items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Appendix' }));

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalledWith(pageRef));
    expect(pdfDoc.getDestination).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(5);
  });

  it('does not resolve malformed empty-array destinations', () => {
    const pdfDoc = {
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    };
    usePdfStore.setState({
      pdfDocRef: pdfDoc as any,
      outline: [{ title: 'Broken bookmark', bold: false, italic: false, dest: [], items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Broken bookmark' }));

    expect(pdfDoc.getPageIndex).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a warning instead of rendering an oversized outline', () => {
    usePdfStore.setState({
      outline: Array.from({ length: 2001 }, (_, index) => ({
        title: `Bookmark ${index + 1}`,
        bold: false,
        italic: false,
        dest: null,
        items: [],
      })),
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));

    expect(screen.getByText('This document has 2001 bookmarks. The outline is too large to display.')).toBeTruthy();
  });

  // The Fonts tab runs a batched analysis whose cleanup cancels the run, so it
  // must be mounted lazily (never before the first visit) and then kept alive
  // while the user navigates other tabs.
  it('mounts the Fonts tab on first visit and keeps it mounted across tab switches', () => {
    render(React.createElement(LeftPanel));

    const fontsHint = 'Open a PDF to analyze fonts.';
    expect(screen.queryByText(fontsHint)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Fonts' }));

    const hint = screen.getByText(fontsHint);
    expect(hint.closest('[hidden]')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }));

    // Still mounted, but inside the hidden wrapper: no remount, so an in-flight
    // analysis keeps running instead of restarting from page 1.
    const hiddenHint = screen.getByText(fontsHint);
    expect(hiddenHint).toBe(hint);
    const hiddenWrapper = hiddenHint.closest('[hidden]');
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Objects' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    expect(screen.getByText(fontsHint)).toBe(hint);
    expect(hint.closest('[hidden]')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    expect(screen.getByText(fontsHint)).toBe(hint);
    expect(hint.closest('[hidden]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Fonts' }));
    expect(screen.getByText(fontsHint)).toBe(hint);
    expect(hint.closest('[hidden]')).toBeNull();

    // Tab semantics survive the extra wrapper.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Objects',
      'Outline',
      'Fonts',
      'Layers',
      'Annots',
    ]);
    expect(screen.getByRole('tab', { name: 'Fonts' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });

  it('mounts the Layers panel up front and hides it while another tab is active', () => {
    render(React.createElement(LeftPanel));

    // Mounted eagerly (like Fonts, but without a first-visit gate) so the
    // component-local Solo state is never thrown away.
    const allButton = screen.getByRole('button', { name: 'All', hidden: true });
    expect(allButton.closest('[hidden]')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));

    expect(screen.getByRole('button', { name: 'All' }).closest('[hidden]')).toBeNull();
    expect(useWorkspaceStore.getState().leftTab).toBe('layers');
  });

  it('keeps a Solo selection and its snapshot across tab switches', () => {
    const beforeSolo = { ...usePdfStore.getState().overlayVisibility };
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Solo Words' }));
    expect(usePdfStore.getState().overlayVisibility.word).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Solo Words' }).getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }));

    // Still mounted inside the hidden wrapper, still Soloed.
    const hiddenSolo = screen.getByRole('button', { name: 'Solo Words', hidden: true });
    expect(hiddenSolo.closest('[hidden]')).not.toBeNull();
    expect(hiddenSolo.getAttribute('aria-pressed')).toBe('true');
    expect(
      Object.entries(usePdfStore.getState().overlayVisibility)
        .filter(([, visible]) => visible)
        .map(([type]) => type),
    ).toEqual(['word']);

    fireEvent.click(screen.getByRole('tab', { name: 'Layers' }));

    const restoredSolo = screen.getByRole('button', { name: 'Solo Words' });
    expect(restoredSolo.getAttribute('aria-pressed')).toBe('true');

    // The pre-Solo snapshot survived too, so turning Solo off restores it.
    fireEvent.click(restoredSolo);
    expect(usePdfStore.getState().overlayVisibility).toEqual(beforeSolo);
    expect(
      screen.getByRole('button', { name: 'Solo Words' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('offers a header button that hides the panel without breaking tab semantics', () => {
    useWorkspaceStore.setState({ leftCollapsed: false });
    render(React.createElement(LeftPanel));

    // The tablist must stay a flat list of tabs: the collapse button lives in
    // the surrounding row, not inside `role="tablist"`.
    const tablist = screen.getByRole('tablist');
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(5);
    expect(within(tablist).queryByRole('button', { name: 'Hide left panel' })).toBeNull();

    const collapse = screen.getByRole('button', { name: 'Hide left panel' });
    expect(collapse.getAttribute('title')).toBe('Hide left panel');

    fireEvent.click(collapse);
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Hide left panel' }));
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(false);
  });

  it('adds an Annots tab that selects rows and survives tab switches', () => {
    usePdfStore.setState({
      filePath: '/docs/doc.pdf',
      currentPage: 2,
      // Annotations are normalized against the MediaBox, so the page geometry
      // has to be present for the list to render at all.
      pageData: {
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
      },
      isLoading: false,
      error: null,
    });
    useAnnotationStore.getState().setPageData(2, [linkAnnotation, widgetAnnotation]);
    render(React.createElement(LeftPanel));

    // Mounted from the start inside the hidden wrapper, exactly like Layers.
    const kindSelect = screen.getByRole('combobox', { name: 'Kind', hidden: true });
    expect(kindSelect.closest('[hidden]')).not.toBeNull();

    const annotsTab = screen.getByRole('tab', { name: 'Annots' });
    // The short visible label keeps the tooltip as the full name.
    expect(annotsTab.getAttribute('title')).toBe('Annotations');
    fireEvent.click(annotsTab);

    expect(annotsTab.getAttribute('aria-selected')).toBe('true');
    expect(useWorkspaceStore.getState().leftTab).toBe('annotations');
    expect(kindSelect.closest('[hidden]')).toBeNull();
    expect(screen.getByText('2 annotations · 1 link · 1 form field')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'form' },
    });
    expect(useAnnotationStore.getState().kindFilter).toBe('form');

    const row = screen.getByRole('button', { name: /field = value/ });
    fireEvent.click(row);

    expect(useAnnotationStore.getState().selected?.id).toBe('2:widget');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');
    expect(
      screen.getByRole('button', { name: /field = value/ }).getAttribute('aria-pressed'),
    ).toBe('true');

    // Switching away keeps the panel (and its filter, selection and rows)
    // mounted in the hidden wrapper instead of rebuilding them on return.
    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }));
    const hiddenKind = screen.getByRole('combobox', {
      name: 'Kind',
      hidden: true,
    }) as HTMLSelectElement;
    expect(hiddenKind).toBe(kindSelect);
    expect(hiddenKind.value).toBe('form');
    expect(hiddenKind.closest('[hidden]')).not.toBeNull();
    expect(useAnnotationStore.getState().selected?.id).toBe('2:widget');

    fireEvent.click(screen.getByRole('tab', { name: 'Annots' }));
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBe(kindSelect);
    expect(
      screen.getByRole('button', { name: /field = value/ }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('LeftPanel localization', () => {
  it('translates the tab labels, the Annots tooltip and the collapse control', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(LeftPanel));

    expect(screen.getByRole('complementary', { name: '文档导航' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: '文档导航标签页' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '对象',
      '大纲',
      '字体',
      '图层',
      '注释',
    ]);
    // Chinese "注释" fits the tab, so the label and its tooltip agree.
    expect(screen.getByRole('tab', { name: '注释' }).getAttribute('title')).toBe('注释');
    expect(screen.getByRole('button', { name: '隐藏左侧面板' }).getAttribute('title')).toBe(
      '隐藏左侧面板',
    );
  });

  it('translates the empty Objects and Outline panes', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(LeftPanel));

    expect(screen.getByText('打开 PDF 以查看其结构。')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '大纲' }));

    expect(screen.getByText('此文档没有书签。')).toBeTruthy();
  });

  it('keeps document-provided bookmark titles while translating the outline chrome', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    usePdfStore.setState({
      outline: [{ title: 'Chapter 3', bold: false, italic: false, dest: null, items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: '大纲' }));

    expect(screen.getByRole('navigation', { name: 'PDF 书签' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chapter 3' })).toBeTruthy();
  });

  it('translates the oversized-outline warning', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    usePdfStore.setState({
      outline: Array.from({ length: 2001 }, (_, index) => ({
        title: `Bookmark ${index + 1}`,
        bold: false,
        italic: false,
        dest: null,
        items: [],
      })),
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: '大纲' }));

    expect(screen.getByText('此文档有 2001 个书签，大纲过大，无法显示。')).toBeTruthy();
  });

  it('returns to English without a reload', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(LeftPanel));
    expect(screen.getByRole('tab', { name: '对象' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('tab', { name: 'Objects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide left panel' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Document navigation' })).toBeTruthy();
  });
});
