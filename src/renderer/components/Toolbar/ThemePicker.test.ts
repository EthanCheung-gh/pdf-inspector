// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Install a Storage-shaped localStorage before the persisted store evaluates.
const localStorageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => (values.has(key) ? (values.get(key) as string) : null),
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
  return storage;
});

import { THEME_STORAGE_KEY, useThemeStore } from '../../store/theme-store';
import { useI18nStore } from '../../i18n/store';
import { ThemePicker } from './ThemePicker';

const renderPicker = (): HTMLSelectElement => {
  render(React.createElement(ThemePicker));
  return screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
};

describe('ThemePicker', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useI18nStore.setState({ locale: 'en' });
    useThemeStore.setState({ theme: 'dark', resolvedTheme: 'dark' });
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;
  });

  afterEach(cleanup);

  it('shows the current theme and offers all four options', () => {
    const select = renderPicker();

    expect(select.value).toBe('dark');
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      'Dark',
      'Islands',
      'Light',
      'System',
    ]);
    expect(select.getAttribute('title')).toBe('Theme: Dark');
  });

  it('is a single focusable native control with an accessible name', () => {
    const select = renderPicker();

    expect(select.tagName).toBe('SELECT');
    expect(select.disabled).toBe(false);
    expect(select.getAttribute('aria-label')).toBe('Theme');
    select.focus();
    expect(document.activeElement).toBe(select);
  });

  it('selects, persists and applies a theme immediately', () => {
    const select = renderPicker();

    fireEvent.change(select, { target: { value: 'light' } });

    expect(select.value).toBe('light');
    expect(useThemeStore.getState().theme).toBe('light');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');
    expect(select.getAttribute('title')).toBe('Theme: Light');
  });

  it('persists and applies Islands', () => {
    const select = renderPicker();

    fireEvent.change(select, { target: { value: 'islands' } });

    expect(useThemeStore.getState().theme).toBe('islands');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
    expect(document.documentElement.dataset.themeMode).toBe('islands');
  });

  it('names the resolved palette in the System tooltip', () => {
    const select = renderPicker();

    fireEvent.change(select, { target: { value: 'system' } });

    // jsdom has no matchMedia, so System resolves to the dark fallback.
    expect(select.value).toBe('system');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(select.getAttribute('title')).toBe('Theme: System (Dark)');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('system');
  });

  it('shows System (Light) when the resolved palette is light', () => {
    useThemeStore.setState({ theme: 'system' });
    useThemeStore.setState({ resolvedTheme: 'light' });

    const select = renderPicker();

    expect(select.value).toBe('system');
    expect(select.getAttribute('title')).toBe('Theme: System (Light)');
  });

  it('translates the option labels, aria label and tooltip, then restores English', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    render(React.createElement(ThemePicker));

    let select = screen.getByRole('combobox', { name: '主题' }) as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('主题');
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      '深色',
      '岛屿',
      '浅色',
      '跟随系统',
    ]);
    expect(select.getAttribute('title')).toBe('主题：深色');

    fireEvent.change(select, { target: { value: 'system' } });
    expect(select.getAttribute('title')).toBe('主题：跟随系统（深色）');

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('Theme');
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      'Dark',
      'Islands',
      'Light',
      'System',
    ]);
    expect(select.getAttribute('title')).toBe('Theme: System (Dark)');
  });
});
