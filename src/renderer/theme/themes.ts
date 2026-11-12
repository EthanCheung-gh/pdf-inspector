/**
 * Theme registry.
 *
 * A theme id is a user preference. Most ids map straight to the structural
 * palette in `theme.css`, but `system` is a *mode*: it resolves to `dark` or
 * `light` from `prefers-color-scheme` and the resolved id is what gets written
 * to the DOM. Keeping the registry here (instead of branching inside the store
 * or the toolbar) means adding a theme is a data change, not a UI change.
 */

export type ThemeId = 'dark' | 'islands' | 'light' | 'system';

/** The theme ids that own a concrete token block in `theme.css`. */
export type ResolvedTheme = 'dark' | 'islands' | 'light';

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description?: string;
  /**
   * The browser colour scheme the theme expects. `system` cannot be known
   * ahead of time; it declares the fallback used when `matchMedia` is missing
   * (which is also the default resolution in tests and embeds).
   */
  colorScheme: 'dark' | 'light';
}

/** Registry order is both the picker order and the `toggleTheme` cycle. */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'Compact dark panels',
    colorScheme: 'dark',
  },
  {
    id: 'islands',
    label: 'Islands',
    description: 'Floating cards on a near-black canvas',
    colorScheme: 'dark',
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Light panels for bright rooms',
    colorScheme: 'light',
  },
  {
    id: 'system',
    label: 'System',
    description: 'Follow the operating system appearance',
    colorScheme: 'dark',
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'dark';

/** Stable cycle order for `toggleTheme` (dark → islands → light → system). */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export const isThemeId = (value: unknown): value is ThemeId =>
  value === 'dark' || value === 'islands' || value === 'light' || value === 'system';

export const isResolvedTheme = (value: unknown): value is ResolvedTheme =>
  value === 'dark' || value === 'islands' || value === 'light';

/** Resolve a selected id to the concrete palette applied to the document. */
export const resolveTheme = (id: ThemeId, prefersLight: boolean): ResolvedTheme => {
  switch (id) {
    case 'dark':
      return 'dark';
    case 'islands':
      // Islands is always a dark-canvas design, even under a light OS.
      return 'islands';
    case 'light':
      return 'light';
    case 'system':
      return prefersLight ? 'light' : 'dark';
  }
};

/** Look up a definition; unknown ids are treated as the default theme. */
export const getThemeDefinition = (id: ThemeId): ThemeDefinition =>
  THEMES.find((theme) => theme.id === id) ??
  (THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) as ThemeDefinition);
