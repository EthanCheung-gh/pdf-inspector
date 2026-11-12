import React, { useCallback, useId, useRef, useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
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
 * Row labels live in the catalog rather than in `OVERLAY_LAYERS`: the overlay
 * service describes the canvas, while the panel is UI copy. `nounKey` is the
 * lowercase form used inside the count tooltip.
 */
const LAYER_LABEL_KEYS: Record<PdfObjectType, MessageKey> = {
  char: 'layers.layer.char',
  word: 'layers.layer.word',
  rect: 'layers.layer.rect',
  line: 'layers.layer.line',
  curve: 'layers.layer.curve',
  image: 'layers.layer.image',
  table: 'layers.layer.table',
};

const LAYER_NOUN_KEYS: Record<PdfObjectType, MessageKey> = {
  char: 'layers.layer.char.noun',
  word: 'layers.layer.word.noun',
  rect: 'layers.layer.rect.noun',
  line: 'layers.layer.line.noun',
  curve: 'layers.layer.curve.noun',
  image: 'layers.layer.image.noun',
  table: 'layers.layer.table.noun',
};

/**
 * Visibility, Solo and opacity controls for the seven overlay object types.
 * Counts come from the current `pageData`; the canvas keeps using the same
 * `overlayVisibility` map from `pdf-store`.
 */
export const LayersPanel: React.FC = () => {
  const t = useT();
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
    <section className={styles.panel} aria-label={t('layers.aria')}>
      <div className={styles.header}>
        <span className={styles.title}>{t('layers.title')}</span>
        <div className={styles.bulkActions} role="group" aria-label={t('layers.presetsAria')}>
          <button
            className={styles.bulkButton}
            type="button"
            onClick={handleAll}
            title={t('layers.allTitle')}
          >
            {t('layers.all')}
          </button>
          <button
            className={styles.bulkButton}
            type="button"
            onClick={handleNone}
            title={t('layers.noneTitle')}
          >
            {t('layers.none')}
          </button>
        </div>
      </div>

      <ul className={styles.list} aria-label={t('layers.rowsAria')}>
        {OVERLAY_LAYERS.map((layer) => {
          const visible = Boolean(overlayVisibility[layer.type]);
          const soloActive = soloType === layer.type;
          const count = pageData ? pageData[layer.countKey].length : '—';
          const label = t(LAYER_LABEL_KEYS[layer.type]);

          return (
            <li className={styles.row} key={layer.type}>
              <span
                className={styles.swatch}
                style={{ backgroundColor: OVERLAY_COLORS[layer.type] }}
                aria-hidden="true"
              />
              <span className={styles.label}>{label}</span>
              <span
                className={styles.count}
                title={
                  pageData
                    ? t('layers.countTitle', { count, layer: t(LAYER_NOUN_KEYS[layer.type]) })
                    : t('layers.noPage')
                }
              >
                {count}
              </span>
              <button
                className={`${styles.soloButton} ${soloActive ? styles.soloActive : ''}`}
                type="button"
                aria-label={t('layers.soloAria', { layer: label })}
                aria-pressed={soloActive}
                title={
                  soloActive
                    ? t('layers.soloRestore', { layer: label })
                    : t('layers.soloOnly', { layer: label })
                }
                onClick={() => handleSolo(layer.type)}
              >
                {t('layers.solo')}
              </button>
              <button
                className={`${styles.eyeButton} ${visible ? styles.eyeVisible : ''}`}
                type="button"
                aria-label={t(visible ? 'layers.hide' : 'layers.show', { layer: label })}
                aria-pressed={visible}
                title={t(visible ? 'layers.hide' : 'layers.show', { layer: label })}
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
          {t('layers.opacity')}
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
          aria-label={t('layers.opacityAria')}
          onChange={(event) => setOverlayOpacity(Number(event.target.value))}
        />
      </div>
    </section>
  );
};
