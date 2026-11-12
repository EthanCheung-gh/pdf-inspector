import type { Locale } from '../locales';
import { en } from './en';
import { zhCN } from './zh-CN';

/**
 * Every user-visible key in the renderer. Derived from the English catalog so
 * `translate('en', 'missing.key')` is a compile error; `zh-CN.ts` is typed
 * against the same union, which makes English/Chinese catalogs impossible to
 * drift apart. L2/L3 only append keys, they never rewrite this type.
 */
export type MessageKey = keyof typeof en;

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * The full catalog table. `satisfies` keeps the literal key union while
 * checking that both locales cover every key with a string value.
 */
export const messages = {
  en,
  'zh-CN': zhCN,
} satisfies Record<Locale, Record<MessageKey, string>>;

export { en, zhCN };
