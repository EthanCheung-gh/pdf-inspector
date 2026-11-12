// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawDocument, RawObject, RawRef, RawValue } from '../../types/raw-pdf';

const rawIpc = vi.hoisted(() => ({
  rawDocument: vi.fn(),
  rawObject: vi.fn(),
  rawPageContent: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({ ipc: rawIpc }));

import { useRawStore } from '../../store/raw-store';
import { useI18nStore } from '../../i18n';
import { RawTree, RAW_TREE_MAX_DEPTH, RAW_TREE_MAX_ENTRIES } from './RawTree';

const CATALOG: RawRef = { objectNumber: 1, generation: 0 };
const INFO: RawRef = { objectNumber: 2, generation: 0 };
const PAGES: RawRef = { objectNumber: 3, generation: 0 };

function nestedDict(depth: number): RawValue {
  let value: RawValue = { kind: 'number', value: 0 };
  for (let level = depth - 1; level >= 0; level -= 1) {
    value = { kind: 'dict', truncated: false, entries: [{ key: `k${level}`, value }] };
  }
  return value;
}

function makeDocument(overrides: Partial<RawDocument> = {}): RawDocument {
  return {
    pages: 3,
    version: '1.7',
    encrypted: false,
    roots: [
      { label: 'Catalog', ref: CATALOG, value: null },
      { label: 'Info', ref: INFO, value: null },
      { label: 'Encrypt', ref: null, value: null },
      {
        label: 'ID',
        ref: null,
        value: {
          kind: 'array',
          truncated: false,
          items: [
            { kind: 'string', value: 'first', truncated: false },
            { kind: 'string', value: 'second', truncated: false },
          ],
        },
      },
      { label: 'Pages', ref: PAGES, value: null },
    ],
    ...overrides,
  };
}

function makeObject(ref: RawRef, value?: RawValue): RawObject {
  return {
    ref,
    summary: 'dict · 2 entries',
    value: value ?? {
      kind: 'dict',
      truncated: false,
      entries: [
        { key: 'Type', value: { kind: 'name', value: 'Catalog' } },
        { key: 'Pages', value: { kind: 'ref', ref: PAGES } },
      ],
    },
  };
}

/** Enter the tree with a loaded document, without asking the sidecar for it. */
function showTree(document: RawDocument = makeDocument()): void {
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
  });
}

const tree = () => render(React.createElement(RawTree));

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
  useRawStore.getState().reset();
  rawIpc.rawObject.mockReset();
  rawIpc.rawObject.mockImplementation(async (ref: RawRef) => makeObject(ref));
});

afterEach(cleanup);

describe('RawTree roots', () => {
  it('renders every trailer root with its reference and inline value', () => {
    showTree();
    const { container } = tree();

    expect(screen.getByTestId('raw-tree-meta').textContent).toBe('PDF 1.7 · 3 pages');
    expect(screen.getByText('Catalog')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 0 R' })).toBeTruthy();
    expect(screen.getByText('Info')).toBeTruthy();
    expect(screen.getByRole('button', { name: '2 0 R' })).toBeTruthy();
    expect(screen.getByText('Pages')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3 0 R' })).toBeTruthy();
    // A root without a reference or value is reported, not hidden.
    expect(screen.getByText('Encrypt')).toBeTruthy();
    expect(screen.getByText('not present')).toBeTruthy();
    // Inline roots (the ID array) are expandable without any request.
    expect(screen.getByRole('button', { name: 'Expand ID' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand ID' }));
    expect(screen.getByText('[0]')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('[1]')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
    expect(rawIpc.rawObject).not.toHaveBeenCalled();
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Raw PDF object tree');
  });

  it('reports the document version, page count and encryption', () => {
    showTree(makeDocument({ version: null, pages: 1, encrypted: true }));
    tree();

    expect(screen.getByTestId('raw-tree-meta').textContent).toBe(
      'PDF unknown version · 1 page · encrypted',
    );
  });
});

describe('RawTree lazy expansion', () => {
  it('asks for exactly one object when a reference is expanded', async () => {
    showTree();
    tree();

    expect(rawIpc.rawObject).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });

    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
    expect(rawIpc.rawObject).toHaveBeenCalledWith(CATALOG);
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('/Catalog')).toBeTruthy();
    // A nested reference stays a collapsed node: expanding the catalog does not
    // resolve the pages tree.
    expect(screen.getAllByText('Pages')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Expand Pages' })).toHaveLength(2);
    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
  });

  it('caches a loaded object across collapse and re-expand', async () => {
    showTree();
    tree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Catalog' }));
    expect(screen.queryByText('/Catalog')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });

    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
    expect(screen.getByText('/Catalog')).toBeTruthy();
  });

  it('does not re-ask for the same object when the same reference appears twice', async () => {
    showTree();
    tree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Info' }));
    });

    // The same /Pages reference now appears three times (the root and one entry
    // per expanded object), and expanding all three reads it exactly once.
    expect(screen.getAllByRole('button', { name: 'Expand Pages' })).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      const [next] = screen.getAllByRole('button', { name: 'Expand Pages' });
      await act(async () => {
        fireEvent.click(next);
      });
    }

    expect(rawIpc.rawObject).toHaveBeenCalledTimes(3);
    expect(
      rawIpc.rawObject.mock.calls.filter(([ref]) => (ref as RawRef).objectNumber === 3),
    ).toHaveLength(1);
  });
});

describe('RawTree selection', () => {
  it('selects a reference and reads it into the store', async () => {
    showTree();
    tree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2 0 R' }));
    });

    const state = useRawStore.getState();
    expect(state.selected).toEqual(INFO);
    expect(state.object?.ref).toEqual(INFO);
    expect(state.tab).toBe('object');
    expect(screen.getByRole('button', { name: '2 0 R' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1 0 R' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('highlights the reference the store has selected', () => {
    showTree();
    useRawStore.setState({ selected: PAGES });
    tree();

    expect(screen.getByRole('button', { name: '3 0 R' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('RawTree errors', () => {
  it('shows a per-node error and retries that node only', async () => {
    showTree();
    rawIpc.rawObject.mockRejectedValueOnce(new Error('sidecar timed out'));
    tree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Failed to read 1 0 R: sidecar timed out');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(rawIpc.rawObject).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('/Catalog')).toBeTruthy();
  });
});

describe('RawTree limits', () => {
  it('stops expanding at the depth cap and says why', () => {
    showTree(
      makeDocument({
        roots: [{ label: 'ID', ref: null, value: nestedDict(RAW_TREE_MAX_DEPTH + 2) }],
      }),
    );
    tree();

    // The root value is at depth 0, so `k0` is at depth 1 and the deepest
    // expandable node is `k{MAX_DEPTH - 1}`.
    fireEvent.click(screen.getByRole('button', { name: 'Expand ID' }));
    for (let depth = 0; depth < RAW_TREE_MAX_DEPTH - 1; depth += 1) {
      fireEvent.click(screen.getByRole('button', { name: `Expand k${depth}` }));
    }

    // The node at the cap is rendered but never expanded again.
    expect(screen.queryByRole('button', { name: `Expand k${RAW_TREE_MAX_DEPTH - 1}` })).toBeNull();
    expect(screen.getByTestId('raw-tree-depth-notice').textContent).toContain(
      `Depth limit ${RAW_TREE_MAX_DEPTH} reached`,
    );
  });

  it('caps rendered entries and reports how many were left out', () => {
    const items: RawValue[] = Array.from({ length: RAW_TREE_MAX_ENTRIES + 50 }, (_value, index) => ({
      kind: 'number',
      value: index,
    }));
    showTree(
      makeDocument({
        roots: [{ label: 'ID', ref: null, value: { kind: 'array', truncated: true, items } }],
      }),
    );
    tree();

    fireEvent.click(screen.getByRole('button', { name: 'Expand ID' }));

    expect(screen.getByTestId('raw-tree-truncated').textContent).toBe(
      `Showing the first ${RAW_TREE_MAX_ENTRIES} of ${RAW_TREE_MAX_ENTRIES + 50} items.`,
    );
    expect(screen.getByText(`[${RAW_TREE_MAX_ENTRIES - 1}]`)).toBeTruthy();
    expect(screen.queryByText(`[${RAW_TREE_MAX_ENTRIES}]`)).toBeNull();
  });

  it('stays finite when an object references itself', async () => {
    showTree();
    rawIpc.rawObject.mockResolvedValue(
      makeObject(CATALOG, {
        kind: 'dict',
        truncated: false,
        entries: [{ key: 'Parent', value: { kind: 'ref', ref: CATALOG } }],
      }),
    );
    tree();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Catalog' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Parent' }));
    });

    // The cycle is a node again, never an automatic walk: one request total and
    // the self-reference is still collapsed.
    expect(rawIpc.rawObject).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Expand Parent' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse Catalog' })).toBeTruthy();
  });
});

describe('RawTree streams', () => {
  const streamValue = (preview: string | null, truncated: boolean): RawValue => ({
    kind: 'stream',
    dict: {
      kind: 'dict',
      truncated: false,
      entries: [{ key: 'Subtype', value: { kind: 'name', value: 'Image' } }],
    },
    length: 2048,
    filters: ['DCTDecode'],
    preview,
    truncated,
  });

  const showStream = (value: RawValue): void => {
    showTree(makeDocument({ roots: [{ label: 'Contents', ref: null, value }] }));
    tree();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Contents' }));
  };

  it('labels a binary stream as metadata only instead of claiming truncation', () => {
    showStream(streamValue(null, true));

    expect(screen.getByTestId('raw-tree-stream-binary').textContent).toContain(
      'Binary stream — metadata only',
    );
    // A withheld preview is not a truncated preview.
    expect(screen.queryByText('The stream preview is truncated.')).toBeNull();
    expect(screen.queryByTestId('raw-tree-truncated')).toBeNull();
    // The metadata the tree can show is still there.
    expect(screen.getByText('stream · 2048 B · DCTDecode')).toBeTruthy();
  });

  it('reports a truncated preview only when a preview exists', () => {
    showStream(streamValue('BT /F1 12 Tf', true));

    expect(screen.getByTestId('raw-tree-truncated').textContent).toBe(
      'The stream preview is truncated.',
    );
    expect(screen.queryByTestId('raw-tree-stream-binary')).toBeNull();
  });

  it('reports neither notice for a complete text preview', () => {
    showStream(streamValue('BT ET', false));

    expect(screen.queryByTestId('raw-tree-truncated')).toBeNull();
    expect(screen.queryByTestId('raw-tree-stream-binary')).toBeNull();
  });
});

describe('RawTree localization', () => {
  it('translates the meta line, root labels and limits', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    showTree(makeDocument({ pages: 1, encrypted: true }));
    tree();

    expect(screen.getByTestId('raw-tree-meta').textContent).toBe('PDF 1.7 · 1 页 · 已加密');
    expect(screen.getByRole('navigation', { name: '原始 PDF 对象树' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开 ID' })).toBeTruthy();
    expect(screen.getByTitle('选择对象 1 0 R')).toBeTruthy();
    expect(screen.getByText('不存在')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '展开 ID' }));
    expect(screen.getByText('[0]')).toBeTruthy();
  });

  it('translates the value summaries, depth and truncation notices', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    const items: RawValue[] = Array.from({ length: RAW_TREE_MAX_ENTRIES + 5 }, (_value, index) => ({
      kind: 'number',
      value: index,
    }));
    showTree(
      makeDocument({
        roots: [
          { label: 'ID', ref: null, value: { kind: 'array', truncated: false, items } },
          { label: 'Deep', ref: null, value: nestedDict(RAW_TREE_MAX_DEPTH + 2) },
        ],
      }),
    );
    tree();

    fireEvent.click(screen.getByRole('button', { name: '展开 ID' }));
    expect(screen.getByTestId('raw-tree-truncated').textContent).toBe(
      `仅显示前 ${RAW_TREE_MAX_ENTRIES} 项，共 ${RAW_TREE_MAX_ENTRIES + 5} 项。`,
    );
    expect(screen.getByText(`数组 · ${RAW_TREE_MAX_ENTRIES + 5} 项`)).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByTestId('raw-tree-truncated').textContent).toBe(
      `Showing the first ${RAW_TREE_MAX_ENTRIES} of ${RAW_TREE_MAX_ENTRIES + 5} items.`,
    );
  });
});
