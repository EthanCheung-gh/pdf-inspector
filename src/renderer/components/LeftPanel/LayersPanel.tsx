import React, { useCallback, useId, useRef, useState } from 'react';
import {
  OVERLAY_COLORS,
  OVERLAY_LAYERS,
  buildOverlayVisibility,
} from '../../services/overlay-style';
import { usePdfStore } from '../../store/pdf-store';
import { OVERLAY_OPACITY_LIMITS, useWorkspaceStore } from '../../store/workspace-store';
import type { PdfObjectType } from '../../types/pdf-objects';
import styles from './LayersPanel.module.css';

/**
 * Visibility, Solo and opacity controls for the seven overlay object types.
 * Counts come from the current `pageData`; the canvas keeps using the same
 * `overlayVisibility` map from `pdf-store`.
 */
export const LayersPanel: React.FC = () => {
  const pageData = usePdfStore((state) => state.pageData);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);
  const setOverlayVisibility = usePdfStore((state) => state.setOverlayVisibility);
  const overlayOpacity = useWorkspaceStore((state) => state.overlayOpacity);
  const setOverlayOpacity = useWorkspaceStore((state) => state.setOverlayOpacity);

  const [soloType, setSoloType] = useState<PdfObjectType | null>(null);
  // Visibility snapshot taken right before entering Solo, restored on the next
  // click on the same row. Switching Solo to another row keeps the original
  // snapshot so toggling it off still restores the pre-Solo state.
  const soloSnapshotRef = useRef<Record<string, boolean> | null>(null);
  const opacityId = useId();

  const clearSolo = useCallback(() => {
    soloSnapshotRef.current = null;
    setSoloType(null);
  }, []);

  const handleToggle = useCallback(
    (type: PdfObjectType) => {
      clearSolo();
      toggleOverlay(type);
    },
    [clearSolo, toggleOverlay],
  );

  const handleAll = useCallback(() => {
    clearSolo();
    setOverlayVisibility(buildOverlayVisibility(true));
  }, [clearSolo, setOverlayVisibility]);

  const handleNone = useCallback(() => {
    clearSolo();
    setOverlayVisibility(buildOverlayVisibility(false));
  }, [clearSolo, setOverlayVisibility]);

  const handleSolo = useCallback(
    (type: PdfObjectType) => {
      if (soloType === type) {
        if (soloSnapshotRef.current) {
          setOverlayVisibility(soloSnapshotRef.current);
        }
        clearSolo();
        return;
      }

      if (soloType === null) {
        soloSnapshotRef.current = { ...overlayVisibility };
      }
      const soloVisibility = buildOverlayVisibility(false);
      soloVisibility[type] = true;
      setOverlayVisibility(soloVisibility);
      setSoloType(type);
    },
    [clearSolo, overlayVisibility, setOverlayVisibility, soloType],
  );

  return (
    <section className={styles.panel} aria-label="Layers">
      <div className={styles.header}>
        <span className={styles.title}>Object layers</span>
        <div className={styles.bulkActions} role="group" aria-label="Layer visibility presets">
          <button
            className={styles.bulkButton}
            type="button"
            onClick={handleAll}
            title="Show all object layers"
          >
            All
          </button>
          <button
            className={styles.bulkButton}
            type="button"
            onClick={handleNone}
            title="Hide all object layers"
          >
            None
          </button>
        </div>
      </div>

      <ul className={styles.list} aria-label="Object layer rows">
        {OVERLAY_LAYERS.map((layer) => {
          const visible = Boolean(overlayVisibility[layer.type]);
          const soloActive = soloType === layer.type;
          const count = pageData ? pageData[layer.countKey].length : '—';

          return (
            <li className={styles.row} key={layer.type}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: OVERLAY_COLORS[layer.type] }}
                aria-hidden="true"
              />
              <span className={styles.label}>{layer.label}</span>
              <span
                className={styles.count}
                title={pageData ? `${count} ${layer.label.toLowerCase()} on this page` : 'Page not loaded'}
              >
                {count}
              </span>
              <button
                className={`${styles.soloButton} ${soloActive ? styles.soloActive : ''}`}
                type="button"
                aria-label={`Solo ${layer.label}`}
                aria-pressed={soloActive}
                title={soloActive ? `Restore visibility before isolating ${layer.label}` : `Show only ${layer.label}`}
                onClick={() => handleSolo(layer.type)}
              >
                Solo
              </button>
              <button
                className={`${styles.eyeButton} ${visible ? styles.eyeVisible : ''}`}
                type="button"
                aria-label={`${visible ? 'Hide' : 'Show'} ${layer.label}`}
                aria-pressed={visible}
                title={`${visible ? 'Hide' : 'Show'} ${layer.label}`}
                onClick={() => handleToggle(layer.type)}
              >
                {visible ? '●' : '○'}
              </button>
            </li>
          );
        })}
      </ul>

      <div className={styles.opacityRow}>
        <label className={styles.opacityLabel} htmlFor={opacityId}>
          Opacity
        </label>
        <span className={styles.opacityValue}>{Math.round(overlayOpacity * 100)}%</span>
        <input
          id={opacityId}
          className={styles.slider}
          type="range"
          min={OVERLAY_OPACITY_LIMITS.min}
          max={OVERLAY_OPACITY_LIMITS.max}
          step={0.05}
          value={overlayOpacity}
          aria-label="Object overlay opacity"
          onChange={(event) => setOverlayOpacity(Number(event.target.value))}
        />
      </div>
    </section>
  );
};
