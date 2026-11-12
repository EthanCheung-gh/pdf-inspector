import { useEffect, useState, type ReactNode } from "react";
import { useT, type MessageKey } from "../../i18n";
import { ipc } from "../../services/ipc-client";
import { useAnnotationStore } from "../../store/annotation-store";
import { usePdfStore } from "../../store/pdf-store";
import type { PdfImage, PdfObject, PdfObjectType, PdfTable } from "../../types/pdf-objects";
import { AnnotationDetails } from "./AnnotationDetails";
import { TableGrid, resolveTableIndex } from "./TableGrid";
import styles from "./InspectorPanel.module.css";

type TextObject = PdfObject & {
  text: string;
};

type FontObject = PdfObject & {
  fontname: string;
  size: number;
  color?: string;
};

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

type ImageError = { kind: "raw"; message: string } | { kind: "key"; key: MessageKey };

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

export const InspectTab = (): JSX.Element => {
  const hoveredObject = usePdfStore((state) => state.hoveredObject);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const pageData = usePdfStore((state) => state.pageData);
  // Hovering previews an object without changing the selection; keep that
  // precedence exactly as it was before the tab split.
  const object = hoveredObject ?? selectedObject;
  // An annotation selection is explicit (canvas click or Annots row) and wins
  // over the object hover preview; with no annotation the object view below is
  // untouched.
  const annotation = useAnnotationStore((state) => state.selected);
  const image = object && isImage(object) ? object : null;
  const imageStreamId = image?.stream_id;
  const imageFormat = image?.format;
  const t = useT();
  const [imageData, setImageData] = useState<{ base64: string; format: string } | null>(null);
  // A sidecar error is shown verbatim; our own fallbacks stay as keys so a
  // locale switch re-translates them instead of freezing the old language.
  const [imageError, setImageError] = useState<ImageError | null>(null);
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
          setImageError(
            result.error
              ? { kind: "raw", message: result.error }
              : { kind: "key", key: "inspect.image.unavailable" },
          );
          return;
        }

        setImageData({
          base64: result.base64,
          format: getImageMimeSubtype(result.format ?? imageFormat),
        });
      } catch (error) {
        if (!cancelled) {
          setImageError(
            error instanceof Error
              ? { kind: "raw", message: error.message }
              : { kind: "key", key: "inspect.image.loadFailed" },
          );
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

  const width = object ? object.x1 - object.x0 : 0;
  const height = object ? object.y1 - object.y0 : 0;
  // Tables need their position inside the page's `tables` array so the store's
  // cell state (page + tableIndex) and the canvas grid can address the same
  // table. -1 means the object is not on the currently loaded page.
  const tableIndex = object && isTable(object) ? resolveTableIndex(pageData?.tables, object) : -1;

  return (
    <div className={styles.content}>
      {annotation !== null && <AnnotationDetails annotation={annotation} />}

      {annotation === null && !object && (
        <div className={styles.emptyState}>{t("inspect.empty")}</div>
      )}

      {annotation === null && object && (
        <>
          <Section title={t("inspect.section.object")}>
            <Row label={t("inspect.row.type")}>
              <span className={`${styles.badge} ${badgeClassNames[object.type]}`}>{object.type}</span>
            </Row>
            <Row label={t("inspect.row.page")}>{object.page}</Row>
            {isTextObject(object) && <Row label={t("inspect.row.text")}>{object.text}</Row>}
          </Section>

          <Section title={t("inspect.section.position")}>
            {/* Coordinate names are PDF data, not copy. */}
            <Row label="x0">{formatNumber(object.x0)}</Row>
            <Row label="y0">{formatNumber(object.y0)}</Row>
            <Row label="x1">{formatNumber(object.x1)}</Row>
            <Row label="y1">{formatNumber(object.y1)}</Row>
            <Row label={t("inspect.row.width")}>{formatNumber(width)}</Row>
            <Row label={t("inspect.row.height")}>{formatNumber(height)}</Row>
          </Section>

          {hasFontInfo(object) && (
            <Section title={t("inspect.section.font")}>
              <Row label={t("inspect.row.name")}>{object.fontname}</Row>
              <Row label={t("inspect.row.size")}>{formatNumber(object.size)}</Row>
              {object.color && (
                <Row label={t("inspect.row.color")}>
                  <span className={styles.colorValue}>
                    <span className={styles.colorSwatch} style={{ backgroundColor: object.color }} />
                    {object.color}
                  </span>
                </Row>
              )}
            </Section>
          )}

          {isTable(object) && (
            <Section title={t("inspect.section.table")}>
              <Row label={t("inspect.row.rows")}>{object.rows}</Row>
              <Row label={t("inspect.row.columns")}>{object.cols}</Row>
              {tableIndex >= 0 && <TableGrid table={object} tableIndex={tableIndex} />}
            </Section>
          )}

          {isImage(object) && (
            <Section title={t("inspect.section.image")}>
              <Row label={t("inspect.row.width")}>{object.width}</Row>
              <Row label={t("inspect.row.height")}>{object.height}</Row>
              <Row label={t("inspect.row.format")}>{object.format}</Row>
              <Row label={t("inspect.row.preview")}>
                {imageLoading && t("inspect.image.loading")}
                {imageError &&
                  (imageError.kind === "raw" ? imageError.message : t(imageError.key))}
                {imageData && (
                  <img
                    src={`data:image/${imageData.format};base64,${imageData.base64}`}
                    alt={t("inspect.image.alt")}
                    style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain" }}
                    onError={() => {
                      setImageData(null);
                      setImageError({ kind: "key", key: "inspect.image.displayFailed" });
                    }}
                  />
                )}
              </Row>
            </Section>
          )}

          <Section title={t("inspect.section.rawJson")}>
            <pre className={styles.json}>{JSON.stringify(object, null, 2)}</pre>
          </Section>
        </>
      )}
    </div>
  );
};
