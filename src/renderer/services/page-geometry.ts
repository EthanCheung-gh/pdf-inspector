/**
 * Pure geometry helpers shared by the page renderer.
 *
 * These functions must stay free of React/DOM access so they can be unit
 * tested directly and reused by any view that needs page-space math.
 */

/** Horizontal padding (24px each side) around the page inside the scroll container. */
export const DEFAULT_HORIZONTAL_PADDING = 48;

/** Lowest zoom the viewport allows. */
export const MIN_FIT_WIDTH_ZOOM = 0.25;

/** Highest zoom the viewport allows. */
export const MAX_FIT_WIDTH_ZOOM = 5;

/**
 * Smallest width (in px) a page is ever laid out into. A container that is
 * smaller than the padding (or not measured yet) still gets a usable page
 * instead of a zero/negative width, which then clamps to the minimum zoom for
 * wide pages.
 */
const MIN_AVAILABLE_WIDTH = 200;

const clampZoom = (zoom: number): number =>
  Math.min(MAX_FIT_WIDTH_ZOOM, Math.max(MIN_FIT_WIDTH_ZOOM, zoom));

/**
 * Compute the zoom that makes a page exactly as wide as the available space.
 *
 * @param pdfPageWidth Width of the page in PDF points.
 * @param containerWidth Measured width of the scroll container in CSS px.
 * @param horizontalPadding Padding to subtract from the container (default 48).
 *
 * Invalid (zero, negative, NaN, Infinity) page widths and non-finite container
 * widths fall back to the minimum zoom rather than producing NaN/Infinity
 * layouts. The result is always clamped to [MIN_FIT_WIDTH_ZOOM, MAX_FIT_WIDTH_ZOOM].
 */
export function computeFitWidthZoom(
  pdfPageWidth: number,
  containerWidth: number,
  horizontalPadding: number = DEFAULT_HORIZONTAL_PADDING,
): number {
  if (!Number.isFinite(pdfPageWidth) || pdfPageWidth <= 0) return MIN_FIT_WIDTH_ZOOM;
  if (!Number.isFinite(containerWidth)) return MIN_FIT_WIDTH_ZOOM;

  const padding = Number.isFinite(horizontalPadding) && horizontalPadding > 0 ? horizontalPadding : 0;
  const availableWidth = Math.max(containerWidth - padding, MIN_AVAILABLE_WIDTH);
  const zoom = availableWidth / pdfPageWidth;

  if (!Number.isFinite(zoom)) return MIN_FIT_WIDTH_ZOOM;
  return clampZoom(zoom);
}
