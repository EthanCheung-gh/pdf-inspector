/**
 * Locale registry and DOM/storage plumbing for the renderer UI.
 *
 * This module is intentionally free of React and Zustand: the store, the
 * message catalogs and the toolbar control all build on it, and it stays easy
 * to test in a plain Node environment.
 *
 * Product decision: English is always the default. The browser language is not
 * consulted automatically, so screenshots, tests and first runs stay stable;
 * the user opts into 简体中文 explicitly.
 */

export type Locale = 'en' | 'zh-CN';

/** Stable order for pickers and future language menus. */
export const LOCALES: readonly Locale[] = ['en', 'zh-CN'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Persisted separately from theme/workspace preferences. */
export const LOCALE_STORAGE_KEY = 'pdf-inspector:locale:v1';

/** The value written to `<html lang>` for each locale. */
const HTML_LANG: Readonly<Record<Locale, string>> = {
  en: 'en',
  'zh-CN': 'zh-CN',
};

export const isLocale = (value: unknown): value is Locale =>
  value === 'en' || value === 'zh-CN';

export const localeHtmlLang = (locale: Locale): string => HTML_LANG[locale];

/** The locale a toggle switches to. */
export const otherLocale = (locale: Locale): Locale => (locale === 'en' ? 'zh-CN' : 'en');

/**
 * Access to localStorage can be missing or throw (opaque origins, disabled
 * storage, jsdom). Every access goes through this helper so the preference
 * degrades to "not persisted" instead of breaking the app.
 */
const getStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Read the persisted locale; unknown values and storage failures fall back to `en`. */
export const readStoredLocale = (): Locale => {
  try {
    const stored = getStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
};

/** Persist a locale. Storage is an enhancement, so a failed write is ignored. */
export const persistLocale = (locale: Locale): void => {
  try {
    getStorage()?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory locale still applies for this session.
  }
};

/**
 * Mirror the locale to the document root:
 *
 * - `lang="en|zh-CN"` is what assistive tech and CSS `:lang()` read;
 * - `data-locale` lets future component CSS key off the active locale.
 *
 * A no-op outside the DOM (Node tests) and never throws.
 */
export const applyLocale = (locale: Locale): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = localeHtmlLang(locale);
  document.documentElement.dataset.locale = locale;
};
