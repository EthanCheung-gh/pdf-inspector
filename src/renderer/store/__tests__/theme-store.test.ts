// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom under Node 22 can expose an undefined global localStorage; install a
// real Storage-shaped mock before the store module is evaluated. The property
// stays configurable so the "storage unavailable" case can replace it.
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
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  initializeTheme,
  isTheme,
  readStoredTheme,
  useThemeStore,
} from '../theme-store';

const resetTheme = (): void => {
  useThemeStore.setState({ theme: DEFAULT_THEME });
  delete document.documentElement.dataset.theme;
};

describe('theme-store', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetTheme();
  });

  it('defaults to the dark theme', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('only accepts known themes', () => {
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('islands')).toBe(true);
    expect(isTheme('light')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('reads a persisted theme and falls back for unknown values', () => {
    localStorageMock.setItem(THEME_STORAGE_KEY, 'islands');
    expect(readStoredTheme()).toBe('islands');

    localStorageMock.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('dark');
  });

  it('applies the theme to the document root', () => {
    applyTheme('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');

    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists and applies a selected theme', () => {
    useThemeStore.getState().setTheme('islands');

    expect(useThemeStore.getState().theme).toBe('islands');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
  });

  it('toggles between dark and islands', () => {
    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('islands');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('islands');

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('initialises from storage before the first render', () => {
    localStorageMock.setItem(THEME_STORAGE_KEY, 'islands');

    expect(initializeTheme()).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
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
      expect(readStoredTheme()).toBe('dark');
      expect(() => useThemeStore.getState().setTheme('islands')).not.toThrow();
      expect(useThemeStore.getState().theme).toBe('islands');
      expect(document.documentElement.dataset.theme).toBe('islands');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
