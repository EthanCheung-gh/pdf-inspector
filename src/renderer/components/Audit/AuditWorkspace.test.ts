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
import type {
  SecurityEncryption,
  SecurityReport,
  SecuritySignature,
} from '../../../shared/security-types';

const auditIpc = vi.hoisted(() => ({
  saveFile: vi.fn(),
  auditDocument: vi.fn(),
  auditPages: vi.fn(),
  securityDocument: vi.fn(),
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
  suggestSecurityJsonFilename,
} from './AuditWorkspace';
import { translate, useI18nStore, type TranslateFn } from '../../i18n';
import { useAuditStore } from '../../store/audit-store';
import { useSecurityStore } from '../../store/security-store';
import { SecurityResources } from './SecurityResources';

/** English translator for the pure helper tests. */
const tEn: TranslateFn = (key, params) => translate('en', key, params);
/** Simplified Chinese translator for the localization smoke tests. */
const tZh: TranslateFn = (key, params) => translate('zh-CN', key, params);

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

// --- security resources fixtures -----------------------------------------

const SECURITY_FINDING = makeFinding({
  category: 'security',
  severity: 'warning',
  page: null,
  title: 'JavaScript present',
  detail: 'The document contains JavaScript.',
});

const ENCRYPTION: SecurityEncryption = {
  filter: 'Standard',
  version: 4,
  revision: 4,
  keyLength: 128,
  permissions: {
    raw: -3904,
    print: true,
    modify: false,
    copy: false,
    annotate: true,
    fillForms: true,
    accessibility: true,
    assemble: false,
    highQualityPrint: true,
  },
};

const SIGNATURE: SecuritySignature = {
  fieldName: 'Signature1',
  page: 1,
  signer: 'Alice',
  signedAt: 'D:20240101000000Z',
  reason: 'Approval',
  location: 'Berlin',
  subFilter: 'adbe.pkcs7.detached',
  byteRangeValid: true,
  verified: false,
};

function makeSecurityReport(overrides: Partial<SecurityReport> = {}): SecurityReport {
  return {
    schemaVersion: 1,
    tool: TOOL,
    document: {
      pages: 12,
      version: '1.7',
      encrypted: false,
      xfa: false,
      hasMetadata: true,
      outputIntents: 0,
    },
    attachments: [],
    javascript: [],
    actions: [],
    signatures: [],
    encryption: null,
    findings: [],
    summary: { total: 0, errors: 0, warnings: 0, info: 0 },
    ...overrides,
  };
}

/** A report exercising every section: risky attachment, script, action, signature. */
function makeRichSecurityReport(): SecurityReport {
  return makeSecurityReport({
    document: { ...makeSecurityReport().document, encrypted: true, xfa: true },
    attachments: [
      {
        name: 'invoice.exe',
        description: 'Executable payload',
        size: 1536,
        mimeType: 'application/octet-stream',
        modified: 'D:20240101000000Z',
        sha256: 'a'.repeat(64),
        risky: true,
      },
      {
        name: 'terms.txt',
        description: null,
        size: 12,
        mimeType: 'text/plain',
        modified: null,
        sha256: null,
        risky: false,
      },
    ],
    javascript: [
      {
        name: 'OpenAction',
        location: 'OpenAction',
        page: null,
        source: 'app.alert("hello");',
        truncated: false,
      },
      {
        name: null,
        location: 'Page 3',
        page: 3,
        source: 'var payload = "x";',
        truncated: true,
      },
    ],
    actions: [
      { location: 'Page 1', page: 1, subtype: 'Launch', target: 'cmd.exe', risky: true },
      {
        location: 'Document',
        page: null,
        subtype: 'URI',
        target: 'https://example.com/report',
        risky: false,
      },
    ],
    signatures: [SIGNATURE],
    encryption: ENCRYPTION,
    findings: [SECURITY_FINDING],
    summary: { total: 1, errors: 0, warnings: 1, info: 0 },
  });
}

/** Switch the Audit workspace to the Resources view (and let the read settle). */
async function showResources(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));
  });
}

const findingsMode = (): HTMLElement => screen.getByRole('button', { name: 'Findings' });
const resourcesMode = (): HTMLElement => screen.getByRole('button', { name: 'Resources' });

beforeEach(() => {
  vi.resetAllMocks();
  // Default locale: a Chinese test must not leak into the English assertions.
  useI18nStore.setState({ locale: 'en' });
  store().reset();
  useSecurityStore.getState().reset();
  auditIpc.saveFile.mockResolvedValue({ canceled: false });
  auditIpc.auditDocument.mockResolvedValue({
    tool: TOOL,
    document: makeDocument({ pages: 0 }),
    findings: [],
  });
  auditIpc.auditPages.mockResolvedValue({ tool: TOOL, findings: [] });
  auditIpc.securityDocument.mockResolvedValue(makeSecurityReport());
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

describe('AuditWorkspace localization', () => {
  it('translates the chrome, summary, filters and finding detail', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    showReport();
    renderWorkspace();

    expect(screen.getByRole('region', { name: 'PDF 审计工作区' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回 Inspect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新运行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 JSON' })).toBeTruthy();

    const summary = screen.getByTestId('audit-summary');
    expect(within(summary).getByText('错误').nextSibling?.textContent).toBe('0');
    expect(within(summary).getByText('警告').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('信息').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('总计').nextSibling?.textContent).toBe('4');

    const document = screen.getByTestId('audit-document-info');
    expect(within(document).getByText('页数').nextSibling?.textContent).toBe('12');
    expect(within(document).getByText('加密').nextSibling?.textContent).toBe('否');
    expect(within(document).getByText('标记（Tagged）').nextSibling?.textContent).toBe('是');

    expect(screen.getByText('4 个发现')).toBeTruthy();
    expect(screen.getByLabelText('按严重级别筛选')).toBeTruthy();
    expect(screen.getByLabelText('按类别筛选')).toBeTruthy();

    act(() => {
      fireEvent.change(screen.getByLabelText('按严重级别筛选'), { target: { value: 'warning' } });
    });

    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('2 / 4 个发现');
    // Schema values (severity/category) stay as the engine reports them; only
    // the page label is localized.
    expect(rowNames()).toEqual([
      'warning fonts 文档: Font not embedded: Inter',
      'warning images 第 2 页: Low DPI image on page 2',
    ]);

    act(() => {
      fireEvent.click(within(list()).getByRole('button', { name: /Low DPI image on page 2/ }));
    });

    const detail = screen.getByTestId('audit-finding-detail');
    expect(within(detail).getByText('图片')).toBeTruthy();
    expect(within(detail).getByText('第 2 页')).toBeTruthy();
    expect(within(detail).getByText('证据')).toBeTruthy();
    expect(within(detail).getByText('建议')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '打开页面' })).toBeTruthy();
  });

  it('returns to English without a reload', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    showReport();
    renderWorkspace();
    expect(screen.getByRole('button', { name: '重新运行' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('region', { name: 'PDF audit workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeTruthy();
    expect(screen.getByText('4 findings')).toBeTruthy();
  });
});

describe('audit workspace helpers', () => {
  it('labels document-level and page findings', () => {
    expect(auditPageLabel(null, tEn)).toBe('Document');
    expect(auditPageLabel(7, tEn)).toBe('Page 7');
    expect(auditPageLabel(null, tZh)).toBe('文档');
    expect(auditPageLabel(7, tZh)).toBe('第 7 页');
  });

  it('suggests a portable JSON file name', () => {
    expect(suggestAuditJsonFilename('report.pdf')).toBe('report.audit.json');
    expect(suggestAuditJsonFilename('/docs/My Report.PDF')).toBe('My Report.audit.json');
    expect(suggestAuditJsonFilename(null)).toBe('document.audit.json');
  });

  it('suggests a portable security JSON file name', () => {
    expect(suggestSecurityJsonFilename('report.pdf')).toBe('report.security.json');
    expect(suggestSecurityJsonFilename('/docs/My Report.PDF')).toBe('My Report.security.json');
    expect(suggestSecurityJsonFilename(null)).toBe('document.security.json');
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

describe('AuditWorkspace findings / resources switch', () => {
  it('opens on Findings and keeps the audit report behaviour', () => {
    showReport();
    renderWorkspace();

    expect(findingsMode().getAttribute('aria-pressed')).toBe('true');
    expect(resourcesMode().getAttribute('aria-pressed')).toBe('false');
    // Default mode requests nothing: the security scan is lazy per document.
    expect(auditIpc.securityDocument).not.toHaveBeenCalled();
    expect(screen.queryByTestId('security-resources')).toBeNull();
    expect(screen.getByTestId('audit-summary')).toBeTruthy();
    expect(rowNames()).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeTruthy();
  });

  it('reads the document resources when the Resources mode opens', async () => {
    showReport();
    renderWorkspace();

    await showResources();

    expect(resourcesMode().getAttribute('aria-pressed')).toBe('true');
    expect(findingsMode().getAttribute('aria-pressed')).toBe('false');
    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('security-resources')).toBeTruthy();
    // The first paint is the reading state, never the empty-document hint.
    expect(screen.queryByText(/Open and audit a PDF/)).toBeNull();
    // Findings panes are unmounted, not merely hidden.
    expect(screen.queryByTestId('audit-finding-list')).toBeNull();
    expect(screen.queryByTestId('audit-summary')).toBeNull();
    // The Audit chrome (back, title, file name) stays in place.
    expect(screen.getByRole('region', { name: 'PDF audit workspace' })).toBeTruthy();
    expect(screen.getByTestId('audit-file-name').textContent).toBe('report.pdf');
    expect(screen.getByRole('button', { name: 'Back to Inspect' })).toBeTruthy();
  });

  it('caches the resources of one file across mode switches', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    await act(async () => {
      fireEvent.click(findingsMode());
    });
    expect(screen.getByTestId('audit-finding-list')).toBeTruthy();

    await showResources();

    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('shows the loading state while the scan is in flight', async () => {
    showReport();
    let resolve!: (report: SecurityReport) => void;
    auditIpc.securityDocument.mockImplementationOnce(
      () => new Promise<SecurityReport>((res) => {
        resolve = res;
      }),
    );
    renderWorkspace();

    await act(async () => {
      fireEvent.click(resourcesMode());
    });

    expect(screen.getByRole('status').textContent).toBe('Reading document resources…');

    await act(async () => {
      resolve(makeSecurityReport());
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('reports a failed read locally and retries it', async () => {
    showReport();
    auditIpc.securityDocument.mockRejectedValueOnce(new Error('Sidecar is not running'));
    renderWorkspace();

    await showResources();

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not read document resources: Sidecar is not running',
    );
    // A resources failure never becomes an audit-run failure.
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('shows an empty hint when no document is audited', async () => {
    useAuditStore.setState({
      active: true,
      filePath: null,
      fileName: null,
      report: null,
      loading: false,
      progress: null,
      error: null,
    });
    renderWorkspace();

    await showResources();

    expect(screen.getByTestId('security-empty').textContent).toContain('Open and audit a PDF');
    expect(auditIpc.securityDocument).not.toHaveBeenCalled();
  });

  it('jumps to Findings with the security category filter', async () => {
    showReport(makeReport([...FINDINGS, SECURITY_FINDING]));
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View in Findings' }));
    });

    // The category is forced to the security findings the button promised,
    // and severity is reset so a leftover severity filter cannot hide them.
    expect(findingsMode().getAttribute('aria-pressed')).toBe('true');
    expect(store().filter).toEqual({ severity: 'all', category: 'security' });
    expect(rowNames()).toEqual(['warning security Document: JavaScript present']);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('1 of 5 findings');

    // The row is a normal finding: selecting it fills the detail pane.
    await act(async () => {
      fireEvent.click(within(list()).getByRole('button', { name: /JavaScript present/ }));
    });
    expect(store().selected?.title).toBe('JavaScript present');
  });

  it('drops the cached resources when the audit is re-run', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    await act(async () => {
      fireEvent.click(findingsMode());
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    });

    // Re-run is the user asking for a fresh look at the file.
    expect(useSecurityStore.getState().report).toBeNull();

    await showResources();
    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(2);
  });

  it('re-reads the resources in place when Re-run is clicked in Resources', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    });

    // The cache is dropped and immediately re-read: the visible view never
    // waits for a report nothing would request.
    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(useSecurityStore.getState().report).not.toBeNull();
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('refreshes the resources from the Resources header', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    expect(auditIpc.securityDocument).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('keeps the loaded inventory when a refresh fails', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    expect(screen.getByTestId('security-summary')).toBeTruthy();

    auditIpc.securityDocument.mockRejectedValueOnce(new Error('sidecar died'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not read document resources: sidecar died',
    );
    // The inventory read before the failure stays usable behind the alert.
    expect(screen.getByTestId('security-summary')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('security-summary')).toBeTruthy();
  });

  it('drops resources of the previous file when the audit file changes', async () => {
    showReport();
    renderWorkspace();

    await showResources();
    await act(async () => {
      fireEvent.click(findingsMode());
    });
    expect(useSecurityStore.getState().filePath).toBe('/docs/report.pdf');

    act(() => {
      useAuditStore.setState({ filePath: '/docs/other.pdf', fileName: 'other.pdf' });
    });

    expect(useSecurityStore.getState().filePath).toBeNull();
    expect(useSecurityStore.getState().report).toBeNull();
  });

  it('exports the SecurityReport as JSON from the Resources view', async () => {
    const securityReport = makeRichSecurityReport();
    showReport();
    useAuditStore.setState({ fileName: 'My Report.pdf' });
    auditIpc.securityDocument.mockResolvedValue(securityReport);
    renderWorkspace();

    // Findings keeps the AuditReport export; Resources owns the security one.
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeTruthy();
    await showResources();
    expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export security JSON' }));
    });

    expect(auditIpc.saveFile).toHaveBeenCalledTimes(1);
    const request = auditIpc.saveFile.mock.calls[0][0] as {
      defaultPath: string;
      content: string;
      filterName: string;
      extensions: string[];
    };
    expect(request.defaultPath).toBe('My Report.security.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);
    expect(request.content).toBe(JSON.stringify(securityReport, null, 2));
    expect(JSON.parse(request.content)).toEqual(securityReport);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a failed security export local and dismissible', async () => {
    showReport();
    renderWorkspace();

    await showResources();

    auditIpc.saveFile.mockResolvedValueOnce({ canceled: false, error: 'disk full' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export security JSON' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Export failed: disk full');
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('SecurityResources first paint', () => {
  it('reads as loading when audit has a file the store has not opened yet', () => {
    // The first switch to Resources renders before `AuditWorkspace`'s effect
    // calls `security-store.open()`, so the store is still empty here.
    expect(useSecurityStore.getState().filePath).toBeNull();

    render(
      React.createElement(SecurityResources, {
        filePath: '/docs/report.pdf',
        onViewInFindings: () => {},
      }),
    );

    expect(screen.getByRole('status').textContent).toBe('Reading document resources…');
    expect(screen.queryByTestId('security-empty')).toBeNull();
    expect(screen.queryByText(/Open and audit a PDF/)).toBeNull();
  });

  it('keeps the empty-document hint when audit has no document', () => {
    render(
      React.createElement(SecurityResources, {
        filePath: null,
        onViewInFindings: () => {},
      }),
    );

    expect(screen.getByTestId('security-empty').textContent).toContain('Open and audit a PDF');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never shows the resources of another file while the switch is pending', () => {
    useSecurityStore.setState({
      filePath: '/docs/report.pdf',
      report: makeSecurityReport(),
      loading: false,
      error: null,
    });

    render(
      React.createElement(SecurityResources, {
        filePath: '/docs/other.pdf',
        onViewInFindings: () => {},
      }),
    );

    expect(screen.getByRole('status').textContent).toBe('Reading document resources…');
    expect(screen.queryByTestId('security-summary')).toBeNull();
    expect(screen.queryByTestId('security-empty')).toBeNull();
  });
});

describe('SecurityResources view', () => {
  it('summarises counts, encryption and XFA state', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    const summary = screen.getByTestId('security-summary');
    expect(within(summary).getByText('Attachments').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('JavaScript').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('Actions').nextSibling?.textContent).toBe('2');
    expect(within(summary).getByText('Signatures').nextSibling?.textContent).toBe('1');
    expect(within(summary).getByText('Encryption').nextSibling?.textContent).toBe('Encrypted');
    expect(within(summary).getByText('XFA').nextSibling?.textContent).toBe('Present');
  });

  it('lists attachments with metadata, a short hash and a risk badge', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    const table = screen.getByTestId('security-attachments');
    expect(within(table).getByText('invoice.exe')).toBeTruthy();
    expect(within(table).getByText('Executable payload')).toBeTruthy();
    // 1536 declared bytes, formatted without locale-dependent units.
    expect(within(table).getByText('1.5 KB')).toBeTruthy();
    expect(within(table).getByText('application/octet-stream')).toBeTruthy();
    expect(within(table).getByText('D:20240101000000Z')).toBeTruthy();

    // Only the executable-looking attachment is flagged.
    expect(within(table).getAllByText('Risky')).toHaveLength(1);

    const hash = screen.getByTestId('security-attachment-hash-0');
    expect(hash.textContent).toBe('aaaaaaaaaaaa…');
    expect(hash.getAttribute('title')).toBe('a'.repeat(64));

    // Metadata only: the table offers no open/download affordance.
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    expect(
      screen.getByText('Metadata only — attachments are never opened, saved or extracted.'),
    ).toBeTruthy();
  });

  it('previews JavaScript as inert text and marks truncation', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    expect(screen.getByText('Preview only — not executed')).toBeTruthy();

    const first = screen.getByTestId('security-script-0');
    expect(first.tagName).toBe('PRE');
    expect(first.textContent).toBe('app.alert("hello");');
    expect(first.getAttribute('aria-label')).toBe('JavaScript preview 1');

    // An unnamed entry still gets a label instead of an empty cell.
    expect(screen.getByText('unnamed')).toBeTruthy();
    expect(screen.getByTestId('security-script-1').textContent).toBe('var payload = "x";');
    expect(screen.getByText('The preview is truncated; the script is longer.')).toBeTruthy();
  });

  it('lists actions with their subtype, target and risk', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    const table = screen.getByTestId('security-actions');
    const rows = within(table).getAllByRole('row');
    // Header row + one row per action.
    expect(rows).toHaveLength(3);
    // Subtypes are schema values and stay as reported.
    expect(within(table).getByText('Launch')).toBeTruthy();
    expect(within(table).getByText('URI')).toBeTruthy();
    expect(within(table).getByText('cmd.exe')).toBeTruthy();
    expect(within(table).getByText('https://example.com/report')).toBeTruthy();
    expect(within(table).getAllByText('Risky')).toHaveLength(1);
  });

  it('lists signature fields with a fixed not-verified notice', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    expect(screen.getByTestId('security-signature-not-verified').textContent).toBe(
      'Not cryptographically verified',
    );

    const table = screen.getByTestId('security-signatures');
    expect(within(table).getByText('Signature1')).toBeTruthy();
    expect(within(table).getByText('Alice')).toBeTruthy();
    expect(within(table).getByText('adbe.pkcs7.detached')).toBeTruthy();
    expect(within(table).getByText('complete')).toBeTruthy();
  });

  it('shows encryption facts and permission badges', async () => {
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await showResources();

    const facts = screen.getByTestId('security-encryption');
    expect(within(facts).getByText('Standard')).toBeTruthy();
    expect(within(facts).getByText('128 bit')).toBeTruthy();

    const permissions = screen.getByTestId('security-permissions');
    const badge = (label: string): HTMLElement => within(permissions).getByText(label);
    expect(within(permissions).getAllByRole('listitem')).toHaveLength(8);
    expect(badge('Print').getAttribute('data-state')).toBe('granted');
    expect(badge('Modify').getAttribute('data-state')).toBe('denied');
    expect(badge('Assemble').getAttribute('data-state')).toBe('denied');
    expect(badge('High-quality print').getAttribute('data-state')).toBe('granted');
    expect(badge('Copy').getAttribute('title')).toBe('Copy: Denied');
  });

  it('shows a section-specific empty state for a clean document', async () => {
    showReport();
    renderWorkspace();

    await showResources();

    expect(screen.getByText('No embedded attachments in this document.')).toBeTruthy();
    expect(screen.getByText('No JavaScript in this document.')).toBeTruthy();
    expect(screen.getByText('No document actions in this document.')).toBeTruthy();
    expect(screen.getByText('No signature fields in this document.')).toBeTruthy();
    expect(screen.getByText('This document is not encrypted.')).toBeTruthy();
    expect(screen.getByText('No security findings for this document.')).toBeTruthy();

    const summary = screen.getByTestId('security-summary');
    expect(within(summary).getByText('Encryption').nextSibling?.textContent).toBe('Not encrypted');
    expect(within(summary).getByText('XFA').nextSibling?.textContent).toBe('Absent');

    // Nothing to jump to, so the switch stays disabled.
    const viewInFindings = screen.getByRole('button', { name: 'View in Findings' });
    expect((viewInFindings as HTMLButtonElement).disabled).toBe(true);
  });

  it('localizes the resources view but keeps schema values English', async () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    showReport();
    auditIpc.securityDocument.mockResolvedValue(makeRichSecurityReport());
    renderWorkspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '资源' }));
    });

    expect(screen.getByRole('group', { name: '审计视图模式' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出安全 JSON' })).toBeTruthy();
    expect(screen.getByText('未进行密码学验证')).toBeTruthy();
    expect(screen.getByText('仅供预览——不会执行')).toBeTruthy();
    // One badge for the risky attachment, one for the risky action.
    expect(screen.getAllByText('有风险')).toHaveLength(2);
    // Action subtypes and subfilters are schema values: never translated.
    expect(screen.getByText('Launch')).toBeTruthy();
    expect(screen.getByText('adbe.pkcs7.detached')).toBeTruthy();
    expect(screen.getByRole('button', { name: '在发现中查看' })).toBeTruthy();
  });
});
