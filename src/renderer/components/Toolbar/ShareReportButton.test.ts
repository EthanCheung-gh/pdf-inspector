// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n/store';
import { useAnnotationIndexStore } from '../../store/annotation-index-store';
import { useAnnotationStore } from '../../store/annotation-store';
import { useAuditStore } from '../../store/audit-store';
import { usePdfStore } from '../../store/pdf-store';
import { listCommands } from '../../services/command-registry';
import type { AuditReport } from '../../../shared/audit-types';
import type { AnnotationIndexResult } from '../../services/annotation-index';
import type { SaveFileRequest } from '../../types/ipc-protocol';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageData, PdfMetadata } from '../../types/pdf-objects';

const { saveFile, capturePage } = vi.hoisted(() => ({
  saveFile: vi.fn(),
  capturePage: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { saveFile },
}));

vi.mock('../../services/export-capture', () => ({
  capturePage,
}));

import { ShareReportButton } from './ShareReportButton';

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

const pageData: PageData = {
  width: 612,
  height: 792,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
};

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

const annotationIndex: AnnotationIndexResult = {
  annotations: [],
  summary: {
    annotations: 2,
    pagesWithAnnotations: 1,
    links: 1,
    forms: 0,
    markup: 1,
    notes: 0,
    stamps: 0,
    other: 0,
    hidden: 0,
    unresolvedLinks: 0,
    unsafeLinks: 1,
    formFields: 0,
  },
  linkIssues: [
    {
      annotationId: 'a2',
      page: 1,
      subtype: 'Link',
      kind: 'unsafe',
      target: 'javascript:alert(1)',
      message: 'Link uses an unsafe target scheme',
    },
  ],
  formIssues: [],
  formFields: [],
  scannedPages: 3,
  truncated: false,
};

const auditReport: AuditReport = {
  schemaVersion: 1,
  tool: { name: 'pdf-inspector', version: '0.2.0' },
  document: {
    pages: 3,
    version: '1.7',
    encrypted: false,
    title: 'Demo',
    author: 'A',
    producer: 'P',
    language: null,
    tagged: false,
  },
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
  findings: [
    {
      category: 'metadata',
      severity: 'warning',
      page: null,
      title: 'Missing language',
      detail: 'The document has no /Lang entry.',
      evidence: null,
      recommendation: 'Add /Lang to the catalog.',
    },
  ],
};

function makeCaptured(warnings: string[] = []) {
  return {
    blob: new Blob(['png'], { type: 'image/png' }),
    width: 1224,
    height: 1584,
    pngDataUrl: 'data:image/png;base64,QUJD',
    appliedScale: 2,
    cropped: false,
    warnings,
  };
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('ShareReportButton', () => {
  beforeEach(() => {
    saveFile.mockReset();
    saveFile.mockResolvedValue({ canceled: false, filePath: '/tmp/doc-report.html' });
    capturePage.mockReset();
    capturePage.mockResolvedValue(makeCaptured());

    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      sourceUrl: null,
      documentName: null,
      metadata,
      pageCount: 3,
      currentPage: 1,
      pageData,
      pdfDocRef: {} as never,
      isLoading: false,
      error: null,
      fontStats: null,
    });
    useAnnotationStore.setState({ page: 1, annotations: [annotation] });
    useAnnotationIndexStore.getState().reset();
    useAuditStore.getState().reset();
  });

  afterEach(cleanup);

  function openDialog(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Share report…' }));
    return screen.getByRole('dialog');
  }

  function fileNameInput(dialog: HTMLElement): HTMLInputElement {
    return within(dialog).getByLabelText('File name') as HTMLInputElement;
  }

  function generateButton(dialog: HTMLElement): HTMLButtonElement {
    return within(dialog).getByRole('button', { name: 'Generate report' }) as HTMLButtonElement;
  }

  it('disables the trigger while loading, without page data, or without a PDF document', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ShareReportButton));
    expect(
      (screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    usePdfStore.setState({ pageData, pdfDocRef: null });
    render(React.createElement(ShareReportButton));
    expect(
      (screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    usePdfStore.setState({ pdfDocRef: {} as never, isLoading: true });
    render(React.createElement(ShareReportButton));
    expect(
      (screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    usePdfStore.setState({ isLoading: false });
    render(React.createElement(ShareReportButton));
    expect(
      (screen.getByRole('button', { name: 'Share report…' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('opens with the generated report name and scope description', () => {
    render(React.createElement(ShareReportButton));
    const dialog = openDialog();

    expect(within(dialog).getByRole('heading', { name: 'Share report' })).toBeTruthy();
    expect(fileNameInput(dialog).value).toBe('doc-report.html');
    expect(
      within(dialog).getByText('The report contains no scripts and no external resources.'),
    ).toBeTruthy();
  });

  it('captures the current page and saves a UTF-8 HTML report', async () => {
    render(React.createElement(ShareReportButton));
    const dialog = openDialog();

    fireEvent.click(generateButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const request = saveFile.mock.calls[0][0] as SaveFileRequest;

    expect(request.defaultPath).toBe('doc-report.html');
    expect(request.filterName).toBe('HTML');
    expect(request.extensions).toEqual(['html']);
    expect(request.encoding).toBe('utf8');
    expect(request.mimeType).toBe('text/html');
    expect(request.content).toContain('<!doctype html>');
    expect(request.content).toContain('<html lang="en">');
    expect(request.content).toContain('data:image/png;base64,QUJD');

    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(capturePage.mock.calls[0][1]).toBe(1);
    expect(capturePage.mock.calls[0][2]).toBe(pageData);
    expect(capturePage.mock.calls[0][3]).toEqual([annotation]);
    expect(capturePage.mock.calls[0][4]).toEqual({
      scale: 2,
      region: null,
      overlays: { objects: true, annotations: true, pageBoxes: false },
      objectTypes: undefined,
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('includes audit and annotation index data for the open document', async () => {
    useAuditStore.setState({ filePath: '/tmp/doc.pdf', fileName: 'doc.pdf', report: auditReport });
    useAnnotationIndexStore.setState({
      documentKey: '/tmp/doc.pdf',
      status: 'ready',
      result: annotationIndex,
    });

    render(React.createElement(ShareReportButton));
    fireEvent.click(generateButton(openDialog()));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const content = (saveFile.mock.calls[0][0] as SaveFileRequest).content;

    expect(content).toContain('Missing language');
    expect(content).toContain('Unsafe links');
    expect(content).toContain('Link uses an unsafe target scheme');
  });

  it('drops audit and index data that belongs to another document', async () => {
    useAuditStore.setState({
      filePath: '/tmp/other.pdf',
      fileName: 'other.pdf',
      report: auditReport,
    });
    useAnnotationIndexStore.setState({
      documentKey: '/tmp/other.pdf',
      status: 'ready',
      result: annotationIndex,
    });

    render(React.createElement(ShareReportButton));
    fireEvent.click(generateButton(openDialog()));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const content = (saveFile.mock.calls[0][0] as SaveFileRequest).content;

    expect(content).toContain('Audit not run.');
    expect(content).toContain('Document annotation index not available.');
    expect(content).not.toContain('Missing language');
  });

  it('keeps capture warnings visible when the save is cancelled', async () => {
    capturePage.mockResolvedValue(makeCaptured(['Region is empty; exported the full page.']));
    saveFile.mockResolvedValue({ canceled: true });

    render(React.createElement(ShareReportButton));
    const dialog = openDialog();
    fireEvent.click(generateButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByText('Region is empty; exported the full page.')).toBeTruthy(),
    );
    expect(within(dialog).getByText('Warnings')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(generateButton(dialog).disabled).toBe(false);
  });

  it('closes on Cancel without capturing or saving', () => {
    render(React.createElement(ShareReportButton));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('shows a capture error and keeps the dialog open', async () => {
    capturePage.mockRejectedValue(new Error('render boom'));

    render(React.createElement(ShareReportButton));
    const dialog = openDialog();
    fireEvent.click(generateButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'Could not create the report: render boom',
      ),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('shows a save error and keeps the dialog open', async () => {
    saveFile.mockResolvedValue({ canceled: false, error: 'disk full' });

    render(React.createElement(ShareReportButton));
    const dialog = openDialog();
    fireEvent.click(generateButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'Could not create the report: disk full',
      ),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('sanitises a custom name and falls back to the generated suggestion', async () => {
    render(React.createElement(ShareReportButton));
    let dialog = openDialog();

    fireEvent.change(fileNameInput(dialog), { target: { value: 're:port<1>?' } });
    fireEvent.click(generateButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].defaultPath).toBe('re_port_1__.html');

    fireEvent.click(screen.getByRole('button', { name: 'Share report…' }));
    dialog = screen.getByRole('dialog');
    fireEvent.change(fileNameInput(dialog), { target: { value: '***' } });
    fireEvent.click(generateButton(dialog));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
    expect(saveFile.mock.calls[1][0].defaultPath).toBe('doc-report.html');
  });

  it('cannot be closed while the report is being generated', async () => {
    let resolveCapture: (value: ReturnType<typeof makeCaptured>) => void = () => undefined;
    capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );

    render(React.createElement(ShareReportButton));
    const dialog = openDialog();
    fireEvent.click(generateButton(dialog));

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Generating…' })).toBeTruthy(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);

    await act(async () => {
      resolveCapture(makeCaptured());
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('translates the dialog and passes the active locale to the report', async () => {
    useI18nStore.setState({ locale: 'zh-CN' });

    render(React.createElement(ShareReportButton));
    fireEvent.click(screen.getByRole('button', { name: '分享报告…' }));
    const dialog = screen.getByRole('dialog', { name: '分享报告' });

    expect(within(dialog).getByLabelText('文件名')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '生成报告' }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect((saveFile.mock.calls[0][0] as SaveFileRequest).content).toContain(
      '<html lang="zh-CN">',
    );
  });
});

describe('ShareReportButton command registration', () => {
  const reportCommand = () => listCommands().find((command) => command.id === 'export.report');

  beforeEach(() => {
    useI18nStore.setState({ locale: 'en' });
    capturePage.mockReset();
    capturePage.mockResolvedValue(makeCaptured());
    usePdfStore.setState({
      filePath: '/tmp/doc.pdf',
      pageData,
      pdfDocRef: {} as never,
      isLoading: false,
    });
    useAnnotationStore.setState({ page: 1, annotations: [] });
  });

  afterEach(cleanup);

  it('registers an enabled command that opens the dialog', () => {
    render(React.createElement(ShareReportButton));

    const command = reportCommand();
    expect(command).toBeTruthy();
    expect(command?.title).toBe('Share report…');
    expect(command?.group).toBe('Export');
    expect(command?.isEnabled?.()).toBe(true);

    act(() => {
      command?.run();
    });
    expect(screen.getByRole('heading', { name: 'Share report' })).toBeTruthy();
  });

  it('is disabled while the page data or PDF document is missing', () => {
    usePdfStore.setState({ pageData: null });
    render(React.createElement(ShareReportButton));
    expect(reportCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pageData, pdfDocRef: null });
    });
    expect(reportCommand()?.isEnabled?.()).toBe(false);

    act(() => {
      usePdfStore.setState({ pdfDocRef: {} as never, isLoading: true });
    });
    expect(reportCommand()?.isEnabled?.()).toBe(false);
  });

  it('unregisters the command on unmount', () => {
    const view = render(React.createElement(ShareReportButton));
    expect(reportCommand()).toBeTruthy();

    view.unmount();
    expect(reportCommand()).toBeUndefined();
  });
});
