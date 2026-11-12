import { DEFAULT_LOCALE, type Locale } from './locales';
import { messages, type MessageKey, type MessageParams } from './messages';

export type { MessageKey, MessageParams } from './messages';

/**
 * Translation primitives.
 *
 * `translate` is the typed API used by components: keys come from the English
 * catalog union, so a typo is caught at compile time. The implementation is
 * built on `createTranslator`, which accepts partial catalogs; that keeps the
 * fallback chain (requested locale → English → key text) testable without
 * mutating the real catalogs.
 *
 * Missing keys never throw: the key itself is returned, which makes a missed
 * migration visible in the UI instead of crashing it.
 */

/** A partial catalog; `undefined` stands for "key not present". */
export type MessageCatalog = Readonly<Record<string, string | undefined>>;

/** Catalogs by locale, used by `createTranslator` (tests pass partial tables). */
export type MessageCatalogs = Readonly<Partial<Record<Locale, MessageCatalog>>>;

/** A translation function bound to one locale (what `useT()` returns). */
export type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

export type Translate = (locale: Locale, key: MessageKey, params?: MessageParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Replace `{name}` placeholders with the matching param. Unknown placeholders
 * are preserved verbatim so a partially supplied object is debuggable rather
 * than producing `undefined` in the UI.
 */
export const interpolate = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return value === undefined ? match : String(value);
  });
};

/**
 * Build a translator over an arbitrary catalog table. The chain is:
 * requested locale → English → the key itself.
 */
export const createTranslator =
  (catalogs: MessageCatalogs): Translate =>
  (locale, key, params) => {
    const template =
      catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key] ?? (key as string);
    return interpolate(template, params);
  };

const baseTranslate = createTranslator(messages);

/** Translate a message for a locale. */
export const translate: Translate = (locale, key, params) =>
  baseTranslate(locale, key, params);

/** The CLDR plural categories `Intl.PluralRules` can return. */
export type PluralCategory = Intl.LDMLPluralRule;

/**
 * `Intl.PluralRules` can be missing in very old runtimes (or throw for an
 * unsupported locale). The English-style one/other fallback is deterministic
 * and enough for the catalogs we ship.
 */
export const selectPluralCategory = (locale: Locale, count: number): PluralCategory => {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
};

/**
 * Pick the plural key for `baseKey`: the exact CLDR category
 * (`foo.one`, `foo.few`, …) if the catalogs define it, otherwise `foo.other`,
 * otherwise the base key itself. Chinese only has the `other` category, so its
 * catalog deliberately defines `one` as well for parity with English keys.
 */
export const resolvePluralKey = (
  locale: Locale,
  baseKey: string,
  count: number,
  catalogs: MessageCatalogs = messages,
): string => {
  const category = selectPluralCategory(locale, count);
  const candidates = [`${baseKey}.${category}`, `${baseKey}.other`, baseKey];
  const has = (key: string): boolean =>
    catalogs[locale]?.[key] !== undefined || catalogs[DEFAULT_LOCALE]?.[key] !== undefined;
  return candidates.find(has) ?? baseKey;
};

/**
 * Translate a plural message. `{count}` is supplied automatically, so callers
 * write `translatePlural('en', 'common.itemCount', 3)` and the catalog owns
 * the copy: `"{count} items"`.
 *
 * Plural base keys are plain strings rather than the `MessageKey` union
 * because the selected key is one of several suffixes; adding a plural family
 * therefore does not complicate the typed catalog.
 */
export const translatePlural = (
  locale: Locale,
  baseKey: string,
  count: number,
  params?: MessageParams,
  catalogs: MessageCatalogs = messages,
): string => {
  const key = resolvePluralKey(locale, baseKey, count, catalogs);
  const template =
    catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key] ?? key;
  return interpolate(template, { ...params, count });
};
