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

import { THEME_STORAGE_KEY, useThemeStore } from '../../store/theme-store';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useThemeStore.setState({ theme: 'dark' });
    delete document.documentElement.dataset.theme;
  });

  afterEach(cleanup);

  it('names the current theme and exposes the Islands pressed state', () => {
    render(React.createElement(ThemeToggle));

    const button = screen.getByRole('button', { name: 'Theme: Dark' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe('Switch to Islands theme');
  });

  it('switches to Islands on click and persists the choice', () => {
    render(React.createElement(ThemeToggle));

    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }));

    const button = screen.getByRole('button', { name: 'Theme: Islands' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('Switch to Dark theme');
    expect(useThemeStore.getState().theme).toBe('islands');
    expect(localStorageMock.getItem(THEME_STORAGE_KEY)).toBe('islands');
    expect(document.documentElement.dataset.theme).toBe('islands');
  });

  it('switches back to Dark on a second click', () => {
    useThemeStore.setState({ theme: 'islands' });
    render(React.createElement(ThemeToggle));

    fireEvent.click(screen.getByRole('button', { name: 'Theme: Islands' }));

    expect(screen.getByRole('button', { name: 'Theme: Dark' })).toBeTruthy();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
