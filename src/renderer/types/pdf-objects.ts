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
}

export type PdfObject = PdfChar | PdfWord | PdfRect | PdfLine | PdfCurve | PdfImage | PdfTable;

export interface PageData {
  width: number;
  height: number;
  chars: PdfChar[];
  words: PdfWord[];
  rects: PdfRect[];
  lines: PdfLine[];
  curves: PdfCurve[];
  images: PdfImage[];
  tables: PdfTable[];
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
}

export interface PdfOutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}
