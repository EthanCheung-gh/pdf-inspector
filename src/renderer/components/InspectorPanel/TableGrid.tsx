import { useT } from "../../i18n";
import { usePdfStore, type TableCellRef } from "../../store/pdf-store";
import type { PageBox, PdfTable } from "../../types/pdf-objects";
import styles from "./TableGrid.module.css";

interface TableGridProps {
  table: PdfTable;
  /** Index of `table` inside `PageData.tables`, or -1 when it cannot be resolved. */
  tableIndex: number;
}

export const isTableCell = (cell: TableCellRef | null | undefined, page: number, tableIndex: number): cell is TableCellRef =>
  Boolean(cell) && cell!.page === page && cell!.tableIndex === tableIndex;

const sameTableBox = (a: PdfTable, b: PdfTable): boolean =>
  a.page === b.page && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;

/**
 * Resolves a table's index inside the current page's `tables` array.
 *
 * The Inspector receives the very object stored in `allObjects`, so identity
 * normally wins. The bbox fallback covers objects that were re-created (e.g. a
 * future store normalisation) without silently pointing at the wrong table.
 * Returns -1 when the table is not on the loaded page.
 */
export const resolveTableIndex = (tables: PdfTable[] | undefined | null, table: PdfTable): number => {
  if (!tables || tables.length === 0) return -1;

  const byIdentity = tables.indexOf(table);
  if (byIdentity !== -1) return byIdentity;

  return tables.findIndex((candidate) => sameTableBox(candidate, table));
};

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(2);

const formatBox = (box: PageBox): string =>
  `${formatNumber(box.x0)}, ${formatNumber(box.y0)} → ${formatNumber(box.x1)}, ${formatNumber(box.y1)}`;

const rowCount = (table: PdfTable): number => Math.max(table.rows, table.cells.length, 0);

const colCount = (table: PdfTable): number =>
  Math.max(table.cols, ...table.cells.map((row) => row.length), 0);

const cellText = (table: PdfTable, row: number, col: number): string => table.cells[row]?.[col] ?? "";

/**
 * Positions covered by a span anchor: an anchor keeps its own box and marks
 * every grid slot it spans as covered. Only these positions are merged away;
 * a null box anywhere else is missing (ragged) geometry, not a merge.
 */
const coveredPositions = (table: PdfTable): ReadonlySet<string> => {
  const covered = new Set<string>();

  table.cellSpans?.forEach((rowSpans, row) => {
    rowSpans?.forEach((span, col) => {
      if (!span) return;
      const rowSpan = Math.max(span.rowSpan, 1);
      const colSpan = Math.max(span.colSpan, 1);
      for (let coveredRow = row; coveredRow < row + rowSpan; coveredRow += 1) {
        for (let coveredCol = col; coveredCol < col + colSpan; coveredCol += 1) {
          if (coveredRow === row && coveredCol === col) continue;
          covered.add(`${coveredRow}:${coveredCol}`);
        }
      }
    });
  });

  return covered;
};

/**
 * Compact grid of a table's cells.
 *
 * `cells` is the source of truth for the matrix: every row/column position of
 * the text keeps its own slot, so a merged (covered) position only swaps its
 * content for a marker and never shifts the surrounding text. `cellBoxes` adds
 * hover/click geometry and is optional for pages extracted by older sidecars.
 * A null box is only hatched when a `cellSpans` anchor covers the position;
 * otherwise it is reported as missing geometry on the normal, interactive slot.
 */
export const TableGrid = ({ table, tableIndex }: TableGridProps): JSX.Element => {
  const t = useT();
  const hoveredTableCell = usePdfStore((state) => state.hoveredTableCell);
  const selectedTableCell = usePdfStore((state) => state.selectedTableCell);
  const setHoveredTableCell = usePdfStore((state) => state.setHoveredTableCell);
  const setSelectedTableCell = usePdfStore((state) => state.setSelectedTableCell);

  const rows = rowCount(table);
  const cols = colCount(table);
  const boxes = table.cellBoxes;
  const hasBoxes = Boolean(boxes && boxes.length > 0);
  // Without a box matrix there is no coverage to infer: the grid falls back to
  // plain text slots (older sidecars). With one, a span anchor decides whether
  // a null box is a merge or missing geometry.
  const coveredKeys = hasBoxes ? coveredPositions(table) : null;

  if (rows === 0 || cols === 0) return <></>;

  const hovered = isTableCell(hoveredTableCell, table.page, tableIndex) ? hoveredTableCell : null;
  const selected = isTableCell(selectedTableCell, table.page, tableIndex) ? selectedTableCell : null;
  const active = hovered ?? selected;
  const activeSpan = active ? table.cellSpans?.[active.row]?.[active.col] ?? null : null;

  const selectCell = (cell: TableCellRef): void => {
    // Selecting a cell also keeps the table itself selected, so the panel (and
    // the canvas grid) stay on this table after the pointer leaves the canvas.
    usePdfStore.getState().setSelectedObject(table);
    setSelectedTableCell(cell);
  };

  const cells: JSX.Element[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const box = hasBoxes ? boxes?.[row]?.[col] ?? null : null;
      const covered = box === null && Boolean(coveredKeys?.has(`${row}:${col}`));
      // A null box that no span covers is missing geometry (ragged extraction),
      // not a merge: keep the text and flag the slot instead of hatching it.
      const missingBox = hasBoxes && box === null && !covered;
      const text = cellText(table, row, col);
      const span = table.cellSpans?.[row]?.[col] ?? null;
      const label = t("table.cell", { row: row + 1, col: col + 1 });

      if (covered) {
        // A merged-away position keeps its slot (the text matrix must not
        // shift) but shows a marker instead of duplicated text.
        cells.push(
          <span
            key={`${row}-${col}`}
            className={`${styles.cell} ${styles.covered}`}
            role="img"
            aria-label={t("table.covered", { row: row + 1, col: col + 1 })}
            title={t("table.coveredTitle", { row: row + 1, col: col + 1 })}
          >
            <span className={styles.coveredMark} aria-hidden="true">
              ▨
            </span>
          </span>,
        );
        continue;
      }

      const cell: TableCellRef = { page: table.page, tableIndex, row, col, bbox: box };
      const isSelected = Boolean(selected) && selected!.row === row && selected!.col === col;
      const isHovered = Boolean(hovered) && hovered!.row === row && hovered!.col === col;

      cells.push(
        <button
          key={`${row}-${col}`}
          type="button"
          className={[
            styles.cell,
            styles.cellButton,
            isHovered ? styles.cellHovered : "",
            isSelected ? styles.cellSelected : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={text ? t("table.cellWithText", { label, text }) : label}
          aria-pressed={isSelected}
          title={
            box
              ? `${label} · ${formatBox(box)}`
              : missingBox
                ? `${label} · ${t("table.noCellBox")}`
                : label
          }
          onMouseEnter={() => setHoveredTableCell(cell)}
          onMouseLeave={() => setHoveredTableCell(null)}
          onFocus={() => setHoveredTableCell(cell)}
          onBlur={() => setHoveredTableCell(null)}
          onClick={() => selectCell(cell)}
        >
          <span className={styles.cellText}>{text || "\u00a0"}</span>
          {missingBox && (
            <span aria-hidden="true" title={t("table.noCellBox")}>
              ∅
            </span>
          )}
          {span && (span.rowSpan > 1 || span.colSpan > 1) && (
            <span className={styles.spanBadge} title={t("table.spanTitle")}>
              {`${span.rowSpan}×${span.colSpan}`}
            </span>
          )}
        </button>,
      );
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.gridScroll}>
        <div
          className={styles.grid}
          role="group"
          aria-label={t("table.cellsAria", { index: tableIndex + 1 })}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(58px, 1fr))` }}
        >
          {cells}
        </div>
      </div>

      {active ? (
        <div className={styles.details} aria-label={t("table.selectedCell")}>
          <span className={styles.detailLabel}>{t("table.row")}</span>
          <span className={styles.detailValue}>{active.row + 1}</span>
          <span className={styles.detailLabel}>{t("table.column")}</span>
          <span className={styles.detailValue}>{active.col + 1}</span>
          <span className={styles.detailLabel}>{t("table.span")}</span>
          <span className={styles.detailValue}>
            {activeSpan ? `${activeSpan.rowSpan} × ${activeSpan.colSpan}` : "—"}
          </span>
          <span className={styles.detailLabel}>{t("table.text")}</span>
          <span className={styles.detailValue}>
            {cellText(table, active.row, active.col) || "—"}
          </span>
          <span className={styles.detailLabel}>{t("table.bbox")}</span>
          <span className={styles.detailValue}>{active.bbox ? formatBox(active.bbox) : "—"}</span>
          <span className={styles.detailLabel}>{t("table.size")}</span>
          <span className={styles.detailValue}>
            {active.bbox
              ? `${formatNumber(active.bbox.x1 - active.bbox.x0)} × ${formatNumber(active.bbox.y1 - active.bbox.y0)} pt`
              : "—"}
          </span>
        </div>
      ) : (
        <div className={styles.hint}>{t("table.hint")}</div>
      )}
    </div>
  );
};
