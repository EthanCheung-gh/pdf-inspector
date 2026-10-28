// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageData, PdfMetadata, PdfRect, PdfWord } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { StructureTree } from './StructureTree';

const metadata: PdfMetadata = {
  pages: 1,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: 'Test',
  author: '',
  producer: '',
  fonts: [],
};

const makeWord = (index: number): PdfWord => ({
  type: 'word',
  page: 1,
  x0: index,
  y0: 10,
  x1: index + 1,
  y1: 20,
  text: `word-${index + 1}`,
  fontname: 'Helvetica',
  size: 12,
});

const sameRect: PdfRect = {
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

const pageData = (overrides: Partial<PageData> = {}): PageData => ({
  width: 612,
  height: 792,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
  ...overrides,
});

const wordOnPage = (page: number, text: string): PdfWord => ({
  ...makeWord(0),
  page,
  text,
});

const pageButton = (page: number): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`Page ${page}$`) });

describe('StructureTree', () => {
  afterEach(cleanup);

  beforeEach(() => {
    // The mocked navigate mirrors the real hook's store side of a page change,
    // so page-scoped state (active page, page data) behaves like production.
    navigate.mockReset();
    navigate.mockImplementation(async (page: number) => {
      usePdfStore.getState().setPage(page);
    });
    usePdfStore.setState({
      filePath: '/tmp/test.pdf',
      metadata,
      pageCount: 1,
      currentPage: 1,
      pageData: pageData(),
      selectedObject: null,
      hoveredObject: null,
      allObjects: [],
    });
  });

  it('shows an explicit truncation hint when words exceed the visible limit', () => {
    const words = Array.from({ length: 120 }, (_, index) => makeWord(index));
    usePdfStore.setState({ pageData: pageData({ words }), allObjects: words });

    render(React.createElement(StructureTree));

    expect(screen.getByText('Showing first 50 of 120 words')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^word-\d+$/ })).toHaveLength(50);
    expect(screen.queryByRole('button', { name: 'word-51' })).toBeNull();
  });

  it('does not show a truncation hint when all words fit', () => {
    const words = Array.from({ length: 50 }, (_, index) => makeWord(index));
    usePdfStore.setState({ pageData: pageData({ words }), allObjects: words });

    render(React.createElement(StructureTree));

    expect(screen.queryByText(/Showing first/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^word-\d+$/ })).toHaveLength(50);
  });

  it('renders every object when type/page/bbox are identical', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    usePdfStore.setState({
      pageData: pageData({ rects: [{ ...sameRect }, { ...sameRect }] }),
      allObjects: [sameRect, { ...sameRect }],
    });

    try {
      render(React.createElement(StructureTree));

      expect(screen.getAllByRole('button', { name: 'rect (0, 0)' })).toHaveLength(2);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('toggles the active page groups on repeated clicks without navigating', () => {
    const words = [wordOnPage(1, 'page-one-word')];
    usePdfStore.setState({ pageCount: 2, pageData: pageData({ words }), allObjects: words });

    render(React.createElement(StructureTree));

    const button = pageButton(1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(button.textContent).toContain('▾');
    expect(screen.getByRole('button', { name: 'page-one-word' })).toBeTruthy();

    fireEvent.click(button);

    expect(screen.queryByRole('button', { name: 'page-one-word' })).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(button.textContent).toContain('▸');
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(button);

    expect(screen.getByRole('button', { name: 'page-one-word' })).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('▾');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to another page and keeps that page expanded', async () => {
    const words = [wordOnPage(1, 'page-one-word')];
    usePdfStore.setState({ pageCount: 2, pageData: pageData({ words }), allObjects: words });

    render(React.createElement(StructureTree));

    fireEvent.click(pageButton(1));
    expect(screen.queryByRole('button', { name: 'page-one-word' })).toBeNull();

    fireEvent.click(pageButton(2));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(2));
    expect(navigate).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole('button', { name: 'page-one-word' })).toBeNull();
    expect(pageButton(1).getAttribute('aria-current')).toBeNull();
    expect(pageButton(2).getAttribute('aria-current')).toBe('page');
    expect(pageButton(2).getAttribute('aria-expanded')).toBe('false');
    expect(pageButton(2).textContent).toContain('▸');

    const pageTwoWords = [wordOnPage(2, 'page-two-word')];
    await act(async () => {
      usePdfStore.setState({
        currentPage: 2,
        pageData: pageData({ words: pageTwoWords }),
        allObjects: pageTwoWords,
      });
    });

    expect(screen.getByRole('button', { name: 'page-two-word' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'page-one-word' })).toBeNull();
    expect(pageButton(2).getAttribute('aria-expanded')).toBe('true');
    expect(pageButton(2).textContent).toContain('▾');
  });

  it('starts a newly active page expanded even when the previous page was collapsed', () => {
    const words = [wordOnPage(1, 'page-one-word')];
    usePdfStore.setState({ pageCount: 2, pageData: pageData({ words }), allObjects: words });

    render(React.createElement(StructureTree));

    fireEvent.click(pageButton(1));
    expect(pageButton(1).getAttribute('aria-expanded')).toBe('false');

    const pageTwoWords = [wordOnPage(2, 'page-two-word')];
    act(() => {
      usePdfStore.setState({
        currentPage: 2,
        pageData: pageData({ words: pageTwoWords }),
        allObjects: pageTwoWords,
      });
    });

    expect(screen.getByRole('button', { name: 'page-two-word' })).toBeTruthy();
    expect(pageButton(2).getAttribute('aria-expanded')).toBe('true');
    expect(pageButton(2).textContent).toContain('▾');
    expect(screen.queryByRole('button', { name: 'page-one-word' })).toBeNull();
  });
});
