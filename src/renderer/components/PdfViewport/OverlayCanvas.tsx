import React, { useEffect, useRef } from 'react';
import { useHitTest } from '../../hooks/useHitTest';
import { useOverlay } from '../../hooks/useOverlay';
import { useRegionSelect } from '../../hooks/useRegionSelect';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore, type TableCellRef } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { hitTestAnnotations } from '../../services/annotation-view';
import { effectiveOverlayVisibility, overlayObjects } from '../../services/overlay-visibility';
import { resolveTableIndex } from '../InspectorPanel/TableGrid';
import type { PdfAnnotation } from '../../types/annotations';
import type { PageBox, PdfTable } from '../../types/pdf-objects';

/** Stable empty list for pages that have no annotation hit-test candidates. */
const NO_ANNOTATIONS: readonly PdfAnnotation[] = [];

/** Thin grid lines for the cells of the table under inspection. */
export const TABLE_CELL_GRID_COLOR = 'rgba(120, 200, 255, 0.45)';
export const TABLE_CELL_HOVER_COLOR = 'rgba(127, 178, 232, 0.95)';
export const TABLE_CELL_HOVER_FILL = 'rgba(127, 178, 232, 0.16)';
export const TABLE_CELL_SELECT_COLOR = 'rgba(255, 215, 0, 0.95)';
export const TABLE_CELL_SELECT_FILL = 'rgba(255, 215, 0, 0.18)';

export interface TableCellGridOptions {
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
  /** Cell under the pointer (Inspector grid or canvas), highlighted first. */
  hovered?: Pick<TableCellRef, 'row' | 'col'> | null;
  /** Clicked cell, highlighted while nothing is hovered. */
  selected?: Pick<TableCellRef, 'row' | 'col'> | null;
}

/**
 * Draws the cell grid of a single table on the dedicated grid canvas.
 *
 * Covered (merged-away) positions carry no box and are skipped, so a merged
 * region never draws a stray rectangle. Returns the number of cell rectangles
 * of the grid pass (highlights excluded) which the tests use to assert that
 * exactly one table — the active one — is outlined.
 */
export const drawTableCells = (
  ctx: CanvasRenderingContext2D,
  table: PdfTable,
  options: TableCellGridOptions,
): number => {
  const { pageWidth, pageHeight, pdfWidth, pdfHeight, hovered = null, selected = null } = options;

  ctx.clearRect(0, 0, pageWidth, pageHeight);

  const boxes = table.cellBoxes;
  if (!boxes || boxes.length === 0) return 0;
  if (pageWidth <= 0 || pageHeight <= 0 || pdfWidth <= 0 || pdfHeight <= 0) return 0;

  const scaleX = pageWidth / pdfWidth;
  const scaleY = pageHeight / pdfHeight;
  const toRect = (box: PageBox) => ({
    x: box.x0 * scaleX,
    y: pageHeight - box.y1 * scaleY,
    width: (box.x1 - box.x0) * scaleX,
    height: (box.y1 - box.y0) * scaleY,
  });
  const boxAt = (cell: Pick<TableCellRef, 'row' | 'col'> | null): PageBox | null =>
    cell ? boxes[cell.row]?.[cell.col] ?? null : null;

  // Same bottom-left convention as the object overlay: y grows upwards in PDF
  // space and is flipped against the current page height.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = TABLE_CELL_GRID_COLOR;
  ctx.lineWidth = 0.5;

  let drawn = 0;
  for (const row of boxes) {
    // Ragged data from a partial sidecar must not crash the canvas.
    if (!Array.isArray(row)) continue;
    for (const box of row) {
      if (!box) continue;
      const rect = toRect(box);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      drawn += 1;
    }
  }

  const highlight = (
    cell: Pick<TableCellRef, 'row' | 'col'> | null,
    strokeStyle: string,
    fillStyle: string,
  ): void => {
    const box = boxAt(cell);
    if (!box) return;
    const rect = toRect(box);
    ctx.fillStyle = fillStyle;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  };

  const isSameCell = (a: Pick<TableCellRef, 'row' | 'col'> | null, b: typeof a): boolean =>
    Boolean(a && b && a!.row === b!.row && a!.col === b!.col);

  if (!isSameCell(hovered, selected)) highlight(selected, TABLE_CELL_SELECT_COLOR, TABLE_CELL_SELECT_FILL);
  highlight(hovered, TABLE_CELL_HOVER_COLOR, TABLE_CELL_HOVER_FILL);

  return drawn;
};

interface OverlayCanvasProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const allObjects = usePdfStore((state) => state.allObjects);
  const pageData = usePdfStore((state) => state.pageData);
  const overlayVisibility = usePdfStore((state) => state.overlayVisibility);
  const textSelectionMode = usePdfStore((state) => state.textSelectionMode);
  const subset = usePdfStore((state) => state.subset);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const regionMode = usePdfStore((state) => state.regionMode);
  const hoveredObject = usePdfStore((state) => state.hoveredObject);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const hoveredTableCell = usePdfStore((state) => state.hoveredTableCell);
  const selectedTableCell = usePdfStore((state) => state.selectedTableCell);
  const setHoveredObject = usePdfStore((state) => state.setHoveredObject);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const annotationPage = useAnnotationStore((state) => state.page);
  const annotations = useAnnotationStore((state) => state.annotations);
  const showAnnotationBoxes = useAnnotationStore((state) => state.showBoxes);
  const setSelectedAnnotation = useAnnotationStore((state) => state.setSelected);
  const setHoveredAnnotation = useAnnotationStore((state) => state.setHovered);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const { drawOverlays } = useOverlay();
  const { hitTest } = useHitTest();
  const { handlers, liveRect, dragging, wasDragRef } = useRegionSelect(pageWidth, pageHeight, pdfWidth, pdfHeight);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = pageWidth * dpr;
    canvas.height = pageHeight * dpr;
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const context = canvas.getContext('2d');
    if (context) {
      context.scale(dpr, dpr);
      // A property filter draws only its matching objects. Region mode keeps the
      // full page context (all objects plus the drawn rectangle) unchanged, so the
      // subset is ignored for drawing there while still being passed for its
      // region outline.
      const objects = overlayObjects(allObjects, regionMode ? null : subset);
      // The toolbar toggles always apply; the Inspector type filter narrows them
      // only outside region mode, which keeps every toolbar-enabled type visible.
      const visibility = effectiveOverlayVisibility(
        overlayVisibility,
        regionMode ? undefined : filterCriteria.types,
      );
      drawOverlays(context, objects, visibility, pageWidth, pageHeight, pdfWidth, pdfHeight, subset, liveRect);
    }
  }, [allObjects, drawOverlays, overlayVisibility, filterCriteria, regionMode, pageData, pageWidth, pageHeight, pdfWidth, pdfHeight, subset, liveRect]);

  // The cell grid follows the table the Inspector is showing: `hovered ?? selected`
  // with the same precedence as the Inspect tab. Nothing is drawn for other
  // tables so a plain page never fills up with grid noise.
  const focusedObject = hoveredObject ?? selectedObject;
  const gridTable =
    focusedObject && focusedObject.type === 'table' && focusedObject.page === pageNum
      ? focusedObject
      : null;
  const gridTableIndex = gridTable ? resolveTableIndex(pageData?.tables, gridTable) : -1;
  const cellOfThisTable = (cell: TableCellRef | null): cell is TableCellRef =>
    Boolean(cell) && gridTableIndex >= 0 && cell!.page === pageNum && cell!.tableIndex === gridTableIndex;
  const hoveredCell = cellOfThisTable(hoveredTableCell) ? hoveredTableCell : null;
  const selectedCell = cellOfThisTable(selectedTableCell) ? selectedTableCell : null;

  useEffect(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(pageWidth * dpr));
    canvas.height = Math.max(1, Math.round(pageHeight * dpr));
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr);

    if (!gridTable) {
      context.clearRect(0, 0, pageWidth, pageHeight);
      return;
    }

    drawTableCells(context, gridTable, {
      pageWidth,
      pageHeight,
      pdfWidth,
      pdfHeight,
      hovered: hoveredCell,
      selected: selectedCell,
    });
  }, [gridTable, hoveredCell, selectedCell, pageData, pageWidth, pageHeight, pdfWidth, pdfHeight]);

  const getHoveredObject = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Only hit-test what is actually drawn, otherwise hovering an empty area
    // while a filter hides objects would still select an invisible one.
    return hitTest(
      overlayObjects(allObjects, regionMode ? null : subset),
      event.clientX - rect.left,
      event.clientY - rect.top,
      pdfWidth,
      pdfHeight,
      rect.width,
      rect.height,
    );
  };

  // Annotation hit-testing follows the `Show boxes` toggle: with the boxes
  // hidden, clicks must reach the objects underneath. Annotations of another
  // page are never candidates, so a stale list can never steal a click.
  const annotationTargets =
    showAnnotationBoxes && annotationPage === pageNum ? annotations : NO_ANNOTATIONS;

  const getHoveredAnnotation = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): PdfAnnotation | null => {
    if (annotationTargets.length === 0) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTestAnnotations(
      annotationTargets,
      event.clientX - rect.left,
      event.clientY - rect.top,
      pdfWidth,
      pdfHeight,
      rect.width,
      rect.height,
    );
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        onMouseDown={handlers.onMouseDown}
        onMouseMove={(event) => {
          handlers.onMouseMove(event);
          if (dragging) return;
          // Annotations sit above the page content: while one is hovered, the
          // object underneath it must not become the hover target.
          const annotation = getHoveredAnnotation(event);
          setHoveredAnnotation(annotation);
          if (annotation) {
            setHoveredObject(null);
            return;
          }
          setHoveredObject(getHoveredObject(event));
        }}
        onMouseUp={handlers.onMouseUp}
        onClick={(event) => {
          // Skip the click fired right after a region drag so it does not select a stale hovered object.
          if (wasDragRef.current) return;
          const annotation = getHoveredAnnotation(event);
          if (annotation) {
            setSelectedAnnotation(annotation);
            setSelectedObject(null);
            // A canvas selection always opens the details view.
            setInspectorTab('inspect');
            return;
          }

          // Any other click drops the annotation selection, so only one
          // selection (annotation or object) can be active at a time.
          setSelectedAnnotation(null);
          const hovered = usePdfStore.getState().hoveredObject;
          setSelectedObject(hovered);
          // A canvas selection always opens the object details; an empty click
          // only clears the selection and leaves the current tab alone.
          if (hovered) setInspectorTab('inspect');
        }}
        onMouseLeave={() => {
          if (dragging) return;
          setHoveredObject(null);
          setHoveredAnnotation(null);
        }}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: pageWidth,
          height: pageHeight,
          cursor: textSelectionMode ? 'auto' : 'crosshair',
          pointerEvents: textSelectionMode ? 'none' : 'auto',
        }}
        aria-label={`PDF page ${pageNum} object overlay`}
      />
      {/* Separate canvas for the table cell grid: it never intercepts pointer
          events, so clicking a cell still hits the table on the overlay above. */}
      <canvas
        ref={gridCanvasRef}
        data-testid="table-cell-grid"
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: pageWidth,
          height: pageHeight,
          pointerEvents: 'none',
        }}
      />
    </>
  );
};
