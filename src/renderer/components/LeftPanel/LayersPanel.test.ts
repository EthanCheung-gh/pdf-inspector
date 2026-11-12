// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useI18nStore } from '../../i18n';
import { OVERLAY_LAYERS } from '../../services/overlay-style';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { PageData } from '../../types/pdf-objects';
import { LayersPanel } from './LayersPanel';

const ALL_VISIBLE: Record<string, boolean> = {
  char: true,
  word: true,
  rect: true,
  line: true,
  curve: true,
  image: true,
  table: true,
};

const pageData = (counts: Partial<Record<(typeof OVERLAY_LAYERS)[number]['countKey'], number>>): PageData =>
  ({
    width: 612,
    height: 792,
    chars: Array.from({ length: counts.chars ?? 0 }, () => ({})),
    words: Array.from({ length: counts.words ?? 0 }, () => ({})),
    rects: Array.from({ length: counts.rects ?? 0 }, () => ({})),
    lines: Array.from({ length: counts.lines ?? 0 }, () => ({})),
    curves: Array.from({ length: counts.curves ?? 0 }, () => ({})),
    images: Array.from({ length: counts.images ?? 0 }, () => ({})),
    tables: Array.from({ length: counts.tables ?? 0 }, () => ({})),
  }) as unknown as PageData;

const rowFor = (label: string): HTMLElement =>
  screen.getByText(label).closest('li') as HTMLElement;

const allVisibility = (visible: boolean): Record<string, boolean> =>
  Object.fromEntries(OVERLAY_LAYERS.map((layer) => [layer.type, visible]));

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
  usePdfStore.setState({
    pageData: pageData({}),
    overlayVisibility: { ...ALL_VISIBLE },
  });
  useWorkspaceStore.setState({ overlayOpacity: 1 });
});

afterEach(cleanup);

describe('LayersPanel', () => {

  it('renders one row per overlay type with the current page count', () => {
    usePdfStore.setState({
      pageData: pageData({
        chars: 3,
        words: 2,
        rects: 1,
        lines: 4,
        curves: 5,
        images: 6,
        tables: 7,
      }),
    });

    render(React.createElement(LayersPanel));

    expect(screen.getAllByRole('listitem')).toHaveLength(OVERLAY_LAYERS.length);
    expect(within(rowFor('Chars')).getByText('3')).toBeTruthy();
    expect(within(rowFor('Words')).getByText('2')).toBeTruthy();
    expect(within(rowFor('Rects')).getByText('1')).toBeTruthy();
    expect(within(rowFor('Lines')).getByText('4')).toBeTruthy();
    expect(within(rowFor('Curves')).getByText('5')).toBeTruthy();
    expect(within(rowFor('Images')).getByText('6')).toBeTruthy();
    expect(within(rowFor('Tables')).getByText('7')).toBeTruthy();
  });

  it('shows a placeholder for every count while page data is unavailable', () => {
    usePdfStore.setState({ pageData: null });

    render(React.createElement(LayersPanel));

    expect(screen.getAllByText('—')).toHaveLength(OVERLAY_LAYERS.length);
  });

  it('shows all layers and hides all layers from the header actions', () => {
    usePdfStore.setState({
      overlayVisibility: { ...allVisibility(false), word: true },
    });

    render(React.createElement(LayersPanel));

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual(allVisibility(true));

    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual(allVisibility(false));
  });

  it('toggles a single layer from its eye button', () => {
    render(React.createElement(LayersPanel));

    fireEvent.click(screen.getByRole('button', { name: 'Hide Words' }));
    expect(usePdfStore.getState().overlayVisibility.word).toBe(false);
    expect(screen.getByRole('button', { name: 'Show Words' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show Words' }));
    expect(usePdfStore.getState().overlayVisibility.word).toBe(true);
  });

  it('soloes one layer and restores the previous visibility on the next click', () => {
    const beforeSolo = { ...allVisibility(true), word: false, table: false };
    usePdfStore.setState({ overlayVisibility: beforeSolo });

    render(React.createElement(LayersPanel));

    fireEvent.click(screen.getByRole('button', { name: 'Solo Words' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual({ ...allVisibility(false), word: true });
    expect(
      screen.getByRole('button', { name: 'Solo Words' }).getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Solo Words' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual(beforeSolo);
    expect(
      screen.getByRole('button', { name: 'Solo Words' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('switching Solo keeps the pre-Solo snapshot for the restore click', () => {
    const beforeSolo = { ...allVisibility(true), line: false };
    usePdfStore.setState({ overlayVisibility: beforeSolo });

    render(React.createElement(LayersPanel));

    fireEvent.click(screen.getByRole('button', { name: 'Solo Words' }));
    fireEvent.click(screen.getByRole('button', { name: 'Solo Chars' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual({ ...allVisibility(false), char: true });

    fireEvent.click(screen.getByRole('button', { name: 'Solo Chars' }));
    expect(usePdfStore.getState().overlayVisibility).toEqual(beforeSolo);
  });

  it('binds the opacity slider to the workspace store', () => {
    render(React.createElement(LayersPanel));

    const slider = screen.getByLabelText('Object overlay opacity') as HTMLInputElement;
    expect(slider.value).toBe('1');
    expect(slider.min).toBe('0.15');
    expect(slider.max).toBe('1');
    expect(screen.getByText('100%')).toBeTruthy();

    fireEvent.change(slider, { target: { value: '0.4' } });

    expect(useWorkspaceStore.getState().overlayOpacity).toBe(0.4);
    expect(screen.getByText('40%')).toBeTruthy();
  });
});

describe('LayersPanel localization', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
  });

  it('translates the title, presets, rows and opacity control', () => {
    usePdfStore.setState({ pageData: pageData({ words: 2 }) });

    render(React.createElement(LayersPanel));

    expect(screen.getByRole('region', { name: '图层' })).toBeTruthy();
    expect(screen.getByText('对象图层')).toBeTruthy();
    expect(screen.getByRole('group', { name: '图层可见性预设' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('title')).toBe('显示全部对象图层');
    expect(screen.getByRole('button', { name: '无' }).getAttribute('title')).toBe('隐藏全部对象图层');
    expect(screen.getByRole('list', { name: '对象图层列表' })).toBeTruthy();

    expect(screen.getByText('字符')).toBeTruthy();
    expect(screen.getByText('词')).toBeTruthy();
    expect(screen.getByText('矩形')).toBeTruthy();
    expect(screen.getByText('线条')).toBeTruthy();
    expect(screen.getByText('曲线')).toBeTruthy();
    expect(screen.getByText('图像')).toBeTruthy();
    expect(screen.getByText('表格')).toBeTruthy();
    expect(within(rowFor('词')).getByText('2')).toBeTruthy();

    expect(screen.getByRole('button', { name: '单独显示词' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '隐藏词' })).toBeTruthy();
    expect(screen.getByText('不透明度')).toBeTruthy();
    expect(screen.getByLabelText('对象叠加层不透明度')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('translates the Solo toggle and the page-not-loaded tooltip', () => {
    usePdfStore.setState({ pageData: null });

    render(React.createElement(LayersPanel));

    expect(screen.getAllByTitle('页面未加载')).toHaveLength(OVERLAY_LAYERS.length);

    usePdfStore.setState({ pageData: pageData({ words: 2 }) });
    fireEvent.click(screen.getByRole('button', { name: '单独显示词' }));

    expect(usePdfStore.getState().overlayVisibility.word).toBe(true);
    expect(
      screen.getByRole('button', { name: '单独显示词' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: '单独显示词' }).getAttribute('title'),
    ).toBe('恢复单独显示词之前的可见性');
  });

  it('returns to English without a reload', () => {
    render(React.createElement(LayersPanel));
    expect(screen.getByText('对象图层')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Object layers')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide Words' })).toBeTruthy();
  });
});
