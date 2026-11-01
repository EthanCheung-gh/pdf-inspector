// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageData, PdfWord } from '../../types/pdf-objects';
import { useCursorStore } from '../../store/cursor-store';
import { usePdfStore } from '../../store/pdf-store';

import { StatusBar } from './StatusBar';

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
