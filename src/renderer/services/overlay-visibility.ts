import type { PdfObject, PdfObjectType } from '../types/pdf-objects';
import type { ObjectSubset } from './object-filter';

/**
 * Combine the toolbar overlay toggles with the Inspector type filter.
 *
 * A non-empty `types` list narrows the overlay to those types, but only where
 * the toolbar still allows them (logical AND): turning `word` off in the
 * toolbar keeps words hidden even when the Inspector selects `word`.
 * An empty or missing `types` list returns a copy of `base` unchanged.
 */
export function effectiveOverlayVisibility(
  base: Record<string, boolean>,
  types?: PdfObjectType[],
): Record<string, boolean> {
  if (!types || types.length === 0) return { ...base };

  const selected = new Set<PdfObjectType>(types);
  const effective: Record<string, boolean> = {};
  for (const [type, visible] of Object.entries(base)) {
    effective[type] = visible && selected.has(type as PdfObjectType);
  }
  return effective;
}

/**
 * Pick the objects the overlay should draw.
 *
 * A property/font filter subset (`source === 'filter'`) is exactly what the
 * user asked to see, so only those objects are drawn. Region subsets keep the
 * full page context: the region rectangle and the orange outline communicate
 * the selection instead of hiding the rest of the page.
 */
export function overlayObjects(
  allObjects: PdfObject[],
  subset: ObjectSubset | null,
): PdfObject[] {
  if (subset?.source === 'filter') return subset.objects;
  return allObjects;
}
