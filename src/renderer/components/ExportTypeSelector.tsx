import { useId } from 'react';
import { EXPORT_OBJECT_TYPES } from '../services/export-data';
import type { PdfObjectType } from '../types/pdf-objects';
import styles from './ExportTypeSelector.module.css';

/** Display names for the checkboxes, in the same order as `EXPORT_OBJECT_TYPES`. */
export const EXPORT_TYPE_LABELS: Record<PdfObjectType, string> = {
  char: 'Chars',
  word: 'Words',
  rect: 'Rects',
  line: 'Lines',
  curve: 'Curves',
  image: 'Images',
  table: 'Tables',
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
  /** Group label shown next to the count. */
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
  label = 'Object types',
}: ExportTypeSelectorProps): JSX.Element => {
  const labelId = useId();
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
          {label}
        </span>
        <span className={styles.count}>
          {chosen.size}/{ALL_TYPES.length}
        </span>
        <span className={styles.headerSpacer} />
        <button type="button" className={styles.miniButton} onClick={selectAll} disabled={disabled}>
          Select all
        </button>
        <button type="button" className={styles.miniButton} onClick={clearAll} disabled={disabled}>
          Clear
        </button>
      </div>
      <div className={styles.options}>
        {ALL_TYPES.map((type) => (
          <label key={type} className={styles.option}>
            <input
              type="checkbox"
              checked={chosen.has(type)}
              onChange={() => toggle(type)}
              disabled={disabled}
            />
            <span>{EXPORT_TYPE_LABELS[type]}</span>
          </label>
        ))}
      </div>
    </div>
  );
};
