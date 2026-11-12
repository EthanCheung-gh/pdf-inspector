// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useI18nStore } from '../../i18n';
import type { PageData } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';
import { DEFAULT_WORKSPACE_LAYOUT, useWorkspaceStore } from '../../store/workspace-store';

import { PageTab, convertPageLength, formatPageBox, formatPageLength } from './PageTab';

const pageData: PageData = {
  width: 612,
  height: 792,
  rotation: 90,
  boxes: {
    media: { x0: 0, y0: 0, x1: 612, y1: 792 },
    crop: { x0: 0, y0: 0, x1: 600, y1: 780 },
    trim: null,
    bleed: null,
    art: null,
  },
  chars: [],
  words: [],
  rects: [],
  lines: [],
  curves: [],
  images: [],
  tables: [],
};

const resetStores = (): void => {
  usePdfStore.setState({ pageData: null });
  useWorkspaceStore.setState({ ...DEFAULT_WORKSPACE_LAYOUT });
};

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('PageTab formatting', () => {
  it('converts points to millimetres and keeps undefined boxes as a dash', () => {
    expect(convertPageLength(72, 'pt')).toBe(72);
    expect(convertPageLength(72, 'mm')).toBeCloseTo(25.4, 6);
    expect(formatPageLength(612, 'pt')).toBe('612');
    expect(formatPageLength(612, 'mm')).toBe('215.9');
    expect(formatPageBox(null, 'pt')).toBe('—');
    expect(formatPageBox({ x0: 0, y0: 0, x1: 612, y1: 792 }, 'pt')).toBe('0, 0 → 612, 792');
  });
});

describe('PageTab', () => {
  afterEach(cleanup);

  beforeEach(resetStores);

  it('shows the page size, rotation and every box value', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    expect(screen.getByText('612 × 792 pt')).toBeTruthy();
    expect(screen.getByText('90°')).toBeTruthy();
    expect(screen.getByText('0, 0 → 612, 792')).toBeTruthy();
    expect(screen.getByText('0, 0 → 600, 780')).toBeTruthy();
    // Trim/Bleed/Art are undefined in this PDF.
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('switches the displayed values to millimetres', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    fireEvent.click(screen.getByRole('button', { name: 'mm' }));

    expect(useWorkspaceStore.getState().pageUnits).toBe('mm');
    expect(screen.getByRole('button', { name: 'mm' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'pt' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('215.9 × 279.4 mm')).toBeTruthy();
    expect(screen.getByText('0, 0 → 215.9, 279.4')).toBeTruthy();
  });

  it('reflects and updates the box visibility of boxes the page defines', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    const media = screen.getByRole('checkbox', { name: 'Show MediaBox' }) as HTMLInputElement;
    const crop = screen.getByRole('checkbox', { name: 'Show CropBox' }) as HTMLInputElement;

    expect(media.checked).toBe(true);
    expect(media.disabled).toBe(false);
    expect(crop.checked).toBe(true);

    fireEvent.click(crop);

    expect(useWorkspaceStore.getState().pageBoxVisibility.crop).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: 'Show CropBox' }) as HTMLInputElement).checked,
    ).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show CropBox' }));
    expect(useWorkspaceStore.getState().pageBoxVisibility.crop).toBe(true);
  });

  it('disables the toggle of a box the page does not define', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    const trim = screen.getByRole('checkbox', { name: 'Show TrimBox' }) as HTMLInputElement;

    // TrimBox is null: no control state to toggle, and no rectangle to show.
    expect(trim.disabled).toBe(true);
    expect(trim.checked).toBe(false);

    fireEvent.click(trim);

    // The persisted value is untouched, so a later page that defines the box
    // keeps the user's earlier preference.
    expect(useWorkspaceStore.getState().pageBoxVisibility.trim).toBe(false);
  });

  it('never renders a checked control for a missing box with a persisted true', () => {
    useWorkspaceStore.setState({
      pageBoxVisibility: { ...DEFAULT_WORKSPACE_LAYOUT.pageBoxVisibility, art: true },
    });
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    const art = screen.getByRole('checkbox', { name: 'Show ArtBox' }) as HTMLInputElement;
    expect(art.disabled).toBe(true);
    expect(art.checked).toBe(false);
    // The stored preference survives the page that cannot show the box.
    expect(useWorkspaceStore.getState().pageBoxVisibility.art).toBe(true);
  });

  it('warns that object overlays are unavailable on a rotated page', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    expect(
      screen.getByText(
        'Object overlay is unavailable on rotated pages. Page boxes and rulers still work.',
      ),
    ).toBeTruthy();
  });

  it('shows no rotation warning on an unrotated page', () => {
    usePdfStore.setState({ pageData: { ...pageData, rotation: 0 } });
    render(React.createElement(PageTab));

    expect(screen.getByText('0°')).toBeTruthy();
    expect(screen.queryByText(/Object overlay is unavailable/)).toBeNull();
  });

  it('toggles rulers through the display section', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    const rulers = screen.getByRole('checkbox', { name: 'Show rulers' }) as HTMLInputElement;
    expect(rulers.checked).toBe(false);

    fireEvent.click(rulers);

    expect(useWorkspaceStore.getState().showRulers).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Show rulers' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('shows dashes instead of inventing values when no page data has loaded', () => {
    render(React.createElement(PageTab));

    const panel = screen.getByText('Page boxes').closest('section') as HTMLElement;
    expect(within(panel).getAllByText('—')).toHaveLength(5);
    expect(screen.getAllByText('—')).toHaveLength(7);
  });
});

describe('PageTab localization', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
    resetStores();
  });

  it('translates sections, labels, the rotation warning and the box toggles', () => {
    usePdfStore.setState({ pageData });
    render(React.createElement(PageTab));

    expect(screen.getByText('页面')).toBeTruthy();
    expect(screen.getByText('页面框')).toBeTruthy();
    expect(screen.getByText('显示')).toBeTruthy();
    expect(screen.getByText('尺寸')).toBeTruthy();
    expect(screen.getByText('旋转')).toBeTruthy();
    expect(screen.getByText('单位')).toBeTruthy();
    expect(screen.getByText('标尺')).toBeTruthy();
    expect(
      screen.getByText('旋转页面不提供对象叠加层；页面框与标尺仍可使用。'),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: '页面单位' })).toBeTruthy();
    // pt/mm are symbols and stay untranslated.
    expect(screen.getByRole('button', { name: 'pt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'mm' })).toBeTruthy();
    // MediaBox is a technical name; only the "Show" prefix is translated.
    expect(screen.getByRole('checkbox', { name: '显示 MediaBox' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '显示标尺' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Page boxes')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Show MediaBox' })).toBeTruthy();
  });
});
