import React from 'react';
import type { RawRef, RawValue } from '../../types/raw-pdf';
import styles from './RawValueView.module.css';

/**
 * Bounds of the value renderer.
 *
 * The sidecar already caps depth (4), container items (100) and strings (4096
 * characters); these limits are the renderer's own guard so a hand-written or
 * future payload can never make a panel render an unbounded tree. Every cap is
 * reported to the reader instead of silently dropping data.
 */
export const RAW_VALUE_MAX_DEPTH = 8;
export const RAW_VALUE_MAX_ENTRIES = 100;

/** `15 0 R`, the PDF spelling of an indirect reference. */
export function formatRawRef(ref: RawRef): string {
  return `${ref.objectNumber} ${ref.generation} R`;
}

/** Stable identity of a reference, used for caches and selection checks. */
export function refKey(ref: RawRef): string {
  return `${ref.objectNumber}:${ref.generation}`;
}

/**
 * Printable text of a scalar value, or null for containers/streams/refs.
 *
 * Values are never interpreted: they are returned as plain strings and always
 * end up as React text nodes, never as HTML.
 */
export function rawScalarText(value: RawValue): string | null {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'number':
      return String(value.value);
    case 'name':
      return `/${value.value}`;
    case 'string':
      return value.truncated ? `${value.value}…` : value.value;
    default:
      return null;
  }
}

/** One-line description of any value, used next to a row label. */
export function rawValueSummary(value: RawValue): string {
  switch (value.kind) {
    case 'dict': {
      const count = value.entries.length;
      return `dict · ${count} ${count === 1 ? 'entry' : 'entries'}${value.truncated ? ' (truncated)' : ''}`;
    }
    case 'array': {
      const count = value.items.length;
      return `array · ${count} ${count === 1 ? 'item' : 'items'}${value.truncated ? ' (truncated)' : ''}`;
    }
    case 'stream': {
      const length = value.length === null ? 'length unknown' : `${value.length} B`;
      const filters = value.filters.length > 0 ? value.filters.join(', ') : 'no filter';
      return `stream · ${length} · ${filters}`;
    }
    case 'ref':
      return formatRawRef(value.ref);
    default:
      return rawScalarText(value) ?? '';
  }
}

/** `Showing 100 of 250 entries.` / the sidecar's own truncation, in one line. */
function truncationNotice(shown: number, total: number, truncated: boolean, noun: string): string | null {
  if (total > shown) return `Showing the first ${shown} of ${total} ${noun}.`;
  if (truncated) return `The ${noun} list was truncated by the sidecar.`;
  return null;
}

const Row: React.FC<{ label?: string; text: string; kind: string }> = ({ label, text, kind }) => (
  <div className={styles.row} data-kind={kind}>
    {label !== undefined && <span className={styles.key}>{label}</span>}
    <span className={styles.text} data-kind={kind} title={text}>
      {text}
    </span>
  </div>
);

const Notice: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <p className={styles.notice} data-testid={testId}>
    {children}
  </p>
);

interface RenderContext {
  depth: number;
  label?: string;
  onSelectRef?: (ref: RawRef) => void;
}

function renderRawValue(value: RawValue, context: RenderContext): React.ReactNode {
  const { depth, label, onSelectRef } = context;
  const nested = { depth: depth + 1, onSelectRef };

  switch (value.kind) {
    case 'dict': {
      const entries = value.entries.slice(0, RAW_VALUE_MAX_ENTRIES);
      const root = depth >= RAW_VALUE_MAX_DEPTH;
      const notice = truncationNotice(entries.length, value.entries.length, value.truncated, 'entries');
      return (
        <>
          <Row label={label} text={rawValueSummary(value)} kind="dict" />
          {root ? (
            <Notice testId="raw-value-depth-notice">
              Nested containers deeper than {RAW_VALUE_MAX_DEPTH} levels are not expanded.
            </Notice>
          ) : (
            <ul className={styles.children}>
              {entries.map((entry, index) => (
                <li key={`${entry.key}:${index}`}>
                  {renderRawValue(entry.value, { ...nested, label: entry.key })}
                </li>
              ))}
            </ul>
          )}
          {notice !== null && <Notice testId="raw-value-truncated">{notice}</Notice>}
        </>
      );
    }

    case 'array': {
      const items = value.items.slice(0, RAW_VALUE_MAX_ENTRIES);
      const root = depth >= RAW_VALUE_MAX_DEPTH;
      const notice = truncationNotice(items.length, value.items.length, value.truncated, 'items');
      return (
        <>
          <Row label={label} text={rawValueSummary(value)} kind="array" />
          {root ? (
            <Notice testId="raw-value-depth-notice">
              Nested containers deeper than {RAW_VALUE_MAX_DEPTH} levels are not expanded.
            </Notice>
          ) : (
            <ul className={styles.children}>
              {items.map((item, index) => (
                <li key={index}>{renderRawValue(item, { ...nested, label: `[${index}]` })}</li>
              ))}
            </ul>
          )}
          {notice !== null && <Notice testId="raw-value-truncated">{notice}</Notice>}
        </>
      );
    }

    case 'stream': {
      const root = depth >= RAW_VALUE_MAX_DEPTH;
      return (
        <>
          <Row label={label} text={rawValueSummary(value)} kind="stream" />
          <dl className={styles.streamMeta} aria-label="Stream metadata">
            <div className={styles.metaItem}>
              <dt>Length</dt>
              <dd>{value.length === null ? '—' : `${value.length} B`}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>Filters</dt>
              <dd>{value.filters.length > 0 ? value.filters.join(', ') : 'none'}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>Preview</dt>
              <dd>{value.preview === null ? 'binary / withheld' : value.truncated ? 'truncated' : 'full'}</dd>
            </div>
          </dl>
          {value.preview === null ? (
            <Notice testId="raw-value-stream-binary">
              Binary stream — only its metadata is shown, never the bytes.
            </Notice>
          ) : (
            <pre className={styles.preview} data-testid="raw-value-stream-preview">
              {value.preview}
            </pre>
          )}
          {value.truncated && value.preview !== null && (
            <Notice testId="raw-value-truncated">
              The decoded preview is truncated; the stream itself is longer.
            </Notice>
          )}
          {root ? (
            <Notice testId="raw-value-depth-notice">
              Nested containers deeper than {RAW_VALUE_MAX_DEPTH} levels are not expanded.
            </Notice>
          ) : (
            <ul className={styles.children}>
              <li>{renderRawValue(value.dict, { ...nested, label: 'Dictionary' })}</li>
            </ul>
          )}
        </>
      );
    }

    case 'ref': {
      const text = formatRawRef(value.ref);
      const target = value.ref;
      return (
        <div className={styles.row} data-kind="ref">
          {label !== undefined && <span className={styles.key}>{label}</span>}
          {onSelectRef ? (
            <button
              className={styles.ref}
              type="button"
              title={`Select object ${text}`}
              onClick={() => onSelectRef(target)}
            >
              {text}
            </button>
          ) : (
            <span className={styles.text} data-kind="ref">
              {text}
            </span>
          )}
        </div>
      );
    }

    default: {
      return <Row label={label} kind={value.kind} text={rawScalarText(value) ?? ''} />;
    }
  }
}

export interface RawValueViewProps {
  value: RawValue;
  /** Called when a reference is clicked; without it refs are plain text. */
  onSelectRef?: (ref: RawRef) => void;
  /** Optional label shown before the value (a dict key, `[0]`, ...). */
  label?: string;
  depth?: number;
}

/**
 * Read-only, recursive renderer for one `RawValue`.
 *
 * Containers become nested lists, every scalar is a React text node (so PDF
 * content can never inject markup), refs are optional buttons and every cap
 * produced by the renderer or by the sidecar is spelled out.
 */
export const RawValueView: React.FC<RawValueViewProps> = ({ value, onSelectRef, label, depth = 0 }) => (
  <div className={styles.view} data-testid="raw-value" data-kind={value.kind}>
    {renderRawValue(value, { depth, label, onSelectRef })}
  </div>
);
