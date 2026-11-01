import type { WorkspacePanelSide } from '../../store/workspace-store';
import styles from './PanelRail.module.css';

export interface PanelRailProps {
  side: WorkspacePanelSide;
  /** Human readable pane name shown on the rail, e.g. `Objects` / `Inspector`. */
  label: string;
  onShow: () => void;
}

/** Accessible name and tooltip of the rail button. */
export const panelRailShowLabel = (side: WorkspacePanelSide): string => `Show ${side} panel`;

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
  const showLabel = panelRailShowLabel(side);

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
