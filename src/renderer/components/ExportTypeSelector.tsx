import { useId } from 'react';
import { useT, type MessageKey } from '../i18n';
import { EXPORT_OBJECT_TYPES } from '../services/export-data';
import type { PdfObjectType } from '../types/pdf-objects';
import styles from './ExportTypeSelector.module.css';

/**
 * English display names for the checkboxes, in the same order as
 * `EXPORT_OBJECT_TYPES`. Exported for callers/tests that build the canonical
 * label order; the component itself renders the active-locale catalog.
 */
export const EXPORT_TYPE_LABELS: Record<PdfObjectType, string> = {
  char: 'Chars',
  word: 'Words',
  rect: 'Rects',
  line: 'Lines',
  curve: 'Curves',
  image: 'Images',
  table: 'Tables',
};

/** Display label per type; the emitted list still uses the raw identifier. */
const EXPORT_TYPE_LABEL_KEYS: Record<PdfObjectType, MessageKey> = {
  char: 'exportTypes.type.char',
  word: 'exportTypes.type.word',
  rect: 'exportTypes.type.rect',
  line: 'exportTypes.type.line',
  curve: 'exportTypes.type.curve',
  image: 'exportTypes.type.image',
  table: 'exportTypes.type.table',
};

/** Every selectable type, always in canonical order. */
const ALL_TYPES: PdfObjectType[] = [...EXPORT_OBJECT_TYPES];

export interface ExportTypeSelectorProps {
  /** Currently selected types; any order, but the emitted list is canonical. */
  selected: readonly PdfObjectType[];
  onChange: (types: PdfObjectType[]) => void;
  disabled?: boolean;
  /** Dense layout for narrow hosts such as the Inspector panel. */
  compact?: boolean;
  /** Group label shown next to the count; defaults to the catalog copy. */
  label?: string;
}

/**
 * Checkbox group that picks which PDF object types an export contains.
 * Toggling re-derives the selection from `EXPORT_OBJECT_TYPES`, so the value
 * handed to `onChange` is always de-duplicated and canonically ordered.
 */
export const ExportTypeSelector = ({
  selected,
  onChange,
  disabled = false,
  compact = false,
  label,
}: ExportTypeSelectorProps): JSX.Element => {
  const t = useT();
  const labelId = useId();
  const groupLabel = label ?? t('exportTypes.label');
  const chosen = new Set<string>(selected);

  const emit = (types: readonly PdfObjectType[]): void => {
    if (disabled) return;
    onChange([...types]);
  };

  const toggle = (type: PdfObjectType): void => {
    const next = new Set(chosen);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    // Filter instead of append so callers cannot drift out of canonical order.
    emit(ALL_TYPES.filter((candidate) => next.has(candidate)));
  };

  const selectAll = (): void => emit(ALL_TYPES);
  const clearAll = (): void => emit([]);

  const className = `${styles.group}${compact ? ` ${styles.compact}` : ''}`;

  return (
    <div className={className} role="group" aria-labelledby={labelId}>
      <div className={styles.header}>
        <span id={labelId} className={styles.label}>
          {groupLabel}
        </span>
        <span className={styles.count}>
          {chosen.size}/{ALL_TYPES.length}
        </span>
        <span className={styles.headerSpacer} />
        <button type="button" className={styles.miniButton} onClick={selectAll} disabled={disabled}>
          {t('exportTypes.selectAll')}
        </button>
        <button type="button" className={styles.miniButton} onClick={clearAll} disabled={disabled}>
          {t('exportTypes.clear')}
        </button>
      </div>
      <div className={styles.options}>
        {ALL_TYPES.map((type) => (
          <label key={type} className={styles.option}>
            <input
              type="checkbox"
              value={type}
              checked={chosen.has(type)}
              onChange={() => toggle(type)}
              disabled={disabled}
            />
            <span>{t(EXPORT_TYPE_LABEL_KEYS[type])}</span>
          </label>
        ))}
      </div>
    </div>
  );
};
