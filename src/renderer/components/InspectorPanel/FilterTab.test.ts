// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useI18nStore } from '../../i18n';
import type { PdfChar } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';

import { FilterTab } from './FilterTab';

const char: PdfChar = {
  type: 'char',
  page: 1,
  x0: 0,
  y0: 0,
  x1: 10,
  y1: 10,
  text: 'a',
  fontname: 'Inter',
  size: 12,
  color: '#000000',
};

const resetStores = (): void => {
  usePdfStore.setState({ allObjects: [char], filterCriteria: {}, subset: null });
};

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

afterEach(cleanup);

describe('FilterTab', () => {
  beforeEach(resetStores);

  it('renders the English labels and keeps the object type identifier as the checkbox value', () => {
    render(React.createElement(FilterTab));

    expect(screen.getByText('Filter')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Font' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Color' })).toBeTruthy();
    const char = screen.getByRole('checkbox', { name: 'Chars' }) as HTMLInputElement;
    expect(char.value).toBe('char');
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeTruthy();
  });
});

describe('FilterTab localization', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
    resetStores();
  });

  it('translates the section, type names, controls and placeholders', () => {
    render(React.createElement(FilterTab));

    expect(screen.getByText('筛选')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '字符' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '词' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '矩形' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '线条' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '曲线' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '图像' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '表格' })).toBeTruthy();
    // The visible name is localized; the emitted identifier is not.
    expect((screen.getByRole('checkbox', { name: '字符' }) as HTMLInputElement).value).toBe(
      'char',
    );

    expect(screen.getByRole('combobox', { name: '字体' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '任意字体' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '最小字号' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '最大字号' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '颜色' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '任意颜色' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除筛选' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Filter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeTruthy();
  });
});
