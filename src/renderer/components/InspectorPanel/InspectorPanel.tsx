import { useEffect, useState, type ReactNode } from "react";
import { objectsToCsv, objectsToJson, suggestFilename } from "../../services/export-data";
import { ipc } from "../../services/ipc-client";
import { filterByRegion, type FilterCriteria } from "../../services/object-filter";
import { usePdfStore } from "../../store/pdf-store";
import type { PdfImage, PdfObject, PdfObjectType, PdfTable } from "../../types/pdf-objects";
import styles from "./InspectorPanel.module.css";

type TextObject = PdfObject & {
  text: string;
};

type FontObject = PdfObject & {
  fontname: string;
  size: number;
  color?: string;
};

const OBJECT_TYPES: PdfObjectType[] = ["char", "word", "rect", "line", "curve", "image", "table"];

const badgeClassNames: Record<PdfObjectType, string> = {
  char: styles.badgeChar,
  word: styles.badgeWord,
  rect: styles.badgeRect,
  line: styles.badgeLine,
  curve: styles.badgeCurve,
  image: styles.badgeImage,
  table: styles.badgeTable,
};

const isTextObject = (object: PdfObject): object is TextObject => "text" in object;

const hasFontInfo = (object: PdfObject): object is FontObject =>
  "fontname" in object && "size" in object;

const isImage = (object: PdfObject): object is PdfImage => object.type === "image";

const isTable = (object: PdfObject): object is PdfTable => object.type === "table";

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(2);

const imageMimeTypes = new Set(["png", "jpeg", "gif", "webp"]);

const getImageMimeSubtype = (format: string | undefined): string => {
  const subtype = format?.toLowerCase()?.replace("jpg", "jpeg");
  return subtype && imageMimeTypes.has(subtype) ? subtype : "jpeg";
};

interface SectionProps {
  title: string;
  children: ReactNode;
}

const Section = ({ title, children }: SectionProps): JSX.Element => (
  <section className={styles.section}>
    <h3 className={styles.sectionTitle}>{title}</h3>
    <div className={styles.sectionContent}>{children}</div>
  </section>
);

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

export const InspectorPanel = (): JSX.Element => {
  const hoveredObject = usePdfStore((state) => state.hoveredObject);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const allObjects = usePdfStore((state) => state.allObjects);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const subset = usePdfStore((state) => state.subset);
  const setFilterCriteria = usePdfStore((state) => state.setFilterCriteria);
  const setSubset = usePdfStore((state) => state.setSubset);
  const clearSubset = usePdfStore((state) => state.clearSubset);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const object = hoveredObject ?? selectedObject;
  const image = object && isImage(object) ? object : null;
  const imageStreamId = image?.stream_id;
  const imageFormat = image?.format;
  const [imageData, setImageData] = useState<{ base64: string; format: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadImage = async () => {
      if (!imageStreamId) {
        setImageData(null);
        setImageError(null);
        setImageLoading(false);
        return;
      }

      setImageData(null);
      setImageError(null);
      setImageLoading(true);

      try {
        const result = await ipc.getImageData(imageStreamId);
        if (cancelled) return;

        if (result.error || !result.base64) {
          setImageError(result.error ?? "Image data is unavailable.");
          return;
        }

        setImageData({
          base64: result.base64,
          format: getImageMimeSubtype(result.format ?? imageFormat),
        });
      } catch (error) {
        if (!cancelled) {
          setImageError(error instanceof Error ? error.message : "Unable to load image preview.");
        }
      } finally {
        if (!cancelled) setImageLoading(false);
      }
    };

    void loadImage();

    return () => {
      cancelled = true;
    };
  }, [imageFormat, imageStreamId]);

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

  const applyRegionMode = (mode: "intersect" | "contain"): void => {
    if (!subset || !subset.bbox) return;
    setSubset({ ...subset, mode, objects: filterByRegion(allObjects, subset.bbox, mode) });
  };

  const handleExport = async (ext: "json" | "csv"): Promise<void> => {
    const state = usePdfStore.getState();
    if (!state.subset || !state.filePath) return;
    const content =
      ext === "json"
        ? objectsToJson(state.subset.objects, state.metadata, state.currentPage)
        : objectsToCsv(state.subset.objects, state.currentPage);
    try {
      const result = await ipc.saveFile({
        defaultPath: suggestFilename(state.filePath, "page", state.currentPage, ext),
        content,
        filterName: ext.toUpperCase(),
        extensions: [ext],
      });
      if (!result.canceled && result.error) {
        usePdfStore.getState().setError(result.error);
      }
    } catch (error) {
      usePdfStore.getState().setError(error instanceof Error ? error.message : "Export failed");
    }
  };

  const width = object ? object.x1 - object.x0 : 0;
  const height = object ? object.y1 - object.y0 : 0;

  return (
    <aside className={styles.panel} aria-label="Object inspector">
      <h2 className={styles.title}>Inspector</h2>
      <div className={styles.content}>
        <Section title="Filter">
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
                value={filterCriteria.sizeMin ?? ""}
                onChange={(event) => patchCriteria({ sizeMin: parseSize(event.target.value) })}
              />
              <input
                className={styles.numberInput}
                type="number"
                placeholder="Max"
                value={filterCriteria.sizeMax ?? ""}
                onChange={(event) => patchCriteria({ sizeMax: parseSize(event.target.value) })}
              />
            </span>
          </Row>
          <Row label="Color">
            <select
              className={styles.select}
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
        </Section>

        {subset && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              Results ({subset.objects.length} · {subset.source})
              <button type="button" className={styles.titleButton} onClick={clearSubset}>
                Clear
              </button>
            </h3>
            <div className={styles.sectionContent}>
              {subset.source === "region" && (
                <div className={styles.row}>
                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      checked={subset.mode === "intersect"}
                      onChange={() => applyRegionMode("intersect")}
                    />
                    Intersect
                  </label>
                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      checked={subset.mode === "contain"}
                      onChange={() => applyRegionMode("contain")}
                    />
                    Contain
                  </label>
                </div>
              )}
              <div className={styles.resultList}>
                {subset.objects.length === 0 && (
                  <div className={styles.resultsEmpty}>No objects in selection/filter.</div>
                )}
                {subset.objects.map((item, index) => (
                  <button
                    key={index}
                    type="button"
                    className={styles.resultItem}
                    onClick={() => setSelectedObject(item)}
                  >
                    [{item.type}]{" "}
                    {"text" in item
                      ? item.text
                      : `${item.x0},${item.y0} → ${item.x1},${item.y1}`}
                  </button>
                ))}
              </div>
              <div className={styles.buttonRow}>
                <button type="button" className={styles.button} onClick={() => void handleExport("json")}>
                  Export JSON
                </button>
                <button type="button" className={styles.button} onClick={() => void handleExport("csv")}>
                  Export CSV
                </button>
              </div>
            </div>
          </section>
        )}

        {!object && (
          <div className={styles.emptyState}>
            Hover over or select an object to inspect its properties.
          </div>
        )}

        {object && (
          <>
            <Section title="Object">
              <Row label="Type">
                <span className={`${styles.badge} ${badgeClassNames[object.type]}`}>{object.type}</span>
              </Row>
              <Row label="Page">{object.page}</Row>
              {isTextObject(object) && <Row label="Text">{object.text}</Row>}
            </Section>

            <Section title="Position">
              <Row label="x0">{formatNumber(object.x0)}</Row>
              <Row label="y0">{formatNumber(object.y0)}</Row>
              <Row label="x1">{formatNumber(object.x1)}</Row>
              <Row label="y1">{formatNumber(object.y1)}</Row>
              <Row label="Width">{formatNumber(width)}</Row>
              <Row label="Height">{formatNumber(height)}</Row>
            </Section>

            {hasFontInfo(object) && (
              <Section title="Font">
                <Row label="Name">{object.fontname}</Row>
                <Row label="Size">{formatNumber(object.size)}</Row>
                {object.color && (
                  <Row label="Color">
                    <span className={styles.colorValue}>
                      <span className={styles.colorSwatch} style={{ backgroundColor: object.color }} />
                      {object.color}
                    </span>
                  </Row>
                )}
              </Section>
            )}

            {isTable(object) && (
              <Section title="Table">
                <Row label="Rows">{object.rows}</Row>
                <Row label="Columns">{object.cols}</Row>
              </Section>
            )}

            {isImage(object) && (
              <Section title="Image">
                <Row label="Width">{object.width}</Row>
                <Row label="Height">{object.height}</Row>
                <Row label="Format">{object.format}</Row>
                <Row label="Preview">
                  {imageLoading && "Loading image preview..."}
                  {imageError && imageError}
                  {imageData && (
                    <img
                      src={`data:image/${imageData.format};base64,${imageData.base64}`}
                      alt="PDF image preview"
                      style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain" }}
                      onError={() => {
                        setImageData(null);
                        setImageError("Unable to display image preview.");
                      }}
                    />
                  )}
                </Row>
              </Section>
            )}

            <Section title="Raw JSON">
              <pre className={styles.json}>{JSON.stringify(object, null, 2)}</pre>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
};
