// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FontStat } from '../../types/ipc-protocol';
import { usePdfStore } from '../../store/pdf-store';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
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

type FontsResponse = { fonts: FontStat[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Drains the sequential batch chain (one microtask per await and merge). */
async function flush(runs = 12): Promise<void> {
  await act(async () => {
    for (let i = 0; i < runs; i += 1) await Promise.resolve();
  });
}

/** One stat per requested range, keyed to the range's first page. */
function statPerRange(charCount: number, fontname = 'Helvetica') {
  return async (startPage?: number, _endPage?: number): Promise<FontsResponse> => {
    const page = startPage ?? 1;
    return {
      fonts: [{ fontname, pages: [page], charCount, sizeMin: 10, sizeMax: 12, colors: ['#000000'] }],
    };
  };
}

describe('FontsTab', () => {
  afterEach(cleanup);

  beforeEach(() => {
    // reset (not just clear) so a mockImplementation from one test cannot leak
    // into the next one's later batches.
    vi.resetAllMocks();
    usePdfStore.setState({
      filePath: '/tmp/test.pdf',
      pageCount: 25,
      fontStats: null,
      fontProgress: null,
      isLoading: false,
      error: null,
      filterCriteria: {},
    });
  });

  it('analyzes the document in 10-page batches and merges the results', async () => {
    vi.mocked(ipc.analyzeFonts).mockImplementation(statPerRange(7));
    render(React.createElement(FontsTab));

    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [1, 11, 21], charCount: 21, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
    ]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
    expect(screen.getByText('Helvetica')).toBeTruthy();
  });

  it('shows progress between batches and the list once done', async () => {
    usePdfStore.setState({ pageCount: 20 });
    const batches: Array<ReturnType<typeof deferred<FontsResponse>>> = [];
    vi.mocked(ipc.analyzeFonts).mockImplementation(() => {
      const pending = deferred<FontsResponse>();
      batches.push(pending);
      return pending.promise;
    });

    render(React.createElement(FontsTab));

    expect(batches).toHaveLength(1);
    expect(screen.getByText('Analyzing fonts… 0/20 pages')).toBeTruthy();
    expect(screen.getByLabelText('Font analysis progress')).toBeTruthy();

    await act(async () => {
      batches[0].resolve({ fonts: [font] });
      await batches[0].promise;
    });
    await flush(2);

    expect(batches).toHaveLength(2);
    expect(screen.getByText('Analyzing fonts… 10/20 pages')).toBeTruthy();
    expect(usePdfStore.getState().fontProgress).toEqual({ done: 10, total: 20 });
    expect(usePdfStore.getState().fontStats).toBeNull();

    await act(async () => {
      batches[1].resolve({ fonts: [otherFont] });
      await batches[1].promise;
    });
    await flush(2);

    expect(usePdfStore.getState().fontStats).toEqual([font, otherFont]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
    expect(screen.getByText('Helvetica')).toBeTruthy();
    expect(screen.getByText('Times-Roman')).toBeTruthy();
    expect(screen.queryByText('Analyzing fonts… 20/20 pages')).toBeNull();
  });

  it('surfaces a failed batch and restarts from the first page on retry', async () => {
    vi.mocked(ipc.analyzeFonts)
      .mockRejectedValueOnce(new Error('sidecar exploded'))
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('sidecar exploded')).toBeTruthy();
    expect(usePdfStore.getState().error).toBe('Failed to analyze fonts. Please try again.');
    expect(usePdfStore.getState().fontStats).toBeNull();
    // The failed run released its progress and its request slot.
    expect(usePdfStore.getState().fontProgress).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.queryByText('sidecar exploded')).toBeNull();
    expect(usePdfStore.getState().error).toBeNull();

    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [1, 11, 21], charCount: 12, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
    ]);
  });

  it('discards a pending result when the document changes and analyzes the new one from page 1', async () => {
    const first = deferred<FontsResponse>();
    const second = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 10]]);

    act(() => { usePdfStore.setState({ filePath: '/tmp/other.pdf' }); });

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [1, 10],
    ]);

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });
    await flush(2);

    // The superseded document never publishes, and its progress is gone.
    expect(usePdfStore.getState().fontStats).toBeNull();
    expect(usePdfStore.getState().fontProgress).toEqual({ done: 0, total: 25 });

    await act(async () => {
      second.resolve({ fonts: [otherFont] });
      await second.promise;
    });
    await flush();

    // Only the new document's batches contribute: the old [font] (42 chars on
    // page 1) never lands.
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [11, 21], charCount: 8, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
      { ...otherFont },
    ]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
  });

  it('keeps a single run in flight across navigation loading changes', async () => {
    const first = deferred<FontsResponse>();
    const second = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    // Navigation toggles isLoading while a batch is still pending.
    act(() => { usePdfStore.setState({ isLoading: true }); });
    act(() => { usePdfStore.setState({ isLoading: false }); });
    act(() => { usePdfStore.setState({ error: 'stale error' }); });

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });
    await flush(2);

    // The run continued into the next batch instead of restarting.
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.analyzeFonts).mock.calls[1]).toEqual([11, 20]);

    act(() => { usePdfStore.setState({ isLoading: true }); });
    act(() => { usePdfStore.setState({ isLoading: false }); });
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ fonts: [otherFont] });
      await second.promise;
    });
    await flush();

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ipc.analyzeFonts).mock.calls[2]).toEqual([21, 25]);
    expect(usePdfStore.getState().fontStats).not.toBeNull();
    expect(usePdfStore.getState().error).toBeNull();
  });

  it('reports when the document has no text fonts', async () => {
    usePdfStore.setState({ pageCount: 5 });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [] });

    render(React.createElement(FontsTab));
    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 5]]);
    expect(screen.getByText('No text fonts detected in this document.')).toBeTruthy();
    expect(usePdfStore.getState().fontStats).toEqual([]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
  });

  it('navigates to the first page of a font and applies the font filter', async () => {
    usePdfStore.setState({ pageCount: 10 });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [{ ...font, pages: [3, 4] }] });

    render(React.createElement(FontsTab));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Helvetica/ }));
    await flush(2);

    expect(navigate).toHaveBeenCalledWith(3);
    expect(usePdfStore.getState().filterCriteria).toEqual({ fontname: 'Helvetica' });
  });
});
