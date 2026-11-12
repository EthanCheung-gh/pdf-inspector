import React, { useCallback } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { useThemeStore } from '../../store/theme-store';
import {
  THEMES,
  getThemeDefinition,
  isThemeId,
  type ThemeId,
} from '../../theme/themes';
import styles from './Toolbar.module.css';

/**
 * Theme ids are stable data (`dark`, `islands`, …); their user-visible labels
 * live in the message catalog so the picker and the palette follow the active
 * locale without touching the theme registry.
 */
const THEME_LABEL_KEYS = {
  dark: 'theme.dark',
  islands: 'theme.islands',
  light: 'theme.light',
  system: 'theme.system',
} as const satisfies Record<ThemeId, MessageKey>;

const THEME_DESCRIPTION_KEYS = {
  dark: 'theme.description.dark',
  islands: 'theme.description.islands',
  light: 'theme.description.light',
  system: 'theme.description.system',
} as const satisfies Record<ThemeId, MessageKey>;

export const themeLabelKey = (id: ThemeId): MessageKey => THEME_LABEL_KEYS[id];

export const themeDescriptionKey = (id: ThemeId): MessageKey => THEME_DESCRIPTION_KEYS[id];

/**
 * Toolbar theme picker.
 *
 * A native `<select>` is intentional: it is keyboard accessible by default,
 * keeps one focus target (unlike a menu that has to manage focus manually),
 * and renders the current theme without extra markup. The control keeps the
 * old toggle's 88px footprint (no separate "Theme:" label) so the toolbar
 * still fits at 1280px; `aria-label` supplies the accessible name and the
 * tooltip names the current theme.
 */
export const ThemePicker: React.FC = () => {
  const theme = useThemeStore((state) => state.theme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const t = useT();

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      if (isThemeId(next)) setTheme(next);
    },
    [setTheme],
  );

  const resolvedLabel = t(themeLabelKey(resolvedTheme));
  // System is the only mode whose visible label cannot state the palette it
  // currently resolves to, so the tooltip spells it out: "System (Dark)".
  const title =
    theme === 'system'
      ? t('theme.currentResolved', {
          theme: t(themeLabelKey(theme)),
          resolved: resolvedLabel,
        })
      : t('theme.current', { theme: t(themeLabelKey(theme)) });

  return (
    <label className={styles.themePicker}>
      <select
        className={styles.themeSelect}
        aria-label={t('theme.label')}
        value={theme}
        onChange={handleChange}
        title={title}
      >
        {THEMES.map((definition) => (
          <option
            key={definition.id}
            value={definition.id}
            title={t(themeDescriptionKey(definition.id))}
          >
            {t(themeLabelKey(definition.id))}
          </option>
        ))}
      </select>
    </label>
  );
};
