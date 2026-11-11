// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationIndexResult } from '../../services/annotation-index';
import type { SaveFileRequest } from '../../types/ipc-protocol';
import type { PdfAnnotation } from '../../types/annotations';

const { saveFile } = vi.hoisted(() => ({
  saveFile: vi.fn<
    (request: SaveFileRequest) => Promise<{ canceled: boolean; filePath?: string; error?: string }>
  >(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: { saveFile } }));

import { AnnotationExportDialog } from './AnnotationExportDialog';

const base = {
  rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
  title: null,
  contents: null,
  modificationDate: null,
  color: null,
  opacity: null,
  hidden: false,
  link: null,
  form: null,
} as const;

const pageTwoLink: PdfAnnotation = {
  ...base,
  page: 2,
  id: '2:link',
  subtype: 'Link',
  kind: 'link',
  link: {
    url: 'https://example.com/b',
    unsafeUrl: 'https://example.com/b',
    internalPage: null,
    newWindow: false,
  },
};

const pageThreeNote: PdfAnnotation = {
  ...base,
  page: 3,
  id: '3:note',
  subtype: 'Text',
  kind: 'note',
  contents: 'Please review the invoice',
};

const result: AnnotationIndexResult = {
  annotations: [pageTwoLink, pageThreeNote],
  summary: {
    annotations: 2,
    pagesWithAnnotations: 2,
    links: 1,
    forms: 0,
    markup: 0,
    notes: 1,
    stamps: 0,
    other: 0,
    hidden: 0,
    unresolvedLinks: 0,
    unsafeLinks: 0,
    formFields: 0,
  },
  linkIssues: [],
  formIssues: [],
  formFields: [],
  scannedPages: 3,
  truncated: false,
};

/** Render props helper so each test only states what it cares about. */
function renderDialog(overrides: Partial<React.ComponentProps<typeof AnnotationExportDialog>> = {}) {
  const onClose = vi.fn();
  const props = {
    open: true,
    result,
    documentName: 'doc.pdf',
    sourceUrl: null,
    filePath: '/tmp/doc.pdf',
    pageCount: 3,
    onClose,
    ...overrides,
  } satisfies React.ComponentProps<typeof AnnotationExportDialog>;

  const view = render(React.createElement(AnnotationExportDialog, props));
  return { ...view, onClose, props };
}

const dialog = (): HTMLElement => screen.getByRole('dialog');

const fileNameInput = (): HTMLInputElement =>
  within(dialog()).getByLabelText('File name') as HTMLInputElement;

const exportButton = (): HTMLButtonElement =>
  within(dialog()).getByRole('button', { name: 'Export' }) as HTMLButtonElement;

const csvRadio = (): HTMLInputElement =>
  within(dialog()).getByRole('radio', { name: 'CSV' }) as HTMLInputElement;

const jsonRadio = (): HTMLInputElement =>
  within(dialog()).getByRole('radio', { name: 'JSON' }) as HTMLInputElement;

describe('AnnotationExportDialog', () => {
  beforeEach(() => {
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });
  });

  afterEach(cleanup);

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens as a labelled modal named after the annotation export', () => {
    renderDialog();

    expect(dialog().getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog().getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Export annotations');

    expect(jsonRadio().checked).toBe(true);
    expect(csvRadio().checked).toBe(false);
  });

  it('prefills the annotation export name for the open document', () => {
    renderDialog();

    expect(fileNameInput().value).toBe('doc-annotations.json');
    expect(fileNameInput().placeholder).toBe('report-annotations.json');
  });

  it('prefers the display name and decodes URL documents', () => {
    renderDialog({ documentName: '测试 报告.pdf', filePath: '/tmp/_____-1a2b.pdf' });
    expect(fileNameInput().value).toBe('测试 报告-annotations.json');
    cleanup();

    renderDialog({
      documentName: null,
      sourceUrl: 'http://localhost:8080/doc/x/%E6%B5%8B%E8%AF%95%20report.pdf',
      filePath: '/tmp/tmp-1a2b.pdf',
    });
    expect(fileNameInput().value).toBe('测试 report-annotations.json');
  });

  it('follows the format while the name is untouched', () => {
    renderDialog();

    fireEvent.click(csvRadio());

    expect(csvRadio().checked).toBe(true);
    expect(fileNameInput().value).toBe('doc-annotations.csv');
  });

  it('keeps an edited stem and only swaps its extension', () => {
    renderDialog();

    fireEvent.change(fileNameInput(), { target: { value: 'audit 2024.json' } });
    fireEvent.click(csvRadio());

    expect(fileNameInput().value).toBe('audit 2024.csv');

    fireEvent.click(jsonRadio());
    expect(fileNameInput().value).toBe('audit 2024.json');
  });

  it('saves JSON with the index document block and no disk path', async () => {
    renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];

    expect(request.defaultPath).toBe('doc-annotations.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);

    const parsed = JSON.parse(request.content);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.tool).toEqual({ name: 'pdf-inspector', version: '0.2.0' });
    expect(parsed.document).toEqual({ name: 'doc.pdf', sourceUrl: null, pages: 3 });
    expect(parsed.summary).toEqual(result.summary);
    expect(parsed.pages.map((group: { page: number }) => group.page)).toEqual([2, 3]);
    expect(parsed.linkIssues).toEqual([]);
    expect(parsed.formFields).toEqual([]);
    // The local path the dialog was handed stays out of the payload.
    expect(request.content).not.toContain('/tmp/doc.pdf');
  });

  it('saves CSV with a BOM and the annotation sections', async () => {
    renderDialog();

    fireEvent.click(csvRadio());
    fireEvent.click(exportButton());

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0];

    expect(request.defaultPath).toBe('doc-annotations.csv');
    expect(request.filterName).toBe('CSV');
    expect(request.extensions).toEqual(['csv']);
    expect(request.content.startsWith('\uFEFF# annotations\n')).toBe(true);
    expect(request.content).toContain('2,Link,link,"0,0,10,10",false,,,https://example.com/b,,,,');
    expect(request.content).toContain('3,Text,note,');
    expect(request.content).toContain('# links');
    expect(request.content).toContain('# form_fields');
  });

  it('closes after a saved export', async () => {
    const { onClose } = renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('submits a custom file name with the export extension', async () => {
    renderDialog();

    fireEvent.change(fileNameInput(), { target: { value: 'my annotations' } });
    fireEvent.click(exportButton());

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('my annotations.json');
  });

  it('falls back to the suggestion when the custom name is unusable', async () => {
    renderDialog();

    fireEvent.change(fileNameInput(), { target: { value: '***' } });
    fireEvent.click(exportButton());

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('doc-annotations.json');
  });

  it('never submits a directory path from the name field', async () => {
    renderDialog();

    fireEvent.change(fileNameInput(), { target: { value: '/etc/passwd' } });
    fireEvent.click(exportButton());

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('passwd.json');
  });

  it('closes silently when the save dialog is cancelled', async () => {
    saveFile.mockResolvedValue({ canceled: true });
    const { onClose } = renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Cancelling is not a failure: the error area stays empty.
    expect(within(dialog()).getByRole('alert').textContent).toBe('');
  });

  it('keeps the dialog open with an inline error when saving fails', async () => {
    saveFile.mockResolvedValue({ canceled: false, error: 'disk full' });
    const { onClose } = renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() =>
      expect(within(dialog()).getByRole('alert').textContent).toBe('Export failed: disk full'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(exportButton().disabled).toBe(false);
  });

  it('reports a rejected save request', async () => {
    saveFile.mockRejectedValue(new Error('no such directory'));
    renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() =>
      expect(within(dialog()).getByRole('alert').textContent).toBe('no such directory'),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('disables the fields and ignores Escape while saving', async () => {
    let resolveSave: (value: { canceled: boolean }) => void = () => undefined;
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { onClose } = renderDialog();

    fireEvent.click(exportButton());

    await waitFor(() => expect(fileNameInput().disabled).toBe(true));
    expect(within(dialog()).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    resolveSave({ canceled: false });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(exportButton().disabled).toBe(false));
  });

  it('closes on Escape while idle without reaching the app-level handler', () => {
    const appLevelEscape = vi.fn();
    window.addEventListener('keydown', appLevelEscape);
    const { onClose } = renderDialog();

    fireEvent.keyDown(dialog(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(appLevelEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appLevelEscape);
  });

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    const { onClose } = renderDialog();

    fireEvent.click(within(dialog()).getByRole('heading'));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = dialog().parentElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes through the Cancel button', () => {
    const { onClose } = renderDialog();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('resets the draft when reopened', () => {
    const { rerender, onClose } = renderDialog({ documentName: 'doc.pdf' });

    fireEvent.change(fileNameInput(), { target: { value: 'custom.csv' } });
    fireEvent.click(csvRadio());
    rerender(
      React.createElement(AnnotationExportDialog, {
        open: false,
        result,
        documentName: 'doc.pdf',
        sourceUrl: null,
        filePath: '/tmp/doc.pdf',
        pageCount: 3,
        onClose,
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(
      React.createElement(AnnotationExportDialog, {
        open: true,
        result,
        documentName: 'doc.pdf',
        sourceUrl: null,
        filePath: '/tmp/doc.pdf',
        pageCount: 3,
        onClose,
      }),
    );

    expect(jsonRadio().checked).toBe(true);
    expect(fileNameInput().value).toBe('doc-annotations.json');
  });

  it('sizes the modal for a narrow window with the shared theme tokens', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/components/LeftPanel/AnnotationExportDialog.module.css'),
      'utf8',
    );
    const rule = (selector: string): string =>
      css.match(new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';

    expect(rule('dialog')).toContain('width: 420px');
    expect(rule('dialog')).toContain('max-width: calc(100vw - 32px)');
    expect(rule('dialog')).toContain('var(--pi-bg-panel)');
    expect(rule('backdrop')).toContain('position: fixed');
    expect(rule('backdrop')).toContain('z-index: 1000');
    expect(rule('actions')).toContain('justify-content: flex-end');
    expect(rule('primary')).toContain('var(--pi-accent-strong)');
  });
});
