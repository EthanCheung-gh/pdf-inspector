import React, { useCallback } from 'react';
import { useI18n } from '../../i18n';
import styles from './Toolbar.module.css';

/**
 * Compact language switch in the toolbar.
 *
 * A button (rather than a select) is enough for two locales: one click toggles
 * and persists, keyboard activation is native, and the control stays narrow
 * (~34px) so the 1280px toolbar layout does not need a new width budget.
 *
 * The visible text is the current language's short form (`EN` / `中文`); the
 * accessible name states the current language and the title describes the
 * action (`Language: English` / `Switch to 简体中文`).
 */
export const LanguagePicker: React.FC = () => {
  const { locale, toggleLocale, t } = useI18n();

  const currentName = t(locale === 'en' ? 'language.en' : 'language.zh-CN');
  const nextName = t(locale === 'en' ? 'language.zh-CN' : 'language.en');
  const label = t('language.current', { language: currentName });
  const title = t('language.switchTo', { language: nextName });
  const shortLabel = t(locale === 'en' ? 'language.short.en' : 'language.short.zh-CN');

  const handleClick = useCallback(() => {
    toggleLocale();
  }, [toggleLocale]);

  return (
    <button
      className={styles.languageButton}
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={title}
    >
      {shortLabel}
    </button>
  );
};
