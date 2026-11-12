// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuditReport, type AuditFinding } from '../../../shared/audit-types';
import type { PageData, PdfWord } from '../../types/pdf-objects';
import { translate, useI18nStore, type TranslateFn } from '../../i18n';
import { useAuditStore } from '../../store/audit-store';
import { useCursorStore } from '../../store/cursor-store';
import { useDiffStore } from '../../store/diff-store';
import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import { makeSampleResult } from '../../services/__tests__/diff-fixtures';
import type { RawDocument, RawPageContent } from '../../types/raw-pdf';

import { StatusBar, formatRawStatus, plural } from './StatusBar';

/** Simplified Chinese translator for the raw status helper. */
const translateZh: TranslateFn = (key, params) => translate('zh-CN', key, params);

const selectedWord: PdfWord = {
  type: 'word',
  page: 3,
  x0: 10,
  y0: 10,
  x1: 40,
  y1: 20,
  text: 'selected',
  fontname: 'Inter',
  size: 12,
};

const pageData: PageData = {
  width: 612,
  height: 792,
  rotation: 90,
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
};

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('StatusBar', () => {
  afterEach(cleanup);

  beforeEach(() => {
    // Reset the fields the bar reads so a leaked value cannot satisfy an
    // assertion in the next test.
    usePdfStore.setState({
      isLoading: false,
      currentPage: 3,
      pageCount: 12,
      allObjects: [],
      sidecarRunning: true,
      exportProgress: null,
      error: null,
      fontProgress: null,
      filterCriteria: {},
      selectedObject: null,
      pageData: null,
    });
    useCursorStore.setState({ cursorPdfPoint: null });
    useAuditStore.getState().reset();
    useDiffStore.getState().reset();
    useRawStore.getState().reset();
  });

  it('announces background font analysis progress', () => {
    usePdfStore.setState({ fontProgress: { done: 30, total: 500 } });

    render(React.createElement(StatusBar));

    const progress = screen.getByRole('status');
    expect(progress.textContent).toBe('Analyzing fonts 30/500…');
    expect(progress.getAttribute('aria-live')).toBe('polite');
    // The regular document status stays in place next to it.
    expect(screen.getByText('Page 3/12 · 0 objects')).toBeTruthy();
  });

  it('hides the font progress indicator when no run is active', () => {
    render(React.createElement(StatusBar));

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Analyzing fonts/)).toBeNull();
    expect(screen.getByText('Page 3/12 · 0 objects')).toBeTruthy();
  });

  it('renders font progress without disturbing the document, export, error and sidecar status', () => {
    usePdfStore.setState({
      isLoading: true,
      exportProgress: { done: 2, total: 5 },
      error: 'sidecar exploded',
      fontProgress: { done: 7, total: 9 },
      sidecarRunning: false,
    });

    render(React.createElement(StatusBar));

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.getByText('Exporting 2/5…')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Error: sidecar exploded');
    expect(screen.getByRole('status').textContent).toBe('Analyzing fonts 7/9…');
    expect(screen.getByText(/Sidecar offline/)).toBeTruthy();
  });

  it('summarizes active filters and clears them from the bar', () => {
    usePdfStore.setState({
      filterCriteria: {
        fontname: 'Inter',
        sizeMin: 12,
        sizeMax: 18,
        color: '#000000',
        types: ['word', 'rect'],
      },
    });

    render(React.createElement(StatusBar));

    // A named group (not a bare labelled span) so assistive tech exposes the
    // summary reliably.
    const summary = screen.getByRole('group', {
      name: 'Active filters: Inter · 12–18pt · #000000 · 2 types',
    });
    expect(summary).toBe(screen.getByLabelText('Active filters: Inter · 12–18pt · #000000 · 2 types'));
    expect(summary.textContent).toContain('Filter:');
    expect(summary.textContent).toContain('Inter · 12–18pt · #000000 · 2 types');
    // The full summary is available as a tooltip when the bar ellipsizes it.
    expect(summary.getAttribute('title')).toBe('Filter: Inter · 12–18pt · #000000 · 2 types');

    fireEvent.click(within(summary).getByRole('button', { name: 'Clear' }));

    expect(usePdfStore.getState().filterCriteria).toEqual({});
    expect(screen.queryByLabelText(/^Active filters:/)).toBeNull();
    expect(screen.queryByRole('group', { name: /^Active filters:/ })).toBeNull();
    expect(screen.getByText('Page 3/12 · 0 objects')).toBeTruthy();
  });

  it('does not reserve space for a filter summary when no filter is active', () => {
    render(React.createElement(StatusBar));

    expect(screen.queryByLabelText(/^Active filters:/)).toBeNull();
    expect(screen.queryByRole('group', { name: /^Active filters:/ })).toBeNull();
    expect(screen.queryByText('Filter:')).toBeNull();
  });

  it('shows the selected object type and page only while something is selected', () => {
    render(React.createElement(StatusBar));
    expect(screen.queryByLabelText(/^Selected /)).toBeNull();

    act(() => {
      usePdfStore.setState({ selectedObject: selectedWord });
    });

    const summary = screen.getByRole('group', { name: 'Selected word on page 3' });
    expect(summary).toBe(screen.getByLabelText('Selected word on page 3'));
    expect(summary.textContent).toContain('word');
    expect(summary.textContent).toContain('page 3');

    act(() => {
      usePdfStore.setState({ selectedObject: null });
    });
    expect(screen.queryByLabelText(/^Selected /)).toBeNull();
    expect(screen.queryByRole('group', { name: /^Selected / })).toBeNull();
  });

  it('shows the hovered PDF point and the page size/rotation summary', () => {
    usePdfStore.setState({ pageData });
    useCursorStore.setState({ cursorPdfPoint: { x: 123.44, y: 56.7 } });

    render(React.createElement(StatusBar));

    const cursor = screen.getByRole('group', { name: 'Cursor 123.4, 56.7 pt' });
    expect(cursor.textContent).toBe('123.4, 56.7 pt');
    expect(screen.getByText('612 × 792 pt · rot 90°')).toBeTruthy();
  });

  it('does not reserve space for the cursor or page summary without data', () => {
    render(React.createElement(StatusBar));

    expect(screen.queryByRole('group', { name: /^Cursor / })).toBeNull();
    expect(screen.queryByText(/· rot /)).toBeNull();
  });

  it('clears the cursor readout when the pointer leaves the page', () => {
    useCursorStore.setState({ cursorPdfPoint: { x: 1, y: 2 } });
    render(React.createElement(StatusBar));

    expect(screen.getByRole('group', { name: 'Cursor 1, 2 pt' })).toBeTruthy();

    act(() => {
      useCursorStore.setState({ cursorPdfPoint: null });
    });

    expect(screen.queryByRole('group', { name: /^Cursor / })).toBeNull();
  });

  it('translates the document summary, loading state and sidecar label', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(StatusBar));

    expect(screen.getByLabelText('应用状态')).toBeTruthy();
    expect(screen.getByText('第 3/12 页 · 0 个对象')).toBeTruthy();
    expect(screen.getByText('Sidecar 已连接')).toBeTruthy();

    act(() => {
      usePdfStore.setState({ isLoading: true });
    });

    expect(screen.getByText('加载中…')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByLabelText('Application status')).toBeTruthy();
    expect(screen.getByText('Sidecar connected')).toBeTruthy();
  });
});

describe('StatusBar diff mode', () => {
  afterEach(() => {
    cleanup();
    // Diff wins the branch over Audit/Raw, so a leftover result would hide
    // every later mode in this file.
    useDiffStore.getState().reset();
  });

  const enterDiff = (overrides: Partial<ReturnType<typeof useDiffStore.getState>> = {}): void => {
    useAuditStore.getState().reset();
    useRawStore.getState().reset();
    useDiffStore.setState({
      active: true,
      result: makeSampleResult(),
      pageIndex: 0,
      filter: { kind: 'all', type: 'all' },
      loading: false,
      error: null,
      ...overrides,
    });
  };

  it('describes the comparison instead of the Inspect document', () => {
    enterDiff();

    render(React.createElement(StatusBar));

    expect(screen.getByText('Diff page 1/3 · 4 changes')).toBeTruthy();
    expect(screen.getByText('2 vs 2 pages')).toBeTruthy();
    expect(screen.queryByText(/^Page 3\/12/)).toBeNull();
  });

  it('translates the comparing, page and page-count lines', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    enterDiff();

    render(React.createElement(StatusBar));

    expect(screen.getByText('对比第 1/3 页 · 4 处变更')).toBeTruthy();
    expect(screen.getByText('2 对 2 页')).toBeTruthy();

    act(() => {
      useDiffStore.setState({ loading: true });
    });
    expect(screen.getByText('对比：正在比较文档…')).toBeTruthy();

    act(() => {
      useDiffStore.setState({ loading: false, result: null });
    });
    expect(screen.getByText('对比：尚无比较结果')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });
    expect(screen.getByText('Diff: no comparison yet')).toBeTruthy();
  });
});

describe('StatusBar audit mode', () => {
  afterEach(cleanup);

  const finding = (severity: AuditFinding['severity'], page: number | null): AuditFinding => ({
    category: 'pages',
    severity,
    page,
    title: `${severity} finding`,
    detail: 'detail',
    evidence: null,
    recommendation: null,
  });

  const report = (
    findings: AuditFinding[] = [
      finding('error', 1),
      finding('warning', 2),
      finding('warning', 3),
      finding('info', null),
      finding('info', 4),
      finding('info', 5),
    ],
  ): ReturnType<typeof buildAuditReport> =>
    buildAuditReport(
      {
        pages: 12,
        version: '1.7',
        encrypted: false,
        title: null,
        author: null,
        producer: null,
        language: null,
        tagged: false,
      },
      findings,
      { name: 'pdf-inspector', version: '0.2.0' },
    );

  const enterAudit = (findings?: AuditFinding[]): void => {
    useAuditStore.setState({
      active: true,
      filePath: '/docs/report.pdf',
      fileName: 'report.pdf',
      report: report(findings),
      loading: false,
      progress: null,
      error: null,
    });
  };

  it('reports the audit finding counts instead of the Inspect selection and filter', () => {
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      fontProgress: { done: 3, total: 9 },
    });
    enterAudit();

    render(React.createElement(StatusBar));

    // One error is singular, two warnings are plural; `info` is uncountable.
    expect(screen.getByTestId('status-audit').textContent).toBe(
      'Audit: 1 error · 2 warnings · 3 info',
    );
    // The Inspect document is hidden behind the workspace, so neither its
    // selection nor its active filter belongs in the bar.
    expect(screen.queryByRole('group', { name: /^Selected / })).toBeNull();
    expect(screen.queryByLabelText(/^Active filters:/)).toBeNull();
    expect(screen.queryByText(/^Page 3\/12/)).toBeNull();
  });

  it('pluralizes each non-zero count on its own', () => {
    enterAudit([finding('error', 1), finding('error', 2), finding('warning', 3)]);

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-audit').textContent).toBe(
      'Audit: 2 errors · 1 warning · 0 info',
    );
  });

  it('pluralizes a single finding of every severity', () => {
    enterAudit([finding('error', 1), finding('warning', 2), finding('info', 3)]);

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-audit').textContent).toBe(
      'Audit: 1 error · 1 warning · 1 info',
    );
  });

  it('formats counts as prose, leaving uncountable nouns alone', () => {
    expect(plural(0, 'error')).toBe('0 errors');
    expect(plural(1, 'error')).toBe('1 error');
    expect(plural(2, 'error')).toBe('2 errors');
    expect(plural(1, 'warning')).toBe('1 warning');
    expect(plural(2, 'warning')).toBe('2 warnings');
    expect(plural(1, 'info', 'info')).toBe('1 info');
    expect(plural(2, 'info', 'info')).toBe('2 info');
  });

  it('reports page progress while the audit is running', () => {
    useAuditStore.setState({
      active: true,
      fileName: 'report.pdf',
      report: null,
      loading: true,
      progress: { done: 10, total: 25 },
      error: null,
    });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-audit').textContent).toBe('Audit: 10/25 pages');
    expect(screen.queryByLabelText(/^Active filters:/)).toBeNull();
  });

  it('shows an audit failure in the bar', () => {
    useAuditStore.setState({
      active: true,
      fileName: 'report.pdf',
      report: null,
      loading: false,
      progress: null,
      error: 'Sidecar is not running',
    });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-audit').textContent).toBe('Audit: no report yet');
    expect(screen.getByRole('alert').textContent).toBe('Audit failed: Sidecar is not running');
  });

  it('translates the audit summary, progress and failure lines', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    enterAudit();

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-audit').textContent).toBe(
      '审计：1 个错误 · 2 个警告 · 3 条信息',
    );

    act(() => {
      useAuditStore.setState({ report: null, loading: true, progress: { done: 10, total: 25 } });
    });
    expect(screen.getByTestId('status-audit').textContent).toBe('审计：10/25 页');

    act(() => {
      useAuditStore.setState({ progress: null, loading: false, error: 'Sidecar is not running' });
    });
    expect(screen.getByTestId('status-audit').textContent).toBe('审计：尚无报告');
    expect(screen.getByRole('alert').textContent).toBe('审计失败：Sidecar is not running');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });
    expect(screen.getByTestId('status-audit').textContent).toBe('Audit: no report yet');
  });
});

describe('StatusBar Inspect localization', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
    usePdfStore.setState({
      isLoading: false,
      currentPage: 3,
      pageCount: 12,
      allObjects: [],
      sidecarRunning: true,
      exportProgress: null,
      error: null,
      fontProgress: null,
      filterCriteria: {},
      selectedObject: null,
      pageData: null,
    });
    useCursorStore.setState({ cursorPdfPoint: null });
    useAuditStore.getState().reset();
    useDiffStore.getState().reset();
    useRawStore.getState().reset();
  });

  it('translates the document summary, geometry, cursor, selection, filter and error', () => {
    usePdfStore.setState({
      pageData,
      selectedObject: selectedWord,
      error: 'sidecar exploded',
      filterCriteria: {
        fontname: 'Inter',
        sizeMin: 12,
        sizeMax: 18,
        color: '#000000',
        types: ['word', 'rect'],
      },
    });
    useCursorStore.setState({ cursorPdfPoint: { x: 123.44, y: 56.7 } });

    render(React.createElement(StatusBar));

    expect(screen.getByText('第 3/12 页 · 0 个对象')).toBeTruthy();
    expect(screen.getByText('612 × 792 pt · 旋转 90°')).toBeTruthy();
    expect(screen.getByRole('group', { name: '光标 123.4, 56.7 pt' })).toBeTruthy();
    expect(
      screen.getByRole('group', { name: '已选中第 3 页的 word' }),
    ).toBeTruthy();
    const filters = screen.getByRole('group', {
      name: '当前筛选：Inter · 12–18pt · #000000 · 2 种类型',
    });
    expect(filters.textContent).toContain('筛选：');
    expect(filters.textContent).toContain('2 种类型');
    expect(screen.getByRole('alert').textContent).toBe('错误：sidecar exploded');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Page 3/12 · 0 objects')).toBeTruthy();
    expect(screen.getByText('612 × 792 pt · rot 90°')).toBeTruthy();
    expect(
      screen.getByRole('group', {
        name: 'Active filters: Inter · 12–18pt · #000000 · 2 types',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Error: sidecar exploded');
  });
});

describe('StatusBar raw mode', () => {
  afterEach(cleanup);

  const document: RawDocument = {
    pages: 5,
    version: '1.7',
    encrypted: false,
    roots: [],
  };

  const content: RawPageContent = {
    page: 2,
    truncated: false,
    streams: [
      {
        ref: { objectNumber: 12, generation: 0 },
        length: 128,
        filters: [],
        truncated: false,
        error: null,
        operators: [
          { index: 0, offset: 0, operator: 'BT', operands: [] },
          { index: 1, offset: 4, operator: 'Tj', operands: [] },
          { index: 2, offset: 9, operator: 'ET', operands: [] },
        ],
      },
    ],
  };

  const enterRaw = (overrides: Partial<ReturnType<typeof useRawStore.getState>> = {}): void => {
    // The bar shows exactly one workspace; the other stores are reset so a
    // leftover mode from another test cannot win the branch.
    useAuditStore.getState().reset();
    useDiffStore.getState().reset();
    useRawStore.setState({
      active: true,
      filePath: '/docs/raw.pdf',
      fileName: 'raw.pdf',
      document,
      selected: null,
      object: null,
      content: null,
      contentPage: null,
      tab: 'object',
      loading: false,
      error: null,
      ...overrides,
    });
  };

  it('describes the selected object instead of the Inspect selection', () => {
    usePdfStore.setState({
      selectedObject: selectedWord,
      filterCriteria: { types: ['word'] },
      pageData,
    });
    enterRaw({
      selected: { objectNumber: 1, generation: 0 },
      object: {
        ref: { objectNumber: 1, generation: 0 },
        summary: 'dict · 2 entries',
        value: { kind: 'null' },
      },
    });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe(
      'Raw: object 1 0 R · dict · 2 entries',
    );
    // The Inspect document is hidden behind the workspace.
    expect(screen.queryByRole('group', { name: /^Selected / })).toBeNull();
    expect(screen.queryByLabelText(/^Active filters:/)).toBeNull();
    expect(screen.queryByText(/^Page 3\/12/)).toBeNull();
  });

  it('describes the content page and its operator count', () => {
    enterRaw({ tab: 'content', content, contentPage: 2 });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe('Raw: page 2/5 · 3 operators');
  });

  it('reports loading and missing data', () => {
    enterRaw({ document: null, loading: true });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe('Raw: loading document…');
  });

  it('reports an object that is still loading', () => {
    enterRaw({ selected: { objectNumber: 7, generation: 0 }, object: null, loading: true });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe('Raw: object 7 0 R · loading…');
  });

  it('shows a raw failure in the bar', () => {
    enterRaw({ document: null, loading: false, error: 'sidecar is not running' });

    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe('Raw: no document');
    expect(screen.getByRole('alert').textContent).toBe('Raw failed: sidecar is not running');
  });

  it('formats the raw status line on its own', () => {
    expect(
      formatRawStatus({
        document: null,
        tab: 'object',
        selected: null,
        object: null,
        content: null,
        contentPage: null,
        loading: false,
      }),
    ).toBe('Raw: no document');
    expect(
      formatRawStatus({
        document,
        tab: 'object',
        selected: null,
        object: null,
        content: null,
        contentPage: null,
        loading: false,
      }),
    ).toBe('Raw: no object selected');
    expect(
      formatRawStatus({
        document,
        tab: 'content',
        selected: null,
        object: null,
        content: null,
        contentPage: 3,
        loading: true,
      }),
    ).toBe('Raw: page 3/5 · loading…');
    expect(
      formatRawStatus({
        document,
        tab: 'content',
        selected: null,
        object: null,
        content,
        contentPage: 2,
        loading: false,
      }),
    ).toBe('Raw: page 2/5 · 3 operators');
  });

  it('translates the raw page, object and missing-document lines', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    enterRaw({ tab: 'content', content, contentPage: 2 });
    render(React.createElement(StatusBar));

    expect(screen.getByTestId('status-raw').textContent).toBe('原始数据：第 2/5 页 · 3 个操作符');

    act(() => {
      useRawStore.setState({
        tab: 'object',
        selected: { objectNumber: 1, generation: 0 },
        object: { ref: { objectNumber: 1, generation: 0 }, summary: 'dict · 2 entries', value: { kind: 'null' } },
      });
    });
    expect(screen.getByTestId('status-raw').textContent).toBe(
      '原始数据：对象 1 0 R · dict · 2 entries',
    );

    act(() => {
      useRawStore.setState({ document: null, loading: false, error: 'sidecar is not running' });
    });
    expect(screen.getByTestId('status-raw').textContent).toBe('原始数据：无文档');
    expect(screen.getByRole('alert').textContent).toBe('原始数据失败：sidecar is not running');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });
    expect(screen.getByTestId('status-raw').textContent).toBe('Raw: no document');
    expect(screen.getByRole('alert').textContent).toBe('Raw failed: sidecar is not running');
  });

  it('translates the raw no-selection and loading lines on their own', () => {
    expect(
      formatRawStatus(
        {
          document,
          tab: 'object',
          selected: null,
          object: null,
          content: null,
          contentPage: null,
          loading: false,
        },
        translateZh,
      ),
    ).toBe('原始数据：未选择对象');
    expect(
      formatRawStatus(
        {
          document: null,
          tab: 'object',
          selected: null,
          object: null,
          content: null,
          contentPage: null,
          loading: true,
        },
        translateZh,
      ),
    ).toBe('原始数据：正在加载文档…');
  });
});
