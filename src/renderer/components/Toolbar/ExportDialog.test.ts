// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';
import { listCommands } from '../../services/command-registry';
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
      documentName: null,
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

  function fileNameInput(dialog: HTMLElement): HTMLInputElement {
    return within(dialog).getByLabelText('File name') as HTMLInputElement;
  }

  function setFileName(dialog: HTMLElement, value: string): void {
    fireEvent.change(fileNameInput(dialog), { target: { value } });
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

  it('prefills the file name with the generated suggestion', () => {
    render(React.createElement(ExportDialog));

    const dialog = openDialog();
    const input = fileNameInput(dialog);

    expect(input.value).toBe('doc-p1.json');
    expect(input.placeholder).toBe('report-p1.json');
  });

  it('prefers the document display name and decodes encoded paths', () => {
    usePdfStore.setState({
      filePath: '/tmp/_____-1a2b.pdf',
      documentName: '测试 报告.pdf',
    });
    render(React.createElement(ExportDialog));

    expect(fileNameInput(openDialog()).value).toBe('测试 报告-p1.json');
    cleanup();

    usePdfStore.setState({
      filePath: 'http://localhost:8080/doc/x/%E6%B5%8B%E8%AF%95%20report.pdf',
      documentName: null,
    });
    render(React.createElement(ExportDialog));

    expect(fileNameInput(openDialog()).value).toBe('测试 report-p1.json');
  });

  it('submits a custom file name with the export extension', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    setFileName(dialog, 'my export');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('my export.json');
  });

  it('keeps a custom stem and swaps the extension when the format changes', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    setFileName(dialog, 'my export.json');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'CSV' }));

    expect(fileNameInput(dialog).value).toBe('my export.csv');

    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('my export.csv');
    expect(saveFile.mock.calls[0][0].extensions).toEqual(['csv']);
  });

  it('updates the whole suggestion while the name was not edited', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Whole document' }));
    expect(fileNameInput(dialog).value).toBe('doc-all.json');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'CSV' }));
    expect(fileNameInput(dialog).value).toBe('doc-all.csv');

    extractPage.mockImplementation(async (page: number) => makePage(page));
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('doc-all.csv');
  });

  it('falls back to the generated name when the custom name is unusable', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    setFileName(dialog, '***');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('doc-p1.json');
  });

  it('never submits a directory path from the name field', async () => {
    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    setFileName(dialog, '/etc/passwd');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('passwd.json');
  });

  it('disables the name field while exporting', async () => {
    let resolveSave: (value: { canceled: boolean }) => void = () => undefined;
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(React.createElement(ExportDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(fileNameInput(dialog).disabled).toBe(true));
    resolveSave({ canceled: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

describe('ExportDialog command registration', () => {
  const exportCommand = () => listCommands().find((command) => command.id === 'export.objects');

  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      pageData: pageOne,
      isLoading: false,
      exportProgress: null,
    });
  });

  afterEach(cleanup);

  it('registers an enabled export command that opens the dialog', () => {
    render(React.createElement(ExportDialog));

    const command = exportCommand();
    expect(command).toBeTruthy();
    expect(command?.isEnabled?.()).toBe(true);

    act(() => {
      command?.run();
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Export' })).toBeTruthy();
  });

  it('is disabled while page data is missing or the document is loading', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ExportDialog));
    expect(exportCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pageData: pageOne, isLoading: true });
    });
    expect(exportCommand()?.isEnabled?.()).toBe(false);
  });

  it('unregisters the command on unmount', () => {
    const view = render(React.createElement(ExportDialog));
    expect(exportCommand()).toBeTruthy();

    view.unmount();
    expect(exportCommand()).toBeUndefined();
  });
});
