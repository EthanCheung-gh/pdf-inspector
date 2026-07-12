// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { LeftPanel } from './LeftPanel';

describe('LeftPanel', () => {
  afterEach(cleanup);

  beforeEach(() => {
    navigate.mockReset();
    usePdfStore.setState({
      filePath: null,
      metadata: null,
      pageCount: 0,
      outline: null,
      pdfDocRef: null,
    });
  });

  it('switches between Structure and Bookmarks tabs', () => {
    render(React.createElement(LeftPanel));

    expect(screen.getByRole('tab', { name: 'Structure' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));

    expect(screen.getByRole('tab', { name: 'Bookmarks' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('No bookmarks found in this document.')).toBeTruthy();
  });

  it('resolves a named destination and delegates page loading to guarded navigation', async () => {
    const pdfDoc = {
      getDestination: vi.fn().mockResolvedValue([{ num: 12, gen: 0 }]),
      getPageIndex: vi.fn().mockResolvedValue(2),
    };
    usePdfStore.setState({
      pdfDocRef: pdfDoc as any,
      outline: [{ title: 'Chapter 3', bold: false, italic: false, dest: 'chapter-three', items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chapter 3' }));

    await waitFor(() => expect(pdfDoc.getDestination).toHaveBeenCalledWith('chapter-three'));
    expect(pdfDoc.getPageIndex).toHaveBeenCalledWith({ num: 12, gen: 0 });
    expect(navigate).toHaveBeenCalledWith(3);
  });

  it('resolves an explicit destination and delegates page loading to guarded navigation', async () => {
    const pageRef = { num: 5, gen: 0 };
    const pdfDoc = {
      getDestination: vi.fn(),
      getPageIndex: vi.fn().mockResolvedValue(4),
    };
    usePdfStore.setState({
      pdfDocRef: pdfDoc as any,
      outline: [{ title: 'Appendix', bold: false, italic: false, dest: [pageRef], items: [] }],
    });
    render(React.createElement(LeftPanel));

    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));
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

    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));
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

    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));

    expect(screen.getByText('This document has 2001 bookmarks. The outline is too large to display.')).toBeTruthy();
  });
});
