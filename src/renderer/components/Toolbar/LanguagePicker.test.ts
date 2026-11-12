// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { LOCALE_STORAGE_KEY } from '../../i18n';
import { useI18nStore } from '../../i18n/store';
import { LanguagePicker } from './LanguagePicker';

const resetLocale = (): void => {
  useI18nStore.setState({ locale: 'en' });
  document.documentElement.removeAttribute('lang');
  delete document.documentElement.dataset.locale;
};

describe('LanguagePicker', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetLocale();
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('lang');
    delete document.documentElement.dataset.locale;
  });

  it('shows EN with an accessible name and action tooltip in English', () => {
    render(React.createElement(LanguagePicker));

    const button = screen.getByRole('button', { name: 'Language: English' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('EN');
    expect(button.getAttribute('title')).toBe('Switch to 简体中文');
  });

  it('is keyboard focusable', () => {
    render(React.createElement(LanguagePicker));

    const button = screen.getByRole('button', { name: 'Language: English' });
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('switches to 中文, persists and applies the locale immediately', () => {
    render(React.createElement(LanguagePicker));

    fireEvent.click(screen.getByRole('button', { name: 'Language: English' }));

    const button = screen.getByRole('button', { name: '语言：简体中文' });
    expect(button.textContent).toBe('中文');
    expect(button.getAttribute('title')).toBe('切换到 English');
    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');
  });

  it('switches back to English and persists it', () => {
    render(React.createElement(LanguagePicker));

    const click = (): void => {
      fireEvent.click(screen.getByRole('button'));
    };

    click();
    click();

    const button = screen.getByRole('button', { name: 'Language: English' });
    expect(button.textContent).toBe('EN');
    expect(button.getAttribute('title')).toBe('Switch to 简体中文');
    expect(useI18nStore.getState().locale).toBe('en');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('starts in the persisted language', () => {
    localStorageMock.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    useI18nStore.setState({ locale: 'zh-CN' });

    render(React.createElement(LanguagePicker));

    expect(screen.getByRole('button', { name: '语言：简体中文' }).textContent).toBe('中文');
  });
});
