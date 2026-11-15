// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditReport,
  type AuditDocumentInfo,
  type AuditFinding,
  type AuditReport,
} from '../../../shared/audit-types';
import type { AnnotationIndexResult } from '../../services/annotation-index';
import type { PdfAnnotation } from '../../types/annotations';
import type { ThumbnailDocument } from '../../services/page-thumbnails';

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn<(page: number) => Promise<void>>(),
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { PageOverview } from './PageOverview';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { useAuditStore } from '../../store/audit-store';
import { useI18nStore } from '../../i18n/store';
import { usePageOverviewStore } from '../../store/page-overview-store';
import { usePdfStore } from '../../store/pdf-store';

const PDF_DOCUMENT = {} as ThumbnailDocument;

const makeLoader = () => ({
  load: vi.fn(
    async (_document: ThumbnailDocument, page: number) => `data:image/jpeg;base64,${page}`,
  ),
});

type Loader = ReturnType<typeof makeLoader>;

const show = (loader: Loader = makeLoader()): Loader => {
  render(React.createElement(PageOverview, { loader }));
  return loader;
};

const card = (page: number): HTMLElement =>
  screen.getByRole('button', { name: `Page ${page}` });

/** A card by page number, independent of its (marker-carrying) accessible name. */
const cardByPage = (page: number): HTMLElement | null =>
  screen.getByTestId('page-overview-grid').querySelector<HTMLElement>(`[data-page="${page}"]`);

/** Badge texts of one card, in contract order. */
const badgesOf = (page: number): string[] => {
  const element = cardByPage(page);
  if (!element) return [];
  return Array.from(element.querySelectorAll('[data-testid^="page-marker-"]'), (badge) =>
    (badge.textContent ?? '').trim(),
  );
};

// --- Audit/annotation fixtures --------------------------------------------

const TOOL = { name: 'pdf-inspector', version: '0.0.0-test' };

function makeDocument(overrides: Partial<AuditDocumentInfo> = {}): AuditDocumentInfo {
  return {
    pages: 5,
    version: '1.7',
    encrypted: false,
    title: 'Overview fixture',
    author: null,
    producer: 'pdf-inspector tests',
    language: 'en-US',
    tagged: true,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    category: 'pages',
    severity: 'info',
    page: null,
    title: 'Finding',
    detail: 'Finding detail.',
    evidence: null,
    recommendation: null,
    ...overrides,
  };
}

/**
 * The open document's audit report: one error on page 1, two warnings on page 2,
 * one info on page 3, plus one warning that belongs to the whole document (it
 * must never be drawn on page 1).
 */
const REPORT_FINDINGS: AuditFinding[] = [
  makeFinding({ severity: 'error', page: 1, title: 'Missing fonts' }),
  makeFinding({ severity: 'warning', page: 2, title: 'Low resolution image' }),
  makeFinding({ severity: 'warning', page: 2, title: 'Untagged content' }),
  makeFinding({ severity: 'info', page: 3, title: 'Empty page' }),
  makeFinding({ severity: 'warning', page: null, title: 'No language entry' }),
];

const makeReport = (findings: AuditFinding[] = REPORT_FINDINGS): AuditReport =>
  buildAuditReport(makeDocument(), findings, TOOL);

function makeAnnotation(page: number, id: string): PdfAnnotation {
  return {
    id,
    page,
    subtype: 'Highlight',
    kind: 'markup',
    rect: null,
    title: null,
    contents: null,
    modificationDate: null,
    color: null,
    opacity: null,
    hidden: false,
    link: null,
    form: null,
  };
}

/** Two annotations on page 1, one on page 2 with two unresolved links. */
const makeAnnotationResult = (): AnnotationIndexResult => ({
  annotations: [makeAnnotation(1, 'a1'), makeAnnotation(1, 'a2'), makeAnnotation(2, 'a3')],
  summary: {
    annotations: 3,
    pagesWithAnnotations: 2,
    links: 2,
    forms: 0,
    markup: 3,
    notes: 0,
    stamps: 0,
    other: 0,
    hidden: 0,
    unresolvedLinks: 2,
    unsafeLinks: 0,
    formFields: 0,
  },
  linkIssues: [
    {
      annotationId: 'a3',
      page: 2,
      subtype: 'Link',
      kind: 'unresolved',
      target: null,
      message: 'Link target could not be resolved',
    },
    {
      annotationId: 'a3',
      page: 2,
      subtype: 'Link',
      kind: 'unsafe',
      target: 'javascript:void(0)',
      message: 'Unsafe link target',
    },
  ],
  formIssues: [],
  formFields: [],
  scannedPages: 5,
  truncated: false,
});

/** The audit report of `doc.pdf` (the open document) is available. */
const withAuditReport = (findings: AuditFinding[] = REPORT_FINDINGS): AuditReport => {
  const report = makeReport(findings);
  act(() => useAuditStore.setState({ filePath: 'doc.pdf', fileName: 'doc.pdf', report }));
  return report;
};

/** A finished whole-document index for `documentKey`. */
const withAnnotationIndex = (
  documentKey: string | null = 'doc.pdf',
  result: AnnotationIndexResult = makeAnnotationResult(),
): void => {
  act(() =>
    useAnnotationIndexStore.setState({
      documentKey,
      status: 'ready',
      progress: null,
      result,
      error: null,
    }),
  );
};

interface ObserverHarness {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Set<Element>;
  /** Deliver one batch for the given pages; `isIntersecting` defaults to true. */
  emit: (pages: number[], isIntersecting?: boolean) => void;
}

/** Install a controllable IntersectionObserver; returns every instance. */
const installObserver = (): ObserverHarness[] => {
  const created: ObserverHarness[] = [];

  class MockIntersectionObserver {
    readonly options: IntersectionObserverInit | undefined;
    readonly observed = new Set<Element>();
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.options = options;
      created.push({
        callback,
        options,
        observed: this.observed,
        emit: (pages, isIntersecting = true) => {
          const entries = pages.map(
            (page) =>
              ({
                isIntersecting,
                target: card(page),
              }) as unknown as IntersectionObserverEntry,
          );
          callback(entries, this as unknown as IntersectionObserver);
        },
      });
    }

    observe(element: Element): void {
      this.observed.add(element);
    }

    unobserve(element: Element): void {
      this.observed.delete(element);
    }

    disconnect(): void {
      this.observed.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  return created;
};

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue(undefined);
  useI18nStore.setState({ locale: 'en' });
  // No analysis has run yet: the grid starts as plain thumbnails.
  useAuditStore.getState().reset();
  useAnnotationIndexStore.getState().reset();
  usePdfStore.setState({
    filePath: 'doc.pdf',
    sourceUrl: null,
    pageCount: 5,
    currentPage: 2,
    pdfDocRef: PDF_DOCUMENT as never,
    documentEpoch: 1,
    isLoading: false,
  });
  usePageOverviewStore.setState({ open: true, filter: 'all' });
});

afterEach(() => {
  cleanup();
  usePageOverviewStore.setState({ open: false, filter: 'all' });
  useAuditStore.getState().reset();
  useAnnotationIndexStore.getState().reset();
  // Remove the `scrollIntoView` stub a test may have installed on the shared
  // prototype (jsdom does not implement it).
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PageOverview', () => {
  it('renders an accessible modal with one card per page and the current page marked', () => {
    show();

    const dialog = screen.getByRole('dialog', { name: 'Page overview' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(
      screen.getByText('Arrow keys to move, Enter to open a page, Esc to close.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();

    const cards = screen.getAllByRole('button', { name: /^Page \d+$/ });
    expect(cards).toHaveLength(5);
    expect(card(2).getAttribute('aria-current')).toBe('page');
    expect(card(1).getAttribute('aria-current')).toBeNull();
    expect(screen.getByText('Current page')).toBeTruthy();
  });

  it('loads a thumbnail for every card and renders it with empty alt text', async () => {
    const loader = show();

    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(5));
    expect(loader.load).toHaveBeenCalledWith(PDF_DOCUMENT, 1);

    await waitFor(() => {
      const images = Array.from(document.querySelectorAll('img'));
      expect(images).toHaveLength(5);
      expect(images.every((image) => image.getAttribute('alt') === '')).toBe(true);
      expect(images[0].getAttribute('src')).toBe('data:image/jpeg;base64,1');
    });
  });

  it('navigates to the clicked page and closes', () => {
    show();

    fireEvent.click(card(4));

    expect(navigate).toHaveBeenCalledWith(4);
    expect(usePageOverviewStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes from the close button, Escape and the backdrop, but not from inside the dialog', () => {
    show();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(usePageOverviewStore.getState().open).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(usePageOverviewStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => usePageOverviewStore.getState().openOverview());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(usePageOverviewStore.getState().open).toBe(false);

    act(() => usePageOverviewStore.getState().openOverview());
    fireEvent.click(screen.getByTestId('page-overview-backdrop'));
    expect(usePageOverviewStore.getState().open).toBe(false);
  });

  it('focuses the current page on open and restores the opener on close', async () => {
    usePageOverviewStore.setState({ open: false });
    const loader = makeLoader();

    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement('button', { type: 'button' }, 'Open overview'),
        React.createElement(PageOverview, { loader }),
      ),
    );

    const opener = screen.getByRole('button', { name: 'Open overview' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    act(() => usePageOverviewStore.getState().openOverview());
    await waitFor(() => expect(document.activeElement).toBe(card(2)));

    act(() => usePageOverviewStore.getState().closeOverview());
    expect(document.activeElement).toBe(opener);
  });

  it('restores focus to the opener after a card navigation that starts loading', async () => {
    usePageOverviewStore.setState({ open: false });
    usePdfStore.setState({ isLoading: false });
    navigate.mockImplementationOnce(async () => {
      usePdfStore.setState({ isLoading: true });
    });
    const loader = makeLoader();

    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement('button', { type: 'button' }, 'Open overview'),
        React.createElement(PageOverview, { loader }),
      ),
    );

    const opener = screen.getByRole('button', { name: 'Open overview' });
    opener.focus();
    act(() => usePageOverviewStore.getState().openOverview());
    await waitFor(() => expect(document.activeElement).toBe(card(2)));

    fireEvent.click(card(4));

    expect(navigate).toHaveBeenCalledWith(4);
    expect(usePdfStore.getState().isLoading).toBe(true);
    expect(usePageOverviewStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('moves focus with ArrowRight/ArrowLeft without navigating', () => {
    show();
    expect(document.activeElement).toBe(card(2));

    fireEvent.keyDown(card(2), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(card(3));

    fireEvent.keyDown(card(3), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(card(2));

    expect(navigate).not.toHaveBeenCalled();
  });

  it('moves focus by the computed column count with ArrowDown/ArrowUp', () => {
    show();
    const grid = screen.getByTestId('page-overview-grid');
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      if (element === grid) {
        return { gridTemplateColumns: '1fr 1fr 1fr' } as CSSStyleDeclaration;
      }
      return realGetComputedStyle(element);
    });

    fireEvent.keyDown(card(2), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card(5));

    // Clamped at the last row: page 5 - 3 stays inside the document.
    fireEvent.keyDown(card(5), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(card(2));
  });

  it('jumps to the first and last page with Home/End', () => {
    show();

    fireEvent.keyDown(card(2), { key: 'End' });
    expect(document.activeElement).toBe(card(5));

    fireEvent.keyDown(card(5), { key: 'Home' });
    expect(document.activeElement).toBe(card(1));
  });

  it('traps Tab inside the dialog and cycles Shift+Tab in reverse', () => {
    show();
    const closeButton = screen.getByRole('button', { name: 'Close' });

    card(5).focus();
    fireEvent.keyDown(card(5), { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(card(5));
  });

  it('shows a skeleton while a thumbnail never resolves and still navigates on click', () => {
    const loader = {
      load: vi.fn(() => new Promise<string>(() => {})),
    };
    show(loader);

    expect(screen.getAllByTestId('thumbnail-skeleton')).toHaveLength(5);

    fireEvent.click(card(3));
    expect(navigate).toHaveBeenCalledWith(3);
    expect(usePageOverviewStore.getState().open).toBe(false);
  });

  it('shows a titled placeholder for a failed thumbnail and keeps the card clickable', async () => {
    const loader = {
      load: vi.fn(async () => {
        throw new Error('render failed');
      }),
    };
    show(loader);

    await waitFor(() => expect(screen.getAllByTestId('thumbnail-error')).toHaveLength(5));
    const placeholder = screen.getAllByTestId('thumbnail-error')[0];
    expect(placeholder.getAttribute('title')).toBe('Thumbnail unavailable');

    fireEvent.click(card(4));
    expect(navigate).toHaveBeenCalledWith(4);
  });

  it('asks for the seeded current-page window plus pages the observer reports', async () => {
    usePdfStore.setState({ pageCount: 50, currentPage: 20 });
    const observers = installObserver();
    const loader = show();
    const observer = observers[0];

    expect(observer).toBeTruthy();
    expect(observer.options?.rootMargin).toBe('300px');
    expect(observer.options?.root).toBe(screen.getByTestId('page-overview-grid').parentElement);
    expect(observer.observed.size).toBe(50);

    // currentPage - 2 through currentPage + 5 is requested before any observer
    // callback fires.
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(8));
    expect(loader.load.mock.calls.map((call) => call[1]).sort((a, b) => a - b)).toEqual([
      18, 19, 20, 21, 22, 23, 24, 25,
    ]);

    act(() => observer.emit([40, 41]));
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(10));
    const requested = loader.load.mock.calls.map((call) => call[1]);
    expect(requested).toContain(40);
    expect(requested).toContain(41);
    // Pages outside the seeded window stay unrequested until observed.
    expect(requested).not.toContain(1);
  });

  it('observes every card for a 1000-page document but requests only the seeded/visible pages', async () => {
    usePdfStore.setState({ pageCount: 1000, currentPage: 1 });
    const observers = installObserver();
    const loader = show();
    const observer = observers[0];

    expect(observer.observed.size).toBe(1000);

    // pageCount is large, so the seed window is pages 1–6, not the whole file.
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(6));
    expect(loader.load.mock.calls.map((call) => call[1]).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    act(() => observer.emit([7, 8, 9]));
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(9));
    expect(loader.load.mock.calls.length).toBeLessThan(1000);
  });

  it('seeds the current-page window when the observer never delivers an initial batch', async () => {
    usePdfStore.setState({ pageCount: 1000, currentPage: 500 });
    const observers = installObserver();
    const loader = show();
    const observer = observers[0];

    expect(observer.observed.size).toBe(1000);
    // The mock callback is never invoked: this is the real-browser case where
    // the first paint beats the observer for a 1000-card grid.
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(8));
    const pages = loader.load.mock.calls.map((call) => call[1]).sort((a, b) => a - b);
    expect(pages).toEqual([498, 499, 500, 501, 502, 503, 504, 505]);
    expect(pages).not.toContain(0);

    expect(screen.getByRole('button', { name: 'Page 500' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Page 498' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 505' })).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Page 1' })
        .querySelector('[data-testid="thumbnail-skeleton"]'),
    ).toBeTruthy();
  });

  it('releases a thumbnail when its card leaves the viewport and reloads it on re-entry', async () => {
    usePdfStore.setState({ pageCount: 50, currentPage: 20 });
    const observers = installObserver();
    const loader = show();
    const observer = observers[0];

    // The seeded window is pages 18–25; page 2 starts as a skeleton.
    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(8));
    expect(loader.load.mock.calls.map((call) => call[1])).not.toContain(2);
    expect(card(2).querySelector('img')).toBeNull();
    expect(card(2).querySelector('[data-testid="thumbnail-skeleton"]')).toBeTruthy();

    act(() => observer.emit([2]));
    await waitFor(() => expect(card(2).querySelector('img')).not.toBeNull());
    expect(card(2).querySelector('[data-testid="thumbnail-skeleton"]')).toBeNull();

    // Leaving drops the data URL and shows the skeleton again.
    act(() => observer.emit([2], false));
    await waitFor(() => expect(card(2).querySelector('img')).toBeNull());
    expect(card(2).querySelector('[data-testid="thumbnail-skeleton"]')).toBeTruthy();

    // Re-entry requests the page again (a real loader may answer from cache).
    act(() => observer.emit([2]));
    await waitFor(() => expect(card(2).querySelector('img')).not.toBeNull());
    expect(loader.load.mock.calls.filter((call) => call[1] === 2)).toHaveLength(2);
  });

  it('closes when the document changes while open', async () => {
    show();

    act(() => usePdfStore.setState({ filePath: 'other.pdf' }));
    await waitFor(() => expect(usePageOverviewStore.getState().open).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => usePageOverviewStore.getState().openOverview());
    act(() => usePdfStore.setState({ documentEpoch: 2 }));
    await waitFor(() => expect(usePageOverviewStore.getState().open).toBe(false));
  });

  it('closes itself when opened without a document or without pages', async () => {
    usePdfStore.setState({ pageCount: 0 });
    show();

    await waitFor(() => expect(usePageOverviewStore.getState().open).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('translates the dialog, cards and hint into Chinese', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    show();

    expect(screen.getByRole('dialog', { name: '页面总览' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '第 2 页' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByText('方向键移动，Enter 打开页面，Esc 关闭。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });
});

describe('PageOverview markers and filters', () => {
  it('draws audit badges and the header summary for the open document', () => {
    withAuditReport();
    show();

    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      'Problems: 3 pages · 1 error · 2 warnings · 1 info',
    );
    expect(screen.getByTestId('page-overview-document').textContent).toBe('Document-level: 1');
    // An audit report is enough: no "run the audit" hint.
    expect(screen.queryByTestId('page-overview-markers-hint')).toBeNull();

    expect(badgesOf(1)).toEqual(['E1']);
    expect(badgesOf(2)).toEqual(['W2']);
    expect(badgesOf(3)).toEqual(['I1']);
    expect(badgesOf(4)).toEqual([]);
    expect(badgesOf(5)).toEqual([]);

    // The card label carries the counts, so colour is never the only cue.
    expect(cardByPage(1)?.getAttribute('aria-label')).toBe('Page 1 · 1 error');
    expect(cardByPage(2)?.getAttribute('aria-label')).toBe('Page 2 · 2 warnings');
    expect(cardByPage(3)?.getAttribute('aria-label')).toBe('Page 3 · 1 info');
    expect(cardByPage(4)?.getAttribute('aria-label')).toBe('Page 4');
  });

  it('keeps document-level findings off page 1 and only in the header', () => {
    // One page finding on page 1 plus one document-level warning: page 1 must
    // not inherit the document count.
    withAuditReport([
      makeFinding({ severity: 'info', page: 1, title: 'Page finding' }),
      makeFinding({ severity: 'warning', page: null, title: 'Document finding' }),
    ]);
    show();

    expect(badgesOf(1)).toEqual(['I1']);
    expect(screen.getByTestId('page-overview-document').textContent).toBe('Document-level: 1');
    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      'Problems: 1 page · 0 errors · 0 warnings · 1 info',
    );
  });

  it('counts page findings only, so document-level findings are not counted twice', () => {
    // `basic.pdf`-like report: one page warning plus two document-level infos.
    withAuditReport([
      makeFinding({ severity: 'warning', page: 2, title: 'Page warning' }),
      makeFinding({ severity: 'info', page: null, title: 'Document info A' }),
      makeFinding({ severity: 'info', page: null, title: 'Document info B' }),
    ]);
    show();

    // 1 page (not "1 pages"), and the two infos appear only in the document
    // line instead of also inflating the page-level info count.
    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      'Problems: 1 page · 0 errors · 1 warning · 0 info',
    );
    expect(screen.getByTestId('page-overview-document').textContent).toBe('Document-level: 2');
    expect(badgesOf(2)).toEqual(['W1']);
    expect(cardByPage(1)?.getAttribute('aria-label')).toBe('Page 1');
  });

  it('shows only the document line when every finding is document-level', () => {
    withAuditReport([
      makeFinding({ severity: 'warning', page: null }),
      makeFinding({ severity: 'info', page: null }),
    ]);
    show();

    expect(screen.queryByTestId('page-overview-problems')).toBeNull();
    expect(screen.getByTestId('page-overview-document').textContent).toBe('Document-level: 2');
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveProperty('disabled', true);
    expect(badgesOf(1)).toEqual([]);
  });

  it('ignores an audit report that belongs to another file', () => {
    const report = makeReport();
    act(() =>
      useAuditStore.setState({ filePath: 'other.pdf', fileName: 'other.pdf', report }),
    );
    show();

    expect(screen.queryByTestId('page-overview-problems')).toBeNull();
    expect(screen.queryByTestId('page-overview-document')).toBeNull();
    expect(screen.getByTestId('page-overview-markers-hint').textContent).toBe(
      'Run Audit to mark pages.',
    );
    expect(badgesOf(1)).toEqual([]);
    expect(badgesOf(2)).toEqual([]);
  });

  it('draws annotation badges and the annotations summary for a ready index', () => {
    withAnnotationIndex();
    show();

    expect(screen.getByTestId('page-overview-annotations').textContent).toBe(
      'Annotations: 2 pages · 3 marks · 2 issues',
    );
    expect(screen.getByTestId('page-overview-markers-hint').textContent).toBe(
      'Run Audit to mark pages.',
    );

    expect(badgesOf(1)).toEqual(['A2']);
    expect(badgesOf(2)).toEqual(['A1', '!2']);
    expect(cardByPage(2)?.getAttribute('aria-label')).toBe(
      'Page 2 · 1 annotation · 2 issues',
    );
    expect(badgesOf(3)).toEqual([]);
  });

  it('pluralizes a single annotated page and its single mark', () => {
    // One annotation on one page, no link/form issues.
    withAnnotationIndex('doc.pdf', {
      ...makeAnnotationResult(),
      annotations: [makeAnnotation(2, 'only')],
      linkIssues: [],
    });
    show();

    expect(screen.getByTestId('page-overview-annotations').textContent).toBe(
      'Annotations: 1 page · 1 mark · 0 issues',
    );
    expect(badgesOf(2)).toEqual(['A1']);
  });

  it('shows no annotations line for a ready index that found nothing', () => {
    withAnnotationIndex('doc.pdf', {
      ...makeAnnotationResult(),
      annotations: [],
      linkIssues: [],
      formIssues: [],
    });
    show();

    // A finished but empty index is not worth a header line; the grid is
    // unchanged and both marker filters stay disabled.
    expect(screen.queryByTestId('page-overview-annotations')).toBeNull();
    expect(screen.queryByTestId('page-overview-problems')).toBeNull();
    expect(badgesOf(1)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Annotated only' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('uses an annotation issue as a problem page without an audit report', () => {
    // No audit report at all: only the index knows about the defect.
    withAnnotationIndex('doc.pdf', {
      ...makeAnnotationResult(),
      annotations: [makeAnnotation(3, 'broken-link')],
      linkIssues: [
        {
          annotationId: 'broken-link',
          page: 3,
          subtype: 'Link',
          kind: 'unresolved',
          target: null,
          message: 'Link target could not be resolved',
        },
      ],
    });
    show();

    expect(badgesOf(3)).toEqual(['A1', '!1']);
    // An issue makes the page a problem page even though no audit ran…
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveProperty(
      'disabled',
      false,
    );
    // …but the audit summary line stays hidden (no report to summarise).
    expect(screen.queryByTestId('page-overview-problems')).toBeNull();
    expect(screen.queryByTestId('page-overview-document')).toBeNull();
    expect(screen.getByTestId('page-overview-annotations').textContent).toBe(
      'Annotations: 1 page · 1 mark · 1 issue',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Problems only' }));
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('1 of 5 pages');
    expect(cardByPage(3)).toBeTruthy();
    expect(cardByPage(1)).toBeNull();
    expect(cardByPage(2)).toBeNull();
  });

  it('ignores an annotation index that belongs to another document or is unfinished', () => {
    withAnnotationIndex('other.pdf');
    show();

    expect(screen.queryByTestId('page-overview-annotations')).toBeNull();
    expect(badgesOf(1)).toEqual([]);

    // Same document, but the index is still running.
    act(() =>
      useAnnotationIndexStore.setState({
        documentKey: 'doc.pdf',
        status: 'indexing',
        progress: { done: 1, total: 5 },
        result: makeAnnotationResult(),
      }),
    );
    expect(screen.queryByTestId('page-overview-annotations')).toBeNull();
    expect(badgesOf(1)).toEqual([]);
  });

  it('filters the grid to problem pages and counts what is left', () => {
    withAuditReport();
    show();

    fireEvent.click(screen.getByRole('button', { name: 'Problems only' }));

    expect(usePageOverviewStore.getState().filter).toBe('problems');
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('3 of 5 pages');
    expect(cardByPage(1)).toBeTruthy();
    expect(cardByPage(2)).toBeTruthy();
    expect(cardByPage(3)).toBeTruthy();
    expect(cardByPage(4)).toBeNull();
    expect(cardByPage(5)).toBeNull();
    expect(screen.getByRole('button', { name: 'Problems only' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // Back to all pages: the full grid returns and the count line disappears.
    fireEvent.click(screen.getByRole('button', { name: 'All pages' }));
    expect(cardByPage(4)).toBeTruthy();
    expect(screen.queryByTestId('page-overview-filter-count')).toBeNull();
  });

  it('filters the grid to annotated pages', () => {
    withAnnotationIndex();
    show();

    fireEvent.click(screen.getByRole('button', { name: 'Annotated only' }));

    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('2 of 5 pages');
    expect(cardByPage(1)).toBeTruthy();
    expect(cardByPage(2)).toBeTruthy();
    expect(cardByPage(3)).toBeNull();
  });

  it('moves focus only between rendered cards of a filtered grid', () => {
    usePdfStore.setState({ pageCount: 6, currentPage: 2 });
    // Problems on pages 2 and 4 only, so the rendered list is [2, 4].
    withAuditReport([
      makeFinding({ severity: 'warning', page: 2 }),
      makeFinding({ severity: 'error', page: 4 }),
    ]);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Problems only' }));

    // One column per row, so ArrowDown/ArrowUp move to the next rendered page
    // instead of one raw page number.
    const grid = screen.getByTestId('page-overview-grid');
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      if (element === grid) {
        return { gridTemplateColumns: '1fr' } as CSSStyleDeclaration;
      }
      return realGetComputedStyle(element);
    });

    const first = cardByPage(2) as HTMLElement;
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cardByPage(4));
    // Past the last rendered card, focus stays put rather than landing on a
    // page the filter hides.
    fireEvent.keyDown(cardByPage(4) as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cardByPage(4));

    fireEvent.keyDown(cardByPage(4) as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cardByPage(2));
    fireEvent.keyDown(cardByPage(2) as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cardByPage(4));

    fireEvent.keyDown(cardByPage(4) as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(cardByPage(2));
    fireEvent.keyDown(cardByPage(2) as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(cardByPage(4));

    fireEvent.keyDown(cardByPage(4) as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cardByPage(2));

    // The hidden pages are not in the DOM at all, so they never take focus.
    expect(cardByPage(1)).toBeNull();
    expect(cardByPage(3)).toBeNull();
    expect(cardByPage(5)).toBeNull();
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('2 of 6 pages');
  });

  it('disables a filter that has nothing to show', () => {
    show();

    expect(screen.getByRole('button', { name: 'All pages' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Annotated only' })).toHaveProperty(
      'disabled',
      true,
    );

    cleanup();
    // An audit report enables only the problems filter; annotations enable the
    // annotated filter.
    withAuditReport();
    show();
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Annotated only' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows the localized empty message when a filter matches nothing', () => {
    withAuditReport();
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Problems only' }));
    expect(cardByPage(1)).toBeTruthy();

    // Re-running the audit returned document-level findings only: the open,
    // filtered grid must explain itself instead of rendering an empty scroll
    // area.
    act(() =>
      useAuditStore.setState({ report: makeReport([makeFinding({ page: null })]) }),
    );

    expect(screen.getByTestId('page-overview-empty').textContent).toBe(
      'No pages with problems.',
    );
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('0 of 5 pages');
    expect(screen.queryByTestId('page-overview-grid')).toBeNull();
  });

  it('updates markers while the overview is open without closing it', () => {
    show();
    expect(screen.getByTestId('page-overview-markers-hint')).toBeTruthy();
    expect(badgesOf(1)).toEqual([]);

    act(() =>
      useAuditStore.setState({
        filePath: 'doc.pdf',
        fileName: 'doc.pdf',
        report: makeReport(),
      }),
    );

    expect(usePageOverviewStore.getState().open).toBe(true);
    expect(screen.queryByTestId('page-overview-markers-hint')).toBeNull();
    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      'Problems: 3 pages · 1 error · 2 warnings · 1 info',
    );
    expect(badgesOf(2)).toEqual(['W2']);
    expect(cardByPage(4)).toBeTruthy();
  });

  it('keeps focus and scroll when markers arrive while the overview is open', () => {
    // jsdom has no `scrollIntoView`; the dialog only reaches it through
    // `focusAndCenter`, so a new call is exactly "the grid recentered".
    const scrollIntoView = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView =
      scrollIntoView;

    withAuditReport([makeFinding({ severity: 'warning', page: 1 })]);
    show();

    const scroller = screen.getByTestId('page-overview-grid').parentElement as HTMLElement;
    const focusedCard = cardByPage(4) as HTMLElement;
    focusedCard.focus();
    expect(document.activeElement).toBe(focusedCard);

    // An audit run updates the report for the same file while the dialog is
    // open: new markers, a new rendered-page array and a new summary.
    scroller.scrollTop = 240;
    const scrollTop = scroller.scrollTop;
    const centers = scrollIntoView.mock.calls.length;
    expect(centers).toBeGreaterThan(0);

    act(() =>
      useAuditStore.setState({
        filePath: 'doc.pdf',
        fileName: 'doc.pdf',
        report: makeReport([
          makeFinding({ severity: 'warning', page: 1 }),
          makeFinding({ severity: 'error', page: 4, title: 'New finding' }),
        ]),
      }),
    );

    // The markers did refresh…
    expect(usePageOverviewStore.getState().open).toBe(true);
    expect(badgesOf(4)).toEqual(['E1']);
    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      'Problems: 2 pages · 1 error · 1 warning · 0 info',
    );

    // …without pulling focus or the scroll position back to the current page.
    expect(document.activeElement).toBe(focusedCard);
    expect(scrollIntoView.mock.calls.length).toBe(centers);
    expect(scroller.scrollTop).toBe(scrollTop);
  });

  it('focuses the first rendered card when the current page is filtered out', async () => {
    // Problems on pages 1, 3 and 5 only: the current page (2) is hidden.
    withAuditReport([
      makeFinding({ severity: 'error', page: 1 }),
      makeFinding({ severity: 'warning', page: 3 }),
      makeFinding({ severity: 'info', page: 5 }),
    ]);
    usePageOverviewStore.setState({ open: false, filter: 'problems' });

    show();
    act(() => usePageOverviewStore.getState().openOverview('problems'));

    await waitFor(() => expect(document.activeElement).toBe(cardByPage(1)));
    expect(cardByPage(2)).toBeNull();
    // The dialog never throws or loses focus when the current card is gone.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('re-seeds and re-observes only the rendered pages after a filter change', async () => {
    usePdfStore.setState({ pageCount: 50, currentPage: 20 });
    // Problems on pages 40–45: the current page is not part of the filter.
    withAuditReport(
      Array.from({ length: 6 }, (_value, index) =>
        makeFinding({ severity: 'warning', page: 40 + index }),
      ),
    );
    const observers = installObserver();
    const loader = show();

    await waitFor(() => expect(loader.load).toHaveBeenCalledTimes(8));

    act(() => usePageOverviewStore.getState().setFilter('problems'));

    const filtered = observers[observers.length - 1];
    expect(filtered.observed.size).toBe(6);
    const observedPages = Array.from(filtered.observed, (element) =>
      Number((element as HTMLElement).dataset.page),
    ).sort((left, right) => left - right);
    expect(observedPages).toEqual([40, 41, 42, 43, 44, 45]);

    // The current page is hidden, so the first six rendered pages are seeded.
    await waitFor(() =>
      expect(
        loader.load.mock.calls
          .map((call) => call[1])
          .filter((page) => page >= 40 && page <= 45),
      ).toHaveLength(6),
    );
    expect(cardByPage(20)).toBeNull();
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('6 of 50 pages');
  });

  it('keeps focus on the filter control instead of yanking it into the grid', () => {
    withAuditReport();
    show();

    const filterButton = screen.getByRole('button', { name: 'Problems only' });
    filterButton.focus();
    fireEvent.click(filterButton);
    expect(document.activeElement).toBe(filterButton);
  });

  it('translates the marker summary and filters into Chinese', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    withAuditReport();
    withAnnotationIndex();
    show();

    expect(screen.getByTestId('page-overview-problems').textContent).toBe(
      '问题：3 页 · 1 个错误 · 2 个警告 · 1 个提示',
    );
    expect(screen.getByTestId('page-overview-document').textContent).toBe('文档级：1');
    expect(screen.getByTestId('page-overview-annotations').textContent).toBe(
      '注释：2 页 · 3 个标记 · 2 个问题',
    );
    expect(screen.getByRole('button', { name: '全部页面' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仅问题页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仅有注释页' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '仅问题页' }));
    expect(screen.getByTestId('page-overview-filter-count').textContent).toBe('3 / 5 页');
    // The badge keeps its compact letters, its label is localized.
    expect(cardByPage(1)?.getAttribute('aria-label')).toBe('第 1 页 · 1 个错误 · 2 个注释');
    const badge = within(cardByPage(1) as HTMLElement).getByTestId('page-marker-error');
    expect(badge.getAttribute('title')).toBe('1 个错误');
  });
});
