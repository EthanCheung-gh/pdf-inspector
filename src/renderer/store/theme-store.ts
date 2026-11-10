import { create } from 'zustand';

/**
 * UI theme selection.
 *
 * `dark` is the original appearance (and the default): the flush, compact
 * panels the app has always shipped. `islands` renders the same layout as
 * floating, rounded cards on a near-black canvas.
 *
 * The active theme is mirrored to `document.documentElement.dataset.theme` so
 * `src/renderer/theme.css` can switch the structural token palette with one
 * attribute. It is persisted separately from the workspace layout so a theme
 * change cannot invalidate a saved layout (or vice versa).
 */

export type Theme = 'dark' | 'islands';

export const THEMES: readonly Theme[] = ['dark', 'islands'];
export const DEFAULT_THEME: Theme = 'dark';
export const THEME_STORAGE_KEY = 'pdf-inspector:theme:v1';

export const isTheme = (value: unknown): value is Theme =>
  value === 'dark' || value === 'islands';

/**
 * Read the persisted theme. Access to localStorage can be missing or throw
 * (opaque origins, disabled storage, jsdom); in every one of those cases the
 * dark default keeps the app usable for the session.
 */
export const readStoredTheme = (): Theme => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

const persistTheme = (theme: Theme): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is an enhancement: a failed write must not break the toggle.
  }
};

/** Apply the theme to the document; a no-op outside the DOM (tests, Node). */
export const applyTheme = (theme: Theme): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
};

/**
 * Apply the persisted theme. Called by both entry points before the first
 * render so an Islands user does not see a dark flash on startup.
 */
export const initializeTheme = (): Theme => {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
};

export interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  // The store initialises from storage too: App renders from state, so the
  // first paint already reflects the saved theme even if the entry point did
  // not call `initializeTheme` (for example in tests or a future embedder).
  theme: readStoredTheme(),

  setTheme: (theme) => {
    if (!isTheme(theme)) return;
    persistTheme(theme);
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'islands' : 'dark';
    get().setTheme(next);
  },
}));
