import { useMemo } from 'react';
import { create } from 'zustand';
import {
  applyLocale,
  isLocale,
  otherLocale,
  persistLocale,
  readStoredLocale,
  type Locale,
} from './locales';
import {
  translate,
  type MessageKey,
  type MessageParams,
  type TranslateFn,
} from './translate';

/**
 * UI language selection.
 *
 * Mirrors the theme store pattern:
 * - the store initialises from storage, so a component rendered without the
 *   entry point (tests, embeds) already shows the saved language;
 * - `setLocale` persists and applies the locale immediately;
 * - a module-level subscription re-applies `<html lang>`/`data-locale` when
 *   `locale` is written directly through `setState` (tests, future callers).
 *
 * No OS/browser language listener exists by design: the default is English
 * until the user chooses otherwise.
 */

export interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const initialLocale = readStoredLocale();

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: initialLocale,

  setLocale: (locale) => {
    if (!isLocale(locale)) return;
    persistLocale(locale);
    applyLocale(locale);
    set({ locale });
  },

  toggleLocale: () => {
    get().setLocale(otherLocale(get().locale));
  },
}));

/**
 * Safety net for direct `setState({ locale })` writes: keep the document
 * attributes in sync without persisting (a direct write is not a user choice).
 * `setLocale` already does the same work.
 */
let unsubscribeConsistency: (() => void) | null = null;

const ensureStoreConsistency = (): void => {
  if (unsubscribeConsistency) return;
  unsubscribeConsistency = useI18nStore.subscribe((state, previous) => {
    if (state.locale === previous.locale) return;
    applyLocale(state.locale);
  });
};

ensureStoreConsistency();

/**
 * Apply the persisted locale before the first render and wire the DOM sync.
 * Called by both entry points (desktop and web). Repeated calls are harmless:
 * there is no listener to duplicate, and applying the same locale is a no-op.
 */
export const initializeLocale = (): Locale => {
  const locale = readStoredLocale();
  applyLocale(locale);
  useI18nStore.setState({ locale });
  ensureStoreConsistency();
  return locale;
};

/** Translation function bound to the current locale; re-created on change. */
export const useT = (): TranslateFn => {
  const locale = useI18nStore((state) => state.locale);
  return useMemo<TranslateFn>(
    () => (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale],
  );
};

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: TranslateFn;
}

/** Locale value plus actions and translator, for controls that need all three. */
export const useI18n = (): I18n => {
  const locale = useI18nStore((state) => state.locale);
  const setLocale = useI18nStore((state) => state.setLocale);
  const toggleLocale = useI18nStore((state) => state.toggleLocale);
  const t = useT();

  return useMemo<I18n>(
    () => ({ locale, setLocale, toggleLocale, t }),
    [locale, setLocale, t, toggleLocale],
  );
};
