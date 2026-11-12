// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import type { PdfRect } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';
import { EXPORT_OBJECT_TYPES } from '../../services/export-data';

vi.mock('../../services/ipc-client', () => ({
  ipc: { saveFile: vi.fn(), getImageData: vi.fn() },
}));

import { ResultsTab } from './ResultsTab';

const rect: PdfRect = {
  type: 'rect',
  page: 1,
  x0: 0,
  y0: 0,
  x1: 10,
  y1: 10,
  fill: true,
  stroke: false,
  color: '#000000',
  width: 1,
};

const renderResults = (): ReturnType<typeof render> =>
  render(
    React.createElement(ResultsTab, {
      exportTypes: [...EXPORT_OBJECT_TYPES],
      onExportTypesChange: vi.fn(),
    }),
  );

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
  usePdfStore.setState({ subset: null });
});

afterEach(cleanup);

describe('ResultsTab localization', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
  });

  it('translates the empty prompt', () => {
    renderResults();

    expect(
      screen.getByText('在页面上框选区域或应用筛选，以在此收集对象。'),
    ).toBeTruthy();
  });

  it('translates the heading, region mode controls and export actions', () => {
    usePdfStore.setState({
      subset: { source: 'region', mode: 'intersect', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, objects: [rect] },
    });

    renderResults();

    expect(screen.getByText('结果（1 · 区域）')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '区域匹配模式' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '相交' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '包含' })).toBeTruthy();
    const heading = screen.getByText('结果（1 · 区域）').closest('h3') as HTMLElement;
    expect(within(heading).getByRole('button', { name: '清除' })).toBeTruthy();

    const types = screen.getByRole('group', { name: '导出类型' });
    expect(within(types).getByRole('checkbox', { name: '矩形' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 JSON' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Results (1 · region)')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Export types' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeTruthy();
  });
});
