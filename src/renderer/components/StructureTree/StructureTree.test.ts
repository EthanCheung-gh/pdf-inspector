// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageData, PdfMetadata, PdfRect, PdfWord } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate: vi.fn() }),
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

describe('StructureTree', () => {
  afterEach(cleanup);

  beforeEach(() => {
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
});
