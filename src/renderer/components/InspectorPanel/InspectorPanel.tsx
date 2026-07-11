import type { ReactNode } from "react";
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
  const object = hoveredObject ?? selectedObject;

  if (!object) {
    return (
      <aside className={styles.panel} aria-label="Object inspector">
        <h2 className={styles.title}>Inspector</h2>
        <div className={styles.emptyState}>
          Hover over or select an object to inspect its properties.
        </div>
      </aside>
    );
  }

  const width = object.x1 - object.x0;
  const height = object.y1 - object.y0;

  return (
    <aside className={styles.panel} aria-label="Object inspector">
      <h2 className={styles.title}>Inspector</h2>
      <div className={styles.content}>
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
          </Section>
        )}

        <Section title="Raw JSON">
          <pre className={styles.json}>{JSON.stringify(object, null, 2)}</pre>
        </Section>
      </div>
    </aside>
  );
};
