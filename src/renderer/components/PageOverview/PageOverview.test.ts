// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThumbnailDocument } from '../../services/page-thumbnails';

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn<(page: number) => Promise<void>>(),
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { PageOverview } from './PageOverview';
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
  usePdfStore.setState({
    filePath: 'doc.pdf',
    pageCount: 5,
    currentPage: 2,
    pdfDocRef: PDF_DOCUMENT as never,
    documentEpoch: 1,
    isLoading: false,
  });
  usePageOverviewStore.setState({ open: true });
});

afterEach(() => {
  cleanup();
  usePageOverviewStore.setState({ open: false });
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
