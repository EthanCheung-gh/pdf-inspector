import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE } from '../locales';
import { messages, type MessageKey } from '../messages';
import {
  createTranslator,
  interpolate,
  resolvePluralKey,
  selectPluralCategory,
  translate,
  translatePlural,
} from '../translate';

describe('message catalogs', () => {
  it('defaults to English and covers the same keys in both locales', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages['zh-CN']).sort());
  });

  it('looks up English and Chinese messages', () => {
    expect(translate('en', 'language.command.en')).toBe('Language: English');
    expect(translate('zh-CN', 'language.command.zh-CN')).toBe('语言：简体中文');
    expect(translate('zh-CN', 'common.close')).toBe('关闭');
    expect(translate('en', 'common.close')).toBe('Close');
  });

  it('interpolates named parameters, including numbers', () => {
    expect(translate('en', 'common.pageOf', { page: 3, count: 12 })).toBe('Page 3 of 12');
    expect(translate('zh-CN', 'common.pageOf', { page: 3, count: 12 })).toBe(
      '第 3 页，共 12 页',
    );
    expect(translate('en', 'language.current', { language: 'English' })).toBe(
      'Language: English',
    );
  });

  it('keeps unknown placeholders instead of rendering undefined', () => {
    expect(interpolate('Page {page} of {count}', { page: 2 })).toBe('Page 2 of {count}');
    expect(translate('en', 'common.page', {})).toBe('Page {page}');
  });

  it('falls back from the requested locale to English and then to the key', () => {
    const translator = createTranslator({
      en: { 'only.english': 'English only' },
      'zh-CN': {},
    });

    expect(translator('zh-CN', 'only.english' as MessageKey)).toBe('English only');
    expect(translator('zh-CN', 'missing.key' as MessageKey)).toBe('missing.key');
    expect(translator('en', 'missing.key' as MessageKey)).toBe('missing.key');
  });
});

describe('plural translation', () => {
  it('selects Intl plural categories', () => {
    expect(selectPluralCategory('en', 1)).toBe('one');
    expect(selectPluralCategory('en', 2)).toBe('other');
    // Chinese has no grammatical one/other distinction.
    expect(selectPluralCategory('zh-CN', 1)).toBe('other');
  });

  it('resolves one/other keys, falling back to other', () => {
    expect(resolvePluralKey('en', 'common.itemCount', 1)).toBe('common.itemCount.one');
    expect(resolvePluralKey('en', 'common.itemCount', 4)).toBe('common.itemCount.other');
    // A catalog that only defines `.other` still resolves for count 1.
    expect(
      resolvePluralKey('en', 'custom.items', 1, {
        en: { 'custom.items.other': '{count} things' },
        'zh-CN': {},
      }),
    ).toBe('custom.items.other');
  });

  it('translates and injects {count}', () => {
    expect(translatePlural('en', 'common.itemCount', 1)).toBe('1 item');
    expect(translatePlural('en', 'common.itemCount', 3)).toBe('3 items');
    expect(translatePlural('zh-CN', 'common.itemCount', 3)).toBe('3 项');
  });

  it('returns the base key when no plural family exists', () => {
    expect(translatePlural('en', 'missing.plural', 2)).toBe('missing.plural');
  });
});
