// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditReport,
  type AuditDocumentInfo,
  type AuditFinding,
  type AuditReport,
} from '../../../shared/audit-types';

const auditIpc = vi.hoisted(() => ({
  saveFile: vi.fn(),
  auditDocument: vi.fn(),
  auditPages: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../services/ipc-client', () => ({ ipc: auditIpc }));

// "Open page" hands the page to the Inspect navigator; the workspace test only
// needs to see that call, not the extraction that follows it.
vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate: navigation.navigate }),
}));

import {
  AuditWorkspace,
  auditPageLabel,
  filterAuditFindings,
  suggestAuditJsonFilename,
} from './AuditWorkspace';
import { useAuditStore } from '../../store/audit-store';

const TOOL = { name: 'pdf-inspector', version: '0.2.0' };

const store = () => useAuditStore.getState();

function makeDocument(overrides: Partial<AuditDocumentInfo> = {}): AuditDocumentInfo {
  return {
    pages: 12,
    version: '1.7',
    encrypted: false,
    title: 'Quarterly report',
    author: null,
    producer: 'pdf-inspector tests',
    language: 'en-US',
    tagged: true,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    category: 'fonts',
    severity: 'info',
    page: null,
    title: 'Finding',
    detail: 'Finding detail.',
    evidence: null,
    recommendation: null,
    ...overrides,
  };
}

const FINDINGS: AuditFinding[] = [
  makeFinding({
    category: 'fonts',
    severity: 'warning',
    page: null,
    title: 'Font not embedded: Inter',
    detail: 'Inter is referenced but not embedded in the file.',
    evidence: 'Inter, Regular, 400',
    recommendation: 'Embed Inter before distributing the document.',
  }),
  makeFinding({
    category: 'images',
    severity: 'warning',
    page: 2,
    title: 'Low DPI image on page 2',
    detail: 'The image resolves to 72 dpi, below the 96 dpi minimum.',
    evidence: '144 × 144 px on 144 × 144 pt → 72 dpi',
    recommendation: 'Replace the image with a 96 dpi or higher version.',
  }),
  makeFinding({
    category: 'pages',
    severity: 'info',
    page: 3,
    title: 'Page 3 has no content',
    detail: 'Page 3 draws nothing.',
  }),
  makeFinding({
    category: 'metadata',
    severity: 'info',
    page: null,
    title: 'Missing language',
    detail: 'The document has no /Lang entry.',
  }),
];

function makeReport(
  findings: AuditFinding[] = FINDINGS,
  document: Partial<AuditDocumentInfo> = {},
): AuditReport {
  return buildAuditReport(makeDocument(document), findings, TOOL);
}

/** Enter the workspace with a completed report, without running the engine. */
function showReport(report: AuditReport = makeReport()): void {
  useAuditStore.setState({
    active: true,
    filePath: '/docs/report.pdf',
    fileName: 'report.pdf',
    report,
    loading: false,
    progress: null,
    error: null,
    filter: { severity: 'all', category: 'all' },
    selected: null,
  });
}

function renderWorkspace(): void {
  render(React.createElement(AuditWorkspace));
}

const list = (): HTMLElement => screen.getByTestId('audit-finding-list');
const rowNames = (): string[] =>
  within(list())
    .queryAllByRole('button')
    .map((row) => row.getAttribute('aria-label') ?? '');

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  auditIpc.saveFile.mockResolvedValue({ canceled: false });
  auditIpc.auditDocument.mockResolvedValue({
    tool: TOOL,
    document: makeDocument({ pages: 0 }),
    findings: [],
  });
  auditIpc.auditPages.mockResolvedValue({ tool: TOOL, findings: [] });
  navigation.navigate.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('AuditWorkspace summary', () => {
  it('renders the severity counts and the document information', () => {
    showReport();
    renderWorkspace();

    expect(screen.getByTestId('audit-file-name').textContent).toBe('report.pdf');
    expect(screen.getByRole('button', { name: 'Back to Inspect' })).toBeTruthy();

    const summary = screen.getByTestId('audit-summary');
    expect(within(summary).getByText('Errors').nextSibling?.textContent).toBe('0');
    expect(within(summary).getByText('Warnings').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('Info').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('Total').nextSibling?.textContent).toBe('4');

    const document = screen.getByTestId('audit-document-info');
    expect(within(document).getByText('Pages').nextSibling?.textContent).toBe('12');
    expect(within(document).getByText('Version').nextSibling?.textContent).toBe('1.7');
    expect(within(document).getByText('Encrypted').nextSibling?.textContent).toBe('No');
    expect(within(document).getByText('Tagged').nextSibling?.textContent).toBe('Yes');
    expect(within(document).getByText('Language').nextSibling?.textContent).toBe('en-US');

    expect(screen.getByText('4 findings')).toBeTruthy();
    expect(rowNames()).toHaveLength(4);
    expect(within(list()).getByText('Font not embedded: Inter')).toBeTruthy();
    // Document-level findings say "Document", page findings say "Page N".
    expect(within(list()).getAllByText('Document')).toHaveLength(2);
    expect(within(list()).getByText('Page 2')).toBeTruthy();
  });

  it('reports a document without findings as clean instead of an empty list', () => {
    showReport(makeReport([], { encrypted: true, tagged: false, language: null }));
    renderWorkspace();

    expect(screen.getByText(/the document passed every check/)).toBeTruthy();
    expect(screen.queryByTestId('audit-filtered-count')).toBeNull();
    expect(within(list()).queryAllByRole('button')).toHaveLength(0);

    const document = screen.getByTestId('audit-document-info');
    expect(within(document).getByText('Encrypted').nextSibling?.textContent).toBe('Yes');
    expect(within(document).getByText('Tagged').nextSibling?.textContent).toBe('No');
    expect(within(document).getByText('Language').nextSibling?.textContent).toBe('—');
  });
});

describe('AuditWorkspace filtering', () => {
  it('filters the list by severity and category and resets again', () => {
    showReport();
    renderWorkspace();

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by severity'), {
        target: { value: 'warning' },
      });
    });

    expect(store().filter.severity).toBe('warning');
    expect(rowNames()).toEqual([
      'warning fonts Document: Font not embedded: Inter',
      'warning images Page 2: Low DPI image on page 2',
    ]);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('2 of 4 findings');
    // The summary keeps reporting the whole document, not the filtered view.
    const summary = screen.getByTestId('audit-summary');
    expect(within(summary).getByText('Total').nextSibling?.textContent).toBe('4');

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by category'), {
        target: { value: 'fonts' },
      });
    });

    expect(store().filter).toEqual({ severity: 'warning', category: 'fonts' });
    expect(rowNames()).toEqual(['warning fonts Document: Font not embedded: Inter']);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('1 of 4 findings');

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by category'), {
        target: { value: 'security' },
      });
    });

    expect(rowNames()).toEqual([]);
    expect(screen.getByText('No findings match this filter.')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    });

    expect(store().filter).toEqual({ severity: 'all', category: 'all' });
    expect(rowNames()).toHaveLength(4);
    expect(screen.getByText('4 findings')).toBeTruthy();
  });
});

describe('AuditWorkspace finding detail', () => {
  it('shows the selected finding and highlights its row', () => {
    showReport();
    renderWorkspace();

    expect(screen.getByText(/Select a finding/)).toBeTruthy();

    const row = within(list()).getByRole('button', { name: /Low DPI image on page 2/ });
    act(() => {
      fireEvent.click(row);
    });

    expect(store().selected?.title).toBe('Low DPI image on page 2');
    expect(row.getAttribute('aria-pressed')).toBe('true');

    const detail = screen.getByTestId('audit-finding-detail');
    expect(within(detail).getByText('Low DPI image on page 2')).toBeTruthy();
    expect(within(detail).getByText('Images')).toBeTruthy();
    expect(within(detail).getByText('warning')).toBeTruthy();
    expect(within(detail).getByText('Page 2')).toBeTruthy();
    expect(within(detail).getByText(/below the 96 dpi minimum/)).toBeTruthy();
    expect(within(detail).getByText('Evidence')).toBeTruthy();
    expect(within(detail).getByText('144 × 144 px on 144 × 144 pt → 72 dpi')).toBeTruthy();
    expect(within(detail).getByText('Recommendation')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Open page' })).toBeTruthy();

    // Selecting another row moves the highlight and the detail.
    act(() => {
      fireEvent.click(within(list()).getByRole('button', { name: /Font not embedded/ }));
    });

    expect(row.getAttribute('aria-pressed')).toBe('false');
    const next = screen.getByTestId('audit-finding-detail');
    expect(within(next).getByText('Font not embedded: Inter')).toBeTruthy();
    // A document-level finding has no page to open.
    expect(within(next).queryByRole('button', { name: 'Open page' })).toBeNull();
  });
});

describe('AuditWorkspace actions', () => {
  it('closes the workspace and navigates Inspect when a page finding says Open page', async () => {
    showReport();
    renderWorkspace();

    act(() => {
      fireEvent.click(within(list()).getByRole('button', { name: /Low DPI image on page 2/ }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open page' }));
    });

    expect(store().active).toBe(false);
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith(2);
    // Like Diff, the completed report survives so it can be reopened.
    expect(store().report).not.toBeNull();
  });

  it('exports the full report as JSON with a suggested file name', async () => {
    showReport(makeReport(FINDINGS));
    useAuditStore.setState({ fileName: 'My Report.pdf' });
    renderWorkspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });

    expect(auditIpc.saveFile).toHaveBeenCalledTimes(1);
    const request = auditIpc.saveFile.mock.calls[0][0] as {
      defaultPath: string;
      content: string;
      filterName: string;
      extensions: string[];
    };
    expect(request.defaultPath).toBe('My Report.audit.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);
    expect(request.content).toBe(JSON.stringify(makeReport(), null, 2));

    const parsed = JSON.parse(request.content) as AuditReport;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.summary).toEqual({ total: 4, errors: 0, warnings: 2, info: 2 });
    expect(parsed.findings.map((finding) => finding.title)).toEqual(
      FINDINGS.map((finding) => finding.title),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a cancelled save as a no-op and reports a failed one', async () => {
    showReport();
    auditIpc.saveFile.mockResolvedValueOnce({ canceled: true });
    renderWorkspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();

    auditIpc.saveFile.mockResolvedValueOnce({ canceled: false, error: 'disk full' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Export failed: disk full');

    auditIpc.saveFile.mockRejectedValueOnce(new Error('save channel closed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Export failed: save channel closed');
  });

  it('re-runs the audit from the header', async () => {
    showReport();
    renderWorkspace();

    expect(screen.getByRole('button', { name: 'Re-run' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    });

    expect(auditIpc.auditDocument).toHaveBeenCalledTimes(1);
    // The mocked run returns no findings, so the freshly applied report is clean.
    await waitFor(() => expect(screen.getByText(/the document passed every check/)).toBeTruthy());
  });

  it('leaves the workspace from the header', () => {
    showReport();
    renderWorkspace();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to Inspect' }));
    });

    expect(store().active).toBe(false);
    expect(store().report).not.toBeNull();
  });
});

describe('AuditWorkspace states', () => {
  it('shows an empty workspace before any audit has run', () => {
    useAuditStore.setState({
      active: true,
      filePath: '/docs/report.pdf',
      fileName: 'report.pdf',
      report: null,
      loading: false,
      progress: null,
      error: null,
    });
    renderWorkspace();

    expect(screen.getByTestId('audit-empty')).toBeTruthy();
    expect(screen.queryByTestId('audit-summary')).toBeNull();
    expect(within(list()).queryAllByRole('button')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Export JSON' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });

  it('shows the document pass and the page progress while running', () => {
    useAuditStore.setState({
      active: true,
      filePath: '/docs/report.pdf',
      fileName: 'report.pdf',
      report: null,
      loading: true,
      progress: null,
      error: null,
    });
    renderWorkspace();

    expect(screen.getByRole('status').textContent).toBe('Auditing document…');
    expect(screen.queryByTestId('audit-empty')).toBeNull();
    expect((screen.getByRole('button', { name: /Auditing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    act(() => {
      useAuditStore.setState({ progress: { done: 10, total: 25 } });
    });
    expect(screen.getByRole('status').textContent).toBe('Auditing pages 10/25…');
  });

  it('shows an audit failure as an alert with no findings list', () => {
    useAuditStore.setState({
      active: true,
      filePath: '/docs/report.pdf',
      fileName: 'report.pdf',
      report: null,
      loading: false,
      progress: null,
      error: 'Sidecar is not running',
    });
    renderWorkspace();

    expect(screen.getByRole('alert').textContent).toContain('Audit failed: Sidecar is not running');
    expect(screen.queryByTestId('audit-empty')).toBeNull();
    expect(within(list()).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('audit workspace helpers', () => {
  it('labels document-level and page findings', () => {
    expect(auditPageLabel(null)).toBe('Document');
    expect(auditPageLabel(7)).toBe('Page 7');
  });

  it('suggests a portable JSON file name', () => {
    expect(suggestAuditJsonFilename('report.pdf')).toBe('report.audit.json');
    expect(suggestAuditJsonFilename('/docs/My Report.PDF')).toBe('My Report.audit.json');
    expect(suggestAuditJsonFilename(null)).toBe('document.audit.json');
  });

  it('keeps Unicode and decodes percent escapes', () => {
    expect(suggestAuditJsonFilename('测试 报告.pdf')).toBe('测试 报告.audit.json');
    expect(suggestAuditJsonFilename('/doc/x/%E6%B5%8B%E8%AF%95%20report.pdf')).toBe(
      '测试 report.audit.json',
    );
    expect(
      suggestAuditJsonFilename('https://example.com/files/%E6%B5%8B%E8%AF%95%20report.pdf?x=1'),
    ).toBe('测试 report.audit.json');
    // Unusable names keep the existing fallback.
    expect(suggestAuditJsonFilename('_____.pdf')).toBe('document.audit.json');
  });

  it('combines both filter axes', () => {
    expect(filterAuditFindings(FINDINGS, { severity: 'all', category: 'all' })).toBe(FINDINGS);
    expect(
      filterAuditFindings(FINDINGS, { severity: 'warning', category: 'images' }).map(
        (finding) => finding.title,
      ),
    ).toEqual(['Low DPI image on page 2']);
    expect(filterAuditFindings(FINDINGS, { severity: 'error', category: 'all' })).toEqual([]);
  });
});
