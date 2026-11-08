// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawDocument, RawObject, RawRef } from '../../types/raw-pdf';

const rawIpc = vi.hoisted(() => ({
  rawDocument: vi.fn(),
  rawObject: vi.fn(),
  rawPageContent: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: rawIpc }));

import { usePdfStore } from '../../store/pdf-store';
import { useRawStore } from '../../store/raw-store';
import { RawWorkspace } from './RawWorkspace';

const CATALOG: RawRef = { objectNumber: 1, generation: 0 };

function makeDocument(): RawDocument {
  return {
    pages: 3,
    version: '1.7',
    encrypted: false,
    roots: [{ label: 'Catalog', ref: CATALOG, value: null }],
  };
}

function makeObject(): RawObject {
  return {
    ref: CATALOG,
    summary: 'dict · 1 entry',
    value: {
      kind: 'dict',
      truncated: false,
      entries: [{ key: 'Type', value: { kind: 'name', value: 'Catalog' } }],
    },
  };
}

const workspace = () => render(React.createElement(RawWorkspace));

beforeEach(() => {
  useRawStore.getState().reset();
  rawIpc.rawDocument.mockReset();
  rawIpc.rawDocument.mockResolvedValue(makeDocument());
  rawIpc.rawObject.mockReset();
  rawIpc.rawObject.mockResolvedValue(makeObject());
  rawIpc.rawPageContent.mockReset();
  rawIpc.rawPageContent.mockResolvedValue({ page: 1, truncated: false, streams: [] });
  usePdfStore.setState({ currentPage: 1, pageCount: 3 });
  useRawStore.setState({
    active: true,
    filePath: '/docs/raw.pdf',
    fileName: 'raw.pdf',
    document: makeDocument(),
    selected: CATALOG,
    object: makeObject(),
    loading: false,
    error: null,
  });
});

afterEach(cleanup);

describe('RawWorkspace header', () => {
  it('shows the workspace title, file name, tabs and controls', () => {
    workspace();

    expect(screen.getByText('Raw')).toBeTruthy();
    expect(screen.getByTestId('raw-file-name').textContent).toBe('raw.pdf');
    expect(screen.getByRole('tab', { name: 'Object' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Content stream' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to Inspect' })).toBeTruthy();
    // Tree on the left, detail on the right.
    expect(screen.getByRole('navigation', { name: 'Raw PDF object tree' })).toBeTruthy();
    expect(screen.getByTestId('raw-object-panel')).toBeTruthy();
  });

  it('leaves the workspace through Back to Inspect', () => {
    workspace();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Inspect' }));

    expect(useRawStore.getState().active).toBe(false);
  });

  it('switches between the object and content tabs', async () => {
    workspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Content stream' }));
    });

    expect(useRawStore.getState().tab).toBe('content');
    expect(screen.getByRole('tab', { name: 'Content stream' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByTestId('raw-content-panel')).toBeTruthy();
    expect(screen.queryByTestId('raw-object-panel')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Object' }));
    });
    expect(screen.getByTestId('raw-object-panel')).toBeTruthy();
  });
});

describe('RawWorkspace reload', () => {
  it('drops the current read and loads the same file again', async () => {
    workspace();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });

    await waitFor(() => expect(rawIpc.rawDocument).toHaveBeenCalledTimes(1));
    // The catalog root is selected again by the store's own load.
    await waitFor(() => expect(rawIpc.rawObject).toHaveBeenCalledWith(CATALOG));

    const state = useRawStore.getState();
    expect(state.active).toBe(true);
    expect(state.filePath).toBe('/docs/raw.pdf');
    expect(state.fileName).toBe('raw.pdf');
    expect(state.document).not.toBeNull();
  });
});

describe('RawWorkspace states', () => {
  it('reports a document that is still loading', () => {
    useRawStore.setState({ document: null, loading: true, error: null });
    workspace();

    expect(screen.getByRole('status').textContent).toBe('Loading the raw object graph…');
    expect(screen.queryByRole('navigation', { name: 'Raw PDF object tree' })).toBeNull();
  });

  it('reports a failed document read', () => {
    useRawStore.setState({ document: null, loading: false, error: 'sidecar is not running' });
    workspace();

    expect(screen.getByRole('alert').textContent).toBe('Raw view failed: sidecar is not running');
  });

  it('asks for a document when nothing is loaded', () => {
    useRawStore.setState({ document: null, loading: false, error: null });
    workspace();

    expect(screen.getByTestId('raw-workspace-empty').textContent).toContain('Open a PDF');
  });
});
