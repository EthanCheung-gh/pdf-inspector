// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import type { PdfMetadata } from '../../types/pdf-objects';

const { navigate, openPdf, openPdfUrl } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openPdf: vi.fn(),
  openPdfUrl: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdf, openPdfUrl, extractPage: vi.fn(), saveFile: vi.fn() },
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { Toolbar } from './Toolbar';

const metadata: PdfMetadata = {
  pages: 5,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

const url = 'https://example.com/a.pdf';

function openUrlDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Open URL' }));
}

function submitUrl(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
}

describe('Toolbar open URL', () => {
  beforeEach(() => {
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    openPdf.mockReset();
    openPdfUrl.mockReset();

    usePdfStore.setState({
      filePath: null,
      sourceUrl: null,
      metadata: null,
      pageCount: 0,
      currentPage: 1,
      zoom: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      isLoading: false,
      error: null,
      pdfDocRef: null,
      outline: null,
      fitWidthZoom: null,
      textSelectionMode: false,
      regionMode: false,
      searchOpen: false,
    });
  });

  afterEach(cleanup);

  it('opens the URL dialog from the toolbar button', () => {
    render(React.createElement(Toolbar));

    expect(screen.queryByRole('dialog')).toBeNull();
    openUrlDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('stores the source URL and navigates to page 1 after a successful open', async () => {
    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/download.pdf',
      metadata,
      sourceUrl: url,
    });

    render(React.createElement(Toolbar));
    openUrlDialog();
    submitUrl(url);

    await waitFor(() => expect(usePdfStore.getState().sourceUrl).toBe(url));

    const state = usePdfStore.getState();
    expect(state.filePath).toBe('/tmp/download.pdf');
    expect(state.pageCount).toBe(5);
    expect(state.currentPage).toBe(1);
    expect(openPdfUrl).toHaveBeenCalledWith(url);
    expect(navigate).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTitle(url).textContent).toBe(url);
  });

  it('shows the local file name and clears the URL when a local file is opened', async () => {
    openPdfUrl.mockResolvedValue({
      canceled: false,
      path: '/tmp/download.pdf',
      metadata,
      sourceUrl: url,
    });
    openPdf.mockResolvedValue({ canceled: false, path: '/home/user/local.pdf', metadata });

    render(React.createElement(Toolbar));
    openUrlDialog();
    submitUrl(url);
    await waitFor(() => expect(usePdfStore.getState().sourceUrl).toBe(url));

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(usePdfStore.getState().filePath).toBe('/home/user/local.pdf'));
    expect(usePdfStore.getState().sourceUrl).toBeNull();
    expect(screen.getByTitle('/home/user/local.pdf').textContent).toBe('local.pdf');
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
