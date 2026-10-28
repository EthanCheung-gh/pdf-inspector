// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePdfStore } from '../../store/pdf-store';

import { StatusBar } from './StatusBar';

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
    });
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
});
