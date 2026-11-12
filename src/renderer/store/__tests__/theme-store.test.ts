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

// A controllable `prefers-color-scheme: light` query. Installed before the
// store evaluates so its initial resolvedTheme is deterministic; `emit` fires
// the same listener the browser would on an OS appearance change.
const mediaMock = vi.hoisted(() => {
  type Listener = (event: MediaQueryListEvent) => void;
  const listeners = new Set<Listener>();
  const query = {
    matches: false,
    media: '(prefers-color-scheme: light)',
    onchange: null as Listener | null,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === 'change') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === 'change') listeners.delete(listener);
    }),
    addListener: vi.fn((listener: Listener) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: Listener) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(() => true),
  };

  const matchMedia = vi.fn(() => query as unknown as MediaQueryList);
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    query,
    listeners,
    matchMedia,
    emit(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
  };
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
import {
  DEFAULT_THEME_ID,
  THEMES,
  isResolvedTheme,
  isThemeId,
  resolveTheme,
  type ThemeId,
} from '../../theme/themes';

const resetTheme = (theme: ThemeId = DEFAULT_THEME): void => {
  useThemeStore.setState({ theme, resolvedTheme: resolveTheme(theme, mediaMock.query.matches) });
  // Writing through `setState` notifies the consistency subscription, which
  // may have written the attributes; start each test from a blank document.
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
};

describe('theme registry', () => {
  it('lists Dark, Islands, Light, System in order', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(['dark', 'islands', 'light', 'system']);
    expect(THEMES.map((theme) => theme.label)).toEqual(['Dark', 'Islands', 'Light', 'System']);
    expect(DEFAULT_THEME_ID).toBe('dark');
  });

  it('validates ids and resolved palettes separately', () => {
    expect(isThemeId('dark')).toBe(true);
    expect(isThemeId('islands')).toBe(true);
    expect(isThemeId('light')).toBe(true);
    expect(isThemeId('system')).toBe(true);
    expect(isThemeId('neon')).toBe(false);
    expect(isThemeId(null)).toBe(false);

    expect(isResolvedTheme('dark')).toBe(true);
    expect(isResolvedTheme('light')).toBe(true);
    expect(isResolvedTheme('islands')).toBe(true);
    expect(isResolvedTheme('system')).toBe(false);
  });

  it('resolves System from the OS preference and keeps Islands dark', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('islands', true)).toBe('islands');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
});

describe('theme-store', () => {
  beforeEach(() => {
    localStorageMock.clear();
    mediaMock.query.matches = false;
    resetTheme();
  });

  it('attaches exactly one prefers-color-scheme listener', () => {
    initializeTheme();
    initializeTheme();

    expect(mediaMock.query.addEventListener).toHaveBeenCalledTimes(1);
    expect(mediaMock.listeners.size).toBe(1);
  });

  it('defaults to the dark theme', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
  });

  it('accepts all four themes and falls back for unknown values', () => {
    for (const theme of ['dark', 'islands', 'light', 'system'] as const) {
      expect(isTheme(theme)).toBe(true);
      localStorageMock.setItem(THEME_STORAGE_KEY, theme);
      expect(readStoredTheme()).toBe(theme);
    }

    localStorageMock.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('dark');
    expect(isTheme(null)).toBe(false);
  });

  it('reads old dark/islands values without a migration step', () => {
    localStorageMock.setItem(THEME_STORAGE_KEY, 'islands');
    expect(initializeTheme()).toBe('islands');
    expect(useThemeStore.getState().theme).toBe('islands');
    expect(useThemeStore.getState().resolvedTheme).toBe('islands');

    localStorageMock.setItem(THEME_STORAGE_KEY, 'dark');
    expect(initializeTheme()).toBe('dark');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
  });

  it('applies both the resolved palette and the selected mode to the document', () => {
    applyTheme('islands', 'islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
    expect(document.documentElement.dataset.themeMode).toBe('islands');

    applyTheme('light', 'system');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');

    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeMode).toBe('dark');
  });

  it('persists and applies a selected theme', () => {
    useThemeStore.getState().setTheme('islands');

    expect(useThemeStore.getState().theme).toBe('islands');
    expect(useThemeStore.getState().resolvedTheme).toBe('islands');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
    expect(document.documentElement.dataset.themeMode).toBe('islands');
  });

  it('resolves System from matchMedia when selecting it', () => {
    mediaMock.query.matches = true;
    useThemeStore.getState().setTheme('system');

    expect(useThemeStore.getState().theme).toBe('system');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('updates the resolved theme when the OS preference changes', () => {
    initializeTheme();
    useThemeStore.getState().setTheme('system');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');

    mediaMock.emit(true);
    expect(useThemeStore.getState().theme).toBe('system');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('system');

    mediaMock.emit(false);
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('keeps Islands dark even when the OS prefers light', () => {
    mediaMock.query.matches = true;
    useThemeStore.getState().setTheme('islands');

    expect(useThemeStore.getState().resolvedTheme).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
  });

  it('cycles dark → islands → light → system → dark', () => {
    expect(useThemeStore.getState().theme).toBe('dark');
    const seen: ThemeId[] = [];
    for (let index = 0; index < 4; index += 1) {
      useThemeStore.getState().toggleTheme();
      seen.push(useThemeStore.getState().theme);
    }

    expect(seen).toEqual(['islands', 'light', 'system', 'dark']);
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('keeps resolvedTheme and the DOM in sync when theme is set directly', () => {
    useThemeStore.setState({ theme: 'light' });

    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeMode).toBe('light');
  });

  it('initialises from storage before the first render', () => {
    localStorageMock.setItem(THEME_STORAGE_KEY, 'islands');

    expect(initializeTheme()).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
    expect(document.documentElement.dataset.themeMode).toBe('islands');
  });

  it('falls back to dark when matchMedia is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    try {
      useThemeStore.getState().setTheme('system');
      expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    } finally {
      if (original) Object.defineProperty(globalThis, 'matchMedia', original);
    }
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
      expect(useThemeStore.getState().resolvedTheme).toBe('islands');
      expect(document.documentElement.dataset.theme).toBe('islands');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
