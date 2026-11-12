import React from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { useT } from '../../i18n';
import { useWorkspaceStore, type PageUnits } from '../../store/workspace-store';
import styles from './PageRuler.module.css';

/**
 * Top/left rulers in PDF points or millimetres.
 *
 * Tick positions are measured along the *displayed* page edge (viewport
 * pixels), so a rotated page needs no special case: the viewport has already
 * rotated the page and its scale is the only conversion factor required.
 */

export type RulerUnit = PageUnits;

/** Which edge of the page a ruler is drawn along. */
export type RulerEdge = 'top' | 'left';

/**
 * Room a label needs beyond its tick before the ruler's `overflow: hidden`
 * clips it: top labels start 2px right of the tick, left labels sit 8px below
 * it and are a few characters wide. A tick closer than this to the end of the
 * edge keeps its mark but loses its label (a clipped "600" reads as "60").
 */
export const RULER_LABEL_INSET: Record<RulerEdge, number> = { top: 18, left: 10 };

/** True when a label anchored at `position` still fits inside `length`. */
export const labelFitsAt = (position: number, length: number, edge: RulerEdge): boolean => {
  if (!Number.isFinite(position) || !Number.isFinite(length)) return false;
  return position <= length - RULER_LABEL_INSET[edge];
};

export interface RulerTick {
  /** Offset from the displayed page's top-left corner, in CSS pixels. */
  position: number;
  /** Tick value in the selected display unit. */
  value: number;
  /** Present only for labelled (major) ticks that fit the ruler. */
  label: string | null;
  major: boolean;
}

export interface RulerTicksOptions {
  /** Length of the edge being ruled, in CSS pixels. */
  length: number;
  /** Viewport pixels per PDF point (`viewport.scale * userUnit`). */
  pxPerPt: number;
  unit: RulerUnit;
  /** Minimum gap between labelled ticks; keeps labels from colliding. */
  minMajorSpacing?: number;
  /** Edge being ruled; decides how much room a trailing label needs. */
  edge?: RulerEdge;
}

/** 1 mm expressed in PDF points (72 pt per inch). */
export const PT_PER_MM = 72 / 25.4;

/** Candidate major steps in the display unit, smallest first. */
export const RULER_STEPS: Record<RulerUnit, readonly number[]> = {
  pt: [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000],
  mm: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
};

/** Minor subdivisions per major step, chosen so every minor value is round. */
const SUBDIVISIONS: Record<number, number> = {
  1: 5,
  2: 4,
  5: 5,
  10: 5,
  20: 4,
  25: 5,
  50: 5,
  100: 5,
  200: 4,
  250: 5,
  500: 5,
  1000: 5,
  2000: 4,
};

const DEFAULT_MIN_MAJOR_SPACING = 44;

export const formatRulerLabel = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const pxPerUnit = (pxPerPt: number, unit: RulerUnit): number =>
  pxPerPt * (unit === 'pt' ? 1 : PT_PER_MM);

/** Pick the smallest step whose labelled ticks are at least `minMajorSpacing` apart. */
export const selectRulerStep = (
  pxPerPt: number,
  unit: RulerUnit,
  minMajorSpacing: number = DEFAULT_MIN_MAJOR_SPACING,
): number => {
  const scale = pxPerUnit(pxPerPt, unit);
  const steps = RULER_STEPS[unit];
  if (!Number.isFinite(scale) || scale <= 0) return steps[0];

  for (const step of steps) {
    if (step * scale >= minMajorSpacing) return step;
  }
  return steps[steps.length - 1];
};

/**
 * Build major/minor ticks for one edge. Invalid lengths/scales yield no ticks
 * instead of NaN positions, which keeps the ruler safe during the first render
 * before the PDF.js viewport exists.
 */
export const computeRulerTicks = ({
  length,
  pxPerPt,
  unit,
  minMajorSpacing = DEFAULT_MIN_MAJOR_SPACING,
  edge = 'top',
}: RulerTicksOptions): RulerTick[] => {
  if (!Number.isFinite(length) || length <= 0) return [];
  if (!Number.isFinite(pxPerPt) || pxPerPt <= 0) return [];

  const step = selectRulerStep(pxPerPt, unit, minMajorSpacing);
  const scale = pxPerUnit(pxPerPt, unit);
  const subdivisions = SUBDIVISIONS[step] ?? 5;
  const minorStep = step / subdivisions;
  const minorSpacing = minorStep * scale;
  if (!Number.isFinite(minorSpacing) || minorSpacing <= 0) return [];

  const lastIndex = Math.floor(length / minorSpacing + 1e-6);
  const ticks: RulerTick[] = [];

  for (let index = 0; index <= lastIndex; index += 1) {
    const value = index * minorStep;
    const position = value * scale;
    if (position > length + 0.5) break;

    const major = index % subdivisions === 0;
    ticks.push({
      position,
      value,
      // The tick stays; only a label that would be clipped is dropped.
      label: major && labelFitsAt(position, length, edge) ? formatRulerLabel(value) : null,
      major,
    });
  }

  return ticks;
};

interface PageRulerProps {
  /** Width of the page container in CSS pixels. */
  width: number;
  /** Height of the page container in CSS pixels. */
  height: number;
  viewport: PageViewport | null;
}

export const PageRuler: React.FC<PageRulerProps> = ({ width, height, viewport }) => {
  const t = useT();
  const unit = useWorkspaceStore((state) => state.pageUnits);
  if (!viewport) return null;

  const pxPerPt = viewport.scale * (viewport.userUnit || 1);
  const horizontal = computeRulerTicks({ length: width, pxPerPt, unit, edge: 'top' });
  const vertical = computeRulerTicks({ length: height, pxPerPt, unit, edge: 'left' });

  return (
    <div
      className={styles.rulers}
      role="img"
      aria-label={t('ruler.aria', { unit })}
      data-testid="page-ruler"
    >
      {/* pt/mm are unit symbols; the tick numbers need no translation. */}
      <div className={styles.corner}>{unit}</div>
      <div className={styles.topRuler} style={{ width }}>
        {horizontal.map((tick, index) => (
          <span
            key={`x-${index}`}
            className={`${styles.tick} ${styles.topTick} ${tick.major ? styles.major : styles.minor}`}
            style={{ left: tick.position }}
          >
            {tick.label !== null && <span className={styles.topLabel}>{tick.label}</span>}
          </span>
        ))}
      </div>
      <div className={styles.leftRuler} style={{ height }}>
        {vertical.map((tick, index) => (
          <span
            key={`y-${index}`}
            className={`${styles.tick} ${styles.leftTick} ${tick.major ? styles.major : styles.minor}`}
            style={{ top: tick.position }}
          >
            {tick.label !== null && <span className={styles.leftLabel}>{tick.label}</span>}
          </span>
        ))}
      </div>
    </div>
  );
};
