import { usePdfStore } from '../../store/pdf-store';
import {
  PAGE_BOX_KEYS,
  useWorkspaceStore,
  type PageBoxKey,
  type PageUnits,
} from '../../store/workspace-store';
import type { PageBox } from '../../types/pdf-objects';
import { PAGE_BOX_STYLES } from '../PdfViewport/PageGeometryOverlay';
import shared from './InspectorPanel.module.css';
import styles from './PageTab.module.css';

/** 1 mm expressed in PDF points (72 pt per inch). */
export const PT_PER_MM = 72 / 25.4;

export const convertPageLength = (pt: number, unit: PageUnits): number =>
  unit === 'pt' ? pt : pt / PT_PER_MM;

/** Round display values to one decimal; integers stay clean. */
export const formatPageLength = (pt: number, unit: PageUnits): string => {
  if (!Number.isFinite(pt)) return '—';
  const value = Math.round(convertPageLength(pt, unit) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

export const formatPageSize = (
  width: number,
  height: number,
  unit: PageUnits,
): string => `${formatPageLength(width, unit)} × ${formatPageLength(height, unit)} ${unit}`;

/** `—` marks a box the PDF does not define; never invent coordinates. */
export const formatPageBox = (box: PageBox | null | undefined, unit: PageUnits): string => {
  if (!box) return '—';
  return `${formatPageLength(box.x0, unit)}, ${formatPageLength(box.y0, unit)} → ${formatPageLength(
    box.x1,
    unit,
  )}, ${formatPageLength(box.y1, unit)}`;
};

const BOX_LABEL = (box: PageBoxKey): string => PAGE_BOX_STYLES[box].label;

export const PageTab = (): JSX.Element => {
  const pageData = usePdfStore((state) => state.pageData);
  const pageUnits = useWorkspaceStore((state) => state.pageUnits);
  const setPageUnits = useWorkspaceStore((state) => state.setPageUnits);
  const pageBoxVisibility = useWorkspaceStore((state) => state.pageBoxVisibility);
  const setPageBoxVisible = useWorkspaceStore((state) => state.setPageBoxVisible);
  const showRulers = useWorkspaceStore((state) => state.showRulers);
  const setShowRulers = useWorkspaceStore((state) => state.setShowRulers);

  const rotation = pageData?.rotation ?? 0;
  // Object overlays are mapped in unrotated PDF space, so they are hidden on a
  // rotated page (see PdfPage). Saying so beats an unexplained empty page.
  const rotated = rotation % 360 !== 0;

  return (
    <div className={styles.pageTab}>
      <section className={shared.section}>
        <h3 className={shared.sectionTitle}>Page</h3>
        <div className={shared.sectionContent}>
          <div className={shared.row}>
            <span className={shared.label}>Size</span>
            <span className={shared.value}>
              {pageData ? formatPageSize(pageData.width, pageData.height, pageUnits) : '—'}
            </span>
          </div>
          <div className={shared.row}>
            <span className={shared.label}>Rotation</span>
            <span className={shared.value}>{pageData ? `${rotation}°` : '—'}</span>
          </div>
          {rotated && (
            <p className={styles.rotationWarning}>
              Object overlay is unavailable on rotated pages. Page boxes and rulers still work.
            </p>
          )}
          <div className={shared.row}>
            <span className={shared.label}>Units</span>
            <div className={styles.unitToggle} role="group" aria-label="Page units">
              {(['pt', 'mm'] as const).map((unit) => (
                <button
                  key={unit}
                  type="button"
                  className={`${styles.unitButton} ${
                    pageUnits === unit ? styles.unitButtonActive : ''
                  }`}
                  aria-pressed={pageUnits === unit}
                  onClick={() => setPageUnits(unit)}
                >
                  {unit}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={shared.section}>
        <h3 className={shared.sectionTitle}>Page boxes</h3>
        <div className={shared.sectionContent}>
          {PAGE_BOX_KEYS.map((box) => {
            // A box the page does not define has nothing to show or hide, so the
            // control is disabled; its persisted visibility is left untouched.
            const boxValue = pageData?.boxes?.[box] ?? null;
            const defined = boxValue !== null;
            return (
              <div className={styles.boxRow} key={box}>
                <label className={styles.boxLabel}>
                  <input
                    type="checkbox"
                    checked={defined && pageBoxVisibility[box]}
                    disabled={!defined}
                    aria-label={`Show ${BOX_LABEL(box)}`}
                    onChange={(event) => {
                      // A disabled control can still emit a synthetic change in
                      // tests; a missing box must never be persisted as visible.
                      if (defined) setPageBoxVisible(box, event.target.checked);
                    }}
                  />
                  <span
                    className={styles.swatch}
                    style={{ background: PAGE_BOX_STYLES[box].color }}
                    aria-hidden="true"
                  />
                  <span>{BOX_LABEL(box)}</span>
                </label>
                <span className={styles.boxValue}>{formatPageBox(boxValue, pageUnits)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className={shared.section}>
        <h3 className={shared.sectionTitle}>Display</h3>
        <div className={shared.sectionContent}>
          <div className={shared.row}>
            <span className={shared.label}>Rulers</span>
            <label className={shared.checkLabel}>
              <input
                type="checkbox"
                checked={showRulers}
                onChange={(event) => setShowRulers(event.target.checked)}
              />
              Show rulers
            </label>
          </div>
        </div>
      </section>
    </div>
  );
};
