// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../i18n';
import { EXPORT_OBJECT_TYPES } from '../services/export-data';
import type { PdfObjectType } from '../types/pdf-objects';
import { EXPORT_TYPE_LABELS, ExportTypeSelector } from './ExportTypeSelector';

/** Checkbox names in the order the component must render them. */
const CANONICAL_NAMES = EXPORT_OBJECT_TYPES.map((type) => EXPORT_TYPE_LABELS[type]);

const ALL = [...EXPORT_OBJECT_TYPES];

type Props = {
  selected: readonly PdfObjectType[];
  onChange: (types: PdfObjectType[]) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
};

function renderSelector(overrides: Partial<Props> = {}) {
  const props: Props = { selected: ALL, onChange: vi.fn(), ...overrides };
  render(React.createElement(ExportTypeSelector, props));
  return props;
}

/** Controlled harness so the rendered count follows the emitted selection. */
function renderStateful(initial: readonly PdfObjectType[]) {
  const onChange = vi.fn();
  const Harness = () => {
    const [selected, setSelected] = useState<PdfObjectType[]>([...initial]);
    return React.createElement(ExportTypeSelector, {
      selected,
      onChange: (types: PdfObjectType[]) => {
        onChange(types);
        setSelected(types);
      },
    });
  };
  render(React.createElement(Harness));
  return onChange;
}

function group(name = 'Object types'): HTMLElement {
  return screen.getByRole('group', { name });
}

function checkbox(name: string): HTMLInputElement {
  return within(group()).getByRole('checkbox', { name }) as HTMLInputElement;
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('ExportTypeSelector', () => {
  afterEach(cleanup);

  it('renders every type checked in canonical order with a 7/7 count', () => {
    renderSelector();

    const boxes = CANONICAL_NAMES.map((name) => checkbox(name));
    expect(within(group()).getAllByRole('checkbox')).toHaveLength(EXPORT_OBJECT_TYPES.length);
    boxes.forEach((box) => expect(box.checked).toBe(true));
    for (let i = 1; i < boxes.length; i += 1) {
      // Each canonical name must come after the previous one in the DOM.
      expect(boxes[i - 1].compareDocumentPosition(boxes[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(group()).getByText('7/7')).toBeTruthy();
  });

  it('toggles a type off and shows the new count', () => {
    const onChange = renderStateful(ALL);

    fireEvent.click(checkbox('Chars'));

    expect(onChange).toHaveBeenCalledWith(ALL.filter((type) => type !== 'char'));
    expect(checkbox('Chars').checked).toBe(false);
    expect(within(group()).getByText('6/7')).toBeTruthy();
  });

  it('re-emits a non-canonical selection in canonical order when toggling', () => {
    const props = renderSelector({ selected: ['table', 'char'] });

    fireEvent.click(checkbox('Words'));

    expect(props.onChange).toHaveBeenCalledWith(['char', 'word', 'table']);
  });

  it('Clear emits an empty selection, unchecks every box and shows 0/7', () => {
    const onChange = renderStateful(ALL);

    fireEvent.click(within(group()).getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith([]);
    CANONICAL_NAMES.forEach((name) => expect(checkbox(name).checked).toBe(false));
    expect(within(group()).getByText('0/7')).toBeTruthy();
  });

  it('Select all restores every type in canonical order', () => {
    const onChange = renderStateful(['word']);

    fireEvent.click(within(group()).getByRole('button', { name: 'Select all' }));

    expect(onChange).toHaveBeenCalledWith(ALL);
    CANONICAL_NAMES.forEach((name) => expect(checkbox(name).checked).toBe(true));
    expect(within(group()).getByText('7/7')).toBeTruthy();
  });

  it('disables every checkbox and both buttons, ignoring interactions', () => {
    const props = renderSelector({ disabled: true });

    CANONICAL_NAMES.forEach((name) => expect(checkbox(name).disabled).toBe(true));
    expect((within(group()).getByRole('button', { name: 'Select all' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(group()).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(checkbox('Chars'));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('uses the provided label as the group name', () => {
    renderSelector({ label: 'Export types' });

    expect(screen.getByRole('group', { name: 'Export types' })).toBeTruthy();
  });
});

describe('ExportTypeSelector localization', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
  });

  it('translates labels and actions while emitted values stay identifiers', () => {
    const onChange = renderStateful(ALL);

    const zhGroup = within(screen.getByRole('group', { name: '对象类型' }));
    expect(zhGroup.getByText('7/7')).toBeTruthy();
    expect((zhGroup.getByRole('checkbox', { name: '字符' }) as HTMLInputElement).value).toBe(
      'char',
    );
    expect((zhGroup.getByRole('checkbox', { name: '词' }) as HTMLInputElement).value).toBe('word');
    expect((zhGroup.getByRole('checkbox', { name: '矩形' }) as HTMLInputElement).value).toBe(
      'rect',
    );
    expect(zhGroup.getByRole('checkbox', { name: '线条' })).toBeTruthy();
    expect(zhGroup.getByRole('checkbox', { name: '曲线' })).toBeTruthy();
    expect(zhGroup.getByRole('checkbox', { name: '图像' })).toBeTruthy();
    expect(zhGroup.getByRole('checkbox', { name: '表格' })).toBeTruthy();
    expect(zhGroup.getByRole('button', { name: '全选' })).toBeTruthy();
    expect(zhGroup.getByRole('button', { name: '清除' })).toBeTruthy();

    fireEvent.click(zhGroup.getByRole('checkbox', { name: '字符' }));
    expect(onChange).toHaveBeenCalledWith(ALL.filter((type) => type !== 'char'));
    expect(zhGroup.getByText('6/7')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('group', { name: 'Object types' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select all' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Chars' })).toBeTruthy();
  });
});
