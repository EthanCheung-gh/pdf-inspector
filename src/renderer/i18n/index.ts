/**
 * Public i18n surface for the renderer.
 *
 * L2/L3 import from here (`@renderer/i18n` or `../../i18n`) and only add
 * catalog keys; they never need to touch the locale/store plumbing.
 */
export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  applyLocale,
  isLocale,
  localeHtmlLang,
  otherLocale,
  persistLocale,
  readStoredLocale,
  type Locale,
} from './locales';

export {
  en,
  messages,
  zhCN,
  type MessageKey,
  type MessageParams,
} from './messages';

export {
  createTranslator,
  interpolate,
  resolvePluralKey,
  selectPluralCategory,
  translate,
  translatePlural,
  type MessageCatalog,
  type MessageCatalogs,
  type PluralCategory,
  type Translate,
  type TranslateFn,
} from './translate';

export {
  initializeLocale,
  useI18n,
  useI18nStore,
  useT,
  type I18n,
  type I18nState,
} from './store';
