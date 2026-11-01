import type { ReactNode } from "react";
import { usePdfStore } from "../../store/pdf-store";
import type { FilterCriteria } from "../../services/object-filter";
import type { PdfObjectType } from "../../types/pdf-objects";
import styles from "./InspectorPanel.module.css";

const OBJECT_TYPES: PdfObjectType[] = ["char", "word", "rect", "line", "curve", "image", "table"];

interface RowProps {
  label: string;
  children: ReactNode;
}

const Row = ({ label, children }: RowProps): JSX.Element => (
  <div className={styles.row}>
    <span className={styles.label}>{label}</span>
    <span className={styles.value}>{children}</span>
  </div>
);

export const FilterTab = (): JSX.Element => {
  const allObjects = usePdfStore((state) => state.allObjects);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const setFilterCriteria = usePdfStore((state) => state.setFilterCriteria);

  const fontnames = Array.from(
    new Set(allObjects.flatMap((o) => ("fontname" in o ? [o.fontname] : []))),
  ).sort();
  const colorOptions = Array.from(
    new Set(allObjects.flatMap((o) => ("color" in o ? [String(o.color)] : []))),
  ).sort();

  const patchCriteria = (patch: FilterCriteria): void => {
    setFilterCriteria({ ...filterCriteria, ...patch });
  };

  const toggleType = (type: PdfObjectType): void => {
    const current = filterCriteria.types ?? [];
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    patchCriteria({ types: next.length > 0 ? next : undefined });
  };

  const parseSize = (value: string): number | undefined => {
    if (value === "") return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return (
    <div className={styles.content}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Filter</h3>
        <div className={styles.sectionContent}>
          <div className={styles.filterTypes}>
            {OBJECT_TYPES.map((type) => (
              <label key={type} className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={filterCriteria.types?.includes(type) ?? false}
                  onChange={() => toggleType(type)}
                />
                {type}
              </label>
            ))}
          </div>
          <Row label="Font">
            <select
              className={styles.select}
              aria-label="Font"
              value={filterCriteria.fontname ?? ""}
              onChange={(event) =>
                patchCriteria({ fontname: event.target.value || undefined })
              }
            >
              <option value="">Any font</option>
              {fontnames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Size">
            <span className={styles.sizeInputs}>
              <input
                className={styles.numberInput}
                type="number"
                placeholder="Min"
                aria-label="Minimum font size"
                value={filterCriteria.sizeMin ?? ""}
                onChange={(event) => patchCriteria({ sizeMin: parseSize(event.target.value) })}
              />
              <input
                className={styles.numberInput}
                type="number"
                placeholder="Max"
                aria-label="Maximum font size"
                value={filterCriteria.sizeMax ?? ""}
                onChange={(event) => patchCriteria({ sizeMax: parseSize(event.target.value) })}
              />
            </span>
          </Row>
          <Row label="Color">
            <select
              className={styles.select}
              aria-label="Color"
              value={filterCriteria.color ?? ""}
              onChange={(event) => patchCriteria({ color: event.target.value || undefined })}
            >
              <option value="">Any color</option>
              {colorOptions.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </Row>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.button} onClick={() => setFilterCriteria({})}>
              Clear filter
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
