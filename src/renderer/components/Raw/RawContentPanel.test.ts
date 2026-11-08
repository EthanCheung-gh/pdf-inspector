// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawDocument, RawPageContent, RawRef } from '../../types/raw-pdf';

const rawIpc = vi.hoisted(() => ({
  rawDocument: vi.fn(),
  rawObject: vi.fn(),
  rawPageContent: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: rawIpc }));

import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import { RawContentPanel, clampRawPage, countContentOperators } from './RawContentPanel';

const PAGES_STREAM: RawRef = { objectNumber: 10, generation: 0 };

function makeDocument(pages = 5): RawDocument {
  return {
    pages,
    version: '1.7',
    encrypted: false,
    roots: [{ label: 'Catalog', ref: { objectNumber: 1, generation: 0 }, value: null }],
  };
}

function makeContent(page: number): RawPageContent {
  return {
    page,
    truncated: false,
    streams: [
      {
        ref: { objectNumber: 10 + page, generation: 0 },
        length: 128,
        filters: ['FlateDecode'],
        truncated: false,
        error: null,
        operators: [
          { index: 0, offset: 0, operator: 'BT', operands: [] },
          {
            index: 1,
            offset: 8,
            operator: 'Tf',
            operands: [
              { kind: 'name', value: 'F1' },
              { kind: 'number', value: 12 },
            ],
          },
          {
            index: 2,
            offset: 20,
            operator: 'Do',
            operands: [{ kind: 'ref', ref: PAGES_STREAM }],
          },
        ],
      },
    ],
  };
}

const panel = () => render(React.createElement(RawContentPanel));

/** Drain the store's fire-and-forget requests without a rendered tree. */
async function settleStore(): Promise<void> {
  for (let tick = 0; tick < 200 && useRawStore.getState().loading; tick += 1) {
    await Promise.resolve();
  }
}

beforeEach(async () => {
  useRawStore.getState().reset();
  rawIpc.rawDocument.mockReset();
  rawIpc.rawDocument.mockResolvedValue(makeDocument());
  rawIpc.rawPageContent.mockReset();
  rawIpc.rawPageContent.mockImplementation(async (page: number) => makeContent(page));
  rawIpc.rawObject.mockReset();
  rawIpc.rawObject.mockResolvedValue({
    ref: { objectNumber: 1, generation: 0 },
    summary: 'dict · 0 entries',
    value: { kind: 'null' },
  });
  usePdfStore.setState({ currentPage: 2, pageCount: 5 });

  // Enter through `open()` like the app does: the store keys its page cache to
  // the open file there, which is what makes an ordinary page switch free.
  useRawStore.getState().open('/docs/raw.pdf', 'raw.pdf');
  await settleStore();
});

afterEach(cleanup);

describe('RawContentPanel helpers', () => {
  it('keeps pages inside the document', () => {
    expect(clampRawPage(0, 5)).toBe(1);
    expect(clampRawPage(7, 5)).toBe(5);
    expect(clampRawPage(2.4, 5)).toBe(2);
    expect(clampRawPage(3, 0)).toBe(1);
  });

  it('counts the operators of every stream', () => {
    expect(countContentOperators(makeContent(1).streams)).toBe(3);
    expect(countContentOperators([])).toBe(0);
  });
});

describe('RawContentPanel data', () => {
  it('loads the current PDF page by default and lists its operators', async () => {
    panel();

    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(screen.getByTestId('raw-content-summary').textContent).toBe(
        'Page 2/5 · 1 stream · 3 operators',
      ),
    );

    const table = screen.getByRole('table');
    expect(within(table).getByText('BT')).toBeTruthy();
    expect(within(table).getByText('Tf')).toBeTruthy();
    expect(within(table).getByText('/F1')).toBeTruthy();
    expect(within(table).getByText('12')).toBeTruthy();
    // Offsets and indexes are shown for every operator.
    expect(within(table).getByText('Offset')).toBeTruthy();
    expect(within(table).getAllByText('0').length).toBeGreaterThan(0);
    // Stream metadata comes from the decoded stream, not from a guess.
    expect(screen.getByText('Stream 12 0 R')).toBeTruthy();
    expect(screen.getByText('128 B')).toBeTruthy();
    expect(screen.getByText('FlateDecode')).toBeTruthy();
  });

  it('switches pages through the selector', async () => {
    panel();
    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledWith(2));

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Content page'), { target: { value: '4' } });
    });

    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledWith(4));
    await waitFor(() =>
      expect(screen.getByTestId('raw-content-summary').textContent).toContain('Page 4/5'),
    );
    expect(useRawStore.getState().contentPage).toBe(4);
  });

  it('keeps ordinary page switches cache-backed', async () => {
    panel();
    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getByTestId('raw-content-summary')).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Content page'), { target: { value: '4' } });
    });
    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledWith(4));

    // Returning to a page that was already read asks the store, not the sidecar.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Content page'), { target: { value: '2' } });
    });

    await waitFor(() =>
      expect(screen.getByTestId('raw-content-summary').textContent).toContain('Page 2/5'),
    );
    expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(2);
  });

  it('re-reads the page through Reload page even when it is cached', async () => {
    panel();
    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(1));

    // The second read returns different content, so the panel must prove it
    // replaced the cached page instead of re-rendering it.
    rawIpc.rawPageContent.mockResolvedValueOnce({
      page: 2,
      truncated: false,
      streams: [
        {
          ref: { objectNumber: 99, generation: 0 },
          length: 4,
          filters: ['FlateDecode'],
          truncated: false,
          error: null,
          operators: [{ index: 0, offset: 0, operator: 'q', operands: [] }],
        },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    });

    await waitFor(() => expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('raw-content-summary').textContent).toBe(
        'Page 2/5 · 1 stream · 1 operator',
      ),
    );
    expect(screen.getByText('Stream 99 0 R')).toBeTruthy();
    expect(screen.getByText('q')).toBeTruthy();
  });

  it('selects a reference operand and moves to the Object tab', async () => {
    panel();
    await waitFor(() => expect(screen.getByTestId('raw-content-summary')).toBeTruthy());
    rawIpc.rawObject.mockResolvedValue({
      ref: PAGES_STREAM,
      summary: 'stream',
      value: { kind: 'null' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '10 0 R' }));
    });

    expect(useRawStore.getState().selected).toEqual(PAGES_STREAM);
    expect(useRawStore.getState().tab).toBe('object');
    expect(rawIpc.rawObject).toHaveBeenCalledWith(PAGES_STREAM);
  });

  it('shows a stream error and the page truncation notice', async () => {
    rawIpc.rawPageContent.mockResolvedValue({
      page: 2,
      truncated: true,
      streams: [
        {
          ref: null,
          length: null,
          filters: [],
          operators: [],
          truncated: true,
          error: 'unexpected EOF',
        },
      ],
    });
    panel();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unexpected EOF'));
    expect(screen.getByTestId('raw-content-page-truncated')).toBeTruthy();
    expect(screen.getByTestId('raw-content-truncated')).toBeTruthy();
    expect(screen.getByText('No operators in this stream.')).toBeTruthy();
  });

  it('reports a page without content streams', async () => {
    rawIpc.rawPageContent.mockResolvedValue({ page: 2, truncated: false, streams: [] });
    panel();

    await waitFor(() =>
      expect(screen.getByTestId('raw-content-empty').textContent).toContain(
        'Page 2 has no content streams.',
      ),
    );
  });

  it('shows a failed page read with a retry', async () => {
    rawIpc.rawPageContent.mockRejectedValueOnce(new Error('page out of range'));
    panel();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Failed to read page 2: page out of range',
      ),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    await waitFor(() => expect(screen.getByTestId('raw-content-summary').textContent).toContain('Page 2/5'));
    expect(rawIpc.rawPageContent).toHaveBeenCalledTimes(2);
  });

  it('renders nothing to read for a document without pages', () => {
    useRawStore.setState({ document: makeDocument(0) });
    panel();

    expect(screen.getByTestId('raw-content-empty').textContent).toContain('no pages');
    expect(rawIpc.rawPageContent).not.toHaveBeenCalled();
  });
});
