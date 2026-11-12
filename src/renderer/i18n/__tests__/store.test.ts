// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom under Node 22 can expose an undefined global localStorage; install a
// Storage-shaped mock before the store module is evaluated. The property stays
// configurable so the "storage unavailable" case can replace it.
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

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  applyLocale,
  isLocale,
  localeHtmlLang,
  otherLocale,
  persistLocale,
  readStoredLocale,
} from '../locales';
import { initializeLocale, useI18nStore } from '../store';

const resetLocale = (): void => {
  // Direct setState notifies the consistency subscription, which writes the
  // attributes; start each test from a blank document.
  useI18nStore.setState({ locale: DEFAULT_LOCALE });
  document.documentElement.removeAttribute('lang');
  delete document.documentElement.dataset.locale;
};

describe('locale helpers', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetLocale();
  });

  afterEach(() => {
    document.documentElement.removeAttribute('lang');
    delete document.documentElement.dataset.locale;
  });

  it('defaults to English and validates locale ids', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('zh')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(otherLocale('en')).toBe('zh-CN');
    expect(otherLocale('zh-CN')).toBe('en');
    expect(localeHtmlLang('en')).toBe('en');
    expect(localeHtmlLang('zh-CN')).toBe('zh-CN');
  });

  it('reads stored locales and falls back for unknown values', () => {
    expect(readStoredLocale()).toBe('en');

    localStorageMock.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    expect(readStoredLocale()).toBe('zh-CN');

    localStorageMock.setItem(LOCALE_STORAGE_KEY, 'fr');
    expect(readStoredLocale()).toBe('en');
  });

  it('applies the locale to the document root', () => {
    applyLocale('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');

    applyLocale('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dataset.locale).toBe('en');
  });
});

describe('i18n store', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetLocale();
  });

  afterEach(() => {
    document.documentElement.removeAttribute('lang');
    delete document.documentElement.dataset.locale;
  });

  it('defaults to English', () => {
    expect(useI18nStore.getState().locale).toBe('en');
  });

  it('initialises from storage and applies html lang', () => {
    localStorageMock.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    expect(initializeLocale()).toBe('zh-CN');
    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');
  });

  it('persists and applies a selected locale', () => {
    useI18nStore.getState().setLocale('zh-CN');

    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');
  });

  it('keeps html lang in sync when the locale is set directly', () => {
    useI18nStore.setState({ locale: 'zh-CN' });

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.locale).toBe('zh-CN');
    // A direct write is not a user choice, so it is not persisted.
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it('toggles English ↔ 简体中文 and persists each choice', () => {
    useI18nStore.getState().toggleLocale();
    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');

    useI18nStore.getState().toggleLocale();
    expect(useI18nStore.getState().locale).toBe('en');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('ignores invalid values written through setLocale', () => {
    useI18nStore.getState().setLocale('fr' as never);

    expect(useI18nStore.getState().locale).toBe('en');
    expect(localStorageMock.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it('keeps working when localStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(readStoredLocale()).toBe('en');
      expect(() => persistLocale('zh-CN')).not.toThrow();
      expect(() => useI18nStore.getState().setLocale('zh-CN')).not.toThrow();
      expect(useI18nStore.getState().locale).toBe('zh-CN');
      expect(document.documentElement.lang).toBe('zh-CN');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('subscribes only once and repeated initialisation stays consistent', () => {
    localStorageMock.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    initializeLocale();
    initializeLocale();

    expect(useI18nStore.getState().locale).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    // The store has one subscription; setting the same value does not detach it.
    useI18nStore.setState({ locale: 'en' });
    expect(document.documentElement.lang).toBe('en');
  });

  it('does not throw outside the DOM', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(() => applyLocale('zh-CN')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
