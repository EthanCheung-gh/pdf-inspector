// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuditReport, type AuditFinding } from '../../../shared/audit-types';
import type { PageData, PdfWord } from '../../types/pdf-objects';
import { useAuditStore } from '../../store/audit-store';
import { useCursorStore } from '../../store/cursor-store';
import { useDiffStore } from '../../store/diff-store';
import { usePdfStore } from '../../store/pdf-store';

import { StatusBar, plural } from './StatusBar';

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
});
