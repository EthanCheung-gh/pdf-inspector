import { DEFAULT_LOCALE } from '../i18n/locales';
import { translate, type TranslateFn } from '../i18n/translate';
import type { FilterCriteria } from './object-filter';

/**
 * Compact, presentation-ready description of the active property filters.
 * Used by the Inspector Filter tab count and the StatusBar filter summary so
 * both surfaces agree on what counts as one active condition.
 */
export interface FilterSummary {
  /** Number of active conditions; a min/max size pair counts as one. */
  count: number;
  /** Short tokens in Font / Size / Color / Types order. */
  parts: string[];
  /** `parts` joined with ` · `, or an empty string when no filter is active. */
  label: string;
}

/**
 * English translator for plain callers (unit tests, non-React code). Components
 * pass their `useT()` translator so a locale switch re-renders the summary.
 */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

const isFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Drop trailing zeros so 12.0 renders as `12` but 12.5 stays intact. */
const formatSize = (value: number): string => String(Math.round(value * 100) / 100);

const describeSize = (min: number | undefined, max: number | undefined): string => {
  const hasMin = isFiniteNumber(min);
  const hasMax = isFiniteNumber(max);

  if (hasMin && hasMax && min === max) {
    return `${formatSize(min)}pt`;
  }
  if (hasMin && hasMax) return `${formatSize(min)}–${formatSize(max)}pt`;
  if (hasMin) return `≥${formatSize(min)}pt`;
  if (hasMax) return `≤${formatSize(max)}pt`;
  return '';
};

export const describeFilterCriteria = (
  criteria: FilterCriteria,
  t: TranslateFn = defaultTranslate,
): FilterSummary => {
  const parts: string[] = [];
  let count = 0;

  if (criteria.fontname) {
    parts.push(criteria.fontname);
    count += 1;
  }

  if (isFiniteNumber(criteria.sizeMin) || isFiniteNumber(criteria.sizeMax)) {
    parts.push(describeSize(criteria.sizeMin, criteria.sizeMax));
    count += 1;
  }

  if (criteria.color) {
    parts.push(criteria.color);
    count += 1;
  }

  const typeCount = criteria.types?.length ?? 0;
  if (typeCount > 0) {
    parts.push(
      t(typeCount === 1 ? 'filter.summary.types.one' : 'filter.summary.types.other', {
        count: typeCount,
      }),
    );
    count += 1;
  }

  return { count, parts, label: parts.join(' · ') };
};
