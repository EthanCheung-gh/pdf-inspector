import type { ReactNode } from "react";
import { useT, type MessageKey } from "../../i18n";
import { usePdfStore } from "../../store/pdf-store";
import type { FilterCriteria } from "../../services/object-filter";
import type { PdfObjectType } from "../../types/pdf-objects";
import styles from "./InspectorPanel.module.css";

const OBJECT_TYPES: PdfObjectType[] = ["char", "word", "rect", "line", "curve", "image", "table"];

/** Display names only; the checkbox value keeps the object type identifier. */
const OBJECT_TYPE_LABEL_KEYS: Record<PdfObjectType, MessageKey> = {
  char: "filter.type.char",
  word: "filter.type.word",
  rect: "filter.type.rect",
  line: "filter.type.line",
  curve: "filter.type.curve",
  image: "filter.type.image",
  table: "filter.type.table",
};

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
  const t = useT();
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
        <h3 className={styles.sectionTitle}>{t("filter.title")}</h3>
        <div className={styles.sectionContent}>
          <div className={styles.filterTypes}>
            {OBJECT_TYPES.map((type) => (
              <label key={type} className={styles.checkLabel}>
                <input
                  type="checkbox"
                  value={type}
                  checked={filterCriteria.types?.includes(type) ?? false}
                  onChange={() => toggleType(type)}
                />
                {t(OBJECT_TYPE_LABEL_KEYS[type])}
              </label>
            ))}
          </div>
          <Row label={t("filter.font")}>
            <select
              className={styles.select}
              aria-label={t("filter.font")}
              value={filterCriteria.fontname ?? ""}
              onChange={(event) =>
                patchCriteria({ fontname: event.target.value || undefined })
              }
            >
              <option value="">{t("filter.anyFont")}</option>
              {fontnames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("filter.size")}>
            <span className={styles.sizeInputs}>
              <input
                className={styles.numberInput}
                type="number"
                placeholder={t("filter.min")}
                aria-label={t("filter.minAria")}
                value={filterCriteria.sizeMin ?? ""}
                onChange={(event) => patchCriteria({ sizeMin: parseSize(event.target.value) })}
              />
              <input
                className={styles.numberInput}
                type="number"
                placeholder={t("filter.max")}
                aria-label={t("filter.maxAria")}
                value={filterCriteria.sizeMax ?? ""}
                onChange={(event) => patchCriteria({ sizeMax: parseSize(event.target.value) })}
              />
            </span>
          </Row>
          <Row label={t("filter.color")}>
            <select
              className={styles.select}
              aria-label={t("filter.color")}
              value={filterCriteria.color ?? ""}
              onChange={(event) => patchCriteria({ color: event.target.value || undefined })}
            >
              <option value="">{t("filter.anyColor")}</option>
              {colorOptions.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </Row>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.button} onClick={() => setFilterCriteria({})}>
              {t("filter.clear")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
