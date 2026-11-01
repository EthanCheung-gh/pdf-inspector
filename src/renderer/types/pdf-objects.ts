export type PdfObjectType = 'char' | 'word' | 'rect' | 'line' | 'curve' | 'image' | 'table';

export interface PdfBaseObject {
  type: PdfObjectType;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page: number;
}

export interface PdfChar extends PdfBaseObject {
  type: 'char';
  text: string;
  fontname: string;
  size: number;
  color: string;
}

export interface PdfWord extends PdfBaseObject {
  type: 'word';
  text: string;
  fontname: string;
  size: number;
}

export interface PdfRect extends PdfBaseObject {
  type: 'rect';
  fill: boolean;
  stroke: boolean;
  color: string;
  width: number;
}

export interface PdfLine extends PdfBaseObject {
  type: 'line';
  stroke: boolean;
  color: string;
  width: number;
}

export interface PdfCurve extends PdfBaseObject {
  type: 'curve';
  points: number[][];
  stroke: boolean;
}

export interface PdfImage extends PdfBaseObject {
  type: 'image';
  width: number;
  height: number;
  stream_id: string;
  format: string;
}

export interface PdfTable extends PdfBaseObject {
  type: 'table';
  rows: number;
  cols: number;
  cells: string[][];
  /**
   * Cell rectangles aligned to `cells`, in the same bottom-left PDF coordinates
   * as chars/words. `null` marks a covered (merged-away) or missing cell.
   */
  cellBoxes?: (PageBox | null)[][];
  /** Row/column span per cell; `null` when the span could not be determined. */
  cellSpans?: ({ rowSpan: number; colSpan: number } | null)[][];
}

export type PdfObject = PdfChar | PdfWord | PdfRect | PdfLine | PdfCurve | PdfImage | PdfTable;

/** A rectangle in unrotated PDF points (y grows upwards from the bottom). */
export interface PageBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageBoxes {
  media: PageBox;
  crop: PageBox | null;
  trim: PageBox | null;
  bleed: PageBox | null;
  art: PageBox | null;
}

export type PageRotation = 0 | 90 | 180 | 270;

export interface PageData {
  width: number;
  height: number;
  /** Clockwise page rotation; absent in data produced by older sidecars. */
  rotation?: PageRotation;
  /** Raw page boxes; absent in data produced by older sidecars. */
  boxes?: PageBoxes;
  chars: PdfChar[];
  words: PdfWord[];
  rects: PdfRect[];
  lines: PdfLine[];
  curves: PdfCurve[];
  images: PdfImage[];
  tables: PdfTable[];
}

export interface FontInfo {
  fontname: string;
  /** Type1 / TrueType / Type0 / Type3 ... */
  subtype: string | null;
  embedded: boolean;
  embedding: 'embedded' | 'standard14' | 'not-embedded' | 'unknown';
  /** Six-uppercase-letter subset tag, e.g. `ABCDEF+Foo`. */
  subset: boolean;
  encoding: string | null;
  hasToUnicode: boolean;
  fontFileType: 'Type1' | 'TrueType' | 'CFF' | 'OpenType' | null;
}

export interface PdfMetadata {
  pages: number;
  version: string;
  encrypted: boolean;
  page_w: number;
  page_h: number;
  title: string;
  author: string;
  producer: string;
  fonts: string[];
  /** Embedding details per font; absent in data produced by older sidecars. */
  fontInfo?: FontInfo[];
}

export interface PdfOutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}
