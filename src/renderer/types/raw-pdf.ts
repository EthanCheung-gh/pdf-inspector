/**
 * Shared contract for the Raw workspace (raw PDF object tree and content
 * streams).
 *
 * The shapes here are the wire format produced by the Python sidecar
 * (`raw_document`, `raw_object`, `raw_page_content`) and consumed by the
 * renderer. They are deliberately bounded and JSON-only:
 * - references are never resolved implicitly; a `ref` value is a node the user
 *   expands or clicks, so no recursive walk can hide in a payload;
 * - every container carries `truncated` instead of silently dropping data;
 * - stream bodies are never included: only length/filters and a capped textual
 *   `preview` (a binary stream has `preview: null`).
 *
 * Nothing in this file is executable: the renderer only ever displays these
 * values as text.
 */

/** One indirect object reference, printed as `objectNumber generation R`. */
export interface RawRef {
  objectNumber: number;
  generation: number;
}

export type RawValue =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string; truncated: boolean }
  | { kind: 'name'; value: string }
  | { kind: 'ref'; ref: RawRef }
  | { kind: 'array'; items: RawValue[]; truncated: boolean }
  | { kind: 'dict'; entries: RawEntry[]; truncated: boolean }
  | {
      kind: 'stream';
      dict: RawValue;
      length: number | null;
      filters: string[];
      preview: string | null;
      truncated: boolean;
    };

export interface RawEntry {
  key: string;
  value: RawValue;
}

export interface RawObject {
  ref: RawRef;
  value: RawValue;
  /** One-line human summary produced by the sidecar (never trusted as HTML). */
  summary: string;
}

/** One trailer root (Catalog, Info, Encrypt, ID, ...). */
export interface RawRoot {
  label: string;
  ref: RawRef | null;
  value: RawValue | null;
}

export interface RawDocument {
  pages: number;
  version: string | null;
  encrypted: boolean;
  roots: RawRoot[];
}

/** One operator of a decoded content stream, with its operands. */
export interface RawContentOperator {
  index: number;
  offset: number;
  operator: string;
  operands: RawValue[];
}

export interface RawContentStream {
  ref: RawRef | null;
  length: number | null;
  filters: string[];
  operators: RawContentOperator[];
  truncated: boolean;
  /** Per-stream parse error; the stream may still carry partial operators. */
  error: string | null;
}

export interface RawPageContent {
  page: number;
  streams: RawContentStream[];
  truncated: boolean;
}
