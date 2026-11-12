import React from 'react';
import { useT } from '../../i18n';
import { DEFAULT_LOCALE } from '../../i18n/locales';
import { translate, type MessageKey, type TranslateFn } from '../../i18n/translate';
import type { RawRef, RawValue } from '../../types/raw-pdf';
import styles from './RawValueView.module.css';

/**
 * English translator for the exported pure helpers (used by the status bar and
 * plain unit tests). Components pass their `useT()` translator, so a locale
 * switch re-renders the labels without leaving hard-coded English behind.
 */
const defaultTranslate: TranslateFn = (key, params) => translate(DEFAULT_LOCALE, key, params);

/**
 * Pick the one/other form of a count.
 *
 * The catalogs define both suffixes for every count key, and the two shipped
 * locales only need `one`/`other`, so a direct comparison is exact here. React
 * components use `translatePlural` (CLDR) instead; this helper exists because a
 * `TranslateFn` carries the locale but not its plural rules.
 */
const countKey = (count: number, one: MessageKey, other: MessageKey): MessageKey =>
  count === 1 ? one : other;

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
export function rawValueSummary(value: RawValue, t: TranslateFn = defaultTranslate): string {
  switch (value.kind) {
    case 'dict': {
      const count = value.entries.length;
      const entries = t(countKey(count, 'raw.count.entry.one', 'raw.count.entry.other'), { count });
      const summary = `${t('raw.value.dict')} · ${entries}`;
      return value.truncated ? t('raw.value.truncatedSuffix', { summary }) : summary;
    }
    case 'array': {
      const count = value.items.length;
      const items = t(countKey(count, 'raw.count.item.one', 'raw.count.item.other'), { count });
      const summary = `${t('raw.value.array')} · ${items}`;
      return value.truncated ? t('raw.value.truncatedSuffix', { summary }) : summary;
    }
    case 'stream': {
      const length = value.length === null ? t('raw.lengthUnknown') : `${value.length} B`;
      const filters = value.filters.length > 0 ? value.filters.join(', ') : t('raw.noFilter');
      return `${t('raw.value.stream')} · ${length} · ${filters}`;
    }
    case 'ref':
      return formatRawRef(value.ref);
    default:
      return rawScalarText(value) ?? '';
  }
}

/** `Showing 100 of 250 entries.` / the sidecar's own truncation, in one line. */
function truncationNotice(
  shown: number,
  total: number,
  truncated: boolean,
  keys: { shown: MessageKey; truncated: MessageKey },
  t: TranslateFn,
): string | null {
  if (total > shown) return t(keys.shown, { shown, total });
  if (truncated) return t(keys.truncated);
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
  t: TranslateFn;
}

function renderRawValue(value: RawValue, context: RenderContext): React.ReactNode {
  const { depth, label, onSelectRef, t } = context;
  const nested = { depth: depth + 1, onSelectRef, t };

  switch (value.kind) {
    case 'dict': {
      const entries = value.entries.slice(0, RAW_VALUE_MAX_ENTRIES);
      const root = depth >= RAW_VALUE_MAX_DEPTH;
      const notice = truncationNotice(
        entries.length,
        value.entries.length,
        value.truncated,
        { shown: 'raw.value.entriesShown', truncated: 'raw.value.entriesTruncated' },
        t,
      );
      return (
        <>
          <Row label={label} text={rawValueSummary(value, t)} kind="dict" />
          {root ? (
            <Notice testId="raw-value-depth-notice">
              {t('raw.value.depth', { limit: RAW_VALUE_MAX_DEPTH })}
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
      const notice = truncationNotice(
        items.length,
        value.items.length,
        value.truncated,
        { shown: 'raw.value.itemsShown', truncated: 'raw.value.itemsTruncated' },
        t,
      );
      return (
        <>
          <Row label={label} text={rawValueSummary(value, t)} kind="array" />
          {root ? (
            <Notice testId="raw-value-depth-notice">
              {t('raw.value.depth', { limit: RAW_VALUE_MAX_DEPTH })}
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
          <Row label={label} text={rawValueSummary(value, t)} kind="stream" />
          <dl className={styles.streamMeta} aria-label={t('raw.value.streamMetaAria')}>
            <div className={styles.metaItem}>
              <dt>{t('raw.value.length')}</dt>
              <dd>{value.length === null ? '—' : `${value.length} B`}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>{t('raw.value.filters')}</dt>
              <dd>{value.filters.length > 0 ? value.filters.join(', ') : t('raw.value.none')}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>{t('raw.value.preview')}</dt>
              <dd>
                {value.preview === null
                  ? t('raw.value.binary')
                  : value.truncated
                    ? t('raw.value.truncated')
                    : t('raw.value.full')}
              </dd>
            </div>
          </dl>
          {value.preview === null ? (
            <Notice testId="raw-value-stream-binary">{t('raw.value.streamBinary')}</Notice>
          ) : (
            <pre className={styles.preview} data-testid="raw-value-stream-preview">
              {value.preview}
            </pre>
          )}
          {value.truncated && value.preview !== null && (
            <Notice testId="raw-value-truncated">{t('raw.value.previewTruncated')}</Notice>
          )}
          {root ? (
            <Notice testId="raw-value-depth-notice">
              {t('raw.value.depth', { limit: RAW_VALUE_MAX_DEPTH })}
            </Notice>
          ) : (
            <ul className={styles.children}>
              <li>{renderRawValue(value.dict, { ...nested, label: t('raw.tree.dictionary') })}</li>
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
              title={t('raw.tree.selectObject', { ref: text })}
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
export const RawValueView: React.FC<RawValueViewProps> = ({ value, onSelectRef, label, depth = 0 }) => {
  const t = useT();

  return (
    <div className={styles.view} data-testid="raw-value" data-kind={value.kind}>
      {renderRawValue(value, { depth, label, onSelectRef, t })}
    </div>
  );
};
