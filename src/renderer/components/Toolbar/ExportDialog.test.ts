// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import type { SaveFileRequest } from '../../types/ipc-protocol';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';

const { extractPage, saveFile } = vi.hoisted(() => ({
  extractPage: vi.fn<(page: number) => Promise<PageData>>(),
  saveFile: vi.fn<
    (request: SaveFileRequest) => Promise<{ canceled: boolean; filePath?: string; error?: string }>
  >(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { extractPage, saveFile },
}));

import { ExportDialog } from './ExportDialog';

const metadata: PdfMetadata = {
  pages: 3,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: 'Demo',
  author: 'A',
  producer: 'P',
  fonts: ['F1'],
};

function makePage(page: number): PageData {
  return {
    width: 612,
    height: 792,
    chars: [
      { type: 'char', x0: 1, y0: 2, x1: 3, y1: 4, page, text: 'a', fontname: 'F1', size: 12, color: '#000000' },
    ],
    words: [
      { type: 'word', x0: 1, y0: 2, x1: 9, y1: 4, page, text: 'hello', fontname: 'F1', size: 12 },
    ],
    rects: [],
    lines: [],
    curves: [],
    images: [],
    tables: [],
  };
}

const pageOne = makePage(1);

describe('ExportDialog', () => {
  beforeEach(() => {
    extractPage.mockReset();
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });

    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      sourceUrl: null,
      metadata,
      pageCount: 3,
      currentPage: 1,
      pageData: pageOne,
      isLoading: false,
      exportProgress: null,
      error: null,
    });
  });

  afterEach(cleanup);

  function openDialog(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    return screen.getByRole('dialog');
  }

  function typesGroup(dialog: HTMLElement): HTMLElement {
    return within(dialog).getByRole('group', { name: 'Object types' });
  }

  function exportButton(dialog: HTMLElement): HTMLButtonElement {
    return within(dialog).getByRole('button', { name: 'Export' }) as HTMLButtonElement;
  }

  it('disables the trigger while loading or without page data', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ExportDialog));
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    usePdfStore.setState({ pageData: pageOne, isLoading: true });
    render(React.createElement(ExportDialog));
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    usePdfStore.setState({ isLoading: false });
    render(React.createElement(ExportDialog));
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the modal with page scope, JSON and every type selected', () => {
    render(React.createElement(ExportDialog));

    const dialog = openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Export');

    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect((within(dialog).getByRole('radio', { name: 'Current page' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: 'Whole document' }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole('radio', { name: 'JSON' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: 'CSV' }) as HTMLInputElement).checked).toBe(false);

    const checkboxes = within(typesGroup(dialog)).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(7);
    checkboxes.forEach((box) => expect((box as HTMLInputElement).checked).toBe(true));
  });

  it('exports the current page as JSON without the unselected type', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(within(typesGroup(dialog)).getByRole('checkbox', { name: 'Chars' }));
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];
    const parsed = JSON.parse(request.content);

    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].chars).toEqual([]);
    expect(parsed.pages[0].words).toHaveLength(1);
    expect(parsed.objectTypes).not.toContain('char');
    expect(parsed.objectTypes).toHaveLength(6);
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);
    expect(request.defaultPath).toBe('doc-p1.json');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(usePdfStore.getState().exportProgress).toBeNull();
    expect(extractPage).not.toHaveBeenCalled();
  });

  it('disables Export when no type is selected', () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(within(typesGroup(dialog)).getByRole('button', { name: 'Clear' }));

    expect(exportButton(dialog).disabled).toBe(true);
  });

  it('exports CSV with only the words section', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    const types = typesGroup(dialog);
    fireEvent.click(within(types).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Words' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'CSV' }));
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];

    expect(request.content).toContain('# words');
    expect(request.content).not.toContain('# chars');
    expect(request.filterName).toBe('CSV');
    expect(request.extensions).toEqual(['csv']);
    expect(request.defaultPath).toBe('doc-p1.csv');
  });

  it('extracts every page for a whole-document export', async () => {
    extractPage.mockImplementation(async (page: number) => makePage(page));
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Whole document' }));
    const types = typesGroup(dialog);
    fireEvent.click(within(types).getByRole('button', { name: 'Clear' }));
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Words' }));
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(extractPage).toHaveBeenCalledTimes(3);
    expect(extractPage).toHaveBeenNthCalledWith(1, 1);
    expect(extractPage).toHaveBeenNthCalledWith(2, 2);
    expect(extractPage).toHaveBeenNthCalledWith(3, 3);

    const request = saveFile.mock.calls[0][0];
    const parsed = JSON.parse(request.content);
    expect(parsed.pageCount).toBe(3);
    expect(parsed.objectTypes).toEqual(['word']);
    expect(parsed.pages.every((page: { words: unknown[] }) => page.words.length === 1)).toBe(true);
    expect(request.defaultPath).toBe('doc-all.json');
    expect(usePdfStore.getState().exportProgress).toBeNull();
  });

  it('closes on Escape while idle without reaching the app-level handler', () => {
    const appLevelEscape = vi.fn();
    window.addEventListener('keydown', appLevelEscape);
    render(React.createElement(ExportDialog));

    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appLevelEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appLevelEscape);
  });

  it('keeps the dialog open with an inline error when saving fails', async () => {
    saveFile.mockResolvedValue({ canceled: false, error: 'disk full' });
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Export failed: disk full'));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(exportButton(dialog).disabled).toBe(false);
  });

  it('resets the selection when reopened', () => {
    render(React.createElement(ExportDialog));

    let dialog = openDialog();
    fireEvent.click(within(typesGroup(dialog)).getByRole('button', { name: 'Clear' }));
    expect(exportButton(dialog).disabled).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    dialog = openDialog();
    const checkboxes = within(typesGroup(dialog)).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(7);
    checkboxes.forEach((box) => expect((box as HTMLInputElement).checked).toBe(true));
    expect(exportButton(dialog).disabled).toBe(false);
  });
});
