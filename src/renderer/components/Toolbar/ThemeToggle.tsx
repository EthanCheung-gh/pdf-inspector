import React, { useCallback } from 'react';
import { useThemeStore, type Theme } from '../../store/theme-store';
import styles from './Toolbar.module.css';

const LABELS: Record<Theme, string> = {
  dark: 'Theme: Dark',
  islands: 'Theme: Islands',
};

/**
 * Compact toolbar toggle for the UI theme. The visible label is the current
 * theme ("Theme: Dark" / "Theme: Islands") so the control is self-describing;
 * `aria-pressed` exposes whether Islands is active and the title names the
 * theme a click will switch to.
 */
export const ThemeToggle: React.FC = () => {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);

  const handleClick = useCallback(() => {
    toggleTheme();
  }, [toggleTheme]);

  const nextTheme: Theme = theme === 'dark' ? 'islands' : 'dark';
  const label = LABELS[theme];

  return (
    <button
      className={`${styles.button} ${styles.themeToggle} ${theme === 'islands' ? styles.themeToggleActive : ''}`}
      type="button"
      onClick={handleClick}
      aria-pressed={theme === 'islands'}
      title={`Switch to ${nextTheme === 'dark' ? 'Dark' : 'Islands'} theme`}
    >
      {label}
    </button>
  );
};
