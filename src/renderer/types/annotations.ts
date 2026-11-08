import type { PageBox } from './pdf-objects';

/** Broad display category for a PDF.js annotation subtype. */
export type AnnotationKind =
  | 'link'
  | 'form'
  | 'markup'
  | 'note'
  | 'stamp'
  | 'other';

export interface AnnotationLink {
  /** Sanitized URL safe to activate; only http(s), otherwise null. */
  url: string | null;
  /** Raw PDF.js URL for display only; never passed to the opener. */
  unsafeUrl: string | null;
  /** 1-based page for an internal destination, or null when unresolved. */
  internalPage: number | null;
  /** True for annotations that request a new window. */
  newWindow: boolean;
}

export interface AnnotationOption {
  label: string;
  value: string;
}

export interface AnnotationForm {
  fieldName: string | null;
  /** Tx / Btn / Ch / Sig, or the raw value when unknown. */
  fieldType: string | null;
  value: string | string[] | null;
  defaultValue: string | string[] | null;
  readOnly: boolean;
  required: boolean;
  checkBox: boolean;
  radioButton: boolean;
  pushButton: boolean;
  multiLine: boolean;
  combo: boolean;
  options: AnnotationOption[];
}

export interface PdfAnnotation {
  id: string;
  page: number;
  /** Raw PDF.js subtype: Link, Widget, Highlight, Text, ... */
  subtype: string;
  kind: AnnotationKind;
  /** MediaBox-relative, unrotated PDF points; null when geometry is unusable. */
  rect: PageBox | null;
  title: string | null;
  contents: string | null;
  modificationDate: string | null;
  /** #rrggbb when PDF.js supplies an RGB colour. */
  color: string | null;
  opacity: number | null;
  hidden: boolean;
  link: AnnotationLink | null;
  form: AnnotationForm | null;
}
