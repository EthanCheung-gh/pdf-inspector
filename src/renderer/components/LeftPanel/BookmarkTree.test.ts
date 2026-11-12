// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfMetadata } from '../../types/pdf-objects';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { BookmarkTree } from './BookmarkTree';

const metadata = (pages: number): PdfMetadata => ({
  pages,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
});

/** A PDF.js stand-in whose single bookmark resolves to `pageIndex`. */
function fakeDoc(pageIndex: number | (() => Promise<number>), numPages = 10) {
  return {
    numPages,
    getDestination: vi.fn().mockResolvedValue([{ num: 12, gen: 0 }]),
    getPageIndex: vi.fn(() =>
      typeof pageIndex === 'function' ? pageIndex() : Promise.resolve(pageIndex),
    ),
  };
}

function renderTree(pdfDoc: ReturnType<typeof fakeDoc>) {
  usePdfStore.setState({
    pdfDocRef: pdfDoc as never,
    outline: [{ title: 'Chapter 3', bold: false, italic: false, dest: 'chapter-three', items: [] }],
  });
  render(React.createElement(BookmarkTree, { pdfDoc: pdfDoc as never }));
  fireEvent.click(screen.getByRole('button', { name: 'Chapter 3' }));
}

beforeEach(() => {
  navigate.mockReset();
  useI18nStore.setState({ locale: 'en' });
  usePdfStore.setState({
    filePath: '/tmp/doc.pdf',
    metadata: metadata(10),
    pageCount: 10,
    outline: null,
    pdfDocRef: null,
    pageData: null,
    error: null,
    isLoading: false,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BookmarkTree', () => {
  it('navigates to a destination that is a page of the open document', async () => {
    renderTree(fakeDoc(2));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(3));
  });

  it('accepts the last page of the document', async () => {
    renderTree(fakeDoc(9, 10));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(10));
  });

  // A bookmark can point past the end of the document (malformed outline, or an
  // outline still on screen for a document that was just replaced). Navigating
  // there used to ask the sidecar for a missing page and surface
  // "list index out of range" as a fatal page error.
  it('ignores an out-of-range destination and keeps rendering', async () => {
    const pdfDoc = fakeDoc(42);
    renderTree(pdfDoc);

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    // A malformed bookmark is not a fatal UI state: the outline is still usable
    // and no error is shown.
    expect(screen.getByRole('button', { name: 'Chapter 3' })).toBeTruthy();
    expect(usePdfStore.getState().error).toBeNull();
  });

  it('ignores a negative destination', async () => {
    const pdfDoc = fakeDoc(-1);
    renderTree(pdfDoc);

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('ignores a non-integer destination', async () => {
    const pdfDoc = fakeDoc(2.5);
    renderTree(pdfDoc);

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('ignores a destination outside the loaded PDF.js document', async () => {
    // The store still reports ten pages, but the PDF.js document only has five.
    const pdfDoc = fakeDoc(7, 5);
    renderTree(pdfDoc);

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('ignores a destination resolved after the document changed', async () => {
    let resolveIndex!: (index: number) => void;
    const pdfDoc = fakeDoc(
      () => new Promise<number>((resolve) => { resolveIndex = resolve; }),
    );
    renderTree(pdfDoc);

    await waitFor(() => expect(pdfDoc.getPageIndex).toHaveBeenCalled());
    // The user switched documents while the destination was still resolving.
    usePdfStore.getState().setFile('/tmp/next.pdf', metadata(10));
    await act(async () => { resolveIndex(1); });

    expect(navigate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
