// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FontStat } from '../../types/ipc-protocol';
import { usePdfStore } from '../../store/pdf-store';

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { analyzeFonts: vi.fn(), extractPage: vi.fn() },
}));

import { ipc } from '../../services/ipc-client';
import { FontsTab } from './FontsTab';

const font: FontStat = {
  fontname: 'Helvetica',
  pages: [1],
  charCount: 42,
  sizeMin: 10,
  sizeMax: 14,
  colors: ['#000000'],
};

const otherFont: FontStat = {
  fontname: 'Times-Roman',
  pages: [1, 2],
  charCount: 7,
  sizeMin: 8,
  sizeMax: 9,
  colors: ['#111111'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('FontsTab', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    usePdfStore.setState({
      filePath: '/tmp/test.pdf',
      fontStats: null,
      isLoading: false,
      error: null,
      filterCriteria: {},
    });
  });

  it('keeps a single analyzeFonts request in flight across loading changes', async () => {
    const pending = deferred<{ fonts: FontStat[] }>();
    vi.mocked(ipc.analyzeFonts).mockReturnValue(pending.promise);
    render(React.createElement(FontsTab));

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    // Navigation toggles isLoading while the request is still pending.
    act(() => { usePdfStore.setState({ isLoading: true }); });
    act(() => { usePdfStore.setState({ isLoading: false }); });
    act(() => { usePdfStore.setState({ error: 'stale error' }); });

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ fonts: [font] });
      await pending.promise;
    });

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);
    expect(usePdfStore.getState().fontStats).toEqual([font]);
    expect(usePdfStore.getState().error).toBeNull();
    expect(screen.getByText('Helvetica')).toBeTruthy();
  });

  it('allows retry to start a new request after a failure', async () => {
    const first = deferred<{ fonts: FontStat[] }>();
    const second = deferred<{ fonts: FontStat[] }>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(React.createElement(FontsTab));

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.reject(new Error('sidecar exploded'));
      await Promise.resolve();
    });

    expect(screen.getByText('sidecar exploded')).toBeTruthy();
    expect(usePdfStore.getState().error).toBe('Failed to analyze fonts. Please try again.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.queryByText('sidecar exploded')).toBeNull();
    expect(usePdfStore.getState().error).toBeNull();
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ fonts: [font] });
      await second.promise;
    });

    expect(usePdfStore.getState().fontStats).toEqual([font]);
    expect(usePdfStore.getState().error).toBeNull();
  });

  it('ignores a result for a document that is no longer open', async () => {
    const first = deferred<{ fonts: FontStat[] }>();
    const second = deferred<{ fonts: FontStat[] }>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(React.createElement(FontsTab));

    act(() => { usePdfStore.setState({ filePath: '/tmp/other.pdf' }); });
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });

    expect(usePdfStore.getState().fontStats).toBeNull();

    await act(async () => {
      second.resolve({ fonts: [otherFont] });
      await second.promise;
    });

    expect(usePdfStore.getState().fontStats).toEqual([otherFont]);
  });
});
