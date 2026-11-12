import { create } from 'zustand';
import {
  DEFAULT_THEME_ID,
  THEME_IDS,
  isThemeId,
  resolveTheme,
  type ResolvedTheme,
  type ThemeId,
} from '../theme/themes';

/**
 * UI theme selection.
 *
 * `theme` is the user's choice and may be the `system` mode; `resolvedTheme`
 * is the concrete palette (`dark`, `islands` or `light`) that `theme.css`
 * actually renders. Both are mirrored to the root element:
 *
 * - `data-theme="<resolved>"` selects the token block;
 * - `data-theme-mode="<id>"` lets the UI know the user selected System.
 *
 * The preference is persisted separately from the workspace layout so a theme
 * change cannot invalidate a saved layout (or vice versa).
 */

export type Theme = ThemeId;
export type { ResolvedTheme, ThemeId };

export const DEFAULT_THEME = DEFAULT_THEME_ID;
export const THEME_STORAGE_KEY = 'pdf-inspector:theme:v1';
export const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Backwards-compatible aliases for callers that used the old store API. */
export const isTheme = isThemeId;

/**
 * Read the persisted theme. Access to localStorage can be missing or throw
 * (opaque origins, disabled storage, jsdom); in every one of those cases the
 * dark default keeps the app usable for the session. The previous values
 * (`dark` / `islands`) remain valid, so no migration step is needed.
 */
export const readStoredTheme = (): ThemeId => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME_ID;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
};

const persistTheme = (theme: ThemeId): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is an enhancement: a failed write must not break the picker.
  }
};

/** Whether the OS currently prefers a light appearance (false without matchMedia). */
export const prefersLightTheme = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(SYSTEM_LIGHT_QUERY).matches === true;
  } catch {
    return false;
  }
};

/**
 * Apply a resolved palette to the document; a no-op outside the DOM (tests,
 * Node). `theme` is the selected id, so System keeps its own mode attribute.
 */
export const applyTheme = (
  resolvedTheme: ResolvedTheme,
  theme: ThemeId = resolvedTheme,
): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = theme;
};

export interface ThemeState {
  /** The selected id, including the `system` mode. */
  theme: ThemeId;
  /** The concrete palette applied to the DOM. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeId) => void;
  toggleTheme: () => void;
  /** Re-resolve `theme` after a `prefers-color-scheme` change (or on demand). */
  syncSystemTheme: (prefersLight?: boolean) => void;
}

const initialTheme = readStoredTheme();

export const useThemeStore = create<ThemeState>()((set, get) => ({
  // The store initialises from storage too: App renders from state, so the
  // first paint already reflects the saved theme even if the entry point did
  // not call `initializeTheme` (for example in tests or a future embedder).
  theme: initialTheme,
  resolvedTheme: resolveTheme(initialTheme, prefersLightTheme()),

  setTheme: (theme) => {
    if (!isThemeId(theme)) return;
    persistTheme(theme);
    const resolvedTheme = resolveTheme(theme, prefersLightTheme());
    applyTheme(resolvedTheme, theme);
    set({ theme, resolvedTheme });
  },

  toggleTheme: () => {
    const current = get().theme;
    const index = THEME_IDS.indexOf(current);
    const next = THEME_IDS[(index + 1) % THEME_IDS.length] ?? DEFAULT_THEME_ID;
    get().setTheme(next);
  },

  syncSystemTheme: (prefersLight = prefersLightTheme()) => {
    const { theme, resolvedTheme } = get();
    const nextResolved = resolveTheme(theme, prefersLight);
    // Keep the DOM attribute in sync even when a change event reports the same
    // resolution (for example a listener fired while the theme is not System).
    applyTheme(nextResolved, theme);
    if (nextResolved !== resolvedTheme) set({ resolvedTheme: nextResolved });
  },
}));

/**
 * Keep `resolvedTheme` and the DOM attributes correct when `theme` is written
 * directly through `setState` (tests, embeds and future non-store callers).
 * `setTheme` already does the same work; this subscription is the safety net.
 */
let unsubscribeConsistency: (() => void) | null = null;

const ensureStoreConsistency = (): void => {
  if (unsubscribeConsistency) return;
  unsubscribeConsistency = useThemeStore.subscribe((state, previous) => {
    if (state.theme === previous.theme) return;
    const resolvedTheme = resolveTheme(state.theme, prefersLightTheme());
    applyTheme(resolvedTheme, state.theme);
    if (resolvedTheme !== state.resolvedTheme) {
      useThemeStore.setState({ resolvedTheme });
    }
  });
};

ensureStoreConsistency();

/**
 * The OS listener is attached at most once per document. `initializeTheme` is
 * called by both entry points (desktop and web) before the first render; the
 * guard also makes repeated calls from tests or embeds harmless.
 */
let systemMediaQuery: MediaQueryList | null = null;

const handleSystemThemeChange = (event: MediaQueryListEvent): void => {
  useThemeStore.getState().syncSystemTheme(event.matches);
};

export const attachSystemThemeListener = (): void => {
  if (systemMediaQuery) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  try {
    const media = window.matchMedia(SYSTEM_LIGHT_QUERY);
    const listener: (event: MediaQueryListEvent) => void = handleSystemThemeChange;
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', listener);
    } else if (typeof media.addListener === 'function') {
      // Safari < 14 and older jsdom implementations only expose the legacy API.
      media.addListener(listener);
    } else {
      // No listener API: stay unattached so a later call can retry.
      return;
    }
    systemMediaQuery = media;
  } catch {
    systemMediaQuery = null;
  }
};

/**
 * Apply the persisted theme and start following `prefers-color-scheme`.
 * Called by both entry points before the first render so the correct palette
 * is in place before paint.
 */
export const initializeTheme = (): ThemeId => {
  const theme = readStoredTheme();
  const resolvedTheme = resolveTheme(theme, prefersLightTheme());
  applyTheme(resolvedTheme, theme);
  useThemeStore.setState({ theme, resolvedTheme });
  ensureStoreConsistency();
  attachSystemThemeListener();
  return theme;
};
