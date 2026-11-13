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
import { compareAuditReports } from '../../../shared/audit-baseline';
import type {
  SecurityEncryption,
  SecurityReport,
  SecuritySignature,
} from '../../../shared/security-types';
import type {
  AccessibilityDocumentInfo,
  AccessibilityReport,
  StructureNode,
} from '../../../shared/accessibility-types';

const auditIpc = vi.hoisted(() => ({
  saveFile: vi.fn(),
  auditDocument: vi.fn(),
  auditPages: vi.fn(),
  securityDocument: vi.fn(),
  accessibilityDocument: vi.fn(),
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
  BASELINE_COUNT_SEPARATOR,
  auditBaselineCountsText,
  auditBaselineCountsTitle,
  auditPageLabel,
  filterAuditFindings,
  suggestAccessibilityJsonFilename,
  suggestAuditJsonFilename,
  suggestSecurityJsonFilename,
} from './AuditWorkspace';
import { translate, useI18nStore, type TranslateFn } from '../../i18n';
import { useAuditStore } from '../../store/audit-store';
import { useSecurityStore } from '../../store/security-store';
import { useAccessibilityStore } from '../../store/accessibility-store';
import { SecurityResources } from './SecurityResources';
import {
  StructureView,
  buildIssueIndex,
  defaultExpandedIds,
  evidenceNodeIds,
  filterStructure,
  flattenStructure,
  structureStats,
} from './StructureView';

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

/** A valid 32-character lowercase hex fingerprint, distinct per `seed`. */
function fingerprint(seed: number | string): string {
  const hex = typeof seed === 'number' ? seed.toString(16) : seed;
  return hex.padStart(32, '0').slice(-32).toLowerCase();
}

/**
 * A current report and the baseline it is compared with:
 *
 * - `existing`   fonts warning, document level, same page;
 * - `escalated`  images info on page 2 became a warning;
 * - `existing`   pages info on page 3;
 * - `new`        metadata info, absent from the baseline;
 * - `moved`      security warning, page 1 in the baseline, page 5 now;
 * - `fixed`      structure error the baseline had and this run does not.
 */
const BASELINE_CURRENT: AuditFinding[] = [
  { ...FINDINGS[0], fingerprint: fingerprint(1) },
  { ...FINDINGS[1], fingerprint: fingerprint(2) },
  { ...FINDINGS[2], fingerprint: fingerprint(3) },
  { ...FINDINGS[3], fingerprint: fingerprint(4) },
  makeFinding({
    category: 'security',
    severity: 'warning',
    page: 5,
    title: 'JavaScript present',
    detail: 'The document contains JavaScript.',
    fingerprint: fingerprint(5),
  }),
];

const BASELINE_OLD: AuditFinding[] = [
  { ...BASELINE_CURRENT[0] },
  { ...BASELINE_CURRENT[1], severity: 'info' },
  { ...BASELINE_CURRENT[2] },
  { ...BASELINE_CURRENT[4], page: 1 },
  makeFinding({
    category: 'structure',
    severity: 'error',
    page: null,
    title: 'Document is not tagged',
    detail: 'No /StructTreeRoot was found.',
    fingerprint: fingerprint(9),
  }),
];

function baselineFile(report: AuditReport, name = 'baseline.json'): File {
  return new File([JSON.stringify(report)], name, { type: 'application/json' });
}

/** Enter the workspace with a report and a loaded, compared baseline. */
async function showBaseline(
  current: AuditFinding[] = BASELINE_CURRENT,
  baseline: AuditFinding[] = BASELINE_OLD,
): Promise<void> {
  showReport(makeReport(current));
  await act(async () => {
    await store().loadBaselineFile(baselineFile(makeReport(baseline)));
  });
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
const structureMode = (): HTMLElement => screen.getByRole('button', { name: 'Structure' });
const resourcesMode = (): HTMLElement => screen.getByRole('button', { name: 'Resources' });

// --- accessibility structure fixtures ------------------------------------

function makeNode(overrides: Partial<StructureNode> = {}): StructureNode {
  return {
    id: '0',
    kind: 'element',
    role: 'Document',
    rawRole: 'Document',
    title: null,
    alt: null,
    actualText: null,
    lang: null,
    page: null,
    mcid: null,
    objectNumber: null,
    attributes: {},
    children: [],
    truncated: false,
    ...overrides,
  };
}

function makeAccessibilityDocument(
  overrides: Partial<AccessibilityDocumentInfo> = {},
): AccessibilityDocumentInfo {
  return {
    pages: 12,
    version: '1.7',
    encrypted: false,
    tagged: true,
    hasStructTreeRoot: true,
    hasParentTree: true,
    language: 'en-US',
    title: 'Quarterly report',
    roleMap: {},
    truncated: false,
    skipped: 0,
    ...overrides,
  };
}

const FIGURE_FINDING = makeFinding({
  category: 'structure',
  severity: 'warning',
  page: 2,
  title: 'Figure has no alternative text',
  detail: 'Figure elements have no /Alt text. 1 node affected.',
  evidence: 'nodes=0/2 (Figure, page 2)',
  recommendation: 'Add /Alt text to every Figure element.',
});

const UNKNOWN_ROLE_FINDING = makeFinding({
  category: 'structure',
  severity: 'warning',
  page: 1,
  title: 'Unknown structure role: Widget',
  detail: "Role 'Widget' is not a standard structure role.",
  evidence: 'nodes=0/1/0 (Widget, page 1)',
  recommendation: 'Map custom roles to a standard role in /RoleMap.',
});

const PARENT_TREE_FINDING = makeFinding({
  category: 'structure',
  severity: 'warning',
  page: null,
  title: 'Structure tree has no ParentTree',
  detail: 'The catalog has a /StructTreeRoot but no /ParentTree.',
  evidence: 'hasStructTreeRoot=true; hasParentTree=false',
  recommendation: 'Add a /ParentTree number tree.',
});

/**
 * Document
 *   H1 ("Quarterly report", page 1)
 *   P
 *     Widget (custom role, page 1)
 *       Span
 *         MCID 2
 *   Figure (no Alt, page 2, one attribute)
 *     OBJR 12
 */
function makeStructure(): StructureNode[] {
  return [
    makeNode({
      id: '0',
      children: [
        makeNode({
          id: '0/0',
          role: 'H1',
          rawRole: 'H1',
          page: 1,
          title: 'Quarterly report',
          mcid: 0,
        }),
        makeNode({
          id: '0/1',
          role: 'P',
          rawRole: 'P',
          page: 1,
          mcid: 1,
          children: [
            makeNode({
              id: '0/1/0',
              role: 'Widget',
              rawRole: 'Widget',
              page: 1,
              title: 'Custom widget',
              children: [
                makeNode({
                  id: '0/1/0/0',
                  role: 'Span',
                  rawRole: 'Span',
                  page: 1,
                  lang: 'de-DE',
                  actualText: 'Actual text',
                  children: [
                    makeNode({
                      id: '0/1/0/0/0',
                      kind: 'mcid',
                      role: 'MCID',
                      rawRole: null,
                      page: 1,
                      mcid: 2,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
        makeNode({
          id: '0/2',
          role: 'Figure',
          rawRole: 'Figure',
          page: 2,
          attributes: { Placement: 'Block' },
          children: [
            makeNode({
              id: '0/2/0',
              kind: 'object',
              role: 'OBJR',
              rawRole: null,
              page: 2,
              objectNumber: 12,
            }),
          ],
        }),
      ],
    }),
  ];
}

function makeAccessibilityReport(overrides: Partial<AccessibilityReport> = {}): AccessibilityReport {
  return {
    schemaVersion: 1,
    tool: TOOL,
    document: makeAccessibilityDocument(),
    structure: makeStructure(),
    findings: [FIGURE_FINDING, UNKNOWN_ROLE_FINDING, PARENT_TREE_FINDING],
    summary: { total: 3, errors: 0, warnings: 3, info: 0 },
    ...overrides,
  };
}

/** Enter the Structure view with a completed report, without parsing. */
function showStructureReport(report: AccessibilityReport = makeAccessibilityReport()): void {
  useAccessibilityStore.setState({
    filePath: '/docs/report.pdf',
    report,
    loading: false,
    error: null,
  });
}

interface StructureViewHarness {
  onViewInFindings: ReturnType<typeof vi.fn>;
  onOpenPage: ReturnType<typeof vi.fn>;
}

/** Render `StructureView` on its own with recorded callbacks. */
function renderStructureView(
  options: { filePath?: string | null; report?: AccessibilityReport } = {},
): StructureViewHarness {
  const harness: StructureViewHarness = { onViewInFindings: vi.fn(), onOpenPage: vi.fn() };
  render(
    React.createElement(StructureView, {
      filePath: options.filePath === undefined ? '/docs/report.pdf' : options.filePath,
      onViewInFindings: harness.onViewInFindings,
      onOpenPage: harness.onOpenPage,
    }),
  );
  return harness;
}

/** Switch the Audit workspace to the Structure view (and let the parse settle). */
async function showStructure(): Promise<void> {
  await act(async () => {
    fireEvent.click(structureMode());
  });
}

const node = (id: string): HTMLElement => screen.getByTestId(`structure-node-${id}`);
const nodeIdsOnScreen = (): string[] =>
  screen
    .getAllByTestId(/^structure-node-/)
    .map((element) => element.getAttribute('data-testid')?.replace('structure-node-', '') ?? '');

beforeEach(() => {
  vi.resetAllMocks();
  // Default locale: a Chinese test must not leak into the English assertions.
  useI18nStore.setState({ locale: 'en' });
  store().reset();
  useSecurityStore.getState().reset();
  useAccessibilityStore.getState().reset();
  auditIpc.saveFile.mockResolvedValue({ canceled: false });
  auditIpc.auditDocument.mockResolvedValue({
    tool: TOOL,
    document: makeDocument({ pages: 0 }),
    findings: [],
  });
  auditIpc.auditPages.mockResolvedValue({ tool: TOOL, findings: [] });
  auditIpc.securityDocument.mockResolvedValue(makeSecurityReport());
  auditIpc.accessibilityDocument.mockResolvedValue(makeAccessibilityReport());
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
    expect(structureMode().getAttribute('aria-pressed')).toBe('false');
    expect(resourcesMode().getAttribute('aria-pressed')).toBe('false');
    // Default mode requests nothing: the structure parse and the security scan
    // are lazy per document.
    expect(auditIpc.securityDocument).not.toHaveBeenCalled();
    expect(auditIpc.accessibilityDocument).not.toHaveBeenCalled();
    expect(screen.queryByTestId('security-resources')).toBeNull();
    expect(screen.queryByTestId('structure-view')).toBeNull();
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

// --- Audit Findings / Structure / Resources --------------------------------

const STRUCTURE_FINDING = makeFinding({
  category: 'structure',
  severity: 'warning',
  page: 1,
  title: 'Figure has no alternative text',
  detail: 'Figure elements have no /Alt text.',
});

describe('AuditWorkspace structure mode', () => {
  it('parses the document when the Structure mode opens', async () => {
    showReport();
    renderWorkspace();

    await showStructure();

    expect(structureMode().getAttribute('aria-pressed')).toBe('true');
    expect(findingsMode().getAttribute('aria-pressed')).toBe('false');
    expect(resourcesMode().getAttribute('aria-pressed')).toBe('false');
    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(1);
    expect(auditIpc.securityDocument).not.toHaveBeenCalled();

    expect(screen.getByTestId('structure-view')).toBeTruthy();
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
    // Findings panes are unmounted, not merely hidden.
    expect(screen.queryByTestId('audit-finding-list')).toBeNull();
    expect(screen.queryByTestId('audit-summary')).toBeNull();
    // The Audit chrome (back, title, file name) stays in place.
    expect(screen.getByRole('region', { name: 'PDF audit workspace' })).toBeTruthy();
    expect(screen.getByTestId('audit-file-name').textContent).toBe('report.pdf');
  });

  it('shows the reading state until the parse answers', async () => {
    showReport();
    let resolve!: (report: AccessibilityReport) => void;
    auditIpc.accessibilityDocument.mockImplementationOnce(
      () => new Promise<AccessibilityReport>((res) => {
        resolve = res;
      }),
    );
    renderWorkspace();

    await act(async () => {
      fireEvent.click(structureMode());
    });

    expect(screen.getByRole('status').textContent).toBe('Reading the structure tree…');
    // The first paint is the reading state, never the empty-document hint.
    expect(screen.queryByTestId('structure-no-file')).toBeNull();
    expect(screen.queryByText(/Open and audit a PDF/)).toBeNull();

    await act(async () => {
      resolve(makeAccessibilityReport());
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
  });

  it('caches the structure of one file across mode switches', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    await act(async () => {
      fireEvent.click(findingsMode());
    });
    expect(screen.getByTestId('audit-finding-list')).toBeTruthy();

    await showStructure();

    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
  });

  it('reports a failed parse locally and retries it', async () => {
    showReport();
    auditIpc.accessibilityDocument.mockRejectedValueOnce(new Error('Sidecar is not running'));
    renderWorkspace();

    await showStructure();

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not read the document structure: Sidecar is not running',
    );
    // A structure failure never becomes an audit-run failure and never drops
    // the audit report the user already has.
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
  });

  it('shows the untagged empty state with a jump to Findings', async () => {
    showReport();
    auditIpc.accessibilityDocument.mockResolvedValue(
      makeAccessibilityReport({
        document: makeAccessibilityDocument({
          tagged: false,
          hasStructTreeRoot: false,
          hasParentTree: false,
        }),
        structure: [],
        findings: [
          makeFinding({
            category: 'structure',
            severity: 'info',
            page: null,
            title: 'Document is not tagged',
            detail: 'No /StructTreeRoot or /MarkInfo /Marked true was found.',
          }),
        ],
        summary: { total: 1, errors: 0, warnings: 0, info: 1 },
      }),
    );
    renderWorkspace();

    await showStructure();

    const untagged = screen.getByTestId('structure-untagged');
    expect(untagged.textContent).toContain('No structure tree');
    expect(untagged.textContent).toContain('not tagged');
    expect(screen.queryByTestId('structure-tree')).toBeNull();
    expect(screen.getByTestId('structure-facts').textContent).toContain('No');

    await act(async () => {
      fireEvent.click(within(untagged).getByRole('button', { name: 'View in Findings' }));
    });

    expect(findingsMode().getAttribute('aria-pressed')).toBe('true');
    expect(store().filter).toEqual({ severity: 'all', category: 'structure' });
  });

  it('jumps to Findings with the structure category filter', async () => {
    showReport(makeReport([...FINDINGS, STRUCTURE_FINDING]));
    renderWorkspace();

    await showStructure();
    await act(async () => {
      fireEvent.click(node('0/2'));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View in Findings' }));
    });

    expect(findingsMode().getAttribute('aria-pressed')).toBe('true');
    expect(store().filter).toEqual({ severity: 'all', category: 'structure' });
    expect(rowNames()).toEqual(['warning structure Page 1: Figure has no alternative text']);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('1 of 5 findings');
  });

  it('drops the cached structure when the audit is re-run', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    await act(async () => {
      fireEvent.click(findingsMode());
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    });

    expect(useAccessibilityStore.getState().report).toBeNull();

    await showStructure();
    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
  });

  it('re-parses in place when Re-run is clicked in Structure', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    });

    // The cache is dropped and immediately re-read: the visible view never
    // waits for a report nothing would request.
    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(useAccessibilityStore.getState().report).not.toBeNull();
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
  });

  it('refreshes the structure from the Structure header', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    expect(auditIpc.accessibilityDocument).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('structure-summary')).toBeTruthy();
  });

  it('keeps the parsed tree when a refresh fails', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    expect(screen.getByTestId('structure-summary')).toBeTruthy();

    auditIpc.accessibilityDocument.mockRejectedValueOnce(new Error('sidecar died'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not read the document structure: sidecar died',
    );
    // The tree read before the failure stays usable behind the alert.
    expect(screen.getByTestId('structure-summary')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops the structure of the previous file when the audit file changes', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    await act(async () => {
      fireEvent.click(findingsMode());
    });
    expect(useAccessibilityStore.getState().filePath).toBe('/docs/report.pdf');

    act(() => {
      useAuditStore.setState({ filePath: '/docs/other.pdf', fileName: 'other.pdf' });
    });

    expect(useAccessibilityStore.getState().filePath).toBeNull();
    expect(useAccessibilityStore.getState().report).toBeNull();
  });

  it('exports the AccessibilityReport as JSON from the Structure view', async () => {
    const report = makeAccessibilityReport();
    showReport();
    useAuditStore.setState({ fileName: 'My Report.pdf' });
    auditIpc.accessibilityDocument.mockResolvedValue(report);
    renderWorkspace();

    await showStructure();

    // Findings keeps the AuditReport export; Structure owns the accessibility one.
    expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export accessibility JSON' }));
    });

    expect(auditIpc.saveFile).toHaveBeenCalledTimes(1);
    const request = auditIpc.saveFile.mock.calls[0][0] as {
      defaultPath: string;
      content: string;
      filterName: string;
      extensions: string[];
    };
    expect(request.defaultPath).toBe('My Report.accessibility.json');
    expect(request.filterName).toBe('JSON');
    expect(request.extensions).toEqual(['json']);
    expect(request.content).toBe(JSON.stringify(report, null, 2));
    expect(JSON.parse(request.content)).toEqual(report);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a failed accessibility export local and dismissible', async () => {
    showReport();
    renderWorkspace();

    await showStructure();

    auditIpc.saveFile.mockResolvedValueOnce({ canceled: false, error: 'disk full' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export accessibility JSON' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Export failed: disk full');
    expect(store().error).toBeNull();
    expect(store().report).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the page of the selected structure element', async () => {
    showReport();
    renderWorkspace();

    await showStructure();
    await act(async () => {
      fireEvent.click(node('0/2'));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open page' }));
    });

    expect(store().active).toBe(false);
    expect(navigation.navigate).toHaveBeenCalledWith(2);
    expect(store().report).not.toBeNull();
  });
});

describe('StructureView first paint', () => {
  it('reads as loading when audit has a file the store has not opened yet', () => {
    expect(useAccessibilityStore.getState().filePath).toBeNull();

    renderStructureView({ filePath: '/docs/report.pdf' });

    expect(screen.getByRole('status').textContent).toBe('Reading the structure tree…');
    expect(screen.queryByTestId('structure-no-file')).toBeNull();
    expect(screen.queryByTestId('structure-untagged')).toBeNull();
    expect(screen.queryByTestId('structure-summary')).toBeNull();
  });

  it('keeps the empty-document hint when audit has no document', () => {
    renderStructureView({ filePath: null });

    expect(screen.getByTestId('structure-no-file').textContent).toContain('Open and audit a PDF');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never shows the structure of another file while the switch is pending', () => {
    useAccessibilityStore.setState({
      filePath: '/docs/other.pdf',
      report: makeAccessibilityReport(),
      loading: false,
      error: null,
    });

    renderStructureView({ filePath: '/docs/report.pdf' });

    expect(screen.getByRole('status').textContent).toBe('Reading the structure tree…');
    expect(screen.queryByTestId('structure-summary')).toBeNull();
    expect(screen.queryByTestId('structure-no-file')).toBeNull();
  });
});

describe('StructureView summary and facts', () => {
  it('summarises the structure and the document facts', () => {
    showStructureReport();
    renderStructureView();

    const summary = screen.getByTestId('structure-summary');
    expect(within(summary).getByText('Elements').nextSibling?.textContent).toBe('6');
    expect(within(summary).getByText('Figures').nextSibling?.textContent).toBe('1');
    expect(within(summary).getByText('Tables').nextSibling?.textContent).toBe('0');
    expect(within(summary).getByText('Lists').nextSibling?.textContent).toBe('0');
    expect(within(summary).getByText('Headings').nextSibling?.textContent).toBe('1');
    expect(within(summary).getByText('Findings').nextSibling?.textContent).toBe('3');

    const facts = screen.getByTestId('structure-facts');
    expect(within(facts).getByText('Tagged').nextSibling?.textContent).toBe('Yes');
    expect(within(facts).getByText('StructTreeRoot').nextSibling?.textContent).toBe('Present');
    expect(within(facts).getByText('ParentTree').nextSibling?.textContent).toBe('Present');
    expect(within(facts).getByText('Language').nextSibling?.textContent).toBe('en-US');
    expect(within(facts).getByText('Title').nextSibling?.textContent).toBe('Quarterly report');
  });

  it('reports truncated parses and skipped elements', () => {
    showStructureReport(
      makeAccessibilityReport({
        document: makeAccessibilityDocument({ truncated: true, skipped: 3 }),
      }),
    );
    renderStructureView();

    expect(screen.getByTestId('structure-truncated').textContent).toContain('truncated');
    expect(screen.getByTestId('structure-skipped').textContent).toContain('3');
  });

  it('shows an empty state for a tagged document without structure elements', () => {
    showStructureReport(
      makeAccessibilityReport({
        structure: [],
        findings: [],
        summary: { total: 0, errors: 0, warnings: 0, info: 0 },
      }),
    );
    renderStructureView();

    expect(screen.getByTestId('structure-empty-tree').textContent).toContain('structure tree is empty');
    expect(screen.queryByTestId('structure-untagged')).toBeNull();
  });

  it('shows the untagged state instead of an empty tree', () => {
    showStructureReport(
      makeAccessibilityReport({
        document: makeAccessibilityDocument({
          tagged: false,
          hasStructTreeRoot: false,
          hasParentTree: false,
        }),
        structure: [],
      }),
    );
    renderStructureView();

    const untagged = screen.getByTestId('structure-untagged');
    expect(untagged.textContent).toContain('not tagged');
    expect(screen.queryByTestId('structure-empty-tree')).toBeNull();
    expect(screen.getByRole('button', { name: 'View in Findings' })).toBeTruthy();
  });

  it('explains an unreadable StructTreeRoot without claiming it is missing', () => {
    showStructureReport(
      makeAccessibilityReport({
        document: makeAccessibilityDocument({ tagged: false, hasStructTreeRoot: true }),
        structure: [],
      }),
    );
    renderStructureView();

    const untagged = screen.getByTestId('structure-untagged');
    expect(untagged.textContent).toContain('could not be read');
    expect(
      within(screen.getByTestId('structure-facts')).getByText('StructTreeRoot').nextSibling?.textContent,
    ).toBe('Present');
  });
});

describe('StructureView tree', () => {
  it('expands the root and the first level only', () => {
    showStructureReport();
    renderStructureView();

    expect(nodeIdsOnScreen()).toEqual(['0', '0/0', '0/1', '0/1/0', '0/2', '0/2/0']);
    expect(screen.getByTestId('structure-count').textContent).toBe('8 nodes');
  });

  it('expands and collapses a branch', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Widget' }));
    });
    expect(nodeIdsOnScreen()).toContain('0/1/0/0');
    expect(node('0/2/0')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Widget' }));
    });
    expect(nodeIdsOnScreen()).not.toContain('0/1/0/0');
  });

  it('expands all and collapses all', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    });
    expect(nodeIdsOnScreen()).toHaveLength(8);
    expect(screen.getByTestId('structure-count').textContent).toBe('8 nodes');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    });
    expect(nodeIdsOnScreen()).toEqual(['0']);
  });

  it('marks roles, pages, MCID/OBJR references and node statuses', () => {
    showStructureReport();
    renderStructureView();

    expect(within(node('0/0')).getByText('H1')).toBeTruthy();
    expect(within(node('0/0')).getByText('MCID 0')).toBeTruthy();
    expect(within(node('0/0')).getByText('Page 1')).toBeTruthy();
    // The Span is one level deeper: collapsed branches are not rendered at all.
    expect(screen.queryByTestId('structure-node-0/1/0/0')).toBeNull();

    // MCID/OBJR markers stay raw in both locales.
    expect(within(node('0/2/0')).getByText('OBJR 12')).toBeTruthy();

    // Statuses inferred from the findings' node evidence.
    expect(within(node('0/2')).getByText('Alt missing')).toBeTruthy();
    expect(within(node('0/1/0')).getByText('Unknown role')).toBeTruthy();
    expect(within(node('0/0')).queryByText('Alt missing')).toBeNull();
  });

  it('searches roles, titles and alt text and expands the ancestors', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter structure elements by role, title or alternative text'), {
        target: { value: 'quarterly' },
      });
    });

    // The H1 title matches; its ancestor is expanded so the path stays readable.
    expect(nodeIdsOnScreen()).toEqual(['0', '0/0']);
    expect(screen.getByTestId('structure-count').textContent).toBe('2 of 8 nodes');

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter structure elements by role, title or alternative text'), {
        target: { value: 'zzz' },
      });
    });

    expect(screen.getByTestId('structure-no-match').textContent).toContain('No structure element matches');

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter structure elements by role, title or alternative text'), {
        target: { value: 'figure' },
      });
    });

    expect(nodeIdsOnScreen()).toEqual(['0', '0/2']);
  });

  it('shows only problem nodes and their ancestors when Issues only is on', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Issues only' }));
    });

    expect(nodeIdsOnScreen()).toEqual(['0', '0/1', '0/1/0', '0/2']);

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter structure elements by role, title or alternative text'), {
        target: { value: 'Figure' },
      });
    });

    // Both conditions apply: only the flagged Figure survives the search, so
    // its non-matching OBJR child is filtered out too.
    expect(nodeIdsOnScreen()).toEqual(['0', '0/2']);
  });

  it('reports when no node has an issue', () => {
    showStructureReport(
      makeAccessibilityReport({
        findings: [],
        summary: { total: 0, errors: 0, warnings: 0, info: 0 },
      }),
    );
    renderStructureView();

    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Issues only' }));
    });

    expect(screen.getByTestId('structure-no-match').textContent).toBe(
      'No structure element has a finding.',
    );
  });

  it('marks truncated children', () => {
    showStructureReport(
      makeAccessibilityReport({
        structure: [
          makeNode({
            id: '0',
            truncated: true,
            children: [makeNode({ id: '0/0', role: 'P', rawRole: 'P', page: 1 })],
          }),
        ],
      }),
    );
    renderStructureView();

    expect(screen.getByText('Children truncated — more items exist than are shown.')).toBeTruthy();
  });
});

describe('StructureView details', () => {
  it('shows the selected element, its attributes and its findings', () => {
    showStructureReport();
    renderStructureView();

    expect(screen.getByText(/Select a structure element/)).toBeTruthy();

    act(() => {
      fireEvent.click(node('0/2'));
    });

    const detail = screen.getByTestId('structure-detail');
    expect(within(detail).getAllByText('Figure').length).toBeGreaterThan(0);
    expect(within(detail).getByText('Page 2')).toBeTruthy();
    expect(within(detail).getByText('Alt')).toBeTruthy();
    expect(within(detail).getByText('Children')).toBeTruthy();
    expect(within(detail).getByText('Truncated')).toBeTruthy();

    const attributes = screen.getByTestId('structure-attributes');
    expect(within(attributes).getByText('Placement')).toBeTruthy();
    expect(within(attributes).getByText('Block')).toBeTruthy();

    const issues = screen.getByTestId('structure-detail-issues');
    expect(within(issues).getByText('Alt missing')).toBeTruthy();
    expect(within(issues).getByText('Alt missing').getAttribute('data-severity')).toBe('warning');

    // Page-level location only: the view says so instead of highlighting.
    expect(screen.getByTestId('structure-no-bbox').textContent).toContain('Page-level location only');
    expect(node('0/2').closest('[aria-selected="true"]')).toBeTruthy();
  });

  it('shows text fields of a nested element and no empty attribute table', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Widget' }));
    });
    act(() => {
      fireEvent.click(node('0/1/0/0'));
    });

    const detail = screen.getByTestId('structure-detail');
    expect(within(detail).getByText('Actual text')).toBeTruthy();
    expect(within(detail).getByText('de-DE')).toBeTruthy();
    expect(within(detail).getByText('MCID')).toBeTruthy();
    expect(within(detail).getByText('No attributes.')).toBeTruthy();
    expect(screen.queryByTestId('structure-attributes')).toBeNull();
  });

  it('offers Open page only for an element with a page and reports it', () => {
    const harness = (() => {
      showStructureReport();
      return renderStructureView();
    })();

    act(() => {
      fireEvent.click(node('0/2'));
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open page' }));
    });

    expect(harness.onOpenPage).toHaveBeenCalledWith(2);
  });

  it('jumps to Findings from the detail pane', () => {
    showStructureReport();
    const harness = renderStructureView();

    act(() => {
      fireEvent.click(node('0/0'));
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'View in Findings' }));
    });

    expect(harness.onViewInFindings).toHaveBeenCalledTimes(1);
  });

  it('shows MCID references and the object number of an OBJR node', () => {
    showStructureReport();
    renderStructureView();

    act(() => {
      fireEvent.click(node('0/2/0'));
    });

    const detail = screen.getByTestId('structure-detail');
    expect(within(detail).getAllByText('OBJR').length).toBeGreaterThan(0);
    expect(within(detail).getByText('Object number')).toBeTruthy();
    expect(within(detail).getByText('12')).toBeTruthy();
  });
});

describe('StructureView localization', () => {
  it('translates the chrome but keeps roles, MCID and PDF text raw', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    showStructureReport();
    renderStructureView();

    expect(screen.getByRole('group', { name: '结构树控件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部展开' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '仅显示问题' })).toBeTruthy();
    expect(screen.getByText('元素')).toBeTruthy();

    // Roles, MCID markers, issue statuses and the PDF's own title are data.
    expect(within(node('0/0')).getByText('H1')).toBeTruthy();
    expect(within(node('0/0')).getByText('MCID 0')).toBeTruthy();
    expect(within(node('0/0')).getByText('Quarterly report')).toBeTruthy();
    expect(within(node('0/2')).getByText('缺少 Alt')).toBeTruthy();
  });
});

describe('structure view helpers', () => {
  it('reads node ids out of finding evidence', () => {
    expect(evidenceNodeIds('nodes=0/2 (Figure, page 2)')).toEqual(['0/2']);
    expect(evidenceNodeIds('nodes=0/2 (Figure, page 2), 0/3 (P); +2 more')).toEqual(['0/2', '0/3']);
    expect(evidenceNodeIds('H1 -> H3 at 0/3 (H3, page 2)')).toEqual(['0/3']);
    expect(evidenceNodeIds('hasStructTreeRoot=true; hasParentTree=false')).toEqual([]);
    expect(evidenceNodeIds(null)).toEqual([]);
  });

  it('maps findings onto the nodes they name', () => {
    const index = buildIssueIndex([
      FIGURE_FINDING,
      UNKNOWN_ROLE_FINDING,
      // A non-structure finding never marks a structure node, even if its
      // evidence happens to look similar.
      makeFinding({ category: 'fonts', evidence: 'nodes=0/0 (H1)' }),
    ]);

    expect(index.get('0/2')?.[0].labelKey).toBe('audit.structure.issue.altMissing');
    expect(index.get('0/2')?.[0].title).toBe('Figure has no alternative text');
    expect(index.get('0/1/0')?.[0].labelKey).toBe('audit.structure.issue.unknownRole');
    expect(index.has('0/0')).toBe(false);
    // Aggregate findings without node evidence mark nothing.
    expect(buildIssueIndex([PARENT_TREE_FINDING]).size).toBe(0);
  });

  it('counts roles and flattens the forest', () => {
    const structure = makeStructure();
    expect(structureStats(structure)).toEqual({
      elements: 6,
      figures: 1,
      tables: 0,
      lists: 0,
      headings: 1,
    });
    expect(flattenStructure(structure).map((entry) => entry.id)).toEqual([
      '0',
      '0/0',
      '0/1',
      '0/1/0',
      '0/1/0/0',
      '0/1/0/0/0',
      '0/2',
      '0/2/0',
    ]);
    expect([...defaultExpandedIds(structure)]).toEqual(['0', '0/1', '0/2']);
  });

  it('describes the visible set of a filter', () => {
    const structure = makeStructure();
    const issues = buildIssueIndex([FIGURE_FINDING]);

    expect(filterStructure(structure, { search: '', issuesOnly: false }, issues)).toEqual({
      visible: null,
      ancestors: new Set(),
    });

    const byTitle = filterStructure(structure, { search: 'quarterly', issuesOnly: false }, issues);
    expect([...(byTitle.visible ?? [])].sort()).toEqual(['0', '0/0']);
    expect([...byTitle.ancestors]).toEqual(['0']);

    // Issues-only keeps the flagged nodes and every ancestor path to them.
    const onlyIssues = filterStructure(structure, { search: '', issuesOnly: true }, issues);
    expect([...(onlyIssues.visible ?? [])].sort()).toEqual(['0', '0/2']);
    expect([...onlyIssues.ancestors]).toEqual(['0']);
  });

  it('suggests a portable accessibility JSON file name', () => {
    expect(suggestAccessibilityJsonFilename('report.pdf')).toBe('report.accessibility.json');
    expect(suggestAccessibilityJsonFilename('/docs/My Report.PDF')).toBe(
      'My Report.accessibility.json',
    );
    expect(suggestAccessibilityJsonFilename('测试 报告.pdf')).toBe('测试 报告.accessibility.json');
    expect(suggestAccessibilityJsonFilename(null)).toBe('document.accessibility.json');
  });
});

// --- Audit baseline comparison ---------------------------------------------

const rowFor = (title: string): HTMLElement =>
  within(list()).getByRole('button', { name: new RegExp(title) });

const badgeOf = (title: string): HTMLElement | null =>
  within(rowFor(title)).queryByTestId('audit-baseline-badge') ?? null;

const baselineInput = (): HTMLInputElement =>
  screen.getByTestId('audit-baseline-input') as HTMLInputElement;

/** Choose `file` in the hidden picker the way a user would. */
async function chooseBaseline(file: File): Promise<void> {
  await act(async () => {
    fireEvent.change(baselineInput(), { target: { files: [file] } });
  });
}

describe('AuditWorkspace baseline', () => {
  it('disables the Baseline button until a report exists', () => {
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

    expect((screen.getByRole('button', { name: 'Baseline…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The file input is always mounted so the button only has to forward clicks.
    expect(baselineInput().getAttribute('aria-label')).toBe('Baseline AuditReport JSON file');
    expect(baselineInput().accept).toBe('.json,application/json');
  });

  it('opens the file picker from the header button', () => {
    showReport(makeReport(BASELINE_CURRENT));
    renderWorkspace();

    const click = vi.spyOn(HTMLInputElement.prototype, 'click');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Baseline…' }));
    });

    expect(click).toHaveBeenCalledTimes(1);
    // The picker opens, not the save dialog: loading is client-side only.
    expect(auditIpc.saveFile).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('loads a baseline from the picker and shows the counts and file name', async () => {
    showReport(makeReport(BASELINE_CURRENT));
    renderWorkspace();

    await chooseBaseline(baselineFile(makeReport(BASELINE_OLD), 'previous audit.json'));

    expect(store().baseline?.fileName).toBe('previous audit.json');
    expect(screen.getByTestId('audit-baseline-summary').textContent).toBe(
      'Baseline: 1 new · 2 existing · 1 moved · 1 escalated · 1 fixed',
    );
    // `fixed` has no current row, so it is a count only.
    expect(within(list()).getAllByRole('button')).toHaveLength(5);
    expect(within(list()).queryByText('Document is not tagged')).toBeNull();

    const fileName = screen.getByTestId('audit-baseline-file-name');
    expect(fileName.textContent).toBe('previous audit.json');
    expect(fileName.getAttribute('title')).toBe('Baseline file: previous audit.json');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    // The full breakdown lives in the title, zeros included.
    expect(screen.getByTestId('audit-baseline-summary').getAttribute('title')).toBe(
      'Baseline comparison — new 1, existing 2, moved 1, escalated 1, fixed 1, waived 0',
    );
    expect(auditIpc.saveFile).not.toHaveBeenCalled();
  });

  it('badges new, escalated and moved rows and leaves existing rows plain', async () => {
    await showBaseline();
    renderWorkspace();

    expect(badgeOf('JavaScript present')?.textContent).toBe('Moved');
    expect(badgeOf('JavaScript present')?.getAttribute('data-status')).toBe('moved');
    expect(badgeOf('Low DPI image on page 2')?.textContent).toBe('Escalated');
    expect(badgeOf('Missing language')?.textContent).toBe('New');
    expect(badgeOf('Font not embedded')).toBeNull();
    expect(badgeOf('Page 3 has no content')).toBeNull();

    // The badge text is part of the row's accessible name, not colour alone.
    expect(rowFor('Missing language').getAttribute('aria-label')).toBe(
      'info metadata Document: Missing language (New)',
    );
    expect(rowFor('Font not embedded').getAttribute('aria-label')).toBe(
      'warning fonts Document: Font not embedded: Inter',
    );
  });

  it('shows only new and escalated rows when New only is on', async () => {
    await showBaseline();
    renderWorkspace();

    expect(screen.getByTestId('audit-baseline-count').textContent).toBe('(2)');

    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'New only' }));
    });

    expect(store().baselineOnly).toBe(true);
    expect(rowNames()).toEqual([
      'warning images Page 2: Low DPI image on page 2 (Escalated)',
      'info metadata Document: Missing language (New)',
    ]);
    // The list count describes the combined filter, not just the baseline one.
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('2 of 5 findings');
    expect(screen.getByTestId('audit-filtered-count').getAttribute('data-baseline-only')).toBe(
      'true',
    );

    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by severity'), {
        target: { value: 'warning' },
      });
    });

    expect(rowNames()).toEqual([
      'warning images Page 2: Low DPI image on page 2 (Escalated)',
    ]);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('1 of 5 findings');

    // The category axis combines the same way: only the escalated images row
    // survives New only + `images`, and the metadata `new` row is filtered out.
    act(() => {
      fireEvent.change(screen.getByLabelText('Filter by severity'), {
        target: { value: 'all' },
      });
      fireEvent.change(screen.getByLabelText('Filter by category'), {
        target: { value: 'images' },
      });
    });

    expect(store().filter).toEqual({ severity: 'all', category: 'images' });
    expect(rowNames()).toEqual([
      'warning images Page 2: Low DPI image on page 2 (Escalated)',
    ]);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('1 of 5 findings');
    // The summary keeps the whole-document counts regardless of the filters.
    expect(screen.getByTestId('audit-baseline-summary').textContent).toBe(
      'Baseline: 1 new · 2 existing · 1 moved · 1 escalated · 1 fixed',
    );

    // Reset clears the category filter and New only together.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    });

    expect(store().baselineOnly).toBe(false);
    expect(store().filter).toEqual({ severity: 'all', category: 'all' });
    expect(rowNames()).toHaveLength(5);
    expect(screen.getByTestId('audit-filtered-count').textContent).toBe('5 findings');
  });

  it('keeps the loaded baseline and reports a bad file inline', async () => {
    await showBaseline();
    renderWorkspace();
    const before = store().comparison;

    await chooseBaseline(new File(['{ "schemaVersion": '], 'broken.json'));

    const alert = screen.getByTestId('audit-baseline-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('not valid JSON');
    // A baseline failure is never the audit-run failure, and the good baseline
    // stays on screen.
    expect(store().error).toBeNull();
    expect(store().comparison).toBe(before);
    expect(screen.getByTestId('audit-baseline-summary').textContent).toContain('1 new');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });

    expect(screen.queryByTestId('audit-baseline-error')).toBeNull();
    expect(store().baseline).not.toBeNull();
  });

  it('explains a legacy baseline and keeps the previous one', async () => {
    await showBaseline();
    renderWorkspace();

    await chooseBaseline(
      baselineFile(
        makeReport(BASELINE_OLD.map((finding) => ({ ...finding, fingerprint: undefined }))),
        'legacy.json',
      ),
    );

    expect(screen.getByTestId('audit-baseline-error').textContent).toContain(
      'Regenerate the baseline with the current CLI',
    );
    expect(screen.getByTestId('audit-baseline-file-name').textContent).toBe('baseline.json');
  });

  it('reports the first invalid baseline inline, before any baseline is loaded', async () => {
    // No baseline exists yet, so the summary pane must appear for the error
    // alone; hiding it would make the very first bad file silent.
    showReport(makeReport(BASELINE_CURRENT));
    renderWorkspace();

    const cases: Array<{ name: string; file: File; message: string }> = [
      {
        name: 'broken JSON',
        file: new File(['{ "schemaVersion": 1, '], 'broken.json'),
        message: 'not valid JSON',
      },
      {
        name: 'wrong schema version',
        file: new File([JSON.stringify({ schemaVersion: 2, findings: [] })], 'v2.json'),
        message: '"schemaVersion": 1',
      },
      {
        name: 'legacy fingerprints',
        file: baselineFile(
          makeReport(BASELINE_OLD.map((finding) => ({ ...finding, fingerprint: undefined }))),
          'legacy.json',
        ),
        message: 'Regenerate the baseline with the current CLI',
      },
    ];

    for (const testCase of cases) {
      await chooseBaseline(testCase.file);

      const alert = screen.getByTestId('audit-baseline-error');
      expect(alert.getAttribute('role'), testCase.name).toBe('alert');
      expect(alert.textContent, testCase.name).toContain(testCase.message);
      // Only the error is on screen: no counts and no toggle without a baseline.
      expect(screen.queryByTestId('audit-baseline-summary'), testCase.name).toBeNull();
      expect(screen.queryByRole('checkbox', { name: 'New only' }), testCase.name).toBeNull();
      expect(store().baseline, testCase.name).toBeNull();
      // The list keeps showing every current finding.
      expect(rowNames(), testCase.name).toHaveLength(5);

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      });

      expect(screen.queryByTestId('audit-baseline-error'), testCase.name).toBeNull();
      // Nothing is left to show, so the whole pane goes away again.
      expect(screen.queryByTestId('audit-baseline'), testCase.name).toBeNull();
      expect(store().baselineError, testCase.name).toBeNull();
    }
  });

  it('reports a current report without fingerprints instead of hiding the counts', async () => {
    // A report from an engine that predates fingerprints: the baseline file is
    // valid, so it stays loaded, but the comparison cannot be built and the
    // user must be told why rather than seeing a file name with no counts.
    showReport(makeReport(FINDINGS));
    renderWorkspace();

    await chooseBaseline(baselineFile(makeReport(BASELINE_OLD), 'previous audit.json'));

    expect(store().baseline?.fileName).toBe('previous audit.json');
    expect(store().comparison).toBeNull();
    // The baseline is still the loaded one, so its name stays in the header.
    expect(screen.getByTestId('audit-baseline-file-name').textContent).toBe('previous audit.json');

    const alert = screen.getByTestId('audit-baseline-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(
      'The current audit report has no fingerprints. Re-run the audit with the current engine.',
    );
    // No counts and no toggle without a comparison, and no audit-run error.
    expect(screen.queryByTestId('audit-baseline-summary')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'New only' })).toBeNull();
    expect(store().error).toBeNull();
    expect(rowNames()).toHaveLength(4);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });

    expect(screen.queryByTestId('audit-baseline-error')).toBeNull();
    // Dismissing explains nothing away: the baseline file is still loaded.
    expect(store().baseline).not.toBeNull();
    expect(screen.getByTestId('audit-baseline-file-name')).toBeTruthy();
  });

  it('rejects a BaselineComparison JSON instead of comparing against it', async () => {
    showReport(makeReport(BASELINE_CURRENT));
    renderWorkspace();

    const comparison = compareAuditReports(
      makeReport(BASELINE_CURRENT),
      makeReport(BASELINE_OLD),
    );

    await chooseBaseline(
      new File([JSON.stringify(comparison)], 'report.baseline.json', {
        type: 'application/json',
      }),
    );

    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    const alert = screen.getByTestId('audit-baseline-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('BaselineComparison instead of AuditReport');
    expect(rowNames()).toHaveLength(5);
  });

  it('clears the baseline, the badges and the toggle from the header', async () => {
    await showBaseline();
    renderWorkspace();
    expect(screen.getAllByTestId('audit-baseline-badge').length).toBeGreaterThan(0);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });

    expect(store().baseline).toBeNull();
    expect(store().comparison).toBeNull();
    expect(screen.queryByTestId('audit-baseline')).toBeNull();
    expect(screen.queryByTestId('audit-baseline-file-name')).toBeNull();
    expect(screen.queryAllByTestId('audit-baseline-badge')).toHaveLength(0);
    expect(rowNames()).toHaveLength(5);
  });

  it('never writes the baseline into the exported report', async () => {
    await showBaseline();
    renderWorkspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    });

    const request = auditIpc.saveFile.mock.calls[0][0] as { content: string };
    const parsed = JSON.parse(request.content) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'document',
      'findings',
      'schemaVersion',
      'summary',
      'tool',
    ]);
    expect(request.content).not.toContain('baseline');
    expect(auditIpc.saveFile).toHaveBeenCalledTimes(1);
  });

  it('localizes the counts, the toggle and the badges', async () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    await showBaseline();
    renderWorkspace();

    expect(screen.getByTestId('audit-baseline-summary').textContent).toBe(
      '基线：新增 1 · 已存在 2 · 换页 1 · 升级 1 · 已修复 1',
    );
    expect(screen.getByRole('button', { name: '基线…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '仅看新增' })).toBeTruthy();
    expect(badgeOf('Missing language')?.textContent).toBe('新增');
    expect(badgeOf('Low DPI image on page 2')?.textContent).toBe('升级');
    expect(badgeOf('JavaScript present')?.textContent).toBe('换页');
  });
});

describe('audit baseline count wording', () => {
  it('shows new, existing and fixed always and moved/escalated only when non-zero', () => {
    expect(
      auditBaselineCountsText(
        { new: 0, existing: 5, moved: 0, escalated: 0, fixed: 0, waived: 0 },
        tEn,
      ),
    ).toBe('Baseline: 0 new · 5 existing · 0 fixed');

    expect(
      auditBaselineCountsText(
        { new: 2, existing: 5, moved: 1, escalated: 1, fixed: 3, waived: 0 },
        tEn,
      ),
    ).toBe('Baseline: 2 new · 5 existing · 1 moved · 1 escalated · 3 fixed');

    // Waivers are reserved for S2 and only shown when a producer reports them.
    expect(
      auditBaselineCountsText(
        { new: 0, existing: 1, moved: 0, escalated: 0, fixed: 0, waived: 2 },
        tEn,
      ),
    ).toBe('Baseline: 0 new · 1 existing · 0 fixed · 2 waived');

    expect(BASELINE_COUNT_SEPARATOR).toBe(' · ');
  });

  it('keeps every count, zeros included, in the full title', () => {
    expect(
      auditBaselineCountsTitle(
        { new: 2, existing: 5, moved: 1, escalated: 1, fixed: 3, waived: 1 },
        tZh,
      ),
    ).toBe('基线对比——新增 2、已存在 5、换页 1、升级 1、已修复 3、已豁免 1');
  });
});
