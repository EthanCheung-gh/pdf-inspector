// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n/store';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import { listCommands } from '../../services/command-registry';
import { EXPORT_OBJECT_TYPES } from '../../services/export-data';
import type { SaveFileRequest } from '../../types/ipc-protocol';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';

const { saveFile, capturePage, capturePageSvg } = vi.hoisted(() => ({
  saveFile: vi.fn(),
  capturePage: vi.fn(),
  capturePageSvg: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { saveFile },
}));

vi.mock('../../services/export-capture', () => ({
  capturePage,
  capturePageSvg,
}));

import { ExportViewDialog } from './ExportViewDialog';

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

const annotation: PdfAnnotation = {
  id: 'a1',
  page: 1,
  subtype: 'Highlight',
  kind: 'markup',
  rect: { x0: 10, y0: 20, x1: 30, y1: 40 },
  title: 'Note',
  contents: 'Body',
  modificationDate: null,
  color: '#ffff00',
  opacity: 1,
  hidden: false,
  link: null,
  form: null,
};

const regionBox = { x0: 10, y0: 20, x1: 110, y1: 220 };

function makeCaptured(warnings: string[] = []): {
  blob: Blob;
  width: number;
  height: number;
  pngDataUrl: string;
  appliedScale: number;
  cropped: boolean;
  warnings: string[];
} {
  return {
    blob: new Blob(['png'], { type: 'image/png' }),
    width: 612,
    height: 792,
    pngDataUrl: 'data:image/png;base64,QUJD',
    appliedScale: 1,
    cropped: false,
    warnings,
  };
}

const SVG_OUTPUT = '<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"></svg>';

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('ExportViewDialog', () => {
  beforeEach(() => {
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.png' });
    capturePage.mockReset();
    capturePage.mockResolvedValue(makeCaptured());
    capturePageSvg.mockReset();
    capturePageSvg.mockReturnValue(SVG_OUTPUT);

    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      sourceUrl: null,
      documentName: null,
      metadata,
      pageCount: 3,
      currentPage: 1,
      pageData: pageOne,
      pdfDocRef: {} as never,
      isLoading: false,
      subset: null,
      error: null,
    });
    useAnnotationStore.setState({ page: 1, annotations: [annotation] });
  });

  afterEach(cleanup);

  function openDialog(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Export view…' }));
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

  function overlayCheckbox(dialog: HTMLElement, name: string): HTMLInputElement {
    return within(within(dialog).getByRole('group', { name: 'Overlays' })).getByRole('checkbox', {
      name,
    }) as HTMLInputElement;
  }

  function exportButton(dialog: HTMLElement): HTMLButtonElement {
    return within(dialog).getByRole('button', { name: 'Export' }) as HTMLButtonElement;
  }

  it('disables the trigger while loading, without page data, or without a PDF document', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ExportViewDialog));
    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    usePdfStore.setState({ pageData: pageOne, pdfDocRef: null });
    render(React.createElement(ExportViewDialog));
    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    usePdfStore.setState({ pdfDocRef: {} as never, isLoading: true });
    render(React.createElement(ExportViewDialog));
    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    usePdfStore.setState({ isLoading: false });
    render(React.createElement(ExportViewDialog));
    expect((screen.getByRole('button', { name: 'Export view…' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens with page scope, PNG, 1x, objects+annotations and every type', () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    expect(within(dialog).getByRole('heading', { name: 'Export view' })).toBeTruthy();
    expect((within(dialog).getByRole('radio', { name: 'Current page' }) as HTMLInputElement).checked).toBe(true);

    const regionRadio = within(dialog).getByRole('radio', { name: 'Selected region' }) as HTMLInputElement;
    expect(regionRadio.checked).toBe(false);
    expect(regionRadio.disabled).toBe(true);
    expect(within(dialog).getByText('Select a region first')).toBeTruthy();

    expect((within(dialog).getByRole('radio', { name: 'PNG' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: 'SVG' }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole('radio', { name: '1x' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: '2x' }) as HTMLInputElement).checked).toBe(false);

    expect(overlayCheckbox(dialog, 'Objects').checked).toBe(true);
    expect(overlayCheckbox(dialog, 'Annotations').checked).toBe(true);
    expect(overlayCheckbox(dialog, 'Page boxes').checked).toBe(false);

    const checkboxes = within(typesGroup(dialog)).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(EXPORT_OBJECT_TYPES.length);
    checkboxes.forEach((box) => expect((box as HTMLInputElement).checked).toBe(true));

    expect(fileNameInput(dialog).value).toBe('doc-p1.png');
    expect(fileNameInput(dialog).placeholder).toBe('report-p1.png');
  });

  it('enables the region scope only with a region subset and passes its bbox to the capture', async () => {
    usePdfStore.setState({
      subset: { source: 'region', mode: 'contain', objects: [], bbox: regionBox },
    });
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    const regionRadio = within(dialog).getByRole('radio', { name: 'Selected region' }) as HTMLInputElement;
    expect(regionRadio.disabled).toBe(false);
    expect(within(dialog).queryByText('Select a region first')).toBeNull();

    fireEvent.click(regionRadio);
    expect(regionRadio.checked).toBe(true);
    expect(fileNameInput(dialog).value).toBe('doc-p1-region.png');

    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(capturePage.mock.calls[0][4].region).toEqual(regionBox);
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('doc-p1-region.png');
  });

  it('saves a PNG as base64 binary with the PNG MIME type', async () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0] as SaveFileRequest;

    expect(request.defaultPath).toBe('doc-p1.png');
    expect(request.filterName).toBe('PNG');
    expect(request.extensions).toEqual(['png']);
    expect(request.encoding).toBe('base64');
    expect(request.mimeType).toBe('image/png');
    expect(request.content).toBe('QUJD');
    expect(capturePage.mock.calls[0][1]).toBe(1);
    expect(capturePage.mock.calls[0][2]).toBe(pageOne);
    expect(capturePage.mock.calls[0][3]).toEqual([annotation]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('builds an SVG and saves it as utf8', async () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'SVG' }));
    expect(fileNameInput(dialog).value).toBe('doc-p1.svg');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0] as SaveFileRequest;

    expect(capturePageSvg).toHaveBeenCalledTimes(1);
    expect(capturePageSvg.mock.calls[0][1]).toBe(pageOne);
    expect(capturePageSvg.mock.calls[0][2]).toEqual([annotation]);
    expect(request.defaultPath).toBe('doc-p1.svg');
    expect(request.filterName).toBe('SVG');
    expect(request.extensions).toEqual(['svg']);
    expect(request.encoding).toBe('utf8');
    expect(request.mimeType).toBe('image/svg+xml');
    expect(request.content).toContain('<svg');
  });

  it('passes the selected object types, scale and overlays to the capture', async () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(within(typesGroup(dialog)).getByRole('checkbox', { name: 'Chars' }));
    fireEvent.click(overlayCheckbox(dialog, 'Annotations'));
    fireEvent.click(overlayCheckbox(dialog, 'Page boxes'));
    fireEvent.click(within(dialog).getByRole('radio', { name: '2x' }));
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const options = capturePage.mock.calls[0][4];

    expect(options.scale).toBe(2);
    expect(options.overlays).toEqual({ objects: true, annotations: false, pageBoxes: true });
    expect(options.objectTypes).toHaveLength(EXPORT_OBJECT_TYPES.length - 1);
    expect(options.objectTypes).not.toContain('char');
  });

  it('disables the object type selector while object overlays are off', () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(overlayCheckbox(dialog, 'Objects'));

    expect(
      (within(typesGroup(dialog)).getByRole('checkbox', { name: 'Chars' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(exportButton(dialog).disabled).toBe(false);
  });

  it('follows the generated name on scope/format changes until the user edits it', () => {
    usePdfStore.setState({
      subset: { source: 'region', mode: 'contain', objects: [], bbox: regionBox },
    });
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    expect(fileNameInput(dialog).value).toBe('doc-p1.png');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'SVG' }));
    expect(fileNameInput(dialog).value).toBe('doc-p1.svg');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Selected region' }));
    expect(fileNameInput(dialog).value).toBe('doc-p1-region.svg');

    setFileName(dialog, 'my capture.png');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Current page' }));
    expect(fileNameInput(dialog).value).toBe('my capture.png');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'PNG' }));
    expect(fileNameInput(dialog).value).toBe('my capture.png');
  });

  it('sanitises a custom file name and enforces the format extension', async () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    setFileName(dialog, 're:port<1>?');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('re_port_1__.png');
  });

  it('falls back to the generated name when the custom name is unusable', async () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    setFileName(dialog, '***');
    fireEvent.click(exportButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('doc-p1.png');
  });

  it('prefers the document display name and decodes an encoded source URL', () => {
    usePdfStore.setState({
      filePath: '/tmp/_____-1a2b.pdf',
      documentName: '测试 报告.pdf',
    });
    render(React.createElement(ExportViewDialog));
    expect(fileNameInput(openDialog()).value).toBe('测试 报告-p1.png');
    cleanup();

    usePdfStore.setState({
      filePath: 'http://localhost:8080/doc/x/%E6%B5%8B%E8%AF%95%20report.pdf',
      documentName: null,
    });
    render(React.createElement(ExportViewDialog));
    expect(fileNameInput(openDialog()).value).toBe('测试 report-p1.png');
  });

  it('closes on Cancel without capturing or saving', () => {
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('closes on Escape while idle without reaching the app-level handler', () => {
    const appLevelEscape = vi.fn();
    window.addEventListener('keydown', appLevelEscape);
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appLevelEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appLevelEscape);
  });

  it('shows a save error and keeps the dialog open', async () => {
    saveFile.mockResolvedValue({ canceled: false, error: 'disk full' });
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe('Export failed: disk full'),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(exportButton(dialog).disabled).toBe(false);
  });

  it('shows a capture error and keeps the dialog open', async () => {
    capturePage.mockRejectedValue(new Error('render boom'));
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe('Export failed: render boom'),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('cannot be closed while an export is running', async () => {
    let resolveCapture: (value: ReturnType<typeof makeCaptured>) => void = () => undefined;
    capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Exporting…' })).toBeTruthy());

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole('dialog')).toBe(dialog);

    await act(async () => {
      resolveCapture(makeCaptured());
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps capture warnings visible when the save is cancelled', async () => {
    capturePage.mockResolvedValue(makeCaptured(['Region is empty; exported the full page.']));
    saveFile.mockResolvedValue({ canceled: true });
    render(React.createElement(ExportViewDialog));
    const dialog = openDialog();

    fireEvent.click(exportButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByText('Region is empty; exported the full page.')).toBeTruthy(),
    );
    expect(within(dialog).getByText('Warnings')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(exportButton(dialog).disabled).toBe(false);
  });

  it('translates the dialog chrome and restores English when the locale changes back', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(ExportViewDialog));

    fireEvent.click(screen.getByRole('button', { name: '导出视图…' }));
    const dialog = screen.getByRole('dialog', { name: '导出视图' });

    expect(within(dialog).getByRole('radio', { name: '当前页' })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: '所选区域' })).toBeTruthy();
    expect(within(dialog).getByLabelText('文件名')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '导出' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(within(dialog).getByRole('heading', { name: 'Export view' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('ExportViewDialog command registration', () => {
  const exportViewCommand = () => listCommands().find((command) => command.id === 'export.view');

  beforeEach(() => {
    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      pageData: pageOne,
      pdfDocRef: {} as never,
      isLoading: false,
    });
    useAnnotationStore.setState({ page: 1, annotations: [] });
  });

  afterEach(cleanup);

  it('registers an enabled command that opens the dialog', () => {
    render(React.createElement(ExportViewDialog));

    const command = exportViewCommand();
    expect(command).toBeTruthy();
    expect(command?.isEnabled?.()).toBe(true);

    act(() => {
      command?.run();
    });

    expect(screen.getByRole('heading', { name: 'Export view' })).toBeTruthy();
  });

  it('is disabled while the page data or PDF document is missing', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ExportViewDialog));
    expect(exportViewCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pageData: pageOne, pdfDocRef: null });
    });
    expect(exportViewCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pdfDocRef: {} as never, isLoading: true });
    });
    expect(exportViewCommand()?.isEnabled?.()).toBe(false);
  });

  it('unregisters the command on unmount', () => {
    const view = render(React.createElement(ExportViewDialog));
    expect(exportViewCommand()).toBeTruthy();

    view.unmount();
    expect(exportViewCommand()).toBeUndefined();
  });
});
