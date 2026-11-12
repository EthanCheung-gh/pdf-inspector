// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate, useI18nStore, type TranslateFn } from '../../i18n';
import type { RawValue } from '../../types/raw-pdf';
import {
  RAW_VALUE_MAX_ENTRIES,
  RawValueView,
  formatRawRef,
  rawScalarText,
  rawValueSummary,
  refKey,
} from './RawValueView';

/** Simplified Chinese translator for the pure helper tests. */
const tZh: TranslateFn = (key, params) => translate('zh-CN', key, params);

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

afterEach(cleanup);

const view = (value: RawValue, onSelectRef?: (ref: { objectNumber: number; generation: number }) => void) =>
  render(React.createElement(RawValueView, { value, onSelectRef }));

describe('RawValueView scalars', () => {
  it('formats every scalar kind as plain text', () => {
    expect(rawScalarText({ kind: 'null' })).toBe('null');
    expect(rawScalarText({ kind: 'boolean', value: true })).toBe('true');
    expect(rawScalarText({ kind: 'boolean', value: false })).toBe('false');
    expect(rawScalarText({ kind: 'number', value: 42.5 })).toBe('42.5');
    expect(rawScalarText({ kind: 'name', value: 'Catalog' })).toBe('/Catalog');
    expect(rawScalarText({ kind: 'string', value: 'hello', truncated: false })).toBe('hello');
    expect(rawScalarText({ kind: 'string', value: 'hello', truncated: true })).toBe('hello…');
    expect(rawScalarText({ kind: 'dict', entries: [], truncated: false })).toBeNull();
  });

  it('spells references the way PDF does', () => {
    expect(formatRawRef({ objectNumber: 15, generation: 0 })).toBe('15 0 R');
    expect(refKey({ objectNumber: 15, generation: 2 })).toBe('15:2');
  });

  it('renders a string as React text, never as markup', () => {
    const { container } = view({
      kind: 'string',
      value: '<script>alert(1)</script>',
      truncated: false,
    });

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByTestId('raw-value').textContent).toContain('<script>alert(1)</script>');
  });

  it('marks a truncated string with an ellipsis', () => {
    view({ kind: 'string', value: 'a'.repeat(20), truncated: true });
    expect(screen.getByTestId('raw-value').textContent).toBe(`${'a'.repeat(20)}…`);
  });
});

describe('RawValueView containers', () => {
  it('renders dictionary keys and nested values', () => {
    view({
      kind: 'dict',
      truncated: false,
      entries: [
        { key: 'Type', value: { kind: 'name', value: 'Catalog' } },
        { key: 'Pages', value: { kind: 'ref', ref: { objectNumber: 3, generation: 0 } } },
        {
          key: 'Count',
          value: { kind: 'array', truncated: false, items: [{ kind: 'number', value: 2 }] },
        },
      ],
    });

    const root = screen.getByTestId('raw-value');
    expect(root.textContent).toContain('dict · 3 entries');
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('/Catalog')).toBeTruthy();
    expect(screen.getByText('Pages')).toBeTruthy();
    expect(screen.getByText('3 0 R')).toBeTruthy();
    expect(screen.getByText('Count')).toBeTruthy();
    expect(screen.getByText('[0]')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('renders array indexes and reports sidecar truncation', () => {
    view({ kind: 'array', truncated: true, items: [{ kind: 'number', value: 1 }] });

    expect(screen.getByTestId('raw-value').textContent).toContain('array · 1 item (truncated)');
    expect(screen.getByText('[0]')).toBeTruthy();
    expect(screen.getByTestId('raw-value-truncated').textContent).toContain(
      'truncated by the sidecar',
    );
  });

  it('caps the rendered entries and says how many were left out', () => {
    const items: RawValue[] = Array.from({ length: RAW_VALUE_MAX_ENTRIES + 25 }, (_value, index) => ({
      kind: 'number',
      value: index,
    }));
    view({ kind: 'array', truncated: true, items });

    expect(screen.getByTestId('raw-value-truncated').textContent).toBe(
      `Showing the first ${RAW_VALUE_MAX_ENTRIES} of ${RAW_VALUE_MAX_ENTRIES + 25} items.`,
    );
  });

  it('stops at the depth cap and says so', () => {
    let value: RawValue = { kind: 'number', value: 1 };
    for (let level = 0; level < 12; level += 1) {
      value = { kind: 'dict', truncated: false, entries: [{ key: `k${level}`, value }] };
    }
    view(value);

    expect(screen.getAllByTestId('raw-value-depth-notice').length).toBeGreaterThan(0);
  });
});

describe('RawValueView streams and refs', () => {
  const stream: RawValue = {
    kind: 'stream',
    dict: { kind: 'dict', truncated: false, entries: [{ key: 'Type', value: { kind: 'name', value: 'XObject' } }] },
    length: 128,
    filters: ['FlateDecode'],
    preview: 'BT /F1 12 Tf',
    truncated: true,
    };

  it('renders stream metadata, preview and truncation', () => {
    view(stream);

    const root = screen.getByTestId('raw-value');
    expect(root.textContent).toContain('stream · 128 B · FlateDecode');
    expect(screen.getByLabelText('Stream metadata').textContent).toContain('FlateDecode');
    expect(screen.getByTestId('raw-value-stream-preview').textContent).toBe('BT /F1 12 Tf');
    expect(screen.getByTestId('raw-value-truncated')).toBeTruthy();
    // The stream dictionary is rendered as the stream's child.
    expect(screen.getByText('Dictionary')).toBeTruthy();
    expect(screen.getByText('/XObject')).toBeTruthy();
  });

  it('never shows stream bytes when the sidecar withholds the preview', () => {
    view({ ...stream, preview: null, truncated: false, filters: ['DCTDecode'] });

    expect(screen.queryByTestId('raw-value-stream-preview')).toBeNull();
    expect(screen.getByTestId('raw-value-stream-binary').textContent).toContain('Binary stream');
    expect(rawValueSummary({ ...stream, preview: null, truncated: false })).toBe(
      'stream · 128 B · FlateDecode',
    );
  });

  it('makes references clickable when a handler is given', () => {
    const onSelectRef = vi.fn();
    view({ kind: 'ref', ref: { objectNumber: 15, generation: 0 } }, onSelectRef);

    fireEvent.click(screen.getByRole('button', { name: '15 0 R' }));
    expect(onSelectRef).toHaveBeenCalledWith({ objectNumber: 15, generation: 0 });
  });

  it('renders references as plain text without a handler', () => {
    view({ kind: 'ref', ref: { objectNumber: 15, generation: 0 } });

    expect(screen.queryByRole('button', { name: '15 0 R' })).toBeNull();
    expect(screen.getByText('15 0 R')).toBeTruthy();
  });
});

describe('RawValueView localization', () => {
  const dict: RawValue = {
    kind: 'dict',
    truncated: true,
    entries: [{ key: 'Type', value: { kind: 'name', value: 'Catalog' } }],
  };

  const stream: RawValue = {
    kind: 'stream',
    dict: { kind: 'dict', truncated: false, entries: [] },
    length: null,
    filters: [],
    preview: null,
    truncated: false,
  };

  it('translates the value summaries through the translator', () => {
    expect(rawValueSummary(dict)).toBe('dict · 1 entry (truncated)');
    expect(rawValueSummary(dict, tZh)).toBe('字典 · 1 个条目（已截断）');
    expect(rawValueSummary(stream)).toBe('stream · length unknown · no filter');
    expect(rawValueSummary(stream, tZh)).toBe('流 · 长度未知 · 无过滤器');
    expect(rawValueSummary({ kind: 'ref', ref: { objectNumber: 3, generation: 0 } }, tZh)).toBe(
      '3 0 R',
    );
  });

  it('translates the rendered metadata and notices', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    view(stream);

    expect(screen.getByLabelText('流元数据')).toBeTruthy();
    expect(screen.getByText('长度')).toBeTruthy();
    expect(screen.getByText('过滤器')).toBeTruthy();
    expect(screen.getByText('预览')).toBeTruthy();
    expect(screen.getByTestId('raw-value-stream-binary').textContent).toBe(
      '二进制流——仅显示元数据，从不显示字节。',
    );
    expect(screen.getByText('字典')).toBeTruthy();
  });
});
