// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import { computeFitWidthZoom } from '../../services/page-geometry';

const { usePdfMock } = vi.hoisted(() => ({ usePdfMock: vi.fn() }));

vi.mock('../../hooks/usePdf', () => ({ usePdf: () => usePdfMock() }));
// The page itself pulls in pdfjs-dist and CSS modules; the fit-width logic
// only needs the viewport shell.
vi.mock('./PdfPage', () => ({
  PdfPage: () => React.createElement('div', { 'data-testid': 'pdf-page' }),
}));

import { PdfViewport } from './PdfViewport';

const metadata = {
  pages: 2,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

const LETTER_FIT_WIDTH = computeFitWidthZoom(612, 900);

let containerWidth = 900;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

function setContainerWidth(width: number): void {
  containerWidth = width;
}

function stubPdfDoc(): { fake: true } {
  return { fake: true };
}

beforeEach(() => {
  setContainerWidth(900);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => containerWidth,
  });

  usePdfMock.mockReturnValue({
    pdfDoc: stubPdfDoc(),
    loading: false,
    error: null,
    loadPdf: vi.fn(),
  });

  usePdfStore.setState({
    filePath: '/tmp/sample.pdf',
    metadata,
    pageCount: 2,
    currentPage: 1,
    zoom: 1,
    pageData: null,
    allObjects: [],
    fitWidthZoom: null,
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePdfMock.mockReset();
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  }
});

describe('PdfViewport fit-width', () => {
  it('fits the page to the measured scroll container instead of a window guess', async () => {
    render(React.createElement(PdfViewport));

    await waitFor(() => expect(usePdfStore.getState().fitWidthZoom).not.toBeNull());

    const state = usePdfStore.getState();
    expect(state.fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5);
    expect(state.zoom).toBeCloseTo(LETTER_FIT_WIDTH, 5);
    // The old guess used window.innerWidth (1024 in jsdom).
    expect(state.zoom).not.toBeCloseTo(computeFitWidthZoom(612, window.innerWidth), 3);
  });

  it('treats a 0 client width as unmeasured and applies no fit', async () => {
    setContainerWidth(0);
    render(React.createElement(PdfViewport));

    // Let mount effects (ref → measure) and a resize tick run.
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    const state = usePdfStore.getState();
    expect(state.fitWidthZoom).toBeNull();
    expect(state.zoom).toBe(1);
    // window.innerWidth must not be used as a fallback width.
    expect(state.zoom).not.toBeCloseTo(computeFitWidthZoom(612, window.innerWidth), 3);
  });

  it('fits as soon as the container reports a real width', async () => {
    setContainerWidth(0);
    render(React.createElement(PdfViewport));
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(usePdfStore.getState().fitWidthZoom).toBeNull();

    setContainerWidth(900);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5);
    });
  });

  it('re-fits when the container resizes while the user is in fit mode', async () => {
    render(React.createElement(PdfViewport));
    await waitFor(() => expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5));

    setContainerWidth(700);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(computeFitWidthZoom(612, 700), 5);
    });
    expect(usePdfStore.getState().zoom).toBeCloseTo(computeFitWidthZoom(612, 700), 5);
  });

  it('never overrides a manual zoom on resize', async () => {
    render(React.createElement(PdfViewport));
    await waitFor(() => expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5));

    act(() => {
      usePdfStore.getState().setZoom(2);
    });
    setContainerWidth(700);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(usePdfStore.getState().zoom).toBe(2);
    expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5);
  });

  it('refits once per newly loaded document', async () => {
    const { rerender } = render(React.createElement(PdfViewport));
    await waitFor(() => expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(LETTER_FIT_WIDTH, 5));

    // A landscape/tabloid document loads: metadata and document change together.
    act(() => {
      usePdfStore.setState({ metadata: { ...metadata, page_w: 1224 } });
    });
    usePdfMock.mockReturnValue({
      pdfDoc: stubPdfDoc(),
      loading: false,
      error: null,
      loadPdf: vi.fn(),
    });
    rerender(React.createElement(PdfViewport));

    await waitFor(() => {
      expect(usePdfStore.getState().fitWidthZoom).toBeCloseTo(computeFitWidthZoom(1224, 900), 5);
    });
  });

  it('observes the scroll container and disconnects the observer on unmount', async () => {
    const observed: Element[] = [];
    const disconnected: boolean[] = [];

    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe(element: Element): void {
        observed.push(element);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnected.push(true);
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const { unmount } = render(React.createElement(PdfViewport));
    await waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0].className).toContain('viewport');

    unmount();
    expect(disconnected).toEqual([true]);
  });
});

describe('PdfViewport scroll position', () => {
  it('returns to the top when the page or document changes', async () => {
    const { container } = render(React.createElement(PdfViewport));
    await waitFor(() => expect(usePdfStore.getState().fitWidthZoom).not.toBeNull());

    const viewport = container.firstElementChild as HTMLDivElement;
    viewport.scrollTop = 420;
    viewport.scrollLeft = 30;

    act(() => {
      usePdfStore.getState().setPage(2);
    });

    expect(viewport.scrollTop).toBe(0);
    expect(viewport.scrollLeft).toBe(0);
  });
});
