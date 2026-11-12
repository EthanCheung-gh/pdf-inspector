import { DEFAULT_LOCALE, translate, useT, type TranslateFn } from '../../i18n';
import type { WorkspacePanelSide } from '../../store/workspace-store';
import styles from './PanelRail.module.css';

export interface PanelRailProps {
  side: WorkspacePanelSide;
  /** Human readable pane name shown on the rail, e.g. `Objects` / `Inspector`. */
  label: string;
  onShow: () => void;
}

/** The English label, kept as the pure default for tests and non-React callers. */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

/** Accessible name and tooltip of the rail button. */
export const panelRailShowLabel = (
  side: WorkspacePanelSide,
  t: TranslateFn = defaultTranslate,
): string => t(side === 'left' ? 'toolbar.leftShow' : 'toolbar.rightShow');

/** The arrow points back toward the canvas that the restored pane narrows. */
export const PANEL_RAIL_ARROW: Record<WorkspacePanelSide, string> = {
  left: '›',
  right: '‹',
};

/**
 * Persistent, click-anywhere restore affordance for a collapsed pane. It lives
 * in the workspace flex row at the canvas edge, so opening the pane shrinks the
 * canvas and lets fit-width recompute instead of overlaying the page.
 */
export const PanelRail = ({ side, label, onShow }: PanelRailProps): JSX.Element => {
  const t = useT();
  const showLabel = panelRailShowLabel(side, t);

  return (
    <div className={styles.rail} data-side={side}>
      <button
        className={styles.button}
        type="button"
        onClick={onShow}
        aria-label={showLabel}
        title={showLabel}
      >
        <span className={styles.arrow} aria-hidden="true">
          {PANEL_RAIL_ARROW[side]}
        </span>
        <span className={styles.label}>{label}</span>
      </button>
    </div>
  );
};
