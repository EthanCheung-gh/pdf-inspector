import type { PageData, PdfObjectType } from '../types/pdf-objects';

/**
 * Shared styling for the canvas overlay and the Layers panel.
 *
 * The color table used to live in `useOverlay`, which meant the Layers swatches
 * would need a second copy. Keeping both the colors and the display order here
 * guarantees that a row in the panel always matches what the canvas draws.
 */
export const OVERLAY_COLORS: Record<PdfObjectType, string> = {
  char: 'rgba(80, 200, 80, 0.5)',
  word: 'rgba(80, 120, 255, 0.5)',
  rect: 'rgba(200, 100, 200, 0.5)',
  line: 'rgba(255, 80, 80, 0.6)',
  curve: 'rgba(255, 160, 50, 0.6)',
  image: 'rgba(80, 220, 220, 0.5)',
  table: 'rgba(80, 160, 255, 0.5)',
};

export type OverlayCountKey =
  | 'chars'
  | 'words'
  | 'rects'
  | 'lines'
  | 'curves'
  | 'images'
  | 'tables';

export interface OverlayLayerDescriptor {
  type: PdfObjectType;
  label: string;
  /** `PageData` array that supplies this layer's item count. */
  countKey: OverlayCountKey;
}

/**
 * Display order used by the Layers panel. It mirrors the order in which
 * `PageData` stores the arrays (and therefore the order objects are stitched
 * into `allObjects`).
 */
export const OVERLAY_LAYERS: readonly OverlayLayerDescriptor[] = [
  { type: 'char', label: 'Chars', countKey: 'chars' },
  { type: 'word', label: 'Words', countKey: 'words' },
  { type: 'rect', label: 'Rects', countKey: 'rects' },
  { type: 'line', label: 'Lines', countKey: 'lines' },
  { type: 'curve', label: 'Curves', countKey: 'curves' },
  { type: 'image', label: 'Images', countKey: 'images' },
  { type: 'table', label: 'Tables', countKey: 'tables' },
];

export const OVERLAY_LAYER_TOTAL = OVERLAY_LAYERS.length;

export type OverlayPageData = Pick<PageData, OverlayCountKey>;

export const overlayVisibleCount = (visibility: Record<string, boolean>): number =>
  OVERLAY_LAYERS.reduce((count, layer) => (visibility[layer.type] ? count + 1 : count), 0);

/** Build a complete visibility map for the All/None actions. */
export const buildOverlayVisibility = (visible: boolean): Record<string, boolean> =>
  Object.fromEntries(OVERLAY_LAYERS.map((layer) => [layer.type, visible]));
