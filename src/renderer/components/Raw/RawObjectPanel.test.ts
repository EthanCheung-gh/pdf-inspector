// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawObject, RawRef } from '../../types/raw-pdf';

const rawIpc = vi.hoisted(() => ({
  rawDocument: vi.fn(),
  rawObject: vi.fn(),
  rawPageContent: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: rawIpc }));

import { useRawStore } from '../../store/raw-store';
import { RawObjectPanel } from './RawObjectPanel';

const CATALOG: RawRef = { objectNumber: 1, generation: 0 };
const PAGES: RawRef = { objectNumber: 3, generation: 0 };

function makeObject(): RawObject {
  return {
    ref: CATALOG,
    summary: 'dict · 2 entries',
    value: {
      kind: 'dict',
      truncated: false,
      entries: [
        { key: 'Type', value: { kind: 'name', value: 'Catalog' } },
        { key: 'Pages', value: { kind: 'ref', ref: PAGES } },
      ],
    },
  };
}

const writeText = vi.fn();

beforeEach(() => {
  useRawStore.getState().reset();
  rawIpc.rawObject.mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  useRawStore.setState({ active: true, filePath: '/docs/raw.pdf', fileName: 'raw.pdf' });
});

afterEach(cleanup);

const panel = () => render(React.createElement(RawObjectPanel));

describe('RawObjectPanel states', () => {
  it('asks for a selection when nothing is selected', () => {
    panel();

    expect(screen.getByTestId('raw-object-empty').textContent).toContain('Select a reference');
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toHaveProperty('disabled', true);
  });

  it('reports the object it is reading', () => {
    useRawStore.setState({ selected: CATALOG, object: null, loading: true });
    panel();

    expect(screen.getByRole('status').textContent).toBe('Reading 1 0 R…');
    expect(screen.getByText('Object 1 0 R')).toBeTruthy();
  });

  it('renders the selected object value and summary', () => {
    useRawStore.setState({ selected: CATALOG, object: makeObject(), loading: false });
    panel();

    expect(screen.getByTestId('raw-object-panel').textContent).toContain('dict · 2 entries');
    expect(screen.getByTestId('raw-value')).toBeTruthy();
    expect(screen.getByText('/Catalog')).toBeTruthy();
    expect(screen.getByText('Pages')).toBeTruthy();
  });

  it('shows a failure with a retry that re-selects the object', async () => {
    useRawStore.setState({
      selected: PAGES,
      object: null,
      loading: false,
      error: 'sidecar is not running',
    });
    rawIpc.rawObject.mockResolvedValue({ ...makeObject(), ref: PAGES });
    panel();

    expect(screen.getByRole('alert').textContent).toContain(
      'Failed to read 3 0 R: sidecar is not running',
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(rawIpc.rawObject).toHaveBeenCalledWith(PAGES);
    expect(useRawStore.getState().object?.ref).toEqual(PAGES);
  });

  it('selects a referenced object from the value tree', async () => {
    useRawStore.setState({ selected: CATALOG, object: makeObject(), loading: false });
    rawIpc.rawObject.mockResolvedValue({ ...makeObject(), ref: PAGES });
    panel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '3 0 R' }));
    });

    expect(useRawStore.getState().selected).toEqual(PAGES);
    expect(rawIpc.rawObject).toHaveBeenCalledWith(PAGES);
  });
});

describe('RawObjectPanel copy', () => {
  it('copies the raw object JSON and reports success', async () => {
    const object = makeObject();
    useRawStore.setState({ selected: CATALOG, object, loading: false });
    writeText.mockResolvedValue(undefined);
    panel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(object, null, 2));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
  });

  it('reports a failed copy without changing the object', async () => {
    useRawStore.setState({ selected: CATALOG, object: makeObject(), loading: false });
    writeText.mockRejectedValue(new Error('denied'));
    panel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    });

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copy failed'));
    expect(useRawStore.getState().object?.ref).toEqual(CATALOG);
  });
});
